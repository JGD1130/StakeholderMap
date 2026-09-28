// src/components/faCompassView.js
//
// Display logic for the F&A Compass workspace (FaCompassWorkspace.jsx) and the
// side-panel summary card: KPI models, chart rows, room-table rows and the
// Method tab's text. Pure functions over the useResearchSpaceData result --
// no React, no fetching, no new math: every number comes from the hook's
// roomRows (per-room status and profile) and rollup
// (researchSpaceClassification.js computeResearchSpaceRollup).

import { MF } from '../theme/mfTokens';
import { FUNCTIONAL_CATEGORIES } from '../utils/researchSpaceClassification';
import { RS_STATUS, RS_STATUS_LABELS } from '../utils/researchSpaceStatus';

export const WORKSPACE_TITLE = 'F&A Compass';

export function workspaceSubtitle(universityName) {
  return `${universityName || 'Campus'} · research space classification`;
}

// --- Formatting -------------------------------------------------------------------
export function formatSf(value) {
  return `${Math.round(Number(value) || 0).toLocaleString('en-US')} SF`;
}

function formatPct(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  const factor = 10 ** digits;
  return `${Math.round(value * factor) / factor}%`;
}

export function floorLabel(floor) {
  if (floor == null) return '—';
  return Number(floor) === 0 ? 'Basement' : `Level ${floor}`;
}

// One wording everywhere (workspace, side panel, map legend).
export function statusLabel(status) {
  return RS_STATUS_LABELS[status] || RS_STATUS_LABELS[RS_STATUS.NOT_STARTED];
}

export const STATUS_OPTIONS = [RS_STATUS.NOT_STARTED, RS_STATUS.CLASSIFIED, RS_STATUS.EXCLUDED]
  .map((value) => ({ value, label: statusLabel(value) }));

// --- Totals ------------------------------------------------------------------------
function scopeTotals(data) {
  const rows = data?.roomRows || [];
  const rollup = data?.rollup || null;
  const inScope = rows.length;
  const done = rollup ? rollup.roomCountClassified : 0; // classified + excluded
  const excluded = rows.filter((r) => r.status === RS_STATUS.EXCLUDED).length;
  const scopeSf = rows.reduce((sum, r) => sum + (Number(r.areaSF) || 0), 0);
  return { inScope, done, excluded, scopeSf, rollup };
}

export function progressKpi(data) {
  const { inScope, done, scopeSf } = scopeTotals(data);
  const base = { key: 'progress', label: 'Classification progress' };
  if (!inScope) return { ...base, value: null, missing: { reason: 'No rooms in scope yet' } };
  return {
    ...base,
    value: `${done.toLocaleString('en-US')} of ${inScope.toLocaleString('en-US')} rooms`,
    context: `${formatSf(scopeSf)} in scope · ${formatPct((done / inScope) * 100)}`
  };
}

export function organizedResearchKpi(data) {
  const { rollup } = scopeTotals(data);
  return {
    key: 'or',
    label: 'Organized Research SF',
    value: rollup ? formatSf(rollup.totalOrganizedResearchSF) : null,
    context: 'Requires a named sponsor or grant',
    ...(rollup ? null : { missing: { reason: 'Not loaded yet' } })
  };
}

export function overviewKpis(data) {
  const { rollup, excluded } = scopeTotals(data);
  return [
    progressKpi(data),
    {
      key: 'classifiedSf',
      label: 'Classified SF',
      value: rollup ? formatSf(rollup.knownAreaSF) : null,
      context: 'Rooms with occupants on file',
      ...(rollup ? null : { missing: { reason: 'Not loaded yet' } })
    },
    organizedResearchKpi(data),
    {
      key: 'excluded',
      label: 'Excluded rooms',
      value: excluded.toLocaleString('en-US'),
      context: 'Vacant or ineligible'
    }
  ];
}

export function sideCardKpis(data) {
  return [progressKpi(data), organizedResearchKpi(data)];
}

