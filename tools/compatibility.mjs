import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { parse, parseExpressionAt, extractCatalog } from './catalog.mjs';
import { parseAsar, sha256 } from './asar.mjs';

const fail = message => { throw new Error(`前向兼容检查失败：${message}；未修改客户端`); };
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function isForwardCompatible(version, baseline = '1.4.1') {
  if (!stable.test(version) || !stable.test(baseline)) return false;
  const [major, minor, patch] = version.split('.').map(Number), [baseMajor, baseMinor, basePatch] = baseline.split('.').map(Number);
  return [major, minor, patch, baseMajor, baseMinor, basePatch].every(Number.isSafeInteger)
    && major === baseMajor && minor <= baseMinor + 5 && (minor > baseMinor || minor === baseMinor && patch > basePatch);
}

export function verifyOfficialExecutable(path) {
  if (process.platform !== 'win32') fail('仅支持 Windows 官方签名校验');
  const script = "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'); $s=Get-AuthenticodeSignature -LiteralPath $env:FACTORY_ZH_VERIFY_EXE; [pscustomobject]@{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress";
  const signature = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, FACTORY_ZH_VERIFY_EXE: path },
  }));
  assertOfficialSignature(signature);
  return { publisher: 'The San Francisco AI Factory, Inc.' };
}

export function assertOfficialSignature(signature) {
  if (signature.status !== 'Valid' || !/(?:^|,\s*)O="The San Francisco AI Factory, Inc\."(?:,|$)/.test(signature.subject ?? '')) fail('EXE 不是具有有效 Factory 官方签名的原版');
}

export function verifyArchiveBinding(archive, exeBytes) {
  const hash = sha256(archive.rawHeader), needle = Buffer.from(hash), index = exeBytes.indexOf(needle);
  if (index < 0 || exeBytes.indexOf(needle, index + 1) >= 0) fail('EXE 与 ASAR 原始头部校验记录不匹配');
  const context = exeBytes.subarray(Math.max(0, index - 160), index + 66).toString();
  if (!context.includes('resources\\\\app.asar') || !/"alg"\s*:\s*"sha256"/i.test(context) || !/"value"\s*:\s*"[a-f0-9]{64}"/.test(context)) fail('未知 Electron ASAR 完整性记录');
}

