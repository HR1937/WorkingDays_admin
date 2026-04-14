const { generateText } = require('../../utils/openai');
const { collections, getProjectMembers } = require('../../config/firebase');
const logger = require('../../utils/logger');

// ── FUNCTION: Suggest best assignee using OpenAI + Firebase history ───────────
const suggestAssignee = async (issue, projectKey) => {
  try {
    // Load team members from Firebase
    const members = await getProjectMembers(projectKey);
    if (!members.length) return { suggestions: [], error: 'No team members found' };

    // Load issue history from Firebase to build expertise map
    const issueSnap = await collections.issues
      .where('projectKey', '==', projectKey)
      .orderBy('updatedAt', 'desc')
      .limit(100)
      .get().catch(() => ({ docs: [] }));

    const history = issueSnap.docs.map(d => d.data());

    // Build workload + expertise per member
    const stats = {};
    for (const m of members) {
      stats[m.displayName] = {
        accountId: m.jiraAccountId,
        displayName: m.displayName,
        openTasks: 0,
        totalAssigned: 0,
        taskTypes: {},
        recentTasks: [],
      };
    }
    for (const i of history) {
      const s = stats[i.assigneeName];
      if (!s) continue;
      s.totalAssigned++;
      if (i.status !== 'Done') s.openTasks++;
      s.taskTypes[i.type || 'Task'] = (s.taskTypes[i.type || 'Task'] || 0) + 1;
      if (s.recentTasks.length < 5) s.recentTasks.push(i.summary);
    }

    const teamSummary = Object.values(stats).map(m => {
      const exp = Object.entries(m.taskTypes).map(([t, c]) => `${t}(${c})`).join(', ') || 'none';
      return `- ${m.displayName}: ${m.openTasks} open, total: ${m.totalAssigned}, expertise: ${exp}`;
    }).join('\n');

    const prompt = `You are a smart project manager AI.

Task: ${issue.key || 'NEW'} | ${issue.summary}
Description: ${issue.description || 'N/A'}
Type: ${issue.type || 'Task'} | Priority: ${issue.priority || 'Medium'}

Team:
${teamSummary}

Pick the best person. Respond ONLY in raw JSON:
{"suggestedAssignee":"<name>","accountId":"<id>","confidence":"High|Medium|Low","reason":"2-3 sentences"}`;

    const text = await generateText(prompt, 0.2);
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('AI bad format');
    const suggestion = JSON.parse(json[0]);

    // Fill accountId from stats if AI missed it
    if (!suggestion.accountId && stats[suggestion.suggestedAssignee]) {
      suggestion.accountId = stats[suggestion.suggestedAssignee].accountId;
    }

    logger.info(`[AI] Assignee suggestion for ${issue.key}: ${suggestion.suggestedAssignee} (${suggestion.confidence})`);
    return suggestion;
  } catch (err) {
    logger.error('[AI] Assignee suggestion failed:', err.message);
    return { suggestions: [], error: err.message };
  }
};

module.exports = { suggestAssignee };
