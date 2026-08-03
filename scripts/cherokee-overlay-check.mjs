import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildCherokeeDoorLinework,
  buildCherokeeStairLinework
} from '../src/utils/cherokeeArchitecturalOverlays.js';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

const rooms = await readJson('../public/floorplans/CherokeeMentalHealth/Overall/Rooms/BASEMENT_Dept_Rooms.geojson');
const doors = await readJson('../public/floorplans/CherokeeMentalHealth/Overall/Doors/BASEMENT_Dept_Doors.geojson');
const stairs = await readJson('../public/floorplans/CherokeeMentalHealth/Overall/Stairs/BASEMENT_Dept_Stairs.geojson');
const before = JSON.stringify({ rooms, doors, stairs });

const doorLinework = buildCherokeeDoorLinework(doors, rooms);
const stairLinework = buildCherokeeStairLinework(stairs, rooms);

assert.equal(JSON.stringify({ rooms, doors, stairs }), before, 'source GeoJSON was mutated');
assert.ok(doorLinework.features.length > 0, 'no Cherokee doors were converted');
assert.ok(doorLinework.features.length <= doors.features.length, 'door conversion added duplicates');
assert.ok(doorLinework.features.every((feature) => feature.geometry.type === 'MultiLineString'));
assert.ok(doorLinework.features.every((feature) => feature.properties.__mfSnapDistanceMeters <= 1.25));
assert.ok(stairLinework.features.length > 0, 'no Cherokee stairs were converted');
assert.ok(stairLinework.features.length <= stairs.features.length, 'stair conversion added duplicates');
assert.ok(stairLinework.features.every((feature) => feature.geometry.type === 'MultiLineString'));

console.log(JSON.stringify({
  sourceDoors: doors.features.length,
  renderedDoors: doorLinework.features.length,
  sourceStairPoints: stairs.features.length,
  renderedStairs: stairLinework.features.length
}, null, 2));
