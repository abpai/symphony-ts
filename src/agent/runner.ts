import { rm } from "node:fs/promises";

import {
  type AgentRuntime,
  type AgentRuntimeEvent,
  type CreateAgentRuntimeOptions,
  createAgentRuntime,
} from "../agent-runtime/interface.js";
import type { AgentSession } from "../agent-runtime/types.js";
import type { CodexAppServerClientOptions } from "../codex/app-server-client.js";
import type { ResolvedWorkflowConfig } from "../config/types.js";
import {
  type Issue,
  type LiveSession,
  type RunAttempt,
  type RunAttemptPhase,
  type Workspace,
  createEmptyLiveSession,
  normalizeIssueState,
} from "../domain/model.js";
import { applyAgentEventToSession } from "../logging/session-metrics.js";
import type { IssueTracker } from "../tracker/tracker.js";
import { WorkspaceHookRunner } from "../workspace/hooks.js";
import {
  type WorkspaceProvider,
  createWorkspaceProvider,
} from "../workspace/interface.js";
import { validateWorkspaceCwd } from "../workspace/path-safety.js";
import { buildTurnPrompt } from "./prompt-builder.js";

export interface AgentRunnerEvent extends AgentRuntimeEvent {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  turnCount: number;
}

export type AgentRunnerCodexClientFactoryInput = CodexAppServerClientOptions & {
  onEvent: NonNullable<CodexAppServerClientOptions["onEvent"]>;
};

export interface AgentRunnerOptions {
  config: ResolvedWorkflowConfig;
  tracker: IssueTracker;
  workspaceProvider?: WorkspaceProvider;
  hooks?: WorkspaceHookRunner;
  runtime?: AgentRuntime;
  createAgentRuntime?: () => AgentRuntime;
  createCodexClient?: (input: AgentRunnerCodexClientFactoryInput) => {
    startSession(input: { prompt: string; title: string }): Promise<{
      status: "completed" | "failed" | "cancelled";
      threadId: string;
      turnId: string;
      sessionId: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      } | null;
      rateLimits: Record<string, unknown> | null;
      message: string | null;
    }>;
    continueTurn(
      prompt: string,
      title: string,
    ): Promise<{
      status: "completed" | "failed" | "cancelled";
      threadId: string;
      turnId: string;
      sessionId: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      } | null;
      rateLimits: Record<string, unknown> | null;
      message: string | null;
    }>;
    close(): Promise<void>;
  };
  fetchFn?: typeof fetch;
  onEvent?: (event: AgentRunnerEvent) => void;
}

export interface AgentRunInput {
  issue: Issue;
  attempt: number | null;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  issue: Issue;
  workspace: Workspace;
  runAttempt: RunAttempt;
  liveSession: LiveSession;
  turnsCompleted: number;
  lastTurn: {
    outcome: string;
    message: string | null;
  } | null;
  rateLimits: Record<string, unknown> | null;
}

export class AgentRunnerError extends Error {
  readonly code: string | undefined;
  readonly status: RunAttemptPhase;
  readonly failedPhase: RunAttemptPhase;
  readonly issue: Issue;
  readonly workspace: Workspace | null;
  readonly runAttempt: RunAttempt;
  readonly liveSession: LiveSession;

  constructor(input: {
    message: string;
    code?: string;
    status: RunAttemptPhase;
    failedPhase: RunAttemptPhase;
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "AgentRunnerError";
    this.code = input.code;
    this.status = input.status;
    this.failedPhase = input.failedPhase;
    this.issue = input.issue;
    this.workspace = input.workspace;
    this.runAttempt = input.runAttempt;
    this.liveSession = input.liveSession;
  }
}

export class AgentRunner {
  private readonly config: ResolvedWorkflowConfig;
  private readonly tracker: IssueTracker;
  private readonly workspaceProvider: WorkspaceProvider;
  private readonly runtime: AgentRuntime;
  private readonly onEvent: ((event: AgentRunnerEvent) => void) | undefined;

  constructor(options: AgentRunnerOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    const hookRunner =
      options.hooks ??
      new WorkspaceHookRunner({
        config: options.config.hooks,
      });
    this.workspaceProvider =
      options.workspaceProvider ??
      createWorkspaceProvider(options.config.workspace, {
        hooksConfig: options.config.hooks,
        hookRunner,
        ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
        logicalOnly:
          (options.config.workspace.provider ?? "local") === "sandbox" &&
          (options.config.agentRuntime?.provider ?? "stdio") === "http",
      });
    this.runtime =
      options.runtime ??
      options.createAgentRuntime?.() ??
      createAgentRuntime({
        config: getAgentRuntimeConfig(options.config),
        trackerConfig: options.config.tracker,
        ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
        ...(options.createCodexClient === undefined
          ? {}
          : {
              createCodexClient:
                options.createCodexClient as CreateAgentRuntimeOptions["createCodexClient"],
            }),
      } as CreateAgentRuntimeOptions);
    this.onEvent = options.onEvent;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    let issue = cloneIssue(input.issue);
    let workspace: Workspace | null = null;
    let session: AgentSession | null = null;
    let lastTurn: AgentRunResult["lastTurn"] = null;
    let rateLimits: Record<string, unknown> | null = null;
    const liveSession = createEmptyLiveSession();
    const runAttempt: RunAttempt = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: input.attempt,
      workspacePath: "",
      startedAt: new Date().toISOString(),
      status: "preparing_workspace",
    };
    const abortController = createAgentAbortController(
      input.signal,
      async () => {
        if (session !== null) {
          await this.runtime.stopSession(session);
        }
      },
    );

