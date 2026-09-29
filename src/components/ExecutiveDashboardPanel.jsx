// src/components/ExecutiveDashboardPanel.jsx
//
// Executive Dashboard -- a standalone, top-level synthesis of Capital Priorities,
// Capital Phasing, Space Growth, and Classroom Utilization. Mounted as its own
// .dashboard-box in StakeholderMap.jsx, gated on isAdminMode && enableCapitalPriorities
// && enableClassroomUtilization (both existing flags, ANDed -- no new config flag,
// since this panel is nothing but a synthesis of exactly those two feature areas; a
// tenant with either one off has no data for this panel to meaningfully summarize).
//
// READ-ONLY, always: this panel never writes to Firestore. Capital Compass data (Tier 1
// buildings with live tiers and costs from the one cost rule, and capital phasing) comes
// from the shared useCapitalCompassData hook (`capitalData`, the same object
// CapitalPrioritiesPanel.jsx reads), so saved manual costs show here too. Space Gap
// figures come from the shared useSpaceGrowthData hook (`spaceGrowthData`, the same
// load and 2036 calculation the Space Growth sections read). Classroom data is still
// re-fetched here, and run through the exact same calc functions that panel uses
// (computeClassroomUtilization, computeCampusUtilizationByTerm, resolveCurrentTerm) --
// nothing in this file modifies any of those functions or any other panel's logic.
// executiveDashboardCalc.js adds only new, additive aggregation on top of their output.
//
// Capital Priorities' "budget vs. need" is deliberately NOT shown as a funded/deferred
// split: the budget cap defaults to "everything funded" until someone sets it, so
// showing it here could present a default nobody chose as a decision. Only Tier 1
// count + total known cost are shown.
//
// Same "flag visibly, never a blank/broken section" philosophy as every other module
// in this codebase: a section with no underlying data (no terms configured, no capital
// phasing uploaded yet, etc.) renders a clear, specific message instead of an empty or
// silently-wrong area.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pdf } from '@react-pdf/renderer';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import { TERMS_COLLECTION, COURSE_MEETINGS_COLLECTION } from '../utils/classroomUtilizationSchema';
import {
  computeClassroomUtilization,
  computeSizeRangeUtilizationByTerm,
  computeCampusUtilizationByTerm,
  resolveCurrentTerm,
  fetchAirtableRoomsForUtilization
} from '../utils/classroomUtilizationCalc';
import { SPACE_GROWTH_DASHBOARD_YEAR } from '../utils/useSpaceGrowthData';
import { computeTier1Summary } from '../utils/capitalCompassCalc';
import {
  computeNearTermCapitalPhasing,
  addTimeUtilizationToSizeRanges
} from '../utils/executiveDashboardCalc';
import ExecutiveDashboardPdfDocument from './ExecutiveDashboardPdfDocument.jsx';
import ExecutiveDashboardModal from './ExecutiveDashboardModal.jsx';
import { CE_ORANGE_HEADER } from '../utils/brandColors';
import { MF } from '../theme/mfTokens';
import { KpiCard } from './mf';
import { tier1NeedKpi, spaceGapKpi } from './executiveDashboardView';
import { useCloseWhenPresenting } from './presentationMode';

// Same near-term window computeNearTermCapitalPhasing defaults to -- named here so the
// UI copy ("next ~2 years") and the calc call always agree.
const CAPITAL_PHASING_HORIZON_MONTHS = 24;

// Shared module header color -- see src/utils/brandColors.js.
const CLARK_ENERSEN_ORANGE = CE_ORANGE_HEADER;

