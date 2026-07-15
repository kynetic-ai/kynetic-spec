import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as YAML from "yaml";
import {
  DispatchEngine,
  type DispatchLifecycleAuthorityStore,
} from "../src/agent-runtime/dispatch.js";
import {
  DispatchControlStore,
  projectDispatchCleanupState,
  type DispatchControlMutation,
  type DispatchControlPublication,
} from "../src/agent-runtime/dispatch-control-store.js";
import { withDispatchShadowTransaction } from "../src/agent-runtime/dispatch-shadow-transaction.js";
import { getDispatchShadowMutationLockPath } from "../src/agent-runtime/workspace.js";
import {
  replaceDispatchControlFile,
  serializeDispatchControl,
} from "../src/parser/dispatch-control.js";
import { acquireFileLock } from "../src/parser/file-lock.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import type { DispatchControl } from "../src/schema/dispatch-control.js";
import { createMissingDispatchControl } from "../src/schema/dispatch-control.js";
import * as bootstrapModule from "../src/agent-runtime/bootstrap.js";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import * as workspaceModule from "../src/agent-runtime/workspace.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  seedSplitTask,
  testUlid,
} from "./helpers/cli.js";

const MOCK_KSPEC_CLI = path.join(__dirname, "mocks", "kspec-capture-mock.cjs");
ensureSplitBackendRegistered();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function deferredBarrier() {
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, arrive: async () => (enter(), blocked), release };
}

function writerSettledBarrier() {
  return deferredBarrier();
}

function admissionBarrier() {
  return deferredBarrier();
}

function spawnBarrier() {
  return deferredBarrier();
}

function publicationRecorder() {
  const publications: DispatchControlPublication[] = [];
  return {
    publications,
    record: (publication: DispatchControlPublication) => publications.push(publication),
    tokens: () => publications.map((publication) => publication.token),
  };
}

function control(authority: "stopped" | "running" | "paused", revision = 1): DispatchControl {
  return { ...createMissingDispatchControl(), revision, global: { authority } };
}

class AdmissionControlStore implements DispatchLifecycleAuthorityStore {
  private publication: DispatchControlPublication;
  private listener: ((publication: DispatchControlPublication) => void) | undefined;
  private nextLoadBarrier: ReturnType<typeof admissionBarrier> | null = null;
  writes = 0;

  constructor(snapshot: DispatchControl) {
    this.publication = {
      snapshot,
      token: { revision: snapshot.revision, commit_oid: `memory-${snapshot.revision}` },
    };
  }

  setPublicationListener(
    _key: string,
    listener: (publication: DispatchControlPublication) => void,
  ): void {
    this.listener = listener;
  }

  gateNextLoad(barrier: ReturnType<typeof admissionBarrier>): void {
    this.nextLoadBarrier = barrier;
  }

  async loadCommitted(): Promise<DispatchControlPublication> {
    const barrier = this.nextLoadBarrier;
    this.nextLoadBarrier = null;
    if (barrier) await barrier.arrive();
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
      this.commit(next);
    }
    return this.publication;
  }

  commit(snapshot: DispatchControl): void {
    this.publication = {
      snapshot,
      token: { revision: snapshot.revision, commit_oid: `memory-${snapshot.revision}` },
    };
    this.listener?.(this.publication);
  }
}

type Harness = Awaited<ReturnType<typeof createPublicationAdmissionHarness>>;
const harnesses: Harness[] = [];

