import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { REPOSITORY, OWNER_ID, TITLE_PREFIX, LIMITS, validateRequest, validateEvent, validatePath, treeFiles, changedFiles, verifyBlob, validatePackageChanges, validateVersionPolicy, validateReleaseState, preflightRelease, finalizeRelease, reconstruct, readZip, verifyReleaseFiles } from '../tools/cloud-bridge.mjs';

const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40);
const request = { schemaVersion: 1, mode: 'validate', baseCommit: sha, sourceTree: otherSha, packageVersion: '1.2.3' };
const environment = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'issues', GITHUB_ACTOR_ID: String(OWNER_ID) };
const event = () => ({ action: 'opened', repository: { full_name: REPOSITORY }, sender: { id: OWNER_ID }, issue: { number: 5, title: `${TITLE_PREFIX} daily update`, user: { id: OWNER_ID }, body: JSON.stringify(request) } });
const entry = (path, hash = sha, size = 1, mode = '100644') => ({ path, sha: hash, size, mode, type: 'blob' });
const tree = entries => ({ truncated: false, tree: entries });

test('request schema accepts only exact bounded versioned data', () => {
  assert.deepEqual(validateRequest(JSON.stringify(request)), request);
  for (const version of ['0.0.0', '1.2.3-rc.1', '1.2.3-beta+build.123']) assert.equal(validateRequest(JSON.stringify({ ...request, packageVersion: version })).packageVersion, version);
  for (const version of ['01.2.3', '1.2', '1.2.3-01', '1.2.3;echo', 'v1.2.3', '1.2.3\n']) assert.throws(() => validateRequest(JSON.stringify({ ...request, packageVersion: version })));
  for (const change of [{ token: 'x' }, { schemaVersion: 2 }, { mode: 'exec' }, { baseCommit: [sha] }, { sourceTree: sha.toUpperCase() }]) assert.throws(() => validateRequest(JSON.stringify({ ...request, ...change })));
  assert.throws(() => validateRequest(' '.repeat(LIMITS.body + 1)));
  assert.throws(() => validateRequest('[]'));
  assert.throws(() => validateRequest('not json'));
});

test('event authorization binds repository, issue owner, sender, actor and opened action', () => {
  assert.equal(validateEvent(event(), environment).issueNumber, 5);
  for (const edit of [value => { value.action = 'edited'; }, value => { value.sender.id++; }, value => { value.issue.user.id++; }, value => { value.repository.full_name = 'other/repo'; }, value => { value.issue.title = 'run me'; }, value => { value.issue.pull_request = {}; }]) {
    const value = event(); edit(value); assert.throws(() => validateEvent(value, environment));
  }
  for (const edit of [{ GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_ACTOR_ID: '1' }, { GITHUB_ACTOR_ID: undefined }]) assert.throws(() => validateEvent(event(), { ...environment, ...edit }));
});

test('Windows repository paths reject traversal, metadata, reserved names and aliases', () => {
  for (const path of ['profiles/0.202.0.json', 'translations/source-text.json', '.github/workflows/checks.yml', 'package.json']) assert.equal(validatePath(path), path);
  for (const path of ['', '/x', '../x', 'a/../x', 'a//b', 'a\\b', 'C:/x', 'a:b', 'a. ', 'a./b', '.git/config', '.git~1/config', 'pack/ZH-CN~1.JSO', 'translations/中文.json', 'pack/\u0131.json', 'NUL', 'x/COM1.json', 'x/Lpt9.txt', 'x/aux', 'x\ny', 'x\ty', 'x?']) assert.throws(() => validatePath(path), path);
});

test('trees reject truncation, case collisions, symlinks, submodules and oversized blobs', () => {
  assert.equal(treeFiles(tree([entry('pack/a')])).size, 1);
  for (const value of [{ ...tree([]), truncated: true }, tree([entry('A'), entry('a')]), tree([entry('x', sha, 1, '120000')]), tree([{ ...entry('x'), type: 'commit', mode: '160000' }]), tree([entry('x', sha, LIMITS.blob + 1)]), tree([entry('x'), entry('x/y')])]) assert.throws(() => treeFiles(value));
});

