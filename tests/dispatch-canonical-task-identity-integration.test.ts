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
  discoverWorkspaceForReviewOrFixCycle,
  getDispatchWorkspaceHealth,
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
import { initContext } from "../src/parser/index.js";
import { findDispatchWorkspaceByExactTaskRef } from "../src/parser/dispatch-workspaces.js";
import {
  AmbiguousWorkspaceTaskError,
  findDispatchWorkspaceByCanonicalTask,
} from "../src/agent-runtime/workspace-identity.js";

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

    // AC: @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
    // AC: @dispatch-canonical-task-identity ac-historical-workspace-records-normalize-or-stale
    it("reconciles task status and active role by canonical id for a slug-display record", async () => {
      await seedRepo(tempDir);
      git(tempDir, "checkout -b agent-dev");
      const taskUlid = testUlid("WSRC", 1);
      // Task is completed so reconciliation should resolve integration to merged.
      await setupProjectWithTask(tempDir, taskUlid, "task-reconcile-slug", "completed");

      // Provision under the SLUG alias: task_ref is the slug, task_id the ULID.
      await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef: "@task-reconcile-slug",
        task: { title: "Recon", slugs: ["task-reconcile-slug"] },
      });

      // The caller supplies canonical-keyed maps, exactly as DispatchEngine does:
      // task status keyed by `@<ULID>`, active role keyed by the bare ULID. A
      // record whose display ref is a slug only hits these via canonical
      // resolution — the bug looked them up by the raw slug task_ref and missed.
      const taskStatusByRef = new Map<string, "completed">([[`@${taskUlid}`, "completed"]]);
      const activeRoleByTaskId = new Map<string, "worker" | "reviewer">([[taskUlid, "reviewer"]]);
      await workspaceModule.reconcileDispatchWorkspaceRegistry(
        tempDir,
        taskStatusByRef,
        activeRoleByTaskId,
      );

      const rec = (await readRegistry(tempDir)).find((r) => r.task_id === taskUlid);
      expect(rec).toBeDefined();
      // Active role came from the canonical (bare-ULID) keyed map.
      expect(rec?.active_role).toBe("reviewer");
      // Completed task status (canonical `@<ULID>` keyed) drove integration to merged.
      expect(rec?.integration.status).toBe("merged");
    });

    // AC: @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
    it("rejects more than one non-closed alias record for the same canonical task", async () => {
      await seedRepo(tempDir);
      git(tempDir, "checkout -b agent-dev");
      const taskUlid = testUlid("WSDUP", 1);
      await setupProjectWithTask(tempDir, taskUlid, "task-dup-alias");

      const first = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef: "@task-dup-alias",
        task: { title: "Dup", slugs: ["task-dup-alias"] },
      });

      // Forge a SECOND non-closed record under a different display alias (full
      // ULID), simulating a historical record that predates canonical task_id
      // tracking. Strip task_id from both so they differ only by display alias —
      // the parser's task_id-keyed validator cannot collide them, so the
      // canonical-aware reuse path must reject the ambiguity.
      const registryPath = path.join(tempDir, "project.dispatch-workspaces.yaml");
      const raw = YAML.parse(await readTestOutput(registryPath)) as {
        workspaces: Array<Record<string, unknown>>;
      };
      const clone = JSON.parse(JSON.stringify(raw.workspaces[0])) as Record<string, unknown>;
      delete raw.workspaces[0].task_id;
      clone.workspace_id = "dispatch-workspace-dup-alias-2";
      delete clone.task_id;
      clone.task_ref = `@${taskUlid}`;
      raw.workspaces.push(clone);
      await fs.writeFile(registryPath, YAML.stringify(raw), "utf-8");

      // Provisioning under either alias must reject the ambiguous duplicate
      // rather than silently collapsing to the newest record.
      await expect(
        provisionDispatchWorkspace({ projectDir: tempDir, taskRef: `@${taskUlid}` }),
      ).rejects.toThrow(/Multiple non-closed dispatch workspace records resolve to canonical task/);

      // The original workspace id is unchanged — no fork happened.
      expect(first.metadata.taskId).toBe(taskUlid);
    });

    // AC: @dispatch-canonical-task-identity ac-workspace-lineage-stable-across-aliases
    it("recovers a metadata-backed worktree under a different alias when its display ref is stale", async () => {
      await seedRepo(tempDir);
      git(tempDir, "checkout -b agent-dev");
      const taskUlid = testUlid("WSMD", 1);
      await setupProjectWithTask(tempDir, taskUlid, "task-metadata-alias");

      // Provision under the SLUG alias: metadata persists taskId=<ULID> with the
      // display ref taskRef=@task-metadata-alias captured at provision time.
      const provisioned = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef: "@task-metadata-alias",
        task: { title: "Meta", slugs: ["task-metadata-alias"] },
      });

      // Drop the registry record but keep the worktree + metadata file so
      // discovery must fall through to the metadata-backed phase rather than
      // short-circuiting on registry state.
      const registryPath = path.join(tempDir, "project.dispatch-workspaces.yaml");
      await fs.writeFile(
        registryPath,
        YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
        "utf-8",
      );
      const healthBefore = await getDispatchWorkspaceHealth({
        projectDir: tempDir,
        taskRef: "@task-metadata-alias",
      });
      expect(healthBefore.exists).toBe(false);

      // Discover under a DIFFERENT alias (full ULID). The metadata file's display
      // ref (@task-metadata-alias) no longer equals the query ref (@<ULID>), so
      // pure display-ref matching would miss it; canonical-id matching recovers it.
      const result = await discoverWorkspaceForReviewOrFixCycle({
        projectDir: tempDir,
        taskRef: `@${taskUlid}`,
        role: "worker",
      });
      expect(result.recovered).toBe(true);
      expect(result.recoverySource).toBe("metadata-backed-worktree");

      // The reconstructed record carries canonical identity and the same
      // workspace lineage — the stale display ref did not fork the workspace.
      const open = (await readRegistry(tempDir)).filter((r) => r.lifecycle_state !== "closed");
      expect(open).toHaveLength(1);
      expect(open[0].task_id).toBe(taskUlid);
      expect(open[0].workspace_id).toBe(provisioned.metadata.workspaceId);
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
  it("emits started, terminal, and session events with canonical task id separate from the display ref", async () => {
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
    // Capture the event-bus payloads for the terminal invocation and session
    // lifecycle events — the paths the reviewer flagged as uncovered.
    const busPayloads: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
    engine.eventBus.subscribe("invocation.*", (event) => {
      busPayloads.push({ event_type: event.event_type, payload: event.payload });
    });
    engine.eventBus.subscribe("session.*", (event) => {
      busPayloads.push({ event_type: event.event_type, payload: event.payload });
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
    await vi.waitFor(() => expect(events.some((e) => e.type === "completed")).toBe(true));

    const started = events.find((e) => e.type === "started");
    // Canonical full ULID is the identity field; the slug is display-only.
    expect(started?.task_id).toBe(taskUlid);
    expect(started?.task_ref).toBe("@task-session-payload");

    // Terminal onInvocationEvent keeps identity and display ref separate too.
    const completed = events.find((e) => e.type === "completed");
    expect(completed?.task_id).toBe(taskUlid);
    expect(completed?.task_ref).toBe("@task-session-payload");

    // Terminal event-bus payload must carry canonical task_id AND preserve the
    // display task_ref — the bug overwrote task_ref with the canonical ULID.
    await vi.waitFor(() =>
      expect(busPayloads.some((p) => p.event_type === "invocation.completed")).toBe(true),
    );
    const invCompleted = busPayloads.find((p) => p.event_type === "invocation.completed");
    expect(invCompleted?.payload.task_id).toBe(taskUlid);
    expect(invCompleted?.payload.task_ref).toBe("@task-session-payload");

    // Session terminal event-bus payload must carry canonical task_id separately
    // from the display task_ref — previously it set task_ref to the ULID and
    // omitted task_id entirely.
    await vi.waitFor(() =>
      expect(busPayloads.some((p) => p.event_type === "session.ended")).toBe(true),
    );
    const sessionEnded = busPayloads.find((p) => p.event_type === "session.ended");
    expect(sessionEnded?.payload.task_id).toBe(taskUlid);
    expect(sessionEnded?.payload.task_ref).toBe("@task-session-payload");

    await engine.stop();
  });
});

