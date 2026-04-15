import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createNote, initContext } from "../src/parser/index.js";
import { resolveTaskDataManager } from "../src/parser/task-data-manager.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import { cleanupTempDir, CLI_PATH, kspec, setupTempFixtures } from "./helpers/cli.js";

// Register the split backend (required before resolveTaskDataManager can return split manager)
ensureSplitBackendRegistered();

function runKspecAsync(
  args: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Strip dispatch/session env vars that pollute tests when running
    // inside a dispatch loop — mirrors the sanitization in tests/helpers/cli.ts.
    const cleanEnv = { ...process.env };
    for (const key of [
      "KSPEC_RALPH_SESSION",
      "KSPEC_SESSION_ID",
      "KSPEC_SHADOW_MUTATION_LOCK_FILE",
      "KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS",
    ]) {
      delete cleanEnv[key];
    }

    const child = spawn("/bin/sh", ["-c", `node ${CLI_PATH} ${args}`], {
      cwd,
      env: { ...cleanEnv, KSPEC_AUTHOR: "@test", KSPEC_NO_DAEMON: "1" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

describe("Task Mutation Serialization", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  it("preserves status transition when concurrent note mutation runs on the same task", async () => {
    // AC: @agent-invocation-lifecycle ac-5 - runtime failure notes must not clobber concurrent task state transitions.
    tempDir = await setupTempFixtures();
    const ctx = await initContext(tempDir);
    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const target = tasks.find((task) => task.slugs.includes("test-task-pending"));

    expect(target).toBeDefined();

    const failNote = createNote("[AGENT-FAIL] simulated failure", "@test");

    await Promise.all([
      manager.mutateTask(ctx, target!._ulid, async (latestTask) => {
        // Delay increases overlap pressure so both mutators race for the same file lock.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          ...latestTask,
          status: "in_progress",
          started_at: "2026-03-03T00:00:00.000Z",
        };
      }),
      manager.mutateTask(ctx, target!._ulid, (latestTask) => ({
        ...latestTask,
        notes: [...latestTask.notes, failNote],
      })),
    ]);

    const refreshed = (await manager.loadAllTasks(ctx)).find(
      (task) => task._ulid === target!._ulid,
    );
    expect(refreshed?.status).toBe("in_progress");
    expect(refreshed?.notes.some((note) => note.content === failNote.content)).toBe(true);
  });

  it("keeps both notes when concurrent note appends target the same task", async () => {
    tempDir = await setupTempFixtures();
    const ctx = await initContext(tempDir);
    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const target = tasks.find((task) => task.slugs.includes("test-task-pending"));

    expect(target).toBeDefined();

    const noteA = createNote("first concurrent note", "@test");
    const noteB = createNote("second concurrent note", "@test");

    await Promise.all([
      manager.mutateTask(ctx, target!._ulid, async (latestTask) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          ...latestTask,
          notes: [...latestTask.notes, noteA],
        };
      }),
      manager.mutateTask(ctx, target!._ulid, (latestTask) => ({
        ...latestTask,
        notes: [...latestTask.notes, noteB],
      })),
    ]);

    const refreshed = (await manager.loadAllTasks(ctx)).find(
      (task) => task._ulid === target!._ulid,
    );
    const contents = refreshed?.notes.map((note) => note.content) ?? [];

    expect(contents).toContain(noteA.content);
    expect(contents).toContain(noteB.content);
  });

  it("preserves concurrent notes during task submit", async () => {
    tempDir = await setupTempFixtures();
    kspec("task start @test-task-pending", tempDir);

    const ctx = await initContext(tempDir);
    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const target = tasks.find((task) => task.slugs.includes("test-task-pending"));
    expect(target).toBeDefined();

    const note = createNote("concurrent note during submit", "@test");
    const [submitResult] = await Promise.all([
      runKspecAsync("task submit @test-task-pending", tempDir),
      manager.mutateTask(ctx, target!._ulid, async (latestTask) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          ...latestTask,
          notes: [...latestTask.notes, note],
        };
      }),
    ]);

    expect(submitResult.exitCode).toBe(0);
    const refreshed = (await manager.loadAllTasks(ctx)).find(
      (task) => task._ulid === target!._ulid,
    );
    expect(refreshed?.status).toBe("pending_review");
    expect(refreshed?.notes.some((entry) => entry.content === note.content)).toBe(true);
  });

  it("preserves concurrent notes during task set --refs batch updates", async () => {
    tempDir = await setupTempFixtures();

    const ctx = await initContext(tempDir);
    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const target = tasks.find((task) => task.slugs.includes("test-task-pending"));
    expect(target).toBeDefined();

    const note = createNote("concurrent note during set --refs", "@test");
    const [setResult] = await Promise.all([
      runKspecAsync("task set --refs @test-task-pending @test-task-blocked --priority 1", tempDir),
      manager.mutateTask(ctx, target!._ulid, async (latestTask) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          ...latestTask,
          notes: [...latestTask.notes, note],
        };
      }),
    ]);

    expect(setResult.exitCode).toBe(0);
    const refreshedTasks = await manager.loadAllTasks(ctx);
    const pendingTask = refreshedTasks.find((task) => task.slugs.includes("test-task-pending"));
    const blockedTask = refreshedTasks.find((task) => task.slugs.includes("test-task-blocked"));

    expect(pendingTask?.priority).toBe(1);
    expect(blockedTask?.priority).toBe(1);
    expect(pendingTask?.notes.some((entry) => entry.content === note.content)).toBe(true);
  });

  it("preserves concurrent notes during task complete --refs batch transitions", async () => {
    tempDir = await setupTempFixtures();
    kspec('task add --title "Batch Complete One" --slug batch-complete-one', tempDir);
    kspec('task add --title "Batch Complete Two" --slug batch-complete-two', tempDir);
    kspec("task start @batch-complete-one", tempDir);
    kspec("task submit @batch-complete-one", tempDir);
    kspec("task start @batch-complete-two", tempDir);
    kspec("task submit @batch-complete-two", tempDir);

    const ctx = await initContext(tempDir);
    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const target = tasks.find((task) => task.slugs.includes("batch-complete-one"));
    expect(target).toBeDefined();

    const note = createNote("concurrent note during complete --refs", "@test");
    const [completeResult] = await Promise.all([
      runKspecAsync(
        'task complete --refs @batch-complete-one @batch-complete-two --reason "Batch complete"',
        tempDir,
      ),
      manager.mutateTask(ctx, target!._ulid, async (latestTask) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          ...latestTask,
          notes: [...latestTask.notes, note],
        };
      }),
    ]);

    expect(completeResult.exitCode).toBe(0);
    const refreshedTasks = await manager.loadAllTasks(ctx);
    const completedOne = refreshedTasks.find((task) => task.slugs.includes("batch-complete-one"));
    const completedTwo = refreshedTasks.find((task) => task.slugs.includes("batch-complete-two"));

    expect(completedOne?.status).toBe("completed");
    expect(completedTwo?.status).toBe("completed");
    expect(completedOne?.notes.some((entry) => entry.content === note.content)).toBe(true);
  });
});
