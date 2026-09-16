// src/utils/deferredMaintenanceImport.js
//
// Deferred Maintenance import (Capital Priorities sub-section). Real per-
// building deferred maintenance dollar figures from the master plan's cost
// estimate workbook, HC_MP_-_Cost_Estimate_Backup.xlsx, sheet
// "Summary (Revised)".
//
// Confirmed real header structure (from direct inspection of the actual
// file) is TWO rows, not one flat row: row 6 carries a per-column sub-label
// ("EXISTING BUILDING", "Project Cost", "Construction Cost",
// "Const. Cost/SF"), and row 5 (the row directly above) carries the
// category each sub-label column belongs to (Demolition / 0-5yr / 6-10yr /
// Renovation), sometimes merged across the 2 columns it groups -- SheetJS
// only populates a merged range's top-left cell, so category text is
// forward-filled left-to-right to cover the merge. Exact verified column
// mapping: B=building name, C=Demolition Project Cost, D=0-5yr Construction
// Cost, E=0-5yr Project Cost, F=6-10yr Construction Cost, G=6-10yr Project
// Cost, H=Renovation Cost/SF, I=Renovation Construction Cost. This parser
// does NOT hardcode those letters -- it locates the header block
// structurally (anchored on "EXISTING BUILDING", which is unique and
// unambiguous, since "Project Cost"/"Construction Cost" alone repeat across
// groups and can't anchor a row by themselves) so a future re-export with
// shifted columns still parses correctly as long as the same two-row shape
// holds. The same SheetJS "!ref bounding-box" column-shift gotcha
// documented in capitalPhasingImport.js's root-cause note is guarded
// against here too (forcedRange starting at column A).
//
// The headline dollar figure per bucket (deferredMaint0to5 /
// deferredMaint6to10) uses the Project Cost column, not Construction Cost
// -- Project Cost is the more complete figure (includes soft costs), per
// Clark's explicit instruction. Construction Cost is retained alongside it
// as a secondary figure, not discarded, since it's real data from a
// distinct real column.
//
// Building-name crosswalk: the source sheet uses short/abbreviated names
// for some buildings that don't match the real GeoJSON building names used
// everywhere else in Capital Priorities (Hastings_College_Buildings.geojson,
// via the buildingFeatures/realBuildingNames the panel already has). The
// pairs below are a confirmed real crosswalk from direct inspection of the
// actual file, not a guess. Any sheet name that doesn't resolve via exact
// match OR this crosswalk is treated as UNMAPPED -- its dollar figures are
// still imported and still counted toward campus totals, but flagged
// visibly ("no mapped location") in the UI rather than silently dropped or
// omitted. This is how the known real case (Jack Osborne Track Complex --
// real deferred-maintenance data, no corresponding building footprint in
// the GeoJSON) is handled, and it generalizes correctly to any other name
// a future version of the file introduces that this crosswalk doesn't yet
// cover.
import { canon } from './idUtils';
import * as XLSX from 'xlsx';

export const DEFERRED_MAINTENANCE_SHEET_NAME = 'Summary (Revised)';

// canon(shortName) -> real building name. Each target must match a
// Hastings_College_Buildings.geojson feature's properties.id/name exactly
// after trim -- verified against the real 41-building list before this
// crosswalk was written.
const BUILDING_NAME_CROSSWALK = {
  [canon('Daugherty Center')]: 'Daugherty Student Engagement Center',
  [canon('Hurley-McDonald')]: 'Hurley-McDonald Hall',
  [canon('Morrison-Reeves')]: 'Morrison-Reeves Science Center',
  [canon('French Memorial Chapel')]: 'Calvin H. French Memorial Chapel',
  [canon('Stone Health Center')]: 'The Stone Health Center',
  [canon('Babcock Hall')]: 'Babcock Hall Residence',
  [canon('Taylor Hall')]: 'Taylor Hall Residence',
  [canon('Altman Hall')]: 'Altman Hall Residency',
  [canon('Bronc Hall')]: 'Bronc Hall Residence',
  [canon('Fuhr Hall')]: 'Hayes M. Fuhr Hall of Music',
  // Source-file word order between Fleharty/Farrell wasn't confirmed --
  // both orders resolve to the same real building.
  [canon('Fleharty/Farrell')]: 'Lynn Farrell Arena/Fleharty Educational Center',
  [canon('Farrell/Fleharty')]: 'Lynn Farrell Arena/Fleharty Educational Center'
};