    try {
      abortController.throwIfAborted({
        issue,
        workspace,
        runAttempt,
        liveSession,
      });

      workspace = await this.workspaceProvider.createOrReuse(issue.identifier);
      runAttempt.workspacePath =
        workspace.provider === "local"
          ? validateWorkspaceCwd({
              cwd: workspace.cwd ?? workspace.path,
              workspacePath: workspace.path,
              workspaceRoot: this.config.workspace.root ?? "",
            })
          : workspace.path;
      if (workspace.provider === "local") {
        await cleanupWorkspaceArtifacts(workspace.path);
      }

      await this.workspaceProvider.runHook({
        name: "beforeRun",
        environment: workspace,
      });

      runAttempt.status = "launching_agent_process";
      session = await this.runtime.startSession({
        environment: workspace,
        issue,
      });
      abortController.bindSession(session);
      const maxTurns = getAgentRuntimeConfig(this.config).maxTurns;
      for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber += 1) {
        abortController.throwIfAborted({
          issue,
          workspace,
          runAttempt,
          liveSession,
        });
        runAttempt.status = "building_prompt";
        const prompt = await buildTurnPrompt({
          workflow: { promptTemplate: this.config.promptTemplate },
          issue,
          attempt: input.attempt,
          turnNumber,
          maxTurns,
        });
        const title = `${issue.identifier}: ${issue.title}`;

        runAttempt.status =
          turnNumber === 1 ? "initializing_session" : "streaming_turn";
        const activeSession = session;
        if (activeSession === null) {
          throw new Error("Agent session was not initialized.");
        }
        const turnResult = await this.runtime.sendTurn({
          session: activeSession,
          prompt,
          issue,
          environment: workspace,
          title,
          onEvent: (event) => {
            applyAgentEventToSession(liveSession, event);
            this.onEvent?.({
              ...event,
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              attempt: input.attempt,
              workspacePath: workspace?.path ?? "",
              turnCount: liveSession.turnCount,
            });
          },
        });
        session = {
          sessionId: turnResult.sessionId ?? session.sessionId,
          threadId: turnResult.threadId ?? null,
          turnId: turnResult.turnId ?? null,
          processId: turnResult.processId ?? null,
        };
        rateLimits = turnResult.rateLimits;
        lastTurn = {
          outcome: turnResult.outcome,
          message: turnResult.message,
        };

        if (turnResult.outcome !== "completed") {
          throw new Error(
            turnResult.error ??
              turnResult.message ??
              `Agent turn ended with outcome '${turnResult.outcome}'.`,
          );
        }

        const terminalEvent = {
          event: outcomeToEvent(turnResult.outcome),
          timestamp: new Date().toISOString(),
          processId: turnResult.processId ?? liveSession.processId ?? null,
          sessionId: turnResult.sessionId ?? liveSession.sessionId,
          threadId: turnResult.threadId,
          turnId: turnResult.turnId,
          ...(turnResult.usage === null ? {} : { usage: turnResult.usage }),
          ...(turnResult.rateLimits === null
            ? {}
            : { rateLimits: turnResult.rateLimits }),
          ...(turnResult.message === null
            ? {}
            : { message: turnResult.message }),
        };
        applyAgentEventToSession(liveSession, terminalEvent);
        this.onEvent?.({
          ...terminalEvent,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          attempt: input.attempt,
          workspacePath: workspace?.path ?? "",
          turnCount: liveSession.turnCount,
        });

        runAttempt.status = "finishing";
        issue = await this.refreshIssueState(issue);
        if (!this.isIssueStillActive(issue)) {
          break;
        }
      }

      runAttempt.status = "succeeded";

