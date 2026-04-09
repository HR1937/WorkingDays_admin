const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

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
          "cdn.tailwindcss.com",
          "cdn.jsdelivr.net",
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: [
          "'self'",
          "https://api.atlassian.com",
          "https://auth.atlassian.com",
          "https://cdn.jsdelivr.net",
        ],
      },
    },
  }),
);

// Rate limiting for API routes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// === SESSION CONFIG ===
app.use(
  session({
    secret:
      process.env.SESSION_SECRET || "dev_secret_fallback_change_in_production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  }),
);

// === BODY PARSING ===
// Raw body for webhook signature verification
app.use("/webhooks", express.raw({ type: "application/json", limit: "10mb" }));
// JSON parsing for other routes
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// === STATIC FILES ===
app.use(express.static(path.join(__dirname, "public")));

// === ROUTES ===
// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Auth routes (OAuth flow)
app.use("/", require("./routes/auth"));

// API routes (protected)
app.use("/api", apiLimiter, require("./routes/workflows"));
app.use("/api/features", apiLimiter, require("./routes/features/ai-analysis"));
app.use("/api/features", apiLimiter, require("./routes/features/reports"));

// Webhook routes (no rate limit - Jira/GitHub need reliability)
app.use("/webhooks", require("./routes/webhooks/jira"));
app.use("/webhooks", require("./routes/webhooks/github"));
app.use("/api/admin", require("./routes/admin"));
// Serve frontend workflow builder for authenticated admin users
app.get("/workflow-builder", (req, res) => {
  if (!req.session?.token || !req.session?.isAdmin) {
    return res.redirect("/login");
  }
  res.sendFile(path.join(__dirname, "public", "workflow-builder.html"));
});

// Catch-all for SPA routing (if you expand frontend later)
app.get("*", (req, res) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/webhooks")) {
    return res.status(404).json({ error: "API endpoint not found" });
  }
  res.sendFile(path.join(__dirname, "public", "workflow-builder.html"));
});

// === ERROR HANDLING ===
// 404 handler
app.use((req, res) => {
  logger.warn(`404 - ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err);

  // Don't leak error details in production
  const isDev = process.env.NODE_ENV === "development";

  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    ...(isDev && { stack: err.stack, details: err }),
  });
});

module.exports = app;