function normalizeHeaderText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isRowBlank(row, columns) {
  return columns.every((col) => {
    const v = row?.[col];
    return v === null || v === undefined || String(v).trim() === '';
  });
}

// Row-6-level classification: what KIND of column this is, independent of
// which group (Demolition/0-5yr/6-10yr/Renovation) it belongs to.
// "existing building" is checked first and is mutually exclusive with the
// others -- it's the anchor, not a cost column.
function classifySubLabel(value) {
  const n = normalizeHeaderText(value);
  if (!n) return null;
  if (n.includes('existing') && n.includes('building')) return 'buildingName';
  if (n.includes('cost') && (n.includes('/sf') || n.includes('per sf'))) return 'costPerSf';
  if (n.includes('project') && n.includes('cost')) return 'projectCost';
  if (n.includes('construction') && n.includes('cost')) return 'constructionCost';
  return null;
}

// Row-5-level classification: which GROUP a column belongs to.
function classifyCategory(value) {
  const n = normalizeHeaderText(value);
  if (!n) return null;
  if (n.includes('demolition')) return 'demolition';
  if (n.includes('0-5')) return 'zeroToFive';
  if (n.includes('6-10')) return 'sixToTen';
  if (n.includes('renovation')) return 'renovation';
  return null;
}

const FIELD_BY_GROUP_AND_TYPE = {
  'demolition:projectCost': 'demolitionProjectCost',
  'zeroToFive:constructionCost': 'deferredMaint0to5ConstructionCost',
  'zeroToFive:projectCost': 'deferredMaint0to5ProjectCost',
  'sixToTen:constructionCost': 'deferredMaint6to10ConstructionCost',
  'sixToTen:projectCost': 'deferredMaint6to10ProjectCost',
  'renovation:costPerSf': 'renovationCostPerSf',
  'renovation:constructionCost': 'renovationConstructionCost'
};

// The real file's confirmed column order (B..I), used ONLY as a fallback
// for a sub-label column whose row-above category text doesn't classify --
// e.g. if a future re-export relabels row 5 in a way classifyCategory
// doesn't recognize. Matches the exact verified B..I mapping: a lone
// Project Cost column (Demolition), then two Construction+Project Cost
// pairs in order (0-5yr, 6-10yr), then a Cost/SF+Construction Cost pair
// (Renovation).
const POSITIONAL_FALLBACK_GROUPS = [
  'demolition', 'zeroToFive', 'zeroToFive', 'sixToTen', 'sixToTen', 'renovation', 'renovation'
];

const MIN_SUBLABEL_COLUMNS_REQUIRED = 4;