test('candidate changes preserve protected bridge and workflow paths', () => {
  for (const path of ['.github/workflows/cloud.yml', '.gitignore', 'tools/cloud-bridge.mjs', 'tools/package.ps1', 'tools/package.mjs', 'test/package.test.mjs', 'tools/download-client.ps1', 'tools/cloud-native.mjs', 'tools/cloud-ui.ps1', 'test/cloud-bridge.test.mjs', 'test/cloud-native.test.mjs', 'docs/cloud-maintenance.md', 'factory-zh.ps1', 'new-top/file', 'tools/new-executable.mjs']) {
    assert.throws(() => changedFiles(new Map(), new Map([[path, entry(path)]])), path);
  }
  const before = new Map([['tools/check.mjs', entry('tools/check.mjs')], ['pack/zh-CN.json', entry('pack/zh-CN.json')]]);
  const after = new Map([['tools/check.mjs', entry('tools/check.mjs', otherSha)], ['translations/new.json', entry('translations/new.json')]]);
  assert.equal(changedFiles(before, after).length, 3);
  const unchangedExecutable = new Map([['tools/old.mjs', entry('tools/old.mjs', sha, 1, '100755')]]);
  assert.deepEqual(changedFiles(unchangedExecutable, unchangedExecutable), []);
  assert.throws(() => changedFiles(new Map(), new Map([['pack/a', entry('pack/a', sha, 1, '100755')]])));
});

test('candidate limits count additions and deletions and bound changed bytes', () => {
  const additions = new Map(Array.from({ length: 301 }, (_, i) => [`pack/${i}`, entry(`pack/${i}`)]));
  assert.throws(() => changedFiles(new Map(), additions), /300-file/);
  assert.throws(() => changedFiles(additions, new Map()), /300-file/);
  const large = new Map(Array.from({ length: 5 }, (_, i) => [`pack/${i}`, entry(`pack/${i}`, sha, LIMITS.blob)]));
  assert.throws(() => changedFiles(new Map(), large), /32-MiB/);
});

test('Git blob authentication uses the exact raw bytes and Git object header', () => {
  const bytes = Buffer.from('Chinese 中文\r\n');
  const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(verifyBlob(bytes, digest), bytes);
  assert.throws(() => verifyBlob(Buffer.from('Chinese 中文\n'), digest));
  assert.throws(() => verifyBlob(bytes, digest, bytes.length + 1));
  assert.throws(() => verifyBlob(bytes, sha));
});

test('package metadata permits root version updates but forbids dependency and script changes', () => {
  const base = { name: 'pack', version: '1.0.0', scripts: { test: 'node --test' }, dependencies: { x: '1' } };
  const lock = { version: '1.0.0', lockfileVersion: 3, packages: { '': { version: '1.0.0', dependencies: { x: '1' } }, x: { version: '1' } } };
  const next = { ...base, version: '1.2.3' }, nextLock = structuredClone(lock);
  nextLock.version = nextLock.packages[''].version = '1.2.3';
  assert.doesNotThrow(() => validatePackageChanges(base, next, lock, nextLock, '1.2.3'));
  assert.throws(() => validatePackageChanges(base, { ...next, scripts: { test: 'curl token' } }, lock, nextLock, '1.2.3'));
  assert.throws(() => validatePackageChanges(base, next, lock, { ...nextLock, lockfileVersion: 4 }, '1.2.3'));
  assert.throws(() => validatePackageChanges(base, next, lock, nextLock, '1.2.4'));
  const bad = structuredClone(nextLock); bad.packages.x.version = '2';
  assert.throws(() => validatePackageChanges(base, next, lock, bad, '1.2.3'));
});

