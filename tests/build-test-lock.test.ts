/**
 * Tests for the per-worktree build/test lock that serializes `npm run build`
 * against scripts/test.cjs runs. The lock prevents the flake class where a
 * concurrent build rewrites dist/ non-atomically while a test-spawned CLI
 * subprocess is loading it (observed as an intermittent ESM export mismatch
 * crash in tests/upgrade-folder-storage.test.ts under full-suite conditions).
 *
 * Spec: @test-suite-perf-reliability ac-7
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestSubprocessEnv } from "./helpers/cli";

// Import the shipped module — tests exercise this, not reimplemented logic
const lockModule = require("../scripts/build-test-lock.cjs");
const { acquireBuildTestLock, getDefaultLockPath, HELD_ENV_VAR } = lockModule;

interface LockHandle {
  lockPath: string;
  reentrant: boolean;
  release: () => void;
}

const projectRoot = path.resolve(import.meta.dirname, "..");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** PID of a process that has already exited (for stale-lock tests). */
function deadPid(): number {
  const child = spawnSync("node", ["-e", ""], { stdio: "pipe" });
  expect(child.pid).toBeGreaterThan(0);
  return child.pid;
}

describe("build/test lock module", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kspec-build-test-lock-"));
    lockPath = path.join(tempDir, "worktree.lock");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // AC: @test-suite-perf-reliability ac-7
  it("acquire creates the lock with owner metadata; release removes it", async () => {
    const lock: LockHandle = await acquireBuildTestLock({ lockPath, label: "test" });
    expect(lock.reentrant).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);

    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.label).toBe("test");

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);

    // Re-acquire after release succeeds immediately.
    const again: LockHandle = await acquireBuildTestLock({ lockPath, label: "test" });
    expect(fs.existsSync(lockPath)).toBe(true);
    again.release();
  });

  // AC: @test-suite-perf-reliability ac-7
  it("a second acquire blocks while the lock is held and proceeds after release", async () => {
    const first: LockHandle = await acquireBuildTestLock({ lockPath, label: "build" });

    let acquired = false;
    const second = acquireBuildTestLock({
      lockPath,
      label: "test",
      timeoutMs: 10_000,
      pollIntervalMs: 25,
    }).then((lock: LockHandle) => {
      acquired = true;
      return lock;
    });

    // Still waiting while the first holder is alive.
    await sleep(200);
    expect(acquired).toBe(false);

    first.release();
    const lock = await second;
    expect(acquired).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    lock.release();
  });

  // AC: @test-suite-perf-reliability ac-7
  it("acquire times out with holder diagnostics when the lock stays held", async () => {
    const holder: LockHandle = await acquireBuildTestLock({ lockPath, label: "build" });
    try {
      await expect(
        acquireBuildTestLock({ lockPath, label: "test", timeoutMs: 300, pollIntervalMs: 25 }),
      ).rejects.toThrow(new RegExp(`build/test lock.*pid ${process.pid} \\(build\\)`, "s"));
    } finally {
      holder.release();
    }
  });

  // AC: @test-suite-perf-reliability ac-7
  it("reclaims a stale lock whose holder process is dead", async () => {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: deadPid(), label: "build", acquired_at: new Date().toISOString() }),
      "utf8",
    );

    const lock: LockHandle = await acquireBuildTestLock({
      lockPath,
      label: "test",
      timeoutMs: 2000,
      pollIntervalMs: 25,
    });
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    lock.release();
  });

  // AC: @test-suite-perf-reliability ac-7
  it("reclaims an ownerless lock directory once it is old enough", async () => {
    fs.mkdirSync(lockPath, { recursive: true });
    // Backdate the directory past the ownerless-stale threshold.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, past, past);

    const lock: LockHandle = await acquireBuildTestLock({
      lockPath,
      label: "test",
      timeoutMs: 2000,
      pollIntervalMs: 25,
    });
    expect(lock.reentrant).toBe(false);
    expect(fs.existsSync(path.join(lockPath, "owner.json"))).toBe(true);
    lock.release();
  });

  // AC: @test-suite-perf-reliability ac-7
  it("acquire is a reentrant no-op when an ancestor marked the lock as held", async () => {
    const holder: LockHandle = await acquireBuildTestLock({ lockPath, label: "test" });
    const savedHeld = process.env[HELD_ENV_VAR];
    process.env[HELD_ENV_VAR] = lockPath;
    try {
      const nested: LockHandle = await acquireBuildTestLock({
        lockPath,
        label: "test",
        timeoutMs: 300,
      });
      expect(nested.reentrant).toBe(true);
      // Releasing the reentrant handle must not remove the ancestor's lock.
      nested.release();
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      if (savedHeld === undefined) {
        delete process.env[HELD_ENV_VAR];
      } else {
        process.env[HELD_ENV_VAR] = savedHeld;
      }
      holder.release();
    }
  });

  it("default lock path is stable per worktree and lives under the OS tempdir", () => {
    const a = getDefaultLockPath(projectRoot);
    const b = getDefaultLockPath(projectRoot);
    expect(a).toBe(b);
    expect(a.startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(getDefaultLockPath(tempDir)).not.toBe(a);
  });
});

