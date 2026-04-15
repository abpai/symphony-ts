# Symphony-TS Extension Specification

Status: Draft v1
Base: `SPEC.upstream.md` (openai/symphony SPEC.md, March 2026)
Scope: Jira tracker, pluggable agent runtime, pluggable workspace provider

This document specifies only the changes and additions to `SPEC.upstream.md` required for our fork.
Anything not mentioned here follows the upstream spec exactly.

---

## 1. Summary of Changes

Three extension axes, all additive — existing Linear + Codex + local workspace behavior is
preserved as one valid configuration.

| Extension | What changes | What stays the same |
|-----------|-------------|---------------------|
| **Tracker provider** | Abstract `TrackerClient` interface; add `JiraTrackerClient` | `LinearTrackerClient` unchanged; normalized `Issue` model (§4.1.1) unchanged |
| **Agent runtime provider** | Abstract `AgentRuntime` interface; add `HttpAgentRuntime` for Open Agents | `StdioAgentRuntime` (current Codex client) unchanged; orchestrator event model unchanged |
| **Workspace provider** | Abstract `WorkspaceProvider` interface; add `SandboxWorkspaceProvider` | `LocalWorkspaceProvider` (current workspace manager) unchanged; hook contract unchanged |

The orchestrator, poll loop, retry queue, reconciliation engine, prompt renderer, config loader,
observability layer, and dashboard remain untouched. They consume the provider interfaces.

---

## 2. Config Schema Changes

### 2.1 `tracker` block

Add to existing fields (upstream §5.3.1):

```yaml
tracker:
  kind: linear | jira          # was: linear only

  # --- Jira-specific (ignored when kind: linear) ---
  base_url: https://mycompany.atlassian.net   # required for jira
  user_email: $JIRA_USER_EMAIL                # required for jira (basic auth)
  api_token: $JIRA_API_TOKEN                  # reuses existing field name
  project_key: PROJ                           # replaces project_slug for jira
  jql_filter: 'AND labels = "agent-ready"'    # optional, appended to generated JQL
```

Validation rules (extend upstream §6.3):

- When `tracker.kind == "jira"`:
  - `tracker.base_url` must be present and a valid URL (no trailing slash).
  - `tracker.user_email` must be present after `$` resolution.
  - `tracker.api_token` must be present after `$` resolution.
  - `tracker.project_key` must be present and non-empty.
- When `tracker.kind == "linear"`: existing validation unchanged.

Default active/terminal states for Jira:

- `active_states`: `["To Do", "In Progress"]`
- `terminal_states`: `["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]`

These defaults apply only when `tracker.kind == "jira"` and the user omits them. Linear defaults
remain `["Todo", "In Progress"]` and `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`.

### 2.2 `agent_runtime` block (new, replaces `codex` for provider selection)

The existing `codex` block remains valid and is treated as shorthand for
`agent_runtime.provider: stdio` with the Codex-specific fields. When `agent_runtime` is present, it
takes precedence over `codex`. When neither is present, the service falls back to `codex` defaults
for backward compatibility.

```yaml
agent_runtime:
  provider: stdio | http       # default: stdio

  # --- stdio provider fields (same semantics as existing codex block) ---
  command: codex app-server          # default
  approval_policy: <pass-through>
  thread_sandbox: <pass-through>
  turn_sandbox_policy: <pass-through>

  # --- http provider fields (new) ---
  base_url: $AGENT_RUNTIME_URL          # required for http
  api_token: $AGENT_RUNTIME_TOKEN       # required for http
  github_installation_id: "12345678"    # optional, for Open Agents GitHub integration
  auto_commit: true                     # default true
  auto_pr: true                         # default true

  # --- common fields (both providers) ---
  turn_timeout_ms: 3600000       # default 1h
  read_timeout_ms: 5000          # default 5s
  stall_timeout_ms: 300000       # default 5m
  max_turns: 20                  # default 20
```

Validation rules:

- When `agent_runtime.provider == "stdio"`: `command` must be present and non-empty (same as
  existing `codex.command` check).
- When `agent_runtime.provider == "http"`: `base_url` must be present after `$` resolution.

Backward compatibility:

