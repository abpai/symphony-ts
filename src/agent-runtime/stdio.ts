import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexClientEvent,
  type CodexDynamicTool,
} from "../codex/app-server-client.js";
import type { WorkflowAgentRuntimeConfig } from "../config/types.js";
import type { AgentRuntime } from "./interface.js";
import type {
  AgentRuntimeStartParams,
  AgentRuntimeTurnParams,
  AgentSession,
  AgentTurnResult,
} from "./types.js";

type CodexClientLike = Pick<
  CodexAppServerClient,
  "startSession" | "continueTurn" | "close"
>;

type CodexClientFactoryInput = CodexAppServerClientOptions;

interface RuntimeEntry {
  client: CodexClientLike | null;
  cwd: string;
  started: boolean;
  processId: string | null;
  onEvent: (event: ReturnType<typeof mapEvent>) => void;
}

export class StdioAgentRuntime implements AgentRuntime {
  private readonly config: WorkflowAgentRuntimeConfig;
  private readonly dynamicTools: CodexDynamicTool[];
  private readonly createCodexClient: (
    input: CodexClientFactoryInput,
  ) => CodexClientLike;
  private readonly sessions = new Map<string, RuntimeEntry>();
  private nextId = 0;

  constructor(input: {
    config: WorkflowAgentRuntimeConfig;
    dynamicTools: CodexDynamicTool[];
    createCodexClient?: (input: CodexClientFactoryInput) => CodexClientLike;
  }) {
    this.config = input.config;
    this.dynamicTools = input.dynamicTools;
    this.createCodexClient =
      input.createCodexClient ??
      ((options) => new CodexAppServerClient(options));
  }

  async startSession(params: AgentRuntimeStartParams): Promise<AgentSession> {
    const localSessionId = `stdio-${++this.nextId}`;
    const entry: RuntimeEntry = {
      client: null,
      cwd: params.environment.cwd ?? params.environment.path,
      started: false,
      processId: null,
      onEvent: () => {},
    };
    entry.client = this.createCodexClient({
      command: this.config.command,
      cwd: entry.cwd,
      approvalPolicy: this.config.approvalPolicy,
      threadSandbox: this.config.threadSandbox,
      turnSandboxPolicy: this.config.turnSandboxPolicy,
      readTimeoutMs: this.config.readTimeoutMs,
      turnTimeoutMs: this.config.turnTimeoutMs,
      stallTimeoutMs: this.config.stallTimeoutMs,
      dynamicTools: this.dynamicTools,
      onEvent: (event) => {
        const mapped = mapEvent(event);
        entry.processId = mapped.processId ?? null;
        entry.onEvent(mapped);
      },
    });
    this.sessions.set(localSessionId, entry);
    return {
      sessionId: localSessionId,
      threadId: null,
      turnId: null,
      processId: null,
    };
  }

  async sendTurn(params: AgentRuntimeTurnParams): Promise<AgentTurnResult> {
    const entry = this.sessions.get(params.session.sessionId);
    if (!entry) {
      throw new Error(`Unknown stdio session: ${params.session.sessionId}`);
    }

    entry.onEvent = params.onEvent;
    if (entry.client === null) {
      throw new Error(`Unknown stdio session: ${params.session.sessionId}`);
    }

    const result =
      entry.started === false
        ? await entry.client.startSession({
            prompt: params.prompt,
            title: params.title,
          })
        : await entry.client.continueTurn(params.prompt, params.title);
    entry.started = true;

    return {
      outcome: mapOutcome(result.status),
      sessionId: params.session.sessionId,
      threadId: result.threadId,
      turnId: result.turnId,
      processId: entry.processId ?? null,
      usage: result.usage,
      rateLimits: result.rateLimits,
      message: result.message,
      ...(result.status === "failed"
        ? { error: result.message ?? "Turn failed." }
        : {}),
    };
  }

  async stopSession(session: AgentSession): Promise<void> {
    const entry = this.sessions.get(session.sessionId);
    if (!entry) {
      return;
    }
    this.sessions.delete(session.sessionId);
    if (entry.client !== null) {
      await entry.client.close();
    }
  }
}

function mapEvent(event: CodexClientEvent) {
  return {
    ...event,
    processId: event.codexAppServerPid ?? null,
  };
}

function mapOutcome(status: "completed" | "failed" | "cancelled") {
  switch (status) {
    case "completed":
      return "completed" as const;
    case "failed":
      return "failed" as const;
    case "cancelled":
      return "cancelled" as const;
  }
}
