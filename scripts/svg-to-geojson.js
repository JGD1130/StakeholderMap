#!/usr/bin/env node

// Usage: node scripts/svg-to-geojson.js <input.svg> <output.geojson>

import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import process from 'process';
import { parse } from 'svgson';
import pkg from 'svg-path-parser';
const { parseSVG, makeAbsolute } = pkg;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function hasClass(attrClass = '', cls) {
  return String(attrClass)
    .split(/\s+/)
    .filter(Boolean)
    .includes(cls);
}

function approximatelyEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function pointsEqual(p1, p2, eps = 1e-6) {
  if (!p1 || !p2) return false;
  return approximatelyEqual(p1[0], p2[0], eps) && approximatelyEqual(p1[1], p2[1], eps);
}

// Convert an SVG path 'd' attribute into an array of [x, y] points.
// Supports straight segments; warns and approximates by sampling skipped for brevity.
function pathToPoints(d) {
  if (!d || typeof d !== 'string') return [];

  let commands;
  try {
    commands = makeAbsolute(parseSVG(d));
  } catch (err) {
    console.warn('Warning: failed to parse path data:', err?.message || err);
    return [];
  }

  const points = [];
  let started = false;

  for (const cmd of commands) {
    const type = cmd.code || cmd.command || cmd.type;
    switch (type) {
      case 'M': // moveto absolute
        points.push([cmd.x, cmd.y]);
        started = true;
        break;
      case 'L': // lineto
      case 'H': // horizontal lineto
      case 'V': // vertical lineto
        // makeAbsolute ensures x,y are present
        if (!started) {
          points.push([cmd.x0 ?? cmd.x, cmd.y0 ?? cmd.y]);
          started = true;
        }
        points.push([cmd.x, cmd.y]);
        break;
      case 'Z': // closepath
        if (points.length && !pointsEqual(points[0], points[points.length - 1])) {
          points.push(points[0]);
        }
        break;
      case 'C': // cubic bezier
      case 'S': // smooth cubic
      case 'Q': // quadratic
      case 'T': // smooth quadratic
      case 'A': // arc
        // Not implementing curve flattening in this script to keep dependencies light.
        // Warn once and skip control points; we will connect to end point to retain structure.
        console.warn(`Warning: Path contains '${type}' curve; approximating with end points only.`);
        if (!started) {
          points.push([cmd.x0 ?? cmd.x, cmd.y0 ?? cmd.y]);
          started = true;
        }
        points.push([cmd.x, cmd.y]);
        break;
      default:
        console.warn(`Warning: Unsupported path command '${type}', attempting to continue.`);
        break;
    }
  }
  return points;
}

function ensureClosed(points) {
  if (!points || points.length === 0) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (!pointsEqual(first, last)) points.push(first);
  return points;
}

function findPathElements(node, out = []) {
  if (!node) return out;
  if (node.name === 'path' && node.attributes && node.attributes.d) {
    out.push(node);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) findPathElements(child, out);
  }
  return out;
}

function toNumberOrString(val) {
  if (val == null) return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n : String(val);
}

async function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile || !outputFile) {
    die('Usage: node scripts/svg-to-geojson.js <input.svg> <output.geojson>');
  }

  let svgRaw;
  try {
    svgRaw = await readFile(inputFile, 'utf8');
  } catch (err) {
    die(`Failed to read input SVG: ${err?.message || err}`);
  }

  let svgJson;
  try {
    svgJson = await parse(svgRaw);
  } catch (err) {
    die(`Failed to parse SVG XML: ${err?.message || err}`);
  }

  // NEW: grab ALL path elements
  const allNodes = findPathElements(svgJson);
  const features = [];

  for (const n of allNodes) {
    const pts = pathToPoints(n.attributes?.d);
    if (!pts.length) continue;

    // Guess: closed shapes = rooms, open shapes = walls
    const isClosed = pts.length > 3 && pointsEqual(pts[0], pts[pts.length - 1]);

    features.push({
      type: 'Feature',
      properties: {
        kind: isClosed ? 'room' : 'wall',
        rawClass: n.attributes?.class || null,
      },
      geometry: {
        type: isClosed ? 'Polygon' : 'LineString',
        coordinates: isClosed ? [pts] : pts,
      },
    });
  }

  const fc = {
    type: 'FeatureCollection',
    features,
  };

  try {
    const json = JSON.stringify(fc, null, 2);
    await writeFile(outputFile, json, 'utf8');
    const rel = path.normalize(outputFile);
    console.error(`Wrote GeoJSON to ${rel}`);
  } catch (err) {
    die(`Failed to write output: ${err?.message || err}`);
  }
}

main().catch((err) => die(err?.message || String(err)));
