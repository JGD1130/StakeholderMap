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

// Static, hardcoded industry-standard reference for Time Utilization --
// not fetched from Airtable, Firestore, or anywhere external, per Clark's
// explicit decision. 0-1 scale (matches every other rate constant in this
// codebase, e.g. targetUtilizationRate in classroomUtilizationSchema.js),
// so a display site multiplies by 100 the same way it already does for any
// other computed *Pct value. Single named constant so every place that
// shows "Industry Target: 65%" (Utilization Results table, campus-wide
// summary line, Executive Dashboard gauges) reads from one source instead
// of duplicating the literal 0.65 across files and risking drift.
export const INDUSTRY_TARGET_TIME_UTILIZATION = 0.65;

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
//
// The /ai prefix is a dev-only Vite proxy convention (vite.config.js strips
// it before forwarding to the local ai-server) -- ai-server/server.js itself
// only ever registers the bare route (`app.get("/api/rooms", ...)`), no /ai
// prefix. Once a request leaves the dev proxy and hits the real Render host
// directly (both branches below), that prefix must be stripped or the real
// server 404s ("Cannot GET /ai/api/rooms") -- confirmed live in production,
// silently degrading every capacity-dependent feature since dc27e6d because
// every call site fails soft. Strip logic copied verbatim from
// StakeholderMap.jsx's resolveAiUrl() (not reimplemented) -- that is the
// proven-working version of this exact step; not imported directly since
// StakeholderMap.jsx already imports fetchAirtableRoomsForUtilization from
// this file and resolveAiUrl() isn't exported, so importing it back here
// would be circular.
function stripAiPrefix(path) {
  return path.startsWith('/ai/') ? path.replace(/^\/ai/, '') : path;
}

export function resolveRoomsUrl() {
  const envBase = (import.meta.env.VITE_AI_BASE_URL || '').trim();
  if (envBase) return `${envBase.replace(/\/$/, '')}${stripAiPrefix('/ai/api/rooms')}`;
  if (typeof window !== 'undefined' && window.location.hostname.includes('github.io')) {
    return `${DEFAULT_PUBLIC_AI_BASE_URL}${stripAiPrefix('/ai/api/rooms')}`;
  }
  return '/ai/api/rooms';
}

// A timeout abort surfaces from fetch() as a DOMException whose message is
// the browser's raw "signal is aborted without reason" -- never user-facing
// copy. isAbortError() lets callers recognize it; the fetch helpers below
// rethrow timeouts as an Error with name 'TimeoutError' and a readable message.
export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