// --- Space by F&A function ---------------------------------------------------------
export const FUNCTION_CHART_TITLE = 'Space by F&A Function';
export const FUNCTION_CHART_EMPTY = 'No rooms classified yet. Classify rooms on the map to build the function mix.';

export function functionChartSubtitle(data) {
  return `Share of classified space (${formatSf(data?.rollup?.knownAreaSF)}) by function`;
}

const GROUP_LABELS = { direct: 'Direct', indirect: 'Indirect' };

// Every function (zeros included), under Direct / Indirect header rows, in
// CategoryBars' row shape. null when nothing is classified with a known area.
export function functionChartRows(data) {
  const rollup = data?.rollup;
  if (!rollup || !(rollup.knownAreaSF > 0)) return null;
  const rows = [];
  ['direct', 'indirect'].forEach((group) => {
    rows.push({ key: `header-${group}`, header: GROUP_LABELS[group] });
    FUNCTIONAL_CATEGORIES.filter((c) => c.group === group).forEach((c) => {
      const sf = Number(rollup.categoryTotalsSF?.[c.code]) || 0;
      const pct = (sf / rollup.knownAreaSF) * 100;
      rows.push({
        key: c.code,
        label: c.label,
        value: sf,
        valueLabel: sf > 0 ? `${formatSf(sf)} · ${formatPct(pct, pct < 1 && pct > 0 ? 1 : 0)}` : '0 SF',
        color: MF.util.base,
        tooltip: {
          title: c.label,
          rows: [['Space', formatSf(sf)], ['Share of classified space', formatPct(pct, 1)]]
        }
      });
    });
  });
  return rows;
}

// --- Progress by building -----------------------------------------------------------
export const BUILDING_CHART_TITLE = 'Progress by Building';
export const BUILDING_CHART_SUBTITLE = 'Rooms in scope, by classification status';

const STATUS_COLORS = {
  [RS_STATUS.CLASSIFIED]: MF.util.base,
  [RS_STATUS.EXCLUDED]: MF.ink.subtle,
  [RS_STATUS.NOT_STARTED]: MF.status.warningBorder
};
const STATUS_ORDER = [RS_STATUS.CLASSIFIED, RS_STATUS.EXCLUDED, RS_STATUS.NOT_STARTED];

export const BUILDING_LEGEND = STATUS_ORDER.map((status) => ({ key: status, label: statusLabel(status), color: STATUS_COLORS[status] }));

