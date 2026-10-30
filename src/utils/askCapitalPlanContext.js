// src/utils/askCapitalPlanContext.js
//
// Compact Capital Compass context for Ask Mapfluence (admin only): phasing
// projects, uploaded deferred maintenance, priority scores/tiers and the
// condition assessment, from the same useCapitalCompassData result the
// Capital Compass workspace uses. Pure functions -- no React, no fetching.
//
// Each project gets a status from its dates vs. today, so the answer can say
// "completed per the capital plan" without anything being hard-coded:
//   completion month passed       -> "completed per plan"
//   approximate start passed      -> "underway"
//   otherwise                     -> "planned"
// The start is the completion month minus the phase durations (phases run
// back to back, as on the Phasing tab).
import { classifyProjectType, splitProjectName, PROJECT_TYPES } from '../components/mf/charts/projectTypes';
import { CONDITION_COMPLEXES } from '../components/conditionView';

const DEFERRED_MAINTENANCE_COST_FIELDS = [
  ['demolitionProjectCost', 'demolitionCost'],
  ['deferredMaint0to5', 'deferredMaint0to5yrProjectCost'],
  ['deferredMaint0to5ConstructionCost', 'deferredMaint0to5yrConstructionCost'],
  ['deferredMaint6to10', 'deferredMaint6to10yrProjectCost'],
  ['deferredMaint6to10ConstructionCost', 'deferredMaint6to10yrConstructionCost'],
  ['renovationCostPerSf', 'renovationCostPerSf'],
  ['renovationConstructionCost', 'renovationConstructionCost']
];

export const CAPITAL_PLAN_INSTRUCTIONS =
  'capitalPlan holds the campus capital plan. Cite capitalPlan.projects as "Capital phasing plan" and ' +
  'capitalPlan.deferredMaintenance as "Deferred maintenance upload" (in dataUsed and in the answer). ' +
  'A project\'s type comes from its project name (e.g. a name containing "Demolition" is a demolition project). ' +
  'Each project has a status computed from its dates vs. today ("completed per plan", "underway", "planned"): ' +
  'use that status and phrase it as "per the capital plan" (e.g. "completed per the capital plan"), never as ' +
  'confirmed fact. Phasing project costs (projectCost2026, escalatedCost, and the dollar amounts inside phase ' +
  'names) and deferred maintenance demolitionCost are separate estimates from different sources and may ' +
  'differ for the same building: whenever you give a cost, label which figure it is and its source, and do not ' +
  'add them together. Priority tiers (capitalPlan.priorities) and condition scores (capitalPlan.condition, ' +
  '1 very poor to 5 excellent) are separate Capital Compass inputs.';

// "YYYY-MM-01" -> { y, m } (m 1-12), or null.
function parseMonth(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) };
}

function shiftMonths({ y, m }, delta) {
  const index = (y * 12) + (m - 1) + delta;
  return { y: Math.floor(index / 12), m: (index % 12) + 1 };
}

function formatMonth(month) {
  return month ? `${month.y}-${String(month.m).padStart(2, '0')}` : '';
}

function monthStart(month) {
  return new Date(month.y, month.m - 1, 1);
}

function projectStatus(start, completion, now) {
  if (!completion) return 'planned';
  if (monthStart(completion) <= now) return 'completed per plan';
  if (start && monthStart(start) <= now) return 'underway';
  return 'planned';
}

function costOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function buildAskCapitalPlanProjects(phasingDocs, now = new Date()) {
  return (Array.isArray(phasingDocs) ? phasingDocs : []).map((p) => {
    const name = String(p?.projectName || '').trim();
    const { building, project, sf } = splitProjectName(name);
    const phases = Array.isArray(p?.phases) ? p.phases : [];
    const totalMonths = phases.reduce((sum, ph) => sum + (Number(ph?.durationMonths) || 0), 0);
    const completion = parseMonth(p?.completionDate);
    const start = completion && totalMonths ? shiftMonths(completion, -totalMonths) : null;
    const notes = (Array.isArray(p?.notes) ? p.notes : []).map((n) => String(n || '').trim()).filter(Boolean);
    const phaseText = phases
      .map((ph) => `${String(ph?.name || '').trim()} ${Number(ph?.durationMonths) || 0}mo`)
      .join('; ');
    return {
      project: name,
      building,
      scope: project,
      type: PROJECT_TYPES[classifyProjectType(name)]?.label || '',
      sf: sf ?? null,
      approxStart: formatMonth(start),
      completion: formatMonth(completion),
      status: projectStatus(start, completion, now),
      projectCost2026: costOrNull(p?.projectCost2026),
      escalatedCost: costOrNull(p?.escalatedCost),
      phases: notes.length ? `${phaseText} | ${notes.join('; ')}` : phaseText
    };
  });
}

// Non-null cost fields only; rows with no costs are dropped.
export function buildAskDeferredMaintenance(deferredMaintenanceDocs) {
  return (Array.isArray(deferredMaintenanceDocs) ? deferredMaintenanceDocs : [])
    .map((d) => {
      const row = { building: String(d?.matchedBuildingId || d?.rawBuildingName || d?.docId || '').trim() };
      DEFERRED_MAINTENANCE_COST_FIELDS.forEach(([field, label]) => {
        const n = Number(d?.[field]);
        if (d?.[field] == null || d[field] === '' || !Number.isFinite(n)) return;
        // Whole dollars (the upload carries float noise); $/sf keeps cents.
        row[label] = field === 'renovationCostPerSf' ? Math.round(n * 100) / 100 : Math.round(n);
      });
      return row;
    })
    .filter((row) => Object.keys(row).length > 1);
}

export function buildAskPriorities(buildings) {
  return (Array.isArray(buildings) ? buildings : []).map((b) => ({
    building: b.name,
    totalScore: b.total,
    tier: b.tier ? `Tier ${b.tier.level} - ${b.tier.horizon}` : null
  }));
}

// One row per complex (the assessment repeats the complex score on each
// apartment building), one per building otherwise.
export function buildAskCondition(conditionEntries) {
  const seenComplexes = new Set();
  const out = [];
  (Array.isArray(conditionEntries) ? conditionEntries : []).forEach((entry) => {
    const name = String(entry?.building || '').trim();
    const complex = CONDITION_COMPLEXES.find((c) => c.entry.test(name));
    if (complex) {
      if (seenComplexes.has(complex.key)) return;
      seenComplexes.add(complex.key);
    }
    const avg = Number(entry?.conditionAssessment?.averageScore);
    out.push({
      building: complex ? complex.label : name,
      averageScore: Number.isFinite(avg) ? Math.round(avg * 100) / 100 : null,
      note: String(entry?.conditionAssessment?.notes || '').trim()
    });
  });
  return out;
}

// capitalCompassData: useCapitalCompassData's result. null unless ready.
export function buildAskCapitalPlan(capitalCompassData, now = new Date()) {
  if (capitalCompassData?.status !== 'ready') return null;
  return {
    asOf: `${formatMonth({ y: now.getFullYear(), m: now.getMonth() + 1 })}-${String(now.getDate()).padStart(2, '0')}`,
    projects: buildAskCapitalPlanProjects(capitalCompassData.phasingDocs, now),
    deferredMaintenance: buildAskDeferredMaintenance(capitalCompassData.deferredMaintenanceDocs),
    priorities: buildAskPriorities(capitalCompassData.buildings),
    condition: buildAskCondition(capitalCompassData.conditionEntries)
  };
}
