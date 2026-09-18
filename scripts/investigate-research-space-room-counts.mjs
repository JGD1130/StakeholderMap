// Scratch investigation script (not part of the app) -- counts real Lab-type
// and Office-type rooms in the live Hastings Airtable inventory, reusing the
// EXACT filtering/dedup logic already built and shipped for the Office/FTE
// expansion (deriveOfficeRoomsFromAirtable, roomTypeSuggestion.js), not a
// re-derived approximation. Run with the local ai-server already running
// (npm run dev:ai) so this can pull the same /api/rooms payload the app uses.
//
// node scripts/investigate-research-space-room-counts.mjs [path-to-rooms.json]

import fs from 'fs';
import {
  ROOM_TYPE_TO_SPACE_CATEGORY,
  deriveOfficeRoomsFromAirtable
} from '../src/utils/roomTypeSuggestion.js';
import { resolveAirtableBuildingName, stripKnownAirtableRoomPrefix } from '../src/utils/classroomUtilizationCalc.js';
import { buildRoomUtilizationMetaKey } from '../src/utils/roomUtilizationMeta.js';

const jsonPath = process.argv[2];
const raw = jsonPath
  ? fs.readFileSync(jsonPath, 'utf8')
  : fs.readFileSync(process.env.ROOMS_JSON_PATH, 'utf8');
const payload = JSON.parse(raw);
const airtableRooms = Array.isArray(payload.rooms) ? payload.rooms : [];

console.log(`Total Airtable room records fetched: ${airtableRooms.length}`);

// --- Office: reuse the shipped function verbatim, no reimplementation ---
const officeRooms = deriveOfficeRoomsFromAirtable(airtableRooms);

// --- Lab: same prefix-filter + dedup shape as deriveOfficeRoomsFromAirtable,
// just swapped to "Laboratory - " (mirrors that function's own comment: this
// is deliberately broader than ROOM_TYPE_TO_SPACE_CATEGORY's exact-membership
// list, so a future new "Laboratory - <something>" subtype still surfaces
// for manual tagging instead of staying invisible). ---
const LAB_ROOM_TYPE_PREFIX = 'Laboratory - ';
function deriveLabRoomsFromAirtable(rooms) {
  const seen = new Map();
  rooms.forEach((room) => {
    const roomType = String(room?.type || '').trim();
    if (!roomType.startsWith(LAB_ROOM_TYPE_PREFIX)) return;
    const rawBuilding = String(room?.building || '').trim();
    if (!rawBuilding) return;
    const building = resolveAirtableBuildingName(rawBuilding);
    const rawRoomLabel = String(room?.roomNumber || room?.roomId || '').trim();
    const roomLabel = stripKnownAirtableRoomPrefix(building, rawRoomLabel);
    if (!building || !roomLabel) return;
    const roomKey = buildRoomUtilizationMetaKey(building, roomLabel);
    if (!roomKey) return;
    if (!seen.has(roomKey)) seen.set(roomKey, { roomKey, building, room: roomLabel, source: 'lab' });
  });
  return Array.from(seen.values()).sort((a, b) => {
    const buildingCompare = a.building.localeCompare(b.building);
    if (buildingCompare !== 0) return buildingCompare;
    return a.room.localeCompare(b.room, undefined, { numeric: true });
  });
}
const labRooms = deriveLabRoomsFromAirtable(airtableRooms);

console.log(`\nOffice-type rooms (prefix "Office - ", deduped by roomKey): ${officeRooms.length}`);
console.log(`Lab-type rooms (prefix "Laboratory - ", deduped by roomKey): ${labRooms.length}`);
console.log(`Combined Lab + Office scope: ${officeRooms.length + labRooms.length}`);

// Distinct raw Room Type Description values within each prefix, so any
// subtype not already in ROOM_TYPE_TO_SPACE_CATEGORY is visible rather than
// silently folded in.
function distinctTypesWithCounts(rooms, prefix) {
  const counts = new Map();
  rooms.forEach((room) => {
    const t = String(room?.type || '').trim();
    if (!t.startsWith(prefix)) return;
    counts.set(t, (counts.get(t) || 0) + 1);
  });
  return counts;
}

console.log('\n--- Raw Office - * type distribution (pre-dedup, all matching records) ---');
for (const [type, count] of distinctTypesWithCounts(airtableRooms, 'Office - ')) {
  const mapped = ROOM_TYPE_TO_SPACE_CATEGORY[type] || '(unmapped)';
  console.log(`  ${type}: ${count}  -> ${mapped}`);
}

console.log('\n--- Raw Laboratory - * type distribution (pre-dedup, all matching records) ---');
for (const [type, count] of distinctTypesWithCounts(airtableRooms, 'Laboratory - ')) {
  const mapped = ROOM_TYPE_TO_SPACE_CATEGORY[type] || '(unmapped)';
  console.log(`  ${type}: ${count}  -> ${mapped}`);
}

console.log('\n--- Office rooms by building ---');
const officeByBuilding = new Map();
officeRooms.forEach((r) => officeByBuilding.set(r.building, (officeByBuilding.get(r.building) || 0) + 1));
for (const [b, c] of [...officeByBuilding.entries()].sort()) console.log(`  ${b}: ${c}`);

console.log('\n--- Lab rooms by building ---');
const labByBuilding = new Map();
labRooms.forEach((r) => labByBuilding.set(r.building, (labByBuilding.get(r.building) || 0) + 1));
for (const [b, c] of [...labByBuilding.entries()].sort()) console.log(`  ${b}: ${c}`);
