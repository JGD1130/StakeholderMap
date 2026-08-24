// src/utils/roomUtilizationMeta.js
//
// Classroom Utilization module (Hastings-only). Isolated helpers for the
// Room Utilization Tagging build step (roomUtilizationMeta) -- derives the
// distinct room list from already-imported courseMeetings docs and builds
// the roomKey those docs get tagged under. Framework-agnostic (no Firestore
// imports), same isolation convention as classroomScheduleImport.js:
// ClassroomUtilizationPanel.jsx owns the actual Firestore reads/writes.
//
// roomKey intentionally mirrors the format documented in
// classroomUtilizationSchema.js's RoomUtilizationMetaDoc comment --
// `${normalizeDashboardKey(buildingName)}||${normalizeUtilizationRoomKey(roomLabel)}`
// -- MINUS StakeholderMap.jsx's fuzzy resolveBuildingNameFromInput() step
// that normalizeDashboardKey wraps around canon(). This build step is
// scoped to new, isolated files only (no StakeholderMap.jsx changes), and
// it doesn't need that fuzzy resolver here: courseMeetings.building is
// already the canonical, alias-resolved building name at write time --
// ai-server's HASTINGS_CLASS_SCHEDULE_BUILDING_ALIASES resolves real
// registrar spellings (e.g. "Hurley McDonald" -> "Hurley-McDonald Hall")
// before a row ever reaches courseMeetings (see the 2026-08-18 HANDOFF
// entry / commit 5d31af0). canon() alone reproduces the same key for these
// already-canonical values without re-deriving or duplicating the fuzzy
// resolver.

import { canon } from './idUtils';

// Exact port of StakeholderMap.jsx's normalizeUtilizationRoomKey -- strips a
// leading-zero room number down to its bare digits (e.g. "007" -> "7") so
// the same physical room can't split into two keys over a zero-padding
// inconsistency between data sources.
function normalizeRoomLabel(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (/^0+\d+$/.test(raw)) return String(Number(raw));
  return raw;
}

// Floorplan-vs-courseMeetings room-number normalization -- confirmed via a
// direct audit of the real floorplan geojson (public/floorplans/Hastings/
// */Rooms/*.geojson `Number` property) against courseMeetings' 48 distinct
// building+room pairs from the real Fall 2026 combined workbook: 36/48
// already joined cleanly, 12/48 didn't.
//
// This is a SEPARATE, ISOLATED normalization from StakeholderMap.jsx's
// AIRTABLE_ROOM_PREFIX_STRIP and CLASS_SCHEDULE_ROOM_PREFIX_STRIP -- those
// serve the Airtable-vs-schedule join and are NOT touched by this file, even
// though two of the three prefix shapes below happen to look the same.
// Applied to whichever side's room label actually carries the shape (the
// floorplan's `Number` field for the prefix cases, courseMeetings' raw
// unimported `room` text for the suffix case) -- a no-op on the other side.
const FLOORPLAN_ROOM_PREFIX_STRIP = {
  // Farrell-Fleharty: the floorplan geojson bakes an "FC-" prefix into every
  // room number in the 100-153 range (e.g. "FC-142"); courseMeetings stores
  // the bare number. 6/6 rooms confirmed affected.
  farrell_fleharty: /^FC-/i,
  // Kiewit: only "GYM" carries a floorplan prefix ("K GYM", space-separated).
  // Scoped with a lookahead so Kiewit's other bare room numbers (113, 116,
  // ...) are never touched, and "SPC" (which has no floorplan counterpart at
  // all) is intentionally left unmatched rather than force-fixed.
  kiewit_building: /^K\s+(?=GYM$)/i,
};

function stripKnownFloorplanRoomPrefix(buildingKey, roomLabel) {
  const pattern = FLOORPLAN_ROOM_PREFIX_STRIP[buildingKey];
  return pattern ? String(roomLabel || '').replace(pattern, '') : roomLabel;
}

// Scott Studio Theater: courseMeetings.room stores the registrar workbook's
// raw text uncleaned (classroomScheduleImport.js does no room-label
// cleanup at import time), which has three inconsistent verbose variants of
// room 118 ("118 - Theater", "118 -Theat", "118 - Theat"); the floorplan's
// `Number` field for this room is already a clean bare "118". Extracts
// leading digits when followed by a hyphen-separated suffix -- a no-op for
// any hyphen-free room label (e.g. "01EV01", "148A"), so it's safe to apply
// unconditionally to either side of this join.
function extractLeadingFloorplanRoomNumber(roomLabel) {
  const match = String(roomLabel || '').trim().match(/^(\d+)\s*-\s*.+$/);
  return match ? match[1] : roomLabel;
}

// Morrison-Reeves Science Center, room 148: investigated rather than
// pattern-matched, per instruction. The floorplan has exactly one room in
// the "148" numbering slot -- "148A" (a Psychology classroom, 819 SF) --
// with no separate bare "148" room anywhere in the building (confirmed by
// enumerating every room number on both floors of the real floorplan
// geojson). Critically, every OTHER lettered room in this same floorplan
// (128/128A, 141/141A, 142/142A/142B, 146/146A, 150/150A) has BOTH the base
// number and the suffixed one as distinct physical rooms -- so a general
// "strip a trailing letter" rule would be wrong and would wrongly conflate
// those genuinely-different pairs. 148 is the one exception with no
// base-number sibling, which is why this is a single scoped exact-match
// alias, not a stripped pattern -- the same judgment call already made for
// Kiewit's SPC (left unmatched rather than force-fixed).
const FLOORPLAN_ROOM_EXACT_ALIAS = {
  'morrison_reeves_science_center||148a': '148',
};

function applyFloorplanRoomExactAlias(buildingKey, roomLabel) {
  const key = `${buildingKey}||${String(roomLabel || '').trim().toLowerCase()}`;
  return FLOORPLAN_ROOM_EXACT_ALIAS[key] || roomLabel;
}

export function buildRoomUtilizationMetaKey(building, room) {
  const buildingKey = canon(building);
  let cleanedRoom = stripKnownFloorplanRoomPrefix(buildingKey, room);
  cleanedRoom = extractLeadingFloorplanRoomNumber(cleanedRoom);
  cleanedRoom = applyFloorplanRoomExactAlias(buildingKey, cleanedRoom);
  const roomKey = normalizeRoomLabel(cleanedRoom);
  if (!buildingKey || !roomKey) return '';
  return `${buildingKey}||${roomKey}`;
}

// Distinct building+room pairs across all courseMeetings docs, sorted by
// building then room (numeric-aware) for a stable, predictable row order.
// Deliberately reads only {building, room} off each doc -- this is a room
// *list* derivation, not a schedule reducer, so course/section/time fields
// are irrelevant here.
export function deriveDistinctRoomsFromCourseMeetings(courseMeetingDocs) {
  const seen = new Map();
  (Array.isArray(courseMeetingDocs) ? courseMeetingDocs : []).forEach((data) => {
    const building = String(data?.building || '').trim();
    const room = String(data?.room || '').trim();
    if (!building || !room) return;
    const roomKey = buildRoomUtilizationMetaKey(building, room);
    if (!roomKey || seen.has(roomKey)) return;
    seen.set(roomKey, { roomKey, building, room });
  });
  return Array.from(seen.values()).sort((a, b) => {
    const buildingCompare = a.building.localeCompare(b.building);
    if (buildingCompare !== 0) return buildingCompare;
    return a.room.localeCompare(b.room, undefined, { numeric: true });
  });
}
