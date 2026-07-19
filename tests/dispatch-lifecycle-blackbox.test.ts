import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  DispatchEngine,
  type DispatchLifecycleAuthorityStore,
  type DispatchStopRecoveryRuntime,
} from "../src/agent-runtime/dispatch.js";
import type {
  DispatchControl,
  DispatchControlMutation,
  DispatchControlPublication,
} from "../src/agent-runtime/dispatch-control-store.js";
import { buildDispatchArtifactProtectionState } from "../src/agent-runtime/workspace.js";
import type { DispatchWorkspaceRecord } from "../src/schema/dispatch-workspaces.js";
import { createMissingDispatchControl } from "../src/schema/dispatch-control.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import { closeSession, createSession, getSession } from "../src/sessions/store.js";
import type { DispatchOwnership } from "../src/sessions/types.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  seedSplitTask,
  testUlid,
} from "./helpers/cli.js";

ensureSplitBackendRegistered();

export function recoveryBarrier() {
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const blocked = new Promise<void>((resolve) => (release = resolve));
  return { entered, release, wait: async () => (enter(), blocked) };
}

class BlackBoxControlStore implements DispatchLifecycleAuthorityStore {
  private publication: DispatchControlPublication;
  private listener?: (publication: DispatchControlPublication) => void;
  private operationGate?: { operation: string; barrier: ReturnType<typeof recoveryBarrier> };

  constructor(snapshot: DispatchControl) {
    this.publication = { snapshot, token: { revision: snapshot.revision, commit_oid: "memory" } };
  }

  setPublicationListener(
    _key: string,
    listener: (publication: DispatchControlPublication) => void,
  ): void {
    this.listener = listener;
  }

  async loadCommitted(): Promise<DispatchControlPublication> {
    this.listener?.(this.publication);
    return this.publication;
  }

  getPublication(): DispatchControlPublication {
    return this.publication;
  }

  getDegradedReason(): string | null {
    return null;
  }

  gateOperation(operation: string, barrier: ReturnType<typeof recoveryBarrier>): void {
    this.operationGate = { operation, barrier };
  }

  async mutate(
    operation: string,
    mutation: DispatchControlMutation,
  ): Promise<DispatchControlPublication> {
    const gate = this.operationGate;
    if (gate?.operation === operation) {
      this.operationGate = undefined;
      await gate.barrier.wait();
    }
    const next = await mutation(structuredClone(this.publication.snapshot));
    if (next) {
      this.publication = {
        snapshot: next,
        token: { revision: next.revision, commit_oid: `memory-${next.revision}` },
      };
      this.listener?.(this.publication);
    }
    return this.publication;
  }
}

type ProcessEvidence = { pid: number; pgid: number; processStartTicks: string };
type BlackBoxHarness = Awaited<ReturnType<typeof createBlackBoxLifecycleHarness>>;
const harnesses: BlackBoxHarness[] = [];

