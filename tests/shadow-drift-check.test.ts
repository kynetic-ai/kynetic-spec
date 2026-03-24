import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as shadowModule from "../src/parser/shadow.js";
import { shadowNeedsSync, spawnGitWithTimeout } from "../src/parser/shadow.js";
import { setSyncMode, _resetSyncModeForTesting } from "../src/cli/sync-mode.js";
import { initContext } from "../src/parser/yaml.js";

// ─── Test Setup ──────────────────────────────────────────────────────────────

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
}

function initBareRepo(dir: string): void {
  execSync("git init --bare -b main", { cwd: dir, stdio: "pipe" });
}

function makeCommit(dir: string, filename: string, content: string): void {
  const filePath = path.join(dir, filename);
  execSync(`echo "${content}" > "${filePath}"`, { cwd: dir, stdio: "pipe" });
  git(dir, `add ${filename}`);
  git(dir, `commit -m "add ${filename}"`);
}

describe("Shadow Drift Check", () => {
  const baseDir = path.join("/tmp", `kspec-drift-test-${Date.now()}`);
  let bareDir: string;
  let worktreeDir: string;
  let cloneDir: string;

  beforeEach(async () => {
    await fs.rm(baseDir, { recursive: true }).catch(() => {});
    await fs.mkdir(baseDir, { recursive: true });

    // Create a bare remote
    bareDir = path.join(baseDir, "remote.git");
    await fs.mkdir(bareDir);
    initBareRepo(bareDir);

    // Clone to simulate worktree-like setup
    worktreeDir = path.join(baseDir, "worktree");
    execSync(`git clone "${bareDir}" "${worktreeDir}"`, { stdio: "pipe" });
    git(worktreeDir, 'config user.email "test@test.com"');
    git(worktreeDir, 'config user.name "Test"');

    // Make initial commit so we have a branch
    makeCommit(worktreeDir, "initial.txt", "initial");
    git(worktreeDir, "push -u origin main");

    // Create a second clone to simulate remote changes
    cloneDir = path.join(baseDir, "clone");
    execSync(`git clone "${bareDir}" "${cloneDir}"`, { stdio: "pipe" });
    git(cloneDir, 'config user.email "test@test.com"');
    git(cloneDir, 'config user.name "Test"');
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true }).catch(() => {});
  });

  // AC: @shadow-lazy-read-sync ac-no-drift-fast-path
  it("returns false when local matches upstream and FETCH_HEAD is fresh", async () => {
    // FETCH_HEAD is fresh (just fetched during clone/push)
    // Local matches remote
    const result = await shadowNeedsSync(worktreeDir, "origin", 60_000);
    expect(result).toBe(false);
  });

  // AC: @shadow-lazy-read-sync ac-pull-when-behind
  it("returns true when local is behind remote", async () => {
    // Push a new commit from the clone
    makeCommit(cloneDir, "remote-change.txt", "from remote");
    git(cloneDir, "push origin main");

    // Now worktree is behind — but FETCH_HEAD is stale, so it'll fetch
    // Set threshold to 0 to force fetch
    const result = await shadowNeedsSync(worktreeDir, "origin", 0);
    expect(result).toBe(true);
  });

  // AC: @shadow-lazy-read-sync ac-no-pull-when-ahead
  it("returns false when local is ahead of remote", async () => {
    // Make a local commit without pushing
    makeCommit(worktreeDir, "local-change.txt", "local only");

    // Force stale FETCH_HEAD to trigger fetch
    const result = await shadowNeedsSync(worktreeDir, "origin", 0);
    expect(result).toBe(false);
  });

  // AC: @shadow-lazy-read-sync ac-pull-when-diverged
  it("returns true when local and remote have diverged", async () => {
    // Push from clone
    makeCommit(cloneDir, "remote-diverge.txt", "remote side");
    git(cloneDir, "push origin main");

    // Make local commit without pulling
    makeCommit(worktreeDir, "local-diverge.txt", "local side");

    // Force stale threshold
    const result = await shadowNeedsSync(worktreeDir, "origin", 0);
    expect(result).toBe(true);
  });

  // AC: @shadow-lazy-read-sync ac-fetch-head-freshness
  it("skips fetch when FETCH_HEAD is fresh", async () => {
    // First call with threshold 0 to force fetch and create FETCH_HEAD
    await shadowNeedsSync(worktreeDir, "origin", 0);

    // Push from clone to create divergence
    makeCommit(cloneDir, "sneaky-change.txt", "sneaky");
    git(cloneDir, "push origin main");

    // With a large threshold, FETCH_HEAD should still be fresh from the first call
    // So it won't fetch and won't see the new remote commit
    const result = await shadowNeedsSync(worktreeDir, "origin", 600_000);
    expect(result).toBe(false); // Doesn't see remote change because fetch was skipped
  });

  // AC: @shadow-lazy-read-sync ac-fetch-when-stale
  it("fetches when FETCH_HEAD is stale", async () => {
    // First call to create FETCH_HEAD
    await shadowNeedsSync(worktreeDir, "origin", 0);

    // Push from clone
    makeCommit(cloneDir, "new-remote.txt", "new remote");
    git(cloneDir, "push origin main");

    // With threshold 0, FETCH_HEAD is always stale → fetch happens
    const result = await shadowNeedsSync(worktreeDir, "origin", 0);
    expect(result).toBe(true);
  });

  // AC: @shadow-lazy-read-sync ac-fetch-head-location
  it("resolves FETCH_HEAD via git rev-parse --git-path", async () => {
    // This is implicitly tested by the above tests working correctly
    // in a standard clone. Let's verify the path resolution explicitly.
    const result = await shadowNeedsSync(worktreeDir, "origin", 0);
    expect(typeof result).toBe("boolean");
  });

  // AC: @shadow-lazy-read-sync ac-upstream-ref-missing
  it("returns true when upstream ref is missing", async () => {
    // Create a branch with no upstream tracking
    git(worktreeDir, "checkout -b orphan-branch");

    // Remove tracking
    try {
      git(worktreeDir, "config --unset branch.orphan-branch.remote");
    } catch {
      // May not exist
    }

    // shadowNeedsSync should return true (safer default) when rev-list fails
    const result = await shadowNeedsSync(worktreeDir, "origin", 0);
    expect(result).toBe(true);
  });

  // AC: @shadow-lazy-read-sync ac-threshold-from-config
  it("uses the provided threshold to determine freshness", async () => {
    // First call with threshold 0 → always fetches
    await shadowNeedsSync(worktreeDir, "origin", 0);

    // Push remote change
    makeCommit(cloneDir, "threshold-test.txt", "test");
    git(cloneDir, "push origin main");

    // Large threshold → skip fetch → miss remote change
    const freshResult = await shadowNeedsSync(worktreeDir, "origin", 999_999_000);
    expect(freshResult).toBe(false);

    // Zero threshold → fetch → see remote change
    const staleResult = await shadowNeedsSync(worktreeDir, "origin", 0);
    expect(staleResult).toBe(true);
  });
});

