// app.js
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const admin = require("firebase-admin");

// Initialize Firebase first (before routes)
require("./config/firebase");

const logger = require("./utils/logger");

const app = express();

// === SECURITY MIDDLEWARE ===
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          "cdn.tailwindcss.com",
          "cdn.jsdelivr.net",
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com", "fonts.googleapis.com", "fonts.gstatic.com"],
        fontSrc: ["'self'", "fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: [
          "'self'",
          "https://api.atlassian.com",
          "https://auth.atlassian.com",
          "https://cdn.jsdelivr.net",
          "https://firestore.googleapis.com",
        ],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
  }),
);

// Rate limiting for API routes (prevent abuse)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per window
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.session?.userId || req.ip, // Rate limit by user if authenticated
});

// === SESSION CONFIG ===
app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      "dev_secret_change_in_production_must_be_64_chars",
    resave: false, // Don't save session if unmodified
    saveUninitialized: false, // Don't create session for unauthenticated requests
    cookie: {
      secure: false, // Must be false for ngrok HTTP→HTTPS tunneling in dev
      httpOnly: true, // Prevent XSS attacks
      sameSite: "lax", // Allow cross-site redirects from OAuth flow
      maxAge: 24 * 60 * 60 * 1000, // 24 hours session lifetime
    },
  }),
);

// === BODY PARSING ===
// Raw body for webhook signature verification (must be before JSON parsing)
app.use("/webhooks", express.raw({ type: "application/json", limit: "10mb" }));
// JSON parsing for other routes
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// === STATIC FILES ===
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// === ROUTES (ORDER MATTERS: most specific FIRST) ===

// Health check (public endpoint for load balancers)
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    env: process.env.NODE_ENV,
  });
});

// Auth routes (OAuth flow) - public endpoints
app.use("/", require("./routes/auth"));

// ✅ SPECIFIC API routes FIRST (before generic /api catch-all)
app.use("/api/session", require("./routes/session"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/features/ai-analysis", require("./routes/features/ai-analysis"));
app.use("/api/features/reports", require("./routes/features/reports"));

// ✅ AI Chat routes (Gemini proxy + history)
app.use("/ai", require("./routes/ai-chat"));

// ✅ BugSense (unified dashboard) routes — all on port 3000 now
app.use("/bugsense/api", require("./routes/bugsense"));

// ✅ GENERIC /api routes LAST (with rate limiting)
// This only catches /api/workflows/* paths, not all /api/*
app.use("/api/workflows", apiLimiter, require("./routes/workflows"));

// Webhook routes (no rate limit - Jira/GitHub need reliability)
// Signature verification happens inside these routes
app.use("/webhooks", require("./routes/webhooks/jira"));
app.use("/webhooks", require("./routes/webhooks/github"));
app.use("/webhooks/sentry", require("./routes/webhooks/sentry"));

// ===== SLACK OAuth routes (top-level, no requireProjectAdmin since Slack can't send headers) =====
// GET /slack/install - Redirect to Slack OAuth authorization page
app.get("/slack/install", (req, res) => {
  if (!req.session?.token) return res.redirect("/login");
  
  const projectKey = req.query.projectKey || req.session.projectKey;
  if (!projectKey) return res.redirect("/dashboard");

  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    scope: process.env.SLACK_SCOPES || "chat:write,channels:read,im:write",
    redirect_uri: process.env.SLACK_REDIRECT_URI,
    state: projectKey, // Pass projectKey as state to retrieve after callback
  });

  res.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
});

// GET /slack/oauth - Slack OAuth callback (redirect from Slack after authorization)
app.get("/slack/oauth", async (req, res) => {
  try {
    // Session may be lost during ngrok redirect - try to recover
    const hasSession = !!(req.session?.token);
    if (!hasSession) {
      // If session is lost, we still have state param with projectKey
      // Redirect to dashboard with error asking user to retry
      const { error: slackError, state: projectKey, code } = req.query;
      if (!code) {
        return res.redirect("/login?error=slack_no_code");
      }
      // Even without full session, we can process the OAuth if we have code+state
      // But we need session for userId - redirect to login with a hint
      return res.redirect("/login?slack_pending=true&state=" + encodeURIComponent(projectKey || "") + "&code=" + encodeURIComponent(code));
    }

    const { code, error: slackError, state: projectKey } = req.query;

    if (slackError) {
      return res.redirect("/dashboard?slack_error=" + encodeURIComponent(slackError));
    }
    if (!code) {
      return res.redirect("/dashboard?slack_error=" + encodeURIComponent("Missing OAuth code"));
    }
    if (!projectKey) {
      return res.redirect("/dashboard?slack_error=" + encodeURIComponent("Missing project key"));
    }

    const { handleSlackOAuth, fetchWorkspaceChannels, fetchWorkspaceUsers } = require("./config/slack");
    const { encrypt } = require("./utils/crypto");
    const { collections } = require("./config/firebase");
    const logger = require("./utils/logger");

    // Exchange code for token
    const oauthResult = await handleSlackOAuth(code, process.env.SLACK_REDIRECT_URI);
    logger.info("Slack OAuth success:", { teamId: oauthResult.teamId, teamName: oauthResult.teamName });

    // Encrypt token before storing
    const encryptedToken = encrypt(oauthResult.botToken);

    // Fetch channels and users
    let channels = [];
    let users = [];
    try {
      channels = await fetchWorkspaceChannels(oauthResult.botToken);
    } catch (e) {
      logger.warn("Could not fetch Slack channels:", e.message);
    }
    try {
      users = await fetchWorkspaceUsers(oauthResult.botToken);
    } catch (e) {
      logger.warn("Could not fetch Slack users:", e.message);
    }

    // Store in Firestore: /projects/{projectKey}/integrations.slack
    await collections.projects.doc(projectKey).set({
      "integrations": {
        slack: {
          teamId: oauthResult.teamId,
          teamName: oauthResult.teamName,
          botToken: encryptedToken,
          connectedBy: req.session.userId,
          connectedAt: new Date(),
          channels: channels,
          users: users,
          confirmedChannels: [],
        },
      },
      updatedAt: new Date(),
    }, { merge: true });

    // Store projectKey in session for subsequent calls
    req.session.projectKey = projectKey;

    res.redirect("/dashboard?slack_connected=true");
  } catch (error) {
    const logger = require("./utils/logger");
    logger.error("Slack OAuth callback failed:", error);
    res.redirect("/dashboard?slack_error=" + encodeURIComponent(error.message));
  }
});