export function buildingProgressRows(data) {
  const byBuilding = new Map();
  (data?.roomRows || []).forEach((r) => {
    if (!byBuilding.has(r.building)) {
      byBuilding.set(r.building, { [RS_STATUS.CLASSIFIED]: 0, [RS_STATUS.EXCLUDED]: 0, [RS_STATUS.NOT_STARTED]: 0 });
    }
    byBuilding.get(r.building)[r.status] += 1;
  });
  return Array.from(byBuilding.entries())
    .map(([building, counts]) => {
      const total = STATUS_ORDER.reduce((sum, s) => sum + counts[s], 0);
      const done = counts[RS_STATUS.CLASSIFIED] + counts[RS_STATUS.EXCLUDED];
      return {
        key: building,
        label: building,
        total,
        totalLabel: `${done} of ${total}`,
        segments: STATUS_ORDER.map((status) => ({ key: status, value: counts[status], color: STATUS_COLORS[status] })),
        tooltip: {
          title: building,
          rows: [
            ['Rooms in scope', String(total)],
            ...STATUS_ORDER.map((status) => [statusLabel(status), String(counts[status])])
          ]
        }
      };
    })
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

// --- Rooms table ---------------------------------------------------------------------
export function roomTableRows(data) {
  return (data?.roomRows || []).map((r) => {
    const orPct = r.status === RS_STATUS.CLASSIFIED ? Number(r.profile?.categoryPercentages?.OR) || 0 : null;
    return {
      key: r.roomKey,
      room: r,
      building: r.building,
      roomLabel: r.room,
      floorLabel: floorLabel(r.floor),
      roomType: r.roomType,
      sfLabel: Number.isFinite(r.areaSF) ? formatSf(r.areaSF) : '—',
      status: r.status,
      statusLabel: statusLabel(r.status),
      occupants: r.occupantCount,
      orLabel: orPct == null ? '—' : formatPct(orPct, orPct > 0 && orPct < 1 ? 1 : 0)
    };
  });
}

export function buildingOptions(data) {
  return Array.from(new Set((data?.roomRows || []).map((r) => r.building))).sort((a, b) => a.localeCompare(b));
}

export function roomTypeOptions(data) {
  return Array.from(new Set((data?.roomRows || []).map((r) => r.roomType).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export function filterRoomRows(rows, { search = '', building = '', status = '', roomType = '' } = {}) {
  const needle = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (building && r.building !== building) return false;
    if (status && r.status !== status) return false;
    if (roomType && r.roomType !== roomType) return false;
    if (needle && !`${r.building} ${r.roomLabel} ${r.roomType}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

export function roomSummaryLine(rows) {
  const notStarted = rows.filter((r) => r.status === RS_STATUS.NOT_STARTED).length;
  return `${rows.length.toLocaleString('en-US')} ${rows.length === 1 ? 'room' : 'rooms'} · ${notStarted.toLocaleString('en-US')} not started`;
}

// --- Method ------------------------------------------------------------------------------
export const METHOD_INTRO = 'F&A Compass classifies space the way a federal facilities and administrative (F&A) cost study does: '
  + 'by who uses each room and how their work is paid for, not by what the room is called.';

export const METHOD_STEPS = [
  { title: 'List who uses the room', text: 'For each room, record the people or groups who occupy it — a faculty member, a lab group, an office.' },
  { title: 'Split the room among them', text: 'Give each occupant a footprint weight: the share of the room they use. The weights in a room add up to 100%.' },
  { title: 'Say how each occupant is funded', text: 'For each occupant, split their activity by funding source (a named grant, a sponsor, or institutional funds) and assign each part to an F&A function. Each occupant adds up to 100%.' },
  { title: 'Add it up', text: "Each room's square feet are divided among the functions by those shares, then totaled across campus. Vacant or ineligible rooms are marked excluded instead." }
];

export const FUNCTION_DEFINITIONS = {
  OR: 'Research funded by an outside sponsor under a grant or contract.',
  IDR: "Teaching, plus departmental research that isn't separately budgeted.",
  OSA: 'Sponsored projects that are neither research nor instruction, such as health or community service programs.',
  OIA: 'Other institutional activities, such as residence halls, dining and athletics.',
  DA: 'Administrative work done inside academic departments.',
  GA: 'Institution-wide administration: president, finance, human resources and similar offices.',
  SPA: 'Offices that manage sponsored grants and contracts.',
  OM: 'Operating and maintaining buildings and grounds.',
  LIB: 'Library operations and space.'
};

export function methodFunctionGroups() {
  return ['direct', 'indirect'].map((group) => ({
    key: group,
    title: group === 'direct' ? 'Direct functions' : 'Indirect functions',
    items: FUNCTIONAL_CATEGORIES.filter((c) => c.group === group).map((c) => ({
      key: c.code,
      label: c.label,
      text: FUNCTION_DEFINITIONS[c.code] || ''
    }))
  }));
}

export const METHOD_RULES = [
  "Each occupant's funding adds up to 100%.",
  'The footprint weights of everyone in a room add up to 100%.',
  'Organized Research and Other Sponsored Activities need a named sponsor or grant; blank or "Institutional" funding can\'t be filed there.',
  'A room is either split among occupants or excluded as vacant or ineligible, never both.'
];

export const METHOD_SCOPE = 'Rooms in scope are every office and laboratory in the room inventory — every office and lab subtype, including '
  + "conference rooms, reception and service rooms — except buildings that no longer exist. Classrooms and other spaces aren't included.";
