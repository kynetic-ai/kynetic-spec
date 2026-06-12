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
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

type OverlayEntryKind = "file" | "directory";
type BufferedFileContent = string | Uint8Array;

interface BufferedDirectoryOverlay {
  directWrites: Map<string, "file" | "deleted">;
  inferredDirectories: Set<string>;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function createNotFoundError(filePath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), {
    code: "ENOENT",
  }) as NodeJS.ErrnoException;
}

export class SyntheticDirent {
  name: string;
  readonly parentPath = "";
  readonly path = "";
  private readonly _isFile: boolean;

  constructor(name: string, isFile: boolean) {
    this.name = name;
    this._isFile = isFile;
  }

  isFile(): boolean {
    return this._isFile;
  }

  isDirectory(): boolean {
    return !this._isFile;
  }

  isBlockDevice(): boolean {
    return false;
  }

  isCharacterDevice(): boolean {
    return false;
  }

  isSymbolicLink(): boolean {
    return false;
  }

  isFIFO(): boolean {
    return false;
  }

  isSocket(): boolean {
    return false;
  }
}

/**
 * In-memory write buffer for a single batch execution.
 *
 * Maps absolute file paths to their buffered string content.
 * A null value indicates the file should be deleted on flush.
 */
let _bufferIdCounter = 0;

export class WriteBuffer {
  /** specDir this buffer is scoped to */
  readonly specDir: string;

  /** unique id for this buffer instance — used to isolate staging files */
  private readonly _id = ++_bufferIdCounter;

  /** buffered writes: path → content (null = deleted) */
  private readonly entries = new Map<string, BufferedFileContent | null>();

  /** directories to recursively remove during flush (after file operations) */
  private readonly pendingDirRemovals = new Set<string>();

  /**
   * Empty directories to materialize during flush. File writes auto-create
   * their parent chain in phase 1, so this set only needs to carry
   * directories that are intentionally empty at flush time (e.g. an
   * entity-scoped `resources/` sidecar created by a migration that has
   * no resource files to ship). The flush walks this set after renames
   * and before removals so a paired create+remove of the same directory
   * resolves to "removed", matching pendingDirRemovals' precedence.
   */
  private readonly pendingDirCreations = new Set<string>();

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
  write(filePath: string, content: BufferedFileContent): void {
    this.entries.set(path.resolve(filePath), content);
  }

  /**
   * Mark a file as deleted in the buffer.
   */
  delete(filePath: string): void {
    this.entries.set(path.resolve(filePath), null);
  }

  /**
   * Mark a directory for recursive removal during flush.
   * The removal happens after all file-level operations complete,
   * ensuring it participates in the buffer's atomicity guarantees.
   */
  deleteDirectory(dirPath: string): void {
    this.pendingDirRemovals.add(path.resolve(dirPath));
  }

  /**
   * Mark an empty directory for materialization during flush. Repeated
   * calls coalesce. File writes already auto-create their parent chain,
   * so this is only needed for directories that must exist on disk even
   * though no file inside them is being written (e.g. an entity's empty
   * `resources/` sidecar). The buffer's discard contract still applies:
   * if the buffer aborts, no directory is created.
   */
  createDirectory(dirPath: string): void {
    this.pendingDirCreations.add(path.resolve(dirPath));
  }

