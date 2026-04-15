# BugSense - Agentic Workflow System

BugSense is an AI-powered workflow automation platform built on top of Jira. It acts as an intelligent orchestration layer that reacts to project events - issues created, assigned, transitioned - and executes configured actions across Slack, GitHub, Email, and SMS automatically.

Built for Tic Tech Toe '26 (Problem Statement 6: Agentic MCP Gateway) by Team WorkingDays.

---

## The Problem

Jira is powerful but passive. Issues get created and sit there. The right people don't get notified at the right time. Assignees forget to check. Bugs rot in the backlog. Someone always has to manually jump between Jira, Slack, GitHub, and their phone.

BugSense removes that person from the loop.

---

## What It Does

An admin connects their Jira project, Slack workspace, and GitHub repository to BugSense. They define what should happen when something occurs in the project - either by typing it in plain English or using a visual builder. From that point, BugSense handles everything automatically.

When a high priority bug is assigned, the developer gets an SMS with an AI-generated fix suggestion, a Slack DM with full issue context, and a GitHub branch already created in their name — without anyone doing any of that manually.

---

## Three Users, Three Experiences

**Admin**
Sets up the project once. Configures workflows via natural language or a 3-stage visual builder. Manages integrations (Slack OAuth, GitHub PAT), feature toggles, and views AI-generated project reports.

**Assigner**
Uses the BugSense dashboard to triage unassigned issues. Gets AI-powered assignee suggestions based on team workload and past issue history. Can create new Jira issues directly from natural language descriptions.

**Assignee**
Never opens the dashboard. Receives notifications on the right channel (SMS for high priority, Slack/Email for lower), complete with an AI-generated solution hint and a GitHub branch already waiting.

---

## Core Features

### Dual-Mode Workflow Builder
Admins can build workflows in two ways:

- **Natural Language:** Type "if a new bug is assigned, text them if high priority, otherwise Slack them." Gemini parses this and maps it to the exact configuration. If it's uncertain, it asks for confirmation before saving. If it can't understand, it says so honestly.
- **Visual Builder (3 stages):** Choose trigger events, configure notification channels per event, enable enhancements like auto-branching and AI solution hints.

Every workflow — whether built manually or via natural language - gets a Gemini-generated plain English summary that the admin approves before it goes live.

### Agentic AI Layer (LangGraph)
The AI backend is built on LangGraph - a stateful, graph-based agent framework. Instead of one big AI call, the system runs a structured pipeline:

```
User Message
     |
[intentClassifier]   — LLM call, returns typed intent + data
     |
[contextFetcher]     — Firestore fetch: workflows, features, integrations
     |
     |-- "create_workflow"   → [workflowNode]
     |-- "edit_workflow"     → [workflowNode] (edit mode)
     |-- "toggle_feature"   → [featureToggleNode]  ← writes Firestore directly
     |-- "view_workflows"   → [viewWorkflowsNode]  ← no LLM
     └-- "general"          → [generalNode]
```

The agent doesn't just suggest actions - it executes them. Toggling a feature flag writes to Firestore directly. Creating a workflow fires the Jira API. The human approves before any irreversible action (issue creation, assignment), but the agent does the rest.

### BugSense Assigner Dashboard
A separate role-based interface for assigners. Unassigned issues sit at the top. Clicking one opens an AI-assisted workflow:

- **AI Assignee Suggestion:** Gemini analyzes the issue and team history (workload, skills, recent tasks) and recommends the best person with a confidence level and reason.
- **AI Solution Hints:** If enabled by the admin, an AI-generated fix suggestion is shown before assigning - so the assignee receives it in their notification.
- **Manual Assignment:** Dropdown filtered to project members only, with canAssign validation.

### Contextual Issue Creation
Assigners can create Jira issues from plain English descriptions. The AI:
- Classifies issue type (Bug, Task, Story, Feature)
- Detects if a similar issue already exists (duplicate warning)
- Asks for clarification if the description is too vague
- Presents a fully editable confirmation card before creating anything in Jira

The AI never creates an issue automatically. It proposes, the user reviews and edits, then confirms.

### Smart Notification Routing
- High priority → SMS (Twilio)
- Medium priority → Slack DM
- Low priority → Email (HTML template with issue summary + AI solution)

All three channels receive the AI solution in the same send - not separately, not after.

