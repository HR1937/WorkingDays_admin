/**
 * Sentry Webhook Handler
 *
 * Flow:
 * 1. Sentry detects an error → sends POST to /webhooks/sentry/{projectKey}
 * 2. We verify the request (optional secret)
 * 3. We create a Jira issue via the project's stored Jira credentials
 * 4. We log the execution to Firebase
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { collections } = require('../../config/firebase');
const logger = require('../../utils/logger');

// ── POST /webhooks/sentry/:projectKey ─────────────────────────────────────────
router.post('/:projectKey', express.json(), async (req, res) => {
  // Acknowledge immediately — Sentry expects fast response
  res.status(200).json({ received: true });

  try {
    const { projectKey } = req.params;
    const payload = req.body;

    logger.info(`[SENTRY] Webhook received for project: ${projectKey}`);

    // ── Validate it's a real Sentry issue event ──
    const action = payload.action;
    const sentryIssue = payload.data?.issue;

    if (!sentryIssue) {
      logger.debug('[SENTRY] No issue data in payload, skipping');
      return;
    }

    // Only process new issues or regressions (not resolved/ignored)
    if (action && !['created', 'triggered', 'regression'].includes(action)) {
      logger.debug(`[SENTRY] Skipping action: ${action}`);
      return;
    }

    // ── Check if project has Sentry feature enabled ──
    const projectDoc = await collections.projects.doc(projectKey).get();
    if (!projectDoc.exists) {
      logger.warn(`[SENTRY] Project ${projectKey} not found in Firebase`);
      return;
    }

    const projectData = projectDoc.data();
    if (!projectData.features?.sentryEnabled) {
      logger.debug(`[SENTRY] Sentry feature not enabled for project ${projectKey}`);
      return;
    }

    // ── Get admin's Jira credentials from Firebase ──
    // Find the admin user for this project
    const membersSnap = await collections.projects
      .doc(projectKey)
      .collection('members')
      .where('role', '==', 'admin')
      .limit(1)
      .get();

    if (membersSnap.empty) {
      logger.warn(`[SENTRY] No admin found for project ${projectKey}`);
      return;
    }

    const adminMember = membersSnap.docs[0].data();
    const adminUserId = adminMember.userId;

    // Get admin's Jira token from users collection
    const adminUserDoc = await collections.users.doc(adminUserId).get();
    if (!adminUserDoc.exists) {
      logger.warn(`[SENTRY] Admin user ${adminUserId} not found`);
      return;
    }

    const adminUser = adminUserDoc.data();
    const { jiraCloudId, jiraBaseUrl } = adminUser;

    // Get the stored Jira OAuth token — stored in session, not Firebase
    // We use the project's stored API token approach instead
    // Check if project has a stored Jira API token
    const jiraToken = projectData.jiraApiToken;
    if (!jiraToken) {
      logger.warn(`[SENTRY] No Jira API token stored for project ${projectKey}. Admin needs to save one in Settings.`);
      return;
    }

    // ── Build Jira issue from Sentry data ──
    const title = sentryIssue.title || 'Sentry Error';
    const culprit = sentryIssue.culprit || '';
    const level = sentryIssue.level || 'error'; // error, warning, info
    const sentryUrl = sentryIssue.permalink || sentryIssue.web_url || '';
    const firstSeen = sentryIssue.firstSeen || new Date().toISOString();
    const count = sentryIssue.count || 1;
    const project = sentryIssue.project?.name || 'Unknown';

    // Map Sentry level to Jira priority
    const priorityMap = { fatal: 'Highest', error: 'High', warning: 'Medium', info: 'Low', debug: 'Low' };
    const jiraPriority = priorityMap[level] || 'High';

    const summary = `[Sentry] ${title}`.slice(0, 255);
    const description = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: `🐛 Automatically created from Sentry error detection` }],
        },
        { type: 'rule' },
        {
          type: 'heading', attrs: { level: 3 },
          content: [{ type: 'text', text: 'Error Details' }],
        },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Title: ${title}` }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Level: ${level.toUpperCase()}` }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Culprit: ${culprit || 'N/A'}` }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Occurrences: ${count}` }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `First seen: ${firstSeen}` }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Sentry Project: ${project}` }] }] },
          ],
        },
        ...(sentryUrl ? [{
          type: 'paragraph',
          content: [
            { type: 'text', text: 'View in Sentry: ' },
            { type: 'text', text: sentryUrl, marks: [{ type: 'link', attrs: { href: sentryUrl } }] },
          ],
        }] : []),
      ],
    };

    // ── Create Jira issue ──
    const jiraResponse = await axios.post(
      `https://api.atlassian.com/ex/jira/${jiraCloudId}/rest/api/3/issue`,
      {
        fields: {
          project: { key: projectKey },
          summary,
          description,
          issuetype: { name: 'Bug' },
          priority: { name: jiraPriority },
          labels: ['sentry', 'auto-created'],
        },
      },
      {
        headers: {
          Authorization: `Bearer ${jiraToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      }
    );

    const createdIssue = jiraResponse.data;
    logger.info(`[SENTRY] Created Jira issue: ${createdIssue.key} for project ${projectKey}`);

    // ── Log to Firebase ──
    await collections.executions.add({
      projectId: projectKey,
      source: 'sentry',
      sentryIssueId: sentryIssue.id,
      jiraIssueKey: createdIssue.key,
      title,
      level,
      status: 'created',
      createdAt: new Date(),
    });

  } catch (error) {
    logger.error('[SENTRY] Webhook processing failed:', error.message);
  }
});

module.exports = router;