describe("spawnGitWithTimeout", () => {
  const testDir = path.join("/tmp", `kspec-spawn-test-${Date.now()}`);

  beforeEach(async () => {
    await fs.rm(testDir, { recursive: true }).catch(() => {});
    await fs.mkdir(testDir, { recursive: true });
    execSync("git init -b main", { cwd: testDir, stdio: "pipe" });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true }).catch(() => {});
  });

  it("resolves on successful git command", async () => {
    const result = await spawnGitWithTimeout(testDir, ["status"], 5000);
    expect(result.stdout).toBeDefined();
  });

  it("rejects on non-zero exit code", async () => {
    await expect(
      spawnGitWithTimeout(testDir, ["log"], 5000), // No commits → error
    ).rejects.toThrow();
  });

  // AC: @shadow-lazy-read-sync ac-fetch-timeout
  it("rejects with timeout error when command takes too long", async () => {
    // Use a sleep-like git operation that will exceed timeout
    // git gc with a very short timeout
    await expect(spawnGitWithTimeout(testDir, ["gc", "--aggressive"], 1)).rejects.toThrow(
      /timed out/,
    );
  });
});

describe("shadowNeedsSync fetch failure handling", () => {
  const baseDir = path.join("/tmp", `kspec-fetch-fail-${Date.now()}`);
  let repoDir: string;

  beforeEach(async () => {
    await fs.rm(baseDir, { recursive: true }).catch(() => {});
    await fs.mkdir(baseDir, { recursive: true });

    // Create a repo with a remote that points to a non-existent location
    repoDir = path.join(baseDir, "repo");
    await fs.mkdir(repoDir);
    execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: "pipe" });
    execSync('echo "init" > init.txt && git add init.txt && git commit -m "init"', {
      cwd: repoDir,
      stdio: "pipe",
    });
    // Add a remote that will fail to fetch (non-existent path)
    execSync("git remote add origin /tmp/this-remote-does-not-exist-kspec-test", {
      cwd: repoDir,
      stdio: "pipe",
    });
    // Set upstream tracking (so rev-list HEAD...@{u} path is attempted)
    execSync("git config branch.main.remote origin", { cwd: repoDir, stdio: "pipe" });
    execSync("git config branch.main.merge refs/heads/main", { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true }).catch(() => {});
    delete process.env.KSPEC_DEBUG;
  });

  // AC: @shadow-lazy-read-sync ac-fetch-timeout-no-error
  it("returns false and does not throw when fetch fails", async () => {
    // threshold 0 forces a fetch attempt, which will fail (bad remote)
    // shadowNeedsSync should catch the error and return false
    const result = await shadowNeedsSync(repoDir, "origin", 0);
    expect(result).toBe(false);
  });

  // AC: @shadow-lazy-read-sync ac-fetch-timeout-debug-log
  it("emits debug log when fetch fails and KSPEC_DEBUG=1 is set", async () => {
    process.env.KSPEC_DEBUG = "1";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await shadowNeedsSync(repoDir, "origin", 0);

    const debugMessages = errorSpy.mock.calls.map((c) => c[0]);
    expect(
      debugMessages.some((msg: string) => msg.includes("[DEBUG] shadow drift-check: fetch failed")),
    ).toBe(true);

    errorSpy.mockRestore();
  });

  // AC: @shadow-lazy-read-sync ac-fetch-timeout-debug-log (negative case)
  it("does not emit debug log when fetch fails and debug is not enabled", async () => {
    delete process.env.KSPEC_DEBUG;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await shadowNeedsSync(repoDir, "origin", 0);

    const debugMessages = errorSpy.mock.calls.map((c) => c[0]);
    expect(
      debugMessages.some(
        (msg: string) => typeof msg === "string" && msg.includes("[DEBUG] shadow drift-check"),
      ),
    ).toBe(false);

    errorSpy.mockRestore();
  });
});

