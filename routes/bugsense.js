/**
 * bugsense.js
 * All BugSense (unified-dashboard) API routes mounted at /bugsense/api
 * Reads workflow config from Firebase to gate features.
 */
const express = require('express');
const router = express.Router();
const axios = require('axios');
const nodemailer = require('nodemailer');
const { generateText } = require('../utils/openai');
const { collections, getProjectMembers, getProjectMember } = require('../config/firebase');
const { decrypt } = require('../utils/crypto');
const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

// OpenAI generate — drop-in replacement for Gemini's generateContent
async function generate(prompt) {
  return generateText(prompt, 0.3);
}


// ── Jira client helper ────────────────────────────────────────────────────────
const jiraClient = (token, cloudId) => axios.create({
  baseURL: `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`,
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
});

// ── Workflow config loader ────────────────────────────────────────────────────
const getWorkflowConfig = async (projectKey) => {
  try {
    const projectDoc = await collections.projects.doc(projectKey).get();
    const features = projectDoc.exists ? (projectDoc.data()?.features || {}) : {};
    const githubRepoUrl = projectDoc.exists ? projectDoc.data()?.integrations?.github?.repoUrl : null;

    const snap = await collections.workflows
      .where('projectId', '==', projectKey)
      .where('isActive', '==', true)
      .get();

    const cfg = {
      aiAssignee: features.aiAssigneeSuggestions === true,
      aiSolution: false,
      notifySlack: false,
      notifySms: false,
      notifyEmail: false,
      githubBranch: false,
      githubRepoUrl: githubRepoUrl || null,
      workflows: [],
      // Per-priority channel map: what channels fire for each priority level
      // Built from all active workflows' notifications.issue_assigned config
      priorityChannels: { High: [], Medium: [], Low: [] },
    };

    if (!snap.empty) {
      snap.docs.forEach(doc => {
        const wf = doc.data();
        cfg.workflows.push({ id: doc.id, name: wf.name });
        const enh = wf.enhancements || {};
        if (enh.aiSolutions) cfg.aiSolution = true;
        if (enh.autoBranch?.enabled) cfg.githubBranch = true;

        // Build per-priority channel map from issue_assigned notification config
        const assignedNotif = wf.notifications?.issue_assigned;
        if (assignedNotif?.enabled !== false) {
          const smsConf = assignedNotif?.sms;
          const slackConf = assignedNotif?.slack;
          const emailConf = assignedNotif?.email;

          if (smsConf?.enabled) {
            cfg.notifySms = true;
            const prios = smsConf.priorities || {};
            Object.entries(prios).forEach(([p, on]) => {
              if (on) {
                const key = p.charAt(0).toUpperCase() + p.slice(1);
                if (cfg.priorityChannels[key]) cfg.priorityChannels[key].push('sms');
              }
            });
          }
          if (slackConf?.enabled) {
            cfg.notifySlack = true;
            const prios = slackConf.priorities || {};
            // If no per-priority config, treat as all priorities
            const hasPrios = Object.keys(prios).length > 0;
            if (!hasPrios) {
              cfg.priorityChannels.High.push('slack');
              cfg.priorityChannels.Medium.push('slack');
              cfg.priorityChannels.Low.push('slack');
            } else {
              Object.entries(prios).forEach(([p, on]) => {
                if (on) {
                  const key = p.charAt(0).toUpperCase() + p.slice(1);
                  if (cfg.priorityChannels[key]) cfg.priorityChannels[key].push('slack');
                }
              });
            }
          }
          if (emailConf?.enabled) {
            cfg.notifyEmail = true;
            const prios = emailConf.priorities || {};
            Object.entries(prios).forEach(([p, on]) => {
              if (on) {
                const key = p.charAt(0).toUpperCase() + p.slice(1);
                if (cfg.priorityChannels[key]) cfg.priorityChannels[key].push('email');
              }
            });
          }
        }

        // Also scan other events for legacy channelId-based slack
        Object.values(wf.notifications || {}).forEach(n => {
          if (!n.enabled) return;
          if (n.channelId) cfg.notifySlack = true;
        });
      });
    }

    return cfg;
  } catch (e) { logger.error('[WF CONFIG]', e.message); return null; }
};

// ── GET /bugsense/api/users ───────────────────────────────────────────────────
router.get('/users', requireAuth, async (req, res, next) => {
  try {
    const { token, cloudId } = req.session;
    if (!token || !cloudId) return res.status(401).json({ error: 'Session expired', redirect: '/login' });
    const r = await jiraClient(token, cloudId).get('/users/search', { params: { maxResults: 100 } });
    const users = (r.data || []).filter(u => u.accountType === 'atlassian' && u.active);
    res.json(users);
  } catch (e) {
    if (e.response?.status === 401 || e.response?.status === 403) return res.status(401).json({ error: 'Jira token expired', redirect: '/login' });
    next(e);
  }
});

// ── GET /bugsense/api/users/assignable — only users who can be assigned in this project ──
router.get('/users/assignable', requireAuth, async (req, res, next) => {
  try {
    const { token, cloudId } = req.session;
    const project = req.query.project || req.session.projectKey;
    if (!token || !cloudId) return res.status(401).json({ error: 'Session expired', redirect: '/login' });
    // Use Jira's assignable users endpoint — restricted to project
    const r = await jiraClient(token, cloudId).get('/user/assignable/search', {
      params: { project, maxResults: 100 },
    });
    const users = (r.data || []).filter(u => u.accountType === 'atlassian' && u.active !== false);
    res.json(users);
  } catch (e) {
    if (e.response?.status === 401 || e.response?.status === 403) return res.status(401).json({ error: 'Jira token expired', redirect: '/login' });
    next(e);
  }
});

