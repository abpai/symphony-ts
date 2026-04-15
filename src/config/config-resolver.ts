import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

import type { WorkflowDefinition } from "../domain/model.js";
import { normalizeIssueState } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import {
  DEFAULT_ACTIVE_STATES,
  DEFAULT_AGENT_RUNTIME_AUTO_COMMIT,
  DEFAULT_AGENT_RUNTIME_AUTO_PR,
  DEFAULT_AGENT_RUNTIME_PROVIDER,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_JIRA_ACTIVE_STATES,
  DEFAULT_JIRA_TERMINAL_STATES,
  DEFAULT_LINEAR_ENDPOINT,
  DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
  DEFAULT_LINEAR_PAGE_SIZE,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_OBSERVABILITY_ENABLED,
  DEFAULT_OBSERVABILITY_REFRESH_MS,
  DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TERMINAL_STATES,
  DEFAULT_TRACKER_KIND,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_WORKSPACE_PROVIDER,
  DEFAULT_WORKSPACE_ROOT,
} from "./defaults.js";
import type {
  DispatchValidationResult,
  ResolvedWorkflowConfig,
} from "./types.js";

const LINEAR_CANONICAL_API_KEY_ENV = "LINEAR_API_KEY";
const JIRA_CANONICAL_API_KEY_ENV = "JIRA_API_TOKEN";
const JIRA_CANONICAL_USER_ENV = "JIRA_USER_EMAIL";
const AGENT_RUNTIME_URL_ENV = "AGENT_RUNTIME_URL";
const AGENT_RUNTIME_TOKEN_ENV = "AGENT_RUNTIME_TOKEN";
const SANDBOX_API_URL_ENV = "SANDBOX_API_URL";
const SANDBOX_API_TOKEN_ENV = "SANDBOX_API_TOKEN";