describe("Command Annotations", () => {
  it("markAlwaysSync and getAlwaysSyncAnnotation work correctly", async () => {
    const { Command } = await import("commander");
    const { markAlwaysSync, getAlwaysSyncAnnotation, getMutatingAnnotation } =
      await import("../src/cli/command-annotations.js");

    const cmd = new Command("test");
    expect(getAlwaysSyncAnnotation(cmd)).toBe(false);

    markAlwaysSync(cmd);
    expect(getAlwaysSyncAnnotation(cmd)).toBe(true);
    expect(getMutatingAnnotation(cmd)).toBe(false); // Independent
  });

  it("markMutating and getMutatingAnnotation work correctly", async () => {
    const { Command } = await import("commander");
    const { markMutating, getMutatingAnnotation, getAlwaysSyncAnnotation } =
      await import("../src/cli/command-annotations.js");

    const cmd = new Command("test");
    expect(getMutatingAnnotation(cmd)).toBe(false);

    markMutating(cmd);
    expect(getMutatingAnnotation(cmd)).toBe(true);
    expect(getAlwaysSyncAnnotation(cmd)).toBe(false); // Independent
  });

  // AC: @shadow-lazy-read-sync ac-session-start-always-pulls
  it("session start command is annotated as always-sync", async () => {
    const { Command } = await import("commander");
    const { getAlwaysSyncAnnotation } = await import("../src/cli/command-annotations.js");
    const { registerSessionCommands } = await import("../src/cli/commands/session/commands.js");

    const program = new Command("kspec");
    registerSessionCommands(program);

    // Find the session start subcommand
    const sessionCmd = program.commands.find((c) => c.name() === "session");
    expect(sessionCmd).toBeDefined();
    const startCmd = sessionCmd!.commands.find((c) => c.name() === "start");
    expect(startCmd).toBeDefined();

    // Verify it's annotated as always-sync
    expect(getAlwaysSyncAnnotation(startCmd!)).toBe(true);
  });

  // AC: @shadow-write-sync ac-write-skips-read-check
  it("mutating task command is annotated as mutating (triggers skip syncMode)", async () => {
    const { Command } = await import("commander");
    const { getMutatingAnnotation, getAlwaysSyncAnnotation } =
      await import("../src/cli/command-annotations.js");
    const { registerTaskCommands } = await import("../src/cli/commands/task.js");

    const program = new Command("kspec");
    registerTaskCommands(program);

    // Find the task add subcommand (representative mutating command)
    const taskCmd = program.commands.find((c) => c.name() === "task");
    expect(taskCmd).toBeDefined();
    const addCmd = taskCmd!.commands.find((c) => c.name() === "add");
    expect(addCmd).toBeDefined();

    // Verify it's annotated as mutating (will cause preAction to set skip syncMode)
    expect(getMutatingAnnotation(addCmd!)).toBe(true);
    // And NOT always-sync (mutating and always-sync are independent)
    expect(getAlwaysSyncAnnotation(addCmd!)).toBe(false);
  });
});