// ── GET /bugsense/api/projects/assignable — projects where user can assign ───
router.get('/projects/assignable', requireAuth, async (req, res, next) => {
  try {
    const { token, cloudId } = req.session;
    if (!token || !cloudId) return res.status(401).json({ error: 'Session expired', redirect: '/login' });
    // Get all projects
    const r = await jiraClient(token, cloudId).get('/project', { params: { maxResults: 50 } });
    const projects = r.data || [];
    // Check ASSIGN_ISSUES permission for each project
    const assignable = [];
    for (const p of projects) {
      try {
        const perm = await jiraClient(token, cloudId).get('/mypermissions', {
          params: { permissions: 'ASSIGN_ISSUES', projectKey: p.key },
        });
        if (perm.data?.permissions?.ASSIGN_ISSUES?.havePermission) {
          assignable.push(p);
        }
      } catch { /* skip */ }
    }
    res.json(assignable);
  } catch (e) {
    next(e);
  }
});
// ── GET /bugsense/api/member/contact/:accountId — fetch contact info for a project member ──
router.get('/member/contact/:accountId', requireAuth, async (req, res) => {
  try {
    const { projectKey } = req.session;
    const { accountId } = req.params;
    if (!projectKey || !accountId) return res.status(400).json({ error: 'Missing project or accountId' });

    const member = await getProjectMember(projectKey, accountId);
    if (!member) return res.json({ found: false, contact: null });

    const contact = {
      slackMemberId: member.slackMemberId || member.slackUserId || null,
      phoneNumber: member.phoneNumber ? (() => { try { return decrypt(member.phoneNumber); } catch { return member.phoneNumber; } })() : null,
      email: member.email || null,
      displayName: member.displayName || null,
    };
    res.json({ found: true, contact });
  } catch (e) {
    logger.error('[MEMBER CONTACT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /bugsense/api/workflow-config ─────────────────────────────────────────
router.get('/workflow-config', requireAuth, async (req, res) => {
  const projectKey = req.query.projectKey || req.session?.projectKey;
  const cfg = await getWorkflowConfig(projectKey);
  res.json(cfg || { aiAssignee: false, aiSolution: false, notifySlack: false, notifySms: false, notifyEmail: false, githubBranch: false, workflows: [] });
});

// ── GET /bugsense/api/issues ──────────────────────────────────────────────────
router.get('/issues', requireAuth, async (req, res, next) => {
  try {
    const { token, cloudId, projectKey } = req.session;
    const project = req.query.project || projectKey;
    const jql = project ? `project = "${project}" ORDER BY created DESC` : 'project is not EMPTY ORDER BY created DESC';
    const r = await jiraClient(token, cloudId).get('/search/jql', {
      params: { jql, maxResults: 50, fields: 'summary,status,assignee,issuetype,description,project,priority' },
    });
    res.json(r.data);
  } catch (e) { next(e); }
});

// ── POST /bugsense/api/issues ─────────────────────────────────────────────────
router.post('/issues', requireAuth, async (req, res, next) => {
  try {
    const { token, cloudId } = req.session;
    const { projectKey, summary, description, issueType = 'Task' } = req.body;
    if (!projectKey || !summary) return res.status(400).json({ error: 'projectKey and summary required' });
    const r = await jiraClient(token, cloudId).post('/issue', {
      fields: {
        project: { key: projectKey }, summary,
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description || '' }] }] },
        issuetype: { name: issueType },
      },
    });
    res.status(201).json(r.data);
  } catch (e) { next(e); }
});

// ── POST /bugsense/api/assign/execute ────────────────────────────────────────
router.post('/assign/execute', requireAuth, async (req, res, next) => {
  try {
    const { token, cloudId, projectKey } = req.session;
    const { issueId, accountId, assigneeName } = req.body;
    if (!issueId || !accountId) return res.status(400).json({ error: 'issueId and accountId required' });
    await jiraClient(token, cloudId).put(`/issue/${issueId}/assignee`, { accountId });
    res.json({ success: true, message: `Assigned ${issueId} to ${assigneeName}` });
  } catch (e) { next(e); }
});

// ── POST /bugsense/api/assign ─────────────────────────────────────────────────
router.post('/assign', requireAuth, async (req, res, next) => {
  try {
    const { token, cloudId } = req.session;
    const { issueId, accountId, assigneeName } = req.body;
    if (!issueId || !accountId) return res.status(400).json({ error: 'issueId and accountId required' });
    await jiraClient(token, cloudId).put(`/issue/${issueId}/assignee`, { accountId });
    res.json({ success: true, message: `Assigned ${issueId}` });
  } catch (e) { next(e); }
});

// ── Shared notify helper — writes to res ─────────────────────────────────────
async function notifyViaChannel(channel, opts, res) {
  const result = await notifyInternal(channel, opts);
  return res.json(result);
}

