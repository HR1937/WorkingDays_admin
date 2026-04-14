/**
 * bugsense.js — AI-powered issue assignment (BugSense frontend)
 * Uses LangGraph backend via /ai/chat for general queries.
 * Direct API calls for assignment and notification actions.
 */
'use strict';
const API = '/bugsense/api';

const S = {
  session: null,
  issue: null,
  priority: 'Medium',
  assignedTo: null,
  assignedContact: { slack: '', phone: '', email: '' },
  wf: { aiAssignee: false, aiSolution: false, notifySlack: false, notifySms: false, notifyEmail: false, priorityChannels: {} },
  chatHistory: [],
  isTyping: false,
  assignableUsers: [],
  aiSolution: null,
  allIssues: [],
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const el  = id => document.getElementById(id);
const esc = s  => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

async function apiFetch(url, opts = {}) {
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401) { window.location.href = '/login'; throw new Error('Session expired'); }
  const d = await r.json().catch(() => { throw new Error('Invalid JSON from server'); });
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const page = el('page-' + name);
  if (page) page.classList.add('active');
  if (btn) btn.classList.add('active');
  if (name === 'projects') loadProjects();
  if (name === 'create') initCreateIssueTab();
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
}

function autoResizeChat(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 130) + 'px';
}

// ── Priority Picker ───────────────────────────────────────────────────────────
function setPriority(p, btn) {
  S.priority = p;
  document.querySelectorAll('.p-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Update context bar
  const icons = { High: '🔴', Medium: '🟡', Low: '🟢' };
  const ctxPriority = el('ctx-priority');
  if (ctxPriority) {
    ctxPriority.textContent = `${icons[p]} ${p} Priority`;
    ctxPriority.style.display = 'inline-flex';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const d = await apiFetch('/api/session');
    S.session = d.user;
    if (el('user-name')) el('user-name').textContent = d.user?.displayName || '';
    const m = d.user?.projectMember;
    if (m) {
      S.assignedContact.phone = m.phoneNumber || '';
      S.assignedContact.slack = m.slackMemberId || m.slackUserId || '';
    }
    S.assignedContact.email = d.user?.email || '';

    const pKey = new URLSearchParams(window.location.search).get('project') || d.user?.jiraProjectKey;
    await loadWorkflowConfig(pKey);
    await loadIssues();

    addAIMessage(buildWelcome(d.user?.displayName));
  } catch (e) {
    console.error('[Init]', e.message);
    addAIMessage('⚠️ Failed to load session. Please <a href="/login" style="color:var(--accent)">log in again</a>.');
  }
}

function buildWelcome(name) {
  const n = name ? `Hi **${name}**! ` : 'Hi! ';
  const lines = [];
  if (S.wf.aiAssignee) lines.push('🤖 **AI Assignee Suggestions** — I can recommend who to assign based on issue type and team expertise');
  else lines.push('👥 Manual assignment — select a team member from the list');
  if (S.wf.aiSolution) lines.push('💡 **AI Solutions** — when you assign an issue, I\'ll generate a suggested fix and include it in the notification so your assignee knows where to start');

  return `${n}I'm your **BugSense AI**.

${lines.join('\n')}

**How to start:**
• Click any issue in the sidebar
• Set a priority using the **High / Medium / Low** pills
• I'll guide you through assignment and notification`;
}

// ── Workflow Config ───────────────────────────────────────────────────────────
async function loadWorkflowConfig(projectKey) {
  try {
    const cfg = await apiFetch(`${API}/workflow-config?projectKey=${encodeURIComponent(projectKey || '')}`);
    S.wf = { ...S.wf, ...cfg };
    if (el('wf-badge') && cfg.workflows?.length) {
      el('wf-badge').textContent = `${cfg.workflows.length} active workflow${cfg.workflows.length > 1 ? 's' : ''}`;
      el('wf-badge').style.display = 'inline-flex';
    }
  } catch (e) { console.warn('[WF Config]', e.message); }
}

// ── Issue List ────────────────────────────────────────────────────────────────
async function loadIssues() {
  el('issue-list').innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);font-size:12px;"><div class="spin" style="margin:0 auto 10px;"></div>Loading...</div>';
  try {
    const pKey = new URLSearchParams(window.location.search).get('project') || S.session?.jiraProjectKey;
    const data = await apiFetch(`${API}/issues${pKey ? '?project=' + pKey : ''}`);
    S.allIssues = data.issues || [];
    renderIssueList(S.allIssues);
  } catch (e) {
    el('issue-list').innerHTML = `<div style="color:var(--red);font-size:12px;padding:12px;">${esc(e.message)}</div>`;
  }
}