// Locates the two-row header block. Anchored on "EXISTING BUILDING" (row
// 6's unique, unambiguous label) to find the sub-label row -- "Project
// Cost"/"Construction Cost" alone repeat across groups and can't anchor a
// row on their own. Once found, reads the row directly above for each
// sub-label column's category, forward-filling across blank cells to cover
// a merged category cell. Returns null (never guesses a row with no
// "EXISTING BUILDING" match) if the sheet's structure doesn't match at
// all -- fails loudly rather than parsing garbage.
function locateHeaderBlock(rows) {
  const warnings = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const nameCol = row.findIndex((cell) => classifySubLabel(cell) === 'buildingName');
    if (nameCol === -1) continue;

    const subLabelCols = []; // [{ col, type }], left-to-right
    row.forEach((cell, col) => {
      if (col === nameCol) return;
      const type = classifySubLabel(cell);
      if (type && type !== 'buildingName') subLabelCols.push({ col, type });
    });
    if (subLabelCols.length < MIN_SUBLABEL_COLUMNS_REQUIRED) continue; // not the real header row

    const categoryRow = rows[r - 1] || [];
    const maxCol = Math.max(nameCol, ...subLabelCols.map((s) => s.col));
    // Forward-fill ONLY across truly blank cells (a merge continuation --
    // SheetJS leaves every cell but the merge's top-left one empty). A cell
    // that has text but doesn't classify (e.g. a literal "Deferred Maint.
    // Total" label with no 0-5/6-10 distinction) must NOT inherit the
    // category to its left -- it's a real, distinct label that just isn't
    // recognized, not a merge continuation, and blanket-forward-filling it
    // would silently mislabel every column after it (caught in testing:
    // this produced e.g. two columns both writing to demolitionProjectCost,
    // one silently clobbering the other).
    let lastCategory = null;
    const categoryByCol = {};
    for (let c = nameCol; c <= maxCol; c++) {
      const rawCell = categoryRow[c];
      const isBlank = rawCell === null || rawCell === undefined || String(rawCell).trim() === '';
      if (isBlank) {
        categoryByCol[c] = lastCategory;
      } else {
        const cat = classifyCategory(rawCell);
        categoryByCol[c] = cat;
        lastCategory = cat;
      }
    }

    const columns = {};
    subLabelCols.forEach(({ col, type }, idx) => {
      let group = categoryByCol[col];
      if (!group) {
        group = POSITIONAL_FALLBACK_GROUPS[idx] || null;
        if (group) {
          warnings.push(
            `Column index ${col}: no recognizable category text ("Demolition"/"0-5yr"/"6-10yr"/`
            + `"Renovation") found in the row above the header row -- assumed "${group}" by column `
            + 'position. Verify against the real file before saving.'
          );
        }
      }
      if (!group) return;
      const field = FIELD_BY_GROUP_AND_TYPE[`${group}:${type}`];
      if (field) columns[field] = col;
    });

    return { subLabelRowIndex: r, nameCol, columns, warnings };
  }
  return null;
}

// Strips a leading numeric line-item prefix like "(01) " -- confirmed real
// format from the actual file (e.g. "(01) Daugherty Center"). Used ONLY for
// matching; the stored rawBuildingName keeps the original, unstripped text
// (prefix included) so the UI still shows exactly what the sheet says.
// Root cause of the "every building unmapped" bug: both the direct-match
// and crosswalk lookups compared the FULL cell text (prefix and all)
// against real building names / crosswalk keys with no prefix, so every
// row failed to match regardless of whether it needed the crosswalk or was
// a clean 1:1 name -- confirmed against the real file's "(01) Daugherty
// Center" / equivalent prefixed Kiewit/Perkins rows.
function stripBuildingNamePrefix(name) {
  return String(name || '').trim().replace(/^\(\d+\)\s*/, '').trim();
}

function matchBuildingName(rawName, realBuildingNames) {
  const trimmed = stripBuildingNamePrefix(rawName);
  const names = Array.isArray(realBuildingNames) ? realBuildingNames : [];
  if (!trimmed) return { matchedBuildingId: null, matchMethod: 'blank' };
  const direct = names.find((name) => String(name || '').trim() === trimmed);
  if (direct) return { matchedBuildingId: direct, matchMethod: 'direct' };
  const crosswalkTarget = BUILDING_NAME_CROSSWALK[canon(trimmed)];
  if (crosswalkTarget) {
    const resolved = names.find((name) => String(name || '').trim() === crosswalkTarget.trim());
    if (resolved) return { matchedBuildingId: resolved, matchMethod: 'crosswalk' };
  }
  return { matchedBuildingId: null, matchMethod: 'unmapped' };
}

// Benign in-table label rows other than the real end-of-table marker (see
// END_OF_TABLE_MARKER below) -- kept as a lenient regex since these are
// skipped, not used as a structural boundary. NOT relied on to detect the
// real table's end: a regex is the wrong tool for "stop parsing entirely
// here" (see the 2026-09 bug below).
const SKIP_NAME_PATTERN = /^(total|grand total|subtotal|summary)\b/i;

