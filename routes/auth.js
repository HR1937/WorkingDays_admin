const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { collections, getUserRef } = require("../config/firebase");
const {
  JIRA_AUTH,
  JIRA_API,
  createJiraClient,
  getAccessibleResources,
  getCurrentUser,
  checkProjectAdmin,
} = require("../config/jira");
const logger = require("../utils/logger");

const router = express.Router();

// Home - redirect to login or dashboard
router.get("/", (req, res) => {
  if (req.session?.token && req.session?.isAdmin) {
    return res.redirect("/workflow-builder");
  }
  res.redirect("/login");
});

// Initiate Jira OAuth flow
router.get("/login", (req, res) => {
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: process.env.JIRA_CLIENT_ID,
    scope: "read:jira-work read:jira-user read:me write:jira-work",
    redirect_uri: process.env.JIRA_CALLBACK_URL,
    response_type: "code",
    prompt: "consent",
  });

  res.redirect(`${JIRA_AUTH}/authorize?${params}`);
});

// OAuth callback handler
router.get("/callback", async (req, res) => {
  try {
    const { code, error, error_description } = req.query;

    if (error) {
      logger.error("OAuth error:", error, error_description);
      return res
        .status(400)
        .send(`Authentication failed: ${error_description || error}`);
    }

    if (!code) {
      return res.status(400).send("Missing authorization code");
    }

    // Exchange code for tokens
    const tokenResponse = await axios.post(`${JIRA_AUTH}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: process.env.JIRA_CLIENT_ID,
      client_secret: process.env.JIRA_CLIENT_SECRET,
      code,
      redirect_uri: process.env.JIRA_CALLBACK_URL,
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Get accessible resources (cloud instances)
    const resources = await getAccessibleResources(access_token);

    if (!resources?.length) {
      return res.send(`
        <h2>⚠️ No Jira Projects Found</h2>
        <p>Your account doesn't have access to any Jira Cloud sites.</p>
        <p><a href="/login">Try again</a> or contact your Jira admin.</p>
      `);
    }

    // Store tokens in session (encrypt in production)
    req.session.token = access_token;
    req.session.refreshToken = refresh_token;
    req.session.tokenExpiry = Date.now() + expires_in * 1000;
    req.session.sites = resources;

    // Generate session user ID
    const sessionUserId = uuidv4();
    req.session.userId = sessionUserId;

    // Show site selection
    let html = `
      <!DOCTYPE html>
      <html><head><title>Select Jira Site</title>
      <style>body{font-family:system-ui;padding:2rem;max-width:600px;margin:0 auto}
      .site{padding:1rem;margin:0.5rem 0;border:1px solid #ddd;border-radius:8px;cursor:pointer}
      .site:hover{border-color:#3b82f6;background:#f8fafc}
      .selected{border-color:#3b82f6;background:#eff6ff}</style></head>
      <body>
      <h2>🔐 Select Your Jira Site</h2>
      <form method="POST" action="/select-site">
    `;

    resources.forEach((site, index) => {
      html += `
        <label class="site">
          <input type="radio" name="siteIndex" value="${index}" ${index === 0 ? "checked" : ""}>
          <strong>${site.name}</strong><br>
          <small>${site.url}</small>
        </label>
      `;
    });

    html += `<button type="submit" style="margin-top:1rem;padding:0.75rem 1.5rem;background:#3b82f6;color:white;border:none;border-radius:6px;cursor:pointer">Continue</button>
      </form></body></html>`;

    res.send(html);
  } catch (error) {
    logger.error(
      "OAuth callback failed:",
      error.response?.data || error.message,
    );
    res.status(500).send("Authentication failed. Please try again.");
  }
});

// Handle site selection
router.post("/select-site", async (req, res) => {
  try {
    const { siteIndex } = req.body;
    const selected = req.session.sites?.[siteIndex];

    if (!selected) {
      return res.status(400).send("Invalid site selection");
    }

    req.session.cloudId = selected.id;
    req.session.baseUrl = selected.url;

    // Fetch user info and permissions
    const jiraClient = createJiraClient(req.session.token);
    const user = await getCurrentUser(jiraClient, selected.id);

    // Save minimal user data to session
    req.session.user = {
      accountId: user.accountId,
      email: user.emailAddress,
      displayName: user.displayName,
    };

    // Upsert user in Firestore (create or update)
    await getUserRef(req.session.userId).set(
      {
        jiraAccountId: user.accountId,
        email: user.emailAddress,
        displayName: user.displayName,
        jiraCloudId: selected.id,
        jiraBaseUrl: selected.url,
        lastLogin: new Date(),
        createdAt: new Date(),
      },
      { merge: true },
    );

    // Redirect to project selection
    res.redirect("/projects");
  } catch (error) {
    logger.error("Site selection failed:", error.message);
    res.status(500).send("Failed to load your Jira account");
  }
});

// Project selection page
router.get("/projects", async (req, res) => {
  try {
    if (!req.session?.token || !req.session?.cloudId) {
      return res.redirect("/login");
    }

    const jiraClient = createJiraClient(req.session.token);

    // Fetch projects user can administer
    const response = await jiraClient.get(
      `/ex/jira/${req.session.cloudId}/rest/api/3/project/search`,
      {
        params: {
          permissions: "ADMINISTER_PROJECTS",
          expand: "description,lead,url,projectKeys",
        },
      },
    );

    const projects = response.data.values || [];

    if (!projects.length) {
      return res.send(`
        <h2>⚠️ No Admin Projects Found</h2>
        <p>You don't have admin access to any Jira projects.</p>
        <p>Contact your Jira administrator to get project admin permissions.</p>
        <p><a href="/login">Switch account</a></p>
      `);
    }

    let html = `
      <!DOCTYPE html>
      <html><head><title>Select Project</title>
      <style>body{font-family:system-ui;padding:2rem;max-width:600px;margin:0 auto}
      .project{padding:1rem;margin:0.5rem 0;border:1px solid #ddd;border-radius:8px;cursor:pointer}
      .project:hover{border-color:#3b82f6;background:#f8fafc}</style></head>
      <body>
      <h2>📁 Select Project to Configure</h2>
      <p style="color:#666;margin-bottom:1.5rem">Only projects where you have <strong>Admin</strong> permissions are shown.</p>
      <form method="POST" action="/validate">
    `;

    projects.forEach((project) => {
      html += `
        <label class="project">
          <input type="radio" name="projectKey" value="${project.key}" required>
          <strong>${project.key}</strong> - ${project.name}<br>
          <small style="color:#666">${project.description || "No description"}</small>
        </label>
      `;
    });

    html += `<button type="submit" style="margin-top:1rem;padding:0.75rem 1.5rem;background:#3b82f6;color:white;border:none;border-radius:6px;cursor:pointer">Configure Project</button>
      </form>
      <p style="margin-top:2rem;font-size:0.9rem;color:#666">
        🔐 Your credentials are stored securely and only used for API calls on your behalf.
      </p>
      </body></html>`;

    res.send(html);
  } catch (error) {
    logger.error(
      "Failed to fetch projects:",
      error.response?.data || error.message,
    );
    res.status(500).send("Failed to load your projects");
  }
});

// Validate project and check permissions
router.post("/validate", async (req, res) => {
  try {
    const { token, cloudId, user } = req.session;
    const { projectKey } = req.body;

    if (!token || !cloudId || !projectKey) {
      return res.status(400).send("Missing required parameters");
    }

    const jiraClient = createJiraClient(token);

    // Verify admin permission (double-check)
    const isAdmin = await checkProjectAdmin(jiraClient, cloudId, projectKey);

    if (!isAdmin) {
      return res
        .status(403)
        .send(`You don't have admin access to project ${projectKey}`);
    }

    // Update session with project context
    req.session.projectKey = projectKey;
    req.session.isAdmin = true;

    // Update Firestore with project association
    await getUserRef(req.session.userId).update({
      currentProjectKey: projectKey,
      isAdmin: true,
      updatedAt: new Date(),
    });

    // Redirect to workflow builder
    res.redirect("/workflow-builder");
  } catch (error) {
    logger.error("Project validation failed:", error.message);
    res.status(500).send("Failed to validate project access");
  }
});

// Logout
router.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) logger.warn("Session destruction error:", err.message);
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});

module.exports = router;