function renderIssueList(issues) {
  if (!issues.length) {
    el('issue-list').innerHTML = '<p style="color:var(--muted);font-size:12px;text-align:center;padding:20px;">No issues found.</p>';
    return;
  }
  const unassigned = issues.filter(i => !i.fields?.assignee);
  const assigned   = issues.filter(i => i.fields?.assignee);
  let html = '';
  if (unassigned.length) html += `<div class="issue-label">🔴 Unassigned (${unassigned.length})</div>` + unassigned.map(renderCard).join('');
  if (assigned.length)   html += `<div class="issue-label" style="margin-top:8px;">✅ Assigned (${assigned.length})</div>` + assigned.map(renderCard).join('');
  el('issue-list').innerHTML = html;
}

function filterIssues(query) {
  const q = query.trim().toLowerCase();
  if (!q) { renderIssueList(S.allIssues); return; }
  const filtered = S.allIssues.filter(i =>
    (i.key || '').toLowerCase().includes(q) ||
    (i.fields?.summary || '').toLowerCase().includes(q) ||
    (i.fields?.priority?.name || '').toLowerCase().includes(q) ||
    (i.fields?.assignee?.displayName || '').toLowerCase().includes(q)
  );
  renderIssueList(filtered);
}

function renderCard(issue) {
  const p  = issue.fields?.priority?.name || 'Medium';
  const pc = (p==='High'||p==='Highest') ? 'tag-high' : p==='Medium' ? 'tag-medium' : 'tag-low';
  return `<div class="icard${!issue.fields?.assignee ? ' unassigned' : ''}" id="ic-${issue.id}" onclick='selectIssue(${JSON.stringify(JSON.stringify(issue))})'>
    <div class="icard-key">${esc(issue.key)}</div>
    <div class="icard-title">${esc(issue.fields?.summary || '')}</div>
    <div class="icard-meta">
      <span class="tag ${pc}">${esc(p)}</span>
      <span class="tag tag-type">${esc(issue.fields?.issuetype?.name || 'Task')}</span>
      <span class="tag tag-status">${esc(issue.fields?.status?.name || 'To Do')}</span>
      <span style="font-size:10px;color:var(--muted);margin-left:auto;">${esc(issue.fields?.assignee?.displayName || 'Unassigned')}</span>
    </div>
  </div>`;
}

// ── Select Issue ──────────────────────────────────────────────────────────────
async function selectIssue(json) {
  const issue = JSON.parse(json);
  S.issue = issue;
  S.assignedTo = null;
  S.aiSolution = null;

  // Update sidebar active state
  document.querySelectorAll('.icard').forEach(c => c.classList.remove('active'));
  el(`ic-${issue.id}`)?.classList.add('active');

  // Update context bar
  const ctxIssue = el('ctx-issue');
  if (ctxIssue) ctxIssue.innerHTML = `<strong style="color:var(--accent)">${esc(issue.key)}</strong> <span style="color:var(--sub)">— ${esc((issue.fields?.summary||'').slice(0,50))}${issue.fields?.summary?.length>50?'…':''}</span>`;
  el('ctx-priority').style.display = 'inline-flex';
  el('ctx-assigned').style.display = 'none';

  const f = issue.fields || {};
  const p = f.priority?.name || 'Medium';
  const desc = extractDesc(f.description);

  let msg = `📌 **${esc(issue.key)}: ${esc(f.summary)}**\n`;
  msg += `Priority: **${p}** · Type: ${esc(f.issuetype?.name||'Task')} · Status: ${esc(f.status?.name||'To Do')}\n`;
  msg += f.assignee ? `Assigned to: **${esc(f.assignee.displayName)}**\n` : `**Unassigned** 🔴\n`;
  if (desc) msg += `\n${esc(desc.slice(0,250))}${desc.length>250?'…':''}`;
  addAIMessage(msg);

  // Action buttons
  addActionCard(() => `
    <div style="font-size:12px;color:var(--sub);margin-bottom:10px;">What would you like to do with <strong style="color:var(--text)">${esc(issue.key)}</strong>?</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${S.wf.aiAssignee ? `<button class="btn btn-primary btn-sm" onclick="runAISuggest()">🤖 AI Suggest Assignee</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="showManualList()">👥 Manual Assign</button>
      <button class="btn btn-ghost btn-sm" onclick="sendChatDirectly('Analyze the issue ${esc(issue.key)}: ${esc(f.summary||'')}. Who is best suited and what might the fix involve?')">🔍 Analyze</button>
      <button class="btn btn-ghost btn-sm" onclick="openCreateForIssue(${JSON.stringify(JSON.stringify(issue))})">📝 Report Issue</button>
    </div>
  `);

  if (S.wf.aiSolution && !f.assignee) {
    try {
      const sol = await apiFetch(`${API}/ai/solution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: issue.key, summary: f.summary, description: desc, type: f.issuetype?.name }),
      });
      if (sol.solution) {
        S.aiSolution = sol.solution;
        addAIMessage(`💡 **AI Suggested Fix:**\n\n${esc(sol.solution)}`);
      }
    } catch { /* not critical */ }
  }
  scrollChat();
}