describe("build/test lock integration with runner and build scripts", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kspec-build-test-lock-int-"));
    lockPath = path.join(tempDir, "worktree.lock");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Hold the lock as this (live) test process via raw fs, no release needed. */
  function holdLock(): void {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, label: "build", acquired_at: new Date().toISOString() }),
      "utf8",
    );
  }

  // AC: @test-suite-perf-reliability ac-7
  it("scripts/test.cjs waits on the lock and fails fast when it stays held", () => {
    holdLock();
    const result = spawnSync("node", [path.join(projectRoot, "scripts", "test.cjs"), "--dry-run"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: buildTestSubprocessEnv({
        KSPEC_BUILD_TEST_LOCK_PATH: lockPath,
        KSPEC_BUILD_TEST_LOCK_TIMEOUT_MS: "400",
        KSPEC_BUILD_TEST_LOCK_HELD: "", // never reentrant against the temp lock
        SKIP_BUILD: "1",
      }),
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("build/test lock");
  });

  // AC: @test-suite-perf-reliability ac-7
  it("scripts/test.cjs proceeds once the lock is free", () => {
    const result = spawnSync("node", [path.join(projectRoot, "scripts", "test.cjs"), "--dry-run"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: buildTestSubprocessEnv({
        KSPEC_BUILD_TEST_LOCK_PATH: lockPath,
        KSPEC_BUILD_TEST_LOCK_HELD: "",
        SKIP_BUILD: "1",
      }),
      timeout: 60_000,
    });
    expect(result.stderr).toContain("Environment check passed");
    expect(result.status).toBe(0);
    // The runner released (or never leaked) the lock on exit.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // AC: @test-suite-perf-reliability ac-7
  it("scripts/build.cjs waits on the same lock and fails fast when it stays held", () => {
    holdLock();
    const result = spawnSync(
      "node",
      [path.join(projectRoot, "scripts", "build.cjs"), "build:unlocked"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: buildTestSubprocessEnv({
          KSPEC_BUILD_TEST_LOCK_PATH: lockPath,
          KSPEC_BUILD_TEST_LOCK_TIMEOUT_MS: "400",
          KSPEC_BUILD_TEST_LOCK_HELD: "",
        }),
        timeout: 30_000,
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("build/test lock");
  });

  it("scripts/build.cjs rejects unknown build script names without acquiring the lock", () => {
    const result = spawnSync("node", [path.join(projectRoot, "scripts", "build.cjs"), "bogus"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: buildTestSubprocessEnv({ KSPEC_BUILD_TEST_LOCK_PATH: lockPath }),
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown build script");
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
