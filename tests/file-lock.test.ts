import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  acquireFileLock,
  withFileLock,
} from "../src/parser/file-lock.js";
import { createTempDir, cleanupTempDir } from "./helpers/cli.js";

describe("File Lock", () => {
  let tempDir: string;

  afterEach(async () => {
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
    const pidContent = await fs.readFile(
      path.join(lockDir, "pid"),
      "utf-8",
    );
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
    await expect(
      acquireFileLock(lockTarget, 200),
    ).rejects.toThrow(/Timed out waiting for file lock/);

    await release();
  });

  it("should detect and clean up stale locks from dead processes", async () => {
    tempDir = await createTempDir();
    const lockTarget = path.join(tempDir, "test.yaml");
    const lockDir = `${lockTarget}.lock`;

    // Create a fake stale lock with a non-existent PID
    await fs.mkdir(lockDir);
    // PID 999999 almost certainly doesn't exist, and timestamp is old
    await fs.writeFile(
      path.join(lockDir, "pid"),
      `999999\n${Date.now() - 60000}`,
    );

    // Should be able to acquire despite stale lock
    const release = await acquireFileLock(lockTarget, 1000);

    // Verify we own the lock
    const pidContent = await fs.readFile(
      path.join(lockDir, "pid"),
      "utf-8",
    );
    expect(pidContent).toContain(String(process.pid));

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
    const promises = Array.from({ length: 5 }, (_, i) =>
      withFileLock(targetFile, async () => {
        const content = await fs.readFile(targetFile, "utf-8");
        const match = content.match(/count: (\d+)/);
        const current = parseInt(match![1], 10);
        // Small delay to increase chance of overlap without lock
        await new Promise((r) => setTimeout(r, 10));
        await fs.writeFile(targetFile, `count: ${current + 1}\n`);
      }),
    );

    await Promise.all(promises);

    // With locking, all 5 increments should be applied
    const finalContent = await fs.readFile(targetFile, "utf-8");
    expect(finalContent).toBe("count: 5\n");
  });
});
