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
 *   If --building "<Name>" is provided:
 *   - Reads src/Configs/geojson/SarpyCounty_Buildings.json to find the building polygon
 *   - Computes the same local-planar fit used at runtime (fitLocalFloorplanToBuilding):
 *       IQR-clipped rooms bbox → building footprint bbox, scale + translate only
 *   - Applies that transform to the walls features so the walls GeoJSON is written
 *     in lon/lat coordinates, eliminating any runtime transform for those files.
 *
 * Floor ID extraction: leading BASEMENT or LEVEL_N from the filename.
 *   LEVEL_1_Dept_Rooms.geojson  →  floorId = LEVEL_1
 *   BASEMENT_Dept_Rooms.geojson →  floorId = BASEMENT
 *
 * Usage:
 *   node scripts/optimize-sarpy-export.cjs \
 *     --src "C:\temp\Sarpy\1102 Building" \
 *     --dst "public/floorplans/SarpyCounty/1102 Building" \
 *     --building "1102 Building"
 */

const fs   = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
function flagVal(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}
const SRC      = flagVal('--src');
const DST      = flagVal('--dst');
const BUILDING = flagVal('--building');

if (!SRC || !DST) {
  console.error('Usage: node scripts/optimize-sarpy-export.cjs --src <export-folder> --dst <public-dest-folder> [--building "<Name>"]');
  process.exit(1);
}

const srcAbs = path.resolve(SRC);
const dstAbs = path.resolve(DST);

if (!fs.existsSync(srcAbs)) {
  console.error('Source folder not found:', srcAbs);
  process.exit(1);
}

// ── Coordinate helpers ────────────────────────────────────────────────────────
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

// Recursive coordinate mapper — mirrors mapCoords() in StakeholderMap.jsx
function mapCoords(coords, fn) {
  if (!coords) return coords;
  if (typeof coords[0] === 'number') return fn(coords);
  return coords.map(c => mapCoords(c, fn));
}

// ── File helpers ──────────────────────────────────────────────────────────────
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

// ── Wall-layer classification ─────────────────────────────────────────────────
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

// ── Offline local-planar fit ──────────────────────────────────────────────────
// Mirrors fitLocalFloorplanToBuilding() in StakeholderMap.jsx:
//   IQR-clip room feature centroids → core bbox → scale + translate to building bbox.
// No rotation — the runtime function does not rotate either.

function bboxFromFeatures(features) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of features) {
    if (!f?.geometry?.coordinates) continue;
    mapCoords(f.geometry.coordinates, ([x, y]) => {
      if (Number.isFinite(x) && Number.isFinite(y)) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      return [x, y];
    });
  }
  return [minX, minY, maxX, maxY];
}

function featureCentroid(f) {
  const pts = [];
  mapCoords(f.geometry.coordinates, ([x, y]) => { pts.push([x, y]); return [x, y]; });
  if (!pts.length) return null;
  return [
    pts.reduce((s, p) => s + p[0], 0) / pts.length,
    pts.reduce((s, p) => s + p[1], 0) / pts.length,
  ];
}

/**
 * Compute scale + center mapping that places roomsFC into buildingFeature.
 * Returns { scale, roomCx, roomCy, bldgCx, bldgCy } or null if input is degenerate.
 */
