// src/utils/spaceGrowthCalc.js
//
// Classroom Utilization module (Hastings-only). Isolated, framework-agnostic
// helper for the Space Growth / Right-Sizing section (roadmap item beyond
// the original 6) -- per space category, computes Current SF (sum of
// Airtable area for rooms tagged with that category in roomUtilizationMeta),
// Ideal SF now and at a target year (category's Ideal NSF/Student times
// institution-wide enrollment for that year), and both gaps.
//
// Per Clark's explicit decision, this first version uses INSTITUTION-WIDE
// enrollment only, not department-specific -- deliberately ignores the 12
// per-department enrollmentProjections records even though they exist in
// the same collection, and only reads the single "Overall" record. Every
// consumer of this module's output must keep that caveat visible in the UI
// (ClassroomUtilizationPanel.jsx does, in the section intro text) so it's
// never mistaken for more precise than it is.
//
// "Ideal NSF/Student" is DERIVED, not a direct pass-through of any single
// spaceConfig field -- per the original spec: sfPerStationTarget divided by
// targetUtilizationRate (both already-existing spaceConfig fields, no new
// field added, Space Configuration itself untouched). E.g. a 25 SF/station
// target at a 70% target utilization rate means the space actually needs to
// be PROVISIONED at 25/0.7 = 35.71 SF/student to still hit that utilization
// once real-world scheduling slack is accounted for -- using sfPerStationTarget
// alone (an earlier version of this file's bug, caught in review before this
// module was ever exercised against real numbers) silently understates Ideal
// SF, and therefore understates the gap, by exactly the utilization factor.
// A zero/missing/non-positive targetUtilizationRate is treated as "not set"
// (division skipped, Ideal NSF/Student is null), same convention as a
// missing sfPerStationTarget -- never divide by zero, never fabricate a
// derived value from an incomplete input.
//
// Pure computation over already-fetched plain data; ClassroomUtilizationPanel.jsx
// owns every Firestore read, the Airtable fetch, and all rendering.

import { buildRoomUtilizationMetaKey } from './roomUtilizationMeta';

// Institution-wide enrollment (Net Student Headcount) for a given year, from
// an already-fetched list of enrollmentProjections docs. Deliberately keys
// off division === "Overall" (not a hardcoded deptId) so it still resolves
// correctly even if the deterministic id format ever changes -- matches only
// the one institution-wide record, per Clark's decision, and ignores every
// per-department record in the same collection.
export function getInstitutionWideEnrollment(enrollmentProjectionDocs, year) {
  const overall = (Array.isArray(enrollmentProjectionDocs) ? enrollmentProjectionDocs : [])
    .find((d) => String(d?.division || '').trim().toLowerCase() === 'overall');
  if (!overall) return null;
  const yearData = overall.years?.[String(year)];
  const headcount = Number(yearData?.studentHeadcount);
  return Number.isFinite(headcount) ? headcount : null;
}

