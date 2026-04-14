// routes/admin.js
const express = require("express");
const admin = require("firebase-admin");
const {
  collections,
  getUserRef,
  upsertProjectMember,
  getProjectMember,
  getProjectMembers,
  getRequiredContactInfo,
  getMemberContact,
} = require("../config/firebase");
const { requireAuth, requireProjectAdmin } = require("../middleware/auth");
const { encrypt, decrypt } = require("../utils/crypto");
const logger = require("../utils/logger");

const router = express.Router();

// ============================================================================
// ADMIN PROFILE ENDPOINTS
// ============================================================================

// ✅ GET /api/admin/profile - Fetch current user's profile
router.get("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const jiraAccountId = req.session.user?.accountId;

    const userDoc = await collections.users.doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User profile not found" });
    }
    const profile = userDoc.data();

    // Fetch per-project member data
    let projectMember = null;
    if (projectKey && jiraAccountId) {
      projectMember = await getProjectMember(projectKey, jiraAccountId);
      if (projectMember) {
        // Decrypt sensitive fields
        if (projectMember.phoneNumber) {
          try { projectMember.phoneNumber = decrypt(projectMember.phoneNumber); } catch { /* already plain */ }
        }
        if (projectMember.githubAccessToken) {
          try { projectMember.githubAccessToken = decrypt(projectMember.githubAccessToken); } catch {}
        }
      }
    }

    res.json({ success: true, profile, projectMember });
  } catch (error) {
    logger.error("Failed to fetch admin profile:", error);
    res.status(500).json({ success: false, error: "Failed to load profile" });
  }
});

// ✅ PUT /api/admin/profile - Update contact info
// Stores: slackMemberId + slackWorkspaceId + phoneNumber per-project member doc
// Stores: githubAccountId globally (username is not workspace-scoped)
router.put("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const jiraAccountId = req.session.user?.accountId;
    const { slackMemberId, phoneNumber, githubAccountId } = req.body;

    // Encrypt sensitive data
    const encryptedPhone = phoneNumber ? encrypt(phoneNumber) : undefined;

    // Save globally: githubAccountId (username is same across workspaces)
    if (githubAccountId !== undefined) {
      await getUserRef(userId).update({
        "contact.githubAccountId": githubAccountId || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // Save per-project: slackMemberId (scoped to workspace) + phone
    if (projectKey && jiraAccountId) {
      // Fetch workspaceId for this project's Slack integration
      let slackWorkspaceId = null;
      try {
        const projectDoc = await collections.projects.doc(projectKey).get();
        slackWorkspaceId = projectDoc.data()?.integrations?.slack?.teamId || null;
      } catch {}

      const memberUpdate = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (slackMemberId !== undefined) {
        memberUpdate.slackMemberId = slackMemberId || null;
        memberUpdate.slackWorkspaceId = slackWorkspaceId;
      }
      if (encryptedPhone !== undefined) memberUpdate.phoneNumber = encryptedPhone;

      await upsertProjectMember(projectKey, jiraAccountId, memberUpdate);
    }

    res.json({ success: true, message: "Profile updated" });
  } catch (error) {
    logger.error("Failed to update admin profile:", error);
    res.status(500).json({ success: false, error: "Failed to update profile" });
  }
});

// ✅ PUT /api/admin/members/contact - Save per-project member contact (Slack ID + phone)
router.put("/members/contact", requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const jiraAccountId = req.session.user?.accountId;
    const { slackMemberId, phoneNumber } = req.body;

    if (!projectKey || !jiraAccountId) {
      return res.status(400).json({ success: false, error: "Missing project or account info" });
    }

    // Fetch workspaceId for this project's Slack integration
    let slackWorkspaceId = null;
    try {
      const projectDoc = await collections.projects.doc(projectKey).get();
      slackWorkspaceId = projectDoc.data()?.integrations?.slack?.teamId || null;
    } catch {}

    const memberUpdate = {};
    if (slackMemberId !== undefined) {
      memberUpdate.slackMemberId = slackMemberId || null;
      memberUpdate.slackWorkspaceId = slackWorkspaceId;
    }
    if (phoneNumber !== undefined) memberUpdate.phoneNumber = phoneNumber ? encrypt(phoneNumber) : null;

    await upsertProjectMember(projectKey, jiraAccountId, memberUpdate);
    res.json({ success: true, message: "Contact info saved for project" });
  } catch (error) {
    logger.error("Failed to save member contact:", error);
    res.status(500).json({ success: false, error: "Failed to save contact info" });
  }
});