// ── AI Suggest ────────────────────────────────────────────────────────────────
async function runAISuggest() {
  const issue = S.issue;
  if (!issue) return;
  addUserMessage('🤖 Get AI assignee suggestion');
  addTypingIndicator();
  try {
    const f = issue.fields || {};
    const d = await apiFetch(`${API}/assign/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: issue.key, summary: f.summary, description: extractDesc(f.description), type: f.issuetype?.name, priority: S.priority }),
    });
    removeTypingIndicator();
    S.assignedContact.slack = d.slackMemberId || d.slackUserId || '';
    S.assignedContact.phone = d.phoneNumber || '';
    S.assignedContact.email = d.email || d.emailAddress || '';

    const confColor = d.confidence==='High' ? 'var(--green)' : d.confidence==='Medium' ? 'var(--yellow)' : 'var(--red)';
    const lvl = d.confidence==='High' ? '🟢' : d.confidence==='Medium' ? '🟡' : '🔴';
    addAIMessage(`${lvl} **AI suggests: ${esc(d.suggestedAssignee)}**\nConfidence: **${d.confidence}**\n\n${esc(d.reason)}`);
    addActionCard(() => `
      <div style="font-size:12px;color:var(--sub);margin-bottom:10px;">Assign to <strong style="color:var(--text)">${esc(d.suggestedAssignee)}</strong>?</div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary btn-sm" onclick="confirmAssign('${esc(d.accountId)}','${esc(d.suggestedAssignee).replace(/'/g,"\\'")}')">✅ Confirm & Assign</button>
        <button class="btn btn-ghost btn-sm" onclick="showManualList()">👥 Choose Someone Else</button>
      </div>
    `);
  } catch (e) {
    removeTypingIndicator();
    addAIMessage(`❌ ${esc(e.message)}`);
  }
}

// ── Manual List ───────────────────────────────────────────────────────────────
async function showManualList() {
  addUserMessage('👥 Show team members');
  addTypingIndicator();
  try {
    const pKey = new URLSearchParams(window.location.search).get('project') || S.session?.jiraProjectKey;
    const users = await apiFetch(`${API}/users/assignable?project=${encodeURIComponent(pKey||'')}`);
    S.assignableUsers = users;
    removeTypingIndicator();
    if (!users.length) { addAIMessage('No assignable team members found.'); return; }
    addAIMessage(`Found **${users.length} team member${users.length>1?'s':''}** — click to assign:`);
    addActionCard(() => {
      const chips = users.map(u =>
        `<button class="user-chip" onclick="confirmAssign('${esc(u.accountId)}','${esc(u.displayName||'').replace(/'/g,"\\'")}')">
          <div class="avatar-sm">${(u.displayName||'?')[0].toUpperCase()}</div>
          <div>
            <div style="font-size:12px;font-weight:600;">${esc(u.displayName)}</div>
            <div style="font-size:10px;color:var(--muted);">${esc(u.emailAddress||'')}</div>
          </div>
        </button>`).join('');
      return `<div style="font-size:12px;color:var(--sub);margin-bottom:10px;">Select a team member:</div><div style="display:flex;flex-wrap:wrap;gap:2px;">${chips}</div>`;
    });
  } catch (e) {
    removeTypingIndicator();
    addAIMessage(`❌ ${esc(e.message)}`);
  }
}

// ── Confirm Assign ────────────────────────────────────────────────────────────
async function confirmAssign(accountId, displayName) {
  if (!S.issue) return;
  addUserMessage(`Assign ${esc(S.issue.key)} to ${esc(displayName)}`);
  addTypingIndicator();
  try {
    await apiFetch(`${API}/assign/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueId: S.issue.key, accountId, assigneeName: displayName }),
    });
    S.assignedTo = { accountId, displayName };

    // ✅ Fresh contact fetch from server
    try {
      const cr = await apiFetch(`${API}/member/contact/${accountId}`);
      if (cr.found && cr.contact) {
        S.assignedContact.slack = cr.contact.slackMemberId || '';
        S.assignedContact.phone = cr.contact.phoneNumber || '';
        S.assignedContact.email = cr.contact.email || '';
      }
    } catch {
      const match = S.assignableUsers.find(u => u.accountId === accountId);
      if (match) S.assignedContact.email = match.emailAddress || '';
    }

    removeTypingIndicator();
    // Update context bar
    const ca = el('ctx-assigned');
    if (ca) { ca.textContent = `✅ Assigned to ${displayName}`; ca.style.display = 'inline'; }
    addAIMessage(`✅ **${esc(S.issue.key)} assigned to ${esc(displayName)}** successfully!\n\nPriority: **${S.priority}**`);
    showNotifyPanel(displayName);
    loadIssues();
  } catch (e) {
    removeTypingIndicator();
    addAIMessage(`❌ Assignment failed: ${esc(e.message)}`);
  }
}

