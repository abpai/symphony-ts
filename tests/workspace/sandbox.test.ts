import { describe, expect, it, vi } from "vitest";

import { SandboxWorkspaceProvider } from "../../src/workspace/sandbox.js";

describe("SandboxWorkspaceProvider", () => {
  it("creates, lists, reuses, and cleans up sandbox workspaces", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([], 200))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: "sbx-1",
            workspace_key: "FAST-1",
            cwd: "/workspace/FAST-1",
          },
          200,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          [{ id: "sbx-1", workspace_key: "FAST-1", managed_by: "symphony" }],
          200,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          [
            {
              id: "sbx-1",
              workspace_key: "FAST-1",
              cwd: "/workspace/FAST-1",
            },
          ],
          200,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          [
            {
              id: "sbx-1",
              workspace_key: "FAST-1",
              cwd: "/workspace/FAST-1",
            },
          ],
          200,
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const provider = new SandboxWorkspaceProvider({
      config: {
        root: "/tmp/workspaces",
        provider: "sandbox",
        sandboxApiUrl: "https://sandbox.example.com",
        sandboxApiToken: "token",
        sandboxBaseSnapshotId: "snap-1",
        sandboxIdleTimeoutMs: 300000,
      },
      hooksConfig: {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 1000,
      },
      fetchFn,
    });

    const created = await provider.createOrReuse("FAST-1");
    expect(created.createdNow).toBe(true);
    expect(created.workspaceKey).toBe("FAST-1");

    await expect(provider.listEnvironments()).resolves.toEqual(["FAST-1"]);

    const reused = await provider.createOrReuse("FAST-1");
    expect(reused.createdNow).toBe(false);

    await expect(provider.cleanup("FAST-1")).resolves.toBe(true);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
