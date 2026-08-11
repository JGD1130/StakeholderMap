'use strict';
/**
 * trim-sarpy-tax-parcels.cjs
 *
 * Strips public/SarpyCounty_Tax_Parcels.geojson down to a minimal property
 * set for the client-side Tax Parcels layer -- drops owner names/mailing
 * addresses (PII) and every other unused GIS/assessor field -- then runs
 * @turf/simplify on the geometry to cut vertex count. The layer that
 * consumes this file only renders at zoom 13+ (~14.4 m/pixel at Sarpy's
 * latitude), so SIMPLIFY_TOLERANCE_DEG is set for ~1m of allowed deviation,
 * comfortably under a pixel of error at that zoom.
 *
 * Usage:
 *   node scripts/trim-sarpy-tax-parcels.cjs [--in path] [--out path]
 */

const fs = require('fs');
const path = require('path');
const { simplify } = require('@turf/turf');

// ~1 meter, converted to degrees using 111,320 m/degree (latitude spacing).
// Conservative on purpose: errs toward preserving parcel boundary shape
// over maximizing file-size reduction.
const SIMPLIFY_TOLERANCE_DEG = 1 / 111320;

const args = process.argv.slice(2);
function flagVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const IN_PATH = flagVal('--in')
  ? path.resolve(flagVal('--in'))
  : path.join(__dirname, '..', 'public', 'SarpyCounty_Tax_Parcels.geojson');

const OUT_PATH = flagVal('--out')
  ? path.resolve(flagVal('--out'))
  : path.join(__dirname, '..', 'public', 'Data', 'SarpyCounty_Tax_Parcels_trimmed.geojson');

// Keep only what the layer actually needs. Everything else -- including
// OWNERNME1/2, PSTLADDRESS, PSTLCITY, PSTLSTATE, PSTLZIP5, and all other
// source fields -- is dropped, not just hidden from the UI.
const KEEP_PROPS = [
  'PARCELID',
  'SITEADDRESS',
  'CLASSDSCRP',
  'ACREAGE',
  'LNDVALUE',
  'CNTASSDVAL',
  'RESYRBLT'
];

function main() {
  console.log(`Reading ${IN_PATH} ...`);
  const raw = JSON.parse(fs.readFileSync(IN_PATH, 'utf8'));
  if (!Array.isArray(raw?.features)) {
    throw new Error('Input file has no features array -- is this a valid FeatureCollection?');
  }
  console.log(`  ${raw.features.length} features.`);

  const trimmedFeatures = raw.features.map((feature) => {
    const srcProps = feature.properties || {};
    const properties = {};
    for (const key of KEEP_PROPS) {
      properties[key] = srcProps[key] ?? null;
    }
    return {
      type: 'Feature',
      geometry: feature.geometry,
      properties
    };
  });
  const fmtMB = (b) => (b / (1024 * 1024)).toFixed(1);
  const trimmedBytes = Buffer.byteLength(JSON.stringify(trimmedFeatures));
  console.log(`  Trimmed properties: ${fmtMB(trimmedBytes)} MB (geometry unchanged so far)`);

  console.log(`Simplifying geometry (tolerance ~1m, highQuality)...`);
  let skipped = 0;
  const features = trimmedFeatures.map((feature) => {
    try {
      return simplify(feature, { tolerance: SIMPLIFY_TOLERANCE_DEG, highQuality: true, mutate: true });
    } catch (err) {
      skipped += 1;
      return feature;
    }
  });
  if (skipped > 0) {
    console.warn(`  Warning: ${skipped} feature(s) failed to simplify and were kept as-is.`);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify({ type: 'FeatureCollection', features })
  );

  const inBytes = fs.statSync(IN_PATH).size;
  const outBytes = fs.statSync(OUT_PATH).size;
  console.log(`Wrote ${features.length} features to ${OUT_PATH}`);
  console.log(`  Original:            ${fmtMB(inBytes)} MB`);
  console.log(`  Trimmed (no simplify): ${fmtMB(trimmedBytes)} MB`);
  console.log(`  Trimmed + simplified:  ${fmtMB(outBytes)} MB (${((outBytes / inBytes) * 100).toFixed(1)}% of original)`);
}

main();
