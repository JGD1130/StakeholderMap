import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCherokeeDoorLinework,
  buildCherokeeStairLinework
} from '../src/utils/cherokeeArchitecturalOverlays.js';

const root = fileURLToPath(new URL('../public/floorplans/CherokeeMentalHealth/', import.meta.url));

const collectFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (entry.name.endsWith('.geojson')) files.push(path);
  }
  return files;
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const normalizedRelativePath = (path) => relative(root, path).replaceAll('\\', '/');
const finiteCoordinates = (value) => Array.isArray(value)
  ? value.every((item) => Array.isArray(item) ? finiteCoordinates(item) : Number.isFinite(item))
  : false;
const hasDrawingMetadata = (feature) => feature.properties?.Element === 'Drawing'
  && feature.properties?.interactive === false
  && typeof feature.properties?.RevitId === 'string';

const files = await collectFiles(root);
const byRelativePath = new Map(files.map((path) => [normalizedRelativePath(path), path]));
const roomPaths = files.filter((path) => normalizedRelativePath(path).includes('/Rooms/'));
const results = [];

for (const roomPath of roomPaths) {
  const roomRelativePath = normalizedRelativePath(roomPath);
  const match = roomRelativePath.match(/^(.*)\/Rooms\/(.+)_Dept_Rooms\.geojson$/);
  assert.ok(match, `unexpected Cherokee room path: ${roomRelativePath}`);
  const [, building, floor] = match;
  const doorPath = byRelativePath.get(`${building}/Doors/${floor}_Dept_Doors.geojson`);
  const stairPath = byRelativePath.get(`${building}/Stairs/${floor}_Dept_Stairs.geojson`);
  if (!doorPath && !stairPath) continue;

  const rooms = await readJson(roomPath);
  const doors = doorPath ? await readJson(doorPath) : { type: 'FeatureCollection', features: [] };
  const stairs = stairPath ? await readJson(stairPath) : { type: 'FeatureCollection', features: [] };
  const before = JSON.stringify({ rooms, doors, stairs });
  const startedAt = performance.now();
  const doorLinework = buildCherokeeDoorLinework(doors, rooms);
  const stairLinework = buildCherokeeStairLinework(stairs, rooms);
  const durationMs = performance.now() - startedAt;

  assert.equal(JSON.stringify({ rooms, doors, stairs }), before, `${building} ${floor} source was mutated`);
  if (doors.features.length) {
    assert.ok(doorLinework.features.length > 0, `${building} ${floor} converted no doors`);
    assert.ok(doorLinework.features.length <= doors.features.length, `${building} ${floor} added door duplicates`);
  }
  assert.ok(doorLinework.features.every((feature) => feature.geometry.type === 'MultiLineString'));
  assert.ok(doorLinework.features.every((feature) => finiteCoordinates(feature.geometry.coordinates)));
  assert.ok(doorLinework.features.every((feature) => feature.properties.__mfSnapDistanceMeters <= 1.25));
  assert.ok(doorLinework.features.every(hasDrawingMetadata));
  assert.equal(new Set(doorLinework.features.map((feature) => feature.properties.RevitId)).size, doorLinework.features.length);

  if (stairs.features.length) {
    assert.ok(stairLinework.features.length > 0, `${building} ${floor} converted no stairs`);
  }
  assert.ok(stairLinework.features.every((feature) => feature.geometry.type === 'MultiLineString'));
  assert.ok(stairLinework.features.every((feature) => finiteCoordinates(feature.geometry.coordinates)));
  assert.ok(stairLinework.features.every(hasDrawingMetadata));
  assert.equal(new Set(stairLinework.features.map((feature) => feature.properties.RevitId)).size, stairLinework.features.length);

  results.push({
    building,
    floor,
    sourceDoors: doors.features.length,
    renderedDoors: doorLinework.features.length,
    sourceStairPoints: stairs.features.length,
    renderedStairs: stairLinework.features.length,
    durationMs: Number(durationMs.toFixed(1))
  });
}

assert.ok(results.length >= 18, `expected at least 18 Cherokee architectural floors, found ${results.length}`);
console.table(results);
assert.ok(results.every(({ durationMs }) => durationMs < 1000), 'a Cherokee overlay conversion exceeded 1 second');

const mapSource = await readFile(new URL('../src/components/StakeholderMap.jsx', import.meta.url), 'utf8');
assert.match(mapSource, /useSharedCherokeeLinework = Boolean\(options\?\.useVectorDoorStairOverlay\)/);
assert.match(mapSource, /features: \[\.\.\.\(patchedFC\.features \|\| \[\]\), \.\.\.architecturalFeatures\]/);
assert.match(mapSource, /if \(!useSharedCherokeeLinework && overlayBasePath\)/);

console.log(JSON.stringify({
  floorsValidated: results.length,
  sourceDoors: results.reduce((sum, result) => sum + result.sourceDoors, 0),
  renderedDoors: results.reduce((sum, result) => sum + result.renderedDoors, 0),
  sourceStairPoints: results.reduce((sum, result) => sum + result.sourceStairPoints, 0),
  renderedStairs: results.reduce((sum, result) => sum + result.renderedStairs, 0),
  durationMs: Number(results.reduce((sum, result) => sum + result.durationMs, 0).toFixed(1))
}, null, 2));