- If `codex` is present and `agent_runtime` is absent, treat as `agent_runtime.provider: stdio`
  with all `codex.*` fields mapped 1:1. No migration required for existing WORKFLOW.md files.

### 2.3 `workspace` block

Add to existing fields (upstream §5.3.3):

```yaml
workspace:
  provider: local | sandbox    # default: local
  root: ~/symphony_workspaces  # used when provider: local (existing behavior)

  # --- sandbox provider fields (new) ---
  sandbox_api_url: $SANDBOX_API_URL
  sandbox_api_token: $SANDBOX_API_TOKEN
  sandbox_base_snapshot_id: snap_base_node20   # optional
  sandbox_idle_timeout_ms: 300000              # default 5m
```

Validation rules:

- When `workspace.provider == "local"`: existing validation unchanged.
- When `workspace.provider == "sandbox"`:
  - `sandbox_api_url` must be present after `$` resolution.
  - `sandbox_api_token` must be present after `$` resolution.

---

## 3. TrackerProvider Interface

### 3.1 Interface Definition

Extract from the existing `LinearTrackerClient` the following interface. Both Linear and Jira
clients implement it.

```typescript
interface TrackerProvider {
  /**
   * Return issues in configured active states for the configured project.
   * Handles pagination internally. Returns normalized Issue[].
   */
  fetchCandidateIssues(): Promise<Issue[]>;

  /**
   * Return issues currently in any of the given state names.
   * Used for startup terminal cleanup.
   */
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;

  /**
   * Return current state for specific issue IDs.
   * Used for active-run reconciliation.
   */
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}
```

The `Issue` type is the existing normalized model from upstream §4.1.1. It does not change.

### 3.2 Provider Factory

```typescript
function createTrackerProvider(config: TrackerConfig): TrackerProvider {
  switch (config.kind) {
    case "linear":
      return new LinearTrackerClient(config);
    case "jira":
      return new JiraTrackerClient(config);
    default:
      throw new UnsupportedTrackerKindError(config.kind);
  }
}
```

The orchestrator calls `createTrackerProvider` once at startup and on config reload.

### 3.3 Jira Implementation Details

#### 3.3.1 Authentication

Jira Cloud uses basic auth:

```
Authorization: Basic base64(user_email:api_token)
```

#### 3.3.2 Candidate Issue Query

```
POST {base_url}/rest/api/3/search
Content-Type: application/json

{
  "jql": "project = \"{project_key}\" AND status IN (\"{active_state_1}\", ...) {jql_filter}",
  "fields": [
    "summary", "description", "status", "priority",
    "labels", "issuelinks", "created", "updated"
  ],
  "startAt": 0,
  "maxResults": 50
}
```

Paginate using `startAt` + `total` from response. Page size: `50`. Timeout: `30000 ms`.

#### 3.3.3 Issue State Refresh

For reconciliation (small batch of known IDs):

```
POST {base_url}/rest/api/3/search

{
  "jql": "id IN ({id1}, {id2}, ...)",
  "fields": ["status"],
  "maxResults": 100
}
```

#### 3.3.4 Terminal Issues Query

```
POST {base_url}/rest/api/3/search

{
  "jql": "project = \"{project_key}\" AND status IN (\"{terminal_state_1}\", ...)",
  "fields": ["key", "status"],
  "maxResults": 50
}
```

Paginate as with candidate query.

#### 3.3.5 Normalization (Jira → Issue)

| Issue field | Jira source | Notes |
|-------------|-------------|-------|
| `id` | response `id` | Numeric Jira ID, stored as string |
| `identifier` | response `key` | e.g., `PROJ-123` |
| `title` | `fields.summary` | |
| `description` | `fields.description` | ADF to plaintext (use `@atlaskit/renderer` or strip to text) |
| `priority` | `fields.priority.name` | Map: Highest→1, High→2, Medium→3, Low→4, Lowest→5, unknown→null |
| `state` | `fields.status.name` | |
| `branch_name` | null | Unless DevInfo or custom field available |
| `url` | `{base_url}/browse/{key}` | Constructed |
| `labels` | `fields.labels` | Lowercase |
| `blocked_by` | `fields.issuelinks` | Filter: link type name `Blocks`, take `inwardIssue` entries |
| `created_at` | `fields.created` | Parse ISO-8601 |
| `updated_at` | `fields.updated` | Parse ISO-8601 |

