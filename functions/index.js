const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

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
