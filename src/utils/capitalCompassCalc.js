// src/utils/capitalCompassCalc.js
//
// Capital Compass rules, in one place: the scoring rubric (7 criteria, 100
// pts), the ONLY copy of the tier thresholds, the building cost rule, the
// score suggestions, the Tier 1 summary and the budget funding line. Pure
// functions over plain data -- no Firestore, no React. Used by
// useCapitalCompassData.js, CapitalPrioritiesPanel.jsx and the Executive
// Dashboard.
//
// Scoring rubric and tier thresholds are taken verbatim from the Capital
// Compass reference tool:
//   Tier 1: 80-100  (Short-term, 0-5 yrs)  -- fund immediately
//   Tier 2: 60-79   (Mid-term, 5-10 yrs)   -- advance planning/funding/grants
//   Tier 3: 40-59   (Long-term, 10-20 yrs) -- continue planning, reassess at CIP updates
//   Tier 4: <40     (Deferred / opportunistic) -- reevaluate scope/funding/strategic importance
//
// Tier, horizon and action are always computed live from a building's total
// (getTier). Saved capitalPriorities docs also carry tier/tierHorizon/
// tierAction fields frozen at save time; nothing reads those.

import { firstCurrencyValue } from './currency';

export const SCORE_FIELDS = [
  {
    key: 'criticalCoreService',
    label: 'Critical Core Service',
    fullName: 'Criticality to mission & safety',
    max: 25,
    levels: [
      { score: 25, label: 'Immediate threat', desc: 'Immediate threat to life safety, regulatory compliance, or continuity of academic/research operations' },
      { score: 20, label: '3-5 yr risk', desc: 'Major degradation of instructional, research, or clinical capacity likely within 3-5 years' },
      { score: 15, label: 'Noticeable', desc: 'Noticeable impacts to academic operations, research productivity, or asset reliability' },
      { score: 8, label: 'Minor', desc: 'Minor or limited impact on core academic or research functions' }
    ]
  },
  {
    key: 'publicBenefit',
    label: 'Public Benefit',
    fullName: 'Student & institutional benefit',
    max: 20,
    levels: [
      { score: 20, label: 'System/institution-wide', desc: 'Benefit spans multiple campuses or the full student/faculty population' },
      { score: 15, label: 'Multi-college', desc: 'Significant benefit to multiple colleges, departments, or large user groups' },
      { score: 10, label: 'Department/program', desc: 'Moderate benefit to a defined department, program, or user group' },
      { score: 5, label: 'Limited', desc: 'Limited benefit to a small or specialized group' }
    ]
  },
  {
    key: 'organizationalCapacity',
    label: 'Organizational Capacity',
    fullName: 'Operational capacity & efficiency',
    max: 15,
    levels: [
      { score: 15, label: 'Transformational', desc: 'Transformational improvement to research capacity, instructional delivery, or operational efficiency' },
      { score: 10, label: 'Significant', desc: 'Significant operational improvement' },
      { score: 7, label: 'Moderate', desc: 'Moderate efficiency gains' },
      { score: 2, label: 'Minor', desc: 'Minor or no measurable institutional benefit' }
    ]
  },
  {
    key: 'financialDelayCost',
    label: 'Financial Delay Cost',
    fullName: 'Financial impact of delay',
    max: 15,
    levels: [
      { score: 15, label: 'Substantial', desc: 'Delay substantially increases costs, deferred maintenance backlog, or risk of asset failure' },
      { score: 10, label: 'Moderate', desc: 'Moderate escalation or increased project complexity expected' },
      { score: 7, label: 'Manageable', desc: 'Manageable cost increases expected' },
      { score: 2, label: 'Minimal', desc: 'Minimal financial consequence if delayed' }
    ]
  },
  {
    key: 'fundingLeverage',
    label: 'Funding Leverage',
    fullName: 'Funding availability & leverage',
    max: 10,
    levels: [
      { score: 10, label: '>50% external', desc: 'More than 50% of project cost potentially funded via grants, gifts, or indirect cost recovery' },
      { score: 8, label: 'Strong leverage', desc: 'Significant grant, philanthropic, or partnership funding opportunity' },
      { score: 5, label: 'Moderate', desc: 'Moderate funding leverage available' },
      { score: 1, label: 'Limited', desc: 'Limited or no outside funding source available' }
    ]
  },
  {
    key: 'politicalReadiness',
    label: 'Political Readiness',
    fullName: 'Board & stakeholder expectations',
    max: 10,
    levels: [
      { score: 10, label: 'High visibility', desc: 'Strong Board of Regents, donor, or legislative visibility and expectation' },
      { score: 8, label: 'Broad support', desc: 'Broad stakeholder support and visibility' },
      { score: 5, label: 'Moderate', desc: 'Moderate stakeholder interest' },
      { score: 1, label: 'Limited', desc: 'Limited stakeholder awareness or support' }
    ]
  },
  {
    key: 'readinessScore',
    label: 'Readiness Score',
    fullName: 'Project readiness',
    max: 5,
    levels: [
      { score: 5, label: 'Ready', desc: 'Design complete, permits secured, funding identified, ready to proceed' },
      { score: 4, label: 'Advanced', desc: 'Advanced planning complete' },
      { score: 3, label: 'Preliminary', desc: 'Preliminary planning complete' },
      { score: 1, label: 'Concept', desc: 'Early-stage concept or undefined project' }
    ]
  }
];

