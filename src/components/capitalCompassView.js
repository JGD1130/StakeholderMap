// src/components/capitalCompassView.js
//
// Display logic for the Capital Compass workspace (CapitalCompassWorkspace.jsx
// and its tabs): KPI models, tier bar rows, the priority ranking, the score
// breakdown and the funding line. Pure functions over the
// useCapitalCompassData result -- no React, no fetching. Every rule (tiers,
// cost, funding line) comes from capitalCompassCalc.js; this file only picks,
// groups and formats. Tiers are always colored MF.tier[1-4].

import { MF, utilColor } from '../theme/mfTokens';
import { computeCapitalPhasingSchedule, formatCapitalPhasingMonthYear } from '../utils/capitalPhasingImport';
import { computeNearTermCapitalPhasing, getPhasingAxisRange } from '../utils/executiveDashboardCalc';
import { PROJECT_TYPES, classifyProjectType, splitProjectName } from './mf/charts/projectTypes';
import { phasingRows, phasingLegendItems } from './executiveDashboardView';
import {
  SCORE_FIELDS,
  TIERS,
  scoredBuildings,
  computeFundingLine,
  formatUsdCompact,
  costCoverageContext,
  COST_SOURCE_TAGS
} from '../utils/capitalCompassCalc';

export const INSTITUTION_NAME = 'Hastings College';
export const WORKSPACE_TITLE = 'Capital Compass';

export const TIER_SHORT_HORIZON = { 1: '0–5 yrs', 2: '5–10 yrs', 3: '10–20 yrs', 4: 'Deferred' };