// ─── Canonical-safe workspace lookup + target-branch resolution ───────────────

describe("dispatch canonical task identity: workspace lookup APIs", { timeout: 60_000 }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-canonical-ws-lookup-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  /** Strip task_id from every persisted record to simulate a pre-canonical
   * historical record whose only task identity is its display task_ref. */
  async function stripTaskIdFromRegistry(dir: string): Promise<void> {
    const registryPath = path.join(dir, "project.dispatch-workspaces.yaml");
    const raw = YAML.parse(await readTestOutput(registryPath)) as {
      workspaces: Array<Record<string, unknown>>;
    };
    for (const ws of raw.workspaces) delete ws.task_id;
    await fs.writeFile(registryPath, YAML.stringify(raw), "utf-8");
  }

  // AC: @dispatch-canonical-task-identity ac-workspace-target-lookup-canonicalizes-historical-aliases
  // AC: @dispatch-workspace-registry ac-4
  it("loads the integration target branch by canonical ULID for a historical slug-only record", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    const taskUlid = testUlid("WTGT", 1);
    await setupProjectWithTask(tempDir, taskUlid, "task-old-slug");

    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef: "@task-old-slug",
      task: { title: "Old Slug", slugs: ["task-old-slug"] },
    });

    // The provisioned record carries the slug as its display ref. Capture its
    // target branch, then strip task_id so only the historical slug remains.
    const beforeRecords = await readRegistry(tempDir);
    const expectedTarget = beforeRecords[0].integration.target_branch;
    expect(expectedTarget).toBeTruthy();
    await stripTaskIdFromRegistry(tempDir);

    const ctx = await initContext(tempDir);

    // Exact raw-ref lookup by the canonical ULID alias MISSES the slug record —
    // this is exactly the alias-sensitive bug the canonical API must avoid.
    const exactMiss = await findDispatchWorkspaceByExactTaskRef(ctx, `@${taskUlid}`);
    expect(exactMiss).toBeUndefined();

    // Canonical lookup resolves the slug record by canonical identity and
    // returns its existing integration target branch.
    const canonical = await findDispatchWorkspaceByCanonicalTask(ctx, `@${taskUlid}`);
    expect(canonical).toBeDefined();
    expect(canonical?.integration.target_branch).toBe(expectedTarget);

    // The DispatchEngine's own target loader (the production cleanup/terminal
    // path) resolves the same target by canonical ULID — proving production
    // code uses canonical identity, not exact raw-ref matching.
    const engine = new DispatchEngine({
      projectDir: tempDir,
      specDir: tempDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
      reconcileIntervalMs: 0,
    });
    const loadTarget = (
      engine as unknown as {
        _loadWorkspaceTargetForTask: (
          taskId: string | undefined,
          taskRef?: string | undefined,
        ) => Promise<string | null>;
      }
    )._loadWorkspaceTargetForTask.bind(engine);
    expect(await loadTarget(taskUlid, `@${taskUlid}`)).toBe(expectedTarget);
  });

  // AC: @dispatch-canonical-task-identity ac-workspace-lineage-stable-across-aliases
  // AC: @dispatch-canonical-task-identity ac-workspace-lookup-apis-use-canonical-identity
  it("resolves the same non-closed record via full-ULID, slug, and unique-prefix aliases", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    const taskUlid = testUlid("WALI", 1);
    await setupProjectWithTask(tempDir, taskUlid, "task-alias-lookup");

    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef: "@task-alias-lookup",
      task: { title: "Alias Lookup", slugs: ["task-alias-lookup"] },
    });

    const ctx = await initContext(tempDir);
    const bySlug = await findDispatchWorkspaceByCanonicalTask(ctx, "@task-alias-lookup");
    const byUlid = await findDispatchWorkspaceByCanonicalTask(ctx, `@${taskUlid}`);
    const byPrefix = await findDispatchWorkspaceByCanonicalTask(ctx, `@${taskUlid.slice(0, 12)}`);

    expect(bySlug).toBeDefined();
    // All three aliases resolve to one workspace record — no forked identity.
    expect(byUlid?.workspace_id).toBe(bySlug?.workspace_id);
    expect(byPrefix?.workspace_id).toBe(bySlug?.workspace_id);
    expect(byUlid?.canonical_branch).toBe(bySlug?.canonical_branch);
    expect(byPrefix?.canonical_branch).toBe(bySlug?.canonical_branch);
    expect(byUlid?.worktrees.worker.path).toBe(bySlug?.worktrees.worker.path);
    expect(byUlid?.integration.target_branch).toBe(bySlug?.integration.target_branch);
  });

  // AC: @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
  // AC: @dispatch-workspace-registry ac-2
  it("rejects more than one non-closed record resolving to the same canonical task", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    const taskUlid = testUlid("WAMB", 1);
    await setupProjectWithTask(tempDir, taskUlid, "task-ambiguous-lookup");

    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef: "@task-ambiguous-lookup",
      task: { title: "Ambiguous", slugs: ["task-ambiguous-lookup"] },
    });

    // Forge a SECOND non-closed record under a different display alias (full
    // ULID) with task_id stripped from both, so they collide only by canonical
    // resolution — the parser's task_id-keyed validator cannot catch them.
    const registryPath = path.join(tempDir, "project.dispatch-workspaces.yaml");
    const raw = YAML.parse(await readTestOutput(registryPath)) as {
      workspaces: Array<Record<string, unknown>>;
    };
    const clone = JSON.parse(JSON.stringify(raw.workspaces[0])) as Record<string, unknown>;
    delete raw.workspaces[0].task_id;
    delete clone.task_id;
    clone.workspace_id = "dispatch-workspace-ambiguous-2";
    clone.task_ref = `@${taskUlid}`;
    raw.workspaces.push(clone);
    await fs.writeFile(registryPath, YAML.stringify(raw), "utf-8");

    const ctx = await initContext(tempDir);
    await expect(findDispatchWorkspaceByCanonicalTask(ctx, `@${taskUlid}`)).rejects.toThrow(
      AmbiguousWorkspaceTaskError,
    );
    await expect(
      findDispatchWorkspaceByCanonicalTask(ctx, "@task-ambiguous-lookup"),
    ).rejects.toThrow(/Multiple non-closed dispatch workspace records resolve to canonical task/);
  });

  // AC: @dispatch-canonical-task-identity ac-workspace-lookup-apis-use-canonical-identity
  it("falls back to raw task_ref equality only when neither query nor record resolves", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    // The only resolvable task is unrelated to the provisioned workspace.
    const otherUlid = testUlid("WRAW", 1);
    await setupProjectWithTask(tempDir, otherUlid, "task-unrelated");

    // Provision a workspace for a ref that resolves to NO current task, so the
    // record is unresolvable on the record side (no task_id, stale task_ref).
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef: "@task-ghost",
      task: { title: "Ghost", slugs: ["task-ghost"] },
    });

    const ctx = await initContext(tempDir);

    // Both query and record are unresolvable ⇒ exact raw-ref equality matches.
    const rawMatch = await findDispatchWorkspaceByCanonicalTask(ctx, "@task-ghost");
    expect(rawMatch).toBeDefined();
    expect(rawMatch?.task_ref).toBe("@task-ghost");

    // A resolvable query for a DIFFERENT task must NOT match the stale record
    // via raw fallback — canonical resolution rejects the mismatch.
    const noFalseMatch = await findDispatchWorkspaceByCanonicalTask(ctx, "@task-unrelated");
    expect(noFalseMatch).toBeUndefined();
  });
});
