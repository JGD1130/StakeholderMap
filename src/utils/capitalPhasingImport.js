// src/utils/capitalPhasingImport.js
//
// Capital Priorities module -- Capital Phasing & Costs (new section, lives
// inside Capital Priorities per Clark's explicit decision, NOT Classroom
// Utilization -- these are two separate master-plan-derived features that
// happen to both read Hastings master plan workbooks). Isolated helper for
// the Phasing_and_Costs.xlsx upload, same "framework-agnostic, no Firestore/
// React imports" isolation convention as enrollmentProjectionsImport.js --
// CapitalPrioritiesPanel.jsx owns the file input, preview UI, and all
// Firestore writes; this file only turns an uploaded workbook into plain
// parsed project records, plus the pure schedule-computation function the
// display needs.
//
// Real file structure, confirmed by direct cell-address reads against the
// actual workbook (B5/C5/D5/E5, B7/C7/D7/E7 -- see the 2026-08-26 root-cause
// note below for why "direct cell reads" and not just the parsed array
// mattered here) against sheet "HC MP Phasing - Revised":
//   - Project header row: column B = project name, column C = completion
//     date as a "Mon. YYYY" label (e.g. "Aug. 2026"), column D = 2026-dollar
//     project cost, column E = escalated cost.
//   - Phase rows follow: column B = phase name (e.g. "Design"/"Demolition"/
//     "Construction"/"Move In" -- NOT an exhaustive enum matched against;
//     see below for why), column C = a duration like "4 months".
//   - Column A is entirely blank throughout this sheet.
//   - Some rows are sub-item descriptions with no duration (relocation
//     notes) -- attached to the preceding phase, not treated as phases of
//     their own.
//   - A blank row (columns B-E all empty) separates one project's block
//     from the next.
//   - The visual Gantt bars in this file are pure cell-fill-color with no
//     underlying values -- never parsed. Each project's phase timeline is
//     instead computed purely from completionDate + phase durations,
//     working BACKWARD (completionDate = end of the last listed phase; sum
//     durations backward to get every phase's start/end) -- see
//     computeCapitalPhasingSchedule below.
//
// ROOT CAUSE, 2026-08-26 (a real bug, but not the one it first looked
// like): uploading the real file produced 0 of 28 projects, every row
// flagged "could not parse completion date". First hypothesis -- that the
// real columns were A/B/C/D, one left of spec -- looked confirmed by
// XLSX.utils.sheet_to_json(sheet, {header:1})'s own array output, but that
// was a misdiagnosis: direct cell-address reads (sheet['B5'], sheet['C7'],
// etc., bypassing sheet_to_json's array indexing entirely) proved the real
// columns are exactly B/C/D/E as originally specified. The actual bug is a
// SheetJS gotcha -- sheet_to_json(ws, {header:1}) indexes its returned
// arrays relative to the sheet's OWN "!ref" bounding box, not always from
// column A. Because column A is blank for every row in this sheet, Excel
// recorded this sheet's used range as starting at column B ("!ref" =
// "B1:EM151"), so the returned arrays' index 0 was actually column B's
// value, index 1 was column C's, etc. -- silently shifting every column
// left by one in the parsed output, with no error. The parser was reading
// the date-label into what it thought was the name field, and a raw cost
// NUMBER into what it thought was the date field, which of course never
// matches a date pattern. Fixed not by changing which array indices the
// parser reads (that would only "fix" this one file's specific blank-
// column quirk and silently break again the moment a future revision puts
// so much as a stray value in column A), but by forcing sheet_to_json's
// own range to always start at column A (parseCapitalPhasingFile below) --
// guaranteeing index 1 is always column B, index 2 always column C,
// regardless of which columns a given file happens to have used. This was
// NOT a Date-object-vs-string issue (a real, separately-plausible failure
// mode that was also checked and ruled out -- SheetJS returns the
// completion-date column as plain strings, type "s", under both
// cellDates:true and cellDates:false); parseCompletionMonthYear below still
// defensively accepts a native Date or an Excel serial number in addition
// to text, in case a future re-export ever formats this column as an
// actual date cell instead of text.
//
// Parsed STRUCTURALLY, not by fixed row-count assumptions, so a future
// updated version of this workbook still parses correctly as long as the
// same block shape holds:
//   - Block boundaries come from blank rows, not row-count assumptions.
//   - Within a block, row 0 is always the project header (positional --
//     the first row after a separator), row 1+ are phase/note rows.
//   - A phase vs. a note row is distinguished by whether column C parses as
//     a duration ("N month(s)"), NOT by matching specific phase-name
//     strings -- Design/Demolition/Construction/Move In are examples from
//     the real file, not an exhaustive list a future project's phase names
//     must match. This is what lets an unfamiliar future phase name still
//     parse correctly as long as it carries a duration.
//
// Any block that doesn't parse cleanly (missing/unparseable completion
// date, no phases at all, a note with no phase yet to attach to) is
// reported in `issues`, NOT silently dropped -- same "flag visibly, review
// before trusting" philosophy as every other suggestion/import path in
// this codebase (roomTypeSuggestion.js, enrollmentProjectionsImport.js).