export function tierColor(level) {
  return MF.tier[level] || MF.ink.subtle;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// "A, B, C +2 more"
function listWithMore(names, max = 3) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

// Axis labels: "$0", "$500K", "$1M", "$2.5M" (no trailing .0).
export function formatUsdAxis(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1000000) return `$${Number((n / 1000000).toFixed(1))}M`;
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

export function workspaceSubtitle(data, mapBuildingCount) {
  const n = scoredBuildings(data?.buildings).length;
  return `${INSTITUTION_NAME} · ${n} of ${mapBuildingCount || n} buildings scored`;
}

// "Sep 28, 2026" from a Firestore Timestamp / date-ish value, or "—".
export function formatShortDate(value) {
  try {
    const d = value?.toDate ? value.toDate() : value ? new Date(value) : null;
    if (d && !Number.isNaN(d.getTime())) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {}
  return '—';
}

function sumKnown(buildings) {
  const known = buildings.filter((b) => b.cost.amount != null);
  return known.length ? known.reduce((s, b) => s + b.cost.amount, 0) : null;
}

// --- Overview: KPIs ------------------------------------------------------------------
// KpiCard props: { key, label, value, context?, missing? }.
export function overviewKpis(data, mapBuildingCount) {
  const scored = scoredBuildings(data?.buildings);
  const tier1 = scored.filter((b) => b.tier.level === 1);
  const tier1Need = sumKnown(tier1);
  const totalNeed = sumKnown(scored);
  const costs = (list) => list.map((b) => b.cost);

  return [
    {
      key: 'scored',
      label: 'Buildings scored',
      value: scored.length,
      context: `${scored.length} of ${mapBuildingCount || scored.length} buildings on the map`
    },
    {
      key: 'tier1',
      label: 'Tier 1 buildings',
      value: tier1.length,
      context: tier1.length ? listWithMore(tier1.map((b) => b.name)) : 'No buildings score 80+'
    },
    tier1.length && tier1Need != null
      ? { key: 'tier1Need', label: 'Tier 1 capital need', value: formatUsdCompact(tier1Need), context: costCoverageContext(costs(tier1)) }
      : { key: 'tier1Need', label: 'Tier 1 capital need', value: null, missing: { reason: tier1.length ? 'Costs not entered' : 'No Tier 1 buildings' } },
    totalNeed != null
      ? {
        key: 'totalNeed',
        label: 'Total identified need',
        value: formatUsdCompact(totalNeed),
        context: `All scored buildings · ${scored.filter((b) => b.cost.amount != null).length} of ${scored.length} costed`
      }
      : { key: 'totalNeed', label: 'Total identified need', value: null, missing: { reason: 'Costs not entered' } }
  ];
}

// --- Overview: tier bars --------------------------------------------------------------
// CategoryBars rows, Tier 1 at top.
export function tierCountRows(data) {
  const scored = scoredBuildings(data?.buildings);
  return TIERS.map((t) => {
    const count = scored.filter((b) => b.tier.level === t.level).length;
    return {
      key: `tier${t.level}`,
      label: `Tier ${t.level}`,
      sublabel: TIER_SHORT_HORIZON[t.level],
      value: count,
      valueLabel: String(count),
      color: tierColor(t.level),
      tooltip: { title: `Tier ${t.level} · ${t.range}`, rows: [['Buildings', String(count)], ['Horizon', t.horizon]] }
    };
  });
}

export function tierCostRows(data) {
  const scored = scoredBuildings(data?.buildings);
  return TIERS.map((t) => {
    const inTier = scored.filter((b) => b.tier.level === t.level);
    const total = sumKnown(inTier);
    const costedCount = inTier.filter((b) => b.cost.amount != null).length;
    return {
      key: `tier${t.level}`,
      label: `Tier ${t.level}`,
      sublabel: TIER_SHORT_HORIZON[t.level],
      value: total ?? 0,
      valueLabel: inTier.length ? formatUsdCompact(total) : '—',
      color: tierColor(t.level),
      tooltip: {
        title: `Tier ${t.level} · ${t.range}`,
        rows: [['Est. cost', formatUsdCompact(total)], ['Costed', `${costedCount} of ${inTier.length}`]]
      }
    };
  });
}

export const TIER_COST_FOOTNOTE = 'Costs from the cost rule: manual entry, else 0–5 yr deferred maintenance, else the building estimate.';

// --- Overview: priority ranking --------------------------------------------------------
export const RANKING_FOOTNOTE = 'Score = sum of 7 criteria (100 max). Tier 1 ≥ 80 · Tier 2 60–79 · Tier 3 40–59 · Tier 4 < 40.';

export function rankingRows(data) {
  return scoredBuildings(data?.buildings).map((b, i) => ({
    key: b.docId,
    rank: i + 1,
    name: b.name,
    tierLevel: b.tier.level,
    tierLabel: `Tier ${b.tier.level}`,
    color: tierColor(b.tier.level),
    score: b.total,
    horizon: TIER_SHORT_HORIZON[b.tier.level],
    costLabel: formatUsdCompact(b.cost.amount),
    sourceTag: COST_SOURCE_TAGS[b.cost.source] || null,
    updated: formatShortDate(b.updatedAt),
    breakdown: SCORE_FIELDS.map((f) => {
      const points = b.scores[f.key];
      const level = f.levels.find((l) => l.score === points);
      return {
        key: f.key,
        label: f.label,
        points,
        max: f.max,
        levelLabel: level?.label || 'Not scored',
        desc: level?.desc || ''
      };
    })
  }));
}

// --- Budget ----------------------------------------------------------------------------
// Rows in priority order with each costed building's place in the running
// total. The status follows capitalCompassCalc.js computeFundingLine exactly
// (once one building doesn't fit, everything after it is beyond budget).
export function fundingModel(data) {
  const budgetCap = Number(data?.budgetCap) || 0;
  const line = computeFundingLine(data?.buildings, budgetCap);
  const within = new Set(line.funded.map((b) => b.docId));
  let cumulative = 0;
  const rows = scoredBuildings(data?.buildings).map((b, i) => {
    const amount = b.cost.amount;
    const status = amount == null ? 'needsCost' : within.has(b.docId) ? 'within' : 'beyond';
    const start = amount == null ? null : cumulative;
    if (amount != null) cumulative += amount;
    return {
      key: b.docId,
      rank: i + 1,
      name: b.name,
      tierLevel: b.tier.level,
      amount,
      costLabel: formatUsdCompact(amount),
      source: b.cost.source,
      sourceTag: COST_SOURCE_TAGS[b.cost.source] || null,
      start,
      end: amount == null ? null : cumulative,
      status,
      statusLabel: status === 'within' ? 'Within budget' : status === 'beyond' ? 'Beyond budget' : 'Cost needed'
    };
  });
  const sum = (list) => list.reduce((s, b) => s + b.cost.amount, 0);
  return {
    rows,
    budgetCap,
    axisMax: Math.max(cumulative, budgetCap, 1),
    within: { count: line.funded.length, total: sum(line.funded) },
    beyond: { count: line.deferred.length, total: sum(line.deferred) },
    needsCostCount: line.needsCost.length
  };
}

export function budgetKpis(data, model) {
  return [
    {
      key: 'cap',
      label: 'Budget cap',
      value: formatUsdCompact(model.budgetCap),
      context: data?.budgetCapIsSaved ? 'Saved' : 'Default: every known cost'
    },
    { key: 'within', label: 'Within budget', value: `${model.within.count} · ${formatUsdCompact(model.within.total)}`, context: plural(model.within.count, 'building') },
    { key: 'beyond', label: 'Beyond budget', value: `${model.beyond.count} · ${formatUsdCompact(model.beyond.total)}`, context: plural(model.beyond.count, 'building') },
    { key: 'needsCost', label: 'Cost needed', value: model.needsCostCount, context: model.needsCostCount ? 'Enter a cost to place them' : 'Every scored building has a cost' }
  ];
}

export const FUNDING_SUBTITLE = 'Highest score first. Each bar spans where the building’s cost falls in the running total.';
export const FUNDING_FOOTNOTE = 'Once one building doesn’t fit within the budget, it and every lower-ranked building are beyond budget.';

// --- Phasing tab ------------------------------------------------------------------------
const PHASING_HORIZON_MONTHS = 24;

// Sum of a numeric field across docs, or null when none has a real amount.
function sumField(list, field) {
  const known = list
    .map((x) => x?.[field])
    .filter((v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)))
    .map(Number);
  return known.length ? known.reduce((s, n) => s + n, 0) : null;
}

export function phasingKpis(data, now = new Date()) {
  const docs = data?.phasingDocs || [];
  if (!docs.length) {
    const none = { value: null, missing: { reason: 'No phasing uploaded' } };
    return [
      { key: 'projects', label: 'Projects', ...none },
      { key: 'cost', label: 'Total cost (2026 $)', ...none },
      { key: 'escalated', label: 'Escalated total', ...none },
      { key: 'nearTerm', label: 'Starting in next 2 yrs', ...none }
    ];
  }
  const nearTerm = computeNearTermCapitalPhasing({ capitalPhasingDocs: docs, now, horizonMonths: PHASING_HORIZON_MONTHS }).nearTerm;
  return [
    { key: 'projects', label: 'Projects', value: docs.length, context: 'From the master plan phasing' },
    { key: 'cost', label: 'Total cost (2026 $)', value: formatUsdCompact(sumField(docs, 'projectCost2026')), context: 'All projects, in 2026 dollars' },
    { key: 'escalated', label: 'Escalated total', value: formatUsdCompact(sumField(docs, 'escalatedCost')), context: 'Escalated to each completion date' },
    { key: 'nearTerm', label: 'Starting in next 2 yrs', value: nearTerm.length, context: 'Work on at least one phase begins by then' }
  ];
}

// PhasingTimeline input for every project (not just near-term): each bar
// runs from the first phase's start to completion. Projects with no
// schedulable phases are left off and counted.
export function phasingTimelineModel(data, now = new Date()) {
  const items = [];
  let unschedulable = 0;
  (data?.phasingDocs || []).forEach((p) => {
    const schedule = computeCapitalPhasingSchedule(p);
    if (!schedule.length) { unschedulable += 1; return; }
    items.push({
      projectId: p.projectId,
      projectName: p.projectName,
      completionDate: p.completionDate,
      escalatedCost: p.escalatedCost,
      nextPhaseStart: schedule[0].startDate
    });
  });
  const rows = items.length ? phasingRows(items) : [];
  return {
    rows,
    legend: phasingLegendItems(rows),
    range: items.length ? getPhasingAxisRange(items, now) : null,
    unschedulable
  };
}

export const PHASING_SUBTITLE = 'All projects, from the first phase to completion';

export function phasingFootnote(unschedulable) {
  return unschedulable
    ? `${plural(unschedulable, 'project')} without phase durations ${unschedulable === 1 ? 'is' : 'are'} not shown on the timeline.`
    : null;
}

export function phasingTableRows(data) {
  return (data?.phasingDocs || []).map((p) => {
    const { building, project, sf } = splitProjectName(p.projectName);
    const type = PROJECT_TYPES[classifyProjectType(p.projectName)];
    const phases = (Array.isArray(p.phases) ? p.phases : [])
      .map((ph) => `${ph.name} ${Math.round(Number(ph.durationMonths) || 0)} mo`)
      .join(' · ');
    return {
      key: p.projectId,
      project: [project || p.projectName, Number.isFinite(sf) ? `${sf.toLocaleString('en-US')} SF` : null].filter(Boolean).join(' · '),
      building: project ? building : '—',
      typeLabel: type.label,
      typeColor: type.color,
      completion: formatCapitalPhasingMonthYear(p.completionDate) || '—',
      cost: formatUsdCompact(p.projectCost2026),
      escalated: formatUsdCompact(p.escalatedCost),
      phases: phases || '—'
    };
  });
}

// --- Deferred Maintenance tab -----------------------------------------------------------
export const DM_SEGMENTS = [
  { key: 'dm05', field: 'deferredMaint0to5', label: '0–5 yr', color: MF.util.base },
  { key: 'dm610', field: 'deferredMaint6to10', label: '6–10 yr', color: utilColor(45) }
];

export const DM_FOOTNOTE = '0–5 yr costs feed Capital Compass cost estimates.';

function dmBuildingName(d) {
  return d.matchedBuildingId || d.rawBuildingName || '—';
}

function amountOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatUsdFull(value) {
  const n = amountOrNull(value);
  return n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`;
}

export function deferredKpis(data) {
  const docs = data?.deferredMaintenanceDocs || [];
  const kpi = (key, label, field, context) => {
    const total = sumField(docs, field);
    return total == null
      ? { key, label, value: null, missing: { reason: docs.length ? 'No amounts in the upload' : 'No deferred maintenance uploaded' } }
      : { key, label, value: formatUsdCompact(total), context };
  };
  return [
    kpi('dm05', '0–5 yr total', 'deferredMaint0to5', 'Project cost, next 5 years'),
    kpi('dm610', '6–10 yr total', 'deferredMaint6to10', 'Project cost, years 6–10'),
    kpi('demo', 'Demolition total', 'demolitionProjectCost', 'Project cost'),
    kpi('reno', 'Renovation total', 'renovationConstructionCost', 'Construction cost')
  ];
}

// StackedBars rows: one per building with any 0–10 yr amount, 0–5 yr high to low.
export function deferredStackRows(data) {
  return (data?.deferredMaintenanceDocs || [])
    .map((d) => {
      const segments = DM_SEGMENTS.map((s) => ({ key: s.key, value: amountOrNull(d[s.field]) ?? 0, color: s.color }));
      const total = segments.reduce((s, x) => s + x.value, 0);
      return {
        key: d.docId,
        label: dmBuildingName(d),
        segments,
        total,
        totalLabel: formatUsdCompact(total),
        tooltip: { title: dmBuildingName(d), rows: DM_SEGMENTS.map((s) => [s.label, formatUsdCompact(d[s.field])]) }
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => (b.segments[0].value - a.segments[0].value) || (b.total - a.total) || a.label.localeCompare(b.label));
}

export function deferredTableRows(data) {
  return (data?.deferredMaintenanceDocs || [])
    .map((d) => ({
      key: d.docId,
      building: dmBuildingName(d),
      dm05: formatUsdFull(d.deferredMaint0to5),
      dm610: formatUsdFull(d.deferredMaint6to10),
      demolition: formatUsdFull(d.demolitionProjectCost),
      renovation: formatUsdFull(d.renovationConstructionCost),
      perSf: formatUsdFull(d.renovationCostPerSf),
      sortValue: amountOrNull(d.deferredMaint0to5) ?? -1
    }))
    .sort((a, b) => (b.sortValue - a.sortValue) || a.building.localeCompare(b.building));
}

// --- Setup tab ----------------------------------------------------------------------------
// Importer messages in plain language: "--" becomes "—", and a row reference
// reads "“Name” (workbook row 17): reason".
export function plainIssue(issue) {
  const reason = String(issue?.reason || '').replace(/\s*--\s*/g, ' — ').replace(/parseable/g, 'readable');
  const name = issue?.rawName && issue.rawName !== '(blank)' ? `“${issue.rawName}”` : 'A row with no name';
  const where = issue?.excelRow ? ` (workbook row ${issue.excelRow})` : '';
  return `${name}${where}: ${reason}`;
}

// Standing issues in the saved data, for the Data quality card.
export function dataQualityItems(data) {
  const items = [];
  (data?.deferredMaintenanceDocs || [])
    .filter((d) => d.matchMethod === 'unmapped' || d.matchMethod === 'blank')
    .forEach((d) => items.push({
      key: `dm-${d.docId}`,
      text: `“${d.rawBuildingName || 'Unnamed row'}” in the deferred maintenance upload doesn’t match a building on the map. Its costs count in the totals but not toward any building.`
    }));
  (data?.phasingDocs || [])
    .filter((p) => !computeCapitalPhasingSchedule(p).length)
    .forEach((p) => items.push({
      key: `ph-${p.projectId}`,
      text: `“${p.projectName}” has no completion date or phase durations, so it isn’t on the phasing timeline.`
    }));
  scoredBuildings(data?.buildings)
    .filter((b) => b.cost.amount == null)
    .forEach((b) => items.push({
      key: `cost-${b.docId}`,
      text: `${b.name} is scored but has no cost. Enter one on the Budget tab.`
    }));
  return items;
}

// --- Side-panel card ------------------------------------------------------------------------
export function panelKpis(data, mapBuildingCount) {
  const scored = scoredBuildings(data?.buildings);
  const tier1 = scored.filter((b) => b.tier.level === 1);
  const need = sumKnown(tier1);
  return [
    tier1.length && need != null
      ? { key: 'tier1Need', label: 'Tier 1 capital need', value: formatUsdCompact(need), context: costCoverageContext(tier1.map((b) => b.cost)) }
      : { key: 'tier1Need', label: 'Tier 1 capital need', value: null, missing: { reason: tier1.length ? 'Costs not entered' : 'No Tier 1 buildings' } },
    { key: 'scored', label: 'Buildings scored', value: scored.length, context: `${scored.length} of ${mapBuildingCount || scored.length}` }
  ];
}

// --- Map: "Capital Compass tiers" view --------------------------------------------------
export const MAP_LEGEND_TITLE = 'Capital Compass tiers';
export const MAP_UNSCORED_COLOR = MF.line.border;

// [[buildingName, color], ...] for a Mapbox ['match', ['get', 'id'], ...]
// expression: every fully scored building in its tier color. Names are
// unique (a match label may appear only once).
export function mapTierColorEntries(data) {
  const seen = new Set();
  const entries = [];
  scoredBuildings(data?.buildings).forEach((b) => {
    const name = String(b.name || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    entries.push([name, tierColor(b.tier.level)]);
  });
  return entries;
}

export function mapLegendRows() {
  return [
    ...TIERS.map((t) => ({ key: `tier${t.level}`, label: `Tier ${t.level}`, detail: TIER_SHORT_HORIZON[t.level], color: tierColor(t.level) })),
    { key: 'unscored', label: 'Not scored', detail: '', color: MAP_UNSCORED_COLOR }
  ];
}

// Building popup line, e.g. "Capital Compass: Tier 1 · score 94 · $385K (0–5 yr DM)".
export function mapPopupLine(data, buildingName) {
  const name = String(buildingName || '').trim();
  const b = scoredBuildings(data?.buildings).find((x) => x.name === name);
  if (!b) return 'Capital Compass: Not scored';
  const cost = b.cost.amount != null
    ? `${formatUsdCompact(b.cost.amount)}${COST_SOURCE_TAGS[b.cost.source] ? ` (${COST_SOURCE_TAGS[b.cost.source]})` : ''}`
    : 'cost not entered';
  return `Capital Compass: Tier ${b.tier.level} · score ${b.total} · ${cost}`;
}

// mapPopupLine, HTML-escaped for the Mapbox popup's HTML string.
export function mapPopupLineHtml(data, buildingName) {
  return mapPopupLine(data, buildingName)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
