const { WebClient } = require("@slack/web-api");
const logger = require("../utils/logger");

// Create Slack client
const createSlackClient = (botToken) => {
  return new WebClient(botToken, {
    logger: {
      debug: (msg) => logger.debug(`[Slack] ${msg}`),
      info: (msg) => logger.info(`[Slack] ${msg}`),
      warn: (msg) => logger.warn(`[Slack] ${msg}`),
      error: (msg) => logger.error(`[Slack] ${msg}`),
    },
    retryConfig: {
      retries: 3,
      factor: 2,
    },
  });
};

// Send message to a channel by ID or link
const sendChannelMessage = async (slack, channel, text, blocks = null) => {
  try {
    // Extract channel ID from URL if needed: https://xxx.slack.com/archives/C123456 -> C123456
    const channelId = channel.match(/archives\/([A-Z0-9]+)/)?.[1] || channel;

    const result = await slack.chat.postMessage({
      channel: channelId,
      text,
      blocks: blocks || undefined,
      unfurl_links: false,
      unfurl_media: false,
    });

    return { success: true, ts: result.ts, channel: result.channel };
  } catch (error) {
    logger.error("Failed to send Slack message:", error.data || error.message);
    return { success: false, error: error.data?.error || error.message };
  }
};

// Send DM to a user by Slack ID
const sendDirectMessage = async (slack, userId, text, blocks = null) => {
  try {
    // Open DM conversation
    const {
      channel: { id: dmChannelId },
    } = await slack.conversations.open({
      users: userId,
    });

    const result = await slack.chat.postMessage({
      channel: dmChannelId,
      text,
      blocks: blocks || undefined,
    });

    return { success: true, ts: result.ts };
  } catch (error) {
    logger.error("Failed to send Slack DM:", error.data || error.message);
    return { success: false, error: error.data?.error || error.message };
  }
};

// Format message with issue details
const formatIssueMessage = (event, issue, config = {}) => {
  const { issueKey, summary, priority, assignee, reporter, url } = issue;

  const priorityEmoji =
    {
      high: "🔴",
      medium: "🟡",
      low: "🟢",
    }[priority] || "⚪";

  const eventText =
    {
      issue_created: "🆕 New issue created",
      issue_assigned: "👤 Issue assigned",
      issue_updated: "✏️ Issue updated",
      issue_commented: "💬 New comment",
      issue_deleted: "🗑️ Issue deleted",
    }[event] || "📋 Issue event";

  let text = `${priorityEmoji} *${eventText}*\n*${issueKey}*: ${summary}`;

  if (assignee) {
    text += `\n👤 Assignee: ${assignee.displayName || assignee.name}`;
  }
  if (reporter) {
    text += `\n📝 Reporter: ${reporter.displayName || reporter.name}`;
  }
  if (url) {
    text += `\n🔗 <${url}|View in Jira>`;
  }

  return text;
};

// Create rich blocks for Slack message (optional enhancement)
const createIssueBlocks = (issue) => {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `🎫 ${issue.issueKey}`, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Summary:*\n${issue.summary}` },
        {
          type: "mrkdwn",
          text: `*Priority:*\n${issue.priority?.toUpperCase() || "Medium"}`,
        },
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${issue.url}|View in Jira>` }],
    },
  ];
};

module.exports = {
  createSlackClient,
  sendChannelMessage,
  sendDirectMessage,
  formatIssueMessage,
  createIssueBlocks,
};
