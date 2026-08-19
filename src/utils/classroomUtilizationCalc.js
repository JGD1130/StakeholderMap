// src/utils/classroomUtilizationCalc.js
//
// Classroom Utilization module (Hastings-only). Isolated helpers for the
// Utilization Calc Engine build step (roadmap item 6/6) -- turns already-
// fetched courseMeetings/terms Firestore docs plus an Airtable rooms payload
// into per-room Time/Seat Utilization numbers. Framework-agnostic (no
// Firestore imports), same isolation convention as classroomScheduleImport.js
// and roomUtilizationMeta.js: ClassroomUtilizationPanel.jsx owns the actual
// Firestore reads and the Airtable fetch call site, this file is pure
// computation over plain data.
//
// Two conditions this file was built to handle defensively rather than
// assume, per explicit instruction (live Firestore verification was blocked
// by a DevTools paste issue this session, so nothing about real courseMeetings/
// terms data shape below was re-confirmed against live docs before this was
// written):
//   1. A courseMeetings doc's sessionRaw might not resolve to any existing
//      terms doc (typo, a term never entered, or a sessionRaw the parser
//      can't read at all). Such meetings are excluded from Time Utilization
//      and surfaced in a visible, named list -- never silently dropped or
//      defaulted to a fabricated hours number.
//   2. enrollment/capacity may be present or absent per meeting/room. Seat
//      Utilization is only ever computed when both are genuinely known;
//      otherwise the room is labeled with *why* it isn't computed
//      (pending-enrollment vs capacity-unknown) instead of showing 0% or a
//      blank cell that looks like a computed zero.

import { canon } from './idUtils';
import { buildRoomUtilizationMetaKey } from './roomUtilizationMeta';

// Airtable's official facilities "Building" field text doesn't always match
// the canonical building name courseMeetings stores (ai-server's
// HASTINGS_CLASS_SCHEDULE_BUILDING_ALIASES resolves the registrar's short
// building codes to a canonical name -- server.js:94 -- which is sometimes a
// different string entirely, not just different punctuation/spacing that
// canon() would already absorb). Checked every Hastings building that
// actually has scheduled classrooms this session (Gray Center, Hurley-
// McDonald, Jackson Dinsdale Art Center, Physical Fitness Facility,
// McCormick Hall, Morrison-Reeves Science Center, Wilson Center, Kiewit
// Building, Scott Studio Theatre, Farrell-Fleharty) against live Airtable
// data -- only these two genuinely diverge after canon():
//   - "Farrell Arena Fleharty Educational Center" (Airtable) vs
//     "Farrell-Fleharty" (courseMeetings, from alias code "FC")
//   - "Scott Studio Theatre" (Airtable, "-re" spelling) vs
//     "Scott Studio Theater" (courseMeetings, from alias codes "SCOTT"/"SEAT",
//     "-er" spelling) -- a spelling difference, not a punctuation one, so
//     canon() alone can't bridge it either.
// Keyed by canon(Airtable's raw building name) -> the courseMeetings-side
// canonical name to use instead. Data-driven and additive: a newly
// discovered mismatch is a one-line entry here, not a new resolver.
const AIRTABLE_BUILDING_NAME_OVERRIDES = {
  [canon('Farrell Arena Fleharty Educational Center')]: 'Farrell-Fleharty',
  [canon('Scott Studio Theatre')]: 'Scott Studio Theater'
};

function resolveAirtableBuildingName(rawBuilding) {
  return AIRTABLE_BUILDING_NAME_OVERRIDES[canon(rawBuilding)] || rawBuilding;
}

// Airtable bakes a building-code prefix into some buildings' Room ID field
// (Farrell-Fleharty: "FC-146") while courseMeetings stores the bare room
// number the registrar schedule uses ("146"). Confirmed via direct Airtable
// pull this is NOT universal -- Gray Center, Hurley-McDonald, Jackson
// Dinsdale, McCormick, Morrison-Reeves, Wilson Center, Kiewit, Physical
// Fitness, and Scott Studio Theatre were all checked and every one of them
// stores bare room numbers already. Keyed by the resolved canonical building
// name (post AIRTABLE_BUILDING_NAME_OVERRIDES, pre-canon), so this stays
// data-driven per building rather than one blanket regex that could
// mis-strip a legitimately hyphenated room number in some other building
// later.
const AIRTABLE_ROOM_PREFIX_STRIP = {
  [canon('Farrell-Fleharty')]: /^FC-/i
};