Blocker normalization from `issuelinks`:

```typescript
issue.fields.issuelinks
  .filter(link => link.type.name === "Blocks" && link.inwardIssue)
  .map(link => ({
    id: link.inwardIssue.id,
    identifier: link.inwardIssue.key,
    state: link.inwardIssue.fields?.status?.name ?? null
  }))
```

Note: Jira's "Blocks" link type means "inwardIssue blocks outwardIssue". When we're looking at an
issue's links, `inwardIssue` in a `Blocks`-typed link is the *blocker*.

#### 3.3.6 Error Categories

- `jira_api_request` — transport/network failure
- `jira_api_status` — non-2xx HTTP response
- `jira_api_auth_failed` — 401 or 403
- `jira_unknown_payload` — unexpected response shape
- `jira_pagination_error` — missing/invalid pagination fields

Orchestrator behavior on Jira errors follows the same contract as Linear errors (upstream §11.4).

#### 3.3.7 Optional Client-Side Tool: `jira_rest`

Equivalent of the upstream `linear_graphql` tool. Available only for `stdio` agent runtime sessions
when `tracker.kind == "jira"`.

Input schema:

```typescript
{
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;   // must start with /rest/
  body?: object;   // for POST/PUT
}
```

Execution: prepend `tracker.base_url`, authenticate with configured Jira credentials, execute one
call, return structured result.

Result semantics:

- 2xx → `{ success: true, data: <response body> }`
- 4xx → `{ success: false, status: <code>, error: <response body> }`
- 5xx / transport failure → `{ success: false, error: <message> }`

Advertise during stdio session startup alongside or instead of `linear_graphql` based on
`tracker.kind`.

---

## 4. AgentRuntime Provider Interface

### 4.1 Interface Definition

Extract from the existing Codex app-server client:

```typescript
interface AgentRuntime {
  /**
   * Start a new agent session in the given execution environment.
   * Returns a session handle used for subsequent calls.
   */
  startSession(params: {
    environment: ExecutionEnvironment;
    issue: Issue;
    config: AgentRuntimeConfig;
  }): Promise<AgentSession>;

  /**
   * Send a turn (prompt) to the active session and stream events.
   * Calls onEvent for each agent event received.
   * Returns when the turn completes, fails, or times out.
   */
  sendTurn(params: {
    session: AgentSession;
    prompt: string;
    issue: Issue;
    onEvent: (event: AgentEvent) => void;
  }): Promise<TurnResult>;

  /**
   * Stop the session and release resources.
   */
  stopSession(session: AgentSession): Promise<void>;
}

interface AgentSession {
  sessionId: string;
  threadId: string | null;   // populated by stdio, null for http
  turnId: string | null;
  processId: string | null;  // PID for stdio, session ID for http
}

interface AgentEvent {
  event: string;             // session_started, turn_completed, notification, etc.
  timestamp: string;
  processId: string | null;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  payload?: unknown;
}

type TurnResult =
  | { outcome: "completed" }
  | { outcome: "failed"; error: string }
  | { outcome: "cancelled" }
  | { outcome: "timeout" }
  | { outcome: "input_required" };
```

### 4.2 Provider Factory

```typescript
function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime {
  switch (config.provider) {
    case "stdio":
      return new StdioAgentRuntime(config);
    case "http":
      return new HttpAgentRuntime(config);
    default:
      throw new UnsupportedAgentRuntimeError(config.provider);
  }
}
```

### 4.3 StdioAgentRuntime (existing behavior, extracted)

The current Codex app-server client code moves into `StdioAgentRuntime` with no behavioral changes.
It implements the `AgentRuntime` interface by:

- `startSession` → spawns subprocess, runs initialize/initialized/thread/start handshake
- `sendTurn` → sends turn/start, streams stdout lines, emits AgentEvents
- `stopSession` → kills subprocess

All existing approval handling, stall detection wiring, turn continuation, and line buffering logic
stays in this class.

### 4.4 HttpAgentRuntime (new — Open Agents)

#### 4.4.1 Session Creation

```
POST {base_url}/api/sessions
Content-Type: application/json
Authorization: Bearer {api_token}

{
  "title": "{issue.identifier}: {issue.title}",
  "github_installation_id": "{config.github_installation_id}"
}
```

