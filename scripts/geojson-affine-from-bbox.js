// scripts/geojson-affine-from-bbox.js (ESM)
import fs from 'node:fs';

// === 1) INPUT / OUTPUT ===
if (process.argv.length < 4) {
  console.log('Usage: node scripts/geojson-affine-from-bbox.js <in.local.geojson> <out.geojson>');
  process.exit(1);
}
const inFile = process.argv[2];
const outFile = process.argv[3];

// === 2) READ LOCAL (PIXEL) GEOJSON & GET BBOX ===
const fc = JSON.parse(fs.readFileSync(inFile, 'utf8'));
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

for (const f of fc.features || []) {
  const g = f.geometry;
  if (!g) continue;
  if (g.type === 'Polygon') {
    g.coordinates.flat(2).forEach((v, idx, arr) => {
      if (idx % 2 === 0) {
        const x = v, y = arr[idx + 1];
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    });
  } else if (g.type === 'MultiPolygon') {
    g.coordinates.flat(3).forEach((v, idx, arr) => {
      if (idx % 2 === 0) {
        const x = v, y = arr[idx + 1];
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    });
  } else if (g.type === 'LineString') {
    g.coordinates.forEach(([x, y]) => {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    });
  } else if (g.type === 'MultiLineString') {
    g.coordinates.flat().forEach(([x, y]) => {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    });
  }
}
console.log('Local bbox:', { minX, minY, maxX, maxY });

// === 3) DEFINE 3 CONTROL POINTS ===
// src = SVG/local coords from the bbox corners
// IMPORTANT: most SVGs have +Y downward. Using NW, NE, SW mapping works well.
const src = [
  [minX, minY], // NW  (top-left in SVG space)
  [maxX, minY], // NE  (top-right)
  [minX, maxY], // SW  (bottom-left)
];

// Paste the three [lng, lat] you logged from the app clicks:
const dst = [
  /* P1 (NW) */ [-98.37329132988776, 40.59579845052452],
  /* P2 (NE) */ [-98.37306096467078, 40.59581062367802],
  /* P3 (SW) */ [-98.37316479497925, 40.59522273413831],
];

// === 4) SOLVE AFFINE (2x3) ===
function solveAffine(src, dst) {
  const M = [], b = [];
  for (let i = 0; i < 3; i++) {
    const [x, y] = src[i]; const [X, Y] = dst[i];
    M.push([x, y, 1, 0, 0, 0]); b.push(X);
    M.push([0, 0, 0, x, y, 1]); b.push(Y);
  }
  // 6x6 Gaussian elimination
  function gaussian(A, y) {
    const n = y.length;
    for (let i = 0; i < n; i++) {
      let max = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[max][i])) max = r;
      [A[i], A[max]] = [A[max], A[i]]; [y[i], y[max]] = [y[max], y[i]];
      const div = A[i][i];
      for (let j = i; j < n; j++) A[i][j] /= div; y[i] /= div;
      for (let r = 0; r < n; r++) if (r !== i) {
        const f = A[r][i];
        for (let j = i; j < n; j++) A[r][j] -= f * A[i][j];
        y[r] -= f * y[i];
      }
    }
    return y;
  }
  const a = gaussian(M.map(r => r.slice()), b.slice());
  return [[a[0], a[1], a[2]], [a[3], a[4], a[5]]];
}

function applyAffine(A, [x, y]) {
  const lng = A[0][0] * x + A[0][1] * y + A[0][2];
  const lat = A[1][0] * x + A[1][1] * y + A[1][2];
  return [lng, lat];
}

const A = solveAffine(src, dst);

// === 5) TRANSFORM ALL FEATURES ===
for (const f of fc.features || []) {
  const g = f.geometry;
  if (!g) continue;
  if (g.type === 'Polygon') {
    g.coordinates = g.coordinates.map(ring => ring.map(pt => applyAffine(A, pt)));
  } else if (g.type === 'MultiPolygon') {
    g.coordinates = g.coordinates.map(poly => poly.map(ring => ring.map(pt => applyAffine(A, pt))));
  } else if (g.type === 'LineString') {
    g.coordinates = g.coordinates.map(pt => applyAffine(A, pt));
  } else if (g.type === 'MultiLineString') {
    g.coordinates = g.coordinates.map(line => line.map(pt => applyAffine(A, pt)));
  }
}

fs.writeFileSync(outFile, JSON.stringify(fc));
console.log('Wrote georeferenced:', outFile);

