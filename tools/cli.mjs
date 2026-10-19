import { readFile } from 'node:fs/promises';
import { resolveInstall, inspect, install, restore } from './install.mjs';
import { sha256 } from './asar.mjs';
import { adapterDigest } from './patch.mjs';

try {
  const [command = 'status', ...args] = process.argv.slice(2);
  const root = await resolveInstall(args[0]);
  const profile = JSON.parse(await readFile(new URL('../profiles/0.201.0.json', import.meta.url)));
  const pack = JSON.parse(await readFile(new URL('../pack/zh-CN.json', import.meta.url)));
  const { digest, ...contents } = pack;
  if (sha256(Buffer.from(JSON.stringify(contents))) !== digest || pack.clientVersion !== profile.version) throw new Error('汉化包内容或适配版本校验失败');
  if (pack.adapterSha256 !== await adapterDigest()) throw new Error('语言加载适配器与汉化包版本不匹配');
  let result;
  if (command === 'status') result = await inspect(root, profile);
  else if (command === 'install') result = await install(root, profile, pack);
  else if (command === 'restore') result = await restore(root, profile);
  else throw new Error('命令：install / status / restore [安装目录]');
  const labels = { original: '原版，未安装汉化包', installed: '汉化包已安装', interrupted: '安装被中断，可重新安装或恢复', unknown: '未知版本或文件已修改', unchanged: '无需更改，已跳过写入', restored: '已恢复原版' };
  console.log(labels[result.state] ?? result.state);
  console.log(`目录：${root}`);
  if (result.version) console.log(`汉化包：${result.version}`);
  if (command === 'install' && result.state === 'installed') console.log('启动 Factory，在 Settings → General → Language 中选择“简体中文”。原版文件已备份，恢复后可还原官方签名。');
} catch (error) {
  console.error(`操作未完成：${error.message}`);
  process.exitCode = 1;
}
