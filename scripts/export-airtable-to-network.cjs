'use strict';
/**
 * export-airtable-to-network.cjs
 *
 * Standalone backup script — NOT part of the deployed web app, not wired
 * into any npm script, build, or CI step. Run manually or from a scheduled
 * task on a machine that has access to \\CE-LN-SRV-009.
 *
 * Fetches every row from the Hastings College and Sarpy County Airtable
 * bases and writes a dated CSV snapshot to the network share on every run
 * (e.g. Hastings_Rooms_2026-08-26.csv). Files accumulate in place — no
 * archive subfolder, no cleanup of older dated files.
 *
 * Cherokee is intentionally excluded. Do not add it to TARGETS below.
 *
 * Credentials come from the same ai-server .env files the running app
 * already uses (never committed):
 *   ai-server/.env        → Hastings  (AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE)
 *   ai-server/.env.sarpy  → Sarpy County (same keys)
 *
 * Usage:
 *   node scripts/export-airtable-to-network.cjs
 *
 * Exit code is non-zero if either target fails, so a scheduler can alert
 * on failure. Progress and errors are logged to the console and appended
 * to export-airtable-to-network.log next to this script.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SCRIPT_DIR = __dirname;
const LOG_FILE = path.join(SCRIPT_DIR, 'export-airtable-to-network.log');

const TARGETS = [
  {
    name: 'Hastings College',
    envFile: path.join(SCRIPT_DIR, '..', 'ai-server', '.env'),
    outputDir:
      '\\\\CE-LN-SRV-009\\Architecture\\Space Planning\\Airtable\\Data Backup\\Hastings College',
    filePrefix: 'Hastings_Rooms',
  },
  {
    name: 'Sarpy County',
    envFile: path.join(SCRIPT_DIR, '..', 'ai-server', '.env.sarpy'),
    outputDir:
      '\\\\CE-LN-SRV-009\\Architecture\\Space Planning\\Airtable\\Data Backup\\Sarpy County',
    filePrefix: 'Sarpy_Rooms',
  },
];

// ── dated filename ──────────────────────────────────────────────────────
// Local calendar date the script actually runs, not UTC -- so a run late
// in the evening stays filed under the day the operator thinks it ran on.
function dateStamp(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── logging ─────────────────────────────────────────────────────────────
const pendingLogLines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  pendingLogLines.push(line);
}
function flushLog() {
  try {
    fs.appendFileSync(LOG_FILE, pendingLogLines.join('\n') + '\n');
  } catch (err) {
    // Network CSV writes are the point of this script; a log-file failure
    // shouldn't be treated as fatal, but it must still be visible.
    console.error(`Could not write log file ${LOG_FILE}: ${err.message}`);
  }
}

// ── .env loader (same minimal pattern as scripts/sync-airtable-rooms.cjs) ──
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// ── Airtable fetch (paginated) ─────────────────────────────────────────────
function airtableRequest(token, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.airtable.com',
        path: urlPath,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            reject(new Error(`Non-JSON response from Airtable (${res.statusCode}): ${raw.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAllRecords({ token, baseId, table }) {
  const records = [];
  let offset = null;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const urlPath = `/v0/${baseId}/${encodeURIComponent(table)}?${qs}`;
    const res = await airtableRequest(token, urlPath);
    if (res.status !== 200) {
      throw new Error(`Airtable list error ${res.status}: ${JSON.stringify(res.body)}`);
    }
    records.push(...(res.body.records || []));
    offset = res.body.offset || null;
    if (offset) await sleep(250); // stay well under Airtable's 5 req/s limit
  } while (offset);
  return records;
}

// ── CSV conversion ─────────────────────────────────────────────────────
function csvEscape(value) {
  if (value == null) return '';
  let str;
  if (Array.isArray(value)) {
    str = value.map((v) => (v == null ? '' : String(v))).join('; ');
  } else if (typeof value === 'object') {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  if (/[",\n\r]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function recordsToCsv(records) {
  // Airtable only returns keys for non-empty fields, so the column set has
  // to be the union across every record, not just whatever the first has.
  const columns = new Set(['id']);
  for (const rec of records) {
    for (const key of Object.keys(rec.fields || {})) columns.add(key);
  }
  const columnList = Array.from(columns);
  const header = columnList.map(csvEscape).join(',');
  const rows = records.map((rec) => {
    const row = { id: rec.id, ...rec.fields };
    return columnList.map((col) => csvEscape(row[col])).join(',');
  });
  return [header, ...rows].join('\r\n') + '\r\n';
}

// ── write to network share ─────────────────────────────────────────────
function writeCsvToNetwork(outputPath, csv) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    throw new Error(`Target directory not reachable (check VPN/share access): ${dir}`);
  }
  fs.writeFileSync(outputPath, csv, 'utf8');
}

// ── per-target run ─────────────────────────────────────────────────────
async function exportTarget(target) {
  log(`--- ${target.name}: starting ---`);
  const cfg = loadDotEnv(target.envFile);
  const token = cfg.AIRTABLE_TOKEN;
  const baseId = cfg.AIRTABLE_BASE_ID;
  const table = cfg.AIRTABLE_TABLE || 'Rooms';

  if (!token || !baseId) {
    throw new Error(`Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID in ${target.envFile}`);
  }

  log(`${target.name}: fetching from base ${baseId}, table "${table}"...`);
  const records = await fetchAllRecords({ token, baseId, table });
  log(`${target.name}: fetched ${records.length} records`);

  const csv = recordsToCsv(records);
  const outputPath = path.join(target.outputDir, `${target.filePrefix}_${dateStamp()}.csv`);
  log(`${target.name}: writing ${records.length} rows to ${outputPath}`);
  writeCsvToNetwork(outputPath, csv);
  log(`${target.name}: SUCCESS`);
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  log('=== export-airtable-to-network run started ===');
  let failures = 0;
  for (const target of TARGETS) {
    try {
      await exportTarget(target);
    } catch (err) {
      failures += 1;
      log(`${target.name}: FAILED — ${err.message}`);
    }
  }
  log(`=== run finished: ${TARGETS.length - failures}/${TARGETS.length} succeeded ===`);
  flushLog();
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  flushLog();
  process.exitCode = 1;
});
