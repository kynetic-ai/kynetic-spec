import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ResolvedKspecConfig } from "../parser/config.js";

export type DispatchBaseBranchSource =
  | "configured"
  | "remote_head"
  | "current_branch"
  | "fallback_main";

export type DispatchWorktreeRootSource =
  | "configured_absolute"
  | "configured_relative"
  | "default";

export interface ResolvedDispatchWorkspaceConfig {
  baseBranch: string;
  publicationBaseBranch: string;
  baseBranchSource: DispatchBaseBranchSource;
  worktreeRoot: string;
  worktreeRootSource: DispatchWorktreeRootSource;
}

export class DispatchWorkspaceConfigError extends Error {
  field: "dispatch.base_branch" | "dispatch.worktree_root";
  guidance: string;

  constructor(
    field: "dispatch.base_branch" | "dispatch.worktree_root",
    message: string,
    guidance: string,
  ) {
    super(`${message} ${guidance}`);
    this.name = "DispatchWorkspaceConfigError";
    this.field = field;
    this.guidance = guidance;
  }
}

interface ResolveDispatchWorkspaceConfigOptions {
  projectRoot: string;
  config: ResolvedKspecConfig;
}

function runGit(projectRoot: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
  };
}

function validateConfiguredBranchName(projectRoot: string, branch: string): void {
  const format = runGit(projectRoot, ["check-ref-format", "--branch", branch]);
  if (format.status !== 0) {
    throw new DispatchWorkspaceConfigError(
      "dispatch.base_branch",
      `Invalid dispatch.base_branch value "${branch}".`,
      "Use a valid branch name such as main or agent-dev.",
    );
  }
}

function configuredBranchExists(projectRoot: string, branch: string): boolean {
  const refs = runGit(projectRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  if (refs.status !== 0) return false;
  return refs.stdout
    .split("\n")
    .filter(Boolean)
    .some((ref) => ref === branch || ref.endsWith(`/${branch}`));
}

function resolveConfiguredBaseBranch(projectRoot: string, branch: string): string {
  validateConfiguredBranchName(projectRoot, branch);
  if (!configuredBranchExists(projectRoot, branch)) {
    throw new DispatchWorkspaceConfigError(
      "dispatch.base_branch",
      `Configured dispatch.base_branch "${branch}" does not exist in this repository.`,
      "Create the branch locally or on a tracked remote, or update kspec.config.yaml to an existing integration branch.",
    );
  }
  return branch;
}

function resolveRemoteHeadBranch(projectRoot: string): string | null {
  const remotes = runGit(projectRoot, ["remote"]);
  if (remotes.status !== 0) return null;

  const orderedRemotes = remotes.stdout
    .split("\n")
    .filter(Boolean)
    .sort((a, b) => {
      if (a === "origin") return -1;
      if (b === "origin") return 1;
      return a.localeCompare(b);
    });

  for (const remote of orderedRemotes) {
    const symbolic = runGit(projectRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    ]);
    if (symbolic.status !== 0 || !symbolic.stdout) continue;
    const prefix = `${remote}/`;
    return symbolic.stdout.startsWith(prefix)
      ? symbolic.stdout.slice(prefix.length)
      : symbolic.stdout;
  }

  return null;
}

function resolveCurrentBranch(projectRoot: string): string | null {
  const symbolic = runGit(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic.status !== 0 || !symbolic.stdout) return null;
  return symbolic.stdout;
}

export function resolveDispatchBaseBranch(
  projectRoot: string,
  config: ResolvedKspecConfig,
): { branch: string; source: DispatchBaseBranchSource } {
  if (config.dispatch.base_branch) {
    return {
      branch: resolveConfiguredBaseBranch(projectRoot, config.dispatch.base_branch),
      source: "configured",
    };
  }

  const remoteHead = resolveRemoteHeadBranch(projectRoot);
  if (remoteHead) {
    return { branch: remoteHead, source: "remote_head" };
  }

  const currentBranch = resolveCurrentBranch(projectRoot);
  if (currentBranch) {
    return { branch: currentBranch, source: "current_branch" };
  }

  return { branch: "main", source: "fallback_main" };
}

export function resolveDispatchWorktreeRoot(
  projectRoot: string,
  config: ResolvedKspecConfig,
): { path: string; source: DispatchWorktreeRootSource } {
  const configured = config.dispatch.worktree_root;
  const source: DispatchWorktreeRootSource =
    configured === ".kspec-worktrees"
      ? "default"
      : path.isAbsolute(configured)
        ? "configured_absolute"
        : "configured_relative";
  const resolved = path.isAbsolute(configured)
    ? configured
    : path.resolve(projectRoot, configured);

  const shadowRoot = path.resolve(projectRoot, config.shadow.directory);
  if (resolved === shadowRoot || resolved.startsWith(`${shadowRoot}${path.sep}`)) {
    throw new DispatchWorkspaceConfigError(
      "dispatch.worktree_root",
      `dispatch.worktree_root resolves inside the shadow worktree: ${resolved}`,
      `Choose a directory outside ${config.shadow.directory}, such as .kspec-worktrees.`,
    );
  }

  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new DispatchWorkspaceConfigError(
        "dispatch.worktree_root",
        `dispatch.worktree_root must point to a directory, but found a file at ${resolved}.`,
        "Update kspec.config.yaml to a writable directory path for dispatch worktrees.",
      );
    }
  }

  return { path: resolved, source };
}

export function resolveDispatchWorkspaceConfig(
  options: ResolveDispatchWorkspaceConfigOptions,
): ResolvedDispatchWorkspaceConfig {
  const base = resolveDispatchBaseBranch(options.projectRoot, options.config);
  const worktree = resolveDispatchWorktreeRoot(options.projectRoot, options.config);

  return {
    baseBranch: base.branch,
    publicationBaseBranch: base.branch,
    baseBranchSource: base.source,
    worktreeRoot: worktree.path,
    worktreeRootSource: worktree.source,
  };
}
