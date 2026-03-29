import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  provisionDispatchWorkspace,
  reconcileDispatchWorkspaceArtifacts,
  reconcileDispatchWorkspaceRegistry,
  reconcileDispatchWorkspaceLifecycle,
} from "../src/agent-runtime/workspace.js";
import {
  getDispatchWorkspaceRegistryPath,
  loadDispatchWorkspaceRegistry,
  saveDispatchWorkspaceRecord,
} from "../src/parser/dispatch-workspaces.js";
import { initContext } from "../src/parser/index.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  readTestOutput,
  testUlid,
} from "./helpers/cli.js";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

/**
 * Seed a test repo with a real shadow worktree via `kspec init`.
 * This avoids setting process.env.KSPEC_SPEC_DIR which is shared across
 * vitest worker threads and can corrupt concurrent tests (e.g.
 * daemon-command-api.test.ts) that rely on initContext() resolving
 * from cwd rather than an env override.
 */
async function seedRepo(dir: string): Promise<void> {
  initGitRepo(dir);
  await fs.writeFile(path.join(dir, "README.md"), "seed\n", "utf-8");
  git(dir, "add README.md");
  git(dir, 'commit -m "init"');

  const result = kspec("init --no-prompt", dir, {
    env: { KSPEC_AUTHOR: "@test" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`kspec init --no-prompt failed: ${result.stderr}`);
  }
}

async function readWorkspaceRecord(
  registryPath: string,
  taskRef: string,
): Promise<Record<string, any>> {
  const raw = YAML.parse(await readTestOutput(registryPath)) as {
    workspaces?: Array<Record<string, any>>;
  };
  return raw.workspaces?.find((workspace) => workspace.task_ref === taskRef) ?? {};
}

// AC: @trait-error-guidance ac-1 — N/A: reconciliation runs internally in the dispatch runtime and reports through registry state/logging, not CLI errors.
// AC: @trait-error-guidance ac-2 — N/A: reconciliation guidance is captured in registry health issues and task notes, not user-facing CLI suggestions.
// AC: @trait-error-guidance ac-3 — N/A: reconciliation does not surface reference lookup errors to a direct CLI caller.
// AC: @trait-error-guidance ac-4 — N/A: invalid state transitions are enforced by task commands, not by reconciliation helpers.
// AC: @trait-error-guidance ac-5 — N/A: reconciliation does not expose field-validation error payloads in this path.
// AC: @trait-error-guidance ac-6 — N/A: reconciliation helpers do not implement a JSON CLI error mode.

describe("dispatch workspace terminal task reconciliation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-terminal-reconcile-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-workspace-registry ac-12
  it("skips branch restoration for completed task records with merged integration when canonical branch is missing locally", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 40)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Terminal Branch Skip",
        slugs: ["task-terminal-branch-skip"],
      },
    });

    // Transition the workspace to closing/merged state (simulating completed task)
    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: {
        title: "Terminal Branch Skip",
        slugs: ["task-terminal-branch-skip"],
      },
    });

    // Simulate that artifact cleanup already ran and deleted the branch + worktree
    // (or that cleanup happens out of band), but the registry record remains non-closed.
    const canonicalBranch = workspace.metadata.canonicalBranch;
    await fs.rm(workspace.cwd, { recursive: true, force: true });
    git(tempDir, "worktree prune");
    // Delete the local branch (simulating post-reap state)
    try {
      git(tempDir, `branch -D ${canonicalBranch}`);
    } catch {
      // Branch may already be gone
    }

    // Create a fake remote tracking ref that would cause tryRestoreBranchFromRemote
    // to restore the branch if not properly guarded
    git(tempDir, `update-ref refs/remotes/origin/${canonicalBranch} HEAD`);

    // Now run registry reconciliation with task status = completed
    // The fix should prevent tryRestoreBranchFromRemote from being called
    await reconcileDispatchWorkspaceRegistry(
      tempDir,
      new Map([[taskRef, "completed" as const]]),
    );

    // Verify the branch was NOT restored from the remote tracking ref
    const branchExists = git(tempDir, `branch --list ${canonicalBranch}`);
    expect(branchExists).toBe("");

    // Verify the record was updated appropriately — it should not be in an
    // error state from trying to resolve a commit on a missing branch
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const record = await readWorkspaceRecord(registryPath, taskRef);
    // The lifecycle should be closing (completed + merged = cleanup eligible)
    // and health should reflect the terminal-skip evaluation
    expect(record.lifecycle_state).toBe("closing");
    expect(record.integration.status).toBe("merged");
  });

  // AC: @dispatch-workspace-registry ac-12
  it("skips branch restoration for cancelled task records with abandoned integration", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 41)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Cancelled Branch Skip",
        slugs: ["task-cancelled-branch-skip"],
      },
    });

    // Transition to closing/abandoned (cancelled task)
    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "abandoned", taskStatus: "cancelled" },
      task: {
        title: "Cancelled Branch Skip",
        slugs: ["task-cancelled-branch-skip"],
      },
    });

    const canonicalBranch = workspace.metadata.canonicalBranch;
    await fs.rm(workspace.cwd, { recursive: true, force: true });
    git(tempDir, "worktree prune");
    try {
      git(tempDir, `branch -D ${canonicalBranch}`);
    } catch {
      // Branch may already be gone
    }

    // Set up remote tracking ref that would trigger restoration
    git(tempDir, `update-ref refs/remotes/origin/${canonicalBranch} HEAD`);

    await reconcileDispatchWorkspaceRegistry(
      tempDir,
      new Map([[taskRef, "cancelled" as const]]),
    );

    // Branch should not have been restored
    const branchExists = git(tempDir, `branch --list ${canonicalBranch}`);
    expect(branchExists).toBe("");
  });

  // AC: @dispatch-workspace-registry ac-13
  it("preserves dispatch branches tracked by registry records during artifact reconciliation", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 42)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Registry Branch Protect",
        slugs: ["task-registry-branch-protect"],
      },
    });

    const canonicalBranch = workspace.metadata.canonicalBranch;

    // Remove the worktree but keep the branch and registry record
    // This simulates the scenario where worktree is gone but the record still
    // exists in the registry in a non-terminal state (e.g., ready/active)
    await fs.rm(workspace.cwd, { recursive: true, force: true });
    git(tempDir, "worktree prune");

    // Verify branch still exists before artifact reconciliation
    expect(git(tempDir, `branch --list ${canonicalBranch}`)).toContain(canonicalBranch);

    // Run artifact reconciliation — without the fix, this would delete the
    // branch because it has no matching worktree in the trackedBranches set.
    // With the fix, it should consult the registry and preserve the branch.
    await reconcileDispatchWorkspaceArtifacts(tempDir);

    // The branch should still exist because the registry record is not in a
    // terminal/cleanup state
    expect(git(tempDir, `branch --list ${canonicalBranch}`)).toContain(canonicalBranch);
  });

  // AC: @dispatch-workspace-registry ac-13
  it("preserves dispatch branches for registry records in closing state (non-closed is not eligible for deletion)", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 43)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Closing Branch Preserve",
        slugs: ["task-closing-branch-preserve"],
      },
    });

    const canonicalBranch = workspace.metadata.canonicalBranch;

    // Transition to closing/merged
    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: {
        title: "Closing Branch Preserve",
        slugs: ["task-closing-branch-preserve"],
      },
    });

    // Remove the worktree (simulating partial reap) but keep the branch
    await fs.rm(workspace.cwd, { recursive: true, force: true });
    git(tempDir, "worktree prune");

    // Verify branch exists
    expect(git(tempDir, `branch --list ${canonicalBranch}`)).toContain(canonicalBranch);

    // Artifact reconciliation must preserve the branch because the record
    // is still non-closed (lifecycle_state = "closing").  AC-13 says only
    // branches whose registry record has lifecycle_state "closed" are
    // eligible for deletion.
    await reconcileDispatchWorkspaceArtifacts(tempDir);

    // Branch should still exist — "closing" is not "closed"
    expect(git(tempDir, `branch --list ${canonicalBranch}`)).toContain(canonicalBranch);
  });

  // AC: @dispatch-workspace-registry ac-13
  it("allows deletion of dispatch branches for registry records in closed state", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 44)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Closed Branch Delete",
        slugs: ["task-closed-branch-delete"],
      },
    });

    const canonicalBranch = workspace.metadata.canonicalBranch;

    // Transition to closing/merged first
    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: {
        title: "Closed Branch Delete",
        slugs: ["task-closed-branch-delete"],
      },
    });

    // Now advance cleanup to "completed" so lifecycle reaches "closed".
    // We do this by directly updating the registry record's cleanup status,
    // simulating what the reap process does after cleaning up artifacts.
    const ctx = await initContext(tempDir);
    const records = await loadDispatchWorkspaceRegistry(ctx);
    const record = records.find((r) => r.task_ref === taskRef);
    expect(record).toBeDefined();
    await saveDispatchWorkspaceRecord(ctx, {
      ...record!,
      lifecycle_state: "closed",
      cleanup: {
        ...record!.cleanup,
        status: "completed",
      },
      timestamps: {
        ...record!.timestamps,
        updated_at: new Date().toISOString(),
        closed_at: new Date().toISOString(),
      },
    });

    // Remove the worktree but keep the branch
    await fs.rm(workspace.cwd, { recursive: true, force: true });
    git(tempDir, "worktree prune");

    // Verify branch exists
    expect(git(tempDir, `branch --list ${canonicalBranch}`)).toContain(canonicalBranch);

    // Artifact reconciliation should delete the branch because the record
    // is in "closed" state — per AC-13, closed records are eligible.
    await reconcileDispatchWorkspaceArtifacts(tempDir);

    // Branch should be deleted — record is closed
    expect(git(tempDir, `branch --list ${canonicalBranch}`)).toBe("");
  });

  // AC: @dispatch-workspace-registry ac-13
  it("still deletes truly orphaned dispatch branches with no registry record", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    // Create an orphan dispatch branch with no registry record
    git(tempDir, "branch dispatch/task/orphaned-no-registry/01orphn");

    expect(git(tempDir, "branch --list dispatch/task/orphaned-no-registry/01orphn")).toContain(
      "dispatch/task/orphaned-no-registry/01orphn",
    );

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    // Orphan branch with no registry record should be deleted
    expect(git(tempDir, "branch --list dispatch/task/orphaned-no-registry/01orphn")).toBe("");
  });
});
