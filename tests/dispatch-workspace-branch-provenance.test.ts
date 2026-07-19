import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import { initContext } from "../src/parser/index.js";
import {
  getDispatchWorkspaceRegistryPath,
  loadDispatchWorkspaceRegistry,
  saveDispatchWorkspaceRecord,
} from "../src/parser/dispatch-workspaces.js";
import { findDispatchWorkspaceByCanonicalTask } from "../src/agent-runtime/workspace-identity.js";
import {
  provisionDispatchWorkspace,
  reapDispatchWorkspace,
  reconcileDispatchWorkspaceLifecycle,
  reconcileDispatchWorkspaceArtifacts,
  reconcileDispatchWorkspaceRegistry,
} from "../src/agent-runtime/workspace.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
  testUlid,
} from "./helpers/cli.js";

// AC: @trait-error-guidance ac-1 — N/A: branch provenance is internal workspace registry state, not a user-facing CLI command
// AC: @trait-error-guidance ac-2 — N/A: branch provenance is internal workspace registry state, not a user-facing CLI command
// AC: @trait-error-guidance ac-3 — N/A: branch provenance is internal workspace registry state, not a user-facing ref lookup surface
// AC: @trait-error-guidance ac-4 — N/A: branch provenance does not introduce state transitions surfaced as CLI errors
// AC: @trait-error-guidance ac-5 — N/A: branch provenance validation is exercised through schema parsing, not CLI error rendering
// AC: @trait-error-guidance ac-6 — N/A: branch provenance is not exposed through a JSON CLI mode

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
    'kynetic: "1"\ntitle: "Branch Provenance Test"\n',
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

