import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import * as workspaceModule from "../src/agent-runtime/workspace.js";
import * as bootstrapModule from "../src/agent-runtime/bootstrap.js";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import {
  provisionDispatchWorkspace,
  buildDispatchArtifactProtectionState,
  type DispatchWorkspaceMetadata,
} from "../src/agent-runtime/workspace.js";
import type { InvocationEvent } from "../src/agent-runtime/dispatch.js";
import type { DispatchWorkspaceRecord } from "../src/schema/index.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
  seedSplitTask,
  testUlid,
} from "./helpers/cli.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";

ensureSplitBackendRegistered();

const MOCK_KSPEC_CLI = path.join(__dirname, "mocks", "kspec-capture-mock.cjs");

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

async function seedRepo(dir: string): Promise<void> {
  initGitRepo(dir);
  await fs.writeFile(path.join(dir, "README.md"), "seed\n", "utf-8");
  git(dir, "add README.md");
  git(dir, 'commit -m "init"');
}

/** Write a split-format project manifest plus a single resolvable task. */
async function setupProjectWithTask(
  dir: string,
  taskUlid: string,
  slug: string,
  status = "pending",
): Promise<void> {
  await fs.writeFile(
    path.join(dir, "kynetic.yaml"),
    'kynetic: "1.1"\ntask_storage:\n  format: split\ntitle: Test Project\n',
    "utf-8",
  );
  seedSplitTask(dir, {
    _ulid: taskUlid,
    slugs: [slug],
    type: "task",
    title: `Task ${slug}`,
    status,
    automation: "eligible",
    tags: [],
    priority: 1,
    depends_on: [],
    blocked_by: [],
    notes: [],
    todos: [],
    created_at: new Date().toISOString(),
  });
}

async function readRegistry(dir: string): Promise<DispatchWorkspaceRecord[]> {
  const registryPath = path.join(dir, "project.dispatch-workspaces.yaml");
  try {
    const raw = YAML.parse(await readTestOutput(registryPath)) as {
      workspaces?: DispatchWorkspaceRecord[];
    };
    return raw.workspaces ?? [];
  } catch {
    return [];
  }
}

// ─── Workspace lineage + registry identity ───────────────────────────────────

