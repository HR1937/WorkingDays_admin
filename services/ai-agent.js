/**
 * services/ai-agent.js
 * ─────────────────────────────────────────────────────────────────────────────
 * LangGraph-powered agentic workflow orchestrator.
 *
 * WHY LANGGRAPH vs plain if-else / single Gemini call:
 * ──────────────────────────────────────────────────────
 * Our PREVIOUS approach (routes/ai-chat.js):
 *   User message → one Gemini call → parse response string
 *   → if ([WORKFLOW_JSON_START]) save, else if (mentions "suggest") runAI…
 *   This is fragile: intent is extracted by hoping the LLM writes specific
 *   strings. It's one giant black-box call where context, reasoning, action
 *   execution and response all happen inside the same prompt.
 *
 * LANGGRAPH approach:
 *   User message → State flows through a DIRECTED GRAPH of nodes.
 *   Each node is a focused unit: classify intent, fetch context, execute tool,
 *   generate natural-language answer. Edges are CONDITIONAL: the output of one
 *   node determines which node runs next. The graph can CYCLE (clarify → user
 *   responds → continue), and the full conversation STATE is accumulated.
 *
 * Key differences:
 *   1. STRUCTURED INTENT  — a dedicated classifier node returns a typed intent
 *      object (not a free-form string), so routing is deterministic.
 *   2. TOOL NODES  — saveWorkflow, toggleFeature, suggestAssignee are real
 *      async functions called by the graph, not regex-matched in a response.
 *   3. STATE PERSISTENCE  — AgentState carries messages + intent + context +
 *      pendingAction across every node; nothing is re-parsed from scratch.
 *   4. MODULARITY  — Adding "report generation via chat" = add one node + one
 *      edge. Zero changes to existing nodes.
 *   5. OBSERVABILITY  — Every node's input/output is traceable; you can log
 *      exactly why the graph took a particular path.
 *   6. CYCLES/RETRIES  — The graph can loop back for clarification or retry
 *      a failed tool call without tangling the main prompt.
 *
 * Graph topology:
 * ┌─────────────┐
 * │  __start__  │
 * └──────┬──────┘
 *        │
 *        ▼
 * ┌─────────────────┐
 * │ intentClassifier│  ← LLM classifies: create_workflow | edit_workflow |
 * └────────┬────────┘    toggle_feature | assign_issue | run_report |
 *          │              view_workflows | general
 *          ▼
 * ┌─────────────────┐
 * │  contextFetcher │  ← fetches live project data (workflows, features,
 * └────────┬────────┘    integrations) from Firestore
 *          │
 *     ┌────┴──────────────────────────────────────────────┐
 *     │ conditional edge: routes on state.intent          │
 *     └─┬─────┬──────┬──────┬──────┬──────┬──────────────┘
 *       ▼     ▼      ▼      ▼      ▼      ▼
 *  wfNode fNode aiNode rNode vNode  generalNode
 *  (build) (feat) (assign)(rpt) (view)  (chat)
 *       │     │      │      │      │      │
 *       └─────┴──────┴──────┴──────┴──────┘
 *                        │
 *                        ▼
 *               ┌──────────────┐
 *               │   responder  │  ← formats final natural-language reply
 *               └──────┬───────┘
 *                      │
 *                   __end__
 */

'use strict';

