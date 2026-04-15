import type {
  CodexAppServerClient,
  CodexAppServerClientOptions,
  CodexDynamicTool,
} from "../codex/app-server-client.js";
import { createJiraRestDynamicTool } from "../codex/jira-rest-tool.js";
import { createLinearGraphqlDynamicTool } from "../codex/linear-graphql-tool.js";
import type {
  WorkflowAgentRuntimeConfig,
  WorkflowTrackerConfig,
} from "../config/types.js";
import { ERROR_CODES } from "../errors/codes.js";
import { HttpAgentRuntime } from "./http.js";
import { StdioAgentRuntime } from "./stdio.js";
import type {
  AgentRuntimeEvent,
  AgentRuntimeStartParams,
  AgentRuntimeTurnParams,
  AgentSession,
  AgentTurnResult,
} from "./types.js";

export interface AgentRuntime {
  startSession(params: AgentRuntimeStartParams): Promise<AgentSession>;
  sendTurn(params: AgentRuntimeTurnParams): Promise<AgentTurnResult>;
  stopSession(session: AgentSession): Promise<void>;
}

export interface CreateAgentRuntimeOptions {
  config: WorkflowAgentRuntimeConfig;
  trackerConfig: WorkflowTrackerConfig;
  fetchFn?: typeof fetch;
  createCodexClient?: (
    input: CodexAppServerClientOptions & {
      onEvent: NonNullable<CodexAppServerClientOptions["onEvent"]>;
    },
  ) => Pick<CodexAppServerClient, "startSession" | "continueTurn" | "close">;
}

export function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): AgentRuntime {
  switch (options.config.provider) {
    case "stdio":
      return new StdioAgentRuntime({
        config: options.config,
        dynamicTools: buildDynamicTools({
          trackerConfig: options.trackerConfig,
          ...(options.fetchFn === undefined
            ? {}
            : { fetchFn: options.fetchFn }),
        }),
        ...(options.createCodexClient === undefined
          ? {}
          : { createCodexClient: options.createCodexClient }),
      } as ConstructorParameters<typeof StdioAgentRuntime>[0]);
    case "http":
      return new HttpAgentRuntime({
        config: options.config,
        ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      });
    default:
      throw new Error(
        `${ERROR_CODES.configInvalid}: agent_runtime.provider '${options.config.provider}' is not supported.`,
      );
  }
}

function buildDynamicTools(input: {
  trackerConfig: WorkflowTrackerConfig;
  fetchFn?: typeof fetch;
}): CodexDynamicTool[] {
  switch ((input.trackerConfig.kind ?? "").trim().toLowerCase()) {
    case "linear":
      return [
        createLinearGraphqlDynamicTool({
          endpoint: input.trackerConfig.endpoint,
          apiKey: input.trackerConfig.apiKey,
          ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
        }),
      ];
    case "jira":
      return [
        createJiraRestDynamicTool({
          baseUrl: input.trackerConfig.baseUrl ?? "",
          apiToken: input.trackerConfig.apiKey,
          userEmail: input.trackerConfig.userEmail ?? null,
          ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
        }),
      ];
    default:
      return [];
  }
}

export type {
  AgentRuntimeEvent,
  AgentSession,
  AgentTurnResult,
} from "./types.js";
