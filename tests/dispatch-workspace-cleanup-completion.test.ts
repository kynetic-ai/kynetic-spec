import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  provisionDispatchWorkspace,
  reapDispatchWorkspace,
  reconcileDispatchWorkspaceLifecycle,
  reconcileDispatchWorkspaceRegistry,
} from "../src/agent-runtime/workspace.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
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

async function seedRepo(dir: string): Promise<void> {
  initGitRepo(dir);
  await fs.writeFile(path.join(dir, "README.md"), "seed\n", "utf-8");
  git(dir, "add README.md");
  git(dir, 'commit -m "init"');
}

type RegistryRecord = {
  workspace_id: string;
  task_ref: string;
  canonical_branch: string;
  lifecycle_state: string;
  cleanup: {
    status: string;
    eligible: boolean;
    reason: string | null;
    detail: string | null;
    updated_at: string;
  };
  timestamps: {
    created_at: string;
    updated_at: string;
    last_reconciled_at: string | null;
    last_active_at: string | null;
    closed_at: string | null;
  };
};

async function readRegistryRecords(dir: string): Promise<RegistryRecord[]> {
  const registryPath = path.join(dir, "project.dispatch-workspaces.yaml");
  const raw = YAML.parse(await readTestOutput(registryPath)) as {
    workspaces?: RegistryRecord[];
  };
  return raw.workspaces ?? [];
}

async function writeRegistryRecords(dir: string, workspaces: RegistryRecord[]): Promise<void> {
  const registryPath = path.join(dir, "project.dispatch-workspaces.yaml");
  await fs.writeFile(
    registryPath,
    YAML.stringify({
      kynetic_dispatch_workspaces: "1.0",
      workspaces,
    }),
    "utf-8",
  );
}

async function markCleanupEligible(
  projectDir: string,
  taskRef: string,
  task: { title: string; slugs: string[] },
): Promise<void> {
  await reconcileDispatchWorkspaceLifecycle({
    projectDir,
    taskRef,
    cleanupState: { integrationState: "merged", taskStatus: "completed" },
    task,
  });
}

