import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAsar, writeAsar, sha256 } from '../tools/asar.mjs';
import { patchClient } from '../tools/patch.mjs';

function fixture() {
  const renderer = '.vite/renderer/main_window/assets/index.js', chunk = '.vite/renderer/main_window/assets/editor.js';
  const main = '.vite/build/main.js', html = '.vite/renderer/main_window/index.html';
  const chunkSource = 'import {setLocale} from "./index.js";export function createPanel(query){return {label:"Search",query,command:"replace-all"}}export {setLocale};';
  const files = {
    'package.json': '{"version":"1.3.0"}',
    [renderer]: 'const Lang={English:"en",Japanese:"ja",Korean:"ko",ChineseSimplified:"zh-CN"};const supported=[Lang.English,Lang.Japanese,Lang.Korean];const imports={[Lang.Japanese]:()=>1};let locale="en",ready=false;function getI18n(){return {t:(_key,options)=>{if(!ready)throw Error("resources unavailable");return locale==="zh-CN"?"搜索":options.defaultValue}}}export function setLocale(value){locale=value;ready=true}export function openEditor(){return import("./editor.js")}function log(){}function mount(){}getI18n();mount();',
    [chunk]: chunkSource,
    [main]: 'const supported=[Lang.English,Lang.Japanese,Lang.Korean];const resources={[Lang.English]:english,[Lang.Japanese]:{desktop:{}}};',
    [html]: "var messages = {en:[]};var locale = 'en';",
  };
  const asar = writeAsar({ header: { files: {} }, bytes: Buffer.alloc(0), base: 0 }, new Map(Object.entries(files).map(([key, value]) => [key, Buffer.from(value)])));
  const exe = Buffer.from(`MZ:[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${sha256(parseAsar(asar).rawHeader)}"}]`);
  const profile = {
    version: '1.3.0', asarSha256: sha256(asar), exeSha256: sha256(exe),
    files: Object.fromEntries(Object.entries({ renderer, main, html }).map(([key, path]) => [key, { path, sha256: sha256(Buffer.from(files[path])) }])),
    adapter: {
      renderer: { enum: 'Lang', supported: 'supported', imports: 'imports', preload: 'preload', i18n: 'getI18n', useTranslation: 'useTranslation', resolve: 'resolve', switch: 'switchLocale', persist: 'persist', logger: 'log', englishRoot: 'english', mount: 'mount();' },
      main: { enum: 'Lang', supported: 'supported', resources: 'resources', englishRoot: 'english', i18n: 'nativeTranslate' },
    },
  };
  const start = chunkSource.indexOf('"Search"');
  const pack = { version: '0.3.4', clientVersion: '1.3.0', resources: {}, desktop: {}, loader: [], hardcoded: {
    files: { [chunk]: sha256(Buffer.from(chunkSource)) },
    rendererChunks: [chunk],
    entries: [{ file: chunk, runtime: 'renderer', id: '0', raw: '"Search"', start, end: start + 8 }],
  } };
  return { asar, exe, profile, pack, renderer, chunk };
}

test('a lazy renderer module reads current-language labels and preserves editor inputs and commands', async t => {
  const f = fixture(), patched = parseAsar(patchClient(f.asar, f.exe, f.profile, f.pack).asar);
  const root = await mkdtemp(join(tmpdir(), 'factory-renderer-chunk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'index.js'), patched.read(f.renderer));
  await writeFile(join(root, 'editor.js'), patched.read(f.chunk));
  const main = await import(pathToFileURL(join(root, 'index.js')).href);
  const editor = await main.openEditor();
  assert.deepEqual(editor.createPanel('user input'), { label: 'Search', query: 'user input', command: 'replace-all' });
  main.setLocale('zh-CN');
  assert.deepEqual(editor.createPanel('Search'), { label: '搜索', query: 'Search', command: 'replace-all' });
  editor.setLocale('en');
  assert.equal(editor.createPanel('搜索').label, 'Search');
});

test('the optional renderer bridge leaves legacy output unchanged and refuses unregistered modules', () => {
  const f = fixture();
  delete f.pack.hardcoded.rendererChunks;
  const without = patchClient(f.asar, f.exe, f.profile, f.pack);
  f.pack.hardcoded.rendererChunks = [];
  const empty = patchClient(f.asar, f.exe, f.profile, f.pack);
  assert.deepEqual(empty, without);
  assert.doesNotMatch(parseAsar(without.asar).read(f.renderer).toString(), /export \{__factoryZhUi\}/);
  for (const chunks of [[f.chunk, f.chunk], ['../unregistered.js'], [f.renderer], ['.vite/renderer/main_window/assets/unknown.js']]) {
    f.pack.hardcoded.rendererChunks = chunks;
    assert.throws(() => patchClient(f.asar, f.exe, f.profile, f.pack), /模块/);
  }
});
