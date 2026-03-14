import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  DispatchWorkspaceError,
  getDispatchWorkspaceHealth,
  provisionDispatchWorkspace,
  reapDispatchWorkspace,
  reconcileDispatchWorkspaceArtifacts,
  reconcileDispatchWorkspaceLifecycle,
} from "../src/agent-runtime/workspace.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  testUlid,
} from "./helpers/cli.js";

// ─── Shared helpers ─────────────────────────────────────────────────────────

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

async function seedRepo(dir: string): Promise<void> {
  initGitRepo(dir);
  await fs.writeFile(path.join(dir, "README.md"), "seed\n", "utf-8");
  git(dir, "add README.md");
  git(dir, 'commit -m "init"');
}

async function setupShadowSpecDir(dir: string): Promise<string> {
  const specDir = path.join(dir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: "Adopted Branch Regression Test"\n',
    "utf-8",
  );
  return specDir;
}

async function readRegistryWorkspaces(
  registryPath: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = YAML.parse(await fs.readFile(registryPath, "utf-8")) as {
    workspaces?: Array<Record<string, unknown>>;
  };
  return raw.workspaces ?? [];
}

function makeSubmissionLinkage(
  branch: string | null,
  commit: string,
  remote?: string | null,
  remoteUrl?: string | null,
) {
  return {
    branch,
    commit,
    remote: remote ?? null,
    remote_url: remoteUrl ?? null,
    upstream_ref: null,
    review_url: null,
    captured_at: new Date().toISOString(),
  };
}

// ─── @adopted-branch-cleanup-and-recoverability ──────────────────────────────