// ✅ PUT /api/admin/members/github - Save GitHub account ID + encrypted PAT
router.put("/members/github", requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const jiraAccountId = req.session.user?.accountId;
    const { githubAccountId, githubAccessToken } = req.body;

    if (!githubAccountId) {
      return res.status(400).json({ success: false, error: "GitHub account ID required" });
    }

    const encryptedToken = githubAccessToken ? encrypt(githubAccessToken) : null;

    await upsertProjectMember(projectKey, jiraAccountId, {
      githubAccountId,
      githubAccessToken: encryptedToken,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: "GitHub info saved" });
  } catch (error) {
    logger.error("Failed to save GitHub info:", error);
    res.status(500).json({ success: false, error: "Failed to save GitHub info" });
  }
});

// ✅ GET /api/admin/members/profile-status - What contact info is still needed?
router.get("/members/profile-status", requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const jiraAccountId = req.session.user?.accountId;

    if (!projectKey || !jiraAccountId) {
      return res.status(400).json({ success: false, error: "Missing project or account info" });
    }

    const required = await getRequiredContactInfo(projectKey);
    const member = await getProjectMember(projectKey, jiraAccountId);

    const status = {
      slackNeeded: required.slackRequired,
      phoneNeeded: required.smsRequired,
      githubNeeded: required.githubRequired,
      slackComplete: !!(member?.slackMemberId || member?.slackUserId),
      phoneComplete: !!(member?.phoneNumber),
      githubComplete: !!(member?.githubAccountId || member?.contact?.githubUsername),
      slackWorkspaceId: required.slackWorkspaceId,
    };

    res.json({ success: true, status });
  } catch (error) {
    logger.error("Failed to get profile status:", error);
    res.status(500).json({ success: false, error: "Failed to get status" });
  }
});

// ✅ GET /api/admin/members/contact/:accountId - Get contact info for a specific member
router.get("/members/contact/:accountId", requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const { accountId } = req.params;

    if (!projectKey || !accountId) {
      return res.status(400).json({ success: false, error: "Missing project or account info" });
    }

    const member = await getProjectMember(projectKey, accountId);
    if (!member) {
      return res.json({ success: true, contact: null });
    }

    const contact = {
      slackMemberId: member.slackMemberId || member.slackUserId || null,
      phoneNumber: member.phoneNumber ? (() => { try { return decrypt(member.phoneNumber); } catch { return member.phoneNumber; } })() : null,
      email: member.email || null,
      githubAccountId: member.githubAccountId || member.contact?.githubUsername || null,
      displayName: member.displayName || null,
    };

    res.json({ success: true, contact });
  } catch (error) {
    logger.error("Failed to fetch member contact:", error);
    res.status(500).json({ success: false, error: "Failed to load contact" });
  }
});

// ============================================================================
// PROJECT REGISTRATION CHECK
// ============================================================================

router.get("/project/check-registration", requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    if (!projectKey) {
      return res.status(400).json({ success: false, error: "Project key required" });
    }

    const projectDoc = await collections.projects.doc(projectKey).get();
    const isRegistered = projectDoc.exists && !!projectDoc.data()?.registeredBy;
    const requiredContact = await getRequiredContactInfo(projectKey);

    res.json({
      success: true,
      registered: isRegistered,
      registeredBy: isRegistered ? projectDoc.data().registeredBy : null,
      requiredContact,
    });
  } catch (error) {
    logger.error("Failed to check project registration:", error);
    res.status(500).json({ success: false, error: "Check failed" });
  }
});

