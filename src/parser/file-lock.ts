/**
 * Advisory file locking for atomic read-modify-write operations.
 *
 * Uses mkdir (atomic on all platforms) to create a lock directory.
 * Prevents concurrent kspec processes from corrupting YAML files
 * during overlapping read-modify-write cycles.
 *
 * AC: Fixes race condition where concurrent task operations could
 * lose data due to non-atomic read-modify-write cycles.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 50;
const DEFAULT_MAX_HOLD_MS = 30_000;

/** The suffix appended by acquireFileLock to create the lock directory. */
const LOCK_DIR_SUFFIX = ".lock";

/**
 * Return the filesystem path of the lock directory that acquireFileLock
 * creates for a given base path. Single source of truth for the suffix
 * convention so callers (e.g. the gitignore builder) can predict the
 * directory name without hard-coding the suffix.
 */
export function getLockDirPath(filePath: string): string {
  return `${filePath}${LOCK_DIR_SUFFIX}`;
}

/**
 * Information about how a lock was acquired, particularly whether
 * it was force-reclaimed from a holder that exceeded the max hold duration.
 */
export interface FileLockAcquireInfo {
  /** True when the lock was reclaimed from an alive-but-stuck holder via duration ceiling. */
  forceReclaimed: boolean;
  /** PID of the previous holder if force-reclaimed, null otherwise. */
  previousHolderPid: number | null;
  /** How long the previous holder held the lock (ms) if force-reclaimed, null otherwise. */
  previousHoldDurationMs: number | null;
}

export interface AcquireFileLockOptions {
  /** Maximum time to wait (ms). 0 or Infinity = wait indefinitely. */
  timeoutMs?: number;
  /**
   * Maximum duration a holder may keep the lock before it becomes
   * eligible for reclamation, regardless of PID liveness.
   * Set to 0 or Infinity to disable duration-based reclamation.
   * Defaults to KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS env var, or 30000ms.
   *
   * AC: @scoped-dispatch-shadow-serialization ac-8
   */
  maxHoldMs?: number;
}

/**
 * Resolve the max-hold-duration ceiling from env or default.
 */
function resolveMaxHoldMs(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.KSPEC_SHADOW_MUTATION_LOCK_MAX_HOLD_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_HOLD_MS;
}

/** Result from stale-lock check with richer diagnostics. */
interface StaleLockResult {
  stale: boolean;
  /** True when staleness was determined by duration ceiling, not dead PID. */
  durationReclaim: boolean;
  /** PID of the holder, if parseable. */
  holderPid: number | null;
  /** How long the lock has been held (ms), if timestamp is parseable. */
  holdDurationMs: number | null;
}

/**
 * Acquire an advisory file lock using mkdir (atomic across processes).
 * Returns a release function and acquisition info (including whether the
 * lock was force-reclaimed from an alive-but-stuck holder).
 *
 * Ensures the lock directory's parent exists before attempting mkdir,
 * so callers can place directory creation inside the locked section.
 *
 * @overload Backward-compatible: acquireFileLock(path, timeoutMs?)
 * @overload Extended: acquireFileLock(path, options?)
 */
