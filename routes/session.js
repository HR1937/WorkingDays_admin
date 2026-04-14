// routes/session.js
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  collections,
  getProjectMember,
  isProjectRegistered,
  getRequiredContactInfo,
} = require("../config/firebase");

const router = express.Router();

// ✅ GET /api/session - Return current user session data with per-project context
router.get("/", requireAuth, async (req, res) => {
  try {
    const { userId, projectKey, isAdmin, canAssign, user } = req.session;

    // Fetch fresh global profile from Firestore
    let profile = null;
    if (userId) {
      const userDoc = await collections.users.doc(userId).get();
      if (userDoc.exists) {
        profile = userDoc.data();
        // Decrypt phone before sending (global contact — legacy)
        if (profile.contact?.phoneNumber) {
          try {
            const { decrypt } = require("../utils/crypto");
            profile.contact.phoneNumber = decrypt(profile.contact.phoneNumber);
          } catch (e) {
            profile.contact.phoneNumber = null; // corrupted, clear it
          }
        }
      }
    }

    // Fetch per-project member data (Slack ID specific to this workspace)
    let projectMember = null;
    if (projectKey && user?.accountId) {
      projectMember = await getProjectMember(projectKey, user.accountId);
      if (projectMember) {
        // Decrypt phone
        if (projectMember.phoneNumber) {
          try {
            const { decrypt } = require("../utils/crypto");
            projectMember.phoneNumber = decrypt(projectMember.phoneNumber);
          } catch (e) {
            projectMember.phoneNumber = null;
          }
        }
        // Normalize Slack member ID — expose as slackMemberId, keep slackUserId for compat
        projectMember.slackMemberId = projectMember.slackMemberId || projectMember.slackUserId || null;
      }
    }


    // Check project registration status
    let projectRegistered = false;
    if (projectKey) {
      projectRegistered = await isProjectRegistered(projectKey);
    }

    // Check what contact info is required by existing workflows
    let requiredContact = { slackRequired: false, smsRequired: false };
    if (projectKey) {
      requiredContact = await getRequiredContactInfo(projectKey);
    }

    // Check if Slack workspace is connected for this project
    let slackConnected = false;
    let slackTeamName = null;
    if (projectKey) {
      const projectDoc = await collections.projects.doc(projectKey).get();
      if (projectDoc.exists && projectDoc.data()?.integrations?.slack?.teamId) {
        slackConnected = true;
        slackTeamName = projectDoc.data().integrations.slack.teamName;
      }
    }

    res.json({
      success: true,
      user: {
        userId,
        email: user?.email,
        displayName: user?.displayName,
        jiraAccountId: user?.accountId,
        jiraProjectKey: projectKey,
        isAdmin: isAdmin || false,
        canAssign: canAssign || false,
        profile,
        // Per-project data
        projectMember,
        projectRegistered,
        requiredContact,
        slackConnected,
        slackTeamName,
      },
    });
  } catch (error) {
    console.error("Session fetch failed:", error);
    res.status(500).json({ success: false, error: "Failed to load session" });
  }
});

module.exports = router;
