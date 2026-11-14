import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parseAsar, writeAsar, sha256 } from '../tools/asar.mjs';
import { discoverCompatibility, isForwardCompatible, reuseCatalog, buildCompatibilityPack, assertOfficialSignature } from '../tools/compatibility.mjs';
import { flatten, parse } from '../tools/catalog.mjs';
import { patchClient } from '../tools/patch.mjs';
import { install, inspect, restore } from '../tools/install.mjs';
import { loadTarget, loadReceiptProfile, selectCompatibilityBaseline } from '../tools/versions.mjs';

function fixture({ version = '1.9.7', renamed = false, extra = '', beforeMount = '', mutateSource = value => value, baselineVersion = '1.4.1', additionalFiles = {} } = {}) {
  const r = renamed ? '$q' : 'Lang', support = renamed ? '_a' : 'supported', init = renamed ? '$init' : 'initialize';
  const enumSource = `var ${r}=(e=>(e.English="en",e.Japanese="ja",e.ChineseSimplified="zh-CN",e.Korean="ko",e))(${r}||{});`;
  const renderer = `${enumSource}
const ${support} = [${r}.English, ${r}.Japanese, ${r}.Korean];
const english = Object.assign({"./common.json": {save:"Save",changed:"New label",newEntry:"New feature",renamed:"Cancel"}});
const imports = { [${r}.Japanese]:async()=>import('./ja.js') };
function ${init}(){const i=factory();i.init({resources:{en:english},supportedLngs:[...${support}],defaultNS:"common"});return i;}
function choose({saved:s,candidates:c=[],supported:l}){return s||c[0]||l[0]}
async function change(l){const i=${init}();await i.changeLanguage(l);return true}
function persist(l){return l}
async function observer(l){try{await change(l)&&persist(l)}catch(e){log("Failed to switch the app language",{cause:e})}}
${extra}
${init}();${beforeMount}
root.createRoot(document.getElementById("root")).render(view());`;
  const main = `${enumSource}const ${support}=[${r}.English,${r}.Japanese,${r}.Korean];const nativeEnglish={desktop:{save:"Save",unknown:"New menu"}};const nativeResources={[${r}.English]:nativeEnglish,[${r}.Japanese]:{}};ipc.handle("i18n:getLocalePreference",()=>{});`;
  const htmlPath = '.vite/renderer/main_window/index.html', rendererPath = `.vite/renderer/main_window/${renamed ? 'chunks/ui-renamed.js' : 'assets/index-new.js'}`, mainPath = `.vite/build/${renamed ? 'native-renamed' : 'lifecycle-new'}.js`;
  const files = new Map([
    ['package.json', Buffer.from(JSON.stringify({ version }))],
    [htmlPath, Buffer.from(`<script type="module" src="./${rendererPath.split('/').slice(-2).join('/')}"></script><script>var messages = {en:["Loading",{tip:"New tip"}]};var locale = 'en';</script>`)],
    [rendererPath, Buffer.from(mutateSource(renderer))], [mainPath, Buffer.from(main)], ['untouched.txt', Buffer.from('preserve')],
    ...Object.entries(additionalFiles).map(([path, value]) => [path, Buffer.from(value)]),
  ]);
  const asar = writeAsar({ header: { files: {} }, bytes: Buffer.alloc(0), base: 0 }, files);
  const hash = sha256(parseAsar(asar).rawHeader);
  const exe = Buffer.from(`MZ-fixture:[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${hash}"}]`);
  const discovered = () => discoverCompatibility(asar, exe, baselineVersion);
  return { asar, exe, discovered, rendererPath, mainPath };
}

function baseline() {
  const original = { renderer: { common: { save: 'Save', changed: 'Old label', cancel: 'Cancel' } }, desktop: { desktop: { save: 'Save' } }, loader: ['Loading', { tip: 'Old tip' }] };
  const pack = { version: '0.4.0', clientVersion: '1.4.1', locale: 'zh-CN', adapterSha256: 'test-adapter', digest: 'test-baseline', resources: { common: { save: '保存', changed: '旧标签', cancel: '取消' } }, desktop: { desktop: { save: '保存' } }, loader: ['正在加载', { tip: '旧提示' }], sourceHashes: {} };
  for (const [name, catalog] of Object.entries(original)) pack.sourceHashes[name] = Object.fromEntries(Object.entries(flatten(catalog)).map(([name, source]) => [name, sha256(Buffer.from(source))]));
  return pack;
}

