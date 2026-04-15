import type { WorkflowAgentRuntimeConfig } from "../config/types.js";
import { ERROR_CODES } from "../errors/codes.js";
import type { AgentRuntime } from "./interface.js";
import type {
  AgentRuntimeEvent,
  AgentRuntimeStartParams,
  AgentRuntimeTurnParams,
  AgentSession,
  AgentTurnResult,
} from "./types.js";

export class HttpAgentRuntime implements AgentRuntime {
  private readonly config: WorkflowAgentRuntimeConfig;
  private readonly fetchFn: typeof fetch;

  constructor(input: {
    config: WorkflowAgentRuntimeConfig;
    fetchFn?: typeof fetch;
  }) {
    this.config = input.config;
    this.fetchFn = input.fetchFn ?? globalThis.fetch;
  }

  async startSession(params: AgentRuntimeStartParams): Promise<AgentSession> {
    const response = await this.fetchJson(
      `${this.requireBaseUrl()}/api/sessions`,
      {
        method: "POST",
        body: {
          title: `${params.issue.identifier}: ${params.issue.title}`,
          auto_commit: this.config.autoCommit ?? true,
          auto_pr: this.config.autoPr ?? true,
          workspace: {
            provider: params.environment.provider,
            environment_id:
              params.environment.environmentId ?? params.environment.path,
            cwd: params.environment.cwd ?? params.environment.path,
            workspace_key: params.environment.workspaceKey,
            ...(params.environment.snapshotId === undefined ||
            params.environment.snapshotId === null
              ? {}
              : { snapshot_id: params.environment.snapshotId }),
          },
          ...(this.config.githubInstallationId === undefined ||
          this.config.githubInstallationId === null
            ? {}
            : { github_installation_id: this.config.githubInstallationId }),
        },
      },
    );

    if (!response.ok || !response.body || typeof response.body !== "object") {
      throw new Error(
        `Failed to start HTTP agent session${response.status ? ` (HTTP ${response.status})` : ""}.`,
      );
    }

    const body = response.body as Record<string, unknown>;
    const sessionId =
      (typeof body.id === "string" ? body.id : null) ??
      (typeof body.session_id === "string" ? body.session_id : null);
    if (!sessionId) {
      throw new Error("HTTP agent session response did not include an id.");
    }

    return {
      sessionId,
      threadId: null,
      turnId: null,
      processId: sessionId,
    };
  }

