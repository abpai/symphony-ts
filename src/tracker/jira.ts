import { Buffer } from "node:buffer";

import type { Issue } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import { TrackerError } from "./errors.js";
import type { IssueStateSnapshot, IssueTracker } from "./tracker.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 30_000;
const JIRA_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "labels",
  "issuelinks",
  "created",
  "updated",
] as const;

export interface JiraTrackerClientOptions {
  baseUrl: string;
  apiKey: string | null;
  apiToken?: string | null;
  userEmail: string | null;
  projectKey: string | null;
  activeStates: string[];
  terminalStates?: string[];
  jqlFilter?: string | null;
  pageSize?: number;
  networkTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class JiraTrackerClient implements IssueTracker {
  readonly #baseUrl: string;
  readonly #apiKey: string | null;
  readonly #userEmail: string | null;
  readonly #projectKey: string | null;
  readonly #activeStates: string[];
  readonly #jqlFilter: string | null;
  readonly #pageSize: number;
  readonly #networkTimeoutMs: number;
  readonly #fetchFn: typeof fetch;

  constructor(options: JiraTrackerClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#apiKey = options.apiKey ?? options.apiToken ?? null;
    this.#userEmail = options.userEmail;
    this.#projectKey = options.projectKey;
    this.#activeStates = [...options.activeStates];
    this.#jqlFilter = options.jqlFilter ?? null;
    this.#pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.#networkTimeoutMs = options.networkTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return await this.searchIssues(
      `project = "${this.requireProjectKey()}" AND status IN (${quoteList(this.#activeStates)})${appendJqlFilter(this.#jqlFilter)}`,
      JIRA_FIELDS,
    );
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) {
      return [];
    }
    return await this.searchIssues(
      `project = "${this.requireProjectKey()}" AND status IN (${quoteList(stateNames)})`,
      JIRA_FIELDS,
    );
  }

  async fetchIssueStatesByIds(
    issueIds: string[],
  ): Promise<IssueStateSnapshot[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const payload = await this.postSearch({
      jql: `id IN (${issueIds.map((id) => JSON.stringify(id)).join(", ")})`,
      fields: ["status"],
      startAt: 0,
      maxResults: 100,
    });
    const issues = asArray(
      payload.issues,
      ERROR_CODES.jiraUnknownPayload,
      "Jira issue-state payload was missing issues.",
    );
    return issues.map((issue) => normalizeJiraIssueState(issue));
  }

  async executeRestCall(input: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
  }): Promise<{
    success: boolean;
    status?: number;
    data?: unknown;
    error?: unknown;
  }> {
    if (!input.path.startsWith("/rest/")) {
      throw new TrackerError(
        ERROR_CODES.configInvalid,
        "jira_rest path must start with /rest/.",
      );
    }

    const response = await this.fetchWithTimeout(
      `${this.#baseUrl}${input.path}`,
      {
        method: input.method,
        headers: this.createHeaders(),
        ...(input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) }),
      },
    );

    const body = await parseJsonResponse(response);
    if (response.ok) {
      return { success: true, data: body };
    }
    if (response.status >= 400 && response.status < 500) {
      return { success: false, status: response.status, error: body };
    }
    return {
      success: false,
      error:
        typeof body === "string"
          ? body
          : `Jira request failed with status ${response.status}`,
    };
  }

  async executeRest(input: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
  }): Promise<{
    success: boolean;
    status?: number;
    data?: unknown;
    error?: unknown;
  }> {
    return await this.executeRestCall(input);
  }

  private async searchIssues(
    jql: string,
    fields: readonly string[],
  ): Promise<Issue[]> {
    const results: Issue[] = [];
    let startAt = 0;

    while (true) {
      const payload = await this.postSearch({
        jql,
        fields,
        startAt,
        maxResults: this.#pageSize,
      });
      const issues = asArray(
        payload.issues,
        ERROR_CODES.jiraUnknownPayload,
        "Jira search payload was missing issues.",
      );
      results.push(
        ...issues.map((issue) => normalizeJiraIssue(issue, this.#baseUrl)),
      );

      const total = readNonNegativeInteger(payload.total);
      const pageStartAt = readNonNegativeInteger(payload.startAt);
      const pageMaxResults = readNonNegativeInteger(payload.maxResults);
      if (total === null || pageStartAt === null || pageMaxResults === null) {
        throw new TrackerError(
          ERROR_CODES.jiraPaginationError,
          "Jira pagination payload was missing total/startAt/maxResults.",
          { details: payload },
        );
      }

      startAt = pageStartAt + pageMaxResults;
      if (startAt >= total || issues.length === 0) {
        return results;
      }
    }
  }

  private async postSearch(body: {
    jql: string;
    fields: readonly string[];
    startAt: number;
    maxResults: number;
  }): Promise<Record<string, unknown>> {
    const response = await this.fetchWithTimeout(
      `${this.#baseUrl}/rest/api/3/search`,
      {
        method: "POST",
        headers: this.createHeaders(),
        body: JSON.stringify(body),
      },
    );

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new TrackerError(
          ERROR_CODES.jiraApiAuthFailed,
          `Jira authentication failed with status ${response.status}.`,
          { status: response.status, details: payload },
        );
      }

      throw new TrackerError(
        ERROR_CODES.jiraApiStatus,
        `Jira responded with status ${response.status}.`,
        { status: response.status, details: payload },
      );
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TrackerError(
        ERROR_CODES.jiraUnknownPayload,
        "Jira search payload was not an object.",
        { details: payload },
      );
    }

    return payload as Record<string, unknown>;
  }

  private createHeaders(): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`${this.requireUserEmail()}:${this.requireApiKey()}`).toString("base64")}`,
      accept: "application/json",
      "content-type": "application/json",
    };
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#networkTimeoutMs,
    );
    try {
      return await this.#fetchFn(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      throw new TrackerError(
        ERROR_CODES.jiraApiRequest,
        "Jira request failed before a valid response was received.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireApiKey(): string {
    if (this.#apiKey && this.#apiKey.trim() !== "") {
      return this.#apiKey;
    }
    throw new TrackerError(
      ERROR_CODES.trackerCredentialsMissing,
      "tracker.api_token must be configured for Jira.",
    );
  }

  private requireUserEmail(): string {
    if (this.#userEmail && this.#userEmail.trim() !== "") {
      return this.#userEmail;
    }
    throw new TrackerError(
      ERROR_CODES.trackerCredentialsMissing,
      "tracker.user_email must be configured for Jira.",
    );
  }

  private requireProjectKey(): string {
    if (this.#projectKey && this.#projectKey.trim() !== "") {
      return this.#projectKey;
    }
    throw new TrackerError(
      ERROR_CODES.configInvalid,
      "tracker.project_key must be configured for Jira.",
    );
  }
}

function normalizeJiraIssue(issue: unknown, baseUrl: string): Issue {
  const record = asRecord(
    issue,
    ERROR_CODES.jiraUnknownPayload,
    "Jira issue payload was not an object.",
  ) as Record<string, unknown>;
  const fields = asRecord(
    record.fields,
    ERROR_CODES.jiraUnknownPayload,
    "Jira issue payload was missing fields.",
  ) as Record<string, unknown>;
  const key = requireString(
    record.key,
    ERROR_CODES.jiraUnknownPayload,
    "Jira issue payload was missing key.",
  );
  const id = requireString(
    record.id,
    ERROR_CODES.jiraUnknownPayload,
    "Jira issue payload was missing id.",
  );
  const summary = requireString(
    fields.summary,
    ERROR_CODES.jiraUnknownPayload,
    "Jira issue payload was missing summary.",
  );
  const statusRecord = asRecord(
    fields.status,
    ERROR_CODES.jiraUnknownPayload,
    "Jira issue payload was missing status.",
  ) as Record<string, unknown>;
  const state = requireString(
    statusRecord.name,
    ERROR_CODES.jiraUnknownPayload,
    "Jira issue payload was missing status.name.",
  );

  return {
    id,
    identifier: key,
    title: summary,
    description: normalizeJiraDescription(fields.description),
    priority: normalizeJiraPriority(
      asRecord(
        fields.priority,
        ERROR_CODES.jiraUnknownPayload,
        "Jira issue payload was missing priority.",
        true,
      ),
    ),
    state,
    branchName: null,
    url: `${baseUrl}/browse/${encodeURIComponent(key)}`,
    labels: asArray(
      fields.labels,
      ERROR_CODES.jiraUnknownPayload,
      "Jira labels payload was invalid.",
      true,
    )
      .filter((label): label is string => typeof label === "string")
      .map((label) => label.toLowerCase()),
    blockedBy: normalizeJiraBlockedBy(fields.issuelinks),
    createdAt: normalizeTimestamp(fields.created),
    updatedAt: normalizeTimestamp(fields.updated),
  };
}

function normalizeJiraIssueState(issue: unknown): IssueStateSnapshot {
  const record = asRecord(
    issue,
    ERROR_CODES.jiraUnknownPayload,
    "Jira issue-state payload was not an object.",
  ) as Record<string, unknown>;
  const fields = asRecord(
    record.fields,
    ERROR_CODES.jiraUnknownPayload,
    "Jira issue-state payload was missing fields.",
  ) as Record<string, unknown>;
  const status = asRecord(
    fields.status,
    ERROR_CODES.jiraUnknownPayload,
    "Jira issue-state payload was missing status.",
  ) as Record<string, unknown>;
  return {
    id: requireString(
      record.id,
      ERROR_CODES.jiraUnknownPayload,
      "Jira issue-state payload was missing id.",
    ),
    identifier: requireString(
      record.key,
      ERROR_CODES.jiraUnknownPayload,
      "Jira issue-state payload was missing key.",
    ),
    state: requireString(
      status.name,
      ERROR_CODES.jiraUnknownPayload,
      "Jira issue-state payload was missing status.name.",
    ),
  };
}

function normalizeJiraDescription(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child);
      }
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.trim() !== "") {
      parts.push(record.text.trim());
    }
    if (Array.isArray(record.content)) {
      walk(record.content);
    }
  };

  walk(value);
  return parts.length === 0 ? null : parts.join("\n");
}

function normalizeJiraPriority(
  value: Record<string, unknown> | null,
): number | null {
  if (value === null) {
    return null;
  }
  const name = typeof value.name === "string" ? value.name.toLowerCase() : null;
  switch (name) {
    case "highest":
    case "blocker":
      return 1;
    case "high":
      return 2;
    case "medium":
      return 3;
    case "low":
      return 4;
    case "lowest":
      return 5;
    default:
      return null;
  }
}

function normalizeJiraBlockedBy(value: unknown): Issue["blockedBy"] {
  const links = asArray(
    value,
    ERROR_CODES.jiraUnknownPayload,
    "Jira issue links payload was invalid.",
    true,
  );
  if (links.length === 0) {
    return [];
  }
  return links.flatMap((link) => {
    const record = asRecord(
      link,
      ERROR_CODES.jiraUnknownPayload,
      "Jira issue link payload was invalid.",
      true,
    ) as Record<string, unknown>;
    const type = asRecord(
      record.type,
      ERROR_CODES.jiraUnknownPayload,
      "Jira issue link type payload was invalid.",
      true,
    ) as Record<string, unknown>;
    if (typeof type.name !== "string" || type.name.toLowerCase() !== "blocks") {
      return [];
    }
    const blocker = asRecord(
      record.inwardIssue,
      ERROR_CODES.jiraUnknownPayload,
      "Jira inward issue payload was invalid.",
      true,
    );
    const fields = blocker
      ? asRecord(
          blocker.fields,
          ERROR_CODES.jiraUnknownPayload,
          "Jira inward issue fields payload was invalid.",
          true,
        )
      : null;
    const status = fields
      ? asRecord(
          fields.status,
          ERROR_CODES.jiraUnknownPayload,
          "Jira inward issue status payload was invalid.",
          true,
        )
      : null;
    return [
      {
        id: blocker && typeof blocker.id === "string" ? blocker.id : null,
        identifier:
          blocker && typeof blocker.key === "string" ? blocker.key : null,
        state: status && typeof status.name === "string" ? status.name : null,
      },
    ];
  });
}

function requireString(
  value: unknown,
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw new TrackerError(code, message, { details: value });
}

function asArray(
  value: unknown,
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  allowEmpty = false,
): unknown[] {
  if (value === undefined || value === null) {
    return allowEmpty ? [] : failArray(code, message, value);
  }
  if (Array.isArray(value)) {
    return value;
  }
  throw new TrackerError(code, message, { details: value });
}

function failArray(
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  value: unknown,
): never {
  throw new TrackerError(code, message, { details: value });
}

function asRecord(
  value: unknown,
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  allowNull = false,
): Record<string, unknown> {
  if (value === null || value === undefined) {
    if (allowNull) {
      return {};
    }
    throw new TrackerError(code, message, { details: value });
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new TrackerError(code, message, { details: value });
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return null;
  }
  return parsed.toISOString();
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function appendJqlFilter(filter: string | null): string {
  if (!filter || filter.trim() === "") {
    return "";
  }
  return ` ${filter.trim()}`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
