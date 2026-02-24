/**
 * Advisory file locking for atomic read-modify-write operations.
 *
 * Uses mkdir (atomic on all platforms) to create a lock directory.
 * Prevents concurrent kspec processes from corrupting YAML files
 * during overlapping read-modify-write cycles.
 *
 * AC: Fixes race condition where concurrent task add commands could
 * lose data due to non-atomic read-modify-write in saveTask.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 50;
const STALE_LOCK_MS = 30000; // Consider locks older than 30s stale

/**
 * Acquire an advisory file lock using mkdir (atomic across processes).
 * Returns a release function that must be called when done.
 */
export async function acquireFileLock(
  filePath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<() => Promise<void>> {
  const lockDir = `${filePath}.lock`;
  const pidFile = path.join(lockDir, "pid");
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      // mkdir with recursive:false is atomic - only one process succeeds
      await fs.mkdir(lockDir, { recursive: false });

      // Write our PID for stale lock detection
      await fs.writeFile(pidFile, `${process.pid}\n${Date.now()}`, "utf-8");

      // Return release function
      return async () => {
        try {
          await fs.rm(lockDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup
        }
      };
    } catch (err: unknown) {
      // Lock exists - check if it's stale
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "EEXIST"
      ) {
        const isStale = await checkStaleLock(pidFile);
        if (isStale) {
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
  timeoutMs?: number,
): Promise<T> {
  const release = await acquireFileLock(filePath, timeoutMs);
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function checkStaleLock(pidFile: string): Promise<boolean> {
  try {
    const content = await fs.readFile(pidFile, "utf-8");
    const [pidStr, timestampStr] = content.trim().split("\n");
    const pid = parseInt(pidStr, 10);
    const timestamp = parseInt(timestampStr, 10);

    // Check age first - if lock is old enough, consider stale
    if (!isNaN(timestamp) && Date.now() - timestamp > STALE_LOCK_MS) {
      return true;
    }

    // Check if the PID is still alive
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0); // Signal 0 = check if process exists
        return false; // Process exists, lock is valid
      } catch {
        return true; // Process doesn't exist, lock is stale
      }
    }

    return false;
  } catch {
    // Can't read PID file - might be in the process of being written
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
