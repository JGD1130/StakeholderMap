import "dotenv/config";
import cors from "cors";
import express from "express";
import OpenAI from "openai";
import PDFDocument from "pdfkit";
import { validateAiQuery } from "./validateAiQuery.js";

const app = express();
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;
const AIRTABLE_VIEW = process.env.AIRTABLE_VIEW;

async function fetchAirtableRows(filterFormula) {
  const params = new URLSearchParams({
    view: AIRTABLE_VIEW
  });
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

    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: "Use only provided data; do not speculate or invent facts." },
        { role: "user", content: JSON.stringify({ context, floorStats, panelStats }, null, 2) }
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

    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: "Use only provided data; do not speculate or invent facts." },
        { role: "user", content: JSON.stringify({ context, buildingStats, panelStats }, null, 2) }
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

    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "Generate a high-level campus summary using only the provided data. Do not speculate, recommend actions, or assume future changes."
        },
        {
          role: "user",
          content: JSON.stringify({ context, campusStats, panelStats }, null, 2)
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
      model: "gpt-4.1-mini",
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

    const schema = {
      name: "move_scenario_plan",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          interpretedIntent: { type: "string" },
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
                roomLabel: { type: "string" },
                type: { type: "string" },
                sf: { type: "number" },
                rationale: { type: "string" }
              },
              required: ["roomId", "id", "revitId", "buildingLabel", "floorId", "roomLabel", "type", "sf", "rationale"]
            },
            minItems: 0,
            maxItems: 25
          },
          nextSteps: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 8 }
        },
        required: ["title", "interpretedIntent", "assumptions", "selectionCriteria", "recommendedCandidates", "nextSteps"]
      }
    };

    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "You are helping create a move scenario by selecting candidate rooms from the provided campus-wide inventory. Consider all buildings and floors unless the user explicitly restricts scope. Use only provided inventory/context. Echo back roomId/revitId exactly as provided so the client can map results. If inventory is limited, return fewer candidates and explain assumptions. Do not fabricate rooms."
        },
        {
          role: "user",
          content: JSON.stringify({ request, context, constraints, inventory }, null, 2)
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
      model: "gpt-4.1-mini",
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

    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "Answer questions using only the provided data. If the question requires data that is not present, say so in missingData and answer with what you can. For vacancy queries, prefer listing rooms when roomRows are provided. Never fabricate."
        },
        {
          role: "user",
          content: JSON.stringify({ question, context, data }, null, 2)
        }
      ],
      text: { format: { type: "json_schema", name: "ask_mapfluence", schema: schema.schema, strict: true } }
    });

    res.json(JSON.parse(resp.output_text || "{}"));
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
      model: "gpt-4.1-mini",
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
      model: "gpt-4.1-mini",
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
    // 🔒 Normalize Room Type equality → contains
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
const rows = await fetchAirtableRows(formula);

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

// 🔍 Sample records demo (THIS IS NEW)
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
  console.log("🧠 AI server running at http://localhost:8787");
});
