// src/utils/researchSpaceRoomScope.js
//
// Research Space Classification module (Hastings-only, new). Derives the
// room universe this module is scoped to -- every Lab-type and Office-type
// room in the live Hastings Airtable inventory -- reusing the EXACT
// filtering/dedup shape already shipped for the Office/FTE expansion
// (deriveOfficeRoomsFromAirtable, roomTypeSuggestion.js), not a re-derived
// approximation: same building-name/room-prefix resolution
// (classroomUtilizationCalc.js), same roomKey (roomUtilizationMeta.js), same
// "first record wins" determinism, same prefix-match convention (broader
// than ROOM_TYPE_TO_SPACE_CATEGORY's exact-membership list, so a future new
// subtype still surfaces here rather than staying invisible).
//
// Scope confirmed 2026-09-17 via a live pull of all 2,986 Hastings Airtable
// room records (scripts/investigate-research-space-room-counts.mjs):
//   - Office - * (all 17 subtypes): 275 rooms
//   - Laboratory - * (all 6 subtypes, incl. Special Nonclass/Service/Music
//     Practice/Computer non-scheduled, not just the 2 subtypes
//     ROOM_TYPE_TO_SPACE_CATEGORY already maps to "Lab"): 67 rooms
//   Combined scope: 342 rooms in the raw Airtable pull; 306 after the Hayes
//   M. Fuhr Hall of Music exclusion below (36 rooms). Deliberately the BROAD
//   interpretation, per
//   Clark's explicit decision -- the occupant-based model itself is what
//   determines a room's real functional mix (a Music Practice room with no
//   grant-funded occupant simply rolls up to 100% Instruction/IDR), so
//   pre-excluding subtypes at the room-scope layer would just hide rooms
//   that could legitimately carry real research/sponsored-activity funding.
import { resolveAirtableBuildingName, stripKnownAirtableRoomPrefix } from './classroomUtilizationCalc';
import { buildRoomUtilizationMetaKey } from './roomUtilizationMeta';

// Buildings that no longer physically exist but still carry stale rows in
// Airtable. Their rooms can never be surveyed, have no floorplan, and would
// otherwise sit in "Remaining" forever, so they are dropped from the scope
// entirely. Hayes M. Fuhr Hall of Music: demolished (confirmed by Clark,
// 2026-09-21) -- 36 rooms (Music Practice/Studio labs + offices).
//
// Deliberately NOT StakeholderMap.jsx's SCENARIO_OFFLINE_BUILDINGS: that list
// is a planning-scenario heuristic ("low-fit building") and isn't a statement
// that a building is gone, so it is not reused as the convention here.
// Compared on letters/digits only so "Hayes M.Fuhr" (the Airtable spelling)
// and "Hayes M. Fuhr" match alike.
const DEMOLISHED_BUILDING_KEYS = new Set([
  'hayesmfuhrhallofmusic'
]);
function isDemolishedBuilding(buildingName) {
  return DEMOLISHED_BUILDING_KEYS.has(String(buildingName || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
}

const OFFICE_ROOM_TYPE_PREFIX = 'Office - ';
const LAB_ROOM_TYPE_PREFIX = 'Laboratory - ';

function roomTypeSource(roomType) {
  if (roomType.startsWith(OFFICE_ROOM_TYPE_PREFIX)) return 'office';
  if (roomType.startsWith(LAB_ROOM_TYPE_PREFIX)) return 'lab';
  return null;
}

// Combined Lab+Office room universe. Each entry: { roomKey, building, room,
// source: 'office'|'lab', roomType, areaSF, folder, floor }. Deduped by
// roomKey exactly like deriveOfficeRoomsFromAirtable ("first record wins"),
// sorted building then room (numeric-aware).
//
// roomKey is built from the Airtable building name and is deliberately left
// exactly as it was: researchSpaceOccupants / researchSpaceRoomStatus docs
// already saved are keyed by it, so changing its building component would
// orphan them.
//
// `folder` is the floorplan folder for the room's building (e.g. Airtable
// "Barrett Alumni Center" -> "Barrett Alumni"), used to join a room to its
// floorplan features. It is resolved by the caller-supplied
// resolveBuildingFolder -- StakeholderMap.jsx passes its own
// getBuildingFolderKey, i.e. the SAME alias table floorplan rendering uses,
// rather than a second list kept here. null when unresolved/not supplied.
// `floor` is Airtable's numeric floor (0 = basement) or null.
export function deriveResearchSpaceRoomsFromAirtable(airtableRooms, { resolveBuildingFolder } = {}) {
  const seen = new Map();
  (Array.isArray(airtableRooms) ? airtableRooms : []).forEach((room) => {
    const roomType = String(room?.type || '').trim();
    const source = roomTypeSource(roomType);
    if (!source) return;
    const rawBuilding = String(room?.building || '').trim();
    if (!rawBuilding) return;
    const building = resolveAirtableBuildingName(rawBuilding);
    const rawRoomLabel = String(room?.roomNumber || room?.roomId || '').trim();
    const roomLabel = stripKnownAirtableRoomPrefix(building, rawRoomLabel);
    if (!building || !roomLabel) return;
    if (isDemolishedBuilding(building)) return;
    const roomKey = buildRoomUtilizationMetaKey(building, roomLabel);
    if (!roomKey) return;
    if (seen.has(roomKey)) return;
    const areaSF = Number(room?.areaSF);
    const floorNum = room?.floor === '' || room?.floor == null ? NaN : Number(room.floor);
    seen.set(roomKey, {
      roomKey,
      building,
      room: roomLabel,
      source,
      roomType,
      areaSF: Number.isFinite(areaSF) && areaSF > 0 ? areaSF : null,
      folder: (typeof resolveBuildingFolder === 'function' ? resolveBuildingFolder(building) : null) || null,
      floor: Number.isFinite(floorNum) ? floorNum : null
    });
  });
  return Array.from(seen.values()).sort((a, b) => {
    const buildingCompare = a.building.localeCompare(b.building);
    if (buildingCompare !== 0) return buildingCompare;
    return a.room.localeCompare(b.room, undefined, { numeric: true });
  });
}
