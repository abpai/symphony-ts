import type {
  AgentRateLimits,
  AgentTotals,
  OrchestratorState,
} from "../domain/model.js";
import { getAggregateSecondsRunning } from "./session-metrics.js";

export interface RuntimeSnapshotRunningRow {
  issue_id: string;
  issue_identifier: string;
  state: string;
  session_id: string | null;
  runtime_provider?: string;
  workspace_provider?: string;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface RuntimeSnapshotRetryRow {
  issue_id: string;
  issue_identifier: string | null;
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface RuntimeSnapshotTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface RuntimeSnapshot {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
  };
  running: RuntimeSnapshotRunningRow[];
  retrying: RuntimeSnapshotRetryRow[];
  agent_totals: RuntimeSnapshotTotals;
  codex_totals: RuntimeSnapshotTotals;
  rate_limits: AgentRateLimits;
}

export function buildRuntimeSnapshot(
  state: OrchestratorState,
  options?: {
    now?: Date;
  },
): RuntimeSnapshot {
  const now = options?.now ?? new Date();

  const running = Object.values(state.running)
    .slice()
    .sort((left, right) =>
      left.identifier.localeCompare(right.identifier, "en"),
    )
    .map((entry) => ({
      issue_id: entry.issue.id,
      issue_identifier: entry.identifier,
      state: entry.issue.state,
      session_id: entry.sessionId,
      runtime_provider: entry.runtimeProvider === "http" ? "http" : "stdio",
      workspace_provider:
        entry.workspaceProvider === "sandbox" ? "sandbox" : "local",
      turn_count: entry.turnCount,
      last_event: (entry.lastAgentEvent ?? entry.lastCodexEvent ?? null) as
        | string
        | null,
      last_message: (entry.lastAgentMessage ??
        entry.lastCodexMessage ??
        null) as string | null,
      started_at: entry.startedAt,
      last_event_at: (entry.lastAgentTimestamp ??
        entry.lastCodexTimestamp ??
        null) as string | null,
      tokens: {
        input_tokens: preferLegacyCounter(
          entry.agentInputTokens,
          entry.codexInputTokens,
        ),
        output_tokens: preferLegacyCounter(
          entry.agentOutputTokens,
          entry.codexOutputTokens,
        ),
        total_tokens: preferLegacyCounter(
          entry.agentTotalTokens,
          entry.codexTotalTokens,
        ),
      },
    }));

  const retrying = Object.values(state.retryAttempts)
    .slice()
    .sort((left, right) => left.dueAtMs - right.dueAtMs)
    .map((entry) => ({
      issue_id: entry.issueId,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: new Date(entry.dueAtMs).toISOString(),
      error: entry.error,
    }));

  const totals = toSnapshotAgentTotals(
    state.agentTotals,
    getAggregateSecondsRunning(state, now),
  );

  return {
    generated_at: now.toISOString(),
    counts: {
      running: running.length,
      retrying: retrying.length,
    },
    running,
    retrying,
    agent_totals: totals,
    codex_totals: totals,
    rate_limits: state.agentRateLimits ?? state.codexRateLimits,
  };
}

function toSnapshotAgentTotals(
  totals: AgentTotals,
  secondsRunning: number,
): RuntimeSnapshotTotals {
  return {
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    total_tokens: totals.totalTokens,
    seconds_running: secondsRunning,
  };
}

function toNullableText(value: string | null | undefined): string | null {
  return value ?? null;
}

function preferLegacyCounter(
  primary: number | undefined,
  legacy: number | undefined,
): number {
  if (typeof primary === "number" && primary > 0) {
    return primary;
  }
  if (typeof legacy === "number") {
    return legacy;
  }
  return primary ?? 0;
}
