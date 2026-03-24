import "dotenv/config";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import cors from "cors";
import express from "express";
import OpenAI from "openai";
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";
import { fileURLToPath } from "url";
import { validateAiQuery } from "./validateAiQuery.js";

const app = express();
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: "10mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AI_MODEL =
  process.env.AI_MODEL ||
  process.env.ASK_MAPFLUENCE_MODEL ||
  process.env.OPENAI_ASK_MODEL ||
  "gpt-4.1";

const AI_DOCS_ENABLED = String(process.env.AI_DOCS_ENABLED || "true").toLowerCase() !== "false";
const AI_DOCS_DIR = process.env.AI_DOCS_DIR
  ? path.resolve(process.env.AI_DOCS_DIR)
  : path.join(__dirname, "Docs");
const AI_DOCS_FILE_PURPOSE = process.env.AI_DOCS_FILE_PURPOSE || "assistants";
const AI_DOC_FILE_IDS = String(process.env.AI_DOC_FILE_IDS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const AI_DOC_FILE_NAMES = String(process.env.AI_DOC_FILE_NAMES || "")
  .split(",")
  .map((v) => v.trim());
const AI_DOC_TMP_DIR = process.env.AI_DOC_TMP_DIR
  ? path.resolve(process.env.AI_DOC_TMP_DIR)
  : path.join(os.tmpdir(), "mapfluence-ai-docs");
const AI_DOC_XLSX_MAX_CHARS = Number(process.env.AI_DOC_XLSX_MAX_CHARS || 250000);
const ASK_DOCS_SKIP_DATA_CHARS = Number(process.env.ASK_DOCS_SKIP_DATA_CHARS || 40000);
const ASK_DOCS_SKIP_ROOM_ROWS = Number(process.env.ASK_DOCS_SKIP_ROOM_ROWS || 150);
const EXPLAIN_CAMPUS_MAX_INPUT_CHARS = Number(process.env.EXPLAIN_CAMPUS_MAX_INPUT_CHARS || 20000);
const EXPLAIN_CAMPUS_MAX_TOP_ITEMS = Number(process.env.EXPLAIN_CAMPUS_MAX_TOP_ITEMS || 60);
const EXPLAIN_CAMPUS_DEFAULT_MODEL =
  process.env.EXPLAIN_CAMPUS_MODEL ||
  process.env.ASK_MAPFLUENCE_MODEL ||
  process.env.OPENAI_ASK_MODEL ||
  AI_MODEL;
const EXPLAIN_CAMPUS_LARGE_MODEL = process.env.EXPLAIN_CAMPUS_LARGE_MODEL || "gpt-4.1-mini";
const SERVER_COMMIT =
  process.env.RENDER_GIT_COMMIT ||
  process.env.GIT_COMMIT ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  "";
const ENROLLMENT_FILE_NAME = process.env.ENROLLMENT_FILE_NAME || "HastingsCollege_Enrollment.xlsx";
const ENROLLMENT_SHEET_NAME = process.env.ENROLLMENT_SHEET_NAME || "";
const XLSX_API = (XLSX && XLSX.readFile && XLSX.utils)
  ? XLSX
  : (XLSX?.default || XLSX);
const aiDocsCache = {
  signature: "",
  docs: [] // [{ name, fullPath, fileId }]
};

function isAllowedAiDocFile(name) {
  return /\.(pdf|xlsx|xls|csv|txt|md)$/i.test(String(name || ""));
}

function isXlsxAiDoc(name) {
  return /\.xlsx$/i.test(String(name || ""));
}

function normalizeAiDocBaseName(name) {
  const base = path.basename(String(name || ""), path.extname(String(name || ""))) || "doc";
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function buildXlsxContextText(workbook) {
  if (!XLSX_API?.utils?.sheet_to_csv) return "";
  const sections = [];
  let usedChars = 0;
  const maxChars = Math.max(10000, AI_DOC_XLSX_MAX_CHARS);
  const sheetNames = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];

  for (const sheetName of sheetNames) {
    const sheet = workbook?.Sheets?.[sheetName];
    if (!sheet) continue;
    const csvBody = String(
      XLSX_API.utils.sheet_to_csv(sheet, {
        blankrows: false
      }) || ""
    ).trim();
    if (!csvBody) continue;

    const section = `Sheet: ${sheetName}\n${csvBody}`;
    const remaining = maxChars - usedChars;
    if (remaining <= 0) break;
    if (section.length <= remaining) {
      sections.push(section);
      usedChars += section.length + 2;
    } else {
      sections.push(section.slice(0, remaining));
      usedChars = maxChars;
      break;
    }
  }

  if (!sections.length) {
    return "No readable worksheet data was found in this spreadsheet.";
  }

  if (usedChars >= maxChars) {
    sections.push("[Spreadsheet context truncated for AI input size.]");
  }
  return sections.join("\n\n");
}

async function resolveAiDocUploadSource(doc) {
  if (!doc?.fullPath) return null;
  if (!isXlsxAiDoc(doc.name)) {
    return { uploadPath: doc.fullPath, cleanupPath: null };
  }
  if (!XLSX_API?.readFile || !XLSX_API?.utils?.sheet_to_csv) {
    throw new Error("XLSX parsing is unavailable on server");
  }

  const workbook = XLSX_API.readFile(doc.fullPath, { cellDates: false });
  const contextText = buildXlsxContextText(workbook);
  await fsp.mkdir(AI_DOC_TMP_DIR, { recursive: true });
  const safeBase = normalizeAiDocBaseName(doc.name);
  const tempName = `${safeBase}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const tempPath = path.join(AI_DOC_TMP_DIR, tempName);
  await fsp.writeFile(tempPath, contextText, "utf8");
  return { uploadPath: tempPath, cleanupPath: tempPath };
}

async function listLocalAiDocs() {
  if (!AI_DOCS_ENABLED) return [];
  let entries = [];
  try {
    entries = await fsp.readdir(AI_DOCS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && isAllowedAiDocFile(entry.name))
    .map((entry) => ({
      name: entry.name,
      fullPath: path.join(AI_DOCS_DIR, entry.name)
    }));
}

async function buildDocsSignature(docs) {
  const parts = [];
  for (const doc of docs) {
    try {
      const stat = await fsp.stat(doc.fullPath);
      parts.push(`${doc.name}:${stat.size}:${Number(stat.mtimeMs || 0)}`);
    } catch {
      parts.push(`${doc.name}:missing`);
    }
  }
  return parts.sort().join("|");
}

async function ensureUploadedAiDocs() {
  if (!AI_DOCS_ENABLED) return [];
  if (!process.env.OPENAI_API_KEY) return [];

  const docs = await listLocalAiDocs();
  if (!docs.length) {
    aiDocsCache.signature = "";
    aiDocsCache.docs = [];
    return [];
  }

  const signature = await buildDocsSignature(docs);
  if (aiDocsCache.signature === signature && aiDocsCache.docs.length) {
    return aiDocsCache.docs;
  }

  const uploaded = [];
  for (const doc of docs) {
    let uploadSource = null;
    try {
      uploadSource = await resolveAiDocUploadSource(doc);
      if (!uploadSource?.uploadPath) continue;
      const file = await client.files.create({
        file: fs.createReadStream(uploadSource.uploadPath),
        purpose: AI_DOCS_FILE_PURPOSE
      });
      uploaded.push({ ...doc, fileId: file.id });
    } catch (err) {
      console.warn(`AI docs upload skipped for ${doc.name}:`, err?.message || err);
    } finally {
      if (uploadSource?.cleanupPath) {
        await fsp.unlink(uploadSource.cleanupPath).catch(() => {});
      }
    }
  }

  aiDocsCache.signature = signature;
  aiDocsCache.docs = uploaded;
  return uploaded;
}

function getConfiguredEnvDocs() {
  return AI_DOC_FILE_IDS.map((fileId, idx) => ({
    fileId,
    name: AI_DOC_FILE_NAMES[idx] || `external-doc-${idx + 1}`
  }));
}

function estimateAskPayloadSize(data) {
  const roomRowsCount = Array.isArray(data?.roomRows) ? data.roomRows.length : 0;
  let jsonChars = 0;
  try {
    jsonChars = JSON.stringify(data || {}).length;
  } catch {
    jsonChars = 0;
  }
  return { roomRowsCount, jsonChars };
}

function estimateJsonChars(value) {
  try {
    return JSON.stringify(value ?? {}).length;
  } catch {
    return 0;
  }
}

function topNumericEntries(mapLike, maxItems = EXPLAIN_CAMPUS_MAX_TOP_ITEMS) {
  if (!mapLike || typeof mapLike !== "object") return mapLike;
  return Object.fromEntries(
    Object.entries(mapLike)
      .map(([k, v]) => [k, Number(v) || 0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, maxItems))
  );
}

function topTypeRows(rows, maxItems = EXPLAIN_CAMPUS_MAX_TOP_ITEMS) {
  if (!Array.isArray(rows)) return rows;
  return rows
    .map((row) => ({
      type: row?.type ?? row?.name ?? "",
      sf: Number(row?.sf ?? row?.value ?? 0) || 0,
      rooms: Number(row?.rooms ?? row?.count ?? 0) || 0
    }))
    .filter((row) => row.type || row.sf || row.rooms)
    .sort((a, b) => (b.sf || 0) - (a.sf || 0) || (b.rooms || 0) - (a.rooms || 0))
    .slice(0, Math.max(1, maxItems));
}

function compactCampusStats(campusStats) {
  if (!campusStats || typeof campusStats !== "object") return campusStats;
  return {
    totalSf: Number(campusStats?.totalSf ?? 0) || 0,
    rooms: Number(campusStats?.rooms ?? 0) || 0,
    totalsByDeptTop: topNumericEntries(campusStats?.totalsByDept, 40),
    byTypeTop: topTypeRows(campusStats?.byType, 30),
    occupancySummary: campusStats?.occupancySummary || null,
    officeOccupancy: campusStats?.officeOccupancy || null
  };
}

function compactPanelStats(panelStats) {
  if (!panelStats || typeof panelStats !== "object") return panelStats;
  return summarizeAskMapData(panelStats);
}

function buildExplainCampusPayload({ context, campusStats, panelStats }) {
  const rawPayload = { context, campusStats, panelStats };
  const rawChars = estimateJsonChars(rawPayload);
  if (rawChars <= EXPLAIN_CAMPUS_MAX_INPUT_CHARS) {
    return {
      payload: rawPayload,
      includeDocs: true,
      model: EXPLAIN_CAMPUS_DEFAULT_MODEL,
      wasCompacted: false,
      rawChars
    };
  }

  const compactedPayload = {
    context,
    campusStats: compactCampusStats(campusStats),
    panelStats: compactPanelStats(panelStats),
    note:
      "Large campus payload was compacted to key totals and top distributions to stay within model limits."
  };

  return {
    payload: compactedPayload,
    includeDocs: false,
    model: EXPLAIN_CAMPUS_LARGE_MODEL,
    wasCompacted: true,
    rawChars
  };
}

function shouldSkipDocsForAsk({ docsFirst, data }) {
  if (docsFirst) return false;
  const { roomRowsCount, jsonChars } = estimateAskPayloadSize(data);
  return roomRowsCount >= ASK_DOCS_SKIP_ROOM_ROWS || jsonChars >= ASK_DOCS_SKIP_DATA_CHARS;
}

async function buildUserContentWithAiDocs(payload, { warnLabel = "ai", includeDocs = true } = {}) {
  let docs = [];
  if (includeDocs) {
    try {
      docs = await ensureUploadedAiDocs();
    } catch (err) {
      console.warn(`AI docs load failed (${warnLabel}); continuing without docs:`, err?.message || err);
      docs = [];
    }
  }

  const envDocs = includeDocs ? getConfiguredEnvDocs() : [];
  const allDocs = [...docs, ...envDocs];
  const referenceDocNames = allDocs.map((doc) => doc.name);
  const userContent = [
    {
      type: "input_text",
      text: JSON.stringify({ ...payload, referenceDocs: referenceDocNames }, null, 2)
    }
  ];
  allDocs.forEach((doc) => {
    if (!doc?.fileId) return;
    userContent.push({ type: "input_file", file_id: doc.fileId });
  });
  return userContent;
}

function isDocPriorityQuestion(question) {
  const q = String(question || "").trim().toLowerCase();
  if (!q) return false;
  return /(history|historic|origin|background|founded|founded in|built|construction|renovation|renovated|named after|namesake|timeline|master plan|facilities plan|strategic plan|mission|vision)/i.test(q);
}

function isDocDependentQuantQuestion(question) {
  const q = String(question || "").trim().toLowerCase();
  if (!q) return false;
  return /(enrollment|projected|projection|forecast|headcount|fte|admissions|demographic|program growth|program decline|gain or lose|grow or shrink)/i.test(q);
}

function parseYearCell(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1900 && n <= 2200) return Math.round(n);
  const s = String(value || "").trim();
  const m = s.match(/\b(19|20|21)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

function pickEnrollmentRow(rows = []) {
  const scoreCell = (cell) => {
    const s = String(cell || "").toLowerCase();
    if (!s) return 0;
    if (s.includes("net student headcou") || s.includes("net student headcount")) return 5;
    if (s.includes("enrollment")) return 3;
    if (s.includes("headcount")) return 3;
    return 0;
  };

  let best = { idx: -1, col: -1, score: 0 };
  rows.forEach((row, idx) => {
    (row || []).forEach((cell, col) => {
      const score = scoreCell(cell);
      if (score > best.score) best = { idx, col, score };
    });
  });
  return best.score > 0 ? best : null;
}

function normalizeEnrollmentSeries(rows = []) {
  const byYear = new Map();
  (rows || []).forEach((row) => {
    const year = Number(row?.year);
    const enrollment = Number(row?.enrollment);
    if (!Number.isFinite(year)) return;
    byYear.set(
      Math.round(year),
      Number.isFinite(enrollment) && enrollment >= 0 ? Math.round(enrollment) : 0
    );
  });
  return Array.from(byYear.entries())
    .map(([year, enrollment]) => ({ year, enrollment }))
    .sort((a, b) => a.year - b.year);
}

function parseEnrollmentSeriesFromSheet(sheet) {
  if (!sheet) return [];
  const rows = XLSX_API.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false
  });
  if (!rows.length) return [];

  const hit = pickEnrollmentRow(rows);
  if (!hit) return [];
  const labelCol = Math.max(0, hit.col);
  const enrollmentRow = rows[hit.idx] || [];

  const valueCells = [];
  for (let col = labelCol + 1; col < enrollmentRow.length; col += 1) {
    const val = Number(enrollmentRow[col]);
    if (!Number.isFinite(val) || val < 0) continue;
    valueCells.push({ col, enrollment: Math.round(val) });
  }
  if (!valueCells.length) return [];

  let trimmedValueCells = valueCells.slice();
  let years = trimmedValueCells.map(() => null);
  const yearRowCandidates = [hit.idx - 1, hit.idx - 2, hit.idx - 3]
    .filter((idx) => idx >= 0)
    .map((idx) => rows[idx] || []);

  for (const candidate of yearRowCandidates) {
    const parsed = trimmedValueCells.map((entry) => parseYearCell(candidate[entry.col]));
    const matchCount = parsed.filter((v) => Number.isFinite(v)).length;
    if (matchCount >= Math.max(2, Math.ceil(trimmedValueCells.length * 0.5))) {
      years = parsed;
      break;
    }
  }

  // Trim leading/trailing placeholder cells (null year + zero value) that appear in some planning sheets.
  while (
    trimmedValueCells.length &&
    !Number.isFinite(years[0]) &&
    Number(trimmedValueCells[0]?.enrollment) === 0
  ) {
    trimmedValueCells = trimmedValueCells.slice(1);
    years = years.slice(1);
  }
  while (
    trimmedValueCells.length &&
    !Number.isFinite(years[years.length - 1]) &&
    Number(trimmedValueCells[trimmedValueCells.length - 1]?.enrollment) === 0
  ) {
    trimmedValueCells = trimmedValueCells.slice(0, -1);
    years = years.slice(0, -1);
  }
  if (!trimmedValueCells.length) return [];

  const firstKnown = years.findIndex((v) => Number.isFinite(v));
  if (firstKnown >= 0) {
    for (let i = firstKnown + 1; i < years.length; i += 1) {
      if (!Number.isFinite(years[i])) years[i] = Number(years[i - 1]) + 1;
    }
    for (let i = firstKnown - 1; i >= 0; i -= 1) {
      if (!Number.isFinite(years[i])) years[i] = Number(years[i + 1]) - 1;
    }
  } else {
    const startYear = new Date().getFullYear();
    years = years.map((_, idx) => startYear + idx);
  }

  const series = trimmedValueCells.map((entry, idx) => ({
    year: Number(years[idx]),
    enrollment: entry.enrollment
  }));
  return normalizeEnrollmentSeries(series);
}

async function resolveEnrollmentFilePath() {
  const preferredPath = path.join(AI_DOCS_DIR, ENROLLMENT_FILE_NAME);
  try {
    const st = await fsp.stat(preferredPath);
    if (st.isFile()) return preferredPath;
  } catch {}

  try {
    const entries = await fsp.readdir(AI_DOCS_DIR, { withFileTypes: true });
    const hit = entries.find((entry) => entry.isFile() && /\.(xlsx|xls)$/i.test(entry.name));
    if (hit) return path.join(AI_DOCS_DIR, hit.name);
  } catch {}
  return null;
}

function summarizeAskMapData(data) {
  if (!data || typeof data !== "object") return {};
  const out = {};
  Object.entries(data).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      out[`${key}Count`] = value.length;
    } else if (value && typeof value === "object") {
      out[`${key}Keys`] = Object.keys(value).length;
    } else if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      out[key] = value;
    }
  });
  return out;
}

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;
const AIRTABLE_VIEW = process.env.AIRTABLE_VIEW;
const AIRTABLE_BUILDING_FIELD = process.env.AIRTABLE_BUILDING_FIELD || "Building";
const AIRTABLE_BUILDING_NAME_FIELD = process.env.AIRTABLE_BUILDING_NAME_FIELD || "";
const AIRTABLE_FLOOR_FIELD = process.env.AIRTABLE_FLOOR_FIELD || "Floor";
const AIRTABLE_ROOM_ID_FIELD = process.env.AIRTABLE_ROOM_ID_FIELD || "Room ID";
const AIRTABLE_ROOM_GUID_FIELD = process.env.AIRTABLE_ROOM_GUID_FIELD || "Room GUID";
const AIRTABLE_OCC_STATUS_FIELD = process.env.AIRTABLE_OCC_STATUS_FIELD || "Occupancy Status";
const AIRTABLE_OCCUPANT_FIELD = process.env.AIRTABLE_OCCUPANT_FIELD || "Occupant";
const AIRTABLE_DEPT_FIELD = process.env.AIRTABLE_DEPT_FIELD || "Department";
const AIRTABLE_TYPE_FIELD = process.env.AIRTABLE_TYPE_FIELD || "Type";
const AIRTABLE_COMMENTS_FIELD = process.env.AIRTABLE_COMMENTS_FIELD || "Comments";
const AIRTABLE_FIELDS = process.env.AIRTABLE_FIELDS || "";
const AIRTABLE_ROOM_TYPE_TABLE = process.env.AIRTABLE_ROOM_TYPE_TABLE || "";
const AIRTABLE_ROOM_TYPE_PRIMARY_FIELD = process.env.AIRTABLE_ROOM_TYPE_PRIMARY_FIELD || "";
const AIRTABLE_DEPT_TABLE = process.env.AIRTABLE_DEPT_TABLE || "";
const AIRTABLE_DEPT_PRIMARY_FIELD = process.env.AIRTABLE_DEPT_PRIMARY_FIELD || "";

const linkedRecordCache = new Map();
const tablePrimaryFieldCache = new Map();
const linkedLabelCache = new Map();
const LINKED_LABEL_CACHE_TTL_MS = 5 * 60 * 1000;

const isAirtableRecordId = (value) => /^rec[a-z0-9]{6,}$/i.test(String(value || ""));
const isLinkedRecordArray = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((v) => isAirtableRecordId(v));

function pickFieldValue(fields = {}, candidates = []) {
  for (const key of candidates) {
    if (!key) continue;
    const val = fields[key];
    if (val == null) continue;
    if (typeof val === "string" && !val.trim()) continue;
    return val;
  }
  return "";
}

async function fetchAirtableRows(filterFormula, viewOverride) {
  const tryFetch = async (viewValue) => {
    const params = new URLSearchParams();
    if (viewValue) params.set("view", viewValue);
    if (filterFormula) {
      params.set("filterByFormula", filterFormula);
    }

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}?${params}`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`
      }
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Airtable error: ${resp.status} ${text}`);
    }

    const data = await resp.json();
    return data.records || [];
  };

  const view = viewOverride || AIRTABLE_VIEW || "Mapfluence_Rooms";
  try {
    return await tryFetch(view);
  } catch (err) {
    if (view) {
      return await tryFetch(null);
    }
    throw err;
  }
}

