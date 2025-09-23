#!/usr/bin/env node
// Usage: node scripts/svg-to-geojson.js <input.svg> <output.geojson>
// ESM script

import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import process from 'process';
import { parse as parseSVGDom } from 'svgson';
import pkg from 'svg-path-parser';
const { parseSVG, makeAbsolute } = pkg;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function approximatelyEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}
function pointsEqual(p1, p2, eps = 1e-6) {
  if (!p1 || !p2) return false;
  return approximatelyEqual(p1[0], p2[0], eps) && approximatelyEqual(p1[1], p2[1], eps);
}

// Convert an SVG path 'd' into an array of [x, y] points.
// Supports straight segments (M,L,H,V,Z). Curves are ignored (rare in Revit exports).
function pathToPoints(d) {
  if (!d || typeof d !== 'string') return [];
  let commands;
  try {
    commands = makeAbsolute(parseSVG(d));
  } catch (err) {
    console.warn('Warning: failed to parse path data:', err?.message || err);
    return [];
  }
  const pts = [];
  let cx = 0, cy = 0;
  let sx = null, sy = null; // subpath start for Z

  for (const c of commands) {
    const type = (c.code || c.command || c.type || '').toUpperCase();
    if (type === 'M') {
      cx = c.x; cy = c.y;
      sx = cx; sy = cy;
      pts.push([cx, cy]);
    } else if (type === 'L') {
      cx = c.x; cy = c.y;
      pts.push([cx, cy]);
    } else if (type === 'H') {
      cx = c.x;
      pts.push([cx, cy]);
    } else if (type === 'V') {
      cy = c.y;
      pts.push([cx, cy]);
    } else if (type === 'Z') {
      if (sx != null && sy != null && !pointsEqual(pts[pts.length - 1], [sx, sy])) {
        pts.push([sx, sy]);
      }
      // subpath closed; next M will reset sx/sy
    } else {
      // Ignore curves (C,Q,S,T,A). Revit exports usually straight segments.
      // If you encounter curves, consider sampling/flattening here.
    }
  }

  // Deduplicate consecutive identical points
  const out = [];
  for (const p of pts) {
    if (!out.length || !pointsEqual(out[out.length - 1], p)) out.push(p);
  }
  return out;
}

// Polygon area in SVG pixel^2 (shoelace)
function polyArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

// Total length of a linestring (SVG pixels)
function lineLength(pts) {
  if (!pts || pts.length < 2) return 0;
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    len += Math.hypot(dx, dy);
  }
  return len;
}

// DFS collect nodes
function nodesBy(predicate, root) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (predicate(n)) out.push(n);
    if (n.children && n.children.length) {
      for (const ch of n.children) walk(ch);
    }
  })(root);
  return out;
}

async function main() {
  if (process.argv.length < 4) {
    console.log('Usage: node scripts/svg-to-geojson.js <input.svg> <output.geojson>');
    process.exit(1);
  }
  const inFile = process.argv[2];
  const outFile = process.argv[3];

  let svgRaw;
  try {
    svgRaw = await readFile(inFile, 'utf8');
  } catch (e) {
    die(`Failed to read input SVG: ${e.message}`);
  }

  let svgRoot;
  try {
    svgRoot = await parseSVGDom(svgRaw);
  } catch (e) {
    die(`Failed to parse SVG XML: ${e.message}`);
  }

  // Grab ALL <path> elements
  const pathNodes = nodesBy(n => n.name === 'path' && n.attributes && n.attributes.d, svgRoot);

  const MIN_ROOM_AREA = 1500;  // drop tiny polys (label boxes, etc.)
  const MIN_WALL_LEN = 20;     // drop microscopic lines
  const features = [];
  let roomIdCounter = 1;

  for (const n of pathNodes) {
    const d = n.attributes.d;
    const pts = pathToPoints(d);
    if (!pts.length) continue;

    // Closed if first == last or path had Z (our pathToPoints closes on Z)
    const closed = pts.length >= 3 && pointsEqual(pts[0], pts[pts.length - 1]);

    if (closed) {
      // ROOM
      // Ensure single ring is closed
      const ring = pointsEqual(pts[0], pts[pts.length - 1]) ? pts : [...pts, pts[0]];
      const area = polyArea(ring);
      if (area < MIN_ROOM_AREA) continue; // skip tiny junk

      features.push({
        type: 'Feature',
        properties: { kind: 'room', id: `R${roomIdCounter++}`, rawClass: n.attributes.class || null },
        geometry: { type: 'Polygon', coordinates: [ring] }
      });
    } else {
      // WALL (open path as LineString)
      if (lineLength(pts) < MIN_WALL_LEN) continue; // skip tiny fragments
      features.push({
        type: 'Feature',
        properties: { kind: 'wall', rawClass: n.attributes.class || null },
        geometry: { type: 'LineString', coordinates: pts }
      });
    }
  }

  const fc = { type: 'FeatureCollection', features };
  await writeFile(outFile, JSON.stringify(fc));
  console.log(`Wrote ${features.length} features → ${path.basename(outFile)}`);
}

main().catch(err => die(err?.stack || String(err)));
