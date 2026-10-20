import { mkdir, writeFile } from 'node:fs/promises';
import { readAsar, sha256 } from './asar.mjs';
import { extractCatalog, flatten } from './catalog.mjs';
import { readProfile, latestVersion } from './versions.mjs';

const profile = await readProfile(process.argv[3] ?? latestVersion);
const path = process.argv[2] ?? `${process.env.LOCALAPPDATA}/Factory/app-${profile.version}/resources/app.asar`;
const asar = await readAsar(path);
if (sha256(asar.bytes) !== profile.asarSha256) throw new Error(`需要原版 Factory ${profile.version} 资源`);
const source = asar.read(profile.files.renderer.path).toString('utf8');
const original = extractCatalog(source, profile.adapter.renderer.englishRoot, true);
const resources = Object.fromEntries(Object.entries(original).map(([key, value]) => [key.replace(/^.*\//, '').replace(/\.json$/, ''), value]));
const flat = flatten(resources);
await mkdir('.local', { recursive: true });
await writeFile(`.local/${profile.version}-en.json`, `${JSON.stringify(resources, null, 2)}\n`);
await writeFile(`.local/${profile.version}-en-flat.json`, `${JSON.stringify(flat, null, 2)}\n`);
console.log(JSON.stringify({ version: profile.version, renderer: profile.files.renderer.path, sha256: sha256(Buffer.from(source)), namespaces: Object.keys(resources), entries: Object.keys(flat).length }, null, 2));
