// routes/workflows.js
const express = require("express");
const Joi = require("joi");
const admin = require("firebase-admin"); // ✅ CRITICAL: Add this import
const { collections, isEventUsed } = require("../config/firebase");
const {
  requireAuth,
  requireProjectAdmin,
  loadUserProfile,
} = require("../middleware/auth");
const logger = require("../utils/logger");

const router = express.Router();

// Validation schema for workflow creation
const workflowSchema = Joi.object({
  name: Joi.string().min(3).max(100).required(),
  trigger: Joi.object({
    events: Joi.array()
      .items(
        Joi.string().valid(
          "issue_created",
          "issue_assigned",
          "issue_transitioned",
          "issue_commented",
          "issue_updated",
          "issue_deleted",
        ),
      )
      .min(1)
      .required(),
  }).required(),
  notifications: Joi.object()
    .pattern(
      Joi.string(),
      Joi.alternatives().try(
        // For issue_assigned
        Joi.object({
          enabled: Joi.boolean().default(true), // ✅ Master toggle per event
          useDefaultPriority: Joi.boolean().default(true),
          slack: Joi.object({
            enabled: Joi.boolean().default(true), // ✅ Now optional + uncheckable
            channelLink: Joi.string().uri().allow(null),
          }),
          email: Joi.object({
            enabled: Joi.boolean(),
            priorities: Joi.object({
              low: Joi.boolean(),
              medium: Joi.boolean(),
              high: Joi.boolean(),
            }),
          }),
          sms: Joi.object({
            enabled: Joi.boolean(),
            priorities: Joi.object({
              low: Joi.boolean(),
              medium: Joi.boolean(),
              high: Joi.boolean(),
            }),
          }),
        }),
        // For other events
        Joi.object({
          enabled: Joi.boolean().default(true), // ✅ Master toggle
          channelLink: Joi.string().uri().allow(null),
        }),
      ),
    )
    .required(),
  enhancements: Joi.object({
    aiSuggestions: Joi.boolean().default(false),
    autoBranch: Joi.object({
      enabled: Joi.boolean().default(false),
      repoUrl: Joi.string()
        .uri()
        .pattern(/^https:\/\/github\.com\/[^/]+\/[^/]+$/)
        .allow(null),
    }),
  }).default({}),
});

// ✅ GET /api/workflows - Fetch all active workflows for project (REAL)
router.get("/", requireAuth, async (req, res) => {
  try {
    const { projectKey } = req.session; // ✅ From OAuth session

    const snapshot = await collections.workflows
      .where("projectId", "==", projectKey)
      .where("isActive", "==", true)
      .orderBy("createdAt", "desc")
      .get();

    const workflows = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ success: true, workflows });
  } catch (error) {
    logger.error("Failed to fetch workflows:", error);
    res.status(500).json({ success: false, error: "Failed to load workflows" });
  }
});

// ✅ GET /api/workflows/:workflowId - Fetch single workflow (REAL)
router.get("/:workflowId", requireAuth, async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { projectKey } = req.session;

    const doc = await collections.workflows.doc(workflowId).get();

    if (!doc.exists || doc.data().projectId !== projectKey) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    res.json({ success: true, data: { id: doc.id, ...doc.data() } });
  } catch (error) {
    logger.error("Failed to fetch workflow:", error);
    res.status(500).json({ success: false, error: "Failed to load workflow" });
  }
});

