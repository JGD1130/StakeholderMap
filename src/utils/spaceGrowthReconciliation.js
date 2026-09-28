// src/utils/spaceGrowthReconciliation.js
//
// TEMPORARY (Phase 5.2 investigation, dev builds only) -- REMOVE once the
// campus vs. division space gap difference is understood. Called from
// useSpaceGrowthData.js behind import.meta.env.DEV; prints to the console,
// changes nothing.
//
// Explains why the campus gap (computeSpaceGrowth, all tagged rooms, need
// priced on campus-wide headcount/FTE) differs from the division total
// (computeDepartmentSpaceGrowth summed by academic division, only
// category x department pairs that have a tagged room). The buckets below
// are built so they add up to exactly (campus - divisions); "anything left
// over" is the remainder, and its known parts are listed separately.

import { buildRoomUtilizationMetaKey } from './roomUtilizationMeta';

function sum(list, fn) {
  return list.reduce((s, x) => s + (Number(fn(x)) || 0), 0);
}

function round(n) {
  return Number.isFinite(n) ? Math.round(n) : n;
}

export function printSpaceGrowthReconciliation({
  targetYear,
  campusBefore, // computeSpaceGrowth result without the Office fix
  campusAfter, // computeSpaceGrowth result with the Office fix
  campusLive, // the campus result actually shown (per PRICE_OFFICE_IN_CAMPUS_GAP) -- part c reconciles this one
  officePricedLive,
  department, // computeDepartmentSpaceGrowth result
  divisions, // computeDivisionSpaceGapSummary result
  roomUtilizationMetaDocs,
  airtableAreaByRoomKey,
  enrollmentProjectionDocs
}) {
  const divisionByDept = new Map();
  const academicDepartments = [];
  (enrollmentProjectionDocs || []).forEach((d) => {
    const division = String(d?.division || '').trim();
    const dept = String(d?.department || '').trim();
    if (!division || !dept || division.toLowerCase() === 'overall') return;
    if (!divisionByDept.has(dept)) academicDepartments.push(dept);
    divisionByDept.set(dept, division);
  });
  const deptHeadcount = (dept) => {
    const doc = (enrollmentProjectionDocs || []).find((d) => String(d?.department || '').trim() === dept && String(d?.division || '').trim().toLowerCase() !== 'overall');
    const n = Number(doc?.years?.[String(targetYear)]?.studentHeadcount);
    return Number.isFinite(n) ? n : null;
  };

  const campusRows = campusLive.rows;
  const campusByCategory = new Map(campusRows.map((r) => [r.category, r]));
  const inCampus = (c) => campusByCategory.get(c)?.gapTarget != null;
  // Office = FTE-based in the fixed campus calc or in any department pair,
  // so it's identified the same way whether or not the live figure prices it.
  const isOffice = (c) => campusAfter.rows.some((r) => r.category === c && r.formulaType === 'fte')
    || department.rows.some((r) => r.category === c && r.formulaType === 'fte');

  const campusTotal = sum(campusRows.filter((r) => r.gapTarget != null), (r) => r.gapTarget);
  const divisionTotal = sum(divisions.filter((d) => d.gapTarget != null), (d) => d.gapTarget);
  const difference = campusTotal - divisionTotal;

  // Division rows = department rows whose department has a division.
  const divisionRows = department.rows.filter((r) => divisionByDept.has(r.department));

  // --- Buckets -------------------------------------------------------------
  let noDepartment = 0;
  let outsideDivisions = 0;
  (roomUtilizationMetaDocs || []).forEach((m) => {
    const category = String(m?.spaceCategory || '').trim();
    if (!category || isOffice(category) || !inCampus(category)) return;
    const roomKey = m?.roomKey || buildRoomUtilizationMetaKey(m?.building, m?.room);
    const area = airtableAreaByRoomKey?.get?.(roomKey);
    if (!Number.isFinite(area) || area <= 0) return;
    const dept = String(m?.primaryDepartment || '').trim();
    if (!dept) noDepartment += area;
    else if (!divisionByDept.has(dept)) outsideDivisions += area;
  });

  let noTaggedRoomNeed = 0;
  let rateDifferences = 0;
  const leftoverParts = { excludedPairs: 0, categoriesOnlyInDivisions: 0, unitMismatch: 0 };
  campusRows.forEach((c) => {
    if (c.gapTarget == null || isOffice(c.category)) return;
    const rate = c.idealNsfPerStudent;
    academicDepartments.forEach((dept) => {
      const pair = divisionRows.find((r) => r.category === c.category && r.department === dept);
      const units = deptHeadcount(dept);
      if (!pair) {
        if (units != null) noTaggedRoomNeed -= rate * units;
      } else if (pair.gapTarget != null) {
        rateDifferences += pair.idealSfTarget - rate * pair.targetEnrollment;
      } else {
        leftoverParts.excludedPairs += pair.currentSF - (units != null ? rate * units : 0);
      }
    });
    const campusUnits = campusLive.targetEnrollment;
    const deptUnits = sum(academicDepartments, (d) => deptHeadcount(d));
    if (Number.isFinite(campusUnits)) leftoverParts.unitMismatch -= rate * (campusUnits - deptUnits);
  });
  divisionRows.forEach((r) => {
    if (r.gapTarget != null && !isOffice(r.category) && !inCampus(r.category)) leftoverParts.categoriesOnlyInDivisions -= r.gapTarget;
  });

  const officeCategories = [...new Set([...campusRows.map((r) => r.category), ...divisionRows.map((r) => r.category)])].filter(isOffice);
  const office = sum(officeCategories, (c) => (inCampus(c) ? campusByCategory.get(c).gapTarget : 0))
    - sum(divisionRows.filter((r) => isOffice(r.category) && r.gapTarget != null), (r) => r.gapTarget);

  const explicit = noDepartment + outsideDivisions + noTaggedRoomNeed + rateDifferences + office;
  const leftover = difference - explicit;

  const campusTable = (result) => result.rows.map((r) => ({
    category: r.category,
    formula: r.formulaType === 'fte' ? 'SF/FTE' : 'SF/student',
    rate: r.idealNsfPerStudent != null ? Math.round(r.idealNsfPerStudent * 100) / 100 : 'not set',
    taggedRooms: r.taggedRoomCount,
    currentSF: round(r.currentSF),
    [`need${targetYear}`]: round(r.idealSfTarget),
    [`gap${targetYear}`]: round(r.gapTarget)
  }));

  console.info(`%cSpace Growth reconciliation (DEV ONLY, temporary) — ${targetYear}`, 'font-weight:bold');
  console.info('a) Campus gap by category — BEFORE the Office fix (total', round(sum(campusBefore.rows.filter((r) => r.gapTarget != null), (r) => r.gapTarget)), 'SF)');
  console.table(campusTable(campusBefore));
  console.info('a) Campus gap by category — AFTER the Office fix (total', round(sum(campusAfter.rows.filter((r) => r.gapTarget != null), (r) => r.gapTarget)), 'SF)');
  console.table(campusTable(campusAfter));
  console.info('b) Division gap by category × department (total', round(divisionTotal), 'SF)');
  console.table(department.rows.map((r) => ({
    category: r.category,
    department: r.department,
    division: divisionByDept.get(r.department) || '(none)',
    target: r.usingDepartmentOverride ? 'dept override' : 'category default',
    formula: r.formulaType === 'fte' ? 'SF/FTE' : 'SF/student',
    rate: r.idealNsfPerStudent != null ? Math.round(r.idealNsfPerStudent * 100) / 100 : 'not set',
    taggedRooms: r.taggedRoomCount,
    currentSF: round(r.currentSF),
    [`need${targetYear}`]: round(r.idealSfTarget),
    [`gap${targetYear}`]: round(r.gapTarget),
    inDivisionTotal: divisionByDept.has(r.department) && r.gapTarget != null
  })));
  console.info(`c) Reconciliation of the LIVE campus figure (Office ${officePricedLive ? 'priced' : 'NOT priced'} — PRICE_OFFICE_IN_CAMPUS_GAP = ${officePricedLive}): campus ${round(campusTotal)} − divisions ${round(divisionTotal)} = ${round(difference)} SF`);
  console.table([
    { bucket: 'Rooms with no department (their SF counts on campus only)', sf: round(noDepartment) },
    { bucket: 'Rooms outside the 3 academic divisions', sf: round(outsideDivisions) },
    { bucket: 'Need for pairs where a department has no tagged room of that category', sf: round(noTaggedRoomNeed) },
    { bucket: 'Target-rate differences (department overrides vs. category defaults)', sf: round(rateDifferences) },
    { bucket: 'Office (FTE-based)', sf: round(office) },
    { bucket: 'Anything left over', sf: round(leftover) },
    { bucket: '= Total (should equal campus − divisions)', sf: round(explicit + leftover) }
  ]);
  console.info('   Left over, known parts:', {
    'pairs with tagged rooms but no gap (missing target/enrollment)': round(leftoverParts.excludedPairs),
    'categories priced only in the divisions': round(leftoverParts.categoriesOnlyInDivisions),
    'campus headcount vs. sum of department headcounts': round(leftoverParts.unitMismatch),
    'unexplained': round(leftover - leftoverParts.excludedPairs - leftoverParts.categoriesOnlyInDivisions - leftoverParts.unitMismatch)
  });
}
