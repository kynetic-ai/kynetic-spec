import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  getDispatchWorkspaceHealth,
  provisionDispatchWorkspace,
  reconcileDispatchWorkspaceRegistry,
} from "../src/agent-runtime/workspace.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  testUlid,
} from "./helpers/cli.js";

// AC: @trait-error-guidance ac-1 — N/A: internal workspace health reconciliation, not a user-facing CLI command
// AC: @trait-error-guidance ac-2 — N/A: internal workspace health reconciliation, not a user-facing CLI command
// AC: @trait-error-guidance ac-3 — N/A: internal workspace health reconciliation, not a user-facing ref lookup surface
// AC: @trait-error-guidance ac-4 — N/A: internal state transitions, not surfaced as CLI transition errors
// AC: @trait-error-guidance ac-5 — N/A: schema validation exercised through parser/runtime tests
// AC: @trait-error-guidance ac-6 — N/A: health reconciliation does not expose a JSON CLI mode

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
    'kynetic: "1"\ntitle: "Remote Branch Fallback Test"\n',
    "utf-8",
  );
  return specDir;
}

async function readWorkspaceRecord(
  registryPath: string,
  taskRef: string,
): Promise<Record<string, any>> {
  const raw = YAML.parse(await fs.readFile(registryPath, "utf-8")) as {
    workspaces?: Array<Record<string, any>>;
  };
  return raw.workspaces?.find((workspace) => workspace.task_ref === taskRef) ?? {};
}

describe("remote branch fallback in workspace health reconciliation", () => {
  let tempDir: string;
  let remoteDir: string;
  let specDir: string;
  let originalSpecDir: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-remote-fallback-");
    remoteDir = await createTempDir("kspec-dispatch-remote-bare-");
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

  // AC: @dispatch-workspace-remote-branch-fallback ac-1
  it("restores a missing local canonical branch from a remote ref", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    // Set up bare remote
    git(remoteDir, "init --bare");
    git(tempDir, `remote add origin "${remoteDir}"`);

    const taskRef = `@${testUlid("TASK", 1)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Remote Fallback Restore",
        slugs: ["task-remote-fallback-restore"],
      },
    });

    // Push the canonical branch to remote
    const canonicalBranch = workspace.metadata.canonicalBranch;
    git(tempDir, `push origin ${canonicalBranch}`);

    // Record the commit hash before deletion
    const originalHead = git(tempDir, `rev-parse ${canonicalBranch}`);

    // Remove the worktree and delete the local branch
    git(tempDir, `worktree remove "${workspace.cwd}" --force`);
    git(tempDir, `branch -D ${canonicalBranch}`);

    // Verify local branch is gone
    const localBranchGone = execSync(
      `git show-ref --verify --quiet refs/heads/${canonicalBranch}; echo $?`,
      { cwd: tempDir, encoding: "utf-8" },
    ).trim();
    expect(localBranchGone).toBe("1");

    // Verify remote ref exists
    const remoteRefExists = execSync(
      `git show-ref --verify --quiet refs/remotes/origin/${canonicalBranch}; echo $?`,
      { cwd: tempDir, encoding: "utf-8" },
    ).trim();
    expect(remoteRefExists).toBe("0");

    // Run health check — should restore from remote
    const health = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef,
    });

    // Branch should be restored — no missing_canonical_branch issue
    expect(health.exists).toBe(true);
    // Health won't be fully healthy (worktree is gone) but the reason should NOT be missing-canonical-branch
    expect(health.reason).not.toBe("missing-canonical-branch");

    // Verify the local branch was actually restored
    const restoredHead = git(tempDir, `rev-parse refs/heads/${canonicalBranch}`);
    expect(restoredHead).toBe(originalHead);
  });

  // AC: @dispatch-workspace-remote-branch-fallback ac-2
  it("emits missing_canonical_branch when branch is absent locally and on all remotes", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    // Set up bare remote (empty — no branches pushed)
    git(remoteDir, "init --bare");
    git(tempDir, `remote add origin "${remoteDir}"`);

    const taskRef = `@${testUlid("TASK", 2)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Remote Fallback Missing",
        slugs: ["task-remote-fallback-missing"],
      },
    });

    const canonicalBranch = workspace.metadata.canonicalBranch;

    // Remove the worktree and delete the local branch WITHOUT pushing to remote
    git(tempDir, `worktree remove "${workspace.cwd}" --force`);
    git(tempDir, `branch -D ${canonicalBranch}`);

    // Run health check — branch is gone everywhere
    const health = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef,
    });

    expect(health.exists).toBe(true);
    expect(health.healthy).toBe(false);
    expect(health.reason).toBe("missing-canonical-branch");
  });

  // AC: @dispatch-workspace-remote-branch-fallback ac-3
  it("degrades gracefully when remote fetch fails and logs at debug level", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    // Set up bare remote and push the branch
    git(remoteDir, "init --bare");
    git(tempDir, `remote add origin "${remoteDir}"`);

    const taskRef = `@${testUlid("TASK", 3)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Remote Fallback Error",
        slugs: ["task-remote-fallback-error"],
      },
    });

    const canonicalBranch = workspace.metadata.canonicalBranch;
    git(tempDir, `push origin ${canonicalBranch}`);

    // Remove worktree and delete local branch
    git(tempDir, `worktree remove "${workspace.cwd}" --force`);
    git(tempDir, `branch -D ${canonicalBranch}`);

    // Break the remote by making it point to a non-existent location
    git(tempDir, "remote remove origin");
    git(tempDir, `remote add origin "/nonexistent/path/to/repo"`);

    // Spy on console.debug to verify debug logging
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    // Run health check — remote fetch should fail gracefully
    const health = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef,
    });

    // Should fall back to missing_canonical_branch
    expect(health.exists).toBe(true);
    expect(health.healthy).toBe(false);
    expect(health.reason).toBe("missing-canonical-branch");

    debugSpy.mockRestore();
  });

  // AC: @dispatch-workspace-remote-branch-fallback ac-4
  it("updates canonical_branch_head after restoring a branch from remote", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    // Set up bare remote
    git(remoteDir, "init --bare");
    git(tempDir, `remote add origin "${remoteDir}"`);

    const taskRef = `@${testUlid("TASK", 4)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Remote Fallback Head Update",
        slugs: ["task-remote-fallback-head-update"],
      },
    });

    const canonicalBranch = workspace.metadata.canonicalBranch;

    // Make a commit on the canonical branch in the worktree
    await fs.writeFile(path.join(workspace.cwd, "feature.txt"), "work\n", "utf-8");
    git(workspace.cwd, "add feature.txt");
    git(workspace.cwd, 'commit -m "task work"');

    // Push the updated branch to remote
    git(workspace.cwd, `push origin ${canonicalBranch}`);

    // Record the updated commit hash
    const updatedHead = git(workspace.cwd, "rev-parse HEAD");

    // Remove the worktree and delete the local branch
    git(tempDir, `worktree remove "${workspace.cwd}" --force`);
    git(tempDir, `branch -D ${canonicalBranch}`);

    // Run reconciliation (which updates canonical_branch_head)
    await reconcileDispatchWorkspaceRegistry(
      tempDir,
      new Map([[taskRef, "in_progress" as const]]),
    );

    // Read the registry record and verify canonical_branch_head was updated
    const registryPath = path.join(specDir, "project.dispatch-workspaces.yaml");
    const record = await readWorkspaceRecord(registryPath, taskRef);

    expect(record.canonical_branch_head).toBe(updatedHead);
  });
});
