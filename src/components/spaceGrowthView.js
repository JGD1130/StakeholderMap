// src/components/spaceGrowthView.js
//
// Display logic for the Space Growth workspace (SpaceGrowthWorkspace.jsx):
// KPI models, bar rows, table rows and the enrollment series, all for the
// hook's selected target year. Pure functions over the useSpaceGrowthData
// result -- no React, no fetching, no new math: every number comes from
// spaceGrowthCalc.js via the hook (results.headline, results.headlineDivisions,
// results.institutionGap). Same role executiveDashboardView.js plays for the
// Executive Dashboard, and the division bars reuse that file's spaceGapRows so
// both screens match.

import {
  INSTITUTION_NAME,
  formatSignedSf,
  formatSf,
  spaceGapRows
} from './executiveDashboardView';
import { SPACE_GROWTH_BASELINE_YEAR, SPACE_GROWTH_DASHBOARD_YEAR } from '../utils/useSpaceGrowthData';

export const WORKSPACE_TITLE = 'Space Growth Projections';
export const YEAR_OPTIONS = Array.from({ length: 10 }, (_, i) => 2027 + i); // 2027-2036
export const DASHBOARD_YEAR_NOTE = `Executive Dashboard uses ${SPACE_GROWTH_DASHBOARD_YEAR}`;
export const HEADLINE_CONTEXT = 'Classroom and lab · by department';
export const OVERRIDE_TAG = 'department target';
export const CATEGORY_FILTERS = ['All', 'Classroom', 'Lab'];

const MINUS_SIGN = '−';

// Names as the workbook/tags spell them, minus stray whitespace (some source
// division names end in a space).
function cleanName(value) {
  return String(value ?? '').trim();
}

// --- Formatting -------------------------------------------------------------------
function formatCount(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—';
}

function formatSignedCount(value) {
  const rounded = Math.round(value);
  if (rounded === 0) return '0';
  return `${rounded < 0 ? MINUS_SIGN : '+'}${Math.abs(rounded).toLocaleString('en-US')}`;
}

function formatSignedPct(value) {
  const rounded = Math.round(value);
  if (rounded === 0) return '0%';
  return `${rounded < 0 ? MINUS_SIGN : '+'}${Math.abs(rounded)}%`;
}

function formatSfPerStudent(value) {
  return Number.isFinite(value) ? `${(Math.round(value * 10) / 10).toLocaleString('en-US')} SF/student` : '—';
}

function signedSfOrDash(value) {
  return Number.isFinite(value) ? formatSignedSf(value) : '—';
}

function sfOrDash(value) {
  return Number.isFinite(value) ? formatSf(value) : '—';
}

function indicatorFor(value) {
  if (!Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded < 0 ? 'deficit' : rounded > 0 ? 'surplus' : undefined;
}

export function workspaceSubtitle(data) {
  return `${INSTITUTION_NAME} · ${data?.baselineYear ?? SPACE_GROWTH_BASELINE_YEAR} → ${data?.targetYear ?? SPACE_GROWTH_DASHBOARD_YEAR}`;
}

// department -> division, from the enrollment projections (Overall excluded).
function divisionByDepartment(data) {
  const map = new Map();
  (data?.raw?.enrollmentProjections || []).forEach((d) => {
    const division = String(d.data?.division || '').trim();
    const department = String(d.data?.department || '').trim();
    if (!division || !department || division.toLowerCase() === 'overall') return;
    map.set(department, division);
  });
  return map;
}

// --- Overview KPIs ------------------------------------------------------------------
function categoryGapKpi(data, category) {
  const year = data.targetYear;
  const base = { key: category, label: `${category} gap (${year})` };
  const piece = data.results?.headline?.byCategory?.find((c) => c.category === category);
  if (!piece) return { ...base, value: null, missing: { reason: `No ${category.toLowerCase()} rooms priced` } };
  return {
    ...base,
    value: formatSignedSf(piece.gapTarget),
    context: `${piece.pairs} ${piece.pairs === 1 ? 'department' : 'departments'} · need ${formatSf(piece.needSF)}`
  };
}

function enrollmentKpi(data) {
  const base = { key: 'enrollment', label: `Enrollment (${data.targetYear})` };
  const start = data.results?.institution?.baselineEnrollment;
  const end = data.results?.institution?.targetEnrollment;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { ...base, value: null, missing: { reason: 'Enrollment projections not uploaded' } };
  }
  const pct = start > 0 ? ((end - start) / start) * 100 : null;
  return {
    ...base,
    value: formatCount(end),
    context: `${formatCount(start)} → ${formatCount(end)} students${pct != null ? ` (${formatSignedPct(pct)})` : ''}`
  };
}

export function overviewKpis(data) {
  const gap = data.results?.headline?.totalGapTarget;
  const headline = { key: 'gap', label: `Space gap (${data.targetYear})` };
  return [
    Number.isFinite(gap)
      ? { ...headline, value: formatSignedSf(gap), context: HEADLINE_CONTEXT, indicator: indicatorFor(gap) }
      : { ...headline, value: null, missing: { reason: 'Space data unavailable' } },
    categoryGapKpi(data, 'Classroom'),
    categoryGapKpi(data, 'Lab'),
    enrollmentKpi(data)
  ];
}