function verifyEntry(archive, path) {
  const data = archive.read(path), integrity = archive.entries.get(path).integrity;
  if (integrity?.algorithm?.toUpperCase() !== 'SHA256' || integrity.hash !== sha256(data)) fail(`资源完整性不匹配：${path}`);
  return data;
}
const verifiedRead = (archive, path) => verifyEntry(archive, path).toString('utf8');
function nodes(root, predicate) {
  const result = [], stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node.type === 'string' && predicate(node)) result.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      if (Array.isArray(child)) stack.push(...child);
      else if (child && typeof child === 'object') stack.push(child);
    }
  }
  return result;
}
const member = (node, name) => node?.type === 'MemberExpression' && !node.computed && node.property.name === name;
const key = property => property?.computed ? null : property?.key?.name ?? property?.key?.value;
const property = (object, name) => object?.type === 'ObjectExpression' ? object.properties.find(item => key(item) === name)?.value : null;
const only = (values, label) => values.length === 1 ? values[0] : fail(`${label}必须唯一，发现 ${values.length} 项`);
const statements = ast => ast.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node).filter(Boolean);
function languageModule(source, renderer) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const top = statements(ast), declarations = top.filter(node => node.type === 'VariableDeclaration').flatMap(node => node.declarations).filter(node => node.id.type === 'Identifier');
  const functions = top.filter(node => node.type === 'FunctionDeclaration');
  const enumNode = only(declarations.filter(node => {
    const assignments = nodes(node.init, item => item.type === 'AssignmentExpression');
    return [['English', 'en'], ['Japanese', 'ja'], ['ChineseSimplified', 'zh-CN']].every(([name, value]) => assignments.some(item => member(item.left, name) && item.right.value === value));
  }), '语言枚举');
  const enumName = enumNode.id.name;
  const languageKey = (node, name) => node?.computed && member(node.key, name) && node.key.object.name === enumName;
  function validateLanguageTable(node) {
    const enumValues = new Map(nodes(enumNode.init, item => item.type === 'AssignmentExpression' && item.left.type === 'MemberExpression' && !item.left.computed && typeof item.right.value === 'string').map(item => [item.left.property.name, item.right.value]));
    const seen = new Set();
    for (const item of node.init.properties) {
      if (item.type !== 'Property' || item.kind !== 'init' || item.method || item.shorthand) fail('语言资源表含动态或未知属性');
      let locale;
      if (item.computed && item.key.type === 'MemberExpression' && !item.key.computed && item.key.object.name === enumName) locale = enumValues.get(item.key.property.name);
      else if (item.key.type === 'Literal') locale = item.key.value;
      else if (!item.computed) locale = item.key.name;
      else if (item.key.type === 'Identifier') locale = declarations.find(entry => entry.id.name === item.key.name)?.init?.value;
      if (typeof locale !== 'string') fail('语言资源表含未知计算键');
      if (locale.toLowerCase() === 'zh-cn') fail('语言资源表已注册简体中文');
      if (seen.has(locale)) fail('语言资源表含重复语言');
      seen.add(locale);
    }
  }
  const supported = only(declarations.filter(node => node.init?.type === 'ArrayExpression' && node.init.elements.length >= 2
    && node.init.elements.every(item => item?.type === 'MemberExpression' && item.object.name === enumName && item.property.name !== 'ChineseSimplified')
    && node.init.elements.some(item => member(item, 'English')) && node.init.elements.some(item => member(item, 'Japanese'))), '支持语言数组');
  const result = { enum: enumName, supported: supported.id.name };
  const anchors = { supported: source.slice(supported.init.start, supported.init.end) };
  if (renderer) {
    const imports = only(declarations.filter(node => node.init?.type === 'ObjectExpression' && node.init.properties.some(item => languageKey(item, 'Japanese') && nodes(item.value, child => child.type === 'ImportExpression').length)), '语言导入表');
    validateLanguageTable(imports);
    const init = only(functions.flatMap(fn => nodes(fn.body, node => node.type === 'CallExpression' && member(node.callee, 'init') && property(node.arguments[0], 'resources')?.type === 'ObjectExpression'
      && nodes(property(node.arguments[0], 'supportedLngs'), item => item.type === 'Identifier' && item.name === result.supported).length).map(call => ({ fn, call }))), 'i18n 初始化');
    const resourceObject = property(init.call.arguments[0], 'resources');
    const englishRoot = only(resourceObject.properties.filter(item => item.value?.type === 'Identifier'), '英文资源根').value.name;
    const resolve = only(functions.filter(fn => fn.params[0]?.type === 'ObjectPattern' && ['saved', 'candidates', 'supported'].every(name => fn.params[0].properties.some(item => key(item) === name))), '语言选择函数');
    const switchFn = only(functions.filter(fn => fn.async && nodes(fn.body, node => node.type === 'CallExpression' && node.callee.name === init.fn.id.name).length
      && nodes(fn.body, node => node.type === 'CallExpression' && member(node.callee, 'changeLanguage')).length), '语言切换函数');
    const persist = only([...new Set(nodes(ast, node => node.type === 'LogicalExpression' && node.operator === '&&' && node.left.type === 'AwaitExpression'
      && node.left.argument.type === 'CallExpression' && node.left.argument.callee.name === switchFn.id.name && node.right.type === 'CallExpression' && node.right.callee.type === 'Identifier').map(node => node.right.callee.name))], '启动语言缓存函数');
    const logger = only([...new Set(nodes(ast, node => node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.arguments[0]?.value === 'Failed to switch the app language').map(node => node.callee.name))], '语言错误日志函数');
    const mount = only(top.filter(node => node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' && member(node.expression.callee, 'render')
      && nodes(node.expression, child => child.type === 'CallExpression' && member(child.callee, 'createRoot')).length
      && nodes(node.expression, child => child.type === 'CallExpression' && member(child.callee, 'getElementById') && child.arguments[0]?.value === 'root').length), '应用挂载');
    const mountIndex = top.indexOf(mount);
    const directCall = statement => statement?.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression'
      && statement.expression.callee.type === 'Identifier' && !statement.expression.optional && statement.expression.arguments.length === 0;
    let previous = top[mountIndex - 1];
    if (directCall(previous) && previous.expression.callee.name !== init.fn.id.name) {
      const name = previous.expression.callee.name;
      const helpers = functions.filter(fn => fn.id?.name === name && !fn.async && !fn.generator && fn.params.length === 0);
      if (helpers.length !== 1) fail('挂载前调用不是唯一的本地同步无参函数');
      result.beforeMount = name;
      previous = top[mountIndex - 2];
    }
    if (!directCall(previous) || previous.expression.callee.name !== init.fn.id.name) fail('语言初始化与挂载关系改变');
    Object.assign(result, { imports: imports.id.name, i18n: init.fn.id.name, resolve: resolve.id.name, switch: switchFn.id.name, persist, logger, englishRoot, mount: source.slice(mount.start, mount.end) });
    Object.assign(anchors, { imports: source.slice(imports.init.start, imports.init.end), startup: source.slice(previous.start, mount.end) });
  } else {
    const resources = only(declarations.filter(node => node.init?.type === 'ObjectExpression' && node.init.properties.some(item => languageKey(item, 'English') && item.value?.type === 'Identifier') && node.init.properties.some(item => languageKey(item, 'Japanese'))), '原生语言资源表');
    validateLanguageTable(resources);
    const root = resources.init.properties.find(item => languageKey(item, 'English')).value.name;
    Object.assign(result, { resources: resources.id.name, englishRoot: root });
    anchors.resources = source.slice(resources.init.start, resources.init.end);
  }
  return { bindings: result, anchors };
}

