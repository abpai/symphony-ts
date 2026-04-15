import { describe, expect, it, vi } from "vitest";

import { HttpAgentRuntime } from "../../src/agent-runtime/http.js";

describe("HttpAgentRuntime", () => {
  it("starts a session and sends workspace context with auto commit/pr flags", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "sess-1" }))
      .mockResolvedValueOnce(
        new Response(
          'data: {"event":"notification","message":"hello"}\n' +
            "data: [DONE]\n",
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      );

    const runtime = new HttpAgentRuntime({
      config: {
        provider: "http",
        command: "",
        approvalPolicy: null,
        threadSandbox: null,
        turnSandboxPolicy: null,
        turnTimeoutMs: 1000,
        readTimeoutMs: 1000,
        stallTimeoutMs: 1000,
        maxTurns: 3,
        baseUrl: "https://agents.example.com",
        apiToken: "token",
        autoCommit: true,
        autoPr: true,
      },
      fetchFn,
    });

    const environment = {
      path: "/workspace/FAST-1",
      cwd: "/workspace/FAST-1",
      environmentId: "sandbox-1",
      workspaceKey: "FAST-1",
      provider: "sandbox" as const,
      createdNow: true,
      snapshotId: "snap-1",
    };
    const issue = {
      id: "10001",
      identifier: "FAST-1",
      title: "Ship HTTP runtime",
      description: null,
      priority: null,
      state: "In Progress",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    };

    const session = await runtime.startSession({ environment, issue });
    const events: string[] = [];
    const turn = await runtime.sendTurn({
      session,
      issue,
      environment,
      prompt: "hello",
      title: "FAST-1: Ship HTTP runtime",
      onEvent: (event) => events.push(event.event),
    });

    expect(session.sessionId).toBe("sess-1");
    expect(turn.outcome).toBe("completed");
    expect(events).toContain("session_started");

    const firstBody = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(firstBody.auto_commit).toBe(true);
    expect(firstBody.auto_pr).toBe(true);
    expect(firstBody.workspace.workspace_key).toBe("FAST-1");

    const secondBody = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body));
    expect(secondBody.workspace.environment_id).toBe("sandbox-1");
    expect(secondBody.workspace.cwd).toBe("/workspace/FAST-1");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
