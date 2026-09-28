// src/components/classroomUtilizationView.js
//
// Display logic for the Classroom Utilization workspace
// (ClassroomUtilizationWorkspace.jsx): term options, KPI models, By Building
// rows and the heat map model, all for one selected term. Pure functions over
// the useClassroomUtilizationData result -- no React, no fetching. Every
// number comes from classroomUtilizationCalc.js; this file only picks the
// selected term's rows, groups and formats them. Same role
// executiveDashboardView.js plays for the Executive Dashboard, and the room
// size chart reuses that file's functions so both screens match.

import { formatHeatmapHourLabel } from '../utils/classroomUtilizationCalc';
import { addTimeUtilizationToSizeRanges, formatTermSubtitle } from '../utils/executiveDashboardCalc';
import { INSTITUTION_NAME, TARGET_PCT, formatPctValue } from './executiveDashboardView';

export const WORKSPACE_TITLE = 'Classroom Utilization';

// --- Terms --------------------------------------------------------------------
// "FALL" / 2026 / 1 -> "Fall 2026 · Block 1", for terms with no scheduled
// meetings (so no sessionLabel to format).
function termLabelFromDoc(termDoc) {
  const d = termDoc?.data || {};
  const term = String(d.term || '').trim();
  const name = term ? `${term.charAt(0).toUpperCase()}${term.slice(1).toLowerCase()}` : '';
  const parts = [[name, d.academicYear].filter(Boolean).join(' ')];
  if (d.sessionNumber) parts.push(`Block ${d.sessionNumber}`);
  return parts.filter(Boolean).join(' · ') || String(termDoc?.id || '');
}

// "Fall 2026 · Block 1" for a termId: the imported schedule's own label when
// the term has meetings, else built from the terms doc.
export function termDisplayLabel(data, termId) {
  if (!termId) return '';
  const entry = data?.resultsByTerm?.[termId];
  const scheduleLabel = entry?.campusRollup?.termLabel || entry?.rooms?.[0]?.termLabel;
  if (scheduleLabel) return formatTermSubtitle(scheduleLabel);
  const doc = (data?.terms || []).find((t) => t.id === termId);
  return doc ? termLabelFromDoc(doc) : termId;
}

