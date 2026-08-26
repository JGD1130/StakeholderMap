// src/utils/roomTypeSuggestion.js
//
// Classroom Utilization module (Hastings-only). Isolated helper for
// suggesting a roomUtilizationMeta spaceCategory from Airtable's "Room Type
// Description" field, per Clark's 2026-08-19 investigation: of the 48 rooms
// courseMeetings actually schedules classes in, 37 match an Airtable room
// record and every one of those 37 has a non-blank Room Type Description;
// exactly 7 distinct values are in use across them. The other 11 rooms
// (Farrell-Fleharty x7, Kiewit GYM/SPC, Scott Studio Theater x2) don't
// resolve to any Airtable room under the existing building/room-key join --
// see classroomUtilizationCalc.js's AIRTABLE_BUILDING_NAME_OVERRIDES /
// AIRTABLE_ROOM_PREFIX_STRIP for the known root causes (building-name
// mismatches, an "FC-" room prefix, inconsistent registrar room labels) --
// so those 11 simply have nothing to suggest from, not a blank/failed
// suggestion. RoomUtilizationMetaSection falls back to the existing manual
// dropdown for them, unchanged.
//
// Grouped, not a 1:1 passthrough -- matching the "100 Classrooms / 200 Labs"
// split StakeholderMap.jsx's Strategic Dashboard section already uses as
// precedent (STRATEGIC_DEFAULT_SEAT_SUPPLY_PREFIXES) for how granular a
// space-category split should be: every "Classroom - *" subtype suggests
// "Classroom", every "Laboratory - *" subtype suggests "Lab". This module
// only borrows that split as prior art -- it never reads from or writes to
// the Strategic Dashboard's data path.
//
// This file only computes a suggested category string from already-fetched
// data. It never creates a spaceConfig category and never writes to
// Firestore or Airtable -- ClassroomUtilizationPanel.jsx's
// RoomUtilizationMetaSection owns whether a suggestion is actually offered
// (only pre-filled if the suggested category already exists in spaceConfig)
// and all persistence.

import { buildRoomUtilizationMetaKey } from './roomUtilizationMeta';
import { resolveAirtableBuildingName, stripKnownAirtableRoomPrefix } from './classroomUtilizationCalc';

// The 7 distinct Room Type Description values found across the 37 matched
// rooms (direct Airtable pull, Hastings base appQbbKh2wTFogpN5, Rooms table,
// AIRTABLE_TYPE_FIELD="Room Type Description"). A value not in this map
// (e.g. a future new Airtable room type, or one of the many non-classroom
// types like "Office" that will never appear here since roomList is already
// scoped to courseMeetings' 48 scheduled rooms) simply has no suggestion.
// Office subtypes added 2026-08-25, per the Office/support space
// right-sizing investigation: pulled directly from a live /api/rooms fetch
// (not assumed/remembered) -- all 17 distinct "Office - *" Room Type
// Description values that currently exist in Airtable, ~275 rooms total.
// Grouped to "Office" the same way every "Classroom - *"/"Laboratory - *"
// subtype above already groups to "Classroom"/"Lab" -- one category per
// physical-space family, not a finer split.
export const ROOM_TYPE_TO_SPACE_CATEGORY = {
  'Classroom - General': 'Classroom',
  'Classroom - Multipurpose': 'Classroom',
  'Classroom - Collaborative': 'Classroom',
  'Classroom - Computer': 'Classroom',
  'Classroom - Indoor Amphitheater / Auditorium': 'Classroom',
  'Laboratory - Class': 'Lab',
  'Laboratory - Studio': 'Lab',
  'Office - Adjunct Faculty': 'Office',
  'Office - Conference Room': 'Office',
  'Office - Department / Suite Circulation': 'Office',
  'Office - Emeritus Faculty': 'Office',
  'Office - Faculty': 'Office',
  'Office - File Room': 'Office',
  'Office - Graduate / Post Doc Students': 'Office',
  'Office - Library / Reference Room': 'Office',
  'Office - Lounge / Lunch Room': 'Office',
  'Office - Mail Room': 'Office',
  'Office - Pantry / Kitchenette': 'Office',
  'Office - Prof and Admin': 'Office',
  'Office - Service': 'Office',
  'Office - Staff': 'Office',
  'Office - Student / Organization': 'Office',
  'Office - Waiting / Reception': 'Office',
  'Office - Work Room': 'Office'
};