const { StateGraph, Annotation, END } = require('@langchain/langgraph');
const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, SystemMessage, AIMessage } = require('@langchain/core/messages');
const admin = require('firebase-admin');
const { collections } = require('../config/firebase');
const { decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

// ── Quota / Rate-limit helpers ────────────────────────────────────────────────
/**
 * Returns true if the error is a Gemini free-tier quota exhaustion.
 * We surface this to the user BEFORE burning another API call.
 */
function isQuotaError(e) {
  const msg = String(e?.message || '');
  return msg.includes('429') ||
    msg.includes('Too Many Requests') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.toLowerCase().includes('quota');
}

/**
 * Try to extract the retry delay from the 429 body, default 30s.
 */
function extractRetrySeconds(e) {
  try {
    const match = String(e?.message || '').match(/retryDelay":"(\d+)/);
    if (match) return parseInt(match[1], 10);
    const sMatch = String(e?.message || '').match('retry in ([\\d.]+)s');
    if (sMatch) return Math.ceil(parseFloat(sMatch[1]));
  } catch { /* ignore */ }
  return 30;
}

/** Friendly quota message shown to the user */
function quotaMessage(e) {
  const secs = extractRetrySeconds(e);
  return `⏳ **Gemini API quota reached.**

The free tier has a limit per minute and per day. Please wait about **${secs} seconds** then try again.

If this keeps happening your daily free quota may be exhausted. Options:
• Wait a few minutes and retry
• Check usage at https://ai.dev/rate-limit
• Upgrade your plan for higher limits`;
}

// ── 1. AGENT STATE SCHEMA ─────────────────────────────────────────────────────
// All nodes read from and write to this shared state.
// LangGraph merges returned partial state with the existing state automatically.

const AgentState = Annotation.Root({
  // Conversation history (LangChain message objects)
  messages: Annotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  // Last user message (plain text)
  userMessage: Annotation({ reducer: (_, b) => b, default: () => '' }),
  // Classified intent from intentClassifier node
  intent: Annotation({ reducer: (_, b) => b, default: () => 'general' }),
  // Structured intent data (e.g., { featureName, enabled } for toggle_feature)
  intentData: Annotation({ reducer: (_, b) => b, default: () => ({}) }),
  // Live project context fetched from Firestore
  projectContext: Annotation({ reducer: (_, b) => b, default: () => null }),
  // Pending workflow JSON to save (set by workflowNode, cleared by saveWorkflow tool)
  pendingWorkflowJSON: Annotation({ reducer: (_, b) => b, default: () => null }),
  // Action result from tool nodes
  actionResult: Annotation({ reducer: (_, b) => b, default: () => null }),
  // Final reply to send to the client
  finalReply: Annotation({ reducer: (_, b) => b, default: () => '' }),
  // Runtime context (projectKey, role) — not persisted to Firestore
  projectKey: Annotation({ reducer: (_, b) => b, default: () => '' }),
  role: Annotation({ reducer: (_, b) => b, default: () => 'assigner' }),
  editingWorkflowId: Annotation({ reducer: (_, b) => b, default: () => null }),
});

// ── 2. LLM INSTANCE ──────────────────────────────────────────────────────────
// Using gpt-4o-mini: best cost/quality/speed ratio on OpenAI free tier.
// Same structured-output capabilities as gemini-2.0-flash.
function getLLM(temperature = 0.3) {
  return new ChatOpenAI({
    model: 'gpt-4o-mini',
    temperature,
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 0, // fail fast on quota, surface friendly message
  });
}

async function invokeLLM(messages, temperature = 0.3) {
  return await getLLM(temperature).invoke(messages);
}

// ── 3. NODE: intentClassifier ─────────────────────────────────────────────────
// PURPOSE: Determine WHAT the user wants as a typed intent.
// LANGGRAPH ADVANTAGE: This is a separate node — its sole job is classification.
// The output is a structured JSON object, not a free-form string.
// The router then uses this deterministically, no string matching needed.

async function intentClassifier(state) {
  const llm = getLLM(0.1); // low temp = more deterministic classification
  const lastUserMsg = state.userMessage;
  const role = state.role;

  const prompt = `You are an intent classifier for an AI workflow management assistant.

Classify the user's message into EXACTLY ONE of these intents:
- "create_workflow": user wants to create a new automation workflow
- "edit_workflow": user wants to modify an existing workflow
- "toggle_feature": user wants to enable/disable a project feature (AI suggestions, report generation, Sentry)
- "view_workflows": user wants to see current workflows
- "assign_issue": user wants to assign a Jira issue (assigner role only)
- "run_report": user wants to generate a report
- "general": anything else (questions, greetings, explanations)

Also extract relevant data:
- For toggle_feature: which feature? (aiAssigneeSuggestions | reportGeneration | sentryEnabled) and enable/disable
- For edit_workflow: workflow name if mentioned
- For create_workflow: any initial details mentioned

User role: ${role}
User message: "${lastUserMsg}"

Respond with ONLY valid JSON:
{"intent":"...", "data":{"featureName":"...","enabled":true/false,"workflowName":"...","details":"..."}}`;

  try {
    const result = await llm.invoke([new HumanMessage(prompt)]);
    const text = result.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      logger.info(`[LANGGRAPH] Intent classified: ${parsed.intent}`, parsed.data);
      return { intent: parsed.intent, intentData: parsed.data || {} };
    }
  } catch (e) {
    logger.warn('[LANGGRAPH] Intent classification failed, defaulting to general:', e.message);
  }
  return { intent: 'general', intentData: {} };
}