// --- Side-panel card ----------------------------------------------------------------
// Two compact KPIs, always for the dashboard year (2036), from the hook's
// dashboardResults -- the same numbers the Executive Dashboard shows.
export function sideCardKpis(spaceGrowthData) {
  const results = spaceGrowthData?.dashboardResults || null;
  const year = SPACE_GROWTH_DASHBOARD_YEAR;
  const gap = results?.headline?.totalGapTarget;
  const gapKpi = { key: 'gap', label: `Space gap (${year})` };
  const start = results?.institution?.baselineEnrollment;
  const end = results?.institution?.targetEnrollment;
  const enrollment = { key: 'enrollment', label: `Enrollment (${year})` };
  const pct = Number.isFinite(start) && Number.isFinite(end) && start > 0 ? ((end - start) / start) * 100 : null;
  return [
    Number.isFinite(gap)
      ? { ...gapKpi, value: formatSignedSf(gap), context: HEADLINE_CONTEXT, indicator: indicatorFor(gap) }
      : { ...gapKpi, value: null, missing: { reason: 'Space data unavailable' } },
    Number.isFinite(start) && Number.isFinite(end)
      ? { ...enrollment, value: formatCount(end), context: `${formatCount(start)} → ${formatCount(end)}${pct != null ? ` (${formatSignedPct(pct)})` : ''}` }
      : { ...enrollment, value: null, missing: { reason: 'No projections uploaded' } }
  ];
}

// --- Overview charts ----------------------------------------------------------------
export const DIVISION_TITLE = 'Gap by Division';
export function divisionSubtitle(data) {
  return `Classroom and lab, current vs. ${data.targetYear} need, academic divisions`;
}
export function divisionRows(data) {
  return spaceGapRows(data.results?.headlineDivisions || [], data.targetYear).map((row) => ({
    ...row,
    label: cleanName(row.label),
    tooltip: row.tooltip ? { ...row.tooltip, title: cleanName(row.tooltip.title) } : row.tooltip
  }));
}

export const OFFICE_TITLE = 'Office Space';
export const OFFICE_SUBTITLE = 'Inventory only · not in the gap';
export const OFFICE_NOTE = "Office need requires staff FTE, which the enrollment projections don't include yet.";
export function officeSummary(data) {
  const inv = data.results?.headline?.officeInventory;
  return {
    sfLabel: inv ? formatSf(inv.currentSF) : '—',
    roomsLabel: inv ? `${inv.roomCount.toLocaleString('en-US')} ${inv.roomCount === 1 ? 'room' : 'rooms'}` : '—',
    hasOffice: Boolean(inv?.categories?.length)
  };
}

export function categoryChartTitle(category) {
  return `${category} Gap by Department`;
}
export function categoryChartSubtitle(data, category) {
  return `Departments with ${category.toLowerCase()} rooms · current vs. ${data.targetYear} need`;
}

function pairTooltip(row, year) {
  const rows = [
    [`${year} headcount`, formatCount(row.targetEnrollment)],
    ['Target', `${formatSfPerStudent(row.idealNsfPerStudent)}${row.usingDepartmentOverride ? ` (${OVERRIDE_TAG})` : ''}`],
    ['Existing', sfOrDash(row.currentSF)],
    [`${year} need`, sfOrDash(row.idealSfTarget)],
    ['Gap', Number.isFinite(row.gapTarget) ? formatSignedSf(row.gapTarget) : 'No data']
  ];
  return { title: `${cleanName(row.department)} · ${row.category}`, rows };
}

// Largest deficit first; pairs with rooms but no computable need sort last.
function byGapAscending(a, b) {
  const av = Number.isFinite(a.gapTarget) ? a.gapTarget : Infinity;
  const bv = Number.isFinite(b.gapTarget) ? b.gapTarget : Infinity;
  return av - bv || a.department.localeCompare(b.department);
}

export function categoryDepartmentRows(data, category) {
  return (data.results?.headline?.rows || [])
    .filter((r) => r.category === category)
    .sort(byGapAscending)
    .map((r) => ({
      key: `${r.category}||${r.department}`,
      label: cleanName(r.department),
      value: Number.isFinite(r.gapTarget) ? r.gapTarget : null,
      tooltip: pairTooltip(r, data.targetYear)
    }));
}

export function overviewFootnote(data) {
  const campus = data.results?.institutionGap?.totalGapTarget;
  const base = 'Need = department headcount × department SF-per-student target, for departments with that room type.';
  return Number.isFinite(campus)
    ? `${base} For comparison, counting every student campus-wide gives ${formatSignedSf(campus)}.`
    : base;
}