// spaceConfigDocs: [{category, sfPerStationTarget, targetUtilizationRate}]
// (category = spaceConfig doc id, same convention RoomUtilizationMetaSection's
// categoryOptions use; targetUtilizationRate is a 0-1 fraction, same as
// SpaceConfigSection stores it).
//
// roomUtilizationMetaDocs: [{roomKey, spaceCategory}] -- only rows with a
// non-blank spaceCategory are ever considered; an untagged room (blank
// spaceCategory) never contributes to any category's total, per explicit
// instruction. A tagged room whose Airtable area can't be resolved (no
// match, or area <=0) is also excluded rather than counted as 0 SF -- same
// "don't fabricate a number for missing data" convention as everywhere else
// in this module (see classroomUtilizationCalc.js's seatUtilizationStatus).
//
// airtableAreaByRoomKey: Map(roomKey -> areaSF), from
// classroomUtilizationCalc.js's buildAirtableAreaMap().
export function computeSpaceGrowth({
  spaceConfigDocs,
  roomUtilizationMetaDocs,
  airtableAreaByRoomKey,
  baselineYear,
  targetYear,
  enrollmentProjectionDocs
}) {
  const baselineEnrollment = getInstitutionWideEnrollment(enrollmentProjectionDocs, baselineYear);
  const targetEnrollment = getInstitutionWideEnrollment(enrollmentProjectionDocs, targetYear);

  const taggedByCategory = new Map(); // category -> { currentSF, roomCount }
  (Array.isArray(roomUtilizationMetaDocs) ? roomUtilizationMetaDocs : []).forEach((docEntry) => {
    const category = String(docEntry?.spaceCategory || '').trim();
    if (!category) return; // untagged -- never contributes to any category's total
    const roomKey = docEntry?.roomKey || buildRoomUtilizationMetaKey(docEntry?.building, docEntry?.room);
    if (!roomKey) return;
    const areaSF = airtableAreaByRoomKey?.get?.(roomKey);
    if (!Number.isFinite(areaSF) || areaSF <= 0) return; // no resolvable area -- excluded, not counted as 0
    if (!taggedByCategory.has(category)) taggedByCategory.set(category, { currentSF: 0, roomCount: 0 });
    const agg = taggedByCategory.get(category);
    agg.currentSF += areaSF;
    agg.roomCount += 1;
  });

  const rows = (Array.isArray(spaceConfigDocs) ? spaceConfigDocs : []).map(({ category, sfPerStationTarget, targetUtilizationRate }) => {
    const sfPerStation = Number(sfPerStationTarget);
    const hasSfPerStation = Number.isFinite(sfPerStation) && sfPerStation > 0;
    const utilizationRate = Number(targetUtilizationRate);
    const hasUtilizationRate = Number.isFinite(utilizationRate) && utilizationRate > 0;

    // Ideal NSF/Student = SF/station target ÷ target utilization rate. Both
    // inputs must be present and positive -- a missing/zero utilization rate
    // means "not set", not "divide by zero" or "fall back to sfPerStation
    // alone" (that fallback is exactly the bug this replaced).
    const idealNsfPerStudent = hasSfPerStation && hasUtilizationRate
      ? sfPerStation / utilizationRate
      : null;

    const tagged = taggedByCategory.get(category) || { currentSF: 0, roomCount: 0 };

    const idealSfNow = idealNsfPerStudent != null && Number.isFinite(baselineEnrollment)
      ? idealNsfPerStudent * baselineEnrollment
      : null;
    const idealSfTarget = idealNsfPerStudent != null && Number.isFinite(targetEnrollment)
      ? idealNsfPerStudent * targetEnrollment
      : null;

    return {
      category,
      // Raw inputs passed through (independently of whether both are
      // present) so the UI can show exactly which one is missing/zero
      // rather than a single opaque "not set" -- see the header comment.
      sfPerStationTarget: hasSfPerStation ? sfPerStation : null,
      targetUtilizationRate: hasUtilizationRate ? utilizationRate : null,
      idealNsfPerStudent,
      currentSF: tagged.currentSF,
      taggedRoomCount: tagged.roomCount,
      idealSfNow,
      gapNow: idealSfNow != null ? tagged.currentSF - idealSfNow : null,
      idealSfTarget,
      gapTarget: idealSfTarget != null ? tagged.currentSF - idealSfTarget : null
    };
  });

  return {
    rows,
    baselineYear,
    targetYear,
    baselineEnrollment,
    targetEnrollment
  };
}

// Department-specific enrollment (Net Student Headcount) for a given
// department name and year. Matches against enrollmentProjectionDocs'
// `department` field (e.g. "Art"), same field enrollmentProjectionsImport.js
// populates -- and explicitly EXCLUDES division === "Overall" so the
// institution-wide record (department: "Hastings College Overall") can never
// be matched here by accident; that record isn't a real department a room
// can be tagged with. Case-insensitive/trimmed match, same convention as
// getInstitutionWideEnrollment above. A department name with no matching
// doc, or no data for the requested year, returns null -- "not set", never
// fabricated.
export function getDepartmentEnrollment(enrollmentProjectionDocs, departmentName, year) {
  const target = String(departmentName || '').trim().toLowerCase();
  if (!target) return null;
  const match = (Array.isArray(enrollmentProjectionDocs) ? enrollmentProjectionDocs : [])
    .find((d) => (
      String(d?.division || '').trim().toLowerCase() !== 'overall'
      && String(d?.department || '').trim().toLowerCase() === target
    ));
  if (!match) return null;
  const yearData = match.years?.[String(year)];
  const headcount = Number(yearData?.studentHeadcount);
  return Number.isFinite(headcount) ? headcount : null;
}

