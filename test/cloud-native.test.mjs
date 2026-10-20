import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertIsolatedRoot, verifyExecutableChanges, verifyLoader } from '../tools/cloud-native.mjs';

test('native verification refuses unmarked or relocated extraction roots', async t => {
  const temporaryBase = await realpath(tmpdir());
  const cache = await mkdtemp(join(temporaryBase, 'factory-cloud-test-'));
  assert.equal(dirname(cache), temporaryBase);
  t.after(() => rm(cache, { recursive: true, force: true }));
  const app = join(cache, 'app-0.202.0'), root = join(app, 'lib/net45');
  await mkdir(root, { recursive: true });
  await assert.rejects(assertIsolatedRoot(root, '0.202.0'));
  const marker = { format: 'factory-cloud-client-cache-v1', version: '0.202.0', root, fileName: 'Factory-0.202.0-full.nupkg', sha1: 'a'.repeat(40), size: 1 };
  await writeFile(join(app, '.factory-cloud-client.json'), JSON.stringify(marker));
  assert.equal((await assertIsolatedRoot(root, '0.202.0')).root, await realpath(root));
  await writeFile(join(app, '.factory-cloud-client.json'), JSON.stringify({ ...marker, root: join(cache, 'another-client') }));
  await assert.rejects(assertIsolatedRoot(root, '0.202.0'), /缓存标记与实际目录不符/);
  await assert.rejects(assertIsolatedRoot(root, '0.201.0'), /隔离缓存目录必须与客户端版本匹配/);
});

test('native verification rejects any EXE change outside the ASAR hash, including fuse changes', () => {
  const oldHash = 'a'.repeat(64), newHash = 'b'.repeat(64);
  const original = Buffer.concat([Buffer.from('MZ' + oldHash), Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 3]), Buffer.from('010SIGNED')]);
  const patched = Buffer.from(original);
  patched.write(newHash, 2, 64, 'ascii');
  assert.equal(verifyExecutableChanges(original, patched, oldHash, newHash).onlyChangedRange.changedByteCount, 64);
  for (const offset of [0, patched.length - 1, patched.length - 7]) {
    const corrupted = Buffer.from(patched);
    corrupted[offset] ^= 1;
    assert.throws(() => verifyExecutableChanges(original, corrupted, oldHash, newHash));
  }
  assert.throws(() => verifyExecutableChanges(original, original, oldHash, newHash));
});

test('native loader verification checks inline syntax, both version shapes and all six translated tips', () => {
  const old = ['启动', '等待', '重试', '重载'];
  const tips = Object.fromEntries(['specMode', 'commandPalette', 'stop', 'reasoning', 'model', 'autonomy'].map(key => [key, '中文提示']));
  const current = [...old, tips];
  const html = (zh, en = zh) => `<script>var messages = ${JSON.stringify({ en, 'zh-CN': zh })};var locale='zh-CN';</script>`;
  assert.equal(verifyLoader(html(old), '0.201.0', old).arrayLength, 4);
  assert.equal(verifyLoader(html(current), '0.202.0', current).tipCount, 6);
  assert.throws(() => verifyLoader(html(old), '0.202.0', old));
  assert.throws(() => verifyLoader(html(current, old), '0.202.0', current));
  const missing = [...old, { ...tips }];
  delete missing[4].stop;
  assert.throws(() => verifyLoader(html(missing), '0.202.0', missing));
  const english = [...old, { ...tips, stop: 'Stop' }];
  assert.throws(() => verifyLoader(html(english), '0.202.0', english));
  assert.throws(() => verifyLoader(html(old) + '<script>const = ;</script>', '0.201.0', old));
  assert.throws(() => verifyLoader(html(old), '0.201.0', ['错误']));
});
