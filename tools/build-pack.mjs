import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readAsar, sha256 } from './asar.mjs';
import { extractCatalog, flatten, setPath, placeholders } from './catalog.mjs';
import { readFullCatalog } from './full-catalog.mjs';
import { textHash, validateTranslation, protectedTokens } from './quality.mjs';
import { adapterDigest } from './patch.mjs';
import { readProfile, latestVersion, packPath } from './versions.mjs';
import { dirname } from 'node:path';
import { parseExpressionAt } from 'acorn';

const profile = await readProfile(process.argv[3] ?? latestVersion);
const path = process.argv[2] ?? `${process.env.LOCALAPPDATA}/Factory/app-${profile.version}/resources/app.asar`;
const asar = await readAsar(path);
if (sha256(asar.bytes) !== profile.asarSha256) throw new Error(`需要原版 ${profile.version} 资源，不能从已修改的客户端生成语言包`);
const raw = extractCatalog(asar.read(profile.files.renderer.path).toString('utf8'), profile.adapter.renderer.englishRoot, true);
const english = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/^.*\//, '').replace(/\.json$/, ''), value]));
const desktopEnglish = extractCatalog(asar.read(profile.files.main.path).toString('utf8'), profile.adapter.main.englishRoot);
const memory = new Map();
const phraseText = await readFile(new URL('../translations/phrases.tsv', import.meta.url), 'utf8');
for (const line of phraseText.split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const [source, target, extra] = line.split('\t');
  if (!source || !target || extra !== undefined) throw new Error(`译文行格式错误：${line}`);
  if (memory.has(source)) throw new Error(`重复译文：${source}`);
  memory.set(source, target);
}
const overrides = JSON.parse(await readFile(new URL('../translations/overrides.json', import.meta.url)));
const nativeOverrides = JSON.parse(await readFile(new URL('../translations/desktop.json', import.meta.url)));
const contextual = JSON.parse(await readFile(new URL('../translations/context-overrides.json', import.meta.url)));
const loader = JSON.parse(await readFile(new URL('../translations/loader.json', import.meta.url)));
const html = asar.read(profile.files.html.path).toString('utf8');
const marker = 'var messages = ';
if (html.split(marker).length !== 2) throw new Error('未知启动页词典结构');
const loaderNode = parseExpressionAt(html, html.indexOf(marker) + marker.length, { ecmaVersion: 'latest' });
const loaderEnglish = extractCatalog(`const messages=${html.slice(loaderNode.start, loaderNode.end)};`, 'messages').en;
const loaderResources = loader.slice(0, loaderEnglish.length);
const loaderFlat = flatten(loaderResources), loaderEnglishFlat = flatten(loaderEnglish);
if (JSON.stringify(Object.keys(loaderFlat).sort()) !== JSON.stringify(Object.keys(loaderEnglishFlat).sort())) throw new Error('启动页词典键集合不一致');
for (const [key, source] of Object.entries(loaderEnglishFlat)) validateTranslation(loaderFlat[key], { sha256: textHash(source), ...protectedTokens(source) }, `loader:${key}`);
const full = await readFullCatalog(profile.version);
if (full.missing.length || full.failures.length) {
  await mkdir('.local', { recursive: true });
  await writeFile('.local/full-validation.json', JSON.stringify({ missing: full.missing, failures: full.failures }, null, 2) + '\n');
  throw new Error(`全量词典未通过：缺少 ${full.missing.length} 项，格式或保留说明错误 ${full.failures.length} 项，见 .local/full-validation.json`);
}
const resources = {};
const desktop = {};
const report = {};
const untranslated = {};
for (const [name, original, target, localOverrides] of [['renderer', english, resources, { ...overrides, ...contextual }], ['desktop', desktopEnglish, desktop, nativeOverrides]]) {
  const flat = flatten(original);
  const keys = Object.keys(flat).sort(), required = Object.keys(full.inventory[name]).sort();
  if (JSON.stringify(keys) !== JSON.stringify(required)) throw new Error(`原版词条集合与适配清单不一致：${name}`);
  // Shared overrides may target a key removed from another supported client version.
  let translated = 0;
  let preserved = 0;
  for (const [key, source] of Object.entries(flat)) {
    const id = full.inventory[name][key];
    const reference = full.inventory.sources[id];
    if (textHash(source) !== reference.sha256) throw new Error(`原版词条指纹不一致：${name}:${key}`);
    const value = localOverrides[key] ?? full.translations[id];
    const classification = validateTranslation(value, reference, `${name}:${key}`, full.preserved[id]);
    setPath(target, key, value);
    if (classification === 'preserved') preserved++;
    else translated++;
  }
  report[name] = { translated, preserved, covered: translated + preserved, total: Object.keys(flat).length };
}
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
const hardcodedProfile = JSON.parse(await readFile(new URL(`../profiles/${profile.version}.hardcoded.json`, import.meta.url)));
const badges = JSON.parse(await readFile(new URL('../translations/badges.json', import.meta.url)));
const hardcoded = { files: hardcodedProfile.files, entries: [], useTranslation: profile.adapter.renderer.useTranslation, memoOwners: hardcodedProfile.memoOwners, languageSubscribers: hardcodedProfile.languageSubscribers, badgeIds: { name: {}, description: {}, quip: {} } };
resources.hardcoded = {};
desktop.desktop.hardcoded = {};
for (const [index, entry] of badges.texts.entries()) {
  if (!['name','description','quip'].includes(entry.field)) throw new Error('未知徽章字段');
  validateTranslation(entry.target, { sha256: textHash(entry.source), ...protectedTokens(entry.source) }, `badge:${index}`, entry.preserveReason);
  const key = `badge_${index}`;
  hardcoded.badgeIds[entry.field][entry.source] = key;
  resources.hardcoded[key] = entry.target;
}
for (const entry of hardcodedProfile.entries) {
  if (entry.decision === 'preserved') {
    if (!entry.reason?.trim()) throw new Error(`硬编码保留项缺少审核说明：${entry.file}:${entry.start}`);
    continue;
  }
  if (entry.lookup === 'badge') { hardcoded.entries.push(entry); continue; }
  if (entry.decision !== 'translated' || full.translations[entry.id] === undefined) throw new Error(`存在未处理硬编码：${entry.file}:${entry.start}`);
  if (full.inventory.sources[entry.id].sha256 !== entry.sourceHash) throw new Error('硬编码源文指纹不匹配');
  const text = full.translations[entry.id];
  if (entry.runtime === 'renderer') resources.hardcoded[entry.id] = text;
  else if (entry.runtime === 'main') desktop.desktop.hardcoded[entry.id] = text;
  hardcoded.entries.push({ ...entry, ...(entry.runtime === 'early' ? { translation: text } : {}) });
}
report.hardcoded = { reviewed: hardcodedProfile.entries.length, localized: hardcoded.entries.length, preserved: hardcodedProfile.entries.length - hardcoded.entries.length, unresolved: 0, rendererResources: Object.keys(resources.hardcoded).length, desktopResources: Object.keys(desktop.desktop.hardcoded).length, badgeTexts: badges.texts.length };
const pack = {
  version, clientVersion: profile.version, locale: 'zh-CN',
  adapterSha256: await adapterDigest(),
  hardcoded,
  resources, desktop,
  loader: loaderResources,
  coverage: report,
};
pack.inputsSha256 = sha256(Buffer.from(JSON.stringify({ profile, phrases: phraseText, overrides, contextOverrides: contextual, desktop: nativeOverrides, loader, hardcodedProfile, badges, full: { inventory: full.inventory, translations: full.translations, preserved: full.preserved }, adapterSha256: pack.adapterSha256 })));
pack.digest = sha256(Buffer.from(JSON.stringify(pack)));
const destination = packPath(profile.version);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(pack, null, 2)}\n`);
await mkdir('.local', { recursive: true });
await writeFile('.local/untranslated.json', `${JSON.stringify(untranslated, null, 2)}\n`);
await writeFile(`.local/${profile.version}-desktop-en.json`, `${JSON.stringify(desktopEnglish, null, 2)}\n`);
console.log(JSON.stringify({ version: pack.version, clientVersion: pack.clientVersion, coverage: report, digest: pack.digest }, null, 2));
