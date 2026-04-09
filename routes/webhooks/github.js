const express = require("express");
const {
  createWebhookAuth,
  verifyGitHubWebhook,
} = require("../../middleware/webhookAuth");
const { collections } = require("../../config/firebase");
const logger = require("../../utils/logger");

const router = express.Router();

// Handle GitHub webhooks (PR merged, branch created, etc.)
router.post(
  "/github",
  createWebhookAuth(verifyGitHubWebhook),
  express.json(),
  async (req, res) => {
    // Acknowledge immediately
    res.status(200).send("Event received");

    try {
      const eventType = req.headers["x-github-event"];
      const payload = req.body;

      logger.debug(`GitHub webhook: ${eventType}`);

      // Handle PR merged event -> update Jira status
      if (
        eventType === "pull_request" &&
        payload.action === "closed" &&
        payload.pull_request?.merged
      ) {
        await handlePullRequestMerged(payload);
      }

      // Handle "work done" reply detection (if using email/SMS replies)
      // This would integrate with your "work done" parsing logic
    } catch (error) {
      logger.error("GitHub webhook error:", error);
    }
  },
);

// Handle PR merged: update Jira issue status to "Done" if workflow configured
async function handlePullRequestMerged(payload) {
  const { repository, pull_request } = payload;
  const branchName = pull_request.head.ref;

  // Extract Jira issue key from branch name (e.g., "feature/PROJ-123-fix-login")
  const issueKeyMatch = branchName.match(/([A-Z]+-\d+)/i);
  if (!issueKeyMatch) {
    logger.debug(`No Jira key in branch: ${branchName}`);
    return;
  }

  const issueKey = issueKeyMatch[1].toUpperCase();

  // Find workflows that have auto-branch enabled for this project
  // This is simplified - in prod, you'd query by repo URL + project mapping
  const workflows = await collections.workflows
    .where("enhancements.autoBranch.enabled", "==", true)
    .where("isActive", "==", true)
    .get();

  for (const doc of workflows.docs) {
    const workflow = doc.data();

    // Check if this workflow's repo matches
    if (
      workflow.enhancements.autoBranch.repoUrl?.includes(repository.full_name)
    ) {
      // Update Jira issue status (would need Jira client with proper auth)
      logger.info(
        `PR merged for ${issueKey} - would update Jira status (workflow: ${doc.id})`,
      );

      // In production: call Jira API to transition issue to "Done"
      // This requires storing Jira transition IDs per project
    }
  }
}

module.exports = router;
