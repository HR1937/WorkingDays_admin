const crypto = require("crypto");
const logger = require("../utils/logger");

// Verify Jira webhook signature
const verifyJiraWebhook = (req, res, buf) => {
  const signature = req.headers["x-atlassian-webhook-signature"];
  const secret = process.env.JIRA_WEBHOOK_SECRET;

  if (!signature || !secret) {
    logger.warn("Webhook signature verification skipped (missing config)");
    return; // Allow in dev, block in prod via env check
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(buf)
    .digest("base64");

  if (signature !== expected) {
    logger.error("Invalid Jira webhook signature");
    throw new Error("Invalid webhook signature");
  }
};

// Verify GitHub webhook signature
const verifyGitHubWebhook = (req, res, buf) => {
  const signature = req.headers["x-hub-signature-256"];
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!signature || !secret) {
    logger.warn("GitHub webhook verification skipped (missing config)");
    return;
  }

  const [algorithm, hash] = signature.split("=");
  const expected = crypto
    .createHmac(algorithm, secret)
    .update(buf)
    .digest("hex");

  if (hash !== expected) {
    logger.error("Invalid GitHub webhook signature");
    throw new Error("Invalid webhook signature");
  }
};

// Generic webhook auth middleware factory
const createWebhookAuth = (verifier) => {
  return (req, res, next) => {
    try {
      // Body must be raw (set in app.js for /webhooks routes)
      verifier(req, res, req.body);
      next();
    } catch (error) {
      res.status(401).json({ error: "Unauthorized webhook" });
    }
  };
};

module.exports = {
  verifyJiraWebhook,
  verifyGitHubWebhook,
  createWebhookAuth,
};
