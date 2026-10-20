import { sha256 } from './asar.mjs';

function callFor(entry) {
  return entry.runtime === 'main' ? '__factoryZhNative' : '__factoryZhUi';
}

export function hardcodedExpression(entry) {
  if (entry.lookup === 'badge') {
    if (!['name', 'description', 'quip'].includes(entry.field)) throw new Error('Invalid badge display field');
    return `__factoryZhBadge(${JSON.stringify(entry.field)},${entry.raw})`;
  }
  if (entry.runtime === 'early') {
    if (!/^[A-Za-z_$][\w$]*$/.test(entry.electron ?? '') || typeof entry.translation !== 'string') throw new Error('Invalid early-startup localization entry');
    return `(()=>{try{const l=${entry.electron}.app.getPreferredSystemLanguages()[0];if(/^zh(?:-|$)/i.test(l))return ${JSON.stringify(entry.translation)}}catch{}return ${entry.raw}})()`;
  }
  const call = callFor(entry);
  const key = JSON.stringify(entry.id);
  if (entry.expressions?.length) {
    const values = entry.expressions.map((_, index) => `expression${index}:v[${index}]`).join(',');
    const fallback = entry.quasis.map((part, index) => JSON.stringify(part) + (index < entry.expressions.length ? `+String(v[${index}])+` : '')).join('');
    return `(v=>${call}(${key},${fallback},{${values}}))([${entry.expressions.join(',')}])`;
  }
  return `${call}(${key},${entry.raw})`;
}

export function applyHardcoded(source, file, manifest) {
  const entries = manifest?.entries.filter(entry => entry.file === file) ?? [];
  if (!entries.length) return source;
  const hook = manifest.useTranslation ?? 'le';
  if (!/^[A-Za-z_$][\w$]*$/.test(hook)) throw new Error('本地化订阅函数不匹配');
  if (sha256(Buffer.from(source)) !== manifest.files[file]) throw new Error(`硬编码资源指纹不匹配：${file}`);
  const changes = entries.map(entry => {
    if (source.slice(entry.start, entry.end) !== entry.raw) throw new Error(`硬编码位置不匹配：${file}:${entry.start}`);
    const expression = hardcodedExpression(entry);
    if (entry.property !== undefined) {
      if (entry.propertyStart > entry.start || entry.propertyEnd < entry.end) throw new Error('Invalid property bounds');
      const key = JSON.stringify(entry.property);
      return { start: entry.propertyStart, end: entry.propertyEnd, text: `get [${key}](){return ${expression}},set [${key}](v){Object.defineProperty(this,${key},{value:v,writable:true,enumerable:true,configurable:true})}` };
    }
    return { start: entry.start, end: entry.end, text: expression };
  });
  for (const owner of manifest?.memoOwners?.filter(owner => owner.file === file) ?? []) {
    if (source.slice(owner.sizeStart, owner.sizeEnd) !== String(owner.size) || !/^[A-Za-z_$][\w$]*$/.test(owner.cacheName) || !Number.isSafeInteger(owner.size)) throw new Error('本地化组件缓存结构不匹配');
    changes.push(
      { start: owner.bodyStart, end: owner.bodyStart, text: `const __factoryZhLanguageT=${hook}("hardcoded").t;` },
      { start: owner.sizeStart, end: owner.sizeEnd, text: String(owner.size + 1) },
      { start: owner.declarationEnd, end: owner.declarationEnd, text: `if(${owner.cacheName}[${owner.size}]!==__factoryZhLanguageT){${owner.cacheName}.fill(Symbol.for("react.memo_cache_sentinel"));${owner.cacheName}[${owner.size}]=__factoryZhLanguageT;}` },
    );
  }
  for (const component of manifest?.languageSubscribers?.filter(component => component.file === file) ?? []) {
    if (source[component.bodyStart - 1] !== '{') throw new Error('本地化组件入口不匹配');
    changes.push({ start: component.bodyStart, end: component.bodyStart, text: `${hook}("hardcoded");` });
  }
  changes.sort((a, b) => b.start - a.start);
  let previous = source.length;
  for (const change of changes) {
    if (change.end > previous) throw new Error(`硬编码位置重叠：${file}:${change.start}`);
    source = source.slice(0, change.start) + change.text + source.slice(change.end);
    previous = change.start;
  }
  return source;
}

export const rendererHelper = 'function __factoryZhUi(id,fallback,values={}){try{return eon().t("hardcoded:"+id,{defaultValue:fallback,...values})}catch{return fallback}}';
export const mainHelper = 'function __factoryZhNative(id,fallback,values={}){try{return ne("hardcoded."+id,{defaultValue:fallback,...values})}catch{return fallback}}';

export function localizedHelper(source, original, binding) {
  if (!/^[A-Za-z_$][\w$]*$/.test(binding)) throw new Error('本地化翻译函数不匹配');
  return source.replace(`${original}(`, `${binding}(`);
}

export function badgeHelper(mapping) {
  return `var __factoryZhBadgeIds=${JSON.stringify(mapping ?? {})};function __factoryZhBadge(field,value){if(typeof value!=="string")return value;const id=__factoryZhBadgeIds[field]?.[value];return typeof id==="string"?__factoryZhUi(id,value):value}`;
}
