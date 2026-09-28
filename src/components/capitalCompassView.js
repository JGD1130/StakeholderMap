// src/components/capitalCompassView.js
//
// Display logic for the Capital Compass workspace (CapitalCompassWorkspace.jsx
// and its tabs): KPI models, tier bar rows, the priority ranking, the score
// breakdown and the funding line. Pure functions over the
// useCapitalCompassData result -- no React, no fetching. Every rule (tiers,
// cost, funding line) comes from capitalCompassCalc.js; this file only picks,
// groups and formats. Tiers are always colored MF.tier[1-4].

import { MF } from '../theme/mfTokens';
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