async function fetchAirtableAllRecords({ table, view, fields }) {
  const records = [];
  let offset = null;

  const tryFetch = async (viewValue) => {
    do {
      const params = new URLSearchParams();
      if (viewValue) params.set("view", viewValue);
      if (Array.isArray(fields)) {
        fields.forEach((field) => {
          if (field) params.append("fields[]", field);
        });
      }
      params.set("pageSize", "100");
      if (offset) params.set("offset", offset);

      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?${params}`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`
        }
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Airtable error: ${resp.status} ${text}`);
      }

      const data = await resp.json();
      records.push(...(data.records || []));
      offset = data.offset || null;
    } while (offset);
  };

  const viewValue = view === undefined ? (AIRTABLE_VIEW || "Mapfluence_Rooms") : view;
  try {
    await tryFetch(viewValue);
  } catch (err) {
    if (viewValue) {
      offset = null;
      records.length = 0;
      await tryFetch(null);
    } else {
      throw err;
    }
  }

  return records;
}

function filtersToAirtableFormula(filters) {
  if (!filters || !filters.length) return "";

  const parts = filters.map(f => {
    const field = `{${f.field}}`;

    if (f.op === "contains") {
      return `FIND("${f.value}", ${field})`;
    }
    if (f.op === "=") {
      return `${field}="${f.value}"`;
    }
    if (f.op === "is_empty") {
      return `${field}=""`;
    }
    if (f.op === "not_empty") {
      return `${field}!=""`;
    }

    throw new Error(`Unsupported op for demo: ${f.op}`);
  });

  return parts.length === 1 ? parts[0] : `AND(${parts.join(",")})`;
}

function escapeFormulaValue(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const out = [];
  values.forEach((value) => {
    const v = String(value ?? "").trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  });
  return out;
}

function buildFieldEqualsClause(fields = [], values = []) {
  const fieldList = uniqueStrings(fields);
  const valueList = uniqueStrings(values);
  if (!fieldList.length || !valueList.length) return null;
  const clauses = [];
  fieldList.forEach((field) => {
    const fieldExpr = `{${field}}`;
    valueList.forEach((value) => {
      const escaped = escapeFormulaValue(value);
      clauses.push(`${fieldExpr}="${escaped}"`);
      const raw = String(value ?? "").trim();
      if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
        clauses.push(`${fieldExpr}=${raw}`);
      }
    });
  });
  if (!clauses.length) return null;
  return clauses.length === 1 ? clauses[0] : `OR(${clauses.join(",")})`;
}

async function fetchAirtableTableRecords(tableName, { filterFormula, view } = {}) {
  const params = new URLSearchParams();
  if (view) params.set("view", view);
  if (filterFormula) params.set("filterByFormula", filterFormula);
  params.set("pageSize", "5");

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}?${params}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`
    }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Airtable error: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  return data.records || [];
}

async function fetchAirtableBaseSchema() {
  if (tablePrimaryFieldCache.has("__schema__")) {
    return tablePrimaryFieldCache.get("__schema__");
  }
  const url = `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`
    }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Airtable schema error: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  tablePrimaryFieldCache.set("__schema__", data);
  return data;
}

async function resolvePrimaryFieldName(tableName, explicitField) {
  if (explicitField) return explicitField;
  if (tablePrimaryFieldCache.has(tableName)) {
    return tablePrimaryFieldCache.get(tableName);
  }
  try {
    const schema = await fetchAirtableBaseSchema();
    const table = (schema?.tables || []).find((t) => t?.name === tableName);
    const primaryId = table?.primaryFieldId;
    const primary = (table?.fields || []).find((f) => f?.id === primaryId);
    const name = primary?.name || "";
    if (name) {
      tablePrimaryFieldCache.set(tableName, name);
      return name;
    }
  } catch (err) {
    console.warn(`Unable to read Airtable schema for ${tableName}`, err?.message || err);
  }
  return "";
}

async function resolveLinkedRecordId(tableName, primaryFieldName, label) {
  if (!tableName) return null;
  const raw = String(label ?? "").trim();
  if (!raw) return null;
  const normKey = `${tableName}|${normalizeLoose(raw)}`;
  if (linkedRecordCache.has(normKey)) {
    return linkedRecordCache.get(normKey);
  }
  const primaryField = await resolvePrimaryFieldName(tableName, primaryFieldName);
  if (!primaryField) return null;
  const lower = raw.toLowerCase();
  const filter = `LOWER({${primaryField}})="${escapeFormulaValue(lower)}"`;
  const records = await fetchAirtableTableRecords(tableName, { filterFormula: filter });
  const id = records?.[0]?.id || null;
  if (id) {
    linkedRecordCache.set(normKey, id);
  }
  return id;
}

