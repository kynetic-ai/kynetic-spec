/**
 * Per-worktree advisory lock serializing builds and test runs.
 *
 * `npm run build` rewrites dist/ non-atomically (tsc emits one file at a
 * time). A vitest run spawns dist/cli/index.js dozens of times; any spawn
 * that lands inside a concurrent build's emit window can load a mix of old
 * and new modules and crash with an import/export mismatch. Observed as an
 * intermittent failure in tests/upgrade-folder-storage.test.ts when a
 * reviewer session ran the build gate and the full test suite concurrently.
 *
 * The lock is a directory under the OS tmpdir keyed by the worktree's real
 * path (mkdir is atomic on all platforms — same pattern as
 * src/parser/file-lock.ts). An owner.json inside records pid/label/time for
 * stale detection and diagnostics.
 *
 * Coordination env vars:
 *   KSPEC_BUILD_TEST_LOCK_HELD        Set by a lock-holding process for its
 *                                     children; a matching value makes
 *                                     acquire a reentrant no-op so nested
 *                                     build/test invocations don't deadlock
 *                                     against their ancestor.
 *   KSPEC_BUILD_TEST_LOCK_PATH        Override the lock directory path
 *                                     (tests point this at a temp dir).
 *   KSPEC_BUILD_TEST_LOCK_TIMEOUT_MS  Override the acquire timeout.
 *
 * AC: @test-suite-perf-reliability ac-7
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HELD_ENV_VAR = "KSPEC_BUILD_TEST_LOCK_HELD";
const LOCK_PATH_ENV_VAR = "KSPEC_BUILD_TEST_LOCK_PATH";
const TIMEOUT_ENV_VAR = "KSPEC_BUILD_TEST_LOCK_TIMEOUT_MS";

// A full build (~5 min) plus a full suite (~3 min) can legitimately hold the
// lock back-to-back; default generously so waiters outlast a slow holder.
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const WAIT_LOG_INTERVAL_MS = 5000;
// A lock dir with no readable owner.json is either mid-acquire (give it a
// moment) or debris from a holder killed between mkdir and writeFile.
const OWNERLESS_STALE_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default lock path for a worktree: tmpdir keyed by the root's real path. */
function getDefaultLockPath(rootDir) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(rootDir);
  } catch {
    realRoot = path.resolve(rootDir);
  }
  const key = crypto.createHash("sha256").update(realRoot).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "kspec-build-test-locks", `${key}.lock`);
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err.code === "EPERM";
  }
}

function readOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function lockDirAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function removeLock(lockPath) {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Lost a removal race with another waiter — the retry loop handles it.
  }
}

function resolveTimeoutMs(explicit) {
  if (explicit !== undefined) return explicit;
  const raw = process.env[TIMEOUT_ENV_VAR];
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Acquire the per-worktree build/test lock.
 *
 * @param {object} options
 * @param {string} [options.rootDir] Worktree root (used for the default lock path).
 * @param {string} [options.label] Holder label written into owner.json ("build", "test").
 * @param {number} [options.timeoutMs] Max wait; 0 = fail immediately if held.
 * @param {number} [options.pollIntervalMs] Retry interval while waiting.
 * @param {string} [options.lockPath] Explicit lock dir (overrides env + default).
 * @param {(msg: string) => void} [options.onWait] Called periodically while waiting.
 * @returns {Promise<{ lockPath: string, reentrant: boolean, release: () => void }>}
 */
async function acquireBuildTestLock(options = {}) {
  const {
    rootDir = path.dirname(__dirname),
    label = "unknown",
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onWait,
  } = options;
  const lockPath =
    options.lockPath || process.env[LOCK_PATH_ENV_VAR] || getDefaultLockPath(rootDir);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);

  // Reentrant: an ancestor process already holds this exact lock and marked
  // the environment for its children. Nested build/test runs are covered by
  // the ancestor's exclusion, so they proceed without acquiring.
  if (process.env[HELD_ENV_VAR] === lockPath) {
    return { lockPath, reentrant: true, release: () => {} };
  }

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const start = Date.now();
  let lastWaitLog = 0;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, label, acquired_at: new Date().toISOString() })}\n`,
        "utf8",
      );
      const release = () => {
        const owner = readOwner(lockPath);
        if (owner && owner.pid === process.pid) {
          removeLock(lockPath);
        }
      };
      return { lockPath, reentrant: false, release };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }

    const owner = readOwner(lockPath);
    if (owner) {
      if (!pidIsAlive(owner.pid)) {
        removeLock(lockPath);
        continue;
      }
    } else {
      const age = lockDirAgeMs(lockPath);
      if (age === null) continue; // dir vanished — retry mkdir immediately
      if (age > OWNERLESS_STALE_MS) {
        removeLock(lockPath);
        continue;
      }
    }

    const waited = Date.now() - start;
    if (waited >= timeoutMs) {
      const holder = owner ? `pid ${owner.pid} (${owner.label})` : "unknown holder";
      throw new Error(
        `Timed out after ${Math.round(waited / 1000)}s waiting for build/test lock ` +
          `${lockPath} held by ${holder}. If that process is gone, remove the lock ` +
          `directory and retry.`,
      );
    }

    if (waited - lastWaitLog >= WAIT_LOG_INTERVAL_MS) {
      lastWaitLog = waited;
      if (onWait) {
        const holder = owner ? `pid ${owner.pid} (${owner.label})` : "another process";
        onWait(`Waiting for build/test lock held by ${holder} (${Math.round(waited / 1000)}s)...`);
      }
    }

    await sleep(pollIntervalMs);
  }
}

module.exports = {
  acquireBuildTestLock,
  getDefaultLockPath,
  HELD_ENV_VAR,
  LOCK_PATH_ENV_VAR,
  TIMEOUT_ENV_VAR,
};
