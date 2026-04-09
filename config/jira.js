const axios = require("axios");
const logger = require("../utils/logger");

const JIRA_AUTH = process.env.JIRA_AUTH_URL || "https://auth.atlassian.com";
const JIRA_API = process.env.JIRA_API_URL || "https://api.atlassian.com";

// Create authenticated Jira API client
const createJiraClient = (accessToken) => {
  return axios.create({
    baseURL: JIRA_API,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeout: 15000, // 15 second timeout
  });
};

// Get accessible resources (cloud IDs) for a user
const getAccessibleResources = async (accessToken) => {
  try {
    const response = await axios.get(
      `${JIRA_API}/oauth/token/accessible-resources`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    return response.data;
  } catch (error) {
    logger.error(
      "Failed to fetch Jira resources:",
      error.response?.data || error.message,
    );
    throw new Error("Failed to fetch Jira projects");
  }
};

// Get current user info
const getCurrentUser = async (jiraClient, cloudId) => {
  try {
    const response = await jiraClient.get(
      `/ex/jira/${cloudId}/rest/api/3/myself`,
    );
    return response.data;
  } catch (error) {
    logger.error(
      "Failed to fetch Jira user:",
      error.response?.data || error.message,
    );
    throw error;
  }
};

// Check project admin permission
const checkProjectAdmin = async (jiraClient, cloudId, projectKey) => {
  try {
    const response = await jiraClient.get(
      `/ex/jira/${cloudId}/rest/api/3/mypermissions`,
      {
        params: {
          permissions: "ADMINISTER_PROJECTS",
          projectKey,
        },
      },
    );
    return (
      response.data.permissions.ADMINISTER_PROJECTS?.havePermission || false
    );
  } catch (error) {
    logger.warn("Permission check failed:", error.message);
    return false;
  }
};

// Check assign issues permission
const checkAssignPermission = async (jiraClient, cloudId, issueKey) => {
  try {
    const response = await jiraClient.get(
      `/ex/jira/${cloudId}/rest/api/3/mypermissions`,
      {
        params: {
          permissions: "ASSIGN_ISSUES",
          issueKey,
        },
      },
    );
    return response.data.permissions.ASSIGN_ISSUES?.havePermission || false;
  } catch (error) {
    logger.warn("Assign permission check failed:", error.message);
    return false;
  }
};

// Get project issues (for testing/validation)
const getProjectIssues = async (
  jiraClient,
  cloudId,
  projectKey,
  maxResults = 10,
) => {
  try {
    const response = await jiraClient.get(
      `/ex/jira/${cloudId}/rest/api/3/search`,
      {
        params: {
          jql: `project = "${projectKey}" ORDER BY created DESC`,
          maxResults,
          fields: "key,summary,status,priority,assignee,reporter,created",
        },
      },
    );
    return response.data.issues;
  } catch (error) {
    logger.error("Failed to fetch project issues:", error.message);
    return [];
  }
};

// Map Jira webhook events to our internal event names
const JIRA_EVENT_MAP = {
  "jira:issue_created": "issue_created",
  "jira:issue_assigned": "issue_assigned",
  "jira:issue_updated": "issue_updated", // covers transitions, comments, edits
  "jira:issue_commented": "issue_commented",
  "jira:issue_deleted": "issue_deleted",
};

// Extract priority from Jira issue (normalize to our format)
const extractPriority = (jiraIssue) => {
  const priority = jiraIssue.fields?.priority?.name?.toLowerCase() || "medium";

  if (
    priority.includes("high") ||
    priority.includes("urgent") ||
    priority.includes("critical")
  ) {
    return "high";
  }
  if (priority.includes("low") || priority.includes("minor")) {
    return "low";
  }
  return "medium";
};

// Extract assignee email (may be null if unassigned)
const extractAssigneeEmail = (jiraIssue) => {
  return jiraIssue.fields?.assignee?.emailAddress || null;
};

// Extract assignee Slack ID from user properties (if configured)
const extractAssigneeSlackId = async (jiraClient, cloudId, accountId) => {
  try {
    // This requires Jira user properties to be set up with Slack ID
    // Fallback: return null and let frontend handle Slack lookup
    const response = await jiraClient.get(
      `/ex/jira/${cloudId}/rest/api/3/user`,
      {
        params: { accountId },
      },
    );
    // Assuming Slack ID is stored in a custom user property
    return response.data.properties?.slack_user_id || null;
  } catch {
    return null;
  }
};

module.exports = {
  JIRA_AUTH,
  JIRA_API,
  createJiraClient,
  getAccessibleResources,
  getCurrentUser,
  checkProjectAdmin,
  checkAssignPermission,
  getProjectIssues,
  JIRA_EVENT_MAP,
  extractPriority,
  extractAssigneeEmail,
  extractAssigneeSlackId,
};
