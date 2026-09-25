// src/components/executiveDashboardView.js
//
// Display logic for the Executive Dashboard, shared by the screen
// (ExecutiveDashboardModal.jsx), the PDF (ExecutiveDashboardPdfDocument.jsx)
// and the side-panel card (ExecutiveDashboardPanel.jsx), so all three show
// the same values, labels, sort orders and footnotes. Pure functions over the
// `data` object runCalculation() produces -- no React, no aggregation of its
// own; every number still comes from executiveDashboardCalc.js.

import {
  formatUsdCompact,
  formatTier1CapitalNeed,
  formatTermSubtitle,
  formatPhasingTitle
} from '../utils/executiveDashboardCalc';
import { INDUSTRY_TARGET_TIME_UTILIZATION } from '../utils/classroomUtilizationCalc';
import { PROJECT_TYPES, classifyProjectType, splitProjectName } from './mf/charts/projectTypes';

// The Executive Dashboard is Hastings-only (gated in StakeholderMap.jsx on
// Hastings' enableCapitalPriorities + enableClassroomUtilization flags).
export const INSTITUTION_NAME = 'Hastings College';
export const TARGET_PCT = Math.round(INDUSTRY_TARGET_TIME_UTILIZATION * 100);

const MINUS_SIGN = '−';

// --- Formatting -------------------------------------------------------------
export function formatAsOfDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function dashboardSubtitle(date = new Date()) {
  return `${INSTITUTION_NAME} · as of ${formatAsOfDate(date)}`;
}

// Signed square feet with a true minus sign: "−60,051 SF", "+4,200 SF".
export function formatSignedSf(value) {
  const rounded = Math.round(value);
  if (rounded === 0) return '0 SF';
  return `${rounded < 0 ? MINUS_SIGN : '+'}${Math.abs(rounded).toLocaleString('en-US')} SF`;
}

// Unsigned square feet: "43,120 SF".
export function formatSf(value) {
  return `${Math.round(value).toLocaleString('en-US')} SF`;
}

export function formatPctValue(pct) {
  return `${Math.round(pct)}%`;
}