// ── Notify Panel ──────────────────────────────────────────────────────────────
function showNotifyPanel(assigneeName) {
  const p = S.priority;
  const isHigh = (p==='High'||p==='Highest');
  const isMedium = p==='Medium';

  const channels = [];
  if (S.wf.notifySlack || isHigh) channels.push('slack');
  if (S.wf.notifySms && isHigh) channels.push('sms');
  if (S.wf.notifyEmail) channels.push('email');
  // Deduplicate
  const uniqueChannels = [...new Set(channels)];

  const labels = { sms:'📱 SMS', slack:'💬 Slack', email:'📧 Email' };
  const contactMap = { sms: S.assignedContact.phone, slack: S.assignedContact.slack, email: S.assignedContact.email };

  const channelBadges = uniqueChannels.length
    ? uniqueChannels.map(ch =>
        `<span style="background:var(--accent-light);color:var(--accent);padding:2px 10px;border-radius:10px;font-size:11px;font-weight:600;border:1px solid var(--border2);">${labels[ch]||ch}</span>`
      ).join(' ')
    : `<span style="font-size:11px;color:var(--muted);">No channels configured for this priority</span>`;

  const contactRows = uniqueChannels.map(ch => {
    const val = contactMap[ch];
    const lbl = ch==='sms'?'Phone':ch==='slack'?'Slack ID':'Email';
    return val
      ? `<div style="font-size:11px;color:var(--sub);">${lbl}: <strong style="color:var(--text)">${esc(val)}</strong></div>`
      : `<div style="font-size:11px;color:var(--yellow);">⚠️ ${lbl}: not set in profile</div>`;
  }).join('');

  addAIMessage(`🔔 Ready to send **${p}** priority notification to **${esc(assigneeName)}**`);
  addActionCard(() => `
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;font-weight:600;color:var(--sub);margin-bottom:6px;">SEND VIA</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px;">${channelBadges}</div>
      <div style="display:flex;flex-direction:column;gap:3px;">${contactRows}</div>
      ${S.aiSolution ? `<div style="margin-top:8px;padding:8px 10px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;font-size:11px;color:var(--green);">📎 Notification includes AI-generated fix suggestion</div>` : ''}
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-green btn-sm" onclick="sendNotification()">🚀 Send Notification</button>
      <button class="btn btn-ghost btn-sm" onclick="skipNotify()">Skip</button>
    </div>
    <div id="notify-result" style="margin-top:8px;"></div>
  `);
}

