// src/utils/executiveDashboardCalc.js
//
// Executive Dashboard module (Hastings-only, same posture as classroomUtilizationCalc.js/
// spaceGrowthCalc.js). Pure, framework-agnostic aggregation on top of data these three
// already-shipped modules produce -- ExecutiveDashboardPanel.jsx owns every Firestore
// read and the Airtable fetch; this file only computes over already-fetched plain data.
// No writes anywhere in this module, ever.
//
// Small, additive aggregations, none of which modify or re-derive the logic of
// the functions they sit on top of:
//   1. computeTier1CapitalSummary -- Tier 1 (score >= 80) buildings from capitalPriorities,
//      with the same "auto" (deferred-maintenance) cost resolution CapitalPrioritiesPanel.jsx's
//      own getResolvedBuildingCost prefers.
//   2. computeNearTermCapitalPhasing -- splits capitalPhasingProjects into near-term
//      (a phase window overlapping the next ~2 years) vs longer-term, using
//      capitalPhasingImport.js's own computeCapitalPhasingSchedule (not re-derived).
//   3. computeDivisionSpaceGapSummary / computeInstitutionWideSpaceGapTotal -- grouping/
//      summing on top of spaceGrowthCalc.js's already-computed rows.
//
// Also exports the small display-formatting helpers (formatUsdCompact/formatPct/
// formatGapSf) both ExecutiveDashboardPanel.jsx's on-screen JSX and
// ExecutiveDashboardPdfDocument.jsx's React-PDF chart labels need identically --
// colocated here rather than duplicated in each, since unlike this module's other
// small isolated constants (e.g. classroomUtilizationCalc.js's HASTINGS_UNIVERSITY_ID
// copy), these are shared between two sibling files in THIS module, not copied across
// unrelated modules, so a single shared source is the safer choice.

import { computeCapitalPhasingSchedule } from './capitalPhasingImport';
import { firstCurrencyValue } from './currency';
import { bucketRangeForCapacity } from './classroomUtilizationCalc';

export function formatUsdCompact(value) {
  // null/'' must not become "$0" -- Number(null) is 0.
  if (value == null || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

export function formatPct(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : '—';
}

// Gauge subtitle from a term label: "Fall 2026 Block 1" / "Fall 2026 - Block 1"
// -> "Fall 2026 · Block 1". Labels without a "Block N" part pass through as-is.
export function formatTermSubtitle(termLabel) {
  const label = String(termLabel || '').trim();
  return label.replace(/\s*[-–—:·]?\s*(block\s*\d+)\s*$/i, ' · $1');
}

// Date axis shared by the Capital Phasing timeline on screen and in the PDF:
// earliest of today and every project's next phase start, to the latest
// completion. The card title reads its years from this same range, so the
// title and the axis can't disagree.
export function getPhasingAxisRange(nearTerm, now = new Date()) {
  const starts = nearTerm.map((p) => new Date(p.nextPhaseStart).getTime());
  const ends = nearTerm.map((p) => new Date(p.completionDate).getTime());
  const minTime = Math.min(now.getTime(), ...starts);
  const maxTime = Math.max(...ends, minTime + 1);
  return { minTime, maxTime };
}

// "Capital Phasing, 2026–2031" (en dash); a single year when the range stays
// within one year; plain "Capital Phasing" when there's nothing to plot.
export function formatPhasingTitle(nearTerm, now = new Date()) {
  if (!Array.isArray(nearTerm) || !nearTerm.length) return 'Capital Phasing';
  const { minTime, maxTime } = getPhasingAxisRange(nearTerm, now);
  const startYear = new Date(minTime).getUTCFullYear();
  const endYear = new Date(maxTime).getUTCFullYear();
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) return 'Capital Phasing';
  return startYear === endYear ? `Capital Phasing, ${startYear}` : `Capital Phasing, ${startYear}–${endYear}`;
}

export function formatGapSf(value) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  return `${rounded >= 0 ? '+' : ''}${rounded.toLocaleString()} SF`;
}

// CapitalPrioritiesPanel.jsx's own TIERS[0] threshold ("Tier 1: 80-100, fund
// immediately") -- TIERS/getTier aren't exported from that file, so this is a
// standalone copy, same isolation convention classroomUtilizationCalc.js/
// roomUtilizationMeta.js already use for small shared constants. A capitalPriorities
// doc with no numeric `total` (not yet fully scored) never counts as Tier 1.
const TIER1_MIN_SCORE = 80;