export async function fetchWithTimeout(url, init = {}, timeoutMs = 60000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort('timeout'), timeoutMs) : null;
  try {
    return await fetch(url, { ...init, signal: controller ? controller.signal : undefined });
  } catch (error) {
    if (controller?.signal.aborted) {
      const timeoutError = new Error(`AI server did not respond within ${Math.round(timeoutMs / 1000)}s (it may be waking up).`);
      timeoutError.name = 'TimeoutError';
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Default timeout is 60s, not 20s: the AI server runs on Render's free tier,
// which commonly takes 30-50s+ to wake from idle (see ExecutiveDashboardPanel's
// note on its own 60s override). 20s aborted every cold-start page load.
export async function fetchAirtableRoomsForUtilization({ timeoutMs = 60000 } = {}) {
  const res = await fetchWithTimeout(resolveRoomsUrl(), { cache: 'no-store' }, timeoutMs);
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

// --- Campus-wide Time/Seat Utilization rollup, split by term -------------
//
// Board-summary-level aggregation (Recent Changes 2026-09-14 investigation:
// "campus-wide Classroom Utilization" was identified as the one piece Space
// Growth/Capital Priorities/Capital Phasing all already have and this module
// didn't -- no single number anywhere summed Time/Seat Utilization above the
// per-building level). Purely additive: takes computeClassroomUtilization's
// already-computed `rooms` array (room+term grain) as input and aggregates
// it further -- does not call computeClassroomUtilization itself, does not
// re-derive term matching, and does not touch that function's own return
// value. Callers that already hold a `result` from computeClassroomUtilization
// (e.g. UtilizationResultsSection) pass `result.rooms` straight through.
//
// Split by term, never blended -- same convention as computeDayTimeHeatmapByTerm
// and computeSizeRangeUtilizationByTerm: one entry per termId actually present
// in the input rows, so a room used in both Fall 2026 Block 1 and Block 2
// contributes to both terms' rollups independently. "Current term" is not a
// concept this function needs to know about -- a caller that wants just the
// current term's rollup resolves it separately via resolveCurrentTerm(termDocs)
// below and looks up that termId in the returned array, same pattern
// computeBuildingUtilizationForCurrentTerm already established.
//
// Time Utilization: hours-weighted average across every room+term row for
// that term (sum weeklyHoursUsed / sum standardWeeklyHoursAvailable) -- same
// weighting reasoning as computeClassroomUtilization's own buildingSummary
// ("a 40-hr/week room and a 5-hr/week room shouldn't count equally"). Every
// row reaching this function already has a positive standardWeeklyHoursAvailable
// (guaranteed by computeClassroomUtilization's termMatched gate before a row
// can exist at all), so Time Utilization has no "excluded" case of its own --
// totalRoomTermRows below is exactly the room-term row count this average is
// computed over, not a partial count.
//
// Seat Utilization: capacity-weighted average (a 200-seat lecture hall should
// move the campus number more than a 15-seat seminar room), same weighting
// computeBuildingUtilizationForCurrentTerm already uses at building level --
// but ONLY across rows whose own seatUtilizationStatus is 'computed'. Rows
// with 'pending-enrollment' or 'capacity-unknown' are counted and broken out
// by reason, never silently treated as 0% or folded into the average --
// same never-silent, never-a-fabricated-zero philosophy as every other
// function in this module.
export function computeCampusUtilizationByTerm(rooms) {
  const byTerm = new Map(); // termId -> working accumulator

  (Array.isArray(rooms) ? rooms : []).forEach((r) => {
    if (!byTerm.has(r.termId)) {
      byTerm.set(r.termId, {
        termId: r.termId,
        termLabel: r.termLabel,
        weeklyHoursUsed: 0,
        standardWeeklyHoursAvailable: 0,
        totalRoomTermRows: 0,
        seatWeightedSum: 0,
        seatWeightTotal: 0,
        seatComputedRoomCount: 0,
        seatPendingEnrollmentCount: 0,
        seatCapacityUnknownCount: 0
      });
    }
    const acc = byTerm.get(r.termId);
    acc.totalRoomTermRows += 1;
    acc.weeklyHoursUsed += Number(r.weeklyHoursUsed) || 0;
    acc.standardWeeklyHoursAvailable += Number(r.standardWeeklyHoursAvailable) || 0;

    if (r.seatUtilizationStatus === 'computed') {
      acc.seatComputedRoomCount += 1;
      // Capacity is guaranteed present/positive whenever status is
      // 'computed' (see computeClassroomUtilization above) -- the
      // fallback-to-1 here is a defensive floor, not a real code path.
      const weight = Number(r.capacity) > 0 ? Number(r.capacity) : 1;
      acc.seatWeightedSum += r.seatUtilizationPct * weight;
      acc.seatWeightTotal += weight;
    } else if (r.seatUtilizationStatus === 'pending-enrollment') {
      acc.seatPendingEnrollmentCount += 1;
    } else if (r.seatUtilizationStatus === 'capacity-unknown') {
      acc.seatCapacityUnknownCount += 1;
    }
  });

  const campusRollups = Array.from(byTerm.values())
    .map(({ seatWeightedSum, seatWeightTotal, ...acc }) => ({
      termId: acc.termId,
      termLabel: acc.termLabel,
      timeUtilizationPct: acc.standardWeeklyHoursAvailable > 0
        ? (acc.weeklyHoursUsed / acc.standardWeeklyHoursAvailable) * 100
        : null,
      seatUtilizationPct: acc.seatComputedRoomCount > 0 && seatWeightTotal > 0
        ? seatWeightedSum / seatWeightTotal
        : null,
      totalRoomTermRows: acc.totalRoomTermRows,
      seatComputedRoomCount: acc.seatComputedRoomCount,
      seatPendingEnrollmentCount: acc.seatPendingEnrollmentCount,
      seatCapacityUnknownCount: acc.seatCapacityUnknownCount,
      // Convenience sum so a caller/UI doesn't need to re-add the two reason
      // counts itself just to answer "how many rooms were excluded".
      seatExcludedRoomCount: acc.seatPendingEnrollmentCount + acc.seatCapacityUnknownCount
    }))
    .sort((a, b) => a.termId.localeCompare(b.termId));

  return { campusRollups };
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
    return { currentTerm, buildings: [], rooms: [], unmatchedMeetings: [] };
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

  // rooms: the same per-room, per-current-term rows already computed above
  // to build `buildings` (line 535's termRooms) -- exposed as-is, not
  // recomputed, so the room-level popup (StakeholderMap.jsx) can look up a
  // single room's own timeUtilizationPct/seatUtilizationPct/etc without a
  // second Firestore/Airtable read. Purely additive: buildings' aggregation
  // above is unchanged.
  return { currentTerm, buildings, rooms: termRooms, unmatchedMeetings };
}

// --- Day/Time occupancy heat map, split by term --------------------------
//
// From the original Master Facilities Plan spec's hourly Day/Time
// utilization grid (hour rows 7am-9pm, weekday columns, % of classrooms
// occupied per cell) -- a concept present in the original CE Calc spec but
// never built until now. Same courseMeetings fields the rest of this module
// already trusts (dayTokens/startMinutes/endMinutes, already correctly
// parsed/normalized at import time) -- this is a new AGGREGATION over that
// existing data, not a new data source or a new parsing step.
//
// "% of rooms occupied" means percent of the rooms that actually have ANY
// scheduled meeting that term (same posture as computeClassroomUtilization
// above) -- deliberately independent of roomUtilizationMeta space-category
// tagging. A term with 40 scheduled classrooms and 10 occupied at 9am on
// Tuesday shows 25% for that cell, regardless of how many of those 40 rooms
// have been tagged.
//
// Split by term, never blended: uses the exact same termMatched gate as
// computeClassroomUtilization (sessionRaw must resolve to a real terms doc
// with a positive standardWeeklyHours) so a term that has no rows in
// Utilization Results also has no heatmap here -- no silent mismatch
// between the two views of the same data. A room used in both Fall 2026
// Block 1 and Block 2 contributes to BOTH terms' heatmaps independently,
// each against that term's own room universe, never a combined one.
const HEATMAP_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]; // 7 AM - 9 PM, matching the original plan's row range

// Canonical column keys/labels, decoupled from the exact courseMeetings
// dayTokens value(s) that can represent each day. ai-server's
// normalizeScheduleDayTokens (server.js:878-921) produces a different token
// spelling for Tuesday/Thursday depending on which of its two parsing
// branches the raw registrar text hits: dense clusters with no spaces (e.g.
// "TF", "MWR", "MTRF") produce bare 'T' (Tuesday) and bare 'R' (Thursday);
// spaced/verbose text produces 'TU'/'TH' instead. Both forms are real and
// both appear in live data. Monday/Wednesday/Friday have no such ambiguity
// -- 'M'/'W'/'F' are unambiguous single letters in either parsing branch.
//
// Mirrors the exact dual-token handling already established and tested at
// StakeholderMap.jsx:9163-9215 (SCHEDULE_DAY_QUERY_OPTIONS /
// getScheduleDayTokensForDate) -- same convention, not reinvented here. A
// prior version of this file checked only 'TU'/'TH' and silently dropped
// every dense-pattern Tuesday/Thursday meeting (confirmed: a "TF" meeting
// produces dayTokens ['T','F'], and 'T' never matched 'TU').
const HEATMAP_DAY_DEFS = [
  { day: 'M', label: 'Mon', tokens: ['M'] },
  { day: 'T', label: 'Tue', tokens: ['T', 'TU'] },
  { day: 'W', label: 'Wed', tokens: ['W'] },
  { day: 'R', label: 'Thu', tokens: ['R', 'TH'] },
  { day: 'F', label: 'Fri', tokens: ['F'] }
];
const HEATMAP_DAYS = HEATMAP_DAY_DEFS.map((d) => d.day);
const HEATMAP_DAY_LABELS = Object.fromEntries(HEATMAP_DAY_DEFS.map((d) => [d.day, d.label]));

export function formatHeatmapHourLabel(hour) {
  const h12 = hour % 12 || 12;
  const meridiem = hour >= 12 ? 'PM' : 'AM';
  return `${h12} ${meridiem}`;
}

// Single pass over courseMeetingDocs, splitting into per-term heatmaps as it
// goes -- same shape as computeClassroomUtilization's own room+term split,
// not N separate calls for N terms. Each returned entry is scoped to
// exactly one term; nothing is ever blended across terms.
export function computeDayTimeHeatmapByTerm({ courseMeetingDocs, termDocs }) {
  const termsById = new Map(
    (Array.isArray(termDocs) ? termDocs : []).map((t) => [String(t?.id ?? ''), t?.data || {}])
  );

  const roomsByTerm = new Map(); // termId -> Set(roomKey) -- the term's room universe (denominator)
  const occupiedByTerm = new Map(); // termId -> day -> hour -> Set(roomKey)
  const termLabels = new Map(); // termId -> label, same fallback convention as computeClassroomUtilization's agg.termLabel

  (Array.isArray(courseMeetingDocs) ? courseMeetingDocs : []).forEach((meeting) => {
    const building = String(meeting?.building || '').trim();
    const room = String(meeting?.room || '').trim();
    if (!building || !room) return;
    const roomKey = buildRoomUtilizationMetaKey(building, room);
    if (!roomKey) return;

    const termId = deriveTermIdFromSessionRaw(meeting?.sessionRaw);
    const standardWeeklyHours = termId != null ? termsById.get(termId)?.standardWeeklyHours : undefined;
    const termMatched = termId != null && Number.isFinite(Number(standardWeeklyHours)) && Number(standardWeeklyHours) > 0;
    if (!termMatched) return; // same "no term to belong to" exclusion as computeClassroomUtilization

    if (!termLabels.has(termId)) {
      termLabels.set(termId, String(meeting?.sessionLabel || '') || termId);
    }
    if (!roomsByTerm.has(termId)) roomsByTerm.set(termId, new Set());
    roomsByTerm.get(termId).add(roomKey);

    const start = Number(meeting?.startMinutes);
    const end = Number(meeting?.endMinutes);
    const dayTokens = Array.isArray(meeting?.dayTokens) ? meeting.dayTokens.filter(Boolean) : [];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !dayTokens.length) return;

    const relevantDays = HEATMAP_DAY_DEFS
      .filter((def) => def.tokens.some((token) => dayTokens.includes(token)))
      .map((def) => def.day);
    if (!relevantDays.length) return;

    if (!occupiedByTerm.has(termId)) occupiedByTerm.set(termId, new Map());
    const byDay = occupiedByTerm.get(termId);

    relevantDays.forEach((day) => {
      if (!byDay.has(day)) byDay.set(day, new Map());
      const byHour = byDay.get(day);
      HEATMAP_HOURS.forEach((hour) => {
        const hourStart = hour * 60;
        const hourEnd = hourStart + 60;
        // Overlap test: the meeting occupies this hour bucket if its
        // [start, end) range overlaps [hourStart, hourEnd) at all -- a
        // class ending exactly at hourStart doesn't occupy that hour.
        if (start < hourEnd && end > hourStart) {
          if (!byHour.has(hour)) byHour.set(hour, new Set());
          byHour.get(hour).add(roomKey);
        }
      });
    });
  });

  const heatmaps = Array.from(roomsByTerm.entries())
    .map(([termId, roomKeySet]) => {
      const roomCount = roomKeySet.size;
      const byDay = occupiedByTerm.get(termId) || new Map();
      const grid = HEATMAP_DAYS.map((day) => ({
        day,
        dayLabel: HEATMAP_DAY_LABELS[day],
        hours: HEATMAP_HOURS.map((hour) => {
          const occupiedRoomCount = byDay.get(day)?.get(hour)?.size || 0;
          return {
            hour,
            occupiedRoomCount,
            // roomCount is guaranteed > 0 here -- a term only reaches this
            // map at all via roomsByTerm.set(termId, ...) above, which only
            // happens once a real room has been added to its Set.
            pct: (occupiedRoomCount / roomCount) * 100
          };
        })
      }));
      return {
        termId,
        termLabel: termLabels.get(termId) || termId,
        roomCount,
        days: HEATMAP_DAYS,
        dayLabels: HEATMAP_DAY_LABELS,
        hours: HEATMAP_HOURS,
        grid
      };
    })
    .sort((a, b) => a.termId.localeCompare(b.termId));

  return { heatmaps };
}

// --- Classroom Size Range Utilization table, split by term ---------------
//
// From the original Master Facilities Plan spec's classroom-size-range
// table: rooms bucketed into 10-seat capacity increments, with room count,
// times used, aggregated enrollment, total official capacity, and seat
// utilization per bucket. Data table only, per Clark's decision -- no
// "ideal arrangement" recommendation, unlike the original report's fuller
// treatment.
//
// Reuses computeClassroomUtilization's already-computed room+term rows
// wholesale -- same Airtable capacity join (buildAirtableCapacityMap,
// called internally by computeClassroomUtilization), same termMatched
// gate, same enrollment averaging. This function only adds a bucketing
// aggregation on top of those rows; it does not re-derive or duplicate any
// of that logic. Room universe = every room with any scheduled meeting
// that term, independent of roomUtilizationMeta tagging, same posture as
// computeBuildingUtilizationForCurrentTerm/computeDayTimeHeatmapByTerm.
// Split by term, never blended -- computeClassroomUtilization's rows are
// already room+term grain (one row per room per term), so grouping them by
// termId here is sufficient; no separate term-matching logic is needed.
//
// Buckets are computed generically from whatever capacities actually
// appear in the data (1-10, 11-20, 21-30, ... up to the real max), not
// hardcoded to the specific ranges the original 2025 report happened to
// show -- Hastings' current room mix may differ. Every bucket between the
// smallest and largest occupied bucket is included, even ones with zero
// rooms, so the table reads as a complete size distribution rather than
// silently skipping gaps a reader could mistake for missing data.
//
// Rooms whose capacity couldn't be resolved (Airtable has no Seat Count on
// file, or the room never matched an Airtable record at all -- e.g.
// Kiewit's SPC, which has no Airtable counterpart by design) are excluded
// from every bucket rather than guessed into one, and counted separately
// per term so the exclusion is visible, not silent.
function bucketRangeForCapacity(capacity) {
  const index = Math.floor((capacity - 1) / 10);
  const start = (index * 10) + 1;
  const end = start + 9;
  return { index, start, end, label: `${start}-${end}` };
}

export function computeSizeRangeUtilizationByTerm({ courseMeetingDocs, termDocs, airtableRooms }) {
  const { rooms } = computeClassroomUtilization({ courseMeetingDocs, termDocs, airtableRooms });

  // termId -> { termLabel, resolvedRows: [room+term rows with known capacity], unresolvedCapacityRoomCount }
  const byTerm = new Map();
  rooms.forEach((r) => {
    if (!byTerm.has(r.termId)) {
      byTerm.set(r.termId, {
        termId: r.termId,
        termLabel: r.termLabel,
        resolvedRows: [],
        unresolvedCapacityRoomCount: 0
      });
    }
    const entry = byTerm.get(r.termId);
    if (r.capacity == null) {
      entry.unresolvedCapacityRoomCount += 1; // visibly excluded, not dropped or guessed into a bucket
      return;
    }
    entry.resolvedRows.push(r);
  });

  const sizeRangeTables = Array.from(byTerm.values())
    .map(({ termId, termLabel, resolvedRows, unresolvedCapacityRoomCount }) => {
      if (!resolvedRows.length) {
        return { termId, termLabel, unresolvedCapacityRoomCount, buckets: [] };
      }

      const bucketAccByIndex = new Map();
      let minIndex = Infinity;
      let maxIndex = -Infinity;

      resolvedRows.forEach((r) => {
        const { index } = bucketRangeForCapacity(r.capacity);
        minIndex = Math.min(minIndex, index);
        maxIndex = Math.max(maxIndex, index);
        if (!bucketAccByIndex.has(index)) {
          bucketAccByIndex.set(index, {
            roomCount: 0,
            timesUsed: 0,
            totalCapacity: 0,
            seatComputedRoomCount: 0,
            seatPendingEnrollmentCount: 0,
            // Sums across only the seatUtilizationStatus === 'computed' rooms
            // in this bucket -- mirrors computeBuildingUtilizationForCurrentTerm's
            // seatWeightedSum/seatWeightTotal reasoning: a room with unknown
            // enrollment must never silently count as 0 in either the
            // numerator or denominator of the bucket's seat utilization.
            computedEnrollmentSum: 0,
            computedCapacitySum: 0
          });
        }
        const b = bucketAccByIndex.get(index);
        b.roomCount += 1;
        b.timesUsed += r.meetingCount;
        b.totalCapacity += r.capacity;
        if (r.seatUtilizationStatus === 'computed') {
          b.seatComputedRoomCount += 1;
          b.computedEnrollmentSum += r.avgEnrollment;
          b.computedCapacitySum += r.capacity;
        } else {
          // 'pending-enrollment' is the only other status a resolved-capacity
          // row can have here -- 'capacity-unknown' rows never reach
          // resolvedRows at all (excluded into unresolvedCapacityRoomCount
          // above, before bucketing).
          b.seatPendingEnrollmentCount += 1;
        }
      });

      const buckets = [];
      for (let index = minIndex; index <= maxIndex; index += 1) {
        const start = (index * 10) + 1;
        const end = start + 9;
        const label = `${start}-${end}`;
        const b = bucketAccByIndex.get(index);

        if (!b) {
          // A real gap in the size distribution -- zero rooms this size,
          // shown explicitly rather than omitted, per instruction.
          buckets.push({
            label, start, end,
            roomCount: 0,
            timesUsed: 0,
            totalCapacity: 0,
            seatComputedRoomCount: 0,
            seatPendingEnrollmentCount: 0,
            aggregatedEnrollment: null,
            seatUtilizationStatus: 'no-rooms',
            seatUtilizationPct: null
          });
          continue;
        }

        const hasComputed = b.seatComputedRoomCount > 0;
        const seatUtilizationStatus = hasComputed
          ? (b.seatPendingEnrollmentCount > 0 ? 'partial' : 'computed')
          : 'pending-enrollment';

        buckets.push({
          label, start, end,
          roomCount: b.roomCount,
          timesUsed: b.timesUsed,
          totalCapacity: b.totalCapacity,
          seatComputedRoomCount: b.seatComputedRoomCount,
          seatPendingEnrollmentCount: b.seatPendingEnrollmentCount,
          aggregatedEnrollment: hasComputed ? b.computedEnrollmentSum : null,
          seatUtilizationStatus,
          seatUtilizationPct: hasComputed && b.computedCapacitySum > 0
            ? (b.computedEnrollmentSum / b.computedCapacitySum) * 100
            : null
        });
      }

      return { termId, termLabel, unresolvedCapacityRoomCount, buckets };
    })
    .sort((a, b) => a.termId.localeCompare(b.termId));

  return { sizeRangeTables };
}