// ── 4. NODE: contextFetcher ───────────────────────────────────────────────────
// PURPOSE: Fetch live Firestore data once and attach to state.
// LANGGRAPH ADVANTAGE: All downstream nodes share the SAME fetched context —
// no redundant Firestore calls in each node, single source of truth in state.

async function contextFetcher(state) {
  const { projectKey } = state;
  if (!projectKey) return { projectContext: null };

  try {
    const [projectDoc, wfSnap] = await Promise.all([
      collections.projects.doc(projectKey).get(),
      collections.workflows.where('projectId', '==', projectKey).where('isActive', '==', true).get(),
    ]);

    const pData = projectDoc.exists ? projectDoc.data() : {};
    const workflows = wfSnap.docs.map(doc => ({
      id: doc.id,
      name: doc.data().name,
      events: doc.data().trigger?.events || [],
      notifications: doc.data().notifications || {},
      enhancements: doc.data().enhancements || {},
    }));

    const ctx = {
      features: pData.features || {},
      slackConnected: !!pData.integrations?.slack?.teamId,
      slackTeamName: pData.integrations?.slack?.teamName || null,
      githubConnected: !!pData.integrations?.github?.repoUrl,
      githubRepoUrl: pData.integrations?.github?.repoUrl || null,
      workflows,
      workflowCount: workflows.length,
      usedTriggerEvents: workflows.flatMap(w => w.events),
    };

    return { projectContext: ctx };
  } catch (e) {
    logger.warn('[LANGGRAPH] Context fetch failed:', e.message);
    return { projectContext: null };
  }
}

