'use strict';
/**
 * optimize-sarpy-export.cjs
 *
 * Optimizes a Revit GeoJSON export for Sarpy County and copies it (and any
 * Doors / Stairs overlay files) to the correct public/ destination.
 *
 * What it does:
 *   1. Reads every *.geojson in <src>/ (top level — the main floor files)
 *   2. Keeps only Room polygon features and DXF drawing linework features
 *   3. Rounds coordinates to 6 decimal places and writes compact JSON
 *   4. Writes optimized file(s) to <dst>/Rooms/
 *   5. Copies <src>/Doors/ → <dst>/Doors/ if the folder exists
 *   6. Copies <src>/Stairs/ → <dst>/Stairs/ if the folder exists
 *
 * Usage:
 *   node scripts/optimize-sarpy-export.cjs --src "C:\temp\Sarpy\1246 Building" --dst "public/floorplans/SarpyCounty/1246 Building"
 */

const fs   = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
function flagVal(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}
const SRC = flagVal('--src');
const DST = flagVal('--dst');

if (!SRC || !DST) {
  console.error('Usage: node scripts/optimize-sarpy-export.cjs --src <export-folder> --dst <public-dest-folder>');
  process.exit(1);
}

const srcAbs = path.resolve(SRC);
const dstAbs = path.resolve(DST);

if (!fs.existsSync(srcAbs)) {
  console.error('Source folder not found:', srcAbs);
  process.exit(1);
}

// ── Coord rounding ────────────────────────────────────────────────────────────
function roundCoords(c) {
  return typeof c[0] === 'number'
    ? c.map(n => Math.round(n * 1e6) / 1e6)
    : c.map(roundCoords);
}

// ── Recursive folder copy ─────────────────────────────────────────────────────
function copyDir(src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
const roomsDst = path.join(dstAbs, 'Rooms');
if (!fs.existsSync(roomsDst)) fs.mkdirSync(roomsDst, { recursive: true });

// 1. Optimize main GeoJSON files (top-level *.geojson in src)
const geojsonFiles = fs.readdirSync(srcAbs).filter(f => f.endsWith('.geojson'));
if (!geojsonFiles.length) {
  console.warn('No .geojson files found at top level of', srcAbs);
}

for (const file of geojsonFiles) {
  const srcFile = path.join(srcAbs, file);
  const dstFile = path.join(roomsDst, file);

  const fc = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  const before = fc.features.length;

  // Keep Room polygons and DXF architectural linework
  fc.features = fc.features.filter(f =>
    f.properties && (f.properties.Element === 'Room' || f.properties.type === 'drawing')
  );

  const rooms    = fc.features.filter(f => f.properties.Element === 'Room').length;
  const drawings = fc.features.filter(f => f.properties.type === 'drawing').length;

  // Round coordinates
  fc.features.forEach(f => {
    if (f.geometry && f.geometry.coordinates) {
      f.geometry.coordinates = roundCoords(f.geometry.coordinates);
    }
  });

  const out = JSON.stringify(fc);
  fs.writeFileSync(dstFile, out, 'utf8');

  const srcKB  = (fs.statSync(srcFile).size / 1024).toFixed(1);
  const dstKB  = (out.length / 1024).toFixed(1);
  console.log(`  ${file}: ${before} features → ${rooms} rooms + ${drawings} drawings | ${srcKB} KB → ${dstKB} KB`);
}

// 2. Copy Doors overlay if present
const doorsSrc = path.join(srcAbs, 'Doors');
const doorsDst = path.join(dstAbs, 'Doors');
if (fs.existsSync(doorsSrc)) {
  copyDir(doorsSrc, doorsDst);
  const count = fs.readdirSync(doorsDst).length;
  console.log(`  Doors/: copied ${count} file(s) → ${doorsDst}`);
} else {
  console.log('  Doors/: not found in source, skipping');
}

// 3. Copy Stairs overlay if present
const stairsSrc = path.join(srcAbs, 'Stairs');
const stairsDst = path.join(dstAbs, 'Stairs');
if (fs.existsSync(stairsSrc)) {
  copyDir(stairsSrc, stairsDst);
  const count = fs.readdirSync(stairsDst).length;
  console.log(`  Stairs/: copied ${count} file(s) → ${stairsDst}`);
} else {
  console.log('  Stairs/: not found in source, skipping');
}

console.log('\nDone. Destination:', dstAbs);