export function suggestSpaceCategoryFromRoomType(roomTypeDescription) {
  const key = String(roomTypeDescription || '').trim();
  if (!key) return '';
  return ROOM_TYPE_TO_SPACE_CATEGORY[key] || '';
}

// building+room -> Airtable's raw Room Type Description string, keyed with
// the exact same buildRoomUtilizationMetaKey() every other join in this
// module uses, and the exact same building-name/room-prefix resolution
// classroomUtilizationCalc.js's buildAirtableCapacityMap() already applies
// (imported, not re-derived, so the two joins can never quietly drift apart
// from each other).
export function buildAirtableRoomTypeMap(airtableRooms) {
  const map = new Map();
  (Array.isArray(airtableRooms) ? airtableRooms : []).forEach((room) => {
    const rawBuilding = String(room?.building || '').trim();
    if (!rawBuilding) return;
    const building = resolveAirtableBuildingName(rawBuilding);
    const rawRoomLabel = String(room?.roomNumber || room?.roomId || '').trim();
    const roomLabel = stripKnownAirtableRoomPrefix(building, rawRoomLabel);
    if (!building || !roomLabel) return;
    const roomType = String(room?.type || '').trim();
    if (!roomType) return;
    const roomKey = buildRoomUtilizationMetaKey(building, roomLabel);
    if (!roomKey) return;
    // First record wins for a given key, same determinism convention as
    // buildAirtableCapacityMap.
    if (!map.has(roomKey)) map.set(roomKey, roomType);
  });
  return map;
}

// Real Airtable inventory rooms whose Room Type Description starts with
// "Office - ", added 2026-08-25 to settle the Office/support space
// right-sizing blocker: these ~275 rooms are never course-scheduled (no
// courseMeetings docs exist for them), so
// deriveDistinctRoomsFromCourseMeetings (roomUtilizationMeta.js) can never
// surface them for tagging on its own -- ClassroomUtilizationPanel.jsx
// merges this function's output with that one into one combined tagging
// universe.
//
// Filtered by PREFIX, not by exact membership in ROOM_TYPE_TO_SPACE_CATEGORY
// above -- deliberately broader than the reviewed suggestion map, so a
// future new "Office - <something>" subtype Airtable might add later still
// shows up here for manual tagging (same as any of the 5 unmapped
// courseMeetings rooms already do for Room Type today), rather than
// silently staying invisible until this map is updated too. It just won't
// get an auto-suggested category until the map catches up -- same
// "no match, no suggestion, tag manually" convention as everywhere else in
// this module.
//
// Same building/room-key resolution as buildAirtableRoomTypeMap above (not
// re-derived), so a room here and its entry in airtableRoomTypeByKey always
// agree on roomKey.
const OFFICE_ROOM_TYPE_PREFIX = 'Office - ';

export function deriveOfficeRoomsFromAirtable(airtableRooms) {
  const seen = new Map();
  (Array.isArray(airtableRooms) ? airtableRooms : []).forEach((room) => {
    const roomType = String(room?.type || '').trim();
    if (!roomType.startsWith(OFFICE_ROOM_TYPE_PREFIX)) return;
    const rawBuilding = String(room?.building || '').trim();
    if (!rawBuilding) return;
    const building = resolveAirtableBuildingName(rawBuilding);
    const rawRoomLabel = String(room?.roomNumber || room?.roomId || '').trim();
    const roomLabel = stripKnownAirtableRoomPrefix(building, rawRoomLabel);
    if (!building || !roomLabel) return;
    const roomKey = buildRoomUtilizationMetaKey(building, roomLabel);
    if (!roomKey) return;
    // First record wins for a given key, same determinism convention as
    // buildAirtableRoomTypeMap/buildAirtableCapacityMap above.
    if (!seen.has(roomKey)) seen.set(roomKey, { roomKey, building, room: roomLabel, source: 'office' });
  });
  return Array.from(seen.values()).sort((a, b) => {
    const buildingCompare = a.building.localeCompare(b.building);
    if (buildingCompare !== 0) return buildingCompare;
    return a.room.localeCompare(b.room, undefined, { numeric: true });
  });
}