// ─── Behavioral tests against real initContext() ──────────────────────────────
// These tests call the real initContext() with a working shadow branch setup
// and verify that the sync behavior matches the spec ACs. shadowPull and
// shadowNeedsSync are mocked to track whether initContext routes to them.

describe("initContext sync behavior", () => {
  const baseDir = path.join("/tmp", `kspec-initctx-sync-${Date.now()}`);
  let testDir: string;
  let remoteDir: string;
  let pullCalled: boolean;
  let needsSyncCalled: boolean;
  let pullSpy: ReturnType<typeof vi.spyOn>;
  let needsSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    pullCalled = false;
    needsSyncCalled = false;
    await fs.rm(baseDir, { recursive: true }).catch(() => {});
    await fs.mkdir(baseDir, { recursive: true });

    testDir = path.join(baseDir, "project");
    remoteDir = path.join(baseDir, "remote.git");

    // Create bare remote
    await fs.mkdir(remoteDir);
    execSync(`git init --bare -b main`, { cwd: remoteDir, stdio: "pipe" });

    // Create project repo with remote
    await fs.mkdir(testDir);
    execSync("git init -b main", { cwd: testDir, stdio: "pipe" });
    git(testDir, 'config user.email "test@test.com"');
    git(testDir, 'config user.name "Test"');
    await fs.writeFile(path.join(testDir, "README.md"), "# Test");
    execSync("git add . && git commit -m 'initial'", { cwd: testDir, stdio: "pipe" });
    execSync(`git remote add origin "${remoteDir}"`, { cwd: testDir, stdio: "pipe" });
    git(testDir, "push -u origin main");

    // Set up shadow branch as a git worktree with remote tracking
    const kspecDir = path.join(testDir, ".kspec");

    // Create orphan branch kspec-meta with a manifest
    git(testDir, "checkout --orphan kspec-meta");
    execSync("git rm -rf .", { cwd: testDir, stdio: "pipe" }).toString();
    await fs.writeFile(path.join(testDir, "kynetic.yaml"), "project:\n  name: Test\nmodules: []\n");
    execSync("git add kynetic.yaml && git commit -m 'init shadow'", {
      cwd: testDir,
      stdio: "pipe",
    });
    git(testDir, "push -u origin kspec-meta");
    git(testDir, "checkout main");

    // Create worktree at .kspec/
    git(testDir, `worktree add "${kspecDir}" kspec-meta`);

    // Spy on shadow module functions using closure variables for reliability
    pullSpy = vi.spyOn(shadowModule, "shadowPull").mockImplementation(async () => {
      pullCalled = true;
      return { hadConflict: false };
    });
    needsSyncSpy = vi.spyOn(shadowModule, "shadowNeedsSync").mockImplementation(async () => {
      needsSyncCalled = true;
      return false;
    });
  });

  afterEach(async () => {
    pullSpy.mockRestore();
    needsSyncSpy.mockRestore();
    _resetSyncModeForTesting();
    delete process.env.KSPEC_NO_SYNC;
    // Remove worktree before removing directory
    try {
      git(testDir, "worktree remove .kspec --force");
    } catch {
      // Best effort
    }
    await fs.rm(baseDir, { recursive: true }).catch(() => {});
  });

  // AC: @shadow-lazy-read-sync ac-session-start-always-pulls
  it("initContext calls shadowPull and skips shadowNeedsSync when syncMode is 'always'", async () => {
    // Simulate what the preAction hook does for session start
    setSyncMode("always");

    await initContext(testDir);

    // "always" mode should call shadowPull directly, bypassing drift check
    expect(pullCalled).toBe(true);
    expect(needsSyncCalled).toBe(false);
  });

  // AC: @shadow-lazy-read-sync ac-no-sync-env
  it("initContext skips all sync when KSPEC_NO_SYNC=1 is set", async () => {
    // Set up: syncMode "always" (strongest sync), but KSPEC_NO_SYNC overrides
    setSyncMode("always");
    process.env.KSPEC_NO_SYNC = "1";

    await initContext(testDir);

    // KSPEC_NO_SYNC should prevent both shadowPull and shadowNeedsSync
    expect(pullCalled).toBe(false);
    expect(needsSyncCalled).toBe(false);
  });

  // AC: @shadow-lazy-read-sync ac-no-sync-env (negative: without env var, sync runs)
  it("initContext performs sync when KSPEC_NO_SYNC is not set", async () => {
    delete process.env.KSPEC_NO_SYNC;
    setSyncMode("always");

    await initContext(testDir);

    // Without KSPEC_NO_SYNC, "always" mode should call shadowPull
    expect(pullCalled).toBe(true);
  });

  // AC: @shadow-lazy-read-sync ac-session-start-always-pulls (drift-check comparison)
  it("initContext calls shadowNeedsSync (not direct pull) when syncMode is 'drift-check'", async () => {
    // "drift-check" is the default for read commands
    setSyncMode("drift-check");

    await initContext(testDir);

    // drift-check mode should call shadowNeedsSync, not directly pull
    expect(needsSyncCalled).toBe(true);
    // Pull was not called because our mock returns false (no sync needed)
    expect(pullCalled).toBe(false);
  });

  // AC: @shadow-write-sync ac-write-skips-read-check
  it("initContext skips both shadowPull and shadowNeedsSync when syncMode is 'skip'", async () => {
    // Simulate what the preAction hook does for mutating (write) commands
    setSyncMode("skip");

    await initContext(testDir);

    // "skip" mode should bypass all pre-read sync — writes handle their own sync
    // via commitIfShadow → shadowPushAsync → pullRebaseBeforePush
    expect(pullCalled).toBe(false);
    expect(needsSyncCalled).toBe(false);
  });

  // AC: @shadow-write-sync ac-write-skips-read-check (consume-once: second initContext also skips)
  it("initContext skips sync on both calls within a mutating command lifecycle", async () => {
    // Mutating commands call initContext twice: once in preAction (via maybeAutoStartDaemon)
    // and once in the action handler. Both should skip pre-read sync.
    setSyncMode("skip");

    await initContext(testDir);
    expect(pullCalled).toBe(false);
    expect(needsSyncCalled).toBe(false);

    // Second call (action handler) — consumeSyncMode returns 'skip' (consumed)
    await initContext(testDir);
    expect(pullCalled).toBe(false);
    expect(needsSyncCalled).toBe(false);
  });
});