// ── Internal notify — returns plain object ────────────────────────────────────
async function notifyInternal(channel, { issue, assigneeName, toPhone, toEmail, slackChannel, aiSuggestion, baseUrl, projectKey }) {
  const key = issue?.key || 'TASK';
  const summary = issue?.fields?.summary || issue?.summary || '';
  const priority = issue?.fields?.priority?.name || issue?.priority || 'Medium';
  const type = issue?.fields?.issuetype?.name || 'Task';
  const status = issue?.fields?.status?.name || 'To Do';
  const jiraUrl = `${baseUrl || ''}/browse/${key}`;
  const hasSolution = !!aiSuggestion;

  // ── SMS ──────────────────────────────────────────────────────────────────────
  if (channel === 'sms') {
    const sid = process.env.TWILIO_ACCOUNT_SID, auth = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_PHONE_NUMBER;
    if (!sid || !auth || !from) return { ok: false, error: 'Twilio not configured — add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER to .env' };
    if (!toPhone) return { ok: false, error: 'No phone number on file for this assignee' };

    const phone = toPhone.trim().startsWith('+') ? toPhone.trim() : `+${toPhone.trim()}`;

    const body = [
      `📋 ISSUE: ${key}`,
      `${summary}`,
      `Priority: ${priority} | Type: ${type}`,
      `Assigned to: ${assigneeName}`,
      `Link: ${jiraUrl}`,
      hasSolution ? `\n💡 AI SOLUTION:\n${aiSuggestion.slice(0, 280)}` : '',
    ].filter(Boolean).join('\n');

    const r = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      new URLSearchParams({ From: from, To: phone, Body: body }),
      { auth: { username: sid, password: auth } }
    );
    return { ok: true, sid: r.data.sid };
  }

  // ── SLACK ─────────────────────────────────────────────────────────────────────
  if (channel === 'slack') {
    // ⚠️ KEY FIX: use the PROJECT's Slack OAuth bot token (stored encrypted in Firestore by admin).
    // Field: integrations.slack.botToken (encrypted). Falls back to env SLACK_BOT_TOKEN.
    let slackToken = null;
    try {
      if (projectKey) {
        const projDoc = await collections.projects.doc(projectKey).get();
        const encToken = projDoc.exists ? (projDoc.data()?.integrations?.slack?.botToken || null) : null;
        if (encToken) slackToken = decrypt(encToken);
      }
    } catch { /* fallback below */ }
    // Last resort: env token (only works if bot is in same workspace)
    if (!slackToken) slackToken = process.env.SLACK_BOT_TOKEN;
    if (!slackToken || slackToken.startsWith('xoxb-your')) return { ok: false, error: 'Slack not configured — connect Slack in Admin → Integrations first' };

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `📋 Issue: ${key}` } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Summary:*\n${summary}` },
          { type: 'mrkdwn', text: `*Assigned To:*\n${assigneeName}` },
          { type: 'mrkdwn', text: `*Priority:*\n${priority}` },
          { type: 'mrkdwn', text: `*Type:*\n${type}` },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `🔗 <${jiraUrl}|View in Jira>` }] },
    ];
    if (hasSolution) {
      blocks.push({ type: 'divider' });
      blocks.push({ type: 'header', text: { type: 'plain_text', text: '💡 AI Suggested Solution' } });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: aiSuggestion } });
    }

    const slackHeaders = { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' };
    const targetChannel = (slackChannel || '').trim();
    const fallbackText = `Issue ${key} assigned to ${assigneeName}`;

    if (!targetChannel) return { ok: false, error: 'No Slack ID or channel configured for this assignee' };

    const isUserId = /^U[A-Z0-9]{6,}$/i.test(targetChannel);
    if (isUserId) {
      // DM: open conversation first, then post
      const openRes = await axios.post(
        'https://slack.com/api/conversations.open',
        { users: targetChannel },
        { headers: slackHeaders }
      );
      if (!openRes.data?.ok) {
        // Fallback: look up by email
        if (toEmail) {
          try {
            const lookup = await axios.get(
              `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(toEmail)}`,
              { headers: slackHeaders }
            );
            if (lookup.data?.ok && lookup.data.user?.id) {
              const openRes2 = await axios.post(
                'https://slack.com/api/conversations.open',
                { users: lookup.data.user.id },
                { headers: slackHeaders }
              );
              if (openRes2.data?.ok) {
                const r2 = await axios.post(
                  'https://slack.com/api/chat.postMessage',
                  { channel: openRes2.data.channel.id, blocks, text: fallbackText },
                  { headers: slackHeaders }
                );
                if (r2.data?.ok) return { ok: true, ts: r2.data.ts, channel: r2.data.channel };
                return { ok: false, error: `chat.postMessage failed: ${r2.data?.error}` };
              }
            }
          } catch { /* ignore */ }
        }
        return { ok: false, error: `conversations.open failed: ${openRes.data?.error}. Make sure the bot is installed in the project's Slack workspace.` };
      }
      const r = await axios.post(
        'https://slack.com/api/chat.postMessage',
        { channel: openRes.data.channel.id, blocks, text: fallbackText },
        { headers: slackHeaders }
      );
      if (!r.data?.ok) return { ok: false, error: `chat.postMessage failed: ${r.data?.error}` };
      return { ok: true, ts: r.data.ts, channel: r.data.channel };
    }

    // Channel ID/name — post directly
    const r = await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel: targetChannel, blocks, text: fallbackText },
      { headers: slackHeaders }
    );
    if (!r.data?.ok) return { ok: false, error: r.data?.error || 'Slack API error' };
    return { ok: true, ts: r.data.ts, channel: r.data.channel };
  }

  // ── EMAIL ─────────────────────────────────────────────────────────────────────
  const user = process.env.SMTP_USER;
  if (!user || user.startsWith('your')) return { ok: false, error: 'Email not configured — add SMTP_USER to .env' };
  if (!toEmail) return { ok: false, error: 'No email on file for this assignee' };

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;background:#f9fafb;padding:24px;border-radius:10px">
      <div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;border:1px solid #e5e7eb">
        <h2 style="color:#1e40af;font-size:16px;margin:0 0 14px">📋 Issue Details</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:6px 0;font-weight:600;color:#374151;width:120px">Issue</td><td style="padding:6px 0;color:#111827">${key}</td></tr>
          <tr style="background:#f9fafb"><td style="padding:6px 0;font-weight:600;color:#374151">Summary</td><td style="padding:6px 0;color:#111827">${summary}</td></tr>
          <tr><td style="padding:6px 0;font-weight:600;color:#374151">Assigned To</td><td style="padding:6px 0;color:#111827">${assigneeName}</td></tr>
          <tr style="background:#f9fafb"><td style="padding:6px 0;font-weight:600;color:#374151">Priority</td><td style="padding:6px 0;color:#111827">${priority}</td></tr>
          <tr><td style="padding:6px 0;font-weight:600;color:#374151">Type</td><td style="padding:6px 0;color:#111827">${type}</td></tr>
          <tr style="background:#f9fafb"><td style="padding:6px 0;font-weight:600;color:#374151">Status</td><td style="padding:6px 0;color:#111827">${status}</td></tr>
        </table>
        <a href="${jiraUrl}" style="display:inline-block;margin-top:14px;padding:9px 18px;background:#1e40af;color:#fff;text-decoration:none;border-radius:6px;font-size:13px">View in Jira →</a>
      </div>
      ${hasSolution ? `
      <div style="background:#f0fdf4;border-radius:8px;padding:20px;border:1px solid #bbf7d0">
        <h2 style="color:#166534;font-size:16px;margin:0 0 12px">💡 AI Suggested Solution</h2>
        <div style="color:#166534;font-size:14px;line-height:1.7;white-space:pre-wrap">${aiSuggestion}</div>
      </div>` : ''}
    </div>`;

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: `[${key}] Task Assigned: ${summary.slice(0, 60)}`,
    html,
  });
  return { ok: true, messageId: info.messageId };
}


// ── POST /bugsense/api/ai/solution — AI solution using GitHub repo structure ──
router.post('/ai/solution', requireAuth, async (req, res, next) => {
  try {
    const { key, summary, description, type } = req.body;
    const projectKey = req.session.projectKey;

    // Get stored GitHub repo for this project
    let repoUrl = null;
    let repoStructure = '';
    try {
      const projectDoc = await collections.projects.doc(projectKey).get();
      repoUrl = projectDoc.data()?.integrations?.github?.repoUrl;
    } catch { /* ok */ }

    // If repo is configured, fetch its file structure
    if (repoUrl && process.env.GITHUB_TOKEN) {
      try {
        const { getRepoTree } = require('../services/githubHelper');
        const { files } = await getRepoTree(repoUrl);
        // Filter to source files only, limit to 80 for prompt size
        const srcFiles = files
          .filter(f => f.path.match(/\.(js|ts|py|java|go|rb|php|cs|cpp|c|jsx|tsx|vue)$/i))
          .slice(0, 80)
          .map(f => f.path);
        if (srcFiles.length) {
          repoStructure = `\n\nGitHub Repository: ${repoUrl}\nSource files:\n${srcFiles.join('\n')}`;
        }
      } catch (e) {
        logger.warn('[AI SOLUTION] Repo fetch failed:', e.message);
      }
    }

    const prompt = `You are an expert software engineer analyzing a Jira issue to provide a solution.

