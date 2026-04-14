// config/slack.js
const { WebClient, LogLevel } = require("@slack/web-api");
const { encrypt, decrypt } = require("../utils/crypto");
const logger = require("../utils/logger");

// Create Slack client with bot token
const createSlackClient = (botToken) => {
  return new WebClient(botToken, {
    logLevel:
      process.env.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.INFO,
    retryConfig: {
      retries: 3,
      factor: 2,
    },
  });
};

// Get Slack OAuth URL for "Add to Workspace" button
const getSlackOAuthUrl = (redirectUri) => {
  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    scope: process.env.SLACK_SCOPES,
    redirect_uri: redirectUri,
    state: "project_setup", // Could add projectKey here for validation
  });
  return `https://slack.com/oauth/v2/authorize?${params}`;
};

// Handle Slack OAuth callback (exchange code for token)
const handleSlackOAuth = async (code, redirectUri) => {
  try {
    const client = new WebClient();
    const result = await client.oauth.v2.access({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    });

    if (!result.ok) {
      throw new Error(`Slack OAuth failed: ${result.error}`);
    }

    return {
      teamId: result.team.id,
      teamName: result.team.name,
      botToken: result.access_token, // ✅ Encrypt this before storing in Firestore
      botUserId: result.authed_user?.id,
      scopes: result.scope?.split(",") || [],
    };
  } catch (error) {
    logger.error("Slack OAuth failed:", error.message);
    throw error;
  }
};

// Fetch channels from workspace (with pagination)
const fetchWorkspaceChannels = async (botToken, types = "public_channel") => {
  try {
    const slack = createSlackClient(botToken);
    const channels = [];
    let cursor;

    do {
      const res = await slack.conversations.list({
        types,
        limit: 100,
        cursor,
      });
      channels.push(...res.channels);
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);

    // Return simplified channel list
    return channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      isPrivate: ch.is_private,
      isMember: ch.is_member,
    }));
  } catch (error) {
    logger.error("Failed to fetch Slack channels:", error.message);
    throw error;
  }
};

// Fetch users from workspace (non-bots, non-deleted)
const fetchWorkspaceUsers = async (botToken) => {
  try {
    const slack = createSlackClient(botToken);
    const users = [];
    let cursor;

    do {
      const res = await slack.users.list({
        limit: 100,
        cursor,
      });
      for (const member of res.members) {
        if (!member.deleted && !member.is_bot && member.id !== "USLACKBOT") {
          users.push({
            id: member.id,
            name: member.real_name || member.name,
            email: member.profile?.email || null,
          });
        }
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);

    return users;
  } catch (error) {
    logger.error("Failed to fetch Slack users:", error.message);
    throw error;
  }
};

// Send message to channel (with rich blocks)
const sendChannelMessage = async (botToken, channelId, issue, priority) => {
  try {
    const slack = createSlackClient(botToken);

    // Try to join channel first (bot must be member to post)
    try {
      await slack.conversations.join({ channel: channelId });
    } catch (e) {
      // May already be member or lack permission - continue anyway
      logger.debug(`Join channel ${channelId}: ${e.message}`);
    }

    const priorityEmoji =
      { high: "🔴", medium: "🟡", low: "🟢" }[priority] || "⚪";

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${priorityEmoji} ${priority.toUpperCase()} PRIORITY*\n*${issue.key}*: ${issue.summary}`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Type:*\n${issue.type}` },
          { type: "mrkdwn", text: `*Status:*\n${issue.status}` },
        ],
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `<${issue.url}|🔗 View in Jira>` }],
      },
    ];

    const result = await slack.chat.postMessage({
      channel: channelId,
      text: `🎫 ${issue.key}: ${issue.summary}`,
      blocks,
      unfurl_links: false,
    });

    return { success: true, ts: result.ts, channel: result.channel };
  } catch (error) {
    logger.error("Failed to send Slack channel message:", error.message);
    return { success: false, error: error.message };
  }
};

// Send DM to user by Slack ID
const sendDirectMessage = async (botToken, userId, issue, priority) => {
  try {
    const slack = createSlackClient(botToken);

    // Open DM conversation
    const {
      channel: { id: dmChannelId },
    } = await slack.conversations.open({
      users: userId,
    });

    const priorityEmoji =
      { high: "🔴", medium: "🟡", low: "🟢" }[priority] || "⚪";

    const result = await slack.chat.postMessage({
      channel: dmChannelId,
      text: `👋 *You've been assigned:*\n${priorityEmoji} *${issue.key}*: ${issue.summary}\n<${issue.url}|🔗 View in Jira>`,
      unfurl_links: false,
    });

    return { success: true, ts: result.ts };
  } catch (error) {
    logger.error("Failed to send Slack DM:", error.message);
    return { success: false, error: error.message };
  }
};

// Verify bot token works (auth.test)
const verifyBotToken = async (botToken) => {
  try {
    const slack = createSlackClient(botToken);
    const result = await slack.auth.test();
    return {
      valid: true,
      team: result.team,
      userId: result.user_id,
      botId: result.bot_id,
    };
  } catch (error) {
    logger.error("Bot token verification failed:", error.message);
    return { valid: false, error: error.message };
  }
};

module.exports = {
  createSlackClient,
  getSlackOAuthUrl,
  handleSlackOAuth,
  fetchWorkspaceChannels,
  fetchWorkspaceUsers,
  sendChannelMessage,
  sendDirectMessage,
  verifyBotToken,
};
