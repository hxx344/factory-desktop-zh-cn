import { readFile, writeFile, mkdir, rename, copyFile, realpath, open, lstat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sha256 } from './asar.mjs';
import { patchClient } from './patch.mjs';

async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function atomicJson(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
const names = { exe: 'factory-desktop.exe', asar: 'resources/app.asar' };

async function assertRegularPaths(root) {
  for (const name of ['resources', ...Object.values(names)]) {
    if ((await lstat(join(root, name))).isSymbolicLink()) throw new Error('客户端路径不能是符号链接或目录联接');
  }
}

export function assertStopped(root) {
  if (process.platform !== 'win32') throw new Error('安装与恢复仅支持 Windows');
  // Only inspect executable paths; never stop user sessions automatically.
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process -Filter \"name='factory-desktop.exe'\" | Select-Object -ExpandProperty ExecutablePath) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
  const paths = output.trim() ? JSON.parse(output) : [];
  if ([].concat(paths).some(path => path && resolve(path).toLowerCase() === join(root, names.exe).toLowerCase())) throw new Error('Factory 正在运行。请从应用菜单正常退出后重试；不会自动结束会话。');
}

export async function resolveInstall(path) {
  if (path) return realpath(path);
  const root = join(process.env.LOCALAPPDATA ?? '', 'Factory');
  const response = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@((Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object DisplayName -eq 'Factory' | Select-Object -ExpandProperty InstallLocation)) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
  const locations = response.trim() ? [].concat(JSON.parse(response)) : [];
  const base = locations.find(path => path && !path.includes('WindowsApps')) ?? root;
  const { readdir } = await import('node:fs/promises');
  const directories = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^app-\d+\.\d+\.\d+$/.test(entry.name));
  directories.sort((a, b) => {
    const x = a.name.slice(4).split('.').map(Number), y = b.name.slice(4).split('.').map(Number);
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  if (!directories.length) throw new Error('未找到 Factory 安装目录，可使用 -InstallDir 指定 app-x.y.z 目录');
  return realpath(join(base, directories[0].name));
}

export async function inspect(root, profile) {
  const current = {};
  for (const [kind, name] of Object.entries(names)) current[kind] = sha256(await readFile(join(root, name)));
  const receiptPath = join(root, '.factory-zh-cn', 'receipt.json');
  const receipt = await exists(receiptPath) ? await json(receiptPath) : null;
  let state = 'unknown';
  if (current.exe === profile.exeSha256 && current.asar === profile.asarSha256) state = 'original';
  else if (receipt?.clientVersion === profile.version && current.exe === receipt.patched.exe && current.asar === receipt.patched.asar) state = 'installed';
  else if (receipt?.clientVersion === profile.version && Object.keys(names).every(kind => [receipt.original[kind], receipt.patched[kind], receipt.previous?.[kind]].includes(current[kind]))) state = 'interrupted';
  return { state, current, receipt };
}

export async function install(rootInput, profile, pack, options = {}) {
  const root = await realpath(rootInput);
  await assertRegularPaths(root);
  if (root.toLowerCase().includes('windowsapps')) throw new Error('首版不支持 MSIX / WindowsApps 安装');
  const backup = join(root, '.factory-zh-cn');
  if (await exists(backup)) {
    const stat = await lstat(backup);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('备份目录类型异常');
  }
  await mkdir(backup, { recursive: true });
  const lockPath = join(backup, 'install.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw new Error('存在安装锁；确认没有其他安装进程后删除 .factory-zh-cn/install.lock 再重试'); throw error; }
  const tempNames = [];
  try {
    const before = await inspect(root, profile);
    if (before.state === 'unknown') throw new Error('未知客户端版本或文件已被其他程序修改；未覆盖任何资源');
    if (before.state === 'installed' && before.receipt.digest === pack.digest) return { state: 'unchanged', version: pack.version };
    (options.checkStopped ?? assertStopped)(root);
    const originals = {};
    const previousBytes = {};
    for (const [kind, name] of Object.entries(names)) {
      previousBytes[kind] = await readFile(join(root, name));
      if (sha256(previousBytes[kind]) !== before.current[kind]) throw new Error('安装期间客户端文件发生变化');
      const saved = join(backup, `${kind}.original`);
      if (before.state === 'original' && !await exists(saved)) await copyFile(join(root, name), saved, constants.COPYFILE_EXCL);
      originals[kind] = await readFile(saved);
      if (sha256(originals[kind]) !== profile[`${kind}Sha256`]) throw new Error(`原版备份校验失败：${kind}`);
    }
    const patched = patchClient(originals.asar, originals.exe, profile, pack);
    const receipt = { format: 1, clientVersion: profile.version, version: pack.version, digest: pack.digest, phase: 'prepared', original: { exe: profile.exeSha256, asar: profile.asarSha256 }, previous: before.current, patched: { exe: sha256(patched.exe), asar: sha256(patched.asar) } };
    for (const [kind, name] of Object.entries(names)) {
      const temporary = join(root, `${name}.factory-zh-tmp`);
      const handle = await open(temporary, 'wx');
      tempNames.push(temporary);
      try { await handle.writeFile(patched[kind]); } finally { await handle.close(); }
    }
    await atomicJson(join(backup, 'receipt.json'), receipt);
    try {
      for (const [kind, name] of Object.entries(names)) {
        const current = sha256(await readFile(join(root, name)));
        if (current !== before.current[kind]) throw new Error('安装期间客户端文件发生变化');
      }
      (options.checkStopped ?? assertStopped)(root);
      for (const [kind, name] of Object.entries(names)) {
        await rename(join(root, `${name}.factory-zh-tmp`), join(root, name));
        await options.afterReplace?.(kind);
      }
      const result = await inspect(root, profile);
      if (result.state !== 'installed') throw new Error('安装后文件校验失败');
      receipt.phase = 'installed';
      await atomicJson(join(backup, 'receipt.json'), receipt);
      return { state: 'installed', version: pack.version, coverage: pack.coverage };
    } catch (error) {
      // Restore only files written by this transaction, preserving third-party changes.
      for (const [kind, name] of Object.entries(names)) {
        const current = sha256(await readFile(join(root, name)));
        if (current === receipt.patched[kind]) {
          const temp = join(root, `${name}.factory-zh-rollback`);
          await writeFile(temp, previousBytes[kind], { flag: 'wx' });
          await rename(temp, join(root, name));
        }
      }
      await atomicJson(join(backup, 'receipt.json'), before.receipt ?? { ...receipt, phase: 'rolled-back' });
      throw error;
    }
  } finally {
    for (const path of tempNames) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await lock.close();
    await unlink(lockPath);
  }
}

export async function restore(rootInput, profile, options = {}) {
  const root = await realpath(rootInput);
  await assertRegularPaths(root);
  (options.checkStopped ?? assertStopped)(root);
  const backup = join(root, '.factory-zh-cn');
  if ((await lstat(backup).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))?.isSymbolicLink()) throw new Error('备份目录类型异常');
  const before = await inspect(root, profile);
  if (before.state === 'original') return { state: 'unchanged' };
  if (!['installed', 'interrupted'].includes(before.state)) throw new Error('文件已升级或被修改；为保留现有版本，拒绝恢复旧备份');
  const lockPath = join(backup, 'install.lock');
  const lock = await open(lockPath, 'wx');
  const temps = [];
  try {
    const originals = {};
    const previousBytes = {};
    for (const kind of Object.keys(names)) {
      originals[kind] = await readFile(join(backup, `${kind}.original`));
      if (sha256(originals[kind]) !== profile[`${kind}Sha256`]) throw new Error('备份校验失败');
      previousBytes[kind] = await readFile(join(root, names[kind]));
      if (sha256(previousBytes[kind]) !== before.current[kind]) throw new Error('恢复期间客户端文件发生变化');
    }
    for (const [kind, name] of Object.entries(names)) {
      const temporary = join(root, `${name}.factory-zh-restore`);
      const handle = await open(temporary, 'wx');
      temps.push(temporary);
      try { await handle.writeFile(originals[kind]); } finally { await handle.close(); }
    }
    for (const [kind, name] of Object.entries(names)) {
      const current = sha256(await readFile(join(root, name)));
      if (current !== before.current[kind]) throw new Error('恢复期间客户端文件发生变化');
    }
    (options.checkStopped ?? assertStopped)(root);
    try {
      for (const [kind, name] of Object.entries(names)) {
        await rename(join(root, `${name}.factory-zh-restore`), join(root, name));
        await options.afterReplace?.(kind);
      }
      if ((await inspect(root, profile)).state !== 'original') throw new Error('恢复后文件校验失败');
      await atomicJson(join(backup, 'receipt.json'), { ...before.receipt, phase: 'restored' });
      return { state: 'restored' };
    } catch (error) {
      for (const [kind, name] of Object.entries(names)) {
        if (sha256(await readFile(join(root, name))) === profile[`${kind}Sha256`]) {
          const temp = join(root, `${name}.${randomUUID()}.rollback`);
          await writeFile(temp, previousBytes[kind], { flag: 'wx' });
          await rename(temp, join(root, name));
        }
      }
      throw error;
    }
  } finally {
    for (const path of temps) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await lock.close(); await unlink(lockPath);
  }
}