// ── 5. NODE: workflowNode ─────────────────────────────────────────────────────
async function workflowNode(state) {
  const { messages, userMessage, projectContext: ctx, editingWorkflowId, role } = state;
  if (role !== 'admin') {
    return { finalReply: '⚠️ Only project admins can create or edit workflows. Please contact your admin.' };
  }

  const usedEvents = ctx?.usedTriggerEvents || [];
  const freeEvents = ['issue_created','issue_assigned','issue_transitioned','issue_commented','issue_updated','issue_deleted']
    .filter(e => !usedEvents.includes(e) || editingWorkflowId);

  const systemPrompt = `You are a workflow creation assistant for Jira automation.

## PROJECT STATE
- Active workflows: ${ctx?.workflowCount || 0}
${ctx?.workflows.map(w => `  • "${w.name}" — triggers: ${w.events.join(', ')}`).join('\n') || '  (none)'}
- Slack: ${ctx?.slackConnected ? `✅ Connected (${ctx.slackTeamName})` : '❌ Not connected'}
- GitHub: ${ctx?.githubConnected ? `✅ ${ctx.githubRepoUrl}` : '❌ Not connected'}
- Available trigger events: ${freeEvents.join(', ') || 'NONE — all events already used'}

## ENHANCEMENTS YOU CAN SUGGEST
- **AI Assignee Suggestions** (aiSuggestions): AI recommends best person to assign based on issue type
- **AI Solutions in Notifications** (aiSolutions): When issue is assigned, AI generates a suggested fix and includes it in the Slack/email/SMS notification so the assignee knows where to start
- **Auto GitHub Branch** (autoBranch): Automatically creates a branch in the linked GitHub repo when a bug is assigned

## YOUR JOB
Guide the user step by step. Ask clarifying questions. Once you have all info, confirm and output JSON.

## WORKFLOW JSON SCHEMA
{
  "name": "string",
  "trigger": { "events": ["issue_assigned"|"issue_created"|"issue_transitioned"|"issue_commented"|"issue_updated"|"issue_deleted"] },
  "notifications": {
    "issue_assigned": {
      "enabled": true,
      "slack": { "enabled": bool, "channelId": null },
      "email": { "enabled": bool, "priorities": { "low": bool, "medium": bool, "high": bool } },
      "sms": { "enabled": bool, "priorities": { "low": bool, "medium": bool, "high": bool } }
    }
  },
  "enhancements": {
    "aiSuggestions": bool,
    "aiSolutions": bool,
    "autoBranch": { "enabled": bool, "repoUrl": null }
  }
}

## RULES
- Only suggest events from the available list
- Only suggest Slack if Connected above
- Only suggest autoBranch if GitHub is Connected
- Always confirm full summary BEFORE outputting JSON
${editingWorkflowId ? '- This is an EDIT — mention what is changing.' : ''}`;

  const history = state.messages.slice(-14).map(m =>
    m._getType ? m : (m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content))
  );

  try {
    const result = await invokeLLM([
      new SystemMessage(systemPrompt),
      ...history,
      new HumanMessage(userMessage),
    ], 0.4);
    const reply = result.content;
    const jsonMatch = reply.match(/\[WORKFLOW_JSON_START\]([\s\S]*?)\[WORKFLOW_JSON_END\]/);
    if (jsonMatch) {
      try {
        const wfJSON = JSON.parse(jsonMatch[1].trim());
        const cleanReply = reply.replace(/\[WORKFLOW_JSON_START\][\s\S]*?\[WORKFLOW_JSON_END\]/, '').trim();
        return {
          finalReply: cleanReply || '✅ Workflow ready to save.',
          pendingWorkflowJSON: wfJSON,
          messages: [new HumanMessage(userMessage), new AIMessage(reply)],
        };
      } catch { /* malformed JSON */ }
    }
    return { finalReply: reply, messages: [new HumanMessage(userMessage), new AIMessage(reply)] };
  } catch (e) {
    if (isQuotaError(e)) return { finalReply: quotaMessage(e) };
    logger.error('[LANGGRAPH/workflowNode]', e.message);
    return { finalReply: `❌ Error building workflow: ${e.message}` };
  }
}