If the Open Agents instance requires repo context, include `repo_url` and `branch` fields (derived
from hook environment or config). The exact request shape may vary by Open Agents version — the
implementation should tolerate additional or optional fields.

Map response to `AgentSession`:

```typescript
{
  sessionId: response.id,        // or response.session_id
  threadId: null,                 // not applicable for HTTP
  turnId: null,
  processId: response.id
}
```

#### 4.4.2 Sending Turns

```
POST {base_url}/api/chat
Content-Type: application/json
Authorization: Bearer {api_token}

{
  "session_id": "{session.sessionId}",
  "message": "{prompt}",
  "stream": true
}
```

Read the streamed response (SSE or chunked JSON). Map streaming events to `AgentEvent`:

| Open Agents event | AgentEvent.event | Notes |
|--------------------|------------------|-------|
| Agent text chunk | `notification` | Accumulate for `last_agent_message` |
| Tool use start | `notification` | Log tool name |
| Tool use result | `notification` | |
| Stream complete (success) | `turn_completed` | |
| Stream complete (error) | `turn_failed` | Extract error message |
| HTTP 4xx/5xx | `turn_failed` | Map status to error string |

Token usage extraction:

- Check response headers and/or final event payload for usage metadata.
- Open Agents may include usage in the streaming response or in a summary event.
- If unavailable, report zeros (the orchestrator handles missing usage gracefully).

#### 4.4.3 Turn Timeout

Apply `agent_runtime.turn_timeout_ms` to the streaming read. If the timeout fires before the
stream completes, abort the HTTP request and return `{ outcome: "timeout" }`.

#### 4.4.4 Stall Detection

The orchestrator handles stall detection externally (upstream §8.5 Part A). The HTTP provider just
needs to update `last_agent_timestamp` on each received event so the orchestrator can measure
elapsed time. No provider-side stall logic is needed.

#### 4.4.5 Session Teardown

If Open Agents exposes a session close endpoint, call it. Otherwise, allow idle cleanup by the
service. This is a best-effort operation — failure is logged and ignored.

#### 4.4.6 Sandbox Interaction

When `workspace.provider == "sandbox"` and `agent_runtime.provider == "http"`, the Open Agents
service manages its own sandboxes internally. In this configuration:

- Symphony still creates a logical environment via the `WorkspaceProvider` for tracking purposes.
- The actual sandbox lifecycle (VM provisioning, snapshot, hibernate) is delegated to Open Agents.
- Hooks run inside the Open Agents sandbox via the agent service's shell execution capability, or
  are skipped if the service doesn't expose shell access.

When `workspace.provider == "local"` and `agent_runtime.provider == "http"`, the HTTP provider must
pass the local workspace `cwd` to the agent service so it knows where to operate. This requires
the agent service to have filesystem access to the same path — which may not be possible for remote
services. Implementations should validate this at startup and warn if the combination is likely
invalid.

---

## 5. WorkspaceProvider Interface

### 5.1 Interface Definition

Extract from the existing workspace manager:

```typescript
interface WorkspaceProvider {
  /**
   * Ensure an execution environment exists for the given issue.
   * Creates if necessary, reuses if already present.
   */
  createOrReuse(issueIdentifier: string): Promise<ExecutionEnvironment>;

  /**
   * Run a lifecycle hook inside the environment.
   * hookName: after_create | before_run | after_run | before_remove
   */
  runHook(
    hookName: string,
    environment: ExecutionEnvironment,
    script: string,
    timeoutMs: number
  ): Promise<HookResult>;

  /**
   * Remove the environment for the given issue.
   * Runs before_remove hook if configured.
   */
  cleanup(issueIdentifier: string): Promise<void>;

  /**
   * List existing environment keys (used for startup cleanup).
   */
  listEnvironments(): Promise<string[]>;
}

interface ExecutionEnvironment {
  environmentId: string;    // local path or sandbox ID
  workspaceKey: string;     // sanitized issue identifier
  provider: "local" | "sandbox";
  cwd: string;              // absolute local path or sandbox working dir
  createdNow: boolean;
  snapshotId?: string;      // sandbox provider only
}

type HookResult =
  | { ok: true }
  | { ok: false; error: string; timedOut: boolean };
```