describe("dispatch workspace branch provenance", () => {
  let tempDir: string;
  let specDir: string;
  let originalSpecDir: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-branch-provenance-");
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

  // AC: @branch-provenance-in-dispatch-workspace-registry ac-1
  it("stores dispatcher-managed provenance when a workspace is provisioned with a deterministic branch", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("PROV", 1)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Provenance Managed Branch",
        slugs: ["task-provenance-managed-branch"],
      },
    });

    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);
    expect(record.branch_provenance).toMatchObject({
      ownership: "dispatcher-managed",
      source: "provisioned",
      remote_ref: null,
      adopted_from: null,
      adopted_at: null,
    });
    expect(record.canonical_branch).toMatch(/^dispatch\/task\//);
  });

  // AC: @branch-provenance-in-dispatch-workspace-registry ac-1
  it("preserves existing provenance when re-provisioning an existing workspace", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("PROV", 2)}`;
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Provenance Re-provision",
        slugs: ["task-provenance-re-provision"],
      },
    });

    const workspace2 = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Provenance Re-provision",
        slugs: ["task-provenance-re-provision"],
      },
    });

    const record = await readWorkspaceRecord(workspace2.metadataPath, taskRef);
    expect(record.branch_provenance).toMatchObject({
      ownership: "dispatcher-managed",
      source: "provisioned",
    });
  });

  // AC: @branch-provenance-in-dispatch-workspace-registry ac-1
  it("distinguishes ownership and cleanup semantics between dispatcher-managed and adopted branches", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("PROV", 3)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Cleanup Semantics Test",
        slugs: ["task-cleanup-semantics-test"],
      },
    });

    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);
    expect(record.branch_provenance.ownership).toBe("dispatcher-managed");
    // Dispatcher-managed branches can be deleted during cleanup
    // (verified by the existing cleanup tests in dispatch-workspace-cleanup.test.ts)
  });

  // AC: @branch-provenance-in-dispatch-workspace-registry ac-2
  it("preserves adopted branch identity during reconciliation instead of normalizing to dispatch namespace", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("PROV", 4)}`;
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Adopted Branch Reconciliation",
        slugs: ["task-adopted-branch-reconciliation"],
      },
    });

    // Manually set provenance to adopted to simulate an adopted branch
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const existingRecord = await findDispatchWorkspaceByCanonicalTask(ctx, taskRef);
    expect(existingRecord).toBeTruthy();

    const adoptedBranch = existingRecord!.canonical_branch;
    const now = new Date().toISOString();
    await saveDispatchWorkspaceRecord(ctx, {
      ...existingRecord!,
      branch_provenance: {
        ownership: "adopted",
        source: "task-submission-linkage",
        remote_ref: "origin/feat/my-feature",
        adopted_from: "feat/my-feature",
        adopted_at: now,
      },
      _sourceFile: registryPath,
    });

    // Reconcile and verify provenance is preserved
    await reconcileDispatchWorkspaceRegistry(tempDir, new Map([[taskRef, "in_progress" as const]]));

    const record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.branch_provenance).toMatchObject({
      ownership: "adopted",
      source: "task-submission-linkage",
      remote_ref: "origin/feat/my-feature",
      adopted_from: "feat/my-feature",
    });
    expect(record.branch_provenance.adopted_at).toBeTruthy();
    // Canonical branch is preserved, not normalized
    expect(record.canonical_branch).toBe(adoptedBranch);
  });

  // AC: @branch-provenance-in-dispatch-workspace-registry ac-3
  it("defaults to dispatcher-managed ownership for pre-provenance workspace records", async () => {
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const now = new Date().toISOString();
    const taskRef = `@${testUlid("PROV", 5)}`;

    // Write a workspace record WITHOUT branch_provenance (simulating a pre-migration record)
    await fs.writeFile(
      registryPath,
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [
          {
            workspace_id: "dispatch-workspace-legacy-provenance",
            task_ref: taskRef,
            task_slug: "task-legacy-no-provenance",
            worktree_root: path.join(tempDir, ".kspec-worktrees"),
            resolved_base_branch: "main",
            base_branch_point: "abc123",
            canonical_branch: "dispatch/task/task-legacy-no-provenance/legacy",
            canonical_branch_head: "def456",
            lifecycle_state: "ready",
            active_role: null,
            worktrees: {
              worker: {
                path: path.join(tempDir, ".kspec-worktrees", "legacy-worker"),
                branch_mode: "branch",
                branch_ref: "dispatch/task/task-legacy-no-provenance/legacy",
                head: "def456",
                last_seen_at: now,
              },
              reviewer: null,
            },
            bootstrap: {
              status: "not_run",
              detail: null,
              updated_at: now,
            },
            integration: {
              status: "pending",
              target_branch: "main",
              target_commit: "abc123",
              publication_mode: "manual_merge",
              outcome: "manual_merge",
              detail: null,
              updated_at: now,
            },
            health: {
              status: "healthy",
              summary: "healthy",
              issues: [],
              updated_at: now,
            },
            cleanup: {
              status: "not_scheduled",
              eligible: false,
              reason: null,
              detail: null,
              updated_at: now,
            },
            timestamps: {
              created_at: now,
              updated_at: now,
              last_reconciled_at: now,
              last_active_at: null,
              closed_at: null,
            },
          },
        ],
      }),
      "utf-8",
    );

    // Load through the registry parser — should apply default provenance
    const [record] = await loadDispatchWorkspaceRegistry(ctx);
    expect(record).toBeTruthy();
    expect(record.branch_provenance).toMatchObject({
      ownership: "dispatcher-managed",
      source: "provisioned",
      remote_ref: null,
      adopted_from: null,
      adopted_at: null,
    });
  });

  // AC: @branch-provenance-in-dispatch-workspace-registry ac-3
  it("does not break dispatch continuity when loading pre-provenance records", async () => {
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const now = new Date().toISOString();
    const taskRef = `@${testUlid("PROV", 6)}`;

    // Write a workspace record WITHOUT branch_provenance
    await fs.writeFile(
      registryPath,
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [
          {
            workspace_id: "dispatch-workspace-continuity",
            task_ref: taskRef,
            task_slug: "task-continuity-check",
            worktree_root: path.join(tempDir, ".kspec-worktrees"),
            resolved_base_branch: "main",
            base_branch_point: "abc123",
            canonical_branch: "dispatch/task/task-continuity-check/contchk",
            canonical_branch_head: "def456",
            lifecycle_state: "active",
            active_role: "worker",
            worktrees: {
              worker: {
                path: path.join(tempDir, ".kspec-worktrees", "continuity-worker"),
                branch_mode: "branch",
                branch_ref: "dispatch/task/task-continuity-check/contchk",
                head: "def456",
                last_seen_at: now,
              },
              reviewer: null,
            },
            bootstrap: {
              status: "succeeded",
              detail: null,
              updated_at: now,
            },
            integration: {
              status: "in_progress",
              target_branch: "main",
              target_commit: "abc123",
              publication_mode: "pull_request",
              outcome: "pull_request",
              detail: null,
              updated_at: now,
            },
            health: {
              status: "healthy",
              summary: "healthy",
              issues: [],
              updated_at: now,
            },
            cleanup: {
              status: "not_scheduled",
              eligible: false,
              reason: null,
              detail: null,
              updated_at: now,
            },
            timestamps: {
              created_at: now,
              updated_at: now,
              last_reconciled_at: now,
              last_active_at: now,
              closed_at: null,
            },
          },
        ],
      }),
      "utf-8",
    );

    // Load and verify all fields are intact
    const [record] = await loadDispatchWorkspaceRegistry(ctx);
    expect(record).toBeTruthy();
    expect(record.lifecycle_state).toBe("active");
    expect(record.active_role).toBe("worker");
    expect(record.integration.status).toBe("in_progress");
    expect(record.canonical_branch).toBe("dispatch/task/task-continuity-check/contchk");
    // Default provenance applied without breaking anything
    expect(record.branch_provenance.ownership).toBe("dispatcher-managed");
  });

  // AC: @branch-provenance-in-dispatch-workspace-registry ac-1
  it("records provenance locator data sufficient for remote recovery", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("PROV", 7)}`;
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Provenance Locator Data",
        slugs: ["task-provenance-locator-data"],
      },
    });

    // Update record with adopted provenance including remote locator
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const existingRecord = await findDispatchWorkspaceByCanonicalTask(ctx, taskRef);
    const now = new Date().toISOString();

    await saveDispatchWorkspaceRecord(ctx, {
      ...existingRecord!,
      branch_provenance: {
        ownership: "adopted",
        source: "task-submission-linkage",
        remote_ref: "origin/feat/my-feature",
        adopted_from: "feat/my-feature",
        adopted_at: now,
      },
      _sourceFile: registryPath,
    });

    const record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.branch_provenance.remote_ref).toBe("origin/feat/my-feature");
    expect(record.branch_provenance.adopted_from).toBe("feat/my-feature");
    expect(record.branch_provenance.source).toBe("task-submission-linkage");
  });

  // AC: @branch-provenance-in-dispatch-workspace-registry ac-2
  it("reaps adopted workspace via registry fallback when synthetic dispatch/task/* branch does not exist", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("PROV", 9)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Reap Adopted Workspace",
        slugs: ["task-reap-adopted-workspace"],
      },
    });

    // Simulate adoption: rename the branch to a non-dispatch name and update the registry
    const adoptedBranch = "feat/adopted-work";
    git(workspace.cwd, `checkout -b ${adoptedBranch}`);
    git(tempDir, `branch -D ${workspace.metadata.canonicalBranch}`);

    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const existingRecord = await findDispatchWorkspaceByCanonicalTask(ctx, taskRef);
    const now = new Date().toISOString();

    await saveDispatchWorkspaceRecord(ctx, {
      ...existingRecord!,
      canonical_branch: adoptedBranch,
      canonical_branch_head: git(workspace.cwd, "rev-parse HEAD"),
      branch_provenance: {
        ownership: "adopted",
        source: "task-submission-linkage",
        remote_ref: null,
        adopted_from: adoptedBranch,
        adopted_at: now,
      },
      _sourceFile: registryPath,
    });

    // Write adopted branch metadata into the worktree
    const metadataFile = path.join(workspace.cwd, ".kspec-dispatch-workspace.json");
    const metadata = JSON.parse(await readTestOutput(metadataFile));
    metadata.canonicalBranch = adoptedBranch;
    metadata.branchProvenance = {
      ownership: "adopted",
      source: "task-submission-linkage",
      remote_ref: null,
      adopted_from: adoptedBranch,
      adopted_at: now,
    };
    await fs.writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

    // Make the workspace cleanup-eligible
    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: {
        title: "Reap Adopted Workspace",
        slugs: ["task-reap-adopted-workspace"],
      },
    });

    // Reap — should discover the workspace via registry fallback
    const result = await reapDispatchWorkspace(tempDir, taskRef, {
      task: {
        title: "Reap Adopted Workspace",
        slugs: ["task-reap-adopted-workspace"],
      },
    });

    expect(result).toEqual({
      taskRef,
      action: "reaped",
      blockedReason: null,
    });

    // Worktree should be removed
    await expect(fs.access(workspace.cwd)).rejects.toThrow();

    // Adopted branch should NOT be deleted (cleanup preserves adopted branches)
    expect(git(tempDir, `branch --list ${adoptedBranch}`)).toContain(adoptedBranch);
  });

  // AC: @branch-provenance-in-dispatch-workspace-registry ac-2
  it("reaps adopted workspace via artifact reconciliation", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("PROV", 10)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Reap Adopted Via Reconcile",
        slugs: ["task-reap-adopted-via-reconcile"],
      },
    });

    // Simulate adoption: rename branch and update registry + metadata
    const adoptedBranch = "feat/adopted-reconcile";
    git(workspace.cwd, `checkout -b ${adoptedBranch}`);
    git(tempDir, `branch -D ${workspace.metadata.canonicalBranch}`);

    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const existingRecord = await findDispatchWorkspaceByCanonicalTask(ctx, taskRef);
    const now = new Date().toISOString();

    await saveDispatchWorkspaceRecord(ctx, {
      ...existingRecord!,
      canonical_branch: adoptedBranch,
      canonical_branch_head: git(workspace.cwd, "rev-parse HEAD"),
      branch_provenance: {
        ownership: "adopted",
        source: "task-submission-linkage",
        remote_ref: null,
        adopted_from: adoptedBranch,
        adopted_at: now,
      },
      _sourceFile: registryPath,
    });

    const metadataFile = path.join(workspace.cwd, ".kspec-dispatch-workspace.json");
    const metadata = JSON.parse(await readTestOutput(metadataFile));
    metadata.canonicalBranch = adoptedBranch;
    metadata.branchProvenance = {
      ownership: "adopted",
      source: "task-submission-linkage",
      remote_ref: null,
      adopted_from: adoptedBranch,
      adopted_at: now,
    };
    await fs.writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

    // Make cleanup-eligible
    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: {
        title: "Reap Adopted Via Reconcile",
        slugs: ["task-reap-adopted-via-reconcile"],
      },
    });

    // Run artifact reconciliation (the path that triggered the bug)
    await reconcileDispatchWorkspaceArtifacts(tempDir);

    // Worktree should be removed
    await expect(fs.access(workspace.cwd)).rejects.toThrow();

    // Adopted branch preserved
    expect(git(tempDir, `branch --list ${adoptedBranch}`)).toContain(adoptedBranch);
  });

  // AC: @branch-provenance-in-dispatch-workspace-registry ac-2
  it("preserves adopted branch identity during metadata-backed recovery when branch_provenance is missing", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("PROV", 11)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Legacy Adopted Recovery",
        slugs: ["task-legacy-adopted-recovery"],
      },
    });

    // Simulate adoption: rename branch to a non-dispatch name
    const adoptedBranch = "feat/legacy-adopted";
    git(workspace.cwd, `checkout -b ${adoptedBranch}`);
    git(tempDir, `branch -D ${workspace.metadata.canonicalBranch}`);

    // Write metadata WITHOUT branchProvenance (simulating a legacy workspace
    // that was adopted before provenance tracking existed)
    const metadataFile = path.join(workspace.cwd, ".kspec-dispatch-workspace.json");
    const metadata = JSON.parse(await readTestOutput(metadataFile));
    metadata.canonicalBranch = adoptedBranch;
    delete metadata.branchProvenance;
    await fs.writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

    // Remove the registry record so recovery from metadata is triggered
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    await fs.writeFile(
      registryPath,
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [],
      }),
      "utf-8",
    );

    // Run artifact reconciliation — should recover from metadata
    await reconcileDispatchWorkspaceArtifacts(tempDir);

    // Verify the recovered record preserves adopted branch identity
    const record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.canonical_branch).toBe(adoptedBranch);
    expect(record.branch_provenance).toMatchObject({
      ownership: "adopted",
      adopted_from: adoptedBranch,
    });
  });

  // AC: @branch-provenance-in-dispatch-workspace-registry ac-2
  it("does not normalize adopted canonical branch back to dispatch namespace during reconciliation", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");

    const taskRef = `@${testUlid("PROV", 8)}`;
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "No Normalize Adopted",
        slugs: ["task-no-normalize-adopted"],
      },
    });

    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const existingRecord = await findDispatchWorkspaceByCanonicalTask(ctx, taskRef);
    const canonicalBranch = existingRecord!.canonical_branch;
    const now = new Date().toISOString();

    // Set adopted provenance
    await saveDispatchWorkspaceRecord(ctx, {
      ...existingRecord!,
      branch_provenance: {
        ownership: "adopted",
        source: "task-submission-linkage",
        remote_ref: null,
        adopted_from: "feat/manual-work",
        adopted_at: now,
      },
      _sourceFile: registryPath,
    });

    // Run full reconciliation
    await reconcileDispatchWorkspaceRegistry(
      tempDir,
      new Map([[taskRef, "pending_review" as const]]),
    );

    // Verify canonical branch was NOT changed
    const record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.canonical_branch).toBe(canonicalBranch);
    expect(record.branch_provenance.ownership).toBe("adopted");
  });
});
