import type { AgentRuntimeEvent } from "../agent-runtime/types.js";
import type {
  LiveSession,
  OrchestratorState,
  RunningEntry,
} from "../domain/model.js";

const SESSION_EVENT_MESSAGES: Partial<
  Record<AgentRuntimeEvent["event"], string>
> = Object.freeze({
  session_started: "session started",
  startup_failed: "startup failed",
  turn_completed: "turn completed",
  turn_failed: "turn failed",
  turn_cancelled: "turn cancelled",
  turn_ended_with_error: "turn ended with error",
  turn_input_required: "operator input required",
  approval_auto_approved: "approval auto approved",
  unsupported_tool_call: "unsupported tool call",
  notification: "notification",
  other_message: "other message",
  malformed: "malformed event",
});

export interface SessionTelemetryUpdateResult {
  inputTokensDelta: number;
  outputTokensDelta: number;
  totalTokensDelta: number;
  rateLimitsUpdated: boolean;
}

export function applyAgentEventToSession(
  session: LiveSession,
  event: AgentRuntimeEvent,
): SessionTelemetryUpdateResult {
  if (event.sessionId !== undefined) {
    session.sessionId = event.sessionId;
  }
  if (event.threadId !== undefined) {
    session.threadId = event.threadId;
  }
  if (event.turnId !== undefined) {
    session.turnId = event.turnId;
  }
  session.processId = event.processId ?? event.codexAppServerPid ?? null;
  session.agentProcessId = session.processId;
  session.codexAppServerPid = session.processId;
  session.lastAgentEvent = event.event;
  session.lastCodexEvent = event.event;
  session.lastAgentTimestamp = event.timestamp;
  session.lastCodexTimestamp = event.timestamp;
  session.lastAgentMessage = summarizeAgentEvent(event);
  session.lastCodexMessage = session.lastAgentMessage;

  if (event.event === "session_started") {
    session.turnCount += 1;
  }

  if (event.usage === undefined) {
    return {
      inputTokensDelta: 0,
      outputTokensDelta: 0,
      totalTokensDelta: 0,
      rateLimitsUpdated: event.rateLimits !== undefined,
    };
  }

  const inputTokens = normalizeAbsoluteCounter(event.usage.inputTokens);
  const outputTokens = normalizeAbsoluteCounter(event.usage.outputTokens);
  const totalTokens = normalizeAbsoluteCounter(event.usage.totalTokens);

  const inputTokensDelta = computeCounterDelta(
    session.lastReportedInputTokens,
    inputTokens,
  );
  const outputTokensDelta = computeCounterDelta(
    session.lastReportedOutputTokens,
    outputTokens,
  );
  const totalTokensDelta = computeCounterDelta(
    session.lastReportedTotalTokens,
    totalTokens,
  );

  session.agentInputTokens = inputTokens;
  session.agentOutputTokens = outputTokens;
  session.agentTotalTokens = totalTokens;
  session.codexInputTokens = inputTokens;
  session.codexOutputTokens = outputTokens;
  session.codexTotalTokens = totalTokens;
  session.lastReportedInputTokens = inputTokens;
  session.lastReportedOutputTokens = outputTokens;
  session.lastReportedTotalTokens = totalTokens;

  return {
    inputTokensDelta,
    outputTokensDelta,
    totalTokensDelta,
    rateLimitsUpdated: event.rateLimits !== undefined,
  };
}

export function applyAgentEventToOrchestratorState(
  state: OrchestratorState,
  runningEntry: RunningEntry,
  event: AgentRuntimeEvent,
): SessionTelemetryUpdateResult {
  const result = applyAgentEventToSession(runningEntry, event);

  state.agentTotals.inputTokens += result.inputTokensDelta;
  state.agentTotals.outputTokens += result.outputTokensDelta;
  state.agentTotals.totalTokens += result.totalTokensDelta;
  state.codexTotals.inputTokens = state.agentTotals.inputTokens;
  state.codexTotals.outputTokens = state.agentTotals.outputTokens;
  state.codexTotals.totalTokens = state.agentTotals.totalTokens;
  state.codexTotals.secondsRunning = state.agentTotals.secondsRunning;

  if (event.rateLimits !== undefined) {
    state.agentRateLimits = event.rateLimits;
    state.codexRateLimits = event.rateLimits;
  }

  return result;
}

export function addEndedSessionRuntime(
  state: OrchestratorState,
  startedAt: string,
  endedAt = new Date(),
): number {
  const startedAtMs = Date.parse(startedAt);
  const endedAtMs = endedAt.getTime();
  if (!Number.isFinite(startedAtMs) || endedAtMs < startedAtMs) {
    return state.agentTotals.secondsRunning;
  }

  const seconds = roundSeconds((endedAtMs - startedAtMs) / 1000);
  state.agentTotals.secondsRunning = roundSeconds(
    state.agentTotals.secondsRunning + seconds,
  );
  state.codexTotals.secondsRunning = state.agentTotals.secondsRunning;
  return state.agentTotals.secondsRunning;
}

export function getAggregateSecondsRunning(
  state: OrchestratorState,
  now = new Date(),
): number {
  const nowMs = now.getTime();
  let total = state.agentTotals.secondsRunning;

  for (const runningEntry of Object.values(state.running)) {
    const startedAtMs = Date.parse(runningEntry.startedAt);
    if (!Number.isFinite(startedAtMs) || nowMs < startedAtMs) {
      continue;
    }

    total += (nowMs - startedAtMs) / 1000;
  }

  return roundSeconds(total);
}

export function summarizeAgentEvent(event: AgentRuntimeEvent): string {
  if (event.message !== undefined && event.message.trim().length > 0) {
    return event.message.trim();
  }

  if (
    event.event === "unsupported_tool_call" &&
    event.toolName !== undefined &&
    event.toolName !== null &&
    event.toolName.trim().length > 0
  ) {
    return `unsupported tool call: ${event.toolName.trim()}`;
  }

  const fallback = SESSION_EVENT_MESSAGES[event.event];
  return fallback ?? event.event;
}

export const applyCodexEventToSession = applyAgentEventToSession;
export const applyCodexEventToOrchestratorState =
  applyAgentEventToOrchestratorState;
export const summarizeCodexEvent = summarizeAgentEvent;

function computeCounterDelta(previous: number, next: number): number {
  if (!Number.isFinite(previous)) {
    return next;
  }
  return Math.max(0, next - previous);
}

function normalizeAbsoluteCounter(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
