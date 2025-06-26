// This script gives a user the 'admin' custom claim.
const admin = require('firebase-admin');

// IMPORTANT: Make sure the path to your service account key is correct.
const serviceAccount = require('./service-account-key.json');

// The email of the user you want to make an admin.
const USER_EMAIL = 'jack.g.dohrman@gmail.com'; 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

async function setAdminClaim() {
  try {
    console.log(`Fetching user data for: ${USER_EMAIL}`);
    const user = await admin.auth().getUserByEmail(USER_EMAIL);
    
    console.log(`Setting custom claim { admin: true } for user: ${user.uid}`);
    await admin.auth().setCustomUserClaims(user.uid, { admin: true });
    
    console.log('\nSUCCESS! Admin claim has been set.');
    console.log('You can now verify this in your React application.');
  } catch (error) {
    console.error('\nERROR setting admin claim:', error.message);
  }
}

setAdminClaim();