import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  JiraTrackerClient,
  type TrackerError,
  createTrackerProvider,
} from "../../src/index.js";

describe("JiraTrackerClient", () => {
  it("builds candidate JQL, authenticates with basic auth, and normalizes issues", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        issues: [
          {
            id: "10001",
            key: "FAST-1",
            fields: {
              summary: "Ship Jira support",
              description: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "hello" }],
                  },
                ],
              },
              status: { name: "In Progress" },
              priority: { name: "High" },
              labels: ["Agent-Ready"],
              issuelinks: [
                {
                  type: { name: "Blocks" },
                  inwardIssue: {
                    id: "200",
                    key: "FAST-0",
                    fields: { status: { name: "Done" } },
                  },
                },
              ],
              created: "2026-04-01T00:00:00.000Z",
              updated: "2026-04-02T00:00:00.000Z",
            },
          },
        ],
        total: 1,
        startAt: 0,
        maxResults: 50,
      }),
    );

    const client = new JiraTrackerClient({
      baseUrl: "https://example.atlassian.net",
      apiKey: "jira-token",
      userEmail: "dev@example.com",
      projectKey: "FAST",
      activeStates: ["To Do", "In Progress"],
      jqlFilter: 'AND labels = "agent-ready"',
      fetchFn,
    });

    const issues = await client.fetchCandidateIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: "10001",
      identifier: "FAST-1",
      priority: 2,
      labels: ["agent-ready"],
      blockedBy: [{ id: "200", identifier: "FAST-0", state: "Done" }],
    });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://example.atlassian.net/rest/api/3/search");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("dev@example.com:jira-token").toString("base64")}`,
    );
    const body = JSON.parse(String(init?.body));
    expect(body.jql).toContain('project = "FAST"');
    expect(body.jql).toContain('status IN ("To Do", "In Progress")');
    expect(body.jql).toContain('AND labels = "agent-ready"');
  });

  it("returns [] for fetchIssuesByStates([]) without calling the API", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = new JiraTrackerClient({
      baseUrl: "https://example.atlassian.net",
      apiKey: "jira-token",
      userEmail: "dev@example.com",
      projectKey: "FAST",
      activeStates: ["To Do"],
      fetchFn,
    });

    await expect(client.fetchIssuesByStates([])).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps 401 to jira_api_auth_failed", async () => {
    const client = new JiraTrackerClient({
      baseUrl: "https://example.atlassian.net",
      apiKey: "jira-token",
      userEmail: "dev@example.com",
      projectKey: "FAST",
      activeStates: ["To Do"],
      fetchFn: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("denied", { status: 401 })),
    });

    await expect(client.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.jiraApiAuthFailed,
      }),
    );
  });

  it("factory returns Jira provider when tracker.kind is jira", () => {
    const tracker = createTrackerProvider(
      {
        kind: "jira",
        endpoint: "",
        apiKey: "jira-token",
        projectSlug: null,
        activeStates: ["To Do"],
        terminalStates: ["Done"],
        baseUrl: "https://example.atlassian.net",
        userEmail: "dev@example.com",
        projectKey: "FAST",
        jqlFilter: null,
      },
      {
        fetchFn: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            jsonResponse({ issues: [], total: 0, startAt: 0, maxResults: 50 }),
          ),
      },
    );

    expect(tracker).toBeInstanceOf(JiraTrackerClient);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
