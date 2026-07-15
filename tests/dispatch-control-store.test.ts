import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DispatchControlStore,
  projectDispatchCleanupState,
  type DispatchControlPublication,
} from "../src/agent-runtime/dispatch-control-store.js";
import {
  parseDispatchControl,
  readDispatchControlFile,
  replaceDispatchControlFile,
  serializeDispatchControl,
} from "../src/parser/dispatch-control.js";
import type { DispatchControl } from "../src/schema/dispatch-control.js";
import { acquireFileLock, getLockDirPath } from "../src/parser/file-lock.js";
import { getDispatchShadowMutationLockPath } from "../src/agent-runtime/workspace.js";
import {
  commitDispatchShadowTransaction,
  withDispatchShadowTransaction,
} from "../src/agent-runtime/dispatch-shadow-transaction.js";
import { setBatchMode } from "../src/cli/batch-context.js";
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from "./helpers/cli.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function control(revision: number, authority: "stopped" | "running" | "paused"): DispatchControl {
  return {
    version: 1,
    revision,
    global: { authority },
    tasks: {},
    pending_cleanup: {},
  };
}

function commitBarrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => promise, release };
}

function publicationRecorder() {
  const publications: DispatchControlPublication[] = [];
  return {
    publications,
    tokens: () => publications.map((publication) => publication.token),
    record: (publication: DispatchControlPublication) => publications.push(publication),
  };
}

async function createDispatchControlStoreHarness(
  initial: DispatchControl | string = control(1, "stopped"),
) {
  const projectDir = await createTempDir("dispatch-control-store-");
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "seed\n", "utf-8");
  git(projectDir, "add", "README.md");
  git(projectDir, "commit", "-m", "seed");
  git(projectDir, "branch", "kspec-meta");
  git(projectDir, "worktree", "add", ".kspec", "kspec-meta");
  const specDir = path.join(projectDir, ".kspec");
  await fs.rm(path.join(specDir, "README.md"));
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: "Dispatch Control Store Test"\n',
    "utf-8",
  );
  await fs.writeFile(
    path.join(specDir, "dispatch-control.yaml"),
    typeof initial === "string" ? initial : serializeDispatchControl(initial),
    "utf-8",
  );
  git(specDir, "add", "-A");
  git(specDir, "commit", "-m", "seed shadow");

  const recorder = publicationRecorder();
  const store = new DispatchControlStore(projectDir, { onPublication: recorder.record });
  await store.loadCommitted();
  return { projectDir, specDir, store, recorder };
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

describe("dispatch control parsing", () => {
  it("loads missing state as stopped and accepts exact version 1", () => {
    expect(parseDispatchControl(serializeDispatchControl(control(3, "paused")))).toEqual(
      control(3, "paused"),
    );
  });

  it("reads a missing canonical file as stopped with no controls", async () => {
    const dir = await createTempDir("dispatch-control-missing-");
    cleanupDirs.push(dir);
    await expect(readDispatchControlFile(dir)).resolves.toEqual(control(0, "stopped"));
  });

  it.each([
    [
      "unknown version",
      "version: 2\nrevision: 0\nglobal: { authority: stopped }\ntasks: {}\npending_cleanup: {}\n",
    ],
    ["malformed", "version: 1\nrevision: nope\n"],
    [
      "duplicate key",
      "version: 1\nrevision: 0\nglobal: { authority: stopped }\ntasks: {}\ntasks: {}\npending_cleanup: {}\n",
    ],
    [
      "noncanonical task key",
      "version: 1\nrevision: 0\nglobal: { authority: stopped }\ntasks:\n  task-slug: { mode: paused, reason: x, actor: x, source: cli, controlled_at: 2026-01-01T00:00:00.000Z, updated_at: 2026-01-01T00:00:00.000Z }\npending_cleanup: {}\n",
    ],
  ])("rejects %s durable data", (_name, input) => {
    expect(() => parseDispatchControl(input)).toThrow();
  });

  it("rejects duplicate cleanup identities even when YAML keys differ only by case", () => {
    const id = testUlid("CLN", 1);
    const raw = `version: 1\nrevision: 1\nglobal: { authority: stopped }\ntasks: {}\npending_cleanup:\n  global: { cleanup_id: ${id}, status: pending, phase: owned }\n  ${testUlid("TSK", 1)}: { cleanup_id: ${id}, status: pending, phase: owned }\n`;
    expect(() => parseDispatchControl(raw)).toThrow();
  });
});

