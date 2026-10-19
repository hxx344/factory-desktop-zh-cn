import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { sha256 } from './asar.mjs';
import { flatten, placeholders } from './catalog.mjs';
import assert from 'node:assert/strict';

const pack = JSON.parse(await readFile('pack/zh-CN.json'));
const profile = JSON.parse(await readFile('profiles/0.201.0.json'));
const phrases = await readFile('translations/phrases.tsv', 'utf8');
const overrides = JSON.parse(await readFile('translations/overrides.json'));
const desktop = JSON.parse(await readFile('translations/desktop.json'));
const adapterSha256 = sha256(await readFile('tools/patch.mjs'));
const inputs = sha256(Buffer.from(JSON.stringify({ profile, phrases, overrides, desktop, adapterSha256 })));
assert.equal(pack.inputsSha256, inputs, '译文或适配器已变化，需要 npm run build');
assert.equal(pack.adapterSha256, adapterSha256);
assert.equal(pack.coverage.renderer.translated, Object.keys(flatten(pack.resources)).length);
assert.equal(pack.coverage.desktop.translated, Object.keys(flatten(pack.desktop)).length);
assert.equal(pack.version, JSON.parse(await readFile('package.json')).version);
const seen = new Set();
for (const line of phrases.split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const [source, target] = line.split('\t');
  assert.ok(!seen.has(source), `重复译文：${source}`);
  seen.add(source);
  assert.deepEqual(placeholders(source), placeholders(target), `占位符不匹配：${source}`);
}
for (const path of ['tools/asar.mjs', 'tools/patch.mjs', 'tools/install.mjs', 'tools/cli.mjs', 'tools/catalog.mjs', 'tools/build-pack.mjs', 'tools/check.mjs', 'tools/extract-i18n.mjs']) execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
console.log(`译文、占位符、构建输入及脚本检查通过；${pack.coverage.renderer.translated} 条界面译文、${pack.coverage.desktop.translated} 条原生译文。`);
