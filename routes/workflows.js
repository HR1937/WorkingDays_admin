// routes/workflows.js
const express = require("express");
const Joi = require("joi");
const admin = require("firebase-admin");
const {
  collections,
  isEventUsed,
  findWorkflowByEvent,
} = require("../config/firebase");
const {
  requireAuth,
  requireProjectAdmin,
} = require("../middleware/auth");
const logger = require("../utils/logger");

const router = express.Router();

// ===== JOI VALIDATION SCHEMA =====
// Notification config for issue_assigned (has priority-based channels)
const issueAssignedNotifSchema = Joi.object({
  enabled: Joi.boolean().default(true),
  useDefaultPriority: Joi.boolean().default(true),
  slack: Joi.object({
    enabled: Joi.boolean().default(true),
    channelId: Joi.string().allow(null, ""),       // ← channelId from dropdown
    channelName: Joi.string().allow(null, ""),      // ← human-readable name
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
});

// Notification config for other events (simpler — just channel)
const genericNotifSchema = Joi.object({
  enabled: Joi.boolean().default(true),
  channelId: Joi.string().allow(null, ""),         // ← channelId from dropdown
  channelName: Joi.string().allow(null, ""),        // ← human-readable name
  channelLink: Joi.string().uri().allow(null, ""),  // ← backward compat (old URL format)
});

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
      Joi.alternatives().try(issueAssignedNotifSchema, genericNotifSchema),
    )
    .required(),
  enhancements: Joi.object({
    aiSuggestions: Joi.boolean().default(false),
    aiSolutions: Joi.boolean().default(false),
    autoBranch: Joi.object({
      enabled: Joi.boolean().default(false),
      repoUrl: Joi.string()
        .uri()
        .pattern(/^https:\/\/github\.com\/[^/]+\/[^/]+$/)
        .allow(null, ""),
    }),
  }).default({}),
}).options({ stripUnknown: true }); // ← Strip projectId and any unknown fields

// ===== GET /api/workflows — Fetch all active workflows for project =====
router.get("/", requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    if (!projectKey) {
      return res.status(400).json({ success: false, error: "Project key required" });
    }

    const snapshot = await collections.workflows
      .where("projectId", "==", projectKey)
      .where("isActive", "==", true)
      .orderBy("createdAt", "desc")
      .get();

    const workflows = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ success: true, data: workflows });
  } catch (error) {
    logger.error("Failed to fetch workflows:", error);
    res.status(500).json({ success: false, error: "Failed to load workflows" });
  }
});

