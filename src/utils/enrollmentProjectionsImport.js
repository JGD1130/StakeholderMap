// src/utils/enrollmentProjectionsImport.js
//
// Classroom Utilization module (Hastings-only). Isolated helper for the
// Enrollment & FTE Projections upload -- the data layer the future growth/
// right-sizing module needs. Framework-agnostic (no Firestore/React
// imports), same isolation convention as classroomScheduleImport.js and
// roomUtilizationMeta.js: ClassroomUtilizationPanel.jsx owns the file input,
// preview UI, and all Firestore writes; this file only turns an uploaded
// workbook into plain parsed records.
//
// Parses STRUCTURALLY (label text + relative column position), not by fixed
// row/column offsets, per explicit instruction -- verified directly against
// the real file (ai-server/Docs/"Hastings enroll_FTE.xlsx", read with the
// same `xlsx` library version already used server-side, 0.18.5) rather than
// built from the row/column numbers alone, because the real file's columns
// don't match the numbers as originally described (years live at columns
// F:P / 0-indexed 5-15, not G:Q) -- exactly the kind of drift this
// structural approach is meant to survive. Full verified shape:
//
//   - Year header: whichever row has the most integer cells in [2000,2100]
//     (found to be row 5 in the real file -- NOT assumed). Their column
//     positions are used to pull every subsequent data row's values, so a
//     future version with a different year range or column position still
//     parses correctly as long as the header row itself is still a row of
//     plain year numbers.
//   - Column A non-blank = a Level-1 header: either a real division name
//     (e.g. "Arts & Humanities") or the institution row ("Hastings
//     College"). Resets the division context; never carries values itself.
//   - Column B non-blank = one of two things, disambiguated by LABEL TEXT
//     (not position, since both shapes share column B):
//       - Text matches a known metric label (Net Student Headcount / FTE /
//         NTT Faculty / Tenure-or-slash-TT Faculty / Admin/Staff / Total
//         FTE) or a known skip label (Net Revenue / Total Expenses / Net
//         Income / bare "FTE" sub-header / "Offsets") -> this is the
//         institution-wide block's own row (only "Hastings College" has
//         this shape in the real file -- its metrics sit flat at column B
//         with no department in between). Recognized metric labels with
//         values are stored on a single institute-wide record, forced to
//         division="Overall"/department="Hastings College Overall" per
//         explicit instruction, regardless of the literal column-A text
//         above them -- this also means a future workbook that spells the
//         institution row differently still resolves correctly.
//       - Text matches neither -> a department name (e.g. "Art"), child of
//         whatever division is currently active from the last column-A row.
//   - Column C non-blank = a metric row within the current department
//     (Net Student Headcount / NTT Faculty / Tenure.../ Admin/Staff / Total
//     FTE, with values; Net Revenue/Total Expenses/Net Income, no values,
//     silently skipped since they don't match any known metric label).
//
// This label-driven design also transparently handles the "Offsets" block
// (rows found at column B, sub-rows "Fundraising"/"Auxiliary"/"Forecasted
// Balance" at column C) without any special-casing: none of those labels
// match a known metric, so no record is ever created for them -- confirmed
// against the real file: exactly 12 department records come out, matching
// the confirmed department count, with zero stray "Offsets" record.

import { canon } from './idUtils';
import * as XLSX from 'xlsx';

const METRIC_LABEL_MATCHERS = [
  { field: 'studentHeadcount', test: (n) => n.includes('student headcount') },
  { field: 'nttFacultyFte', test: (n) => n.includes('ntt') && n.includes('faculty') },
  { field: 'tenureTtFacultyFte', test: (n) => n.includes('tenure') && n.includes('faculty') },
  { field: 'adminStaffFte', test: (n) => n.includes('admin') && n.includes('staff') },
  { field: 'totalFte', test: (n) => n === 'total fte' }
];

// Recognized-but-not-a-metric labels that can appear directly at column B
// under the institution block ("FTE" is a bare sub-header with no values of
// its own; the other three are financial rows Clark confirmed aren't needed
// for space-growth math). Explicitly recognizing these (rather than relying
// only on "didn't match a metric" -> department fallback) keeps a column-B
// row like "Net Revenue" from ever being mistaken for a new department name
// -- purely defensive, since the real file's shape means this never actually
// changes the parsed output either way (see header comment).
const RECOGNIZED_NON_METRIC_LABELS = new Set(['fte', 'net revenue', 'total expenses', 'net income']);

function normalizeLabel(text) {
  return String(text ?? '').trim().toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

function matchMetricField(normalized) {
  if (!normalized) return null;
  const hit = METRIC_LABEL_MATCHERS.find((m) => m.test(normalized));
  return hit ? hit.field : null;
}

// Scans every row for the one with the most integer cells in a plausible
// calendar-year range -- not a fixed row number, so a workbook with extra
// title/version rows inserted above (as the real file has, rows 1-4) still
// locates the right header row.
function findYearHeaderRow(rows) {
  let best = { idx: -1, cols: [] };
  rows.forEach((row, idx) => {
    const cols = [];
    (row || []).forEach((cell, col) => {
      const n = Number(cell);
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 2000 && n <= 2100) cols.push({ col, year: n });
    });
    if (cols.length > best.cols.length) best = { idx, cols };
  });
  return best;
}