export async function createBlackBoxLifecycleHarness() {
  const projectDir = await createTempDir("dispatch-lifecycle-blackbox-");
  initGitRepo(projectDir);
  const taskA = testUlid("TASK", 1);
  const taskB = testUlid("TASK", 2);
  await fs.writeFile(
    path.join(projectDir, "kynetic.yaml"),
    YAML.stringify({
      kynetic: "1.1",
      title: "Lifecycle black box",
      task_storage: { format: "split" },
    }),
  );
  for (const [id, slug] of [
    [taskA, "task-alpha"],
    [taskB, "task-beta"],
  ] as const) {
    seedSplitTask(projectDir, {
      _ulid: id,
      type: "task",
      title: slug,
      slugs: [slug],
      status: "completed",
      priority: 1,
      automation: "eligible",
      depends_on: [],
      blocked_by: [],
      tags: [],
      notes: [],
      created_at: new Date().toISOString(),
    });
  }
  const initial = createMissingDispatchControl();
  initial.revision = 1;
  initial.global = { authority: "running" };
  const store = new BlackBoxControlStore(initial);
  const processes = new Map<number, ProcessEvidence>();
  const signals: number[] = [];
  const closedSessions: string[] = [];
  const runtime: DispatchStopRecoveryRuntime = {
    readProcess: async (pid) => processes.get(pid) ?? null,
    listProcessGroup: async (pgid) =>
      [...processes.values()].filter((entry) => entry.pgid === pgid),
    signalProcessGroup: async (pgid) => signals.push(pgid),
    waitForProcessGroupExit: async () => true,
    closeSession: async (sessionsDir, sessionId) => {
      closedSessions.push(sessionId);
      await closeSession(sessionsDir, sessionId, "failed", "black-box hard stop");
    },
  };
  const engines: DispatchEngine[] = [];
  const restart = () => {
    const engine = new DispatchEngine({
      projectDir,
      specDir: projectDir,
      lifecycleStore: store,
      reconcileIntervalMs: 0,
      stopRecoveryRuntime: runtime,
    });
    engines.push(engine);
    return engine;
  };
  const engine = restart();
  const seedOwnership = async (sequence: number, taskId: string): Promise<DispatchOwnership> => {
    const sessionId = testUlid("SESS", sequence);
    const pid = 60_000 + sequence;
    const ownership: DispatchOwnership = {
      invocation_id: testUlid("INVK", sequence),
      session_id: sessionId,
      task_id: taskId,
      agent_id: "worker",
      adapter: "mock-acp",
      owner_instance_id: testUlid("OWNR", 1),
      pid,
      pgid: pid,
      process_start_ticks: String(80_000 + sequence),
      process_identity_platform: "linux_proc_stat_v1",
      captured_at: new Date().toISOString(),
      group_members: [{ pid, process_start_ticks: String(80_000 + sequence) }],
    };
    processes.set(pid, {
      pid,
      pgid: pid,
      processStartTicks: ownership.process_start_ticks!,
    });
    await createSession(path.join(projectDir, ".kspec-sessions"), {
      id: sessionId,
      task_id: taskId,
      agent_type: "mock-acp",
      status: "active",
      dispatch_ownership: ownership,
    });
    return ownership;
  };
  const seedCleanup = async (
    phase: "owned" | "signals_sent" | "sessions_closed",
    target: DispatchOwnership,
  ) => {
    const current = store.getPublication().snapshot;
    await store.mutate("black-box-crash-checkpoint", () => ({
      ...current,
      revision: current.revision + 1,
      global: { authority: "stopped" },
      pending_cleanup: {
        global: {
          cleanup_id: testUlid("CLNP", 1),
          status: "pending",
          phase,
          targets: [
            {
              ...target,
              session_metadata_path: `.kspec-sessions/${target.session_id}/session.yaml`,
            },
          ],
        },
      },
    }));
  };
  const harness = {
    projectDir,
    taskA,
    taskB,
    store,
    processes,
    signals,
    closedSessions,
    runtime,
    engines,
    engine,
    restart,
    seedOwnership,
    seedCleanup,
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async ({ engines, projectDir }) => {
      await Promise.all(engines.map((engine) => engine.stop().catch(() => undefined)));
      await cleanupTempDir(projectDir);
    }),
  );
});

function cleanupEntry(engine: DispatchEngine) {
  return engine.getLifecycleStatus().cleanupState.entries[0];
}

