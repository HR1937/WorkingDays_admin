/**
 * workflowExecutor.js
 *
 * The central brain. Given a Jira event + issue context:
 * 1. Loads the project's active workflow from Firebase
 * 2. Checks which features are enabled in that workflow
 * 3. Calls ONLY the enabled feature functions in the correct sequence
 *
 * Every feature is a function. Nothing runs unless the workflow says so.
 */

const { collections, getProjectMember, getMemberContact } = require('../config/firebase');
const { decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

// ── Feature function imports ──────────────────────────────────────────────────
const { sendSlackMessage }    = require('./actionHandlers/sendSlackMessage');
const { sendSMS }             = require('./actionHandlers/sendSMS');
const { sendEmail }           = require('./actionHandlers/sendEmail');
const { createGitHubBranch }  = require('./actionHandlers/createGitHubBranch');
const { suggestAssignee }     = require('./ai/assigneeSuggester');
const { analyzeBug }          = require('./ai/bugAnalyzer');

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY: run all workflow-gated features for an event
// ─────────────────────────────────────────────────────────────────────────────
const runWorkflowForEvent = async (projectKey, event, issue) => {
  const results = [];

  // 1. Load active workflow for this project + event
  const workflow = await getActiveWorkflow(projectKey, event);
  if (!workflow) {
    logger.debug(`[WORKFLOW] No active workflow for ${event} in ${projectKey}`);
    return { skipped: true, reason: 'No matching workflow' };
  }

  logger.info(`[WORKFLOW] Running "${workflow.name}" for ${event} on ${issue.key}`);

  const notifConfig = workflow.notifications?.[event] || {};
  const enhancements = workflow.enhancements || {};
  const priority = (issue.priority || 'medium').toLowerCase();

  // 2. Load assignee contact info from project member doc
  let assigneeContact = null;
  if (issue.assignee?.accountId) {
    const raw = await getProjectMember(projectKey, issue.assignee.accountId);
    if (raw) {
      assigneeContact = {
        slackMemberId: raw.slackMemberId || raw.slackUserId || null,
        phoneNumber: raw.phoneNumber ? (() => { try { return decrypt(raw.phoneNumber); } catch { return raw.phoneNumber; } })() : null,
        email: raw.email || issue.assignee?.emailAddress || null,
        githubAccountId: raw.githubAccountId || raw.contact?.githubUsername || null,
        githubAccessToken: raw.githubAccessToken ? (() => { try { return decrypt(raw.githubAccessToken); } catch { return raw.githubAccessToken; } })() : null,
        displayName: raw.displayName || null,
      };
    }
  }

  const context = { issue, event, priority, assigneeContact, workflow };

  // ── FEATURE: AI Assignee Suggestion ──────────────────────────────────────
  if (enhancements.aiSuggestions && event === 'issue_created') {
    results.push(await runFeature('ai_assignee_suggestion', () =>
      suggestAssignee(issue, projectKey)
    ));
  }

  // ── FEATURE: AI Bug Analysis / Solution ──────────────────────────────────
  let aiSolution = null;
  if (enhancements.aiSolutions) {
    const bugResult = await runFeature('ai_bug_analysis', () =>
      analyzeBug({ issueKey: issue.key, summary: issue.summary, description: issue.description, projectKey })
    );
    results.push(bugResult);
    aiSolution = bugResult.output?.suggestions?.join('\n') || null;
  }

  // ── FEATURE: Notifications (gated by priority + workflow config) ──────────
  if (notifConfig.enabled !== false) {

    // SMS — only if enabled AND priority matches
    if (notifConfig.sms?.enabled && notifConfig.sms?.priorities?.[priority]) {
      const phone = assigneeContact?.phoneNumber;
      results.push(await runFeature('sms_notification', () =>
        sendSMS({ to: phone, issue, event, priority })
      ));
    }

    // Slack — only if enabled
    if (notifConfig.slack?.enabled) {
      const slackMemberId = assigneeContact?.slackMemberId;
      const channelId = notifConfig.slack?.channelId;
      // Fetch project bot token for Slack
      let botToken = null;
      try {
        const pDoc = await collections.projects.doc(projectKey).get();
        const encrypted = pDoc.data()?.integrations?.slack?.botToken;
        if (encrypted) botToken = decrypt(encrypted);
      } catch {}
      results.push(await runFeature('slack_notification', () =>
        sendSlackMessage({
          recipient: slackMemberId ? 'assignee_dm' : 'channel',
          channelLink: channelId,
          botToken,
          issue: { ...issue, assignee: { ...issue.assignee, slackId: slackMemberId } },
          event,
          priority,
          includeAISuggestion: !!aiSolution,
          aiSolution,
        })
      ));
    }

    // Email — only if enabled AND priority matches
    if (notifConfig.email?.enabled && notifConfig.email?.priorities?.[priority]) {
      const email = assigneeContact?.email || issue.assignee?.emailAddress;
      results.push(await runFeature('email_notification', () =>
        sendEmail({ to: email, issue, event, priority })
      ));
    }
  }

  // ── FEATURE: Auto GitHub Branch ───────────────────────────────────────────
  if (enhancements.autoBranch?.enabled && enhancements.autoBranch?.repoUrl && event === 'issue_assigned') {
    const githubAccountId = assigneeContact?.githubAccountId;
    const githubAccessToken = assigneeContact?.githubAccessToken || process.env.GITHUB_TOKEN;
    results.push(await runFeature('github_branch', () =>
      createGitHubBranch({
        repoUrl: enhancements.autoBranch.repoUrl,
        issueKey: issue.key,
        assigneeGithubUsername: githubAccountId || 'unknown',
        accessToken: githubAccessToken,
      })
    ));
  }

  logger.info(`[WORKFLOW] Completed "${workflow.name}": ${results.length} features ran`);
  return { workflowId: workflow.id, workflowName: workflow.name, results };
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Wrap a feature call with logging + error isolation
// ─────────────────────────────────────────────────────────────────────────────
const runFeature = async (featureName, fn) => {
  try {
    logger.info(`[FEATURE] Running: ${featureName}`);
    const output = await fn();
    logger.info(`[FEATURE] Done: ${featureName} → ${JSON.stringify(output).slice(0, 100)}`);
    return { feature: featureName, status: 'ok', output };
  } catch (err) {
    logger.error(`[FEATURE] Failed: ${featureName} → ${err.message}`);
    return { feature: featureName, status: 'error', error: err.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Load the active workflow for a project + event from Firebase
// ─────────────────────────────────────────────────────────────────────────────
const getActiveWorkflow = async (projectKey, event) => {
  try {
    const snapshot = await collections.workflows
      .where('projectId', '==', projectKey)
      .where('trigger.events', 'array-contains', event)
      .where('isActive', '==', true)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() };
  } catch (err) {
    logger.error('[WORKFLOW] Failed to load workflow:', err.message);
    return null;
  }
};

module.exports = { runWorkflowForEvent };