export function resolveWorkflowConfig(
  workflow: WorkflowDefinition & { workflowPath: string },
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedWorkflowConfig {
  const config = workflow.config;
  const tracker = asRecord(config.tracker);
  const polling = asRecord(config.polling);
  const workspace = asRecord(config.workspace);
  const hooks = asRecord(config.hooks);
  const agent = asRecord(config.agent);
  const codex = asRecord(config.codex);
  const agentRuntime = asRecord(config.agent_runtime);
  const server = asRecord(config.server);
  const observability = asRecord(config.observability);

  const trackerKind =
    typeof tracker.kind === "string" && tracker.kind.trim() !== ""
      ? tracker.kind.trim().toLowerCase()
      : DEFAULT_TRACKER_KIND;
  const workspaceProvider =
    typeof workspace.provider === "string" && workspace.provider.trim() !== ""
      ? workspace.provider.trim().toLowerCase()
      : DEFAULT_WORKSPACE_PROVIDER;
  const runtimeProvider =
    typeof agentRuntime.provider === "string" &&
    agentRuntime.provider.trim() !== ""
      ? agentRuntime.provider.trim().toLowerCase()
      : DEFAULT_AGENT_RUNTIME_PROVIDER;

  const trackerApiKey =
    resolveEnvReference(
      readString(tracker.api_token) ?? readString(tracker.api_key),
      environment,
    ) ??
    (trackerKind === "jira"
      ? (environment[JIRA_CANONICAL_API_KEY_ENV] ?? null)
      : (environment[LINEAR_CANONICAL_API_KEY_ENV] ?? null));
  const trackerUserEmail =
    resolveEnvReference(readString(tracker.user_email), environment) ??
    (trackerKind === "jira"
      ? (environment[JIRA_CANONICAL_USER_ENV] ?? null)
      : null);

  const resolvedAgentMaxTurns =
    readPositiveInteger(agent.max_turns) ?? DEFAULT_MAX_TURNS;

  const resolvedCodex = {
    command: readString(codex.command) ?? DEFAULT_CODEX_COMMAND,
    approvalPolicy: codex.approval_policy,
    threadSandbox: codex.thread_sandbox,
    turnSandboxPolicy: codex.turn_sandbox_policy,
    turnTimeoutMs:
      readPositiveInteger(codex.turn_timeout_ms) ?? DEFAULT_TURN_TIMEOUT_MS,
    readTimeoutMs:
      readPositiveInteger(codex.read_timeout_ms) ?? DEFAULT_READ_TIMEOUT_MS,
    stallTimeoutMs:
      readInteger(codex.stall_timeout_ms) ?? DEFAULT_STALL_TIMEOUT_MS,
  };

  const resolvedAgentRuntimeProvider =
    Object.keys(agentRuntime).length === 0
      ? DEFAULT_AGENT_RUNTIME_PROVIDER
      : runtimeProvider;

  const resolvedAgentRuntime = {
    provider: resolvedAgentRuntimeProvider,
    command:
      readString(agentRuntime.command) ??
      resolvedCodex.command ??
      DEFAULT_CODEX_COMMAND,
    approvalPolicy:
      agentRuntime.approval_policy !== undefined
        ? agentRuntime.approval_policy
        : resolvedCodex.approvalPolicy,
    threadSandbox:
      agentRuntime.thread_sandbox !== undefined
        ? agentRuntime.thread_sandbox
        : resolvedCodex.threadSandbox,
    turnSandboxPolicy:
      agentRuntime.turn_sandbox_policy !== undefined
        ? agentRuntime.turn_sandbox_policy
        : resolvedCodex.turnSandboxPolicy,
    baseUrl:
      resolveEnvReference(readString(agentRuntime.base_url), environment) ??
      environment[AGENT_RUNTIME_URL_ENV] ??
      null,
    apiToken:
      resolveEnvReference(readString(agentRuntime.api_token), environment) ??
      environment[AGENT_RUNTIME_TOKEN_ENV] ??
      null,
    githubInstallationId: readString(agentRuntime.github_installation_id),
    autoCommit:
      readBoolean(agentRuntime.auto_commit) ??
      DEFAULT_AGENT_RUNTIME_AUTO_COMMIT,
    autoPr: readBoolean(agentRuntime.auto_pr) ?? DEFAULT_AGENT_RUNTIME_AUTO_PR,
    turnTimeoutMs:
      readPositiveInteger(agentRuntime.turn_timeout_ms) ??
      resolvedCodex.turnTimeoutMs,
    readTimeoutMs:
      readPositiveInteger(agentRuntime.read_timeout_ms) ??
      resolvedCodex.readTimeoutMs,
    stallTimeoutMs:
      readInteger(agentRuntime.stall_timeout_ms) ??
      resolvedCodex.stallTimeoutMs,
    maxTurns:
      readPositiveInteger(agentRuntime.max_turns) ?? resolvedAgentMaxTurns,
  } as const;

  return {
    workflowPath: workflow.workflowPath,
    promptTemplate: workflow.promptTemplate,
    tracker: {
      kind: trackerKind,
      endpoint: readString(tracker.endpoint) ?? DEFAULT_LINEAR_ENDPOINT,
      apiKey: trackerApiKey,
      projectSlug: readString(tracker.project_slug),
      baseUrl: normalizeBaseUrl(
        resolveEnvReference(readString(tracker.base_url), environment),
      ),
      userEmail: trackerUserEmail,
      projectKey: readString(tracker.project_key),
      jqlFilter: readString(tracker.jql_filter),
      activeStates: readStringList(
        tracker.active_states,
        trackerKind === "jira"
          ? DEFAULT_JIRA_ACTIVE_STATES
          : DEFAULT_ACTIVE_STATES,
      ),
      terminalStates: readStringList(
        tracker.terminal_states,
        trackerKind === "jira"
          ? DEFAULT_JIRA_TERMINAL_STATES
          : DEFAULT_TERMINAL_STATES,
      ),
    },
    polling: {
      intervalMs: readInteger(polling.interval_ms) ?? DEFAULT_POLL_INTERVAL_MS,
    },
    workspace: {
      provider: workspaceProvider,
      root:
        resolvePathValue(
          readString(workspace.root),
          workflow.workflowPath,
          environment,
        ) ?? DEFAULT_WORKSPACE_ROOT,
      sandboxApiUrl: normalizeBaseUrl(
        resolveEnvReference(
          readString(workspace.sandbox_api_url),
          environment,
        ) ??
          environment[SANDBOX_API_URL_ENV] ??
          null,
      ),
      sandboxApiToken:
        resolveEnvReference(
          readString(workspace.sandbox_api_token),
          environment,
        ) ??
        environment[SANDBOX_API_TOKEN_ENV] ??
        null,
      sandboxBaseSnapshotId: readString(workspace.sandbox_base_snapshot_id),
      sandboxIdleTimeoutMs:
        readPositiveInteger(workspace.sandbox_idle_timeout_ms) ??
        DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
    },
    hooks: {
      afterCreate: readScript(hooks.after_create),
      beforeRun: readScript(hooks.before_run),
      afterRun: readScript(hooks.after_run),
      beforeRemove: readScript(hooks.before_remove),
      timeoutMs:
        readPositiveInteger(hooks.timeout_ms) ?? DEFAULT_HOOK_TIMEOUT_MS,
    },
    agent: {
      maxConcurrentAgents:
        readPositiveInteger(agent.max_concurrent_agents) ??
        DEFAULT_MAX_CONCURRENT_AGENTS,
      maxTurns: resolvedAgentMaxTurns,
      maxRetryBackoffMs:
        readPositiveInteger(agent.max_retry_backoff_ms) ??
        DEFAULT_MAX_RETRY_BACKOFF_MS,
      maxConcurrentAgentsByState: readStateConcurrencyMap(
        agent.max_concurrent_agents_by_state,
      ),
    },
    codex: resolvedCodex,
    agentRuntime: resolvedAgentRuntime,
    server: {
      port: readNonNegativeInteger(server.port),
    },
    observability: {
      dashboardEnabled:
        readBoolean(observability.dashboard_enabled) ??
        DEFAULT_OBSERVABILITY_ENABLED,
      refreshMs:
        readPositiveInteger(observability.refresh_ms) ??
        DEFAULT_OBSERVABILITY_REFRESH_MS,
      renderIntervalMs:
        readPositiveInteger(observability.render_interval_ms) ??
        DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
    },
  };
}

export function validateDispatchConfig(
  config: ResolvedWorkflowConfig,
): DispatchValidationResult {
  const trackerKind = config.tracker.kind?.trim();
  if (!trackerKind) {
    return invalid(
      ERROR_CODES.configInvalid,
      "tracker.kind must be present before dispatch.",
    );
  }

  if (trackerKind !== "linear" && trackerKind !== "jira") {
    return invalid(
      ERROR_CODES.unsupportedTrackerKind,
      `tracker.kind '${trackerKind}' is not supported.`,
    );
  }

  if (!config.tracker.apiKey || config.tracker.apiKey.trim() === "") {
    return invalid(
      ERROR_CODES.trackerCredentialsMissing,
      trackerKind === "jira"
        ? "tracker.api_token must be configured before dispatch."
        : "tracker.api_key must be configured before dispatch.",
    );
  }

  if (trackerKind === "linear") {
    if (
      !config.tracker.projectSlug ||
      config.tracker.projectSlug.trim() === ""
    ) {
      return invalid(
        ERROR_CODES.configInvalid,
        "tracker.project_slug must be configured before dispatch.",
      );
    }
  }

  if (trackerKind === "jira") {
    if (!config.tracker.baseUrl || !isValidUrl(config.tracker.baseUrl)) {
      return invalid(
        ERROR_CODES.configInvalid,
        "tracker.base_url must be configured as a valid URL before dispatch.",
      );
    }
    if (!config.tracker.userEmail || config.tracker.userEmail.trim() === "") {
      return invalid(
        ERROR_CODES.trackerCredentialsMissing,
        "tracker.user_email must be configured before dispatch.",
      );
    }
    if (!config.tracker.projectKey || config.tracker.projectKey.trim() === "") {
      return invalid(
        ERROR_CODES.configInvalid,
        "tracker.project_key must be configured before dispatch.",
      );
    }
  }

  const agentRuntime = config.agentRuntime ?? {
    provider: "stdio" as const,
    command: config.codex.command,
    approvalPolicy: config.codex.approvalPolicy,
    threadSandbox: config.codex.threadSandbox,
    turnSandboxPolicy: config.codex.turnSandboxPolicy,
    turnTimeoutMs: config.codex.turnTimeoutMs,
    readTimeoutMs: config.codex.readTimeoutMs,
    stallTimeoutMs: config.codex.stallTimeoutMs,
    maxTurns: config.agent.maxTurns,
  };

  if (agentRuntime.provider !== "stdio" && agentRuntime.provider !== "http") {
    return invalid(
      ERROR_CODES.configInvalid,
      `agent_runtime.provider '${agentRuntime.provider}' is not supported.`,
    );
  }

  const workspaceProvider =
    config.workspace.provider ?? DEFAULT_WORKSPACE_PROVIDER;
  if (workspaceProvider !== "local" && workspaceProvider !== "sandbox") {
    return invalid(
      ERROR_CODES.configInvalid,
      `workspace.provider '${workspaceProvider}' is not supported.`,
    );
  }

  if (agentRuntime.provider === "stdio") {
    if (agentRuntime.command.trim() === "") {
      return invalid(
        ERROR_CODES.configInvalid,
        "agent_runtime.command must be present and non-empty before dispatch.",
      );
    }
    if (workspaceProvider === "sandbox") {
      return invalid(
        ERROR_CODES.configInvalid,
        "workspace.provider 'sandbox' is only supported with agent_runtime.provider 'http'.",
      );
    }
  }

  if (agentRuntime.provider === "http") {
    if (!agentRuntime.baseUrl || !isValidUrl(agentRuntime.baseUrl)) {
      return invalid(
        ERROR_CODES.configInvalid,
        "agent_runtime.base_url must be configured as a valid URL before dispatch.",
      );
    }
  }

  if (workspaceProvider === "sandbox") {
    if (
      !config.workspace.sandboxApiUrl ||
      !isValidUrl(config.workspace.sandboxApiUrl)
    ) {
      return invalid(
        ERROR_CODES.configInvalid,
        "workspace.sandbox_api_url must be configured as a valid URL before dispatch.",
      );
    }
    if (
      !config.workspace.sandboxApiToken ||
      config.workspace.sandboxApiToken.trim() === ""
    ) {
      return invalid(
        ERROR_CODES.trackerCredentialsMissing,
        "workspace.sandbox_api_token must be configured before dispatch.",
      );
    }
  }

  return { ok: true };
}

function invalid(code: string, message: string): DispatchValidationResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value;
}