describe(
  "dispatch canonical task identity: workspace lineage and registry",
  { timeout: 60_000 },
  () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await createTempDir("kspec-canonical-identity-ws-");
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanupTempDir(tempDir);
    });

    // AC: @dispatch-canonical-task-identity ac-workspace-lineage-stable-across-aliases
    // AC: @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
    it("reuses one workspace lineage across slug, full-ULID, and unique-prefix aliases of the same task", async () => {
      await seedRepo(tempDir);
      git(tempDir, "checkout -b agent-dev");
      const taskUlid = testUlid("WSLI", 1);
      await setupProjectWithTask(tempDir, taskUlid, "task-lineage-stable");

      const slugWs = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef: "@task-lineage-stable",
        task: { title: "Lineage", slugs: ["task-lineage-stable"] },
      });

      // Re-provision under the full ULID alias.
      const ulidWs = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef: `@${taskUlid}`,
      });

      // Re-provision under a unique ULID prefix alias.
      const prefixWs = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef: `@${taskUlid.slice(0, 12)}`,
      });

      // All three aliases resolve to the same workspace lineage.
      expect(ulidWs.metadata.workspaceId).toBe(slugWs.metadata.workspaceId);
      expect(prefixWs.metadata.workspaceId).toBe(slugWs.metadata.workspaceId);
      expect(ulidWs.metadata.canonicalBranch).toBe(slugWs.metadata.canonicalBranch);
      expect(prefixWs.metadata.canonicalBranch).toBe(slugWs.metadata.canonicalBranch);
      expect(ulidWs.metadata.workerWorktreeDir).toBe(slugWs.metadata.workerWorktreeDir);

      // The canonical branch short id is derived from the ULID, not the alias.
      expect(slugWs.metadata.canonicalBranch).toBe(
        `dispatch/task/task-lineage-stable/${taskUlid.slice(0, 8).toLowerCase()}`,
      );

      // Exactly one registry record exists, keyed by canonical task id.
      const records = await readRegistry(tempDir);
      const open = records.filter((r) => r.lifecycle_state !== "closed");
      expect(open).toHaveLength(1);
      expect(open[0].task_id).toBe(taskUlid);
    });

    // AC: @dispatch-canonical-task-identity ac-historical-workspace-records-normalize-or-stale
    it("reuses a historical workspace record that lacks task_id when its task_ref still resolves", async () => {
      await seedRepo(tempDir);
      git(tempDir, "checkout -b agent-dev");
      const taskUlid = testUlid("WSHI", 1);
      await setupProjectWithTask(tempDir, taskUlid, "task-historical-resolvable");

      // First provision under the slug, then strip task_id from the persisted
      // record to simulate a record written before canonical identity tracking.
      const first = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef: "@task-historical-resolvable",
        task: { title: "Hist", slugs: ["task-historical-resolvable"] },
      });
      const registryPath = path.join(tempDir, "project.dispatch-workspaces.yaml");
      const raw = YAML.parse(await readTestOutput(registryPath)) as {
        kynetic_dispatch_workspaces?: string;
        workspaces: Array<Record<string, unknown>>;
      };
      for (const ws of raw.workspaces) delete ws.task_id;
      await fs.writeFile(registryPath, YAML.stringify(raw), "utf-8");

      // Provisioning under the canonical ULID alias must reuse the historical
      // record (matched by resolving its task_ref), not fork a second workspace.
      const second = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef: `@${taskUlid}`,
      });
      expect(second.metadata.workspaceId).toBe(first.metadata.workspaceId);

      const open = (await readRegistry(tempDir)).filter((r) => r.lifecycle_state !== "closed");
      expect(open).toHaveLength(1);
      // The reused record is backfilled with canonical identity on the rewrite.
      expect(open[0].task_id).toBe(taskUlid);
    });

    // AC: @dispatch-canonical-task-identity ac-historical-workspace-records-normalize-or-stale
    it("does not let an unresolvable historical record block provisioning a resolvable task", async () => {
      await seedRepo(tempDir);
      git(tempDir, "checkout -b agent-dev");
      const taskUlid = testUlid("WSUN", 1);
      await setupProjectWithTask(tempDir, taskUlid, "task-resolvable-now");

      // Pre-seed a registry with an unresolvable historical record (its task_ref
      // resolves to no current task, and it carries no canonical task_id).
      const registryPath = path.join(tempDir, "project.dispatch-workspaces.yaml");
      const provisioned = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef: "@task-resolvable-now",
        task: { title: "Resolvable", slugs: ["task-resolvable-now"] },
      });
      expect(provisioned.metadata.workspaceId).toBeDefined();

      // Provisioning the resolvable task again under its ULID still reuses its own
      // record regardless of the unrelated unresolvable record's presence.
      const raw = YAML.parse(await readTestOutput(registryPath)) as {
        workspaces: Array<Record<string, unknown>>;
      };
      raw.workspaces.push({
        ...JSON.parse(JSON.stringify(raw.workspaces[0])),
        workspace_id: "dispatch-workspace-orphaned-history",
        task_id: undefined,
        task_ref: "@task-that-no-longer-exists",
        task_slug: "task-that-no-longer-exists",
      });
      await fs.writeFile(registryPath, YAML.stringify(raw), "utf-8");

      const again = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef: `@${taskUlid}`,
      });
      expect(again.metadata.workspaceId).toBe(provisioned.metadata.workspaceId);
      expect(again.metadata.taskId).toBe(taskUlid);
    });
  },
);

// ─── Cleanup protection by canonical identity (pure function) ─────────────────

