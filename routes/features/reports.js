const express = require('express');
const router = express.Router();
const { generateText } = require('../../utils/openai');
const { collections } = require('../../config/firebase');
const { requireAuth, requireProjectAdmin } = require('../../middleware/auth');
const logger = require('../../utils/logger');
const axios = require('axios');

// OpenAI generate — drop-in replacement for Gemini's generateContent
async function generate(prompt) {
  return generateText(prompt, 0.4);
}


// ── Fetch Jira issues for date range ─────────────────────────────────────────
async function fetchJiraIssues(token, cloudId, projectKey, from, to) {
  try {
    const jql = `project = "${projectKey}" AND created >= "${from}" AND created <= "${to}" ORDER BY created DESC`;
    const r = await axios.get(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        params: { jql, maxResults: 200, fields: 'summary,status,assignee,issuetype,priority,created,resolutiondate,description' },
      }
    );
    return r.data.issues || [];
  } catch (e) {
    logger.warn('[REPORT] Jira fetch failed:', e.message);
    return [];
  }
}

// ── POST /api/features/reports/generate ──────────────────────────────────────
router.post('/generate', requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const { token, cloudId, projectKey } = req.session;
    const { reportType, from, to, editNotes } = req.body;

    // ── Validation ──
    if (!reportType) return res.status(400).json({ error: 'reportType is required' });
    if (!from || !to) return res.status(400).json({ error: 'from and to dates are required' });

    const fromDate = new Date(from);
    const toDate = new Date(to);
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    if (isNaN(fromDate.getTime())) return res.status(400).json({ error: 'Invalid from date' });
    if (isNaN(toDate.getTime())) return res.status(400).json({ error: 'Invalid to date' });
    if (toDate > today) return res.status(400).json({ error: 'End date cannot be in the future' });
    if (fromDate > toDate) return res.status(400).json({ error: 'Start date must be before end date' });

    const diffDays = (toDate - fromDate) / (1000 * 60 * 60 * 24);
    if (diffDays > 365) return res.status(400).json({ error: 'Date range cannot exceed 1 year' });

    const validTypes = ['team-performance', 'sprint-summary', 'bug-analysis'];
    if (!validTypes.includes(reportType)) return res.status(400).json({ error: `Invalid report type. Must be one of: ${validTypes.join(', ')}` });

    // ── Fetch data ──
    const issues = await fetchJiraIssues(token, cloudId, projectKey, from, to);

    // ── Firebase executions ──
    let executions = [];
    try {
      const snap = await collections.executions
        .where('projectId', '==', projectKey)
        .where('startedAt', '>=', fromDate)
        .where('startedAt', '<=', toDate)
        .get();
      executions = snap.docs.map(d => d.data());
    } catch (e) { logger.warn('[REPORT] Executions fetch failed:', e.message); }

    // ── Firebase issues history ──
    let issueHistory = [];
    try {
      const snap = await collections.issues
        .where('projectKey', '==', projectKey)
        .get();
      issueHistory = snap.docs.map(d => d.data());
    } catch (e) { logger.warn('[REPORT] Issue history fetch failed:', e.message); }

    // ── Build data summary for Gemini ──
    const totalIssues = issues.length;
    const byStatus = {};
    const byPriority = {};
    const byType = {};
    const byAssignee = {};
    let resolved = 0;

    issues.forEach(i => {
      const status = i.fields?.status?.name || 'Unknown';
      const priority = i.fields?.priority?.name || 'Unknown';
      const type = i.fields?.issuetype?.name || 'Unknown';
      const assignee = i.fields?.assignee?.displayName || 'Unassigned';

      byStatus[status] = (byStatus[status] || 0) + 1;
      byPriority[priority] = (byPriority[priority] || 0) + 1;
      byType[type] = (byType[type] || 0) + 1;
      byAssignee[assignee] = (byAssignee[assignee] || 0) + 1;
      if (i.fields?.resolutiondate) resolved++;
    });

    const resolutionRate = totalIssues > 0 ? Math.round((resolved / totalIssues) * 100) : 0;

    const dataSummary = {
      projectKey,
      period: { from, to, days: Math.round(diffDays) },
      totalIssues,
      resolved,
      resolutionRate: `${resolutionRate}%`,
      byStatus,
      byPriority,
      byType,
      byAssignee,
      workflowExecutions: executions.length,
      historicalIssues: issueHistory.length,
    };

    // ── Build Gemini prompt per report type ──
    const reportTypeLabels = {
      'team-performance': 'Team Performance Report',
      'sprint-summary': 'Sprint Summary Report',
      'bug-analysis': 'Bug Analysis Report',
    };

    const typeSpecificInstructions = {
      'team-performance': `Focus on: individual team member workload, assignment distribution, who is overloaded vs underutilized, productivity trends, recommendations for better task distribution.`,
      'sprint-summary': `Focus on: overall sprint health, completion rate, velocity, blockers, what went well, what needs improvement, key achievements, risks for next sprint.`,
      'bug-analysis': `Focus on: bug frequency by priority/type, resolution time trends, recurring patterns, most affected areas, root cause analysis, prevention recommendations.`,
    };

    const prompt = `You are a professional project manager generating a formal ${reportTypeLabels[reportType]} for project "${projectKey}".

## Data Summary (${from} to ${to}):
${JSON.stringify(dataSummary, null, 2)}

## Report Type Instructions:
${typeSpecificInstructions[reportType]}

${editNotes ? `## Additional Notes from Admin:\n${editNotes}\n` : ''}

Generate a comprehensive, professional report in HTML format. Requirements:
- Use professional language suitable for stakeholders
- Include an executive summary at the top
- Use tables for data presentation where appropriate
- Include specific numbers and percentages from the data
- Provide actionable recommendations
- Use proper HTML with inline styles (no external CSS)
- Color scheme: white background, #1e40af for headings, #374151 for body text
- Make it print-friendly
- Include a footer with generation date and project name

Return ONLY the HTML content (starting with <div), no markdown, no code blocks.`;

    const reportHtml = await generate(prompt);

    // ── Save to Firebase ──
    const reportDoc = {
      projectId: projectKey,
      reportType,
      period: { from, to },
      generatedAt: new Date(),
      generatedBy: req.session.user?.displayName || 'Admin',
      dataSummary,
      editNotes: editNotes || null,
    };

    let reportId = null;
    try {
      const ref = await collections.reports.add(reportDoc);
      reportId = ref.id;
    } catch (e) { logger.warn('[REPORT] Save to Firebase failed:', e.message); }

    res.json({
      success: true,
      reportId,
      reportType,
      period: { from, to },
      dataSummary,
      html: reportHtml,
    });

  } catch (e) {
    logger.error('[REPORT] Generation failed:', e.message);
    res.status(500).json({ error: e.message || 'Report generation failed' });
  }
});

// ── GET /api/features/reports/history ────────────────────────────────────────
router.get('/history', requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const { projectKey } = req.session;
    const snap = await collections.reports
      .where('projectId', '==', projectKey)
      .orderBy('generatedAt', 'desc')
      .limit(20)
      .get();
    const reports = snap.docs.map(d => ({ id: d.id, ...d.data(), html: undefined }));
    res.json({ success: true, reports });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