Issue: ${key}
Type: ${type || 'Task'}
Summary: ${summary}
Description: ${description || 'No description'}${repoStructure}

${repoStructure ? `Based on the repository structure above, identify which files are most likely related to this issue, then provide a specific solution.

Respond in this format:
**Likely Files:** [list the 2-3 most relevant files from the repo]
**Root Cause:** [what is likely causing this issue]
**Solution:** [specific, actionable fix in 3-4 sentences referencing the actual files]` : `Provide a specific, actionable solution in 3-4 sentences. Be technical and precise.`}`;

    const text = await generate(prompt);
    res.json({ solution: text, hasRepo: !!repoUrl });
  } catch (e) { next(e); }
});

// ── POST /bugsense/api/assign/suggest ────────────────────────────────────────
router.post('/assign/suggest', requireAuth, async (req, res, next) => {
  try {
    const { projectKey, token, cloudId } = req.session;
    const { summary, description, type, priority, key } = req.body;

    // 1. Fetch assignable users from Jira
    let jiraMembers = [];
    try {
      const r = await jiraClient(token, cloudId).get('/user/assignable/search', {
        params: { project: projectKey, maxResults: 50 },
      });
      jiraMembers = (r.data || []).filter(u => u.accountType === 'atlassian' && u.active !== false);
    } catch (e) { logger.warn('[AI SUGGEST] Jira users fetch failed:', e.message); }

    if (!jiraMembers.length) return res.status(400).json({ error: 'No assignable users found for this project' });

    // 2. Fetch Firebase project members for enriched contact/skills data
    const { getProjectMembers: getMembers } = require('../config/firebase');
    let fbMembers = [];
    try {
      fbMembers = await getMembers(projectKey);
    } catch (e) { logger.warn('[AI SUGGEST] Firebase members fetch failed:', e.message); }

    // Build a map: jiraAccountId → firebase member data
    const fbMap = {};
    fbMembers.forEach(m => { fbMap[m.id] = m; });

    // 3. Build workload stats — try Jira issues first, then Firebase issues collection
    let history = [];
    try {
      // Try fetching recent issues from Jira directly (most reliable)
      const jql = `project = "${projectKey}" AND assignee is not EMPTY ORDER BY updated DESC`;
      const r = await jiraClient(token, cloudId).get('/search/jql', {
        params: { jql, maxResults: 100, fields: 'summary,status,assignee,issuetype' },
      });
      history = (r.data?.issues || []).map(i => ({
        assigneeAccountId: i.fields?.assignee?.accountId,
        assigneeName: i.fields?.assignee?.displayName,
        status: i.fields?.status?.name,
        type: i.fields?.issuetype?.name,
        summary: i.fields?.summary,
      }));
    } catch (e) {
      // Fallback to Firebase issues collection
      try {
        const db = require('../config/firebase').db;
        const snap = await db.collection('issues').where('projectKey', '==', projectKey).limit(100).get();
        history = snap.docs.map(d => d.data());
      } catch { /* ok */ }
    }

    // 4. Build stats per member
    const stats = {};
    jiraMembers.forEach(m => {
      const fb = fbMap[m.accountId] || {};
      stats[m.accountId] = {
        accountId: m.accountId,
        displayName: m.displayName,
        email: m.emailAddress || fb.email || '',
        openTasks: 0,
        totalAssigned: 0,
        taskTypes: {},
        recentTasks: [],
        // Firebase-enriched fields
        skills: fb.skills || fb.contact?.skills || [],
        role: fb.role || '',
        slackUserId: fb.slackUserId || fb.contact?.slackUserId || '',
      };
    });

    history.forEach(i => {
      const accountId = i.assigneeAccountId;
      const s = accountId ? stats[accountId] : Object.values(stats).find(m => m.displayName === i.assigneeName);
      if (!s) return;
      s.totalAssigned++;
      if (i.status !== 'Done' && i.status !== 'Closed' && i.status !== 'Resolved') s.openTasks++;
      s.taskTypes[i.type || 'Task'] = (s.taskTypes[i.type || 'Task'] || 0) + 1;
      if (s.recentTasks.length < 5) s.recentTasks.push(i.summary);
    });

    const teamSummary = Object.values(stats).map(m => {
      const exp = Object.entries(m.taskTypes).map(([t, c]) => `${t}(${c})`).join(', ') || 'no history';
      const skills = m.skills?.length ? `, skills: ${m.skills.join(', ')}` : '';
      const role = m.role ? `, role: ${m.role}` : '';
      return `- ${m.displayName} [accountId: ${m.accountId}]: ${m.openTasks} open tasks, total: ${m.totalAssigned}, expertise: ${exp}${skills}${role}`;
    }).join('\n');

    const prompt = `You are a smart project manager AI. Suggest the best team member to assign this task.

