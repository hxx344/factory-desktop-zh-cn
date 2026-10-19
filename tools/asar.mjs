import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readAsar(path) {
  return parseAsar(await readFile(path));
}

export function parseAsar(bytes) {
  if (bytes.length < 16) throw new Error('Invalid ASAR header');
  const headerSize = bytes.readUInt32LE(4);
  const jsonSize = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(0) !== 4 || jsonSize > headerSize - 8 || headerSize > bytes.length - 8) {
    throw new Error('Invalid ASAR header');
  }
  const rawHeader = bytes.subarray(16, 16 + jsonSize);
  const header = JSON.parse(rawHeader.toString('utf8'));
  const base = 8 + headerSize;
  const entries = new Map();
  function walk(node, prefix = '') {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const relative = `${prefix}${name}`;
      if (entry.files) walk(entry, `${relative}/`);
      else entries.set(relative, entry);
    }
  }
  walk(header);
  return {
    bytes, header, base, entries, rawHeader,
    read(name) {
      const entry = entries.get(name);
      if (!entry || entry.unpacked || entry.link) throw new Error(`Unsupported ASAR entry: ${name}`);
      const offset = Number(entry.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry.size) || entry.size < 0 || base + offset + entry.size > bytes.length) {
        throw new Error(`Invalid ASAR entry bounds: ${name}`);
      }
      return bytes.subarray(base + offset, base + offset + entry.size);
    },
  };
}

export function writeAsar(asar, replacements) {
  const header = structuredClone(asar.header);
  const extra = [];
  let offset = asar.bytes.length - asar.base;
  for (const [name, contents] of replacements) {
    const parts = name.split('/');
    if (parts.some(part => !part || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('Invalid ASAR path');
    let node = header;
    for (const part of parts.slice(0, -1)) {
      node.files ??= {};
      node.files[part] ??= { files: {} };
      node = node.files[part];
      if (!node.files) throw new Error('ASAR parent is not a directory');
    }
    const content = Buffer.from(contents);
    const blockSize = 4 * 1024 * 1024;
    const blocks = [];
    for (let i = 0; i < content.length; i += blockSize) blocks.push(sha256(content.subarray(i, i + blockSize)));
    node.files[parts.at(-1)] = { size: content.length, offset: String(offset), integrity: { algorithm: 'SHA256', hash: sha256(content), blockSize, blocks } };
    extra.push(content);
    offset += content.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const payloadSize = Math.ceil((json.length + 4) / 4) * 4;
  const headerSize = payloadSize + 4;
  const prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(payloadSize, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  return Buffer.concat([prefix, asar.bytes.subarray(asar.base), ...extra]);
}