export function discoverCompatibility(asarBytes, exeBytes, baselineVersion = '1.4.1') {
  const archive = parseAsar(asarBytes);
  verifyArchiveBinding(archive, exeBytes);
  // The signed header authenticates entry hashes; check the whole packed body once
  // before accepting a previously unseen client as a trusted original.
  for (const [path, entry] of archive.entries) if (!entry.unpacked && !entry.link) verifyEntry(archive, path);
  const version = JSON.parse(verifiedRead(archive, 'package.json')).version;
  if (!isForwardCompatible(version, baselineVersion)) fail(`Factory ${version} 不在 ${baselineVersion} 的向前 5 个小版本窗口内`);
  const htmlPath = only([...archive.entries.keys()].filter(path => path.endsWith('/index.html') && verifiedRead(archive, path).includes('var messages = ')), '启动 HTML');
  const html = verifiedRead(archive, htmlPath);
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map(match => match[1]).filter(attributes => /\btype\s*=\s*["']module["']/i.test(attributes));
  const entry = only(scripts.map(attributes => attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]).filter(Boolean), 'HTML 模块入口');
  if (!/^\.\/[\w./-]+\.js$/.test(entry)) fail('未知 HTML 模块路径');
  const rendererPath = posix.normalize(posix.join(posix.dirname(htmlPath), entry));
  if (!rendererPath.startsWith(`${posix.dirname(htmlPath)}/`)) fail('HTML 模块路径越界');
  for (const path of [posix.join(posix.dirname(rendererPath), 'resources-zh-CN.js'), 'factory-zh-CN.manifest.json']) if (archive.entries.has(path)) fail(`新增汉化资源与原包冲突：${path}`);
  const rendererSource = verifiedRead(archive, rendererPath), renderer = languageModule(rendererSource, true);
  const mainCandidates = [];
  for (const path of archive.entries.keys()) {
    if (!path.startsWith('.vite/build/') || !path.endsWith('.js')) continue;
    const source = verifiedRead(archive, path);
    if (source.includes('i18n:getLocalePreference') && source.includes('ChineseSimplified')) mainCandidates.push({ path, source });
  }
  const mainFile = only(mainCandidates, '原生 i18n 模块'), main = languageModule(mainFile.source, false);
  const raw = extractCatalog(rendererSource, renderer.bindings.englishRoot, true);
  const english = Object.fromEntries(Object.entries(raw).map(([name, value]) => [name.replace(/^.*\//, '').replace(/\.json$/, ''), value]));
  const desktop = extractCatalog(mainFile.source, main.bindings.englishRoot);
  const marker = 'var messages = ';
  if (html.split(marker).length !== 2 || html.split("var locale = 'en';").length !== 2) fail('启动页词典结构改变');
  const node = parseExpressionAt(html, html.indexOf(marker) + marker.length, { ecmaVersion: 'latest' });
  const loader = extractCatalog(`const messages=${html.slice(node.start, node.end)};`, 'messages').en;
  if (!Array.isArray(loader)) fail('启动页英文词典不是数组');
  const files = Object.fromEntries(Object.entries({ renderer: rendererPath, main: mainFile.path, html: htmlPath }).map(([kind, path]) => [kind, { path, sha256: sha256(archive.read(path)) }]));
  const profile = { version, platform: 'win32', arch: 'x64', exeSha256: sha256(exeBytes), asarSha256: sha256(asarBytes), adapter: { renderer: renderer.bindings, main: main.bindings }, files,
    compatibility: { baselineVersion, renderer: renderer.anchors, main: main.anchors } };
  return { profile, catalogs: { renderer: english, desktop, loader } };
}

export function reuseCatalog(current, translated, hashes) {
  if (!hashes || Object.values(hashes).some(hash => !/^[a-f0-9]{64}$/.test(hash))) fail('基线包缺少有效英文词条摘要');
  // Preserve literal key names (including dots) and arrays when writing translations.
  // Flattened identifiers are only for matching the signed baseline inventory.
  function entries(value, segments = [], found = new Map()) {
    for (const [name, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(name)) fail('不安全的词典键');
      const path = [...segments, name], key = path.join('.');
      if (typeof child === 'string') {
        if (found.has(key)) fail(`词典键路径有歧义：${key}`);
        found.set(key, { path, source: child });
      } else if (child && typeof child === 'object') entries(child, path, found);
      else fail(`词典含非字符串值：${key}`);
    }
    return found;
  }
  const targets = entries(translated), currentEntries = entries(current), byHash = new Map();
  for (const [name, hash] of Object.entries(hashes)) {
    if (!targets.has(name)) fail(`基线词条缺少译文：${name}`);
    if (!byHash.has(hash)) byHash.set(hash, new Set());
    byHash.get(hash).add(targets.get(name).source);
  }
  const result = structuredClone(current), coverage = { translated: 0, preserved: 0, reusedByKey: 0, reusedBySource: 0, fallback: 0, covered: 0, total: 0 };
  for (const [name, { path, source }] of currentEntries) {
    coverage.total++;
    const hash = sha256(Buffer.from(source)), matching = byHash.get(hash);
    let target;
    if (hashes[name] === hash) { target = targets.get(name).source; coverage.reusedByKey++; }
    else if (matching?.size === 1) { [target] = matching; coverage.reusedBySource++; }
    if (target === undefined) { coverage.fallback++; continue; }
    let node = result;
    for (const segment of path.slice(0, -1)) node = node[segment];
    node[path.at(-1)] = target;
    coverage.covered++;
    if (target === source) coverage.preserved++;
    else coverage.translated++;
  }
  return { resources: result, coverage };
}

export function buildCompatibilityPack(profile, catalogs, baseline) {
  const outputs = {};
  for (const [name, target] of [['renderer', baseline.resources], ['desktop', baseline.desktop], ['loader', baseline.loader]]) outputs[name] = reuseCatalog(catalogs[name], target, baseline.sourceHashes?.[name]);
  const pack = { version: baseline.version, clientVersion: profile.version, locale: baseline.locale, adapterSha256: baseline.adapterSha256,
    compatibility: { baselineVersion: baseline.clientVersion, baselineDigest: baseline.digest, profileSha256: sha256(Buffer.from(JSON.stringify(profile))), hardcoded: 'skipped' },
    resources: outputs.renderer.resources, desktop: outputs.desktop.resources, loader: outputs.loader.resources,
    coverage: Object.fromEntries(Object.entries(outputs).map(([name, output]) => [name, output.coverage])) };
  pack.digest = sha256(Buffer.from(JSON.stringify(pack)));
  return pack;
}
