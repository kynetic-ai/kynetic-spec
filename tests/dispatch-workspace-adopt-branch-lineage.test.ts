import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  provisionDispatchWorkspace,
  DispatchWorkspaceError,
} from "../src/agent-runtime/workspace.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
  testUlid,
} from "./helpers/cli.js";

// AC: @trait-error-guidance ac-1 — Covered by AC-4 test: DispatchWorkspaceError.message includes description
// AC: @trait-error-guidance ac-2 — Covered by AC-4 test: DispatchWorkspaceError.suggestion includes recovery action
// AC: @trait-error-guidance ac-3 — N/A: adoption does not perform ref lookups surfaced as CLI errors
// AC: @trait-error-guidance ac-4 — N/A: adoption does not introduce new task state transitions; it occurs during workspace provisioning
// AC: @trait-error-guidance ac-5 — Covered by AC-4 test: error message identifies what is missing (linkage/branch)
// AC: @trait-error-guidance ac-6 — N/A: adoption errors propagate through dispatch engine, which adds structured notes; no separate JSON CLI mode

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
    'kynetic: "1"\ntitle: "Adopt Branch Lineage Test"\n',
    "utf-8",
  );
  return specDir;
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

function makeSubmissionLinkage(branch: string | null, commit: string, remote?: string | null) {
  return {
    branch,
    commit,
    remote: remote ?? null,
    remote_url: null,
    upstream_ref: null,
    review_url: null,
    captured_at: new Date().toISOString(),
  };
}