function stripKnownAirtableRoomPrefix(canonicalBuilding, roomLabel) {
  const pattern = AIRTABLE_ROOM_PREFIX_STRIP[canon(canonicalBuilding)];
  return pattern ? String(roomLabel || '').replace(pattern, '') : roomLabel;
}

const DEFAULT_PUBLIC_AI_BASE_URL = 'https://github-stakeholder-ai.onrender.com';

// Mirrors classroomScheduleImport.js's resolveClassScheduleUrl() resolution
// order exactly (explicit env override, then the known production AI host on
// GitHub Pages, then a bare relative path for the dev proxy) -- same
// reasoning, different endpoint. /ai/api/rooms already exists and is already
// read-only (StakeholderMap.jsx's own Airtable sync uses it); nothing new is
// added to ai-server for this.
export function resolveRoomsUrl() {
  const envBase = (import.meta.env.VITE_AI_BASE_URL || '').trim();
  if (envBase) return `${envBase.replace(/\/$/, '')}/ai/api/rooms`;
  if (typeof window !== 'undefined' && window.location.hostname.includes('github.io')) {
    return `${DEFAULT_PUBLIC_AI_BASE_URL}/ai/api/rooms`;
  }
  return '/ai/api/rooms';
}

export async function fetchAirtableRoomsForUtilization({ timeoutMs = 20000 } = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(resolveRoomsUrl(), {
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch {}
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || raw || `HTTP ${res.status}`);
  }
  return Array.isArray(json.rooms) ? json.rooms : [];
}

// building+room -> Airtable Seat Count, keyed with the exact same
// buildRoomUtilizationMetaKey() used to key roomUtilizationMeta docs and to
// derive the room list from courseMeetings -- so a courseMeetings room and
// its Airtable capacity line up under one key with no separate matching
// logic to drift out of sync. /ai/api/rooms already normalizes the seat
// field (server.js's AIRTABLE_SEAT_FIELD, default "Seat Count") into
// `seatCount` on every room object -- see the 2026-08-19 groundwork session,
// confirmed by direct Airtable pull that classroom records use "Seat Count"
// with values like 40/32/37, non-classroom spaces (offices, storage,
// restrooms) simply omit the field.
//
// seatCount <= 0 is treated as "not resolvable", not "capacity is zero" --
// server.js defaults a missing field to 0 (`Number(seatCount ?? 0) || 0`),
// so 0 is indistinguishable from absent and a real 0-seat classroom isn't a
// case that exists.
export function buildAirtableCapacityMap(airtableRooms) {
  const map = new Map();
  (Array.isArray(airtableRooms) ? airtableRooms : []).forEach((room) => {
    const rawBuilding = String(room?.building || '').trim();
    if (!rawBuilding) return;
    const building = resolveAirtableBuildingName(rawBuilding);
    const rawRoomLabel = String(room?.roomNumber || room?.roomId || '').trim();
    const roomLabel = stripKnownAirtableRoomPrefix(building, rawRoomLabel);
    if (!building || !roomLabel) return;
    const seatCount = Number(room?.seatCount);
    if (!Number.isFinite(seatCount) || seatCount <= 0) return;
    const roomKey = buildRoomUtilizationMetaKey(building, roomLabel);
    if (!roomKey) return;
    // Airtable can have multiple records resolving to the same key (rare,
    // but not impossible with duplicate/renumbered rooms) -- first one wins,
    // deterministic rather than last-write-wins on unordered array iteration.
    if (!map.has(roomKey)) map.set(roomKey, seatCount);
  });
  return map;
}