// ✅ POST /api/workflows - Create workflow with REAL uniqueness check (REAL)
router.post("/", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const { error, value } = workflowSchema.validate(req.body);
    if (error) {
      return res
        .status(400)
        .json({ success: false, error: error.details[0].message });
    }

    const { projectKey, userId } = req.session; // ✅ Both from OAuth session
    const { trigger } = value;

    // ✅ REAL UNIQUENESS CHECK: Query Firestore directly
    for (const event of trigger.events) {
      const existing = await collections.workflows
        .where("projectId", "==", projectKey)
        .where("trigger.events", "array-contains", event)
        .where("isActive", "==", true)
        .limit(1)
        .get();

      if (!existing.empty) {
        return res.status(409).json({
          success: false,
          error: "Duplicate trigger event",
          conflict: event,
          message: `A workflow already uses "${event}". Edit the existing workflow instead.`,
          existingWorkflowId: existing.docs[0].id,
        });
      }
    }

    // ✅ REAL SAVE: Write to Firestore with server timestamps
    const workflowData = {
      ...value,
      projectId: projectKey,
      createdBy: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), // ✅ REAL server time
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      isActive: true,
    };

    const docRef = await collections.workflows.add(workflowData); // ✅ REAL write

    res.status(201).json({
      success: true,
      data: { id: docRef.id, ...workflowData },
    });
  } catch (error) {
    logger.error("Failed to create workflow:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to create workflow" });
  }
});

// ✅ PUT /api/workflows/:workflowId - Update workflow (REAL)
router.put(
  "/:workflowId",
  requireAuth,
  requireProjectAdmin,
  async (req, res) => {
    try {
      const { workflowId } = req.params;
      const { projectKey } = req.session;

      const { error, value } = workflowSchema.validate(req.body, {
        allowUnknown: true,
      });
      if (error) {
        return res.status(400).json({
          success: false,
          error: error.details[0].message,
        });
      }

      const docRef = collections.workflows.doc(workflowId);
      const doc = await docRef.get();

      if (!doc.exists || doc.data().projectId !== projectKey) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      const existing = doc.data();

      // ✅ Check uniqueness for NEW events only (not ones already in workflow)
      if (value.trigger?.events) {
        const oldEvents = new Set(existing.trigger?.events || []);
        const newEvents = new Set(value.trigger.events);

        for (const event of newEvents) {
          if (!oldEvents.has(event)) {
            const isUsed = await isEventUsed(projectKey, event, workflowId);
            if (isUsed) {
              return res.status(409).json({
                success: false,
                error: "Duplicate trigger event",
                conflict: event,
                message: `Another workflow already uses "${event}"`,
              });
            }
          }
        }
      }

      // ✅ REAL UPDATE
      await docRef.update({
        ...value,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`Workflow updated: ${workflowId}`);
      res.json({ success: true, message: "Workflow updated successfully" });
    } catch (error) {
      logger.error("Failed to update workflow:", error);
      res
        .status(500)
        .json({ success: false, error: "Failed to update workflow" });
    }
  },
);

// ✅ PATCH /api/workflows/:workflowId/toggle - Activate/deactivate (REAL)
router.patch(
  "/:workflowId/toggle",
  requireAuth,
  requireProjectAdmin,
  async (req, res) => {
    try {
      const { workflowId } = req.params;
      const { projectKey } = req.session;

      const docRef = collections.workflows.doc(workflowId);
      const doc = await docRef.get();

      if (!doc.exists || doc.data().projectId !== projectKey) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      const current = doc.data().isActive;
      await docRef.update({
        isActive: !current,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(
        `Workflow ${workflowId} ${!current ? "activated" : "deactivated"}`,
      );
      res.json({ success: true, data: { isActive: !current } });
    } catch (error) {
      logger.error("Failed to toggle workflow:", error);
      res
        .status(500)
        .json({ success: false, error: "Failed to update workflow" });
    }
  },
);

// ✅ DELETE /api/workflows/:workflowId - Soft delete (REAL)
router.delete(
  "/:workflowId",
  requireAuth,
  requireProjectAdmin,
  async (req, res) => {
    try {
      const { workflowId } = req.params;
      const { projectKey } = req.session;

      const docRef = collections.workflows.doc(workflowId);
      const doc = await docRef.get();

      if (!doc.exists || doc.data().projectId !== projectKey) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      // ✅ Soft delete: mark inactive + timestamp
      await docRef.update({
        isActive: false,
        deletedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`Workflow soft-deleted: ${workflowId}`);
      res.json({ success: true, message: "Workflow deactivated" });
    } catch (error) {
      logger.error("Failed to delete workflow:", error);
      res
        .status(500)
        .json({ success: false, error: "Failed to delete workflow" });
    }
  },
);

module.exports = router;
