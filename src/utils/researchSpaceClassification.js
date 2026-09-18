// src/utils/researchSpaceClassification.js
//
// Research Space Classification module (Hastings-only, new). Isolated,
// framework-agnostic helpers (no Firestore imports) for the F&A space-survey
// functional-use classification -- occupant-based, not simple room-level
// percentages, per Clark's real domain expertise. Same isolation convention
// as classroomUtilizationCalc.js / roomUtilizationMeta.js: this file is pure
// computation over plain data; ResearchSpaceClassificationPanel.jsx owns the
// actual Firestore reads/writes.
//
// The 9 real functional-use categories (Clark's spec, 2026-09-17) -- every
// funding-source row on every occupant must be one of these. Two more
// "categories" exist but are NOT part of this list on purpose: Vacant/
// Unassigned and Ineligible/Non-Assignable are room-level EXCLUSION states
// (a room gets one of those INSTEAD of a percentage split, when the whole
// room doesn't apply to the survey), never a funding-source category -- see
// ROOM_EXCLUSION_STATUSES below.
export const FUNCTIONAL_CATEGORIES = [
  { code: 'OR', label: 'Organized Research', group: 'direct' },
  { code: 'IDR', label: 'Instruction and Departmental Research', group: 'direct' },
  { code: 'OSA', label: 'Other Sponsored Activities', group: 'direct' },
  { code: 'OIA', label: 'Other Institutional Activities', group: 'direct' },
  { code: 'DA', label: 'Departmental Administration', group: 'indirect' },
  { code: 'GA', label: 'General Administration and General Expense', group: 'indirect' },
  { code: 'SPA', label: 'Sponsored Projects Administration', group: 'indirect' },
  { code: 'OM', label: 'Operations and Maintenance', group: 'indirect' },
  { code: 'LIB', label: 'Library', group: 'indirect' }
];

export const FUNCTIONAL_CATEGORY_CODES = FUNCTIONAL_CATEGORIES.map((c) => c.code);

export const FUNCTIONAL_CATEGORY_LABEL_BY_CODE = FUNCTIONAL_CATEGORIES.reduce((acc, c) => {
  acc[c.code] = c.label;
  return acc;
}, {});

export function isValidFunctionalCategoryCode(code) {
  return FUNCTIONAL_CATEGORY_CODES.includes(code);
}

// Room-level exclusion states -- mutually exclusive with the occupant model.
// A room in one of these states carries no occupants/fundingSources at all;
// it is simply not part of the percentage-classified survey.
export const ROOM_EXCLUSION_STATUSES = [
  { code: 'vacant_unassigned', label: 'Vacant / Unassigned' },
  { code: 'ineligible_non_assignable', label: 'Ineligible / Non-Assignable' }
];
export const ROOM_EXCLUSION_STATUS_CODES = ROOM_EXCLUSION_STATUSES.map((s) => s.code);

// Instruction Default rule (guardrail, enforced here -- not just a UI
// suggestion): the two categories that represent real external grant
// funding require a real, named grant/sponsor in the source field. A blank
// source or the literal word "Institutional" can never be filed under
// Organized Research or Other Sponsored Activities.
const GRANT_REQUIRING_CATEGORY_CODES = new Set(['OR', 'OSA']);

function isBlankOrInstitutional(source) {
  const s = String(source || '').trim().toLowerCase();
  return !s || s === 'institutional';
}

// Both Golden Rules use the same tolerance -- floating-point percentage
// arithmetic (e.g. three occupants at 33.33%) will never land on exactly
// 100.000... -- 0.01 percentage points is tight enough to catch a real
// data-entry error (e.g. forgetting a row) while absorbing rounding noise.
const PERCENT_TOLERANCE = 0.01;

function sumPercentages(items, key) {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => sum + (Number(item?.[key]) || 0), 0);
}

// Golden Rule 1: each occupant's own fundingSources percentages must sum to
// exactly 100%.
export function validateFundingSourcesSumTo100(fundingSources) {
  const total = sumPercentages(fundingSources, 'percentage');
  const diff = Math.round((total - 100) * 100) / 100;
  return { valid: Math.abs(diff) <= PERCENT_TOLERANCE, total, diff };
}

// Golden Rule 2: all occupants within a given room's footprintWeight values
// must sum to exactly 100%.
export function validateFootprintWeightsSumTo100(occupants) {
  const total = sumPercentages(occupants, 'footprintWeight');
  const diff = Math.round((total - 100) * 100) / 100;
  return { valid: Math.abs(diff) <= PERCENT_TOLERANCE, total, diff };
}