function readTrackerKind(value: unknown): string {
  const kind = readString(value)?.trim().toLowerCase();
  return kind && kind !== "" ? kind : DEFAULT_TRACKER_KIND;
}

function readWorkspaceProvider(value: unknown): string {
  const provider = readString(value)?.trim().toLowerCase();
  return provider && provider !== "" ? provider : DEFAULT_WORKSPACE_PROVIDER;
}

function readRuntimeProvider(value: unknown): string {
  const provider = readString(value)?.trim().toLowerCase();
  return provider && provider !== ""
    ? provider
    : DEFAULT_AGENT_RUNTIME_PROVIDER;
}

function readScript(value: unknown): string | null {
  const script = readString(value);
  if (script === null) {
    return null;
  }

  return script === "" ? null : script;
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return null;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = readInteger(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }

  return parsed;
}

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = readInteger(value);
  if (parsed === null || parsed < 0) {
    return null;
  }

  return parsed;
}

function readStringList(value: unknown, fallback: readonly string[]): string[] {
  if (Array.isArray(value)) {
    const items = value.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (items.length > 0) {
      return items.map((entry) => entry.trim()).filter((entry) => entry !== "");
    }
  }

  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (items.length > 0) {
      return items;
    }
  }

  return [...fallback];
}

function readStateConcurrencyMap(
  value: unknown,
): Readonly<Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE;
  }

  const normalizedEntries = Object.entries(value).flatMap(([state, limit]) => {
    const parsedLimit = readPositiveInteger(limit);
    if (parsedLimit === null) {
      return [];
    }

    return [[normalizeIssueState(state), parsedLimit] as const];
  });

  return Object.freeze(Object.fromEntries(normalizedEntries));
}