async function resolveLinkedFields(updateFields = {}) {
  const next = { ...updateFields };
  if (AIRTABLE_TYPE_FIELD in next) {
    const value = next[AIRTABLE_TYPE_FIELD];
    if (Array.isArray(value)) {
      // ok
    } else if (String(value ?? "").trim()) {
      if (!AIRTABLE_ROOM_TYPE_TABLE) {
        throw new Error("AIRTABLE_ROOM_TYPE_TABLE is required for Room Type Description");
      }
      const id = await resolveLinkedRecordId(
        AIRTABLE_ROOM_TYPE_TABLE,
        AIRTABLE_ROOM_TYPE_PRIMARY_FIELD,
        value
      );
      if (!id) {
        throw new Error(`Room Type not found: ${value}`);
      }
      next[AIRTABLE_TYPE_FIELD] = [id];
    } else {
      next[AIRTABLE_TYPE_FIELD] = [];
    }
  }
  if (AIRTABLE_DEPT_FIELD in next) {
    const value = next[AIRTABLE_DEPT_FIELD];
    if (Array.isArray(value)) {
      // ok
    } else if (String(value ?? "").trim()) {
      if (!AIRTABLE_DEPT_TABLE) {
        throw new Error("AIRTABLE_DEPT_TABLE is required for Department");
      }
      const id = await resolveLinkedRecordId(
        AIRTABLE_DEPT_TABLE,
        AIRTABLE_DEPT_PRIMARY_FIELD,
        value
      );
      if (!id) {
        throw new Error(`Department not found: ${value}`);
      }
      next[AIRTABLE_DEPT_FIELD] = [id];
    } else {
      next[AIRTABLE_DEPT_FIELD] = [];
    }
  }
  return next;
}

async function getLinkedLabelMap(tableName, primaryFieldName) {
  if (!tableName || !primaryFieldName) return null;
  const cacheKey = `${tableName}|${primaryFieldName}`;
  const cached = linkedLabelCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < LINKED_LABEL_CACHE_TTL_MS) {
    return cached.map;
  }
  const records = await fetchAirtableAllRecords({
    table: tableName,
    view: null,
    fields: [primaryFieldName]
  });
  const map = new Map();
  records.forEach((record) => {
    const label = record?.fields?.[primaryFieldName];
    const value = String(label ?? "").trim();
    if (value) map.set(record.id, value);
  });
  linkedLabelCache.set(cacheKey, { ts: Date.now(), map });
  return map;
}

function resolveLinkedLabel(value, labelMap) {
  if (!isLinkedRecordArray(value)) return value;
  const labels = value
    .map((id) => labelMap?.get(id) || "")
    .filter(Boolean);
  return labels.length ? labels[0] : "";
}

function normalizeLoose(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function looksLikeMachineRoomIdentifier(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  if (isAirtableRecordId(raw)) return true;
  if (/^[{(]?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:-[0-9a-f]{2,})?[)}]?$/i.test(raw)) return true;
  if (/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:-[0-9a-f]{2,})?/i.test(raw) && raw.length >= 24) return true;
  if (/^[0-9a-f]{24,}$/i.test(raw)) return true;
  if (raw.includes("|")) return true;
  return false;
}

function pickReadableRoomNumber(...candidates) {
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (!text) continue;
    if (looksLikeMachineRoomIdentifier(text)) continue;
    return text;
  }
  return "";
}

function parseEnvFieldList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function expandBuildingValues(values = []) {
  const out = [];
  values.forEach((value) => {
    const v = String(value ?? "").trim();
    if (!v) return;
    out.push(v);
    const noPunct = v.replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
    if (noPunct && noPunct !== v) out.push(noPunct);
  });
  return uniqueStrings(out);
}

function expandFloorValues(values = []) {
  const out = [];
  values.forEach((value) => {
    const v = String(value ?? "").trim();
    if (!v) return;
    out.push(v);
    const upper = v.toUpperCase();
    const levelMatch = upper.match(/LEVEL[_\s]*(\d+)/);
    if (levelMatch?.[1]) {
      out.push(levelMatch[1]);
      out.push(`Level ${levelMatch[1]}`);
      out.push(`LEVEL ${levelMatch[1]}`);
    }
    if (upper === "BASEMENT") {
      out.push("Basement");
    }
  });
  return uniqueStrings(out);
}

app.get("/api/rooms", async (req, res) => {
  try {
    const table = AIRTABLE_TABLE || "Rooms";
    const view = req.query.view || AIRTABLE_VIEW || "Mapfluence_Rooms";

    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !table) {
      return res.status(500).json({ ok: false, error: "Missing Airtable config." });
    }

    const explicitFields = AIRTABLE_FIELDS
      ? AIRTABLE_FIELDS.split(",").map((f) => f.trim()).filter(Boolean)
      : null;
    const requiredFields = uniqueStrings([
      ...parseEnvFieldList(process.env.AIRTABLE_ROOM_ID_FIELD),
      ...parseEnvFieldList(process.env.AIRTABLE_ROOM_GUID_FIELD),
      ...parseEnvFieldList(process.env.AIRTABLE_BUILDING_FIELD),
      ...parseEnvFieldList(process.env.AIRTABLE_BUILDING_NAME_FIELD),
      ...parseEnvFieldList(process.env.AIRTABLE_FLOOR_FIELD),
      ...parseEnvFieldList(process.env.AIRTABLE_OCC_STATUS_FIELD),
      ...parseEnvFieldList(process.env.AIRTABLE_OCCUPANT_FIELD),
      ...parseEnvFieldList(process.env.AIRTABLE_DEPT_FIELD),
      ...parseEnvFieldList(process.env.AIRTABLE_TYPE_FIELD),
      ...parseEnvFieldList(process.env.AIRTABLE_SEAT_FIELD),
      "Room ID",
      "RoomId",
      "Room ID Text",
      "Room Number",
      "RoomNumber",
      "Number",
      "Room GUID",
      "Room Guid",
      "RoomGuid",
      "Revit_UniqueId",
      "Revit Unique Id",
      "Revit UniqueID",
      "Revit GUID",
      "Building",
      "Building Name",
      "Floor",
      "Level",
      "Level Name",
      "Occupancy Status",
      "Occupancy",
      "Vacancy",
      "Occupant",
      "Assigned To",
      "Assignee",
      "Department",
      "Type",
      "Seat Count"
    ]);
    const requestFields =
      explicitFields && explicitFields.length
        ? uniqueStrings([...explicitFields, ...requiredFields])
        : null;

    const records = await fetchAirtableAllRecords({
      table,
      view,
      fields: requestFields && requestFields.length ? requestFields : null
    });

    const rooms = records.map((r) => {
      const f = r.fields || {};
      const buildingRaw = pickFieldValue(f, [
        AIRTABLE_BUILDING_NAME_FIELD,
        AIRTABLE_BUILDING_FIELD,
        "Building Name",
        "Building"
      ]);
      const building = Array.isArray(buildingRaw)
        ? buildingRaw.join(", ")
        : String(buildingRaw || "");
      const type = pickFieldValue(f, [
        process.env.AIRTABLE_TYPE_FIELD,
        "NCES Type Description",
        "NCES_Type",
        "NCES Type",
        "Room Type",
        "Room Type Text",
        "Type"
      ]);
      const dept = pickFieldValue(f, [
        process.env.AIRTABLE_DEPT_FIELD,
        "Department",
        "Department Owner",
        "Dept",
        "NCES_Department",
        "NCES Dept"
      ]);
      const areaRaw = pickFieldValue(f, [
        process.env.AIRTABLE_AREA_FIELD,
        "AreaSF",
        "Area_SF",
        "Area (SF)",
        "Room Area Sq Ft",
        "Area SF",
        "Area",
        "NetArea",
        "Net Area"
      ]);
      const floor = pickFieldValue(f, [
        process.env.AIRTABLE_FLOOR_FIELD,
        "Floor",
        "Level",
        "LevelName",
        "Level Name"
      ]);
      const occupancyStatus = pickFieldValue(f, [
        process.env.AIRTABLE_OCC_STATUS_FIELD,
        "Occupancy Status",
        "NCES_Occupancy Status",
        "Occupancy",
        "Vacancy"
      ]);
      const occupant = pickFieldValue(f, [
        process.env.AIRTABLE_OCCUPANT_FIELD,
        "Occupant",
        "Assigned To",
        "AssignedTo",
        "Assignee"
      ]);
      const seatCount = pickFieldValue(f, [
        process.env.AIRTABLE_SEAT_FIELD,
        "Seat Count",
        "NCES_Seat Count",
        "SeatCount"
      ]);
      const roomIdFields = parseEnvFieldList(process.env.AIRTABLE_ROOM_ID_FIELD);
      const roomIdRaw = pickFieldValue(f, [
        ...roomIdFields,
        "Room ID",
        "RoomId",
        "Room ID Text",
        "Room Number"
      ]);
      const roomNumberRaw = pickFieldValue(f, [
        process.env.AIRTABLE_ROOM_NUMBER_FIELD,
        "Room ID",
        "RoomId",
        "Room ID Text",
        "Room Number",
        "RoomNumber",
        "Number",
        "Room No",
        "Room"
      ]);
      const roomNumber = pickReadableRoomNumber(roomNumberRaw, roomIdRaw);
      const roomId = roomNumber || String(roomIdRaw || "").trim();
      const roomGuid = pickFieldValue(f, [
        "Room GUID",
        "Room Guid",
        "RoomGuid",
        "Revit_UniqueId",
        "Revit Unique Id",
        "Revit UniqueID",
        "Revit GUID"
      ]);

      return {
        airtableId: r.id,
        roomId,
        roomNumber,
        roomGuid,
        building,
        floor,
        areaSF: Number(areaRaw ?? 0) || 0,
        type,
        department: dept,
        occupant,
        seatCount: Number(seatCount ?? 0) || 0,
        occupancyStatus: occupancyStatus || "Unknown"
      };
    });

    const needsTypeLabels = rooms.some((room) => isLinkedRecordArray(room?.type));
    const needsDeptLabels = rooms.some((room) => isLinkedRecordArray(room?.department));
    let roomTypeLabelMap = null;
    let deptLabelMap = null;
    if (needsTypeLabels) {
      roomTypeLabelMap = await getLinkedLabelMap(
        AIRTABLE_ROOM_TYPE_TABLE,
        AIRTABLE_ROOM_TYPE_PRIMARY_FIELD
      );
    }
    if (needsDeptLabels) {
      deptLabelMap = await getLinkedLabelMap(
        AIRTABLE_DEPT_TABLE,
        AIRTABLE_DEPT_PRIMARY_FIELD
      );
    }
    if (roomTypeLabelMap || deptLabelMap) {
      rooms.forEach((room) => {
        if (roomTypeLabelMap && isLinkedRecordArray(room?.type)) {
          room.type = resolveLinkedLabel(room.type, roomTypeLabelMap);
        }
        if (deptLabelMap && isLinkedRecordArray(room?.department)) {
          room.department = resolveLinkedLabel(room.department, deptLabelMap);
        }
      });
    }

    res.json({ ok: true, rooms });
  } catch (err) {
    console.error("GET /api/rooms failed", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to load rooms" });
  }
});