  async sendTurn(params: AgentRuntimeTurnParams): Promise<AgentTurnResult> {
    const processId = params.session.processId ?? null;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.turnTimeoutMs,
    );
    try {
      params.onEvent({
        event: "session_started",
        timestamp: new Date().toISOString(),
        processId,
        sessionId: params.session.sessionId,
        threadId: params.session.threadId ?? null,
        turnId: params.session.turnId ?? null,
        message: `starting HTTP turn for ${params.issue.identifier}`,
      });

      const response = await this.fetchFn(`${this.requireBaseUrl()}/api/chat`, {
        method: "POST",
        headers: this.createHeaders(),
        body: JSON.stringify({
          session_id: params.session.sessionId,
          message: params.prompt,
          stream: true,
          workspace: {
            provider: params.environment.provider,
            environment_id:
              params.environment.environmentId ?? params.environment.path,
            cwd: params.environment.cwd ?? params.environment.path,
            workspace_key: params.environment.workspaceKey,
            ...(params.environment.snapshotId === undefined ||
            params.environment.snapshotId === null
              ? {}
              : { snapshot_id: params.environment.snapshotId }),
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await parseBody(response);
        const message = `HTTP agent runtime request failed with HTTP ${response.status}.`;
        params.onEvent({
          event: "turn_failed",
          timestamp: new Date().toISOString(),
          processId,
          sessionId: params.session.sessionId,
          message,
          payload: body,
          errorCode: ERROR_CODES.agentRuntimeHttpStatus,
        });
        return {
          outcome: "failed",
          sessionId: params.session.sessionId,
          threadId: null,
          turnId: null,
          processId,
          usage: null,
          rateLimits: null,
          message,
          error: message,
        };
      }

      const streamResult = await this.readStreamingBody(
        response,
        processId,
        params,
      );
      return {
        ...streamResult,
        sessionId: params.session.sessionId,
        threadId: null,
        turnId: streamResult.turnId ?? null,
        processId,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        const message = "HTTP agent runtime turn timed out.";
        params.onEvent({
          event: "turn_failed",
          timestamp: new Date().toISOString(),
          processId,
          sessionId: params.session.sessionId,
          message,
          errorCode: ERROR_CODES.agentRuntimeHttpRequest,
        });
        return {
          outcome: "timeout",
          sessionId: params.session.sessionId,
          threadId: null,
          turnId: null,
          processId,
          usage: null,
          rateLimits: null,
          message,
          error: message,
        };
      }

      const message =
        error instanceof Error
          ? error.message
          : "HTTP agent runtime turn failed.";
      params.onEvent({
        event: "turn_failed",
        timestamp: new Date().toISOString(),
        processId,
        sessionId: params.session.sessionId,
        message,
        errorCode: ERROR_CODES.agentRuntimeHttpRequest,
      });
      return {
        outcome: "failed",
        sessionId: params.session.sessionId,
        threadId: null,
        turnId: null,
        processId,
        usage: null,
        rateLimits: null,
        message,
        error: message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async stopSession(session: AgentSession): Promise<void> {
    await this.fetchFn(
      `${this.requireBaseUrl()}/api/sessions/${encodeURIComponent(session.sessionId)}`,
      {
        method: "DELETE",
        headers: this.createHeaders(),
      },
    ).catch(() => undefined);
  }

  private async readStreamingBody(
    response: Response,
    processId: string | null,
    params: AgentRuntimeTurnParams,
  ): Promise<Omit<AgentTurnResult, "sessionId" | "threadId" | "processId">> {
    const body = response.body;
    if (!body) {
      return {
        outcome: "completed",
        turnId: null,
        usage: null,
        rateLimits: null,
        message: null,
      };
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastMessage: string | null = null;
    let usage: AgentTurnResult["usage"] = null;
    let rateLimits: AgentTurnResult["rateLimits"] = null;
    let turnId: string | null = null;
    let outcome: AgentTurnResult["outcome"] = "completed";
    let errorMessage: string | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let lineBreak = buffer.indexOf("\n");
      while (lineBreak >= 0) {
        const rawLine = buffer.slice(0, lineBreak).trim();
        buffer = buffer.slice(lineBreak + 1);
        if (rawLine !== "") {
          const event = parseStreamEvent(rawLine, processId);
          if (event) {
            params.onEvent(event);
            if (typeof event.message === "string") {
              lastMessage = event.message;
            }
            if (event.usage) {
              usage = event.usage;
            }
            if (event.rateLimits !== undefined) {
              rateLimits = event.rateLimits ?? null;
            }
            if (event.turnId !== undefined) {
              turnId = event.turnId ?? null;
            }
            if (event.event === "turn_failed") {
              outcome = "failed";
              errorMessage = event.message;
            }
            if (event.event === "turn_input_required") {
              outcome = "input_required";
            }
          }
        }
        lineBreak = buffer.indexOf("\n");
      }
    }

    return {
      outcome,
      turnId,
      usage,
      rateLimits,
      message: lastMessage,
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
    };
  }

  private async fetchJson(
    url: string,
    input: { method: string; body?: object },
  ) {
    const response = await this.fetchFn(url, {
      method: input.method,
      headers: this.createHeaders(),
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });

    return {
      ok: response.ok,
      status: response.status,
      body: await parseBody(response),
    };
  }

  private createHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.apiToken ?? ""}`,
      "content-type": "application/json",
    };
  }

  private requireBaseUrl(): string {
    if (!this.config.baseUrl || this.config.baseUrl.trim() === "") {
      throw new Error("HTTP agent runtime base URL is required.");
    }

    return this.config.baseUrl.replace(/\/$/, "");
  }
}

function parseStreamEvent(
  rawLine: string,
  processId: string | null,
): AgentRuntimeEvent | null {
  const line = rawLine.startsWith("data:") ? rawLine.slice(5).trim() : rawLine;
  if (line === "[DONE]") {
    return {
      event: "turn_completed",
      timestamp: new Date().toISOString(),
      processId,
      message: "stream completed",
    };
  }

  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const eventName =
      typeof parsed.event === "string" ? parsed.event : "notification";
    const usage =
      parsed.usage && typeof parsed.usage === "object"
        ? {
            inputTokens: numberOrZero(
              (parsed.usage as Record<string, unknown>).inputTokens,
            ),
            outputTokens: numberOrZero(
              (parsed.usage as Record<string, unknown>).outputTokens,
            ),
            totalTokens: numberOrZero(
              (parsed.usage as Record<string, unknown>).totalTokens,
            ),
          }
        : undefined;
    return {
      event: normalizeEventName(eventName),
      timestamp:
        typeof parsed.timestamp === "string"
          ? parsed.timestamp
          : new Date().toISOString(),
      processId,
      ...(typeof parsed.message === "string"
        ? { message: parsed.message }
        : {}),
      ...(typeof parsed.turn_id === "string" ? { turnId: parsed.turn_id } : {}),
      ...(usage === undefined ? {} : { usage }),
      ...(parsed.rate_limits && typeof parsed.rate_limits === "object"
        ? { rateLimits: parsed.rate_limits as Record<string, unknown> }
        : {}),
      payload: parsed,
    };
  } catch {
    return {
      event: "notification",
      timestamp: new Date().toISOString(),
      processId,
      message: line,
    };
  }
}

function normalizeEventName(value: string): AgentRuntimeEvent["event"] {
  switch (value) {
    case "turn_completed":
    case "turn_failed":
    case "turn_cancelled":
    case "turn_ended_with_error":
    case "turn_input_required":
    case "session_started":
    case "startup_failed":
    case "approval_auto_approved":
    case "unsupported_tool_call":
    case "notification":
    case "other_message":
    case "malformed":
      return value;
    default:
      return "notification";
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}