describe("dispatch canonical task identity: cleanup protection", () => {
  const WORKTREE_ROOT = path.join("/tmp", "kspec-canonical-protection-root");

  function makeRecord(overrides: Partial<DispatchWorkspaceRecord>): DispatchWorkspaceRecord {
    const now = new Date().toISOString();
    return {
      workspace_id: "dispatch-workspace-x",
      task_id: testUlid("PROT", 1),
      task_ref: "@task-protected-slug",
      task_slug: "task-protected-slug",
      worktree_root: WORKTREE_ROOT,
      resolved_base_branch: "main",
      base_branch_point: "abc123",
      canonical_branch: "dispatch/task/task-protected-slug/prot0001",
      canonical_branch_head: "def456",
      branch_provenance: {
        ownership: "dispatcher-managed",
        source: "provisioned",
        remote_ref: null,
        adopted_from: null,
        adopted_at: null,
        rehydrated: null,
      },
      lifecycle_state: "closing",
      active_role: null,
      worktrees: {
        worker: {
          path: path.join(WORKTREE_ROOT, "task-protected-slug-prot0001"),
          branch_mode: "branch",
        },
        reviewer: null,
      },
      bootstrap: { status: "not_run", invalidationReasons: [], steps: [] } as never,
      integration: {
        status: "merged",
        target_branch: "main",
        target_commit: "abc123",
        publication_mode: "manual_merge",
        outcome: "merged",
        updated_at: now,
      },
      health: { status: "healthy", summary: "ok", issues: [], updated_at: now },
      cleanup: { status: "scheduled", eligible: true, updated_at: now },
      timestamps: { created_at: now, updated_at: now },
      ...overrides,
    } as DispatchWorkspaceRecord;
  }

  // AC: @dispatch-canonical-task-identity ac-cleanup-protection-uses-canonical-task
  it("protects a record whose display ref is a slug when the active set carries its canonical ULID", () => {
    const canonicalId = testUlid("PROT", 1);
    const record = makeRecord({ task_id: canonicalId, task_ref: "@task-protected-slug" });

    const state = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      // Active set is canonical ULIDs (bare), but the record's display ref is a slug.
      activeOrInFlightTaskRefs: [canonicalId],
      registry: { status: "loaded", records: [record] },
    });

    // Cleanup protection resolves both sides to canonical identity.
    expect(state.evaluateTaskRef("@task-protected-slug").preserve).toBe(true);
    expect(state.evaluateTaskRef(canonicalId).preserve).toBe(true);
    expect(state.evaluateClosingRecordForReap(record).preserve).toBe(true);
    expect(state.evaluateClosingRecordForReap(record).reason).toMatch(/active\/in-flight/);
  });

  // AC: @dispatch-canonical-task-identity ac-cleanup-protection-uses-canonical-task
  it("does not protect a slug-ref record when an unrelated canonical id is active", () => {
    const record = makeRecord({ task_id: testUlid("PROT", 1), task_ref: "@task-protected-slug" });
    const state = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      activeOrInFlightTaskRefs: [testUlid("OTHR", 1)],
      registry: { status: "loaded", records: [record] },
    });
    // Merged + closing + no active ownership ⇒ eligible for reap.
    expect(state.evaluateClosingRecordForReap(record).preserve).toBe(false);
  });
});

// ─── Scheduler alias dedupe + cross-agent exclusivity + session payloads ──────