// capitalPriorityDocs: [{buildingId, originalId, total, ...}] -- raw docs from the
// `capitalPriorities` collection, same shape CapitalPrioritiesPanel.jsx reads.
//
// Cost resolution deliberately mirrors ONLY the "auto" (deferred-maintenance data)
// branch of that panel's getResolvedBuildingCost -- its "manual" branch
// (manualCosts state) is local-only React state in that component, never written to
// Firestore, so this independent read has no way to see it. Per Clark's explicit
// decision, this function also never computes a funded/deferred split: that split in
// CapitalPrioritiesPanel.jsx depends on `budgetCap`, which is local UI state that
// defaults to "everything funded" and is never persisted -- reproducing it here would
// silently show a fabricated 100%-funded number that reflects a default nobody chose,
// not a real budget decision. Only the honest totals (count, total known cost) are
// returned.
export function computeTier1CapitalSummary({ capitalPriorityDocs, getBuildingResourceEntry }) {
  const tier1Buildings = (Array.isArray(capitalPriorityDocs) ? capitalPriorityDocs : [])
    .filter((d) => typeof d?.total === 'number' && d.total >= TIER1_MIN_SCORE)
    .map((d) => {
      const entry = typeof getBuildingResourceEntry === 'function'
        ? getBuildingResourceEntry(d.originalId || d.buildingId)
        : null;
      const deferred = entry?.deferredMaintenance;
      const resolvedCost = deferred
        ? firstCurrencyValue([deferred.totalCost, deferred.totalHigh, deferred.totalLow])
        : null;
      return {
        buildingId: d.buildingId,
        originalId: d.originalId || d.buildingId,
        total: d.total,
        resolvedCost
      };
    })
    .sort((a, b) => (b.total - a.total) || String(a.originalId).localeCompare(String(b.originalId)));

  const withCost = tier1Buildings.filter((b) => b.resolvedCost != null);

  return {
    tier1Buildings,
    tier1Count: tier1Buildings.length,
    // null (not 0) when no Tier 1 building has cost data, so the KPI can show
    // "—" instead of a misleading $0.
    totalKnownCost: withCost.length ? withCost.reduce((sum, b) => sum + b.resolvedCost, 0) : null,
    knownCostCount: withCost.length,
    unresolvedCostCount: tier1Buildings.length - withCost.length
  };
}

// One display rule for the Tier 1 capital need KPI, shared by the modal, the
// side-panel card, and the PDF so the three can't disagree. A real sum
// (including a true $0) shows as a dollar amount; no cost data at all shows
// "—" with a "Costs not entered" note.
export function formatTier1CapitalNeed(tier1Summary) {
  const total = tier1Summary?.totalKnownCost;
  if (total == null || !Number.isFinite(Number(total))) {
    return { value: '—', note: 'Costs not entered' };
  }
  return { value: formatUsdCompact(total), note: '' };
}

// capitalPhasingDocs: [{projectId, projectName, completionDate, escalatedCost, phases, ...}]
// -- raw docs from the `capitalPhasingProjects` collection.
//
// "Near-term" = the project has at least one phase whose [start, end] window overlaps
// [now, now+horizonMonths] -- a project completing years out can still have real work
// (design, site prep) starting soon, which is what an executive reader needs to see,
// not just which projects happen to finish within the window. Uses
// capitalPhasingImport.js's own computeCapitalPhasingSchedule (completionDate + phase
// durations, working backward) rather than re-deriving any date math here.
//
// A project with no completionDate/phases produces an empty schedule (that function's
// own contract) -- counted in `unschedulableCount`, never silently dropped from the
// total or miscounted as longer-term.
export function computeNearTermCapitalPhasing({ capitalPhasingDocs, now = new Date(), horizonMonths = 24 }) {
  const horizonEnd = new Date(now.getTime());
  horizonEnd.setMonth(horizonEnd.getMonth() + horizonMonths);

  const nearTerm = [];
  const longerTerm = [];
  let unschedulableCount = 0;

  (Array.isArray(capitalPhasingDocs) ? capitalPhasingDocs : []).forEach((project) => {
    const schedule = computeCapitalPhasingSchedule(project);
    if (!schedule.length) {
      unschedulableCount += 1;
      return;
    }
    // schedule is already chronologically ascending (computeCapitalPhasingSchedule's
    // own contract), so the first overlapping entry is also the earliest.
    const overlapping = schedule.filter((phase) => (
      new Date(phase.startDate) <= horizonEnd && new Date(phase.endDate) >= now
    ));
    if (overlapping.length) {
      nearTerm.push({
        projectId: project.projectId,
        projectName: project.projectName,
        completionDate: project.completionDate,
        escalatedCost: project.escalatedCost,
        nextPhaseName: overlapping[0].name,
        nextPhaseStart: overlapping[0].startDate
      });
    } else {
      longerTerm.push(project);
    }
  });

  nearTerm.sort((a, b) => String(a.nextPhaseStart || '').localeCompare(String(b.nextPhaseStart || '')));

  const longerTermTotalEscalatedCost = longerTerm.reduce((sum, p) => {
    const cost = Number(p.escalatedCost);
    return sum + (Number.isFinite(cost) ? cost : 0);
  }, 0);

  return {
    nearTerm,
    longerTermCount: longerTerm.length,
    longerTermTotalEscalatedCost,
    unschedulableCount
  };
}