function computeLocalPlanarFit(roomsFC, buildingFeature) {
  // Building bbox
  const [bxMin, byMin, bxMax, byMax] = bboxFromFeatures([buildingFeature]);
  if (![bxMin, byMin, bxMax, byMax].every(Number.isFinite)) return null;
  const bW = Math.max(1e-9, bxMax - bxMin);
  const bH = Math.max(1e-9, byMax - byMin);
  const bldgCx = (bxMin + bxMax) / 2;
  const bldgCy = (byMin + byMax) / 2;

  // Feature centroids for IQR clipping
  const validFeatures = roomsFC.features.filter(f => f?.geometry?.coordinates);
  const centroids = validFeatures.map(featureCentroid).filter(Boolean);
  if (!centroids.length) return null;

  const xs = centroids.map(c => c[0]).sort((a, b) => a - b);
  const ys = centroids.map(c => c[1]).sort((a, b) => a - b);
  const mid  = arr => arr[Math.floor(arr.length / 2)];
  const pct  = (arr, p) => arr[Math.max(0, Math.floor(arr.length * p))];

  const medX  = mid(xs), medY  = mid(ys);
  const iqrX  = Math.max(1e-9, pct(xs, 0.75) - pct(xs, 0.25));
  const iqrY  = Math.max(1e-9, pct(ys, 0.75) - pct(ys, 0.25));

  const clipXMin = medX - iqrX * 2, clipXMax = medX + iqrX * 2;
  const clipYMin = medY - iqrY * 2, clipYMax = medY + iqrY * 2;

  const coreFeatures = validFeatures.filter(f => {
    const c = featureCentroid(f);
    return c && c[0] >= clipXMin && c[0] <= clipXMax && c[1] >= clipYMin && c[1] <= clipYMax;
  });
  const fitFeatures = coreFeatures.length > 0 ? coreFeatures : validFeatures;

  if (coreFeatures.length < validFeatures.length) {
    console.log(`  [fit] IQR-clipped ${validFeatures.length - coreFeatures.length} outlier room features; using ${fitFeatures.length} for source bbox`);
  }

  const [rxMin, ryMin, rxMax, ryMax] = bboxFromFeatures(fitFeatures);
  if (![rxMin, ryMin, rxMax, ryMax].every(Number.isFinite)) return null;

  const rW = Math.max(1e-9, rxMax - rxMin);
  const rH = Math.max(1e-9, ryMax - ryMin);
  const scale = Math.min(bW / rW, bH / rH) * 0.96;
  const roomCx = (rxMin + rxMax) / 2;
  const roomCy = (ryMin + ryMax) / 2;

  return { scale, roomCx, roomCy, bldgCx, bldgCy };
}

/**
 * Apply localPlanarFit transform to a walls FeatureCollection.
 * Returns a new FC with coordinates in lon/lat.
 */
function applyLocalPlanarFitToFC(wallsFC, fit) {
  const { scale, roomCx, roomCy, bldgCx, bldgCy } = fit;
  return {
    ...wallsFC,
    features: wallsFC.features.map(f => {
      if (!f?.geometry?.coordinates) return f;
      return {
        ...f,
        geometry: {
          ...f.geometry,
          coordinates: mapCoords(f.geometry.coordinates, ([x, y]) => [
            bldgCx + (x - roomCx) * scale,
            bldgCy + (y - roomCy) * scale,
          ])
        }
      };
    })
  };
}

// ── Load building footprint (optional) ───────────────────────────────────────
let buildingFeature = null;
if (BUILDING) {
  const buildingsPath = path.resolve('src/Configs/geojson/SarpyCounty_Buildings.json');
  if (!fs.existsSync(buildingsPath)) {
    console.warn('  [--building] SarpyCounty_Buildings.json not found at', buildingsPath, '— walls will be written in Revit space');
  } else {
    const buildingsGJ = JSON.parse(fs.readFileSync(buildingsPath, 'utf8'));
    const needle = BUILDING.trim().toLowerCase();
    buildingFeature = (buildingsGJ.features || []).find(
      f => (f.properties?.name || '').trim().toLowerCase() === needle
    ) || null;
    if (!buildingFeature) {
      console.warn(`  [--building] No building named "${BUILDING}" found in SarpyCounty_Buildings.json — walls will be written in Revit space`);
      console.warn('  Available names:', (buildingsGJ.features || []).map(f => f.properties?.name).join(', '));
    } else {
      console.log(`  [--building] Found footprint for "${BUILDING}"`);
    }
  }
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

  // ── b. Walls file — optionally pre-baked to lon/lat via offline localPlanarFit
  const floorId = extractFloorId(file);
  let wallsKB   = '0';
  if (wallFeatures.length && floorId) {
    let wallsFC = { ...fc, features: wallFeatures };

    if (buildingFeature) {
      // Compute the same local-planar fit the app would apply at runtime,
      // using the rooms we just wrote as the source coordinate reference.
      const fit = computeLocalPlanarFit(mainFC, buildingFeature);
      if (fit) {
        wallsFC = applyLocalPlanarFitToFC(wallsFC, fit);

        const [wxMin, wyMin, wxMax, wyMax] = bboxFromFeatures(wallsFC.features);
        console.log(`  [fit] walls bbox after transform: lon [${wxMin.toFixed(6)}, ${wxMax.toFixed(6)}]  lat [${wyMin.toFixed(6)}, ${wyMax.toFixed(6)}]`);
        console.log(`  [fit] scale=${fit.scale.toExponential(4)}  roomCenter=[${fit.roomCx.toFixed(4)}, ${fit.roomCy.toFixed(4)}]  bldgCenter=[${fit.bldgCx.toFixed(6)}, ${fit.bldgCy.toFixed(6)}]`);
      } else {
        console.warn(`  [fit] could not compute fit for "${BUILDING}" — walls written in Revit space`);
      }
    }

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