import { canon } from './idUtils';
import * as XLSX from 'xlsx';

export const CAPITAL_PHASING_SHEET_NAME = 'HC MP Phasing - Revised';

const MONTH_ABBR_TO_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

// Excel's date epoch is 1899-12-30 UTC (deliberately -- it bakes in the
// historical 1900 leap-year bug Excel preserves for Lotus 1-2-3
// compatibility, which is already correctly accounted for by using this
// exact epoch rather than 1899-12-31/1900-01-01). Used only as a defensive
// fallback -- see parseCompletionMonthYear below -- since the real
// Phasing_and_Costs.xlsx stores this column as plain text ("Aug. 2026"),
// confirmed directly against the file (SheetJS cell type "s" under both
// cellDates:true and cellDates:false), not a native date/serial number.
function excelSerialToUtcDate(serial) {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
}

// Accepts the RAW cell value (not pre-stringified), since which shape it
// arrives in depends on how a given workbook happened to format this
// column -- confirmed necessary, not speculative: the real file has this
// as plain text, but a future re-export could format it as an actual date
// cell, which SheetJS would then hand back as either a native JS Date
// (cellDates:true) or an Excel serial day-number (cellDates:false, the
// mode this module actually reads with). Handles all three:
//   - a JS Date instance
//   - a plain number (Excel serial date)
//   - "Aug. 2026" / "Aug 2026" / "August 2026" text -- only the first three
//     letters of the month word are ever consulted (MONTH_ABBR_TO_INDEX),
//     so full names and abbreviations resolve identically without two regexes.
function parseCompletionMonthYear(rawValue) {
  if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
    return { year: rawValue.getUTCFullYear(), month: rawValue.getUTCMonth() };
  }
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    const date = excelSerialToUtcDate(rawValue);
    return Number.isNaN(date.getTime()) ? null : { year: date.getUTCFullYear(), month: date.getUTCMonth() };
  }
  const raw = String(rawValue ?? '').trim();
  const match = raw.match(/^([A-Za-z]{3,})\.?\s+(\d{4})$/);
  if (!match) return null;
  const monthKey = match[1].slice(0, 3).toLowerCase();
  const month = MONTH_ABBR_TO_INDEX[monthKey];
  const year = Number(match[2]);
  if (month === undefined || !Number.isFinite(year)) return null;
  return { year, month };
}

