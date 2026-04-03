import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireFileLock, withFileLock } from "../src/parser/file-lock.js";
import { createTempDir, cleanupTempDir, readTestOutput } from "./helpers/cli.js";

function spawnKeepAliveProcess(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

describe("File Lock", () => {
  let tempDir: string;
  const childProcesses: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of childProcesses.splice(0)) {
      child.kill("SIGKILL");
    }
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  it("should acquire and release a lock", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    const release = await acquireFileLock(lockTarget);

    // Lock directory should exist
    const stat = await fs.stat(lockDir);
    expect(stat.isDirectory()).toBe(true);

    // PID file should contain our PID
    const pidContent = await readTestOutput(path.join(lockDir, "pid"));
    expect(pidContent).toContain(String(process.pid));

    await release();

    // Lock directory should be removed
    await expect(fs.stat(lockDir)).rejects.toThrow();
  });

  it("should block second acquire until first is released", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const events: string[] = [];

    const release1 = await acquireFileLock(lockTarget);
    events.push("acquired-1");

    // Start second acquire in background
    const acquire2 = acquireFileLock(lockTarget, 2000).then((release) => {
      events.push("acquired-2");
      return release;
    });

    // Give it time to try
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual(["acquired-1"]);

    // Release first lock
    await release1();
    events.push("released-1");

    // Second should now acquire
    const release2 = await acquire2;
    expect(events).toContain("acquired-2");

    await release2();
  });

  it("should timeout if lock is held too long", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");

    const release = await acquireFileLock(lockTarget);

    // Try to acquire with short timeout
    await expect(acquireFileLock(lockTarget, 200)).rejects.toThrow(
      /Timed out waiting for file lock/,
    );

    await release();
  });

  it("should detect and clean up stale locks from dead processes", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    // Create a fake stale lock with a non-existent PID
    await fs.mkdir(lockDir);
    // PID 999999 almost certainly doesn't exist
    await fs.writeFile(path.join(lockDir, "pid"), `999999\n${Date.now()}`);

    // Should be able to acquire despite stale lock (dead PID)
    const release = await acquireFileLock(lockTarget, 1000);

    // Verify we own the lock
    const pidContent = await readTestOutput(path.join(lockDir, "pid"));
    expect(pidContent).toContain(String(process.pid));

    await release();
  });

  it("should NOT treat lock as stale when PID is alive and within max hold duration", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    // Acquire lock normally
    const release = await acquireFileLock(lockTarget);

    // Overwrite the PID file with a recent timestamp and our (alive) PID.
    // The lock is within the default 30s max-hold-duration ceiling.
    await fs.writeFile(path.join(lockDir, "pid"), `${process.pid}\n${Date.now()}`);

    // Second acquire should still timeout (lock is held by live process within ceiling)
    await expect(acquireFileLock(lockTarget, 200)).rejects.toThrow(
      /Timed out waiting for file lock/,
    );

    await release();
  });

  it("should create parent directories for lock when they don't exist", async () => {
    tempDir = await createTempDir();
    // Target file is in a nested directory that doesn't exist yet
    const lockTarget = path.join(tempDir, "nested", "deep", "test.yaml");

    // Should succeed — acquireFileLock creates parent dirs
    const release = await acquireFileLock(lockTarget);

    // Verify the nested lock dir was created
    const lockDir = `${lockTarget}.lock`;
    const stat = await fs.stat(lockDir);
    expect(stat.isDirectory()).toBe(true);

    await release();
  });

  it("withFileLock should execute function and release lock", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    const result = await withFileLock(lockTarget, async () => {
      // Lock should be held during execution
      const stat = await fs.stat(lockDir);
      expect(stat.isDirectory()).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    // Lock should be released after
    await expect(fs.stat(lockDir)).rejects.toThrow();
  });

  it("withFileLock should release lock even if function throws", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    await expect(
      withFileLock(lockTarget, async () => {
        throw new Error("test error");
      }),
    ).rejects.toThrow("test error");

    // Lock should still be released
    await expect(fs.stat(lockDir)).rejects.toThrow();
  });

  it("should handle concurrent writes to same file safely", async () => {
    tempDir = await createTempDir();
    const targetFile = path.join(tempDir, "data.yaml");

    // Write initial data
    await fs.writeFile(targetFile, "count: 0\n");

    // Simulate 5 concurrent read-modify-write operations
    const promises = Array.from({ length: 5 }, (_, _i) =>
      withFileLock(targetFile, async () => {
        const content = await readTestOutput(targetFile);
        const match = content.match(/count: (\d+)/);
        const current = parseInt(match![1], 10);
        // Small delay to increase chance of overlap without lock
        await new Promise((r) => setTimeout(r, 10));
        await fs.writeFile(targetFile, `count: ${current + 1}\n`);
      }),
    );

    await Promise.all(promises);

    // With locking, all 5 increments should be applied
    const finalContent = await readTestOutput(targetFile);
    expect(finalContent).toBe("count: 5\n");
  });

  it("should not reclaim a lock from the same process when waiters exceed max hold duration", async () => {
    tempDir = await createTempDir();
    const targetFile = path.join(tempDir, "data.yaml");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let waiterAcquired = false;

    try {
      const release1 = await acquireFileLock(targetFile, {
        timeoutMs: 3000,
        maxHoldMs: 5,
      });

      const waiter = acquireFileLock(targetFile, {
        timeoutMs: 3000,
        maxHoldMs: 5,
      }).then((release) => {
        waiterAcquired = true;
        return release;
      });

      // Keep the original holder alive beyond maxHoldMs. The waiter must stay
      // blocked until release rather than force-reclaiming the same process.
      await new Promise((r) => setTimeout(r, 25));
      expect(waiterAcquired).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();

      await release1();

      const release2 = await waiter;
      expect(waiterAcquired).toBe(true);
      expect(release2.info.forceReclaimed).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
      await release2();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("should not remove a successor lock when an old releaser runs late", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;
    const pidFile = path.join(lockDir, "pid");

    const release1 = await acquireFileLock(lockTarget);
    const owner1 = await readTestOutput(pidFile);

    await fs.rm(lockDir, { recursive: true, force: true });

    const release2 = await acquireFileLock(lockTarget);
    const owner2 = await readTestOutput(pidFile);

    expect(owner2).not.toBe(owner1);

    await release1();

    const stat = await fs.stat(lockDir);
    expect(stat.isDirectory()).toBe(true);
    expect(await readTestOutput(pidFile)).toBe(owner2);

    await release2();
    await expect(fs.stat(lockDir)).rejects.toThrow();
  });

  // AC: @scoped-dispatch-shadow-serialization ac-4
  it("should wait indefinitely when timeoutMs is 0 and acquire after holder releases", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const events: string[] = [];

    const release1 = await acquireFileLock(lockTarget);
    events.push("acquired-1");

    // Start second acquire with timeoutMs=0 (wait indefinitely)
    const acquire2 = acquireFileLock(lockTarget, 0).then((release) => {
      events.push("acquired-2");
      return release;
    });

    // Give it time to retry several times — should NOT timeout
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toEqual(["acquired-1"]);

    // Release first lock
    await release1();
    events.push("released-1");

    // Second should now acquire
    const release2 = await acquire2;
    expect(events).toContain("acquired-2");

    await release2();
  });

  // AC: @scoped-dispatch-shadow-serialization ac-5
  it("should acquire lock via stale detection when holder is dead and timeoutMs is 0", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    // Create a fake stale lock with a non-existent PID
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, "pid"), `999999\n${Date.now()}`);

    // Should acquire via stale PID detection even with no timeout
    const release = await acquireFileLock(lockTarget, 0);

    // Verify we own the lock
    const pidContent = await readTestOutput(path.join(lockDir, "pid"));
    expect(pidContent).toContain(String(process.pid));

    await release();
  });

  // AC: @scoped-dispatch-shadow-serialization ac-7
  it("should release lock in finally even when callback throws (withFileLock)", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    // withFileLock guarantees release via try/finally
    await expect(
      withFileLock(lockTarget, async () => {
        // Verify lock is held
        const stat = await fs.stat(lockDir);
        expect(stat.isDirectory()).toBe(true);
        throw new Error("intentional failure");
      }),
    ).rejects.toThrow("intentional failure");

    // Lock must be released after error
    await expect(fs.stat(lockDir)).rejects.toThrow();

    // Another acquire should succeed immediately (no stale lock)
    const release = await acquireFileLock(lockTarget, 200);
    await release();
  });

  // AC: @scoped-dispatch-shadow-serialization ac-7
  it("should release lock after successful operation (acquireFileLock)", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    const release = await acquireFileLock(lockTarget);

    // Lock directory should exist
    const stat = await fs.stat(lockDir);
    expect(stat.isDirectory()).toBe(true);

    await release();

    // Lock directory should be removed
    await expect(fs.stat(lockDir)).rejects.toThrow();

    // Subsequent acquire succeeds immediately
    const release2 = await acquireFileLock(lockTarget, 200);
    await release2();
  });

  // AC: @scoped-dispatch-shadow-serialization ac-8
  it("should reclaim lock when holder exceeds max hold duration even if alive", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;
    const holder = spawnKeepAliveProcess();
    childProcesses.push(holder);

    // Create a lock with another alive PID but a timestamp far in the past
    await fs.mkdir(lockDir);
    const oldTimestamp = Date.now() - 60_000; // 60 seconds ago
    await fs.writeFile(path.join(lockDir, "pid"), `${holder.pid}\n${oldTimestamp}\nfake-uuid`);

    // With maxHoldMs=5000 (5s), the 60s-old lock exceeds the ceiling
    const release = await acquireFileLock(lockTarget, {
      timeoutMs: 1000,
      maxHoldMs: 5000,
    });

    // Verify we acquired the lock
    const pidContent = await readTestOutput(path.join(lockDir, "pid"));
    expect(pidContent).toContain(String(process.pid));

    // Verify the acquire info indicates force reclaim
    expect(release.info.forceReclaimed).toBe(true);
    expect(release.info.previousHolderPid).toBe(holder.pid);
    expect(release.info.previousHoldDurationMs).toBeGreaterThan(50_000);

    await release();
  });

  // AC: @scoped-dispatch-shadow-serialization ac-8
  it("should NOT reclaim lock when holder is within max hold duration", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    // Create a lock with our own (alive) PID and a recent timestamp
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, "pid"), `${process.pid}\n${Date.now()}\nfake-uuid`);

    // With maxHoldMs=30000 (30s), the fresh lock should NOT be reclaimable
    await expect(
      acquireFileLock(lockTarget, { timeoutMs: 200, maxHoldMs: 30_000 }),
    ).rejects.toThrow(/Timed out waiting for file lock/);

    // Clean up
    await fs.rm(lockDir, { recursive: true, force: true });
  });

  // AC: @scoped-dispatch-shadow-serialization ac-8
  it("should respect KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS env var", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;
    const holder = spawnKeepAliveProcess();
    childProcesses.push(holder);

    // Create a lock with another alive PID, 10 seconds old
    await fs.mkdir(lockDir);
    const tenSecondsAgo = Date.now() - 10_000;
    await fs.writeFile(path.join(lockDir, "pid"), `${holder.pid}\n${tenSecondsAgo}\nfake-uuid`);

    // Set env var to 5 seconds — the 10s lock should be reclaimable
    const original = process.env.KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS;
    process.env.KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS = "5000";

    try {
      // No explicit maxHoldMs — should pick up from env
      const release = await acquireFileLock(lockTarget, { timeoutMs: 1000 });
      expect(release.info.forceReclaimed).toBe(true);
      await release();
    } finally {
      if (original === undefined) {
        delete process.env.KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS;
      } else {
        process.env.KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS = original;
      }
    }
  });

  // AC: @scoped-dispatch-shadow-serialization ac-10
  it("should log diagnostic when force-reclaiming from alive process", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;
    const holder = spawnKeepAliveProcess();
    childProcesses.push(holder);

    // Create a lock with another alive PID, far in the past
    await fs.mkdir(lockDir);
    const oldTimestamp = Date.now() - 60_000;
    await fs.writeFile(path.join(lockDir, "pid"), `${holder.pid}\n${oldTimestamp}\nfake-uuid`);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const release = await acquireFileLock(lockTarget, {
        timeoutMs: 1000,
        maxHoldMs: 5000,
      });

      // Verify diagnostic was logged
      expect(warnSpy).toHaveBeenCalledOnce();
      const message = warnSpy.mock.calls[0][0] as string;
      expect(message).toContain("[file-lock] Reclaiming lock");
      expect(message).toContain(`PID ${holder.pid}`);
      expect(message).toContain("ceiling 5000ms");

      await release();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // AC: @scoped-dispatch-shadow-serialization ac-10
  it("should report forceReclaimed=false for dead-PID stale lock reclaim", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    // Create a stale lock with a dead PID
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, "pid"), `999999\n${Date.now()}\nfake-uuid`);

    const release = await acquireFileLock(lockTarget, { timeoutMs: 1000 });

    // Dead-PID reclaim should NOT set forceReclaimed
    expect(release.info.forceReclaimed).toBe(false);
    expect(release.info.previousHolderPid).toBeNull();

    await release();
  });

  // AC: @scoped-dispatch-shadow-serialization ac-8
  it("should disable duration-based reclamation when maxHoldMs is 0", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    // Create a lock with our own (alive) PID, far in the past
    await fs.mkdir(lockDir);
    await fs.writeFile(
      path.join(lockDir, "pid"),
      `${process.pid}\n${Date.now() - 60_000}\nfake-uuid`,
    );

    // maxHoldMs=0 disables duration-based reclamation
    await expect(
      acquireFileLock(lockTarget, { timeoutMs: 200, maxHoldMs: 0 }),
    ).rejects.toThrow(/Timed out waiting for file lock/);

    await fs.rm(lockDir, { recursive: true, force: true });
  });
});