Task: ${key || 'NEW'} | ${summary}
Description: ${description || 'N/A'}
Type: ${type || 'Task'} | Priority: ${priority || 'Medium'}

Team (use EXACT names and accountIds from this list):
${teamSummary}

Rules:
- Prefer members with fewer open tasks
- Prefer members with relevant expertise (matching task types or skills)
- Use the EXACT displayName and accountId from the list above

Respond ONLY in raw JSON (no markdown):
{"suggestedAssignee":"<exact displayName>","accountId":"<exact accountId>","confidence":"High|Medium|Low","reason":"2-3 specific sentences"}`;

    const text = await generate(prompt);
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('AI returned unexpected format');
    const suggestion = JSON.parse(json[0]);

    // Validate and fix accountId if AI hallucinated it
    const matched = jiraMembers.find(m => m.accountId === suggestion.accountId);
    if (!matched) {
      const byName = Object.values(stats).find(m => m.displayName === suggestion.suggestedAssignee);
      if (byName) suggestion.accountId = byName.accountId;
    }

    // Enrich suggestion with *assignee's* contact from Firestore (not the current user's)
    let assigneeContact = {};
    try {
      const memberDoc = await getProjectMember(projectKey, suggestion.accountId);
      if (memberDoc) {
        assigneeContact = {
          slackMemberId: memberDoc.slackMemberId || memberDoc.slackUserId || null,
          phoneNumber: memberDoc.phoneNumber ? (() => { try { return decrypt(memberDoc.phoneNumber); } catch { return memberDoc.phoneNumber; } })() : null,
          email: memberDoc.email || null,
        };
      }
    } catch (e) { logger.warn('[AI SUGGEST] Contact fetch failed:', e.message); }

    res.json({ ...suggestion, ...assigneeContact });
  } catch (e) { next(e); }
});

// ── POST /bugsense/api/notify (auto by priority) ─────────────────────────────
router.post('/notify', requireAuth, async (req, res, next) => {
  try {
    const { projectKey } = req.session;
    const cfg = await getWorkflowConfig(projectKey);
    const { channel, issue, assigneeName, toPhone, toEmail, slackChannel, aiSuggestion } = req.body;
    const priority = issue?.fields?.priority?.name || issue?.priority || 'Medium';
    const isH = priority === 'High' || priority === 'Highest' || priority === 'Critical';
    const isM = priority === 'Medium';
    const ch = channel || (isH ? 'sms' : isM ? 'slack' : 'email');
    return notifyViaChannel(ch, { issue, assigneeName, toPhone, toEmail, slackChannel, aiSuggestion, baseUrl: req.session.baseUrl, projectKey }, res);
  } catch (e) { next(e); }
});

// ── POST /bugsense/api/notify/sms ────────────────────────────────────────────
router.post('/notify/sms', requireAuth, async (req, res, next) => {
  try {
    const { projectKey } = req.session;
    const { toNumber, issue, assigneeName, aiSuggestion } = req.body;
    return notifyViaChannel('sms', { issue, assigneeName, toPhone: toNumber, aiSuggestion, baseUrl: req.session.baseUrl, projectKey }, res);
  } catch (e) { next(e); }
});

// ── POST /bugsense/api/notify/slack ──────────────────────────────────────────
router.post('/notify/slack', requireAuth, async (req, res, next) => {
  try {
    const { projectKey } = req.session;
    const { channel, issue, assigneeName, aiSuggestion, toEmail } = req.body;
    return notifyViaChannel('slack', { issue, assigneeName, slackChannel: channel, aiSuggestion, toEmail, baseUrl: req.session.baseUrl, projectKey }, res);
  } catch (e) { next(e); }
});

// ── POST /bugsense/api/notify/email ──────────────────────────────────────────
router.post('/notify/email', requireAuth, async (req, res, next) => {
  try {
    const { projectKey } = req.session;
    const { toEmail, issue, assigneeName, aiSuggestion } = req.body;
    return notifyViaChannel('email', { issue, assigneeName, toEmail, aiSuggestion, baseUrl: req.session.baseUrl, projectKey }, res);
  } catch (e) { next(e); }
});

// ── POST /bugsense/api/notify/all — fire ALL channels for this priority, WAITS for AI solution ──
router.post('/notify/all', requireAuth, async (req, res, next) => {
  try {
    const { projectKey } = req.session;
    const { issue, assigneeName, toPhone, toEmail, slackChannel, priority } = req.body;
    let { aiSuggestion } = req.body;
    const cfg = await getWorkflowConfig(projectKey);
    const p = priority || issue?.fields?.priority?.name || 'Medium';
    const pKey = p.charAt(0).toUpperCase() + p.slice(1);

    // Get channels for this priority from workflow config
    let channels = cfg?.priorityChannels?.[pKey] || [];
    if (!channels.length) {
      const isH = pKey === 'High' || pKey === 'Highest' || pKey === 'Critical';
      const isM = pKey === 'Medium';
      if (isH && cfg?.notifySms) channels = ['sms'];
      else if (isM && cfg?.notifySlack) channels = ['slack'];
      else if (cfg?.notifyEmail) channels = ['email'];
    }
    if (!channels.length) return res.json({ ok: true, results: [], message: 'No channels configured for this priority' });
    channels = [...new Set(channels)];

    // ⚠️ AI SOLUTION GATE: if aiSolutions is enabled and no solution provided yet — fetch it first
    if (cfg?.aiSolution && !aiSuggestion && issue?.key) {
      try {
        const issueFields = issue.fields || {};
        const sol = await (async () => {
          const { generateText: gen } = require('../utils/openai');
          const desc = typeof issueFields.description === 'string'
            ? issueFields.description
            : (issueFields.description?.content?.[0]?.content?.[0]?.text || '');
          const prompt = `You are an expert software engineer. Provide a concise actionable solution suggestion (max 3 bullet points) for this issue:

