import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { textHash, protectedTokens, validateTranslation } from '../tools/quality.mjs';
import { applyHardcoded, rendererHelper, badgeHelper, sourceHelper, localizedHelper } from '../tools/hardcoded.mjs';

const reference = source => ({ sha256: textHash(source), ...protectedTokens(source) });

test('full coverage quality distinguishes translated text from reviewed technical retention', () => {
  assert.equal(validateTranslation('已删除 {{count}} 项', reference('Deleted {{count}} items'), 'test'), 'translated');
  assert.throws(() => validateTranslation('GitHub', reference('GitHub'), 'brand'), /保留说明/);
  assert.equal(validateTranslation('GitHub', reference('GitHub'), 'brand', 'GitHub 产品品牌名称'), 'preserved');
  assert.throws(() => validateTranslation('Deleted {{count}} items', reference('Deleted {{count}} items'), 'not-translated'), /保留说明/);
});

test('crossed rich text tags and modified code or links are rejected', () => {
  const source = 'Open <link><b>billing</b></link> and run `droid --version`. [Docs](https://docs.factory.com/)';
  assert.equal(validateTranslation('打开<link><b>账单</b></link>并运行 `droid --version`。[文档](https://docs.factory.com/)', reference(source), 'valid'), 'translated');
  assert.throws(() => validateTranslation('打开<link><b>账单</link></b>并运行 `droid --version`。[文档](https://docs.factory.com/)', reference(source), 'crossed'), /标签/);
  assert.throws(() => validateTranslation('打开<link><b>账单</b></link>并运行 `droid --help`。[文档](https://docs.factory.com/)', reference(source), 'code'), /代码/);
});

test('lazy localized UI fields survive early initialization, track a later locale, and retain assignments', () => {
  const source = 'const item={label:"Settings"};globalThis.item=item;';
  const start = source.indexOf('"Settings"');
  const manifest = { files: { renderer: textHash(source) }, entries: [{ file: 'renderer', runtime: 'renderer', id: '0', start, end: start + 10, raw: '"Settings"', property: 'label', propertyStart: source.indexOf('label:'), propertyEnd: start + 10 }] };
  const context = {};
  runInNewContext(`${rendererHelper}${applyHardcoded(source, 'renderer', manifest)}`, context);
  assert.equal(context.item.label, 'Settings');
  context.eon = () => ({ t: () => '设置' });
  assert.equal(context.item.label, '设置');
  context.item.label = 'user-assigned-value';
  assert.equal(context.item.label, 'user-assigned-value');
});

test('dynamic hardcoded expressions evaluate each original value once', () => {
  const source = 'globalThis.result=`Count ${next()}`;';
  const start = source.indexOf('`');
  const manifest = { files: { renderer: textHash(source) }, entries: [{ file: 'renderer', runtime: 'renderer', id: '1', start, end: source.lastIndexOf('`') + 1, raw: '`Count ${next()}`', expressions: ['next()'], quasis: ['Count ', ''] }] };
  let calls = 0;
  const context = { next: () => ++calls, eon: () => ({ t: (_, values) => `数量 ${values.expression0}` }) };
  runInNewContext(`${rendererHelper}${applyHardcoded(source, 'renderer', manifest)}`, context);
  assert.equal(context.result, '数量 1');
  assert.equal(calls, 1);
});

test('an unexpected source location or overlapping patch is refused', () => {
  const source = 'const value="Hello";';
  assert.throws(() => applyHardcoded(source, 'renderer', { files: { renderer: textHash(source) }, entries: [{ file: 'renderer', start: 0, end: 2, raw: 'WRONG', runtime: 'renderer', id: '0' }] }), /位置不匹配/);
});

