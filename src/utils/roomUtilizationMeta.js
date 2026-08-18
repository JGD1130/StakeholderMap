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

export function buildRoomUtilizationMetaKey(building, room) {
  const buildingKey = canon(building);
  const roomKey = normalizeRoomLabel(room);
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