test('publication requires a newer stable version for changed candidates and permits current-version recovery', () => {
  assert.doesNotThrow(() => validateVersionPolicy('publish', '0.3.0', '0.3.1', true));
  assert.doesNotThrow(() => validateVersionPolicy('publish', '0.3.1', '0.3.1', false));
  assert.doesNotThrow(() => validateVersionPolicy('publish', '1.0.0-rc.1', '1.0.0', true));
  assert.doesNotThrow(() => validateVersionPolicy('validate', '0.3.0', '0.3.0', true));
  for (const [base, next, changed] of [['0.3.0', '0.3.0', true], ['0.3.0', '0.2.9', true], ['0.3.0', '0.3.1-rc.1', true], ['0.3.0', '0.3.1+build', true], ['0.3.0', '0.3.1', false]]) assert.throws(() => validateVersionPolicy('publish', base, next, changed));
});

test('release preflight rejects conflicting tags and drafts before any mutation', () => {
  const draft = { id: 1, tag_name: 'v1.2.3', target_commitish: sha, draft: true, prerelease: false };
  assert.equal(validateReleaseState(null, null, sha, '1.2.3', true), 'new');
  assert.equal(validateReleaseState(draft, null, sha, '1.2.3'), 'draft');
  assert.equal(validateReleaseState({ ...draft, draft: false }, sha, sha, '1.2.3'), 'formal');
  for (const args of [[draft, null, sha, '1.2.3', true], [null, otherSha, sha, '1.2.3'], [{ ...draft, target_commitish: otherSha }, null, sha, '1.2.3'], [{ ...draft, draft: false }, null, sha, '1.2.3'], [{ ...draft, prerelease: true }, sha, sha, '1.2.3']]) assert.throws(() => validateReleaseState(...args));
});

function releaseApi() {
  const files = { version: '1.2.3', zipName: 'Factory-Desktop-zh-CN-v1.2.3.zip', zip: Buffer.from('zip'), checksum: Buffer.from('sha file'), digest: 'c'.repeat(64) };
  const state = { release: null, assets: [], tag: null, writes: [], failUploadNumber: 0, uploads: 0 };
  const api = async (path, options = {}) => {
    const method = options.method || 'GET';
    if (method !== 'GET') state.writes.push({ path, ...options });
    if (path.includes('/releases?')) return state.release ? [state.release] : [];
    if (path.includes('/git/ref/tags/')) return state.tag ? { object: { type: 'commit', sha: state.tag } } : null;
    if (path.endsWith('/releases') && method === 'POST') {
      assert.equal(options.body.draft, true, 'No incomplete formal release may be created.');
      state.release = { id: 123, ...options.body, html_url: `https://github.com/${REPOSITORY}/releases/tag/v1.2.3` };
      return state.release;
    }
    if (path.endsWith('/assets?per_page=100')) return state.assets;
    if (path.includes('/assets?name=') && method === 'POST') {
      state.uploads++;
      if (state.uploads === state.failUploadNumber) throw new Error('simulated interrupted upload');
      const name = decodeURIComponent(path.split('?name=')[1]);
      state.assets.push({ name, state: 'uploaded', size: options.binary.length, digest: `sha256:${createHash('sha256').update(options.binary).digest('hex')}` });
      return state.assets.at(-1);
    }
    if (path.endsWith('/releases/123') && method === 'PATCH') {
      assert.equal(state.assets.length, 2, 'Formal publication must wait for both verified assets.');
      state.release = { ...state.release, ...options.body }; state.tag = sha;
      return state.release;
    }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  };
  return { files, state, api };
}

