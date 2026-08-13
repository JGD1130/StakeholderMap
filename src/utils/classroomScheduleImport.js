// src/utils/classroomScheduleImport.js
//
// Classroom Utilization module (Hastings-only). Isolated helper for the
// "Import Schedule" build step -- turns a raw /class-schedule payload into
// courseMeetings-shaped docs (see classroomUtilizationSchema.js). Framework-
// agnostic (no Firestore imports) so it can be unit-tested and reused as-is;
// ClassroomUtilizationPanel.jsx owns the actual fetch call site and Firestore
// writes.
//
// The cross-tally dedup below is a direct, unmodified port of the grouping
// key and merge logic already proven in StakeholderMap.jsx's Ask Mapfluence
// payload builder (search `scheduleGroups` there) -- same key composition,
// same courseCode/title join-with-"/" behavior. Kept as a standalone copy
// here rather than importing from StakeholderMap.jsx because that logic is
// inline in a component closure, not an exported function, and this build
// step is scoped to new, isolated files only.

const DEFAULT_PUBLIC_AI_BASE_URL = 'https://github-stakeholder-ai.onrender.com';

// Mirrors StakeholderMap.jsx's getAiBaseUrl()/resolveAiUrl() resolution order
// for this one endpoint: explicit env override, then the known production AI
// host on GitHub Pages, then a bare relative path (dev proxy handles /ai/*).
export function resolveClassScheduleUrl() {
  const envBase = (import.meta.env.VITE_AI_BASE_URL || '').trim();
  if (envBase) return `${envBase.replace(/\/$/, '')}/class-schedule`;
  if (typeof window !== 'undefined' && window.location.hostname.includes('github.io')) {
    return `${DEFAULT_PUBLIC_AI_BASE_URL}/class-schedule`;
  }
  return '/ai/class-schedule';
}

export async function fetchClassScheduleRows({ timeoutMs = 20000 } = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(resolveClassScheduleUrl(), {
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
  return Array.isArray(json.rows) ? json.rows : [];
}

// Direct port of StakeholderMap.jsx's cross-tally merge (same grouping key,
// same courseCode/title join behavior). See file header.
//
// scheduleGroupKeyParts() is the single source of truth for "what makes two
// raw rows the same meeting" -- used both to group rows here AND to build
// each deduped entry's Firestore doc id below (buildCourseMeetingId). A
// prior version of buildCourseMeetingId re-listed a *different* field set
// (building+room+courseCode+day+time, no instructor) instead of reusing this
// one, which let two distinct meetings that only differ by instructor (e.g.
// two different "Special Topics" sections sharing a generic catalog code,
// same room/day/time) collide onto the same doc id and silently overwrite
// each other on import. Deriving the id directly from these same parts makes
// that class of bug structurally impossible to reintroduce.
function scheduleGroupKeyParts(entry) {
  return [
    String(entry?.building || '').trim().toLowerCase(),
    String(entry?.room || '').trim().toLowerCase(),
    String(entry?.daysText || '').trim().toUpperCase(),
    entry?.startMinutes,
    entry?.endMinutes,
    String(entry?.instructor || '').trim().toLowerCase()
  ];
}

export function dedupeCrossTalliedScheduleRows(rows) {
  const groups = new Map();
  (Array.isArray(rows) ? rows : []).forEach((entry) => {
    const key = scheduleGroupKeyParts(entry).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });
  return Array.from(groups.values()).map((group) => {
    const courseCodes = Array.from(new Set(
      group.map((entry) => String(entry?.courseCode || '').trim()).filter(Boolean)
    ));
    const titles = Array.from(new Set(
      group.map((entry) => String(entry?.title || '').trim()).filter(Boolean)
    ));
    return {
      ...group[0],
      courseCode: courseCodes.join('/'),
      title: titles.join('/')
    };
  });
}

function slugPart(value) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'x';
}

// Deterministic so re-running the import updates existing courseMeetings docs
// instead of creating duplicates -- and built from the exact same
// scheduleGroupKeyParts() used to group rows above, not a separately
// maintained field list, so the id can never again drift out of sync with
// what dedup actually considers "the same meeting" (see the comment on
// scheduleGroupKeyParts). A deduped entry still carries the original
// building/room/daysText/startMinutes/endMinutes/instructor from group[0]
// unchanged (only courseCode/title get merged), so calling this on the
// deduped entry reproduces the identical key it was grouped under.
export function buildCourseMeetingId(entry) {
  return scheduleGroupKeyParts(entry).map(slugPart).join('__');
}

// Field-for-field match to CourseMeetingDoc in classroomUtilizationSchema.js,
// minus importedAt (a Firestore serverTimestamp() sentinel -- added by the
// caller, which owns the Firestore import).
export function mapScheduleEntryToCourseMeetingDoc(entry) {
  return {
    building: String(entry?.building || '').trim(),
    room: String(entry?.room || '').trim(),
    courseCode: String(entry?.courseCode || '').trim(),
    section: String(entry?.section || '').trim(),
    title: String(entry?.title || '').trim(),
    instructor: String(entry?.instructor || '').trim(),
    sessionLabel: String(entry?.sessionLabel || '').trim(),
    sessionRaw: String(entry?.sessionRaw || '').trim(),
    dayTokens: Array.isArray(entry?.dayTokens) ? entry.dayTokens.filter(Boolean) : [],
    startMinutes: Number.isFinite(entry?.startMinutes) ? entry.startMinutes : null,
    endMinutes: Number.isFinite(entry?.endMinutes) ? entry.endMinutes : null,
    enrollment: Number.isFinite(Number(entry?.enrollment)) ? Number(entry.enrollment) : '',
    capacity: Number.isFinite(Number(entry?.capacity)) ? Number(entry.capacity) : ''
  };
}
