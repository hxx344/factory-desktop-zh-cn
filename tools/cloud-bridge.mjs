import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdir, lstat, rm, realpath } from 'node:fs/promises';
import { resolve, dirname, join, basename, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { parseArgs, isDeepStrictEqual } from 'node:util';

export const REPOSITORY = 'hxx344/factory-desktop-zh-cn';
export const OWNER_ID = 26082889;
export const TITLE_PREFIX = 'Factory cloud request:';
export const LIMITS = Object.freeze({ body: 4096, blob: 8 * 1024 * 1024, changedBytes: 32 * 1024 * 1024, changes: 300, entries: 5000, zip: 32 * 1024 * 1024, zipEntries: 200 });
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const PROTECTED = new Set(['tools/cloud-bridge.mjs', 'test/cloud-bridge.test.mjs', 'tools/package.ps1', 'tools/package.mjs', 'test/package.test.mjs', 'tools/cloud-ui.ps1', 'tools/download-client.ps1', 'tools/cloud-native.mjs', 'test/cloud-native.test.mjs', 'docs/cloud-maintenance.md']);
const RESULT_MARKER = '<!-- factory-cloud-result -->';
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };

export function validateRequest(body) {
  check(typeof body === 'string' && Buffer.byteLength(body) <= LIMITS.body, 'Request body exceeds 4 KiB or is not text.');
  let request;
  try { request = JSON.parse(body); } catch { fail('Request body must be JSON.'); }
  check(request && typeof request === 'object' && !Array.isArray(request), 'Request must be an object.');
  const keys = ['baseCommit', 'mode', 'packageVersion', 'schemaVersion', 'sourceTree'];
  check(isDeepStrictEqual(Object.keys(request).sort(), keys), 'Request contains missing or unknown fields.');
  check(request.schemaVersion === 1 && ['validate', 'publish'].includes(request.mode), 'Unsupported request schema or mode.');
  check(typeof request.baseCommit === 'string' && typeof request.sourceTree === 'string' && SHA.test(request.baseCommit) && SHA.test(request.sourceTree), 'Commit and tree must be lowercase Git SHA-1 values.');
  check(typeof request.packageVersion === 'string' && request.packageVersion.length <= 100 && VERSION.test(request.packageVersion), 'Invalid package SemVer.');
  return request;
}

export function validateEvent(event, environment = process.env) {
  check(environment.GITHUB_REPOSITORY === REPOSITORY && environment.GITHUB_EVENT_NAME === 'issues', 'Only this repository issues events are authorized.');
  check(String(environment.GITHUB_ACTOR_ID) === String(OWNER_ID), 'Unexpected workflow actor.');
  check(event?.action === 'opened' && event.repository?.full_name === REPOSITORY, 'Only opened issues in the fixed repository are authorized.');
  check(event.sender?.id === OWNER_ID && event.issue?.user?.id === OWNER_ID, 'Only the repository owner can request cloud work.');
  check(Number.isSafeInteger(event.issue.number) && event.issue.number > 0 && !event.issue.pull_request, 'Invalid issue number.');
  check(typeof event.issue.title === 'string' && event.issue.title.startsWith(TITLE_PREFIX) && !/[\r\n]/.test(event.issue.title), 'Unexpected cloud request title.');
  return { ...validateRequest(event.issue.body), issueNumber: event.issue.number };
}

