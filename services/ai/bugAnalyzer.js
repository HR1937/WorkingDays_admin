const { generateText } = require('../../utils/openai');
const logger = require('../../utils/logger');

// ── FUNCTION: Analyze bug and suggest solutions using OpenAI ──────────────────
const analyzeBug = async ({ issueKey, summary, description, codeContext, projectKey }) => {
  try {
    const prompt = `You are an expert software engineer.

Issue: ${issueKey}
Summary: ${summary}
Description: ${description || 'No description'}
${codeContext ? `Code Context:\n${codeContext}` : ''}

Analyze this bug and provide actionable solutions. Respond ONLY in raw JSON:
{
  "suggestions": ["solution 1", "solution 2"],
  "confidence": 0.85,
  "reasoning": "brief explanation",
  "rootCause": "likely root cause"
}`;

    const text = await generateText(prompt, 0.3);
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('AI bad format');
    const analysis = JSON.parse(json[0]);

    logger.info(`[AI] Bug analysis for ${issueKey}: ${analysis.suggestions?.length} suggestions`);
    return { issueKey, ...analysis };
  } catch (err) {
    logger.error('[AI] Bug analysis failed:', err.message);
    return { issueKey, suggestions: [], confidence: 0, error: err.message };
  }
};

// ── FUNCTION: Quick solution suggestion for notifications ────────────────────
const suggestSolution = async (issue) => {
  const analysis = await analyzeBug({
    issueKey: issue.key,
    summary: issue.summary,
    description: issue.description,
  });
  return analysis.suggestions?.[0] || null;
};

module.exports = { analyzeBug, suggestSolution };