// Instruction Default validation: enforced on save, not just suggested in
// the UI. Returns every offending row so the UI can flag them individually
// rather than a single generic error.
export function validateInstructionDefaultRule(fundingSources) {
  const errors = [];
  (Array.isArray(fundingSources) ? fundingSources : []).forEach((row, index) => {
    if (!GRANT_REQUIRING_CATEGORY_CODES.has(row?.category)) return;
    if (isBlankOrInstitutional(row?.source)) {
      const label = FUNCTIONAL_CATEGORY_LABEL_BY_CODE[row.category] || row.category;
      errors.push({
        index,
        message: `Row ${index + 1}: "${label}" requires a real grant/sponsor name in the source field -- it cannot be blank or "Institutional".`
      });
    }
  });
  return { valid: errors.length === 0, errors };
}

// Full pre-save validation for one occupant doc (both rules that apply at
// the occupant level -- the cross-occupant footprint-weight rule is
// validated separately, at the room level, by validateFootprintWeightsSumTo100
// against every occupant sharing a roomKey).
export function validateOccupant(occupant) {
  const fundingSourcesSum = validateFundingSourcesSumTo100(occupant?.fundingSources);
  const instructionDefault = validateInstructionDefaultRule(occupant?.fundingSources);
  return {
    valid: fundingSourcesSum.valid && instructionDefault.valid,
    fundingSourcesSum,
    instructionDefault
  };
}

// Occupant-level -> room-level contribution: this occupant's footprintWeight
// share of the room, multiplied through each of their funding-source
// percentages. footprintWeight and percentage are both 0-100 scale; dividing
// footprintWeight by 100 turns it into a fraction of the room so the result
// lands back on the same 0-100 "percent of room" scale as the room rollup.
//
// Example (footprintWeight 20%, funding source 80% -> DA): contribution to
// the room's DA total = (20 / 100) * 80 = 16 percentage points of the room.
export function computeOccupantCategoryContributions(occupant) {
  const weight = Number(occupant?.footprintWeight) || 0;
  const contributions = {};
  (Array.isArray(occupant?.fundingSources) ? occupant.fundingSources : []).forEach((row) => {
    const category = row?.category;
    if (!isValidFunctionalCategoryCode(category)) return;
    const pct = Number(row?.percentage) || 0;
    contributions[category] = (contributions[category] || 0) + (weight / 100) * pct;
  });
  return contributions;
}

// Computed room-level rollup -- derived on the fly from an already-fetched
// occupants array, not stored redundantly. This is what actually gets
// displayed/reported: blended functional profile per room = weighted sum of
// every occupant's functional-category percentages x their footprint weight.
export function computeRoomFunctionalProfile(occupants) {
  const categoryPercentages = {};
  (Array.isArray(occupants) ? occupants : []).forEach((occupant) => {
    const contributions = computeOccupantCategoryContributions(occupant);
    Object.entries(contributions).forEach(([category, value]) => {
      categoryPercentages[category] = (categoryPercentages[category] || 0) + value;
    });
  });
  const totalPercent = Object.values(categoryPercentages).reduce((sum, v) => sum + v, 0);
  return { categoryPercentages, totalPercent };
}

// Organized Research SF for one room -- the headline F&A-relevant figure,
// computed from the room's own Airtable area (areaSF) x its blended OR
// percentage. Returns null (not 0) when areaSF is unknown, so a room with no
// area on file is visibly excluded from the SF rollup rather than silently
// contributing 0.
export function computeRoomOrganizedResearchSF(areaSF, categoryPercentages) {
  const area = Number(areaSF);
  if (!Number.isFinite(area) || area <= 0) return null;
  const orPct = Number(categoryPercentages?.OR) || 0;
  return area * (orPct / 100);
}

// Campus-wide rollup across every classified room (rooms with either a
// computed occupant profile or an exclusion status). roomEntries:
// [{ roomKey, areaSF, occupants, exclusionStatus }].
export function computeResearchSpaceRollup(roomEntries) {
  const rows = Array.isArray(roomEntries) ? roomEntries : [];
  const classifiedRows = rows.filter((r) => r.exclusionStatus || (Array.isArray(r.occupants) && r.occupants.length > 0));
  const categoryTotals = {};
  let totalOrganizedResearchSF = 0;
  let knownAreaSF = 0;
  classifiedRows.forEach((row) => {
    if (row.exclusionStatus) return; // excluded rooms carry no category percentages
    const { categoryPercentages } = computeRoomFunctionalProfile(row.occupants);
    const area = Number(row.areaSF);
    const hasArea = Number.isFinite(area) && area > 0;
    if (hasArea) knownAreaSF += area;
    Object.entries(categoryPercentages).forEach(([category, pct]) => {
      if (!hasArea) return; // can't convert a percentage into SF without a known area
      categoryTotals[category] = (categoryTotals[category] || 0) + area * (pct / 100);
    });
    const orSF = computeRoomOrganizedResearchSF(row.areaSF, categoryPercentages);
    if (orSF != null) totalOrganizedResearchSF += orSF;
  });
  return {
    roomCountInScope: rows.length,
    roomCountClassified: classifiedRows.length,
    roomCountRemaining: rows.length - classifiedRows.length,
    totalOrganizedResearchSF,
    knownAreaSF,
    categoryTotalsSF: categoryTotals
  };
}
