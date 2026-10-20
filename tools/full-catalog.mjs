import { readFile } from 'node:fs/promises';
import { validateTranslation } from './quality.mjs';
import { latestVersion, readProfile } from './versions.mjs';

export async function readFullCatalog(version = latestVersion) {
  await readProfile(version);
  const inventory = JSON.parse(await readFile(new URL(`../profiles/${version}.catalog.json`, import.meta.url)));
  const translations = {}, preserved = {};
  for (const name of ['seed', 'worker-1', 'worker-2', 'worker-3', 'hardcoded', 'update-0.202.0']) {
    const path = new URL(`../translations/full/${name}.json`, import.meta.url);
    let values;
    try { values = JSON.parse(await readFile(path)); }
    catch (error) { if (error.code === 'ENOENT') values = {}; else throw error; }
    for (const [id, text] of Object.entries(values)) {
      if (!/^(0|[1-9]\d*)$/.test(id) || Number(id) >= inventory.sources.length) throw new Error(`未知全量词条 ID：${name}:${id}`);
      if (translations[id] !== undefined) throw new Error(`重复全量词条 ID：${id}`);
      translations[id] = text;
    }
    const preserveName = name.startsWith('worker-') ? name.replace('worker', 'preserve') : `preserve-${name}`;
    try { Object.assign(preserved, JSON.parse(await readFile(new URL(`../translations/full/${preserveName}.json`, import.meta.url)))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const id of Object.keys(preserved)) if (translations[id] === undefined) throw new Error(`保留说明无对应词条：${id}`);
  const missing = [], failures = [];
  const counts = { translated: 0, preserved: 0 };
  for (const [id, reference] of inventory.sources.entries()) {
    if (translations[id] === undefined) { missing.push(id); continue; }
    try { counts[validateTranslation(translations[id], reference, id, preserved[id])]++; }
    catch (error) { failures.push({ id, message: error.message }); }
  }
  return { inventory, translations, preserved, missing, failures, counts };
}