async function sendNotification() {
  if (!S.issue || !S.assignedTo) return;
  const nb = document.querySelector('.btn-green');
  if (nb) { nb.disabled = true; nb.innerHTML = '<span class="spin"></span> Sending...'; }
  try {
    const r = await apiFetch(`${API}/notify/all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issue: { ...S.issue, fields: { ...S.issue.fields, priority: { name: S.priority } } },
        assigneeName: S.assignedTo.displayName,
        priority: S.priority,
        toPhone: S.assignedContact.phone,
        toEmail: S.assignedContact.email,
        slackChannel: S.assignedContact.slack,
        aiSuggestion: S.aiSolution,
      }),
    });
    const nr = el('notify-result');
    if (nr && r.results?.length) {
      nr.innerHTML = r.results.map(res =>
        res.ok
          ? `<div class="result ok">${res.channel.toUpperCase()} sent ✓</div>`
          : `<div class="result err">${res.channel.toUpperCase()}: ${esc(res.error)}</div>`
      ).join('');
    }
    addAIMessage(`✅ **Notifications sent!**\n\n${(r.results||[]).map(res => res.ok ? `• ${res.channel}: ✓` : `• ${res.channel}: ✗ ${esc(res.error)}`).join('\n')}\n\nSelect another issue from the sidebar when ready.`);
  } catch (e) {
    addAIMessage(`❌ Notification failed: ${esc(e.message)}`);
  } finally {
    if (nb) { nb.disabled = false; nb.innerHTML = '🚀 Send Notification'; }
  }
}

function skipNotify() { addAIMessage('Notification skipped. Select another issue when you\'re ready.'); }

// ── Chat Proxy (LangGraph) ────────────────────────────────────────────────────
async function sendChatMessage() {
  const input = el('chat-input');
  const text = input?.value?.trim();
  if (!text || S.isTyping) return;
  input.value = '';
  autoResizeChat(input);
  await sendChatDirectly(text);
}

async function sendChatDirectly(text) {
  addUserMessage(text);
  S.chatHistory.push({ role: 'user', content: text });

  // Quick local shortcuts
  const lower = text.toLowerCase();
  if ((lower.includes('suggest') || lower.includes('ai assign')) && S.issue) { await runAISuggest(); return; }
  if ((lower.includes('manual') || lower.includes('team')) && S.issue) { await showManualList(); return; }
  if ((lower.includes('notify') || lower.includes('send')) && S.assignedTo) { showNotifyPanel(S.assignedTo.displayName); return; }

  addTypingIndicator();
  S.isTyping = true;
  const sendBtn = el('chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  try {
    const pKey = new URLSearchParams(window.location.search).get('project') || S.session?.jiraProjectKey;
    const res = await fetch('/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-project-key': pKey || '' },
      body: JSON.stringify({ message: text, history: S.chatHistory.slice(-18) }),
    });
    const data = await res.json();
    removeTypingIndicator();
    const reply = data.reply || 'Could not generate a response. Please try again.';
    S.chatHistory.push({ role: 'assistant', content: reply });
    addAIMessage(reply);
  } catch (e) {
    removeTypingIndicator();
    addAIMessage(`❌ Error: ${esc(e.message)}`);
  } finally {
    S.isTyping = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

// ── Chat Render ───────────────────────────────────────────────────────────────
function addAIMessage(text) {
  const msgs = el('chat-messages');
  if (!msgs) return;
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = `
    <div class="msg-header">
      <div class="ai-avatar">🤖</div>
      <span class="ai-name">BugSense AI</span>
    </div>
    <div class="bubble ai">${md(text)}</div>`;
  msgs.appendChild(div);
  scrollChat();
}

function addUserMessage(text) {
  const msgs = el('chat-messages');
  if (!msgs) return;
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="bubble user">${esc(text)}</div>`;
  msgs.appendChild(div);
  scrollChat();
}

function addActionCard(renderFn) {
  const msgs = el('chat-messages');
  if (!msgs) return;
  const w = document.createElement('div');
  w.className = 'msg ai';
  const card = document.createElement('div');
  card.className = 'action-card highlight';
  card.innerHTML = renderFn();
  w.appendChild(card);
  msgs.appendChild(w);
  scrollChat();
}

function addTypingIndicator() {
  const msgs = el('chat-messages');
  if (!msgs || el('typing-indicator')) return;
  const d = document.createElement('div');
  d.id = 'typing-indicator';
  d.className = 'msg ai';
  d.innerHTML = `
    <div class="msg-header"><div class="ai-avatar">🤖</div><span class="ai-name">BugSense AI</span></div>
    <div class="bubble ai" style="display:flex;gap:5px;align-items:center;padding:12px 14px;">
      <span style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:wf-bounce .8s ease-in-out infinite;display:inline-block;"></span>
      <span style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:wf-bounce .8s ease-in-out .18s infinite;display:inline-block;"></span>
      <span style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:wf-bounce .8s ease-in-out .36s infinite;display:inline-block;"></span>
    </div>`;
  msgs.appendChild(d);
  scrollChat();
}

function removeTypingIndicator() { el('typing-indicator')?.remove(); }
function scrollChat() { const m = el('chat-messages'); if (m) m.scrollTop = m.scrollHeight; }

/** Minimal markdown→HTML */
function md(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/_(.+?)_/g,'<em>$1</em>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\n/g,'<br>');
}

function extractDesc(adf) {
  if (!adf) return null;
  if (typeof adf === 'string') return adf;
  try {
    return (adf.content||[]).flatMap(b=>b.content||[]).filter(n=>n.type==='text').map(n=>n.text).join(' ');
  } catch { return null; }
}

// ── Projects Page ─────────────────────────────────────────────────────────────
async function loadProjects() {
  el('projects-list').innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);"><div class="spin" style="margin:0 auto 12px;"></div></div>';
  try {
    const projects = await apiFetch(`${API}/projects/assignable`);
    if (!projects.length) {
      el('projects-list').innerHTML = '<p style="color:var(--muted);font-size:13px;text-align:center;padding:40px;">No projects found.</p>';
      return;
    }
    el('projects-list').innerHTML = projects.map(p => `
      <div class="project-card">
        <div>
          <div style="font-size:14px;font-weight:700;">${esc(p.name)}</div>
          <div style="font-size:11px;color:var(--sub);margin-top:2px;">${esc(p.key)} · ${esc(p.projectTypeKey||'software')}</div>
        </div>
        <button onclick="switchToProject('${esc(p.key)}')"
          style="padding:7px 18px;border-radius:9px;border:none;background:var(--accent);color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:0 2px 8px rgba(37,99,235,.25);">
          Open →
        </button>
      </div>`).join('');
  } catch (e) {
    el('projects-list').innerHTML = `<div style="color:var(--red);padding:16px;font-size:12px;">${esc(e.message)}</div>`;
  }
}

async function switchToProject(projectKey) {
  const url = new URL(window.location.href);
  url.searchParams.set('project', projectKey);
  window.history.pushState({}, '', url);
  showPage('assign'); el('nav-assign').classList.add('active');
  S.issue = null; S.assignedTo = null;
  await loadWorkflowConfig(projectKey);
  await loadIssues();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
init();

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE ISSUE MODULE
// Uses /bugsense/api/issue/analyse → user sees confirmation → /bugsense/api/issue/create
// Permission is stored in Firestore on first use, checkbox not shown again.
// ═══════════════════════════════════════════════════════════════════════════════

const CI = {
  pendingSpec: null,
  permissionSaved: false,
  issueTypes: [],
  _selectedIssue: null,   // issue pre-loaded from Assign tab
  _pendingContext: null,  // accumulated context when AI asks for more
};

function handleCreateKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCreateMessage(); }
}