// Exact port of ClassroomUtilizationPanel.jsx's TermsSection buildTermId() --
// kept as a standalone copy here (not imported) for the same reason
// classroomScheduleImport.js/roomUtilizationMeta.js keep their own copies of
// small shared logic: this file is scoped to be a new, isolated module, and
// buildTermId lives inside a component closure, not an exported function.
function buildTermId({ academicYear, term, sessionNumber }) {
  const yearPart = String(academicYear ?? '').trim() || 'x';
  const termPart = String(term ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  const sessionPart = String(sessionNumber ?? '').trim() || 'x';
  return `${yearPart}-${termPart}-${sessionPart}`;
}

// Parses courseMeetings.sessionRaw (e.g. "2026 / FALL / 1") into the same
// three parts buildTermId expects. Mirrors ai-server's
// formatClassScheduleSessionLabel regex exactly (server.js:851) -- that
// function's match groups are exactly (year, term, session), the same three
// inputs buildTermId needs, so parsing sessionRaw this way reproduces
// exactly the termId a term added via TermsSection's "Fall 2026 Block 1/2"
// quick-fill buttons would get. Returns null (not a guess) if sessionRaw
// doesn't match the expected "YYYY / TERM / N" shape at all.
function parseSessionRawToTermParts(sessionRaw) {
  const match = String(sessionRaw || '').match(/^\s*(\d{4})\s*\/\s*([A-Za-z]+)\s*\/\s*(\d+)\s*$/);
  if (!match) return null;
  return { academicYear: match[1], term: match[2], sessionNumber: match[3] };
}

export function deriveTermIdFromSessionRaw(sessionRaw) {
  const parts = parseSessionRawToTermParts(sessionRaw);
  return parts ? buildTermId(parts) : null;
}

// WeeklyHours for one meeting: (end-start in hours) * number of days/week it
// meets. Returns null (not 0) when the time fields can't support a real
// computation -- a null contributes nothing to a room's total rather than
// masquerading as "this meeting genuinely takes zero hours/week", which
// would silently understate utilization instead of just omitting an
// unparseable row.
export function computeMeetingWeeklyHours(meeting) {
  const start = Number(meeting?.startMinutes);
  const end = Number(meeting?.endMinutes);
  const dayCount = Array.isArray(meeting?.dayTokens) ? meeting.dayTokens.filter(Boolean).length : 0;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || dayCount <= 0) return null;
  return ((end - start) / 60) * dayCount;
}

function hasFiniteEnrollment(meeting) {
  const value = meeting?.enrollment;
  if (value === '' || value === null || value === undefined) return false;
  return Number.isFinite(Number(value));
}

