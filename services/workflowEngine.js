const { collections } = require("../config/firebase");
const { sendSlackMessage } = require("./actionHandlers/sendSlackMessage");
const { createGitHubBranch } = require("./actionHandlers/createGitHubBranch");
const { sendEmail } = require("./actionHandlers/sendEmail");
const { sendSMS } = require("./actionHandlers/sendSMS");
const logger = require("../utils/logger");

// Execute a workflow DAG for a given context
const executeWorkflow = async (workflow, context) => {
  const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Create execution record
  const executionRef = collections.executions.doc(executionId);
  await executionRef.set({
    workflowId: workflow.id,
    projectId: workflow.projectId,
    triggeredBy: {
      issueKey: context.issue.key,
      event: context.event,
      timestamp: new Date(),
    },
    status: "running",
    startedAt: new Date(),
    steps: [],
  });

  try {
    const results = [];

    // Stage 1: Send notifications (parallel where possible)
    if (workflow.notifications?.[context.event]) {
      const notifResults = await executeNotifications(
        workflow.notifications[context.event],
        context,
        workflow,
      );
      results.push(...notifResults);
    }

    // Stage 2: Assignment enhancements (only for issue_assigned)
    if (context.event === "issue_assigned" && workflow.enhancements) {
      if (workflow.enhancements.autoBranch?.enabled && context.issue.assignee) {
        const branchResult = await createGitHubBranch({
          repoUrl: workflow.enhancements.autoBranch.repoUrl,
          issueKey: context.issue.key,
          assigneeGithubUsername: context.issue.assignee.name, // Would need GitHub username mapping
        });
        results.push({ action: "create_branch", result: branchResult });
      }

      // AI suggestions would be sent in the notification, not as separate action
    }

    // Update execution record
    await executionRef.update({
      status: "completed",
      completedAt: new Date(),
      steps: results,
      output: results.map((r) => r.result).filter(Boolean),
    });

    return {
      executionId,
      status: "completed",
      results,
    };
  } catch (error) {
    logger.error(`Workflow ${workflow.id} execution failed:`, error);

    await executionRef.update({
      status: "failed",
      failedAt: new Date(),
      error: error.message,
    });

    throw error;
  }
};

// Execute notification actions based on config
const executeNotifications = async (config, context, workflow) => {
  const results = [];
  const { issue, event } = context;
  const priority = issue.priority;

  // Handle issue_assigned special logic
  if (event === "issue_assigned" && config.useDefaultPriority !== undefined) {
    // Slack: always send if enabled
    if (config.slack?.enabled) {
      const slackResult = await sendSlackMessage({
        recipient: "assignee_dm", // or channelLink
        issue,
        event,
        priority,
        includeAISuggestion: workflow.enhancements?.aiSuggestions,
      });
      results.push({ action: "slack_notify", result: slackResult });
    }

    // Email: check priority config
    if (
      config.email?.enabled &&
      shouldSendForPriority(priority, config.email.priorities)
    ) {
      const emailResult = await sendEmail({
        to: issue.assignee?.emailAddress,
        issue,
        event,
        priority,
      });
      results.push({ action: "email_notify", result: emailResult });
    }

    // SMS: check priority config
    if (
      config.sms?.enabled &&
      shouldSendForPriority(priority, config.sms.priorities)
    ) {
      const smsResult = await sendSMS({
        to: issue.assignee?.phoneNumber, // Would need to fetch from user profile
        issue,
        event,
        priority,
      });
      results.push({ action: "sms_notify", result: smsResult });
    }
  }
  // Handle other events (simple channel notification)
  else if (config.channelLink) {
    const channelResult = await sendSlackMessage({
      recipient: "channel",
      channelLink: config.channelLink,
      issue,
      event,
      priority,
    });
    results.push({ action: "channel_notify", result: channelResult });
  }

  return results;
};

// Check if notification should be sent for given priority
const shouldSendForPriority = (priority, priorities) => {
  if (!priorities) return false;
  return priorities[priority] === true;
};

module.exports = {
  executeWorkflow,
  executeNotifications,
  shouldSendForPriority,
};