export const TIERS = [
  { level: 1, range: '80-100', horizon: 'Short-term (0-5 years)', action: 'Fund immediately or position for immediate implementation' },
  { level: 2, range: '60-79', horizon: 'Mid-term (5-10 years)', action: 'Advance planning, design, funding development, and grant pursuit' },
  { level: 3, range: '40-59', horizon: 'Long-term (10-20 years)', action: 'Continue planning and reassess during future CIP updates' },
  { level: 4, range: 'Below 40', horizon: 'Deferred / opportunistic', action: 'Reevaluate scope, funding, and strategic importance' }
];

// The only copy of the tier thresholds. null for a building that isn't fully
// scored (no numeric total).
export function getTier(total) {
  if (typeof total !== 'number' || !Number.isFinite(total)) return null;
  if (total >= 80) return TIERS[0];
  if (total >= 60) return TIERS[1];
  if (total >= 40) return TIERS[2];
  return TIERS[3];
}

// capitalPriorities / deferredMaintenanceBuildings doc id for a building
// name: slashes aren't allowed in a Firestore doc id.
export function sanitizeBuildingDocId(buildingId) {
  return String(buildingId || '').trim().replace(/\//g, '__');
}

// "$1.2M" / "$450K" / "$900". A missing value is "—", never "$0" (Number(null)
// is 0); a real $0 is "$0".
export function formatUsdCompact(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

// --- Cost rule -------------------------------------------------------------------
export const COST_SOURCE_LABELS = {
  manual: 'manual entry',
  'dm-0-5': '0–5 yr deferred maint.',
  static: 'deferred maint. estimate'
};

// Short source tags for tables and mixed-source text.
export const COST_SOURCE_TAGS = {
  'dm-0-5': '0–5 yr DM',
  manual: 'manual',
  static: 'static'
};

// KPI context for a set of buildings' costs, e.g.
// "0–5 yr deferred maintenance · 3 of 4 costed", or, when the costed ones
// use more than one source, "0–5 yr DM + manual · 3 of 4 costed".
// items: [{ amount, source }]. Shared by the Capital Compass workspace and the
// Executive Dashboard's Tier 1 capital need card (screen and PDF).
export function costCoverageContext(items) {
  const list = Array.isArray(items) ? items : [];
  const costed = list.filter((c) => c.amount != null);
  const sources = Object.keys(COST_SOURCE_TAGS).filter((s) => costed.some((c) => c.source === s));
  let sourceText;
  if (!sources.length) sourceText = 'No costs entered';
  else if (sources.length === 1 && sources[0] === 'dm-0-5') sourceText = '0–5 yr deferred maintenance';
  else sourceText = sources.map((s) => COST_SOURCE_TAGS[s]).join(' + ');
  return `${sourceText} · ${costed.length} of ${list.length} costed`;
}

// A building's estimated capital cost, first match wins:
//   1. saved manual cost (capitalCompassSettings/budget.manualCosts)
//   2. uploaded deferred maintenance, 0-5 yr project cost
//      (deferredMaintenanceBuildings, keyed by sanitizeBuildingDocId)
//   3. building-resources.json deferred maintenance total (totalCost, then
//      totalHigh, then totalLow)
//   4. none
// manualCosts: { [buildingName]: amount }. deferredMaintenance: { [docId]: doc }.
// staticResources: (buildingName) => building-resources.json entry | null.
export function resolveBuildingCost(buildingId, { manualCosts, deferredMaintenance, staticResources } = {}) {
  const manual = Number(manualCosts?.[buildingId]);
  if (Number.isFinite(manual) && manual > 0) return { amount: manual, source: 'manual' };

  const dm = deferredMaintenance?.[sanitizeBuildingDocId(buildingId)];
  const dmAmount = dm ? firstCurrencyValue([dm.deferredMaint0to5]) : null;
  if (dmAmount != null) return { amount: dmAmount, source: 'dm-0-5' };

  const entry = typeof staticResources === 'function' ? staticResources(buildingId) : null;
  const deferred = entry?.deferredMaintenance;
  const staticAmount = deferred ? firstCurrencyValue([deferred.totalCost, deferred.totalHigh, deferred.totalLow]) : null;
  if (staticAmount != null) return { amount: staticAmount, source: 'static' };

  return { amount: null, source: null };
}

// --- Score suggestions -----------------------------------------------------------
// Starting-point scores the user can accept or override; never saved on
// their own.
const FINANCIAL_DELAY_COST_LEVELS_ASC = [...SCORE_FIELDS.find((f) => f.key === 'financialDelayCost').levels].reverse();
const CRITICAL_CORE_SERVICE_LEVELS_ASC = [...SCORE_FIELDS.find((f) => f.key === 'criticalCoreService').levels].reverse();

// cost: resolveBuildingCost's result. priorityLabel: building-resources.json's
// deferred-maintenance priority ("Very High" / "High" / "Medium" / "Low").
// Dollar buckets line up with Hastings' priority labels (Very High ~$2.6-2.9M,
// High ~$1.2-1.8M, Medium ~$345-789K, Low ~$18-297K); the higher of the two
// signals wins, and either alone is enough.
export function suggestFinancialDelayCost(cost, priorityLabel) {
  const amount = Number.isFinite(cost?.amount) ? cost.amount : null;

  const priorityText = String(priorityLabel || '').toLowerCase();
  let priorityTier = null;
  if (priorityText.includes('very high')) priorityTier = 3;
  else if (priorityText.includes('high')) priorityTier = 2;
  else if (priorityText.includes('medium') || priorityText.includes('moderate')) priorityTier = 1;
  else if (priorityText.includes('low')) priorityTier = 0;

  let costTier = null;
  if (amount != null) {
    if (amount >= 2000000) costTier = 3;
    else if (amount >= 1000000) costTier = 2;
    else if (amount >= 300000) costTier = 1;
    else costTier = 0;
  }

  if (priorityTier == null && costTier == null) return null;
  const level = FINANCIAL_DELAY_COST_LEVELS_ASC[Math.max(priorityTier ?? -1, costTier ?? -1)];

  const parts = [];
  if (priorityLabel) parts.push(`${priorityLabel} priority`);
  if (amount != null) parts.push(`~${formatUsdCompact(amount)} ${COST_SOURCE_LABELS[cost.source] || 'estimated cost'}`);
  return { score: level.score, levelLabel: level.label, rationale: parts.join(', ') || 'cost data' };
}

// Lower Life Safety and/or lower overall average condition (1 = very poor,
// 5 = excellent, building-resources.json's scale) suggest higher criticality.
export function suggestCriticalCoreService(lifeSafetyScore, averageScore) {
  let lsTier = null;
  if (Number.isFinite(lifeSafetyScore)) {
    if (lifeSafetyScore <= 2) lsTier = 3;
    else if (lifeSafetyScore <= 3) lsTier = 2;
    else if (lifeSafetyScore <= 4) lsTier = 1;
    else lsTier = 0;
  }
  let avgTier = null;
  if (Number.isFinite(averageScore)) {
    if (averageScore <= 2.5) avgTier = 3;
    else if (averageScore <= 3.25) avgTier = 2;
    else if (averageScore <= 4) avgTier = 1;
    else avgTier = 0;
  }

  if (lsTier == null && avgTier == null) return null;
  const level = CRITICAL_CORE_SERVICE_LEVELS_ASC[Math.max(lsTier ?? -1, avgTier ?? -1)];

  const parts = [];
  if (Number.isFinite(lifeSafetyScore)) parts.push(`Life Safety ${lifeSafetyScore}/5`);
  if (Number.isFinite(averageScore)) parts.push(`avg condition ${averageScore.toFixed(1)}/5`);
  return { score: level.score, levelLabel: level.label, rationale: parts.join(', ') || 'condition data' };
}

// --- Portfolio --------------------------------------------------------------------
// buildings: useCapitalCompassData's `buildings` (one per capitalPriorities
// doc, with live tier and resolved cost). Returns the fully scored ones,
// highest total first.
export function scoredBuildings(buildings) {
  return (Array.isArray(buildings) ? buildings : [])
    .filter((b) => b.tier)
    .sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
}

export function totalKnownCost(buildings) {
  return scoredBuildings(buildings).reduce((sum, b) => sum + (Number.isFinite(b.cost.amount) ? b.cost.amount : 0), 0);
}

// Funding line: walk buildings highest score first, funding each while the
// running cost stays within budgetCap; the first one that doesn't fit, and
// everything after it, is Deferred. Buildings with no cost can't be placed.
export function computeFundingLine(buildings, budgetCap) {
  const funded = [];
  const deferred = [];
  const needsCost = [];
  let cumulative = 0;
  let cutoff = false;
  scoredBuildings(buildings).forEach((b) => {
    if (b.cost.amount == null) {
      needsCost.push(b);
      return;
    }
    if (!cutoff) {
      const next = cumulative + b.cost.amount;
      if (next <= budgetCap) {
        cumulative = next;
        funded.push(b);
        return;
      }
      cutoff = true;
    }
    deferred.push(b);
  });
  return { funded, deferred, needsCost };
}

// Executive Dashboard Tier 1 summary, same shape it has always used:
// { tier1Buildings: [{ buildingId, originalId, total, resolvedCost, costSource }],
//   tier1Count, totalKnownCost (null when no Tier 1 building has a cost),
//   knownCostCount, unresolvedCostCount }.
export function computeTier1Summary(buildings) {
  const tier1Buildings = scoredBuildings(buildings)
    .filter((b) => b.tier.level === 1)
    .map((b) => ({
      buildingId: b.docId,
      originalId: b.name,
      total: b.total,
      resolvedCost: b.cost.amount,
      costSource: b.cost.source
    }));
  const withCost = tier1Buildings.filter((b) => b.resolvedCost != null);
  return {
    tier1Buildings,
    tier1Count: tier1Buildings.length,
    totalKnownCost: withCost.length ? withCost.reduce((sum, b) => sum + b.resolvedCost, 0) : null,
    knownCostCount: withCost.length,
    unresolvedCostCount: tier1Buildings.length - withCost.length
  };
}
