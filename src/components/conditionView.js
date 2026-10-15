// src/components/conditionView.js
//
// Display logic for the Capital Compass Condition tab (admin-only) and the
// "Capital Compass condition" map view: the facility condition assessment
// from building-resources.json (conditionAssessment per building, 1 = very
// poor to 5 = excellent), read through useCapitalCompassData's
// conditionEntries. Pure functions -- no React, no fetching. Tiers and costs
// come from the same hook result as the rest of Capital Compass (live tier,
// the one cost rule); nothing here changes them.
//
// Scores are colored on MF.diverging: 1 = deficit, 3 = zero, 5 = surplus,
// straight-line steps between, so 2 and 4 sit halfway. Averages use the
// same ramp continuously.

import { MF } from '../theme/mfTokens';
import { canon } from '../utils/idUtils';
import { COST_SOURCE_TAGS, formatUsdCompact } from '../utils/capitalCompassCalc';
import { tierColor } from './capitalCompassView';

export const CONDITION_SCALE_CAPTION = '1 very poor · 5 excellent';
// Averages below this round into the "Poor" band (or lower).
export const POOR_CONDITION_BELOW = 2.5;

// Entries the assessment scored as one complex: shown as one row, counted
// once in every average and KPI, and shading every matching map building.
// Display grouping only -- the data file keeps its per-building entries.
export const CONDITION_COMPLEXES = [
  { key: 'bronco-village', label: 'Bronco Village Apartments', entry: /^Bronco Village Apt\b/i, map: /^Bronco Village Apartments\b/i }
];

// The systems as the HC MP workbook groups them. Any other key found in the
// data is appended to its group, labeled from the key.
export const CONDITION_GROUPS = [
  {
    key: 'architecture',
    label: 'Architecture',
    systems: [
      ['exterior', 'Exterior'],
      ['entrances', 'Entrances'],
      ['interiorFinishes', 'Interior Finishes'],
      ['lifeSafety', 'Life Safety'],
      ['codesAccessibility', 'Codes & Accessibility'],
      ['superstructure', 'Superstructure'],
      ['conveyingSystems', 'Conveying Systems']
    ]
  },
  {
    key: 'engineering',
    label: 'Engineering',
    systems: [
      ['fireProtection', 'Fire Protection'],
      ['plumbing', 'Plumbing'],
      ['mechanical', 'Mechanical'],
      ['power', 'Power'],
      ['lighting', 'Lighting'],
      ['telecomm', 'Telecomm'],
      ['fireAlarm', 'Fire Alarm']
    ]
  },
  {
    key: 'functionality',
    label: 'Functionality',
    systems: [
      ['spaceSize', 'Space Size'],
      ['technology', 'Technology']
    ]
  }
];

const SCALE_LABELS = { 1: 'Very poor', 2: 'Poor', 3: 'Adequate', 4: 'Good', 5: 'Excellent' };

