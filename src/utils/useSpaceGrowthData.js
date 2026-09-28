// src/utils/useSpaceGrowthData.js
//
// Space Growth data hook (admin-only, flag-gated): ONE read each of
// spaceConfig, enrollmentProjections, roomUtilizationMeta and
// spaceConfigDepartmentOverrides, plus the shared Airtable rooms cache.
// Called once in StakeholderMap.jsx and handed to the Space Growth
// Projections sections and the Executive Dashboard, so they read one load and
// one calculation.
//
// No live listeners: every write in the Space Growth sections is followed by
// reloadCollection(name) for the collection it changed, which also refreshes
// the other sections' dropdowns (categories, departments) -- what the old
// per-section onSnapshot listeners were for.
//
// Results are computed for two years: `targetYear` (the Space Growth
// section's selector, default 2036) and always 2036 for the Executive
// Dashboard, so changing the section's year never moves the dashboard.
//
// Office fix (Phase 5.2): the campus calculation gets sfPerFteTarget for a
// category that is genuinely FTE-based (an SF/FTE target and no station
// target), so Office CAN be priced as SF/FTE x campus Total FTE -- whether it
// is depends on spaceGrowthCalc.js's PRICE_OFFICE_IN_CAMPUS_GAP (currently
// false, pending Clark's call on which FTE). The department calculation keeps its existing inputs (no category-
// level sfPerFteTarget -- Office pairs are priced by department overrides
// only), unchanged.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import {
  ENROLLMENT_PROJECTIONS_COLLECTION,
  ROOM_UTILIZATION_META_COLLECTION,
  SPACE_CONFIG_COLLECTION,
  SPACE_CONFIG_DEPARTMENT_OVERRIDES_COLLECTION
} from './classroomUtilizationSchema';
import { fetchAirtableRoomsForUtilization, buildAirtableAreaMap } from './classroomUtilizationCalc';
import {
  computeSpaceGrowth,
  computeDepartmentSpaceGrowth,
  computeHeadlineSpaceGap,
  isHeadlineGapRow,
  PRICE_OFFICE_IN_CAMPUS_GAP
} from './spaceGrowthCalc';
import { computeDivisionSpaceGapSummary, computeInstitutionWideSpaceGapTotal } from './executiveDashboardCalc';
import { printSpaceGrowthReconciliation } from './spaceGrowthReconciliation';

const HASTINGS_UNIVERSITY_ID = 'hastings';
export const SPACE_GROWTH_BASELINE_YEAR = 2026;
export const SPACE_GROWTH_DASHBOARD_YEAR = 2036;

export const SPACE_GROWTH_COLLECTIONS = {
  spaceConfig: SPACE_CONFIG_COLLECTION,
  enrollmentProjections: ENROLLMENT_PROJECTIONS_COLLECTION,
  roomUtilizationMeta: ROOM_UTILIZATION_META_COLLECTION,
  departmentOverrides: SPACE_CONFIG_DEPARTMENT_OVERRIDES_COLLECTION
};
const COLLECTION_NAMES = Object.keys(SPACE_GROWTH_COLLECTIONS);
const EMPTY_RAW = Object.fromEntries(COLLECTION_NAMES.map((name) => [name, []]));

// A getDocs()-shaped view of a raw doc list ({ id, data }), so the sections'
// existing loaders can read hook data with their snap.docs code unchanged.
export function asSnapshot(rawDocs) {
  return { docs: (rawDocs || []).map((d) => ({ id: d.id, data: () => d.data })) };
}

