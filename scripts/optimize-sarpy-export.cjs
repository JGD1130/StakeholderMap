'use strict';
/**
 * optimize-sarpy-export.cjs
 *
 * Optimizes a Revit GeoJSON export for Sarpy County and copies it (and any
 * Doors / Stairs overlay files) to the correct public/ destination.
 *
 * What it does:
 *   1. Reads every *.geojson in <src>/ (top level — the main floor files)
 *   2. Splits each file into two outputs:
 *        a. Rooms + non-wall drawings → <dst>/Rooms/{filename}  (fast initial load)
 *           Non-wall layers: A-DOOR, A-GLAZ-*, I-FURN, I-FURN-PNLS, P-SANR-FIXT,
 *                            Q-CASE, S-STRS, S-STRS-*
 *        b. Wall drawings only → <dst>/{floorId}_Walls.geojson at building root
 *           Wall layers: A-WALL, A-WALL-*, I-WALL, I-WALL-*
 *           (auto-detected by tryLoadWallsOverlay after rooms render)
 *   3. Rounds coordinates to 6 decimal places, writes compact JSON
 *   4. Copies <src>/Doors/  → <dst>/Doors/  if present
 *   5. Copies <src>/Stairs/ → <dst>/Stairs/ if present
 *
 * Floor ID extraction: leading BASEMENT or LEVEL_N from the filename.
 *   LEVEL_1_Dept_Rooms.geojson  →  floorId = LEVEL_1
 *   BASEMENT_Dept_Rooms.geojson →  floorId = BASEMENT
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function roundCoords(c) {
  return typeof c[0] === 'number'
    ? c.map(n => Math.round(n * 1e6) / 1e6)
    : c.map(roundCoords);
}

function applyRoundCoords(fc) {
  fc.features.forEach(f => {
    if (f.geometry && f.geometry.coordinates) {
      f.geometry.coordinates = roundCoords(f.geometry.coordinates);
    }
  });
}

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

// Extract LEVEL_1 / BASEMENT from the filename stem
function extractFloorId(filename) {
  const m = filename.match(/^(BASEMENT|LEVEL_\d+)/i);
  return m ? m[1].toUpperCase() : null;
}

// Layers that go to the lazy-loaded companion walls file
// All DXF drawing layers go to the lazy-loaded companion walls file.
// Every drawing feature has complex polygon geometry (~12–35 KB each);
// keeping any in the main file pushes it well over the 5 MB target.
// Rooms stay in the main file (297 KB for LEVEL_1 Courthouse).
const WALL_LAYERS = new Set([
  'A-WALL', 'I-WALL',
  'A-DOOR',
  'A-GLAZ-CURT', 'A-GLAZ-CWMG',
  'I-FURN', 'I-FURN-PNLS',
  'P-SANR-FIXT',
  'Q-CASE',
  'S-STRS',
]);
const WALL_LAYER_PREFIXES = ['A-WALL-', 'I-WALL-', 'A-GLAZ-', 'S-STRS-'];

function isWallFeature(f) {
  const layer = ((f.properties && (f.properties.Layer || f.properties.layer)) || '').toUpperCase();
  if (WALL_LAYERS.has(layer)) return true;
  for (const p of WALL_LAYER_PREFIXES) { if (layer.startsWith(p)) return true; }
  return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const roomsDst = path.join(dstAbs, 'Rooms');
if (!fs.existsSync(roomsDst)) fs.mkdirSync(roomsDst, { recursive: true });

// 1. Process each top-level GeoJSON: split walls out, keep everything else in main
const geojsonFiles = fs.readdirSync(srcAbs).filter(f => f.endsWith('.geojson'));
if (!geojsonFiles.length) {
  console.warn('No .geojson files found at top level of', srcAbs);
}

for (const file of geojsonFiles) {
  const srcFile = path.join(srcAbs, file);
  const fc      = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  const before  = fc.features.length;
  const srcKB   = (fs.statSync(srcFile).size / 1024).toFixed(1);

  const wallFeatures    = fc.features.filter(f => f.properties && f.properties.type === 'drawing' && isWallFeature(f));
  const nonWallFeatures = fc.features.filter(f => !(f.properties && f.properties.type === 'drawing' && isWallFeature(f)));

  // ── a. Main file: rooms + non-wall drawings (doors, glazing, furniture, etc.)
  const mainFC = { ...fc, features: nonWallFeatures };
  applyRoundCoords(mainFC);
  const mainOut  = JSON.stringify(mainFC);
  const mainDst  = path.join(roomsDst, file);
  fs.writeFileSync(mainDst, mainOut, 'utf8');

  const roomCount    = nonWallFeatures.filter(f => f.properties && f.properties.Element === 'Room').length;
  const nonWallCount = nonWallFeatures.filter(f => f.properties && f.properties.type === 'drawing').length;

  // ── b. Walls file: A-WALL + I-WALL only (lazy-loaded by tryLoadWallsOverlay)
  const floorId = extractFloorId(file);
  let wallsKB   = '0';
  if (wallFeatures.length && floorId) {
    const wallsFC  = { ...fc, features: wallFeatures };
    applyRoundCoords(wallsFC);
    const wallsOut  = JSON.stringify(wallsFC);
    const wallsFile = path.join(dstAbs, `${floorId}_Walls.geojson`);
    fs.writeFileSync(wallsFile, wallsOut, 'utf8');
    wallsKB = (wallsOut.length / 1024).toFixed(1);
  } else if (wallFeatures.length && !floorId) {
    console.warn(`  ${file}: could not extract floorId — wall features not written`);
  }

  console.log(
    `  ${file}: ${before} → ${roomCount} rooms + ${nonWallCount} non-wall drawings (${(mainOut.length/1024).toFixed(1)} KB)` +
    (wallFeatures.length ? ` | walls → ${floorId}_Walls.geojson (${wallsKB} KB)` : '') +
    ` | src ${srcKB} KB`
  );
}

// 2. Copy Doors overlay if present
const doorsSrc = path.join(srcAbs, 'Doors');
const doorsDst = path.join(dstAbs, 'Doors');
if (fs.existsSync(doorsSrc)) {
  copyDir(doorsSrc, doorsDst);
  const count = fs.readdirSync(doorsDst).length;
  console.log(`  Doors/: copied ${count} file(s)`);
} else {
  console.log('  Doors/: not found in source, skipping');
}

// 3. Copy Stairs overlay if present
const stairsSrc = path.join(srcAbs, 'Stairs');
const stairsDst = path.join(dstAbs, 'Stairs');
if (fs.existsSync(stairsSrc)) {
  copyDir(stairsSrc, stairsDst);
  const count = fs.readdirSync(stairsDst).length;
  console.log(`  Stairs/: copied ${count} file(s)`);
} else {
  console.log('  Stairs/: not found in source, skipping');
}

console.log('\nDone. Destination:', dstAbs);
