// test-firebase.js
require("dotenv").config();
const admin = require("firebase-admin");

// Initialize Firebase (same logic as config/firebase.js)
if (!admin.apps.length) {
  // Try loading from file first, fallback to env vars
  try {
    const serviceAccount = require("./service-account-key.json");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Loaded Firebase credentials from service-account-key.json");
  } catch (fileErr) {
    // Fallback to env vars
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
    console.log("✅ Loaded Firebase credentials from environment variables");
  }
}

const db = admin.firestore();

async function testConnection() {
  console.log("🔍 Testing Firebase connection...");

  try {
    // Try to write a test document
    const testRef = db.collection("test_connections").doc("first_test");
    await testRef.set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: "connected",
      message: "If you see this, your backend can write to Firestore!",
    });

    // Read it back
    const snapshot = await testRef.get();
    console.log("✅ WRITE SUCCESS: Document saved");
    console.log("✅ READ SUCCESS: Data retrieved ->", snapshot.data());

    // Cleanup (optional)
    // await testRef.delete();

    console.log("\n🎉 Firebase is working! You can now:");
    console.log("   • Save user profiles to /users/{userId}");
    console.log("   • Store workflows in /workflows/{workflowId}");
    console.log("   • Log executions to /executions/{executionId}");
    console.log("\n🚀 Run `npm run dev` to start the full app");

    process.exit(0);
  } catch (error) {
    console.error("❌ Firebase test FAILED:", error.message);
    console.error("\n🔧 Troubleshooting tips:");
    console.error("   1. Is service-account-key.json in project root?");
    console.error("   2. Are FIREBASE_* env vars correctly set?");
    console.error("   3. Did you enable Firestore in Firebase Console?");
    console.error('   4. Is your service account granted "Editor" role?');
    process.exit(1);
  }
}

testConnection();