for (const [hook, getter] of [['le', 'eon'], ['ce', 'yrn']]) test(`${hook}: a localized component invalidates only its compiled memo when the translation function changes`, () => {
  const source = 'function Component(props){const memo=z.c(2);let value;if(memo[0]!==props){value="Breadcrumb";memo[0]=props;memo[1]=value}else value=memo[1];return value}globalThis.Component=Component;';
  const start = source.indexOf('"Breadcrumb"');
  const sizeStart = source.indexOf('2');
  const manifest = {
    useTranslation: hook,
    files: { renderer: textHash(source) },
    entries: [{ file: 'renderer', runtime: 'renderer', id: '0', start, end: start + 12, raw: '"Breadcrumb"' }],
    memoOwners: [{ file: 'renderer', bodyStart: source.indexOf('{') + 1, declarationEnd: source.indexOf(';') + 1, cacheName: 'memo', size: 2, sizeStart, sizeEnd: sizeStart + 1 }],
  };
  let language = 'en', translation = () => 'Breadcrumb';
  const state = { userInput: 'do not lose this input' };
  const cache = Array(3).fill(Symbol.for('react.memo_cache_sentinel'));
  const context = { [hook]: () => ({ t: translation }), z: { c: () => cache }, [getter]: () => ({ t: () => language === 'en' ? 'Breadcrumb' : '导航路径' }), state };
  runInNewContext(`${localizedHelper(rendererHelper, 'eon', getter)}${applyHardcoded(source, 'renderer', manifest)}`, context);
  const props = {};
  assert.equal(context.Component(props), 'Breadcrumb');
  language = 'zh-CN'; translation = () => '导航路径';
  assert.equal(context.Component(props), '导航路径');
  assert.equal(state.userInput, 'do not lose this input');
});

test('badge display translation preserves the data used for internal matching and follows locale changes', () => {
  let language = 'zh-CN';
  let subscriptions = 0;
  const context = { le: () => { subscriptions++; return {}; }, eon: () => ({ t: (_, values) => language === 'zh-CN' ? '夜猫子' : values.defaultValue }) };
  const source = 'function Badge(data){return data.name}globalThis.Badge=Badge;';
  const start = source.indexOf('data.name');
  const manifest = { files: { renderer: textHash(source) }, entries: [{ file: 'renderer', start, end: start + 9, raw: 'data.name', runtime: 'renderer', lookup: 'badge', field: 'name' }], languageSubscribers: [{ file: 'renderer', bodyStart: source.indexOf('{') + 1 }] };
  runInNewContext(`${rendererHelper}${badgeHelper({name:{'Night Owl':'badge_0'}})}${applyHardcoded(source, 'renderer', manifest)}`, context);
  const badge = { name: 'Night Owl', group: 'late_night', tier: 2 };
  assert.equal(context.Badge(badge), '夜猫子');
  assert.equal(badge.name, 'Night Owl');
  language = 'en';
  assert.equal(context.Badge(badge), 'Night Owl');
  assert.equal(context.__factoryZhBadge('name', 'user data'), 'user data');
  assert.equal(subscriptions, 2);
});

test('source display lookup translates only known UI values and leaves source maps and user content intact', () => {
  let language = 'zh-CN';
  const context = { eon: () => ({ t: (_, values) => language === 'zh-CN' ? '网页搜索' : values.defaultValue }) };
  const source = 'const labels={web:"Web Search"};function display(key){return labels[key]}globalThis.labels=labels;globalThis.display=display;';
  const raw = 'labels[key]';
  const start = source.indexOf(raw, source.indexOf('function display'));
  const manifest = { files: { renderer: textHash(source) }, entries: [{ file: 'renderer', start, end: start + raw.length, raw, runtime: 'renderer', lookup: 'source' }] };
  runInNewContext(`${rendererHelper}${sourceHelper({'Web Search':'source_0'})}${applyHardcoded(source, 'renderer', manifest)}`, context);
  assert.equal(context.display('web'), '网页搜索');
  assert.equal(context.labels.web, 'Web Search');
  language = 'en';
  assert.equal(context.display('web'), 'Web Search');
  assert.equal(context.__factoryZhSource('user-authored text'), 'user-authored text');
});
