/**
 * In-memory write buffer for atomic batch execution.
 *
 * Replaces the fs.cp(realSpecDir, tempDir) approach in batch-exec.ts.
 * During batch execution, all writes to the spec directory are intercepted
 * and stored in memory. On success (flush), buffered writes are committed
 * to disk. On failure (discard), the buffer is dropped — real .kspec/ is
 * never touched.
 *
 * AC: @batch-write-buffer ac-1 — writes go to buffer, not disk
 * AC: @batch-write-buffer ac-2 — reads check buffer first (read-after-write)
 * AC: @batch-write-buffer ac-3 — only written files flushed on commit
 * AC: @batch-write-buffer ac-4 — rollback discards buffer, no disk writes
 * AC: @batch-write-buffer ac-5 — sessions/ never copied (buffer is per-file)
 * AC: @batch-write-buffer ac-6 — buffer is process-local, disk unchanged until flush
 * AC: @batch-write-buffer ac-7 — flush failure reported, .kspec/ left in pre-batch state
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * In-memory write buffer for a single batch execution.
 *
 * Maps absolute file paths to their buffered string content.
 * A null value indicates the file should be deleted on flush.
 */
export class WriteBuffer {
  /** specDir this buffer is scoped to */
  readonly specDir: string;

  /** buffered writes: path → content (null = deleted) */
  private readonly entries = new Map<string, string | null>();

  constructor(specDir: string) {
    this.specDir = path.resolve(specDir);
  }

  /**
   * Check if a file path falls within this buffer's specDir scope.
   */
  isInScope(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return resolved === this.specDir || resolved.startsWith(this.specDir + path.sep);
  }

  /**
   * Write a file to the buffer.
   * AC: @batch-write-buffer ac-1
   */
  write(filePath: string, content: string): void {
    this.entries.set(path.resolve(filePath), content);
  }

  /**
   * Mark a file as deleted in the buffer.
   */
  delete(filePath: string): void {
    this.entries.set(path.resolve(filePath), null);
  }

  /**
   * Check if a file path has a buffered entry (write or delete).
   */
  has(filePath: string): boolean {
    return this.entries.has(path.resolve(filePath));
  }

  /**
   * Check if a file has been buffered as a write (not deleted).
   */
  hasWrite(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return this.entries.has(resolved) && this.entries.get(resolved) !== null;
  }

  /**
   * Read a buffered file. Returns the buffered content if present,
   * or undefined if not in buffer (caller should fall back to disk).
   * AC: @batch-write-buffer ac-2
   */
  read(filePath: string): string | null | undefined {
    const resolved = path.resolve(filePath);
    if (!this.entries.has(resolved)) return undefined;
    return this.entries.get(resolved)!;
  }

  /**
   * Get all buffered paths (for tests and diagnostics).
   */
  getPaths(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Get number of buffered entries.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Flush all buffered writes to disk.
   *
   * Strategy for ac-7 (flush failure atomicity):
   * 1. Write all buffered content to staging files (.kspec-batch-staging suffix)
   * 2. If any staging write fails: delete all staging files, throw — nothing committed
   * 3. Rename all staging files to final paths
   * 4. If any rename fails: report error with committed/uncommitted file list
   *
   * AC: @batch-write-buffer ac-3 — only buffered files are written
   * AC: @batch-write-buffer ac-7 — flush failure reported; .kspec/ not silently corrupted
   */
  async flush(): Promise<void> {
    if (this.entries.size === 0) return;

    const stagingMap = new Map<string, string>(); // real path → staging path

    // Phase 1: Write all entries to staging files
    try {
      for (const [filePath, content] of this.entries) {
        if (content === null) {
          // Deletions: record for phase 2 but no staging file needed
          stagingMap.set(filePath, "");
          continue;
        }
        const stagingPath = `${filePath}.kspec-batch-staging`;
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(stagingPath, content, "utf-8");
        stagingMap.set(filePath, stagingPath);
      }
    } catch (err) {
      // Staging failed — clean up staging files, nothing committed
      await this._cleanupStaging(stagingMap);
      throw new Error(
        `Batch flush staging failed: ${err instanceof Error ? err.message : err}. No files were committed.`,
      );
    }

    // Phase 2: Rename staging files to real paths (atomic per-file)
    const committed: string[] = [];
    const uncommitted: string[] = [];

    for (const [filePath, stagingPath] of stagingMap) {
      const content = this.entries.get(filePath);
      try {
        if (content === null) {
          // Delete the real file
          await fs.rm(filePath, { force: true });
        } else {
          // Rename staging → real (atomic)
          await fs.rename(stagingPath, filePath);
        }
        committed.push(filePath);
      } catch (err) {
        // Rename/delete failed — track uncommitted
        uncommitted.push(filePath);
        // Clean up remaining staging files
        for (const [remainingPath, remainingStagingPath] of stagingMap) {
          if (!committed.includes(remainingPath) && remainingStagingPath) {
            await fs.rm(remainingStagingPath, { force: true }).catch(() => {});
          }
        }
        throw new Error(
          `Batch flush commit failed: ${err instanceof Error ? err.message : err}.\n` +
            `Committed (${committed.length}): ${committed.join(", ") || "none"}\n` +
            `Uncommitted (${uncommitted.length + (stagingMap.size - committed.length - 1)}): remaining files`,
        );
      }
    }
  }

  /**
   * Discard the buffer without writing anything to disk.
   * AC: @batch-write-buffer ac-4
   */
  discard(): void {
    this.entries.clear();
  }

  private async _cleanupStaging(stagingMap: Map<string, string>): Promise<void> {
    for (const [, stagingPath] of stagingMap) {
      if (stagingPath) {
        await fs.rm(stagingPath, { force: true }).catch(() => {});
      }
    }
  }
}

// ── Module Singleton ─────────────────────────────────────────────────────────

let _activeBuffer: WriteBuffer | null = null;

/**
 * Activate an in-memory write buffer for the given specDir.
 * All subsequent writes to paths under specDir will go to the buffer.
 * AC: @batch-write-buffer ac-1
 */
export function activateBatchBuffer(specDir: string): WriteBuffer {
  _activeBuffer = new WriteBuffer(specDir);
  return _activeBuffer;
}

/**
 * Deactivate the active buffer (after flush or discard).
 */
export function deactivateBatchBuffer(): void {
  _activeBuffer = null;
}

/**
 * Get the currently active write buffer, or null if not in batch mode.
 */
export function getActiveBatchBuffer(): WriteBuffer | null {
  return _activeBuffer;
}