app.patch("/api/rooms/:airtableId", async (req, res) => {
  try {
    const table = AIRTABLE_TABLE || "Rooms";
    const { airtableId } = req.params || {};
    const body = req.body || {};
    const {
      fields,
      occupancyStatus,
      occupant,
      department,
      type,
      comments,
      seatCount
    } = body;
    const hasOccupant = Object.prototype.hasOwnProperty.call(body, "occupant");
    const hasSeatCount = Object.prototype.hasOwnProperty.call(body, "seatCount");
    const occupantValue = hasOccupant && typeof occupant === "string" ? occupant.trim() : occupant;
    const normalizedOccupant = hasOccupant && occupantValue === "" ? null : occupantValue;
    const seatCountValue = hasSeatCount ? seatCount : undefined;

    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !table) {
      return res.status(500).json({ ok: false, error: "Missing Airtable config." });
    }
    if (!airtableId || (!fields && occupancyStatus == null && !hasOccupant && !hasSeatCount && department == null && type == null && comments == null)) {
      return res.status(400).json({ ok: false, error: "Missing airtableId or fields" });
    }

    const updateFields = (fields && typeof fields === "object") ? { ...fields } : {};
    if (occupancyStatus != null) updateFields[AIRTABLE_OCC_STATUS_FIELD] = occupancyStatus;
    if (hasOccupant) updateFields[AIRTABLE_OCCUPANT_FIELD] = normalizedOccupant;
    if (hasSeatCount) updateFields[AIRTABLE_SEAT_FIELD] = seatCountValue;
    if (department != null) updateFields[AIRTABLE_DEPT_FIELD] = department;
    if (type != null) updateFields[AIRTABLE_TYPE_FIELD] = type;
    if (comments != null) updateFields[AIRTABLE_COMMENTS_FIELD] = comments;

    if (!Object.keys(updateFields).length) {
      return res.status(400).json({ ok: false, error: "No fields to update" });
    }
    const resolvedFields = await resolveLinkedFields(updateFields);

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${airtableId}`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: resolvedFields })
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Airtable PATCH by id failed", { status: resp.status, text });
      return res.status(500).json({ ok: false, error: text });
    }

    const data = await resp.json();
    return res.json({ ok: true, id: data?.id || airtableId });
  } catch (err) {
    console.error("PATCH /api/rooms failed", err);
    res.status(500).json({ ok: false, error: "Failed to update room" });
  }
});

app.patch("/api/rooms", async (req, res) => {
  try {
    const table = AIRTABLE_TABLE || "Rooms";
    const body = req.body || {};
    const {
      roomGuid,
      roomId,
      roomNumber,
      roomLabel,
      building,
      buildingName,
      floor,
      fields,
      occupancyStatus,
      occupant,
      department,
      type,
      comments,
      seatCount
    } = body;
    const hasOccupant = Object.prototype.hasOwnProperty.call(body, "occupant");
    const hasSeatCount = Object.prototype.hasOwnProperty.call(body, "seatCount");
    const occupantValue = hasOccupant && typeof occupant === "string" ? occupant.trim() : occupant;
    const normalizedOccupant = hasOccupant && occupantValue === "" ? null : occupantValue;
    const seatCountValue = hasSeatCount ? seatCount : undefined;

    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !table) {
      return res.status(500).json({ ok: false, error: "Missing Airtable config." });
    }

    const roomIdValue = String(roomId ?? "").trim();
    const roomNumberValue = String(roomNumber ?? "").trim();
    const roomLabelValue = String(roomLabel ?? "").trim();
    const roomGuidValue = String(roomGuid ?? "").trim();
    const hasLookupValue = Boolean(roomIdValue || roomNumberValue || roomLabelValue || roomGuidValue);
    if (hasLookupValue) {
      console.log(
        `[rooms] match roomId=${roomIdValue || "-"} roomNumber=${roomNumberValue || "-"} roomLabel=${roomLabelValue || "-"} roomGuid=${roomGuidValue || "-"}`
      );
    }
    if (!hasLookupValue) {
      return res.status(400).json({ ok: false, error: "roomId required" });
    }

    const updateFields = (fields && typeof fields === "object") ? { ...fields } : {};
    if (!fields) {
      if (occupancyStatus != null) updateFields[AIRTABLE_OCC_STATUS_FIELD] = occupancyStatus;
      if (hasOccupant) updateFields[AIRTABLE_OCCUPANT_FIELD] = normalizedOccupant;
      if (hasSeatCount) updateFields[AIRTABLE_SEAT_FIELD] = seatCountValue;
      if (department != null) updateFields[AIRTABLE_DEPT_FIELD] = department;
      if (type != null) updateFields[AIRTABLE_TYPE_FIELD] = type;
      if (comments != null) updateFields[AIRTABLE_COMMENTS_FIELD] = comments;
    }

    if (!Object.keys(updateFields).length) {
      return res.status(400).json({ ok: false, error: "No fields to update" });
    }

    const roomFields = parseEnvFieldList(process.env.AIRTABLE_ROOM_ID_FIELD);
    if (!roomFields.length) {
      return res.status(400).json({
        ok: false,
        error: "AIRTABLE_ROOM_ID_FIELD is required to update by roomId"
      });
    }
    const roomGuidFields = parseEnvFieldList(process.env.AIRTABLE_ROOM_GUID_FIELD).concat([
      "Room GUID",
      "Room Guid",
      "RoomGuid",
      "Revit_UniqueId",
      "Revit Unique Id",
      "Revit UniqueID",
      "Revit GUID"
    ]);
    const buildingFields = parseEnvFieldList(process.env.AIRTABLE_BUILDING_FIELD)
      .concat(parseEnvFieldList(process.env.AIRTABLE_BUILDING_NAME_FIELD));
    const floorFields = parseEnvFieldList(process.env.AIRTABLE_FLOOR_FIELD);

    const buildingValues = expandBuildingValues([building, buildingName]);
    const floorValues = expandFloorValues([floor]);

    const roomLookupValues = uniqueStrings([roomIdValue, roomNumberValue, roomLabelValue]);
    const roomGuidLookupValues = uniqueStrings([roomGuidValue]);
    const roomIdClause = buildFieldEqualsClause(roomFields, roomLookupValues);
    const roomGuidClause = buildFieldEqualsClause(roomGuidFields, roomGuidLookupValues);
    const roomClause = roomIdClause && roomGuidClause
      ? `OR(${roomIdClause},${roomGuidClause})`
      : (roomIdClause || roomGuidClause);
    const buildingClause = buildFieldEqualsClause(buildingFields, buildingValues);
    const floorClause = buildFieldEqualsClause(floorFields, floorValues);
    if (!roomClause) {
      return res.status(400).json({ ok: false, error: "Missing room field mapping" });
    }
    const formulaParts = [roomClause, buildingClause, floorClause].filter(Boolean);
    const formula = formulaParts.length > 1 ? `AND(${formulaParts.join(",")})` : formulaParts[0];

    const view = req.query.view || AIRTABLE_VIEW || "Mapfluence_Rooms";
    const safeLookup = async (formulaText, label) => {
      if (!formulaText) return [];
      try {
        return await fetchAirtableRows(formulaText, view);
      } catch (err) {
        const msg = String(err?.message || err || "");
        const invalidFormulaUnknownFields =
          /INVALID_FILTER_BY_FORMULA/i.test(msg) && /Unknown field names/i.test(msg);
        if (invalidFormulaUnknownFields) {
          console.warn(`[rooms] lookup skipped (${label}) due to Airtable formula field mismatch`);
          return [];
        }
        throw err;
      }
    };

    let records = await safeLookup(formula, "room+building+floor");
    const roomBaseClause = roomIdClause || roomClause;

    if (!records.length && roomIdClause && roomClause !== roomIdClause) {
      const idOnlyParts = [roomIdClause, buildingClause, floorClause].filter(Boolean);
      const idOnlyFormula = idOnlyParts.length > 1 ? `AND(${idOnlyParts.join(",")})` : idOnlyParts[0];
      records = await safeLookup(idOnlyFormula, "roomId+building+floor");
    }
    if (!records.length && floorClause) {
      const noFloorParts = [roomBaseClause, buildingClause].filter(Boolean);
      const noFloorFormula = noFloorParts.length > 1 ? `AND(${noFloorParts.join(",")})` : noFloorParts[0];
      records = await safeLookup(noFloorFormula, "room+building");
    }
    if (!records.length && buildingClause) {
      records = await safeLookup(roomBaseClause, "room-only");
    }
    if (!records.length) {
      return res.status(404).json({ ok: false, error: "Room not found" });
    }

    let target = records[0];
    if (records.length > 1 && (buildingValues.length || floorValues.length)) {
      const narrowed = records.filter((record) => {
        const f = record?.fields || {};
        const recBuilding = pickFieldValue(f, buildingFields);
        const recFloor = pickFieldValue(f, floorFields);
        const buildingOk = buildingValues.length
          ? buildingValues.some((val) => normalizeLoose(val) === normalizeLoose(recBuilding))
          : true;
        const floorOk = floorValues.length
          ? floorValues.some((val) => normalizeLoose(val) === normalizeLoose(recFloor))
          : true;
        return buildingOk && floorOk;
      });
      if (narrowed.length === 1) {
        target = narrowed[0];
      } else if (narrowed.length > 1) {
        return res.status(409).json({ ok: false, error: "Multiple rooms matched", count: narrowed.length });
      }
    }

    const resolvedFields = await resolveLinkedFields(updateFields);

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${target.id}`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: resolvedFields })
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Airtable PATCH by lookup failed", { status: resp.status, text });
      return res.status(500).json({ ok: false, error: text });
    }

    const data = await resp.json();
    return res.json({ ok: true, id: data?.id || target.id });
  } catch (err) {
    console.error("PATCH /api/rooms (by roomId) failed", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to update room" });
  }
});


app.post("/explain-floor", async (req, res) => {
  try {
    const { context, floorStats, panelStats } = req.body || {};
    if (!floorStats && !panelStats) {
      return res.status(400).json({ error: "Missing floorStats/panelStats" });
    }

    const schema = {
      name: "floor_explanation",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          insights: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 6
          }
        },
        required: ["title", "summary", "insights"]
      },
      strict: true
    };

    console.log("OPENAI key loaded?", Boolean(process.env.OPENAI_API_KEY));

    const userContent = await buildUserContentWithAiDocs(
      { context, floorStats, panelStats },
      { warnLabel: "explain-floor" }
    );

    const resp = await client.responses.create({
      model: AI_MODEL,
      input: [
        {
          role: "system",
          content: "Use only provided data and attached reference documents; do not speculate or invent facts."
        },
        { role: "user", content: userContent }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "floor_explanation",
          schema: schema.schema
        }
      }
    });

    res.json(JSON.parse(resp.output_text || "{}"));
  } catch (err) {
    console.error("AI server error (full):", err);

    const msg =
      err?.error?.message ||
      err?.message ||
      (typeof err === "string" ? err : JSON.stringify(err));

    res.status(500).json({ error: msg });
  }
});


app.post("/explain-building", async (req, res) => {
  try {
    const { context, buildingStats, panelStats } = req.body || {};
    if (!buildingStats && !panelStats) {
      return res.status(400).json({ error: "Missing buildingStats/panelStats" });
    }

    const schema = {
      name: "building_explanation",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          insights: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 7 }
        },
        required: ["title", "summary", "insights"]
      }
    };

    const userContent = await buildUserContentWithAiDocs(
      { context, buildingStats, panelStats },
      { warnLabel: "explain-building" }
    );

    const resp = await client.responses.create({
      model: AI_MODEL,
      input: [
        {
          role: "system",
          content: "Use only provided data and attached reference documents; do not speculate or invent facts."
        },
        { role: "user", content: userContent }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "building_explanation",
          schema: schema.schema,
          strict: true
        }
      }
    });

    res.json(JSON.parse(resp.output_text || "{}"));
  } catch (err) {
    console.error("AI server error (building):", err);
    res.status(500).json({ error: err?.message || "AI building explain failed" });
  }
});


app.post("/explain-campus", async (req, res) => {
  try {
    const { context, campusStats, panelStats } = req.body || {};
    if (!campusStats && !panelStats) {
      return res.status(400).json({ error: "Missing campusStats/panelStats" });
    }

    const schema = {
      name: "campus_explanation",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          insights: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 8
          }
        },
        required: ["title", "summary", "insights"]
      }
    };

    const explainInput = buildExplainCampusPayload({ context, campusStats, panelStats });
    if (explainInput.wasCompacted) {
      console.log(
        `[explain-campus] compacted large input (chars=${explainInput.rawChars}) -> model=${explainInput.model}, docs=${explainInput.includeDocs ? "on" : "off"}`
      );
    }
    const userContent = await buildUserContentWithAiDocs(
      explainInput.payload,
      { warnLabel: "explain-campus", includeDocs: explainInput.includeDocs }
    );

    const resp = await client.responses.create({
      model: explainInput.model,
      input: [
        {
          role: "system",
          content:
            "Generate a high-level campus summary using only the provided data and attached reference documents. Do not speculate, recommend actions, or assume future changes."
        },
        {
          role: "user",
          content: userContent
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "campus_explanation",
          schema: schema.schema,
          strict: true
        }
      }
    });

    res.json(JSON.parse(resp.output_text || "{}"));
  } catch (err) {
    console.error("AI campus error:", err);
    res.status(500).json({ error: err?.message || "AI campus explain failed" });
  }
});


