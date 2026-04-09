const express = require("express");
const {
  requireAuth,
  requireProjectAdmin,
  requireFeature,
} = require("../../middleware/auth");
const { analyzeBug } = require("../../services/ai/bugAnalyzer");
const logger = require("../../utils/logger");

const router = express.Router();

// Analyze a bug and suggest solutions
router.post(
  "/analyze-bug",
  requireAuth,
  requireFeature("aiBugAnalysis"),
  async (req, res) => {
    try {
      const { issueKey, summary, description, codeContext } = req.body;

      if (!issueKey || !summary) {
        return res
          .status(400)
          .json({ error: "issueKey and summary are required" });
      }

      // Call AI analysis service
      const analysis = await analyzeBug({
        issueKey,
        summary,
        description: description || "",
        codeContext: codeContext || null,
        projectKey: req.session.projectKey,
      });

      res.json({
        success: true,
        data: {
          issueKey,
          suggestions: analysis.suggestions,
          confidence: analysis.confidence,
          reasoning: analysis.reasoning,
        },
      });
    } catch (error) {
      logger.error("AI analysis failed:", error.message);
      res.status(500).json({
        success: false,
        error: "Analysis failed",
        message:
          process.env.NODE_ENV === "development"
            ? error.message
            : "Please try again",
      });
    }
  },
);

// Get suggested assignee for an issue
router.post(
  "/suggest-assignee",
  requireAuth,
  requireFeature("aiBugAnalysis"),
  async (req, res) => {
    try {
      const { issueKey, issueType, components, labels } = req.body;

      if (!issueKey) {
        return res.status(400).json({ error: "issueKey is required" });
      }

      // This would integrate with assigneeSuggester service
      // For now, return mock data structure
      res.json({
        success: true,
        data: {
          issueKey,
          suggestions: [
            {
              userId: "user_123",
              name: "Alex Chen",
              confidence: 0.87,
              reasons: [
                "Solved 5 similar auth-related bugs in last 30 days",
                "Currently has lowest active assignment count",
                "Has expertise in component: authentication",
              ],
            },
            {
              userId: "user_456",
              name: "Jordan Lee",
              confidence: 0.72,
              reasons: [
                "Worked on this code module recently",
                "Available (no high-priority tasks)",
              ],
            },
          ],
        },
      });
    } catch (error) {
      logger.error("Assignee suggestion failed:", error.message);
      res.status(500).json({ success: false, error: "Suggestion failed" });
    }
  },
);

module.exports = router;