async function createPublicationAdmissionHarness(
  authority: "stopped" | "running" | "paused" = "running",
) {
  const rootDir = await createTempDir("dispatch-publication-admission-");
  const publicationProjectDir = path.join(rootDir, "publication");
  const engineProjectDir = path.join(rootDir, "engine");
  await fs.mkdir(publicationProjectDir);
  await fs.mkdir(engineProjectDir);

  initGitRepo(publicationProjectDir);
  await fs.writeFile(path.join(publicationProjectDir, "README.md"), "seed\n");
  git(publicationProjectDir, "add", "README.md");
  git(publicationProjectDir, "commit", "-m", "seed");
  git(publicationProjectDir, "branch", "kspec-meta");
  git(publicationProjectDir, "worktree", "add", ".kspec", "kspec-meta");
  const publicationSpecDir = path.join(publicationProjectDir, ".kspec");
  await fs.rm(path.join(publicationSpecDir, "README.md"));
  await fs.writeFile(
    path.join(publicationSpecDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: "Publication admission"\n',
  );
  await fs.writeFile(
    path.join(publicationSpecDir, "dispatch-control.yaml"),
    serializeDispatchControl(control("stopped")),
  );
  git(publicationSpecDir, "add", "-A");
  git(publicationSpecDir, "commit", "-m", "seed control");
  const publications = publicationRecorder();
  const publicationStore = new DispatchControlStore(publicationProjectDir, {
    onPublication: publications.record,
  });
  await publicationStore.loadCommitted();

  initGitRepo(engineProjectDir);
  const taskA = testUlid("TASK", 1);
  const taskB = testUlid("TASK", 2);
  await fs.writeFile(
    path.join(engineProjectDir, "kynetic.yaml"),
    YAML.stringify({ kynetic: "1.1", title: "Admission", task_storage: { format: "split" } }),
  );
  const writeAgents = async (ids: string[] = ["worker"]) => {
    await fs.writeFile(
      path.join(engineProjectDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: ids.map((id, index) => ({
          _ulid: testUlid("AGNT", index + 1),
          id,
          name: id,
          adapter: "mock-acp",
          capabilities: [],
          tools: [],
          conventions: [],
          skills: [],
          auto_approve: false,
          concurrency: { max_concurrent: 2 },
          budget: { max_retries: 0 },
          dispatch: [{ on: "task.ready" }],
        })),
      }),
    );
  };
  await writeAgents();
  const replaceTasks = async (
    tasks: Array<{ id: string; status: "pending" | "completed"; slug: string }>,
  ) => {
    await fs.rm(path.join(engineProjectDir, "tasks"), { recursive: true, force: true });
    await fs.rm(path.join(engineProjectDir, "project.tasks.yaml"), { force: true });
    for (const task of tasks) {
      seedSplitTask(engineProjectDir, {
        _ulid: task.id,
        type: "task",
        title: task.slug,
        slugs: [task.slug],
        status: task.status,
        priority: 1,
        automation: "eligible",
        depends_on: [],
        blocked_by: [],
        tags: [],
        notes: [],
        created_at: new Date().toISOString(),
      });
    }
  };
  await replaceTasks([{ id: taskA, status: "pending", slug: "task-alpha" }]);

  const admissionStore = new AdmissionControlStore(control(authority));
  const engine = new DispatchEngine({
    projectDir: engineProjectDir,
    specDir: engineProjectDir,
    kspecCliPath: MOCK_KSPEC_CLI,
    reconcileIntervalMs: 0,
    coalesceWindowMs: 0,
    lifecycleStore: admissionStore,
  });
  const metadata = {
    workspaceId: "publication-admission-workspace",
    taskRef: "@task-alpha",
    taskSlug: "task-alpha",
    canonicalBranch: "dispatch/task/task-alpha/test",
    canonicalBranchHead: "abc123",
    integrationTargetBranch: "dev",
    publicationMode: "manual_merge",
    lifecycleState: "ready",
    activeRole: null,
    workerWorktreeDir: engineProjectDir,
    reviewerWorktreeDir: null,
    bootstrap: {
      status: "ready",
      lastRole: "worker",
      roleStates: {
        worker: { status: "ready", steps: [], invalidationReasons: [] },
        reviewer: { status: "not_run", steps: [], invalidationReasons: [] },
      },
    },
  };
  const provisioned = {
    cwd: engineProjectDir,
    metadataPath: path.join(engineProjectDir, ".kspec-dispatch-workspace.json"),
    metadata: metadata as never,
  };
  vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
    exists: true,
    healthy: true,
    reason: null,
    metadata: metadata as never,
  });
  vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceRegistry").mockResolvedValue();
  vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceArtifacts").mockResolvedValue();
  vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceLifecycle").mockResolvedValue();
  vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue(provisioned);
  vi.spyOn(workspaceModule, "markDispatchWorkspaceActive").mockResolvedValue(provisioned);
  vi.spyOn(workspaceModule, "markDispatchWorkspaceIdle").mockResolvedValue(provisioned);
  vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
    metadata: metadata as never,
  });

  const spawn = spawnBarrier();
  const completion = deferredBarrier();
  const artifacts = { starts: [] as Array<{ taskId: string | null; agentId: string }>, count: 0 };
  let gateSpawn = false;
  vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (options) => {
    if (gateSpawn) await spawn.arrive();
    const handoff = await options.beforeCreate?.();
    artifacts.count++;
    artifacts.starts.push({ taskId: handoff?.taskId ?? null, agentId: handoff?.agentId ?? "" });
    await completion.arrive();
    return { session: {} as never, outcome: "success", durationMs: 1, turnCount: 1 };
  });

  const harness = {
    rootDir,
    publicationProjectDir,
    publicationSpecDir,
    publicationStore,
    publications,
    engineProjectDir,
    taskA,
    taskB,
    admissionStore,
    engine,
    spawn,
    completion,
    artifacts,
    replaceTasks,
    writeAgents,
    enableSpawnBarrier: () => {
      gateSpawn = true;
    },
  };
  harnesses.push(harness);
  return harness;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      harness.spawn.release();
      harness.completion.release();
      await harness.engine.stop().catch(() => undefined);
      await cleanupTempDir(harness.rootDir);
    }),
  );
});

