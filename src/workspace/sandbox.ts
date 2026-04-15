import type {
  WorkflowHooksConfig,
  WorkflowWorkspaceConfig,
} from "../config/types.js";
import type { Workspace } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import type { WorkspaceHookName } from "./hooks.js";
import type { WorkspaceProvider } from "./interface.js";
import { WorkspacePathError, sanitizeWorkspaceKey } from "./path-safety.js";

interface SandboxRecord {
  id: string;
  workspace_key: string;
  cwd?: string;
  snapshot_id?: string | null;
  state?: string | null;
  managed_by?: string | null;
}

export class SandboxWorkspaceProvider implements WorkspaceProvider {
  readonly provider = "sandbox" as const;

  private readonly config: WorkflowWorkspaceConfig;
  private readonly hooksConfig: WorkflowHooksConfig;
  private readonly fetchFn: typeof fetch;
  private readonly logicalOnly: boolean;
  private readonly knownSandboxes = new Map<string, SandboxRecord>();

  constructor(input: {
    config: WorkflowWorkspaceConfig;
    hooksConfig: WorkflowHooksConfig;
    fetchFn?: typeof fetch;
    logicalOnly?: boolean;
  }) {
    this.config = input.config;
    this.hooksConfig = input.hooksConfig;
    this.fetchFn = input.fetchFn ?? globalThis.fetch;
    this.logicalOnly = input.logicalOnly ?? false;
  }

  async createOrReuse(issueIdentifier: string): Promise<Workspace> {
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    let sandbox = await this.findSandbox(workspaceKey);
    let createdNow = false;

    if (sandbox === null) {
      sandbox = this.logicalOnly
        ? {
            id: `logical:${workspaceKey}`,
            workspace_key: workspaceKey,
            cwd: `/workspace/${workspaceKey}`,
          }
        : await this.createSandbox(workspaceKey);
      createdNow = true;
    } else if (!this.logicalOnly && sandbox.state === "hibernated") {
      await this.post(
        `/api/sandboxes/${encodeURIComponent(sandbox.id)}/resume`,
        {},
      );
    }

    const workspace = toWorkspace(sandbox, createdNow);
    this.knownSandboxes.set(workspaceKey, sandbox);
    if (createdNow) {
      await this.runHook({ name: "afterCreate", environment: workspace });
    }
    return workspace;
  }

  async runHook(input: {
    name: WorkspaceHookName;
    environment: Workspace;
  }): Promise<boolean> {
    const script = this.hooksConfig[input.name];
    if (!script || this.logicalOnly) {
      return false;
    }

    await this.execHook(
      input.environment.environmentId ?? input.environment.path,
      script,
      this.hooksConfig.timeoutMs,
    );
    return true;
  }

  async runHookBestEffort(input: {
    name: WorkspaceHookName;
    environment: Workspace;
  }): Promise<boolean> {
    try {
      return await this.runHook(input);
    } catch {
      return false;
    }
  }

  async cleanup(issueIdentifier: string): Promise<boolean> {
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    const cached = this.knownSandboxes.get(workspaceKey);
    const workspace =
      cached === undefined
        ? await this.resolveExisting(issueIdentifier)
        : toWorkspace(cached, false);
    if (workspace === null) {
      return false;
    }

    await this.runHookBestEffort({
      name: "beforeRemove",
      environment: workspace,
    });
    if (!this.logicalOnly) {
      await this.request(
        `/api/sandboxes/${encodeURIComponent(workspace.environmentId ?? workspace.path)}`,
        {
          method: "DELETE",
        },
      );
    }
    this.knownSandboxes.delete(workspaceKey);
    return true;
  }

