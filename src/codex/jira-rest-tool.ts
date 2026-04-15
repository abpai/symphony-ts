import { ERROR_CODES } from "../errors/codes.js";
import { TrackerError } from "../tracker/errors.js";
import {
  JiraTrackerClient,
  type JiraTrackerClientOptions,
} from "../tracker/jira.js";
import type { CodexDynamicTool } from "./app-server-client.js";

export interface JiraRestToolInput {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}

export interface JiraRestToolResult {
  success: boolean;
  data?: unknown;
  status?: number;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    status?: number | null;
  };
}

export interface JiraRestDynamicToolOptions
  extends Pick<
    JiraTrackerClientOptions,
    "baseUrl" | "apiToken" | "userEmail" | "networkTimeoutMs" | "fetchFn"
  > {}

export const JIRA_REST_TOOL_NAME = "jira_rest";

export function createJiraRestDynamicTool(
  options: JiraRestDynamicToolOptions,
): CodexDynamicTool {
  const client = new JiraTrackerClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiToken ?? null,
    ...(options.apiToken === undefined ? {} : { apiToken: options.apiToken }),
    userEmail: options.userEmail,
    projectKey: null,
    activeStates: [],
    ...(options.networkTimeoutMs === undefined
      ? {}
      : { networkTimeoutMs: options.networkTimeoutMs }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });

  return {
    name: JIRA_REST_TOOL_NAME,
    description:
      "Execute one Jira REST API request against the configured workspace using Symphony-managed auth.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["method", "path"],
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE"],
        },
        path: {
          type: "string",
          minLength: 1,
          description: "REST path starting with /rest/.",
        },
        body: {
          type: "object",
          description: "Optional JSON body for POST/PUT requests.",
        },
      },
    },
    async execute(input: unknown): Promise<JiraRestToolResult> {
      const normalized = normalizeInput(input);
      if (!normalized.success) {
        return normalized;
      }

      try {
        const response = await client.executeRest(normalized);
        return response.success
          ? {
              success: true,
              data: response.data,
              ...(response.status === undefined
                ? {}
                : { status: response.status }),
            }
          : {
              success: false,
              ...(response.status === undefined
                ? {}
                : { status: response.status }),
              error: {
                code:
                  response.status !== undefined && response.status >= 500
                    ? ERROR_CODES.jiraApiStatus
                    : ERROR_CODES.jiraApiRequest,
                message:
                  response.status !== undefined
                    ? `Jira REST request failed with HTTP ${response.status}.`
                    : "Jira REST request failed.",
                details: response.error,
                status: response.status ?? null,
              },
            };
      } catch (error) {
        if (error instanceof TrackerError) {
          return {
            success: false,
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
              status: error.status,
            },
          };
        }

        return {
          success: false,
          error: {
            code: ERROR_CODES.jiraApiRequest,
            message:
              error instanceof Error
                ? error.message
                : "Jira REST request failed.",
          },
        };
      }
    },
  };
}

function normalizeInput(input: unknown):
  | {
      success: true;
      method: JiraRestToolInput["method"];
      path: string;
      body?: Record<string, unknown>;
    }
  | (JiraRestToolResult & { success: false }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalidInput(
      "jira_rest expects an object with method, path, and optional body.",
    );
  }

  const method = "method" in input ? input.method : undefined;
  const path = "path" in input ? input.path : undefined;
  const body = "body" in input ? input.body : undefined;

  if (
    method !== "GET" &&
    method !== "POST" &&
    method !== "PUT" &&
    method !== "DELETE"
  ) {
    return invalidInput(
      "jira_rest.method must be one of GET, POST, PUT, DELETE.",
    );
  }

  if (typeof path !== "string" || path.trim() === "") {
    return invalidInput("jira_rest.path must be a non-empty string.");
  }

  if (
    body !== undefined &&
    (body === null || typeof body !== "object" || Array.isArray(body))
  ) {
    return invalidInput("jira_rest.body must be a JSON object when provided.");
  }

  return {
    success: true,
    method,
    path,
    ...(body === undefined ? {} : { body: body as Record<string, unknown> }),
  };
}

function invalidInput(
  message: string,
): JiraRestToolResult & { success: false } {
  return {
    success: false,
    error: {
      code: "invalid_input",
      message,
    },
  };
}
