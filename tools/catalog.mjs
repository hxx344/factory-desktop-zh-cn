import { parse } from 'acorn';

export function extractCatalog(source, rootName, unwrap = false) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const bindings = new Map();
  // All resource declarations in this build are module-level data bindings.
  for (const statement of ast.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration') continue;
    for (const entry of declaration.declarations) if (entry.id.type === 'Identifier' && entry.init) bindings.set(entry.id.name, entry.init);
  }
  const cache = new Map();
  const visiting = new Set();
  function literal(node) {
    if (!node) throw new Error('Missing static resource binding');
    if (node.type === 'Literal' && !(node.value instanceof RegExp)) return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
    if (node.type === 'Identifier') {
      if (visiting.has(node.name)) throw new Error('Circular resource binding');
      if (!cache.has(node.name)) {
        visiting.add(node.name);
        cache.set(node.name, literal(bindings.get(node.name)));
        visiting.delete(node.name);
      }
      return cache.get(node.name);
    }
    if (node.type === 'ArrayExpression') return node.elements.map(literal);
    if (node.type === 'ObjectExpression') {
      const result = Object.create(null);
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement') Object.assign(result, literal(prop.argument));
        else {
          if (prop.kind !== 'init' || prop.method) throw new Error('Non-data resource property');
          const key = prop.computed ? literal(prop.key) : prop.key.name ?? prop.key.value;
          if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe resource key');
          result[key] = literal(prop.value);
        }
      }
      return result;
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.name === 'Object' && node.callee.property.name === 'assign') return Object.assign(Object.create(null), ...node.arguments.map(literal));
    throw new Error(`Non-static resource expression: ${node.type}`);
  }
  const root = bindings.get(rootName);
  return literal(unwrap ? root.arguments[0] : root);
}

export function flatten(value, prefix = '', output = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') output[path] = child;
    else if (child && typeof child === 'object') flatten(child, path, output);
    else throw new Error(`Non-string translation: ${path}`);
  }
  return output;
}

export function setPath(target, path, value) {
  const parts = path.split('.');
  if (parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Unsafe translation path');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (['__proto__', 'prototype', 'constructor'].includes(part)) throw new Error('Unsafe translation path');
    node[part] ??= {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

export function placeholders(text) {
  return [...text.matchAll(/\{\{[^}]+\}\}|<\/?[\p{L}\p{N}]+(?:\s[^>]*)?\s*\/?>|\$\{[^}]+\}/gu)].map(match => match[0]).sort();
}