// Department-level breakdown of the same Space Growth / Right-Sizing
// calculation above -- ADDITIVE, not a replacement. computeSpaceGrowth()
// (institution-wide, per-category) is untouched and keeps working exactly as
// before; this groups the same tagged rooms by (spaceCategory,
// primaryDepartment) pair instead of by spaceCategory alone, and prices each
// pair's Ideal SF against that specific department's own enrollment
// (getDepartmentEnrollment above) rather than the single institution-wide
// "Overall" record.
//
// Only emits a row for a (category, department) pair that has >=1 tagged
// room contributing resolved Airtable area -- no full cross-product of every
// category x every department. A tagged room with a spaceCategory but a
// blank primaryDepartment can't be attributed to any department pair, so
// it's excluded from `rows` entirely and counted in the returned
// `taggedRoomsMissingDepartment` instead, so the UI can flag it visibly --
// it still counts normally in computeSpaceGrowth()'s institution-wide table,
// which reads spaceCategory only and never looks at primaryDepartment at
// all.
//
// roomUtilizationMetaDocs: same shape computeSpaceGrowth takes -- now also
// carrying a `primaryDepartment` field per doc (added to RoomUtilizationMetaDoc,
// see classroomUtilizationSchema.js). Same "excluded rather than counted as 0
// SF" convention as computeSpaceGrowth for a tagged room whose Airtable area
// can't be resolved.
export function computeDepartmentSpaceGrowth({
  spaceConfigDocs,
  roomUtilizationMetaDocs,
  airtableAreaByRoomKey,
  baselineYear,
  targetYear,
  enrollmentProjectionDocs
}) {
  const spaceConfigByCategory = new Map(
    (Array.isArray(spaceConfigDocs) ? spaceConfigDocs : []).map((entry) => [entry.category, entry])
  );

  const pairAgg = new Map(); // "category||department" -> { category, department, currentSF, roomCount }
  let taggedRoomsMissingDepartment = 0;

  (Array.isArray(roomUtilizationMetaDocs) ? roomUtilizationMetaDocs : []).forEach((docEntry) => {
    const category = String(docEntry?.spaceCategory || '').trim();
    if (!category) return; // untagged -- out of scope for both this and the institution-wide table
    const roomKey = docEntry?.roomKey || buildRoomUtilizationMetaKey(docEntry?.building, docEntry?.room);
    if (!roomKey) return;
    const areaSF = airtableAreaByRoomKey?.get?.(roomKey);
    if (!Number.isFinite(areaSF) || areaSF <= 0) return; // no resolvable area -- excluded, not counted as 0

    const department = String(docEntry?.primaryDepartment || '').trim();
    if (!department) {
      // Has a category and resolvable area, just no department -- still
      // counted normally in computeSpaceGrowth's institution-wide table
      // (unaffected by this function), just not attributable to a
      // (category, department) pair here.
      taggedRoomsMissingDepartment += 1;
      return;
    }

    const pairKey = `${category}||${department}`;
    if (!pairAgg.has(pairKey)) pairAgg.set(pairKey, { category, department, currentSF: 0, roomCount: 0 });
    const agg = pairAgg.get(pairKey);
    agg.currentSF += areaSF;
    agg.roomCount += 1;
  });

  const rows = Array.from(pairAgg.values()).map(({ category, department, currentSF, roomCount }) => {
    const spaceConfigEntry = spaceConfigByCategory.get(category);
    const sfPerStation = Number(spaceConfigEntry?.sfPerStationTarget);
    const hasSfPerStation = Number.isFinite(sfPerStation) && sfPerStation > 0;
    const utilizationRate = Number(spaceConfigEntry?.targetUtilizationRate);
    const hasUtilizationRate = Number.isFinite(utilizationRate) && utilizationRate > 0;

    // Same Ideal NSF/Student derivation as computeSpaceGrowth -- the
    // category's target, not anything department-specific (spaceConfig has
    // no per-department targets).
    const idealNsfPerStudent = hasSfPerStation && hasUtilizationRate
      ? sfPerStation / utilizationRate
      : null;

    const baselineEnrollment = getDepartmentEnrollment(enrollmentProjectionDocs, department, baselineYear);
    const targetEnrollment = getDepartmentEnrollment(enrollmentProjectionDocs, department, targetYear);

    const idealSfNow = idealNsfPerStudent != null && Number.isFinite(baselineEnrollment)
      ? idealNsfPerStudent * baselineEnrollment
      : null;
    const idealSfTarget = idealNsfPerStudent != null && Number.isFinite(targetEnrollment)
      ? idealNsfPerStudent * targetEnrollment
      : null;

    return {
      category,
      department,
      sfPerStationTarget: hasSfPerStation ? sfPerStation : null,
      targetUtilizationRate: hasUtilizationRate ? utilizationRate : null,
      idealNsfPerStudent,
      currentSF,
      taggedRoomCount: roomCount,
      baselineEnrollment,
      idealSfNow,
      gapNow: idealSfNow != null ? currentSF - idealSfNow : null,
      targetEnrollment,
      idealSfTarget,
      gapTarget: idealSfTarget != null ? currentSF - idealSfTarget : null
    };
  });

  rows.sort((a, b) => a.category.localeCompare(b.category) || a.department.localeCompare(b.department));

  return {
    rows,
    baselineYear,
    targetYear,
    taggedRoomsMissingDepartment
  };
}