// Serve dashboard for authenticated users
app.get("/dashboard", (req, res) => {
  if (!req.session?.token || !req.session?.cloudId) {
    return res.redirect("/login");
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// BugSense — serve the unified issue dashboard
// Disable CSP for this route since it uses inline onclick handlers
const helmetNoCsp = helmet({ contentSecurityPolicy: false });
app.get("/bugsense", helmetNoCsp, (req, res) => {
  if (!req.session?.token || !req.session?.cloudId) {
    return res.redirect("/login");
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, "public", "bugsense.html"));
});

// Serve workflow builder for authenticated users (embedded in dashboard or standalone)
app.get("/workflow-builder", (req, res) => {
  if (!req.session?.token || !req.session?.cloudId) {
    return res.redirect("/login");
  }
  res.sendFile(path.join(__dirname, "public", "workflow-builder.html"));
});

// Serve "not registered" page for non-admin users whose project has no admin setup
app.get("/not-registered", (req, res) => {
  if (!req.session?.token) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "public", "not-registered.html"));
});

// Redirect root to dashboard or login based on auth state
app.get("/", (req, res) => {
  if (req.session?.token && req.session?.projectKey) {
    return res.redirect("/dashboard");
  }
  res.redirect("/login");
});

// ⚠️ CATCH-ALL ROUTE MUST BE LAST
app.get("*", (req, res) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/webhooks")) {
    logger.warn(`404 API: ${req.method} ${req.originalUrl}`);
    return res.status(404).json({ error: "API endpoint not found" });
  }
  // For unknown frontend routes, redirect to dashboard
  if (req.session?.token) {
    return res.redirect("/dashboard");
  }
  res.redirect("/login");
});

// === ERROR HANDLING ===

// 404 handler for unmatched routes (after all routes defined)
app.use((req, res) => {
  // Don't log 404s for favicon, robots.txt, etc.
  if (!["/favicon.ico", "/robots.txt"].includes(req.path)) {
    logger.warn(`404: ${req.method} ${req.originalUrl}`);
  }

  // API requests get JSON error, others get redirect to login
  if (
    req.path.startsWith("/api") ||
    req.headers["accept"]?.includes("application/json")
  ) {
    return res.status(404).json({ error: "Not found" });
  }

  // For browser requests, redirect to login if unauthenticated
  if (!req.session?.token) {
    return res.redirect("/login");
  }

  // Otherwise show generic 404 page
  res.status(404).send("Page not found");
});

// Global error handler (catches unhandled errors in routes)
app.use((err, req, res, next) => {
  // Log the error with context
  logger.error("Unhandled error:", {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.session?.userId,
    projectKey: req.session?.projectKey,
  });

  // Don't leak error details in production
  const isDev = process.env.NODE_ENV === "development";

  // Determine response format based on request type
  // /api/* /ai/* /bugsense/* are all API routes — must always return JSON
  const wantsJson =
    req.path.startsWith('/api') ||
    req.path.startsWith('/ai') ||
    req.path.startsWith('/bugsense') ||
    req.headers['accept']?.includes('application/json') ||
    req.headers['content-type']?.includes('application/json');

  if (wantsJson) {
    return res.status(err.status || 500).json({
      error: err.message || 'Internal server error',
      ...(isDev && { stack: err.stack, details: err }),
    });
  }

  // For browser requests, show error page or redirect
  if (err.status === 401 || err.status === 403) {
    return res.redirect("/login");
  }

  // Generic error page for development
  if (isDev) {
    return res.status(500).send(`
      <!DOCTYPE html>
      <html><head><title>Server Error</title>
      <script src="https://cdn.tailwindcss.com"></script></head>
      <body class="bg-red-50 min-h-screen flex items-center justify-center p-4">
        <div class="bg-white rounded-xl shadow p-8 max-w-lg">
          <div class="text-red-500 text-4xl mb-4">⚠️</div>
          <h1 class="text-xl font-bold text-gray-900 mb-2">Server Error</h1>
          <p class="text-gray-600 mb-4">${err.message}</p>
          <pre class="bg-gray-100 p-3 rounded text-xs overflow-auto max-h-48">${err.stack}</pre>
          <a href="/" class="inline-block mt-4 text-blue-600 hover:underline">← Back to Home</a>
        </div>
      </body></html>
    `);
  }

  // Production: generic error message
  res.status(500).send("Something went wrong. Please try again.");
});

// Graceful shutdown handling
process.on("SIGTERM", () => {
  logger.info("🛑 SIGTERM received, shutting down gracefully");
  // Add cleanup logic here if needed (close DB connections, etc.)
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("🛑 SIGINT received, shutting down gracefully");
  process.exit(0);
});

// Unhandled promise rejection handler
process.on("unhandledRejection", (reason, promise) => {
  logger.error("❌ Unhandled Promise Rejection:", { reason, promise });
  // Don't exit in production - let the app continue running
  if (process.env.NODE_ENV === "development") {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  }
});

module.exports = app;