// Real academic division names, exactly as confirmed 2026-09-15 by parsing the
// actual source workbook directly (ai-server/Docs/Hastings enroll_FTE.xlsx,
// through enrollmentProjectionsImport.js's own production parser) -- not typed
// from memory. Used only to order the 3 division buckets below in a stable,
// sensible order; a division value from a future re-uploaded workbook that
// doesn't match one of these three still gets its own bucket (see
// computeDivisionSpaceGapSummary), just sorted after the three known ones
// rather than dropped.
const KNOWN_DIVISION_ORDER = ['Arts & Humanities', 'Education & Social Sciences', 'Math, Science, and Business'];

// Replaces the earlier top-N-by-magnitude department view entirely, per
// Clark's explicit 2026-09-15 decision: every real division always gets a
// bucket (summed across whatever of its departments/categories have
// resolvable data), not just whichever 3 department/category pairs happened
// to have the largest gaps.
//
// departmentRows: computeDepartmentSpaceGrowth(...).rows (spaceGrowthCalc.js,
// unchanged) -- summed by `division`, looked up per department from
// enrollmentProjectionDocs (the same raw docs computeDepartmentSpaceGrowth
// itself already reads; the "Overall" institution-wide record is excluded,
// same convention as spaceGrowthCalc.js's getDepartmentEnrollment -- it was
// never a real department a room could be tagged with). A division's
// gapTarget sums only the rows that HAVE a resolvable gapTarget (same "never
// fabricate a 0 for missing data" convention as computeInstitutionWideSpaceGapTotal
// below); rows excluded for missing enrollment/space-target data are tracked
// separately (`categoriesExcluded`) so the UI can flag partial coverage
// rather than silently under-stating a division's real gap. A department row
// whose name doesn't resolve to any known division is skipped (defensive
// only -- every real department currently has a division, confirmed above).
//
// Per Clark's 2026-09-15 decision, this returns ONLY the 3 real academic
// divisions -- a 4th "Non-Academic/Office" bucket (current SF only, no gap,
// from Office-tagged rooms with no matching academic department) was built
// and shipped for one round, then dropped outright per explicit instruction
// ("revert to showing only the 3 real academic divisions... no 'not
// computable' 4th row"), not merely hidden -- there is no dead code or
// unused param left over from that bucket in this function.
export function computeDivisionSpaceGapSummary({
  departmentRows,
  enrollmentProjectionDocs
}) {
  const divisionByDepartment = new Map();
  (Array.isArray(enrollmentProjectionDocs) ? enrollmentProjectionDocs : []).forEach((d) => {
    const division = String(d?.division || '').trim();
    const department = String(d?.department || '').trim();
    if (!division || !department || division.toLowerCase() === 'overall') return;
    divisionByDepartment.set(department, division);
  });

  // currentSF / needSF sum over exactly the rows that feed gapSum, so
  // currentSF - needSF === gapTarget for every division (display-only
  // additions for the dashboard tooltip; gapTarget itself is unchanged).
  const divisionAgg = new Map(); // division -> { gapSum, currentSfSum, needSfSum, categoriesIncluded, categoriesExcluded }
  (Array.isArray(departmentRows) ? departmentRows : []).forEach((row) => {
    const division = divisionByDepartment.get(row.department);
    if (!division) return; // no known division for this department -- defensive only, see header comment
    if (!divisionAgg.has(division)) {
      divisionAgg.set(division, { division, gapSum: 0, currentSfSum: 0, needSfSum: 0, categoriesIncluded: 0, categoriesExcluded: 0 });
    }
    const agg = divisionAgg.get(division);
    if (row.gapTarget != null) {
      const currentSF = Number(row.currentSF) || 0;
      agg.gapSum += row.gapTarget;
      agg.currentSfSum += currentSF;
      agg.needSfSum += currentSF - row.gapTarget;
      agg.categoriesIncluded += 1;
    } else {
      agg.categoriesExcluded += 1;
    }
  });

  return Array.from(divisionAgg.values())
    .map((d) => ({
      label: d.division,
      gapTarget: d.categoriesIncluded > 0 ? d.gapSum : null,
      currentSF: d.categoriesIncluded > 0 ? d.currentSfSum : null,
      needSF: d.categoriesIncluded > 0 ? d.needSfSum : null,
      categoriesIncluded: d.categoriesIncluded,
      categoriesExcluded: d.categoriesExcluded
    }))
    .sort((a, b) => {
      const ia = KNOWN_DIVISION_ORDER.indexOf(a.label);
      const ib = KNOWN_DIVISION_ORDER.indexOf(b.label);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.label.localeCompare(b.label);
    });
}

