// src/components/ExecutiveDashboardPanel.jsx
//
// Executive Dashboard -- a standalone, top-level synthesis of Capital Priorities,
// Capital Phasing, Space Growth, and Classroom Utilization. Mounted as its own
// .dashboard-box in StakeholderMap.jsx, gated on isAdminMode && enableCapitalPriorities
// && enableClassroomUtilization (both existing flags, ANDed -- no new config flag,
// since this panel is nothing but a synthesis of exactly those two feature areas; a
// tenant with either one off has no data for this panel to meaningfully summarize).
//
// READ-ONLY, always: this panel never writes to Firestore. It independently re-fetches
// the same four collections/data sources CapitalPrioritiesPanel.jsx and
// ClassroomUtilizationPanel.jsx already read, and calls the exact same already-shipped
// calc functions those panels use (computeSpaceGrowth, computeDepartmentSpaceGrowth,
// computeClassroomUtilization, computeCampusUtilizationByTerm, resolveCurrentTerm) --
// nothing in this file modifies any of those functions or any other panel's logic.
// executiveDashboardCalc.js adds only new, additive aggregation on top of their output.
//
// Capital Priorities' "budget vs. need" is deliberately NOT shown as a funded/deferred
// split -- see executiveDashboardCalc.js's header comment: that split in
// CapitalPrioritiesPanel.jsx depends on a local-only, non-persisted UI slider that
// defaults to "everything funded," so reproducing it here would show a fabricated
// number, not a real decision. Only Tier 1 count + total known cost are shown.
//
// Same "flag visibly, never a blank/broken section" philosophy as every other module
// in this codebase: a section with no underlying data (no terms configured, no capital
// phasing uploaded yet, etc.) renders a clear, specific message instead of an empty or
// silently-wrong area.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pdf } from '@react-pdf/renderer';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import {
  SPACE_CONFIG_COLLECTION,
  TERMS_COLLECTION,
  ROOM_UTILIZATION_META_COLLECTION,
  COURSE_MEETINGS_COLLECTION,
  ENROLLMENT_PROJECTIONS_COLLECTION,
  SPACE_CONFIG_DEPARTMENT_OVERRIDES_COLLECTION
} from '../utils/classroomUtilizationSchema';
import {
  computeClassroomUtilization,
  computeCampusUtilizationByTerm,
  resolveCurrentTerm,
  fetchAirtableRoomsForUtilization,
  buildAirtableAreaMap
} from '../utils/classroomUtilizationCalc';
import { computeSpaceGrowth, computeDepartmentSpaceGrowth } from '../utils/spaceGrowthCalc';
import {
  computeTier1CapitalSummary,
  computeNearTermCapitalPhasing,
  computeDivisionSpaceGapSummary,
  computeInstitutionWideSpaceGapTotal,
  formatTier1CapitalNeed,
  formatGapSf
} from '../utils/executiveDashboardCalc';
import ExecutiveDashboardPdfDocument from './ExecutiveDashboardPdfDocument.jsx';
import ExecutiveDashboardModal from './ExecutiveDashboardModal.jsx';

// Mirrors ClassroomUtilizationPanel.jsx's SpaceGrowthSection constants exactly (not
// exported from that file, so duplicated here per this codebase's existing isolation
// convention -- see classroomUtilizationCalc.js's header comment for the same pattern).
// SPACE_GROWTH_TARGET_YEAR uses that section's own default (the last of its 10
// selectable target years) rather than inventing a different one for this dashboard.
const BASELINE_ENROLLMENT_YEAR = 2026;
const SPACE_GROWTH_TARGET_YEAR = 2036;

// Same near-term window computeNearTermCapitalPhasing defaults to -- named here so the
// UI copy ("next ~2 years") and the calc call always agree.
const CAPITAL_PHASING_HORIZON_MONTHS = 24;

