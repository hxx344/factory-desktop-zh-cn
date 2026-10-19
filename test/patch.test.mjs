import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAsar, writeAsar, sha256 } from '../tools/asar.mjs';
import { patchClient } from '../tools/patch.mjs';
import { install, inspect, restore } from '../tools/install.mjs';
import { extractCatalog, placeholders } from '../tools/catalog.mjs';
import i18next from 'i18next';

function fixture() {
  const empty = { header: { files: {} }, bytes: Buffer.alloc(0), base: 0 };
  const files = {
    'package.json': '{"version":"0.201.0"}',
    '.vite/renderer/main_window/assets/index.js': 'const iZe=[Ju.English,Ju.Japanese,Ju.Korean];const YSu={[Ju.Japanese]:()=>1};eon();y9o.createRoot(document.body);',
    '.vite/build/main.js': 'const v3=[Se.English,Se.Japanese,Se.Korean];const rC={[Se.English]:nC,[Se.Japanese]:{desktop:{}}};',
    '.vite/renderer/main_window/index.html': '<script>var messages = {en:[]};</script>',
    'unrelated.bin': 'UNTOUCHED',
  };
  const asar = writeAsar(empty, new Map(Object.entries(files).map(([key, value]) => [key, Buffer.from(value)])));
  const hash = sha256(parseAsar(asar).rawHeader);
  const exe = Buffer.from(`MZ-fuse-010011011-resource:[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${hash}"}]-signed-data`);
  const profile = { version: '0.201.0', asarSha256: sha256(asar), exeSha256: sha256(exe), files: {} };
  for (const [kind, path] of Object.entries({ renderer: '.vite/renderer/main_window/assets/index.js', main: '.vite/build/main.js', html: '.vite/renderer/main_window/index.html' })) profile.files[kind] = { path, sha256: sha256(Buffer.from(files[path])) };
  const pack = { version: '0.1.0', digest: 'test-pack-v1', resources: { common: { save: '保存', items_one: '{{count}} 项', items_other: '{{count}} 项' } }, desktop: { desktop: { menu: { settings: '设置' } } }, loader: ['正在启动', '稍候', '请重试', '重新加载'] };
  return { asar, exe, profile, pack };
}

