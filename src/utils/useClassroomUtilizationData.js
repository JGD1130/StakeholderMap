// src/utils/useClassroomUtilizationData.js
//
// Classroom Utilization data hook (admin-only, flag-gated): ONE read of
// courseMeetings + terms and ONE Airtable rooms fetch, feeding every results
// section of ClassroomUtilizationPanel (Utilization Results, Day/Time Heat
// Map, Size Range). Before this, each of those sections fetched the same
// three sources on its own on mount. Called once in StakeholderMap.jsx and
// handed to the panel as a prop, same convention as useResearchSpaceData.
//
// Pure data plumbing -- every number still comes from the unchanged
// functions in classroomUtilizationCalc.js.
//
//   reload()      -- re-read courseMeetings + terms from Firestore and
//                    recompute, reusing the Airtable rooms already fetched.
//                    Called after Save Terms / Import Schedule, which only
//                    ever write Firestore.
//   recalculate() -- full refresh: Firestore AND Airtable, then recompute.
//                    Matches what each section's own Recalculate button used
//                    to do (it re-fetched all three sources).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import { COURSE_MEETINGS_COLLECTION, TERMS_COLLECTION } from './classroomUtilizationSchema';
import {
  computeClassroomUtilization,
  computeCampusUtilizationByTerm,
  computeDayTimeHeatmapByTerm,
  computeSizeRangeUtilizationByTerm,
  countMeetingsOutsideHeatmapByTerm,
  fetchAirtableRoomsForUtilization,
  resolveCurrentTerm
} from './classroomUtilizationCalc';

const HASTINGS_UNIVERSITY_ID = 'hastings';
const AIRTABLE_TIMEOUT_MS = 60000;

function computeAll({ courseMeetingDocs, termDocs, airtableRooms }) {
  const classroom = computeClassroomUtilization({ courseMeetingDocs, termDocs, airtableRooms });
  const { campusRollups } = computeCampusUtilizationByTerm(classroom.rooms);
  const { heatmaps } = computeDayTimeHeatmapByTerm({ courseMeetingDocs, termDocs });
  const { sizeRangeTables } = computeSizeRangeUtilizationByTerm({ courseMeetingDocs, termDocs, airtableRooms });
  const outsideHeatmapCountByTerm = countMeetingsOutsideHeatmapByTerm({ courseMeetingDocs, termDocs });
  return {
    rooms: classroom.rooms,
    buildingSummary: classroom.buildingSummary,
    unmatchedMeetings: classroom.unmatchedMeetings,
    campusRollups,
    heatmaps,
    sizeRangeTables,
    outsideHeatmapCountByTerm
  };
}

// Imported meeting count and distinct building+room count, for Setup's
// Class schedule card (moved here from the panel's old Import Schedule
// section, which read courseMeetings a second time just for this).
function summarizeMeetings(docs) {
  const rooms = new Set();
  docs.forEach((data) => {
    const building = String(data?.building || '').trim().toLowerCase();
    const room = String(data?.room || '').trim().toLowerCase();
    if (building || room) rooms.add(`${building}||${room}`);
  });
  return { meetingCount: docs.length, roomCount: rooms.size };
}

// termId -> { rooms, campusRollup, heatmap, sizeRangeTable, outsideHeatmapCount } -- the same
// all-terms results above, just regrouped. buildingSummary and
// unmatchedMeetings aren't per-term (the first sums across terms, the
// second has no term by definition), so they stay on `results` only.
function groupResultsByTerm(results) {
  const byTerm = {};
  const entry = (termId) => {
    if (!byTerm[termId]) {
      byTerm[termId] = { rooms: [], campusRollup: null, heatmap: null, sizeRangeTable: null, outsideHeatmapCount: 0 };
    }
    return byTerm[termId];
  };
  results.rooms.forEach((r) => entry(r.termId).rooms.push(r));
  results.campusRollups.forEach((c) => { entry(c.termId).campusRollup = c; });
  results.heatmaps.forEach((h) => { entry(h.termId).heatmap = h; });
  results.sizeRangeTables.forEach((t) => { entry(t.termId).sizeRangeTable = t; });
  Object.entries(results.outsideHeatmapCountByTerm || {}).forEach(([termId, count]) => {
    if (byTerm[termId]) byTerm[termId].outsideHeatmapCount = count;
  });
  return byTerm;
}

function termStartTime(termDoc) {
  const start = termDoc?.data?.startDate?.toDate ? termDoc.data.startDate.toDate() : null;
  return start instanceof Date && !Number.isNaN(start.getTime()) ? start.getTime() : null;
}

