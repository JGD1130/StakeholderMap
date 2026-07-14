const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const cors = require("cors");
const OpenAI = require("openai");
admin.initializeApp();

const db = admin.firestore();
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const corsHandler = cors({ origin: true });
const VALID_UNIVERSITY_ROLES = new Set(["viewer", "editor", "admin"]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeUniversityRole(value) {
  return normalizeString(value).toLowerCase();
}

async function callerCanManageUniversityRoles(context, universityId) {
  if (!context.auth?.uid) return false;
  if (context.auth.token.admin === true) return true;
  const roleDoc = await db.doc(`universities/${universityId}/roles/${context.auth.uid}`).get();
  return roleDoc.exists && normalizeUniversityRole(roleDoc.data()?.role) === "admin";
}

async function lookupUserByEmail(email) {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (error) {
    if (error?.code === "auth/user-not-found") return null;
    throw error;
  }
}

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

exports.setUniversityUserRole = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be logged in.");
  }

  const universityId = normalizeString(data?.universityId).toLowerCase();
  const email = normalizeString(data?.email).toLowerCase();
  const role = normalizeUniversityRole(data?.role);
  const callerIsGlobalAdmin = context.auth.token.admin === true;

  if (!universityId) {
    throw new functions.https.HttpsError("invalid-argument", "Missing universityId.");
  }
  if (!email) {
    throw new functions.https.HttpsError("invalid-argument", "Missing user email.");
  }
  if (!VALID_UNIVERSITY_ROLES.has(role)) {
    throw new functions.https.HttpsError("invalid-argument", "Role must be viewer, editor, or admin.");
  }
  if (role === "admin" && !callerIsGlobalAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Only a global admin can assign the admin role.");
  }

  const allowed = await callerCanManageUniversityRoles(context, universityId);
  if (!allowed) {
    throw new functions.https.HttpsError("permission-denied", "You do not have permission to manage roles for this workspace.");
  }

  const user = await lookupUserByEmail(email);
  if (!user) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "That Google account has not signed in yet. Have them open the Hastings client workspace once, then try again."
    );
  }

  const roleDocRef = db.doc(`universities/${universityId}/roles/${user.uid}`);
  const existingRoleDoc = await roleDocRef.get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const updatedByEmail = normalizeString(context.auth.token.email || "").toLowerCase();
  const payload = {
    role,
    email: normalizeString(user.email || email).toLowerCase(),
    displayName: normalizeString(user.displayName || ""),
    updatedAt: now,
    updatedByUid: context.auth.uid,
    updatedByEmail,
  };

  if (!existingRoleDoc.exists) {
    payload.createdAt = now;
    payload.createdByUid = context.auth.uid;
    payload.createdByEmail = updatedByEmail;
  }

  await roleDocRef.set(payload, { merge: true });

  return {
    ok: true,
    uid: user.uid,
    email: payload.email,
    role,
    message: `${payload.email} now has ${role} access for ${universityId}.`,
  };
});

exports.removeUniversityUserRole = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be logged in.");
  }

  const universityId = normalizeString(data?.universityId).toLowerCase();
  const callerIsGlobalAdmin = context.auth.token.admin === true;
  let targetUid = normalizeString(data?.uid);
  const email = normalizeString(data?.email).toLowerCase();

  if (!universityId) {
    throw new functions.https.HttpsError("invalid-argument", "Missing universityId.");
  }

  const allowed = await callerCanManageUniversityRoles(context, universityId);
  if (!allowed) {
    throw new functions.https.HttpsError("permission-denied", "You do not have permission to manage roles for this workspace.");
  }

  if (!targetUid && email) {
    const user = await lookupUserByEmail(email);
    targetUid = normalizeString(user?.uid);
  }

  if (!targetUid) {
    throw new functions.https.HttpsError("invalid-argument", "Missing target user id.");
  }

  const roleDocRef = db.doc(`universities/${universityId}/roles/${targetUid}`);
  const existingRoleDoc = await roleDocRef.get();
  if (!existingRoleDoc.exists) {
    return {
      ok: true,
      removed: false,
      uid: targetUid,
      message: `No role document was found for ${targetUid}.`,
    };
  }

  const existingRole = normalizeUniversityRole(existingRoleDoc.data()?.role);
  if (existingRole === "admin" && !callerIsGlobalAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Only a global admin can remove the admin role.");
  }

  await roleDocRef.delete();

  const targetEmail = normalizeString(existingRoleDoc.data()?.email || email || targetUid).toLowerCase();
  return {
    ok: true,
    removed: true,
    uid: targetUid,
    email: targetEmail,
    role: existingRole,
    message: `${targetEmail} no longer has ${universityId} client access.`,
  };
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
