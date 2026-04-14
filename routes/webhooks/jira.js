const express = require("express");
const {
  createWebhookAuth,
  verifyJiraWebhook,
} = require("../../middleware/webhookAuth");
const { findWorkflowsByTrigger } = require("../../config/firebase");
const {
  JIRA_EVENT_MAP,
  extractPriority,
  extractAssigneeEmail,
} = require("../../config/jira");
const { executeWorkflow } = require("../../services/workflowEngine");
const { runWorkflowForEvent } = require("../../services/workflowExecutor");
const logger = require("../../utils/logger");

const router = express.Router();

// Apply webhook signature verification
router.post(
  "/jira",
  createWebhookAuth(verifyJiraWebhook),
  express.json(),
  async (req, res) => {
    // Jira requires immediate acknowledgment (<3 seconds)
    // So we acknowledge first, then process async
    res.status(200).send("Event received");

    try {
      const webhookEvent = req.body.webhookEvent;
      const issue = req.body.issue;
      const cloudId = req.headers["x-atlassian-cloud-id"];

      if (!webhookEvent || !issue) {
        logger.warn("Invalid webhook payload");
        return;
      }

      // Map Jira event to our internal format
      const ourEvent = JIRA_EVENT_MAP[webhookEvent];
      if (!ourEvent) {
        logger.debug(`Event not monitored: ${webhookEvent}`);
        return;
      }

      // Extract normalized data
      const context = {
        issue: {
          key: issue.key,
          summary: issue.fields?.summary,
          description: issue.fields?.description,
          priority: extractPriority(issue),
          type: issue.fields?.issuetype?.name,
          status: issue.fields?.status?.name,
          assignee: issue.fields?.assignee,
          reporter: issue.fields?.reporter,
          url: `${issue.self?.replace("/rest/api/3/issue/", "/browse/")}`,
          projectKey: issue.fields?.project?.key,
        },
        event: ourEvent,
        cloudId,
        raw: req.body, // Keep full payload for debugging
      };

      // Find matching active workflows
      const workflows = await findWorkflowsByTrigger(
        context.issue.projectKey,
        ourEvent,
      );

      if (!workflows.length) {
        logger.debug(
          `No workflows found for ${ourEvent} in project ${context.issue.projectKey}`,
        );
        return;
      }

      // Execute using new workflow executor (feature-gated)
      const executionPromises = workflows.map((workflow) =>
        runWorkflowForEvent(context.issue.projectKey, ourEvent, context.issue)
          .then((result) => {
            logger.info(`Workflow executed: ${result.workflowName || workflow.id}`);
            return result;
          })
          .catch((error) => {
            logger.error(`Workflow ${workflow.id} failed:`, error.message);
            return { status: "failed", error: error.message };
          }),
      );

      // Don't await - let them run in background
      Promise.allSettled(executionPromises);
    } catch (error) {
      logger.error("Webhook processing error:", error);
      // Already sent 200 response, so just log
    }
  },
);

// Test endpoint for manual webhook testing (dev only)
if (process.env.NODE_ENV === "development") {
  router.post("/jira/test", express.json(), async (req, res) => {
    // Bypass auth for testing
    const { event, issue, projectKey } = req.body;

    const context = {
      issue,
      event,
      cloudId: "test-cloud",
      raw: req.body,
    };

    const workflows = await findWorkflowsByTrigger(projectKey, event);

    if (!workflows.length) {
      return res.json({ matched: 0, message: "No matching workflows" });
    }

    const results = await Promise.all(
      workflows.map((w) => executeWorkflow(w, context)),
    );

    res.json({ matched: workflows.length, results });
  });
}

module.exports = router;
