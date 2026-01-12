const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const cors = require("cors");
const OpenAI = require("openai");
admin.initializeApp();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const corsHandler = cors({ origin: true });

// FINAL, SECURE VERSION
exports.addAdminRole = functions.https.onCall(async (data, context) => {
  // Security Check 1: User must be authenticated.
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated", "You must be logged in."
    );
  }
  // Security Check 2: User must already be an admin.
  if (context.auth.token.admin !== true) {
    throw new functions.https.HttpsError(
      "permission-denied", "You must be an admin to perform this action."
    );
  }
  // If checks pass, proceed.
  try {
    const email = data.email;
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, { admin: true });
    return {
      message: `Success! ${email} has been made an admin.`,
    };
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

// AI explanation endpoint (keeps OpenAI key on the server)
exports.aiExplainFloor = functions.https.onRequest(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).send("");
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const apiKey =
      process.env.OPENAI_API_KEY ||
      (functions.config().openai && functions.config().openai.key) ||
      "";
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OpenAI API key" });
    }

    const { context, floorStats, panelStats } = req.body || {};
    if (!floorStats && !panelStats) {
      return res.status(400).json({ error: "Missing floorStats/panelStats" });
    }

    const prompt = `
You are a campus space-planning assistant.
Write a concise, client-friendly explanation of the selected floor.

Requirements:
- 2–3 sentence summary
- Then 3–5 bullet insights (short, factual)
- Use ONLY the provided data; do NOT invent numbers or causes.
- If data is missing, say "Not provided".
- Prefer the user's displayed labels (buildingLabel, floorLabel).

Context:
${JSON.stringify(context || {}, null, 2)}

Floor stats (raw):
${JSON.stringify(floorStats || {}, null, 2)}

Panel stats (formatted for humans):
${JSON.stringify(panelStats || {}, null, 2)}
`;

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: prompt,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      const msg = data?.error?.message || resp.statusText || "Explain request failed";
      throw new Error(msg);
    }

    const text =
      data?.output_text ||
      data?.output?.[0]?.content?.[0]?.text?.value ||
      "";

    res.json({ text });
  } catch (e) {
    console.error("aiExplainFloor failed:", e);
    res.status(500).json({ error: "AI explain failed" });
  }
});

// AI explanation endpoint using v2/https with structured JSON response
exports.explainFloor = onRequest(
  { secrets: [OPENAI_API_KEY], region: "us-central1" },
  async (req, res) => {
    await new Promise((resolve) => corsHandler(req, res, resolve));

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const { context, floorStats, panelStats } = req.body || {};
      if (!floorStats && !panelStats) {
        res.status(400).json({ error: "Missing floorStats/panelStats" });
        return;
      }

      const client = new OpenAI({ apiKey: OPENAI_API_KEY.value() });

      const input = [
        {
          role: "system",
          content:
            "You are a campus space-planning assistant. Use ONLY the provided data. Do not speculate or invent numbers. Keep it client-friendly and concise."
        },
        {
          role: "user",
          content: JSON.stringify(
            { context: context || {}, floorStats: floorStats || {}, panelStats: panelStats || {} },
            null,
            2
          )
        }
      ];

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
            },
            watchouts: {
              type: "array",
              items: { type: "string" },
              minItems: 0,
              maxItems: 4
            },
            data_used: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 12
            }
          },
          required: ["title", "summary", "insights", "watchouts", "data_used"]
        },
        strict: true
      };

      const resp = await client.responses.create({
        model: "gpt-4.1-mini",
        input,
        response_format: { type: "json_schema", json_schema: schema }
      });

      const jsonText = resp.output_text || "{}";
      const parsed = JSON.parse(jsonText);

      res.json(parsed);
    } catch (err) {
      console.error("explainFloor failed:", err);
      res.status(500).json({ error: "AI explain failed" });
    }
  }
);