// ── 6. NODE: featureToggleNode ────────────────────────────────────────────────
async function featureToggleNode(state) {
  const { intentData, projectKey, role } = state;
  if (role !== 'admin') {
    return { finalReply: '⚠️ Only admins can change project features.', actionResult: { success: false } };
  }

  const featureName = intentData?.featureName;
  const enabled = intentData?.enabled;

  if (!featureName) {
    return {
      finalReply: `Which feature would you like to toggle?\n\n• **AI Assignee Suggestions** — AI recommends who to assign issues to\n• **AI Solutions in Notifications** — AI generates a fix suggestion and includes it in Slack/email/SMS when an issue is assigned\n• **Report Generation** — Generate project health reports\n• **Sentry Integration** — Auto-create Jira issues from Sentry errors\n\nJust say _"enable AI suggestions"_ or _"turn off reports"_.`,
    };
  }

  try {
    const projectDoc = await collections.projects.doc(projectKey).get();
    const currentFeatures = projectDoc.exists ? (projectDoc.data().features || {}) : {};

    const featureMap = {
      aiassigneesuggestions: 'aiAssigneeSuggestions',
      aisuggestions: 'aiAssigneeSuggestions',
      aisolutions: 'aiSolutions',
      aifixsuggestion: 'aiSolutions',
      reportgeneration: 'reportGeneration',
      reports: 'reportGeneration',
      sentryenabled: 'sentryEnabled',
      sentry: 'sentryEnabled',
    };
    const normalizedKey = featureName.toLowerCase().replace(/[^a-z]/g, '');
    const firestoreKey = featureMap[normalizedKey] || featureName;

    await collections.projects.doc(projectKey).set(
      { features: { ...currentFeatures, [firestoreKey]: enabled }, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    const friendlyName = {
      aiAssigneeSuggestions: 'AI Assignee Suggestions',
      aiSolutions: 'AI Solutions in Notifications',
      reportGeneration: 'Report Generation',
      sentryEnabled: 'Sentry Integration',
    }[firestoreKey] || firestoreKey;

    let detail = '';
    if (firestoreKey === 'aiSolutions' && enabled) {
      detail = '\n\nWhen active: every time an issue is assigned, Gemini will generate a **suggested fix** and attach it to the Slack/email/SMS notification so the assignee knows where to start.';
    } else if (firestoreKey === 'reportGeneration' && enabled) {
      detail = '\n\nThe **Reports** tab will now appear in your dashboard sidebar.';
    }

    const reply = enabled
      ? `✅ **${friendlyName}** has been **enabled**.${detail}`
      : `✅ **${friendlyName}** has been **disabled**. This is now reflected in Settings.`;

    logger.info(`[LANGGRAPH/featureToggle] ${firestoreKey} = ${enabled} on ${projectKey}`);
    return {
      finalReply: reply,
      actionResult: { success: true, feature: firestoreKey, enabled },
    };
  } catch (e) {
    logger.error('[LANGGRAPH/featureToggle]', e.message);
    return { finalReply: `❌ Failed to update feature: ${e.message}`, actionResult: { success: false } };
  }
}

// ── 7. NODE: viewWorkflowsNode ────────────────────────────────────────────────
// PURPOSE: Describe current workflows in natural language using Firestore data.

async function viewWorkflowsNode(state) {
  const { projectContext: ctx } = state;
  if (!ctx || !ctx.workflows.length) {
    return { finalReply: "📭 **No active workflows** yet for this project.\n\nSay **\"create a workflow\"** and I'll guide you through it step by step!" };
  }

  const lines = ctx.workflows.map((w, i) => {
    const notifChannels = [];
    Object.values(w.notifications).forEach(n => {
      if (n?.slack?.enabled) notifChannels.push('Slack DM');
      if (n?.channelId) notifChannels.push('Slack Channel');
      if (n?.email?.enabled) notifChannels.push('Email');
      if (n?.sms?.enabled) notifChannels.push('SMS');
    });
    const enhs = [];
    if (w.enhancements?.aiSuggestions) enhs.push('AI Suggestions');
    if (w.enhancements?.aiSolutions) enhs.push('AI Solutions');
    if (w.enhancements?.autoBranch?.enabled) enhs.push('Auto GitHub Branch');

    return `**${i+1}. ${w.name}**\n` +
      `   Triggers on: ${w.events.join(', ')}\n` +
      (notifChannels.length ? `   Notifications: ${notifChannels.join(', ')}\n` : '') +
      (enhs.length ? `   Enhancements: ${enhs.join(', ')}\n` : '');
  });

  const featList = [];
  if (ctx.features.aiAssigneeSuggestions) featList.push('✅ AI Assignee Suggestions');
  if (ctx.features.reportGeneration) featList.push('✅ Report Generation');
  if (ctx.features.sentryEnabled) featList.push('✅ Sentry Integration');

  let reply = `📋 **Active Workflows (${ctx.workflowCount})**\n\n${lines.join('\n')}\n`;
  if (featList.length) reply += `\n**Enabled Features:**\n${featList.join('\n')}`;
  reply += `\n\nSay **"create a workflow"**, **"edit [workflow name]"**, or **"disable [feature]"** to make changes.`;

  return { finalReply: reply };
}

// ── 8. NODE: generalNode ──────────────────────────────────────────────────────
async function generalNode(state) {
  const { messages, userMessage, projectContext: ctx, role } = state;

  const ctxLines = ctx ? [
    `Active workflows: ${ctx.workflowCount}`,
    `Slack: ${ctx.slackConnected ? 'Connected' : 'Not connected'}`,
    `GitHub: ${ctx.githubConnected ? 'Connected' : 'Not connected'}`,
    `Features: ${Object.entries(ctx.features).filter(([,v])=>v).map(([k])=>k).join(', ') || 'none enabled'}`,
  ].join('\n') : 'No project context loaded.';

  const systemPrompt = role === 'admin'
    ? `You are a helpful AI assistant for workflow management.\nProject context:\n${ctxLines}\n\nYou can help with:\n- Creating/editing workflows (say "create a workflow")\n- Toggling features: AI Assignee Suggestions, AI Solutions in Notifications, Report Generation, Sentry\n- AI Solutions: when enabled, every time an issue is assigned, Gemini generates a fix suggestion included in notifications\n- Viewing current workflows (say "show my workflows")\n- Answering questions about the system\n\nBe concise and friendly.`
    : `You are a helpful AI assistant for issue assignment.\nProject context:\n${ctxLines}\n\nYou can help with:\n- Suggesting the best assignee for a Jira issue\n- Explaining issue details and suggesting fixes\n- Sending notifications after assignment (Slack, email, SMS)\n- AI Solutions: if enabled, a fix suggestion is auto-included in notifications\n\nBe concise and friendly.`;

  const history = state.messages.slice(-10).map(m =>
    m._getType ? m : (m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content))
  );

  try {
    const result = await invokeLLM([
      new SystemMessage(systemPrompt),
      ...history,
      new HumanMessage(userMessage),
    ], 0.6);
    return {
      finalReply: result.content,
      messages: [new HumanMessage(userMessage), new AIMessage(result.content)],
    };
  } catch (e) {
    if (isQuotaError(e)) return { finalReply: quotaMessage(e) };
    logger.error('[LANGGRAPH/generalNode]', e.message);
    return { finalReply: `❌ Error: ${e.message}` };
  }
}

// ── 9. QUOTA SHORTCUT NODE ────────────────────────────────────────────────────
// When intentClassifier itself hits a quota error, we don't try any more LLM
// calls — we surface the message directly without traversing the rest of the graph.
async function quotaNode(state) {
  const secs = extractRetrySeconds(state.intentData?.error);
  return {
    finalReply: quotaMessage({ message: `retry in ${secs}s` }),
    intent: '__quota_exceeded__',
  };
}

// ── 10. CONDITIONAL ROUTER ────────────────────────────────────────────────────
function routeOnIntent(state) {
  const { intent } = state;
  if (intent === '__quota_exceeded__') return 'quotaNode';
  const routeMap = {
    create_workflow: 'workflowNode',
    edit_workflow: 'workflowNode',
    toggle_feature: 'featureToggleNode',
    view_workflows: 'viewWorkflowsNode',
    assign_issue: 'generalNode',
    run_report: 'generalNode',
    general: 'generalNode',
  };
  return routeMap[intent] || 'generalNode';
}

// ── 10. BUILD AND COMPILE THE GRAPH ──────────────────────────────────────────
// LANGGRAPH ADVANTAGE: The graph structure is EXPLICIT and visualizable.
// Unlike a deeply nested if-else tree, you can see the entire topology here.
// Each edge is a declared connection, not implicit control flow.

let _compiledGraph = null;

function buildGraph() {
  if (_compiledGraph) return _compiledGraph;

  const graph = new StateGraph(AgentState)
    .addNode('intentClassifier', intentClassifier)
    .addNode('contextFetcher', contextFetcher)
    .addNode('workflowNode', workflowNode)
    .addNode('featureToggleNode', featureToggleNode)
    .addNode('viewWorkflowsNode', viewWorkflowsNode)
    .addNode('generalNode', generalNode)
    .addNode('quotaNode', quotaNode)      // ← quota shortcut node

    .addEdge('__start__', 'intentClassifier')

    // If intentClassifier hit quota → go directly to quotaNode (no more LLM calls)
    // Otherwise → fetch Firestore context
    .addConditionalEdges('intentClassifier', (state) => {
      if (state.intent === '__quota_exceeded__') return 'quotaNode';
      return 'contextFetcher';
    }, {
      quotaNode: 'quotaNode',
      contextFetcher: 'contextFetcher',
    })

    .addConditionalEdges('contextFetcher', routeOnIntent, {
      workflowNode: 'workflowNode',
      featureToggleNode: 'featureToggleNode',
      viewWorkflowsNode: 'viewWorkflowsNode',
      generalNode: 'generalNode',
      quotaNode: 'quotaNode',
    })

    .addEdge('workflowNode', '__end__')
    .addEdge('featureToggleNode', '__end__')
    .addEdge('viewWorkflowsNode', '__end__')
    .addEdge('generalNode', '__end__')
    .addEdge('quotaNode', '__end__');

  _compiledGraph = graph.compile();
  logger.info('[LANGGRAPH] Graph compiled ✅');
  return _compiledGraph;
}

// ── 11. PUBLIC API ────────────────────────────────────────────────────────────
/**
 * Run the LangGraph agent for one turn.
 * @param {Object} opts
 * @param {string} opts.message - User's message
 * @param {Array}  opts.history - Previous { role, content } messages
 * @param {string} opts.projectKey
 * @param {string} opts.role - 'admin' | 'assigner'
 * @param {string} [opts.editingWorkflowId]
 * @returns {Promise<{ reply: string, pendingWorkflowJSON: object|null, intent: string, actionResult: object|null }>}
 */
async function runAgent(opts) {
  const { message, history = [], projectKey, role, editingWorkflowId } = opts;

  const graph = buildGraph();

  // Convert history to LangChain message objects
  const langChainHistory = history.slice(-20).map(m =>
    m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
  );

  const initialState = {
    messages: langChainHistory,
    userMessage: message,
    projectKey: projectKey || '',
    role: role || 'assigner',
    editingWorkflowId: editingWorkflowId || null,
    intent: 'general',
    intentData: {},
    projectContext: null,
    pendingWorkflowJSON: null,
    actionResult: null,
    finalReply: '',
  };

  try {
    const output = await graph.invoke(initialState);
    return {
      reply: output.finalReply || "I couldn't generate a response. Please try again.",
      pendingWorkflowJSON: output.pendingWorkflowJSON || null,
      intent: output.intent || 'general',
      actionResult: output.actionResult || null,
    };
  } catch (e) {
    logger.error('[LANGGRAPH] Graph execution failed:', e.message);
    try {
      const { chatCompletion } = require('./openai');
      const histMsgs = history.slice(-10).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
      const reply = await chatCompletion([...histMsgs, { role: 'user', content: message }]);
      return { reply, pendingWorkflowJSON: null, intent: 'general', actionResult: null };
    } catch (fallbackErr) {
      return { reply: `❌ Agent error: ${e.message}`, pendingWorkflowJSON: null, intent: 'general', actionResult: null };
    }
  }
}

module.exports = { runAgent, buildGraph };