      return {
        issue,
        workspace,
        runAttempt,
        liveSession,
        turnsCompleted: liveSession.turnCount,
        lastTurn,
        rateLimits,
      };
    } catch (error) {
      const wrapped = this.toAgentRunnerError({
        error,
        issue,
        workspace,
        runAttempt,
        liveSession,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      runAttempt.status = wrapped.status;
      runAttempt.error = wrapped.message;
      throw wrapped;
    } finally {
      abortController.dispose();
      if (session !== null) {
        await closeBestEffort(this.runtime, session);
      }
      if (workspace !== null) {
        await this.workspaceProvider.runHookBestEffort({
          name: "afterRun",
          environment: workspace,
        });
      }
    }
  }

  private async refreshIssueState(issue: Issue): Promise<Issue> {
    const refreshed = await this.tracker.fetchIssueStatesByIds([issue.id]);
    const next = refreshed[0];

    if (next === undefined) {
      return issue;
    }

    return {
      ...issue,
      identifier:
        next.identifier.trim().length > 0 ? next.identifier : issue.identifier,
      state: next.state,
    };
  }

  private isIssueStillActive(issue: Issue): boolean {
    const activeStates = new Set(
      this.config.tracker.activeStates.map((state) =>
        normalizeIssueState(state),
      ),
    );
    return activeStates.has(normalizeIssueState(issue.state));
  }

  private toAgentRunnerError(input: {
    error: unknown;
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
    signal?: AbortSignal;
  }): AgentRunnerError {
    if (input.error instanceof AgentRunnerError) {
      return input.error;
    }

    if (input.signal?.aborted) {
      return new AgentRunnerError({
        message: toAbortMessage(input.signal.reason),
        status: "canceled_by_reconciliation",
        failedPhase: input.runAttempt.status,
        issue: input.issue,
        workspace: input.workspace,
        runAttempt: { ...input.runAttempt },
        liveSession: { ...input.liveSession },
        cause: input.error,
      });
    }

    const message =
      input.error instanceof Error ? input.error.message : "Agent run failed.";
    const code =
      typeof input.error === "object" &&
      input.error !== null &&
      "code" in input.error &&
      typeof input.error.code === "string"
        ? input.error.code
        : undefined;

    return new AgentRunnerError({
      message,
      ...(code === undefined ? {} : { code }),
      status: classifyFailureStatus(code),
      failedPhase: input.runAttempt.status,
      issue: input.issue,
      workspace: input.workspace,
      runAttempt: { ...input.runAttempt },
      liveSession: { ...input.liveSession },
      cause: input.error,
    });
  }
}

async function cleanupWorkspaceArtifacts(workspacePath: string): Promise<void> {
  await rm(`${workspacePath}/tmp`, { force: true, recursive: true });
}

function outcomeToEvent(outcome: string): AgentRuntimeEvent["event"] {
  switch (outcome) {
    case "completed":
      return "turn_completed";
    case "cancelled":
      return "turn_cancelled";
    case "input_required":
      return "turn_input_required";
    default:
      return "turn_failed";
  }
}

function classifyFailureStatus(code: string | undefined): RunAttemptPhase {
  if (code === "codex_turn_timeout" || code === "hook_timed_out") {
    return "timed_out";
  }
  if (code === "codex_session_stalled") {
    return "stalled";
  }
  return "failed";
}

async function closeBestEffort(
  runtime: AgentRuntime,
  session: AgentSession,
): Promise<void> {
  try {
    await runtime.stopSession(session);
  } catch {
    // cleanup only
  }
}

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blockedBy: issue.blockedBy.map((blocker) => ({ ...blocker })),
  };
}

function createAgentAbortController(
  signal: AbortSignal | undefined,
  stopSession: () => Promise<void>,
): {
  bindSession(session: AgentSession): void;
  dispose(): void;
  throwIfAborted(input: {
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
  }): void;
} {
  let bound = false;
  let listener: (() => void) | null = null;

  if (signal !== undefined) {
    listener = () => {
      void stopSession();
    };
    signal.addEventListener("abort", listener, { once: true });
  }

  return {
    bindSession() {
      bound = true;
      if (signal?.aborted) {
        void stopSession();
      }
    },
    dispose() {
      if (signal !== undefined && listener !== null) {
        signal.removeEventListener("abort", listener);
      }
      listener = null;
      bound = false;
    },
    throwIfAborted(input) {
      if (!signal?.aborted) {
        return;
      }

      throw new AgentRunnerError({
        message: toAbortMessage(signal.reason),
        status: "canceled_by_reconciliation",
        failedPhase: input.runAttempt.status,
        issue: input.issue,
        workspace: input.workspace,
        runAttempt: { ...input.runAttempt },
        liveSession: { ...input.liveSession },
      });
    },
  };
}

function toAbortMessage(reason: unknown): string {
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason.trim();
  }

  return "Agent run aborted.";
}

function getAgentRuntimeConfig(config: ResolvedWorkflowConfig) {
  return (
    config.agentRuntime ?? {
      provider: "stdio" as const,
      command: config.codex.command,
      approvalPolicy: config.codex.approvalPolicy,
      threadSandbox: config.codex.threadSandbox,
      turnSandboxPolicy: config.codex.turnSandboxPolicy,
      turnTimeoutMs: config.codex.turnTimeoutMs,
      readTimeoutMs: config.codex.readTimeoutMs,
      stallTimeoutMs: config.codex.stallTimeoutMs,
      maxTurns: config.agent.maxTurns,
    }
  );
}