function extractYearValues(row, yearCols) {
  const out = {};
  yearCols.forEach(({ col, year }) => {
    const v = row[col];
    if (v === null || v === undefined || v === '') return;
    const n = Number(v);
    if (Number.isFinite(n)) out[year] = n;
  });
  return out;
}

function mergeYearValues(record, field, values) {
  Object.entries(values).forEach(([year, val]) => {
    if (!record.years[year]) record.years[year] = {};
    record.years[year][field] = val;
  });
}

// Pure function over an already-extracted 2D array of cell values (i.e.
// XLSX.utils.sheet_to_json(sheet, {header:1}) output) -- kept separate from
// file/IO handling below so the parsing logic itself can be exercised
// directly against a plain array without needing a real File/Blob.
export function parseEnrollmentWorkbookRows(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const yearHeader = findYearHeaderRow(safeRows);
  if (yearHeader.idx < 0 || yearHeader.cols.length < 2) {
    throw new Error('Could not find a year header row (expected a row containing multiple plain year numbers, e.g. 2026-2036).');
  }
  const yearCols = yearHeader.cols;
  const years = yearCols.map((c) => c.year).sort((a, b) => a - b);

  let currentDivision = null;
  let currentDepartment = null;
  const instituteRecord = { division: 'Overall', department: 'Hastings College Overall', years: {} };
  const deptRecordsByKey = new Map(); // "division||department" -> record, in first-seen order

  for (let i = yearHeader.idx + 1; i < safeRows.length; i += 1) {
    const row = safeRows[i] || [];
    const colA = row[0];
    const colB = row[1];
    const colC = row[2];

    if (colA != null && String(colA).trim()) {
      currentDivision = String(colA).trim();
      currentDepartment = null;
      continue;
    }

    if (colB != null && String(colB).trim()) {
      const label = String(colB).trim();
      const normalized = normalizeLabel(label);
      const field = matchMetricField(normalized);
      if (field) {
        mergeYearValues(instituteRecord, field, extractYearValues(row, yearCols));
      } else if (!RECOGNIZED_NON_METRIC_LABELS.has(normalized)) {
        currentDepartment = label;
      }
      continue;
    }

    if (colC != null && String(colC).trim()) {
      const label = String(colC).trim();
      const normalized = normalizeLabel(label);
      const field = matchMetricField(normalized);
      if (field && currentDivision && currentDepartment) {
        const key = `${currentDivision}||${currentDepartment}`;
        if (!deptRecordsByKey.has(key)) {
          deptRecordsByKey.set(key, { division: currentDivision, department: currentDepartment, years: {} });
        }
        mergeYearValues(deptRecordsByKey.get(key), field, extractYearValues(row, yearCols));
      }
      // Unrecognized column-C labels (Net Revenue/Total Expenses/Net Income,
      // or anything under a mis-shaped "Offsets" block) are silently
      // skipped -- no record is ever created unless a real metric label
      // matched, per the header comment.
    }
  }

  const departmentRecords = Array.from(deptRecordsByKey.values());
  const hasInstituteData = Object.keys(instituteRecord.years).length > 0;

  return {
    years,
    instituteRecord: hasInstituteData ? instituteRecord : null,
    departmentRecords,
    yearHeaderRowIndex: yearHeader.idx
  };
}

// deptId is deterministic from division+department, same canon() slug
// convention used everywhere else in this codebase (bId/fId/rId in
// idUtils.js, buildRoomUtilizationMetaKey) -- so re-uploading a newer
// version of the same workbook overwrites the same docs instead of
// accumulating duplicates under slightly different ids.
export function buildEnrollmentProjectionDocId(division, department) {
  return canon(`${division}_${department}`);
}

// Combines the institute-wide record (if present) with every department
// record into the one flat list ClassroomUtilizationPanel.jsx writes to
// Firestore, each tagged with its deterministic deptId.
export function toEnrollmentProjectionDocs(parsed) {
  const records = [
    ...(parsed?.instituteRecord ? [parsed.instituteRecord] : []),
    ...(Array.isArray(parsed?.departmentRecords) ? parsed.departmentRecords : [])
  ];
  return records.map((record) => ({
    deptId: buildEnrollmentProjectionDocId(record.division, record.department),
    division: record.division,
    department: record.department,
    years: record.years
  }));
}

// File/IO wrapper -- reads an uploaded File via the browser's File.arrayBuffer(),
// parses it with the `xlsx` (SheetJS) library, and returns the same shape
// parseEnrollmentWorkbookRows produces plus a bit of source metadata for the
// preview UI. Only the first sheet is read (mirrors ai-server's own
// enrollment-workbook convention, server.js's /enrollment-projections route
// -- the real file, and every version Clark has produced, is single-sheet).
export async function parseEnrollmentProjectionsFile(file) {
  if (!file) throw new Error('No file provided.');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet) throw new Error('Workbook has no readable sheet.');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  const parsed = parseEnrollmentWorkbookRows(rows);
  return { ...parsed, sheetName, sourceFileName: file.name };
}