async function directory(t, fixture) {
  const root = await mkdtemp(join(tmpdir(), 'factory-zh-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'resources'));
  await writeFile(join(root, 'resources/app.asar'), fixture.asar);
  await writeFile(join(root, 'factory-desktop.exe'), fixture.exe);
  await writeFile(join(root, 'user-settings.json'), 'USER-DATA-KEEP');
  return root;
}

test('native resource registration preserves other ASAR entries and every EXE byte except the header hash', () => {
  const f = fixture();
  const result = patchClient(f.asar, f.exe, f.profile, f.pack);
  const archive = parseAsar(result.asar);
  assert.equal(archive.read('unrelated.bin').toString(), 'UNTOUCHED');
  assert.match(archive.read(f.profile.files.renderer.path).toString(), /ChineseSimplified.*resources-zh-CN\.js/);
  assert.match(archive.read(f.profile.files.main.path).toString(), /设置/);
  assert.match(archive.read('.vite/renderer/main_window/assets/resources-zh-CN.js').toString(), /保存/);
  const oldHash = sha256(parseAsar(f.asar).rawHeader);
  const newHash = sha256(archive.rawHeader);
  assert.deepEqual(result.exe, Buffer.from(f.exe.toString().replace(oldHash, newHash)));
  for (const name of [f.profile.files.renderer.path, 'factory-zh-CN.manifest.json']) assert.equal(sha256(archive.read(name)), archive.entries.get(name).integrity.hash);
});

test('first install, no-op reinstall, pack update and exact restore preserve user data', async t => {
  const f = fixture(), root = await directory(t, f), options = { checkStopped() {} };
  assert.equal((await install(root, f.profile, f.pack, options)).state, 'installed');
  const modified = (await stat(join(root, 'resources/app.asar'))).mtimeMs;
  assert.equal((await install(root, f.profile, f.pack, options)).state, 'unchanged');
  assert.equal((await stat(join(root, 'resources/app.asar'))).mtimeMs, modified);
  const updated = { ...f.pack, digest: 'test-pack-v2', version: '0.2.0' };
  assert.equal((await install(root, f.profile, updated, options)).state, 'installed');
  assert.equal((await restore(root, f.profile, options)).state, 'restored');
  assert.deepEqual(await readFile(join(root, 'resources/app.asar')), f.asar);
  assert.deepEqual(await readFile(join(root, 'factory-desktop.exe')), f.exe);
  assert.equal((await restore(root, f.profile, options)).state, 'unchanged');
  assert.equal(await readFile(join(root, 'user-settings.json'), 'utf8'), 'USER-DATA-KEEP');
});

test('a failed replacement rolls back the original pair, including during a pack update', async t => {
  const f = fixture(), root = await directory(t, f);
  const failure = { checkStopped() {}, afterReplace() { throw new Error('simulated write failure'); } };
  await assert.rejects(install(root, f.profile, f.pack, failure), /simulated write failure/);
  assert.equal((await inspect(root, f.profile)).state, 'original');
  await install(root, f.profile, f.pack, { checkStopped() {} });
  const before = await readFile(join(root, 'resources/app.asar'));
  await assert.rejects(install(root, f.profile, { ...f.pack, digest: 'v2', version: '0.2.0' }, failure), /simulated write failure/);
  assert.equal((await inspect(root, f.profile)).state, 'installed');
  assert.deepEqual(await readFile(join(root, 'resources/app.asar')), before);
});

test('unknown files and a running client are refused without replacement', async t => {
  const f = fixture(), root = await directory(t, f);
  await assert.rejects(install(root, f.profile, f.pack, { checkStopped() { throw new Error('running'); } }), /running/);
  assert.deepEqual(await readFile(join(root, 'factory-desktop.exe')), f.exe);
  await writeFile(join(root, 'factory-desktop.exe'), 'UNRECOGNIZED');
  await assert.rejects(install(root, f.profile, f.pack, { checkStopped() {} }), /未知客户端/);
  assert.equal(await readFile(join(root, 'factory-desktop.exe'), 'utf8'), 'UNRECOGNIZED');
});

test('restore refuses to overwrite an official upgrade or third-party change', async t => {
  const f = fixture(), root = await directory(t, f), options = { checkStopped() {} };
  await install(root, f.profile, f.pack, options);
  await writeFile(join(root, 'factory-desktop.exe'), 'OFFICIAL-UPGRADE');
  await assert.rejects(restore(root, f.profile, options), /已升级或被修改/);
  assert.equal(await readFile(join(root, 'factory-desktop.exe'), 'utf8'), 'OFFICIAL-UPGRADE');
});

test('an interrupted pair can be restored, and failed restore rolls back without losing retryability', async t => {
  const f = fixture(), root = await directory(t, f), options = { checkStopped() {} };
  await install(root, f.profile, f.pack, options);
  await assert.rejects(restore(root, f.profile, { checkStopped() {}, afterReplace() { throw new Error('restore interrupted'); } }), /restore interrupted/);
  assert.equal((await inspect(root, f.profile)).state, 'installed');
  await writeFile(join(root, 'factory-desktop.exe'), f.exe);
  assert.equal((await inspect(root, f.profile)).state, 'interrupted');
  assert.equal((await restore(root, f.profile, options)).state, 'restored');
  assert.equal((await inspect(root, f.profile)).state, 'original');
});

test('a pre-existing temporary file is preserved, not removed on installation failure', async t => {
  const f = fixture(), root = await directory(t, f);
  await writeFile(join(root, 'factory-desktop.exe.factory-zh-tmp'), 'KEEP-EXISTING-TEMP');
  await assert.rejects(install(root, f.profile, f.pack, { checkStopped() {} }), /EEXIST/);
  assert.equal(await readFile(join(root, 'factory-desktop.exe.factory-zh-tmp'), 'utf8'), 'KEEP-EXISTING-TEMP');
  assert.equal((await inspect(root, f.profile)).state, 'original');
});

test('Chinese resources use the real i18next plural rules and retain the English fallback', async () => {
  const { pack } = fixture();
  const instance = i18next.createInstance();
  await instance.init({ lng: 'zh-CN', fallbackLng: 'en', supportedLngs: ['en', 'zh-CN'], resources: { en: { common: { missing: 'English fallback' } }, 'zh-CN': pack.resources }, defaultNS: 'common', initAsync: false, showSupportNotice: false });
  assert.equal(instance.t('save'), '保存');
  assert.equal(instance.t('items', { count: 2 }), '2 项');
  assert.equal(instance.t('missing'), 'English fallback');
});

test('catalog extraction never executes bundled code and validates markup placeholders', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(extractCatalog('const a={text:"Hello"};const root={ns:a};', 'root'))), { ns: { text: 'Hello' } });
  assert.throws(() => extractCatalog('const root=process.exit(1);', 'root'), /Non-static/);
  assert.deepEqual(placeholders('{{count}} <billingLink>Billing</billingLink>'), ['</billingLink>', '<billingLink>', '{{count}}']);
  assert.ok(placeholders('<当>unexpected</当>').includes('<当>'));
});

test('the shipped pack has a valid digest and publishes its actual coverage', async () => {
  const pack = JSON.parse(await readFile(new URL('../pack/zh-CN.json', import.meta.url)));
  const { digest, ...contents } = pack;
  assert.equal(digest, sha256(Buffer.from(JSON.stringify(contents))));
  assert.equal(pack.locale, 'zh-CN');
  assert.equal(pack.desktop.desktop.quitGuard.title, '退出 Factory？');
  assert.ok(pack.coverage.renderer.translated < pack.coverage.renderer.total);
  assert.equal(pack.coverage.desktop.translated, pack.coverage.desktop.total);
});
