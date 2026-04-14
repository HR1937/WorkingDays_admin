/**
 * ai-workflow-chat.js
 * Admin AI chat (blue theme) — uses LangGraph backend.
 * Features accessible via chat:
 *   - Create / edit workflows
 *   - Toggle features (AI suggestions, report generation, Sentry)
 *   - View current workflows
 *   - General help
 */

const WorkflowAIChat = (() => {
  'use strict';

  let chatHistory = [];
  let editingWorkflowId = null;
  let editingWorkflowName = null;
  let pendingWorkflowJSON = null;
  let projectKey = null;
  let isTyping = false;

  const el  = id => document.getElementById(id);
  const esc = s  => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init(pKey) {
    projectKey = pKey;
    editingWorkflowId = null;
    editingWorkflowName = null;
    pendingWorkflowJSON = null;
    chatHistory = [];
    renderShell();
    await loadHistory();
    if (chatHistory.length === 0) await sendWelcomeMessage();
  }

  async function initEdit(pKey, wfId, wfName, wfData) {
    projectKey = pKey;
    editingWorkflowId = wfId;
    editingWorkflowName = wfName;
    pendingWorkflowJSON = null;
    chatHistory = [];
    renderShell();
    const summary = buildWorkflowSummary(wfData);
    const editPrompt = `I want to edit the workflow "${wfName}". Current configuration:\n\n${summary}\n\nWhat would you like to change?`;
    addMessage('user', editPrompt, false);
    await sendToAI(editPrompt, true);
  }

  // ── Shell ─────────────────────────────────────────────────────────────────
  function renderShell() {
    const container = el('ai-chat-container');
    if (!container) return;
    container.innerHTML = `
      <div id="wf-chat-messages" style="
        flex:1;overflow-y:auto;padding:20px 28px;display:flex;flex-direction:column;gap:14px;
        background:#f8faff;min-height:0;
      "></div>

      <!-- Suggested prompts -->
      <div id="wf-suggestions" style="padding:10px 28px 0;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0;">
        <button class="wf-suggestion" onclick="WorkflowAIChat.suggest('Create a new workflow')">+ New workflow</button>
        <button class="wf-suggestion" onclick="WorkflowAIChat.suggest('Show my current workflows')">📋 View workflows</button>
        <button class="wf-suggestion" onclick="WorkflowAIChat.suggest('Enable AI assignee suggestions')">🤖 Enable AI suggestions</button>
        <button class="wf-suggestion" onclick="WorkflowAIChat.suggest('Disable report generation')">📊 Disable reports</button>
      </div>

      <div style="padding:14px 20px 16px;border-top:1.5px solid #d1d9f0;background:#fff;flex-shrink:0;">
        <div style="display:flex;gap:10px;align-items:flex-end;">
          <div style="flex:1;min-width:0;position:relative;">
            <textarea
              id="wf-chat-input"
              placeholder="Ask about workflows, toggle features, or say 'enable AI suggestions'..."
              rows="1"
              style="
                width:100%;padding:13px 50px 13px 16px;
                background:#f8faff;border:1.5px solid #d1d9f0;border-radius:12px;
                color:#0f172a;font-size:14px;line-height:1.55;resize:none;outline:none;
                font-family:inherit;transition:border-color .2s,box-shadow .2s;
                max-height:150px;overflow-y:auto;
              "
              onkeydown="WorkflowAIChat.handleKey(event)"
              oninput="WorkflowAIChat.autoResize(this)"
              onfocus="this.style.borderColor='#2563eb';this.style.boxShadow='0 0 0 3px rgba(37,99,235,.12)'"
              onblur="this.style.borderColor='#d1d9f0';this.style.boxShadow='none'"
            ></textarea>
            <button
              id="wf-chat-send"
              onclick="WorkflowAIChat.send()"
              style="
                position:absolute;right:10px;bottom:10px;
                width:32px;height:32px;border-radius:9px;border:none;
                background:linear-gradient(135deg,#2563eb,#3b82f6);
                color:#fff;cursor:pointer;display:flex;align-items:center;
                justify-content:center;font-size:15px;font-weight:700;
                box-shadow:0 2px 8px rgba(37,99,235,.3);transition:all .2s;
              "
              onmouseover="this.style.background='linear-gradient(135deg,#1d4ed8,#2563eb)'"
              onmouseout="this.style.background='linear-gradient(135deg,#2563eb,#3b82f6)'"
            >↑</button>
          </div>
          <button
            onclick="WorkflowAIChat.clearChat()"
            title="New conversation"
            style="
              width:42px;height:42px;border-radius:10px;
              border:1.5px solid #d1d9f0;background:#fff;
              color:#94a3b8;cursor:pointer;font-size:14px;
              display:flex;align-items:center;justify-content:center;flex-shrink:0;
              transition:all .2s;
            "
            onmouseover="this.style.borderColor='#2563eb';this.style.color='#2563eb'"
            onmouseout="this.style.borderColor='#d1d9f0';this.style.color='#94a3b8'"
          >✕</button>
        </div>
        <p style="text-align:center;font-size:10.5px;color:#94a3b8;margin-top:7px;">
          Powered by <strong>LangGraph + Gemini</strong> · Changes take effect immediately
        </p>
      </div>
    `;

    // Suggestion pill CSS
    if (!document.getElementById('wf-suggestion-style')) {
      const s = document.createElement('style');
      s.id = 'wf-suggestion-style';
      s.textContent = `.wf-suggestion{padding:5px 12px;border-radius:16px;border:1.5px solid #d1d9f0;background:#fff;color:#2563eb;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;white-space:nowrap;} .wf-suggestion:hover{background:#dbeafe;border-color:#93c5fd;}`;
      document.head.appendChild(s);
    }

    setTimeout(() => el('wf-chat-input')?.focus(), 100);
  }

  // ── History ───────────────────────────────────────────────────────────────
  async function loadHistory() {
    try {
      const res = await fetch('/ai/chat/history', { headers: { 'x-project-key': projectKey } });
      const data = await res.json();
      chatHistory = data.messages || [];
      if (!editingWorkflowId) {
        chatHistory.forEach(m => addMessage(m.role === 'user' ? 'user' : 'ai', m.content, false));
        scrollToBottom();
      }
    } catch { /* ok */ }
  }

  // ── Welcome ───────────────────────────────────────────────────────────────
  async function sendWelcomeMessage() {
    showTyping();
    try {
      const r = await fetch('/ai/context', { headers: { 'x-project-key': projectKey } });
      const ctx = await r.json();
      let msg = `👋 Welcome! I'm your **Workflow AI** — here's your project status:\n\n`;
      msg += `**Workflows:** ${ctx.workflowCount || 0} active\n`;
      if (ctx.workflows?.length) ctx.workflows.forEach(w => { msg += `• _${esc(w.name)}_ — triggers: ${w.events.join(', ')}\n`; });
      msg += `\n**Integrations:** Slack ${ctx.slackConnected ? '✅' : '❌'} · GitHub ${ctx.githubConnected ? '✅' : '❌'}\n`;
      if (ctx.features) {
        const feats = [];
        if (ctx.features.aiAssigneeSuggestions) feats.push('AI Assignee Suggestions ✅');
        if (ctx.features.reportGeneration) feats.push('Report Generation ✅');
        if (ctx.features.sentryEnabled) feats.push('Sentry ✅');
        if (feats.length) msg += `**Features:** ${feats.join(' · ')}\n`;
      }
      msg += `\n**You can say:**\n• _"Create a workflow that notifies via Slack when bugs are assigned"_\n• _"Enable AI assignee suggestions"_\n• _"Disable report generation"_\n• _"Show my workflows"_`;
      hideTyping();
      addMessage('ai', msg, false);
    } catch {
      hideTyping();
      addMessage('ai', '👋 Welcome! Tell me what workflow you want to create, or ask me to toggle a feature.', false);
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  async function send() {
    const input = el('wf-chat-input');
    const text = input?.value?.trim();
    if (!text || isTyping) return;
    input.value = '';
    autoResize(input);
    addMessage('user', text, true);
    chatHistory.push({ role: 'user', content: text });
    await sendToAI(text, false);
  }

  function suggest(text) {
    const input = el('wf-chat-input');
    if (input) { input.value = text; input.focus(); }
    send();
  }

  async function sendToAI(text, skipHistory) {
    isTyping = true;
    showTyping();
    const sendBtn = el('wf-chat-send');
    if (sendBtn) sendBtn.disabled = true;

    try {
      const res = await fetch('/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-project-key': projectKey },
        body: JSON.stringify({
          message: text,
          history: chatHistory.slice(-18),
          editingWorkflowId: editingWorkflowId || null,
        }),
      });

      // Safely parse — server may return HTML on unexpected crash
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        // If server returned HTML (Express error page), show a clean error
        const isHtml = rawText.trimStart().startsWith('<');
        throw new Error(isHtml
          ? `Server error (${res.status}). The AI agent encountered an unexpected error. Please try again.`
          : `Unexpected response: ${rawText.slice(0, 120)}`);
      }

      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      const reply = data.reply;
      chatHistory.push({ role: 'assistant', content: reply });

      hideTyping();

      // If the agent returned a feature action result, show a toast
      if (data.actionResult?.success && data.intent === 'toggle_feature') {
        showActionToast(`Feature ${data.actionResult.enabled ? 'enabled' : 'disabled'}: ${data.actionResult.feature}`);
        if (typeof window.loadSettings === 'function') setTimeout(() => window.loadSettings(), 600);
      }

      // Check for workflow JSON
      const jsonMatch = reply.match(/\[WORKFLOW_JSON_START\]([\s\S]*?)\[WORKFLOW_JSON_END\]/);
      if (jsonMatch) {
        try {
          pendingWorkflowJSON = JSON.parse(jsonMatch[1].trim());
          const cleanReply = reply.replace(/\[WORKFLOW_JSON_START\][\s\S]*?\[WORKFLOW_JSON_END\]/, '').trim();
          addMessage('ai', cleanReply || '✅ Workflow ready to save.', false);
          showWorkflowPreview(pendingWorkflowJSON);
        } catch { addMessage('ai', reply, false); }
      } else {
        addMessage('ai', reply, false);
      }
    } catch (e) {
      hideTyping();
      addMessage('ai', `❌ ${esc(e.message)}`, false);
    } finally {
      isTyping = false;
      if (sendBtn) sendBtn.disabled = false;
      el('wf-chat-input')?.focus();
    }
  }


  // ── Messages ──────────────────────────────────────────────────────────────
  function addMessage(role, content, save) {
    const messages = el('wf-chat-messages');
    if (!messages) return;
    const isUser = role === 'user';
    const div = document.createElement('div');
    div.style.cssText = `display:flex;flex-direction:column;align-items:${isUser?'flex-end':'flex-start'};gap:4px;`;

    if (!isUser) {
      div.innerHTML = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
        <div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#3b82f6);display:flex;align-items:center;justify-content:center;font-size:12px;box-shadow:0 2px 6px rgba(37,99,235,.25);">🤖</div>
        <span style="font-size:11px;color:#2563eb;font-weight:700;">Workflow AI</span>
      </div>`;
    }

    const bubble = document.createElement('div');
    bubble.style.cssText = `
      max-width:78%;padding:12px 16px;border-radius:${isUser?'18px 18px 4px 18px':'4px 18px 18px 18px'};
      font-size:14px;line-height:1.65;word-wrap:break-word;
      background:${isUser?'linear-gradient(135deg,#2563eb,#3b82f6)':'#fff'};
      color:${isUser?'#fff':'#0f172a'};
      border:${isUser?'none':'1.5px solid #d1d9f0'};
      box-shadow:${isUser?'0 2px 12px rgba(37,99,235,.25)':'0 2px 8px rgba(0,0,0,.05)'};
    `;
    bubble.innerHTML = mdToHtml(content);
    div.appendChild(bubble);
    messages.appendChild(div);
    scrollToBottom();
  }

  // ── Workflow Preview Card ─────────────────────────────────────────────────
  function showWorkflowPreview(wfData) {
    const messages = el('wf-chat-messages');
    if (!messages) return;
    const events = wfData.trigger?.events?.join(', ') || '—';
    const channels = [];
    Object.values(wfData.notifications||{}).forEach(n => {
      if (n?.slack?.enabled || n?.channelId) channels.push('Slack');
      if (n?.email?.enabled) channels.push('Email');
      if (n?.sms?.enabled) channels.push('SMS');
    });
    const enhancements = [];
    if (wfData.enhancements?.aiSuggestions) enhancements.push('AI Suggestions');
    if (wfData.enhancements?.aiSolutions) enhancements.push('AI Solutions');
    if (wfData.enhancements?.autoBranch?.enabled) enhancements.push('Auto GitHub Branch');

    const card = document.createElement('div');
    card.style.cssText = `
      max-width:82%;
      background:linear-gradient(135deg,#eff6ff,#dbeafe);
      border:1.5px solid #93c5fd;border-radius:14px;padding:18px;
      box-shadow:0 4px 20px rgba(37,99,235,.12);
    `;
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <span style="font-size:16px;">📋</span>
        <span style="font-size:12px;font-weight:700;color:#2563eb;text-transform:uppercase;letter-spacing:.5px;">Workflow Ready to Save</span>
      </div>
      <div style="font-size:18px;font-weight:800;color:#0f172a;margin-bottom:10px;">${esc(wfData.name||'New Workflow')}</div>
      <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:14px;">
        <div style="font-size:12px;color:#475569;"><span style="color:#2563eb;font-weight:600;">Triggers on:</span> ${esc(events)}</div>
        ${channels.length ? `<div style="font-size:12px;color:#475569;"><span style="color:#2563eb;font-weight:600;">Notifications:</span> ${[...new Set(channels)].join(', ')}</div>` : ''}
        ${enhancements.length ? `<div style="font-size:12px;color:#475569;"><span style="color:#2563eb;font-weight:600;">Enhancements:</span> ${enhancements.join(', ')}</div>` : ''}
      </div>
      <div style="display:flex;gap:8px;">
        <button onclick="WorkflowAIChat.saveWorkflow()" style="
          flex:1;padding:10px 16px;border:none;border-radius:9px;cursor:pointer;
          background:linear-gradient(135deg,#2563eb,#3b82f6);color:#fff;
          font-size:13px;font-weight:700;font-family:inherit;
          box-shadow:0 2px 8px rgba(37,99,235,.3);transition:opacity .2s;
        " onmouseover="this.style.opacity='.88'" onmouseout="this.style.opacity='1'">
          ✅ ${editingWorkflowId ? 'Update Workflow' : 'Save Workflow'}
        </button>
        <button onclick="WorkflowAIChat.discardWorkflow()" style="
          padding:10px 16px;border:1.5px solid #d1d9f0;border-radius:9px;cursor:pointer;
          background:#fff;color:#94a3b8;font-size:13px;font-weight:600;font-family:inherit;
        ">✕ Discard</button>
      </div>
      <div id="wf-save-status" style="margin-top:8px;font-size:12px;"></div>
    `;
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;';
    wrapper.appendChild(card);
    messages.appendChild(wrapper);
    scrollToBottom();
  }

  async function saveWorkflow() {
    if (!pendingWorkflowJSON) return;
    const statusEl = el('wf-save-status');
    if (statusEl) statusEl.innerHTML = '<span style="color:#94a3b8;">⏳ Saving...</span>';
    try {
      const res = await fetch('/ai/workflow/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-project-key': projectKey },
        body: JSON.stringify({ workflowData: pendingWorkflowJSON, editWorkflowId: editingWorkflowId || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          if (statusEl) statusEl.innerHTML = `<span style="color:#dc2626;">❌ Trigger event "${data.conflict}" already used by "${data.existingWorkflow?.name}"</span>`;
          addMessage('ai', `⚠️ **Conflict:** The trigger event \`${data.conflict}\` is already used by **"${data.existingWorkflow?.name}"**. Would you like to use different trigger events or edit that workflow instead?`, false);
        } else throw new Error(data.error);
        return;
      }
      pendingWorkflowJSON = null;
      editingWorkflowId = null;
      if (statusEl) statusEl.innerHTML = `<span style="color:#16a34a;">✅ ${data.action === 'updated' ? 'Updated!' : 'Created!'}</span>`;
      addMessage('ai', `🎉 **Workflow ${data.action === 'updated' ? 'updated' : 'created'} successfully!** It's now active. You can see it in **Current Workflows** in the sidebar.\n\nAnything else? You can:\n• Create another workflow\n• Enable/disable features\n• Say "show my workflows" to review`, false);
      if (typeof window.loadWorkflows === 'function') setTimeout(() => window.loadWorkflows(), 600);
      const badge = el('wf-edit-badge');
      if (badge) badge.style.display = 'none';
    } catch (e) {
      if (statusEl) statusEl.innerHTML = `<span style="color:#dc2626;">❌ ${esc(e.message)}</span>`;
    }
  }

  function discardWorkflow() {
    pendingWorkflowJSON = null;
    addMessage('ai', "Got it — workflow discarded. Let me know if you want to adjust the configuration or start fresh.", false);
  }

  async function clearChat() {
    chatHistory = []; editingWorkflowId = null; editingWorkflowName = null; pendingWorkflowJSON = null;
    renderShell();
    await sendWelcomeMessage();
  }

  // ── UI helpers ────────────────────────────────────────────────────────────
  function showTyping() {
    const messages = el('wf-chat-messages');
    if (!messages) return;
    const d = document.createElement('div');
    d.id = 'wf-typing-indicator';
    d.style.cssText = 'display:flex;align-items:center;gap:8px;';
    d.innerHTML = `
      <div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#3b82f6);display:flex;align-items:center;justify-content:center;font-size:12px;box-shadow:0 2px 6px rgba(37,99,235,.25);">🤖</div>
      <div style="background:#fff;border:1.5px solid #d1d9f0;border-radius:4px 18px 18px 18px;padding:12px 16px;display:flex;gap:5px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.05);">
        <span style="width:7px;height:7px;border-radius:50%;background:#2563eb;animation:wf-bounce .8s ease-in-out infinite;display:inline-block;"></span>
        <span style="width:7px;height:7px;border-radius:50%;background:#2563eb;animation:wf-bounce .8s ease-in-out .16s infinite;display:inline-block;"></span>
        <span style="width:7px;height:7px;border-radius:50%;background:#2563eb;animation:wf-bounce .8s ease-in-out .32s infinite;display:inline-block;"></span>
      </div>`;
    messages.appendChild(d);
    scrollToBottom();
  }

  function hideTyping() { el('wf-typing-indicator')?.remove(); }
  function scrollToBottom() { const m = el('wf-chat-messages'); if (m) m.scrollTop = m.scrollHeight; }

  function showActionToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;padding:10px 18px;background:#2563eb;color:#fff;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 4px 16px rgba(37,99,235,.35);transition:opacity .3s;';
    t.textContent = '✅ ' + msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }

  function mdToHtml(text) {
    return text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,'<em>$1</em>')
      .replace(/_(.+?)_/g,'<em>$1</em>')
      .replace(/`([^`]+)`/g,'<code style="background:#dbeafe;padding:1px 5px;border-radius:4px;font-family:monospace;font-size:12px;color:#1d4ed8;">$1</code>')
      .replace(/\n/g,'<br>');
  }

  function buildWorkflowSummary(wfData) {
    if (!wfData) return 'Unknown configuration';
    const lines = [];
    lines.push(`**Name:** ${wfData.name || '—'}`);
    lines.push(`**Triggers:** ${wfData.trigger?.events?.join(', ') || '—'}`);
    Object.entries(wfData.notifications||{}).forEach(([event, config]) => {
      if (!config?.enabled) return;
      const channels = [];
      if (config.slack?.enabled) channels.push('Slack');
      if (config.email?.enabled) channels.push('Email');
      if (config.sms?.enabled) channels.push('SMS');
      if (config.channelId) channels.push('Slack channel');
      if (channels.length) lines.push(`**${event} → notifications:** ${channels.join(', ')}`);
    });
    const enh = wfData.enhancements || {};
    if (enh.aiSuggestions) lines.push('**Enhancement:** AI Assignee Suggestions');
    if (enh.aiSolutions) lines.push('**Enhancement:** AI Solutions in Notifications');
    if (enh.autoBranch?.enabled) lines.push(`**Enhancement:** Auto GitHub Branch (${enh.autoBranch.repoUrl || 'no repo'})`);
    return lines.join('\n');
  }

  return { init, initEdit, send, suggest, handleKey, autoResize, saveWorkflow, discardWorkflow, clearChat };
})();
