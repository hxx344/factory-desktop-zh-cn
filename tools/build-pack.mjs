import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readAsar, sha256 } from './asar.mjs';
import { extractCatalog, flatten, setPath, placeholders } from './catalog.mjs';

const profile = JSON.parse(await readFile(new URL('../profiles/0.201.0.json', import.meta.url)));
const path = process.argv[2] ?? `${process.env.LOCALAPPDATA}/Factory/app-${profile.version}/resources/app.asar`;
const asar = await readAsar(path);
if (sha256(asar.bytes) !== profile.asarSha256) throw new Error('需要原版 0.201.0 资源，不能从已修改的客户端生成语言包');
const raw = extractCatalog(asar.read(profile.files.renderer.path).toString('utf8'), 'B8t', true);
const english = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/^.*\//, '').replace(/\.json$/, ''), value]));
const desktopEnglish = extractCatalog(asar.read(profile.files.main.path).toString('utf8'), 'nC');
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
const resources = {};
const desktop = {};
const report = {};
const untranslated = {};
for (const [name, original, target, contextual] of [['renderer', english, resources, overrides], ['desktop', desktopEnglish, desktop, nativeOverrides]]) {
  const flat = flatten(original);
  for (const key of Object.keys(contextual)) if (!(key in flat)) throw new Error(`未知译文键：${name}:${key}`);
  let translated = 0;
  for (const [key, source] of Object.entries(flat)) {
    const value = contextual[key] ?? memory.get(source);
    if (value === undefined) { untranslated[`${name}.${key}`] = source; continue; }
    if (JSON.stringify(placeholders(value)) !== JSON.stringify(placeholders(source))) throw new Error(`译文占位符不匹配：${key}`);
    setPath(target, key, value);
    translated++;
  }
  report[name] = { translated, total: Object.keys(flat).length };
}
const pack = {
  version: '0.1.0', clientVersion: profile.version, locale: 'zh-CN',
  adapterSha256: sha256(await readFile(new URL('./patch.mjs', import.meta.url))),
  resources, desktop,
  loader: ['正在启动 Factory', '启动时间比平时稍长…', '仍在等待。请检查网络连接，或重新加载后重试。', '重新加载'],
  coverage: report,
};
pack.inputsSha256 = sha256(Buffer.from(JSON.stringify({ profile, phrases: phraseText, overrides, desktop: nativeOverrides, adapterSha256: pack.adapterSha256 })));
pack.digest = sha256(Buffer.from(JSON.stringify(pack)));
await mkdir('pack', { recursive: true });
await writeFile('pack/zh-CN.json', `${JSON.stringify(pack, null, 2)}\n`);
await mkdir('.local', { recursive: true });
await writeFile('.local/untranslated.json', `${JSON.stringify(untranslated, null, 2)}\n`);
await writeFile('.local/desktop-en.json', `${JSON.stringify(desktopEnglish, null, 2)}\n`);
console.log(JSON.stringify({ version: pack.version, clientVersion: pack.clientVersion, coverage: report, digest: pack.digest }, null, 2));