### 5.2 Provider Factory

```typescript
function createWorkspaceProvider(config: WorkspaceConfig): WorkspaceProvider {
  switch (config.provider) {
    case "local":
      return new LocalWorkspaceProvider(config);
    case "sandbox":
      return new SandboxWorkspaceProvider(config);
    default:
      throw new UnsupportedWorkspaceProviderError(config.provider);
  }
}
```

### 5.3 LocalWorkspaceProvider (existing behavior, extracted)

Move the current workspace manager code into `LocalWorkspaceProvider` with no behavioral changes.
All safety invariants from upstream §9 apply unchanged:

- Workspace path must be inside workspace root.
- Workspace key is sanitized (`[A-Za-z0-9._-]` only).
- Agent cwd must equal workspace path.
- Hooks execute via `sh -lc` in workspace directory.

### 5.4 SandboxWorkspaceProvider (new)

#### 5.4.1 Environment Creation

1. Sanitize `issueIdentifier` to `workspaceKey` (same rules as local).
2. Query sandbox API for existing sandbox with label/metadata matching `workspaceKey`.
3. If found:
   - Resume sandbox if hibernated.
   - Set `createdNow = false`.
4. If not found:
   - Create new sandbox from `sandbox_base_snapshot_id` (or API default).
   - Tag/label the sandbox with `workspaceKey`.
   - Set `createdNow = true`.
5. Return `ExecutionEnvironment` with `environmentId` = sandbox ID, `cwd` = sandbox working
   directory (typically `/home/user` or `/workspace`).

#### 5.4.2 Hook Execution

Run hooks inside the sandbox via its shell API:

```
POST {sandbox_api_url}/api/sandbox/exec
Authorization: Bearer {sandbox_api_token}

{
  "sandbox_id": "{environmentId}",
  "command": "{script}",
  "timeout_ms": {timeoutMs}
}
```

The exact endpoint depends on the sandbox service. Implementations should abstract the shell
execution call.

Same failure semantics as local hooks (upstream §9.4):

- `after_create` failure → fatal to environment creation
- `before_run` failure → fatal to current attempt
- `after_run` / `before_remove` failure → logged and ignored

#### 5.4.3 Cleanup

1. Run `before_remove` hook inside sandbox (best-effort).
2. Terminate the sandbox.
3. Delete the sandbox.

#### 5.4.4 Listing

Query sandbox API for all sandboxes tagged/labeled with the Symphony workspace prefix. Return their
`workspaceKey` labels.

#### 5.4.5 Safety Invariants

- Each issue maps to exactly one sandbox (enforced by `workspaceKey` label uniqueness).
- Sandbox identity is deterministic from `workspaceKey`.
- `workspaceKey` uses the same sanitization as local.
- Sandboxes should have bounded resource limits where the API supports it.

---

## 6. Orchestrator Wiring Changes

The orchestrator itself does not gain new state or logic. The changes are at initialization and
config reload:

### 6.1 Startup

Replace direct construction with provider factories:

```typescript
// Before (current symphony-ts)
const tracker = new LinearTrackerClient(config);
const workspace = new WorkspaceManager(config);
const agentClient = new CodexAppServerClient(config);

// After
const tracker = createTrackerProvider(config.tracker);
const workspace = createWorkspaceProvider(config.workspace);
const agentRuntime = createAgentRuntime(config.agentRuntime ?? config.codex);
```

### 6.2 Config Reload

On WORKFLOW.md change, re-create providers if `tracker.kind`, `agent_runtime.provider`, or
`workspace.provider` changed. If only parameters within the same provider changed (e.g., polling
interval, concurrency), update in-place as the upstream spec requires.

### 6.3 Field Renames in Runtime State

In the orchestrator's in-memory state (upstream §4.1.8), rename for provider-agnostic semantics:

| Current name | New name | Notes |
|-------------|----------|-------|
| `codex_totals` | `agent_totals` | Same shape |
| `codex_rate_limits` | `agent_rate_limits` | Same shape |

In running entry (upstream §4.1.6):

