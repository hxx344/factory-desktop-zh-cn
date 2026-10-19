import { createHash } from 'node:crypto';

export const textHash = text => createHash('sha256').update(text).digest('hex');
const tagPattern = /<\/?[\p{L}\p{N}][\p{L}\p{N}_.:-]*(?:\s[^<>]*?)?\s*\/?>/gu;
const voidTags = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source', 'area', 'base', 'col', 'embed', 'param', 'track']);

export function tagStructure(text) {
  const tags = [...text.matchAll(tagPattern)].map(match => match[0]);
  const pairedNames = new Set(tags.filter(tag => tag.startsWith('</')).map(tag => tag.match(/^<\/([^\s/>]+)/)[1]));
  const stack = [];
  for (const tag of tags) {
    const name = tag.match(/^<\/?([^\s/>]+)/)[1];
    if (tag.startsWith('</')) {
      if (stack.pop() !== name) return { balanced: false, tags };
    } else if (!tag.endsWith('/>') && (!voidTags.has(name.toLowerCase()) || pairedNames.has(name))) stack.push(name);
  }
  return { balanced: stack.length === 0, tags };
}

export function protectedTokens(text) {
  const interpolations = [...text.matchAll(/\{\{[^}]+\}\}|\$\{[^}]+\}/g)].map(match => match[0]);
  const tags = tagStructure(text);
  const fenced = [...text.matchAll(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g)].map(match => match[0].replace(/^\n/, ''));
  const withoutFences = text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, '');
  const inlineCode = [...withoutFences.matchAll(/(`{1,2})([^`\n]+)\1/g)].map(match => match[0]);
  const links = [...text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(match => match[1]);
  const urls = [...text.matchAll(/\b(?:https?|wss?|ssh|git|factory):\/\/[^\s<>"'`)\]，。；！？]+/g)].map(match => match[0].replace(/[.,;!?]+$/, ''));
  return { tokens: [...interpolations, ...tags.tags, ...fenced, ...inlineCode, ...links, ...urls].sort(), balancedTags: tags.balanced };
}

export function validateTranslation(target, reference, label, reason) {
  if (typeof target !== 'string' || !target.trim()) throw new Error(`空译文：${label}`);
  const actual = protectedTokens(target);
  if (JSON.stringify(actual.tokens) !== JSON.stringify(reference.tokens)) throw new Error(`占位符、标签、代码或链接发生变化：${label}`);
  if (reference.balancedTags && !actual.balancedTags) throw new Error(`富文本标签交叉或未闭合：${label}`);
  const unchanged = textHash(target) === reference.sha256;
  const noChinese = !/[\p{Script=Han}]/u.test(target);
  if ((unchanged || noChinese) && (typeof reason !== 'string' || reason.trim().length < 4)) throw new Error(`未翻译文本缺少明确保留说明：${label}`);
  return unchanged || noChinese ? 'preserved' : 'translated';
}