// ============================================================================
// PROJECT INTEGRATIONS ENDPOINTS
// ============================================================================

router.get("/integrations", requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const projectDoc = await collections.projects.doc(projectKey).get();

    if (!projectDoc.exists) {
      return res.json({ success: true, slack: null, github: null });
    }

    const project = projectDoc.data();
    res.json({
      success: true,
      slack: project.integrations?.slack
        ? {
            teamId: project.integrations.slack.teamId,
            teamName: project.integrations.slack.teamName,
            workspaceUrl: project.integrations.slack.workspaceUrl || null,
            confirmedChannels: project.integrations.slack.confirmedChannels || [],
          }
        : null,
      github: project.integrations?.github
        ? { repoUrl: project.integrations.github.repoUrl }
        : null,
    });
  } catch (error) {
    logger.error("Failed to fetch integrations:", error);
    res.status(500).json({ success: false, error: "Failed to load integrations" });
  }
});

// ============================================================================
// SLACK INTEGRATION ENDPOINTS
// ============================================================================

router.get("/integrations/slack/oauth-url", requireAuth, async (req, res) => {
  try {
    if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_REDIRECT_URI) {
      throw new Error("Slack credentials not configured in .env");
    }

    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const params = new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID,
      scope: process.env.SLACK_SCOPES || "chat:write,channels:read,im:write,users:read,users:read.email",
      redirect_uri: process.env.SLACK_REDIRECT_URI,
      state: projectKey || "unknown",
    });

    const oauthUrl = `https://slack.com/oauth/v2/authorize?${params}`;
    res.json({ success: true, oauthUrl });
  } catch (error) {
    logger.error("Failed to generate Slack OAuth URL:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/integrations/slack/channels", requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const projectDoc = await collections.projects.doc(projectKey).get();
    if (!projectDoc.exists || !projectDoc.data().integrations?.slack?.botToken) {
      return res.json({ success: true, channels: [], connected: false, message: "Slack workspace not connected." });
    }

    const slackData = projectDoc.data().integrations.slack;
    const botToken = decrypt(slackData.botToken);

    try {
      const { fetchWorkspaceChannels } = require("../config/slack");
      const channels = await fetchWorkspaceChannels(botToken);

      collections.projects.doc(projectKey).update({
        "integrations.slack.channels": channels,
        "integrations.slack.channelsUpdatedAt": admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => logger.warn("Failed to cache channels:", e.message));

      res.json({ success: true, channels, connected: true, teamName: slackData.teamName, teamId: slackData.teamId });
    } catch (slackError) {
      logger.warn("Live Slack channel fetch failed, using cache:", slackError.message);
      res.json({ success: true, channels: slackData.channels || [], connected: true, cached: true, teamName: slackData.teamName, teamId: slackData.teamId });
    }
  } catch (error) {
    logger.error("Failed to fetch Slack channels:", error);
    res.status(500).json({ success: false, error: "Failed to fetch channels" });
  }
});

router.get("/integrations/slack/status", requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const projectDoc = await collections.projects.doc(projectKey).get();

    if (!projectDoc.exists || !projectDoc.data().integrations?.slack?.teamId) {
      return res.json({ success: true, connected: false });
    }

    const slack = projectDoc.data().integrations.slack;
    res.json({ success: true, connected: true, teamId: slack.teamId, teamName: slack.teamName });
  } catch (error) {
    logger.error("Failed to check Slack status:", error);
    res.status(500).json({ success: false, error: "Check failed" });
  }
});

