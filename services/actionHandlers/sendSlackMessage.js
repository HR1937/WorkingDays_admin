const {
  createSlackClient,
  formatIssueMessage,
  sendChannelMessage,
  sendDirectMessage,
} = require("../../config/slack");
const { suggestSolution } = require("../ai/bugAnalyzer");
const logger = require("../../utils/logger");

// Send Slack notification based on config
const sendSlackMessage = async ({
  recipient,
  channelLink,
  issue,
  event,
  priority,
  includeAISuggestion = false,
}) => {
  try {
    const slack = createSlackClient(process.env.SLACK_BOT_TOKEN);

    // Format base message
    let text = formatIssueMessage(event, issue);

    // Add AI suggestion if requested and applicable
    if (includeAISuggestion && event === "issue_assigned") {
      const suggestion = await suggestSolution(issue);
      if (suggestion) {
        text += `\n\n💡 *AI Suggestion*:\n${suggestion}`;
      }
    }

    // Add priority indicator
    if (priority === "high") {
      text = `🚨 *HIGH PRIORITY*\n${text}`;
    }

    // Send to appropriate recipient
    let result;
    if (recipient === "assignee_dm" && issue.assignee?.slackId) {
      result = await sendDirectMessage(slack, issue.assignee.slackId, text);
    } else if (channelLink) {
      result = await sendChannelMessage(slack, channelLink, text);
    } else {
      return "⚠️ No valid Slack recipient configured";
    }

    if (result.success) {
      return `✓ msg sent to ${recipient === "assignee_dm" ? "assignee DM" : `channel: ${channelLink?.split("/").pop() || "channel"}`}`;
    } else {
      return `✗ failed to send Slack: ${result.error}`;
    }
  } catch (error) {
    logger.error("Slack notification failed:", error);
    return `✗ Slack error: ${error.message}`;
  }
};

module.exports = { sendSlackMessage };
