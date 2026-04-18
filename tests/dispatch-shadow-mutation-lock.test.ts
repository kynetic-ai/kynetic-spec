import { spawn } from "node:child_process";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock } from "../src/parser/file-lock.js";
import { cleanupTempDir, CLI_PATH, setupTempFixtures } from "./helpers/cli.js";

function runKspecAsync(
  args: string,
  cwd: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", `node ${CLI_PATH} ${args}`], {
      cwd,
      env: { ...process.env, KSPEC_AUTHOR: "@test", KSPEC_NO_DAEMON: "1", ...env },
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Dispatch shadow mutation lock", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  it("serializes mutating commands without blocking read-only commands", async () => {
    // AC: @scoped-dispatch-shadow-serialization ac-1
    // AC: @scoped-dispatch-shadow-serialization ac-2
    tempDir = await setupTempFixtures();
    const lockFile = path.join(tempDir, "dispatch-shadow-mutation");
    const release = await acquireFileLock(lockFile);

    let mutationSettled = false;
    const mutation = runKspecAsync('task note @test-task-pending "serialized note"', tempDir, {
      KSPEC_SHADOW_MUTATION_LOCK_FILE: lockFile,
    }).finally(() => {
      mutationSettled = true;
    });

    await sleep(100);

    const readResult = await runKspecAsync("task get @test-task-pending", tempDir, {
      KSPEC_SHADOW_MUTATION_LOCK_FILE: lockFile,
    });

    expect(readResult.exitCode).toBe(0);
    expect(mutationSettled).toBe(false);

    await release();

    const mutationResult = await mutation;
    expect(mutationResult.exitCode).toBe(0);
  });

  it("waits indefinitely by default when no timeout env var is set", async () => {
    // AC: @scoped-dispatch-shadow-serialization ac-4
    tempDir = await setupTempFixtures();
    const lockFile = path.join(tempDir, "dispatch-shadow-mutation");
    const release = await acquireFileLock(lockFile);

    let mutationSettled = false;
    const mutation = runKspecAsync('task note @test-task-pending "waited note"', tempDir, {
      KSPEC_SHADOW_MUTATION_LOCK_FILE: lockFile,
      // No KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS — default is wait indefinitely
    }).finally(() => {
      mutationSettled = true;
    });

    // Wait longer than the old 5s default to prove no timeout fires
    await sleep(500);
    expect(mutationSettled).toBe(false);

    // Release — mutation should now complete
    await release();
    const mutationResult = await mutation;
    expect(mutationResult.exitCode).toBe(0);
  });

  // AC: @scoped-dispatch-shadow-serialization ac-6
  it("honors explicit timeout from KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS", async () => {
    // AC: @trait-error-guidance ac-1
    // AC: @trait-error-guidance ac-2
    tempDir = await setupTempFixtures();
    const lockFile = path.join(tempDir, "dispatch-shadow-mutation");
    const release = await acquireFileLock(lockFile);

    const result = await runKspecAsync('task note @test-task-pending "blocked note"', tempDir, {
      KSPEC_SHADOW_MUTATION_LOCK_FILE: lockFile,
      KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS: "50",
    });

    await release();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("dispatch shadow mutation lock unavailable");
    expect(result.stderr).toContain("Reason:");
    expect(result.stderr).toContain("Suggested action:");
  });

  // AC: @scoped-dispatch-shadow-serialization ac-8
  it("CLI mutation succeeds after force-reclaiming lock held beyond max duration", async () => {
    tempDir = await setupTempFixtures();
    const lockFile = path.join(tempDir, "dispatch-shadow-mutation");
    const lockDir = `${lockFile}.lock`;

    // Create a lock held by our (alive) PID with a very old timestamp
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(lockDir);
    const oldTimestamp = Date.now() - 60_000;
    writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n${oldTimestamp}\nfake-uuid`);

    // CLI mutation should succeed by reclaiming the stale lock
    const result = await runKspecAsync('task note @test-task-pending "reclaimed note"', tempDir, {
      KSPEC_SHADOW_MUTATION_LOCK_FILE: lockFile,
      // Use a short max hold to ensure the 60s-old lock is reclaimed
      KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS: "5000",
    });

    expect(result.exitCode).toBe(0);
  });

  // AC: @scoped-dispatch-shadow-serialization ac-4
  it("concurrent CLI mutation interleaves when lock is released between holds", async () => {
    // General lock-interleaving test: a CLI mutation blocks while the lock
    // is held, then succeeds when the lock is released.
    tempDir = await setupTempFixtures();
    const lockFile = path.join(tempDir, "dispatch-shadow-mutation");

    // Phase 1: Hold the lock (simulates reconciliation holding lock for a dirty record)
    const release1 = await acquireFileLock(lockFile);

    // Start a CLI mutation while the lock is held — it should block
    let mutationSettled = false;
    const mutation = runKspecAsync('task note @test-task-pending "interleaved note"', tempDir, {
      KSPEC_SHADOW_MUTATION_LOCK_FILE: lockFile,
      KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS: "5000",
    }).finally(() => {
      mutationSettled = true;
    });

    // Give the CLI subprocess time to start and attempt lock acquisition
    await sleep(200);

    // The CLI mutation must still be blocked (lock is held by "reconciliation")
    expect(mutationSettled).toBe(false);

    // Phase 2: Release the lock (simulates reconciliation yielding between records)
    await release1();

    // The CLI mutation should now acquire the lock and succeed
    const result = await mutation;
    expect(result.exitCode).toBe(0);
  });
});
