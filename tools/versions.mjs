import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readAsar, sha256 } from './asar.mjs';
import { adapterDigest } from './patch.mjs';

export const supportedVersions = ['0.201.0', '0.202.0'];
export const latestVersion = supportedVersions.at(-1);

export function packPath(version) {
  if (!supportedVersions.includes(version)) throw new Error(`暂未适配 Factory ${version}；支持 ${supportedVersions.join('、')}，未修改任何文件`);
  return version === latestVersion ? 'pack/zh-CN.json' : `pack/${version}/zh-CN.json`;
}

export async function readProfile(version = latestVersion) {
  packPath(version);
  return JSON.parse(await readFile(new URL(`../profiles/${version}.json`, import.meta.url)));
}

export async function loadTarget(root) {
  const archive = await readAsar(join(root, 'resources/app.asar'));
  const version = JSON.parse(archive.read('package.json')).version;
  const profile = await readProfile(version);
  const pack = JSON.parse(await readFile(new URL(`../${packPath(version)}`, import.meta.url)));
  const { digest, ...contents } = pack;
  if (sha256(Buffer.from(JSON.stringify(contents))) !== digest || pack.clientVersion !== version) throw new Error('汉化包内容或适配版本校验失败');
  if (pack.adapterSha256 !== await adapterDigest()) throw new Error('语言加载适配器与汉化包版本不匹配');
  return { profile, pack };
}