function labelFromKey(key) {
  const spaced = String(key).replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

export function formatScore(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

function listWithMore(names, max = 3) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

// --- Color ------------------------------------------------------------------------------
function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function rgbToHex(rgb) {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

function mix(a, b, t) {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  return rgbToHex(ra.map((c, i) => c + (rb[i] - c) * t));
}

// 1 -> deficit, 3 -> zero, 5 -> surplus; clamped to [1, 5].
export function conditionColor(score) {
  const s = Math.max(1, Math.min(5, Number(score)));
  if (!Number.isFinite(s)) return MF.line.border;
  return s <= 3
    ? mix(MF.diverging.deficit, MF.diverging.zero, (s - 1) / 2)
    : mix(MF.diverging.zero, MF.diverging.surplus, (s - 3) / 2);
}

function luminance(hex) {
  const lin = hexToRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Whichever of white / MF.ink.primary reads better on the cell.
export function conditionTextColor(background) {
  return contrast(background, '#ffffff') > contrast(background, MF.ink.primary) ? '#ffffff' : MF.ink.primary;
}

export function conditionLegendItems() {
  return [1, 2, 3, 4, 5].map((n) => ({ key: `c${n}`, label: `${n} ${SCALE_LABELS[n]}`, color: conditionColor(n) }));
}

// --- Model ------------------------------------------------------------------------------
// One row per building-resources entry with a condition assessment, each
// matched to a map building where its name or an alias matches.
function systemColumns(entries) {
  return CONDITION_GROUPS.map((g) => {
    const known = new Set(g.systems.map(([key]) => key));
    const extra = [];
    entries.forEach((e) => Object.keys(e.conditionAssessment?.[g.key] || {}).forEach((key) => {
      if (!known.has(key)) { known.add(key); extra.push([key, labelFromKey(key)]); }
    }));
    return {
      key: g.key,
      label: g.label,
      systems: [...g.systems, ...extra].map(([key, label]) => ({ id: `${g.key}.${key}`, group: g.key, key, label }))
    };
  });
}

function matchMapName(entry, buildingNames) {
  const aliases = new Set(entry.aliases || []);
  return buildingNames.find((name) => aliases.has(canon(name))) || null;
}

function entryRow(e, systems, buildingNames) {
  const ca = e.conditionAssessment;
  const scores = Object.fromEntries(systems.map((s) => {
    const v = Number(ca[s.group]?.[s.key]);
    return [s.id, Number.isFinite(v) ? v : null];
  }));
  const rated = Object.values(scores).filter((v) => v != null);
  const mapName = matchMapName(e, buildingNames);
  return {
    key: e.building,
    name: e.building,
    mapNames: mapName ? [mapName] : [],
    complex: false,
    average: Number.isFinite(ca.averageScore) ? ca.averageScore : mean(rated),
    scores,
    notes: ca.notes || '',
    sourceLabel: ca.sourceLabel || '',
    updatedAt: ca.updatedAt || ''
  };
}

// One row for a complex: each system and the average is the mean across its
// entries (identical today), every map building matching the complex.
function complexRow(complex, members, systems, buildingNames) {
  const meanOf = (pick) => mean(members.map(pick).filter((v) => v != null));
  const notes = [...new Set(members.map((m) => m.notes).filter(Boolean))].join(' · ');
  return {
    key: complex.key,
    name: `${complex.label} (${members.length} buildings)`,
    mapNames: buildingNames.filter((n) => complex.map.test(n)),
    complex: true,
    average: meanOf((m) => m.average),
    scores: Object.fromEntries(systems.map((s) => [s.id, meanOf((m) => m.scores[s.id])])),
    notes,
    sourceLabel: members[0].sourceLabel,
    updatedAt: members[0].updatedAt
  };
}

export function conditionModel(data, buildingNames = []) {
  const entries = (data?.conditionEntries || []).filter((e) => e?.conditionAssessment);
  const groups = systemColumns(entries);
  const systems = groups.flatMap((g) => g.systems);

  const single = [];
  const byComplex = new Map();
  entries.forEach((e) => {
    const row = entryRow(e, systems, buildingNames);
    const complex = CONDITION_COMPLEXES.find((c) => c.entry.test(e.building));
    if (!complex) { single.push(row); return; }
    if (!byComplex.has(complex)) byComplex.set(complex, []);
    byComplex.get(complex).push(row);
  });
  const complexRows = [...byComplex].map(([c, members]) => complexRow(c, members, systems, buildingNames));

  const rows = [...single, ...complexRows]
    .filter((r) => r.average != null)
    .sort((a, b) => (a.average - b.average) || a.name.localeCompare(b.name));

  const systemAverages = Object.fromEntries(systems.map((s) => [
    s.id,
    mean(rows.map((r) => r.scores[s.id]).filter((v) => v != null))
  ]));
  const campusAverage = mean(rows.map((r) => r.average));
  const onMap = new Set(rows.flatMap((r) => r.mapNames));

  return { groups, systems, rows, systemAverages, campusAverage, onMapCount: onMap.size, mapBuildingCount: buildingNames.length };
}

// --- KPIs -------------------------------------------------------------------------------
export function conditionKpis(model) {
  const { rows, systems, systemAverages, campusAverage } = model;
  if (!rows.length) {
    const none = { value: null, missing: { reason: 'No condition assessment loaded' } };
    return [
      { key: 'assessed', label: 'Buildings assessed', ...none },
      { key: 'campus', label: 'Campus average', ...none },
      { key: 'poor', label: 'Buildings in poor condition', ...none },
      { key: 'weakest', label: 'Weakest system', ...none }
    ];
  }
  const notOnMap = rows.filter((r) => !r.mapNames.length).length;
  const complexes = rows.filter((r) => r.complex);
  const poor = rows.filter((r) => r.average < POOR_CONDITION_BELOW);
  const ranked = systems
    .filter((s) => systemAverages[s.id] != null)
    .sort((a, b) => systemAverages[a.id] - systemAverages[b.id]);
  // Systems tied with the weakest at one decimal.
  const weakestLabel = ranked.length ? formatScore(systemAverages[ranked[0].id]) : null;
  const weakest = ranked.filter((s) => formatScore(systemAverages[s.id]) === weakestLabel);
  const groupLabel = (s) => CONDITION_GROUPS.find((g) => g.key === s.group)?.label || '';
  const assessedNotes = [
    `${model.onMapCount} of ${model.mapBuildingCount || model.onMapCount} on the map`,
    ...complexes.map((r) => `${r.name.replace(/\s*\(.*\)$/, '')} counted once`),
    notOnMap ? `${notOnMap} not matched to a map building` : null
  ].filter(Boolean);

  return [
    { key: 'assessed', label: 'Buildings assessed', value: rows.length, context: assessedNotes.join(' · ') },
    { key: 'campus', label: 'Campus average', value: formatScore(campusAverage), context: CONDITION_SCALE_CAPTION },
    {
      key: 'poor',
      label: `Buildings in poor condition · average below ${POOR_CONDITION_BELOW.toFixed(1)}`,
      value: poor.length,
      context: poor.length
        ? listWithMore(poor.map((r) => r.name))
        : `None · lowest ${rows[0].name} ${formatScore(rows[0].average)}`
    },
    !weakest.length
      ? { key: 'weakest', label: 'Weakest system', value: null, missing: { reason: 'No system scores' } }
      : weakest.length === 1
        ? { key: 'weakest', label: 'Weakest system', value: weakest[0].label, context: `${groupLabel(weakest[0])} · campus average ${weakestLabel}` }
        : {
          key: 'weakest',
          label: 'Weakest systems',
          value: weakest.map((s) => `${s.label} ${weakestLabel}`).join(' · '),
          context: `Tied at campus average ${weakestLabel} · ${[...new Set(weakest.map(groupLabel))].join(', ')}`
        }
  ];
}

// --- Matrix -----------------------------------------------------------------------------
export function conditionCell(score, isAverage = false) {
  if (score == null) return { label: '—', background: MF.surface.card, color: MF.ink.subtle };
  const background = conditionColor(score);
  return {
    label: isAverage || !Number.isInteger(score) ? formatScore(score) : String(score),
    background,
    color: conditionTextColor(background)
  };
}

export function conditionTooltip(buildingName, systemLabel, score) {
  return {
    title: buildingName,
    rows: [[systemLabel, score == null ? 'Not rated' : `${formatScore(score)} of 5${Number.isInteger(score) ? ` · ${SCALE_LABELS[score]}` : ''}`]]
  };
}

// --- Building table ---------------------------------------------------------------------
// "Lowest systems": up to 3 systems below the building's own average, lowest
// first (a building rated evenly has none).
function lowestSystems(row, systems) {
  return systems
    .map((s, i) => ({ s, i, v: row.scores[s.id] }))
    .filter((x) => x.v != null && x.v < row.average)
    .sort((a, b) => (a.v - b.v) || (a.i - b.i))
    .slice(0, 3)
    .map((x) => `${x.s.label} ${x.v}`);
}

// A complex's tier shows only when every scored member shares it; its cost
// is the sum of its members' known costs (each from the same cost rule).
function rowTier(names, priorities) {
  const levels = [...new Set(names.map((n) => priorities.get(n)?.tier?.level).filter(Boolean))];
  if (levels.length === 1) return { label: `Tier ${levels[0]}`, color: tierColor(levels[0]) };
  if (levels.length > 1) return { label: 'Mixed tiers', color: null };
  return { label: 'Not scored', color: null };
}

function rowCost(names, data) {
  const costs = typeof data?.costFor === 'function' ? names.map((n) => data.costFor(n)).filter((c) => c?.amount != null) : [];
  if (!costs.length) return { amount: null, tag: null };
  const sources = [...new Set(costs.map((c) => COST_SOURCE_TAGS[c.source]).filter(Boolean))];
  const coverage = names.length > 1 ? ` · ${costs.length} of ${names.length} costed` : '';
  return { amount: costs.reduce((s, c) => s + c.amount, 0), tag: `${sources.join(' + ')}${coverage}` || null };
}

export function conditionTableRows(model, data) {
  const priorities = new Map((data?.buildings || []).map((b) => [b.name, b]));
  return model.rows.map((r) => {
    const names = r.mapNames.length ? r.mapNames : [r.name];
    const tier = rowTier(names, priorities);
    const cost = rowCost(names, data);
    return {
      key: r.key,
      name: r.name,
      onMap: r.mapNames.length > 0,
      average: r.average,
      averageLabel: formatScore(r.average),
      lowest: lowestSystems(r, model.systems).join(', ') || '—',
      notes: r.notes || '—',
      tierLabel: tier.label,
      tierColor: tier.color,
      costLabel: formatUsdCompact(cost.amount),
      sourceTag: cost.tag
    };
  });
}

// --- Footnote ---------------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-04-01" -> "Apr 2026" (read as written, not through Date, so no
// timezone shift).
function monthYear(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

export function conditionSourceFootnote(model) {
  const seen = new Set();
  const sources = [];
  model.rows.forEach((r) => {
    const label = r.sourceLabel.replace(/\.(xlsx|xls|csv)$/i, '').trim();
    const text = [label, monthYear(r.updatedAt)].filter(Boolean).join(', ');
    if (text && !seen.has(text)) { seen.add(text); sources.push(text); }
  });
  return sources.length ? `Source: ${sources.join('; ')}.` : null;
}

export const CONDITION_MATRIX_NOTE = '— = not rated in the assessment (e.g. no elevator). Average is the mean of the rated systems.';

// --- Map: "Capital Compass condition" view ------------------------------------------------
export const CONDITION_MAP_LEGEND_TITLE = 'Capital Compass condition';
export const CONDITION_MAP_UNASSESSED_COLOR = MF.line.border;

// [[mapBuildingName, color], ...] for a Mapbox ['match', ['get', 'id'], ...].
export function mapConditionColorEntries(data, buildingNames) {
  const seen = new Set();
  const entries = [];
  conditionModel(data, buildingNames).rows.forEach((r) => {
    r.mapNames.forEach((name) => {
      if (seen.has(name)) return;
      seen.add(name);
      entries.push([name, conditionColor(r.average)]);
    });
  });
  return entries;
}

export function conditionMapLegendRows() {
  return [
    ...[1, 2, 3, 4, 5].map((n) => ({ key: `c${n}`, label: String(n), detail: SCALE_LABELS[n], color: conditionColor(n) })),
    { key: 'unassessed', label: 'Not assessed', detail: '', color: CONDITION_MAP_UNASSESSED_COLOR }
  ];
}

// Building popup line, e.g. "Condition: 2.7 average (1 very poor · 5 excellent)".
export function mapConditionPopupLineHtml(data, buildingName, buildingNames) {
  const name = String(buildingName || '').trim();
  const row = conditionModel(data, buildingNames).rows.find((r) => r.mapNames.includes(name));
  const text = row
    ? `Condition: ${formatScore(row.average)} average (${CONDITION_SCALE_CAPTION})${row.complex ? ' · assessed as one complex' : ''}`
    : 'Condition: Not assessed';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