async function handleCompareScenario(req, res) {
  try {
    const {
      context,
      baselineStats,
      scenarioStats,
      deltas,
      scenarioDept = ""
    } = req.body || {};

    if (!baselineStats || !scenarioStats) {
      return res.status(400).json({ error: "Missing baselineStats or scenarioStats" });
    }

    const schema = {
      name: "scenario_only_comparison",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          scenarioDept: { type: "string" },
          scenarioPros: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 10 },
          scenarioCons: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 10 },
          risks: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 10 },
          notes: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 10 }
        },
        required: [
          "summary",
          "scenarioDept",
          "scenarioPros",
          "scenarioCons",
          "risks",
          "notes"
        ]
      }
    };

    const resp = await client.responses.create({
      model: AI_MODEL,
      input: [
        {
          role: "system",
          content:
            "You are comparing a proposed SCENARIO for a selected department against CURRENT (baseline). " +
            "Return ONLY JSON matching the schema. " +
            "Write pros/cons ONLY for the scenario (not baseline). " +
            "Use only the provided stats and deltas; do not invent missing fields. " +
            "Treat all rooms as eligible unless the user explicitly requested 'vacant only'. " +
            "If scenarioDept is empty, infer it from context only if explicitly present; otherwise return an empty string."
        },
        {
          role: "user",
          content: JSON.stringify({ context, baselineStats, scenarioStats, deltas, scenarioDept }, null, 2)
        }
      ],
      text: { format: { type: "json_schema", name: "scenario_only_comparison", schema: schema.schema, strict: true } }
    });

    const out = JSON.parse(resp.output_text || "{}");

    // harden: ensure keys always exist
    res.json({
      summary: out.summary || "",
      scenarioDept: out.scenarioDept || scenarioDept || "",
      scenarioPros: Array.isArray(out.scenarioPros) ? out.scenarioPros : [],
      scenarioCons: Array.isArray(out.scenarioCons) ? out.scenarioCons : [],
      risks: Array.isArray(out.risks) ? out.risks : [],
      notes: Array.isArray(out.notes) ? out.notes : []
    });
  } catch (err) {
    console.error("AI scenario error:", err);
    res.status(500).json({ error: err?.message || "AI scenario compare failed" });
  }
}

app.post("/compare-scenario", handleCompareScenario);
app.post("/compare-scenario-vs-current", handleCompareScenario);

app.post("/create-move-scenario", async (req, res) => {
  try {
    const { request, context, inventory, constraints } = req.body || {};
    if (!request || !String(request).trim()) return res.status(400).json({ error: "Missing request" });

    const minifyMoveScenarioInventory = (rooms, options = {}) => {
      if (!Array.isArray(rooms) || rooms.length === 0) return [];
      const maxTotal = Number.isFinite(options.maxTotal) ? options.maxTotal : 200;
      const minimal = rooms.map((room) => ({
        roomId: room?.roomId ?? room?.id ?? "",
        id: room?.id ?? room?.roomId ?? "",
        revitId: room?.revitId ?? room?.roomGuid ?? "",
        buildingLabel: room?.buildingLabel ?? room?.buildingName ?? room?.building ?? "",
        floorId: room?.floorId ?? room?.floorName ?? "",
        floorName: room?.floorName ?? room?.floorId ?? "",
        roomLabel: room?.roomLabel ?? room?.roomNumber ?? "",
        type: room?.type ?? room?.roomType ?? "",
        sf: Number(room?.sf ?? room?.area ?? room?.areaSF ?? 0) || 0
      })).filter((room) => room.roomId || room.id);
      if (minimal.length <= maxTotal) return minimal;
      minimal.sort((a, b) => (Number(b.sf) || 0) - (Number(a.sf) || 0));
      return minimal.slice(0, maxTotal);
    };

    const scope = String(context?.scope || "").toLowerCase();
    const maxTotal = scope === "building" ? 260 : 220;
    const safeInventory = minifyMoveScenarioInventory(inventory, { maxTotal });

    const schema = {
      name: "move_scenario_plan",
      schema: {
        type: "object",
        additionalProperties: false,
          properties: {
            title: { type: "string" },
            interpretedIntent: { type: "string" },
            scenarioDept: { type: "string" },
            baselineTotals: {
              type: "object",
              additionalProperties: false,
              properties: {
                totalSF: { type: "number" },
                rooms: { type: "number" },
                sfByType: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      type: { type: "string" },
                      sf: { type: "number" }
                    },
                    required: ["type", "sf"]
                  }
                }
              },
              required: ["totalSF", "rooms", "sfByType"]
            },
            scenarioTotals: {
              type: "object",
              additionalProperties: false,
              properties: {
                totalSF: { type: "number" },
                rooms: { type: "number" },
                sfByType: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      type: { type: "string" },
                      sf: { type: "number" }
                    },
                    required: ["type", "sf"]
                  }
                }
              },
              required: ["totalSF", "rooms", "sfByType"]
            },
            assumptions: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 8 },
            selectionCriteria: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 10 },
            recommendedCandidates: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  roomId: { type: "string" },
                  id: { type: "string" },
                  revitId: { type: "string" },
                  buildingLabel: { type: "string" },
                  floorId: { type: "string" },
                  floorName: { type: "string" },
                  roomLabel: { type: "string" },
                  type: { type: "string" },
                  sf: { type: "number" },
                  rationale: { type: "string" }
                },
                required: ["roomId", "id", "revitId", "buildingLabel", "floorId", "floorName", "roomLabel", "type", "sf", "rationale"]
              },
            minItems: 0,
            maxItems: 25
          },
          nextSteps: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 8 }
          },
          required: ["title", "interpretedIntent", "scenarioDept", "baselineTotals", "scenarioTotals", "assumptions", "selectionCriteria", "recommendedCandidates", "nextSteps"]
        }
      };

    const userContent = await buildUserContentWithAiDocs(
      { request, context, constraints, inventory: safeInventory },
      { warnLabel: "create-move-scenario" }
    );

    const resp = await client.responses.create({
      model: AI_MODEL,
      input: [
        {
          role: "system",
          content: `You are helping create a move scenario by selecting candidate rooms from the provided campus-wide inventory and attached reference documents. Consider all buildings and floors unless the user explicitly restricts scope. Use only provided inventory/context/reference docs. Echo back roomId/revitId exactly as provided so the client can map results. Return each recommendation with revitId and floorName. If inventory is limited, return fewer candidates and explain assumptions. Do not fabricate rooms.

IMPORTANT:
- Do NOT filter candidates by vacancy/occupancy. Consider ALL rooms in the target building.
- Do NOT treat current department/occupant assignments as constraints unless the user explicitly asks for it.
- If context.excludeBuildings is provided, do NOT recommend rooms in those buildings (current home).
- Primary objective: replicate the source department's footprint as closely as possible:
  - total SF (+/-10-15% if possible)
  - room type mix using NCES_Type (match SF by type)
  - count of key functional types (labs, classrooms, offices if present)
- Do NOT assume vacant-only unless explicitly stated by the user.
- Treat this as a planning scenario (not a commitment): ignore occupancy/displacement in ranking unless the user explicitly asks to include it.

Building fit + consolidation:
- Prefer building-function compatibility. For academic departments, avoid facilities/maintenance/service-heavy buildings unless no viable alternatives exist.
- If constraints.preferAcademicFit is true, treat constraints.lowFitBuildings as avoid-by-default.
- Treat constraints.offlineBuildings as exclude-by-default unless the user explicitly asks to include them.
- For non-athletics departments, avoid athletics/gym/arena/fieldhouse spaces unless explicitly requested or clearly required to satisfy a missing specialized baseline type.
- If constraints.preferSingleBuilding is true (especially when constraints.sourceHomeBuildingCount <= 1), concentrate recommendations in one primary destination building.
- Only split into additional buildings when needed to meet footprint/type targets, and prefer split exceptions for classroom/specialized space needs (see constraints.crossBuildingExceptionTypes if provided).
- If you must use low-fit or multi-building recommendations, explain the reason explicitly in assumptions.

Vacancy/occupancy:
- DO NOT require rooms to be vacant.
- DO NOT use vacancy as a primary filter.
- Only mention vacancy if the user explicitly asks for "vacant only" or "avoid displacing".
- If you don't have reliable vacancy data, ignore it completely.

Baseline/targets:
- If constraints.baselineTotals is provided, use it as the target footprint.
- Aim for total SF within +/- (constraints.targetSfTolerance or 0.10) of baselineTotals.totalSF.
- If constraints.targetSfTolerance <= 0.05 (strict mode), do not intentionally exceed the upper SF bound; prefer a slight under-target and call out why.
- Match sfByType / roomTypes mix as closely as possible.
- Keep adding best-fit rooms until you reach the target range or exhaust the inventory.
- If no single suitable building can reach the target, select across multiple buildings.
- If you cannot reach the target range or type mix, say so explicitly in assumptions and selectionCriteria.

Return:
- scenarioDept (string)
- baselineTotals: totalSF, rooms, sfByType[] (array of {type, sf}) for the source department
- scenarioTotals: totalSF, rooms, sfByType[] (array of {type, sf}) for selected candidates

Score rooms/buildings using:
1. NCES room type similarity (highest weight)
2. Building fit for department function and consolidation preference
3. Area match (+/- 20%)`
        },
        {
          role: "user",
          content: userContent
        }
      ],
      text: { format: { type: "json_schema", name: "move_scenario_plan", schema: schema.schema, strict: true } }
    });

    res.json(JSON.parse(resp.output_text || "{}"));
  } catch (err) {
    console.error("AI create scenario error:", err);
    res.status(500).json({ error: err?.message || "AI create scenario failed" });
  }
});

function normalizeCopilotText(value) {
  return String(value ?? "").trim();
}

function normalizeCopilotTypeKey(value) {
  return normalizeLoose(value).replace(/\d+/g, "");
}

function toCopilotRoom(room) {
  const roomId = normalizeCopilotText(room?.roomId ?? room?.id);
  const id = normalizeCopilotText(room?.id ?? room?.roomId ?? roomId);
  const revitId = normalizeCopilotText(room?.revitId ?? room?.roomGuid ?? roomId);
  const buildingLabel = normalizeCopilotText(room?.buildingLabel ?? room?.buildingName ?? room?.building);
  const floorId = normalizeCopilotText(room?.floorId ?? room?.floorName);
  const floorName = normalizeCopilotText(room?.floorName ?? room?.floorId ?? floorId);
  const roomLabel = normalizeCopilotText(room?.roomLabel ?? room?.roomNumber ?? roomId);
  const type = normalizeCopilotText(room?.type ?? room?.roomType);
  const sf = Number(room?.sf ?? room?.area ?? room?.areaSF ?? 0) || 0;
  const occupant = normalizeCopilotText(room?.occupant ?? room?.occupantName);
  const occupancyStatus = normalizeCopilotText(room?.occupancyStatus);
  const occupantDept = normalizeCopilotText(room?.occupantDept ?? room?.department);
  const vacancyRaw = room?.vacancy;
  const vacancy = typeof vacancyRaw === "boolean"
    ? vacancyRaw
    : (typeof vacancyRaw === "number" ? vacancyRaw > 0 : null);
  if (!id || !roomId || !buildingLabel || !Number.isFinite(sf) || sf <= 0) return null;
  return {
    roomId,
    id,
    revitId,
    buildingLabel,
    buildingKey: normalizeLoose(buildingLabel),
    floorId,
    floorName,
    roomLabel,
    type,
    typeKey: normalizeCopilotTypeKey(type),
    sf,
    occupant,
    occupancyStatus,
    occupantDept,
    vacancy
  };
}

function buildCopilotTypeTargetMap(constraints = {}) {
  const out = new Map();
  const sfByType = Array.isArray(constraints?.baselineTotals?.sfByType) ? constraints.baselineTotals.sfByType : [];
  sfByType.forEach((row) => {
    const type = normalizeCopilotText(row?.type);
    const sf = Number(row?.sf || 0) || 0;
    if (!type || sf <= 0) return;
    if (isCopilotNonAssignableType(type)) return;
    out.set(normalizeCopilotTypeKey(type), {
      type,
      targetSf: sf
    });
  });
  return out;
}

function buildCopilotScenarioTotals(candidates = []) {
  const sfByTypeMap = new Map();
  let totalSF = 0;
  candidates.forEach((room) => {
    const sf = Number(room?.sf || 0) || 0;
    if (sf <= 0) return;
    totalSF += sf;
    const type = normalizeCopilotText(room?.type) || "Unspecified";
    sfByTypeMap.set(type, (sfByTypeMap.get(type) || 0) + sf);
  });
  return {
    totalSF: Math.round(totalSF),
    rooms: candidates.length,
    sfByType: Array.from(sfByTypeMap.entries())
      .map(([type, sf]) => ({ type, sf: Math.round(sf) }))
      .sort((a, b) => b.sf - a.sf)
  };
}

