const { collections } = require("../config/firebase");
const { checkProjectAdmin } = require("../config/jira");
const { createJiraClient } = require("../config/jira");
const logger = require("../utils/logger");

// Verify user is authenticated and has valid Jira session
const requireAuth = (req, res, next) => {
  if (!req.session?.token || !req.session?.cloudId) {
    logger.warn("Unauthenticated request to protected route");
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
};

// Verify user is admin of the specific Jira project.
// Uses the session's isAdmin flag (set during /validate) instead of calling
// Jira API every time — this avoids failures due to token expiry and speeds
// up every mutating API call significantly.
const requireProjectAdmin = async (req, res, next) => {
  try {
    const projectKey =
      req.headers["x-project-key"] ||
      req.body?.projectKey ||
      req.params?.projectKey ||
      req.query?.projectKey ||
      req.session?.projectKey;

    if (!projectKey) {
      return res.status(400).json({ error: "Project key required" });
    }

    // Store in session for subsequent calls
    req.session.projectKey = projectKey;

    // ✅ Trust session isAdmin flag (set during /validate with live Jira check)
    if (!req.session?.isAdmin) {
      logger.warn(
        `User ${req.session.user?.email} attempted admin action on ${projectKey} without permission`,
      );
      return res.status(403).json({ error: "Project admin access required" });
    }

    // Attach project context to request
    req.project = { key: projectKey, cloudId: req.session.cloudId };
    next();
  } catch (error) {
    logger.error("Admin verification failed:", error.message);
    res.status(500).json({ error: "Authorization service unavailable" });
  }
};

// Load user profile from Firestore (for feature flags, settings)
const loadUserProfile = async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) return next();

    const userDoc = await collections.users.doc(userId).get();
    if (userDoc.exists) {
      req.userProfile = userDoc.data();
    }
    next();
  } catch (error) {
    logger.warn("Failed to load user profile:", error.message);
    next(); // Continue without profile
  }
};

// Check if user has enabled a specific feature
const requireFeature = (featureName) => {
  return (req, res, next) => {
    if (!req.userProfile?.features?.[featureName]) {
      return res.status(403).json({
        error: `Feature "${featureName}" is not enabled for your project`,
        hint: "Enable this feature in your project settings",
      });
    }
    next();
  };
};

module.exports = {
  requireAuth,
  requireProjectAdmin,
  loadUserProfile,
  requireFeature,
};