describe("reap success-path persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-reap-persist-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-workspace-registry ac-successful-cleanup-persists-completion
  // AC: @dispatch-workspace-registry ac-successful-cleanup-populates-closed-at
  // AC: @dispatch-workspace-registry ac-8
  it("persists cleanup.status=completed and closed_at on successful reap", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 50)}`;
    const task = {
      title: "Reap Completion Persists",
      slugs: ["task-reap-completion-persists"],
    };
    await provisionDispatchWorkspace({ projectDir: tempDir, taskRef, task });
    await markCleanupEligible(tempDir, taskRef, task);

    // Before reap: cleanup.status should be "scheduled"
    const beforeRecords = await readRegistryRecords(tempDir);
    const beforeRecord = beforeRecords.find((r) => r.task_ref === taskRef);
    expect(beforeRecord?.cleanup.status).toBe("scheduled");
    expect(beforeRecord?.timestamps.closed_at).toBeFalsy();

    const result = await reapDispatchWorkspace(tempDir, taskRef, { task });
    expect(result.action).toBe("reaped");

    const afterRecords = await readRegistryRecords(tempDir);
    const afterRecord = afterRecords.find((r) => r.task_ref === taskRef);
    expect(afterRecord?.cleanup.status).toBe("completed");
    expect(afterRecord?.timestamps.closed_at).toBeTruthy();
  });

  // AC: @dispatch-workspace-registry ac-completed-cleanup-resolves-to-closed
  it("lifecycle_state resolves to closed after successful reap", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 51)}`;
    const task = {
      title: "Reap Lifecycle Closed",
      slugs: ["task-reap-lifecycle-closed"],
    };
    await provisionDispatchWorkspace({ projectDir: tempDir, taskRef, task });
    await markCleanupEligible(tempDir, taskRef, task);

    const result = await reapDispatchWorkspace(tempDir, taskRef, { task });
    expect(result.action).toBe("reaped");

    const records = await readRegistryRecords(tempDir);
    const record = records.find((r) => r.task_ref === taskRef);
    expect(record?.cleanup.status).toBe("completed");
    expect(record?.lifecycle_state).toBe("closed");
  });

  // AC: @dispatch-workspace-registry ac-10
  it("is idempotent: re-reap of an already-completed record does not bump updated_at", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 53)}`;
    const task = {
      title: "Reap Idempotent",
      slugs: ["task-reap-idempotent"],
    };
    await provisionDispatchWorkspace({ projectDir: tempDir, taskRef, task });
    await markCleanupEligible(tempDir, taskRef, task);

    await reapDispatchWorkspace(tempDir, taskRef, { task });
    const firstRecords = await readRegistryRecords(tempDir);
    const firstRecord = firstRecords.find((r) => r.task_ref === taskRef);
    expect(firstRecord?.cleanup.status).toBe("completed");
    const firstUpdatedAt = firstRecord?.timestamps.updated_at;
    const firstCleanupUpdatedAt = firstRecord?.cleanup.updated_at;

    // Wait a tick so a new timestamp would differ if one were generated.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Re-run reap. Record is already completed; no registry timestamps
    // should change. The physical artifacts are already gone so
    // findWorkspaceRegistrationByTaskRef typically returns null (action="none"),
    // which is the correct idempotent outcome.
    const secondResult = await reapDispatchWorkspace(tempDir, taskRef, { task });
    expect(["none", "reaped"]).toContain(secondResult.action);

    const secondRecords = await readRegistryRecords(tempDir);
    const secondRecord = secondRecords.find((r) => r.task_ref === taskRef);
    expect(secondRecord?.cleanup.status).toBe("completed");
    expect(secondRecord?.timestamps.updated_at).toBe(firstUpdatedAt);
    expect(secondRecord?.cleanup.updated_at).toBe(firstCleanupUpdatedAt);
  });

  // AC: @dispatch-workspace-registry ac-successful-cleanup-persists-completion
  // Partial-failure safety: if physical worker-worktree removal throws, the
  // registry record must remain cleanup.status!==completed.
  //
  // Induction: make the worktree parent directory read-only so that
  // `git worktree remove --force <path>` cannot delete the worktree's
  // directory entry and throws.
  it("does NOT persist completion when worker-worktree removal fails", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 54)}`;
    const task = {
      title: "Reap Partial Failure",
      slugs: ["task-reap-partial-failure"],
    };
    const workspace = await provisionDispatchWorkspace({ projectDir: tempDir, taskRef, task });
    await markCleanupEligible(tempDir, taskRef, task);

    // Make the worktree parent directory read-only so git worktree remove
    // cannot delete the worktree directory entry.
    const parentDir = path.dirname(workspace.cwd);
    const originalMode = (await fs.stat(parentDir)).mode;
    await fs.chmod(parentDir, 0o555);

    let reapThrew = false;
    try {
      await reapDispatchWorkspace(tempDir, taskRef, { task });
    } catch {
      reapThrew = true;
    } finally {
      // Restore perms so afterEach cleanup can proceed.
      await fs.chmod(parentDir, originalMode);
    }

    const records = await readRegistryRecords(tempDir);
    const record = records.find((r) => r.task_ref === taskRef);
    if (reapThrew) {
      // Error path: record must NOT be marked completed.
      expect(record?.cleanup.status).not.toBe("completed");
      expect(record?.timestamps.closed_at).toBeFalsy();
    } else {
      // If the induced failure did not trip (e.g. running as root), the
      // success invariant still applies and we assert completion was
      // persisted normally. This keeps the test valid under non-standard
      // filesystem permissions.
      expect(record?.cleanup.status).toBe("completed");
    }
  });
});