export default function ExecutiveDashboardPanel({
  universityId,
  enabled = false,
  // useCapitalCompassData's result (mounted once in StakeholderMap.jsx).
  capitalData = null,
  // useSpaceGrowthData's result (mounted once in StakeholderMap.jsx): the
  // Space Gap figures, always for SPACE_GROWTH_DASHBOARD_YEAR (2036).
  spaceGrowthData = null
}) {
  const normalizedUniversityId = String(universityId || '').trim();
  const [baseLoading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  // Classroom results; Space Growth and Capital Compass parts are merged in below.
  const [baseData, setData] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  useCloseWhenPresenting(() => setModalOpen(false));

  const courseMeetingsCollection = useMemo(
    () => collection(db, 'universities', normalizedUniversityId, COURSE_MEETINGS_COLLECTION),
    [normalizedUniversityId]
  );
  const termsCollection = useMemo(
    () => collection(db, 'universities', normalizedUniversityId, TERMS_COLLECTION),
    [normalizedUniversityId]
  );

  // Latest-run-wins guard: overlapping runs (e.g. Recalculate clicked while the
  // first load is still waiting on the slow Airtable fetch) must not let the
  // older run overwrite the newer result. Only the newest run may write state.
  const runIdRef = useRef(0);

  // forceAirtable (Recalculate): fetch Airtable rooms again instead of reusing
  // the page-wide shared copy.
  const runCalculation = useCallback(async ({ forceAirtable = false } = {}) => {
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
        courseMeetingsSnap,
        termsSnap,
        airtableRooms
      ] = await Promise.all([
        getDocs(courseMeetingsCollection),
        getDocs(termsCollection),
        // Airtable is capacity/area-only input for two of the four sections below.
        // A failed fetch shouldn't block the other sections from computing -- same
        // fail-soft convention every other Airtable call site in this codebase uses.
        // airtableFetchFailed (closure var, safe: this .catch always resolves
        // before Promise.all does, single-threaded JS, no race) lets the Space
        // Gap card below distinguish "fetch actually failed" from "genuinely
        // zero gaps" instead of showing the same generic empty state for both.
        fetchAirtableRoomsForUtilization({ timeoutMs: 60000, force: forceAirtable }).catch((error) => {
          console.warn('Airtable rooms fetch failed for Executive Dashboard:', error);
          airtableFetchFailed = true;
          return [];
        })
      ]);

      // Space Growth inputs (spaceConfig, room tags, enrollment, department
      // targets) and the Space Gap figures now come from useSpaceGrowthData --
      // see spaceSummary below. This run covers classroom utilization only.
      const courseMeetingDocs = courseMeetingsSnap.docs.map((d) => d.data());
      const termDocs = termsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));

      if (isStale()) return;

      const classroomResult = computeClassroomUtilization({ courseMeetingDocs, termDocs, airtableRooms });
      // Room-size breakdown for the dashboard's Utilization by Room Size chart:
      // the Classroom Size Range section's own buckets, plus time utilization.
      const { sizeRangeTables } = computeSizeRangeUtilizationByTerm({ courseMeetingDocs, termDocs, airtableRooms });
      const sizeRangeByTerm = addTimeUtilizationToSizeRanges({ sizeRangeTables, rooms: classroomResult.rooms });
      const campusRollups = computeCampusUtilizationByTerm(classroomResult.rooms).campusRollups;
      const currentTerm = resolveCurrentTerm(termDocs);

      setData({
        // Surfaced so SpaceGapCard (ExecutiveDashboardModal.jsx) can show a
        // specific "data didn't load, try Recalculate" message instead of
        // the generic "no gaps" one when spaceGapBuckets is empty because
        // the Airtable fetch actually failed (see the fetch's own comment
        // above) -- a real fetch failure and a genuine zero-division result
        // both produce an empty spaceGapBuckets array, and only this flag
        // tells them apart.
        airtableFetchFailed,
        campusRollups,
        sizeRangeByTerm,
        currentTerm
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
    courseMeetingsCollection,
    termsCollection
  ]);

  useEffect(() => {
    void runCalculation();
  }, [runCalculation]);

  // Capital Compass parts, from the shared hook: Tier 1 buildings (live tier,
  // one cost rule, saved manual costs) and near-term phasing. Recomputed when
  // the hook's data changes -- no Firestore read here.
  const capitalReady = capitalData?.status === 'ready' || capitalData?.status === 'error';
  const capitalSummary = useMemo(() => {
    if (!capitalReady) return null;
    const buildings = capitalData.buildings || [];
    const phasingDocs = capitalData.phasingDocs || [];
    return {
      tier1Summary: computeTier1Summary(buildings),
      phasingSummary: computeNearTermCapitalPhasing({
        capitalPhasingDocs: phasingDocs,
        now: new Date(),
        horizonMonths: CAPITAL_PHASING_HORIZON_MONTHS
      }),
      hasAnyCapitalPriorities: buildings.length > 0,
      hasAnyCapitalPhasing: phasingDocs.length > 0
    };
  }, [capitalReady, capitalData?.buildings, capitalData?.phasingDocs]);

  // Space Growth parts, from the shared hook's 2036 results -- no Firestore
  // read here. The headline is the department method for Classroom + Lab;
  // Office is inventory only (see spaceGrowthCalc.js computeHeadlineSpaceGap).
  const spaceResults = spaceGrowthData?.dashboardResults || null;
  const spaceSettled = Boolean(spaceResults) || spaceGrowthData?.status === 'error';
  const spaceSummary = useMemo(() => {
    if (!spaceSettled) return null;
    return {
      // Headline (KPI) and the Space Gap by Division chart: department
      // method, Classroom + Lab only -- the same rows, so they agree.
      headlineGap: spaceResults ? spaceResults.headline : null,
      spaceGapBuckets: spaceResults ? spaceResults.headlineDivisions : [],
      // Old campus method -- comparison only, not displayed on the dashboard.
      institutionGap: spaceResults ? spaceResults.institutionGap : null,
      targetYear: SPACE_GROWTH_DASHBOARD_YEAR,
      hasAnySpaceConfig: (spaceGrowthData?.raw?.spaceConfig || []).length > 0,
      spaceAirtableFailed: Boolean(spaceGrowthData?.airtableError)
    };
  }, [spaceSettled, spaceResults, spaceGrowthData?.raw?.spaceConfig, spaceGrowthData?.airtableError]);

  const data = useMemo(() => {
    if (!baseData || !capitalSummary || !spaceSummary) return null;
    const { spaceAirtableFailed, ...space } = spaceSummary;
    return {
      ...baseData,
      ...space,
      ...capitalSummary,
      airtableFetchFailed: baseData.airtableFetchFailed || spaceAirtableFailed
    };
  }, [baseData, capitalSummary, spaceSummary]);
  const loading = baseLoading
    || capitalData?.status === 'loading'
    || spaceGrowthData?.status === 'loading'
    || Boolean(spaceGrowthData?.refreshing);

  const handleRecalculate = useCallback(() => {
    void runCalculation({ forceAirtable: true });
    void capitalData?.reload?.();
    void spaceGrowthData?.reload?.({ forceAirtable: true });
  }, [runCalculation, capitalData, spaceGrowthData]);

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
  // Same values as the dashboard's KPI row (executiveDashboardView.js).
  const tier1Need = data ? tier1NeedKpi(data) : null;
  const spaceGap = data ? spaceGapKpi(data) : null;

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
          {[tier1Need, spaceGap].map(({ key, ...props }) => (
            <div key={key} style={{ flex: 1, minWidth: 0 }}>
              <KpiCard {...props} compact />
            </div>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setModalOpen(true)}
        disabled={!data}
        style={{
          marginTop: 8,
          width: '100%',
          padding: '8px 12px',
          border: 'none',
          borderRadius: 6,
          background: MF.ink.primary,
          color: MF.surface.page,
          fontFamily: 'inherit',
          fontSize: 12.5,
          fontWeight: 600,
          cursor: data ? 'pointer' : 'default',
          opacity: data ? 1 : 0.55
        }}
      >
        Open Executive Dashboard
      </button>

      {modalOpen && data ? (
        <ExecutiveDashboardModal
          data={data}
          loading={loading}
          loadError={loadError}
          onRecalculate={handleRecalculate}
          onExportPdf={() => void handleExportPdf()}
          onClose={() => setModalOpen(false)}
        />
      ) : null}
    </div>
  );
}