// The current term if it has scheduled classes. Otherwise, among terms that
// do: the latest one that has already started; failing that, the soonest
// upcoming one; and for terms with no start date, the last by termId.
function pickDefaultTermId({ termDocs, resultsByTerm, currentTermId, now = new Date() }) {
  const hasClasses = (termId) => Boolean(resultsByTerm[termId]?.rooms?.length);
  if (currentTermId && hasClasses(currentTermId)) return currentTermId;

  const withClasses = termDocs.filter((t) => hasClasses(t.id));
  if (!withClasses.length) return currentTermId ?? null;

  const nowTime = now.getTime();
  const dated = withClasses.map((t) => ({ id: t.id, start: termStartTime(t) })).filter((t) => t.start != null);
  const started = dated.filter((t) => t.start <= nowTime).sort((a, b) => b.start - a.start);
  if (started.length) return started[0].id;
  const upcoming = dated.sort((a, b) => a.start - b.start);
  if (upcoming.length) return upcoming[0].id;
  return withClasses.map((t) => t.id).sort((a, b) => b.localeCompare(a))[0];
}

export function useClassroomUtilizationData({ enabled = false, universityId } = {}) {
  const resolvedUniversityId = String(universityId || '').trim() || HASTINGS_UNIVERSITY_ID;

  // 'idle' | 'loading' | 'ready' | 'error'
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [termDocs, setTermDocs] = useState([]);
  const [results, setResults] = useState(null);
  const [selectedTermId, setSelectedTermId] = useState(null);

  const airtableRoomsRef = useRef(null); // null = not fetched yet
  const requestIdRef = useRef(0); // latest-wins guard against overlapping loads

  // refetchAirtable: ask for Airtable rooms again rather than reuse this
  // hook's copy. forceAirtable: bypass the page-wide shared rooms cache too
  // (Recalculate) -- otherwise another panel's load is reused.
  const load = useCallback(async ({ refetchAirtable, forceAirtable = false }) => {
    const requestId = ++requestIdRef.current;
    setStatus('loading');
    setError('');
    try {
      const needAirtable = refetchAirtable || airtableRoomsRef.current == null;
      const [meetingsSnap, termsSnap, airtable] = await Promise.all([
        getDocs(collection(db, 'universities', resolvedUniversityId, COURSE_MEETINGS_COLLECTION)),
        getDocs(collection(db, 'universities', resolvedUniversityId, TERMS_COLLECTION)),
        needAirtable
          ? fetchAirtableRoomsForUtilization({ timeoutMs: AIRTABLE_TIMEOUT_MS, force: forceAirtable })
            .then((rooms) => ({ rooms, failed: false }))
            .catch((fetchError) => {
              // Airtable is capacity-only input (Seat Utilization). A failed
              // fetch shouldn't block Time Utilization -- rooms fall back to
              // "capacity unknown", and Setup's Data quality card says why.
              console.warn('Airtable rooms fetch failed for classroom utilization:', fetchError);
              return { rooms: [], failed: true };
            })
          : Promise.resolve(airtableRoomsRef.current)
      ]);
      if (requestId !== requestIdRef.current) return;
      airtableRoomsRef.current = airtable;
      const courseMeetingDocs = meetingsSnap.docs.map((docSnap) => docSnap.data());
      const nextTermDocs = termsSnap.docs.map((docSnap) => ({ id: docSnap.id, data: docSnap.data() }));
      setTermDocs(nextTermDocs);
      setResults({
        ...computeAll({ courseMeetingDocs, termDocs: nextTermDocs, airtableRooms: airtable.rooms }),
        scheduleSummary: summarizeMeetings(courseMeetingDocs),
        capacityFetchFailed: airtable.failed
      });
      setStatus('ready');
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(String(loadError?.message || 'Failed to compute classroom utilization.'));
      setStatus('error');
    }
  }, [resolvedUniversityId]);

  const reload = useCallback(() => load({ refetchAirtable: false }), [load]);
  const recalculate = useCallback(() => load({ refetchAirtable: true, forceAirtable: true }), [load]);

  useEffect(() => {
    if (!enabled) return undefined;
    void load({ refetchAirtable: true });
    // Invalidate any in-flight load on disable/unmount/university change.
    return () => { requestIdRef.current += 1; };
  }, [enabled, load]);

  const currentTermId = useMemo(() => resolveCurrentTerm(termDocs).termId, [termDocs]);

  const resultsByTerm = useMemo(() => (results ? groupResultsByTerm(results) : {}), [results]);

  // Default selection until someone picks a term: the current term, unless
  // it has no scheduled classes (e.g. an upcoming term entered early) -- then
  // the most recent term that does. currentTermId itself is unchanged, so the
  // picker still marks the true current term "(current)" and it stays
  // selectable.
  const defaultTermId = useMemo(
    () => pickDefaultTermId({ termDocs, resultsByTerm, currentTermId }),
    [termDocs, resultsByTerm, currentTermId]
  );
  const effectiveSelectedTermId = selectedTermId ?? defaultTermId ?? null;

  return {
    status,
    error,
    universityId: resolvedUniversityId,
    terms: termDocs,
    currentTermId: currentTermId ?? null,
    defaultTermId: defaultTermId ?? null,
    selectedTermId: effectiveSelectedTermId,
    setSelectedTermId,
    results,
    resultsByTerm,
    recalculate,
    reload
  };
}