// institutionRows: computeSpaceGrowth(...).rows (spaceGrowthCalc.js, unchanged) -- one
// row per space category. Sums gapTarget only across categories where it's resolvable;
// a category with no space target set or no institution-wide enrollment for the target
// year is excluded from the sum and counted in `categoriesExcluded`, never folded in as
// a 0 SF gap that would understate the real total.
export function computeInstitutionWideSpaceGapTotal(institutionRows) {
  const rows = Array.isArray(institutionRows) ? institutionRows : [];
  const withGap = rows.filter((r) => r.gapTarget != null);
  return {
    totalGapTarget: withGap.length ? withGap.reduce((sum, r) => sum + r.gapTarget, 0) : null,
    categoriesIncluded: withGap.length,
    categoriesExcluded: rows.length - withGap.length
  };
}

// Time utilization per classroom size range, for the dashboard's "Utilization
// by Room Size" chart. Additive only: takes the size-range tables exactly as
// classroomUtilizationCalc.js's computeSizeRangeUtilizationByTerm returns them
// (same 10-seat buckets, room counts, seat utilization -- none of it
// re-derived) and adds each bucket's hours-weighted Time Utilization:
// sum weeklyHoursUsed / sum standardWeeklyHoursAvailable over that bucket's
// rooms -- the same weighting the campus rollup (the dashboard gauges) uses.
//
// rooms: computeClassroomUtilization(...).rooms -- the same room+term rows
// computeSizeRangeUtilizationByTerm buckets internally. Rooms with unknown
// capacity are skipped here too (that function counts them separately as
// unresolvedCapacityRoomCount). A bucket with no rooms gets null.
export function addTimeUtilizationToSizeRanges({ sizeRangeTables, rooms }) {
  const hoursByKey = new Map(); // `${termId}||${bucketStart}` -> { used, available }
  (Array.isArray(rooms) ? rooms : []).forEach((r) => {
    if (r?.capacity == null) return;
    const { start } = bucketRangeForCapacity(r.capacity);
    const key = `${r.termId}||${start}`;
    if (!hoursByKey.has(key)) hoursByKey.set(key, { used: 0, available: 0 });
    const acc = hoursByKey.get(key);
    acc.used += Number(r.weeklyHoursUsed) || 0;
    acc.available += Number(r.standardWeeklyHoursAvailable) || 0;
  });

  return (Array.isArray(sizeRangeTables) ? sizeRangeTables : []).map((table) => ({
    ...table,
    buckets: table.buckets.map((bucket) => {
      const acc = bucket.roomCount > 0 ? hoursByKey.get(`${table.termId}||${bucket.start}`) : null;
      return {
        ...bucket,
        timeUtilizationPct: acc && acc.available > 0 ? (acc.used / acc.available) * 100 : null
      };
    })
  }));
}
