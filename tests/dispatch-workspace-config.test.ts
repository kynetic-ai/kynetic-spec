import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import {
  DispatchWorkspaceConfigError,
  resolveDispatchWorkspaceConfig,
} from "../src/agent-runtime/workspace-config.js";
import { getDefaultConfig } from "../src/parser/config.js";
import { cleanupTempDir, createTempDir, initGitRepo } from "./helpers/cli.js";

// AC: @trait-error-guidance ac-3 — N/A: dispatch workspace config does not resolve @refs.
// AC: @trait-error-guidance ac-4 — N/A: dispatch workspace config has no state transition errors.
// AC: @trait-error-guidance ac-6 — N/A: dispatch workspace config is not a JSON CLI surface.

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function setupRepo(): Promise<string> {
  const dir = await createTempDir("kspec-dispatch-workspace-config-");
  initGitRepo(dir);
  await fs.writeFile(path.join(dir, "README.md"), "# dispatch\n", "utf-8");
  git(dir, "add README.md");
  git(dir, 'commit -m "init"');
  return dir;
}

describe("dispatch workspace config", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await setupRepo();
  });

  afterEach(async () => {
    await cleanupTempDir(repoDir);
  });

  // AC: @dispatch-workspace-configuration ac-1
  it("uses configured base_branch as both branch source and publication target", () => {
    git(repoDir, "checkout -b agent-dev");
    git(repoDir, "checkout main");

    const resolved = resolveDispatchWorkspaceConfig({
      projectRoot: repoDir,
      config: {
        ...getDefaultConfig(),
        dispatch: {
          base_branch: "agent-dev",
          worktree_root: ".kspec-worktrees",
        },
      },
    });

    expect(resolved.baseBranch).toBe("agent-dev");
    expect(resolved.publicationBaseBranch).toBe("agent-dev");
    expect(resolved.baseBranchSource).toBe("configured");
  });

  // AC: @dispatch-workspace-configuration ac-2
  it("prefers remote HEAD when dispatch.base_branch is unset", async () => {
    const bareDir = await createTempDir("kspec-dispatch-remote-");
    execSync("git init --bare --initial-branch=main", { cwd: bareDir, stdio: "pipe" });
    git(repoDir, `remote add origin "${bareDir}"`);
    git(repoDir, "checkout -b agent-dev");
    git(repoDir, "push -u origin agent-dev");
    git(repoDir, "checkout main");
    git(repoDir, "push -u origin main");
    execSync("git symbolic-ref HEAD refs/heads/agent-dev", {
      cwd: bareDir,
      stdio: "pipe",
    });
    git(repoDir, "remote set-head origin --auto");

    const resolved = resolveDispatchWorkspaceConfig({
      projectRoot: repoDir,
      config: getDefaultConfig(),
    });

    expect(resolved.baseBranch).toBe("agent-dev");
    expect(resolved.publicationBaseBranch).toBe("agent-dev");
    expect(resolved.baseBranchSource).toBe("remote_head");

    await cleanupTempDir(bareDir);
  });

  // AC: @dispatch-workspace-configuration ac-2
  it("falls back to the current symbolic branch when no remote HEAD exists", () => {
    git(repoDir, "checkout -b integration");

    const resolved = resolveDispatchWorkspaceConfig({
      projectRoot: repoDir,
      config: getDefaultConfig(),
    });

    expect(resolved.baseBranch).toBe("integration");
    expect(resolved.publicationBaseBranch).toBe("integration");
    expect(resolved.baseBranchSource).toBe("current_branch");
  });

  // AC: @dispatch-workspace-configuration ac-2
  it("falls back to main when remote HEAD and symbolic branch are unavailable", () => {
    git(repoDir, "checkout --detach");

    const resolved = resolveDispatchWorkspaceConfig({
      projectRoot: repoDir,
      config: getDefaultConfig(),
    });

    expect(resolved.baseBranch).toBe("main");
    expect(resolved.publicationBaseBranch).toBe("main");
    expect(resolved.baseBranchSource).toBe("fallback_main");
  });

  // AC: @dispatch-workspace-configuration ac-3
  it("resolves relative dispatch.worktree_root from the project root", () => {
    const resolved = resolveDispatchWorkspaceConfig({
      projectRoot: repoDir,
      config: {
        ...getDefaultConfig(),
        dispatch: {
          base_branch: null,
          worktree_root: ".dispatch/worktrees",
        },
      },
    });

    expect(resolved.worktreeRoot).toBe(path.join(repoDir, ".dispatch", "worktrees"));
    expect(resolved.worktreeRootSource).toBe("configured_relative");
  });

  // AC: @dispatch-workspace-configuration ac-3
  it("preserves absolute dispatch.worktree_root values", async () => {
    const absoluteRoot = path.join(await createTempDir("dispatch-absolute-root-"), "worktrees");

    const resolved = resolveDispatchWorkspaceConfig({
      projectRoot: repoDir,
      config: {
        ...getDefaultConfig(),
        dispatch: {
          base_branch: null,
          worktree_root: absoluteRoot,
        },
      },
    });

    expect(resolved.worktreeRoot).toBe(absoluteRoot);
    expect(resolved.worktreeRootSource).toBe("configured_absolute");

    await cleanupTempDir(path.dirname(absoluteRoot));
  });

  // AC: @dispatch-workspace-configuration ac-3
  it("defaults dispatch.worktree_root to .kspec-worktrees under the project root", () => {
    const resolved = resolveDispatchWorkspaceConfig({
      projectRoot: repoDir,
      config: getDefaultConfig(),
    });

    expect(resolved.worktreeRoot).toBe(path.join(repoDir, ".kspec-worktrees"));
    expect(resolved.worktreeRootSource).toBe("default");
  });

  // AC: @dispatch-workspace-configuration ac-4
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  // AC: @trait-error-guidance ac-5
  it("throws actionable guidance for invalid branch names and unusable worktree roots", async () => {
    const invalidBranchConfig = {
      ...getDefaultConfig(),
      dispatch: {
        base_branch: "bad branch name",
        worktree_root: ".kspec-worktrees",
      },
    };

    expect(() =>
      resolveDispatchWorkspaceConfig({
        projectRoot: repoDir,
        config: invalidBranchConfig,
      }),
    ).toThrowError(DispatchWorkspaceConfigError);

    await fs.writeFile(path.join(repoDir, "not-a-dir"), "x", "utf-8");
    const badRootConfig = {
      ...getDefaultConfig(),
      dispatch: {
        base_branch: null,
        worktree_root: "not-a-dir",
      },
    };

    expect(() =>
      resolveDispatchWorkspaceConfig({
        projectRoot: repoDir,
        config: badRootConfig,
      }),
    ).toThrow(/dispatch\.worktree_root/);
    expect(() =>
      resolveDispatchWorkspaceConfig({
        projectRoot: repoDir,
        config: badRootConfig,
      }),
    ).toThrow(/Update kspec\.config\.yaml/);
  });

  // AC: @dispatch-workspace-configuration ac-4
  it("fails dispatch engine startup before queuing work when dispatch config is unusable", async () => {
    await fs.writeFile(
      path.join(repoDir, "kspec.config.yaml"),
      "dispatch:\n  worktree_root: .kspec\n",
      "utf-8",
    );

    const engine = new DispatchEngine({ projectDir: repoDir });

    await expect(engine.start()).rejects.toThrow(/Choose a directory outside \.kspec/);
  });
});