describe("committed publication and admission boundaries", () => {
  // AC: @dispatch-lifecycle-control-authority ac-external-commit-is-eventually-visible
  // AC: @dispatch-lifecycle-control-authority ac-uncommitted-control-is-not-visible
  it("publishes one newer token only after a watcher-observed external writer commits", async () => {
    const harness = await createPublicationAdmissionHarness();
    const before = harness.publicationStore.getPublication();
    const writer = writerSettledBarrier();
    const releaseLock = await acquireFileLock(
      getDispatchShadowMutationLockPath(harness.publicationProjectDir),
    );
    await fs.writeFile(
      path.join(harness.publicationSpecDir, "dispatch-control.yaml"),
      serializeDispatchControl(control("paused", 2)),
    );
    const watcher = harness.publicationStore.reloadCommitted(before.token.commit_oid);
    const externalWriter = (async () => {
      await writer.arrive();
      git(harness.publicationSpecDir, "add", "dispatch-control.yaml");
      git(harness.publicationSpecDir, "commit", "-m", "external pause");
      await releaseLock();
    })();

    await writer.entered;
    expect(harness.publicationStore.getPublication()).toEqual(before);
    expect(harness.publications.tokens()).toEqual([before.token]);
    writer.release();
    await Promise.all([watcher, externalWriter]);
    await harness.publicationStore.reloadCommitted(
      git(harness.publicationSpecDir, "rev-parse", "HEAD"),
    );

    const after = harness.publicationStore.getPublication();
    expect(after.snapshot).toMatchObject({ revision: 2, global: { authority: "paused" } });
    expect(after.token).not.toEqual(before.token);
    expect(harness.publications.tokens()).toEqual([before.token, after.token]);
  });

  // AC: @dispatch-lifecycle-control-authority ac-uncommitted-control-is-not-visible
  // AC: @dispatch-lifecycle-control-authority ac-failed-control-write-is-not-visible
  it.each(["abort", "rollback"] as const)(
    "retains prior authority and token when watcher-observed bytes %s",
    async (outcome) => {
      const harness = await createPublicationAdmissionHarness();
      const before = harness.publicationStore.getPublication();
      if (outcome === "abort") {
        const releaseLock = await acquireFileLock(
          getDispatchShadowMutationLockPath(harness.publicationProjectDir),
        );
        await fs.writeFile(
          path.join(harness.publicationSpecDir, "dispatch-control.yaml"),
          serializeDispatchControl(control("running", 2)),
        );
        const watcher = harness.publicationStore.reloadCommitted(before.token.commit_oid);
        git(harness.publicationSpecDir, "checkout", "--", "dispatch-control.yaml");
        await releaseLock();
        await watcher;
      } else {
        let watcher!: Promise<void>;
        await expect(
          withDispatchShadowTransaction(
            harness.publicationProjectDir,
            "publication-admission-rollback",
            async (ctx) => {
              await replaceDispatchControlFile(ctx.specDir, control("running", 2));
              watcher = harness.publicationStore.reloadCommitted(before.token.commit_oid);
              throw new Error("rollback publication candidate");
            },
          ),
        ).rejects.toThrow("rollback publication candidate");
        await watcher;
      }

      expect(harness.publicationStore.getPublication()).toEqual(before);
      expect(harness.publications.tokens()).toEqual([before.token]);
      expect(git(harness.publicationSpecDir, "status", "--porcelain")).toBe("");
    },
  );

  // AC: @dispatch-lifecycle-control-authority ac-controls-survive-restart
  // AC: @dispatch-lifecycle-control-authority ac-global-paused-work-does-not-start
  // AC: @dispatch-lifecycle-control-authority ac-stop-forbids-new-starts
  it.each(["paused", "stopped", "running"] as const)(
    "loads %s authority before bootstrap scheduling admission",
    async (authority) => {
      const harness = await createPublicationAdmissionHarness(authority);
      const admission = admissionBarrier();
      harness.admissionStore.gateNextLoad(admission);
      const starting = harness.engine.start();
      await admission.entered;
      expect(harness.artifacts.count).toBe(0);
      admission.release();
      await starting;
      if (authority === "running") {
        await vi.waitFor(() => expect(harness.artifacts.count).toBe(1));
      } else {
        expect(harness.artifacts.count).toBe(0);
      }
      expect(harness.engine.getLifecycleStatus().globalAuthority).toBe(authority);
    },
  );

  // AC: @dispatch-lifecycle-control-authority ac-stopped-reconstruction-uses-current-state
  // AC: @dispatch-lifecycle-control-authority ac-task-paused-work-does-not-start
  it("starts global reconciliation once while matching task cleanup remains denied", async () => {
    const harness = await createPublicationAdmissionHarness("stopped");
    const timestamp = new Date().toISOString();
    harness.admissionStore.commit({
      ...control("stopped", 2),
      tasks: {
        [harness.taskA]: {
          mode: "stopped",
          reason: "task cleanup",
          actor: "test",
          source: "recovery",
          controlled_at: timestamp,
          updated_at: timestamp,
        },
      },
      pending_cleanup: {
        [harness.taskA]: {
          cleanup_id: testUlid("CLN", 1),
          status: "pending",
          phase: "owned",
        },
      },
    });
    await harness.replaceTasks([
      { id: harness.taskA, status: "pending", slug: "task-alpha" },
      { id: harness.taskB, status: "pending", slug: "task-beta" },
    ]);
    await harness.engine.start();
    await harness.engine.applyGlobalLifecycleAction("start");
    await vi.waitFor(() => expect(harness.artifacts.count).toBe(1));

    expect(harness.artifacts.starts).toEqual([{ taskId: harness.taskB, agentId: "worker" }]);
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "running",
      heldCount: 1,
      heldTaskIds: [harness.taskA],
    });
    const cleanup = projectDispatchCleanupState(harness.admissionStore.getPublication().snapshot);
    expect(cleanup).toEqual({
      status: "pending",
      entries: [
        expect.objectContaining({
          scope: "task",
          task_id: harness.taskA,
          status: "pending",
        }),
      ],
    });
    expect(cleanup.entries[0]).not.toHaveProperty("error_code");
  });

  // AC: @dispatch-lifecycle-control-authority ac-paused-reconstruction-uses-current-state
  // AC: @dispatch-lifecycle-control-authority ac-resume-reconciles-held-work
  // AC: @dispatch-lifecycle-control-authority ac-task-resume-obeys-global-authority
  it("resume reconstructs only current task and rule while global cleanup still admits zero", async () => {
    const harness = await createPublicationAdmissionHarness("paused");
    await harness.engine.start();
    await harness.replaceTasks([
      { id: harness.taskA, status: "completed", slug: "task-alpha" },
      { id: harness.taskB, status: "pending", slug: "task-current" },
    ]);
    await harness.writeAgents(["current-worker"]);
    await harness.engine.applyGlobalLifecycleAction("resume");
    await vi.waitFor(() => expect(harness.artifacts.count).toBe(1));
    expect(harness.artifacts.starts).toEqual([
      { taskId: harness.taskB, agentId: "current-worker" },
    ]);

    const timestamp = new Date().toISOString();
    harness.admissionStore.commit({
      ...harness.admissionStore.getPublication().snapshot,
      revision: 3,
      global: { authority: "paused" },
      tasks: {
        [harness.taskA]: {
          mode: "paused",
          reason: "metadata hold",
          actor: "test",
          source: "api",
          controlled_at: timestamp,
          updated_at: timestamp,
        },
      },
      pending_cleanup: {
        global: {
          cleanup_id: testUlid("CLN", 2),
          status: "failed",
          phase: "owned",
          error_code: "cancellation_failed",
        },
        [harness.taskB]: {
          cleanup_id: testUlid("CLN", 3),
          status: "pending",
          phase: "owned",
        },
      },
    });
    harness.completion.release();
    await vi.waitFor(() => expect(harness.engine.getLifecycleStatus().activeCount).toBe(0));
    await harness.engine.applyTaskLifecycleAction("resume", { taskId: harness.taskA });
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.artifacts.count).toBe(1);
    const cleanup = projectDispatchCleanupState(harness.admissionStore.getPublication().snapshot);
    expect(cleanup.status).toBe("failed");
    expect(cleanup.entries.map((entry) => entry.status)).toEqual(["failed", "pending"]);
    expect(cleanup.entries[0]).toHaveProperty("error_code", "cancellation_failed");
    expect(cleanup.entries[1]).not.toHaveProperty("error_code");
  });

  // AC: @dispatch-lifecycle-control-authority ac-repeated-resume-does-not-duplicate
  // AC: @dispatch-lifecycle-control-authority ac-concurrent-resume-does-not-duplicate
  it("coalesces two resume calls into at most one active canonical task", async () => {
    const harness = await createPublicationAdmissionHarness("paused");
    await harness.engine.start();
    const results = await Promise.all([
      harness.engine.applyGlobalLifecycleAction("resume"),
      harness.engine.applyGlobalLifecycleAction("resume"),
    ]);
    await vi.waitFor(() => expect(harness.artifacts.count).toBe(1));

    expect(results.map((result) => result.outcome).toSorted()).toEqual(["applied", "noop"]);
    expect(harness.artifacts.starts.map((start) => start.taskId)).toEqual([harness.taskA]);
    expect(harness.engine.getLifecycleStatus().activeCount).toBe(1);
  });

  // AC: @dispatch-lifecycle-control-authority ac-final-gate-prevents-process-creation
  // AC: @dispatch-lifecycle-control-authority ac-final-gate-prevents-session-creation
  it.each([
    ["global", "pause"],
    ["global", "stop"],
    ["task", "pause"],
    ["task", "stop"],
  ] as const)(
    "%s %s commits before creation and produces zero artifacts",
    async (scope, action) => {
      const harness = await createPublicationAdmissionHarness("running");
      harness.enableSpawnBarrier();
      const starting = harness.engine.start();
      await harness.spawn.entered;

      if (action === "pause") {
        if (scope === "global") await harness.engine.applyGlobalLifecycleAction("pause");
        else await harness.engine.applyTaskLifecycleAction("pause", { taskId: harness.taskA });
      } else {
        const current = harness.admissionStore.getPublication().snapshot;
        const timestamp = new Date().toISOString();
        harness.admissionStore.commit({
          ...current,
          revision: current.revision + 1,
          ...(scope === "global" ? { global: { authority: "stopped" as const } } : {}),
          tasks:
            scope === "task"
              ? {
                  ...current.tasks,
                  [harness.taskA]: {
                    mode: "stopped",
                    reason: "stop won admission",
                    actor: "test",
                    source: "api",
                    controlled_at: timestamp,
                    updated_at: timestamp,
                  },
                }
              : current.tasks,
        });
      }
      expect(harness.artifacts.count).toBe(0);
      harness.spawn.release();
      await starting;
      await vi.waitFor(() =>
        expect(harness.engine.getLifecycleStatus()).toMatchObject({ activeCount: 0 }),
      );
      expect(harness.artifacts).toMatchObject({ count: 0, starts: [] });
    },
  );
});