function resolveEnvReference(
  value: string | null,
  environment: NodeJS.ProcessEnv,
): string | null {
  if (!value) {
    return null;
  }

  if (!value.startsWith("$")) {
    return value;
  }

  const envName = value.slice(1);
  const resolvedValue = environment[envName];
  if (!resolvedValue || resolvedValue.trim() === "") {
    return null;
  }

  return resolvedValue;
}

function normalizeBaseUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.replace(/\/$/, "");
}

function resolvePathValue(
  value: string | null,
  workflowPath: string,
  environment: NodeJS.ProcessEnv,
): string | null {
  const rawPath = resolveEnvReference(value, environment);
  if (!rawPath) {
    return null;
  }

  let expanded = rawPath.startsWith("~")
    ? `${homedir()}${rawPath.slice(1)}`
    : rawPath;

  if (
    !expanded.includes(sep) &&
    !expanded.includes("/") &&
    !expanded.includes("\\")
  ) {
    return expanded;
  }

  if (isAbsolute(expanded)) {
    return normalize(expanded);
  }

  expanded = resolve(resolve(workflowPath, ".."), expanded);
  return normalize(expanded);
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const LINEAR_DEFAULTS = Object.freeze({
  endpoint: DEFAULT_LINEAR_ENDPOINT,
  pageSize: DEFAULT_LINEAR_PAGE_SIZE,
  networkTimeoutMs: DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
});