describe("dispatch canonical task identity: scheduler", { timeout: 60_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-canonical-identity-sched-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  function fakeMetadata(): DispatchWorkspaceMetadata {
    const emptyRole = {
      status: "not_run" as const,
      configHash: null,
      canonicalBranchHead: null,
      lastRunAt: null,
      invalidationReasons: [] as string[],
      steps: [] as unknown[],
      failureMessage: null,
    };
    const bootstrap = {
      ...emptyRole,
      lastRole: null,
      roleStates: { worker: { ...emptyRole }, reviewer: { ...emptyRole } },
    };
    const now = new Date().toISOString();
    return {
      workspaceId: "mock-workspace",
      taskId: null,
      taskRef: "@mock",
      taskSlug: "mock",
      baseBranch: "main",
      baseBranchPoint: "abc123",
      mergeTargetBranch: "main",
      integrationTargetBranch: "main",
      integrationTargetCommit: "abc123",
      canonicalBranch: "dispatch/task/mock/abc12345",
      canonicalBranchHead: "abc123",
      branchProvenance: {
        ownership: "dispatcher-managed",
        source: "provisioned",
        remote_ref: null,
        adopted_from: null,
        adopted_at: null,
      },
      publicationMode: "manual_merge",
      integrationState: "pending",
      integrationOutcome: "pending",
      integrationUpdatedAt: now,
      worktreeRoot: testDir,
      workerWorktreeDir: testDir,
      reviewerWorktreeDir: null,
      lifecycleState: "ready",
      activeRole: null,
      bootstrapState: bootstrap,
      healthState: { status: "healthy", summary: "Healthy", issues: [], updated_at: now },
      cleanupState: {
        status: "not_scheduled",
        eligible: false,
        reason: null,
        detail: null,
        updated_at: now,
      },
      healthStatus: "healthy",
      healthReason: null,
      bootstrap,
      cleanupEligible: false,
      cleanupReason: null,
      cleanupScheduledAt: null,
      cleanupBlockedReason: null,
      createdAt: now,
      updatedAt: now,
      lastReconciledAt: null,
      lastActiveAt: null,
      closedAt: null,
    } as unknown as DispatchWorkspaceMetadata;
  }

  type SchedulerInternal = {
    inFlightTaskKeys: Set<string>;
    activeInvocationDetails: Map<string, Record<string, unknown>>;
    _hasActiveOrQueuedInvocation: (agentId: string, taskId: string) => boolean;
    _hasActiveInvocationForTask: (taskId: string) => boolean;
  };

  function makeActiveRecord(agentId: string, taskId: string, role: "worker" | "reviewer") {
    return {
      invocationId: testUlid("INVK"),
      sessionId: testUlid("SESS"),
      agentId,
      agentName: agentId,
      taskId,
      // Display ref is a slug — deliberately different from the canonical id.
      taskRef: "@task-recorded-under-slug",
      role,
      startedAtMs: Date.now(),
      resolvedAdapter: "mock-acp",
      runner: undefined,
    };
  }

  // AC: @dispatch-canonical-task-identity ac-scheduler-alias-dedupe
  it("treats slug, full-ULID, and unique-prefix aliases as one task for same-agent dedupe", async () => {
    const taskUlid = testUlid("SCHED", 1);
    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
      reconcileIntervalMs: 0,
    });
    const internal = engine as unknown as SchedulerInternal;

    // An active worker invocation is recorded under a SLUG display ref, but its
    // canonical identity is the ULID.
    internal.activeInvocationDetails.set(
      "inv-1",
      makeActiveRecord("task-worker", taskUlid, "worker"),
    );

    // A new candidate arriving under the canonical ULID alias is recognized as
    // already active — dedupe collapses the aliases to one canonical task.
    expect(internal._hasActiveOrQueuedInvocation("task-worker", taskUlid)).toBe(true);

    // An in-flight marker keyed by canonical id also collapses aliases.
    const otherUlid = testUlid("SCHED", 2);
    internal.inFlightTaskKeys.add(`task-worker:${otherUlid}`);
    expect(internal._hasActiveOrQueuedInvocation("task-worker", otherUlid)).toBe(true);

    // A genuinely different task is not considered active.
    expect(internal._hasActiveOrQueuedInvocation("task-worker", testUlid("SCHED", 3))).toBe(false);
  });

  // AC: @dispatch-canonical-task-identity ac-cross-agent-exclusivity-uses-canonical-task
  it("defers a reviewer candidate while a worker is active for the same canonical task under another alias", async () => {
    const taskUlid = testUlid("XAGT", 1);
    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
      reconcileIntervalMs: 0,
    });
    const internal = engine as unknown as SchedulerInternal;

    // Worker active under a slug alias.
    internal.activeInvocationDetails.set(
      "inv-worker",
      makeActiveRecord("task-worker", taskUlid, "worker"),
    );

    // Cross-agent exclusivity is evaluated by canonical task id: a reviewer
    // candidate for the same task (referenced by the ULID alias) must see the
    // task as already in-flight and defer.
    expect(internal._hasActiveInvocationForTask(taskUlid)).toBe(true);

    // After the worker completes, the task is no longer active.
    internal.activeInvocationDetails.clear();
    expect(internal._hasActiveInvocationForTask(taskUlid)).toBe(false);
  });

  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  it("emits invocation events with canonical task id separate from the display ref", async () => {
    const taskUlid = testUlid("SESS", 1);
    await seedRepo(testDir);
    const metadata = fakeMetadata();
    vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue({
      cwd: testDir,
      metadataPath: path.join(testDir, ".kspec-dispatch-workspace.json"),
      metadata,
    });
    vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({ metadata } as never);
    vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
      exists: true,
      healthy: true,
      reason: null,
      metadata: null,
    });
    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as never,
      outcome: "success",
      durationMs: 1,
    });

    const events: InvocationEvent[] = [];
    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
      reconcileIntervalMs: 0,
      onInvocationEvent: (event) => events.push(event),
    });
    (engine as unknown as { running: boolean }).running = true;

    const agent = {
      _ulid: "01AGNTWORKER0000000000000W",
      id: "task-worker",
      name: "Task Worker",
      capabilities: [],
      tools: [],
      conventions: [],
      dispatch: [{ on: "task.ready" }],
      skills: [],
      auto_approve: false,
      concurrency: { max_concurrent: 1 },
      adapter: "mock-acp",
    };
    // The change carries canonical taskId separately from a SLUG display ref.
    const entry = {
      agent,
      change: {
        taskId: taskUlid,
        taskRef: "@task-session-payload",
        fromStatus: "in_progress" as const,
        toStatus: "pending" as const,
        timestamp: Date.now(),
      },
      retryCount: 0,
      nextRetryAt: 0,
    };

    const spawned = await (
      engine as unknown as { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> }
    )._spawnInvocation(agent, entry);
    expect(spawned).toBe(true);
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalled());
    await vi.waitFor(() => expect(events.some((e) => e.type === "started")).toBe(true));

    const started = events.find((e) => e.type === "started");
    // Canonical full ULID is the identity field; the slug is display-only.
    expect(started?.task_id).toBe(taskUlid);
    expect(started?.task_ref).toBe("@task-session-payload");

    await engine.stop();
  });
});