| Current name | New name |
|-------------|----------|
| `codex_app_server_pid` | `agent_process_id` |
| `last_codex_event` | `last_agent_event` |
| `last_codex_timestamp` | `last_agent_timestamp` |
| `last_codex_message` | `last_agent_message` |
| `codex_input_tokens` | `agent_input_tokens` |
| `codex_output_tokens` | `agent_output_tokens` |
| `codex_total_tokens` | `agent_total_tokens` |
| `last_reported_input_tokens` | (unchanged) |
| `last_reported_output_tokens` | (unchanged) |
| `last_reported_total_tokens` | (unchanged) |

The dashboard and JSON API should reflect the new field names. The dashboard should also display
`runtime_provider` in the running session rows.

---

## 7. Validation Changes

Extend upstream §6.3 dispatch preflight validation:

```
Existing checks (unchanged):
  ✓ Workflow file loadable
  ✓ tracker.kind present and supported
  ✓ tracker credentials present after $ resolution

New checks:
  ✓ tracker.kind supports "jira" (in addition to "linear")
  ✓ When jira: base_url, user_email, project_key all present
  ✓ agent_runtime.provider present and supported (stdio | http), or codex block present
  ✓ When stdio: command present and non-empty
  ✓ When http: base_url present after $ resolution
  ✓ workspace.provider present and supported (local | sandbox)
  ✓ When sandbox: sandbox_api_url and sandbox_api_token present after $ resolution
  ✓ When workspace=local + agent_runtime=http: warn if remote agent likely can't access local paths
```

---

## 8. File Organization

Suggested source layout for the new modules (minimal disruption to existing structure):

```
src/
  tracker/
    interface.ts              # TrackerProvider type + factory
    linear.ts                 # existing LinearTrackerClient (moved, not modified)
    jira.ts                   # new JiraTrackerClient
    normalization.ts          # shared Issue normalization helpers
  agent-runtime/
    interface.ts              # AgentRuntime type + factory
    stdio.ts                  # existing Codex app-server client (moved, renamed)
    http.ts                   # new HttpAgentRuntime (Open Agents)
    events.ts                 # shared AgentEvent types
  workspace/
    interface.ts              # WorkspaceProvider type + factory
    local.ts                  # existing workspace manager (moved, not modified)
    sandbox.ts                # new SandboxWorkspaceProvider
  config/
    schema.ts                 # extended Zod schema (add jira, agent_runtime, workspace.provider)
    ...existing config files
  orchestrator/
    ...existing files (minimal changes: use interfaces instead of concrete classes)
  cli/
    ...existing files
```

---

## 9. Test Plan

### 9.1 Unit Tests (required)

**Tracker:**

- `JiraTrackerClient.fetchCandidateIssues` constructs correct JQL and paginates
- JQL includes `jql_filter` when configured
- Jira issue normalization produces valid `Issue` objects
- Priority name mapping (Highest→1 through Lowest→5, unknown→null)
- Blocker extraction from `issuelinks` with type `Blocks`
- Label normalization to lowercase
- Auth header is correct basic auth encoding
- Error categories: 401/403 → `jira_api_auth_failed`, 5xx → `jira_api_status`
- Empty `fetchIssuesByStates([])` returns `[]` without API call
- `TrackerProvider` factory returns correct implementation for `linear` and `jira`

**Agent Runtime:**

- `HttpAgentRuntime.startSession` POSTs to correct endpoint with auth
- `HttpAgentRuntime.sendTurn` streams response and emits `AgentEvent`s
- Turn timeout fires and returns `{ outcome: "timeout" }`
- HTTP errors map to `turn_failed` with status info
- Token usage extracted from response metadata when present
- `AgentRuntime` factory returns correct implementation for `stdio` and `http`
- `StdioAgentRuntime` behavior unchanged from existing tests (moved, not rewritten)

**Workspace:**

- `SandboxWorkspaceProvider.createOrReuse` creates new sandbox when none exists
- `SandboxWorkspaceProvider.createOrReuse` resumes existing sandbox
- `createdNow` flag correct in both cases
- Hooks execute inside sandbox via shell API
- `cleanup` terminates and deletes sandbox
- `listEnvironments` returns workspace keys from sandbox labels
- Workspace key sanitization applies (same rules as local)
- `WorkspaceProvider` factory returns correct implementation for `local` and `sandbox`

