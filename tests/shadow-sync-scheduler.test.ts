import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  initializeShadow,
  SHADOW_BRANCH_NAME,
  SHADOW_WORKTREE_DIR,
  hasRemoteTracking,
} from "../src/parser/shadow.js";
import { ShadowSyncScheduler } from "../src/parser/shadow-sync-scheduler.js";
import { readTestOutput } from "./helpers/cli.js";

describe("ShadowSyncScheduler", () => {
  const testDir = path.join("/tmp", `kspec-sync-sched-${Date.now()}`);
  const remoteDir = path.join("/tmp", `kspec-sync-sched-remote-${Date.now()}`);

  beforeEach(async () => {
    for (const dir of [testDir, remoteDir]) {
      try {
        await fs.rm(dir, { recursive: true });
      } catch {
        /* noop */
      }
      await fs.mkdir(dir, { recursive: true });
    }
  });

  afterEach(async () => {
    for (const dir of [testDir, remoteDir]) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  });

  async function setupSyncTest(): Promise<string> {
    // Create bare remote
    execSync("git init --bare", { cwd: remoteDir, stdio: "pipe" });

    // Create local repo with remote
    execSync("git init -b main", { cwd: testDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: testDir, stdio: "pipe" });
    await fs.writeFile(path.join(testDir, "README.md"), "# Test");
    execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: "pipe" });
    execSync(`git remote add origin ${remoteDir}`, { cwd: testDir, stdio: "pipe" });
    execSync("git push -u origin main", { cwd: testDir, stdio: "pipe" });

    // Initialize shadow with remote
    await initializeShadow(testDir);

    return path.join(testDir, SHADOW_WORKTREE_DIR);
  }

  // AC: @config-shadow ac-12
  // oxlint-disable-next-line vitest/expect-expect -- verifies no-throw on start/stop
  it("does not start when interval is 0", () => {
    const scheduler = new ShadowSyncScheduler({
      worktreeDir: "/fake/path",
      intervalSeconds: 0,
    });

    scheduler.start();
    // Should be a no-op — stop should also be safe
    scheduler.stop();
  });

  // AC: @config-shadow ac-12
  it("starts and stops the periodic timer", async () => {
    const worktreeDir = await setupSyncTest();

    const scheduler = new ShadowSyncScheduler({
      worktreeDir,
      intervalSeconds: 60,
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      scheduler.start();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Shadow sync scheduler started"),
      );

      scheduler.stop();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Shadow sync scheduler stopped"),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // AC: @config-shadow ac-12
  it("syncOnce pulls remote changes", async () => {
    const worktreeDir = await setupSyncTest();

    // Make a remote change via a clone
    const cloneDir = path.join("/tmp", `kspec-sched-clone-${Date.now()}`);
    try {
      execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: "pipe" });
      execSync('git config user.email "clone@test.com"', { cwd: cloneDir, stdio: "pipe" });
      execSync('git config user.name "Clone"', { cwd: cloneDir, stdio: "pipe" });
      execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: "pipe" });

      const tasksFile = (await fs.readdir(path.join(cloneDir, ".kspec"))).find((f) =>
        f.endsWith(".tasks.yaml"),
      );
      if (tasksFile) {
        await fs.appendFile(
          path.join(cloneDir, ".kspec", tasksFile),
          "\n# Scheduler sync test change\n",
        );
        execSync('git add -A && git commit -m "Remote change for scheduler"', {
          cwd: path.join(cloneDir, ".kspec"),
          stdio: "pipe",
        });
        execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
          cwd: path.join(cloneDir, ".kspec"),
          stdio: "pipe",
        });
      }

      // Run syncOnce
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const scheduler = new ShadowSyncScheduler({
          worktreeDir,
          intervalSeconds: 60,
        });

        await scheduler.syncOnce();

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("Shadow sync: pulled remote changes"),
        );

        // Verify the change was pulled
        if (tasksFile) {
          const content = await readTestOutput(path.join(worktreeDir, tasksFile));
          expect(content).toContain("# Scheduler sync test change");
        }
      } finally {
        consoleSpy.mockRestore();
      }
    } finally {
      await fs.rm(cloneDir, { recursive: true, force: true });
    }
  });

  // AC: @config-shadow ac-12
  it("syncOnce skips when no remote tracking configured", async () => {
    // Set up a local-only repo (no remote)
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: testDir, stdio: "pipe" });
    await fs.writeFile(path.join(testDir, "README.md"), "# Test");
    execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: "pipe" });

    await initializeShadow(testDir);
    const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

    expect(await hasRemoteTracking(worktreeDir)).toBe(false);

    const scheduler = new ShadowSyncScheduler({
      worktreeDir,
      intervalSeconds: 60,
    });

    // Should complete without error — no pull attempted
    await scheduler.syncOnce();
  });

  // AC: @config-shadow ac-12
  it("syncOnce skips when already running", async () => {
    const worktreeDir = await setupSyncTest();

    const scheduler = new ShadowSyncScheduler({
      worktreeDir,
      intervalSeconds: 60,
    });

    // Simulate concurrent sync by starting two
    const [result1, result2] = await Promise.all([scheduler.syncOnce(), scheduler.syncOnce()]);

    // Both should complete without error (one skipped due to guard)
    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();
  });

  // AC: @shadow-daemon-push-sync ac-periodic-push
  it("syncOnce pushes local commits when ahead of upstream", async () => {
    const worktreeDir = await setupSyncTest();

    // Push shadow branch to remote so tracking is fully set up
    execSync(`git push -u origin ${SHADOW_BRANCH_NAME}`, {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    // Make a local commit in the shadow worktree (ahead of remote)
    const tasksFile = (await fs.readdir(worktreeDir)).find((f) => f.endsWith(".tasks.yaml"));
    expect(tasksFile).toBeDefined();

    await fs.appendFile(path.join(worktreeDir, tasksFile!), "\n# Local change to push\n");
    execSync('git add -A && git commit -m "Local change for push test"', {
      cwd: worktreeDir,
      stdio: "pipe",
      env: { ...process.env, KSPEC_SHADOW_COMMIT: "1" },
    });

    // Verify local is ahead
    const revListOut = execSync("git rev-list --left-right --count HEAD...@{u}", {
      cwd: worktreeDir,
      encoding: "utf-8",
    }).trim();
    const [ahead] = revListOut.split("\t").map(Number);
    expect(ahead).toBeGreaterThan(0);

    // Run syncOnce
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const scheduler = new ShadowSyncScheduler({
        worktreeDir,
        intervalSeconds: 60,
      });

      await scheduler.syncOnce();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Shadow sync: pushed local changes"),
      );

      // Verify local is no longer ahead after push
      const afterRevList = execSync("git rev-list --left-right --count HEAD...@{u}", {
        cwd: worktreeDir,
        encoding: "utf-8",
      }).trim();
      const [afterAhead] = afterRevList.split("\t").map(Number);
      expect(afterAhead).toBe(0);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // AC: @shadow-daemon-push-sync ac-periodic-push
  it("syncOnce does not push when not ahead of upstream", async () => {
    const worktreeDir = await setupSyncTest();

    // Push shadow branch so tracking is configured and we're up to date
    execSync(`git push -u origin ${SHADOW_BRANCH_NAME}`, {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const scheduler = new ShadowSyncScheduler({
        worktreeDir,
        intervalSeconds: 60,
      });

      await scheduler.syncOnce();

      // Should not log any push message
      const pushCalls = consoleSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("pushed"),
      );
      expect(pushCalls).toHaveLength(0);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // AC: @shadow-daemon-push-sync ac-periodic-push
  it("syncOnce push failure is non-fatal", async () => {
    const worktreeDir = await setupSyncTest();

    // Push shadow branch so tracking is configured
    execSync(`git push -u origin ${SHADOW_BRANCH_NAME}`, {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    // Make a local commit so we're ahead
    const tasksFile = (await fs.readdir(worktreeDir)).find((f) => f.endsWith(".tasks.yaml"));
    expect(tasksFile).toBeDefined();
    await fs.appendFile(
      path.join(worktreeDir, tasksFile!),
      "\n# Local change for push failure test\n",
    );
    execSync('git add -A && git commit -m "Local change for push failure test"', {
      cwd: worktreeDir,
      stdio: "pipe",
      env: { ...process.env, KSPEC_SHADOW_COMMIT: "1" },
    });

    // Make the remote unreachable by pointing to a non-existent path
    execSync("git remote set-url origin /nonexistent/path", {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const scheduler = new ShadowSyncScheduler({
        worktreeDir,
        intervalSeconds: 60,
      });

      // Should NOT throw — push failure is non-fatal
      await scheduler.syncOnce();

      // Should log the warning about push failure
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("push failed (non-fatal)"));
    } finally {
      consoleSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // AC: @shadow-daemon-push-sync ac-periodic-push
  // AC: @shadow-daemon-push-sync ac-daemon-freshens-fetch-head
  it("syncOnce uses configured shadow remote instead of defaulting to origin", async () => {
    const worktreeDir = await setupSyncTest();

    // Push shadow branch so tracking is configured
    execSync(`git push -u origin ${SHADOW_BRANCH_NAME}`, {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    // Rename "origin" to a custom remote name to verify the scheduler uses config
    execSync("git remote rename origin specs-remote", {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    // Make a local commit so we're ahead
    const tasksFile = (await fs.readdir(worktreeDir)).find((f) => f.endsWith(".tasks.yaml"));
    expect(tasksFile).toBeDefined();
    await fs.appendFile(path.join(worktreeDir, tasksFile!), "\n# Custom remote push test\n");
    execSync('git add -A && git commit -m "Custom remote push test"', {
      cwd: worktreeDir,
      stdio: "pipe",
      env: { ...process.env, KSPEC_SHADOW_COMMIT: "1" },
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const scheduler = new ShadowSyncScheduler({
        worktreeDir,
        intervalSeconds: 60,
        shadowOptions: { remote: "specs-remote" },
      });

      await scheduler.syncOnce();

      // Should successfully push via the configured remote
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Shadow sync: pushed local changes"),
      );

      // Verify local is no longer ahead
      const revListOut = execSync("git rev-list --left-right --count HEAD...@{u}", {
        cwd: worktreeDir,
        encoding: "utf-8",
      }).trim();
      const [ahead] = revListOut.split("\t").map(Number);
      expect(ahead).toBe(0);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // AC: @shadow-daemon-push-sync ac-daemon-freshens-fetch-head
  it("syncOnce freshens FETCH_HEAD in the worktree git dir", async () => {
    const worktreeDir = await setupSyncTest();

    // Push shadow branch so tracking is configured
    execSync(`git push -u origin ${SHADOW_BRANCH_NAME}`, {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    // Resolve the worktree FETCH_HEAD path
    const fetchHeadRelative = execSync("git rev-parse --git-path FETCH_HEAD", {
      cwd: worktreeDir,
      encoding: "utf-8",
    }).trim();
    const fetchHeadPath = path.resolve(worktreeDir, fetchHeadRelative);

    // Delete FETCH_HEAD if it exists to start clean
    try {
      await fs.unlink(fetchHeadPath);
    } catch {
      /* may not exist */
    }

    // Verify it doesn't exist
    let exists = true;
    try {
      await fs.stat(fetchHeadPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const scheduler = new ShadowSyncScheduler({
        worktreeDir,
        intervalSeconds: 60,
      });

      await scheduler.syncOnce();

      // FETCH_HEAD should now exist in the worktree git dir
      const stat = await fs.stat(fetchHeadPath);
      expect(stat.isFile()).toBe(true);

      // Verify it's fresh (created within last few seconds)
      const ageMs = Date.now() - stat.mtimeMs;
      expect(ageMs).toBeLessThan(10000); // Less than 10 seconds old
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