export function validatePath(path) {
  check(typeof path === 'string' && path.length > 0 && path.length <= 240 && /^[A-Za-z0-9._/-]+$/.test(path), `Unsafe repository path: ${JSON.stringify(path)}`);
  const parts = path.split('/');
  for (const part of parts) {
    check(part && part !== '.' && part !== '..' && !/[. ]$/.test(part), `Unsafe path component: ${JSON.stringify(path)}`);
    check(!/^\.git(?:$|[. ~])/i.test(part), `Git metadata path refused: ${path}`);
    check(!/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part), `Windows reserved path refused: ${path}`);
    check(!/[<>"|?*]/.test(part), `Windows unsafe path refused: ${path}`);
  }
  return path;
}

export function treeFiles(tree) {
  check(tree && tree.truncated === false && Array.isArray(tree.tree) && tree.tree.length <= LIMITS.entries, 'Tree is truncated or too large.');
  const files = new Map(), paths = new Set();
  for (const entry of tree.tree) {
    validatePath(entry.path);
    const folded = entry.path.toLowerCase();
    check(!paths.has(folded), `Case-colliding or duplicate path: ${entry.path}`);
    paths.add(folded);
    check(typeof entry.sha === 'string' && SHA.test(entry.sha), `Invalid Git object SHA: ${entry.path}`);
    if (entry.type === 'tree') { check(entry.mode === '040000', 'Invalid directory mode.'); continue; }
    check(entry.type === 'blob' && ['100644', '100755'].includes(entry.mode), `Symlinks, submodules and special modes are forbidden: ${entry.path}`);
    check(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= LIMITS.blob, `Blob exceeds 8 MiB: ${entry.path}`);
    files.set(entry.path, entry);
  }
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) check(!files.has(parts.slice(0, index).join('/')), `File/directory collision: ${path}`);
  }
  return files;
}

export function changedFiles(base, candidate) {
  const result = [];
  let bytes = 0;
  for (const path of new Set([...base.keys(), ...candidate.keys()])) {
    const before = base.get(path), after = candidate.get(path);
    if (before?.sha === after?.sha && before?.mode === after?.mode) continue;
    check(!path.startsWith('.git') && !PROTECTED.has(path), `Protected bridge path cannot change: ${path}`);
    const top = path.split('/')[0];
    check(['README.md', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'translations', 'profiles', 'pack', 'test', 'tools'].includes(top), `Unsupported changed path: ${path}`);
    if (top === 'tools') check(base.has(path), `New executable tools require a reviewed bridge update: ${path}`);
    if (after) check(after.mode === '100644', `Changed files must have mode 100644: ${path}`);
    bytes += after?.size ?? 0;
    result.push({ path, before, after });
  }
  check(result.length <= LIMITS.changes && bytes <= LIMITS.changedBytes, 'Candidate exceeds the 300-file / 32-MiB change limit.');
  return result;
}

export function verifyBlob(bytes, sha, size = bytes.length) {
  check(Buffer.isBuffer(bytes) && bytes.length <= LIMITS.blob && bytes.length === size, 'Blob size mismatch.');
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  check(actual === sha, 'Git blob SHA-1 mismatch.');
  return bytes;
}

export function validatePackageChanges(basePackage, candidatePackage, baseLock, candidateLock, version) {
  check(candidatePackage?.version === version, 'Requested version does not match package.json.');
  const cleanPackage = value => { const copy = structuredClone(value); delete copy.version; return copy; };
  const cleanLock = value => { const copy = structuredClone(value); delete copy.version; if (copy.packages?.['']) delete copy.packages[''].version; return copy; };
  check(isDeepStrictEqual(cleanPackage(basePackage), cleanPackage(candidatePackage)), 'Only package.json version may change; scripts and dependencies are protected.');
  check(candidateLock?.version === version && candidateLock?.packages?.['']?.version === version, 'Lockfile root versions must match the requested version.');
  check(isDeepStrictEqual(cleanLock(baseLock), cleanLock(candidateLock)), 'Only package-lock.json root version fields may change.');
}

export function validateVersionPolicy(mode, baseVersion, version, hasChanges) {
  if (mode !== 'publish') return;
  check(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), 'Publication requires a three-part stable version.');
  check(typeof baseVersion === 'string' && VERSION.test(baseVersion), 'Base package version is invalid.');
  if (!hasChanges) { check(version === baseVersion, 'An unchanged tree must use the current package version.'); return; }
  const current = baseVersion.split(/[+-]/)[0].split('.').map(BigInt), next = version.split('.').map(BigInt);
  let comparison = 0;
  for (let index = 0; index < 3; index++) { if (next[index] !== current[index]) { comparison = next[index] > current[index] ? 1 : -1; break; } }
  check(comparison > 0 || (comparison === 0 && baseVersion.split('+')[0].includes('-')), 'Changed publication must increase the package version.');
}