/** Open Create tab pre-loaded with a specific issue from the Assign tab */
function openCreateForIssue(json) {
  const issue = JSON.parse(json);
  CI._selectedIssue = issue;
  CI._initialized = false; // force re-init so welcome uses this issue

  // Switch to create tab
  showPage('create', el('nav-create'));
}

// Called when "Create Issue" tab is first opened
async function initCreateIssueTab() {
  if (CI._initialized) return;
  CI._initialized = true;

  // Check if permission was already saved
  try {
    const p = await apiFetch(`${API}/issue/permission`);
    CI.permissionSaved = !!p.saved;
  } catch { CI.permissionSaved = false; }

  // Show project badge
  const pKey = new URLSearchParams(window.location.search).get('project') || S.session?.jiraProjectKey;
  const badge = el('create-project-badge');
  if (badge && pKey) { badge.textContent = `📁 ${pKey}`; badge.style.display = 'inline-flex'; }

  if (CI._selectedIssue) {
    // Opened from Assign tab — pre-load the selected issue as context
    const f = CI._selectedIssue.fields || {};
    addCreateMsg('ai',
      `📌 **You selected: ${esc(CI._selectedIssue.key)} — ${esc(f.summary||'')}**\n` +
      `Status: ${esc(f.status?.name||'?')} · Type: ${esc(f.issuetype?.name||'?')} · Assignee: ${esc(f.assignee?.displayName||'Unassigned')}\n\n` +
      `Tell me what issue you want to report or create related to this. You can say something like:\n` +
      `_"the login still breaks after reload"_ or _"create a follow-up task for this"_`);
  } else {
    addCreateMsg('ai',
      `👋 **Tell me about your problem or idea.**\n\n` +
      `I already know all **${S.allIssues.length}** issues in this project — so you can reference them naturally.\n\n` +
      `Just describe it in plain language:\n` +
      `_Example: "The login button doesn't work on mobile Safari"_`);
  }
  el('create-chat-input')?.focus();
}

async function sendCreateMessage() {
  const input = el('create-chat-input');
  const text = input?.value?.trim();
  if (!text) return;
  input.value = '';
  autoResizeChat(input);
  addCreateMsg('user', text);

  if (CI.pendingSpec) {
    // User replied to confirmation card — check yes/no/edit
    const lower = text.toLowerCase();
    if (lower.includes('yes') || lower.includes('confirm') || lower.includes('create') || lower.includes('ok')) {
      await doCreateIssue();
    } else if (lower.includes('no') || lower.includes('cancel')) {
      CI.pendingSpec = null;
      addCreateMsg('ai', "No problem! Describe a different issue and I'll start fresh.");
    } else {
      // User is correcting something — re-analyse with the correction added
      CI.pendingSpec = null;
      addCreateMsg('ai', '✏️ Got it. Let me re-analyse with your correction...');
      await analyseDescription(text);
    }
    return;
  }

  if (CI._pendingContext) {
    // AI had asked a clarifying question — combine original + answer for re-analysis
    const fullContext = `${CI._pendingContext}. Additional detail: ${text}`;
    CI._pendingContext = null;
    await analyseDescription(fullContext);
    return;
  }

  // Fresh description
  await analyseDescription(text);
}


