import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  discoverWorkspaceForReviewOrFixCycle,
  getDispatchWorkspaceHealth,
  provisionDispatchWorkspace,
} from "../src/agent-runtime/workspace.js";
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from "./helpers/cli.js";

// AC: @trait-error-guidance ac-1 — diagnostics include description of what went wrong
// AC: @trait-error-guidance ac-2 — diagnostics include suggested action to resolve
// AC: @trait-error-guidance ac-3 — N/A: discovery is not a reference lookup surface
// AC: @trait-error-guidance ac-4 — N/A: discovery does not perform task state transitions
// AC: @trait-error-guidance ac-5 — N/A: discovery does not validate schema fields
// AC: @trait-error-guidance ac-6 — N/A: discovery is internal runtime, not a JSON CLI mode

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
  git(dir, "checkout -b agent-dev");
}

async function setupShadowSpecDir(dir: string): Promise<string> {
  const specDir = path.join(dir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: "Workspace Discovery Test"\n',
    "utf-8",
  );
  return specDir;
}

async function setupConfig(dir: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: Test Project\n',
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "kspec.config.yaml"),
    ["dispatch:", "  base_branch: agent-dev", "  worktree_root: .kspec-worktrees", ""].join("\n"),
    "utf-8",
  );
}

// AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1
// AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-2
// AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-3
// AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-4
describe("review and fix-cycle workspace discovery before discard", () => {
  let tempDir: string;
  let remoteDir: string;
  let specDir: string;
  let originalSpecDir: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-discovery-");
    remoteDir = await createTempDir("kspec-dispatch-discovery-remote-");
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
    await cleanupTempDir(remoteDir);
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1
  it("recovers from registry state when canonical branch is locally restorable from remote", async () => {
    await seedRepo(tempDir);
    await setupConfig(tempDir);

    // Set up bare remote
    git(remoteDir, "init --bare");
    git(tempDir, `remote add origin "${remoteDir}"`);

    const taskRef = `@${testUlid("TASK", 1)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Discovery Registry Recovery",
        slugs: ["task-discovery-registry-recovery"],
      },
    });

    const canonicalBranch = workspace.metadata.canonicalBranch;

    // Push branch to remote, then remove locally
    git(tempDir, `push origin ${canonicalBranch}`);
    git(tempDir, `worktree remove "${workspace.cwd}" --force`);
    git(tempDir, `branch -D ${canonicalBranch}`);

    // Registry record exists but workspace is unhealthy (branch missing locally).
    // Discovery should restore from remote via registry-state precedence.
    const result = await discoverWorkspaceForReviewOrFixCycle({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: {
        title: "Discovery Registry Recovery",
        slugs: ["task-discovery-registry-recovery"],
      },
    });

    expect(result.recovered).toBe(true);
    expect(result.recoverySource).toBe("registry-state");
    expect(result.diagnostics).toHaveLength(0);
    expect(result.conflictingSignals).toBeNull();
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1
  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-2
  it("recovers from task submission linkage when no registry record exists", async () => {
    await seedRepo(tempDir);
    await setupConfig(tempDir);

    // Set up bare remote
    git(remoteDir, "init --bare");
    git(tempDir, `remote add origin "${remoteDir}"`);

    // Create a branch with some work (simulating manual submission)
    const manualBranch = "feat/manual-task-work";
    git(tempDir, `checkout -b ${manualBranch}`);
    await fs.writeFile(path.join(tempDir, "work.txt"), "task work\n", "utf-8");
    git(tempDir, "add work.txt");
    git(tempDir, 'commit -m "manual task work"');
    const commitSha = git(tempDir, "rev-parse HEAD");
    git(tempDir, `push origin ${manualBranch}`);
    git(tempDir, "checkout agent-dev");

    const taskRef = `@${testUlid("TASK", 2)}`;

    // No workspace provisioned — only submission linkage exists.
    const result = await discoverWorkspaceForReviewOrFixCycle({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: {
        title: "Discovery Submission Recovery",
        slugs: ["task-discovery-submission-recovery"],
        submission_linkage: {
          branch: manualBranch,
          commit: commitSha,
          remote: "origin",
          remote_url: remoteDir,
          upstream_ref: null,
          review_url: null,
          captured_at: new Date().toISOString(),
        },
      },
    });

    expect(result.recovered).toBe(true);
    expect(result.recoverySource).toBe("task-submission-linkage");
    expect(result.diagnostics).toHaveLength(0);
    expect(result.conflictingSignals).toBeNull();

    // Verify the workspace was registered in the registry.
    const health = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef,
    });
    expect(health.exists).toBe(true);
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1
  it("recovers from remote dispatch branch when no registry or submission linkage exists", async () => {
    await seedRepo(tempDir);
    await setupConfig(tempDir);

    // Set up bare remote
    git(remoteDir, "init --bare");
    git(tempDir, `remote add origin "${remoteDir}"`);

    const taskRef = `@${testUlid("TASK", 3)}`;
    const taskSlug = "task-discovery-remote-recovery";

    // Create a dispatch branch, push to remote, then delete locally
    const shortId = taskRef.replace(/^@/, "").slice(0, 8).toLowerCase();
    const dispatchBranch = `dispatch/task/${taskSlug}/${shortId}`;
    git(tempDir, `checkout -b ${dispatchBranch}`);
    await fs.writeFile(path.join(tempDir, "remote-work.txt"), "remote work\n", "utf-8");
    git(tempDir, "add remote-work.txt");
    git(tempDir, 'commit -m "dispatch work"');
    git(tempDir, `push origin ${dispatchBranch}`);
    git(tempDir, "checkout agent-dev");
    git(tempDir, `branch -D ${dispatchBranch}`);

    // No registry record, no submission linkage.
    const result = await discoverWorkspaceForReviewOrFixCycle({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: {
        title: "Discovery Remote Recovery",
        slugs: [taskSlug],
      },
    });

    expect(result.recovered).toBe(true);
    expect(result.recoverySource).toBe("remote-or-review-locator");
    expect(result.diagnostics).toHaveLength(0);
    expect(result.conflictingSignals).toBeNull();

    // Verify workspace registered
    const health = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef,
    });
    expect(health.exists).toBe(true);
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-3
  // AC: @trait-error-guidance ac-1 — diagnostics include description of what went wrong
  // AC: @trait-error-guidance ac-2 — diagnostics include suggested action to resolve
  it("emits explicit diagnostics when no recovery path exists", async () => {
    await seedRepo(tempDir);
    await setupConfig(tempDir);

    // Set up bare remote (no branches pushed)
    git(remoteDir, "init --bare");
    git(tempDir, `remote add origin "${remoteDir}"`);

    const taskRef = `@${testUlid("TASK", 4)}`;

    // No workspace, no submission linkage, no remote branch.
    const result = await discoverWorkspaceForReviewOrFixCycle({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: {
        title: "Discovery No Recovery",
        slugs: ["task-discovery-no-recovery"],
      },
    });

    expect(result.recovered).toBe(false);
    expect(result.recoverySource).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].taskRef).toBe(taskRef);
    expect(result.diagnostics[0].code).toBe("no-recoverable-workspace");
    expect(result.diagnostics[0].message).toContain("No trustworthy recovery path exists");
    expect(result.diagnostics[0].suggestion).toContain("kspec task submit");
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-4
  it("applies explicit precedence: registry state takes priority over submission linkage", async () => {
    await seedRepo(tempDir);
    await setupConfig(tempDir);

    // Set up bare remote
    git(remoteDir, "init --bare");
    git(tempDir, `remote add origin "${remoteDir}"`);

    const taskRef = `@${testUlid("TASK", 5)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Discovery Precedence",
        slugs: ["task-discovery-precedence"],
      },
    });

    const canonicalBranch = workspace.metadata.canonicalBranch;
    git(tempDir, `push origin ${canonicalBranch}`);

    // Create a different manual branch as a submission linkage candidate
    git(tempDir, "checkout agent-dev");
    git(tempDir, "checkout -b feat/different-branch");
    await fs.writeFile(path.join(tempDir, "other.txt"), "other\n", "utf-8");
    git(tempDir, "add other.txt");
    git(tempDir, 'commit -m "other work"');
    const otherCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout agent-dev");

    // Discovery should prefer the registry state (existing workspace record)
    // over the submission linkage.
    const result = await discoverWorkspaceForReviewOrFixCycle({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: {
        title: "Discovery Precedence",
        slugs: ["task-discovery-precedence"],
        submission_linkage: {
          branch: "feat/different-branch",
          commit: otherCommit,
          remote: null,
          remote_url: null,
          upstream_ref: null,
          review_url: null,
          captured_at: new Date().toISOString(),
        },
      },
    });

    expect(result.recovered).toBe(true);
    expect(result.recoverySource).toBe("registry-state");
    expect(result.diagnostics).toHaveLength(0);
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-4
  it("blocks with diagnostics when multiple branch signals conflict", async () => {
    await seedRepo(tempDir);
    await setupConfig(tempDir);

    // Set up bare remote
    git(remoteDir, "init --bare");
    git(tempDir, `remote add origin "${remoteDir}"`);

    const taskRef = `@${testUlid("TASK", 6)}`;

    // Provision a workspace with one canonical branch
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Discovery Conflict",
        slugs: ["task-discovery-conflict"],
      },
    });

    const canonicalBranch = workspace.metadata.canonicalBranch;

    // Delete the canonical branch so registry record exists but is unhealthy
    git(tempDir, `worktree remove "${workspace.cwd}" --force`);
    git(tempDir, `branch -D ${canonicalBranch}`);

    // Create a DIFFERENT branch via submission linkage that also exists
    const differentBranch = "feat/conflicting-work";
    git(tempDir, `checkout -b ${differentBranch}`);
    await fs.writeFile(path.join(tempDir, "conflict.txt"), "conflict\n", "utf-8");
    git(tempDir, "add conflict.txt");
    git(tempDir, 'commit -m "conflicting work"');
    const conflictCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout agent-dev");

    // Discovery should detect conflicting signals and block.
    const result = await discoverWorkspaceForReviewOrFixCycle({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: {
        title: "Discovery Conflict",
        slugs: ["task-discovery-conflict"],
        submission_linkage: {
          branch: differentBranch,
          commit: conflictCommit,
          remote: null,
          remote_url: null,
          upstream_ref: null,
          review_url: null,
          captured_at: new Date().toISOString(),
        },
      },
    });

    expect(result.recovered).toBe(false);
    expect(result.conflictingSignals).not.toBeNull();
    expect(result.conflictingSignals).toHaveLength(2);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics[0].code).toBe("conflicting-branch-signals");
    expect(result.diagnostics[0].message).toContain("cannot be reconciled safely");
    expect(result.diagnostics[0].suggestion).toContain("kspec task set");
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-2
  it("recovered workspace makes queue entry eligible for normal provisioning", async () => {
    await seedRepo(tempDir);
    await setupConfig(tempDir);

    // Set up bare remote
    git(remoteDir, "init --bare");
    git(tempDir, `remote add origin "${remoteDir}"`);

    const taskRef = `@${testUlid("TASK", 7)}`;

    // Create and push a branch via submission linkage
    const submittedBranch = "feat/submitted-work";
    git(tempDir, `checkout -b ${submittedBranch}`);
    await fs.writeFile(path.join(tempDir, "submitted.txt"), "submitted\n", "utf-8");
    git(tempDir, "add submitted.txt");
    git(tempDir, 'commit -m "submitted work"');
    const submitCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, `push origin ${submittedBranch}`);
    git(tempDir, "checkout agent-dev");

    // Discovery should recover and register workspace.
    const result = await discoverWorkspaceForReviewOrFixCycle({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: {
        title: "Discovery Eligible",
        slugs: ["task-discovery-eligible"],
        submission_linkage: {
          branch: submittedBranch,
          commit: submitCommit,
          remote: "origin",
          remote_url: remoteDir,
          upstream_ref: null,
          review_url: null,
          captured_at: new Date().toISOString(),
        },
      },
    });

    expect(result.recovered).toBe(true);

    // Verify the workspace health check now returns exists=true
    const health = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef,
    });
    expect(health.exists).toBe(true);

    // Normal provisioning should now proceed without errors.
    const provisioned = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: {
        title: "Discovery Eligible",
        slugs: ["task-discovery-eligible"],
      },
    });
    expect(provisioned.cwd).toBeTruthy();
    expect(provisioned.metadata.canonicalBranch).toBe(submittedBranch);
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-3
  it("diagnostics include recovery guidance for unhealthy registry record", async () => {
    await seedRepo(tempDir);
    await setupConfig(tempDir);

    const taskRef = `@${testUlid("TASK", 8)}`;

    // Provision workspace, then destroy everything so it becomes unhealthy
    // with no remote to recover from.
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Discovery Unhealthy",
        slugs: ["task-discovery-unhealthy"],
      },
    });

    const canonicalBranch = workspace.metadata.canonicalBranch;
    git(tempDir, `worktree remove "${workspace.cwd}" --force`);
    git(tempDir, `branch -D ${canonicalBranch}`);

    // No remote, no submission linkage — registry exists but is unrecoverable.
    const result = await discoverWorkspaceForReviewOrFixCycle({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: {
        title: "Discovery Unhealthy",
        slugs: ["task-discovery-unhealthy"],
      },
    });

    expect(result.recovered).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic.taskRef).toBe(taskRef);
    expect(diagnostic.code).toBe("no-recoverable-workspace");
    expect(diagnostic.message).toContain("No trustworthy recovery path exists");
    // AC: @trait-error-guidance ac-1 — description of what went wrong
    expect(diagnostic.message).toContain(taskRef);
    // AC: @trait-error-guidance ac-2 — suggested action to resolve
    expect(diagnostic.suggestion).toContain("Restore the branch");
  });

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1
  it("recovers from metadata-backed worktree when registry record is missing", async () => {
    await seedRepo(tempDir);
    await setupConfig(tempDir);

    const taskRef = `@${testUlid("TASK", 9)}`;

    // Provision workspace to create worktree with metadata file
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Discovery Metadata Recovery",
        slugs: ["task-discovery-metadata-recovery"],
      },
    });

    // Manually remove the registry record but keep the worktree and metadata file.
    const registryPath = path.join(tempDir, ".kspec", "project.dispatch-workspaces.yaml");
    await fs.writeFile(
      registryPath,
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [],
      }),
      "utf-8",
    );

    // Verify registry record is gone
    const healthBefore = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef,
    });
    expect(healthBefore.exists).toBe(false);

    // Discovery should find the metadata-backed worktree and recover.
    const result = await discoverWorkspaceForReviewOrFixCycle({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: {
        title: "Discovery Metadata Recovery",
        slugs: ["task-discovery-metadata-recovery"],
      },
    });

    expect(result.recovered).toBe(true);
    expect(result.recoverySource).toBe("metadata-backed-worktree");
    expect(result.diagnostics).toHaveLength(0);

    // Verify registry was repopulated
    const healthAfter = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef,
    });
    expect(healthAfter.exists).toBe(true);
  });
});