describe("dispatch cleanup projection", () => {
  it("preserves mixed entry status while selectors isolate only their scope", () => {
    const taskId = testUlid("TSK", 2);
    const snapshot: DispatchControl = {
      ...control(5, "stopped"),
      pending_cleanup: {
        global: {
          cleanup_id: testUlid("CLN", 2),
          status: "failed",
          phase: "signals_sent",
          error_code: "cancellation_failed",
        },
        [taskId]: {
          cleanup_id: testUlid("CLN", 3),
          status: "pending",
          phase: "owned",
        },
      },
    };

    const aggregate = projectDispatchCleanupState(snapshot);
    expect(aggregate).toMatchObject({
      status: "failed",
      entries: [
        { scope: "global", status: "failed", error_code: "cancellation_failed" },
        { scope: "task", status: "pending" },
      ],
    });
    expect(aggregate.entries[1]).not.toHaveProperty("error_code");
    expect(projectDispatchCleanupState(snapshot, { scope: "global" }).entries).toHaveLength(1);
    expect(projectDispatchCleanupState(snapshot, { scope: "task", task_id: taskId })).toEqual({
      status: "pending",
      entries: [expect.objectContaining({ task_id: taskId, status: "pending" })],
    });
  });
});

describe("DispatchControlStore committed publication", () => {
  it("recovers from an initially corrupt commit only after a valid committed repair", async () => {
    const harness = await createDispatchControlStoreHarness("version: 99\n");
    cleanupDirs.push(harness.projectDir);
    const corruptHead = git(harness.specDir, "rev-parse", "HEAD");
    expect(harness.store.getPublication()).toMatchObject({
      snapshot: { revision: 0, global: { authority: "stopped" } },
      token: { commit_oid: corruptHead },
    });
    expect(harness.store.getDegradedReason()).toContain("control_store_degraded");
    expect(harness.recorder.tokens()).toEqual([]);

    await fs.writeFile(
      path.join(harness.specDir, "dispatch-control.yaml"),
      serializeDispatchControl(control(0, "stopped")),
      "utf-8",
    );
    git(harness.specDir, "add", "dispatch-control.yaml");
    git(harness.specDir, "commit", "-m", "repair dispatch control");
    await harness.store.reloadCommitted(corruptHead);

    expect(harness.store.getPublication().token.commit_oid).toBe(
      git(harness.specDir, "rev-parse", "HEAD"),
    );
    expect(harness.store.getDegradedReason()).toBeNull();
    expect(harness.recorder.tokens()).toHaveLength(1);
  });

  // AC: @dispatch-lifecycle-control-authority ac-uncommitted-control-is-not-visible
  it("does not publish watcher-observed dirty bytes", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();
    await fs.writeFile(
      path.join(harness.specDir, "dispatch-control.yaml"),
      serializeDispatchControl(control(2, "running")),
      "utf-8",
    );

    await harness.store.reloadCommitted(before.token.commit_oid);

    expect(harness.store.getPublication()).toEqual(before);
    expect(harness.recorder.tokens()).toEqual([before.token]);
  });

  // AC: @dispatch-lifecycle-control-authority ac-failed-control-write-is-not-visible
  it("retains the committed publication when a transaction throws", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();

    await expect(
      harness.store.mutate("test failure", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(harness.store.getPublication()).toEqual(before);
    expect(git(harness.specDir, "status", "--porcelain")).toBe("");
  });

  it("reloads a newer pre-transaction commit after the proposed write fails", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);
    await fs.writeFile(
      path.join(harness.specDir, "dispatch-control.yaml"),
      serializeDispatchControl(control(2, "running")),
      "utf-8",
    );
    git(harness.specDir, "add", "dispatch-control.yaml");
    git(harness.specDir, "commit", "-m", "external control before failed mutation");
    let recoveredWhileShadowLocked = false;
    harness.store.setPublicationListener("lock-observer", () => {
      recoveredWhileShadowLocked = existsSync(
        getLockDirPath(getDispatchShadowMutationLockPath(harness.projectDir)),
      );
    });

    setBatchMode(true);
    try {
      await expect(
        harness.store.mutate("batch-suppressed", (current) => ({
          ...current,
          revision: current.revision + 1,
          global: { authority: "paused" },
        })),
      ).rejects.toThrow("did not produce a committed shadow revision");
    } finally {
      setBatchMode(false);
    }

    expect(harness.store.getPublication()).toMatchObject({
      snapshot: { revision: 2, global: { authority: "running" } },
      token: { commit_oid: git(harness.specDir, "rev-parse", "HEAD") },
    });
    expect(harness.recorder.tokens()).toHaveLength(2);
    expect(recoveredWhileShadowLocked).toBe(true);
  });

  it("rolls back changed bytes when commitIfShadow reports false", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();
    setBatchMode(true);
    try {
      await expect(
        harness.store.mutate("batch-suppressed", (current) => ({
          ...current,
          revision: current.revision + 1,
          global: { authority: "running" },
        })),
      ).rejects.toThrow("did not produce a committed shadow revision");
    } finally {
      setBatchMode(false);
    }

    expect(harness.store.getPublication()).toEqual(before);
    expect(git(harness.specDir, "status", "--porcelain")).toBe("");
  });

  it("rejects mutations whose durable revision does not increase", async () => {
    const harness = await createDispatchControlStoreHarness(control(4, "running"));
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();

    await expect(
      harness.store.mutate("non-monotonic", (current) => ({
        ...current,
        global: { authority: "paused" },
      })),
    ).rejects.toThrow("must increase monotonically");

    expect(harness.store.getPublication()).toEqual(before);
    expect(git(harness.specDir, "status", "--porcelain")).toBe("");
  });

  it("resets to pre_head when committed-object verification fails", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);
    const beforeHead = git(harness.specDir, "rev-parse", "HEAD");
    const proposed = control(2, "running");

    await expect(
      withDispatchShadowTransaction(harness.projectDir, "verification-failure", async (ctx) => {
        const written = await replaceDispatchControlFile(ctx.specDir, proposed);
        return commitDispatchShadowTransaction(
          ctx,
          {
            dispatchControlPath: written.path,
            expectedBytes: `${written.bytes}# mismatch\n`,
            proposedSnapshot: proposed,
          },
          "verification-failure",
        );
      }),
    ).rejects.toThrow("failed verification");

    expect(git(harness.specDir, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(
      parseDispatchControl(git(harness.specDir, "show", "HEAD:dispatch-control.yaml")),
    ).toEqual(control(1, "stopped"));
  });

  it("rolls back dirty shadow state after force-reclaiming the mutation lock", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);
    const lockPath = getDispatchShadowMutationLockPath(harness.projectDir);
    const lockHolder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const lockDir = getLockDirPath(lockPath);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "pid"),
      `${lockHolder.pid}\n${Date.now() - 10_000}\nabandoned\n`,
      "utf-8",
    );
    const interruptedPath = path.join(harness.specDir, "interrupted-control.tmp");
    await fs.writeFile(interruptedPath, "partial\n", "utf-8");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const previousMaxHold = process.env.KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS;
    process.env.KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS = "1";
    try {
      await harness.store.mutate("force-reclaim", (current) => ({
        ...current,
        revision: current.revision + 1,
        global: { authority: "paused" },
      }));
    } finally {
      if (previousMaxHold === undefined) {
        delete process.env.KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS;
      } else {
        process.env.KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS = previousMaxHold;
      }
      lockHolder.kill("SIGTERM");
    }

    await expect(fs.stat(interruptedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(harness.specDir, "status", "--porcelain")).toBe("");
  });

  // AC: @dispatch-lifecycle-control-authority ac-stale-control-is-not-visible
  it("retains a newer verified token when another committed revision is stale", async () => {
    const harness = await createDispatchControlStoreHarness(control(4, "running"));
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();
    await fs.writeFile(
      path.join(harness.specDir, "dispatch-control.yaml"),
      serializeDispatchControl(control(3, "paused")),
      "utf-8",
    );
    git(harness.specDir, "add", "dispatch-control.yaml");
    git(harness.specDir, "commit", "-m", "stale external commit");

    await harness.store.reloadCommitted(before.token.commit_oid);

    expect(harness.store.getPublication()).toEqual(before);
  });

  // AC: @dispatch-lifecycle-control-authority ac-stale-control-is-not-visible
  it("rejects a mutation based on a divergent commit at the published revision", async () => {
    const harness = await createDispatchControlStoreHarness(control(4, "running"));
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();
    await fs.writeFile(
      path.join(harness.specDir, "dispatch-control.yaml"),
      serializeDispatchControl(control(4, "paused")),
      "utf-8",
    );
    git(harness.specDir, "add", "dispatch-control.yaml");
    git(harness.specDir, "commit", "-m", "divergent equal-revision control");

    await harness.store.reloadCommitted(before.token.commit_oid);
    expect(harness.store.getPublication()).toEqual(before);

    await expect(
      harness.store.mutate("reject-divergent-revision", (current) => ({
        ...current,
        revision: current.revision + 1,
      })),
    ).rejects.toThrow("diverges from the verified publication");

    expect(harness.store.getPublication()).toEqual(before);
    expect(git(harness.specDir, "status", "--porcelain")).toBe("");
  });

  it("allows an unchanged published snapshot at a later unrelated shadow commit", async () => {
    const harness = await createDispatchControlStoreHarness(control(4, "running"));
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();
    await fs.writeFile(path.join(harness.specDir, "unrelated.yaml"), "value: changed\n", "utf-8");
    git(harness.specDir, "add", "unrelated.yaml");
    git(harness.specDir, "commit", "-m", "unrelated shadow update");

    await harness.store.reloadCommitted(before.token.commit_oid);
    expect(harness.store.getPublication()).toEqual(before);

    const publication = await harness.store.mutate("pause-after-unrelated-commit", (current) => ({
      ...current,
      revision: current.revision + 1,
      global: { authority: "paused" },
    }));

    expect(publication.snapshot).toMatchObject({
      revision: 5,
      global: { authority: "paused" },
    });
    expect(harness.store.getPublication()).toEqual(publication);
  });

  it("returns the committed publication without writing when a mutation resolves to no change", async () => {
    const harness = await createDispatchControlStoreHarness(control(4, "running"));
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();
    const beforeHead = git(harness.specDir, "rev-parse", "HEAD");

    const publication = await harness.store.mutate("running-noop", () => null);

    expect(publication).toEqual(before);
    expect(git(harness.specDir, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(git(harness.specDir, "status", "--porcelain")).toBe("");
  });

  // AC: @dispatch-lifecycle-control-authority ac-invalid-control-is-not-visible
  it("retains the verified publication and degrades on malformed committed data", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();
    await fs.writeFile(path.join(harness.specDir, "dispatch-control.yaml"), "version: 99\n");
    git(harness.specDir, "add", "dispatch-control.yaml");
    git(harness.specDir, "commit", "-m", "invalid external commit");

    await harness.store.reloadCommitted(before.token.commit_oid);

    expect(harness.store.getPublication()).toEqual(before);
    expect(harness.store.getDegradedReason()).toContain("dispatch-control.yaml");
  });

  // AC: @dispatch-lifecycle-control-authority ac-external-commit-is-eventually-visible
  it("publishes a valid external committed revision once across duplicate watcher events", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();
    const releaseWriter = await acquireFileLock(
      getDispatchShadowMutationLockPath(harness.projectDir),
    );
    await fs.writeFile(
      path.join(harness.specDir, "dispatch-control.yaml"),
      serializeDispatchControl(control(2, "paused")),
      "utf-8",
    );
    const watcherReload = harness.store.reloadCommitted(before.token.commit_oid);
    expect(harness.store.getPublication()).toEqual(before);
    expect(harness.recorder.tokens()).toEqual([before.token]);
    git(harness.specDir, "add", "dispatch-control.yaml");
    git(harness.specDir, "commit", "-m", "external control");
    await releaseWriter();

    await watcherReload;
    await harness.store.reloadCommitted(git(harness.specDir, "rev-parse", "HEAD"));

    const after = harness.store.getPublication();
    expect(after.snapshot).toMatchObject({ revision: 2, global: { authority: "paused" } });
    expect(after.token).not.toEqual(before.token);
    expect(harness.recorder.tokens()).toEqual([before.token, after.token]);
  });

  it("retains the prior token when a watcher event precedes an external abort", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();
    const releaseWriter = await acquireFileLock(
      getDispatchShadowMutationLockPath(harness.projectDir),
    );
    await fs.writeFile(
      path.join(harness.specDir, "dispatch-control.yaml"),
      serializeDispatchControl(control(2, "running")),
      "utf-8",
    );
    const watcherReload = harness.store.reloadCommitted(before.token.commit_oid);
    git(harness.specDir, "checkout", "--", "dispatch-control.yaml");
    await releaseWriter();

    await watcherReload;

    expect(harness.store.getPublication()).toEqual(before);
    expect(harness.recorder.tokens()).toEqual([before.token]);
  });

  it("retains the prior token when a watcher event precedes transaction rollback", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);
    const before = harness.store.getPublication();
    let watcherReload!: Promise<void>;

    await expect(
      withDispatchShadowTransaction(harness.projectDir, "watcher-before-rollback", async (ctx) => {
        await replaceDispatchControlFile(ctx.specDir, control(2, "running"));
        watcherReload = harness.store.reloadCommitted(before.token.commit_oid);
        throw new Error("abort transaction");
      }),
    ).rejects.toThrow("abort transaction");
    await watcherReload;

    expect(harness.store.getPublication()).toEqual(before);
    expect(harness.recorder.tokens()).toEqual([before.token]);
    expect(git(harness.specDir, "status", "--porcelain")).toBe("");
  });

  it("suppresses the self-event when commit publication wins before the watcher", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);

    await harness.store.mutate("pause", (current) => ({
      ...current,
      revision: current.revision + 1,
      global: { authority: "paused" },
    }));
    const committed = harness.store.getPublication();
    await harness.store.reloadCommitted(committed.token.commit_oid);

    expect(harness.store.getPublication()).toEqual(committed);
    expect(harness.recorder.tokens()).toHaveLength(2);
  });

  it("publishes only after the transaction commit boundary", async () => {
    const harness = await createDispatchControlStoreHarness();
    cleanupDirs.push(harness.projectDir);
    const barrier = commitBarrier();
    const before = harness.store.getPublication();
    const mutation = harness.store.mutate("pause", async (current) => {
      await barrier.wait();
      return { ...current, revision: current.revision + 1, global: { authority: "paused" } };
    });

    await Promise.resolve();
    expect(harness.store.getPublication()).toEqual(before);
    barrier.release();
    await mutation;

    expect(harness.store.getPublication().snapshot.global.authority).toBe("paused");
  });
});