export async function acquireFileLock(
  filePath: string,
  timeoutMsOrOptions?: number | AcquireFileLockOptions,
): Promise<(() => Promise<void>) & { info: FileLockAcquireInfo }> {
  const opts: AcquireFileLockOptions =
    typeof timeoutMsOrOptions === "number"
      ? { timeoutMs: timeoutMsOrOptions }
      : (timeoutMsOrOptions ?? {});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxHoldMs = resolveMaxHoldMs(opts.maxHoldMs);

  const lockDir = getLockDirPath(filePath);
  const pidFile = path.join(lockDir, "pid");
  const deadline = timeoutMs === 0 || timeoutMs === Infinity ? Infinity : Date.now() + timeoutMs;
  const ownershipMarker = `${process.pid}\n${Date.now()}\n${randomUUID()}`;

  // Ensure parent directory exists so the lock dir can be created
  // even when the target file's directory hasn't been made yet.
  const parentDir = path.dirname(lockDir);
  await fs.mkdir(parentDir, { recursive: true });

  let acquireInfo: FileLockAcquireInfo = {
    forceReclaimed: false,
    previousHolderPid: null,
    previousHoldDurationMs: null,
  };

  while (true) {
    try {
      // mkdir with recursive:false is atomic - only one process succeeds
      await fs.mkdir(lockDir, { recursive: false });

      // Publish the pid file via temp + rename. fs.writeFile opens with
      // O_TRUNC, briefly leaving the pid file empty; a concurrent staleness
      // check seeing that empty content would treat the lock as corrupt,
      // rm the lockDir, and let two callers into the critical section.
      // Rename is atomic, so readers see ENOENT or the full marker.
      const tmpPidFile = path.join(lockDir, `pid.tmp.${randomUUID()}`);
      try {
        await fs.writeFile(tmpPidFile, ownershipMarker, "utf-8");
        await fs.rename(tmpPidFile, pidFile);
      } catch (writeErr) {
        // Roll back the lockDir so future acquirers aren't blocked by a
        // lock with no pid file (which the ENOENT path treats as notStale).
        // Best-effort: writeErr below is the primary failure; if the rollback
        // also fails, waiters hit the acquire timeout with its manual-removal
        // hint rather than deadlocking silently.
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw writeErr;
      }

      // Return release function with acquire info attached
      const release = async () => {
        try {
          const currentMarker = await fs.readFile(pidFile, "utf-8");
          if (currentMarker !== ownershipMarker) {
            return;
          }

          await fs.unlink(pidFile);
          await fs.rmdir(lockDir);
        } catch {
          // Best effort cleanup
        }
      };
      release.info = acquireInfo;
      return release as (() => Promise<void>) & { info: FileLockAcquireInfo };
    } catch (err: unknown) {
      // Lock exists - check if it's stale
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "EEXIST"
      ) {
        // AC: @scoped-dispatch-shadow-serialization ac-8, ac-10
        const staleResult = await checkStaleLock(pidFile, maxHoldMs);
        if (staleResult.stale) {
          // AC: @scoped-dispatch-shadow-serialization ac-10 — diagnostic for force-reclaim
          if (staleResult.durationReclaim) {
            acquireInfo = {
              forceReclaimed: true,
              previousHolderPid: staleResult.holderPid,
              previousHoldDurationMs: staleResult.holdDurationMs,
            };
            console.warn(
              `[file-lock] Reclaiming lock on ${filePath} from alive process ` +
                `PID ${staleResult.holderPid} (held for ${staleResult.holdDurationMs}ms, ` +
                `ceiling ${maxHoldMs}ms).`,
            );
          }

          // Remove stale lock and retry
          try {
            await fs.rm(lockDir, { recursive: true, force: true });
          } catch {
            // Another process may have already cleaned it
          }
          continue;
        }

        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for file lock on ${filePath} after ${timeoutMs}ms. ` +
              `If no other kspec process is running, remove ${lockDir} manually.`,
            { cause: err },
          );
        }

        // Wait and retry
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }

      // Unexpected error
      throw err;
    }
  }
}

/**
 * Execute a function while holding a file lock.
 * Ensures the lock is released even if the function throws.
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  timeoutMsOrOptions?: number | AcquireFileLockOptions,
): Promise<T> {
  const release = await acquireFileLock(filePath, timeoutMsOrOptions);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Check if a lock is stale. A lock is stale when:
 * 1. The holding process is dead (PID check fails), OR
 * 2. The lock has been held beyond the max-hold-duration ceiling
 *    (regardless of PID liveness).
 *
 * AC: @scoped-dispatch-shadow-serialization ac-8 — duration ceiling
 * AC: @scoped-dispatch-shadow-serialization ac-10 — alive-but-stuck reclamation
 */
async function checkStaleLock(pidFile: string, maxHoldMs: number): Promise<StaleLockResult> {
  const notStale: StaleLockResult = {
    stale: false,
    durationReclaim: false,
    holderPid: null,
    holdDurationMs: null,
  };

  try {
    const content = await fs.readFile(pidFile, "utf-8");
    const lines = content.trim().split("\n");
    const pid = parseInt(lines[0], 10);
    const timestamp = parseInt(lines[1], 10);

    if (!isNaN(pid)) {
      let pidAlive = false;
      try {
        process.kill(pid, 0); // Signal 0 = check if process exists
        pidAlive = true;
      } catch {
        // Process doesn't exist, lock is stale via dead-PID path
        return {
          stale: true,
          durationReclaim: false,
          holderPid: pid,
          holdDurationMs: !isNaN(timestamp) ? Date.now() - timestamp : null,
        };
      }

      // Never reclaim a lock from the current process. Same-process callers
      // must serialize rather than overlap critical sections.
      if (pid === process.pid) {
        return notStale;
      }

      // PID is alive — check duration ceiling
      // AC: @scoped-dispatch-shadow-serialization ac-8
      if (pidAlive && maxHoldMs > 0 && maxHoldMs !== Infinity && !isNaN(timestamp)) {
        const holdDuration = Date.now() - timestamp;
        if (holdDuration > maxHoldMs) {
          // AC: @scoped-dispatch-shadow-serialization ac-10
          return {
            stale: true,
            durationReclaim: true,
            holderPid: pid,
            holdDurationMs: holdDuration,
          };
        }
      }

      return notStale; // Process alive and within duration ceiling
    }

    // Can't parse PID — treat as stale (corrupt PID file)
    return { stale: true, durationReclaim: false, holderPid: null, holdDurationMs: null };
  } catch {
    // Can't read PID file — might be in the process of being written.
    // Don't treat as stale to avoid racing with the lock holder.
    return notStale;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
