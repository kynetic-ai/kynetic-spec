import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import { initContext } from "../src/parser/index.js";
import {
  CLOSED_WORKSPACE_RETENTION_MS,
  getDispatchWorkspaceRegistryPath,
  loadDispatchWorkspaceRegistry,
  saveDispatchWorkspaceRecord,
  type LoadedDispatchWorkspaceRecord,
} from "../src/parser/dispatch-workspaces.js";
import { cleanupTempDir, createTempDir, testUlid } from "./helpers/cli.js";

function makeRecord(
  tempDir: string,
  registryPath: string,
  overrides: {
    workspaceId: string;
    taskRef: string;
    lifecycleState: string;
    closedAt?: string | null;
    updatedAt?: string;
  },
): LoadedDispatchWorkspaceRecord {
  const now = overrides.updatedAt ?? new Date().toISOString();
  return {
    workspace_id: overrides.workspaceId,
    task_ref: overrides.taskRef,
    task_slug: `task-${overrides.workspaceId}`,
    worktree_root: path.join(tempDir, ".kspec-worktrees"),
    resolved_base_branch: "main",
    base_branch_point: "abc123",
    canonical_branch: `dispatch/task/task-${overrides.workspaceId}/${overrides.workspaceId.slice(-8).toLowerCase()}`,
    canonical_branch_head: "abc123",
    lifecycle_state: overrides.lifecycleState,
    active_role: null,
    worktrees: {
      worker: {
        path: path.join(tempDir, ".kspec-worktrees", overrides.workspaceId),
        branch_mode: "branch" as const,
        branch_ref: `dispatch/task/task-${overrides.workspaceId}/branch`,
        head: "abc123",
        last_seen_at: now,
      },
      reviewer: null,
    },
    bootstrap: {
      status: "not_run" as const,
      detail: null,
      updated_at: now,
    },
    integration: {
      status: "pending" as const,
      target_branch: "main",
      target_commit: "abc123",
      publication_mode: "pull_request" as const,
      outcome: "pull_request" as const,
      detail: null,
      updated_at: now,
    },
    health: {
      status: "healthy" as const,
      summary: "healthy",
      issues: [],
      updated_at: now,
    },
    cleanup: {
      status: "not_scheduled" as const,
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
      closed_at: overrides.closedAt ?? null,
    },
    _sourceFile: registryPath,
  } as LoadedDispatchWorkspaceRecord;
}

async function setupShadowSpecDir(dir: string): Promise<string> {
  const specDir = path.join(dir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: "Dispatch Registry Purge Test"\n',
    "utf-8",
  );
  return specDir;
}

// AC: @trait-error-guidance ac-1 — N/A: purge logic is internal registry maintenance, not a user-facing CLI command
// AC: @trait-error-guidance ac-2 — N/A: purge logic is internal registry maintenance, not a user-facing CLI command
// AC: @trait-error-guidance ac-3 — N/A: purge logic does not involve ref lookups
// AC: @trait-error-guidance ac-4 — N/A: purge logic does not involve state transitions surfaced to users
// AC: @trait-error-guidance ac-5 — N/A: purge logic does not produce validation errors for users
// AC: @trait-error-guidance ac-6 — N/A: purge logic does not expose a JSON CLI mode

