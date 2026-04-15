import type { Issue, Workspace } from "../domain/model.js";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AgentRuntimeEvent {
  event:
    | "session_started"
    | "startup_failed"
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "turn_ended_with_error"
    | "turn_input_required"
    | "approval_auto_approved"
    | "unsupported_tool_call"
    | "notification"
    | "other_message"
    | "malformed";
  timestamp: string;
  processId?: string | null;
  codexAppServerPid?: string | null;
  sessionId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  usage?: AgentUsage;
  rateLimits?: Record<string, unknown> | null;
  errorCode?: string;
  message?: string;
  raw?: unknown;
  toolName?: string | null;
  payload?: unknown;
}

export interface AgentSession {
  sessionId: string;
  threadId: string | null;
  turnId: string | null;
  processId?: string | null;
  codexAppServerPid?: string | null;
}

export type AgentTurnOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "input_required";

export interface AgentTurnResult {
  outcome: AgentTurnOutcome;
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  processId: string | null;
  usage: AgentUsage | null;
  rateLimits: Record<string, unknown> | null;
  message: string | null;
  error?: string;
}

export interface AgentRuntimeStartParams {
  environment: Workspace;
  issue: Issue;
}

export interface AgentRuntimeTurnParams {
  session: AgentSession;
  prompt: string;
  issue: Issue;
  environment: Workspace;
  title: string;
  onEvent: (event: AgentRuntimeEvent) => void;
}
