import { parseAsar, writeAsar, sha256 } from './asar.mjs';

export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`语言加载代码不匹配：${before.slice(0, 70)}`);
  return source.replace(before, after);
}

export function patchIntegrity(executable, oldHash, newHash) {
  const oldValue = Buffer.from(oldHash);
  const index = executable.indexOf(oldValue);
  if (index < 0 || executable.indexOf(oldValue, index + 1) !== -1) throw new Error('EXE 中的原始 ASAR 校验记录不唯一');
  const context = executable.subarray(Math.max(0, index - 160), index + 66).toString('utf8');
  if (!context.includes('resources\\\\app.asar') || !/"alg"\s*:\s*"sha256"/i.test(context) || !/"value"\s*:\s*"[a-f0-9]{64}"/.test(context)) throw new Error('不是已知的 ElectronAsar 完整性记录');
  const patched = Buffer.from(executable);
  patched.write(newHash, index, 64, 'ascii');
  return patched;
}

export function patchClient(asarBytes, exeBytes, profile, pack) {
  if (sha256(asarBytes) !== profile.asarSha256 || sha256(exeBytes) !== profile.exeSha256) throw new Error('客户端指纹不匹配；未修改任何文件');
  const asar = parseAsar(asarBytes);
  if (JSON.parse(asar.read('package.json')).version !== profile.version) throw new Error('客户端版本不匹配');
  for (const file of Object.values(profile.files)) if (sha256(asar.read(file.path)) !== file.sha256) throw new Error(`资源指纹不匹配：${file.path}`);
  let renderer = asar.read(profile.files.renderer.path).toString('utf8');
  renderer = replaceOnce(renderer, 'iZe=[Ju.English,Ju.Japanese,', 'iZe=[Ju.English,Ju.ChineseSimplified,Ju.Japanese,');
  renderer = replaceOnce(renderer, 'YSu={[Ju.Japanese]:', 'YSu={[Ju.ChineseSimplified]:async()=>await Pt(()=>import("./resources-zh-CN.js"),[],import.meta.url),[Ju.Japanese]:');
  // The vendor mounts its language preference observer only after sign-in.
  // Apply the same preference on startup so the signed-out screen is localized too.
  renderer = replaceOnce(renderer, 'eon();y9o.createRoot(', 'eon();window.electronAPI?.i18n?.getPreference().then(async p=>{const l=upc({saved:p.savedLocale,candidates:p.systemLanguages,supported:iZe});await XSu(l)&&tMu(l)}).catch(e=>Je("Failed to apply startup language",{cause:e}));y9o.createRoot(');
  let main = asar.read(profile.files.main.path).toString('utf8');
  main = replaceOnce(main, 'v3=[Se.English,Se.Japanese,', 'v3=[Se.English,Se.ChineseSimplified,Se.Japanese,');
  main = replaceOnce(main, 'rC={[Se.English]:nC,', `rC={[Se.ChineseSimplified]:${JSON.stringify(pack.desktop)},[Se.English]:nC,`);
  let html = asar.read(profile.files.html.path).toString('utf8');
  html = replaceOnce(html, 'var messages = {', `var messages = {"zh-CN":${JSON.stringify(pack.loader)},`);
  const replacements = new Map([
    [profile.files.renderer.path, Buffer.from(renderer)],
    [profile.files.main.path, Buffer.from(main)],
    [profile.files.html.path, Buffer.from(html)],
    ['.vite/renderer/main_window/assets/resources-zh-CN.js', Buffer.from(`export const resources=${JSON.stringify(pack.resources)};\n`)],
    ['factory-zh-CN.manifest.json', Buffer.from(JSON.stringify({ version: pack.version, digest: pack.digest, clientVersion: profile.version }))],
  ]);
  const patchedAsar = writeAsar(asar, replacements);
  const patchedExe = patchIntegrity(exeBytes, sha256(asar.rawHeader), sha256(parseAsar(patchedAsar).rawHeader));
  return { asar: patchedAsar, exe: patchedExe };
}