// The real, confirmed end-of-table marker: a row whose name-column text is
// EXACTLY "TOTALS" (case-insensitive, trimmed) -- row 38 in the real file,
// followed by blank rows and an unrelated "ASSUMPTIONS" section. This is a
// dedicated exact-match STOP, not folded into SKIP_NAME_PATTERN above,
// because "mark the end of the table" and "skip this one label row" are
// different jobs -- confirmed real bug: SKIP_NAME_PATTERN's `\b` word
// boundary never matches "Totals" (or any total-row label immediately
// followed by more letters, e.g. "TOTALS (25 Buildings)" -- verified this
// directly: /^(total|...)\b/i.test("Totals") is false, since there's no
// word-character transition between "total" and "s"), so that row's own
// Project Cost values -- BY DEFINITION the sum of every real building --
// were parsed in as an extra "building" row, inflating the computed totals
// (observed: ~$37.9M/$32.2M instead of the real $18,972,091.07/
// $16,096,640). A dedicated exact-match check that BREAKS the loop, rather
// than a regex someone has to keep extending for every label variant, is
// what actually fixes this class of bug.
const END_OF_TABLE_MARKER = 'totals';

function isEndOfTableRow(rawName) {
  return normalizeHeaderText(rawName) === END_OF_TABLE_MARKER;
}

// Pure function over an already-extracted 2D array of cell values (i.e.
// XLSX.utils.sheet_to_json(sheet, {header:1}) output), kept separate from
// file/IO handling below so the parsing logic can be exercised directly
// against a plain array -- same convention as parsePhasingWorkbookRows.
export function parseDeferredMaintenanceRows(rows, realBuildingNames) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const header = locateHeaderBlock(safeRows);

  if (!header) {
    return {
      buildings: [],
      issues: [{
        excelRow: null,
        rawName: '(sheet)',
        reason: 'Could not find the two-row header block (a row with "EXISTING BUILDING" plus at least '
          + `${MIN_SUBLABEL_COLUMNS_REQUIRED} of "Project Cost"/"Construction Cost"/"Const. Cost/SF" `
          + 'columns). Sheet structure may have changed -- check the real file before retrying.'
      }],
      sheetWarnings: [],
      excludedNoDataRows: []
    };
  }

  const { subLabelRowIndex, nameCol, columns, warnings } = header;
  const allTrackedCols = [nameCol, ...Object.values(columns)];

  const buildings = [];
  const issues = [];
  const excludedNoDataRows = [];
  let reachedEndMarker = false;

  for (let r = subLabelRowIndex + 1; r < safeRows.length; r++) {
    const row = safeRows[r] || [];
    const excelRow = r + 1;
    if (isRowBlank(row, allTrackedCols)) continue;

    const rawName = String(row[nameCol] ?? '').trim();
    if (!rawName) {
      issues.push({ excelRow, rawName: '(blank)', reason: 'Row has cost data but no building name in the detected name column.' });
      continue;
    }

    // Real end-of-table marker -- a STOP, not a skip. Everything below it
    // (blank rows, an "ASSUMPTIONS" section, etc.) is never building data
    // and must never be read as if it were.
    if (isEndOfTableRow(rawName)) {
      reachedEndMarker = true;
      break;
    }

    if (SKIP_NAME_PATTERN.test(rawName)) continue; // other benign label rows, mid-table

    const readCol = (key) => (columns[key] != null ? parseMoney(row[columns[key]]) : null);

    const demolitionProjectCost = readCol('demolitionProjectCost');
    const deferredMaint0to5 = readCol('deferredMaint0to5ProjectCost'); // headline -- Project Cost, not Construction Cost
    const deferredMaint0to5ConstructionCost = readCol('deferredMaint0to5ConstructionCost');
    const deferredMaint6to10 = readCol('deferredMaint6to10ProjectCost'); // headline
    const deferredMaint6to10ConstructionCost = readCol('deferredMaint6to10ConstructionCost');
    const renovationCostPerSf = readCol('renovationCostPerSf');
    const renovationConstructionCost = readCol('renovationConstructionCost');

    // A real, distinct case (rows 34-37 in the confirmed real file): a
    // legitimate building name with every cost cell genuinely blank (not
    // $0 -- parseMoney only returns null for a truly empty/unparseable
    // cell) -- an un-costed future line item, not a building with an
    // actual deferred-maintenance profile. Excluded from `buildings`
    // (never counted toward campus totals, never written to Firestore)
    // but reported separately so it's visible in the UI, not silently
    // dropped -- same "flag, never drop" philosophy as `issues` above.
    const allCostFieldsMissing = [
      demolitionProjectCost, deferredMaint0to5, deferredMaint0to5ConstructionCost,
      deferredMaint6to10, deferredMaint6to10ConstructionCost,
      renovationCostPerSf, renovationConstructionCost
    ].every((v) => v === null);

    if (allCostFieldsMissing) {
      excludedNoDataRows.push({ excelRow, rawName });
      continue;
    }

    const { matchedBuildingId, matchMethod } = matchBuildingName(rawName, realBuildingNames);

    buildings.push({
      rawBuildingName: rawName,
      matchedBuildingId,
      matchMethod,
      demolitionProjectCost,
      deferredMaint0to5,
      deferredMaint0to5ConstructionCost,
      deferredMaint6to10,
      deferredMaint6to10ConstructionCost,
      renovationCostPerSf,
      renovationConstructionCost
    });
  }

  const sheetWarnings = [...warnings];
  if (!reachedEndMarker) {
    sheetWarnings.push(
      `No "${END_OF_TABLE_MARKER.toUpperCase()}" end-of-table row was found before reaching the end of the `
      + 'sheet -- every non-blank row below the header was parsed as a building. If the real file\'s total '
      + 'row uses different text, verify nothing below the intended table (notes, an assumptions section, '
      + 'etc.) was misread as building data.'
    );
  }

  return { buildings, issues, sheetWarnings, excludedNoDataRows };
}

