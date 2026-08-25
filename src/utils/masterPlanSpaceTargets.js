// src/utils/masterPlanSpaceTargets.js
//
// Classroom Utilization module (Hastings-only). Isolated helper providing
// department-specific SF/Station and Target Utilization suggestions for the
// Space Growth / Right-Sizing "By Department" breakdown -- per Clark's
// decision, pre-populated from Hastings' own master plan's actually-
// published, department-level space standards, rather than left for every
// department to inherit the single category-level spaceConfig default.
//
// STATIC REFERENCE DATA, HARDCODED ON PURPOSE -- same pattern as
// roomTypeSuggestion.js/departmentSuggestion.js: the source is a published
// PDF document, not a live feed, so there is nothing to fetch and no
// server.js change is needed. Values below are transcribed directly from
// the master plan's own department-level space-standards table (Ideal
// SF/Station, Target Utilization, Ideal SF/Student columns).
//
// FORMULA CONFIRMATION, NOT JUST STRUCTURAL SIMILARITY: the master plan's
// own "Ideal SF/Student" column is independently, exactly reproduced by
// idealSfPerStation ÷ targetUtilizationRate for every one of the 12 rows
// below (e.g. Art: 65 ÷ 0.70 = 92.86 ~ published 93; History/Phil/Religion:
// 30 ÷ 0.70 = 42.86 ~ published 43) -- this is direct confirmation that
// spaceGrowthCalc.js's existing idealNsfPerStudent = sfPerStationTarget /
// targetUtilizationRate formula is correct, not a coincidentally similar
// but different calculation. Nothing here re-derives or stores that
// published "Ideal SF/Student" value -- it's reproduced by the existing
// formula at compute time, same as every other spaceConfig-driven row.
//
// NAMING CROSSWALK, VERIFIED AGAINST REAL LIVE DATA, NOT ASSUMED -- same
// discipline as AIRTABLE_DEPARTMENT_TO_ENROLLMENT_DEPARTMENT in
// departmentSuggestion.js. The master plan's own department column uses
// slightly different labels than the 12 real enrollmentProjections
// `department` values in three cases; departmentSuggestion.js already
// mapped Airtable's finer-grained values onto those same 12 real names and
// had that crosswalk confirmed against a live pull (see HANDOFF.md,
// 2026-08-20 "the debugging journey" entry: "Re-verified the crosswalk
// itself against a fresh live pull of real data (43/48, zero mismatches)"),
// so those already-verified real name strings are reused here as the
// authoritative target rather than re-guessed:
//   - "Music & Theatre"                       -> "Music & Theater"
//     (departmentSuggestion.js maps both 'Music' and 'Theatre' to this)
//   - "Education & Teacher Education"         -> "Education"
//     (departmentSuggestion.js maps 'Teacher Education' to this)
//   - "Physical Education & Human Performance" -> "PHEP"
//     (departmentSuggestion.js maps 'Physical Education' to this)
// All three guesses in the build request were correct once checked against
// this already-live-verified source.
//
// A FOURTH discrepancy was found in the same pass, NOT flagged in the
// build request -- worth surfacing rather than silently "fixing": the real
// enrollmentProjections department name is "History, Philosophy, & Religion"
// (comma before the ampersand -- departmentSuggestion.js line mapping
// 'History, Religion, Philosophy' -> 'History, Philosophy, & Religion'),
// while the master plan table's own column renders it without that comma
// ("History, Philosophy & Religion"). The KEY below uses the verified real
// string (with the comma) since that's what must match
// enrollmentProjections' live `department` field and roomUtilizationMeta's
// `primaryDepartment` field for a suggestion to ever be offered -- an exact
// string match, not a fuzzy one, same convention as every other suggestion
// map in this codebase.
//
// This file only computes a suggested {sfPerStationTarget,
// targetUtilizationRate} pair from a real department name. It never reads
// or writes Firestore -- ClassroomUtilizationPanel.jsx's
// DepartmentSpaceOverridesSection owns whether a suggestion is actually
// offered (only pre-filled when the department already exists in the live
// enrollmentProjections department list, same "known must exist right now"
// gate every other suggestion map in this module uses) and all persistence.
export const MASTER_PLAN_SPACE_TARGETS = {
  'Art': { sfPerStationTarget: 65, targetUtilizationRate: 0.70 },
  'History, Philosophy, & Religion': { sfPerStationTarget: 30, targetUtilizationRate: 0.70 },
  'Languages & Literatures': { sfPerStationTarget: 30, targetUtilizationRate: 0.70 },
  'Music & Theater': { sfPerStationTarget: 65, targetUtilizationRate: 0.70 },
  'Communication Studies & Political Science': { sfPerStationTarget: 30, targetUtilizationRate: 0.70 },
  'Education': { sfPerStationTarget: 30, targetUtilizationRate: 0.70 },
  'PHEP': { sfPerStationTarget: 35, targetUtilizationRate: 0.70 },
  'Psychology & Sociology': { sfPerStationTarget: 30, targetUtilizationRate: 0.70 },
  'Biology': { sfPerStationTarget: 40, targetUtilizationRate: 0.70 },
  'Business & Economics': { sfPerStationTarget: 30, targetUtilizationRate: 0.70 },
  'Chemistry & Physics': { sfPerStationTarget: 40, targetUtilizationRate: 0.70 },
  'Math & Computer Science': { sfPerStationTarget: 30, targetUtilizationRate: 0.70 }
};

// The master plan's own column label for each department, exactly as
// published, kept only for UI attribution (e.g. "master plan calls this
// 'Music & Theatre'") -- NOT used for any matching logic, which is keyed
// entirely on the real enrollmentProjections department name above.
export const MASTER_PLAN_DEPARTMENT_LABELS = {
  'Art': 'Art',
  'History, Philosophy, & Religion': 'History, Philosophy & Religion',
  'Languages & Literatures': 'Languages & Literatures',
  'Music & Theater': 'Music & Theatre',
  'Communication Studies & Political Science': 'Communication Studies & Political Science',
  'Education': 'Education & Teacher Education',
  'PHEP': 'Physical Education & Human Performance',
  'Psychology & Sociology': 'Psychology & Sociology',
  'Biology': 'Biology',
  'Business & Economics': 'Business & Economics',
  'Chemistry & Physics': 'Chemistry & Physics',
  'Math & Computer Science': 'Math & Computer Science'
};

// knownDepartmentNames: the live enrollmentProjections department-name list
// (same onSnapshot-sourced list every other suggestion map in this module
// gates on) -- required, not optional. A suggestion is only ever offered
// for a department confirmed to exist right now, same "stale map entry
// produces no suggestion rather than a value that no longer exists"
// convention as suggestPrimaryDepartmentFromAirtableDepartment.
export function getMasterPlanSpaceTarget(departmentName, knownDepartmentNames) {
  const key = String(departmentName || '').trim();
  if (!key) return null;
  const entry = MASTER_PLAN_SPACE_TARGETS[key];
  if (!entry) return null;
  const known = Array.isArray(knownDepartmentNames) ? knownDepartmentNames : [];
  return known.includes(key) ? entry : null;
}
