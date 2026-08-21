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

// Exported (in addition to being used internally below) so
// roomTypeSuggestion.js can join Airtable rooms to roomUtilizationMeta's
// roomKey with the exact same building/room resolution this file already
// verified against live Airtable data -- avoids a second, independently
// -maintained copy of AIRTABLE_BUILDING_NAME_OVERRIDES that could quietly
// drift out of sync with this one. Purely additive (adds `export`, changes
// no logic) -- computeClassroomUtilization()'s behavior is unchanged.
export function resolveAirtableBuildingName(rawBuilding) {
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

// Exported for the same reason as resolveAirtableBuildingName above -- reused
// as-is by roomTypeSuggestion.js, not re-derived.
export function stripKnownAirtableRoomPrefix(canonicalBuilding, roomLabel) {
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

// building+room -> Airtable Room Area (Sq Ft), same join convention as
// buildAirtableCapacityMap immediately above (kept as a separate function
// rather than refactored into a shared helper, deliberately -- this file's
// existing capacity-map logic is roadmap-6-verified against live data, and
// this is a new, additive read with its own field, not a reason to touch
// that function's body). Confirmed via direct /api/rooms pull (2026-08-19
// groundwork session, Space Growth build): Airtable's raw field is
// "Room Area Sq Ft" (AIRTABLE_AREA_FIELD), exposed here as `areaSF` on
// 2,981 of 2,986 Hastings room records (e.g. Wilson Center "0CR1" ->
// 955 sq ft, Gray Center 104 -> 83.71 sq ft) -- same near-universal
// coverage pattern as Seat Count/Room Type Description.
//
// areaSF <= 0 (or missing) is treated as "not resolvable", same reasoning
// as buildAirtableCapacityMap's seatCount handling -- a room with no real
// area on file shouldn't silently count as 0 SF toward a category's total.
export function buildAirtableAreaMap(airtableRooms) {
  const map = new Map();
  (Array.isArray(airtableRooms) ? airtableRooms : []).forEach((room) => {
    const rawBuilding = String(room?.building || '').trim();
    if (!rawBuilding) return;
    const building = resolveAirtableBuildingName(rawBuilding);
    const rawRoomLabel = String(room?.roomNumber || room?.roomId || '').trim();
    const roomLabel = stripKnownAirtableRoomPrefix(building, rawRoomLabel);
    if (!building || !roomLabel) return;
    const areaSF = Number(room?.areaSF);
    if (!Number.isFinite(areaSF) || areaSF <= 0) return;
    const roomKey = buildRoomUtilizationMetaKey(building, roomLabel);
    if (!roomKey) return;
    if (!map.has(roomKey)) map.set(roomKey, areaSF);
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

// --- "Current term" resolution -------------------------------------------
//
// Building-popup utilization (the replacement for the retired CSV card,
// see HANDOFF.md's "Known follow-up" note) needs a single answer to "which
// term is 'now'" -- unlike computeClassroomUtilization's buildingSummary
// above, which deliberately sums every term a room has ever met in.
//
// This replaces the old month-heuristic pattern used elsewhere in this
// codebase (StakeholderMap.jsx's getPreferredRoomScheduleSession,
// `date.getMonth() >= 9` to guess Fall-vs-Spring/Block-1-vs-2) with the
// real terms collection's own startDate/endDate, since that heuristic only
// ever had to pick between two known blocks inside one hardcoded academic
// calendar shape -- it can't generalize to "is there a configured term
// covering today at all," across any number of terms, gaps, or clients.
//
// Fallback behavior is explicit and visible, never silent:
//   - A term whose [startDate, endDate] window contains `now` wins. If more
//     than one does (overlapping windows -- a data-entry mistake, not
//     something this function tries to prevent), the earliest-starting one
//     wins, deterministically, not by array/Firestore order.
//   - If none contains `now`, the nearest FUTURE term (soonest startDate
//     still after `now`) is used, status 'upcoming' -- e.g. checking during
//     a semester break before the next term's window opens.
//   - If there's no current or future term, the most recently ENDED term
//     (latest endDate still before `now`) is used, status 'past' -- keeps
//     building-level output non-empty and clearly labeled instead of going
//     blank the moment a term's window lapses and nobody's entered the next
//     one yet.
//   - If termDocs is empty, or none has a usable startDate/endDate at all,
//     status is 'unconfigured' and there is no resolved term. Callers must
//     render this state explicitly -- never fall back to summing across
//     every term, which is a different, already-existing computation
//     (buildingSummary above), not a stand-in for "current."
export function resolveCurrentTerm(termDocs, now = new Date()) {
  const candidates = (Array.isArray(termDocs) ? termDocs : [])
    .map((t) => {
      const id = String(t?.id ?? '').trim();
      const data = t?.data || {};
      const start = data?.startDate?.toDate ? data.startDate.toDate() : null;
      const end = data?.endDate?.toDate ? data.endDate.toDate() : null;
      return { id, data, start, end };
    })
    .filter((t) => (
      t.id
      && t.start instanceof Date && !Number.isNaN(t.start.getTime())
      && t.end instanceof Date && !Number.isNaN(t.end.getTime())
      && t.end.getTime() >= t.start.getTime()
    ));

  if (!candidates.length) {
    return {
      status: 'unconfigured',
      termId: null,
      term: null,
      reason: 'No terms with valid start/end dates are configured.'
    };
  }

  const nowTime = now.getTime();

  const current = candidates
    .filter((t) => t.start.getTime() <= nowTime && nowTime <= t.end.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (current.length) {
    return { status: 'current', termId: current[0].id, term: current[0].data, reason: null };
  }

  const future = candidates
    .filter((t) => t.start.getTime() > nowTime)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (future.length) {
    return {
      status: 'upcoming',
      termId: future[0].id,
      term: future[0].data,
      reason: `No term is active today; showing the nearest upcoming term (starts ${future[0].start.toISOString().slice(0, 10)}).`
    };
  }

  const past = candidates
    .filter((t) => t.end.getTime() < nowTime)
    .sort((a, b) => b.end.getTime() - a.end.getTime());
  if (past.length) {
    return {
      status: 'past',
      termId: past[0].id,
      term: past[0].data,
      reason: `No current or upcoming term is configured; showing the most recently ended term (ended ${past[0].end.toISOString().slice(0, 10)}).`
    };
  }

  // Unreachable given every candidate is classified current/future/past
  // above relative to `now` -- kept as an explicit fallback rather than an
  // unhandled empty return, per this module's "never silent" convention.
  return { status: 'unconfigured', termId: null, term: null, reason: 'No usable term could be resolved.' };
}

// --- Building-level Time + Seat Utilization for the resolved current term -
//
// Distinct from buildingSummary (computeClassroomUtilization's own return
// value), which sums every term a room has ever met in. This filters down
// to exactly the one term resolveCurrentTerm() resolves above before
// aggregating -- a room used in both Fall 2026 Block 1 and Block 2 only
// contributes its Block-2 row here if Block 2 is the resolved current term,
// matching this module's existing room+term-grain, never-blended
// convention (see computeClassroomUtilization's own header comment).
//
// Seat Utilization at building level is new: room-level seatUtilizationPct
// values are weighted by capacity (a 200-seat lecture hall should move a
// building's number more than a 15-seat seminar room) and averaged, but
// ONLY across rooms whose own seatUtilizationPct is actually computed.
// Rooms with 'pending-enrollment' or 'capacity-unknown' status are counted
// and surfaced separately, never silently treated as 0% or dropped without
// a trace -- same visible-flagging philosophy as every other function in
// this module.
export function computeBuildingUtilizationForCurrentTerm({ courseMeetingDocs, termDocs, airtableRooms, now = new Date() }) {
  const currentTerm = resolveCurrentTerm(termDocs, now);

  if (!currentTerm.termId) {
    return { currentTerm, buildings: [], unmatchedMeetings: [] };
  }

  const { rooms, unmatchedMeetings } = computeClassroomUtilization({ courseMeetingDocs, termDocs, airtableRooms });
  const termRooms = rooms.filter((r) => r.termId === currentTerm.termId);

  const buildingMap = new Map();
  termRooms.forEach((r) => {
    if (!buildingMap.has(r.building)) {
      buildingMap.set(r.building, {
        building: r.building,
        weeklyHoursUsed: 0,
        standardWeeklyHoursAvailable: 0,
        roomKeys: new Set(),
        seatWeightedSum: 0,
        seatWeightTotal: 0,
        seatComputedRoomCount: 0,
        seatPendingEnrollmentCount: 0,
        seatCapacityUnknownCount: 0
      });
    }
    const b = buildingMap.get(r.building);
    b.roomKeys.add(r.roomKey);
    b.weeklyHoursUsed += r.weeklyHoursUsed;
    b.standardWeeklyHoursAvailable += r.standardWeeklyHoursAvailable;

    if (r.seatUtilizationStatus === 'computed') {
      b.seatComputedRoomCount += 1;
      // Capacity is guaranteed present/positive whenever status is
      // 'computed' (see computeClassroomUtilization above), so this is
      // never a fallback-to-1 in practice for a real computed row -- kept
      // only as a defensive floor, not a real code path.
      const weight = Number(r.capacity) > 0 ? Number(r.capacity) : 1;
      b.seatWeightedSum += r.seatUtilizationPct * weight;
      b.seatWeightTotal += weight;
    } else if (r.seatUtilizationStatus === 'pending-enrollment') {
      b.seatPendingEnrollmentCount += 1;
    } else if (r.seatUtilizationStatus === 'capacity-unknown') {
      b.seatCapacityUnknownCount += 1;
    }
  });

  const buildings = Array.from(buildingMap.values())
    .map(({ roomKeys, seatWeightedSum, seatWeightTotal, ...b }) => {
      const timeUtilizationPct = b.standardWeeklyHoursAvailable > 0
        ? (b.weeklyHoursUsed / b.standardWeeklyHoursAvailable) * 100
        : null;

      // Building-level seat status mirrors room-level's three-way split,
      // plus 'partial' (some rooms computed, some not -- the average is
      // real but incomplete) and 'mixed-unresolved' (no rooms computed at
      // all, but for two different unresolved reasons) so a caller can
      // render exactly what's missing instead of one opaque "no data".
      let seatUtilizationStatus;
      let seatUtilizationPct = null;
      const hasUnresolved = b.seatPendingEnrollmentCount > 0 || b.seatCapacityUnknownCount > 0;
      if (b.seatComputedRoomCount > 0) {
        seatUtilizationStatus = hasUnresolved ? 'partial' : 'computed';
        seatUtilizationPct = seatWeightTotal > 0 ? seatWeightedSum / seatWeightTotal : null;
      } else if (b.seatPendingEnrollmentCount > 0 && b.seatCapacityUnknownCount > 0) {
        seatUtilizationStatus = 'mixed-unresolved';
      } else if (b.seatPendingEnrollmentCount > 0) {
        seatUtilizationStatus = 'pending-enrollment';
      } else if (b.seatCapacityUnknownCount > 0) {
        seatUtilizationStatus = 'capacity-unknown';
      } else {
        seatUtilizationStatus = 'no-data';
      }

      return {
        building: b.building,
        roomCount: roomKeys.size,
        weeklyHoursUsed: b.weeklyHoursUsed,
        standardWeeklyHoursAvailable: b.standardWeeklyHoursAvailable,
        timeUtilizationPct,
        seatUtilizationPct,
        seatUtilizationStatus,
        seatComputedRoomCount: b.seatComputedRoomCount,
        seatPendingEnrollmentCount: b.seatPendingEnrollmentCount,
        seatCapacityUnknownCount: b.seatCapacityUnknownCount
      };
    })
    .sort((a, b) => a.building.localeCompare(b.building));

  return { currentTerm, buildings, unmatchedMeetings };
}
