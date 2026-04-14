// routes/ai-chat.js
// Replaces raw Gemini proxy with the LangGraph-powered agent.
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { collections } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { runAgent } = require('../services/ai-agent');
const logger = require('../utils/logger');

// ── POST /ai/chat ─────────────────────────────────────────────────────────────
router.post('/chat', requireAuth, async (req, res) => {
  try {
    const { message, history = [], editingWorkflowId } = req.body;
    const projectKey = req.headers['x-project-key'] || req.session?.projectKey;
    const role = req.session?.isAdmin ? 'admin' : 'assigner';
    const userId = req.session.userId;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message required' });
    }

    // Run the LangGraph agent — this is where the graph executes
    const result = await runAgent({
      message: message.trim(),
      history,
      projectKey,
      role,
      editingWorkflowId: editingWorkflowId || null,
    });

    // Persist conversation history (background, don't await)
    if (userId && projectKey) {
      const chatRef = collections.users.doc(userId).collection('chats').doc(projectKey);
      const batch = [
        { role: 'user', content: message, ts: new Date().toISOString() },
        { role: 'assistant', content: result.reply, intent: result.intent, ts: new Date().toISOString() },
      ];
      chatRef.set({
        messages: admin.firestore.FieldValue.arrayUnion(...batch),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        projectKey,
      }, { merge: true }).then(async () => {
        const doc = await chatRef.get();
        const msgs = doc.data()?.messages || [];
        if (msgs.length > 100) {
          await chatRef.update({ messages: msgs.slice(-100) });
        }
      }).catch(e => logger.warn('[AI CHAT] History save failed:', e.message));
    }

    res.json({
      reply: result.reply,
      intent: result.intent,
      pendingWorkflowJSON: result.pendingWorkflowJSON || null,
      actionResult: result.actionResult || null,
      role,
    });
  } catch (error) {
    logger.error('[AI CHAT] Error:', error.message);
    res.status(500).json({ error: 'AI agent failed: ' + error.message });
  }
});

// ── GET /ai/chat/history ──────────────────────────────────────────────────────
router.get('/chat/history', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const projectKey = req.headers['x-project-key'] || req.session?.projectKey;
    if (!userId || !projectKey) return res.json({ messages: [] });

    const doc = await collections.users.doc(userId).collection('chats').doc(projectKey).get();
    res.json({ messages: doc.exists ? (doc.data()?.messages || []) : [] });
  } catch (error) {
    logger.error('[AI CHAT] History fetch failed:', error.message);
    res.json({ messages: [] });
  }
});

// ── GET /ai/context ───────────────────────────────────────────────────────────
router.get('/context', requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers['x-project-key'] || req.session?.projectKey;
    const projectDoc = await collections.projects.doc(projectKey).get();
    const pData = projectDoc.exists ? projectDoc.data() : {};

    const wfSnap = await collections.workflows
      .where('projectId', '==', projectKey)
      .where('isActive', '==', true)
      .get();

    res.json({
      projectKey,
      slackConnected: !!pData.integrations?.slack?.teamId,
      slackTeamName: pData.integrations?.slack?.teamName || null,
      githubConnected: !!pData.integrations?.github?.repoUrl,
      features: pData.features || {},
      workflowCount: wfSnap.size,
      workflows: wfSnap.docs.map(doc => ({
        id: doc.id,
        name: doc.data().name,
        events: doc.data().trigger?.events || [],
      })),
    });
  } catch (error) {
    logger.error('[AI CONTEXT] Error:', error.message);
    res.status(500).json({ error: 'Failed to load context' });
  }
});

// ── POST /ai/workflow/save ─────────────────────────────────────────────────────
// Deduplication logic: checks that trigger events are unique across this project.
// For EDIT: updates the existing doc (does NOT delete + recreate = no duplicates).
router.post('/workflow/save', requireAuth, async (req, res) => {
  try {
    const projectKey = req.headers['x-project-key'] || req.session?.projectKey;
    const userId = req.session.userId;
    const { workflowData, editWorkflowId } = req.body;

    if (!workflowData) return res.status(400).json({ error: 'workflowData required' });

    const userMeta = {
      userId,
      email: req.session.user?.email || 'unknown',
      displayName: req.session.user?.displayName || 'Unknown',
    };

    const base = {
      ...workflowData,
      projectId: projectKey,
      isActive: true,
      updatedBy: userMeta,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (editWorkflowId) {
      // ── EDIT path: update in-place, no delete, no duplicate ──────────────────
      const docRef = collections.workflows.doc(editWorkflowId);
      const existing = await docRef.get();
      if (!existing.exists || existing.data().projectId !== projectKey) {
        return res.status(404).json({ error: 'Workflow not found' });
      }

      // Check if new trigger events conflict with OTHER workflows (not itself)
      const newEvents = workflowData.trigger?.events || [];
      for (const event of newEvents) {
        const conflictSnap = await collections.workflows
          .where('projectId', '==', projectKey)
          .where('isActive', '==', true)
          .get();
        const conflict = conflictSnap.docs.find(d =>
          d.id !== editWorkflowId && (d.data().trigger?.events || []).includes(event)
        );
        if (conflict) {
          return res.status(409).json({
            error: 'Duplicate trigger event',
            conflict: event,
            existingWorkflow: { id: conflict.id, name: conflict.data().name },
          });
        }
      }

      const existingData = existing.data();
      await docRef.update({
        ...base,
        version: (existingData.version || 1) + 1,
        editHistory: admin.firestore.FieldValue.arrayUnion({
          editedBy: userMeta,
          editedAt: new Date().toISOString(),
          changeDescription: 'Updated via AI chat',
        }),
      });
      return res.json({ success: true, action: 'updated', workflowId: editWorkflowId });

    } else {
      // ── CREATE path: check uniqueness first, then create ─────────────────────
      const newEvents = workflowData.trigger?.events || [];
      const existingSnap = await collections.workflows
        .where('projectId', '==', projectKey)
        .where('isActive', '==', true)
        .get();

      for (const event of newEvents) {
        const conflict = existingSnap.docs.find(d => (d.data().trigger?.events || []).includes(event));
        if (conflict) {
          return res.status(409).json({
            error: 'Duplicate trigger event',
            conflict: event,
            existingWorkflow: { id: conflict.id, name: conflict.data().name },
          });
        }
      }

      const docRef = await collections.workflows.add({
        ...base,
        createdBy: userMeta,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        version: 1,
        editHistory: [],
      });
      return res.json({ success: true, action: 'created', workflowId: docRef.id });
    }
  } catch (error) {
    logger.error('[AI WORKFLOW SAVE] Error:', error.message);
    res.status(500).json({ error: 'Failed to save workflow: ' + error.message });
  }
});

// ── POST /ai/features/toggle ──────────────────────────────────────────────────
// Direct REST endpoint for feature toggling (used alongside chat)
router.post('/features/toggle', requireAuth, async (req, res) => {
  try {
    if (!req.session?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const projectKey = req.headers['x-project-key'] || req.session?.projectKey;
    const { feature, enabled } = req.body;
    if (!feature) return res.status(400).json({ error: 'feature required' });

    await collections.projects.doc(projectKey).set(
      { features: { [feature]: !!enabled }, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    res.json({ success: true, feature, enabled: !!enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
