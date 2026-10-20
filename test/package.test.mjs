import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { deterministicZip, packageProject } from '../tools/package.mjs';
import { readZip } from '../tools/cloud-bridge.mjs';

test('canonical ZIP keeps stable order and metadata while preserving UTF-8 contents', () => {
  const entries = [{ path: 'b.json', bytes: Buffer.from('中文') }, { path: 'a.txt', bytes: Buffer.from('same bytes\r\n') }];
  const first = deterministicZip(entries), second = deterministicZip([...entries].reverse());
  assert.deepEqual(first, second);
  const decoded = readZip(first);
  assert.deepEqual([...decoded.keys()], ['a.txt', 'b.json']);
  for (const entry of entries) assert.deepEqual(decoded.get(entry.path), entry.bytes);
});

test('fresh packaging after all source mtimes change produces identical retry assets', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'factory-package-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'source');
  const files = {
    'package.json': '{"version":"1.2.3"}',
    'pack/zh-CN.json': '{"version":"1.2.3","clientVersion":"0.202.0"}',
    'profiles/0.201.0.json': '{"version":"0.201.0"}',
    'profiles/0.202.0.json': '{"version":"0.202.0"}',
    'pack/0.201.0/zh-CN.json': '{"version":"1.2.3","clientVersion":"0.201.0"}',
  };
  for (const path of ['README.md', 'LICENSE', 'CHANGELOG.md', 'factory-zh.ps1', 'install.cmd', 'restore.cmd', 'status.cmd', 'docs/screenshots/login-zh-CN.png', ...['cli', 'install', 'patch', 'hardcoded', 'asar', 'versions'].map(name => `tools/${name}.mjs`)]) files[path] = `fixture ${path}\n中文`;
  for (const [path, value] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); }
  const first = await packageProject(root, join(temp, 'first'));
  for (const path of Object.keys(files)) await utimes(join(root, path), new Date('2001-01-01Z'), new Date('2026-10-20Z'));
  const second = await packageProject(root, join(temp, 'retry'));
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(await readFile(first.path), await readFile(second.path));
  assert.deepEqual(await readFile(`${first.path}.sha256`), await readFile(`${second.path}.sha256`));
  assert.ok(readZip(await readFile(first.path)).has('pack/0.201.0/zh-CN.json'));
  files['profiles/0.202.0.json'] = '{"version":"0.203.0"}';
  await writeFile(join(root, 'profiles/0.202.0.json'), files['profiles/0.202.0.json']);
  await assert.rejects(packageProject(root, join(temp, 'invalid')), /Profile version mismatch/);
});
