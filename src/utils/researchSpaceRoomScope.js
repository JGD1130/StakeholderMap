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
//   Combined scope: 342 rooms. Deliberately the BROAD interpretation, per
//   Clark's explicit decision -- the occupant-based model itself is what
//   determines a room's real functional mix (a Music Practice room with no
//   grant-funded occupant simply rolls up to 100% Instruction/IDR), so
//   pre-excluding subtypes at the room-scope layer would just hide rooms
//   that could legitimately carry real research/sponsored-activity funding.
import { resolveAirtableBuildingName, stripKnownAirtableRoomPrefix } from './classroomUtilizationCalc';
import { buildRoomUtilizationMetaKey } from './roomUtilizationMeta';

const OFFICE_ROOM_TYPE_PREFIX = 'Office - ';
const LAB_ROOM_TYPE_PREFIX = 'Laboratory - ';

function roomTypeSource(roomType) {
  if (roomType.startsWith(OFFICE_ROOM_TYPE_PREFIX)) return 'office';
  if (roomType.startsWith(LAB_ROOM_TYPE_PREFIX)) return 'lab';
  return null;
}

// Combined Lab+Office room universe. Each entry: { roomKey, building, room,
// source: 'office'|'lab', roomType, areaSF }. Deduped by roomKey exactly like
// deriveOfficeRoomsFromAirtable ("first record wins"), sorted building then
// room (numeric-aware).
export function deriveResearchSpaceRoomsFromAirtable(airtableRooms) {
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
    const roomKey = buildRoomUtilizationMetaKey(building, roomLabel);
    if (!roomKey) return;
    if (seen.has(roomKey)) return;
    const areaSF = Number(room?.areaSF);
    seen.set(roomKey, {
      roomKey,
      building,
      room: roomLabel,
      source,
      roomType,
      areaSF: Number.isFinite(areaSF) && areaSF > 0 ? areaSF : null
    });
  });
  return Array.from(seen.values()).sort((a, b) => {
    const buildingCompare = a.building.localeCompare(b.building);
    if (buildingCompare !== 0) return buildingCompare;
    return a.room.localeCompare(b.room, undefined, { numeric: true });
  });
}
