const express = require("express");
const axios = require("axios"); // ✅ Needed for direct API calls
const { v4: uuidv4 } = require("uuid");
const admin = require("firebase-admin"); // ✅ Needed for serverTimestamp()
const {
  collections,
  getUserRef,
  registerProject,
  upsertProjectMember,
  isProjectRegistered,
  getRequiredContactInfo,
  getProjectMemberRef,
} = require("../config/firebase");
const {
  JIRA_AUTH,
  JIRA_API, // ✅ This is just a constant, we override with direct URL below
  createJiraClient,
  getAccessibleResources,
  getCurrentUser,
  checkProjectAdmin,
} = require("../config/jira");
const { requireAuth } = require("../middleware/auth"); // ✅ Needed for /profile-setup
const logger = require("../utils/logger");

const router = express.Router();

// Home - redirect to login or dashboard
router.get("/", (req, res) => {
  if (req.session?.token && req.session?.isAdmin) {
    return res.redirect("/dashboard");
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
// ================= CALLBACK =================
router.get("/callback", async (req, res) => {
  try {
    const { code, error, error_description } = req.query;

    if (error) {
      logger.error("OAuth error:", error, error_description);
      return res.status(400).send(`
        <!DOCTYPE html>
        <html><head><title>Auth Failed</title>
        <script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-gray-50 min-h-screen flex items-center justify-center">
          <div class="bg-white rounded-xl shadow p-8 max-w-md text-center">
            <div class="text-red-500 text-4xl mb-4">❌</div>
            <h2 class="text-xl font-bold text-gray-900 mb-2">Authentication Failed</h2>
            <p class="text-gray-600 mb-4">${error_description || error}</p>
            <a href="/login" class="inline-block bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium">Try Again</a>
          </div>
        </body></html>
      `);
    }

    if (!code) {
      return res.status(400).send("Missing authorization code");
    }

    // Exchange code for tokens (your existing code)
    const tokenResponse = await axios.post(`${JIRA_AUTH}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: process.env.JIRA_CLIENT_ID,
      client_secret: process.env.JIRA_CLIENT_SECRET,
      code,
      redirect_uri: process.env.JIRA_CALLBACK_URL,
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const resources = await getAccessibleResources(access_token);

    if (!resources?.length) {
      return res.send(`
        <!DOCTYPE html>
        <html><head><title>No Projects</title>
        <script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-gray-50 min-h-screen flex items-center justify-center">
          <div class="bg-white rounded-xl shadow p-8 max-w-md text-center">
            <div class="text-yellow-500 text-4xl mb-4">⚠️</div>
            <h2 class="text-xl font-bold text-gray-900 mb-2">No Jira Projects Found</h2>
            <p class="text-gray-600 mb-4">Your account doesn't have access to any Jira Cloud sites.</p>
            <a href="/login" class="inline-block bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium">Try Different Account</a>
          </div>
        </body></html>
      `);
    }

    // Store tokens in session
    req.session.token = access_token;
    req.session.refreshToken = refresh_token;
    req.session.tokenExpiry = Date.now() + expires_in * 1000;
    req.session.sites = resources;
    req.session.userId = uuidv4();

    // ✅ PROFESSIONAL SITE SELECTION UI
    let html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>Select Jira Site | Agentic Workflow</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>body{font-family:'Inter',system-ui}</style>
      </head>
      <body class="bg-gradient-to-br from-blue-50 to-indigo-50 min-h-screen flex items-center justify-center p-4">
        <div class="bg-white rounded-2xl shadow-xl p-8 max-w-lg w-full">
          <div class="text-center mb-8">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white text-2xl font-bold mb-4">
              🔄
            </div>
            <h1 class="text-2xl font-bold text-gray-900">Select Your Jira Site</h1>
            <p class="text-gray-600 mt-2">Choose the Jira instance containing your project</p>
          </div>
          
          <form method="POST" action="/select-site" class="space-y-3">
    `;

    resources.forEach((site, index) => {
      html += `
        <label class="flex items-start p-4 border-2 border-gray-200 rounded-xl hover:border-blue-300 hover:bg-blue-50 cursor-pointer transition group">
          <input type="radio" name="siteIndex" value="${index}" class="mt-1 h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500" ${index === 0 ? "checked" : ""}>
          <div class="ml-4 flex-1">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-gray-900 group-hover:text-blue-700">${site.name}</span>
              <span class="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded">${site.id.slice(0, 8)}...</span>
            </div>
            <p class="text-sm text-gray-500 mt-1 break-all">${site.url}</p>
          </div>
        </label>
      `;
    });

    html += `
            <button type="submit" class="w-full mt-6 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white py-3 px-4 rounded-xl font-semibold transition shadow-lg hover:shadow-xl">
              Continue to Project Selection
            </button>
          </form>
          
          <p class="text-xs text-gray-400 text-center mt-6">
            🔐 Your credentials are encrypted and never stored permanently
          </p>
        </div>
      </body>
      </html>
    `;

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
// ================= PROJECT LIST =================
router.get("/projects", async (req, res) => {
  try {
    const { token, cloudId } = req.session;

    if (!token || !cloudId) {
      return res.redirect("/login");
    }

    const jiraClient = createJiraClient(token);

    // ✅ FETCH ALL PROJECTS USER CAN ACCESS (not just admin)
    const response = await jiraClient.get(
      `/ex/jira/${cloudId}/rest/api/3/project/search`,
      {
        params: {
          expand: "description,lead,url",
          maxResults: 50,
        },
      },
    );

    const projects = response.data.values || [];

    if (!projects.length) {
      return res.send(`
        <!DOCTYPE html>
        <html><head><title>No Projects</title>
        <script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-gray-50 min-h-screen flex items-center justify-center">
          <div class="bg-white rounded-xl shadow p-8 max-w-md text-center">
            <div class="text-yellow-500 text-4xl mb-4">📁</div>
            <h2 class="text-xl font-bold text-gray-900 mb-2">No Projects Found</h2>
            <p class="text-gray-600 mb-4">You don't have access to any Jira projects in this site.</p>
            <a href="/login" class="inline-block bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium">Switch Account</a>
          </div>
        </body></html>
      `);
    }

    // ✅ PROFESSIONAL PROJECT SELECTION UI
    let html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>Select Project | Agentic Workflow</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>body{font-family:'Inter',system-ui}</style>
      </head>
      <body class="bg-gradient-to-br from-blue-50 to-indigo-50 min-h-screen flex items-center justify-center p-4">
        <div class="bg-white rounded-2xl shadow-xl p-8 max-w-2xl w-full">
          <div class="text-center mb-8">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white text-2xl font-bold mb-4">
              📋
            </div>
            <h1 class="text-2xl font-bold text-gray-900">Select Your Project</h1>
            <p class="text-gray-600 mt-2">Choose the Jira project to configure workflows for</p>
          </div>
          
          <form method="POST" action="/validate" class="space-y-3 max-h-96 overflow-y-auto pr-2">
    `;

    projects.forEach((project) => {
      const key = project.key;
      const name = project.name;
      const desc = project.description || "No description";
      const lead = project.lead?.displayName || "Unassigned";

      html += `
        <label class="flex items-start p-4 border-2 border-gray-200 rounded-xl hover:border-blue-300 hover:bg-blue-50 cursor-pointer transition group">
          <input type="radio" name="projectKey" value="${key}" class="mt-1 h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500" required>
          <div class="ml-4 flex-1 min-w-0">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="font-mono font-semibold text-gray-900 bg-gray-100 px-2 py-0.5 rounded text-sm">${key}</span>
                <span class="font-medium text-gray-900 group-hover:text-blue-700 truncate">${name}</span>
              </div>
              <span class="text-xs text-gray-400">▼</span>
            </div>
            <p class="text-sm text-gray-500 mt-1 line-clamp-2">${desc}</p>
            <p class="text-xs text-gray-400 mt-2">Lead: ${lead}</p>
          </div>
        </label>
      `;
    });

    html += `
          </form>
          
          <button type="submit" form="projectsForm" class="w-full mt-6 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white py-3 px-4 rounded-xl font-semibold transition shadow-lg hover:shadow-xl">
            Configure Project
          </button>
          
          <p class="text-xs text-gray-400 text-center mt-6">
            🔐 Only projects you have access to are shown
          </p>
        </div>
      </body>
      </html>
    `;

    // Fix: Add form ID for submit button
    html = html.replace(
      '<form method="POST" action="/validate"',
      '<form id="projectsForm" method="POST" action="/validate"',
    );

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
// ================= VALIDATE =================
// ================= VALIDATE =================
// 🔍 DEBUG: Log session before validate
router.use("/validate", (req, res, next) => {
  logger.debug("🔍 /validate request:", {
    body: req.body,
    session: {
      hasToken: !!req.session?.token,
      cloudId: req.session?.cloudId,
      user: req.session?.user?.displayName,
      baseUrl: req.session?.baseUrl,
    },
  });
  next();
});
router.post("/validate", async (req, res) => {
  try {
    const { token, cloudId, user } = req.session;
    const { projectKey } = req.body;

    if (!token || !cloudId || !projectKey) {
      logger.error("Missing params:", { token: !!token, cloudId, projectKey });
      return res.status(400).send("Missing required parameters");
    }

    // ✅ USE DIRECT AXIOS CALLS (like your working oauth-test.js)
    const JIRA_API = "https://api.atlassian.com";
    const authHeaders = { Authorization: `Bearer ${token}` };

    // ===== USER INFO =====
    let userRes;
    try {
      userRes = await axios.get(
        `${JIRA_API}/ex/jira/${cloudId}/rest/api/3/myself`,
        { headers: authHeaders },
      );
    } catch (e) {
      logger.error("Failed to fetch user:", e.response?.data || e.message);
      return res.status(500).send("Failed to fetch user info");
    }
    const userData = userRes.data;

    // ===== ADMIN CHECK (EXACTLY LIKE YOUR WORKING CODE) =====
    let isAdmin = false;
    try {
      const adminRes = await axios.get(
        `${JIRA_API}/ex/jira/${cloudId}/rest/api/3/mypermissions`,
        {
          headers: authHeaders,
          params: {
            permissions: "ADMINISTER_PROJECTS",
            projectKey: projectKey,
          },
        },
      );
      // ✅ EXACT RESPONSE PARSING LIKE YOUR WORKING CODE
      isAdmin =
        adminRes.data.permissions.ADMINISTER_PROJECTS?.havePermission || false;
      logger.debug("Admin check result:", { projectKey, isAdmin });
    } catch (e) {
      logger.warn(
        "Admin permission check failed:",
        e.response?.data || e.message,
      );
      isAdmin = false; // Non-admins can still use app (view-only)
    }

    // ===== ASSIGN CHECK (EXACTLY LIKE YOUR WORKING CODE) =====
    let canAssign = false;
    try {
      const issueKey = `${projectKey}-1`; // Test with first issue
      const permRes = await axios.get(
        `${JIRA_API}/ex/jira/${cloudId}/rest/api/3/mypermissions`,
        {
          headers: authHeaders,
          params: {
            permissions: "ASSIGN_ISSUES",
            issueKey: issueKey,
          },
        },
      );
      canAssign =
        permRes.data.permissions.ASSIGN_ISSUES?.havePermission || false;
      logger.debug("Assign check result:", { issueKey, canAssign });
    } catch (e) {
      logger.warn(
        "Assign permission check failed:",
        e.response?.data || e.message,
      );
      canAssign = false;
    }

    // ✅ SAVE USER TO FIRESTORE
    await getUserRef(req.session.userId).set(
      {
        jiraAccountId: userData.accountId,
        email: userData.emailAddress,
        displayName: userData.displayName,
        jiraCloudId: cloudId,
        jiraProjectKey: projectKey,
        jiraBaseUrl: req.session.baseUrl,
        isAdmin: isAdmin,
        canAssign: canAssign,
        lastLogin: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // ✅ CREATE/UPDATE PROJECT MEMBER doc (per-project, per-user)
    await upsertProjectMember(projectKey, userData.accountId, {
      userId: req.session.userId,
      jiraAccountId: userData.accountId,
      email: userData.emailAddress,
      displayName: userData.displayName,
      role: isAdmin ? "admin" : "member",
      joinedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ✅ IF ADMIN: Register the project (first admin to login registers it)
    if (isAdmin) {
      await registerProject(
        projectKey,
        req.session.userId,
        userData.emailAddress,
        userData.displayName,
      );
    }

    // ✅ UPDATE SESSION (include accountId for member lookups)
    req.session.projectKey = projectKey;
    req.session.isAdmin = isAdmin;
    req.session.canAssign = canAssign;
    req.session.user.accountId = userData.accountId;

    logger.info("Validation complete:", { projectKey, isAdmin, canAssign });

    // ✅ REDIRECT BASED ON ROLE
    if (isAdmin) {
      res.redirect("/dashboard");
    } else {
      // Non-admin: check if project is registered by any admin
      const registered = await isProjectRegistered(projectKey);
      if (!registered) {
        res.redirect("/not-registered");
      } else {
        // Check if this user has already completed profile setup
        // (has at least one contact field saved in the project member doc)
        const memberDoc = await getProjectMemberRef(projectKey, userData.accountId).get();
        const memberData = memberDoc.exists ? memberDoc.data() : {};
        const hasCompletedProfile = !!(
          memberData.slackUserId ||
          memberData.phoneNumber ||
          memberData.contact?.githubUsername
        );

        if (hasCompletedProfile) {
          // Already set up — go straight to BugSense
          res.redirect(`/bugsense?project=${encodeURIComponent(projectKey)}`);
        } else {
          res.redirect("/profile-setup");
        }
      }
    }
  } catch (error) {
    logger.error("❌ VALIDATE HANDLER CRASHED:", {
      message: error.message,
      stack: error.stack,
      session: {
        hasToken: !!req.session?.token,
        cloudId: req.session?.cloudId,
        projectKey: req.session?.projectKey,
        userId: req.session?.userId,
      },
    });
    res.status(500).send(`Failed to validate project access: ${error.message}`);
  }
});

// ================= PROFILE SETUP (for ANY user) =================
router.get("/profile-setup", requireAuth, async (req, res) => {
  try {
    const { projectKey, isAdmin, canAssign } = req.session;

    // Fetch existing profile from Firestore
    const userDoc = await getUserRef(req.session.userId).get();
    const profile = userDoc.exists ? userDoc.data() : {};

    // Determine what to show based on role
    const showWorkflowAccess = isAdmin; // Only admins can create/edit workflows
    const showNotificationSetup = canAssign || isAdmin; // Assignees + admins receive notifications

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>Profile Setup | Agentic Workflow</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-gray-50 min-h-screen">
        <div class="max-w-2xl mx-auto px-4 py-12">
          <div class="bg-white rounded-xl shadow p-8">
            <h1 class="text-2xl font-bold text-gray-900 mb-2">Complete Your Profile</h1>
            <p class="text-gray-600 mb-6">Project: <strong>${projectKey}</strong> • Role: ${isAdmin ? "Admin" : "Member"}</p>
            
            <!-- Contact Info (for ALL users who can receive notifications) -->
            ${
              showNotificationSetup
                ? `
            <div class="mb-8 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h2 class="font-medium text-blue-900 mb-3">🔔 Notification Preferences</h2>
              <p class="text-sm text-blue-700 mb-4">
                Provide your contact details to receive task assignments and updates.
              </p>
              
              <form id="contactForm" class="space-y-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">
                    Personal Slack User ID
                  </label>
                  <input type="text" name="slackUserId" 
                         value="${profile.contact?.slackUserId || ""}"
                         placeholder="U12345678"
                         class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                         pattern="^U[A-Z0-9]+$">
                  <p class="text-xs text-gray-500 mt-1">
                    Find this in Slack: Click your profile → More → Copy User ID
                  </p>
                </div>
                
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">
                    Mobile Number (for SMS alerts)
                  </label>
                  <input type="tel" name="phoneNumber" 
                         value="${profile.contact?.phoneNumber ? "••••••••••" : ""}"
                         placeholder="+1234567890"
                         class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                         pattern="^\\+?[1-9]\\d{1,14}$">
                  <p class="text-xs text-gray-500 mt-1">
                    E.164 format: +[country code][number] (e.g., +14155552671)
                  </p>
                </div>
                
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">
                    GitHub Username (for auto-branch creation)
                  </label>
                  <input type="text" name="githubUsername" 
                         value="${profile.contact?.githubUsername || ""}"
                         placeholder="your-github-handle"
                         class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                         pattern="^[a-zA-Z0-9]([a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$">
                </div>
                
                <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition">
                  Save Contact Info
                </button>
              </form>
              <div id="contactSuccess" class="hidden mt-3 p-3 bg-green-50 text-green-700 rounded-lg text-sm">
                ✅ Contact info saved successfully!
              </div>
            </div>
            `
                : `
            <div class="mb-8 p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <p class="text-sm text-gray-600">
                You'll receive notifications via your Jira account. 
                <a href="/profile-setup" class="text-blue-600 hover:underline">Update preferences</a>
              </p>
            </div>
            `
            }
            
            <!-- Workflow Access (admin-only) -->
            ${
              showWorkflowAccess
                ? `
            <div class="p-4 bg-green-50 border border-green-200 rounded-lg">
              <h2 class="font-medium text-green-900 mb-2">✅ Admin Access Granted</h2>
              <p class="text-sm text-green-700">
                You can create and manage workflows for project <strong>${projectKey}</strong>.
              </p>
              <a href="/workflow-builder" class="inline-block mt-3 text-green-800 font-medium hover:underline">
                Go to Workflow Builder →
              </a>
            </div>
            `
                : `
            <div class="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <h2 class="font-medium text-yellow-900 mb-2">👁️ View-Only Access</h2>
              <p class="text-sm text-yellow-700">
                You can view workflows and receive notifications, but cannot create or edit them. 
                Contact a project admin to request edit access.
              </p>
            </div>
            `
            }
          </div>
        </div>
        
        <script>
          // Save contact info via API
          document.getElementById('contactForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.target;
            const btn = form.querySelector('button[type="submit"]');
            const success = document.getElementById('contactSuccess');
            
            btn.disabled = true;
            btn.textContent = 'Saving...';
            
            try {
              const res = await fetch('/api/admin/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  slackUserId: form.slackUserId.value || null,
                  phoneNumber: form.phoneNumber.value || null,
                  githubUsername: form.githubUsername.value || null
                })
              });
              
              const result = await res.json();
              if (result.success) {
                success.classList.remove('hidden');
                form.reset();
              } else {
                alert('Failed to save: ' + result.error);
              }
            } catch (err) {
              alert('Network error: ' + err.message);
            } finally {
              btn.disabled = false;
              btn.textContent = 'Save Contact Info';
            }
          });
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    logger.error("Profile setup failed:", error);
    res.status(500).send("Failed to load profile setup");
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
