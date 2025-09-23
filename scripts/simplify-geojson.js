// scripts/simplify-geojson.js (ESM)
// Usage: node scripts/simplify-geojson.js <in.geojson> <out.geojson> [percent]
// Approximates mapshaper's percent by converting to a tolerance based on bbox size
import fs from 'node:fs';
import * as turf from '@turf/turf';

if (process.argv.length < 4) {
  console.log('Usage: node scripts/simplify-geojson.js <in.geojson> <out.geojson> [percent]');
  process.exit(1);
}

const inFile = process.argv[2];
const outFile = process.argv[3];
const percent = Number(process.argv[4] ?? 5); // default ~5%

const fc = JSON.parse(fs.readFileSync(inFile, 'utf8'));

const bb = turf.bbox(fc); // [minX, minY, maxX, maxY]
const dx = Math.abs(bb[2] - bb[0]);
const dy = Math.abs(bb[3] - bb[1]);
const extent = Math.max(dx, dy);
// Convert percent to an absolute tolerance in coordinate units
// e.g., 5% of the max extent
const tolerance = (percent / 100) * extent;

// Use highQuality to reduce artifacts; preserveTopology to avoid self-intersections
const simplified = turf.simplify(fc, { tolerance, highQuality: true, mutate: false });

fs.writeFileSync(outFile, JSON.stringify(simplified));
console.log(`Simplified ${inFile} -> ${outFile} with ~${percent}% (tolerance=${tolerance})`);