router.post("/integrations/slack/confirm-channel", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const { channelId, event } = req.body;

    if (!channelId) {
      return res.status(400).json({ success: false, error: "Channel ID required" });
    }

    const confirmedKey = `integrations.slack.confirmedChannels.${event}`;
    await collections.projects.doc(projectKey).update({
      [confirmedKey]: admin.firestore.FieldValue.arrayUnion(channelId),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: "Channel confirmed" });
  } catch (error) {
    logger.error("Failed to confirm Slack channel:", error);
    res.status(500).json({ success: false, error: "Failed to confirm channel" });
  }
});

router.post("/integrations/slack/test-message", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const { channelId, message } = req.body;

    if (!channelId) {
      return res.status(400).json({ success: false, error: "Channel ID required" });
    }

    const projectDoc = await collections.projects.doc(projectKey).get();
    if (!projectDoc.exists || !projectDoc.data().integrations?.slack?.botToken) {
      return res.status(400).json({ success: false, error: "Slack not connected" });
    }

    const { sendChannelMessage } = require("../config/slack");
    const encryptedToken = projectDoc.data().integrations.slack.botToken;
    const botToken = decrypt(encryptedToken);

    const result = await sendChannelMessage(
      botToken,
      channelId,
      { key: "TEST", summary: message || "🧪 Test message from Agentic Workflow", type: "Test", status: "Testing", url: process.env.APP_URL || "http://localhost:3000" },
      "medium",
    );

    if (result.success) {
      res.json({ success: true, message: "Test message sent", ts: result.ts });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    logger.error("Failed to send test Slack message:", error);
    res.status(500).json({ success: false, error: "Failed to send test message" });
  }
});

// ============================================================================
// GITHUB INTEGRATION
// ============================================================================

router.put("/integrations/github", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const projectKey = req.project?.key || req.session?.projectKey;
    const { repoUrl } = req.body;

    if (!repoUrl) {
      return res.status(400).json({ success: false, error: "Repository URL is required" });
    }

    await collections.projects.doc(projectKey).set(
      {
        integrations: {
          github: { repoUrl, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.json({ success: true, message: "GitHub repo URL saved" });
  } catch (error) {
    logger.error("Failed to save GitHub integration:", error);
    res.status(500).json({ success: false, error: "Failed to save GitHub settings" });
  }
});

// ============================================================================
// PROJECT FEATURES ENDPOINTS
// ============================================================================

router.put("/projects/features", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const projectKey = req.project?.key || req.session?.projectKey;
    const { aiAssigneeSuggestions, reportGeneration, sentryEnabled } = req.body;

    await collections.projects.doc(projectKey).set(
      {
        features: {
          aiAssigneeSuggestions: aiAssigneeSuggestions || false,
          reportGeneration: reportGeneration || false,
          sentryEnabled: sentryEnabled || false,
        },
        featuresSetAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.json({ success: true, message: "Features saved" });
  } catch (error) {
    logger.error("Failed to save project features:", error);
    res.status(500).json({ success: false, error: "Failed to save features" });
  }
});

router.get("/projects/features", requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const projectDoc = await collections.projects.doc(projectKey).get();

    if (!projectDoc.exists) {
      return res.json({ success: true, features: null });
    }

    const features = projectDoc.data().features || null;
    res.json({ success: true, features });
  } catch (error) {
    logger.error("Failed to fetch project features:", error);
    res.status(500).json({ success: false, error: "Failed to fetch features" });
  }
});

router.put("/integrations/sentry", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const { jiraApiToken } = req.body;

    if (!jiraApiToken) {
      return res.status(400).json({ success: false, error: "Jira API token is required" });
    }

    await collections.projects.doc(projectKey).set(
      { jiraApiToken, jiraCloudId: req.session.cloudId, updatedAt: new Date() },
      { merge: true }
    );

    res.json({ success: true, message: "Sentry integration configured" });
  } catch (error) {
    logger.error("Failed to save Sentry config:", error);
    res.status(500).json({ success: false, error: "Failed to save" });
  }
});

module.exports = router;
