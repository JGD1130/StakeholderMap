import "dotenv/config";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import cors from "cors";
import express from "express";
import OpenAI from "openai";
import PDFDocument from "pdfkit";
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
const aiDocsCache = {
  signature: "",
  docs: [] // [{ name, fullPath, fileId }]
};

function isPdfFile(name) {
  return /\.pdf$/i.test(String(name || ""));
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
    .filter((entry) => entry.isFile() && isPdfFile(entry.name))
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
    try {
      const file = await client.files.create({
        file: fs.createReadStream(doc.fullPath),
        purpose: AI_DOCS_FILE_PURPOSE
      });
      uploaded.push({ ...doc, fileId: file.id });
    } catch (err) {
      console.warn(`AI docs upload skipped for ${doc.name}:`, err?.message || err);
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

    const records = await fetchAirtableAllRecords({
      table,
      view,
      fields: explicitFields && explicitFields.length ? explicitFields : null
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
            content:
              "You are helping create a move scenario by selecting candidate rooms from the provided campus-wide inventory and attached reference documents. Consider all buildings and floors unless the user explicitly restricts scope. Use only provided inventory/context/reference docs. Echo back roomId/revitId exactly as provided so the client can map results. Return each recommendation with revitId and floorName. If inventory is limited, return fewer candidates and explain assumptions. Do not fabricate rooms.\n\nIMPORTANT:\n- Do NOT filter candidates by vacancy/occupancy. Consider ALL rooms in the target building.\n- Do NOT treat current department/occupant assignments as constraints unless the user explicitly asks for it.\n- If context.excludeBuildings is provided, do NOT recommend rooms in those buildings (current home).\n- Primary objective: replicate the source department's footprint as closely as possible:\n  - total SF (+/-10-15% if possible)\n  - room type mix using NCES_Type (match SF by type)\n  - count of key functional types (labs, classrooms, offices if present)\n- If an occupied room is a better functional match, recommend it and clearly note the displacement.\n- Do NOT assume vacant-only unless explicitly stated by the user.\n\nVacancy/occupancy:\n- DO NOT require rooms to be vacant.\n- DO NOT use vacancy as a primary filter.\n- Only mention vacancy if the user explicitly asks for \"vacant only\" or \"avoid displacing\".\n- If you don't have reliable vacancy data, ignore it completely.\n\nBaseline/targets:\n- If constraints.baselineTotals is provided, use it as the target footprint.\n- Aim for total SF within +/- (constraints.targetSfTolerance or 0.10) of baselineTotals.totalSF.\n- Match sfByType / roomTypes mix as closely as possible.\n- Keep adding best-fit rooms until you reach the target range or exhaust the inventory.\n- If no single building can reach the target, select across multiple buildings.\n- If you cannot reach the target range or type mix, say so explicitly in assumptions and selectionCriteria.\n\nReturn:\n- scenarioDept (string)\n- baselineTotals: totalSF, rooms, sfByType[] (array of {type, sf}) for the source department\n- scenarioTotals: totalSF, rooms, sfByType[] (array of {type, sf}) for selected candidates\n\nScore rooms using:\n1. NCES room type similarity (highest weight)\n2. Area match (+/- 20%)\n3. Minimal displacement penalty"
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
    const skipDocsForDataHeavy = shouldSkipDocsForAsk({ docsFirst, data });
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
            "Answer questions using only the provided data and attached reference documents. If the question requires data that is not present, say so in missingData and answer with what you can. For vacancy queries, prefer listing rooms when roomRows are provided. Never fabricate.\n\nPriority rules:\n1) If docsFirst=true (or the question is narrative/history/planning context), prioritize attached reference documents over room tables.\n2) If the question is quantitative space data, prioritize provided structured data.\n3) For doc-based narrative answers, use resultType='none' unless the user explicitly asks for a table.\n\nWhen the user asks for a \"best new suitable home\" or relocation, do NOT treat current department or occupant assignments as constraints. Search campus-wide unless the user explicitly restricts to a building/floor. If context.excludeBuildings is provided, do not recommend those buildings. Use room type similarity and total SF/room counts to suggest best fits. You may include currently occupied rooms and note the displacement; do not require vacancy unless the user explicitly asks for vacant-only.\n\nIf attached reference docs are used, include them in dataUsed by filename."
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

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(8787, () => {
  console.log("?? AI server running at http://localhost:8787");
});





