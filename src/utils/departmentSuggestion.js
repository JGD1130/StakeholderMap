// src/utils/departmentSuggestion.js
//
import { buildRoomUtilizationMetaKey } from './roomUtilizationMeta';
import { resolveAirtableBuildingName, stripKnownAirtableRoomPrefix } from './classroomUtilizationCalc';

// Classroom Utilization module (Hastings-only). Isolated helper for
// suggesting a roomUtilizationMeta primaryDepartment from Airtable's
// "Department" field, per Clark's 2026-08-20 screenshot confirming the
// Rooms table's Division 1 / Department fields are populated for
// essentially every room with clean values (e.g. "Arts & Humanities" /
// "History, Religion, Philosophy").
//
// Already exposed, no proxy change needed. ai-server's /api/rooms handler
// already reads this (AIRTABLE_DEPT_FIELD, default literal Airtable field
// "Department", linked through the "Departments" table via
// AIRTABLE_DEPT_TABLE/AIRTABLE_DEPT_PRIMARY_FIELD) and returns it as
// `department` on every room object -- confirmed via a live pull against
// the real endpoint, not assumed. Airtable's "Division 1" field is NOT
// currently exposed by the proxy, but isn't needed here either: the 12 real
// enrollmentProjections department names are unique strings regardless of
// division, so Department alone is enough to match against them. If a
// future need for Division 1 comes up, that's a server.js/.env change and
// needs its own sign-off, same as every other proxy-touching decision in
// this module.
//
// NOT a 1:1 passthrough -- checked, not assumed. Airtable's Department
// field is populated at a finer discipline granularity than
// enrollmentProjections' 12 department records (which group several
// disciplines under one combined budget-line department, e.g. "Chemistry &
// Physics", "Psychology & Sociology"). Verified against a live pull of all
// 43 (of 48) courseMeetings-scheduled rooms that resolve to an Airtable
// record: only 3 of the 12 real department names are exact-string
// department values in Airtable (Art, Biology, Languages & Literatures --
// the only 3 of the 12 that aren't themselves a combined name). Every other
// real department needs the grouping below, checked by hand against real
// Airtable values pulled from the live endpoint -- same grouping discipline
// roomTypeSuggestion.js's ROOM_TYPE_TO_SPACE_CATEGORY used for
// spaceCategory, not a fuzzy/automatic matcher (a hardcoded, reviewable map
// stays correct even if a future Airtable value is superficially similar to
// but not actually the same as a real department).
//
// Two entries are a judgment call worth flagging (both still the only
// sensible mapping -- there is no better candidate in either case, and both
// are still gated by the "must exist in the live department list" check in
// suggestPrimaryDepartmentFromAirtableDepartment below): "Math" -> "Math &
// Computer Science" and "Communication" -> "Communication Studies &
// Political Science" both drop a named sub-discipline that has no Airtable
// rooms of its own in the current dataset. Same "suggested, not saved"
// treatment as every other suggestion in this module -- admin can always
// override before Save.
export const AIRTABLE_DEPARTMENT_TO_ENROLLMENT_DEPARTMENT = {
  'Art': 'Art',
  'Biology': 'Biology',
  'Languages & Literatures': 'Languages & Literatures',
  'Business Economics': 'Business & Economics',
  'History, Religion, Philosophy': 'History, Philosophy, & Religion',
  'Physics': 'Chemistry & Physics',
  'Chemistry': 'Chemistry & Physics',
  'Psychology': 'Psychology & Sociology',
  'Music': 'Music & Theater',
  'Theatre': 'Music & Theater',
  'Teacher Education': 'Education',
  'Physical Education': 'PHEP',
  'Communication': 'Communication Studies & Political Science',
  'Math': 'Math & Computer Science'
};

// knownDepartmentNames: the live enrollmentProjections department-name list
// (RoomUtilizationMetaSection's departmentOptions, from the same onSnapshot
// listener the manual dropdown already uses) -- required, not optional. A
// suggestion is only ever offered when the mapped name is confirmed to
// still exist as a real department right now; if a workbook re-upload ever
// renames or drops a department, a stale entry in the map above silently
// produces no suggestion instead of pre-filling a value that no longer
// exists.
export function suggestPrimaryDepartmentFromAirtableDepartment(airtableDepartment, knownDepartmentNames) {
  const key = String(airtableDepartment || '').trim();
  if (!key) return '';
  const mapped = AIRTABLE_DEPARTMENT_TO_ENROLLMENT_DEPARTMENT[key];
  if (!mapped) return '';
  const known = Array.isArray(knownDepartmentNames) ? knownDepartmentNames : [];
  return known.includes(mapped) ? mapped : '';
}

// building+room -> Airtable's raw Department string, same join convention
// as roomTypeSuggestion.js's buildAirtableRoomTypeMap (identical
// building-name/room-prefix resolution, reused rather than re-derived, so
// the two suggestion joins can never quietly drift out of sync with each
// other).
export function buildAirtableDepartmentMap(airtableRooms) {
  const map = new Map();
  (Array.isArray(airtableRooms) ? airtableRooms : []).forEach((room) => {
    const rawBuilding = String(room?.building || '').trim();
    if (!rawBuilding) return;
    const building = resolveAirtableBuildingName(rawBuilding);
    const rawRoomLabel = String(room?.roomNumber || room?.roomId || '').trim();
    const roomLabel = stripKnownAirtableRoomPrefix(building, rawRoomLabel);
    if (!building || !roomLabel) return;
    const department = String(room?.department || '').trim();
    if (!department) return;
    const roomKey = buildRoomUtilizationMetaKey(building, roomLabel);
    if (!roomKey) return;
    // First record wins for a given key, same determinism convention as
    // buildAirtableRoomTypeMap/buildAirtableCapacityMap.
    if (!map.has(roomKey)) map.set(roomKey, department);
  });
  return map;
}
