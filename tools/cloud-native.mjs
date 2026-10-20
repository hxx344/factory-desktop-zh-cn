import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse, parseExpressionAt } from 'acorn';
import { readAsar, sha256 } from './asar.mjs';
import { extractCatalog, flatten } from './catalog.mjs';
import { install, restore, inspect, assertStopped } from './install.mjs';
import { loadTarget, packPath } from './versions.mjs';

const markerName = '.factory-cloud-client.json';
const markerFormat = 'factory-cloud-client-cache-v1';
const resourcePath = '.vite/renderer/main_window/assets/resources-zh-CN.js';
const manifestPath = 'factory-zh-CN.manifest.json';

function containedBy(path, parent) {
  const child = relative(resolve(parent).toLowerCase(), resolve(path).toLowerCase());
  return child === '' || (!child.startsWith(`..\\`) && child !== '..' && !isAbsolute(child));
}

async function assertNoLinks(path) {
  for (let current = resolve(path);;) {
    assert(!(await lstat(current)).isSymbolicLink(), `拒绝符号链接或目录联接：${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function assertIsolatedRoot(input, version) {
  await assertNoLinks(input);
  const root = await realpath(input);
  for (const parent of [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Factory'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Factory'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Factory'),
  ].filter(Boolean)) assert(!containedBy(root, parent), '原生验收拒绝使用真实 Factory 安装目录');
  const cache = resolve(root, '../..');
  assert.equal(root.toLowerCase(), join(cache, 'lib', 'net45').toLowerCase(), '验收根目录必须是缓存中的 lib/net45');
  assert.equal(basename(cache), `app-${version}`, '隔离缓存目录必须与客户端版本匹配');
  const markerPath = join(cache, markerName);
  assert(!(await lstat(markerPath)).isSymbolicLink(), '缓存标记不能是链接');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(marker.format, markerFormat, '缺少下载脚本生成的隔离缓存标记');
  assert.equal(marker.version, version);
  assert.equal(resolve(marker.root).toLowerCase(), root.toLowerCase(), '缓存标记与实际目录不符');
  assert.equal(marker.fileName, `Factory-${version}-full.nupkg`);
  assert.match(marker.sha1, /^[a-f0-9]{40}$/i);
  assert(Number.isSafeInteger(marker.size) && marker.size > 0);
  return { root, marker };
}

function fuse(exe) {
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const offset = exe.indexOf(sentinel);
  assert(offset >= 0, '找不到 Electron fuse marker');
  assert.equal(exe.indexOf(sentinel, offset + 1), -1, 'Electron fuse marker 不唯一');
  const version = exe[offset + sentinel.length], length = exe[offset + sentinel.length + 1];
  assert(length > 0 && length < 64 && offset + sentinel.length + 2 + length <= exe.length);
  const wire = exe.subarray(offset, offset + sentinel.length + 2 + length);
  return { offset, version, length, values: wire.subarray(sentinel.length + 2).toString('ascii'), sha256: sha256(wire) };
}

export function verifyExecutableChanges(original, patched, oldHeaderHash, newHeaderHash) {
  assert.match(oldHeaderHash, /^[a-f0-9]{64}$/);
  assert.match(newHeaderHash, /^[a-f0-9]{64}$/);
  const offset = original.indexOf(Buffer.from(oldHeaderHash));
  assert(offset >= 0, 'EXE 未包含原始 ASAR header hash');
  assert.equal(original.indexOf(Buffer.from(oldHeaderHash), offset + 1), -1);
  assert.equal(patched.length, original.length);
  assert(patched.subarray(0, offset).equals(original.subarray(0, offset)), 'EXE 校验记录前有额外改动');
  assert(patched.subarray(offset + 64).equals(original.subarray(offset + 64)), 'EXE 校验记录后有额外改动');
  assert.equal(patched.subarray(offset, offset + 64).toString('ascii'), newHeaderHash);
  const originalFuse = fuse(original);
  assert.deepEqual(fuse(patched), originalFuse, 'Electron fuse wire 被修改');
  let changedByteCount = 0;
  for (let i = offset; i < offset + 64; i++) if (original[i] !== patched[i]) changedByteCount++;
  assert(changedByteCount > 0, 'ASAR header hash 未更新');
  return { byteLength: patched.length, onlyChangedRange: { start: offset, endExclusive: offset + 64, changedByteCount }, originalHeaderHash: oldHeaderHash, patchedHeaderHash: newHeaderHash, fuseWire: originalFuse, fuseWireUnchanged: true };
}

export function verifyLoader(html, version, loader) {
  const parsedInlineScripts = [];
  for (const [, attributes, source] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!source.trim()) continue;
    const sourceType = /type\s*=\s*["']module["']/i.test(attributes) ? 'module' : 'script';
    parse(source, { sourceType, ecmaVersion: 'latest' });
    parsedInlineScripts.push({ sourceType, bytes: Buffer.byteLength(source), sha256: sha256(Buffer.from(source)) });
  }
  assert(parsedInlineScripts.length > 0, 'HTML 没有可解析的内联脚本');
  const marker = 'var messages = ';
  assert.equal(html.split(marker).length, 2, 'loader messages 声明不唯一');
  const expression = parseExpressionAt(html, html.indexOf(marker) + marker.length, { ecmaVersion: 'latest' });
  const messages = extractCatalog(`const messages=${html.slice(expression.start, expression.end)};`, 'messages');
  const zh = JSON.parse(JSON.stringify(messages['zh-CN']));
  assert.deepEqual(zh, loader, 'HTML 中文 loader 与 pack 不匹配');
  assert(Array.isArray(zh) && Array.isArray(messages.en));
  assert.deepEqual(Object.keys(flatten(zh)).sort(), Object.keys(flatten(messages.en)).sort(), 'loader 中英文键不匹配');
  const expectedLengths = { '0.201.0': 4, '0.202.0': 5 };
  if (expectedLengths[version]) assert.equal(zh.length, expectedLengths[version]);
  const tipKeys = version === '0.202.0' ? ['specMode', 'commandPalette', 'stop', 'reasoning', 'model', 'autonomy'].sort() : [];
  if (tipKeys.length) {
    assert.deepEqual(Object.keys(zh[4]).sort(), tipKeys, '新版 loader 的六个快捷键提示不完整');
    assert(tipKeys.every(key => typeof zh[4][key] === 'string' && /\p{Script=Han}/u.test(zh[4][key])));
  }
  return { arrayLength: zh.length, tipCount: tipKeys.length, tipKeys, keySetMatchesEnglish: true, parsedInlineScripts };
}

async function verifyPatched(root, profile, pack) {
  const originalExe = await readFile(join(root, '.factory-zh-cn/exe.original'));
  const patchedExe = await readFile(join(root, 'factory-desktop.exe'));
  const original = await readAsar(join(root, '.factory-zh-cn/asar.original'));
  const patched = await readAsar(join(root, 'resources/app.asar'));
  assert.equal(sha256(originalExe), profile.exeSha256);
  assert.equal(sha256(original.bytes), profile.asarSha256);
  const executable = verifyExecutableChanges(originalExe, patchedExe, sha256(original.rawHeader), sha256(patched.rawHeader));
  const scripts = [...new Set([profile.files.renderer.path, profile.files.main.path, ...Object.keys(pack.hardcoded?.files ?? {}), resourcePath])];
  const parsedScripts = scripts.map(path => {
    const bytes = patched.read(path);
    parse(bytes.toString('utf8'), { sourceType: 'module', ecmaVersion: 'latest' });
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = JSON.parse(patched.read(manifestPath));
  assert.deepEqual(manifest, { version: pack.version, digest: pack.digest, clientVersion: profile.version });
  const loader = verifyLoader(patched.read(profile.files.html.path).toString('utf8'), profile.version, pack.loader);
  const replacements = new Set([...scripts, profile.files.html.path, manifestPath]);
  let untouched = 0;
  for (const [path, metadata] of original.entries) {
    assert(patched.entries.has(path), `ASAR 条目被删除：${path}`);
    if (!replacements.has(path)) {
      assert.deepEqual(patched.entries.get(path), metadata, `ASAR 元数据被意外改动：${path}`);
      if (!metadata.unpacked && !metadata.link) {
        assert(original.read(path).equals(patched.read(path)), `ASAR 内容被意外改动：${path}`);
        untouched++;
      }
    }
  }
  for (const path of patched.entries.keys()) assert(original.entries.has(path) || replacements.has(path), `ASAR 意外新增条目：${path}`);
  return { parsedScripts, loader, manifest, executable, allOtherPackedEntriesUnchanged: untouched, patchedHashes: { exe: sha256(patchedExe), asar: sha256(patched.bytes) } };
}

function signature(path, powershell) {
  const script = `Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $s = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath '${path.replaceAll("'", "''")}'; $s | Select-Object @{Name='Status';Expression={$_.Status.ToString()}},StatusMessage,@{Name='Signer';Expression={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }));
}

async function timestamps(root) {
  return Object.fromEntries(await Promise.all(['factory-desktop.exe', 'resources/app.asar', '.factory-zh-cn/receipt.json'].map(async path => {
    const file = await stat(join(root, path));
    return [path, { mtimeMs: file.mtimeMs, size: file.size }];
  })));
}

export async function runNativeValidation({ root: input, version, report: output, powershell = process.env.FACTORY_POWERSHELL_PATH || join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') }) {
  const reportPath = resolve(output);
  const report = { status: 'running', startedAt: new Date().toISOString(), platform: process.platform, clientVersion: version, root: resolve(input), wslUsed: false, guiStarted: false, steps: [], upgradeScenario: { status: 'not-run-here', unitTest: 'test/patch.test.mjs: first install, no-op reinstall, pack update and exact restore preserve user data' } };
  await mkdir(dirname(reportPath), { recursive: true });
  const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const step = async (name, action) => {
    const item = { name, status: 'running' };
    report.steps.push(item);
    await save();
    try { item.result = await action(); item.status = 'passed'; }
    catch (error) { item.status = 'failed'; item.error = error.message; throw error; }
    await save();
    console.log(JSON.stringify({ phase: name, status: item.status, version }));
    return item.result;
  };
  try {
    assert.equal(process.platform, 'win32', '原生验收必须在 Windows 运行，禁止 WSL');
    assert(isAbsolute(powershell), 'PowerShell 必须使用绝对路径');
    const { root, marker } = await step('isolated-cache', () => assertIsolatedRoot(input, version));
    let profile, pack;
    await step('profile-and-pack', async () => {
      ({ profile, pack } = await loadTarget(root));
      const project = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
      assert.equal(profile.version, version);
      assert.equal(pack.version, project.version);
      assert.equal(marker.exeSha256, profile.exeSha256);
      assert.equal(marker.asarSha256, profile.asarSha256);
      report.packVersion = pack.version;
      report.packDigest = pack.digest;
      report.packPath = packPath(version);
      report.coverage = pack.coverage;
      return { profileVersion: profile.version, packVersion: pack.version, digest: pack.digest };
    });
    await step('original-files-and-signature', async () => {
      const before = await inspect(root, profile);
      assert.equal(before.state, 'original', '必须从干净原版客户端开始验收');
      assertStopped(root);
      const originalSignature = signature(join(root, 'factory-desktop.exe'), powershell);
      assert.equal(originalSignature.Status, 'Valid', '官方 EXE 签名无效');
      report.originalHashes = before.current;
      return { hashes: before.current, signature: originalSignature };
    });
    await step('first-install', async () => {
      const result = await install(root, profile, pack);
      assert.equal(result.state, 'installed');
      return result;
    });
    const patched = await step('patched-files-and-parsing', async () => ({ ...await verifyPatched(root, profile, pack), signature: signature(join(root, 'factory-desktop.exe'), powershell) }));
    await step('no-op-reinstall', async () => {
      const before = await timestamps(root), hashes = (await inspect(root, profile)).current;
      const result = await install(root, profile, pack);
      assert.equal(result.state, 'unchanged');
      assert.deepEqual(await timestamps(root), before);
      assert.deepEqual((await inspect(root, profile)).current, hashes);
      return { state: result.state, filesAndReceiptTimestampsUnchanged: true, hashesUnchanged: true, timestamps: before };
    });
    await step('exact-restore-and-signature', async () => {
      assert.equal((await restore(root, profile)).state, 'restored');
      const restored = await inspect(root, profile);
      assert.equal(restored.state, 'original');
      assert.deepEqual(restored.current, report.originalHashes);
      const restoredSignature = signature(join(root, 'factory-desktop.exe'), powershell);
      assert.equal(restoredSignature.Status, 'Valid');
      return { state: restored.state, hashes: restored.current, signature: restoredSignature };
    });
    report.final = await step('reinstall-for-ui', async () => {
      assert.equal((await install(root, profile, pack)).state, 'installed');
      const final = await inspect(root, profile);
      assert.equal(final.state, 'installed');
      assert.equal(final.receipt.version, pack.version);
      assert.equal(final.receipt.digest, pack.digest);
      assert.deepEqual(final.current, patched.patchedHashes);
      return { state: final.state, current: final.current, receiptVersion: final.receipt.version, packDigest: final.receipt.digest, readyForUi: true };
    });
    report.status = 'passed';
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    // A failing run never leaves a report that claims success.
    report.completedAt = new Date().toISOString();
    await save();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' }, version: { type: 'string' }, report: { type: 'string' }, powershell: { type: 'string' } } });
    assert(values.root && values.version && values.report, '用法：node tools/cloud-native.mjs --root <lib/net45> --version <version> --report <json> [--powershell <absolute path>]');
    const report = await runNativeValidation(values);
    console.log(JSON.stringify({ status: report.status, reportPath: resolve(values.report), root: report.root, readyForUi: report.final.readyForUi }));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