function git(workspace, args, options = {}) {
  return execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { cwd: workspace, encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, windowsHide: true, ...options });
}

function githubClient(token, fetcher = fetch) {
  check(typeof token === 'string' && token.length > 0, 'GH_TOKEN is required.');
  async function request(path, { method = 'GET', body, binary, accept = 'application/vnd.github+json', allowMissing = false, upload = false } = {}) {
    check(path.startsWith(`/repos/${REPOSITORY}/`) && !/[\r\n]/.test(path), 'Unexpected GitHub API path.');
    const response = await fetcher(`https://${upload ? 'uploads' : 'api'}.github.com${path}`, {
      method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
      body: binary ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    if (allowMissing && response.status === 404) return null;
    check(response.ok, `GitHub ${method} ${path} failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  }
  return request;
}

async function readEvent(options) {
  const eventPath = options.event || process.env.GITHUB_EVENT_PATH;
  check(eventPath, 'GITHUB_EVENT_PATH is required.');
  return JSON.parse(await readFile(eventPath, 'utf8'));
}

async function safePath(workspace, path) {
  validatePath(path);
  const full = resolve(workspace, ...path.split('/'));
  const local = relative(workspace, full);
  check(local && !local.startsWith('..') && !isAbsolute(local), 'Path leaves the workspace.');
  let cursor = workspace;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    try { check(!(await lstat(cursor)).isSymbolicLink(), `Symlink or junction refused: ${path}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}

export async function reconstruct(options, api, environment = process.env) {
  const request = validateEvent(await readEvent(options), environment);
  const workspace = await realpath(resolve(options.workspace || process.cwd()));
  check(git(workspace, ['rev-parse', 'HEAD']).trim() === request.baseCommit, 'Checkout HEAD is not the requested base commit.');
  const baseTree = git(workspace, ['rev-parse', `${request.baseCommit}^{tree}`]).trim();
  const indexedTree = git(workspace, ['write-tree']).trim();
  check([baseTree, request.sourceTree].includes(indexedTree), 'Checkout must be clean or contain the exact previously prepared tree.');
  const ref = await api(`/repos/${REPOSITORY}/git/ref/heads/main`);
  check(ref.object?.sha === request.baseCommit, 'main has moved; generate a new cloud request.');
  const [baseData, sourceData] = await Promise.all([api(`/repos/${REPOSITORY}/git/trees/${baseTree}?recursive=1`), api(`/repos/${REPOSITORY}/git/trees/${request.sourceTree}?recursive=1`)]);
  check(baseData.sha === baseTree && sourceData.sha === request.sourceTree, 'GitHub returned an unexpected tree.');
  const base = treeFiles(baseData), candidate = treeFiles(sourceData), changes = changedFiles(base, candidate);
  const changedSet = new Set(changes.map(change => change.path));
  const unstagedPaths = git(workspace, ['diff', '--name-only', '-z']).split('\0').filter(Boolean);
  check(unstagedPaths.every(path => indexedTree === request.sourceTree && changedSet.has(path)), 'Unrelated tracked workspace modifications are forbidden.');
  const cache = new Map();
  async function blob(entry) {
    check(entry, 'Required package file is missing.');
    if (!cache.has(entry.sha)) {
      const data = await api(`/repos/${REPOSITORY}/git/blobs/${entry.sha}`);
      check(data.sha === entry.sha && data.encoding === 'base64' && data.size === entry.size && typeof data.content === 'string', 'Unexpected blob response.');
      cache.set(entry.sha, verifyBlob(Buffer.from(data.content, 'base64'), entry.sha, entry.size));
    }
    return cache.get(entry.sha);
  }
  const json = async entry => JSON.parse((await blob(entry)).toString('utf8'));
  const beforePackage = await json(base.get('package.json')), afterPackage = await json(candidate.get('package.json'));
  validatePackageChanges(beforePackage, afterPackage, await json(base.get('package-lock.json')), await json(candidate.get('package-lock.json')), request.packageVersion);
  validateVersionPolicy(request.mode, beforePackage.version, request.packageVersion, changes.length > 0);
  // Download and authenticate every blob before making the first workspace mutation.
  for (const change of changes) if (change.after) await blob(change.after);
  git(workspace, ['read-tree', baseTree]);
  for (const change of changes) {
    const full = await safePath(workspace, change.path);
    if (!change.after) { await rm(full, { force: true }); git(workspace, ['update-index', '--force-remove', '--', change.path]); continue; }
    await mkdir(dirname(full), { recursive: true });
    const bytes = await blob(change.after);
    await writeFile(full, bytes);
    const actual = git(workspace, ['hash-object', '-w', '--stdin'], { input: bytes }).trim();
    check(actual === change.after.sha, 'Local Git blob does not match the candidate.');
    git(workspace, ['update-index', '--add', '--cacheinfo', `${change.after.mode},${actual},${change.path}`]);
  }
  check(git(workspace, ['write-tree']).trim() === request.sourceTree, 'Reconstructed Git tree does not exactly match sourceTree.');
  check(git(workspace, ['diff', '--name-only', '--no-ext-diff']).trim() === '', 'Materialized files do not match the exact candidate index.');
  return { request, workspace, baseTree, candidate, changedPaths: changes.map(change => change.path) };
}

async function saveReport(path, report) {
  check(path, '--report is required.');
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function prepare(options = {}) {
  const prepared = await reconstruct(options, githubClient(process.env.GH_TOKEN));
  const report = { ...prepared.request, baseTree: prepared.baseTree, changedPaths: prepared.changedPaths };
  await saveReport(options.report, report);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `mode=${report.mode}\nversion=${report.packageVersion}\nsourceTree=${report.sourceTree}\nbaseCommit=${report.baseCommit}\nchanged=${report.changedPaths.length > 0}\n`);
  return report;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

export function readZip(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= LIMITS.zip, 'Invalid or oversized release ZIP.');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  check(end >= 0 && bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0, 'ZIP footer or disk count is invalid.');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralOffset = bytes.readUInt32LE(end + 16);
  check(count > 0 && count <= LIMITS.zipEntries && bytes.readUInt16LE(end + 8) === count && centralOffset + centralSize === end, 'Invalid ZIP entry count or central directory.');
  const result = new Map(), paths = new Set();
  let cursor = centralOffset, unpacked = 0;
  for (let index = 0; index < count; index++) {
    check(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'Invalid ZIP central entry.');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    check(cursor + 46 + nameLength + extraLength + commentLength <= end && !(flags & 1) && [0, 8].includes(method) && size <= LIMITS.blob, 'Encrypted, unsupported or oversized ZIP entry.');
    const directory = name.endsWith('/'), cleanName = directory ? name.slice(0, -1) : name;
    validatePath(cleanName);
    check(!paths.has(cleanName.toLowerCase()), `Duplicate ZIP path: ${name}`);
    paths.add(cleanName.toLowerCase());
    const unixMode = bytes.readUInt32LE(cursor + 38) >>> 16;
    check((unixMode & 0xf000) !== 0xa000, 'ZIP symlink refused.');
    check(localOffset + 30 <= centralOffset && bytes.readUInt32LE(localOffset) === 0x04034b50, 'Invalid ZIP local entry.');
    check(bytes.readUInt16LE(localOffset + 6) === flags && bytes.readUInt16LE(localOffset + 8) === method, 'ZIP local metadata mismatch.');
    const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28);
    check(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(bytes.subarray(cursor + 46, cursor + 46 + nameLength)), 'ZIP local path mismatch.');
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    check(dataOffset + compressed <= centralOffset, 'ZIP entry exceeds its data region.');
    unpacked += size;
    check(unpacked <= LIMITS.changedBytes, 'ZIP uncompressed content exceeds 32 MiB.');
    const packed = bytes.subarray(dataOffset, dataOffset + compressed);
    const contents = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
    check(contents.length === size && crc32(contents) === crc, 'ZIP size or CRC mismatch.');
    if (directory) check(size === 0, 'ZIP directory contains data.');
    else result.set(cleanName, contents);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  check(cursor === end, 'ZIP central directory has extra data.');
  return result;
}

export async function verifyReleaseFiles(prepared, zipPath, checksumPath) {
  const { request, workspace, candidate } = prepared;
  const zipName = `Factory-Desktop-zh-CN-v${request.packageVersion}.zip`;
  check(basename(zipPath || '') === zipName && basename(checksumPath || '') === `${zipName}.sha256`, 'Unexpected release filenames.');
  const zip = await readFile(zipPath), digest = createHash('sha256').update(zip).digest('hex');
  check((await readFile(checksumPath, 'utf8')) === `${digest}  ${zipName}\n`, 'Release SHA256 file does not match the ZIP.');
  const contents = readZip(zip);
  const expected = new Set(['README.md', 'LICENSE', 'CHANGELOG.md', 'factory-zh.ps1', 'install.cmd', 'restore.cmd', 'status.cmd', 'pack/zh-CN.json', 'docs/screenshots/login-zh-CN.png', ...['cli', 'install', 'patch', 'hardcoded', 'asar', 'versions'].map(name => `tools/${name}.mjs`)]);
  const latest = JSON.parse((await readFile(await safePath(workspace, 'pack/zh-CN.json'))).toString('utf8')).clientVersion;
  check(typeof latest === 'string' && VERSION.test(latest), 'Invalid pack clientVersion.');
  for (const path of candidate.keys()) {
    const match = /^profiles\/([^/]+)\.json$/.exec(path);
    if (!match || !VERSION.test(match[1])) continue;
    expected.add(path);
    if (match[1] !== latest) expected.add(`pack/${match[1]}/zh-CN.json`);
  }
  check(expected.has(`profiles/${latest}.json`), 'Latest client profile is missing.');
  check(contents.size === expected.size, 'Release ZIP contains missing or unexpected files.');
  for (const path of expected) {
    check(candidate.has(path) && contents.has(path), `Required release file is missing: ${path}`);
    check(contents.get(path).equals(await readFile(await safePath(workspace, path))), `ZIP contents do not match the reconstructed candidate: ${path}`);
  }
  return { zip, digest, checksum: await readFile(checksumPath), zipName };
}

async function tagCommit(api, tag) {
  let ref = await api(`/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`, { allowMissing: true });
  if (!ref) return null;
  let object = ref.object;
  for (let i = 0; i < 8 && object?.type === 'tag'; i++) object = (await api(`/repos/${REPOSITORY}/git/tags/${object.sha}`)).object;
  check(object?.type === 'commit' && SHA.test(object.sha), 'Release tag does not resolve to a commit.');
  return object.sha;
}

async function verifyAssets(api, release, files, allowMissing = false) {
  const assets = await api(`/repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100`);
  check(Array.isArray(assets) && assets.length <= 2, 'Release contains unexpected assets.');
  const names = new Set([files.zipName, `${files.zipName}.sha256`]);
  check(assets.every(asset => names.has(asset.name)) && new Set(assets.map(asset => asset.name)).size === assets.length, 'Release contains unknown or duplicate asset names.');
  const missing = [];
  for (const [name, bytes] of [[files.zipName, files.zip], [`${files.zipName}.sha256`, files.checksum]]) {
    const asset = assets.find(value => value.name === name);
    if (!asset && allowMissing) { missing.push([name, bytes]); continue; }
    check(asset?.state === 'uploaded' && asset.size === bytes.length && asset.digest === `sha256:${createHash('sha256').update(bytes).digest('hex')}`, `Release asset digest or size mismatch: ${name}`);
  }
  return missing;
}

async function verifyRelease(api, release, commit, files) {
  check(release.tag_name === `v${files.version}` && release.draft === false && release.prerelease === false && await tagCommit(api, release.tag_name) === commit, 'Existing release is not a matching formal release.');
  await verifyAssets(api, release, files);
  check(release.html_url === `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(release.tag_name)}`, 'Unexpected release URL.');
  return release.html_url;
}

async function findRelease(api, tag) {
  const found = [];
  for (let page = 1; page <= 20; page++) {
    const releases = await api(`/repos/${REPOSITORY}/releases?per_page=100&page=${page}`);
    check(Array.isArray(releases), 'Invalid releases response.');
    found.push(...releases.filter(release => release.tag_name === tag));
    check(found.length <= 1, 'Multiple releases use the requested tag.');
    if (releases.length < 100) return found[0] || null;
  }
  fail('Too many releases to safely identify a matching draft.');
}

export function validateReleaseState(release, existingTagCommit, commit, version, hasChanges = false) {
  if (hasChanges) check(!release && !existingTagCommit, 'A changed candidate cannot reuse an existing release or tag.');
  check(!existingTagCommit || existingTagCommit === commit, 'Existing tag points to a different commit.');
  if (!release) return 'new';
  check(Number.isSafeInteger(release.id) && release.id > 0 && release.tag_name === `v${version}` && release.prerelease === false, 'Existing release identity or type does not match.');
  if (release.draft === true) {
    check(release.target_commitish === commit, 'Existing draft targets a different commit.');
    return 'draft';
  }
  check(release.draft === false && existingTagCommit === commit, 'Existing formal release does not match the expected commit.');
  return 'formal';
}

export async function preflightRelease(api, commit, files, hasChanges) {
  const [release, existingTagCommit] = await Promise.all([findRelease(api, `v${files.version}`), tagCommit(api, `v${files.version}`)]);
  const state = validateReleaseState(release, existingTagCommit, commit, files.version, hasChanges);
  if (state === 'formal') await verifyRelease(api, release, commit, files);
  if (state === 'draft') await verifyAssets(api, release, files, true);
  return { state, release };
}

export async function finalizeRelease(api, commit, files) {
  let { state, release } = await preflightRelease(api, commit, files, false);
  if (state === 'formal') return verifyRelease(api, release, commit, files);
  if (state === 'new') {
    release = await api(`/repos/${REPOSITORY}/releases`, { method: 'POST', body: { tag_name: `v${files.version}`, target_commitish: commit, name: `Factory Desktop 简体中文语言包 v${files.version}`, body: `Factory Desktop 简体中文语言包 v${files.version}\n\n完整汉化、必要检查及原生界面验证已通过。\n\nZIP SHA256: ${files.digest}\n`, draft: true, prerelease: false } });
    validateReleaseState(release, null, commit, files.version);
  }
  const missing = await verifyAssets(api, release, files, true);
  for (const [name, bytes] of missing) await api(`/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', binary: bytes, upload: true });
  await verifyAssets(api, release, files);
  release = await api(`/repos/${REPOSITORY}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, prerelease: false } });
  return verifyRelease(api, release, commit, files);
}

export async function publish(options = {}) {
  const api = githubClient(process.env.GH_TOKEN);
  const prepared = await reconstruct(options, api), { request, workspace, changedPaths } = prepared;
  check(request.mode === 'publish', 'Only publish requests can write commits or releases.');
  const files = { ...await verifyReleaseFiles(prepared, options.zip, options.checksum), version: request.packageVersion };
  await preflightRelease(api, request.baseCommit, files, changedPaths.length > 0);
  const latest = await api(`/repos/${REPOSITORY}/git/ref/heads/main`);
  check(latest.object?.sha === request.baseCommit, 'main moved before publication.');
  let commit = request.baseCommit;
  if (changedPaths.length) {
    const history = git(workspace, ['log', request.baseCommit, '--format=%an%x00%ae']).split('\n');
    const author = history.map(line => line.split('\0')).find(([name, email]) => name === 'charles' && email && !/[\r\n<>]/.test(email));
    check(author, 'No trusted charles author identity found in base history.');
    const message = `feat: update Factory Chinese pack v${request.packageVersion}\n\nUpdate the complete Chinese pack through the verified cloud maintenance workflow.\n\nCo-authored-by: Codex <noreply@openai.com>\n`;
    git(workspace, ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '--no-verify', '--cleanup=verbatim', '-F', '-'], { input: message, env: { ...process.env, GIT_AUTHOR_NAME: author[0], GIT_AUTHOR_EMAIL: author[1] } });
    commit = git(workspace, ['rev-parse', 'HEAD']).trim();
    check(git(workspace, ['show', '-s', '--format=%an', commit]).trim() === 'charles' && git(workspace, ['show', '-s', '--format=%ae', commit]).trim() === author[1], 'Commit author verification failed.');
    check((git(workspace, ['show', '-s', '--format=%B', commit]).match(/^Co-authored-by: Codex <noreply@openai\.com>$/gm) || []).length === 1, 'Codex coauthor footer verification failed.');
    const auth = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64');
    const pushEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` };
    const remote = `https://github.com/${REPOSITORY}.git`;
    check(git(workspace, ['ls-remote', remote, 'refs/heads/main'], { env: pushEnv }).split(/\s/)[0] === request.baseCommit, 'Remote main moved before push.');
    git(workspace, ['push', remote, `${commit}:refs/heads/main`], { env: pushEnv });
    check(git(workspace, ['ls-remote', remote, 'refs/heads/main'], { env: pushEnv }).split(/\s/)[0] === commit, 'Remote branch does not contain the published commit.');
  }
  const releaseUrl = await finalizeRelease(api, commit, files);
  const report = { ...request, status: 'passed', commit, releaseUrl, sha256: files.digest, changedPaths };
  await saveReport(options.report, report);
  return report;
}

export async function reportResult(options = {}) {
  const request = validateEvent(await readEvent(options));
  check(['passed', 'failed'].includes(options.status), '--status must be passed or failed.');
  const api = githubClient(process.env.GH_TOKEN), issue = await api(`/repos/${REPOSITORY}/issues/${request.issueNumber}`);
  check(issue.user?.id === OWNER_ID && issue.title?.startsWith(TITLE_PREFIX), 'Issue ownership changed.');
  const runId = process.env.GITHUB_RUN_ID;
  check(/^\d+$/.test(runId || ''), 'GITHUB_RUN_ID is required.');
  const result = { status: options.status, runUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}` };
  if (options.result) {
    const published = JSON.parse(await readFile(options.result, 'utf8'));
    check(published.baseCommit === request.baseCommit && published.sourceTree === request.sourceTree && published.packageVersion === request.packageVersion && published.issueNumber === request.issueNumber, 'Result does not belong to this request.');
    if (published.commit !== undefined) { check(SHA.test(published.commit), 'Invalid result commit.'); result.commit = published.commit; }
    if (published.releaseUrl !== undefined) { check(published.releaseUrl === `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(`v${request.packageVersion}`)}`, 'Invalid result release URL.'); result.releaseUrl = published.releaseUrl; }
    if (published.sha256 !== undefined) { check(/^[a-f0-9]{64}$/.test(published.sha256), 'Invalid result digest.'); result.sha256 = published.sha256; }
  }
  const body = `${String(issue.body || '').split(RESULT_MARKER)[0].trimEnd()}\n\n${RESULT_MARKER}\n\x60\x60\x60json\n${JSON.stringify(result, null, 2)}\n\x60\x60\x60\n`;
  await api(`/repos/${REPOSITORY}/issues/${request.issueNumber}`, { method: 'PATCH', body: { body, ...(options.status === 'passed' ? { state: 'closed', state_reason: 'completed' } : {}) } });
  if (options.report) await saveReport(options.report, result);
  return result;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['event', 'workspace', 'report', 'zip', 'checksum', 'status', 'result'].map(name => [name, { type: 'string' }])) });
  check(positionals.length === 1, 'Usage: cloud-bridge.mjs prepare|publish|report [options]');
  const commands = { prepare, publish, report: reportResult };
  check(Object.hasOwn(commands, positionals[0]), 'Unknown cloud bridge command.');
  await commands[positionals[0]](values);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`Cloud bridge: ${error.message}`); process.exitCode = 1; });