  async listEnvironments(): Promise<string[]> {
    if (this.logicalOnly) {
      return [...this.knownSandboxes.keys()];
    }
    const response = await this.request(
      "/api/sandboxes",
      { method: "GET" },
      true,
    );
    if (response === null) {
      return [];
    }
    const payload = await parseJson(response);
    const items = Array.isArray(payload)
      ? payload
      : payload &&
          typeof payload === "object" &&
          Array.isArray((payload as Record<string, unknown>).items)
        ? ((payload as Record<string, unknown>).items as unknown[])
        : [];
    return items
      .flatMap((item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          if (
            record.managed_by === "symphony" &&
            typeof record.workspace_key === "string"
          ) {
            return [record.workspace_key as string];
          }
        }
        return [];
      })
      .filter((key) => key.trim() !== "");
  }

  resolveForIssue(issueIdentifier: string): Workspace {
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    return {
      environmentId: `sandbox:${workspaceKey}`,
      workspaceKey,
      provider: "sandbox",
      cwd: "/workspace",
      path: "/workspace",
      createdNow: false,
      snapshotId: null,
    };
  }

  private async resolveExisting(
    issueIdentifier: string,
  ): Promise<Workspace | null> {
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    const sandbox = await this.findSandbox(workspaceKey);
    if (sandbox === null) {
      return null;
    }
    this.knownSandboxes.set(workspaceKey, sandbox);
    return toWorkspace(sandbox, false);
  }

  private async findSandbox(
    workspaceKey: string,
  ): Promise<SandboxRecord | null> {
    const response = await this.request(
      `/api/sandboxes?workspace_key=${encodeURIComponent(workspaceKey)}`,
      { method: "GET" },
      true,
    );
    if (response === null) {
      return null;
    }
    const payload = await parseJson(response);
    if (Array.isArray(payload)) {
      return payload.length === 0
        ? null
        : normalizeSandboxRecord(payload[0] ?? null);
    }
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      if (Array.isArray(record.items)) {
        return record.items.length === 0
          ? null
          : normalizeSandboxRecord(record.items[0] ?? null);
      }
      return normalizeSandboxRecord(record);
    }
    return null;
  }

  private async createSandbox(workspaceKey: string): Promise<SandboxRecord> {
    const payload = await this.post("/api/sandboxes", {
      workspace_key: workspaceKey,
      managed_by: "symphony",
      idle_timeout_ms: this.config.sandboxIdleTimeoutMs,
      ...(this.config.sandboxBaseSnapshotId === null
        ? {}
        : { base_snapshot_id: this.config.sandboxBaseSnapshotId }),
    });
    return normalizeSandboxRecord(payload);
  }

  private async execHook(
    sandboxId: string,
    command: string,
    timeoutMs: number,
  ): Promise<void> {
    await this.post("/api/sandbox/exec", {
      sandbox_id: sandboxId,
      command,
      timeout_ms: timeoutMs,
    });
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response === null) {
      throw new WorkspacePathError(
        ERROR_CODES.workspaceCreateFailed,
        `Sandbox API returned no response for ${path}.`,
      );
    }
    const payload = await parseJson(response);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new WorkspacePathError(
        ERROR_CODES.workspaceCreateFailed,
        `Sandbox API returned an invalid payload for ${path}.`,
      );
    }
    return payload as Record<string, unknown>;
  }

  private async request(
    path: string,
    init: RequestInit,
    allowNotFound = false,
  ): Promise<Response | null> {
    const apiUrl = this.requireApiUrl();
    const apiToken = this.requireApiToken();

    let response: Response;
    try {
      response = await this.fetchFn(`${apiUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new WorkspacePathError(
        ERROR_CODES.workspaceCreateFailed,
        `Sandbox API request failed for ${path}.`,
        { cause: error },
      );
    }

    if (allowNotFound && response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new WorkspacePathError(
        ERROR_CODES.workspaceCreateFailed,
        `Sandbox API responded with status ${response.status} for ${path}.`,
      );
    }

    return response;
  }

  private requireApiUrl(): string {
    const apiUrl = this.config.sandboxApiUrl;
    if (apiUrl === undefined || apiUrl === null || apiUrl.trim() === "") {
      throw new WorkspacePathError(
        ERROR_CODES.configInvalid,
        "workspace.sandbox_api_url must be configured for sandbox workspaces.",
      );
    }
    return apiUrl.replace(/\/$/, "");
  }

  private requireApiToken(): string {
    const apiToken = this.config.sandboxApiToken;
    if (apiToken === undefined || apiToken === null || apiToken.trim() === "") {
      throw new WorkspacePathError(
        ERROR_CODES.configInvalid,
        "workspace.sandbox_api_token must be configured for sandbox workspaces.",
      );
    }
    return apiToken;
  }
}

function toWorkspace(record: SandboxRecord, createdNow: boolean): Workspace {
  return {
    environmentId: record.id,
    workspaceKey: record.workspace_key,
    provider: "sandbox",
    cwd: record.cwd ?? "/workspace",
    path: record.cwd ?? "/workspace",
    createdNow,
    snapshotId: record.snapshot_id ?? null,
  };
}

function normalizeSandboxRecord(value: unknown): SandboxRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspacePathError(
      ERROR_CODES.workspaceCreateFailed,
      "Sandbox API returned an invalid sandbox record.",
    );
  }

  const record = value as Record<string, unknown>;
  const id =
    typeof record.id === "string"
      ? record.id
      : typeof record.sandbox_id === "string"
        ? record.sandbox_id
        : null;
  const workspaceKey =
    typeof record.workspace_key === "string"
      ? record.workspace_key
      : typeof record.workspaceKey === "string"
        ? record.workspaceKey
        : null;
  if (id === null || workspaceKey === null) {
    throw new WorkspacePathError(
      ERROR_CODES.workspaceCreateFailed,
      "Sandbox API returned a record without id/workspace_key.",
    );
  }

  return {
    id,
    workspace_key: workspaceKey,
    cwd:
      typeof record.cwd === "string"
        ? record.cwd
        : typeof record.working_dir === "string"
          ? record.working_dir
          : "/workspace",
    snapshot_id:
      typeof record.snapshot_id === "string" ? record.snapshot_id : null,
    state: typeof record.state === "string" ? record.state : null,
    managed_by:
      typeof record.managed_by === "string" ? record.managed_by : null,
  };
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") {
    return null;
  }
  return JSON.parse(text);
}