// ===== GET /api/workflows/:workflowId — Fetch single workflow =====
router.get("/:workflowId", requireAuth, async (req, res) => {
  try {
    const { workflowId } = req.params;
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;

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

// ===== POST /api/workflows — Create workflow with full audit trail =====
router.post("/", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const userId = req.session.userId;
    const userEmail = req.session.user?.email || "unknown";
    const userDisplayName = req.session.user?.displayName || "Unknown";

    logger.debug("Creating workflow:", {
      body: JSON.stringify(req.body).substring(0, 500),
      projectKey,
      userId,
    });

    // Validate (stripUnknown removes projectId etc.)
    const { error, value } = workflowSchema.validate(req.body);
    if (error) {
      logger.warn("Workflow validation failed:", error.details);
      return res.status(400).json({
        success: false,
        error: error.details[0].message,
        details: error.details,
      });
    }

    const { trigger } = value;

    // ===== DUPLICATE EVENT CHECK =====
    // If any event is already used by another active workflow, return the existing workflow ID
    for (const event of trigger.events) {
      const existing = await findWorkflowByEvent(projectKey, event);
      if (existing) {
        return res.status(409).json({
          success: false,
          error: "Duplicate trigger event",
          conflict: event,
          message: `A workflow already uses "${event}". Edit the existing workflow instead.`,
          existingWorkflowId: existing.id,
          existingWorkflow: {
            id: existing.id,
            name: existing.name,
            events: existing.trigger?.events || [],
          },
        });
      }
    }

    // ===== BUILD WORKFLOW DATA WITH FULL AUDIT TRAIL =====
    const workflowData = {
      ...value,
      projectId: projectKey,
      isActive: true,
      version: 1,
      // Full creator info
      createdBy: {
        userId,
        email: userEmail,
        displayName: userDisplayName,
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: {
        userId,
        email: userEmail,
        displayName: userDisplayName,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      // Audit: track what contact info this workflow requires from team members
      requiresSlack: checkIfWorkflowUsesSlack(value),
      requiresSms: checkIfWorkflowUsesSms(value),
      // Edit history starts empty
      editHistory: [],
    };

    logger.debug("Saving workflow to Firestore:", {
      projectId: projectKey,
      events: trigger.events,
      name: value.name,
    });

    const docRef = await collections.workflows.add(workflowData);

    logger.info("✅ Workflow created successfully:", {
      id: docRef.id,
      projectId: projectKey,
      events: trigger.events,
      createdBy: userEmail,
    });

    res.status(201).json({
      success: true,
      data: { id: docRef.id, ...workflowData },
    });
  } catch (error) {
    logger.error("❌ Failed to create workflow:", {
      message: error.message,
      stack: error.stack,
      body: JSON.stringify(req.body).substring(0, 500),
    });
    res.status(500).json({
      success: false,
      error: "Failed to create workflow",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ===== PUT /api/workflows/:workflowId — Update workflow with audit trail =====
router.put("/:workflowId", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const { workflowId } = req.params;
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;
    const userId = req.session.userId;
    const userEmail = req.session.user?.email || "unknown";
    const userDisplayName = req.session.user?.displayName || "Unknown";

    const { error, value } = workflowSchema.validate(req.body);
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

    // Check uniqueness for NEW events only
    if (value.trigger?.events) {
      const oldEvents = new Set(existing.trigger?.events || []);
      for (const event of value.trigger.events) {
        if (!oldEvents.has(event)) {
          const conflict = await findWorkflowByEvent(projectKey, event, workflowId);
          if (conflict) {
            return res.status(409).json({
              success: false,
              error: "Duplicate trigger event",
              conflict: event,
              message: `Another workflow already uses "${event}"`,
              existingWorkflowId: conflict.id,
            });
          }
        }
      }
    }

    // ===== BUILD EDIT HISTORY ENTRY =====
    const editEntry = {
      editedBy: { userId, email: userEmail, displayName: userDisplayName },
      editedAt: new Date().toISOString(),
      changeDescription: `Updated by ${userDisplayName}`,
      previousEvents: existing.trigger?.events || [],
      newEvents: value.trigger?.events || [],
    };

    // ===== UPDATE WITH AUDIT TRAIL =====
    await docRef.update({
      ...value,
      version: (existing.version || 1) + 1,
      updatedBy: { userId, email: userEmail, displayName: userDisplayName },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      requiresSlack: checkIfWorkflowUsesSlack(value),
      requiresSms: checkIfWorkflowUsesSms(value),
      editHistory: admin.firestore.FieldValue.arrayUnion(editEntry),
    });

    logger.info(`✅ Workflow updated: ${workflowId} (v${(existing.version || 1) + 1}) by ${userEmail}`);
    res.json({ success: true, message: "Workflow updated successfully" });
  } catch (error) {
    logger.error("Failed to update workflow:", error);
    res.status(500).json({ success: false, error: "Failed to update workflow" });
  }
});

// ===== PATCH /api/workflows/:workflowId/toggle — Activate/deactivate =====
router.patch("/:workflowId/toggle", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const { workflowId } = req.params;
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;

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

    logger.info(`Workflow ${workflowId} ${!current ? "activated" : "deactivated"}`);
    res.json({ success: true, data: { isActive: !current } });
  } catch (error) {
    logger.error("Failed to toggle workflow:", error);
    res.status(500).json({ success: false, error: "Failed to update workflow" });
  }
});

// ===== DELETE /api/workflows/:workflowId — Soft delete =====
router.delete("/:workflowId", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const { workflowId } = req.params;
    const projectKey = req.headers["x-project-key"] || req.session?.projectKey;

    const docRef = collections.workflows.doc(workflowId);
    const doc = await docRef.get();

    if (!doc.exists || doc.data().projectId !== projectKey) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    await docRef.update({
      isActive: false,
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`Workflow soft-deleted: ${workflowId}`);
    res.json({ success: true, message: "Workflow deactivated" });
  } catch (error) {
    logger.error("Failed to delete workflow:", error);
    res.status(500).json({ success: false, error: "Failed to delete workflow" });
  }
});

// ===== HELPERS: Check what contact info a workflow requires =====
function checkIfWorkflowUsesSlack(workflowValue) {
  const notifs = workflowValue.notifications || {};
  for (const [event, config] of Object.entries(notifs)) {
    if (!config.enabled) continue;
    if (event === "issue_assigned" && config.slack?.enabled) return true;
    if (config.channelId) return true;
  }
  return false;
}

function checkIfWorkflowUsesSms(workflowValue) {
  const notifs = workflowValue.notifications || {};
  for (const [event, config] of Object.entries(notifs)) {
    if (!config.enabled) continue;
    if (event === "issue_assigned" && config.sms?.enabled) return true;
  }
  return false;
}

module.exports = router;