Issue: ${issue.key}
Summary: ${issueFields.summary || ''}
Description: ${desc.slice(0, 500)}
Type: ${issueFields.issuetype?.name || 'Task'}

Respond with ONLY the solution text, no preamble.`;
          return gen(prompt, 0.4);
        })();
        if (sol) aiSuggestion = sol;
      } catch (e) { logger.warn('[NOTIFY/AI] Solution fetch failed:', e.message); }
    }

    const results = [];
    for (const ch of channels) {
      try {
        const r = await notifyInternal(ch, { issue, assigneeName, toPhone, toEmail, slackChannel, aiSuggestion, baseUrl: req.session.baseUrl, projectKey });
        results.push({ channel: ch, ...r });
      } catch (e) {
        results.push({ channel: ch, ok: false, error: e.message });
      }
    }
    res.json({ ok: results.every(r => r.ok), results, aiSuggestion: aiSuggestion || null });
  } catch (e) { next(e); }
});

// ── GET /bugsense/api/github/identify ─────────────────────────────────────────
router.post('/github/identify', requireAuth, async (req, res, next) => {
  try {
    const { projectKey } = req.session;
    const cfg = await getWorkflowConfig(projectKey);
    if (!cfg?.githubBranch && !cfg?.aiSolution) return res.status(403).json({ error: 'GitHub/AI features not enabled in workflow' });

    const { repo, bugDescription } = req.body;
    // Reuse github-bug-hunter logic
    const { getRepoTree } = require('../services/githubHelper');
    const { files } = await getRepoTree(repo);

    const fileList = files.map(f => `- ${f.path} (${f.size}b)`).join('\n');
    const prompt = `Bug: ${bugDescription}\n\nFiles:\n${fileList}\n\nWhich files most likely contain this bug? Max 8 source files.\nRespond ONLY in raw JSON:\n{"suspectFiles":["path1","path2"],"reasoning":"brief explanation"}`;
    const text = await generate(prompt);
    
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('Gemini bad format');
    res.json({ ...JSON.parse(json[0]), repo: repo.replace(/.*github\.com\//, '').replace(/\.git$/, '') });
  } catch (e) { next(e); }
});

// ── POST /bugsense/api/github/analyze ────────────────────────────────────────
router.post('/github/analyze', requireAuth, async (req, res, next) => {
  try {
    const { repo, files, bugDescription } = req.body;
    if (!files?.length) return res.status(400).json({ error: 'files required' });
    const { getRepoTree } = require('../services/githubHelper');
    const gh = require('axios').create({
      baseURL: 'https://api.github.com',
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    const repoId = repo.replace(/.*github\.com\//, '').replace(/\.git$/, '');
    const results = [];
    for (const filePath of files) {
      try {
        const { data } = await gh.get(`/repos/${repoId}/contents/${encodeURIComponent(filePath)}`);
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const prompt = `You are an expert software engineer.\n\nBug: ${bugDescription}\nFile: ${filePath}\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\`\n\nFind if this file has the bug. Respond ONLY in raw JSON:\n{"bugFound":true/false,"bugLocation":"line/function","explanation":"what the bug is","fix":"what changed","fixedContent":"complete fixed file or null"}`;
        const text = await generate(prompt);
        
        const json = text.match(/\{[\s\S]*\}/);
        results.push({ path: filePath, ...(json ? JSON.parse(json[0]) : { bugFound: false, explanation: 'Could not analyze' }) });
      } catch (e) {
        results.push({ path: filePath, bugFound: false, explanation: `Error: ${e.message}` });
      }
    }
    res.json({ results, bugsFound: results.filter(r => r.bugFound).length });
  } catch (e) { next(e); }
});

