const admin = require("firebase-admin");
const logger = require("../utils/logger");

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
      firestore: {
        databaseId: "(default)",
        preferRest: false,
      },
    });
    logger.info("✅ Firebase Admin SDK initialized");
  } catch (error) {
    logger.error("❌ Firebase initialization failed:", error.message);
    // Don't crash the app - allow graceful degradation for non-Firebase routes
    if (process.env.NODE_ENV === "production") {
      throw error;
    }
  }
}

const db = admin.firestore();

// Enable offline persistence for development (optional)
if (process.env.NODE_ENV === "development") {
  db.settings({ ignoreUndefinedProperties: true });
  logger.debug("🔧 Firestore settings: ignoreUndefinedProperties=true");
}

// Collection references for easy access
const collections = {
  users: db.collection("users"),
  workflows: db.collection("workflows"),
  executions: db.collection("executions"),
  reports: db.collection("reports"),
};

// Helper: Get user document reference
const getUserRef = (userId) => collections.users.doc(userId);

// Helper: Query workflows by project and event
const findWorkflowsByTrigger = async (projectId, event) => {
  try {
    const snapshot = await collections.workflows
      .where("projectId", "==", projectId)
      .where("trigger.events", "array-contains", event)
      .where("isActive", "==", true)
      .get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    logger.error("Error querying workflows:", error);
    return [];
  }
};

// Helper: Check if event is already used in another workflow
const isEventUsed = async (projectId, event, excludeWorkflowId = null) => {
  try {
    let query = collections.workflows
      .where("projectId", "==", projectId)
      .where("trigger.events", "array-contains", event)
      .where("isActive", "==", true);

    if (excludeWorkflowId) {
      query = query.where("__name__", "!=", excludeWorkflowId);
    }

    const snapshot = await query.limit(1).get();
    return !snapshot.empty;
  } catch (error) {
    logger.error("Error checking event uniqueness:", error);
    return true; // Fail safe: assume it's used
  }
};

module.exports = {
  admin,
  db,
  collections,
  getUserRef,
  findWorkflowsByTrigger,
  isEventUsed,
};
