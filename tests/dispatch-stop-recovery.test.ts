import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  DispatchCleanupError,
  DispatchEngine,
  type DispatchControlLifecycleEvent,
  type DispatchLifecycleAuthorityStore,
  type DispatchStopRecoveryRuntime,
} from "../src/agent-runtime/dispatch.js";
import type {
  DispatchControl,
  DispatchControlMutation,
  DispatchControlPublication,
} from "../src/agent-runtime/dispatch-control-store.js";
import { createMissingDispatchControl } from "../src/schema/dispatch-control.js";
import {
  closeSession,
  createSession,
  getSession,
  updateSessionDispatchOwnership,
} from "../src/sessions/store.js";
import type { DispatchOwnership } from "../src/sessions/types.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  seedSplitTask,
  testUlid,
} from "./helpers/cli.js";

ensureSplitBackendRegistered();

class MemoryControlStore implements DispatchLifecycleAuthorityStore {
  private publication: DispatchControlPublication;
  private listener?: (publication: DispatchControlPublication) => void;
  writes = 0;

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

  async mutate(
    _operation: string,
    mutation: DispatchControlMutation,
  ): Promise<DispatchControlPublication> {
    const next = await mutation(structuredClone(this.publication.snapshot));
    if (next) {
      this.writes++;
      this.publication = {
        snapshot: next,
        token: { revision: next.revision, commit_oid: `memory-${next.revision}` },
      };
      this.listener?.(this.publication);
    }
    return this.publication;
  }
}

function stopRecoveryBarrier() {
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const blocked = new Promise<void>((resolve) => (release = resolve));
  return { entered, release, wait: async () => (enter(), blocked) };
}

export function procEvidenceFixture() {
  const evidence = new Map<number, { pid: number; pgid: number; processStartTicks: string }>();
  return {
    evidence,
    readProcess: async (pid: number) => evidence.get(pid) ?? null,
    listProcessGroup: async (pgid: number) =>
      [...evidence.values()].filter((entry) => entry.pgid === pgid),
  };
}

export function sessionCloseRecorder() {
  const closed: string[] = [];
  return {
    closed,
    close: async (_sessionsDir: string, sessionId: string) => {
      closed.push(sessionId);
      await closeSession(_sessionsDir, sessionId, "failed", "hard stop test");
    },
  };
}

function durableCleanupTarget(target: DispatchOwnership) {
  return {
    ...target,
    session_metadata_path: `.kspec-sessions/${target.session_id}/session.yaml`,
  };
}

const harnesses: Array<Awaited<ReturnType<typeof createStopRecoveryHarness>>> = [];

export async function createStopRecoveryHarness() {
  const projectDir = await createTempDir("dispatch-stop-recovery-");
  initGitRepo(projectDir);
  const taskA = testUlid("TASK", 1);
  const taskB = testUlid("TASK", 2);
  await fs.writeFile(
    path.join(projectDir, "kynetic.yaml"),
    YAML.stringify({ kynetic: "1.1", title: "Stop recovery", task_storage: { format: "split" } }),
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
  const store = new MemoryControlStore(initial);
  const proc = procEvidenceFixture();
  const sessions = sessionCloseRecorder();
  const signals: number[] = [];
  const callbackEvents: DispatchControlLifecycleEvent[] = [];
  const cleanupStatusAtCallback: Array<"pending" | "failed" | undefined> = [];
  let groupExits = true;
  const runtime: DispatchStopRecoveryRuntime = {
    ...proc,
    signalProcessGroup: async (pgid) => {
      signals.push(pgid);
    },
    waitForProcessGroupExit: async () => groupExits,
    closeSession: sessions.close,
  };
  const engine = new DispatchEngine({
    projectDir,
    specDir: projectDir,
    lifecycleStore: store,
    reconcileIntervalMs: 0,
    stopRecoveryRuntime: runtime,
    onDispatchControlEvent: (event) => {
      callbackEvents.push(event);
      cleanupStatusAtCallback.push(store.getPublication().snapshot.pending_cleanup.global?.status);
    },
  });
  const seedOwnership = async (
    sequence: number,
    taskId: string | null,
    overrides: Partial<DispatchOwnership> = {},
  ) => {
    const sessionId = testUlid("SESS", sequence);
    const pid = 40_000 + sequence;
    const ownership: DispatchOwnership = {
      invocation_id: testUlid("INVK", sequence),
      session_id: sessionId,
      task_id: taskId,
      agent_id: "worker",
      adapter: "mock-acp",
      owner_instance_id: testUlid("OWNR", 1),
      pid,
      pgid: pid,
      process_start_ticks: String(90_000 + sequence),
      process_identity_platform: "linux_proc_stat_v1",
      captured_at: new Date().toISOString(),
      group_members: [{ pid, process_start_ticks: String(90_000 + sequence) }],
      ...overrides,
    };
    proc.evidence.set(pid, {
      pid,
      pgid: ownership.pgid!,
      processStartTicks: ownership.process_start_ticks!,
    });
    await createSession(path.join(projectDir, ".kspec-sessions"), {
      id: sessionId,
      task_id: taskId ?? undefined,
      agent_type: "mock-acp",
      status: "active",
      dispatch_ownership: ownership,
    });
    return ownership;
  };
  const harness = {
    projectDir,
    taskA,
    taskB,
    store,
    engine,
    proc,
    sessions,
    signals,
    callbackEvents,
    cleanupStatusAtCallback,
    runtime,
    seedOwnership,
    retainActiveOwnership(ownership: DispatchOwnership) {
      const retained = engine as unknown as {
        activeInvocationOwnership: Map<string, DispatchOwnership>;
      };
      retained.activeInvocationOwnership.set(ownership.invocation_id, ownership);
    },
    setGroupExits(value: boolean) {
      groupExits = value;
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async ({ engine, projectDir }) => {
      await engine.stop().catch(() => undefined);
      await cleanupTempDir(projectDir);
    }),
  );
});