### GitHub Auto-Branching
When autoBranch is enabled in a workflow, assigning an issue automatically creates a branch like `bugfix/PROJ-42-login-button-crash` in the connected repository using the assignee's stored GitHub PAT.

### Sentry Integration
Production errors from Sentry are ingested via webhook, automatically converted into Jira Bug issues, and trigger the project's configured notification workflows - without any manual ticket creation.

### AI Report Generation
Admins can generate project health reports covering team performance, sprint summaries, and bug analysis over a selected date range. Reports are editable - admins can prompt Gemini to refine them ("make this more formal", "add a section on front-end regressions") and download as PDF.

### Security
- AES-256-CBC encryption on all sensitive data at rest (phone numbers, Slack tokens, GitHub PATs)
- Scoped credentials per project — bot tokens stored per project, not globally
- Per-project, per-user data model (a user can have different Slack IDs and tokens across different projects)
- All API calls logged for audit

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + Express.js |
| Database | Firebase Firestore |
| Authentication | OAuth 2.0 (Jira + Slack) |
| Encryption | AES-256-CBC (Node crypto) |
| AI Layer | OpenAI GPT-4o-mini via LangGraph |
| Agent Framework | LangGraph (LangChain) |
| Notifications | Slack Web API, Twilio (SMS), Nodemailer (Email) |
| DevOps Integration | GitHub REST API |
| Error Monitoring | Sentry Webhooks |
| Frontend | HTML + Tailwind CSS |

---

## Database Structure (Firestore)

```
users/{userId}
  - jiraAccountId, email, displayName, jiraCloudId, isAdmin, canAssign

projects/{projectKey}
  - registeredBy, features (toggles), integrations (encrypted tokens)

projects/{projectKey}/members/{jiraAccountId}
  - role, slackUserId, phoneNumber (encrypted), github (username + token encrypted)

workflows/{workflowId}
  - name, projectId, trigger events, notification config, enhancements,
    naturalLanguageSummary, isActive
```

---

## How Workflows Execute

1. Jira fires a webhook to `/webhooks/jira` when an event occurs
2. The server matches the event against active workflows in Firestore
3. The execution engine fetches the assignee's contact info from the member subcollection
4. Actions run: Slack message, SMS, email, GitHub branch creation — in the configured combination
5. Every execution is logged

Duplicate trigger prevention ensures no two active workflows share the same trigger event, avoiding routing conflicts.

---

## Folder Structure

```
/
config/
  firebase.js
  github.js
  jira.js
  notifications.js
  slack.js
docs/
  FIREBASE_SETUP.md
middleware/
  auth.js
  webhookAuth.js
public/
  ai-workflow-chat.js
  axios.min.js
  bugsense.html
  bugsense.js
  dashboard.html
  not-registered.html
  workflow-builder.html
routes/
  features/
    ai-analysis.js
    reports.js
  webhooks/
    github.js
    jira.js
    sentry.js
  admin.js
  ai-chat.js
  auth.js
  bugsense.js
  session.js
  workflows.js
services/
  actionHandlers/
    createGitHubBranch.js
    sendEmail.js
    sendSlackMessage.js
    sendSMS.js
  ai/
    assigneeSuggester.js
    bugAnalyzer.js
  ai-agent.js
  githubHelper.js
  workflowEngine.js
  workflowExecutor.js
utils/
  crypto.js
  logger.js
  openai.js
  validator.js
.gitignore
app.js
firestore.rules
package.json
README.md
server.js
test-firebase.js
```

---

## Setup

```bash
git clone https://github.com/your-repo/bugsense.git
cd bugsense
npm install
```

Create a `.env` file:

```
JIRA_CLIENT_ID=
JIRA_CLIENT_SECRET=
JIRA_REDIRECT_URI=

SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_REDIRECT_URI=

OPENAI_API_KEY=

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

EMAIL_USER=
EMAIL_PASS=

ENCRYPTION_KEY=
FIREBASE_SERVICE_ACCOUNT=

SESSION_SECRET=
PORT=3000
```

```bash
node app.js
```

Expose your local server via ngrok or similar to receive Jira webhooks:

```bash
ngrok http 3000
```

Add the ngrok URL as your Jira webhook URL in your project settings.

---

## Team

Team WorkingDays — Tic Tech Toe '26, built in 5 days.