function normalizeSheetName(name) {
  return String(name ?? '').trim().toLowerCase();
}

// File/IO wrapper -- reads an uploaded File via the browser's
// File.arrayBuffer(), parses it with the `xlsx` (SheetJS) library, and
// returns the parsed rows plus source metadata for the preview UI. Reads
// the specific confirmed sheet name (DEFERRED_MAINTENANCE_SHEET_NAME), not
// "first sheet" -- same reasoning as parseCapitalPhasingFile: this workbook
// is expected to carry other sheets alongside this one, and guessing wrong
// here would silently parse garbage instead of failing loudly.
export async function parseDeferredMaintenanceFile(file, realBuildingNames) {
  if (!file) throw new Error('No file provided.');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const targetSheetName = workbook.SheetNames.find(
    (name) => normalizeSheetName(name) === normalizeSheetName(DEFERRED_MAINTENANCE_SHEET_NAME)
  );
  if (!targetSheetName) {
    throw new Error(
      `Could not find a sheet named "${DEFERRED_MAINTENANCE_SHEET_NAME}" in this workbook. `
      + `Sheets found: ${workbook.SheetNames.join(', ') || '(none)'}.`
    );
  }
  const sheet = workbook.Sheets[targetSheetName];
  // Force the read range to start at column A regardless of the sheet's own
  // "!ref" bounding box -- same guard as parseCapitalPhasingFile, against
  // the documented SheetJS gotcha where a blank column A silently shifts
  // every column left by one in sheet_to_json's array output.
  const sheetRange = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  const forcedRange = sheetRange
    ? XLSX.utils.encode_range({ s: { r: sheetRange.s.r, c: 0 }, e: sheetRange.e })
    : undefined;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, range: forcedRange });
  const parsed = parseDeferredMaintenanceRows(rows, realBuildingNames);
  return { ...parsed, sheetName: targetSheetName, sourceFileName: file.name };
}

// docId is deterministic from the matched real building name when mapped
// (slashes replaced with "__", same sanitizeBuildingDocId convention
// CapitalPrioritiesPanel.jsx uses for its own capitalPriorities doc ids --
// so a mapped building's deferred-maintenance doc and its capitalPriorities
// score doc share the same id), or an "unmapped__" + canon(rawName) id when
// no location could be resolved -- kept in its own id namespace so it can
// never collide with a real building id.
export function toDeferredMaintenanceDocs(parsed) {
  const buildings = Array.isArray(parsed?.buildings) ? parsed.buildings : [];
  return buildings.map((b) => {
    const docId = b.matchedBuildingId
      ? String(b.matchedBuildingId).trim().replace(/\//g, '__')
      : `unmapped__${canon(b.rawBuildingName)}`;
    return { docId, ...b };
  });
}