describe("verified dispatch hard-stop recovery", () => {
  // AC: @dispatch-lifecycle-control-authority ac-stop-cancels-active-work
  // AC: @dispatch-lifecycle-control-authority ac-stop-closes-active-sessions
  it("commits global stopped authority before verified cancellation and durable closure", async () => {
    const harness = await createStopRecoveryHarness();
    const a = await harness.seedOwnership(1, harness.taskA);
    const b = await harness.seedOwnership(2, harness.taskB);

    await expect(harness.engine.applyGlobalLifecycleAction("stop")).resolves.toMatchObject({
      outcome: "applied",
      authority: "stopped",
    });
    expect(harness.signals).toEqual([a.pgid, b.pgid]);
    expect(harness.sessions.closed).toEqual([a.session_id, b.session_id]);
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "stopped",
      cleanupState: { status: "idle", entries: [] },
    });
    expect(harness.engine.getLifecycleStatus().globalAuthority).toBe("stopped");
  });

  // AC: @dispatch-lifecycle-control-authority ac-task-stop-cancels-matching-work
  // AC: @dispatch-lifecycle-control-authority ac-task-stop-preserves-unrelated-invocations
  // AC: @dispatch-lifecycle-control-authority ac-task-stop-closes-matching-session
  // AC: @dispatch-lifecycle-control-authority ac-task-stop-preserves-unrelated-sessions
  it("stops task A without changing task B invocation, session, control, or cleanup", async () => {
    const harness = await createStopRecoveryHarness();
    const a = await harness.seedOwnership(1, harness.taskA);
    const b = await harness.seedOwnership(2, harness.taskB);

    await harness.engine.applyTaskLifecycleAction("stop", { taskRef: "@task-alpha" });
    expect(harness.signals).toEqual([a.pgid]);
    expect(harness.sessions.closed).toEqual([a.session_id]);
    expect(harness.proc.evidence.has(b.pid!)).toBe(true);
    expect(
      await getSession(path.join(harness.projectDir, ".kspec-sessions"), b.session_id),
    ).toMatchObject({
      status: "active",
    });
    expect(harness.store.getPublication().snapshot.tasks).toHaveProperty(harness.taskA);
    expect(harness.store.getPublication().snapshot.tasks).not.toHaveProperty(harness.taskB);
  });

  // AC: @dispatch-lifecycle-control-authority ac-recovery-requires-session-ownership
  // AC: @dispatch-lifecycle-control-authority ac-recovery-requires-process-birth
  // AC: @dispatch-lifecycle-control-authority ac-task-stop-failure-retains-stopped-authority
  // AC: @dispatch-lifecycle-control-authority ac-task-stop-failure-reports-pending-cleanup
  // AC: @dispatch-lifecycle-control-authority ac-task-stop-failure-reports-no-success
  // AC: @dispatch-lifecycle-control-authority ac-task-interrupted-stop-recovers-on-retry
  it("rejects mismatched birth evidence without signalling and retries the same stopped cleanup", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    harness.proc.evidence.set(target.pid!, {
      pid: target.pid!,
      pgid: target.pgid!,
      processStartTicks: "999999",
    });

    await expect(
      harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA }),
    ).rejects.toMatchObject<Partial<DispatchCleanupError>>({
      code: "cleanup_process_birth_mismatch",
    });
    expect(harness.signals).toEqual([]);
    expect(harness.store.getPublication().snapshot.tasks[harness.taskA]?.mode).toBe("stopped");
    expect(harness.engine.getLifecycleStatus().cleanupState).toMatchObject({
      status: "failed",
      entries: [{ status: "failed", error_code: "cleanup_process_birth_mismatch" }],
    });

    harness.proc.evidence.set(target.pid!, {
      pid: target.pid!,
      pgid: target.pgid!,
      processStartTicks: target.process_start_ticks!,
    });
    await expect(
      harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA }),
    ).resolves.toMatchObject({ outcome: "noop", mode: "stopped" });
    expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("idle");
  });

  // AC: @dispatch-lifecycle-control-authority ac-missing-leader-live-group-remains-pending
  // AC: @dispatch-lifecycle-control-authority ac-unverified-live-group-is-not-signalled
  // AC: @dispatch-lifecycle-control-authority ac-live-group-prevents-cleanup-completion
  it("keeps a live leaderless group failed and never signals an unproved member", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    harness.proc.evidence.delete(target.pid!);
    harness.proc.evidence.set(target.pid! + 1, {
      pid: target.pid! + 1,
      pgid: target.pgid!,
      processStartTicks: "12345",
    });

    await expect(harness.engine.applyGlobalLifecycleAction("stop")).rejects.toMatchObject({
      code: "cleanup_group_unverifiable",
    });
    expect(harness.signals).toEqual([]);
    expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("failed");
  });

  // AC: @dispatch-lifecycle-control-authority ac-recovery-requires-session-ownership
  it("re-reads the durable session tuple before retry and rejects a changed owner", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    harness.setGroupExits(false);
    await expect(
      harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA }),
    ).rejects.toMatchObject({ code: "cancellation_timeout" });
    const signalCount = harness.signals.length;
    await updateSessionDispatchOwnership(
      path.join(harness.projectDir, ".kspec-sessions"),
      target.session_id,
      { ...target, owner_instance_id: testUlid("OWNR", 2) },
    );

    await expect(
      harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA }),
    ).rejects.toMatchObject({ code: "cleanup_ownership_mismatch" });
    expect(harness.signals).toHaveLength(signalCount);
  });

  // AC: @dispatch-lifecycle-control-authority ac-unverified-live-group-is-not-signalled
  it("rejects unsupported process identity without signalling", async () => {
    const harness = await createStopRecoveryHarness();
    await harness.seedOwnership(1, harness.taskA, {
      process_identity_platform: "unverifiable",
      process_start_ticks: null,
      group_members: [],
    });
    await expect(harness.engine.applyGlobalLifecycleAction("stop")).rejects.toMatchObject({
      code: "cleanup_identity_unverifiable",
    });
    expect(harness.signals).toEqual([]);
  });

  // AC: @dispatch-lifecycle-control-authority ac-unverified-live-group-is-not-signalled
  it("rejects unreadable process-group member evidence without signalling", async () => {
    const harness = await createStopRecoveryHarness();
    await harness.seedOwnership(1, harness.taskA);
    harness.runtime.listProcessGroup = async () => {
      const error = new Error("injected /proc member read failure") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    };

    await expect(harness.engine.applyGlobalLifecycleAction("stop")).rejects.toMatchObject({
      code: "cleanup_identity_unverifiable",
    });
    expect(harness.signals).toEqual([]);
    expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("failed");
  });

  // AC: @dispatch-lifecycle-control-authority ac-stop-failure-retains-stopped-authority
  // AC: @dispatch-lifecycle-control-authority ac-stop-failure-reports-pending-cleanup
  // AC: @dispatch-lifecycle-control-authority ac-unverified-live-group-is-not-signalled
  it.each(["global", "task"] as const)(
    "commits stopped %s authority when a late member proof cannot be persisted",
    async (scope) => {
      const harness = await createStopRecoveryHarness();
      const target = await harness.seedOwnership(1, harness.taskA);
      harness.proc.evidence.set(target.pid! + 1, {
        pid: target.pid! + 1,
        pgid: target.pgid!,
        processStartTicks: "late-member",
      });
      const sessionDir = path.join(harness.projectDir, ".kspec-sessions", target.session_id);
      await fs.chmod(sessionDir, 0o500);
      try {
        const stopping =
          scope === "global"
            ? harness.engine.applyGlobalLifecycleAction("stop")
            : harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA });
        await expect(stopping).rejects.toMatchObject({ code: "cleanup_group_unverifiable" });
      } finally {
        await fs.chmod(sessionDir, 0o700);
      }

      expect(harness.signals).toEqual([]);
      expect(harness.engine.getLifecycleStatus()).toMatchObject({
        ...(scope === "global" ? { globalAuthority: "stopped" } : {}),
        cleanupState: {
          status: "failed",
          entries: [{ status: "failed", error_code: "cleanup_group_unverifiable" }],
        },
      });
      if (scope === "task") {
        expect(harness.store.getPublication().snapshot.tasks[harness.taskA]?.mode).toBe("stopped");
      }
    },
  );

  // AC: @dispatch-lifecycle-control-authority ac-stop-failure-reports-pending-cleanup
  // AC: @dispatch-lifecycle-control-authority ac-stop-failure-reports-no-success
  it("maps unreadable process-group exit evidence to the closed identity failure", async () => {
    const harness = await createStopRecoveryHarness();
    await harness.seedOwnership(1, harness.taskA);
    harness.runtime.waitForProcessGroupExit = async () => {
      const error = new Error("injected wait /proc read failure") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    };

    await expect(harness.engine.applyGlobalLifecycleAction("stop")).rejects.toMatchObject({
      code: "cleanup_identity_unverifiable",
    });
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "stopped",
      cleanupState: {
        status: "failed",
        entries: [{ status: "failed", error_code: "cleanup_identity_unverifiable" }],
      },
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-stop-closes-active-sessions
  // AC: @dispatch-lifecycle-control-authority ac-live-group-prevents-cleanup-completion
  it("completes leaderless empty-group recovery without signalling", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    harness.proc.evidence.delete(target.pid!);

    await expect(harness.engine.applyGlobalLifecycleAction("stop")).resolves.toMatchObject({
      outcome: "applied",
      authority: "stopped",
    });

    expect(harness.signals).toEqual([]);
    expect(harness.sessions.closed).toEqual([target.session_id]);
    expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("idle");
    await expect(
      getSession(path.join(harness.projectDir, ".kspec-sessions"), target.session_id),
    ).resolves.toMatchObject({
      dispatch_ownership: { exited_at: expect.any(String) },
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-missing-leader-live-group-remains-pending
  // AC: @dispatch-lifecycle-control-authority ac-live-group-prevents-cleanup-completion
  it("distinguishes a proved live leaderless group and leaves cleanup unfinished", async () => {
    const harness = await createStopRecoveryHarness();
    const childPid = 50_001;
    const target = await harness.seedOwnership(1, harness.taskA, {
      group_members: [
        { pid: 40_001, process_start_ticks: "90001" },
        { pid: childPid, process_start_ticks: "777" },
      ],
    });
    harness.proc.evidence.delete(target.pid!);
    harness.proc.evidence.set(childPid, {
      pid: childPid,
      pgid: target.pgid!,
      processStartTicks: "777",
    });
    await expect(harness.engine.applyGlobalLifecycleAction("stop")).rejects.toMatchObject({
      code: "cleanup_leader_missing_group_alive",
    });
    expect(harness.signals).toEqual([]);
    expect(harness.engine.getLifecycleStatus().cleanupState.entries).toHaveLength(1);
  });

  // AC: @dispatch-lifecycle-control-authority ac-stop-failure-reports-no-success
  it("retains signals_sent after session closure fails and resumes without re-signalling", async () => {
    const harness = await createStopRecoveryHarness();
    await harness.seedOwnership(1, harness.taskA);
    const close = harness.runtime.closeSession;
    harness.runtime.closeSession = async () => {
      throw new Error("fixture close failure");
    };
    await expect(harness.engine.applyGlobalLifecycleAction("stop")).rejects.toMatchObject({
      code: "session_closure_failed",
    });
    expect(harness.engine.getLifecycleStatus().cleanupState.entries[0]?.phase).toBe("signals_sent");
    const signalCount = harness.signals.length;
    harness.runtime.closeSession = close;
    await expect(harness.engine.applyGlobalLifecycleAction("stop")).resolves.toMatchObject({
      outcome: "noop",
    });
    expect(harness.signals).toHaveLength(signalCount);
  });

  // AC: @dispatch-lifecycle-control-authority ac-recovery-requires-session-ownership
  it("recovers owned cleanup after the live invocation records its exit", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    const current = harness.store.getPublication().snapshot;
    await harness.store.mutate("seed-owned-exit-race", () => ({
      ...current,
      revision: current.revision + 1,
      global: { authority: "stopped" },
      pending_cleanup: {
        global: {
          cleanup_id: testUlid("CLNP", 4),
          status: "pending",
          phase: "owned",
          targets: [
            {
              ...target,
              session_metadata_path: `.kspec-sessions/${target.session_id}/session.yaml`,
            },
          ],
        },
      },
    }));
    await updateSessionDispatchOwnership(
      path.join(harness.projectDir, ".kspec-sessions"),
      target.session_id,
      { ...target, exited_at: new Date().toISOString() },
    );

    await harness.engine.start();

    expect(harness.signals).toEqual([]);
    expect(harness.sessions.closed).toEqual([target.session_id]);
    expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("idle");
  });

  // AC: @dispatch-lifecycle-control-authority ac-failed-control-is-auditable
  // AC: @dispatch-lifecycle-control-authority ac-failure-events-use-closed-error-codes
  it("audits startup recovery failure once after failed cleanup is committed", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    const current = harness.store.getPublication().snapshot;
    await harness.store.mutate("seed-startup-recovery", () => ({
      ...current,
      revision: current.revision + 1,
      global: { authority: "stopped" },
      pending_cleanup: {
        global: {
          cleanup_id: testUlid("CLNP", 5),
          status: "pending",
          phase: "signals_sent",
          targets: [
            {
              ...target,
              session_metadata_path: `.kspec-sessions/${target.session_id}/session.yaml`,
            },
          ],
        },
      },
    }));
    harness.runtime.closeSession = async () => {
      throw new Error("injected startup session close failure");
    };

    await harness.engine.start();

    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "stopped",
      cleanupState: {
        status: "failed",
        entries: [{ error_code: "session_closure_failed" }],
      },
    });
    expect(harness.callbackEvents).toHaveLength(1);
    expect(harness.callbackEvents[0]).toMatchObject({
      type: "dispatch_control.failed",
      data: {
        scope: "global",
        action: "stop",
        outcome: "failed",
        source: "daemon_startup",
        error_code: "session_closure_failed",
      },
    });
    expect(harness.cleanupStatusAtCallback).toEqual(["failed"]);
  });

  // AC: @dispatch-lifecycle-control-authority ac-stop-cancels-active-work
  it("binds a late child proof before freezing and signalling stop cleanup", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    const childPid = target.pid! + 100;
    harness.proc.evidence.set(childPid, {
      pid: childPid,
      pgid: target.pgid!,
      processStartTicks: "123456",
    });

    await expect(harness.engine.applyGlobalLifecycleAction("stop")).resolves.toMatchObject({
      authority: "stopped",
    });

    expect(harness.signals).toEqual([target.pgid]);
    expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("idle");
  });

  it("freezes the latest durable late-child proof during retained completion cleanup", async () => {
    const harness = await createStopRecoveryHarness();
    const initial = await harness.seedOwnership(1, harness.taskA);
    harness.retainActiveOwnership(initial);
    const childPid = initial.pid! + 100;
    const durable = {
      ...initial,
      group_members: [...initial.group_members, { pid: childPid, process_start_ticks: "123456" }],
      exited_at: new Date().toISOString(),
    };
    harness.proc.evidence.clear();
    await updateSessionDispatchOwnership(
      path.join(harness.projectDir, ".kspec-sessions"),
      initial.session_id,
      durable,
    );
    await closeSession(
      path.join(harness.projectDir, ".kspec-sessions"),
      initial.session_id,
      "completed",
      "fixture completion window",
    );

    await expect(harness.engine.applyGlobalLifecycleAction("stop")).resolves.toMatchObject({
      outcome: "applied",
      authority: "stopped",
    });

    expect(harness.signals).toEqual([]);
    expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("idle");
  });

  it("preserves verified exit ownership when durable session closure overlaps publication", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    const sessionsDir = path.join(harness.projectDir, ".kspec-sessions");
    await fs.writeFile(
      path.join(sessionsDir, target.session_id, "events.jsonl"),
      `${JSON.stringify({ data: { rawInput: { command: "task complete" } } })}\n`.repeat(300_000),
    );

    const closing = closeSession(
      sessionsDir,
      target.session_id,
      "completed",
      "fixture concurrent completion",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const exitedAt = new Date().toISOString();
    await updateSessionDispatchOwnership(sessionsDir, target.session_id, {
      ...target,
      exited_at: exitedAt,
    });
    await closing;

    await expect(getSession(sessionsDir, target.session_id)).resolves.toMatchObject({
      status: "completed",
      dispatch_ownership: { exited_at: exitedAt },
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-live-group-prevents-cleanup-completion
  it("retains live ownership after session closure until process exit is recorded", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    harness.retainActiveOwnership(target);
    await closeSession(
      path.join(harness.projectDir, ".kspec-sessions"),
      target.session_id,
      "completed",
      "fixture runtime completion window",
    );

    await expect(harness.engine.applyGlobalLifecycleAction("stop")).resolves.toMatchObject({
      outcome: "applied",
      authority: "stopped",
    });

    expect(harness.signals).toEqual([target.pgid]);
    expect(harness.sessions.closed).toEqual([target.session_id]);
    expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("idle");
  });

  // AC: @dispatch-lifecycle-control-authority ac-task-stop-preserves-unrelated-invocations
  it("rejects durable task reassignment during member refresh without signalling", async () => {
    const harness = await createStopRecoveryHarness();
    const taskAOwner = await harness.seedOwnership(1, harness.taskA);
    const taskBOwner: DispatchOwnership = {
      ...taskAOwner,
      invocation_id: testUlid("INVK", 2),
      task_id: harness.taskB,
      pid: taskAOwner.pid! + 1,
      pgid: taskAOwner.pgid! + 1,
      process_start_ticks: "99002",
      group_members: [{ pid: taskAOwner.pid! + 1, process_start_ticks: "99002" }],
    };
    harness.proc.evidence.set(taskBOwner.pid!, {
      pid: taskBOwner.pid!,
      pgid: taskBOwner.pgid!,
      processStartTicks: taskBOwner.process_start_ticks!,
    });
    harness.proc.evidence.set(taskAOwner.pid! + 100, {
      pid: taskAOwner.pid! + 100,
      pgid: taskAOwner.pgid!,
      processStartTicks: "99100",
    });
    let reassigned = false;
    harness.runtime.listProcessGroup = async (pgid) => {
      if (!reassigned && pgid === taskAOwner.pgid) {
        reassigned = true;
        await updateSessionDispatchOwnership(
          path.join(harness.projectDir, ".kspec-sessions"),
          taskAOwner.session_id,
          taskBOwner,
        );
      }
      return [...harness.proc.evidence.values()].filter((entry) => entry.pgid === pgid);
    };

    await expect(
      harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA }),
    ).rejects.toMatchObject({ code: "cleanup_ownership_mismatch" });

    expect(harness.signals).toEqual([]);
    expect(harness.proc.evidence.has(taskBOwner.pid!)).toBe(true);
    expect(harness.engine.getLifecycleStatus().cleanupState).toMatchObject({
      status: "failed",
      entries: [{ task_id: harness.taskA, error_code: "cleanup_ownership_mismatch" }],
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-stop-failure-reports-pending-cleanup
  // AC: @dispatch-lifecycle-control-authority ac-stop-failure-reports-no-success
  it("materializes corrupt restart ownership as failed unsignalled cleanup", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    await fs.writeFile(
      path.join(harness.projectDir, ".kspec-sessions", target.session_id, "session.yaml"),
      "not: [valid",
    );

    await expect(harness.engine.applyGlobalLifecycleAction("stop")).rejects.toMatchObject({
      code: "cleanup_identity_unverifiable",
    });

    expect(harness.signals).toEqual([]);
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "stopped",
      cleanupState: {
        status: "failed",
        entries: [{ status: "failed", error_code: "cleanup_identity_unverifiable" }],
      },
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-task-stop-preserves-unrelated-invocations
  it("rejects a persisted task cleanup whose target belongs to another task", async () => {
    const harness = await createStopRecoveryHarness();
    const taskBTarget = await harness.seedOwnership(2, harness.taskB);
    const current = harness.store.getPublication().snapshot;
    await harness.store.mutate("seed-invalid-task-cleanup", () => ({
      ...current,
      revision: current.revision + 1,
      tasks: {
        [harness.taskA]: {
          mode: "stopped",
          reason: "fixture",
          actor: "test",
          source: "recovery",
          controlled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
      pending_cleanup: {
        [harness.taskA]: {
          cleanup_id: testUlid("CLNP", 8),
          status: "pending",
          phase: "owned",
          targets: [
            {
              ...taskBTarget,
              session_metadata_path: `.kspec-sessions/${taskBTarget.session_id}/session.yaml`,
            },
          ],
        },
      },
    }));

    await expect(harness.engine.start()).resolves.toBeUndefined();
    expect(harness.signals).toEqual([]);
    expect(harness.proc.evidence.has(taskBTarget.pid!)).toBe(true);
    expect(harness.engine.getLifecycleStatus().cleanupState).toMatchObject({
      status: "failed",
      entries: [{ task_id: harness.taskA, error_code: "cleanup_ownership_mismatch" }],
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-stop-failure-reports-no-success
  it("propagates verified hard-stop failure from graceful engine shutdown", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    harness.setGroupExits(false);
    await harness.engine.start();

    await expect(harness.engine.stop()).rejects.toMatchObject({ code: "cancellation_timeout" });

    expect(harness.signals).toEqual([target.pgid]);
    expect(harness.sessions.closed).toEqual([]);
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "stopped",
      cleanupState: { status: "failed" },
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-task-interrupted-stop-recovers-on-startup
  it.each(["owned", "signals_sent", "sessions_closed"] as const)(
    "resumes a task %s crash checkpoint on startup without reopening task authority",
    async (phase) => {
      const harness = await createStopRecoveryHarness();
      const target = await harness.seedOwnership(1, harness.taskA);
      const current = harness.store.getPublication().snapshot;
      const timestamp = new Date().toISOString();
      await harness.store.mutate("seed-crash", () => ({
        ...current,
        revision: current.revision + 1,
        global: { authority: "running" },
        tasks: {
          [harness.taskA]: {
            mode: "stopped",
            reason: "crash",
            actor: "test",
            source: "api",
            controlled_at: timestamp,
            updated_at: timestamp,
          },
        },
        pending_cleanup: {
          [harness.taskA]: {
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

      await harness.engine.start();
      expect(harness.store.getPublication().snapshot.global.authority).toBe("running");
      expect(harness.store.getPublication().snapshot.tasks[harness.taskA]?.mode).toBe("stopped");
      expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("idle");
      expect(harness.signals.length).toBe(phase === "owned" ? 1 : 0);
      expect(harness.sessions.closed.length).toBe(phase === "sessions_closed" ? 0 : 1);
    },
  );

  // AC: @dispatch-lifecycle-control-authority ac-interrupted-stop-recovers-on-startup
  it.each(["owned", "signals_sent", "sessions_closed"] as const)(
    "resumes a global %s crash checkpoint on startup without reopening global authority",
    async (phase) => {
      const harness = await createStopRecoveryHarness();
      const target = await harness.seedOwnership(1, harness.taskA);
      const current = harness.store.getPublication().snapshot;
      await harness.store.mutate("seed-global-crash", () => ({
        ...current,
        revision: current.revision + 1,
        global: { authority: "stopped" },
        pending_cleanup: {
          global: {
            cleanup_id: testUlid("CLNP", 2),
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

      await harness.engine.start();

      expect(harness.store.getPublication().snapshot.global.authority).toBe("stopped");
      expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("idle");
      expect(harness.signals.length).toBe(phase === "owned" ? 1 : 0);
      expect(harness.sessions.closed.length).toBe(phase === "sessions_closed" ? 0 : 1);
    },
  );

  // AC: @dispatch-lifecycle-control-authority ac-stop-failure-retains-stopped-authority
  // AC: @dispatch-lifecycle-control-authority ac-stop-failure-reports-pending-cleanup
  // AC: @dispatch-lifecycle-control-authority ac-stop-failure-reports-no-success
  // AC: @dispatch-lifecycle-control-authority ac-interrupted-stop-recovers-on-retry
  it("maps a live-group timeout to failure and later global retry completes", async () => {
    const harness = await createStopRecoveryHarness();
    await harness.seedOwnership(1, harness.taskA);
    harness.setGroupExits(false);
    await expect(harness.engine.applyGlobalLifecycleAction("stop")).rejects.toMatchObject({
      code: "cancellation_timeout",
    });
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "stopped",
      cleanupState: { status: "failed" },
    });
    harness.setGroupExits(true);
    await expect(harness.engine.applyGlobalLifecycleAction("stop")).resolves.toMatchObject({
      outcome: "noop",
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-interrupted-stop-recovers-on-retry
  // AC: @dispatch-lifecycle-control-authority ac-task-interrupted-stop-recovers-on-retry
  // AC: @dispatch-lifecycle-control-authority ac-task-stop-preserves-unrelated-invocations
  it.each(["global", "task"] as const)(
    "retries only the matching %s cleanup and preserves mixed aggregate evidence",
    async (scope) => {
      const harness = await createStopRecoveryHarness();
      const targetA = await harness.seedOwnership(1, harness.taskA);
      const targetB = await harness.seedOwnership(2, harness.taskB);
      const current = harness.store.getPublication().snapshot;
      const timestamp = new Date().toISOString();
      const stoppedTask = {
        mode: "stopped" as const,
        reason: "fixture",
        actor: "test",
        source: "recovery" as const,
        controlled_at: timestamp,
        updated_at: timestamp,
      };
      await harness.store.mutate("seed-mixed-cleanup", () => ({
        ...current,
        revision: current.revision + 1,
        global: { authority: "stopped" },
        tasks: {
          [harness.taskA]: stoppedTask,
          [harness.taskB]: stoppedTask,
        },
        pending_cleanup:
          scope === "global"
            ? {
                global: {
                  cleanup_id: testUlid("CLNP", 10),
                  status: "pending",
                  phase: "owned",
                  targets: [durableCleanupTarget(targetA)],
                },
                [harness.taskB]: {
                  cleanup_id: testUlid("CLNP", 11),
                  status: "failed",
                  error_code: "cancellation_timeout",
                  phase: "owned",
                  targets: [durableCleanupTarget(targetB)],
                },
              }
            : {
                global: {
                  cleanup_id: testUlid("CLNP", 12),
                  status: "pending",
                  phase: "owned",
                  targets: [durableCleanupTarget(targetB)],
                },
                [harness.taskA]: {
                  cleanup_id: testUlid("CLNP", 13),
                  status: "pending",
                  phase: "owned",
                  targets: [durableCleanupTarget(targetA)],
                },
                [harness.taskB]: {
                  cleanup_id: testUlid("CLNP", 14),
                  status: "failed",
                  error_code: "cancellation_timeout",
                  phase: "owned",
                  targets: [durableCleanupTarget(targetB)],
                },
              },
      }));

      if (scope === "global") {
        await harness.engine.applyGlobalLifecycleAction("stop");
      } else {
        await harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA });
      }

      expect(harness.signals).toEqual([targetA.pgid]);
      expect(harness.proc.evidence.has(targetB.pid!)).toBe(true);
      expect(
        await getSession(path.join(harness.projectDir, ".kspec-sessions"), targetB.session_id),
      ).toMatchObject({ status: "active", dispatch_ownership: targetB });
      expect(harness.engine.getLifecycleStatus().cleanupState).toMatchObject({
        status: "failed",
        entries: [
          ...(scope === "task" ? [{ scope: "global", status: "pending", phase: "owned" }] : []),
          {
            scope: "task",
            task_id: harness.taskB,
            status: "failed",
            phase: "owned",
            error_code: "cancellation_timeout",
          },
        ],
      });
      for (const entry of harness.engine.getLifecycleStatus().cleanupState.entries) {
        if (entry.status === "pending") expect(entry).not.toHaveProperty("error_code");
        else expect(entry.error_code).toBe("cancellation_timeout");
      }
    },
  );

  // AC: @dispatch-lifecycle-control-authority ac-task-stop-is-idempotent
  it("coalesces repeated task stop into one cleanup identity", async () => {
    const harness = await createStopRecoveryHarness();
    await harness.seedOwnership(1, harness.taskA);
    const barrier = stopRecoveryBarrier();
    harness.runtime.waitForProcessGroupExit = async () => {
      await barrier.wait();
      return true;
    };
    const first = harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA });
    await barrier.entered;
    const cleanupId = harness.engine.getLifecycleStatus().cleanupState.entries[0]?.cleanup_id;
    const second = harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA });
    expect(harness.engine.getLifecycleStatus().cleanupState.entries).toHaveLength(1);
    expect(harness.engine.getLifecycleStatus().cleanupState.entries[0]?.cleanup_id).toBe(cleanupId);
    barrier.release();
    await expect(first).resolves.toMatchObject({ outcome: "applied" });
    await expect(second).resolves.toMatchObject({ outcome: "noop" });
    expect(harness.signals).toHaveLength(1);
  });

  // AC: @dispatch-lifecycle-control-authority ac-task-stop-is-idempotent
  it("keeps a completed sequential task stop noop while ownership is retained", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    harness.retainActiveOwnership(target);

    await expect(
      harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA }),
    ).resolves.toMatchObject({ outcome: "applied" });
    const signalCount = harness.signals.length;
    await expect(
      harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA }),
    ).resolves.toMatchObject({ outcome: "noop" });
    expect(harness.signals).toHaveLength(signalCount);
    expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("idle");
  });

  // AC: @dispatch-lifecycle-control-authority ac-global-stop-is-idempotent
  it("coalesces repeated global stop into one cleanup identity", async () => {
    const harness = await createStopRecoveryHarness();
    await harness.seedOwnership(1, harness.taskA);
    const barrier = stopRecoveryBarrier();
    harness.runtime.waitForProcessGroupExit = async () => {
      await barrier.wait();
      return true;
    };
    const first = harness.engine.applyGlobalLifecycleAction("stop");
    await barrier.entered;
    const cleanupId = harness.engine.getLifecycleStatus().cleanupState.entries[0]?.cleanup_id;
    const second = harness.engine.applyGlobalLifecycleAction("stop");
    expect(harness.engine.getLifecycleStatus().cleanupState.entries).toHaveLength(1);
    expect(harness.engine.getLifecycleStatus().cleanupState.entries[0]?.cleanup_id).toBe(cleanupId);
    barrier.release();
    await expect(first).resolves.toMatchObject({ outcome: "applied" });
    await expect(second).resolves.toMatchObject({ outcome: "noop" });
    expect(harness.signals).toHaveLength(1);
  });

  // AC: @dispatch-lifecycle-control-authority ac-global-stop-is-idempotent
  it("keeps a completed sequential global stop noop while ownership is retained", async () => {
    const harness = await createStopRecoveryHarness();
    const target = await harness.seedOwnership(1, harness.taskA);
    harness.retainActiveOwnership(target);

    await expect(harness.engine.applyGlobalLifecycleAction("stop")).resolves.toMatchObject({
      outcome: "applied",
    });
    const signalCount = harness.signals.length;
    await expect(harness.engine.applyGlobalLifecycleAction("stop")).resolves.toMatchObject({
      outcome: "noop",
    });
    expect(harness.signals).toHaveLength(signalCount);
    expect(harness.engine.getLifecycleStatus().cleanupState.status).toBe("idle");
  });

  // AC: @dispatch-lifecycle-control-authority ac-spawn-win-stop-cancels-invocation
  it("cancels a spawn winner once its durable ownership handoff is active", async () => {
    const harness = await createStopRecoveryHarness();
    const winner = await harness.seedOwnership(1, harness.taskA);
    expect(
      await getSession(path.join(harness.projectDir, ".kspec-sessions"), winner.session_id),
    ).toMatchObject({ status: "active", dispatch_ownership: winner });

    await harness.engine.applyTaskLifecycleAction("stop", { taskId: harness.taskA });
    expect(harness.signals).toEqual([winner.pgid]);
    expect(harness.sessions.closed).toEqual([winner.session_id]);
  });
});