  /** Snapshot of pending empty-directory creations (tests/diagnostics). */
  getPendingDirCreations(): string[] {
    return [...this.pendingDirCreations];
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
  read(filePath: string): BufferedFileContent | null | undefined {
    const resolved = path.resolve(filePath);
    if (!this.entries.has(resolved)) return undefined;
    return this.entries.get(resolved)!;
  }

  /**
   * True when filePath or any ancestor directory has been deleted in the overlay.
   */
  isDeletedInOverlay(filePath: string): boolean {
    if (!this.isInScope(filePath)) return false;

    let current = path.resolve(filePath);
    while (true) {
      if (this.entries.get(current) === null || this.pendingDirRemovals.has(current)) {
        return true;
      }
      if (current === this.specDir) {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    return false;
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

  private _buildDirectoryOverlay(directory: string): BufferedDirectoryOverlay {
    const resolvedDir = path.resolve(directory);
    const directWrites = new Map<string, "file" | "deleted">();
    const inferredDirectories = new Set<string>();

    for (const [bufferedPath, content] of this.entries) {
      const relative = path.relative(resolvedDir, bufferedPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }

      const parts = relative.split(path.sep).filter(Boolean);
      if (parts.length === 0) continue;

      const rootName = parts[0];
      if (parts.length === 1) {
        directWrites.set(rootName, content === null ? "deleted" : "file");
      } else if (content !== null) {
        inferredDirectories.add(rootName);
      }
    }

    // Pending directory removals show as deleted entries in the overlay.
    for (const dirPath of this.pendingDirRemovals) {
      const relative = path.relative(resolvedDir, dirPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      const parts = relative.split(path.sep).filter(Boolean);
      if (parts.length === 1) {
        directWrites.set(parts[0], "deleted");
      }
    }

    // Pending empty-directory creations show up as inferred directories so
    // readdir during the buffer scope sees them before flush.
    for (const dirPath of this.pendingDirCreations) {
      const relative = path.relative(resolvedDir, dirPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      const parts = relative.split(path.sep).filter(Boolean);
      if (parts.length >= 1) {
        inferredDirectories.add(parts[0]);
      }
    }

    // A direct delete always wins over inferred directory presence.
    for (const [name, state] of directWrites) {
      if (state === "deleted") {
        inferredDirectories.delete(name);
      }
    }

    return { directWrites, inferredDirectories };
  }

  /**
   * List a directory with buffered entries overlaid on disk entries.
   * Used to keep batch read-after-write semantics for readdir callers.
   */
  async listDir(
    directory: string,
    options?: { withFileTypes?: boolean },
  ): Promise<string[] | Dirent[]> {
    const resolvedDir = path.resolve(directory);
    const withFileTypes = options?.withFileTypes === true;
    if (this.isDeletedInOverlay(resolvedDir)) {
      throw createNotFoundError(resolvedDir);
    }

    let diskEntries: Dirent[] = [];
    let diskMissing = false;
    try {
      diskEntries = await fs.readdir(resolvedDir, { withFileTypes: true });
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
      diskMissing = true;
    }

    const diskDirentsByName = new Map<string, Dirent>();
    const mergedKinds = new Map<string, OverlayEntryKind>();
    for (const entry of diskEntries) {
      diskDirentsByName.set(entry.name, entry);
      mergedKinds.set(entry.name, entry.isDirectory() ? "directory" : "file");
    }

    const overlay = this._buildDirectoryOverlay(resolvedDir);

    for (const [name, state] of overlay.directWrites) {
      if (state === "deleted") {
        mergedKinds.delete(name);
      } else {
        mergedKinds.set(name, "file");
      }
    }

    for (const name of overlay.inferredDirectories) {
      mergedKinds.set(name, "directory");
    }

    if (diskMissing && mergedKinds.size === 0) {
      throw createNotFoundError(resolvedDir);
    }

    const names = [...mergedKinds.keys()].toSorted((a, b) => a.localeCompare(b));
    if (!withFileTypes) {
      return names;
    }

    return names.map((name) => {
      const mergedKind = mergedKinds.get(name);
      const diskDirent = diskDirentsByName.get(name);
      if (
        mergedKind &&
        diskDirent &&
        ((mergedKind === "directory" && diskDirent.isDirectory()) ||
          (mergedKind === "file" && diskDirent.isFile()))
      ) {
        return diskDirent;
      }
      return new SyntheticDirent(name, mergedKind === "file") as unknown as Dirent;
    });
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
   * Phase 1 is fully atomic: a staging write failure means no files reach disk.
   * Phase 2 is best-effort: rename failures are reported with a detailed error, but
   * files already renamed in Phase 2 before the failure are committed. On healthy
   * filesystems, Phase 2 rename failures are extremely rare (same-device, same-dir
   * renames are near-atomic). Partial Phase 2 failure is always an explicit error,
   * never a silent commit.
   *
   * AC: @batch-write-buffer ac-3 — only buffered files are written
   * AC: @batch-write-buffer ac-7 — flush failure reported; .kspec/ not silently corrupted
   */
  async flush(): Promise<void> {
    if (
      this.entries.size === 0 &&
      this.pendingDirRemovals.size === 0 &&
      this.pendingDirCreations.size === 0
    ) {
      return;
    }

    const stagingMap = new Map<string, string>(); // real path → staging path

    // Phase 1: Write all entries to staging files
    try {
      for (const [filePath, content] of this.entries) {
        if (content === null) {
          // Deletions: record for phase 2 but no staging file needed
          stagingMap.set(filePath, "");
          continue;
        }
        const stagingPath = `${filePath}.kspec-batch-staging-${this._id}`;
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(stagingPath, content, "utf-8");
        stagingMap.set(filePath, stagingPath);
      }
    } catch (err) {
      // Staging failed — clean up staging files, nothing committed
      await this._cleanupStaging(stagingMap);
      throw new Error(
        `Batch flush staging failed: ${err instanceof Error ? err.message : err}. No files were committed.`,
        { cause: err },
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
        // Clean up remaining staging files. Best-effort: the commit error
        // below is the primary failure, and a leftover staging file is inert
        // (never read as real content), so a failed rm is safe to ignore.
        for (const [remainingPath, remainingStagingPath] of stagingMap) {
          if (!committed.includes(remainingPath) && remainingStagingPath) {
            await fs.rm(remainingStagingPath, { force: true }).catch(() => {});
          }
        }
        throw new Error(
          `Batch flush commit failed: ${err instanceof Error ? err.message : err}.\n` +
            `Committed (${committed.length}): ${committed.join(", ") || "none"}\n` +
            `Uncommitted (${uncommitted.length + (stagingMap.size - committed.length - 1)}): remaining files`,
          { cause: err },
        );
      }
    }

    // Phase 3a: Materialize intentionally-empty directories. Done after
    // file renames so any directory that would also be implicitly created
    // by a file write is a harmless no-op, and before pendingDirRemovals
    // so a paired create+remove resolves to "removed" (matching the
    // overlay precedence: deletes win).
    for (const dirPath of this.pendingDirCreations) {
      if (this.pendingDirRemovals.has(dirPath)) continue;
      await fs.mkdir(dirPath, { recursive: true });
    }

    // Phase 3b: Remove pending directories (after all file operations)
    for (const dirPath of this.pendingDirRemovals) {
      await fs.rm(dirPath, { recursive: true, force: true });
    }
  }

  /**
   * Discard the buffer without writing anything to disk.
   * AC: @batch-write-buffer ac-4
   */
  discard(): void {
    this.entries.clear();
    this.pendingDirRemovals.clear();
    this.pendingDirCreations.clear();
  }

  private async _cleanupStaging(stagingMap: Map<string, string>): Promise<void> {
    for (const [, stagingPath] of stagingMap) {
      if (stagingPath) {
        // Best-effort: the caller is already throwing the staging failure,
        // and an orphaned staging file is inert (never read as real content).
        await fs.rm(stagingPath, { force: true }).catch(() => {});
      }
    }
  }
}

// ── Async-Local Buffer Scope ─────────────────────────────────────────────────
//
// Write buffers are scoped per async context using AsyncLocalStorage.
// This ensures concurrent operations each see only their own buffer:
// - batch-exec activates a buffer for the entire batch, visible to all
//   commands dispatched within that async context
// - withWriteBuffer (TaskDataManager) activates a per-operation buffer,
//   invisible to concurrent operations on other tasks
//
// The old module-level singleton (_activeBuffer) caused a concurrency bug:
// concurrent split mutations shared a single global buffer, so one
// operation's discard() would silently lose another's successful writes.

const _bufferStorage = new AsyncLocalStorage<WriteBuffer>();

/**
 * Activate an in-memory write buffer for the given specDir.
 * Stores the buffer in the current async context so only the current
 * operation (and its descendants) see it via getActiveBatchBuffer().
 *
 * @deprecated Use `runWithBatchBuffer(specDir, fn)` instead, which scopes
 * the buffer to the callback via `AsyncLocalStorage.run()` and automatically
 * exits the scope when the callback completes. `enterWith()` permanently
 * mutates the store for the current async context and does not reliably
 * propagate cleanup across async boundaries (e.g., vitest's Promise-chain
 * test runner), causing intermittent buffer leaks.
 *
 * AC: @batch-write-buffer ac-1
 */
export function activateBatchBuffer(specDir: string): WriteBuffer {
  const buffer = new WriteBuffer(specDir);
  _bufferStorage.enterWith(buffer);
  return buffer;
}

/**
 * Deactivate the active buffer (after flush or discard).
 * Exits the async-local context so subsequent code in this async context
 * no longer sees the buffer.
 *
 * @deprecated Use `runWithBatchBuffer(specDir, fn)` instead. When using
 * `runWithBatchBuffer`, the buffer scope exits automatically when the
 * callback returns — no manual deactivation needed.
 */
export function deactivateBatchBuffer(): void {
  _bufferStorage.enterWith(undefined as unknown as WriteBuffer);
}

/**
 * Get the currently active write buffer, or null if no buffer is active
 * in the current async context.
 */
export function getActiveBatchBuffer(): WriteBuffer | null {
  return _bufferStorage.getStore() ?? null;
}

/**
 * Run an operation within an isolated write buffer scope.
 *
 * Creates a new WriteBuffer, executes the callback within an async context
 * where getActiveBatchBuffer() returns that buffer, then flushes on success
 * or discards on failure. The buffer is invisible to concurrent operations
 * running in other async contexts.
 *
 * If a buffer is already active (e.g., from batch-exec), returns null as
 * the buffer parameter to the callback, signaling that the caller should
 * reuse the existing buffer.
 *
 * AC: @batch-write-buffer ac-1 — writes buffered in memory
 * AC: @batch-write-buffer ac-4 — rollback discards buffer on failure
 */
export async function runWithBuffer<T>(
  specDir: string,
  operation: (buffer: WriteBuffer | null) => Promise<T>,
): Promise<T> {
  const existingBuffer = getActiveBatchBuffer();
  if (existingBuffer) {
    // Already in a buffer scope (batch-exec or parent withWriteBuffer).
    // Reuse it — the parent owns flush/discard lifecycle.
    return operation(null);
  }

  const buffer = new WriteBuffer(specDir);
  return _bufferStorage.run(buffer, async () => {
    try {
      const result = await operation(buffer);
      await buffer.flush();
      return result;
    } catch (error) {
      buffer.discard();
      throw error;
    }
  });
}

/**
 * Run an operation within an isolated batch write buffer scope.
 *
 * Creates a new WriteBuffer scoped to specDir and executes `fn` inside
 * `_bufferStorage.run()`, so `getActiveBatchBuffer()` returns this buffer
 * for the callback and all async descendants. The caller owns the flush/discard
 * lifecycle via the buffer passed to `fn`.
 *
 * Unlike `runWithBuffer()`, this does NOT auto-flush or auto-discard — the
 * caller is responsible for calling `buffer.flush()` or `buffer.discard()`.
 * The buffer scope is automatically exited when `fn` returns (or throws),
 * so no manual `deactivateBatchBuffer()` call is needed.
 *
 * AC: @batch-write-buffer ac-9 — concurrent isolation via AsyncLocalStorage.run()
 */
export async function runWithBatchBuffer<T>(
  specDir: string,
  fn: (buffer: WriteBuffer) => Promise<T>,
): Promise<T> {
  const buffer = new WriteBuffer(specDir);
  return _bufferStorage.run(buffer, () => fn(buffer));
}

export async function readdirBufferAware(
  directory: string,
  options?: { withFileTypes?: boolean },
): Promise<string[] | Dirent[]> {
  const buffer = getActiveBatchBuffer();
  if (buffer?.isInScope(directory)) {
    return buffer.listDir(directory, options);
  }

  if (options?.withFileTypes) {
    return fs.readdir(directory, { withFileTypes: true });
  }
  return fs.readdir(directory);
}

export async function accessBufferAware(filePath: string, mode?: number): Promise<void> {
  const buffer = getActiveBatchBuffer();
  if (buffer?.isInScope(filePath)) {
    if (buffer.isDeletedInOverlay(filePath)) {
      throw createNotFoundError(filePath);
    }

    const buffered = buffer.read(filePath);
    if (buffered === null) {
      throw createNotFoundError(filePath);
    }
    if (buffered !== undefined) {
      return;
    }

    const resolved = path.resolve(filePath);
    const prefix = `${resolved}${path.sep}`;
    for (const bufferedPath of buffer.getPaths()) {
      if (bufferedPath.startsWith(prefix) && buffer.read(bufferedPath) !== null) {
        return;
      }
    }
  }

  await fs.access(filePath, mode);
}

export async function writeFileBufferAware(
  filePath: string,
  content: BufferedFileContent,
): Promise<void> {
  const buffer = getActiveBatchBuffer();
  if (buffer?.isInScope(filePath)) {
    buffer.write(filePath, content);
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (typeof content === "string") {
    await fs.writeFile(filePath, content, "utf-8");
  } else {
    await fs.writeFile(filePath, content);
  }
}

export async function mkdirBufferAware(directoryPath: string): Promise<void> {
  const buffer = getActiveBatchBuffer();
  if (buffer?.isInScope(directoryPath)) {
    // Record the directory so it materializes on flush even when no file
    // is written under it (the file-write phase already creates parents
    // implicitly, so this is only load-bearing for intentionally-empty
    // directories like an entity's resources/ sidecar). Tracking the
    // creation also keeps the buffer's discard contract intact — an
    // aborted flush never leaves the directory behind.
    buffer.createDirectory(directoryPath);
    return;
  }

  await fs.mkdir(directoryPath, { recursive: true });
}