describe("dispatch workspace registry purge", () => {
  let tempDir: string;
  let specDir: string;
  let originalSpecDir: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-workspace-purge-");
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

  // AC: @dispatch-workspace-registry ac-9
  it("purges closed records older than the retention threshold during save", async () => {
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const taskRefOld = `@${testUlid("TASK", 50)}`;
    const taskRefNew = `@${testUlid("TASK", 51)}`;

    // Seed registry with an old closed record
    const oldClosedRecord = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-old-closed",
      taskRef: taskRefOld,
      lifecycleState: "closed",
      closedAt: eightDaysAgo,
      updatedAt: eightDaysAgo,
    });

    // Write the old record directly to seed the file
    const registryFile = {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [
        // Strip _sourceFile for YAML serialization
        (() => {
          const { _sourceFile, ...clean } = oldClosedRecord;
          return clean;
        })(),
      ],
    };
    await fs.writeFile(registryPath, YAML.stringify(registryFile), "utf-8");

    // Save a new active record — this triggers the purge
    const newRecord = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-new-active",
      taskRef: taskRefNew,
      lifecycleState: "ready",
    });
    await saveDispatchWorkspaceRecord(ctx, newRecord);

    // Verify: old closed record purged, new record persists
    const workspaces = await loadDispatchWorkspaceRegistry(ctx);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].workspace_id).toBe("ws-new-active");
  });

  // AC: @dispatch-workspace-registry ac-9
  it("retains closed records within the retention threshold", async () => {
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);

    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const taskRefRecent = `@${testUlid("TASK", 52)}`;
    const taskRefNew = `@${testUlid("TASK", 53)}`;

    // Seed registry with a recently closed record
    const recentClosedRecord = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-recent-closed",
      taskRef: taskRefRecent,
      lifecycleState: "closed",
      closedAt: oneDayAgo,
      updatedAt: oneDayAgo,
    });

    const registryFile = {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [
        (() => {
          const { _sourceFile, ...clean } = recentClosedRecord;
          return clean;
        })(),
      ],
    };
    await fs.writeFile(registryPath, YAML.stringify(registryFile), "utf-8");

    // Save a new record
    const newRecord = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-new-active",
      taskRef: taskRefNew,
      lifecycleState: "ready",
    });
    await saveDispatchWorkspaceRecord(ctx, newRecord);

    // Verify: recently closed record retained
    const workspaces = await loadDispatchWorkspaceRegistry(ctx);
    expect(workspaces).toHaveLength(2);
    const ids = workspaces.map((ws) => ws.workspace_id).toSorted();
    expect(ids).toEqual(["ws-new-active", "ws-recent-closed"]);
  });

  // AC: @dispatch-workspace-registry ac-9
  it("does not purge non-closed records regardless of age", async () => {
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const taskRefOld = `@${testUlid("TASK", 54)}`;
    const taskRefNew = `@${testUlid("TASK", 55)}`;

    // Seed with an old but non-closed (stale) record
    const oldStaleRecord = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-old-stale",
      taskRef: taskRefOld,
      lifecycleState: "stale",
      closedAt: null,
      updatedAt: tenDaysAgo,
    });

    const registryFile = {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [
        (() => {
          const { _sourceFile, ...clean } = oldStaleRecord;
          return clean;
        })(),
      ],
    };
    await fs.writeFile(registryPath, YAML.stringify(registryFile), "utf-8");

    // Save a new record
    const newRecord = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-new-active",
      taskRef: taskRefNew,
      lifecycleState: "ready",
    });
    await saveDispatchWorkspaceRecord(ctx, newRecord);

    // Verify: old stale record retained (not closed, so not purged)
    const workspaces = await loadDispatchWorkspaceRegistry(ctx);
    expect(workspaces).toHaveLength(2);
  });

  // AC: @dispatch-workspace-registry ac-9
  it("does not purge closed records with null closed_at", async () => {
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);

    const taskRefClosed = `@${testUlid("TASK", 56)}`;
    const taskRefNew = `@${testUlid("TASK", 57)}`;

    // A closed record with null closed_at (edge case — shouldn't normally happen)
    const closedNoTimestamp = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-closed-no-ts",
      taskRef: taskRefClosed,
      lifecycleState: "closed",
      closedAt: null,
    });

    const registryFile = {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [
        (() => {
          const { _sourceFile, ...clean } = closedNoTimestamp;
          return clean;
        })(),
      ],
    };
    await fs.writeFile(registryPath, YAML.stringify(registryFile), "utf-8");

    const newRecord = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-new-active",
      taskRef: taskRefNew,
      lifecycleState: "ready",
    });
    await saveDispatchWorkspaceRecord(ctx, newRecord);

    // Verify: closed record without closed_at is retained (can't determine age)
    const workspaces = await loadDispatchWorkspaceRegistry(ctx);
    expect(workspaces).toHaveLength(2);
  });

  // AC: @dispatch-workspace-registry ac-9
  it("purges multiple old closed records in a single save", async () => {
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const taskRef1 = `@${testUlid("TASK", 58)}`;
    const taskRef2 = `@${testUlid("TASK", 59)}`;
    const taskRefNew = `@${testUlid("TASK", 60)}`;

    const old1 = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-old-1",
      taskRef: taskRef1,
      lifecycleState: "closed",
      closedAt: tenDaysAgo,
      updatedAt: tenDaysAgo,
    });
    const old2 = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-old-2",
      taskRef: taskRef2,
      lifecycleState: "closed",
      closedAt: twentyDaysAgo,
      updatedAt: twentyDaysAgo,
    });

    const stripSource = (r: LoadedDispatchWorkspaceRecord) => {
      const { _sourceFile, ...clean } = r;
      return clean;
    };

    const registryFile = {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [stripSource(old1), stripSource(old2)],
    };
    await fs.writeFile(registryPath, YAML.stringify(registryFile), "utf-8");

    const newRecord = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-new-active",
      taskRef: taskRefNew,
      lifecycleState: "ready",
    });
    await saveDispatchWorkspaceRecord(ctx, newRecord);

    // Both old closed records purged, only new one remains
    const workspaces = await loadDispatchWorkspaceRegistry(ctx);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].workspace_id).toBe("ws-new-active");
  });

  // AC: @dispatch-workspace-registry ac-9
  it("supports custom retention threshold via options", async () => {
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const taskRefClosed = `@${testUlid("TASK", 61)}`;
    const taskRefNew = `@${testUlid("TASK", 62)}`;

    const closedRecord = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-closed-2d",
      taskRef: taskRefClosed,
      lifecycleState: "closed",
      closedAt: twoDaysAgo,
      updatedAt: twoDaysAgo,
    });

    const registryFile = {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [
        (() => {
          const { _sourceFile, ...clean } = closedRecord;
          return clean;
        })(),
      ],
    };
    await fs.writeFile(registryPath, YAML.stringify(registryFile), "utf-8");

    const newRecord = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-new-active",
      taskRef: taskRefNew,
      lifecycleState: "ready",
    });

    // With default 7-day retention, this 2-day-old record should be kept
    await saveDispatchWorkspaceRecord(ctx, newRecord);
    let workspaces = await loadDispatchWorkspaceRegistry(ctx);
    expect(workspaces).toHaveLength(2);

    // Now save again with a 1-day retention — the 2-day-old record should be purged
    const anotherNew = makeRecord(tempDir, registryPath, {
      workspaceId: "ws-new-active",
      taskRef: taskRefNew,
      lifecycleState: "ready",
    });
    await saveDispatchWorkspaceRecord(ctx, anotherNew, {
      retentionMs: 1 * 24 * 60 * 60 * 1000,
    });
    workspaces = await loadDispatchWorkspaceRegistry(ctx);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].workspace_id).toBe("ws-new-active");
  });

  it("exports a default retention constant of 7 days", () => {
    expect(CLOSED_WORKSPACE_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