async function analyseDescription(description) {
  const sendBtn = el('create-send-btn');
  if (sendBtn) sendBtn.disabled = true;
  addCreateTyping();

  try {
    const data = await apiFetch(`${API}/issue/analyse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description,
        existingIssues: S.allIssues,            // full project issue list for context
        selectedIssue: CI._selectedIssue || null, // issue pre-loaded from Assign tab
      }),
    });

    removeCreateTyping();

    if (!data.success) {
      addCreateMsg('ai', '❌ Could not analyse the description. Could you rephrase it?');
      return;
    }

    if (data.needsMoreInfo) {
      CI._pendingContext = description;
      addCreateMsg('ai', `🤔 ${data.question}`);
      return;
    }

    // Enough info — show confirmation card
    CI.pendingSpec = data.spec;
    CI._pendingContext = null;
    CI._selectedIssue = null; // consumed
    showIssueConfirmCard(data.spec);
  } catch (e) {
    removeCreateTyping();
    addCreateMsg('ai', `❌ Analysis failed: ${esc(e.message)}`);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}

function showIssueConfirmCard(spec) {
  const typeOpts = ['Bug','Task','Story','Feature','Improvement','Epic'];
  const prioOpts = ['Highest','High','Medium','Low','Lowest'];
  const typeIcons = { Bug:'🐛',Task:'✅',Story:'📖',Feature:'✨',Improvement:'⬆️',Epic:'⚡' };

  const permCheckbox = CI.permissionSaved ? '' : `
    <div style="margin-top:12px;padding:10px;background:#fffbeb;border:1.5px solid #fcd34d;border-radius:8px;font-size:12px;">
      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;color:#92400e;">
        <input type="checkbox" id="save-perm-check" checked style="margin-top:2px;accent-color:#2563eb;"/>
        <span><strong>Remember my permission</strong> — allow this app to create Jira issues on my behalf.</span>
      </label>
    </div>`;

  const labelsHtml = (spec.labels||[]).map(l =>
    `<span style="background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;border-radius:10px;padding:1px 8px;font-size:10px;font-weight:600;">${esc(l)}</span>`).join(' ');

  const dupWarn = spec.duplicateWarning
    ? `<div style="margin-top:8px;padding:8px 12px;background:#fffbeb;border:1.5px solid #fcd34d;border-radius:8px;font-size:11px;color:#92400e;">
        ⚠️ <strong>Possible duplicate:</strong> ${esc(spec.duplicateWarning)}
       </div>`
    : '';

  const msgs = el('create-chat-messages');
  if (!msgs) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'msg ai';
  wrapper.innerHTML = `
    <div class="msg-header">
      <div class="ai-avatar">🤖</div>
      <span class="ai-name">BugSense AI</span>
    </div>`;

  const card = document.createElement('div');
  card.style.cssText = `
    max-width:88%;background:linear-gradient(135deg,#eff6ff,#dbeafe);
    border:1.5px solid #93c5fd;border-radius:14px;padding:18px;
    box-shadow:0 4px 20px rgba(37,99,235,.1);
  `;

  // Edge-style label
  const inputStyle = 'width:100%;padding:7px 10px;border:1.5px solid #bfdbfe;border-radius:8px;font-size:13px;background:#fff;color:#0f172a;font-family:inherit;box-sizing:border-box;';
  const selectStyle = 'padding:6px 10px;border:1.5px solid #bfdbfe;border-radius:8px;font-size:12px;background:#fff;color:#0f172a;font-family:inherit;font-weight:600;cursor:pointer;';
  const labelStyle = 'font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;display:block;';

  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
      <span id="ci-type-icon" style="font-size:18px;">${typeIcons[spec.issueType]||'📌'}</span>
      <span style="font-size:11px;font-weight:700;color:#2563eb;text-transform:uppercase;letter-spacing:.5px;">Issue Preview — Edit Before Creating</span>
      <span style="margin-left:auto;font-size:10px;color:#94a3b8;">Confidence: ${esc(spec.confidence)}</span>
    </div>

    <div style="margin-bottom:10px;">
      <label style="${labelStyle}">Summary</label>
      <input id="ci-summary" type="text" value="${esc(spec.summary)}" style="${inputStyle}" maxlength="255"/>
    </div>

    <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
      <div style="flex:1;min-width:110px;">
        <label style="${labelStyle}">Type</label>
        <select id="ci-type" style="${selectStyle}" onchange="document.getElementById('ci-type-icon').textContent=({Bug:'🐛',Task:'✅',Story:'📖',Feature:'✨',Improvement:'⬆️',Epic:'⚡'})[this.value]||'📌'">
          ${typeOpts.map(t=>`<option value="${t}"${t===spec.issueType?' selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div style="flex:1;min-width:110px;">
        <label style="${labelStyle}">Priority</label>
        <select id="ci-priority" style="${selectStyle}">
          ${prioOpts.map(p=>`<option value="${p}"${p===spec.priority?' selected':''}>${p}</option>`).join('')}
        </select>
      </div>
    </div>

    <div style="margin-bottom:10px;">
      <label style="${labelStyle}">Description</label>
      <textarea id="ci-desc" rows="3" style="${inputStyle}resize:vertical;line-height:1.5;">${esc(spec.description||spec.summary)}</textarea>
    </div>

    ${labelsHtml ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;">${labelsHtml}</div>` : ''}
    <div style="font-size:11px;color:#64748b;margin-bottom:8px;font-style:italic;">💡 ${esc(spec.reasoning)}</div>
    ${dupWarn}
    ${permCheckbox}

    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
      <button id="ci-ok-btn" onclick="doCreateIssue()" style="
        flex:1;min-width:120px;padding:10px 16px;border:none;border-radius:9px;cursor:pointer;
        background:linear-gradient(135deg,#2563eb,#3b82f6);color:#fff;
        font-size:13px;font-weight:700;font-family:inherit;
        box-shadow:0 2px 8px rgba(37,99,235,.3);
      ">✅ Create in Jira</button>
      <button onclick="refineSpec()" style="
        padding:10px 14px;border:1.5px solid #93c5fd;border-radius:9px;cursor:pointer;
        background:#fff;color:#2563eb;font-size:12px;font-weight:700;font-family:inherit;
      ">✨ Re-analyse</button>
      <button onclick="CI.pendingSpec=null;CI._pendingContext=null;addCreateMsg('ai','Cancelled. Describe a new issue whenever you\'re ready.')" style="
        padding:10px 12px;border:1.5px solid #fecaca;border-radius:9px;cursor:pointer;
        background:#fff;color:#ef4444;font-size:12px;font-weight:600;font-family:inherit;
      ">✕ Reject</button>
    </div>
    <div id="ci-create-status" style="margin-top:8px;font-size:12px;"></div>
  `;
  wrapper.appendChild(card);
  msgs.appendChild(wrapper);
  msgs.scrollTop = msgs.scrollHeight;
}

// Re-analyse with combined description + current inline edits
function refineSpec() {
  const summary = el('ci-summary')?.value?.trim();
  const desc = el('ci-desc')?.value?.trim();
  const type = el('ci-type')?.value;
  const combined = `${summary||''} ${desc||''} (preferred type: ${type||''})`.trim();
  CI.pendingSpec = null;
  addCreateMsg('user', '✨ Refining...');
  analyseDescription(combined);
}


async function doCreateIssue() {
  if (!CI.pendingSpec) return;

  // Read live edits from the card inputs
  const summary  = el('ci-summary')?.value?.trim()  || CI.pendingSpec.summary;
  const desc     = el('ci-desc')?.value?.trim()     || CI.pendingSpec.description;
  const issueType= el('ci-type')?.value             || CI.pendingSpec.issueType;
  const priority = el('ci-priority')?.value         || CI.pendingSpec.priority;

  const specToSend = { ...CI.pendingSpec, summary, description: desc, issueType, priority };

  const okBtn = el('ci-ok-btn');
  const statusEl = el('ci-create-status');
  if (okBtn) okBtn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span style="color:#94a3b8;">⏳ Creating issue in Jira...</span>';

  const savePermission = CI.permissionSaved || (el('save-perm-check')?.checked ?? true);

  try {
    const data = await apiFetch(`${API}/issue/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: specToSend, savePermission }),
    });

    if (savePermission) CI.permissionSaved = true;
    CI.pendingSpec = null;

    if (statusEl) statusEl.innerHTML = `<span style="color:#16a34a;">✅ Created!</span>`;
    addCreateMsg('ai',
      `🎉 **Issue created successfully!**\n\n` +
      `**${esc(data.issueKey)}** (${esc(data.issueType)}) — <a href="${esc(data.issueUrl)}" target="_blank" style="color:var(--accent);font-weight:600;">${esc(data.issueUrl)}</a>\n\n` +
      `Want to report another problem?`);
  } catch (e) {
    if (okBtn)    okBtn.disabled = false;
    if (statusEl) statusEl.innerHTML = `<span style="color:#dc2626;">❌ ${esc(e.message)}</span>`;
  }
}

// ── Create tab chat helpers ───────────────────────────────────────────────────
function addCreateMsg(role, text) {
  const msgs = el('create-chat-messages');
  if (!msgs) return;
  const isUser = role === 'user';
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  if (!isUser) {
    d.innerHTML = `
      <div class="msg-header">
        <div class="ai-avatar">🤖</div>
        <span class="ai-name">BugSense AI</span>
      </div>
      <div class="bubble ai">${md(text)}</div>`;
  } else {
    d.innerHTML = `<div class="bubble user">${esc(text)}</div>`;
  }
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
}

function addCreateTyping() {
  const msgs = el('create-chat-messages');
  if (!msgs || el('ci-typing')) return;
  const d = document.createElement('div');
  d.id = 'ci-typing'; d.className = 'msg ai';
  d.innerHTML = `<div class="msg-header"><div class="ai-avatar">🤖</div><span class="ai-name">Analysing...</span></div>
    <div class="bubble ai" style="display:flex;gap:5px;align-items:center;padding:12px 14px;">
      <span style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:wf-bounce .8s ease-in-out infinite;display:inline-block;"></span>
      <span style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:wf-bounce .8s ease-in-out .18s infinite;display:inline-block;"></span>
      <span style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:wf-bounce .8s ease-in-out .36s infinite;display:inline-block;"></span>
    </div>`;
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
}

function removeCreateTyping() { el('ci-typing')?.remove(); }