// Main aggregation. Pure function: takes plain arrays already fetched by the
// caller (Firestore docs' .data() output, and /ai/api/rooms's `rooms` array)
// and returns everything the UI needs to render -- no Firestore/React
// awareness here.
//
// Room+term grain, per Clark's decision: a room used in both Fall 2026
// Block 1 and Block 2 (the common case for this dataset, not an edge case --
// courseMeetings was imported from the combined Block 1+2 workbook) produces
// two separate rows, each computed only against that one term's meetings and
// that term's standardWeeklyHours -- never blended/summed across terms. The
// aggregation key is `${roomKey}||${termId}`, not just roomKey.
//
// A meeting whose sessionRaw doesn't resolve to any terms doc has no termId
// to key a row under at all -- it's excluded from every row's Time
// Utilization AND Seat Utilization (there's no term bucket to attribute its
// enrollment to), same as before, and still fully visible via the
// unmatchedMeetings list returned below. This isn't a new rule; it's the
// direct consequence of the key now requiring a real termId to exist.
export function computeClassroomUtilization({ courseMeetingDocs, termDocs, airtableRooms }) {
  const termsById = new Map(
    (Array.isArray(termDocs) ? termDocs : []).map((t) => [
      String(t?.id ?? ''),
      Number(t?.data?.standardWeeklyHours)
    ])
  );

  const capacityByRoomKey = buildAirtableCapacityMap(airtableRooms);

  const rowAgg = new Map(); // `${roomKey}||${termId}` -> working accumulator

  const unmatchedMeetings = [];

  (Array.isArray(courseMeetingDocs) ? courseMeetingDocs : []).forEach((meeting) => {
    const building = String(meeting?.building || '').trim();
    const room = String(meeting?.room || '').trim();
    if (!building || !room) return; // same guard deriveDistinctRoomsFromCourseMeetings uses
    const roomKey = buildRoomUtilizationMetaKey(building, room);
    if (!roomKey) return;

    // --- Term resolution: gates BOTH Time and Seat Utilization now, since
    // a row can't exist without a term to key it under. ---
    const termId = deriveTermIdFromSessionRaw(meeting?.sessionRaw);
    const standardWeeklyHours = termId != null ? termsById.get(termId) : undefined;
    const termMatched = termId != null && Number.isFinite(standardWeeklyHours) && standardWeeklyHours > 0;

    if (!termMatched) {
      unmatchedMeetings.push({
        building,
        room,
        courseCode: String(meeting?.courseCode || ''),
        sessionLabel: String(meeting?.sessionLabel || ''),
        sessionRaw: String(meeting?.sessionRaw || ''),
        derivedTermId: termId,
        reason: termId == null ? 'sessionRaw unparseable' : 'no matching terms doc'
      });
      return; // excluded from every row, per instruction
    }

    const rowKey = `${roomKey}||${termId}`;
    if (!rowAgg.has(rowKey)) {
      rowAgg.set(rowKey, {
        roomKey,
        termId,
        termLabel: String(meeting?.sessionLabel || '') || termId,
        building,
        room,
        weeklyHoursUsed: 0,
        enrollmentSamples: [],
        meetingCount: 0
      });
    }
    const agg = rowAgg.get(rowKey);
    agg.meetingCount += 1;

    // --- Seat Utilization input: same formula as before, now scoped to
    // this room+term bucket only (a meeting only ever belongs to one term,
    // so this is not a behavior change for any single meeting -- only the
    // bucket it's summarized into changes). ---
    if (hasFiniteEnrollment(meeting)) {
      agg.enrollmentSamples.push(Number(meeting.enrollment));
    }

    const weeklyHours = computeMeetingWeeklyHours(meeting);
    if (weeklyHours != null) {
      agg.weeklyHoursUsed += weeklyHours;
    }
  });

  const rooms = Array.from(rowAgg.values()).map((agg) => {
    const standardWeeklyHoursAvailable = Number(termsById.get(agg.termId)) || 0;
    const timeUtilizationPct = standardWeeklyHoursAvailable > 0
      ? (agg.weeklyHoursUsed / standardWeeklyHoursAvailable) * 100
      : null;

    const capacity = capacityByRoomKey.has(agg.roomKey) ? capacityByRoomKey.get(agg.roomKey) : null;
    const avgEnrollment = agg.enrollmentSamples.length
      ? agg.enrollmentSamples.reduce((sum, v) => sum + v, 0) / agg.enrollmentSamples.length
      : null;

    let seatUtilizationStatus;
    let seatUtilizationPct = null;
    if (avgEnrollment == null) {
      seatUtilizationStatus = 'pending-enrollment';
    } else if (capacity == null) {
      seatUtilizationStatus = 'capacity-unknown';
    } else {
      seatUtilizationStatus = 'computed';
      seatUtilizationPct = (avgEnrollment / capacity) * 100;
    }

    return {
      rowKey: `${agg.roomKey}||${agg.termId}`,
      roomKey: agg.roomKey,
      termId: agg.termId,
      termLabel: agg.termLabel,
      building: agg.building,
      room: agg.room,
      weeklyHoursUsed: agg.weeklyHoursUsed,
      standardWeeklyHoursAvailable,
      timeUtilizationPct,
      meetingCount: agg.meetingCount,
      capacity,
      avgEnrollment,
      seatUtilizationStatus,
      seatUtilizationPct
    };
  }).sort((a, b) => (
    a.building.localeCompare(b.building)
    || a.room.localeCompare(b.room, undefined, { numeric: true })
    || a.termId.localeCompare(b.termId)
  ));

  const buildingSummaryMap = new Map();
  rooms.forEach((r) => {
    if (!buildingSummaryMap.has(r.building)) {
      buildingSummaryMap.set(r.building, {
        building: r.building,
        weeklyHoursUsed: 0,
        standardWeeklyHoursAvailable: 0,
        roomKeys: new Set()
      });
    }
    const b = buildingSummaryMap.get(r.building);
    b.weeklyHoursUsed += r.weeklyHoursUsed;
    b.standardWeeklyHoursAvailable += r.standardWeeklyHoursAvailable;
    // A distinct-room count, not a row count -- a room split into two
    // per-term rows above should still count once here, not twice.
    b.roomKeys.add(r.roomKey);
  });
  const buildingSummary = Array.from(buildingSummaryMap.values())
    .map(({ roomKeys, ...b }) => ({
      ...b,
      roomCount: roomKeys.size,
      // Weighted by hours available, not a naive average of room percentages
      // -- a 40-hr/week room and a 5-hr/week room shouldn't count equally
      // toward a building's overall Time Utilization.
      timeUtilizationPct: b.standardWeeklyHoursAvailable > 0
        ? (b.weeklyHoursUsed / b.standardWeeklyHoursAvailable) * 100
        : null
    }))
    .sort((a, b) => a.building.localeCompare(b.building));

  return { rooms, buildingSummary, unmatchedMeetings };
}