function createSeededRng(seedInput) {
  let seed = Number(seedInput) || Date.now();
  seed >>>= 0;
  return () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isCopilotExceptionType(typeValue = "") {
  const t = normalizeCopilotText(typeValue).toLowerCase();
  if (!t) return false;
  return /(classroom|lecture|seminar|lab|laboratory|studio|shop|auditorium|performance|clinic)/i.test(t);
}

function isCopilotNonAssignableType(typeValue = "") {
  const t = normalizeCopilotText(typeValue).toLowerCase();
  if (!t) return false;
  return /(corridor|circulation|vestibule|lobby|stair|elevator|restroom|toilet|mechanical area|mechanical room|electrical area|electrical room|utility room|janitor|custodial closet|shaft|pipe chase)/i
    .test(t);
}

function buildCopilotOptionScore({
  candidates = [],
  totals,
  targetSf,
  minSf,
  maxSf,
  strictFit = false,
  preferSingleBuilding = false,
  typeTargets = new Map()
}) {
  const uniqueBuildings = new Set(candidates.map((room) => room?.buildingKey).filter(Boolean));
  const buildingCount = uniqueBuildings.size;
  const total = Number(totals?.totalSF || 0);
  const sfGapPct = targetSf > 0 ? Math.abs(total - targetSf) / targetSf : 0;
  const overUpper = strictFit && total > maxSf;
  const belowLower = total < minSf;

  let typeGapPct = 0;
  if (typeTargets.size > 0) {
    const actualByType = new Map();
    candidates.forEach((room) => {
      const key = normalizeCopilotTypeKey(room?.type || "");
      if (!key) return;
      actualByType.set(key, (actualByType.get(key) || 0) + (Number(room?.sf || 0) || 0));
    });
    let targetSum = 0;
    let diffSum = 0;
    typeTargets.forEach((row, key) => {
      const target = Number(row?.targetSf || 0) || 0;
      if (target <= 0) return;
      const actual = Number(actualByType.get(key) || 0) || 0;
      targetSum += target;
      diffSum += Math.abs(actual - target);
    });
    typeGapPct = targetSum > 0 ? diffSum / targetSum : 0;
  }

  const buildingSpreadPenalty = preferSingleBuilding
    ? Math.max(0, buildingCount - 1) * 12
    : Math.max(0, buildingCount - 1) * 2;
  let score = 100 - (sfGapPct * 58) - (typeGapPct * 34) - buildingSpreadPenalty;
  if (total >= minSf && total <= maxSf) score += 8;
  if (overUpper) score -= 24;
  if (belowLower) score -= 10;
  if (strictFit && targetSf > 0 && total > targetSf) score -= 8;

  return {
    score: Number(score.toFixed(2)),
    breakdown: {
      sfGapPct: Number((sfGapPct * 100).toFixed(2)),
      typeGapPct: Number((typeGapPct * 100).toFixed(2)),
      buildingCount,
      buildingSpreadPenalty: Number(buildingSpreadPenalty.toFixed(2)),
      strictFit,
      inTargetRange: total >= minSf && total <= maxSf,
      overUpperBound: overUpper,
      belowLowerBound: belowLower
    }
  };
}

function buildCopilotOptionNarrative({
  option,
  targetSf = 0,
  minSf = 0,
  maxSf = Number.POSITIVE_INFINITY
}) {
  const out = [];
  const scoreBreakdown = option?.scoreBreakdown || {};
  const totalSf = Number(option?.scenarioTotals?.totalSF || 0) || 0;
  const buildingCount = Number(scoreBreakdown?.buildingCount || option?.buildingCount || 0) || 0;
  const sfGapPct = Number(scoreBreakdown?.sfGapPct || 0) || 0;
  const typeGapPct = Number(scoreBreakdown?.typeGapPct || 0) || 0;

  if (totalSf >= minSf && totalSf <= maxSf) {
    out.push(`Within target SF band (${Math.round(minSf).toLocaleString()}-${Math.round(maxSf).toLocaleString()} SF).`);
  } else if (targetSf > 0) {
    const direction = totalSf > targetSf ? "over" : "under";
    out.push(`SF is ${sfGapPct.toFixed(1)}% ${direction} target.`);
  }
  out.push(`Room-type fit gap is ${typeGapPct.toFixed(1)}%.`);
  out.push(buildingCount <= 1 ? "Consolidated in one building." : `Spread across ${buildingCount} buildings.`);
  return out;
}

function buildCopilotComparisonSummary(best, runnerUp) {
  if (!best) return [];
  if (!runnerUp) return ["Highest-scoring option among generated candidates."];
  const out = [];
  const bestScore = Number(best?.score || 0) || 0;
  const runnerScore = Number(runnerUp?.score || 0) || 0;
  out.push(`Top score ${bestScore.toFixed(1)} vs next ${runnerScore.toFixed(1)} (+${(bestScore - runnerScore).toFixed(1)}).`);

  const bestSfGap = Number(best?.scoreBreakdown?.sfGapPct || 0) || 0;
  const runnerSfGap = Number(runnerUp?.scoreBreakdown?.sfGapPct || 0) || 0;
  if (bestSfGap < runnerSfGap) {
    out.push(`Closer SF fit (${bestSfGap.toFixed(1)}% gap vs ${runnerSfGap.toFixed(1)}%).`);
  } else if (bestSfGap > runnerSfGap) {
    out.push(`SF fit is weaker (${bestSfGap.toFixed(1)}% gap vs ${runnerSfGap.toFixed(1)}%).`);
  }

  const bestTypeGap = Number(best?.scoreBreakdown?.typeGapPct || 0) || 0;
  const runnerTypeGap = Number(runnerUp?.scoreBreakdown?.typeGapPct || 0) || 0;
  if (bestTypeGap < runnerTypeGap) {
    out.push(`Better room-type alignment (${bestTypeGap.toFixed(1)}% gap vs ${runnerTypeGap.toFixed(1)}%).`);
  } else if (bestTypeGap > runnerTypeGap) {
    out.push(`Room-type alignment is weaker (${bestTypeGap.toFixed(1)}% gap vs ${runnerTypeGap.toFixed(1)}%).`);
  }

  return out;
}

function buildCopilotCandidates({
  rooms = [],
  targetSf = 0,
  minSf = 0,
  maxSf = Number.POSITIVE_INFINITY,
  strictFit = false,
  preferSingleBuilding = false,
  typeTargets = new Map(),
  primaryBuildingKey = "",
  rng
}) {
  const selected = [];
  const usedIds = new Set();
  let selectedSf = 0;
  const maxCandidates = 30;
  const targetByType = new Map();
  typeTargets.forEach((row, key) => {
    const targetSf = Number(row?.targetSf || 0) || 0;
    if (!key || targetSf <= 0) return;
    targetByType.set(key, targetSf);
  });
  const targetTypeTotalSf = Array.from(targetByType.values()).reduce((sum, sf) => sum + sf, 0);
  const actualByType = new Map();
  const addActualTypeSf = (room) => {
    const key = normalizeCopilotTypeKey(room?.type || "");
    if (!key) return;
    actualByType.set(key, (Number(actualByType.get(key) || 0) || 0) + (Number(room?.sf || 0) || 0));
  };
  const cloneActualByTypeWithRoom = (room) => {
    const next = new Map(actualByType);
    const key = normalizeCopilotTypeKey(room?.type || "");
    if (!key) return next;
    next.set(key, (Number(next.get(key) || 0) || 0) + (Number(room?.sf || 0) || 0));
    return next;
  };
  const computeTypeGapSf = (actualMap) => {
    if (!targetByType.size) return 0;
    let diff = 0;
    targetByType.forEach((targetSf, key) => {
      const actualSf = Number(actualMap?.get(key) || 0) || 0;
      diff += Math.abs(targetSf - actualSf);
    });
    return diff;
  };
  const getTypeDeficitSf = (typeKey, actualMap = actualByType) => {
    if (!typeKey || !targetByType.has(typeKey)) return 0;
    const targetSf = Number(targetByType.get(typeKey) || 0) || 0;
    const actualSf = Number(actualMap?.get(typeKey) || 0) || 0;
    return Math.max(0, targetSf - actualSf);
  };

  const addRoom = (room, reason = "") => {
    if (!room?.id || usedIds.has(room.id)) return false;
    const roomSf = Number(room.sf || 0) || 0;
    if (roomSf <= 0) return false;
    if (strictFit && selectedSf >= minSf && (selectedSf + roomSf) > maxSf) return false;
    usedIds.add(room.id);
    selected.push({ ...room, rationale: reason || "Selected to improve fit." });
    selectedSf += roomSf;
    addActualTypeSf(room);
    return true;
  };

  const byType = new Map();
  rooms.forEach((room) => {
    const key = normalizeCopilotTypeKey(room?.type || "");
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(room);
  });
  byType.forEach((list) => {
    list.sort((a, b) => (b.sf - a.sf) + ((rng() - 0.5) * 20));
  });

  // Pass 1: satisfy type targets.
  if (typeTargets.size > 0) {
    const orderedTargets = Array.from(typeTargets.entries())
      .map(([key, row]) => ({ key, type: row.type, targetSf: Number(row.targetSf || 0) || 0 }))
      .filter((row) => row.targetSf > 0)
      .sort((a, b) => b.targetSf - a.targetSf);

    orderedTargets.forEach((target) => {
      if (selected.length >= maxCandidates) return;
      const pool = [...(byType.get(target.key) || [])];
      let remainingTypeSf = target.targetSf;
      while (pool.length && remainingTypeSf > 0 && selected.length < maxCandidates) {
        pool.sort((a, b) => {
          const da = Math.abs(remainingTypeSf - a.sf);
          const db = Math.abs(remainingTypeSf - b.sf);
          return da - db + ((rng() - 0.5) * 8);
        });
        const pick = pool.shift();
        if (!pick) break;
        if (!addRoom(pick, `Type fit: ${target.type}`)) continue;
        remainingTypeSf -= Number(pick.sf || 0) || 0;
        if (selectedSf >= maxSf) break;
      }
    });
  }

  // Pass 2: fill toward target SF with net fit utility (type + SF), not SF-only.
  const remainingPool = rooms.filter((room) => !usedIds.has(room.id));
  const evaluateFillCandidate = (room) => {
    const roomSf = Number(room?.sf || 0) || 0;
    if (roomSf <= 0) return { utility: Number.NEGATIVE_INFINITY, reason: "" };
    if (isCopilotNonAssignableType(room?.type || "")) return { utility: Number.NEGATIVE_INFINITY, reason: "" };
    const afterSf = selectedSf + roomSf;
    if (strictFit && selectedSf >= minSf && afterSf > maxSf) {
      return { utility: Number.NEGATIVE_INFINITY, reason: "" };
    }
    const sfGapBefore = Math.abs(targetSf - selectedSf);
    const sfGapAfter = Math.abs(targetSf - afterSf);
    const sfImprovement = sfGapBefore - sfGapAfter;

    const typeGapBefore = computeTypeGapSf(actualByType);
    const nextActualByType = cloneActualByTypeWithRoom(room);
    const typeGapAfter = computeTypeGapSf(nextActualByType);
    const typeImprovement = typeGapBefore - typeGapAfter;

    const typeKey = normalizeCopilotTypeKey(room?.type || "");
    const inBaselineTypeMix = typeKey && targetByType.has(typeKey);
    if (targetByType.size > 0 && !inBaselineTypeMix) {
      return { utility: Number.NEGATIVE_INFINITY, reason: "" };
    }
    const isExceptionType = isCopilotExceptionType(room?.type || "");
    const buildingPenalty = preferSingleBuilding && primaryBuildingKey && room.buildingKey !== primaryBuildingKey ? 120 : 0;

    // Strongly discourage adding off-profile room types just to gain SF (fallback path only).
    const offProfilePenalty = (targetByType.size > 0 && !inBaselineTypeMix)
      ? (roomSf * (isExceptionType ? 1.0 : 1.35))
      : 0;
    // Penalize additions that worsen type fit.
    const typeWorsenPenalty = typeImprovement < 0 ? Math.abs(typeImprovement) * 1.25 : 0;

    const utility = (sfImprovement + (typeImprovement * 1.35)) - buildingPenalty - offProfilePenalty - typeWorsenPenalty;

    let reason = "Added to improve total SF fit.";
    if (inBaselineTypeMix) {
      const deficitBefore = getTypeDeficitSf(typeKey, actualByType);
      const deficitAfter = getTypeDeficitSf(typeKey, nextActualByType);
      const reducedBy = Math.max(0, deficitBefore - deficitAfter);
      if (reducedBy > 0) {
        reason = `Type fit: ${room.type} (reduced deficit by ${Math.round(reducedBy).toLocaleString()} SF).`;
      } else {
        reason = `Type support: ${room.type}.`;
      }
    }
    if (typeImprovement > 0 && targetTypeTotalSf > 0) {
      const pct = (typeImprovement / targetTypeTotalSf) * 100;
      reason = `${reason} Type-gap improvement ${pct.toFixed(1)}%.`;
    }
    return { utility, reason };
  };
  while (remainingPool.length && selected.length < maxCandidates) {
    if (selectedSf >= minSf && (!strictFit || selectedSf <= maxSf)) break;
    const ranked = remainingPool
      .map((room) => ({ room, ...evaluateFillCandidate(room) }))
      .filter((row) => Number.isFinite(row.utility))
      .sort((a, b) => (b.utility - a.utility) + ((rng() - 0.5) * 3));
    const top = ranked[0] || null;
    if (!top?.room) break;
    const pickIdx = remainingPool.findIndex((row) => row?.id === top.room.id);
    if (pickIdx >= 0) remainingPool.splice(pickIdx, 1);
    addRoom(top.room, top.reason || "Added to improve total SF fit.");
    if (selectedSf > maxSf && strictFit) break;
  }

  // Pass 3: strict-fit trim if needed.
  if (strictFit && selectedSf > maxSf && selected.length > 1) {
    selected.sort((a, b) => {
      const aAfter = selectedSf - (Number(a.sf || 0) || 0);
      const bAfter = selectedSf - (Number(b.sf || 0) || 0);
      const aDist = Math.abs(targetSf - aAfter);
      const bDist = Math.abs(targetSf - bAfter);
      return aDist - bDist;
    });
    let idx = selected.length - 1;
    while (idx >= 0 && selectedSf > maxSf && selected.length > 1) {
      const room = selected[idx];
      const roomSf = Number(room?.sf || 0) || 0;
      const after = selectedSf - roomSf;
      if (after >= Math.max(0, minSf * 0.85)) {
        selected.splice(idx, 1);
        selectedSf = after;
      }
      idx -= 1;
    }
  }

  return selected;
}

function generateMoveScenarioCopilotPlan({ request, context, inventory, constraints }) {
  const requestText = normalizeCopilotText(request);
  const preferSingleBuilding = Boolean(constraints?.preferSingleBuilding);
  const preferAcademicFit = Boolean(constraints?.preferAcademicFit);
  const strictFit = Number(constraints?.targetSfTolerance || 0.1) <= 0.05;
  const tolerance = Math.max(0.03, Math.min(0.25, Number(constraints?.targetSfTolerance || 0.1) || 0.1));
  const baselineTotalSf = Number(constraints?.baselineTotals?.totalSF || 0) || 0;
  const targetSf = baselineTotalSf > 0
    ? baselineTotalSf
    : Math.max(1200, (inventory || []).slice(0, 12).reduce((sum, row) => sum + (Number(row?.sf || 0) || 0), 0));
  const minSf = Math.max(0, targetSf * (1 - tolerance));
  const maxSf = targetSf * (1 + tolerance);
  const typeTargets = buildCopilotTypeTargetMap(constraints);
  const offlineSet = new Set((constraints?.offlineBuildings || []).map((b) => normalizeLoose(b)).filter(Boolean));
  const lowFitSet = new Set((constraints?.lowFitBuildings || []).map((b) => normalizeLoose(b)).filter(Boolean));
  const excludeSet = new Set((context?.excludeBuildings || []).map((b) => normalizeLoose(b)).filter(Boolean));

  const sourceRooms = Array.isArray(inventory) ? inventory : [];
  const normalizedRooms = sourceRooms
    .map(toCopilotRoom)
    .filter(Boolean)
    .filter((room) => !isCopilotNonAssignableType(room?.type || ""))
    .filter((room) => !excludeSet.has(room.buildingKey));

  const filteredRooms = normalizedRooms.filter((room) => {
    if (offlineSet.has(room.buildingKey)) return false;
    if (preferAcademicFit && lowFitSet.has(room.buildingKey)) return false;
    return true;
  });
  const fallbackUsed = filteredRooms.length < Math.min(25, Math.ceil(normalizedRooms.length * 0.2));
  const rooms = fallbackUsed ? normalizedRooms : filteredRooms;
  if (!rooms.length) {
    throw new Error("No eligible room inventory remained after scenario guardrails.");
  }

  const byBuilding = new Map();
  rooms.forEach((room) => {
    if (!byBuilding.has(room.buildingKey)) {
      byBuilding.set(room.buildingKey, {
        buildingKey: room.buildingKey,
        buildingLabel: room.buildingLabel,
        totalSf: 0,
        rooms: []
      });
    }
    const row = byBuilding.get(room.buildingKey);
    row.totalSf += Number(room.sf || 0) || 0;
    row.rooms.push(room);
  });

  const buildingRows = Array.from(byBuilding.values()).sort((a, b) => {
    const aGap = Math.abs(a.totalSf - targetSf);
    const bGap = Math.abs(b.totalSf - targetSf);
    return aGap - bGap;
  });

  const optionTargetCount = Math.max(3, Math.min(5, Number(context?.copilotOptionCount || 4)));
  const seed = Number(context?.seed || Date.now()) >>> 0;
  const generatedOptions = [];
  const signatures = new Set();

  for (let attempt = 0; attempt < optionTargetCount * 4 && generatedOptions.length < optionTargetCount; attempt += 1) {
    const rng = createSeededRng(seed + (attempt * 31));
    const buildingBiasShift = Math.min(buildingRows.length - 1, attempt % Math.max(1, Math.min(3, buildingRows.length)));
    const weightedBuildings = [...buildingRows].sort((a, b) => {
      const aGap = Math.abs(a.totalSf - targetSf) + (a === buildingRows[buildingBiasShift] ? -250 : 0) + ((rng() - 0.5) * 120);
      const bGap = Math.abs(b.totalSf - targetSf) + (b === buildingRows[buildingBiasShift] ? -250 : 0) + ((rng() - 0.5) * 120);
      return aGap - bGap;
    });

    const primary = weightedBuildings[0] || buildingRows[0];
    const secondary = weightedBuildings[1] || null;
    let candidatePool = [];
    if (preferSingleBuilding || !secondary || attempt % 2 === 0) {
      candidatePool = [...(primary?.rooms || [])];
      if (primary && strictFit && (primary.totalSf < (minSf * 0.92))) {
        const deficitSf = Math.max(0, minSf - primary.totalSf);
        const exceptionsByBuilding = new Map();
        rooms.forEach((room) => {
          if (room.buildingKey === primary.buildingKey) return;
          if (!isCopilotExceptionType(room.type)) return;
          if (typeTargets.size > 0 && !typeTargets.has(room.typeKey)) return;
          if (!exceptionsByBuilding.has(room.buildingKey)) {
            exceptionsByBuilding.set(room.buildingKey, []);
          }
          exceptionsByBuilding.get(room.buildingKey).push(room);
        });
        const backupRows = Array.from(exceptionsByBuilding.entries()).map(([buildingKey, list]) => {
          const totalExceptionSf = list.reduce((sum, row) => sum + (Number(row?.sf || 0) || 0), 0);
          return { buildingKey, list, totalExceptionSf };
        });
        backupRows.sort((a, b) => {
          const aGap = Math.abs(deficitSf - a.totalExceptionSf);
          const bGap = Math.abs(deficitSf - b.totalExceptionSf);
          return aGap - bGap;
        });
        const backup = backupRows[0] || null;
        if (backup?.list?.length) {
          const rankedBackup = [...backup.list].sort((a, b) => {
            const aGap = Math.abs(deficitSf - (Number(a?.sf || 0) || 0));
            const bGap = Math.abs(deficitSf - (Number(b?.sf || 0) || 0));
            return aGap - bGap;
          });
          const maxSupplemental = Math.max(2, Math.min(6, Math.ceil(deficitSf / 900)));
          rankedBackup.slice(0, maxSupplemental).forEach((room) => candidatePool.push(room));
        }
      }
    } else {
      const tertiary = weightedBuildings[2] || null;
      const allowed = new Set([primary?.buildingKey, secondary?.buildingKey, tertiary?.buildingKey].filter(Boolean));
      candidatePool = rooms.filter((room) => allowed.has(room.buildingKey));
    }
    if (!candidatePool.length) continue;

    const selected = buildCopilotCandidates({
      rooms: candidatePool,
      targetSf,
      minSf,
      maxSf,
      strictFit,
      preferSingleBuilding,
      typeTargets,
      primaryBuildingKey: primary?.buildingKey || "",
      rng
    });
    if (!selected.length) continue;

    const signature = selected
      .map((room) => room.id)
      .sort()
      .join("|");
    if (!signature || signatures.has(signature)) continue;
    signatures.add(signature);

    const totals = buildCopilotScenarioTotals(selected);
    const score = buildCopilotOptionScore({
      candidates: selected,
      totals,
      targetSf,
      minSf,
      maxSf,
      strictFit,
      preferSingleBuilding,
      typeTargets
    });
    const optionId = `option_${generatedOptions.length + 1}`;
    const selectedBuildings = Array.from(new Set(selected.map((room) => room.buildingLabel))).filter(Boolean);
    const option = {
      optionId,
      label: `Option ${generatedOptions.length + 1}`,
      title: `${context?.targetDepartment || context?.scenarioDepartment || "Department"} scenario option ${generatedOptions.length + 1}`,
      score: score.score,
      scoreBreakdown: score.breakdown,
      buildingCount: selectedBuildings.length,
      buildings: selectedBuildings,
      fitSummary: {
        targetSf: Math.round(targetSf),
        minSf: Math.round(minSf),
        maxSf: Math.round(maxSf),
        totalSf: Math.round(totals.totalSF || 0),
        sfGapPct: Number(score.breakdown?.sfGapPct || 0),
        typeGapPct: Number(score.breakdown?.typeGapPct || 0),
        inTargetRange: Boolean(score.breakdown?.inTargetRange)
      },
      scenarioTotals: totals,
      baselineTotals: constraints?.baselineTotals || {
        totalSF: Math.round(targetSf),
        rooms: 0,
        sfByType: []
      },
      assumptions: [
        strictFit ? `Strict fit mode enforced at +/-${Math.round(tolerance * 100)}%.` : `Fit target set at +/-${Math.round(tolerance * 100)}%.`,
        preferSingleBuilding ? "Single-building preference is active." : "Multi-building options allowed.",
        ...(fallbackUsed ? ["Guardrail filtering was softened due to limited eligible inventory."] : [])
      ],
      selectionCriteria: [
        "Hard constraints checked before room selection (offline/low-fit exclusions where active).",
        "Non-assignable support spaces (for example corridor/mechanical) excluded from move candidates.",
        "Type fit weighted highest against baseline room-type SF mix.",
        "Total SF fit optimized toward baseline target range.",
        ...(preferSingleBuilding ? ["Cross-building spread penalized unless needed for fit."] : [])
      ],
      nextSteps: [
        "Review adjacency and room-function impacts.",
        "Apply selected option to Planning Scenario for visual validation.",
        "Run scenario comparison and export summary for stakeholder review."
      ],
      recommendedCandidates: selected.map((room) => ({
        roomId: room.roomId,
        id: room.id,
        revitId: room.revitId,
        buildingLabel: room.buildingLabel,
        floorId: room.floorId,
        floorName: room.floorName,
        roomLabel: room.roomLabel,
        type: room.type,
        sf: Math.round(Number(room.sf || 0) || 0),
        rationale: room.rationale || "Selected for best-fit coverage."
      }))
    };
    option.whyThisOption = buildCopilotOptionNarrative({
      option,
      targetSf,
      minSf,
      maxSf
    });
    generatedOptions.push(option);
  }

  if (!generatedOptions.length) {
    throw new Error("Planner Copilot could not generate a valid option from the provided inventory.");
  }

  generatedOptions.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  generatedOptions.forEach((option, idx) => {
    option.rank = idx + 1;
  });
  const best = generatedOptions[0];
  const runnerUp = generatedOptions[1] || null;
  const runId = `copilot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    title: `${context?.targetDepartment || context?.scenarioDepartment || "Department"} planner copilot options`,
    interpretedIntent: requestText,
    scenarioDept: context?.targetDepartment || context?.scenarioDepartment || "",
    baselineTotals: best?.baselineTotals || constraints?.baselineTotals || {
      totalSF: Math.round(targetSf),
      rooms: 0,
      sfByType: []
    },
    scenarioTotals: best.scenarioTotals,
    assumptions: best.assumptions,
    selectionCriteria: best.selectionCriteria,
    recommendedCandidates: best.recommendedCandidates,
    nextSteps: best.nextSteps,
    copilot: {
      mode: "agentic-lite",
      runId,
      seed,
      recommendedOptionId: best.optionId,
      selectedOptionId: best.optionId,
      comparisonSummary: buildCopilotComparisonSummary(best, runnerUp),
      generatedOptions
    }
  };
}

app.post("/create-move-scenario-copilot", async (req, res) => {
  try {
    const { request, context, inventory, constraints } = req.body || {};
    if (!request || !String(request).trim()) {
      return res.status(400).json({ error: "Missing request" });
    }
    const out = generateMoveScenarioCopilotPlan({ request, context, inventory, constraints });
    res.json(out);
  } catch (err) {
    console.error("AI create scenario copilot error:", err);
    res.status(500).json({ error: err?.message || "AI create scenario copilot failed" });
  }
});


app.post("/ask", async (req, res) => {
  try {
    const { context, question, campusStats, buildingStats, floorStats, scenarioStats } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ error: "Missing question" });

    const schema = {
      name: "ask_answer",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { type: "string" },
          bullets: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 8 },
          dataUsed: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 }
        },
        required: ["answer", "dataUsed"]
      }
    };

    const resp = await client.responses.create({
      model: AI_MODEL,
      input: [
        { role: "system", content: "Answer only using provided stats/context. If missing data, say what is missing. No guessing." },
        { role: "user", content: JSON.stringify({ context, question, campusStats, buildingStats, floorStats, scenarioStats }, null, 2) }
      ],
      text: { format: { type: "json_schema", name: "ask_answer", schema: schema.schema, strict: true } }
    });

    res.json(JSON.parse(resp.output_text || "{}"));
  } catch (err) {
    console.error("AI ask error:", err);
    res.status(500).json({ error: err?.message || "AI ask failed" });
  }
});

app.post("/ask-mapfluence", async (req, res) => {
  try {
    const { question, context, data } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ error: "Missing question" });
    }

    const schema = {
      name: "ask_mapfluence",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { type: "string" },
          bullets: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 10 },
          resultType: { type: "string", enum: ["none", "table"] },
          columns: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 10 },
          rows: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: { type: ["string", "number", "boolean", "null"] }
            },
            minItems: 0,
            maxItems: 200
          },
          dataUsed: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
          missingData: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 10 }
        },
        required: ["answer", "bullets", "resultType", "columns", "dataUsed", "missingData"]
      }
    };

    const questionText = String(question).trim();
    const docsFirst = isDocPriorityQuestion(questionText);
    const forceDocsForQuant = isDocDependentQuantQuestion(questionText);
    const skipDocsForDataHeavy = forceDocsForQuant
      ? false
      : shouldSkipDocsForAsk({ docsFirst, data });
    const payloadSize = estimateAskPayloadSize(data);
    const envDocs = getConfiguredEnvDocs();
    let docsForLog = [];
    if (!skipDocsForDataHeavy) {
      try {
        docsForLog = await ensureUploadedAiDocs();
      } catch {
        docsForLog = [];
      }
    }
    const referenceDocNames = [...docsForLog, ...envDocs].map((doc) => doc.name);
    if (skipDocsForDataHeavy) {
      console.log(
        `[ask-mapfluence] docs skipped for data-heavy request (roomRows=${payloadSize.roomRowsCount}, jsonChars=${payloadSize.jsonChars})`
      );
    } else if (referenceDocNames.length) {
      console.log(`[ask-mapfluence] docs attached: ${referenceDocNames.join(", ")}`);
    }
    const askPayload = docsFirst
      ? {
          question: questionText,
          context,
          docsFirst: true,
          dataSummary: summarizeAskMapData(data),
          note: "This is a narrative/reference-doc question. Prioritize attached docs over structured room data."
        }
      : {
          question: questionText,
          context,
          docsFirst: false,
          data
        };
    const userContent = await buildUserContentWithAiDocs(askPayload, {
      warnLabel: "ask-mapfluence",
      includeDocs: !skipDocsForDataHeavy
    });

    const resp = await client.responses.create({
      model: AI_MODEL,
      input: [
        {
          role: "system",
          content:
            "Answer questions using only the provided data and attached reference documents. If the question requires data that is not present, say so in missingData and answer with what you can. For vacancy queries, prefer listing rooms when roomRows are provided. Never fabricate.\n\nConcision rules (default):\n- Keep answers concise by default.\n- Provide a short executive summary first (target 2-4 sentences, ~60-120 words).\n- Use bullets for key points (max 5 bullets, one line each).\n- Do not repeat the same details in both answer and bullets.\n- Only provide long-form detail if the user explicitly asks for a detailed/long response.\n\nPriority rules:\n1) If docsFirst=true (or the question is narrative/history/planning context), prioritize attached reference documents over room tables.\n2) If the question is quantitative space data, prioritize provided structured data.\n3) For doc-based narrative answers, use resultType='none' unless the user explicitly asks for a table.\n\nWhen the user asks for a \"best new suitable home\" or relocation, do NOT treat current department or occupant assignments as constraints. Search campus-wide unless the user explicitly restricts to a building/floor. If context.excludeBuildings is provided, do not recommend those buildings. Use room type similarity and total SF/room counts to suggest best fits. You may include currently occupied rooms and note the displacement; do not require vacancy unless the user explicitly asks for vacant-only.\n\nIf attached reference docs are used, include them in dataUsed by filename."
        },
        {
          role: "user",
          content: userContent
        }
      ],
      text: { format: { type: "json_schema", name: "ask_mapfluence", schema: schema.schema, strict: true } }
    });

    const out = JSON.parse(resp.output_text || "{}");
    if (docsFirst && out?.resultType === "table" && (!Array.isArray(out.rows) || out.rows.length === 0)) {
      out.resultType = "none";
    }
    if (docsFirst && Array.isArray(out?.dataUsed) && referenceDocNames.length) {
      referenceDocNames.forEach((name) => {
        if (!out.dataUsed.includes(name)) out.dataUsed.push(name);
      });
    }
    res.json(out);
  } catch (err) {
    console.error("AI ask-mapfluence error:", err);
    res.status(500).json({ error: err?.message || "AI ask failed" });
  }
});


app.post("/recommend", async (req, res) => {
  try {
    const { context, campusStats, buildingStats, floorStats, constraints } = req.body || {};
    if (!campusStats && !buildingStats && !floorStats) {
      return res.status(400).json({ error: "Provide campusStats or buildingStats or floorStats" });
    }

    const schema = {
      name: "recommendations",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          opportunities: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 8 },
          tradeoffs: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 8 },
          assumptions: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 8 }
        },
        required: ["title", "opportunities"]
      }
    };

    const resp = await client.responses.create({
      model: AI_MODEL,
      input: [
        { role: "system", content: "Provide planning-oriented opportunities using only provided data. If data is insufficient, list assumptions explicitly." },
        { role: "user", content: JSON.stringify({ context, campusStats, buildingStats, floorStats, constraints }, null, 2) }
      ],
      text: { format: { type: "json_schema", name: "recommendations", schema: schema.schema, strict: true } }
    });

    res.json(JSON.parse(resp.output_text || "{}"));
  } catch (err) {
    console.error("AI recommend error:", err);
    res.status(500).json({ error: err?.message || "AI recommend failed" });
  }
});

// TODO: wire Airtable executor here when ready
async function executeAirtableQuery(query) {
  return { ok: true, rows: [] };
}

app.post("/ai/query", async (req, res) => {
  try {
    const { question, context } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ ok: false, error: "Missing question" });
    }

    // Force the model to output a structured query object
    const schema = {
      name: "mapfluence_query",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          intent: { type: "string", enum: ["count", "list", "sum", "group_by", "lookup"] },
          entity: { type: "string", enum: ["rooms"] },

          // MUST be present (required) because additionalProperties:false
          filters: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                field: { type: "string" },
                op: { type: "string" },
                value: {
                  anyOf: [
                    { type: "string" },
                    { type: "number" },
                    { type: "boolean" },
                    { type: "null" },
                    { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }
                  ]
                }
              },
              required: ["field", "op", "value"]
            }
          },

          // MUST be present (required)
          group_by: { type: "array", items: { type: "string" } },

          // MUST be present (required)
          limit: { type: "number" }
        },

        // OpenAI json_schema requires required to include EVERY property key at this level
        required: ["intent", "entity", "filters", "group_by", "limit"]
      }
    };

    console.log("SCHEMA REQUIRED:", schema.schema.required);

    const resp = await client.responses.create({
      model: AI_MODEL,
      input: [
        {
          role: "system",
          content:
  "Return ONLY a JSON query object for Mapfluence.\n" +
  "You MUST include these top-level keys exactly: intent, entity, filters, group_by, limit.\n" +
  "If no filters apply, set filters: [].\n" +
  "If not grouping, set group_by: [].\n" +
  "If no limit applies, set limit: 0.\n" +
  "Allowed fields:\n" +
  "Number, RevitId, Revit_UniqueId, Floor, LevelName, Area_SF, Room Type, NCES_Category_Desc, Department, NCES_Occupancy Status, NCES_Seat Count, Comments.\n" +
  "Allowed ops: =, !=, in, contains, >, >=, <, <=, is_empty, not_empty.\n" +
  "For is_empty/not_empty, set value: null.\n" +
  "For room-type questions (office, classroom, lab, etc.), prefer op='contains' on the 'Room Type' field unless the user explicitly asks for an exact match.\n" +
  "If the question is ambiguous, use intent='lookup' and leave filters empty."

        },
        { role: "user", content: JSON.stringify({ question, context }, null, 2) }
      ],
      text: { format: { type: "json_schema", name: "mapfluence_query", schema: schema.schema, strict: true } }
    });

    const query = JSON.parse(resp.output_text || "{}");
    // Force Room Type comparisons to use "contains"
if (Array.isArray(query.filters)) {
  for (const f of query.filters) {
    if (f.field === "Room Type" && f.op === "=") {
      f.op = "contains";
    }
  }
}


    // Enforce canonical field list and ops before any data layer call
    const v = validateAiQuery(query);
    if (!v.ok) {
      console.warn("AI query validation failed:", { errors: v.errors, query });
      return res.status(400).json({ ok: false, errors: v.errors, query });
    }
    // ?? Normalize Room Type equality ? contains
if (query.intent === "count" || query.intent === "list" || query.intent === "lookup") {
  for (const f of query.filters || []) {
    if (
      f.field === "Room Type" &&
      f.op === "=" &&
      typeof f.value === "string"
    ) {
      f.op = "contains";
    }
  }
}


    const formula = filtersToAirtableFormula(query.filters);
const rows = await fetchAirtableRows(formula, AIRTABLE_VIEW || "Mapfluence_Rooms");

if (query.intent === "count") {
  return res.json({
    ok: true,
    value: rows.length
  });
}

return res.json({
  ok: true,
  rows
});
  } catch (err) {
    console.error("AI query error:", err);
    res.status(500).json({ ok: false, error: err?.message || "AI query failed" });
  }
});

app.post("/export-ai-pdf", async (req, res) => {
  try {
    const { title, sections } = req.body || {};
    if (!title || !sections) return res.status(400).json({ error: "Missing title/sections" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Mapfluence-AI-${Date.now()}".pdf`);

    const doc = new PDFDocument({ margin: 48 });
    doc.pipe(res);

    doc.fontSize(18).text(title, { underline: false });
    doc.moveDown(0.75);

    for (const s of sections) {
      doc.fontSize(13).text(s.heading || "", { continued: false });
      doc.moveDown(0.25);
      doc.fontSize(11).text(s.body || "");
      doc.moveDown(0.8);
    }

    doc.end();
  } catch (err) {
    console.error("PDF export error:", err);
    res.status(500).json({ error: err?.message || "PDF export failed" });
  }
});