**Config:**

- `agent_runtime` block parses and validates for both providers
- `codex` block still works as backward-compatible shorthand
- `tracker.kind: jira` validates all required Jira fields
- `workspace.provider: sandbox` validates sandbox-specific fields
- Missing required fields produce correct typed errors

### 9.2 Integration Tests (recommended, env-dependent)

- Jira tracker smoke test with real credentials (`JIRA_API_TOKEN`, `JIRA_USER_EMAIL`)
- Open Agents session creation + chat round-trip against running instance
- Full dispatch cycle: Jira issue → Open Agents session → turn completion → reconciliation
- Sandbox workspace creation + hook execution + cleanup (requires sandbox API access)

Mark as skipped when credentials/services unavailable. Never treat skipped as passed.

---

## 10. Migration and Backward Compatibility

### 10.1 Existing WORKFLOW.md files

No changes required. A `WORKFLOW.md` with `tracker.kind: linear` and a `codex` block works exactly
as before. The `codex` block is interpreted as `agent_runtime.provider: stdio` with all fields
mapped directly.

### 10.2 Dashboard and API

The JSON API at `/api/v1/state` gains a `runtime_provider` field on each running entry. No existing
fields are removed. Field renames (`codex_*` → `agent_*`) apply to the API response keys — if
callers exist, provide both old and new keys during a transition period.

### 10.3 CLI

No new CLI flags required. Provider selection is entirely config-driven via `WORKFLOW.md` front
matter and environment variables.

---

## Appendix A. Example WORKFLOW.md (Jira + Open Agents HTTP)

```yaml
---
tracker:
  kind: jira
  base_url: https://investing.atlassian.net
  api_token: $JIRA_API_TOKEN
  user_email: $JIRA_USER_EMAIL
  project_key: FAST
  active_states:
    - To Do
    - In Progress
  terminal_states:
    - Done
    - Closed
  jql_filter: AND labels = "agent-ready"

polling:
  interval_ms: 30000

workspace:
  provider: sandbox
  sandbox_api_url: $SANDBOX_API_URL
  sandbox_api_token: $SANDBOX_API_TOKEN

hooks:
  after_create: |
    git clone --depth 1 $REPO_URL .
    npm install
  before_run: |
    git fetch origin main
    git checkout -B agent/$ISSUE_KEY origin/main

agent:
  max_concurrent_agents: 5
  max_concurrent_agents_by_state:
    in progress: 3

agent_runtime:
  provider: http
  base_url: $AGENT_RUNTIME_URL
  api_token: $AGENT_RUNTIME_TOKEN
  auto_commit: true
  auto_pr: true
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  max_turns: 10

server:
  port: 4000
---

You are working on Jira issue **{{ issue.identifier }}: {{ issue.title }}**.

**Description:**
{{ issue.description }}

{% if issue.labels.size > 0 %}
**Labels:** {{ issue.labels | join: ", " }}
{% endif %}

{% if attempt %}
This is retry attempt #{{ attempt }}. Check git log and status for prior work.
{% endif %}

**Instructions:**
1. Read the issue description carefully.
2. Implement the required changes with tests.
3. Ensure all existing tests pass.
4. Commit referencing {{ issue.identifier }}.
5. Push and create a pull request.
```

## Appendix B. Example WORKFLOW.md (Jira + Codex stdio, backward-compatible)

```yaml
---
tracker:
  kind: jira
  base_url: https://investing.atlassian.net
  api_token: $JIRA_API_TOKEN
  user_email: $JIRA_USER_EMAIL
  project_key: FAST
  active_states:
    - To Do
    - In Progress

workspace:
  root: ~/symphony_workspaces

codex:
  command: codex app-server
  approval_policy: auto-edit

agent:
  max_concurrent_agents: 10

server:
  port: 4000
---

You are working on {{ issue.identifier }}: {{ issue.title }}.

{{ issue.description }}

{% if attempt %}
Retry attempt #{{ attempt }}. Check git status for prior work.
{% endif %}

Implement the changes, write tests, commit referencing {{ issue.identifier }}.
```

Note: this example uses the `codex` block (not `agent_runtime`) to demonstrate backward
compatibility. It works without any changes to the config format.