// --- Departments table --------------------------------------------------------------
// Classroom and Lab pairs only (the headline rows); Office is never here.
export function departmentTableRows(data) {
  const divisions = divisionByDepartment(data);
  return (data.results?.headline?.rows || []).map((r) => ({
    key: `${r.category}||${r.department}`,
    department: cleanName(r.department),
    division: cleanName(divisions.get(cleanName(r.department))) || '—',
    category: r.category,
    target: Number.isFinite(r.idealNsfPerStudent) ? r.idealNsfPerStudent : null,
    targetLabel: formatSfPerStudent(r.idealNsfPerStudent),
    isOverride: Boolean(r.usingDepartmentOverride),
    headcount: Number.isFinite(r.targetEnrollment) ? r.targetEnrollment : null,
    headcountLabel: formatCount(r.targetEnrollment),
    currentSF: Number.isFinite(r.currentSF) ? r.currentSF : null,
    currentLabel: sfOrDash(r.currentSF),
    need: Number.isFinite(r.idealSfTarget) ? r.idealSfTarget : null,
    needLabel: sfOrDash(r.idealSfTarget),
    gap: Number.isFinite(r.gapTarget) ? r.gapTarget : null,
    gapLabel: signedSfOrDash(r.gapTarget)
  }));
}

export function departmentColumns(year) {
  return [
    { key: 'department', label: 'Department' },
    { key: 'division', label: 'Division' },
    { key: 'category', label: 'Category' },
    { key: 'target', label: 'Target', numeric: true },
    { key: 'headcount', label: `Headcount (${year})`, numeric: true },
    { key: 'currentSF', label: 'Current SF', numeric: true },
    { key: 'need', label: 'Need', numeric: true },
    { key: 'gap', label: 'Gap', numeric: true }
  ];
}

// Blank values always sort last, whichever the direction.
export function sortDepartmentRows(rows, sortKey, direction) {
  const dir = direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    const aBlank = av == null || av === '—';
    const bBlank = bv == null || bv === '—';
    if (aBlank || bBlank) return aBlank === bBlank ? 0 : aBlank ? 1 : -1;
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return cmp * dir || a.department.localeCompare(b.department);
  });
}

// --- Enrollment -----------------------------------------------------------------------
export const ENROLLMENT_TITLE = 'Projected Enrollment';
export const ENROLLMENT_SUBTITLE = `Campus headcount, ${SPACE_GROWTH_BASELINE_YEAR}–${SPACE_GROWTH_DASHBOARD_YEAR}`;
export const ENROLLMENT_NOTE = 'Staff FTE is not in the projections yet.';
export const ENROLLMENT_EMPTY = 'No enrollment projections uploaded yet.';

function overallDoc(data) {
  return (data?.raw?.enrollmentProjections || [])
    .find((d) => String(d.data?.division || '').trim().toLowerCase() === 'overall');
}

function headcountFor(doc, year) {
  const n = Number(doc?.data?.years?.[String(year)]?.studentHeadcount);
  return Number.isFinite(n) ? n : null;
}

// [{ key, label, value, tooltip }] -- campus headcount for every year
// 2026-2036 that the Overall record has.
export function enrollmentSeries(data) {
  const doc = overallDoc(data);
  if (!doc) return [];
  const points = [];
  for (let year = SPACE_GROWTH_BASELINE_YEAR; year <= SPACE_GROWTH_DASHBOARD_YEAR; year += 1) {
    const value = headcountFor(doc, year);
    if (value == null) continue;
    points.push({ key: String(year), label: String(year), value });
  }
  const first = points[0]?.value;
  return points.map((p) => ({
    ...p,
    tooltip: {
      title: p.label,
      rows: [
        ['Headcount', formatCount(p.value)],
        ...(Number.isFinite(first) && p !== points[0] ? [[`Change since ${points[0].label}`, formatSignedCount(p.value - first)]] : [])
      ]
    }
  }));
}

export function formatHeadcount(value) {
  return formatCount(value);
}

// Campus row first, then departments by division and name.
export function enrollmentTableRows(data) {
  const docs = data?.raw?.enrollmentProjections || [];
  const year = data.targetYear;
  const toRow = (doc, isCampus) => {
    const start = headcountFor(doc, SPACE_GROWTH_BASELINE_YEAR);
    const end = headcountFor(doc, year);
    const change = Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
    const pct = change != null && start > 0 ? (change / start) * 100 : null;
    return {
      key: doc.id,
      isCampus,
      department: isCampus ? `${INSTITUTION_NAME} (campus)` : cleanName(doc.data?.department),
      division: isCampus ? '' : cleanName(doc.data?.division),
      startLabel: formatCount(start),
      endLabel: formatCount(end),
      changeLabel: change == null ? '—' : `${formatSignedCount(change)}${pct != null ? ` (${formatSignedPct(pct)})` : ''}`
    };
  };
  const overall = overallDoc(data);
  const departments = docs
    .filter((d) => d !== overall)
    .map((d) => toRow(d, false))
    .sort((a, b) => a.division.localeCompare(b.division) || a.department.localeCompare(b.department));
  return [...(overall ? [toRow(overall, true)] : []), ...departments];
}
