#!/usr/bin/env node
// Generate public/floorplans/manifest.json by scanning the floorplans folder
// Shape produced (flat):
// {
//   "<BuildingId>": {
//     "display": "<BuildingId>",
//     "floors": { "<FloorId>": { "url": "<relative path under floorplans>" } }
//   },
//   ...
// }

import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();
const floorplansDir = path.join(repoRoot, 'public', 'floorplans');
const outFile = path.join(floorplansDir, 'manifest.json');

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && /\.geojson$/i.test(e.name)) out.push(p);
  }
  return out;
}

function normId(s) {
  return String(s || '').trim();
}

function floorIdFromFilename(name) {
  const stem = name.replace(/\.geojson$/i, '');
  const up = stem.toUpperCase();
  const fl = up.match(/(?:^|[^A-Z0-9])F?L\s*_?\s*(\d+)/);
  if (fl) return `FL${fl[1]}`;
  const lvl = up.match(/LEVEL\s*_?\s*(\d+)/);
  if (lvl) return `FL${lvl[1]}`;
  if (up.includes('BASEMENT')) return 'BASEMENT';
  return stem; // fallback to raw stem
}

function relFromAbs(abs) {
  const rel = path.relative(floorplansDir, abs).replace(/\\/g, '/');
  return rel;
}

function buildingIdFromRel(rel) {
  // Prefer second segment if present (e.g., Hastings/HurleyMcDonald/file)
  const parts = rel.split('/');
  if (parts.length >= 3) return normId(parts[1]);
  if (parts.length >= 2) return normId(parts[0]);
  // File at root -> use stem as building id
  return normId(path.basename(rel, path.extname(rel)));
}

function main() {
  if (!fs.existsSync(floorplansDir)) {
    console.error('No floorplans directory at', floorplansDir);
    process.exit(1);
  }
  const files = walk(floorplansDir);
  const manifest = {};
  for (const abs of files) {
    const rel = relFromAbs(abs);
    const bId = buildingIdFromRel(rel);
    const floorId = floorIdFromFilename(path.basename(rel));
    if (!manifest[bId]) manifest[bId] = { display: bId, floors: {} };
    manifest[bId].floors[floorId] = { url: rel };
  }
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${outFile} with ${Object.keys(manifest).length} buildings.`);
}

main();

