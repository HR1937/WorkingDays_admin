const logger = require("../../utils/logger");

// Analyze bug and suggest solutions
const analyzeBug = async ({ issueKey, summary, description, codeContext }) => {
  try {
    // In production: call LLM API (OpenAI/Anthropic) with:
    // - Issue summary/description
    // - Relevant code snippets (from GitHub API)
    // - Project context (tech stack, common patterns)

    // Mock analysis for development
    const suggestions = generateMockSuggestions(summary, description);

    return {
      issueKey,
      suggestions,
      confidence: 0.82,
      reasoning: "Analysis based on keyword matching and historical patterns",
    };
  } catch (error) {
    logger.error("Bug analysis failed:", error);
    return {
      issueKey,
      suggestions: [],
      confidence: 0,
      error: error.message,
    };
  }
};

// Generate solution suggestion for notification
const suggestSolution = async (issue) => {
  const analysis = await analyzeBug({
    issueKey: issue.key,
    summary: issue.summary,
    description: issue.description,
  });

  return analysis.suggestions[0] || null;
};

// Mock suggestion generator (replace with real AI in production)
const generateMockSuggestions = (summary, description) => {
  const text = `${summary} ${description}`.toLowerCase();
  const suggestions = [];

  if (text.includes("login") || text.includes("auth")) {
    suggestions.push("Check session token validation and CORS headers");
    suggestions.push("Verify JWT expiration logic in auth middleware");
  }

  if (text.includes("database") || text.includes("query")) {
    suggestions.push("Add connection pooling and retry logic");
    suggestions.push("Check for N+1 query patterns in data fetching");
  }

  if (text.includes("api") || text.includes("endpoint")) {
    suggestions.push("Validate request schema with Joi/Zod before processing");
    suggestions.push("Add rate limiting to prevent abuse");
  }

  if (suggestions.length === 0) {
    suggestions.push("Review stack trace for root cause");
    suggestions.push("Check recent deployments for related changes");
  }

  return suggestions.slice(0, 2); // Return top 2
};

module.exports = { analyzeBug, suggestSolution };