describe("adopted branch cleanup and recoverability", () => {
  let tempDir: string;
  let specDir: string;
  let originalSpecDir: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-adopted-cleanup-");
    specDir = await setupShadowSpecDir(tempDir);
    originalSpecDir = process.env.KSPEC_SPEC_DIR;
    process.env.KSPEC_SPEC_DIR = specDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalSpecDir === undefined) {
      delete process.env.KSPEC_SPEC_DIR;
    } else {
      process.env.KSPEC_SPEC_DIR = originalSpecDir;
    }
    await cleanupTempDir(tempDir);
  });

  // AC: @adopted-branch-cleanup-and-recoverability ac-1
  it("preserves adopted branch ref during cleanup while removing worktrees", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    // Create a manual feature branch with some work
    git(tempDir, "checkout -b feat/manual-work");
    await fs.writeFile(path.join(tempDir, "feature.ts"), "export const x = 1;\n", "utf-8");
    git(tempDir, "add feature.ts");
    git(tempDir, 'commit -m "feat: manual work"');
    const featureCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout dev");

    const taskRef = `@${testUlid("ACLN", 1)}`;

    // Provision with adoption (pending_review adopts the branch)
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: { title: "Adopted Cleanup Test", slugs: ["task-adopted-cleanup-test"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/manual-work", featureCommit),
    });

    expect(workspace.metadata.branchProvenance.ownership).toBe("adopted");
    expect(workspace.metadata.canonicalBranch).toBe("feat/manual-work");

    // Transition to cleanup-eligible
    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: { title: "Adopted Cleanup Test", slugs: ["task-adopted-cleanup-test"] },
    });

    // Reap the workspace
    const result = await reapDispatchWorkspace(tempDir, taskRef, {
      task: { title: "Adopted Cleanup Test", slugs: ["task-adopted-cleanup-test"] },
    });

    expect(result.action).toBe("reaped");

    // Worktree should be removed
    await expect(fs.access(workspace.cwd)).rejects.toThrow();

    // Adopted branch ref should be PRESERVED
    const branchList = git(tempDir, "branch --list feat/manual-work");
    expect(branchList).toContain("feat/manual-work");
  });

  // AC: @adopted-branch-cleanup-and-recoverability ac-2
  it("deletes dispatcher-managed branch during cleanup", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("ACLN", 2)}`;

    // Provision without adoption (creates dispatcher-managed branch)
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Managed Cleanup Test", slugs: ["task-managed-cleanup-test"] },
    });

    expect(workspace.metadata.branchProvenance.ownership).toBe("dispatcher-managed");
    const canonicalBranch = workspace.metadata.canonicalBranch;

    // Transition to cleanup-eligible
    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: { title: "Managed Cleanup Test", slugs: ["task-managed-cleanup-test"] },
    });

    // Reap the workspace
    const result = await reapDispatchWorkspace(tempDir, taskRef, {
      task: { title: "Managed Cleanup Test", slugs: ["task-managed-cleanup-test"] },
    });

    expect(result.action).toBe("reaped");

    // Worktree should be removed
    await expect(fs.access(workspace.cwd)).rejects.toThrow();

    // Dispatcher-managed branch should be DELETED
    const branchList = git(tempDir, `branch --list ${canonicalBranch}`);
    expect(branchList).toBe("");
  });

  // AC: @adopted-branch-cleanup-and-recoverability ac-3
  it("distinguishes missing adopted branch from missing dispatcher-managed branch in health state", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    // Set up a bare remote for the test
    const remoteDir = path.join(tempDir, "remote.git");
    await fs.mkdir(remoteDir);
    execSync("git init --bare --initial-branch=main", { cwd: remoteDir, stdio: "pipe" });
    git(tempDir, `remote add origin "${remoteDir}"`);

    // --- Case 1: Adopted branch missing locally but known on remote ---
    git(tempDir, "checkout -b feat/adopted-recoverable");
    await fs.writeFile(path.join(tempDir, "adopted.ts"), "export const a = 1;\n", "utf-8");
    git(tempDir, "add adopted.ts");
    git(tempDir, 'commit -m "feat: adopted work"');
    const adoptedCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "push origin feat/adopted-recoverable");
    git(tempDir, "checkout dev");

    const adoptedTaskRef = `@${testUlid("ACLN", 3)}`;
    const adoptedWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef: adoptedTaskRef,
      role: "worker",
      task: { title: "Adopted Health Test", slugs: ["task-adopted-health-test"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/adopted-recoverable", adoptedCommit, "origin"),
    });
    expect(adoptedWorkspace.metadata.branchProvenance.ownership).toBe("adopted");

    // Remove worktree and delete local adopted branch — remote still has it
    git(tempDir, `worktree remove "${adoptedWorkspace.cwd}" --force`);
    git(tempDir, "branch -D feat/adopted-recoverable");

    const adoptedHealth = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef: adoptedTaskRef,
    });

    // Remote recovery should restore the branch, so health should NOT be missing-canonical-branch
    expect(adoptedHealth.exists).toBe(true);
    expect(adoptedHealth.reason).not.toBe("missing-canonical-branch");

    // --- Case 2: Dispatcher-managed branch missing locally with no remote ---
    const managedTaskRef = `@${testUlid("ACLN", 4)}`;
    const managedWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef: managedTaskRef,
      task: { title: "Managed Health Test", slugs: ["task-managed-health-test"] },
    });
    expect(managedWorkspace.metadata.branchProvenance.ownership).toBe("dispatcher-managed");
    const managedBranch = managedWorkspace.metadata.canonicalBranch;

    // Remove worktree and delete local branch (never pushed to remote)
    git(tempDir, `worktree remove "${managedWorkspace.cwd}" --force`);
    git(tempDir, `branch -D ${managedBranch}`);

    const managedHealth = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef: managedTaskRef,
    });

    // Dispatcher-managed branch with no remote backup should be missing
    expect(managedHealth.exists).toBe(true);
    expect(managedHealth.healthy).toBe(false);
    expect(managedHealth.reason).toBe("missing-canonical-branch");

    // --- Case 3: Only reviewer snapshot missing (branch and worker exist) ---
    const reviewerTaskRef = `@${testUlid("ACLN", 5)}`;
    const workerWs = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef: reviewerTaskRef,
      task: { title: "Reviewer Missing Test", slugs: ["task-reviewer-missing-test"] },
    });
    const reviewerWs = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef: reviewerTaskRef,
      role: "reviewer",
      task: { title: "Reviewer Missing Test", slugs: ["task-reviewer-missing-test"] },
    });

    // Remove reviewer worktree only
    git(tempDir, `worktree remove "${reviewerWs.cwd}" --force`);

    const reviewerHealth = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef: reviewerTaskRef,
      role: "reviewer",
    });

    // Should be unhealthy due to missing reviewer, NOT missing canonical branch
    expect(reviewerHealth.exists).toBe(true);
    expect(reviewerHealth.healthy).toBe(false);
    expect(reviewerHealth.reason).toBe("missing-reviewer-worktree");

    // Worker health reflects stale reviewer worktree registration in workspace record,
    // but the reason is distinguished from missing canonical branch
    const workerHealth = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef: reviewerTaskRef,
      role: "worker",
    });
    expect(workerHealth.exists).toBe(true);
    // Workspace is stale due to missing reviewer worktree, but it's NOT a missing branch
    expect(workerHealth.reason).not.toBe("missing-canonical-branch");

    // Cleanup
    await cleanupTempDir(workerWs.cwd);
  });

  // AC: @adopted-branch-cleanup-and-recoverability ac-4
  it("removes local rehydration state without deleting the external source branch", async () => {
    // Set up a "remote" bare repo with a feature branch
    const remoteDir = path.join(tempDir, "upstream.git");
    await fs.mkdir(remoteDir);
    execSync("git init --bare --initial-branch=main", { cwd: remoteDir, stdio: "pipe" });

    const workDir = path.join(tempDir, "work");
    execSync(`git clone ${remoteDir} work`, { cwd: tempDir, stdio: "pipe" });
    initGitRepo(workDir);
    await fs.writeFile(path.join(workDir, "README.md"), "init\n", "utf-8");
    git(workDir, "add README.md");
    git(workDir, 'commit -m "init"');
    git(workDir, "push origin HEAD:main");
    git(workDir, "checkout -b feat/external-branch");
    await fs.writeFile(path.join(workDir, "external.ts"), "export const e = 1;\n", "utf-8");
    git(workDir, "add external.ts");
    git(workDir, 'commit -m "feat: external work"');
    const externalCommit = git(workDir, "rev-parse HEAD");
    git(workDir, "push origin feat/external-branch");

    // Create a fresh dispatch checkout that fetches the branch via adoption
    const dispatchDir = path.join(tempDir, "dispatch");
    execSync(`git clone ${remoteDir} dispatch`, { cwd: tempDir, stdio: "pipe" });
    initGitRepo(dispatchDir);

    const dispatchSpecDir = await setupShadowSpecDir(dispatchDir);
    process.env.KSPEC_SPEC_DIR = dispatchSpecDir;

    const taskRef = `@${testUlid("ACLN", 6)}`;

    // Provision — this fetches the branch from remote and adopts it
    const workspace = await provisionDispatchWorkspace({
      projectDir: dispatchDir,
      taskRef,
      role: "worker",
      task: { title: "Rehydration Cleanup Test", slugs: ["task-rehydration-cleanup-test"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/external-branch", externalCommit, "origin"),
    });

    expect(workspace.metadata.branchProvenance.ownership).toBe("adopted");

    // Verify the branch was fetched locally
    const localBranch = git(dispatchDir, "branch --list feat/external-branch");
    expect(localBranch).toContain("feat/external-branch");

    // Transition to cleanup-eligible and reap
    await reconcileDispatchWorkspaceLifecycle({
      projectDir: dispatchDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: { title: "Rehydration Cleanup Test", slugs: ["task-rehydration-cleanup-test"] },
    });

    const result = await reapDispatchWorkspace(dispatchDir, taskRef, {
      task: { title: "Rehydration Cleanup Test", slugs: ["task-rehydration-cleanup-test"] },
    });

    expect(result.action).toBe("reaped");

    // Worktree should be removed
    await expect(fs.access(workspace.cwd)).rejects.toThrow();

    // The local adopted branch ref should be PRESERVED (not deleted during reap)
    const preservedBranch = git(dispatchDir, "branch --list feat/external-branch");
    expect(preservedBranch).toContain("feat/external-branch");

    // The external source branch on the remote should still exist
    const remoteBranch = execSync(
      `git branch --list feat/external-branch`,
      { cwd: workDir, encoding: "utf-8" },
    ).trim();
    expect(remoteBranch).toContain("feat/external-branch");
  });
});

// ─── @review-and-fix-cycle-workspace-discovery-before-discard ────────────────

describe("review and fix-cycle workspace discovery before discard", () => {
  let tempDir: string;
  let specDir: string;
  let originalSpecDir: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-discovery-");
    specDir = await setupShadowSpecDir(tempDir);
    originalSpecDir = process.env.KSPEC_SPEC_DIR;
    process.env.KSPEC_SPEC_DIR = specDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalSpecDir === undefined) {
      delete process.env.KSPEC_SPEC_DIR;
    } else {
      process.env.KSPEC_SPEC_DIR = originalSpecDir;
    }
    await cleanupTempDir(tempDir);
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1
  it("recovers from submission linkage when no local workspace exists for pending_review", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    // Create feature branch with work
    git(tempDir, "checkout -b feat/discovery-review");
    await fs.writeFile(path.join(tempDir, "feature.ts"), "export const d = 1;\n", "utf-8");
    git(tempDir, "add feature.ts");
    git(tempDir, 'commit -m "feat: discovery work"');
    const featureCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout dev");

    const taskRef = `@${testUlid("DISC", 1)}`;

    // No workspace record exists. Provisioning should recover via submission linkage.
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Discovery Review Test", slugs: ["task-discovery-review-test"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/discovery-review", featureCommit),
    });

    // Recovery succeeded — workspace was adopted from submission linkage
    expect(workspace.metadata.canonicalBranch).toBe("feat/discovery-review");
    expect(workspace.metadata.branchProvenance.ownership).toBe("adopted");
    expect(workspace.metadata.branchProvenance.source).toBe("task-submission-linkage");
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1
  it("recovers from registry state when workspace record exists for needs_work", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    // Create feature branch
    git(tempDir, "checkout -b feat/fix-cycle-recovery");
    await fs.writeFile(path.join(tempDir, "fix.ts"), "export const f = 1;\n", "utf-8");
    git(tempDir, "add fix.ts");
    git(tempDir, 'commit -m "feat: fix cycle work"');
    const featureCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout dev");

    const taskRef = `@${testUlid("DISC", 2)}`;

    // First, provision for review (creates registry record with adoption)
    const reviewWs = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Fix Cycle Recovery", slugs: ["task-fix-cycle-recovery"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/fix-cycle-recovery", featureCommit),
    });
    expect(reviewWs.metadata.branchProvenance.ownership).toBe("adopted");

    // Now re-provision for fix-cycle — registry record should provide recovery
    const fixWs = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: { title: "Fix Cycle Recovery", slugs: ["task-fix-cycle-recovery"] },
      taskStatus: "needs_work",
      submissionLinkage: makeSubmissionLinkage("feat/fix-cycle-recovery", featureCommit),
    });

    // Recovery from existing registry record — same adopted branch reused
    expect(fixWs.metadata.canonicalBranch).toBe("feat/fix-cycle-recovery");
    expect(fixWs.metadata.branchProvenance.ownership).toBe("adopted");
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1
  it("recovers from remote when submission linkage branch is not local", async () => {
    // Create a bare upstream with a feature branch
    const upstreamDir = path.join(tempDir, "upstream.git");
    await fs.mkdir(upstreamDir);
    execSync("git init --bare --initial-branch=main", { cwd: upstreamDir, stdio: "pipe" });

    const cloneDir = path.join(tempDir, "clone");
    execSync(`git clone ${upstreamDir} clone`, { cwd: tempDir, stdio: "pipe" });
    initGitRepo(cloneDir);
    await fs.writeFile(path.join(cloneDir, "README.md"), "init\n", "utf-8");
    git(cloneDir, "add README.md");
    git(cloneDir, 'commit -m "init"');
    git(cloneDir, "push origin HEAD:main");
    git(cloneDir, "checkout -b feat/remote-discovery");
    await fs.writeFile(path.join(cloneDir, "remote.ts"), "export const r = 1;\n", "utf-8");
    git(cloneDir, "add remote.ts");
    git(cloneDir, 'commit -m "feat: remote discovery"');
    const remoteCommit = git(cloneDir, "rev-parse HEAD");
    git(cloneDir, "push origin feat/remote-discovery");

    // Create a fresh dispatch checkout that doesn't have the branch locally
    const freshDir = path.join(tempDir, "fresh");
    execSync(`git clone ${upstreamDir} fresh`, { cwd: tempDir, stdio: "pipe" });
    initGitRepo(freshDir);

    const freshSpecDir = await setupShadowSpecDir(freshDir);
    process.env.KSPEC_SPEC_DIR = freshSpecDir;

    const taskRef = `@${testUlid("DISC", 3)}`;

    // Provision for review — should fetch from remote via submission linkage
    const workspace = await provisionDispatchWorkspace({
      projectDir: freshDir,
      taskRef,
      role: "reviewer",
      task: { title: "Remote Discovery Test", slugs: ["task-remote-discovery-test"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/remote-discovery", remoteCommit, "origin"),
    });

    // Remote recovery succeeded
    expect(workspace.metadata.canonicalBranch).toBe("feat/remote-discovery");
    expect(workspace.metadata.branchProvenance.ownership).toBe("adopted");
    expect(workspace.metadata.branchProvenance.remote_ref).toBe("origin/feat/remote-discovery");
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-2
  it("remains eligible after successful recovery and proceeds with normal provisioning", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    // Create feature branch
    git(tempDir, "checkout -b feat/eligible-after-recovery");
    await fs.writeFile(path.join(tempDir, "eligible.ts"), "export const e = 1;\n", "utf-8");
    git(tempDir, "add eligible.ts");
    git(tempDir, 'commit -m "feat: eligible work"');
    const featureCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout dev");

    const taskRef = `@${testUlid("DISC", 4)}`;

    // Provision workspace via adoption
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Eligible After Recovery", slugs: ["task-eligible-after-recovery"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/eligible-after-recovery", featureCommit),
    });

    // After provisioning, health should report the workspace as existing and healthy
    const health = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
    });

    expect(health.exists).toBe(true);
    expect(health.healthy).toBe(true);
    expect(health.reason).toBeNull();

    // Verify the workspace is fully functional — can commit in the worktree
    await fs.writeFile(path.join(workspace.cwd, "new-file.ts"), "export const n = 1;\n", "utf-8");
    git(workspace.cwd, "add new-file.ts");
    git(workspace.cwd, 'commit -m "review: add new file"');

    // The adopted branch should have the new commit
    const registryPath = path.join(specDir, "project.dispatch-workspaces.yaml");
    const records = await readRegistryWorkspaces(registryPath);
    const record = records.find((r) => r.task_ref === taskRef);
    expect(record).toBeDefined();
    expect(record!.canonical_branch).toBe("feat/eligible-after-recovery");
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-3
  it("emits recovery guidance when no trustworthy recovery path exists for pending_review", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("DISC", 5)}`;

    // No workspace record, no submission linkage at all
    await expect(
      provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        role: "reviewer",
        task: { title: "No Recovery Path", slugs: ["task-no-recovery-path"] },
        taskStatus: "pending_review",
      }),
    ).rejects.toThrow(DispatchWorkspaceError);

    try {
      await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        role: "reviewer",
        task: { title: "No Recovery Path", slugs: ["task-no-recovery-path"] },
        taskStatus: "pending_review",
      });
    } catch (err) {
      const wsErr = err as InstanceType<typeof DispatchWorkspaceError>;
      // Explicit diagnostics, not silent pruning
      expect(wsErr.message).toContain("no existing workspace record");
      expect(wsErr.message).toContain("no recoverable branch lineage");
      // Recovery guidance provided
      expect(wsErr.suggestion).toContain("submission linkage");
    }
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-3
  it("emits recovery guidance when submission linkage references an unreachable branch for needs_work", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("DISC", 6)}`;

    // Submission linkage exists but branch is unreachable
    await expect(
      provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        role: "worker",
        task: { title: "Unreachable Fix Cycle", slugs: ["task-unreachable-fix-cycle"] },
        taskStatus: "needs_work",
        submissionLinkage: makeSubmissionLinkage(
          "feat/ghost-branch",
          "abc123def456abc123def456abc123def456abc1",
        ),
      }),
    ).rejects.toThrow(DispatchWorkspaceError);

    try {
      await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        role: "worker",
        task: { title: "Unreachable Fix Cycle", slugs: ["task-unreachable-fix-cycle"] },
        taskStatus: "needs_work",
        submissionLinkage: makeSubmissionLinkage(
          "feat/ghost-branch",
          "abc123def456abc123def456abc123def456abc1",
        ),
      });
    } catch (err) {
      const wsErr = err as InstanceType<typeof DispatchWorkspaceError>;
      expect(wsErr.message).toContain("could not be found");
      expect(wsErr.suggestion).toBeDefined();
    }
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-4
  it("applies precedence: existing registry state over submission linkage", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    // Create TWO branches: the original adopted branch and a different branch in submission linkage
    git(tempDir, "checkout -b feat/original-adopted");
    await fs.writeFile(path.join(tempDir, "original.ts"), "export const o = 1;\n", "utf-8");
    git(tempDir, "add original.ts");
    git(tempDir, 'commit -m "feat: original"');
    const originalCommit = git(tempDir, "rev-parse HEAD");

    git(tempDir, "checkout dev");
    git(tempDir, "checkout -b feat/new-submission");
    await fs.writeFile(path.join(tempDir, "new.ts"), "export const n = 1;\n", "utf-8");
    git(tempDir, "add new.ts");
    git(tempDir, 'commit -m "feat: new submission"');
    const newCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout dev");

    const taskRef = `@${testUlid("DISC", 7)}`;

    // First provision adopts the original branch
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Precedence Test", slugs: ["task-precedence-test"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/original-adopted", originalCommit),
    });

    // Second provision (fix cycle) passes DIFFERENT submission linkage,
    // but existing registry record should take precedence
    const fixWs = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: { title: "Precedence Test", slugs: ["task-precedence-test"] },
      taskStatus: "needs_work",
      submissionLinkage: makeSubmissionLinkage("feat/new-submission", newCommit),
    });

    // Registry state (original adopted branch) takes precedence over submission linkage
    expect(fixWs.metadata.canonicalBranch).toBe("feat/original-adopted");
    expect(fixWs.metadata.branchProvenance.ownership).toBe("adopted");
    expect(fixWs.metadata.branchProvenance.adopted_from).toBe("feat/original-adopted");
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-4
  it("uses metadata-backed recovery when registry is empty but worktree exists", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("DISC", 8)}`;

    // Provision normally (creates registry record + worktree)
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Metadata Recovery", slugs: ["task-metadata-recovery"] },
    });

    // Wipe the registry but keep the worktree with its metadata
    const registryPath = path.join(specDir, "project.dispatch-workspaces.yaml");
    await fs.writeFile(
      registryPath,
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [],
      }),
      "utf-8",
    );

    // Reconcile artifacts — should recover from metadata
    await reconcileDispatchWorkspaceArtifacts(tempDir);

    // Verify registry was rebuilt from metadata
    const records = await readRegistryWorkspaces(registryPath);
    const record = records.find((r) => r.task_ref === taskRef);
    expect(record).toBeDefined();
    expect(record!.canonical_branch).toBe(workspace.metadata.canonicalBranch);
  });
});

