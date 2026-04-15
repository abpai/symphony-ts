import type { WorkflowTrackerConfig } from "../config/types.js";
import { ERROR_CODES } from "../errors/codes.js";
import { JiraTrackerClient } from "./jira.js";
import { LinearTrackerClient } from "./linear-client.js";
import type { IssueTracker } from "./tracker.js";

export function createTrackerProvider(
  config: WorkflowTrackerConfig,
  options?: {
    fetchFn?: typeof fetch;
  },
): IssueTracker {
  switch ((config.kind ?? "").trim().toLowerCase()) {
    case "linear":
      return new LinearTrackerClient({
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        projectSlug: config.projectSlug,
        activeStates: config.activeStates,
        ...(options?.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      });
    case "jira":
      return new JiraTrackerClient({
        baseUrl: config.baseUrl ?? "",
        apiKey: config.apiKey,
        userEmail: config.userEmail ?? null,
        projectKey: config.projectKey ?? null,
        activeStates: config.activeStates,
        ...(config.jqlFilter === undefined
          ? {}
          : { jqlFilter: config.jqlFilter }),
        ...(options?.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      });
    default:
      throw new Error(
        `${ERROR_CODES.unsupportedTrackerKind}: tracker.kind '${config.kind}' is not supported.`,
      );
  }
}
