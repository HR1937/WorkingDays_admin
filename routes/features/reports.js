const express = require("express");
const { collections } = require("../../config/firebase");
const {
  requireAuth,
  requireProjectAdmin,
  requireFeature,
} = require("../../middleware/auth");
const logger = require("../../utils/logger");

const router = express.Router();

// Generate report for current project
router.get(
  "/generate",
  requireAuth,
  requireProjectAdmin,
  requireFeature("reportGeneration"),
  async (req, res) => {
    try {
      const { projectKey } = req.session;
      const { period = "6months", format = "json" } = req.query;

      // Validate period
      const validPeriods = ["1month", "3months", "6months", "1year"];
      if (!validPeriods.includes(period)) {
        return res
          .status(400)
          .json({ error: `Period must be one of: ${validPeriods.join(", ")}` });
      }

      // Calculate date range
      const endDate = new Date();
      const startDate = new Date();

      switch (period) {
        case "1month":
          startDate.setMonth(startDate.getMonth() - 1);
          break;
        case "3months":
          startDate.setMonth(startDate.getMonth() - 3);
          break;
        case "6months":
          startDate.setMonth(startDate.getMonth() - 6);
          break;
        case "1year":
          startDate.setFullYear(startDate.getFullYear() - 1);
          break;
      }

      // Fetch execution logs for this project in date range
      const executionsSnapshot = await collections.executions
        .where("projectId", "==", projectKey)
        .where("triggeredAt", ">=", startDate)
        .where("triggeredAt", "<=", endDate)
        .get();

      const executions = executionsSnapshot.docs.map((d) => d.data());

      // Aggregate metrics
      const report = {
        period: { start: startDate, end: endDate },
        project: projectKey,
        generatedAt: new Date(),
        summary: {
          totalExecutions: executions.length,
          successfulExecutions: executions.filter(
            (e) => e.status === "completed",
          ).length,
          failedExecutions: executions.filter((e) => e.status === "failed")
            .length,
          avgExecutionTime: calculateAvgExecutionTime(executions),
        },
        bugMetrics: {
          byPriority: aggregateByField(executions, "issue.priority"),
          byType: aggregateByField(executions, "issue.type"),
          resolutionTime: calculateResolutionMetrics(executions),
        },
        teamMetrics: {
          assignmentsByUser: aggregateAssignments(executions),
          performance: calculateTeamPerformance(executions),
        },
      };

      // Format response
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="report-${projectKey}-${period}.csv"`,
        );
        res.send(convertToCSV(report));
      } else {
        res.json({ success: true, data: report });
      }
    } catch (error) {
      logger.error("Report generation failed:", error);
      res
        .status(500)
        .json({ success: false, error: "Failed to generate report" });
    }
  },
);

// Helper: Calculate average execution time in seconds
function calculateAvgExecutionTime(executions) {
  const completed = executions.filter((e) => e.completedAt && e.triggeredAt);
  if (!completed.length) return null;

  const totalMs = completed.reduce((sum, e) => {
    return sum + (new Date(e.completedAt) - new Date(e.triggeredAt));
  }, 0);

  return Math.round(totalMs / completed.length / 1000);
}

// Helper: Aggregate by nested field path
function aggregateByField(executions, fieldPath) {
  const counts = {};

  executions.forEach((exec) => {
    const value = getFieldByPath(exec.context, fieldPath);
    if (value) {
      counts[value] = (counts[value] || 0) + 1;
    }
  });

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {});
}

// Helper: Get nested field value by dot-path
function getFieldByPath(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

// Placeholder aggregation functions
function calculateResolutionMetrics(executions) {
  return { avgHours: null };
}
function aggregateAssignments(executions) {
  return {};
}
function calculateTeamPerformance(executions) {
  return {};
}
function convertToCSV(report) {
  return JSON.stringify(report);
}

module.exports = router;
