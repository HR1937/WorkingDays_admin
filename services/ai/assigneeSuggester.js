const logger = require("../../utils/logger");

// Suggest best assignee based on historical data
const suggestAssignee = async ({ issue, teamMembers, projectHistory }) => {
  try {
    // This is a simplified mock - in production, integrate with ML model

    // Factors to consider:
    // 1. Past success with similar issues (by component/label)
    // 2. Current workload (active assignments)
    // 3. Availability (vacation status, timezone)
    // 4. Expertise match (skills matrix)

    // Mock scoring algorithm
    const scored = teamMembers.map((member) => {
      const history = projectHistory[member.id] || {};

      // Similar issues solved
      const similarSolved = history.similarIssues?.[issue.type] || 0;

      // Current workload (lower = better)
      const workloadScore = 10 - (history.activeAssignments || 0);

      // Response time (lower = better)
      const avgResponseTime = history.avgResolutionHours || 24;
      const responseScore = Math.max(0, 10 - avgResponseTime / 4);

      // Calculate weighted score
      const score =
        similarSolved * 0.4 + workloadScore * 0.3 + responseScore * 0.3;

      return {
        member,
        score: Math.round(score * 100) / 100,
        reasons: generateReasons(member, history, issue),
      };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return {
      suggestions: scored.slice(0, 3),
      confidence:
        scored[0]?.score > 0.7
          ? "high"
          : scored[0]?.score > 0.4
            ? "medium"
            : "low",
    };
  } catch (error) {
    logger.error("Assignee suggestion failed:", error);
    return { suggestions: [], error: error.message };
  }
};

// Generate human-readable reasons for suggestion
const generateReasons = (member, history, issue) => {
  const reasons = [];

  if (history.similarIssues?.[issue.type] > 2) {
    reasons.push(
      `Solved ${history.similarIssues[issue.type]} similar ${issue.type.toLowerCase()} issues`,
    );
  }

  if ((history.activeAssignments || 0) < 3) {
    reasons.push("Currently has light workload");
  }

  if (history.expertise?.includes(issue.component)) {
    reasons.push(`Expert in ${issue.component}`);
  }

  if (history.avgResolutionHours < 8) {
    reasons.push("Fast resolver (avg <8 hours)");
  }

  return reasons.length ? reasons : ["Good general fit for this task"];
};

module.exports = { suggestAssignee, generateReasons };