describe("dispatch workspace adopt existing task branch lineage", () => {
  let tempDir: string;
  let specDir: string;
  let originalSpecDir: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-adopt-branch-");
    specDir = await setupShadowSpecDir(tempDir);
    originalSpecDir = process.env.KSPEC_SPEC_DIR;
    process.env.KSPEC_SPEC_DIR = specDir;
  });

  afterEach(async () => {
    if (originalSpecDir === undefined) {
      delete process.env.KSPEC_SPEC_DIR;
    } else {
      process.env.KSPEC_SPEC_DIR = originalSpecDir;
    }
    await cleanupTempDir(tempDir);
  });

  // AC: @adopt-existing-task-branch-lineage ac-1
  it("adopts a locally-available branch from submission linkage when no workspace record exists", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    // Create a manual feature branch with some work
    git(tempDir, "checkout -b feat/my-feature");
    await fs.writeFile(path.join(tempDir, "feature.ts"), "export const x = 1;\n", "utf-8");
    git(tempDir, "add feature.ts");
    git(tempDir, 'commit -m "feat: add feature"');
    const featureCommit = git(tempDir, "rev-parse HEAD");

    // Go back to dev so the worktree doesn't conflict
    git(tempDir, "checkout dev");

    const taskRef = `@${testUlid("ADPT", 1)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Adopt Branch Test", slugs: ["adopt-branch-test"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/my-feature", featureCommit),
    });

    // Canonical branch should be the adopted branch, not a dispatch/task/* branch
    expect(workspace.metadata.canonicalBranch).toBe("feat/my-feature");
    expect(workspace.metadata.branchProvenance.ownership).toBe("adopted");
    expect(workspace.metadata.branchProvenance.source).toBe("task-submission-linkage");
    expect(workspace.metadata.branchProvenance.adopted_from).toBe("feat/my-feature");

    // The workspace should point at the feature commit content
    const registryPath = path.join(specDir, "project.dispatch-workspaces.yaml");
    const record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.canonical_branch).toBe("feat/my-feature");
    expect(record.branch_provenance?.ownership).toBe("adopted");
  });

  // AC: @adopt-existing-task-branch-lineage ac-2
  it("rehydrates a branch from remote when not present locally", async () => {
    // Create an "upstream" bare repo
    const upstreamDir = path.join(tempDir, "upstream.git");
    await fs.mkdir(upstreamDir);
    execSync("git init --bare --initial-branch=main", { cwd: upstreamDir, stdio: "pipe" });

    // Create a working clone with a feature branch
    const cloneDir = path.join(tempDir, "clone");
    execSync(`git clone ${upstreamDir} clone`, { cwd: tempDir, stdio: "pipe" });
    initGitRepo(cloneDir);
    await fs.writeFile(path.join(cloneDir, "README.md"), "init\n", "utf-8");
    git(cloneDir, "add README.md");
    git(cloneDir, 'commit -m "init"');
    git(cloneDir, "push origin HEAD:main");
    git(cloneDir, "checkout -b feat/remote-feature");
    await fs.writeFile(path.join(cloneDir, "remote-feature.ts"), "export const y = 2;\n", "utf-8");
    git(cloneDir, "add remote-feature.ts");
    git(cloneDir, 'commit -m "feat: remote feature"');
    const remoteCommit = git(cloneDir, "rev-parse HEAD");
    git(cloneDir, "push origin feat/remote-feature");

    // Create a fresh checkout that does NOT have the feature branch locally
    const freshDir = path.join(tempDir, "fresh");
    execSync(`git clone ${upstreamDir} fresh`, { cwd: tempDir, stdio: "pipe" });
    initGitRepo(freshDir);

    const freshSpecDir = await setupShadowSpecDir(freshDir);
    process.env.KSPEC_SPEC_DIR = freshSpecDir;

    const taskRef = `@${testUlid("ADPT", 2)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: freshDir,
      taskRef,
      role: "reviewer",
      task: { title: "Remote Adopt Test", slugs: ["remote-adopt-test"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/remote-feature", remoteCommit, "origin"),
    });

    // Should have fetched the branch and adopted it
    expect(workspace.metadata.canonicalBranch).toBe("feat/remote-feature");
    expect(workspace.metadata.branchProvenance.ownership).toBe("adopted");
    expect(workspace.metadata.branchProvenance.remote_ref).toBe("origin/feat/remote-feature");
  });

  // AC: @adopt-existing-task-branch-lineage ac-2 — remote URL fallback
  it("rehydrates a branch via remote_url when named remotes do not have the branch", async () => {
    // Create a bare "fork" repo that has the branch
    const forkDir = path.join(tempDir, "fork.git");
    await fs.mkdir(forkDir);
    execSync("git init --bare --initial-branch=main", { cwd: forkDir, stdio: "pipe" });

    // Populate the fork with a feature branch
    const forkWork = path.join(tempDir, "fork-work");
    execSync(`git clone ${forkDir} fork-work`, { cwd: tempDir, stdio: "pipe" });
    initGitRepo(forkWork);
    await fs.writeFile(path.join(forkWork, "README.md"), "init\n", "utf-8");
    git(forkWork, "add README.md");
    git(forkWork, 'commit -m "init"');
    git(forkWork, "push origin HEAD:main");
    git(forkWork, "checkout -b feat/url-only");
    await fs.writeFile(path.join(forkWork, "url-feature.ts"), "export const u = 5;\n", "utf-8");
    git(forkWork, "add url-feature.ts");
    git(forkWork, 'commit -m "feat: url-only feature"');
    const urlCommit = git(forkWork, "rev-parse HEAD");
    git(forkWork, "push origin feat/url-only");

    // Create a fresh repo that only has "origin" pointing to a DIFFERENT bare repo (no branch)
    const mainBare = path.join(tempDir, "main-bare.git");
    await fs.mkdir(mainBare);
    execSync("git init --bare --initial-branch=main", { cwd: mainBare, stdio: "pipe" });
    // Push main to main-bare so fresh clone has something
    execSync(`git push ${mainBare} HEAD:main`, { cwd: forkWork, stdio: "pipe" });

    const freshDir = path.join(tempDir, "fresh-url");
    execSync(`git clone ${mainBare} fresh-url`, { cwd: tempDir, stdio: "pipe" });
    initGitRepo(freshDir);

    const freshSpecDir = await setupShadowSpecDir(freshDir);
    process.env.KSPEC_SPEC_DIR = freshSpecDir;

    const taskRef = `@${testUlid("ADPT", 10)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: freshDir,
      taskRef,
      role: "reviewer",
      task: { title: "URL Fallback Test", slugs: ["url-fallback-test"] },
      taskStatus: "pending_review",
      submissionLinkage: {
        branch: "feat/url-only",
        commit: urlCommit,
        remote: null,
        remote_url: forkDir,
        upstream_ref: null,
        review_url: null,
        captured_at: new Date().toISOString(),
      },
    });

    expect(workspace.metadata.canonicalBranch).toBe("feat/url-only");
    expect(workspace.metadata.branchProvenance.ownership).toBe("adopted");
  });

  // AC: @adopt-existing-task-branch-lineage ac-3
  it("resumes the same adopted canonical branch for a fix cycle (needs_work after review)", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    // Create a feature branch
    git(tempDir, "checkout -b feat/fix-cycle");
    await fs.writeFile(path.join(tempDir, "fix.ts"), "export const z = 3;\n", "utf-8");
    git(tempDir, "add fix.ts");
    git(tempDir, 'commit -m "feat: initial"');
    const featureCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout dev");

    const taskRef = `@${testUlid("ADPT", 3)}`;

    // First: provision for review (adopts the branch)
    const reviewWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Fix Cycle Test", slugs: ["fix-cycle-test"] },
      taskStatus: "pending_review",
      submissionLinkage: makeSubmissionLinkage("feat/fix-cycle", featureCommit),
    });
    expect(reviewWorkspace.metadata.canonicalBranch).toBe("feat/fix-cycle");
    expect(reviewWorkspace.metadata.branchProvenance.ownership).toBe("adopted");

    // Second: re-provision for fix cycle (needs_work) — should reuse the same adopted branch
    const fixWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: { title: "Fix Cycle Test", slugs: ["fix-cycle-test"] },
      taskStatus: "needs_work",
      // submission linkage still available but existing record should take precedence
      submissionLinkage: makeSubmissionLinkage("feat/fix-cycle", featureCommit),
    });
    expect(fixWorkspace.metadata.canonicalBranch).toBe("feat/fix-cycle");
    expect(fixWorkspace.metadata.branchProvenance.ownership).toBe("adopted");
    expect(fixWorkspace.metadata.branchProvenance.adopted_from).toBe("feat/fix-cycle");
  });

  // AC: @adopt-existing-task-branch-lineage ac-4
  it("throws with recovery guidance when no workspace record and no submission linkage for pending_review", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("ADPT", 4)}`;

    await expect(
      provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        role: "reviewer",
        task: { title: "No Linkage Test", slugs: ["no-linkage-test"] },
        taskStatus: "pending_review",
        // No submissionLinkage provided
      }),
    ).rejects.toThrow(DispatchWorkspaceError);

    try {
      await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        role: "reviewer",
        task: { title: "No Linkage Test", slugs: ["no-linkage-test"] },
        taskStatus: "pending_review",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchWorkspaceError);
      const wsErr = err as InstanceType<typeof DispatchWorkspaceError>;
      // AC: @trait-error-guidance ac-1 — error message includes description of what went wrong
      expect(wsErr.message).toContain("no existing workspace record");
      expect(wsErr.message).toContain("no recoverable branch lineage");
      // AC: @trait-error-guidance ac-2 — suggestion includes recovery action
      expect(wsErr.suggestion).toContain("submission linkage");
      // AC: @trait-error-guidance ac-5 — indicates what is missing
      expect(wsErr.message).toContain("no submission linkage recorded");
    }
  });

  // AC: @adopt-existing-task-branch-lineage ac-4
  it("throws with recovery guidance when no workspace record and no submission linkage for needs_work", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("ADPT", 5)}`;

    await expect(
      provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        role: "worker",
        task: { title: "Needs Work No Linkage", slugs: ["needs-work-no-linkage"] },
        taskStatus: "needs_work",
      }),
    ).rejects.toThrow(DispatchWorkspaceError);
  });

  // AC: @adopt-existing-task-branch-lineage ac-4
  it("throws when submission linkage has a detached HEAD (no branch name)", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("ADPT", 6)}`;

    try {
      await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        role: "reviewer",
        task: { title: "Detached Linkage", slugs: ["detached-linkage"] },
        taskStatus: "pending_review",
        submissionLinkage: makeSubmissionLinkage(null, "abc123def456abc123def456abc123def456abc1"),
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchWorkspaceError);
      const wsErr = err as InstanceType<typeof DispatchWorkspaceError>;
      expect(wsErr.message).toContain("detached HEAD");
    }
  });

  // AC: @adopt-existing-task-branch-lineage ac-4
  it("throws when submission linkage references an unreachable branch", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("ADPT", 7)}`;

    try {
      await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        role: "reviewer",
        task: { title: "Unreachable Branch", slugs: ["unreachable-branch"] },
        taskStatus: "pending_review",
        submissionLinkage: makeSubmissionLinkage(
          "feat/nonexistent-branch",
          "abc123def456abc123def456abc123def456abc1",
        ),
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchWorkspaceError);
      const wsErr = err as InstanceType<typeof DispatchWorkspaceError>;
      expect(wsErr.message).toContain("could not be found");
    }
  });

  it("does not require adoption for non-review/fix-cycle tasks without a workspace record", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("ADPT", 8)}`;

    // A regular pending task without submission linkage should provision normally
    // (creates a dispatch/task/* branch from base)
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: { title: "Normal Task", slugs: ["normal-task"] },
      taskStatus: "pending",
    });
    expect(workspace.metadata.canonicalBranch).toMatch(/^dispatch\/task\//);
    expect(workspace.metadata.branchProvenance.ownership).toBe("dispatcher-managed");
  });

  it("uses adoption when submission linkage is available for a regular pending task", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    // Create a branch with work
    git(tempDir, "checkout -b feat/pre-existing");
    await fs.writeFile(path.join(tempDir, "pre.ts"), "export const w = 4;\n", "utf-8");
    git(tempDir, "add pre.ts");
    git(tempDir, 'commit -m "feat: pre-existing work"');
    const commit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout dev");

    const taskRef = `@${testUlid("ADPT", 9)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: { title: "Pre-existing Branch", slugs: ["pre-existing-branch"] },
      submissionLinkage: makeSubmissionLinkage("feat/pre-existing", commit),
    });

    // Adoption is optional for non-review tasks but should still use it when available
    expect(workspace.metadata.canonicalBranch).toBe("feat/pre-existing");
    expect(workspace.metadata.branchProvenance.ownership).toBe("adopted");
  });

  // AC: @adopt-existing-task-branch-lineage ac-reject-main-checkout-branch
  it("rejects adoption when submission linkage branch is currently checked out in the main working tree", async () => {
    await seedRepo(tempDir);

    // Main working tree is on "dev" — linkage incorrectly points to "dev"
    git(tempDir, "checkout -b dev");
    git(tempDir, 'commit --allow-empty -m "dev commit"');
    const devCommit = git(tempDir, "rev-parse HEAD");

    const taskRef = `@${testUlid("ADPT", 11)}`;

    try {
      await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        role: "reviewer",
        task: { title: "Bad Linkage Test", slugs: ["bad-linkage-test"] },
        taskStatus: "pending_review",
        submissionLinkage: makeSubmissionLinkage("dev", devCommit),
      });
      expect.fail("should have thrown DispatchWorkspaceError");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchWorkspaceError);
      const wsErr = err as InstanceType<typeof DispatchWorkspaceError>;
      // AC: @trait-error-guidance ac-1 — error describes what went wrong
      expect(wsErr.message).toContain("checked out in the main");
      // AC: @trait-error-guidance ac-2 — suggestion includes recovery action
      expect(wsErr.suggestion).toBeTruthy();
      expect(wsErr.suggestion).toContain("submission linkage");
    }
  });

  // AC: @adopt-existing-task-branch-lineage ac-reject-main-checkout-branch
  it("rejects adoption of main checkout branch even for non-review tasks", async () => {
    await seedRepo(tempDir);

    // Main working tree is on "main" — linkage points to "main"
    const mainCommit = git(tempDir, "rev-parse HEAD");

    const taskRef = `@${testUlid("ADPT", 12)}`;

    try {
      await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        role: "worker",
        task: { title: "Main Branch Adoption", slugs: ["main-branch-adoption"] },
        submissionLinkage: makeSubmissionLinkage("main", mainCommit),
      });
      expect.fail("should have thrown DispatchWorkspaceError");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchWorkspaceError);
      const wsErr = err as InstanceType<typeof DispatchWorkspaceError>;
      expect(wsErr.message).toContain("checked out in the main");
    }
  });
});