// Airtable-only demo: no OpenAI calls
app.get("/demo/count-offices", async (req, res) => {
  try {
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || "Rooms";
    const AIRTABLE_VIEW = process.env.AIRTABLE_VIEW || "Mapfluence_Rooms";

    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
      return res.status(500).json({ ok: false, error: "Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID in .env" });
    }

    const formula = `FIND("Office", {Room Type Text})`;

    const params = new URLSearchParams({
      view: AIRTABLE_VIEW,
      filterByFormula: formula
    });

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}?${params}`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(500).json({ ok: false, error: `Airtable error ${r.status}: ${text}` });
    }

    const data = await r.json();
    const records = data.records || [];

    return res.json({ ok: true, value: records.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ?? Sample records demo (THIS IS NEW)
app.get("/demo/sample", async (req, res) => {
  try {
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || "Rooms";
    const AIRTABLE_VIEW = process.env.AIRTABLE_VIEW || "Mapfluence_Rooms";

    const params = new URLSearchParams({
      view: AIRTABLE_VIEW,
      maxRecords: "3"
    });

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}?${params}`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(500).json({ ok: false, error: text });
    }

    const data = await r.json();

    return res.json({
      ok: true,
      recordCount: data.records?.length || 0,
      firstRecordFields: data.records?.[0]?.fields || null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/enrollment-projections", async (req, res) => {
  try {
    if (!XLSX_API?.readFile || !XLSX_API?.utils?.sheet_to_json) {
      return res.status(500).json({
        ok: false,
        error: "XLSX parser is not initialized correctly on this server"
      });
    }
    const filePath = await resolveEnrollmentFilePath();
    if (!filePath) {
      return res.status(404).json({ ok: false, error: "No enrollment workbook found in Docs" });
    }

    const workbook = XLSX_API.readFile(filePath, { cellDates: false });
    const sheetName =
      ENROLLMENT_SHEET_NAME && workbook.Sheets[ENROLLMENT_SHEET_NAME]
        ? ENROLLMENT_SHEET_NAME
        : workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      return res.status(422).json({ ok: false, error: "Workbook has no readable sheets" });
    }

    const series = parseEnrollmentSeriesFromSheet(sheet);
    if (!series.length) {
      return res.status(422).json({
        ok: false,
        error: "Unable to parse year/enrollment series from workbook"
      });
    }

    return res.json({
      ok: true,
      source: path.basename(filePath),
      sheet: sheetName,
      series
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    commit: SERVER_COMMIT || "unknown"
  })
);

app.listen(8787, () => {
  console.log("[ai-server] running at http://localhost:8787");
});