async function directory(t, fixture) {
  const root = await mkdtemp(join(tmpdir(), 'factory-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'resources'));
  await writeFile(join(root, 'resources/app.asar'), fixture.asar);
  await writeFile(join(root, 'factory-desktop.exe'), fixture.exe);
  return root;
}

test('forward window accepts same-minor patches and +5 minors, and refuses +6, major, old and unstable versions', () => {
  for (const version of ['1.4.2', '1.4.999', '1.5.0', '1.9.0', '1.9.999']) assert.ok(isForwardCompatible(version), version);
  for (const version of ['1.4.1', '1.4.0', '1.3.1', '0.206.1', '1.10.0', '2.0.0', '1.5.0-beta.1', '1.5.0+build', '01.5.0', '1.5', '../1.5.0', '1.9007199254740992.0']) assert.equal(isForwardCompatible(version), false, version);
});

test('new exact profiles retain older compatibility windows and use the nearest available baseline', () => {
  const versions = {
    '1.4.2': '1.4.1', '1.4.999': '1.4.1', '1.5.0': '1.4.1', '1.6.0': '1.4.1',
    '1.6.2': '1.6.1', '1.7.1': '1.7.0', '1.8.0': '1.7.0', '1.8.999': '1.7.0',
    '1.9.1': '1.9.0', '1.9.999': '1.9.0', '1.10.1': '1.10.0', '1.11.0': '1.10.0', '1.12.0': '1.10.0',
    '1.12.2': '1.12.1', '1.17.0': '1.12.1', '1.17.999': '1.12.1',
  };
  for (const [version, baseline] of Object.entries(versions)) assert.equal(selectCompatibilityBaseline(version), baseline, version);
  for (const version of ['0.206.1', '1.3.1', '1.4.0', '1.18.0', '2.0.0', '1.13.0-beta.1', '1.13.0+build', '01.13.0']) {
    assert.equal(selectCompatibilityBaseline(version), null, version);
  }
});

test('target loading reuses the matching historical pack instead of requiring the latest baseline', async t => {
  for (const [version, baselineVersion] of [['1.5.0', '1.4.1'], ['1.6.2', '1.6.1'], ['1.8.0', '1.7.0'], ['1.9.2', '1.9.0'], ['1.12.0', '1.10.0'], ['1.17.1', '1.12.1']]) {
    const f = fixture({ version, baselineVersion }), root = await directory(t, f);
    const target = await loadTarget(root, { verifyOfficial() {} });
    assert.equal(target.profile.version, version);
    assert.equal(target.profile.compatibility.baselineVersion, baselineVersion);
    assert.equal(target.pack.compatibility.baselineVersion, baselineVersion);
    assert.deepEqual(await readFile(join(root, 'resources/app.asar')), f.asar);
  }
});

test('official trust checks require both a valid Authenticode signature and the Factory publisher', () => {
  const subject = 'CN="The San Francisco AI Factory, Inc.", O="The San Francisco AI Factory, Inc.", C=US';
  assert.doesNotThrow(() => assertOfficialSignature({ status: 'Valid', subject }));
  for (const signature of [{ status: 'HashMismatch', subject }, { status: 'NotSigned', subject }, { status: 'Valid', subject: 'CN=Factory, O=Other Company, C=US' }, { status: 'Valid', subject: `${subject.replace('O="The', 'O="Not The')}` }]) assert.throws(() => assertOfficialSignature(signature), /官方签名/);
});

test('HTML entry and AST discovery tolerate renamed assets, minified bindings and whitespace', () => {
  const f = fixture({ renamed: true }), { profile, catalogs } = f.discovered();
  assert.equal(profile.version, '1.9.7');
  assert.equal(profile.adapter.renderer.enum, '$q');
  assert.equal(profile.files.renderer.path, f.rendererPath);
  assert.equal(profile.files.main.path, f.mainPath);
  assert.equal(catalogs.renderer.common.save, 'Save');
  const pack = buildCompatibilityPack(profile, catalogs, baseline());
  const patched = patchClient(f.asar, f.exe, profile, pack), archive = parseAsar(patched.asar);
  assert.equal(archive.read('untouched.txt').toString(), 'preserve');
  assert.match(archive.read('.vite/renderer/main_window/chunks/resources-zh-CN.js').toString(), /保存/);
  assert.match(archive.read(f.mainPath).toString(), /New menu/);
  for (const path of [f.rendererPath, f.mainPath]) assert.doesNotThrow(() => parse(archive.read(path).toString(), { ecmaVersion: 'latest', sourceType: 'module' }));
});

test('a local startup hook runs once before asynchronous locale loading, including preference failure', async () => {
  for (const rejectPreference of [false, true]) {
    const f = fixture({ extra: 'function setup(){mark("hook")}', beforeMount: 'setup();' });
    const { profile, catalogs } = f.discovered();
    assert.equal(profile.adapter.renderer.beforeMount, 'setup');
    assert.match(profile.compatibility.renderer.startup, /^initialize\(\);setup\(\);\s*root\.createRoot/);
    const patched = parseAsar(patchClient(f.asar, f.exe, profile, buildCompatibilityPack(profile, catalogs, baseline())).asar);
    const events = [];
    let finishPreference;
    const preference = new Promise((resolve, reject) => { finishPreference = rejectPreference ? reject : resolve; });
    const completed = runInNewContext(patched.read(f.rendererPath).toString(), {
      mark: value => events.push(value),
      factory: () => ({ init() { events.push('init'); }, async changeLanguage() { events.push('language'); } }),
      window: { electronAPI: { i18n: { getPreference() { events.push('preference'); return preference; } } } },
      document: { getElementById: () => ({}) },
      root: { createRoot: () => ({ render() { events.push('mount'); } }) },
      view: () => ({}), log: () => events.push('error'), setTimeout, clearTimeout,
    });
    assert.deepEqual(events, ['init', 'hook', 'preference']);
    finishPreference(rejectPreference ? new Error('preference unavailable') : { savedLocale: 'zh-CN', systemLanguages: ['en'] });
    await completed;
    assert.deepEqual(events, rejectPreference ? ['init', 'hook', 'preference', 'error', 'mount'] : ['init', 'hook', 'preference', 'init', 'language', 'mount']);
  }
});

test('startup discovery refuses control flow, extra calls and unverified hook declarations', () => {
  for (const beforeMount of ['setup(1);', 'holder.setup();', 'setup?.();', 'if(true)setup();', 'true&&setup();', '(setup(),setup());', 'await setup();', 'setup();setup();']) {
    assert.throws(() => fixture({ extra: 'function setup(){}', beforeMount }).discovered(), /语言初始化与挂载关系改变/);
  }
  for (const extra of ['', 'async function setup(){}', 'function* setup(){}', 'function setup(value){}']) {
    assert.throws(() => fixture({ extra, beforeMount: 'setup();' }).discovered(), /本地同步无参函数/);
  }
});

test('compatibility keeps the original default language when saved and system preferences are absent', () => {
  const f = fixture(), { profile, catalogs } = f.discovered();
  const archive = parseAsar(patchClient(f.asar, f.exe, profile, buildCompatibilityPack(profile, catalogs, baseline())).asar);
  for (const path of [f.rendererPath, f.mainPath]) {
    const source = archive.read(path).toString(), ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const declaration = ast.body.filter(node => node.type === 'VariableDeclaration').flatMap(node => node.declarations).find(node => node.id.name === 'supported');
    // This evaluates only the small synthetic fixture's language array and resolver.
    const value = runInNewContext(`const Lang={English:'en',Japanese:'ja',Korean:'ko',ChineseSimplified:'zh-CN'};const supported=${source.slice(declaration.init.start, declaration.init.end)};function choose({saved:s,candidates:c=[],supported:l}){return s||c[0]||l[0]};choose({saved:null,candidates:[],supported})`);
    assert.equal(value, 'en');
  }
});

test('changed and unknown English stays intact while unambiguous identical source text moves between keys', () => {
  const f = fixture(), { profile, catalogs } = f.discovered(), pack = buildCompatibilityPack(profile, catalogs, baseline());
  assert.deepEqual(pack.resources.common, { save: '保存', changed: 'New label', newEntry: 'New feature', renamed: '取消' });
  assert.deepEqual(pack.loader, ['正在加载', { tip: 'New tip' }]);
  assert.deepEqual(pack.coverage.renderer, { translated: 2, preserved: 0, reusedByKey: 1, reusedBySource: 1, fallback: 2, covered: 2, total: 4 });
  assert.equal(pack.hardcoded, undefined);
  assert.equal(pack.compatibility.hardcoded, 'skipped');
  const { digest, ...contents } = pack;
  assert.equal(digest, sha256(Buffer.from(JSON.stringify(contents))));
  const changedBaseline = buildCompatibilityPack(profile, catalogs, { ...baseline(), digest: 'another-baseline' });
  assert.notEqual(changedBaseline.digest, digest);
});

test('ambiguous source translations require an unchanged key, and static extraction does not run code', () => {
  const hash = sha256(Buffer.from('Open'));
  const result = reuseCatalog({ action: 'Open', newKey: 'Open', brand: 'Factory' }, { action: '打开', status: '开放', brand: 'Factory' }, { action: hash, status: hash, brand: sha256(Buffer.from('Factory')) });
  assert.deepEqual(result.resources, { action: '打开', newKey: 'Open', brand: 'Factory' });
  assert.equal(result.coverage.fallback, 1);
  assert.equal(result.coverage.preserved, 1);
  assert.throws(() => fixture({ mutateSource: source => source.replace('save:"Save"', 'save:process.exit(99)') }).discovered(), /Non-static/);
});

test('literal dotted keys retain their shape and colliding flattened paths are rejected', () => {
  const hash = sha256(Buffer.from('Save'));
  const result = reuseCatalog({ common: { 'button.save': 'Save' } }, { common: { save: '保存' } }, { 'common.save': hash });
  assert.deepEqual(result.resources, { common: { 'button.save': '保存' } });
  assert.equal(result.coverage.translated, 1);
  assert.throws(() => reuseCatalog({ common: { 'button.save': 'Save', button: { save: 'Save' } } }, { common: { save: '保存' } }, { 'common.save': hash }), /词典键路径有歧义/);
});

test('ambiguous adapter structures and altered archive bytes are rejected', () => {
  for (const path of ['.vite/renderer/main_window/assets/resources-zh-CN.js', 'factory-zh-CN.manifest.json']) assert.throws(() => fixture({ additionalFiles: { [path]: 'pre-existing official resource' } }).discovered(), /资源与原包冲突/);
  assert.throws(() => fixture({ extra: 'const duplicate=[Lang.English,Lang.Japanese];' }).discovered(), /必须唯一/);
  assert.throws(() => fixture({ mutateSource: source => source.replace('const imports = {', 'const imports = { [Lang.ChineseSimplified]:async()=>import("./official-zh.js"),') }).discovered(), /已注册简体中文/);
  assert.throws(() => fixture({ mutateSource: source => source.replace('const imports = {', 'const imports = { ["zh-CN"]:async()=>import("./official-zh.js"),') }).discovered(), /已注册简体中文/);
  assert.throws(() => fixture({ mutateSource: source => source.replace('const imports = {', 'const imports = { ...extraLanguages,') }).discovered(), /动态或未知属性/);
  const f = fixture(), corrupted = Buffer.from(f.asar), archive = parseAsar(corrupted);
  const entry = archive.entries.get(f.rendererPath);
  corrupted[archive.base + Number(entry.offset)] ^= 1;
  assert.throws(() => discoverCompatibility(corrupted, f.exe), /资源完整性/);
  const elsewhere = Buffer.from(f.asar), untouched = parseAsar(elsewhere).entries.get('untouched.txt');
  elsewhere[archive.base + Number(untouched.offset)] ^= 1;
  assert.throws(() => discoverCompatibility(elsewhere, f.exe), /资源完整性/);
  assert.throws(() => discoverCompatibility(f.asar, Buffer.from('unrelated executable')), /头部校验/);
});

test('compatibility install, no-op reinstall, readonly status and receipt-based restore preserve original bytes', async t => {
  const f = fixture(), root = await directory(t, f), { profile, catalogs } = f.discovered(), pack = buildCompatibilityPack(profile, catalogs, baseline());
  const options = { checkStopped() {} }, loading = { verifyOfficial() {} };
  assert.equal((await install(root, profile, pack, options)).state, 'installed');
  const before = (await stat(join(root, 'resources/app.asar'))).mtimeMs;
  const saved = await loadReceiptProfile(root, loading);
  assert.deepEqual(saved.profile, profile);
  assert.equal((await install(root, saved.profile, pack, options)).state, 'unchanged');
  assert.equal((await stat(join(root, 'resources/app.asar'))).mtimeMs, before);
  const names = await readdir(join(root, '.factory-zh-cn'));
  const status = await loadTarget(root, { ...loading, command: 'status' });
  assert.equal((await inspect(root, status.profile)).state, 'installed');
  assert.deepEqual(await readdir(join(root, '.factory-zh-cn')), names);
  const target = await loadTarget(root, { ...loading, command: 'restore' });
  assert.equal(target.pack, undefined);
  assert.equal((await restore(root, target.profile, options)).state, 'restored');
  assert.deepEqual(await readFile(join(root, 'resources/app.asar')), f.asar);
  assert.deepEqual(await readFile(join(root, 'factory-desktop.exe')), f.exe);
});

test('saved profiles keep restore available after the compatibility window changes', async t => {
  const f = fixture({ version: '1.20.0', baselineVersion: '1.15.1' }), root = await directory(t, f), { profile, catalogs } = f.discovered();
  const pack = buildCompatibilityPack(profile, catalogs, { ...baseline(), clientVersion: '1.15.1' });
  await install(root, profile, pack, { checkStopped() {} });
  assert.equal(isForwardCompatible(profile.version), false);
  const target = await loadTarget(root, { command: 'restore', verifyOfficial() {} });
  assert.equal((await restore(root, target.profile, { checkStopped() {} })).state, 'restored');
});

test('compatible install and restore failures roll back, and upgrade or third-party bytes are never overwritten', async t => {
  const f = fixture(), root = await directory(t, f), { profile, catalogs } = f.discovered(), pack = buildCompatibilityPack(profile, catalogs, baseline());
  const failed = { checkStopped() {}, afterReplace() { throw new Error('simulated failure'); } };
  await assert.rejects(install(root, profile, pack, failed), /simulated failure/);
  assert.equal((await inspect(root, profile)).state, 'original');
  await install(root, profile, pack, { checkStopped() {} });
  await assert.rejects(restore(root, profile, failed), /simulated failure/);
  assert.equal((await inspect(root, profile)).state, 'installed');
  const backup = await readFile(join(root, '.factory-zh-cn/asar.original'));
  await writeFile(join(root, 'factory-desktop.exe'), 'new official upgrade or third-party data');
  await assert.rejects(restore(root, profile, { checkStopped() {} }), /已升级或被修改/);
  await assert.rejects(install(root, profile, pack, { checkStopped() {} }), /未知客户端/);
  assert.deepEqual(await readFile(join(root, '.factory-zh-cn/asar.original')), backup);
});

test('corrupt persisted profiles and backups cannot authorize recovery', async t => {
  const f = fixture(), root = await directory(t, f), { profile, catalogs } = f.discovered();
  await install(root, profile, buildCompatibilityPack(profile, catalogs, baseline()), { checkStopped() {} });
  const path = join(root, '.factory-zh-cn/receipt.json'), receipt = JSON.parse(await readFile(path));
  await writeFile(path, JSON.stringify({ ...receipt, profile: { ...receipt.profile, version: '1.9.8' } }));
  await assert.rejects(loadReceiptProfile(root, { verifyOfficial() {} }), /适配信息校验/);
  await writeFile(path, JSON.stringify(receipt));
  await writeFile(join(root, '.factory-zh-cn/asar.original'), 'corrupt backup');
  await assert.rejects(loadReceiptProfile(root, { verifyOfficial() {} }), /原版备份校验/);
});