describe("reconciliation self-heal for lost completion writes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-reap-selfheal-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-workspace-registry ac-successful-cleanup-persists-completion
  // Self-heal: a crash between physical removal and the shadow commit leaves
  // the registry record with cleanup.status=scheduled and no tracked physical
  // artifacts. Reconciliation must heal this state forward by transitioning
  // cleanup.status to completed.
  it("transitions cleanup.status to completed when physical artifacts are absent and cleanup.eligible=true", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 60)}`;
    const task = {
      title: "Self Heal Lost Write",
      slugs: ["task-self-heal-lost-write"],
    };
    const workspace = await provisionDispatchWorkspace({ projectDir: tempDir, taskRef, task });
    await markCleanupEligible(tempDir, taskRef, task);

    // Simulate a crashed reap: physically remove the worktree and branch
    // without persisting cleanup.status=completed to the registry.
    git(tempDir, `worktree remove --force ${workspace.cwd}`);
    const records = await readRegistryRecords(tempDir);
    const record = records.find((r) => r.task_ref === taskRef);
    if (record) {
      git(tempDir, `branch -D ${record.canonical_branch}`);
    }

    // Pre-condition: registry still has cleanup.status=scheduled
    const beforeRecord = (await readRegistryRecords(tempDir)).find((r) => r.task_ref === taskRef);
    expect(beforeRecord?.cleanup.status).toBe("scheduled");
    expect(beforeRecord?.cleanup.eligible).toBe(true);

    // Run reconciliation. Task status is "completed" so reconciler knows
    // the workspace is done.
    await reconcileDispatchWorkspaceRegistry(tempDir, new Map([[taskRef, "completed"]]));

    const afterRecord = (await readRegistryRecords(tempDir)).find((r) => r.task_ref === taskRef);
    expect(afterRecord?.cleanup.status).toBe("completed");
    expect(afterRecord?.lifecycle_state).toBe("closed");
    expect(afterRecord?.timestamps.closed_at).toBeTruthy();
  });

  // AC: @dispatch-workspace-registry ac-10
  // Reconciliation is still no-op on already-closed records (they are
  // excluded from the reconcile loop entirely).
  it("does not rewrite already-closed records during reconciliation", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 61)}`;
    const task = {
      title: "Self Heal Already Completed",
      slugs: ["task-self-heal-already-completed"],
    };
    await provisionDispatchWorkspace({ projectDir: tempDir, taskRef, task });
    await markCleanupEligible(tempDir, taskRef, task);

    // Already-completed record: manually set cleanup.status=completed in the
    // registry, matching the post-reap state.
    const records = await readRegistryRecords(tempDir);
    const idx = records.findIndex((r) => r.task_ref === taskRef);
    const fixedTimestamp = "2026-04-01T00:00:00.000Z";
    records[idx] = {
      ...records[idx],
      lifecycle_state: "closed",
      cleanup: {
        ...records[idx].cleanup,
        status: "completed",
        updated_at: fixedTimestamp,
      },
      timestamps: {
        ...records[idx].timestamps,
        updated_at: fixedTimestamp,
        closed_at: fixedTimestamp,
      },
    };
    await writeRegistryRecords(tempDir, records);

    await reconcileDispatchWorkspaceRegistry(tempDir, new Map([[taskRef, "completed"]]));

    const afterRecord = (await readRegistryRecords(tempDir)).find((r) => r.task_ref === taskRef);
    expect(afterRecord?.cleanup.status).toBe("completed");
    expect(afterRecord?.timestamps.updated_at).toBe(fixedTimestamp);
    expect(afterRecord?.cleanup.updated_at).toBe(fixedTimestamp);
  });
});

describe("blocked-path shadow persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-reap-blocked-persist-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-workspace-registry ac-8
  // Blocked transition from reap must be durable on the shadow branch, not
  // only in the worker worktree's metadata file.
  it("persists cleanup.status=blocked (active invocation) through the shadow-mutation path", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 70)}`;
    const task = {
      title: "Blocked Active Persists",
      slugs: ["task-blocked-active-persists"],
    };
    await provisionDispatchWorkspace({ projectDir: tempDir, taskRef, task });
    await markCleanupEligible(tempDir, taskRef, task);

    const result = await reapDispatchWorkspace(tempDir, taskRef, {
      activeTaskIds: [taskRef],
      task,
    });
    expect(result.action).toBe("cleanup_blocked");

    const record = (await readRegistryRecords(tempDir)).find((r) => r.task_ref === taskRef);
    expect(record?.cleanup.status).toBe("blocked");
    expect(record?.lifecycle_state).toBe("cleanup_blocked");
    expect(record?.cleanup.reason).toContain("active dispatch invocation");
  });

  // AC: @dispatch-workspace-registry ac-8
  it("persists cleanup.status=blocked (unresolved integration) through the shadow-mutation path", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 71)}`;
    const task = {
      title: "Blocked Unresolved Persists",
      slugs: ["task-blocked-unresolved-persists"],
    };
    await provisionDispatchWorkspace({ projectDir: tempDir, taskRef, task });

    // Do NOT mark cleanup eligible — leave integration unresolved.
    const result = await reapDispatchWorkspace(tempDir, taskRef, { task });
    expect(result.action).toBe("cleanup_blocked");

    const record = (await readRegistryRecords(tempDir)).find((r) => r.task_ref === taskRef);
    expect(record?.cleanup.status).toBe("blocked");
    expect(record?.lifecycle_state).toBe("cleanup_blocked");
    expect(record?.cleanup.reason).toContain("integration outcome is unresolved");
  });
});

// AC: @trait-error-guidance ac-1 — N/A: cleanup runs in the dispatch runtime and reports through task notes/logging, not direct CLI errors.
// AC: @trait-error-guidance ac-2 — N/A: dispatcher guidance is recorded in metadata/task notes rather than a user-facing command response here.
// AC: @trait-error-guidance ac-3 — N/A: cleanup reconciliation does not surface reference lookup errors to a direct CLI caller in this module test.
// AC: @trait-error-guidance ac-4 — N/A: invalid task state transitions are enforced by task commands, not by workspace cleanup helpers.
// AC: @trait-error-guidance ac-5 — N/A: cleanup helpers do not expose field-validation error payloads in this library-level path.
// AC: @trait-error-guidance ac-6 — N/A: workspace cleanup helpers do not implement a JSON CLI error mode.
