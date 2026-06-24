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
 *        a. Rooms-only  → <dst>/Rooms/{filename}  (fast initial load)
 *        b. Drawings    → <dst>/{floorId}_Walls.geojson at building root
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

// ── Main ─────────────────────────────────────────────────────────────────────
const roomsDst = path.join(dstAbs, 'Rooms');
if (!fs.existsSync(roomsDst)) fs.mkdirSync(roomsDst, { recursive: true });

// 1. Process each top-level GeoJSON: split into rooms + walls
const geojsonFiles = fs.readdirSync(srcAbs).filter(f => f.endsWith('.geojson'));
if (!geojsonFiles.length) {
  console.warn('No .geojson files found at top level of', srcAbs);
}

for (const file of geojsonFiles) {
  const srcFile = path.join(srcAbs, file);
  const fc      = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  const before  = fc.features.length;
  const srcKB   = (fs.statSync(srcFile).size / 1024).toFixed(1);

  const roomFeatures    = fc.features.filter(f => f.properties && f.properties.Element === 'Room');
  const drawingFeatures = fc.features.filter(f => f.properties && f.properties.type === 'drawing');

  // ── a. Rooms file (fast initial load) ──────────────────────────────────────
  const roomsFC = { ...fc, features: roomFeatures };
  applyRoundCoords(roomsFC);
  const roomsOut  = JSON.stringify(roomsFC);
  const roomsDst2 = path.join(roomsDst, file);
  fs.writeFileSync(roomsDst2, roomsOut, 'utf8');

  // ── b. Walls file (lazy-loaded by tryLoadWallsOverlay) ─────────────────────
  const floorId = extractFloorId(file);
  let wallsKB   = '0';
  if (drawingFeatures.length && floorId) {
    const wallsFC  = { ...fc, features: drawingFeatures };
    applyRoundCoords(wallsFC);
    const wallsOut  = JSON.stringify(wallsFC);
    const wallsFile = path.join(dstAbs, `${floorId}_Walls.geojson`);
    fs.writeFileSync(wallsFile, wallsOut, 'utf8');
    wallsKB = (wallsOut.length / 1024).toFixed(1);
  } else if (drawingFeatures.length && !floorId) {
    console.warn(`  ${file}: could not extract floorId — drawings not written`);
  }

  console.log(
    `  ${file}: ${before} → ${roomFeatures.length} rooms (${(roomsOut.length/1024).toFixed(1)} KB)` +
    (drawingFeatures.length ? ` + ${drawingFeatures.length} drawings → ${floorId}_Walls.geojson (${wallsKB} KB)` : '') +
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