// ── POST /bugsense/api/github/pull-request ────────────────────────────────────
router.post('/github/pull-request', requireAuth, async (req, res, next) => {
  try {
    const { repo, fixes, bugDescription } = req.body;
    if (!fixes?.length) return res.status(400).json({ error: 'fixes required' });
    const gh = require('axios').create({
      baseURL: 'https://api.github.com',
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    const repoId = repo.replace(/.*github\.com\//, '').replace(/\.git$/, '');
    const { data: repoData } = await gh.get(`/repos/${repoId}`);
    const baseBranch = repoData.default_branch;
    const { data: refData } = await gh.get(`/repos/${repoId}/git/refs/heads/${baseBranch}`);
    const baseSha = refData.object.sha;
    const { data: commitData } = await gh.get(`/repos/${repoId}/git/commits/${baseSha}`);
    const baseTreeSha = commitData.tree.sha;
    const treeItems = await Promise.all(fixes.map(async fix => {
      const { data: blob } = await gh.post(`/repos/${repoId}/git/blobs`, { content: fix.fixedContent, encoding: 'utf-8' });
      return { path: fix.path, mode: '100644', type: 'blob', sha: blob.sha };
    }));
    const { data: newTree } = await gh.post(`/repos/${repoId}/git/trees`, { base_tree: baseTreeSha, tree: treeItems });
    const { data: newCommit } = await gh.post(`/repos/${repoId}/git/commits`, { message: `fix: AI-detected bug fix\n\n${bugDescription}`, tree: newTree.sha, parents: [baseSha] });
    const newBranch = `ai-bugfix-${Date.now()}`;
    await gh.post(`/repos/${repoId}/git/refs`, { ref: `refs/heads/${newBranch}`, sha: newCommit.sha });
    const { data: pr } = await gh.post(`/repos/${repoId}/pulls`, { title: `[AI Bug Fix] ${bugDescription.slice(0, 72)}`, body: `## AI Bug Fix\n\n${bugDescription}\n\n**Files:** ${fixes.map(f => `\`${f.path}\``).join(', ')}`, head: newBranch, base: baseBranch });
    res.json({ prUrl: pr.html_url, prNumber: pr.number, branch: newBranch });
  } catch (e) { next(e); }
});


// ── POST /bugsense/api/issue/analyse ─────────────────────────────────────────
// AI classifies a natural-language description into a Jira issue spec.
// No Jira call yet — classifies description OR asks a follow-up if too vague.
// Receives existing issues as context so AI can detect duplicates and pre-fill.
router.post('/issue/analyse', requireAuth, async (req, res) => {
  try {
    const { description, existingIssues, selectedIssue } = req.body;
    if (!description?.trim()) return res.status(400).json({ error: 'description required' });

    const projectKey = req.session.projectKey;

    // Build issue context summary (max 30 issues to keep prompt tight)
    const issueList = (existingIssues || []).slice(0, 30);
    const issueContext = issueList.length
      ? issueList.map(i => {
          const f = i.fields || {};
          return `- ${i.key}: [${f.issuetype?.name||'Task'}][${f.status?.name||'?'}][${f.priority?.name||'?'}] ` +
                 `"${(f.summary||'').slice(0,80)}" — ${f.assignee?.displayName || 'Unassigned'}`;
        }).join('\n')
      : 'No existing issues loaded.';

    const selectedCtx = selectedIssue
      ? `## User clicked on this existing issue (may be reporting about it):
${selectedIssue.key}: [${(selectedIssue.fields?.issuetype?.name)||'Task'}][${selectedIssue.fields?.status?.name||'?'}] "${selectedIssue.fields?.summary||''}"
Description: ${(selectedIssue.fields?._description || selectedIssue.fields?.description || 'none').toString().slice(0, 300)}
Assignee: ${selectedIssue.fields?.assignee?.displayName || 'Unassigned'}
`
      : '';

    const prompt = `You are a Jira issue analyst. A user described a problem in natural language.

## Project: ${projectKey || 'UNKNOWN'}

## All existing issues in this project:
${issueContext}

${selectedCtx}
## What the user said:
"${description.trim()}"

---

Your FIRST job: decide if there is ENOUGH information to create a new Jira issue.

IMPORTANT CONTEXT RULES:
- You already have the issue list above. Use it:
  a) If the user references an existing issue (e.g. "this bug" while a specific issue is selected), use that issue's details to fill in the spec.
  b) If a similar open issue already exists, mention it and ask if they want to create a duplicate or add a comment instead.
  c) If no similar issue exists and the description is clear — create the spec.
- "Enough information" = mentions WHAT specifically is broken/needed, not just "there's a problem".
- If user is vague AND no selectedIssue provides context, ask for the missing detail.
- If selectedIssue is provided, you have enough context — use it.

## Two possible responses:

**NOT enough info (and no selectedIssue to fill the gap)**:
{"needsMoreInfo":true,"question":"One specific follow-up question (friendly, 1 sentence)"}

**Enough info**:
{"needsMoreInfo":false,"summary":"concise one-line summary","issueType":"Bug|Task|Story|Feature|Improvement|Epic","priority":"Highest|High|Medium|Low|Lowest","description":"detailed description","labels":["label"],"confidence":"High|Medium","reasoning":"why this type/priority","duplicateWarning":"KEY-X: explanation if similar issue found, else null"}

Bug: broken/error/crash. Story: user need. Feature/Improvement: new functionality. Task: generic.
Priority: critical/urgent=High, minor=Low, else Medium.

Respond with ONLY valid JSON, no markdown.`;

    const raw = await generate(prompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'Could not parse AI response', raw });
    const result = JSON.parse(jsonMatch[0]);

    if (result.needsMoreInfo) {
      return res.json({ success: true, needsMoreInfo: true, question: result.question });
    }
    res.json({ success: true, needsMoreInfo: false, spec: result });
  } catch (e) {
    logger.error('[ISSUE ANALYSE]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Shared helper: fetch real issue types allowed for a project ───────────────
async function fetchProjectIssueTypes(jira, projectKey) {
  // Try newer endpoint first (Jira Cloud v3)
  try {
    const { data } = await jira.get(`/issue/createmeta/${projectKey}/issuetypes`);
    if (data.issueTypes?.length) {
      return data.issueTypes.map(t => ({ id: t.id, name: t.name, subtask: !!t.subtask }));
    }
  } catch { /* fall through to legacy */ }

  // Legacy endpoint (still works on most instances)
  try {
    const { data } = await jira.get('/issue/createmeta', {
      params: { projectKeys: projectKey, expand: 'projects.issuetypes' },
    });
    const types = data.projects?.[0]?.issuetypes;
    if (types?.length) return types.map(t => ({ id: t.id, name: t.name, subtask: !!t.subtask }));
  } catch { /* fall through */ }

  return []; // couldn't fetch — caller will handle
}

// ── GET /bugsense/api/issue/types ─────────────────────────────────────────────
router.get('/issue/types', requireAuth, async (req, res) => {
  try {
    const { token, cloudId, projectKey } = req.session;
    if (!token || !cloudId || !projectKey) return res.json({ types: [] });
    const jira = jiraClient(token, cloudId);
    const types = await fetchProjectIssueTypes(jira, projectKey);
    res.json({ types });
  } catch (e) {
    logger.warn('[ISSUE TYPES]', e.message);
    res.json({ types: [] });
  }
});

// ── POST /bugsense/api/issue/create ──────────────────────────────────────────
// Creates a confirmed Jira issue using the user's OAuth token.
// Fetches allowed issue types live from Jira — no hardcoded IDs.
router.post('/issue/create', requireAuth, async (req, res) => {
  try {
    const { spec, savePermission } = req.body;
    const { token, cloudId, projectKey, userId, user } = req.session;

    if (!token || !cloudId) return res.status(401).json({ error: 'Not authenticated with Jira' });
    if (!projectKey)         return res.status(400).json({ error: 'No project key in session' });
    if (!spec?.summary)      return res.status(400).json({ error: 'Issue spec required' });

    const jira = jiraClient(token, cloudId);

    // ── Step 1: Fetch REAL allowed issue types for this project ──────────────
    const allowedTypes = await fetchProjectIssueTypes(jira, projectKey);
    logger.info(`[ISSUE CREATE] Allowed types for ${projectKey}: ${allowedTypes.map(t => t.name).join(', ')}`);

    // ── Step 2: Match AI-picked type to an allowed type (case-insensitive) ───
    // Strategy: exact match → partial match → "Task" fallback → first non-subtask
    const wantedName = (spec.issueType || 'Task').toLowerCase();

    const matchedType =
      allowedTypes.find(t => t.name.toLowerCase() === wantedName) ||               // exact
      allowedTypes.find(t => t.name.toLowerCase().includes(wantedName)) ||          // partial (e.g. "Bug" in "Bug Report")
      allowedTypes.find(t => t.name.toLowerCase().includes('task')) ||              // task fallback
      allowedTypes.find(t => !t.subtask) ||                                         // any non-subtask
      allowedTypes[0];                                                               // last resort

    if (!matchedType) {
      return res.status(400).json({ error: `No valid issue types found for project ${projectKey}. Check project configuration.` });
    }

    logger.info(`[ISSUE CREATE] Mapped "${spec.issueType}" → "${matchedType.name}" (id: ${matchedType.id})`);

    // ── Step 3: Validate priority ─────────────────────────────────────────────
    // Jira accepts: Highest, High, Medium, Low, Lowest (or project-specific names)
    const validPriorities = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
    const priority = validPriorities.includes(spec.priority) ? spec.priority : 'Medium';

    // ── Step 4: Build Atlassian Document Format description ───────────────────
    const adfDesc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: spec.description || spec.summary }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `Reported by: ${user?.displayName || 'Unknown'}`, marks: [{ type: 'em' }] },
          ],
        },
      ],
    };

    // ── Step 5: Create the issue ──────────────────────────────────────────────
    const payload = {
      fields: {
        project: { key: projectKey },
        summary: spec.summary,
        description: adfDesc,
        issuetype: { id: matchedType.id },    // always use fetched real ID
        priority: { name: priority },
        labels: (spec.labels || []).filter(l => /^[a-zA-Z0-9_-]+$/.test(l)),
      },
    };

    const { data } = await jira.post('/issue', payload);

    // ── Step 6: Save permission preference once ───────────────────────────────
    if (savePermission && userId) {
      await collections.users.doc(userId).set(
        {
          preferences: {
            canCreateIssues: true,
            issueCreationProjectKey: projectKey,
            issueCreationSavedAt: new Date().toISOString(),
          },
        },
        { merge: true }
      );
    }

    // Build Jira browse URL from the issue self link
    const jiraBaseUrl = data.self
      ? `https://${new URL(data.self).hostname}`
      : 'https://your-domain.atlassian.net';

    logger.info(`[ISSUE CREATE] ✅ ${data.key} (${matchedType.name}) created by ${user?.displayName}`);
    res.json({
      success: true,
      issueKey: data.key,
      issueType: matchedType.name,
      issueUrl: `${jiraBaseUrl}/browse/${data.key}`,
    });

  } catch (e) {
    logger.error('[ISSUE CREATE]', e.message, e.response?.data);
    const jiraErrors = e.response?.data?.errors;
    const jiraMsg = jiraErrors
      ? Object.entries(jiraErrors).map(([k, v]) => `${k}: ${v}`).join(' | ')
      : null;
    res.status(500).json({ error: jiraMsg || e.message });
  }
});


// ── GET /bugsense/api/issue/permission ───────────────────────────────────────
// Returns whether this user has already given permission to create issues.
router.get('/issue/permission', requireAuth, async (req, res) => {
  try {
    const { userId } = req.session;
    if (!userId) return res.json({ saved: false });
    const doc = await collections.users.doc(userId).get();
    const prefs = doc.exists ? (doc.data().preferences || {}) : {};
    res.json({ saved: !!prefs.canCreateIssues, projectKey: prefs.issueCreationProjectKey });
  } catch (e) {
    res.json({ saved: false });
  }
});

module.exports = router;

