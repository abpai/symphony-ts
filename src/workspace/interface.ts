import type {
  WorkflowHooksConfig,
  WorkflowWorkspaceConfig,
} from "../config/types.js";
import type { Workspace } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import type { WorkspaceHookName, WorkspaceHookRunner } from "./hooks.js";
import { LocalWorkspaceProvider } from "./local.js";
import { SandboxWorkspaceProvider } from "./sandbox.js";

export interface WorkspaceProvider {
  readonly provider: "local" | "sandbox";
  createOrReuse(issueIdentifier: string): Promise<Workspace>;
  runHook(input: {
    name: WorkspaceHookName;
    environment: Workspace;
  }): Promise<boolean>;
  runHookBestEffort(input: {
    name: WorkspaceHookName;
    environment: Workspace;
  }): Promise<boolean>;
  cleanup(issueIdentifier: string): Promise<boolean>;
  listEnvironments(): Promise<string[]>;
  resolveForIssue(issueIdentifier: string): Workspace;
}

export function createWorkspaceProvider(
  config: WorkflowWorkspaceConfig,
  input: {
    hooksConfig: WorkflowHooksConfig;
    hookRunner?: WorkspaceHookRunner;
    fetchFn?: typeof fetch;
    logicalOnly?: boolean;
  },
): WorkspaceProvider {
  const provider = config.provider ?? "local";
  switch (provider) {
    case "local":
      return new LocalWorkspaceProvider({
        config,
        hooksConfig: input.hooksConfig,
        ...(input.hookRunner === undefined
          ? {}
          : { hookRunner: input.hookRunner }),
      });
    case "sandbox":
      return new SandboxWorkspaceProvider({
        config,
        hooksConfig: input.hooksConfig,
        ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
        ...(input.logicalOnly === undefined
          ? {}
          : { logicalOnly: input.logicalOnly }),
      });
    default:
      throw new Error(
        `${ERROR_CODES.configInvalid}: workspace.provider '${provider}' is not supported.`,
      );
  }
}
