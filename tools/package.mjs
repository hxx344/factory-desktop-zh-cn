import { readFile, writeFile, mkdir, readdir, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FIXED_FILES = ['README.md', 'LICENSE', 'CHANGELOG.md', 'factory-zh.ps1', 'install.cmd', 'restore.cmd', 'status.cmd', 'pack/zh-CN.json', 'docs/screenshots/login-zh-CN.png', ...['cli', 'install', 'patch', 'hardcoded', 'asar', 'versions'].map(name => `tools/${name}.mjs`)];
const fail = message => { throw new Error(message); };
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

// Stored entries avoid OS/runtime compressor differences during a later retry.
// Every timestamp, attribute and entry order is fixed by this format.
export function deterministicZip(entries) {
  if (!entries.length || entries.length > 200) fail('Invalid release file count.');
  const local = [], central = [], names = new Set();
  let offset = 0, total = 0;
  for (const { path, bytes } of [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || names.has(path.toLowerCase())) fail('Unsafe or duplicate release entry.');
    names.add(path.toLowerCase());
    if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) fail('Invalid release file size.');
    total += bytes.length;
    if (total > 32 * 1024 * 1024) fail('Release content exceeds 32 MiB.');
    const name = Buffer.from(path, 'utf8'), crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x2821, 12); // 2000-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x314, 4); // Unix, ZIP 2.0
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x2821, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(0x81a40000, 38); // regular file, 0644
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, bytes);
    central.push(directory, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(entries.length, 8);
  footer.writeUInt16LE(entries.length, 10);
  footer.writeUInt32LE(directory.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, footer]);
}

async function sourceFile(root, path) {
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) fail(`Linked release path refused: ${path}`);
  }
  const canonical = await realpath(cursor), local = relative(root, canonical);
  if (!local || local === '..' || local.startsWith('../') || local.startsWith('..\\') || isAbsolute(local) || !(await lstat(canonical)).isFile()) fail(`Release path leaves the source tree: ${path}`);
  return readFile(canonical);
}

export async function packageProject(rootInput, outputInput) {
  const root = await realpath(resolve(rootInput)), output = resolve(outputInput ?? join(root, 'dist'));
  const project = JSON.parse(await sourceFile(root, 'package.json'));
  if (!VERSION.test(project.version)) fail('A three-part stable package version is required.');
  const latest = JSON.parse(await sourceFile(root, 'pack/zh-CN.json'));
  if (!VERSION.test(latest.clientVersion) || latest.version !== project.version) fail('Latest pack version does not match.');
  const files = [...FIXED_FILES];
  const profiles = (await readdir(join(root, 'profiles'), { withFileTypes: true })).filter(entry => entry.isFile() && /^\d+\.\d+\.\d+\.json$/.test(entry.name));
  if (!profiles.some(entry => entry.name === `${latest.clientVersion}.json`)) fail('The latest client profile is missing.');
  for (const profile of profiles) {
    const version = profile.name.slice(0, -5), path = `profiles/${profile.name}`;
    if (JSON.parse(await sourceFile(root, path)).version !== version) fail(`Profile version mismatch: ${path}`);
    files.push(path);
    if (version !== latest.clientVersion) {
      const packPath = `pack/${version}/zh-CN.json`, pack = JSON.parse(await sourceFile(root, packPath));
      if (pack.version !== project.version || pack.clientVersion !== version) fail(`Legacy pack version mismatch: ${packPath}`);
      files.push(packPath);
    }
  }
  const zip = deterministicZip(await Promise.all(files.map(async path => ({ path, bytes: await sourceFile(root, path) }))));
  const name = `Factory-Desktop-zh-CN-v${project.version}.zip`, path = join(output, name), temp = `${path}.${randomUUID()}.tmp`;
  const sha256 = createHash('sha256').update(zip).digest('hex');
  await mkdir(output, { recursive: true });
  try { await writeFile(temp, zip, { flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  await writeFile(`${path}.sha256`, `${sha256}  ${name}\n`, 'ascii');
  return { path, sha256, bytes: zip.length, files: files.length, version: project.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { root: { type: 'string', default: resolve(dirname(fileURLToPath(import.meta.url)), '..') }, output: { type: 'string' } } });
  packageProject(values.root, values.output).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
