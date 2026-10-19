import { parse } from 'acorn';
import { mkdir, writeFile } from 'node:fs/promises';
import { readAsar, sha256 } from './asar.mjs';

const path = process.argv[2] ?? `${process.env.LOCALAPPDATA}/Factory/app-0.201.0/resources/app.asar`;
const asar = await readAsar(path);
const renderer = '.vite/renderer/main_window/assets/index-DJvfx-E_.js';
const source = asar.read(renderer).toString('utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const bindings = new Map();
// Inspect declarations only. Never execute the application's bundled code.
function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
    bindings.set(node.id.name, node.init);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object' && value.type) visit(value);
  }
}
visit(ast);
const cache = new Map();
function literal(node) {
  if (!node) throw new Error('Missing static binding');
  if (node.type === 'Literal') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  if (node.type === 'Identifier') {
    if (!cache.has(node.name)) cache.set(node.name, literal(bindings.get(node.name)));
    return cache.get(node.name);
  }
  if (node.type === 'ArrayExpression') return node.elements.map(literal);
  if (node.type === 'ObjectExpression') {
    const result = Object.create(null);
    for (const prop of node.properties) {
      if (prop.type === 'SpreadElement') Object.assign(result, literal(prop.argument));
      else {
        if (prop.kind !== 'init' || prop.method) throw new Error('Non-data property');
        const key = prop.computed ? literal(prop.key) : prop.key.name ?? prop.key.value;
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe key');
        result[key] = literal(prop.value);
      }
    }
    return result;
  }
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.name === 'Object' && node.callee.property.name === 'assign') {
    return Object.assign(Object.create(null), ...node.arguments.map(literal));
  }
  throw new Error(`Non-static expression: ${node.type} at ${node.start}`);
}
const root = bindings.get('B8t');
if (root?.callee?.name !== 'KSu') throw new Error('Unknown renderer resource layout');
const original = literal(root.arguments[0]);
const resources = Object.fromEntries(Object.entries(original).map(([key, value]) => [key.replace(/^.*\//, '').replace(/\.json$/, ''), value]));
const flat = {};
function flatten(value, path = '') {
  for (const [key, child] of Object.entries(value)) {
    const name = path ? `${path}.${key}` : key;
    if (typeof child === 'string') flat[name] = child;
    else if (child && typeof child === 'object') flatten(child, name);
    else throw new Error(`Non-string translation: ${name}`);
  }
}
flatten(resources);
await mkdir('.local', { recursive: true });
await writeFile('.local/en.json', `${JSON.stringify(resources, null, 2)}\n`);
await writeFile('.local/en-flat.json', `${JSON.stringify(flat, null, 2)}\n`);
console.log(JSON.stringify({ version: JSON.parse(asar.read('package.json')).version, renderer, sha256: sha256(asar.read(renderer)), namespaces: Object.keys(resources), entries: Object.keys(flat).length }, null, 2));