// "4 months", "1 month", "2.5 Months" -- decimal tolerated defensively,
// though every duration in the real file is a whole number. Anything else
// (blank, "TBD", a description sentence) returns null, which is exactly
// what makes a row a NOTE rather than a phase (see parsePhasingWorkbookRows).
function parseDurationMonths(text) {
  const raw = String(text ?? '').trim();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*months?$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isoFirstOfMonth(year, month) {
  return `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

function isBlankRow(row) {
  return [1, 2, 3, 4].every((col) => {
    const v = row?.[col];
    return v === null || v === undefined || String(v).trim() === '';
  });
}

// Pure function over an already-extracted 2D array of cell values (i.e.
// XLSX.utils.sheet_to_json(sheet, {header:1}) output) -- kept separate from
// file/IO handling below so the parsing logic itself can be exercised
// directly against a plain array without needing a real File/Blob, same
// convention as parseEnrollmentWorkbookRows.
export function parsePhasingWorkbookRows(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const projects = [];
  const issues = [];

  let block = []; // [{ row, excelRow }]

  const flushBlock = () => {
    if (!block.length) return;
    const [{ row: headerRow, excelRow: headerExcelRow }, ...phaseRows] = block;
    block = [];

    const projectName = String(headerRow[1] ?? '').trim();
    const completionCellValue = headerRow[2];
    const completion = parseCompletionMonthYear(completionCellValue);
    const projectCost2026 = parseMoney(headerRow[3]);
    const escalatedCost = parseMoney(headerRow[4]);

    if (!projectName || !completion) {
      issues.push({
        excelRow: headerExcelRow,
        rawName: projectName || '(blank)',
        reason: !projectName
          ? 'Project header row has no name in column B.'
          : `Could not parse completion date "${String(completionCellValue ?? '').trim()}" (expected e.g. "Aug. 2026").`
      });
      return;
    }

    const phases = []; // { name, durationMonths, notes: [] }
    const danglingNotes = [];

    phaseRows.forEach(({ row, excelRow }) => {
      const label = String(row[1] ?? '').trim();
      if (!label) return;
      const durationMonths = parseDurationMonths(row[2]);
      if (durationMonths != null) {
        phases.push({ name: label, durationMonths, notes: [] });
      } else if (phases.length) {
        phases[phases.length - 1].notes.push(label);
      } else {
        danglingNotes.push({ label, excelRow });
      }
    });

    if (danglingNotes.length) {
      danglingNotes.forEach(({ label, excelRow }) => {
        issues.push({
          excelRow,
          rawName: projectName,
          reason: `Sub-item "${label}" appears before any phase with a parseable duration -- attached to no phase, dropped from notes.`
        });
      });
    }

    if (!phases.length) {
      issues.push({
        excelRow: headerExcelRow,
        rawName: projectName,
        reason: 'No phase rows with a parseable duration (e.g. "4 months") were found under this project.'
      });
      return;
    }

    projects.push({
      projectName,
      completionDate: isoFirstOfMonth(completion.year, completion.month),
      projectCost2026,
      escalatedCost,
      // Phase-name prefix preserves which phase a note belongs to even
      // though the stored doc shape flattens notes to one array -- per
      // the explicit {name, durationMonths} / notes:[string] doc shape.
      phases: phases.map((p) => ({ name: p.name, durationMonths: p.durationMonths })),
      notes: phases.flatMap((p) => p.notes.map((n) => `${p.name}: ${n}`))
    });
  };

  safeRows.forEach((row, idx) => {
    const excelRow = idx + 1;
    if (isBlankRow(row)) {
      flushBlock();
      return;
    }
    block.push({ row: row || [], excelRow });
  });
  flushBlock(); // last block has no trailing blank row to trigger on

  return { projects, issues };
}

function normalizeSheetName(name) {
  return String(name ?? '').trim().toLowerCase();
}

// File/IO wrapper -- reads an uploaded File via the browser's
// File.arrayBuffer(), parses it with the `xlsx` (SheetJS) library, and
// returns the same shape parsePhasingWorkbookRows produces plus a bit of
// source metadata for the preview UI. Reads the SPECIFIC confirmed sheet
// name (CAPITAL_PHASING_SHEET_NAME), not "first sheet" -- unlike
// enrollmentProjectionsImport.js's single-sheet workbook, this workbook is
// expected to carry other sheets alongside the phasing one, and guessing
// wrong here would silently parse garbage instead of failing loudly.
export async function parseCapitalPhasingFile(file) {
  if (!file) throw new Error('No file provided.');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const targetSheetName = workbook.SheetNames.find(
    (name) => normalizeSheetName(name) === normalizeSheetName(CAPITAL_PHASING_SHEET_NAME)
  );
  if (!targetSheetName) {
    throw new Error(
      `Could not find a sheet named "${CAPITAL_PHASING_SHEET_NAME}" in this workbook. `
      + `Sheets found: ${workbook.SheetNames.join(', ') || '(none)'}.`
    );
  }
  const sheet = workbook.Sheets[targetSheetName];
  // Force the read range to start at column A (row kept as-is from the
  // sheet's own bounds) regardless of where the sheet's own "!ref" bounding
  // box starts -- see the ROOT CAUSE note at the top of this file.
  // sheet_to_json(ws, {header:1}) indexes its returned arrays relative to
  // whatever column the sheet's "!ref" happens to start at, NOT always
  // column A; the real Phasing_and_Costs.xlsx has an entirely blank column
  // A throughout this sheet, so its own "!ref" starts at column B, which
  // silently shifted every column left by one in the parsed output with no
  // error. Forcing column A here guarantees array index 1 is always column
  // B, index 2 always column C, etc., regardless of which columns any given
  // version of this file happens to have used.
  const sheetRange = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  const forcedRange = sheetRange
    ? XLSX.utils.encode_range({ s: { r: sheetRange.s.r, c: 0 }, e: sheetRange.e })
    : undefined;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, range: forcedRange });
  const parsed = parsePhasingWorkbookRows(rows);
  return { ...parsed, sheetName: targetSheetName, sourceFileName: file.name };
}

// projectId is deterministic from the project name (canon() slug, same
// convention as buildEnrollmentProjectionDocId/buildRoomUtilizationMetaKey),
// so re-uploading a newer version of the same workbook overwrites the same
// docs instead of accumulating duplicates. Two distinct projects that
// happen to canon() to the same slug (e.g. differ only in punctuation) are
// disambiguated with a numeric suffix rather than one silently overwriting
// the other.
export function toCapitalPhasingDocs(parsed) {
  const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
  const seen = new Map(); // slug -> count
  return projects.map((project) => {
    const base = canon(project.projectName);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    const projectId = count === 0 ? base : `${base}__${count + 1}`;
    return {
      projectId,
      projectName: project.projectName,
      completionDate: project.completionDate,
      projectCost2026: project.projectCost2026,
      escalatedCost: project.escalatedCost,
      phases: project.phases,
      notes: project.notes
    };
  });
}

function parseIsoYearMonth(iso) {
  const match = String(iso ?? '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) - 1 };
}

function monthIndexToIso(monthIndex) {
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  return isoFirstOfMonth(year, month);
}

// Computes each phase's start/end date PURELY from completionDate + phase
// durations, working backward -- per explicit instruction, the Gantt bars'
// cell-fill-color in the source file carries no values and is never read.
// completionDate = the end of the LAST listed phase; every earlier phase's
// end is the next phase's start, walking backward to the first phase.
// Returned in original (forward) phase order. Rounds to whole months for
// the date arithmetic (every real duration is already a whole number) --
// the phase's own durationMonths is still returned unrounded for display.
export function computeCapitalPhasingSchedule(project) {
  const completion = parseIsoYearMonth(project?.completionDate);
  const phases = Array.isArray(project?.phases) ? project.phases : [];
  if (!completion || !phases.length) return [];
  let endIndex = completion.year * 12 + completion.month;
  const reversedWithDates = [...phases].reverse().map((phase) => {
    const duration = Math.round(Number(phase.durationMonths) || 0);
    const startIndex = endIndex - duration;
    const entry = {
      name: phase.name,
      durationMonths: phase.durationMonths,
      startDate: monthIndexToIso(startIndex),
      endDate: monthIndexToIso(endIndex)
    };
    endIndex = startIndex;
    return entry;
  });
  return reversedWithDates.reverse();
}

// "2026-08-01" -> "Aug 2026". Shared display formatter so the component
// never re-derives this itself.
export function formatCapitalPhasingMonthYear(iso) {
  const parsed = parseIsoYearMonth(iso);
  if (!parsed) return '';
  const date = new Date(Date.UTC(parsed.year, parsed.month, 1));
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
