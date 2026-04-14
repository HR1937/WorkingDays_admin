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
  projects: db.collection("projects"),
};

// ===== USER HELPERS =====

// Helper: Get user document reference
const getUserRef = (userId) => collections.users.doc(userId);

// ===== PROJECT MEMBER HELPERS (per-project, per-user — Slack ID lives here) =====

// Get a member doc ref: /projects/{projectKey}/members/{jiraAccountId}
const getProjectMemberRef = (projectKey, jiraAccountId) =>
  collections.projects.doc(projectKey).collection("members").doc(jiraAccountId);

// Upsert a project member (create or merge)
const upsertProjectMember = async (projectKey, jiraAccountId, data) => {
  const ref = getProjectMemberRef(projectKey, jiraAccountId);
  await ref.set(
    {
      ...data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return ref;
};

// Get a project member's data
const getProjectMember = async (projectKey, jiraAccountId) => {
  const doc = await getProjectMemberRef(projectKey, jiraAccountId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
};

// Get all members for a project
const getProjectMembers = async (projectKey) => {
  const snapshot = await collections.projects
    .doc(projectKey)
    .collection("members")
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};

// ===== PROJECT REGISTRATION HELPERS =====

// Check if a project has been registered by any admin
const isProjectRegistered = async (projectKey) => {
  const doc = await collections.projects.doc(projectKey).get();
  return doc.exists && !!doc.data()?.registeredBy;
};

// Register a project (called when admin first logs in and selects a project)
const registerProject = async (projectKey, adminUserId, adminEmail, adminDisplayName) => {
  const ref = collections.projects.doc(projectKey);
  const doc = await ref.get();

  // Only set registeredBy if not already registered
  if (!doc.exists || !doc.data()?.registeredBy) {
    await ref.set(
      {
        registeredBy: {
          userId: adminUserId,
          email: adminEmail,
          displayName: adminDisplayName,
        },
        registeredAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    logger.info(`Project ${projectKey} registered by admin ${adminEmail}`);
  }
};

// ===== WORKFLOW HELPERS =====

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

// Helper: Check if event is already used in another workflow (returns the workflow if found)
const findWorkflowByEvent = async (projectId, event, excludeWorkflowId = null) => {
  try {
    const snapshot = await collections.workflows
      .where("projectId", "==", projectId)
      .where("trigger.events", "array-contains", event)
      .where("isActive", "==", true)
      .get();

    for (const doc of snapshot.docs) {
      if (excludeWorkflowId && doc.id === excludeWorkflowId) continue;
      return { id: doc.id, ...doc.data() };
    }
    return null;
  } catch (error) {
    logger.error("Error checking event uniqueness:", error);
    return null;
  }
};

// Helper: Check if event is already used in another workflow (boolean)
const isEventUsed = async (projectId, event, excludeWorkflowId = null) => {
  const existing = await findWorkflowByEvent(projectId, event, excludeWorkflowId);
  return !!existing;
};

// ===== CHECK WHAT CONTACT INFO IS REQUIRED FOR A PROJECT =====
// Returns { slackRequired, smsRequired, githubRequired, slackWorkspaceId } based on active workflows
const getRequiredContactInfo = async (projectKey) => {
  try {
    const snapshot = await collections.workflows
      .where("projectId", "==", projectKey)
      .where("isActive", "==", true)
      .get();

    let slackRequired = false;
    let smsRequired = false;
    let githubRequired = false;

    for (const doc of snapshot.docs) {
      const wf = doc.data();
      const notifs = wf.notifications || {};
      const enh = wf.enhancements || {};

      // Check if auto-branch creation is enabled
      if (enh.autoBranch?.enabled) githubRequired = true;

      for (const [event, config] of Object.entries(notifs)) {
        if (!config.enabled) continue;

        // If any event uses Slack (DM or channel)
        if (event === "issue_assigned") {
          if (config.slack?.enabled) slackRequired = true;
          if (config.sms?.enabled) smsRequired = true;
        }
        // Non-assigned events with a channelId → Slack is used
        if (config.channelId) slackRequired = true;
      }
    }

    // Also fetch slackWorkspaceId from project integrations
    let slackWorkspaceId = null;
    try {
      const projectDoc = await collections.projects.doc(projectKey).get();
      if (projectDoc.exists) {
        slackWorkspaceId = projectDoc.data()?.integrations?.slack?.teamId || null;
        // If Slack is connected at all, require the workspace-scoped memberId
        if (slackWorkspaceId) slackRequired = true;
      }
    } catch (e) {
      logger.warn("Could not fetch project slack workspace:", e.message);
    }

    return { slackRequired, smsRequired, githubRequired, slackWorkspaceId };
  } catch (error) {
    logger.error("Error checking required contact info:", error);
    return { slackRequired: false, smsRequired: false, githubRequired: false, slackWorkspaceId: null };
  }
};

// ===== HELPERS: Get member contact info by jiraAccountId for a project =====
const getMemberContact = async (projectKey, jiraAccountId) => {
  const doc = await getProjectMemberRef(projectKey, jiraAccountId).get();
  if (!doc.exists) return null;
  const d = doc.data();
  return {
    slackMemberId: d.slackMemberId || d.slackUserId || null, // backward compat
    phoneNumber: d.phoneNumber || null,
    email: d.email || null,
    githubAccountId: d.githubAccountId || d.contact?.githubUsername || null,
    githubAccessToken: d.githubAccessToken || null,
    displayName: d.displayName || null,
  };
};

module.exports = {
  admin,
  db,
  collections,
  getUserRef,
  getProjectMemberRef,
  upsertProjectMember,
  getProjectMember,
  getProjectMembers,
  isProjectRegistered,
  registerProject,
  findWorkflowsByTrigger,
  findWorkflowByEvent,
  isEventUsed,
  getRequiredContactInfo,
  getMemberContact,
};
