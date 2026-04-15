export const ORCHESTRATOR_ISSUE_STATUSES = [
  "unclaimed",
  "claimed",
  "running",
  "retry_queued",
  "released",
] as const;

export type OrchestratorIssueStatus =
  (typeof ORCHESTRATOR_ISSUE_STATUSES)[number];

export const RUN_ATTEMPT_PHASES = [
  "preparing_workspace",
  "building_prompt",
  "launching_agent_process",
  "initializing_session",
  "streaming_turn",
  "finishing",
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
] as const;

export type RunAttemptPhase = (typeof RUN_ATTEMPT_PHASES)[number];

export const ORCHESTRATOR_EVENTS = [
  "poll_tick",
  "worker_exit_normal",
  "worker_exit_abnormal",
  "codex_update_event",
  "retry_timer_fired",
  "reconciliation_state_refresh",
  "stall_timeout",
] as const;

export type OrchestratorEvent = (typeof ORCHESTRATOR_EVENTS)[number];

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
  cwd?: string;
  environmentId?: string;
  provider?: "local" | "sandbox";
  snapshotId?: string | null;
}

export interface RunAttempt {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  startedAt: string;
  status: RunAttemptPhase;
  error?: string;
}

export interface LiveSession {
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  processId?: string | null;
  agentProcessId?: string | null;
  codexAppServerPid: string | null;
  lastAgentEvent?: string | null;
  lastAgentTimestamp?: string | null;
  lastAgentMessage?: string | null;
  lastCodexEvent: string | null;
  lastCodexTimestamp: string | null;
  lastCodexMessage: string | null;
  agentInputTokens?: number;
  agentOutputTokens?: number;
  agentTotalTokens?: number;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
}

export interface RetryEntry {
  issueId: string;
  identifier: string | null;
  attempt: number;
  dueAtMs: number;
  timerHandle: ReturnType<typeof setTimeout> | null;
  error: string | null;
}

export interface AgentTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export type AgentRateLimits = Record<string, unknown> | null;
export type CodexTotals = AgentTotals;
export type CodexRateLimits = AgentRateLimits;

export interface RunningEntry extends LiveSession {
  issue: Issue;
  identifier: string;
  retryAttempt: number | null;
  startedAt: string;
  workspacePath?: string | null;
  workerHandle: unknown;
  monitorHandle: unknown;
  runtimeProvider?: "stdio" | "http" | string;
  workspaceProvider?: "local" | "sandbox" | string;
}

export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Record<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Record<string, RetryEntry>;
  completed: Set<string>;
  agentTotals: AgentTotals;
  agentRateLimits: AgentRateLimits;
  codexTotals: CodexTotals;
  codexRateLimits: CodexRateLimits;
}

export function normalizeIssueState(state: string): string {
  return state.trim().toLowerCase();
}

export function toWorkspaceKey(issueIdentifier: string): string {
  return issueIdentifier.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

export function toSessionId(threadId: string, turnId: string): string {
  return `${threadId}-${turnId}`;
}

export function createEmptyLiveSession(): LiveSession {
  return {
    sessionId: null,
    threadId: null,
    turnId: null,
    processId: null,
    agentProcessId: null,
    codexAppServerPid: null,
    lastAgentEvent: null,
    lastAgentTimestamp: null,
    lastAgentMessage: null,
    lastCodexEvent: null,
    lastCodexTimestamp: null,
    lastCodexMessage: null,
    agentInputTokens: 0,
    agentOutputTokens: 0,
    agentTotalTokens: 0,
    codexInputTokens: 0,
    codexOutputTokens: 0,
    codexTotalTokens: 0,
    lastReportedInputTokens: 0,
    lastReportedOutputTokens: 0,
    lastReportedTotalTokens: 0,
    turnCount: 0,
  };
}

export function createInitialOrchestratorState(input: {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
}): OrchestratorState {
  const agentTotals: AgentTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
  };

  return {
    pollIntervalMs: input.pollIntervalMs,
    maxConcurrentAgents: input.maxConcurrentAgents,
    running: {},
    claimed: new Set<string>(),
    retryAttempts: {},
    completed: new Set<string>(),
    agentTotals,
    agentRateLimits: null,
    codexTotals: agentTotals,
    codexRateLimits: null,
  };
}