test('interrupted upload remains draft and retry completes without duplicate releases or assets', async () => {
  const { api, state, files } = releaseApi();
  state.failUploadNumber = 2;
  await assert.rejects(finalizeRelease(api, sha, files), /interrupted upload/);
  assert.equal(state.release.draft, true); assert.equal(state.assets.length, 1); assert.equal(state.tag, null);
  state.failUploadNumber = 0;
  const url = await finalizeRelease(api, sha, files);
  assert.equal(url, `https://github.com/${REPOSITORY}/releases/tag/v1.2.3`);
  assert.equal(state.release.draft, false); assert.equal(state.assets.length, 2);
  assert.equal(state.writes.filter(write => write.path.endsWith('/releases') && write.method === 'POST').length, 1);
  const count = state.writes.length;
  assert.equal(await finalizeRelease(api, sha, files), url);
  assert.equal(state.writes.length, count, 'Matching formal release is read-only and idempotent.');
});

test('existing mismatched draft or formal assets fail before any release write', async () => {
  for (const draft of [true, false]) {
    const { api, state, files } = releaseApi();
    state.release = { id: 123, tag_name: 'v1.2.3', target_commitish: sha, draft, prerelease: false };
    state.tag = draft ? null : sha;
    state.assets.push({ name: files.zipName, state: 'uploaded', size: files.zip.length, digest: `sha256:${'0'.repeat(64)}` });
    await assert.rejects(preflightRelease(api, sha, files, false), /digest or size mismatch/);
    assert.equal(state.writes.length, 0);
  }
  const { api, state, files } = releaseApi(); state.tag = otherSha;
  await assert.rejects(preflightRelease(api, sha, files, false), /different commit/);
  assert.equal(state.writes.length, 0);
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFiles(files, compress = false) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const path = Buffer.from(name), bytes = Buffer.from(data), packed = compress ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(compress ? 8 : 0, 8); header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(path.length, 26);
    const item = Buffer.concat([header, path, packed]); locals.push(item);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(compress ? 8 : 0, 10); record.writeUInt32LE(crc32(bytes), 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(path.length, 28); record.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([record, path])); offset += item.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('ZIP parsing validates stored and deflated entries including UTF-8 data', () => {
  for (const compressed of [false, true]) {
    const data = readZip(zipFiles([['README.md', '中文'], ['pack/zh-CN.json', '{}']], compressed));
    assert.equal(data.get('README.md').toString(), '中文'); assert.equal(data.size, 2);
  }
});

test('ZIP parsing rejects traversal, duplicate names, corruption and oversize data', () => {
  assert.throws(() => readZip(zipFiles([['../payload', 'bad']])));
  assert.throws(() => readZip(zipFiles([['PACK/a', '1'], ['pack/A', '2']])));
  const corrupt = zipFiles([['README.md', 'hello']]); corrupt[39] ^= 1;
  assert.throws(() => readZip(corrupt), /CRC/);
  const mismatch = zipFiles([['README.md', 'hello']]); mismatch[30] = 'x'.charCodeAt(0);
  assert.throws(() => readZip(mismatch), /path mismatch/);
  assert.throws(() => readZip(Buffer.alloc(LIMITS.zip + 1)));
});

test('release archives must exactly match candidate bytes, dynamic profiles and SHA file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-bridge-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map(['README.md', 'LICENSE', 'CHANGELOG.md', 'factory-zh.ps1', 'install.cmd', 'restore.cmd', 'status.cmd', 'docs/screenshots/login-zh-CN.png', ...['cli', 'install', 'patch', 'hardcoded', 'asar', 'versions'].map(name => `tools/${name}.mjs`), 'profiles/0.201.0.json', 'profiles/0.202.0.json', 'pack/0.201.0/zh-CN.json'].map(path => [path, Buffer.from(path)]));
  files.set('pack/zh-CN.json', Buffer.from(JSON.stringify({ clientVersion: '0.202.0' })));
  for (const [path, bytes] of files) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
  const zipPath = join(root, 'Factory-Desktop-zh-CN-v1.2.3.zip'), checksumPath = `${zipPath}.sha256`;
  const prepared = { workspace: root, request, candidate: new Map([...files.keys()].map(path => [path, entry(path)])) };
  async function saveZip(entries) {
    const zip = zipFiles(entries, true), digest = createHash('sha256').update(zip).digest('hex');
    await writeFile(zipPath, zip); await writeFile(checksumPath, `${digest}  Factory-Desktop-zh-CN-v1.2.3.zip\n`);
  }
  await saveZip([...files]);
  assert.match((await verifyReleaseFiles(prepared, zipPath, checksumPath)).digest, /^[a-f0-9]{64}$/);
  await saveZip([...files].map(([path, bytes]) => [path, path === 'README.md' ? Buffer.from('tampered') : bytes]));
  await assert.rejects(verifyReleaseFiles(prepared, zipPath, checksumPath), /do not match/);
  await saveZip([...files].filter(([path]) => path !== 'profiles/0.201.0.json'));
  await assert.rejects(verifyReleaseFiles(prepared, zipPath, checksumPath), /missing or unexpected/);
  await saveZip([...files]); await writeFile(checksumPath, 'invalid');
  await assert.rejects(verifyReleaseFiles(prepared, zipPath, checksumPath), /SHA256/);
});

test('reconstruction authenticates a candidate and repeats without executing candidate code', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'factory-bridge-git-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspace = join(temporary, 'checkout');
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const run = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true });
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '--quiet', repository, workspace], { encoding: 'utf8', windowsHide: true });
  const baseCommit = run(['rev-parse', 'HEAD']).trim(), baseTree = run(['rev-parse', 'HEAD^{tree}']).trim();
  const bytes = Buffer.from('Cloud reconstruction regression: raw CRLF bytes\r\n');
  const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: workspace, input: bytes, encoding: 'utf8', windowsHide: true }).trim();
  run(['update-index', '--cacheinfo', `100644,${hash},README.md`]);
  const sourceTree = run(['write-tree']).trim();
  run(['read-tree', baseTree]);
  const version = JSON.parse(run(['show', 'HEAD:package.json'])).version;
  const payload = event(); payload.issue.body = JSON.stringify({ ...request, baseCommit, sourceTree, packageVersion: version });
  const eventPath = join(temporary, 'event.json'); await writeFile(eventPath, JSON.stringify(payload));
  const gitTree = object => ({ sha: object, truncated: false, tree: run(['ls-tree', '-rz', '-t', '-l', object]).split('\0').filter(Boolean).map(line => {
    const [metadata, path] = line.split('\t'), [mode, type, sha, size] = metadata.trim().split(/\s+/);
    return { mode, type, sha, path, ...(type === 'blob' ? { size: Number(size) } : {}) };
  }) });
  let requestedBlobs = 0;
  const api = async path => {
    if (path.endsWith('/git/ref/heads/main')) return { object: { sha: baseCommit } };
    if (path.includes('/git/trees/')) return gitTree(path.split('/git/trees/')[1].split('?')[0]);
    if (path.includes('/git/blobs/')) {
      requestedBlobs++;
      const sha = path.split('/git/blobs/')[1], data = execFileSync('git', ['cat-file', 'blob', sha], { cwd: workspace, windowsHide: true });
      return { sha, size: data.length, encoding: 'base64', content: data.toString('base64') };
    }
    throw new Error(`Unexpected mock API request: ${path}`);
  };
  const options = { workspace, event: eventPath };
  for (let i = 0; i < 2; i++) {
    const prepared = await reconstruct(options, api, environment);
    assert.deepEqual(prepared.changedPaths, ['README.md']);
    assert.equal(run(['write-tree']).trim(), sourceTree);
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), hash);
  }
  assert.ok(requestedBlobs >= 6, 'Both passes reauthenticate package metadata and candidate bytes.');
  await writeFile(join(workspace, 'LICENSE'), 'unrelated workspace mutation');
  await assert.rejects(reconstruct(options, api, environment), /Unrelated tracked/);
});
