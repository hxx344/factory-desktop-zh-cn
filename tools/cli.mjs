import { resolveInstall, inspect, install, restore } from './install.mjs';
import { loadTarget } from './versions.mjs';

try {
  const [command = 'status', ...args] = process.argv.slice(2);
  const root = await resolveInstall(args[0]);
  const { profile, pack } = await loadTarget(root);
  let result;
  if (command === 'status') result = await inspect(root, profile);
  else if (command === 'install') result = await install(root, profile, pack);
  else if (command === 'restore') result = await restore(root, profile);
  else throw new Error('命令：install / status / restore [安装目录]');
  const labels = { original: '原版，未安装汉化包', installed: '汉化包已安装', interrupted: '安装被中断，可重新安装或恢复', unknown: '未知版本或文件已修改', unchanged: '无需更改，已跳过写入', restored: '已恢复原版' };
  console.log(labels[result.state] ?? result.state);
  console.log(`目录：${root}`);
  console.log(`Factory：${profile.version}`);
  if (result.version) console.log(`汉化包：${result.version}`);
  if (command === 'install' && result.state === 'installed') console.log('启动 Factory，在 Settings → General → Language 中选择“简体中文”。原版文件已备份，恢复后可还原官方签名。');
} catch (error) {
  console.error(`操作未完成：${error.message}`);
  process.exitCode = 1;
}
