#!/usr/bin/env node
// Reduces GeoJSON file size by:
//   1. Douglas-Peucker polygon simplification (removes redundant vertices)
//   2. Coordinate precision reduction (15+ decimals → 4)
// No external dependencies required.

'use strict';

const fs = require('fs');
const path = require('path');

const TARGET = path.resolve(
  __dirname,
  '../public/floorplans/SarpyCounty/AdministrationCourthouse/Rooms/LEVEL_1_Dept_Rooms.geojson'
);

// 4 decimal places ≈ 0.1mm precision in feet — more than enough for screen display
const PRECISION = 10000;

// D-P tolerance in coordinate units (feet).
// 0.01 ft ≈ 3 mm — safely below any perceptible shape change at screen resolution.
const TOLERANCE = 0.01;

function perpDist(pt, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) {
    return Math.hypot(pt[0] - a[0], pt[1] - a[1]);
  }
  const t = ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / (dx * dx + dy * dy);
  return Math.hypot(pt[0] - (a[0] + t * dx), pt[1] - (a[1] + t * dy));
}

function douglasPeucker(pts, tol) {
  if (pts.length <= 2) return pts;
  let maxD = 0, maxI = 0;
  const end = pts.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpDist(pts[i], pts[0], pts[end]);
    if (d > maxD) { maxD = d; maxI = i; }
  }
  if (maxD > tol) {
    const L = douglasPeucker(pts.slice(0, maxI + 1), tol);
    const R = douglasPeucker(pts.slice(maxI), tol);
    return L.slice(0, -1).concat(R);
  }
  return [pts[0], pts[end]];
}

function round(n) {
  return Math.round(n * PRECISION) / PRECISION;
}

function simplifyRing(ring) {
  let pts = douglasPeucker(ring, TOLERANCE);
  // A valid closed ring needs at least 4 points (3 unique + closing repeat).
  // If D-P collapsed it too far, keep the original.
  if (pts.length < 4) pts = ring;
  pts = pts.map(([x, y]) => [round(x), round(y)]);
  // Ensure ring closure (first === last)
  pts[pts.length - 1] = [pts[0][0], pts[0][1]];
  return pts;
}

function simplifyLine(line) {
  let pts = douglasPeucker(line, TOLERANCE);
  if (pts.length < 2) pts = line;
  return pts.map(([x, y]) => [round(x), round(y)]);
}

function simplifyGeometry(geom) {
  if (!geom) return geom;
  if (geom.type === 'Polygon') {
    return { ...geom, coordinates: geom.coordinates.map(simplifyRing) };
  }
  if (geom.type === 'MultiPolygon') {
    return { ...geom, coordinates: geom.coordinates.map(poly => poly.map(simplifyRing)) };
  }
  if (geom.type === 'LineString') {
    return { ...geom, coordinates: simplifyLine(geom.coordinates) };
  }
  if (geom.type === 'MultiLineString') {
    return { ...geom, coordinates: geom.coordinates.map(simplifyLine) };
  }
  if (geom.type === 'GeometryCollection') {
    return { ...geom, geometries: geom.geometries.map(simplifyGeometry) };
  }
  return geom;
}

// --- main ---

console.log(`Reading ${TARGET}`);
const raw = fs.readFileSync(TARGET, 'utf8');
const sizeBefore = Buffer.byteLength(raw, 'utf8');
const geojson = JSON.parse(raw);

let coordsBefore = 0, coordsAfter = 0;

for (const f of geojson.features) {
  if (!f.geometry) continue;
  const countBefore = countCoords(f.geometry);
  f.geometry = simplifyGeometry(f.geometry);
  const countAfterF = countCoords(f.geometry);
  coordsBefore += countBefore;
  coordsAfter += countAfterF;
}

function countCoords(geom) {
  if (!geom) return 0;
  let n = 0;
  if (geom.type === 'Polygon') geom.coordinates.forEach(r => n += r.length);
  if (geom.type === 'MultiPolygon') geom.coordinates.forEach(p => p.forEach(r => n += r.length));
  if (geom.type === 'LineString') n += geom.coordinates.length;
  if (geom.type === 'MultiLineString') geom.coordinates.forEach(l => n += l.length);
  if (geom.type === 'GeometryCollection') geom.geometries.forEach(g => n += countCoords(g));
  return n;
}

const output = JSON.stringify(geojson);
const sizeAfter = Buffer.byteLength(output, 'utf8');

console.log(`Features:   ${geojson.features.length}`);
console.log(`Coords:     ${coordsBefore.toLocaleString()} → ${coordsAfter.toLocaleString()} (${pct(coordsBefore, coordsAfter)}% reduction)`);
console.log(`File size:  ${mb(sizeBefore)} MB → ${mb(sizeAfter)} MB (${pct(sizeBefore, sizeAfter)}% reduction)`);

fs.writeFileSync(TARGET, output, 'utf8');
console.log('Done — file written in place.');

function mb(b) { return (b / 1024 / 1024).toFixed(2); }
function pct(before, after) { return Math.round((1 - after / before) * 100); }
