import type {
  WorkflowHooksConfig,
  WorkflowWorkspaceConfig,
} from "../config/types.js";
import type { Workspace } from "../domain/model.js";
import { type WorkspaceHookName, WorkspaceHookRunner } from "./hooks.js";
import type { WorkspaceProvider } from "./interface.js";
import { WorkspaceManager } from "./workspace-manager.js";

export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly provider = "local" as const;

  private readonly manager: WorkspaceManager;
  private readonly hooks: WorkspaceHookRunner;

  constructor(input: {
    config: WorkflowWorkspaceConfig;
    hooksConfig: WorkflowHooksConfig;
    hookRunner?: WorkspaceHookRunner;
  }) {
    this.manager = new WorkspaceManager({
      root: input.config.root,
    });
    this.hooks =
      input.hookRunner ??
      new WorkspaceHookRunner({
        config: input.hooksConfig,
      });
  }

  async createOrReuse(issueIdentifier: string): Promise<Workspace> {
    const workspace = await this.manager.createForIssue(issueIdentifier);
    const environment = toEnvironment(
      workspace.path,
      workspace.workspaceKey,
      workspace.createdNow,
    );

    if (workspace.createdNow) {
      await this.runHook({ name: "afterCreate", environment });
    }

    return environment;
  }

  async runHook(input: {
    name: WorkspaceHookName;
    environment: Workspace;
  }): Promise<boolean> {
    return await this.hooks.run({
      name: input.name,
      workspacePath: input.environment.cwd ?? input.environment.path,
    });
  }

  async runHookBestEffort(input: {
    name: WorkspaceHookName;
    environment: Workspace;
  }): Promise<boolean> {
    return await this.hooks.runBestEffort({
      name: input.name,
      workspacePath: input.environment.cwd ?? input.environment.path,
    });
  }

  async cleanup(issueIdentifier: string): Promise<boolean> {
    const environment = this.resolveForIssue(issueIdentifier);
    await this.runHookBestEffort({ name: "beforeRemove", environment });
    return await this.manager.removeForIssue(issueIdentifier);
  }

  async listEnvironments(): Promise<string[]> {
    return [];
  }

  resolveForIssue(issueIdentifier: string): Workspace {
    const resolved = this.manager.resolveForIssue(issueIdentifier);
    return toEnvironment(resolved.workspacePath, resolved.workspaceKey, false);
  }
}

function toEnvironment(
  path: string,
  workspaceKey: string,
  createdNow: boolean,
): Workspace {
  return {
    environmentId: path,
    workspaceKey,
    provider: "local",
    cwd: path,
    path,
    createdNow,
    snapshotId: null,
  };
}
