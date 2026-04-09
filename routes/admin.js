// routes/admin.js
const express = require("express");
const admin = require("firebase-admin"); // ✅ CRITICAL: Add this import
const { collections, getUserRef } = require("../config/firebase");
const { requireAuth, requireProjectAdmin } = require("../middleware/auth");
const { encrypt, decrypt } = require("../utils/crypto");
const logger = require("../utils/logger");

const router = express.Router();

// ✅ GET /api/admin/profile - Fetch current admin's profile (REAL)
router.get("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId; // ✅ From OAuth session
    const userDoc = await collections.users.doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User profile not found" });
    }

    const profile = userDoc.data();

    // ✅ Decrypt sensitive fields before sending to client
    if (profile.contact?.phoneNumber) {
      profile.contact.phoneNumber = decrypt(profile.contact.phoneNumber);
    }

    res.json({ success: true, profile });
  } catch (error) {
    logger.error("Failed to fetch admin profile:", error);
    res.status(500).json({ success: false, error: "Failed to load profile" });
  }
});

// ✅ PUT /api/admin/profile - Update admin's contact info (REAL)
router.put("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { slackUserId, phoneNumber, githubUsername } = req.body;

    // ✅ Encrypt sensitive data before storing in Firestore
    const encryptedPhone = phoneNumber ? encrypt(phoneNumber) : null;

    await getUserRef(userId).update({
      "contact.slackUserId": slackUserId || null,
      "contact.phoneNumber": encryptedPhone,
      "contact.githubUsername": githubUsername || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(), // ✅ REAL server time
    });

    res.json({ success: true, message: "Profile updated" });
  } catch (error) {
    logger.error("Failed to update admin profile:", error);
    res.status(500).json({ success: false, error: "Failed to update profile" });
  }
});

// ✅ GET /api/admin/integrations - Fetch project-level integrations (REAL)
router.get(
  "/integrations",
  requireAuth,
  requireProjectAdmin,
  async (req, res) => {
    try {
      const { projectKey } = req.session; // ✅ From OAuth session

      const projectDoc = await collections.projects.doc(projectKey).get();

      if (!projectDoc.exists) {
        return res.json({ success: true, slack: null, github: null });
      }

      const project = projectDoc.data();

      // ✅ Return integration status WITHOUT exposing tokens
      res.json({
        success: true,
        slack: project.integrations?.slack
          ? {
              teamId: project.integrations.slack.teamId,
              teamName: project.integrations.slack.teamName,
              confirmedChannels:
                project.integrations.slack.confirmedChannels || [],
            }
          : null,
        github: project.integrations?.github
          ? {
              repoUrl: project.integrations.github.repoUrl,
            }
          : null,
      });
    } catch (error) {
      logger.error("Failed to fetch integrations:", error);
      res
        .status(500)
        .json({ success: false, error: "Failed to load integrations" });
    }
  },
);

// ✅ POST /api/admin/integrations/slack - Save Slack OAuth result (REAL)
router.post(
  "/integrations/slack",
  requireAuth,
  requireProjectAdmin,
  async (req, res) => {
    try {
      const { projectKey } = req.session;
      const { teamId, teamName, botToken, channels } = req.body;

      // ✅ Encrypt bot token before storing
      const encryptedToken = encrypt(botToken);

      // ✅ Update project document with integration details
      await collections.projects.doc(projectKey).update({
        "integrations.slack": {
          teamId,
          teamName,
          botToken: encryptedToken,
          connectedBy: req.session.userId,
          connectedAt: admin.firestore.FieldValue.serverTimestamp(),
          confirmedChannels: channels || [],
        },
        "setup.slackWorkspaceConnected": true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ✅ Mark ALL admins in this project as "Slack connected" (one-time setup)
      const adminsSnapshot = await collections.users
        .where("jiraProjectKey", "==", projectKey)
        .where("isAdmin", "==", true)
        .get();

      const batch = collections.db.batch();
      adminsSnapshot.docs.forEach((doc) => {
        batch.update(doc.ref, {
          "setup.slackWorkspaceConnected": true,
        });
      });
      await batch.commit();

      res.json({ success: true, message: "Slack integration saved" });
    } catch (error) {
      logger.error("Failed to save Slack integration:", error);
      res
        .status(500)
        .json({ success: false, error: "Failed to save integration" });
    }
  },
);

// ✅ POST /api/admin/integrations/slack/confirm-channel - Confirm bot added to channel (REAL)
router.post(
  "/integrations/slack/confirm-channel",
  requireAuth,
  requireProjectAdmin,
  async (req, res) => {
    try {
      const { projectKey } = req.session;
      const { channelId } = req.body;

      // ✅ Atomic array union: add channel to confirmed list
      await collections.projects.doc(projectKey).update({
        "integrations.slack.confirmedChannels":
          admin.firestore.FieldValue.arrayUnion(channelId),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({ success: true, message: "Channel confirmed" });
    } catch (error) {
      logger.error("Failed to confirm channel:", error);
      res
        .status(500)
        .json({ success: false, error: "Failed to confirm channel" });
    }
  },
);

module.exports = router;
