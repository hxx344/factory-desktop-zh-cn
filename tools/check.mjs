import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { sha256 } from './asar.mjs';
import { flatten, placeholders } from './catalog.mjs';
import assert from 'node:assert/strict';
import { readFullCatalog } from './full-catalog.mjs';
import { adapterDigest } from './patch.mjs';
import { supportedVersions, readProfile, packPath } from './versions.mjs';

const phrases = await readFile('translations/phrases.tsv', 'utf8');
const overrides = JSON.parse(await readFile('translations/overrides.json'));
const desktop = JSON.parse(await readFile('translations/desktop.json'));
const contextOverrides = JSON.parse(await readFile('translations/context-overrides.json'));
const badges = JSON.parse(await readFile('translations/badges.json'));
const loader = JSON.parse(await readFile('translations/loader.json'));
const adapterSha256 = await adapterDigest();
const knownKeys = { renderer: new Set(), desktop: new Set() };
for (const version of supportedVersions) {
  const pack = JSON.parse(await readFile(packPath(version)));
  const profile = await readProfile(version);
  const hardcodedProfile = JSON.parse(await readFile(`profiles/${version}.hardcoded.json`));
  const full = await readFullCatalog(version);
  assert.equal(full.missing.length, 0, '全量词典仍有缺项');
  assert.equal(full.failures.length, 0, JSON.stringify(full.failures));
  const inputs = sha256(Buffer.from(JSON.stringify({ profile, phrases, overrides, contextOverrides, desktop, loader, hardcodedProfile, badges, full: { inventory: full.inventory, translations: full.translations, preserved: full.preserved }, adapterSha256 })));
  assert.equal(pack.inputsSha256, inputs, '译文或适配器已变化，需要 npm run build');
  assert.equal(pack.adapterSha256, adapterSha256);
  const { hardcoded, ...renderer } = pack.resources;
  const { hardcoded: nativeHardcoded, ...native } = pack.desktop.desktop;
  assert.deepEqual(Object.keys(flatten(renderer)).sort(), Object.keys(full.inventory.renderer).sort());
  assert.deepEqual(Object.keys(flatten({ desktop: native })).sort(), Object.keys(full.inventory.desktop).sort());
  assert.equal(pack.clientVersion, version);
  assert.equal(full.inventory.clientVersion, version);
  for (const name of ['renderer', 'desktop']) {
    for (const key of Object.keys(full.inventory[name])) knownKeys[name].add(key);
    assert.equal(pack.coverage[name].covered, Object.keys(full.inventory[name]).length);
  }
  assert.equal(pack.coverage.renderer.covered, pack.coverage.renderer.total);
  assert.equal(pack.coverage.desktop.covered, pack.coverage.desktop.total);
  assert.equal(pack.coverage.hardcoded.unresolved, 0);
  assert.equal(pack.hardcoded.entries.length, pack.coverage.hardcoded.localized);
  assert.equal(Object.keys(hardcoded).length, pack.coverage.hardcoded.rendererResources);
  assert.equal(Object.keys(nativeHardcoded).length, pack.coverage.hardcoded.desktopResources);
  assert.equal(pack.version, JSON.parse(await readFile('package.json')).version);
  const { digest, ...contents } = pack;
  assert.equal(digest, sha256(Buffer.from(JSON.stringify(contents))));
  assert.equal(pack.hardcoded.useTranslation, profile.adapter.renderer.useTranslation);
  console.log(`Factory ${version}：全量词典、保留说明、格式、构建输入及覆盖检查通过；界面 ${pack.coverage.renderer.covered} 项，原生 ${pack.coverage.desktop.covered} 项。`);
}
for (const [name, values] of [['renderer', { ...overrides, ...contextOverrides }], ['desktop', desktop]]) {
  for (const key of Object.keys(values)) assert.ok(knownKeys[name].has(key), `所有适配版本均无此覆盖键：${name}:${key}`);
}
const seen = new Set();
for (const line of phrases.split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const [source, target] = line.split('\t');
  assert.ok(!seen.has(source), `重复译文：${source}`);
  seen.add(source);
  assert.deepEqual(placeholders(source), placeholders(target), `占位符不匹配：${source}`);
}
for (const path of ['tools/asar.mjs', 'tools/patch.mjs', 'tools/install.mjs', 'tools/cli.mjs', 'tools/catalog.mjs', 'tools/build-pack.mjs', 'tools/check.mjs', 'tools/extract-i18n.mjs', 'tools/hardcoded.mjs', 'tools/quality.mjs', 'tools/full-catalog.mjs', 'tools/versions.mjs']) execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