// Sampled directly from public/Data/Clark_Enersen_Logo.png's ampersand fill
// (a palette-indexed PNG, decoded pixel-by-pixel rather than eyeballed off
// the rendered preview -- #f75024 was the dominant exact hex among the
// logo's orange-ish pixels by a wide margin, 88 px vs. the next-closest
// variant's 33, the rest being anti-aliasing blends against the dark
// background). Same isolation convention as this file's other small
// constants -- duplicated identically in CapitalPrioritiesPanel.jsx and
// ClassroomUtilizationPanel.jsx's header bars, not imported from a shared
// location. Darkened ~18% (uniform RGB scale) from the sampled #f75024 for
// header-bar contrast -- same darkened value duplicated in
// CapitalPrioritiesPanel.jsx and ClassroomUtilizationPanel.jsx.
const CLARK_ENERSEN_ORANGE = '#cb421e';

export default function ExecutiveDashboardPanel({
  universityId,
  enabled = false,
  getBuildingResourceEntry = null
}) {
  const normalizedUniversityId = String(universityId || '').trim();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [data, setData] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const capitalPrioritiesCollection = useMemo(
    () => collection(db, 'universities', normalizedUniversityId, 'capitalPriorities'),
    [normalizedUniversityId]
  );
  const capitalPhasingCollection = useMemo(
    () => collection(db, 'universities', normalizedUniversityId, 'capitalPhasingProjects'),
    [normalizedUniversityId]
  );
  const spaceConfigCollection = useMemo(
    () => collection(db, 'universities', normalizedUniversityId, SPACE_CONFIG_COLLECTION),
    [normalizedUniversityId]
  );
  const roomUtilizationMetaCollection = useMemo(
    () => collection(db, 'universities', normalizedUniversityId, ROOM_UTILIZATION_META_COLLECTION),
    [normalizedUniversityId]
  );
  const enrollmentProjectionsCollection = useMemo(
    () => collection(db, 'universities', normalizedUniversityId, ENROLLMENT_PROJECTIONS_COLLECTION),
    [normalizedUniversityId]
  );
  const departmentOverridesCollection = useMemo(
    () => collection(db, 'universities', normalizedUniversityId, SPACE_CONFIG_DEPARTMENT_OVERRIDES_COLLECTION),
    [normalizedUniversityId]
  );
  const courseMeetingsCollection = useMemo(
    () => collection(db, 'universities', normalizedUniversityId, COURSE_MEETINGS_COLLECTION),
    [normalizedUniversityId]
  );
  const termsCollection = useMemo(
    () => collection(db, 'universities', normalizedUniversityId, TERMS_COLLECTION),
    [normalizedUniversityId]
  );

  // Latest-run-wins guard. runCalculation re-runs whenever
  // getBuildingResourceEntry changes -- notably when building-resources.json
  // finishes loading, a moment after the first run already started against an
  // empty catalog (every Tier 1 cost unresolved). Both runs await the same slow
  // Airtable fetch, so the stale first run could finish last and overwrite the
  // correct result. Only the newest run may write state.
  const runIdRef = useRef(0);

  const runCalculation = useCallback(async () => {
    const runId = ++runIdRef.current;
    const isStale = () => runId !== runIdRef.current;
    if (!enabled || !normalizedUniversityId) {
      setData(null);
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      // Confirmed root cause, 2026-09-15: on this dashboard's actual first
      // production load, the Airtable fetch's default 20s timeout
      // (classroomUtilizationCalc.js's fetchAirtableRoomsForUtilization)
      // hit a cold start on the AI server's Render free-tier instance
      // (commonly 30-50s+ to wake from idle) -- the fetch aborted, fell
      // through the fail-soft .catch below, and every per-room Airtable
      // area lookup came back unresolvable, which silently emptied the
      // Space Gap by Division chart (see that card's own comment/
      // airtableFetchFailed below) while every other section, which
      // doesn't require per-room Airtable resolution, still rendered
      // normally -- confirmed by Clark: a manual Recalculate immediately
      // after (server now warm) fixed it with no code change. 60s gives
      // real margin over a cold start instead of just hoping the server
      // happens to already be warm, which board-facing use can't assume.
      let airtableFetchFailed = false;
      const [
        capitalPrioritiesSnap,
        capitalPhasingSnap,
        spaceConfigSnap,
        roomMetaSnap,
        enrollmentSnap,
        departmentOverridesSnap,
        courseMeetingsSnap,
        termsSnap,
        airtableRooms
      ] = await Promise.all([
        getDocs(capitalPrioritiesCollection),
        getDocs(capitalPhasingCollection),
        getDocs(spaceConfigCollection),
        getDocs(roomUtilizationMetaCollection),
        getDocs(enrollmentProjectionsCollection),
        getDocs(departmentOverridesCollection),
        getDocs(courseMeetingsCollection),
        getDocs(termsCollection),
        // Airtable is capacity/area-only input for two of the four sections below.
        // A failed fetch shouldn't block the other sections from computing -- same
        // fail-soft convention every other Airtable call site in this codebase uses.
        // airtableFetchFailed (closure var, safe: this .catch always resolves
        // before Promise.all does, single-threaded JS, no race) lets the Space
        // Gap card below distinguish "fetch actually failed" from "genuinely
        // zero gaps" instead of showing the same generic empty state for both.
        fetchAirtableRoomsForUtilization({ timeoutMs: 60000 }).catch((error) => {
          console.warn('Airtable rooms fetch failed for Executive Dashboard:', error);
          airtableFetchFailed = true;
          return [];
        })
      ]);

      const capitalPriorityDocs = capitalPrioritiesSnap.docs.map((d) => ({ buildingId: d.id, ...(d.data() || {}) }));
      const capitalPhasingDocs = capitalPhasingSnap.docs.map((d) => ({ projectId: d.id, ...(d.data() || {}) }));
      // Deliberately mirrors ClassroomUtilizationPanel.jsx's own spaceConfigDocs
      // mapping EXACTLY (no sfPerFteTarget field) -- an earlier version of this
      // mapping included it and broke the Space Gap chart below. Root cause:
      // SpaceConfigSection preserves a category's inactive-formula field across
      // formula-type flips (never clears it, by design -- see the 2026-08-26
      // "suggestionAppliedFormulaTypeRef" fix in HANDOFF.md), so a
      // Classroom/Lab category can carry a stale, never-actually-used
      // sfPerFteTarget value from earlier testing. computeDepartmentSpaceGrowth
      // checks sfPerFteTarget FIRST as a category-level fallback (for any
      // department pair with no override doc) -- a stray positive value there
      // silently forces those rows onto the FTE formula branch, which needs a
      // totalFte figure teaching departments never have, producing
      // gapTarget: null for every such row and emptying this dashboard's Space
      // Gap chart. The proven-working "By Department" table never reads this
      // field into spaceConfigDocs at all, so it never hits this path.
      const spaceConfigDocs = spaceConfigSnap.docs.map((d) => ({
        category: d.id,
        sfPerStationTarget: d.data()?.sfPerStationTarget,
        targetUtilizationRate: d.data()?.targetUtilizationRate
      }));
      const roomUtilizationMetaDocs = roomMetaSnap.docs.map((d) => ({ roomKey: d.id, ...(d.data() || {}) }));
      const enrollmentProjectionDocs = enrollmentSnap.docs.map((d) => d.data());
      const departmentOverrideDocs = departmentOverridesSnap.docs.map((d) => d.data());
      const courseMeetingDocs = courseMeetingsSnap.docs.map((d) => d.data());
      const termDocs = termsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));

      const airtableAreaByRoomKey = buildAirtableAreaMap(airtableRooms);

      if (isStale()) return;

      const tier1Summary = computeTier1CapitalSummary({ capitalPriorityDocs, getBuildingResourceEntry });
      // Diagnostic trace of every Tier 1 cost input (Chrome: enable "Verbose"
      // to see console.debug). Read-only.
      console.debug('Executive Dashboard: Tier 1 cost inputs', tier1Summary.tier1Buildings.map((b) => {
        const deferred = typeof getBuildingResourceEntry === 'function'
          ? getBuildingResourceEntry(b.originalId)?.deferredMaintenance
          : undefined;
        return {
          buildingId: b.buildingId,
          originalId: b.originalId,
          score: b.total,
          catalogEntryFound: deferred !== undefined,
          totalCost: deferred?.totalCost,
          totalCostType: typeof deferred?.totalCost,
          totalHigh: deferred?.totalHigh,
          totalLow: deferred?.totalLow,
          resolvedCost: b.resolvedCost
        };
      }));
      const phasingSummary = computeNearTermCapitalPhasing({
        capitalPhasingDocs,
        now: new Date(),
        horizonMonths: CAPITAL_PHASING_HORIZON_MONTHS
      });

      const institutionSpace = computeSpaceGrowth({
        spaceConfigDocs,
        roomUtilizationMetaDocs,
        airtableAreaByRoomKey,
        baselineYear: BASELINE_ENROLLMENT_YEAR,
        targetYear: SPACE_GROWTH_TARGET_YEAR,
        enrollmentProjectionDocs
      });
      const departmentSpace = computeDepartmentSpaceGrowth({
        spaceConfigDocs,
        roomUtilizationMetaDocs,
        airtableAreaByRoomKey,
        baselineYear: BASELINE_ENROLLMENT_YEAR,
        targetYear: SPACE_GROWTH_TARGET_YEAR,
        enrollmentProjectionDocs,
        departmentOverrideDocs
      });
      const institutionGap = computeInstitutionWideSpaceGapTotal(institutionSpace.rows);
      const spaceGapBuckets = computeDivisionSpaceGapSummary({
        departmentRows: departmentSpace.rows,
        enrollmentProjectionDocs
      });

      const classroomResult = computeClassroomUtilization({ courseMeetingDocs, termDocs, airtableRooms });
      const campusRollups = computeCampusUtilizationByTerm(classroomResult.rooms).campusRollups;
      const currentTerm = resolveCurrentTerm(termDocs);

      setData({
        tier1Summary,
        phasingSummary,
        institutionGap,
        spaceGapBuckets,
        // Surfaced so SpaceGapCard (ExecutiveDashboardModal.jsx) can show a
        // specific "data didn't load, try Recalculate" message instead of
        // the generic "no gaps" one when spaceGapBuckets is empty because
        // the Airtable fetch actually failed (see the fetch's own comment
        // above) -- a real fetch failure and a genuine zero-division result
        // both produce an empty spaceGapBuckets array, and only this flag
        // tells them apart.
        airtableFetchFailed,
        targetYear: SPACE_GROWTH_TARGET_YEAR,
        campusRollups,
        currentTerm,
        hasAnyCapitalPriorities: capitalPriorityDocs.length > 0,
        hasAnyCapitalPhasing: capitalPhasingDocs.length > 0,
        hasAnySpaceConfig: spaceConfigDocs.length > 0
      });
    } catch (error) {
      if (isStale()) return;
      console.error('Executive Dashboard: calculation failed.', error);
      setLoadError("Couldn't load dashboard data — try Recalculate.");
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [
    enabled,
    normalizedUniversityId,
    capitalPrioritiesCollection,
    capitalPhasingCollection,
    spaceConfigCollection,
    roomUtilizationMetaCollection,
    enrollmentProjectionsCollection,
    departmentOverridesCollection,
    courseMeetingsCollection,
    termsCollection,
    getBuildingResourceEntry
  ]);

  useEffect(() => {
    void runCalculation();
  }, [runCalculation]);

  const handleExportPdf = useCallback(async () => {
    if (!data) return;
    try {
      // React-PDF renders the document tree into a Blob -- no manual doc.text/doc.rect
      // coordinate math, no ensureSpace()/addPage() bookkeeping. Pagination, section
      // atomicity (wrap={false}), and the three SVG charts all live in
      // ExecutiveDashboardPdfDocument.jsx; this handler only turns that component into
      // a downloadable file, mirroring the filename convention every other export in
      // this codebase already uses.
      const blob = await pdf(<ExecutiveDashboardPdfDocument data={data} />).toBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `executive-dashboard-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Executive Dashboard PDF export failed', err);
      alert('Executive Dashboard PDF export failed — see console for details.');
    }
  }, [data]);

  if (!enabled) return null;

  // Compact teaser only -- two headline numbers (not prose) plus the button
  // that opens the real dashboard. The full KPI-card/gauge/chart layout
  // lives in ExecutiveDashboardModal.jsx, which needs more horizontal room
  // than this rail slot can offer (see the layout-feasibility note in
  // ExecutiveDashboardModal.jsx's header comment).
  const gapValue = data?.institutionGap?.totalGapTarget;
  const gapIsDeficit = gapValue != null && gapValue < 0;
  const tier1Need = formatTier1CapitalNeed(data?.tier1Summary);

  return (
    <div
      className="control-section"
      style={{
        background: '#fff',
        padding: 8,
        border: '1px solid #d8e0ea',
        borderRadius: 6,
        marginTop: 6,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        {/* Clark & Enersen orange, sampled directly from
            public/Data/Clark_Enersen_Logo.png's ampersand fill (a palette-
            indexed PNG decoded pixel-by-pixel, not eyeballed) -- same exact
            hex CapitalPrioritiesPanel.jsx/ClassroomUtilizationPanel.jsx use
            for their own header bars. */}
        <h4 style={{ margin: 0, padding: '6px 8px', fontSize: 12.5, fontWeight: 700, color: '#fff', background: CLARK_ENERSEN_ORANGE, borderRadius: 6, flex: 1 }}>Executive Dashboard</h4>
      </div>

      {loadError ? (
        <div style={{ marginTop: 8, fontSize: 11, color: '#b42318' }}>{loadError}</div>
      ) : null}

      {loading && !data ? (
        <div style={{ marginTop: 8, fontSize: 11, color: '#667085' }}>Calculating…</div>
      ) : data ? (
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, background: '#f8fafc', border: '1px solid #d0d7e2' }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#1d2939' }}>{tier1Need.value}</div>
            <div style={{ fontSize: 9.5, color: '#667085', textTransform: 'uppercase' }}>Tier 1 Need</div>
            {tier1Need.note ? <div style={{ fontSize: 9.5, color: '#667085' }}>{tier1Need.note}</div> : null}
          </div>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              padding: '6px 8px',
              borderRadius: 6,
              background: gapValue == null ? '#f8fafc' : gapIsDeficit ? '#fef3f2' : '#f0fdf4',
              border: `1px solid ${gapValue == null ? '#d0d7e2' : gapIsDeficit ? '#fda29b' : '#86efac'}`
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 800, color: gapValue == null ? '#1d2939' : gapIsDeficit ? '#dc2626' : '#15803d' }}>
              {gapValue != null ? formatGapSf(gapValue) : 'N/A'}
            </div>
            <div style={{ fontSize: 9.5, color: '#667085', textTransform: 'uppercase' }}>Space Gap</div>
          </div>
        </div>
      ) : null}

      <button
        className="btn primary"
        type="button"
        onClick={() => setModalOpen(true)}
        disabled={!data}
        style={{ marginTop: 8 }}
      >
        Open Dashboard
      </button>

      {modalOpen && data ? (
        <ExecutiveDashboardModal
          data={data}
          loading={loading}
          loadError={loadError}
          onRecalculate={() => void runCalculation()}
          onExportPdf={() => void handleExportPdf()}
          onClose={() => setModalOpen(false)}
        />
      ) : null}
    </div>
  );
}