describe("dispatch lifecycle restart and race black box", () => {
  // AC: @dispatch-lifecycle-control-authority ac-spawn-win-stop-cancels-invocation
  // AC: @dispatch-lifecycle-control-authority ac-task-stop-cancels-matching-work
  // AC: @dispatch-lifecycle-control-authority ac-task-stop-closes-matching-session
  it("recovers a durable spawn winner through matching cancellation and session closure", async () => {
    const harness = await createBlackBoxLifecycleHarness();
    const winner = await harness.seedOwnership(1, harness.taskA);
    const barrier = recoveryBarrier();
    harness.runtime.waitForProcessGroupExit = async () => {
      await barrier.wait();
      return true;
    };

    const stopping = harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA });
    await barrier.entered;

    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "running",
      projection: "running",
      activeCount: 0,
      cleanupState: {
        status: "pending",
        entries: [
          {
            scope: "task",
            task_id: harness.taskA,
            status: "pending",
            phase: "owned",
          },
        ],
      },
    });
    expect(cleanupEntry(harness.engine)).not.toHaveProperty("error_code");
    expect(harness.signals).toEqual([winner.pgid]);

    barrier.release();
    await expect(stopping).resolves.toMatchObject({ outcome: "applied", mode: "stopped" });
    expect(harness.closedSessions).toEqual([winner.session_id]);
    expect(harness.engine.getLifecycleStatus().cleanupState).toEqual({
      status: "idle",
      entries: [],
    });
    await expect(
      getSession(path.join(harness.projectDir, ".kspec-sessions"), winner.session_id),
    ).resolves.toMatchObject({ status: "failed" });
  });

  // AC: @dispatch-lifecycle-control-authority ac-controls-survive-restart
  // AC: @dispatch-lifecycle-control-authority ac-interrupted-stop-recovers-on-startup
  it.each(["owned", "signals_sent", "sessions_closed"] as const)(
    "restarts from the %s crash checkpoint without reopening stopped authority",
    async (phase) => {
      const harness = await createBlackBoxLifecycleHarness();
      const target = await harness.seedOwnership(1, harness.taskA);
      await harness.seedCleanup(phase, target);
      const barrier = recoveryBarrier();
      if (phase === "owned") {
        harness.runtime.waitForProcessGroupExit = async () => {
          await barrier.wait();
          return true;
        };
      } else if (phase === "signals_sent") {
        const close = harness.runtime.closeSession;
        harness.runtime.closeSession = async (...args) => {
          await barrier.wait();
          await close(...args);
        };
      } else {
        harness.store.gateOperation("dispatch-cleanup-complete-global", barrier);
      }
      const restarted = harness.restart();

      const starting = restarted.start();
      await barrier.entered;
      expect(restarted.getLifecycleStatus()).toMatchObject({
        globalAuthority: "stopped",
        projection: "stopped",
        cleanupState: {
          status: "pending",
          entries: [{ scope: "global", status: "pending", phase }],
        },
      });
      expect(cleanupEntry(restarted)).not.toHaveProperty("error_code");

      barrier.release();
      await starting;
      expect(restarted.getLifecycleStatus()).toMatchObject({
        globalAuthority: "stopped",
        projection: "stopped",
        cleanupState: { status: "idle", entries: [] },
      });
      expect(harness.signals).toHaveLength(phase === "owned" ? 1 : 0);
      expect(harness.closedSessions).toHaveLength(phase === "sessions_closed" ? 0 : 1);
    },
  );

  // AC: @dispatch-lifecycle-control-authority ac-task-stop-preserves-unrelated-invocations
  // AC: @dispatch-lifecycle-control-authority ac-task-stop-preserves-unrelated-sessions
  // AC: @dispatch-lifecycle-control-authority ac-task-control-preserves-unrelated-task-control
  it("keeps task B invocation, session, control, and evidence unchanged while task A stops", async () => {
    const harness = await createBlackBoxLifecycleHarness();
    const taskA = await harness.seedOwnership(1, harness.taskA);
    const taskB = await harness.seedOwnership(2, harness.taskB);
    const barrier = recoveryBarrier();
    harness.runtime.waitForProcessGroupExit = async (pgid) => {
      if (pgid === taskA.pgid) await barrier.wait();
      return true;
    };

    const stopping = harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA });
    await barrier.entered;

    expect(harness.signals).toEqual([taskA.pgid]);
    expect(harness.processes.get(taskB.pid!)).toMatchObject({ pgid: taskB.pgid });
    await expect(
      getSession(path.join(harness.projectDir, ".kspec-sessions"), taskB.session_id),
    ).resolves.toMatchObject({ status: "active", dispatch_ownership: taskB });
    expect(harness.store.getPublication().snapshot.tasks).toHaveProperty(harness.taskA);
    expect(harness.store.getPublication().snapshot.tasks).not.toHaveProperty(harness.taskB);
    expect(harness.engine.getLifecycleStatus().cleanupState.entries).toEqual([
      expect.objectContaining({
        scope: "task",
        task_id: harness.taskA,
        status: "pending",
        phase: "owned",
      }),
    ]);

    barrier.release();
    await stopping;
    expect(harness.closedSessions).toEqual([taskA.session_id]);
    await expect(
      getSession(path.join(harness.projectDir, ".kspec-sessions"), taskB.session_id),
    ).resolves.toMatchObject({ status: "active", dispatch_ownership: taskB });
  });
});

function closingRecord(taskId: string, suffix: string): DispatchWorkspaceRecord {
  const taskSlug = `task-${suffix}`;
  const workerPath = `/tmp/kspec-lifecycle-blackbox/${taskSlug}`;
  return {
    workspace_id: `dispatch-workspace-${suffix}`,
    task_id: taskId,
    task_ref: `@${taskId}`,
    task_slug: taskSlug,
    worktree_root: "/tmp/kspec-lifecycle-blackbox",
    resolved_base_branch: "dev",
    base_branch_point: "0".repeat(40),
    canonical_branch: `dispatch/task/${taskSlug}/${suffix}`,
    canonical_branch_head: "1".repeat(40),
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
        path: workerPath,
        branch_mode: "branch",
        branch_ref: `dispatch/task/${taskSlug}/${suffix}`,
        head: "1".repeat(40),
        last_seen_at: "2026-07-15T00:00:00.000Z",
      },
      reviewer: {
        path: `${workerPath}-review`,
        branch_mode: "detached",
        branch_ref: null,
        head: "1".repeat(40),
        last_seen_at: "2026-07-15T00:00:00.000Z",
      },
    },
    bootstrap: {
      lastRole: null,
      roleStates: {
        worker: {
          status: "not_run",
          configHash: null,
          canonicalBranchHead: null,
          lastRunAt: null,
          invalidationReasons: [],
          steps: [],
          failureMessage: null,
        },
        reviewer: {
          status: "not_run",
          configHash: null,
          canonicalBranchHead: null,
          lastRunAt: null,
          invalidationReasons: [],
          steps: [],
          failureMessage: null,
        },
      },
    },
    integration: {
      status: "merged",
      target_branch: "dev",
      target_commit: "0".repeat(40),
      publication_mode: "manual_merge",
      outcome: "merged",
      detail: null,
      updated_at: "2026-07-15T00:00:00.000Z",
    },
    health: {
      status: "healthy",
      summary: "ok",
      issues: [],
      updated_at: "2026-07-15T00:00:00.000Z",
    },
    cleanup: {
      status: "scheduled",
      eligible: true,
      reason: "task completed",
      detail: null,
      updated_at: "2026-07-15T00:00:00.000Z",
    },
    timestamps: {
      created_at: "2026-07-15T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
      last_reconciled_at: null,
      last_active_at: null,
      closed_at: null,
    },
  };
}