// Keep the previous array when a re-read returns the same documents, so a
// Recalculate elsewhere doesn't make a section rebuild its form (and drop
// unsaved edits) -- sections rebuild only when their data really changed.
function keepIfUnchanged(prev, next) {
  try {
    return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  } catch {
    return next;
  }
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

export function useSpaceGrowthData({ enabled = false, universityId } = {}) {
  const resolvedUniversityId = String(universityId || '').trim() || HASTINGS_UNIVERSITY_ID;

  // 'idle' | 'loading' | 'ready' | 'error'
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [raw, setRaw] = useState(EMPTY_RAW);
  const [airtable, setAirtable] = useState({ rooms: [], error: null, loaded: false });
  const [targetYear, setTargetYear] = useState(SPACE_GROWTH_DASHBOARD_YEAR);
  const requestIdRef = useRef(0);

  const collectionRef = useCallback(
    (name) => collection(db, 'universities', resolvedUniversityId, SPACE_GROWTH_COLLECTIONS[name]),
    [resolvedUniversityId]
  );

  const readCollection = useCallback(async (name) => {
    const snap = await getDocs(collectionRef(name));
    return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
  }, [collectionRef]);

  const loadAirtable = useCallback(async ({ force = false } = {}) => {
    try {
      const rooms = await fetchAirtableRoomsForUtilization({ force });
      setAirtable({ rooms, error: null, loaded: true });
    } catch (err) {
      // Airtable is area-only input (Current SF). Fail soft, same as every
      // other caller: rooms resolve to no area; the error is kept so Room
      // Tagging and the dashboard can say why.
      console.warn('Airtable rooms fetch failed for space growth:', err);
      setAirtable({ rooms: [], error: err, loaded: true });
    }
  }, []);

  // Full load: every collection plus Airtable. forceAirtable: Recalculate.
  // A reload after the first load keeps status 'ready' (refreshing = true) so
  // sections gated on "ready" don't rebuild their forms mid-edit.
  const load = useCallback(async ({ forceAirtable = false } = {}) => {
    const requestId = ++requestIdRef.current;
    setStatus((prev) => (prev === 'ready' ? prev : 'loading'));
    setRefreshing(true);
    setError('');
    try {
      const [lists] = await Promise.all([
        Promise.all(COLLECTION_NAMES.map((name) => readCollection(name))),
        loadAirtable({ force: forceAirtable })
      ]);
      if (requestId !== requestIdRef.current) return;
      setRaw((prev) => Object.fromEntries(COLLECTION_NAMES.map((name, i) => [name, keepIfUnchanged(prev[name], lists[i])])));
      setStatus('ready');
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      console.error('Space Growth: load failed.', err);
      setError(String(err?.message || 'Failed to load space growth data.'));
      setStatus((prev) => (prev === 'ready' ? prev : 'error'));
    } finally {
      if (requestId === requestIdRef.current) setRefreshing(false);
    }
  }, [readCollection, loadAirtable]);

  // After a section saves: re-read just that collection.
  const reloadCollection = useCallback(async (name) => {
    const list = await readCollection(name);
    setRaw((prev) => ({ ...prev, [name]: keepIfUnchanged(prev[name], list) }));
  }, [readCollection]);

  const reload = useCallback((options) => load(options), [load]);

  useEffect(() => {
    if (!enabled) return undefined;
    void load();
    return () => { requestIdRef.current += 1; };
  }, [enabled, load]);

  // --- Calculation inputs --------------------------------------------------
  const inputs = useMemo(() => {
    const spaceConfig = raw.spaceConfig;
    // Department calculation (and the pre-fix campus calculation): station
    // fields only, exactly as both callers built it before.
    const stationSpaceConfigDocs = spaceConfig.map((d) => ({
      category: d.id,
      sfPerStationTarget: d.data.sfPerStationTarget,
      targetUtilizationRate: d.data.targetUtilizationRate
    }));
    // Campus calculation: plus sfPerFteTarget for genuinely FTE-based
    // categories (SF/FTE set, no station target).
    const campusSpaceConfigDocs = spaceConfig.map((d) => {
      const station = positive(d.data.sfPerStationTarget) && positive(d.data.targetUtilizationRate);
      return {
        category: d.id,
        sfPerStationTarget: d.data.sfPerStationTarget,
        targetUtilizationRate: d.data.targetUtilizationRate,
        sfPerFteTarget: !station && positive(d.data.sfPerFteTarget) ? d.data.sfPerFteTarget : undefined
      };
    });
    return {
      stationSpaceConfigDocs,
      campusSpaceConfigDocs,
      // FTE-based categories (e.g. Office): inventory only in the headline.
      officeCategories: campusSpaceConfigDocs.filter((d) => d.sfPerFteTarget !== undefined).map((d) => d.category),
      roomUtilizationMetaDocs: raw.roomUtilizationMeta.map((d) => ({ roomKey: d.id, ...d.data })),
      enrollmentProjectionDocs: raw.enrollmentProjections.map((d) => d.data),
      departmentOverrideDocs: raw.departmentOverrides.map((d) => d.data),
      airtableAreaByRoomKey: buildAirtableAreaMap(airtable.rooms)
    };
  }, [raw, airtable.rooms]);

  const computeForYear = useCallback((year) => {
    const common = {
      roomUtilizationMetaDocs: inputs.roomUtilizationMetaDocs,
      airtableAreaByRoomKey: inputs.airtableAreaByRoomKey,
      baselineYear: SPACE_GROWTH_BASELINE_YEAR,
      targetYear: year,
      enrollmentProjectionDocs: inputs.enrollmentProjectionDocs
    };
    const institution = computeSpaceGrowth({ ...common, spaceConfigDocs: inputs.campusSpaceConfigDocs });
    const department = computeDepartmentSpaceGrowth({
      ...common,
      spaceConfigDocs: inputs.stationSpaceConfigDocs,
      departmentOverrideDocs: inputs.departmentOverrideDocs
    });
    return {
      institution,
      department,
      // Old campus method -- kept as a comparison, no longer the headline.
      institutionGap: computeInstitutionWideSpaceGapTotal(institution.rows),
      // Every department row (Office included) -- the dev reconciliation's
      // division total.
      divisions: computeDivisionSpaceGapSummary({
        departmentRows: department.rows,
        enrollmentProjectionDocs: inputs.enrollmentProjectionDocs
      }),
      // Headline (Phase 5.3): department method, Classroom + Lab only, and
      // the division split of exactly those rows, so the dashboard's KPI and
      // Space Gap by Division chart agree.
      headline: computeHeadlineSpaceGap({
        departmentRows: department.rows,
        institutionRows: institution.rows,
        officeCategories: inputs.officeCategories
      }),
      headlineDivisions: computeDivisionSpaceGapSummary({
        departmentRows: department.rows.filter(isHeadlineGapRow),
        enrollmentProjectionDocs: inputs.enrollmentProjectionDocs
      })
    };
  }, [inputs]);

  const ready = status === 'ready';
  const results = useMemo(() => (ready ? computeForYear(targetYear) : null), [ready, computeForYear, targetYear]);
  const dashboardResults = useMemo(
    () => (ready ? computeForYear(SPACE_GROWTH_DASHBOARD_YEAR) : null),
    [ready, computeForYear]
  );

  // TEMPORARY (Phase 5.2 investigation, dev builds only) -- REMOVE with
  // spaceGrowthReconciliation.js once the campus vs. division gap is
  // understood. Prints once per distinct result, for 2036.
  const lastPrintRef = useRef('');
  useEffect(() => {
    if (!import.meta.env.DEV || !dashboardResults || !airtable.loaded) return;
    const printCommon = {
      spaceConfigDocs: inputs.campusSpaceConfigDocs,
      roomUtilizationMetaDocs: inputs.roomUtilizationMetaDocs,
      airtableAreaByRoomKey: inputs.airtableAreaByRoomKey,
      baselineYear: SPACE_GROWTH_BASELINE_YEAR,
      targetYear: SPACE_GROWTH_DASHBOARD_YEAR,
      enrollmentProjectionDocs: inputs.enrollmentProjectionDocs
    };
    // Both sides of the Office fix, whatever PRICE_OFFICE_IN_CAMPUS_GAP is set to.
    const campusBefore = computeSpaceGrowth({ ...printCommon, priceFteCategories: false });
    const campusAfter = computeSpaceGrowth({ ...printCommon, priceFteCategories: true });
    const signature = JSON.stringify([
      dashboardResults.institutionGap,
      dashboardResults.headline.totalGapTarget,
      dashboardResults.divisions.map((d) => d.gapTarget)
    ]);
    if (signature === lastPrintRef.current) return;
    lastPrintRef.current = signature;
    printSpaceGrowthReconciliation({
      targetYear: SPACE_GROWTH_DASHBOARD_YEAR,
      campusBefore,
      campusAfter,
      // The campus figure actually shown (section and dashboard) -- the one
      // part c reconciles against the division total.
      campusLive: dashboardResults.institution,
      officePricedLive: PRICE_OFFICE_IN_CAMPUS_GAP,
      department: dashboardResults.department,
      divisions: dashboardResults.divisions,
      headline: dashboardResults.headline,
      headlineDivisions: dashboardResults.headlineDivisions,
      roomUtilizationMetaDocs: inputs.roomUtilizationMetaDocs,
      airtableAreaByRoomKey: inputs.airtableAreaByRoomKey,
      enrollmentProjectionDocs: inputs.enrollmentProjectionDocs
    });
  }, [dashboardResults, inputs, airtable.loaded]);

  return {
    status,
    refreshing,
    error,
    universityId: resolvedUniversityId,
    collectionRef,
    raw,
    airtableRooms: airtable.rooms,
    airtableError: airtable.error,
    airtableLoaded: airtable.loaded,
    targetYear,
    setTargetYear,
    baselineYear: SPACE_GROWTH_BASELINE_YEAR,
    results,
    dashboardResults,
    reload,
    reloadCollection
  };
}