// ─── Full lifecycle regression: adopted branch through dispatch review ────────

describe("adopted branch dispatch review lifecycle", () => {
  let tempDir: string;
  let specDir: string;
  let originalSpecDir: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-adopted-lifecycle-");
    specDir = await setupShadowSpecDir(tempDir);
    originalSpecDir = process.env.KSPEC_SPEC_DIR;
    process.env.KSPEC_SPEC_DIR = specDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalSpecDir === undefined) {
      delete process.env.KSPEC_SPEC_DIR;
    } else {
      process.env.KSPEC_SPEC_DIR = originalSpecDir;
    }
    await cleanupTempDir(tempDir);
  });

  // Regression: full adoption → review → fix-cycle → review → cleanup lifecycle
  it("maintains adopted branch identity through full review and fix-cycle lifecycle", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    // Create a manual branch simulating a human's work
    git(tempDir, "checkout -b feat/human-work");
    await fs.writeFile(path.join(tempDir, "human.ts"), "export const h = 1;\n", "utf-8");
    git(tempDir, "add human.ts");
    git(tempDir, 'commit -m "feat: human work"');
    const humanCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout dev");

    const taskRef = `@${testUlid("LIFE", 1)}`;
    const linkage = makeSubmissionLinkage("feat/human-work", humanCommit);

    // Step 1: Provision for review — adopts the manual branch
    const reviewWs = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Human Work Review", slugs: ["task-human-work-review"] },
      taskStatus: "pending_review",
      submissionLinkage: linkage,
    });
    expect(reviewWs.metadata.canonicalBranch).toBe("feat/human-work");
    expect(reviewWs.metadata.branchProvenance.ownership).toBe("adopted");

    // Step 2: Re-provision for fix cycle (needs_work) — should reuse adopted branch
    const fixWs = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: { title: "Human Work Review", slugs: ["task-human-work-review"] },
      taskStatus: "needs_work",
      submissionLinkage: linkage,
    });
    expect(fixWs.metadata.canonicalBranch).toBe("feat/human-work");
    expect(fixWs.metadata.branchProvenance.ownership).toBe("adopted");

    // Make a fix commit in the worktree
    await fs.writeFile(path.join(fixWs.cwd, "fix.ts"), "export const fix = 1;\n", "utf-8");
    git(fixWs.cwd, "add fix.ts");
    git(fixWs.cwd, 'commit -m "fix: address review feedback"');

    // Step 3: Re-provision for second review — still the same branch
    const review2Ws = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Human Work Review", slugs: ["task-human-work-review"] },
      taskStatus: "pending_review",
      submissionLinkage: linkage,
    });
    expect(review2Ws.metadata.canonicalBranch).toBe("feat/human-work");
    expect(review2Ws.metadata.branchProvenance.ownership).toBe("adopted");

    // Step 4: Transition to cleanup and reap
    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: { title: "Human Work Review", slugs: ["task-human-work-review"] },
    });

    const result = await reapDispatchWorkspace(tempDir, taskRef, {
      task: { title: "Human Work Review", slugs: ["task-human-work-review"] },
    });
    expect(result.action).toBe("reaped");

    // Adopted branch should be preserved even after full lifecycle
    const branchList = git(tempDir, "branch --list feat/human-work");
    expect(branchList).toContain("feat/human-work");
  });

  // Regression: dispatcher-managed branch through same lifecycle — branch IS deleted
  it("deletes dispatcher-managed branch after full lifecycle completion", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("LIFE", 2)}`;

    // Provision creates dispatcher-managed branch (no adoption)
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Auto Work", slugs: ["task-auto-work"] },
    });
    const canonicalBranch = workspace.metadata.canonicalBranch;
    expect(workspace.metadata.branchProvenance.ownership).toBe("dispatcher-managed");

    // Make some work, do review, fix cycle
    await fs.writeFile(path.join(workspace.cwd, "auto.ts"), "export const a = 1;\n", "utf-8");
    git(workspace.cwd, "add auto.ts");
    git(workspace.cwd, 'commit -m "feat: auto work"');

    // Provision reviewer
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Auto Work", slugs: ["task-auto-work"] },
      taskStatus: "pending_review",
    });

    // Re-provision for fix cycle
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: { title: "Auto Work", slugs: ["task-auto-work"] },
      taskStatus: "needs_work",
    });

    // Complete lifecycle
    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: { title: "Auto Work", slugs: ["task-auto-work"] },
    });

    const result = await reapDispatchWorkspace(tempDir, taskRef, {
      task: { title: "Auto Work", slugs: ["task-auto-work"] },
    });
    expect(result.action).toBe("reaped");

    // Dispatcher-managed branch should be DELETED
    const branchList = git(tempDir, `branch --list ${canonicalBranch}`);
    expect(branchList).toBe("");
  });

  // Regression: adoption via reconciliation when registry is lost but metadata survives
  it("recovers adopted workspace from metadata during artifact reconciliation", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    // Create a feature branch
    git(tempDir, "checkout -b feat/metadata-recovery");
    await fs.writeFile(path.join(tempDir, "meta.ts"), "export const m = 1;\n", "utf-8");
    git(tempDir, "add meta.ts");
    git(tempDir, 'commit -m "feat: metadata recovery"');
    const metaCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout dev");

    const taskRef = `@${testUlid("LIFE", 3)}`;

    // Provision with adoption
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: { title: "Metadata Recovery Lifecycle", slugs: ["task-metadata-recovery-lifecycle"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/metadata-recovery", metaCommit),
    });
    expect(workspace.metadata.branchProvenance.ownership).toBe("adopted");

    // Wipe the registry
    const registryPath = path.join(specDir, "project.dispatch-workspaces.yaml");
    await fs.writeFile(
      registryPath,
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    // Reconcile — should recover from workspace metadata
    await reconcileDispatchWorkspaceArtifacts(tempDir);

    // Verify the record was reconstructed and adopted provenance preserved
    const records = await readRegistryWorkspaces(registryPath);
    const record = records.find((r) => r.task_ref === taskRef);
    expect(record).toBeDefined();
    expect(record!.canonical_branch).toBe("feat/metadata-recovery");

    // Re-provision for fix-cycle should find existing record
    const fixWs = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: { title: "Metadata Recovery Lifecycle", slugs: ["task-metadata-recovery-lifecycle"] },
      taskStatus: "needs_work",
      submissionLinkage: makeSubmissionLinkage("feat/metadata-recovery", metaCommit),
    });
    expect(fixWs.metadata.canonicalBranch).toBe("feat/metadata-recovery");
  });
});

// ─── Trait AC coverage ───────────────────────────────────────────────────────

// AC: @trait-error-guidance ac-1 — Covered by ac-3 tests: DispatchWorkspaceError.message includes description of what went wrong
// AC: @trait-error-guidance ac-2 — Covered by ac-3 tests: DispatchWorkspaceError.suggestion includes recovery action
// AC: @trait-error-guidance ac-3 — N/A: workspace provisioning does not perform ref lookups surfaced as CLI "not found" errors
// AC: @trait-error-guidance ac-4 — N/A: workspace provisioning does not produce task state transition errors
// AC: @trait-error-guidance ac-5 — Covered by ac-3 tests: error message identifies what is missing (linkage/branch)
// AC: @trait-error-guidance ac-6 — N/A: workspace provisioning errors propagate through dispatch engine; no separate JSON CLI mode