type ProtectionState = ReturnType<typeof buildDispatchArtifactProtectionState>;

export function evidenceDeletionRecorder(protection: ProtectionState) {
  const attempts: Array<{ surface: string; identity: string; deleted: boolean }> = [];
  const attempt = (surface: string, identity: string, decision: { preserve: boolean }): void => {
    attempts.push({ surface, identity, deleted: !decision.preserve });
  };
  return {
    attempts,
    attemptTask: (taskRef: string) => attempt("task", taskRef, protection.evaluateTaskRef(taskRef)),
    attemptRecord: (record: DispatchWorkspaceRecord) =>
      attempt("registry", record.task_ref, protection.evaluateClosingRecordForReap(record)),
    attemptBranch: (branch: string) =>
      attempt("branch", branch, protection.evaluateDispatchBranch(branch)),
    attemptPath: (workspacePath: string) =>
      attempt("workspace", workspacePath, protection.evaluateWorkspacePath(workspacePath)),
  };
}

describe("dispatch lifecycle evidence deletion black box", () => {
  // AC: @dispatch-lifecycle-control-authority ac-session-evidence-survives-control
  // AC: @dispatch-lifecycle-control-authority ac-branch-evidence-survives-control
  // AC: @dispatch-lifecycle-control-authority ac-workspace-evidence-survives-control
  // AC: @dispatch-lifecycle-control-authority ac-worktree-evidence-survives-control
  // AC: @dispatch-lifecycle-control-authority ac-snapshot-evidence-survives-control
  // AC: @dispatch-lifecycle-control-authority ac-audit-evidence-survives-control
  it("rejects every destructive surface for controlled evidence while unrelated cleanup proceeds", () => {
    const active = closingRecord(testUlid("ACTV", 1), "active");
    const inFlight = closingRecord(testUlid("FLGT", 1), "in-flight");
    const held = closingRecord(testUlid("HELD", 1), "held");
    const pending = closingRecord(testUlid("PNDG", 1), "pending-cleanup");
    const unrelated = closingRecord(testUlid("TERM", 1), "terminal");
    const controlled = [active, inFlight, held, pending];
    const protection = buildDispatchArtifactProtectionState({
      worktreeRoot: "/tmp/kspec-lifecycle-blackbox",
      activeOrInFlightTaskRefs: [active.task_ref],
      finalGateInFlightTaskRefs: [inFlight.task_ref],
      pausedHeldTaskRefs: [held.task_ref],
      stoppedPendingCleanupTaskRefs: [pending.task_ref],
      registry: { status: "loaded", records: [...controlled, unrelated] },
    });
    const recorder = evidenceDeletionRecorder(protection);

    for (const record of controlled) {
      recorder.attemptTask(record.task_ref);
      recorder.attemptRecord(record);
      recorder.attemptBranch(record.canonical_branch);
      recorder.attemptPath(record.worktrees.worker.path);
      recorder.attemptPath(record.worktrees.reviewer!.path);
    }
    recorder.attemptRecord(unrelated);
    recorder.attemptBranch(unrelated.canonical_branch);
    recorder.attemptPath(unrelated.worktrees.worker.path);

    expect(
      recorder.attempts.filter((attempt) =>
        controlled.some(
          (record) =>
            attempt.identity.includes(record.task_id ?? record.task_slug) ||
            attempt.identity.includes(record.task_slug),
        ),
      ),
    ).not.toContainEqual(expect.objectContaining({ deleted: true }));
    expect(recorder.attempts).toContainEqual({
      surface: "registry",
      identity: unrelated.task_ref,
      deleted: true,
    });
  });
});
