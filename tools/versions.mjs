import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { readAsar, parseAsar, sha256 } from './asar.mjs';
import { adapterDigest } from './patch.mjs';
import { isForwardCompatible, verifyOfficialExecutable, verifyArchiveBinding, discoverCompatibility, buildCompatibilityPack } from './compatibility.mjs';

export const supportedVersions = ['0.201.0', '0.202.0', '0.204.0', '0.205.0', '0.206.0', '1.3.0', '1.4.1', '1.6.1', '1.7.0'];
export const latestVersion = supportedVersions.at(-1);

export function selectCompatibilityBaseline(version) {
  // Keep the original compatibility window when a newer exact profile is added.
  // Earlier releases never shipped the source hashes needed for safe reuse.
  return supportedVersions.slice(supportedVersions.indexOf('1.4.1'))
    .findLast(baseline => isForwardCompatible(version, baseline)) ?? null;
}

export function packPath(version) {
  if (!supportedVersions.includes(version)) throw new Error(`暂未适配 Factory ${version}；支持 ${supportedVersions.join('、')}，未修改任何文件`);
  return version === latestVersion ? 'pack/zh-CN.json' : `pack/${version}/zh-CN.json`;
}

export async function readProfile(version = latestVersion) {
  packPath(version);
  return JSON.parse(await readFile(new URL(`../profiles/${version}.json`, import.meta.url)));
}

async function loadPack(version) {
  const pack = JSON.parse(await readFile(new URL(`../${packPath(version)}`, import.meta.url)));
  const { digest, ...contents } = pack;
  if (sha256(Buffer.from(JSON.stringify(contents))) !== digest || pack.clientVersion !== version) throw new Error('汉化包内容或适配版本校验失败');
  if (pack.adapterSha256 !== await adapterDigest()) throw new Error('语言加载适配器与汉化包版本不匹配');
  return pack;
}

export async function loadReceiptProfile(root, options = {}) {
  const backup = join(root, '.factory-zh-cn');
  const stat = await lstat(backup).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('备份目录类型异常');
  const receipt = await readFile(join(backup, 'receipt.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!receipt?.profile) return null; // Older exact-version receipts retain the shipped profile path.
  const profile = receipt.profile;
  if (receipt.format !== 2 || receipt.clientVersion !== profile.version || sha256(Buffer.from(JSON.stringify(profile))) !== receipt.profileSha256
    || ['exe', 'asar'].some(kind => receipt.original?.[kind] !== profile[`${kind}Sha256`])) throw new Error('安装收据中的客户端适配信息校验失败');
  const originals = {};
  for (const kind of ['exe', 'asar']) {
    const path = join(backup, `${kind}.original`);
    if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new Error('原版备份类型异常');
    originals[kind] = await readFile(path);
    if (sha256(originals[kind]) !== profile[`${kind}Sha256`]) throw new Error(`原版备份校验失败：${kind}`);
  }
  const archive = parseAsar(originals.asar);
  if (JSON.parse(archive.read('package.json')).version !== profile.version) throw new Error('原版备份版本与安装收据不匹配');
  verifyArchiveBinding(archive, originals.exe);
  if (profile.compatibility) {
    (options.verifyOfficial ?? verifyOfficialExecutable)(join(backup, 'exe.original'));
    if (sha256(await readFile(join(backup, 'exe.original'))) !== profile.exeSha256) throw new Error('签名校验期间原版备份发生变化');
  }
  return { profile, receipt, originals };
}

export async function loadTarget(root, options = {}) {
  const command = options.command ?? 'install';
  const saved = await loadReceiptProfile(root, options);
  // Recovery must survive a changed compatibility window and a removed baseline pack.
  if (command === 'restore' && saved) return { profile: saved.profile };
  const archive = await readAsar(join(root, 'resources/app.asar'));
  const version = JSON.parse(archive.read('package.json')).version;
  if (command === 'status' && saved?.profile.version === version) return { profile: saved.profile, compatibility: saved.receipt.compatibility, coverage: saved.receipt.coverage };
  if (supportedVersions.includes(version)) return { profile: await readProfile(version), ...(command === 'install' ? { pack: await loadPack(version) } : {}) };
  const baselineVersion = selectCompatibilityBaseline(version);
  if (!baselineVersion) throw new Error(`暂未适配 Factory ${version}；精确支持 ${supportedVersions.join('、')}，前向兼容仅到 ${latestVersion.split('.').slice(0, 1)}.${Number(latestVersion.split('.')[1]) + 5}.x；未修改任何文件`);
  let originals;
  if (saved?.profile.version === version) originals = saved.originals;
  else {
    const exePath = join(root, 'factory-desktop.exe');
    originals = { asar: archive.bytes, exe: await readFile(exePath) };
    (options.verifyOfficial ?? verifyOfficialExecutable)(exePath);
    if (sha256(await readFile(exePath)) !== sha256(originals.exe)) throw new Error('签名校验期间客户端文件发生变化');
  }
  const { profile, catalogs } = discoverCompatibility(originals.asar, originals.exe, baselineVersion);
  const pack = buildCompatibilityPack(profile, catalogs, await loadPack(baselineVersion));
  return { profile, pack, compatibility: pack.compatibility, coverage: pack.coverage };
}