export function formatMonthYear(value) {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// "A, B, C +2 more"
function listWithMore(names, max = 3) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

// --- Row 1: KPI models --------------------------------------------------------
// Each model is KpiCard's props: { key, label, value, context?, missing?, indicator? }.
export const KPI_LABELS = {
  tier1Need: 'Tier 1 capital need',
  tier1Count: 'Tier 1 buildings',
  nearTerm: 'Near-term projects'
};

export function tier1NeedKpi(data) {
  const summary = data.tier1Summary;
  const base = { key: 'tier1Need', label: KPI_LABELS.tier1Need };
  if (!summary.tier1Count) return { ...base, value: null, missing: { reason: 'No Tier 1 buildings' } };
  const need = formatTier1CapitalNeed(summary);
  // No Tier 1 building has cost data -- "—" / "Costs not entered".
  if (need.note) return { ...base, value: null, missing: { reason: need.note } };
  return { ...base, value: need.value, context: `${summary.knownCostCount} of ${summary.tier1Count} buildings costed` };
}

function tier1CountKpi(data) {
  const summary = data.tier1Summary;
  const names = summary.tier1Buildings.map((b) => b.originalId).filter(Boolean);
  return {
    key: 'tier1Count',
    label: KPI_LABELS.tier1Count,
    value: summary.tier1Count,
    context: names.length ? listWithMore(names) : 'No buildings score 80+'
  };
}

function nearTermKpi(data) {
  const base = { key: 'nearTerm', label: KPI_LABELS.nearTerm };
  if (!data.hasAnyCapitalPhasing) return { ...base, value: null, missing: { reason: 'No phasing projects uploaded' } };
  return { ...base, value: data.phasingSummary.nearTerm.length, context: 'Starting work in the next 2 years' };
}

export function spaceGapKpi(data) {
  const base = { key: 'spaceGap', label: `Space gap (${data.targetYear})` };
  const gap = data.institutionGap?.totalGapTarget;
  if (gap == null || !Number.isFinite(gap)) return { ...base, value: null, missing: { reason: 'Space data unavailable' } };
  const rounded = Math.round(gap);
  const context = rounded < 0
    ? `Deficit vs. ${data.targetYear} need`
    : rounded > 0
      ? `Surplus vs. ${data.targetYear} need`
      : `Matches ${data.targetYear} need`;
  const indicator = rounded < 0 ? 'deficit' : rounded > 0 ? 'surplus' : undefined;
  return { ...base, value: formatSignedSf(gap), context, indicator };
}

export function kpiModels(data) {
  return [tier1NeedKpi(data), tier1CountKpi(data), nearTermKpi(data), spaceGapKpi(data)];
}

export function loadingKpiModels(targetYear = 2036) {
  return [KPI_LABELS.tier1Need, KPI_LABELS.tier1Count, KPI_LABELS.nearTerm, `Space gap (${targetYear})`]
    .map((label) => ({ key: label, label, value: '…', context: 'Calculating' }));
}

// --- Row 2 (left): classroom time-utilization gauges -------------------------
export const UTILIZATION_TITLE = 'Classroom Time Utilization';
export const UTILIZATION_SUBTITLE = `Share of available weekly hours classrooms are scheduled · Industry target ${TARGET_PCT}%`;

// { message } when there's nothing to draw, else { gauges: [{ key, value (0-1|null), title, pill? }] }.
export function gaugeSection(data) {
  if (data.currentTerm.status === 'unconfigured') return { message: 'No terms configured — cannot compute Time Utilization.' };
  if (!data.campusRollups.length) return { message: 'Terms are configured, but no scheduled classes matched any term.' };
  return {
    gauges: data.campusRollups.map((c) => ({
      key: c.termId,
      value: Number.isFinite(c.timeUtilizationPct) ? c.timeUtilizationPct / 100 : null,
      title: formatTermSubtitle(c.termLabel),
      pill: data.currentTerm.termId === c.termId ? 'Current' : undefined
    }))
  };
}

// --- Row 2 (right): utilization by room size ---------------------------------
// The Classroom Size Range section's own 10-seat buckets for the current term
// (falling back to the first term), smallest at top, empty ranges hidden, with
// time utilization added by executiveDashboardCalc.js's addTimeUtilizationToSizeRanges.
export const ROOM_SIZE_TITLE = 'Utilization by Room Size';
export const ROOM_SIZE_EMPTY = 'No classrooms with a known seat count were scheduled this term.';

export function pickSizeRangeTable(data) {
  const tables = Array.isArray(data.sizeRangeByTerm) ? data.sizeRangeByTerm : [];
  return tables.find((t) => t.termId === data.currentTerm?.termId) || tables[0] || null;
}

export function hasRoomSizeBars(table) {
  return Boolean(table?.buckets?.some((b) => b.roomCount > 0));
}

export function roomSizeSubtitle(table) {
  return table
    ? `${formatTermSubtitle(table.termLabel)} · classroom time utilization by seat capacity`
    : 'Classroom time utilization by seat capacity';
}

export function roomSizeRows(table) {
  return table.buckets.filter((b) => b.roomCount > 0).map((b) => {
    const label = `${b.start}–${b.end} seats`;
    const rooms = `${b.roomCount} ${b.roomCount === 1 ? 'room' : 'rooms'}`;
    const tooltipRows = [
      ['Rooms', String(b.roomCount)],
      ['Time utilization', Number.isFinite(b.timeUtilizationPct) ? formatPctValue(b.timeUtilizationPct) : '—']
    ];
    if (Number.isFinite(b.seatUtilizationPct)) {
      tooltipRows.push(['Seat utilization', formatPctValue(b.seatUtilizationPct)]);
    }
    return {
      key: b.label,
      label,
      value: Number.isFinite(b.timeUtilizationPct) ? b.timeUtilizationPct : null,
      valueLabel: Number.isFinite(b.timeUtilizationPct) ? formatPctValue(b.timeUtilizationPct) : '—',
      countLabel: rooms,
      tooltip: { title: label, rows: tooltipRows }
    };
  });
}

// Empty size ranges are hidden; say so, along with any rooms left out for
// having no seat count on file.
export function roomSizeFootnote(table) {
  const unresolved = table.unresolvedCapacityRoomCount || 0;
  const parts = [];
  if (unresolved > 0) parts.push(`${unresolved} ${unresolved === 1 ? 'room' : 'rooms'} with no seat count on file not shown.`);
  if (table.buckets.some((b) => b.roomCount === 0)) parts.push('Size ranges with no classrooms are hidden.');
  return parts.length ? parts.join(' ') : null;
}

// --- Row 3 (left): space gap by division -------------------------------------
export const SPACE_GAP_TITLE = 'Space Gap by Division';

export function spaceGapSubtitle(data) {
  return `Current vs. ${data.targetYear} need, academic divisions`;
}

export function spaceGapEmptyMessage(data) {
  return data.airtableFetchFailed
    ? 'Space data is still loading — click Recalculate to try again.'
    : 'No division-level gaps available.';
}

// Largest deficit first; divisions with no resolvable gap sort last.
export function spaceGapRows(buckets, targetYear) {
  return [...buckets]
    .sort((a, b) => {
      const av = Number.isFinite(a.gapTarget) ? a.gapTarget : Infinity;
      const bv = Number.isFinite(b.gapTarget) ? b.gapTarget : Infinity;
      return av - bv;
    })
    .map((b) => {
      const rows = [
        ['Existing', Number.isFinite(b.currentSF) ? formatSf(b.currentSF) : '—'],
        [`${targetYear} need`, Number.isFinite(b.needSF) ? formatSf(b.needSF) : '—'],
        ['Gap', Number.isFinite(b.gapTarget) ? formatSignedSf(b.gapTarget) : 'No data']
      ];
      if (b.categoriesExcluded > 0) {
        rows.push(['Not included', `${b.categoriesExcluded} ${b.categoriesExcluded === 1 ? 'category' : 'categories'} without data`]);
      }
      return { key: b.label, label: b.label, value: Number.isFinite(b.gapTarget) ? b.gapTarget : null, tooltip: { title: b.label, rows } };
    });
}

// The KPI's institution-wide gap and the division bars come from two
// different calculations (spaceGrowthCalc.js computeSpaceGrowth vs.
// computeDepartmentSpaceGrowth), so they don't have to add up. Say so, with
// the actual numbers, whenever they differ.
export function spaceGapFootnote(data) {
  const kpi = data.institutionGap?.totalGapTarget;
  const withGap = data.spaceGapBuckets.filter((b) => Number.isFinite(b.gapTarget));
  if (!Number.isFinite(kpi) || !withGap.length) return null;
  const divisionsTotal = withGap.reduce((sum, b) => sum + b.gapTarget, 0);
  if (Math.round(divisionsTotal) === Math.round(kpi)) return null;
  return `Divisions total ${formatSignedSf(divisionsTotal)}; the ${formatSignedSf(kpi)} campus figure above also counts space `
    + 'not assigned to an academic department and uses campus-wide enrollment rather than each department’s own.';
}

// --- Row 3 (right): Tier 1 ranked table ---------------------------------------
export const TIER1_TITLE = 'Capital Compass — Tier 1';
export const TIER1_FOOTNOTE = 'Score: Capital Compass priority score (0–100)';
export const TIER1_EMPTY = 'No Tier 1 buildings currently.';

export function tier1Rows(tier1Summary) {
  return tier1Summary.tier1Buildings.map((b, i) => {
    const cost = b.resolvedCost != null ? formatUsdCompact(b.resolvedCost) : '—';
    return {
      key: b.buildingId,
      rank: i + 1,
      name: b.originalId,
      score: b.total,
      costLabel: cost,
      tooltip: {
        title: b.originalId,
        rows: [
          ['Priority score', `${b.total} / 100`],
          ['Est. cost', b.resolvedCost != null ? `${cost} (deferred maintenance estimate)` : 'Not entered']
        ]
      }
    };
  });
}

// --- Row 4: Capital Phasing timeline ------------------------------------------
// Axis range: executiveDashboardCalc.js getPhasingAxisRange (the same rule the
// card title reads). Each bar spans next phase start -> completion. Rows sort
// by start date, then building name. Building, project and SF are split out
// of the workbook's project name for display only.
export const PHASING_SUBTITLE = 'Projects with work starting in the next 2 years';
export const PHASING_EMPTY = 'No near-term projects.';

export function phasingTitle(nearTerm) {
  return formatPhasingTitle(nearTerm);
}

export function phasingRows(nearTerm) {
  return nearTerm
    .map((p) => {
      const { building, project, sf } = splitProjectName(p.projectName);
      const typeKey = classifyProjectType(p.projectName);
      const type = PROJECT_TYPES[typeKey];
      const sfLabel = Number.isFinite(sf) ? `${sf.toLocaleString('en-US')} SF` : null;
      const start = new Date(p.nextPhaseStart).getTime();
      const end = new Date(p.completionDate).getTime();
      const cost = Number(p.escalatedCost);
      const tooltipRows = [
        ['Project', project || '—'],
        ['Type', type.label],
        ['Schedule', `${formatMonthYear(p.nextPhaseStart)} – ${formatMonthYear(p.completionDate)}`]
      ];
      if (sfLabel) tooltipRows.push(['Size', sfLabel]);
      if (p.escalatedCost != null && Number.isFinite(cost)) tooltipRows.push(['Est. cost (escalated)', formatUsdCompact(cost)]);
      return {
        key: p.projectId,
        building,
        start,
        end,
        typeKey,
        line1: building,
        line2: [project, sfLabel].filter(Boolean).join(' · '),
        color: type.color,
        tooltip: { title: building, rows: tooltipRows }
      };
    })
    .sort((x, y) => (x.start - y.start) || x.building.localeCompare(y.building));
}

// Only the project types actually present, in PROJECT_TYPES order.
export function phasingLegendItems(rows) {
  return Object.entries(PROJECT_TYPES)
    .filter(([key]) => rows.some((r) => r.typeKey === key))
    .map(([key, t]) => ({ key, label: t.label, color: t.color }));
}