// Every configured term, in termId order; the current one reads "(current)".
export function termOptions(data) {
  return [...(data?.terms || [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => ({
      value: t.id,
      label: `${termDisplayLabel(data, t.id)}${t.id === data.currentTermId ? ' (current)' : ''}`
    }));
}

export function workspaceSubtitle(data) {
  const label = termDisplayLabel(data, data?.selectedTermId);
  return label ? `${INSTITUTION_NAME} · ${label}` : INSTITUTION_NAME;
}

// The term's Standard Weekly Hours (Terms section), or null.
export function standardWeeklyHours(data, termId) {
  const doc = (data?.terms || []).find((t) => t.id === termId);
  const hours = Number(doc?.data?.standardWeeklyHours);
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

export function selectedTermEntry(data) {
  const termId = data?.selectedTermId;
  return termId ? data?.resultsByTerm?.[termId] || null : null;
}

export function noTermDataMessage(data) {
  if (!data?.terms?.length) return 'No terms configured — add one in the Terms section.';
  return `No scheduled classes matched ${termDisplayLabel(data, data.selectedTermId) || 'this term'}.`;
}

// --- Formatting -----------------------------------------------------------------
function formatHours(value) {
  return Number.isFinite(value) ? (Math.round(value * 10) / 10).toLocaleString('en-US') : '—';
}

function pctOrDash(value) {
  return Number.isFinite(value) ? formatPctValue(value) : '—';
}

// --- Overview: KPI row ----------------------------------------------------------
// True when at least one of the term's rooms has a computed seat utilization
// (known enrollment and seat count). Without it, the Overview swaps the Seat
// utilization card for Peak hour and hides By Building's Seat util. column.
export function hasSeatData(entry) {
  return (entry?.campusRollup?.seatComputedRoomCount || 0) > 0;
}

// The heat map's busiest cell: highest % first, then earliest day, then
// earliest hour.
function peakHourKpi(heatmap) {
  const base = { key: 'peakHour', label: 'Peak hour' };
  let peak = null;
  (heatmap?.grid || []).forEach((col) => {
    col.hours.forEach((cell) => {
      if (Number.isFinite(cell.pct) && (!peak || cell.pct > peak.pct)) peak = { ...cell, dayLabel: col.dayLabel };
    });
  });
  if (!peak || peak.pct <= 0) return { ...base, value: null, missing: { reason: 'No weekday classes 7 AM–9 PM' } };
  return {
    ...base,
    value: formatPctValue(peak.pct),
    context: `${peak.dayLabel} ${formatHeatmapHourLabel(peak.hour)} · busiest hour this term`
  };
}

// Each model is KpiCard's props: { key, label, value, context?, missing? }.
export function overviewKpis(entry, weekHours) {
  const rollup = entry?.campusRollup || null;
  const rooms = entry?.rooms || [];
  const roomCount = rooms.length; // one row per room for a single term
  const totalHours = rooms.reduce((sum, r) => sum + (Number(r.weeklyHoursUsed) || 0), 0);

  const time = Number.isFinite(rollup?.timeUtilizationPct)
    ? { value: formatPctValue(rollup.timeUtilizationPct), context: `vs. ${TARGET_PCT}% industry target` }
    : { value: null, missing: { reason: 'No scheduled hours' } };
  const seat = Number.isFinite(rollup?.seatUtilizationPct)
    ? { value: formatPctValue(rollup.seatUtilizationPct), context: 'Average share of seats filled when in use' }
    : { value: null, missing: { reason: 'No enrollment or seat counts' } };
  const avg = roomCount
    ? {
      value: `${formatHours(totalHours / roomCount)} hrs`,
      context: weekHours ? `Of a ${formatHours(weekHours)}-hour scheduled week` : 'Per classroom'
    }
    : { value: null, missing: { reason: 'No classrooms scheduled' } };

  return [
    { key: 'time', label: 'Time utilization', ...time },
    hasSeatData(entry) ? { key: 'seat', label: 'Seat utilization', ...seat } : peakHourKpi(entry?.heatmap),
    { key: 'rooms', label: 'Classrooms', value: roomCount, context: 'With scheduled meetings this term' },
    { key: 'avgHours', label: 'Avg. weekly hours', ...avg }
  ];
}

// --- Overview: gauge ------------------------------------------------------------
export const GAUGE_TITLE = 'Classroom Time Utilization';

export function gaugeSubtitle(weekHours) {
  return weekHours
    ? `Scheduled hours ÷ the term's ${formatHours(weekHours)}-hour week`
    : "Scheduled hours ÷ the term's standard week";
}

export function gaugeValue(entry) {
  const pct = entry?.campusRollup?.timeUtilizationPct;
  return Number.isFinite(pct) ? pct / 100 : null;
}

// --- Overview: utilization by room size -----------------------------------------
// The selected term's size-range table with time utilization added, exactly
// as the Executive Dashboard builds it (addTimeUtilizationToSizeRanges), so
// executiveDashboardView.js's roomSize* functions render it unchanged.
export function sizeRangeTableForTerm(entry) {
  if (!entry?.sizeRangeTable) return null;
  return addTimeUtilizationToSizeRanges({ sizeRangeTables: [entry.sizeRangeTable], rooms: entry.rooms })[0] || null;
}

// --- Overview: By Building --------------------------------------------------------
// Time util. is the existing building formula (Σ weekly hours used ÷ Σ
// standard weekly hours, as in computeClassroomUtilization's buildingSummary)
// over the selected term's rows only. Seat util. is the capacity-weighted
// average of rooms with a computed seat utilization, as in
// computeBuildingUtilizationForCurrentTerm. Highest time util. first.
export const BUILDING_TITLE = 'By Building';

export function buildingRows(entry) {
  const byBuilding = new Map();
  (entry?.rooms || []).forEach((r) => {
    if (!byBuilding.has(r.building)) {
      byBuilding.set(r.building, { building: r.building, roomKeys: new Set(), used: 0, available: 0, seatSum: 0, seatWeight: 0 });
    }
    const b = byBuilding.get(r.building);
    b.roomKeys.add(r.roomKey);
    b.used += Number(r.weeklyHoursUsed) || 0;
    b.available += Number(r.standardWeeklyHoursAvailable) || 0;
    if (r.seatUtilizationStatus === 'computed') {
      const weight = Number(r.capacity) > 0 ? Number(r.capacity) : 1;
      b.seatSum += r.seatUtilizationPct * weight;
      b.seatWeight += weight;
    }
  });

  return Array.from(byBuilding.values())
    .map((b) => {
      const timePct = b.available > 0 ? (b.used / b.available) * 100 : null;
      const seatPct = b.seatWeight > 0 ? b.seatSum / b.seatWeight : null;
      return {
        key: b.building,
        building: b.building,
        roomCount: b.roomKeys.size,
        hoursLabel: formatHours(b.used),
        timePct,
        seatLabel: pctOrDash(seatPct)
      };
    })
    .sort((a, b) => {
      const av = Number.isFinite(a.timePct) ? a.timePct : -Infinity;
      const bv = Number.isFinite(b.timePct) ? b.timePct : -Infinity;
      return (bv - av) || a.building.localeCompare(b.building);
    });
}

// --- Heat Map tab ----------------------------------------------------------------
export const HEATMAP_TITLE = 'Day/Time Occupancy';
export const HEATMAP_SUBTITLE = 'Share of scheduled classrooms in use each hour · Mon–Fri, 7 AM–9 PM';
export const HEATMAP_LEGEND_LABEL = 'Share of classrooms in use';
export const NO_CLASSES_THIS_TERM = 'No classes scheduled this term.';

export function heatmapFootnote(outsideCount) {
  const base = "Weekend and outside-hours meetings aren't shown here but count toward Time Utilization.";
  if (!outsideCount) return base;
  return `${base} This term: ${outsideCount.toLocaleString('en-US')} ${outsideCount === 1 ? 'meeting' : 'meetings'}.`;
}

// HeatmapGrid's props: hour rows × weekday columns, one cell per hour/day.
export function heatmapModel(heatmap) {
  if (!heatmap) return null;
  const columns = heatmap.grid.map((col) => ({ key: col.day, label: col.dayLabel }));
  const rows = heatmap.hours.map((hour, hourIndex) => {
    const hourLabel = formatHeatmapHourLabel(hour);
    return {
      key: String(hour),
      label: hourLabel,
      cells: heatmap.grid.map((col) => {
        const cell = col.hours[hourIndex];
        const pctLabel = formatPctValue(cell.pct);
        const text = `${col.dayLabel} ${hourLabel} · ${cell.occupiedRoomCount} of ${heatmap.roomCount} classrooms in use (${pctLabel})`;
        return { key: col.day, pct: cell.pct, label: pctLabel, tooltip: text };
      })
    };
  });
  return { columns, rows, ariaLabel: `${HEATMAP_TITLE}: ${HEATMAP_SUBTITLE}` };
}
