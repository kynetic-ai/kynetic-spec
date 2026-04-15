/**
 * Managed-block gitignore writer for kspec transient directories.
 *
 * Maintains a sentinel-delimited block inside .gitignore so that:
 * - All kspec transient directories are enumerated in one place
 * - The block can be created or updated idempotently
 * - User content outside the block is never touched
 * - User content inside the block is preserved (never removed)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  SHADOW_WORKTREE_DIR,
  SESSIONS_WORKTREE_DIR,
  TRANSIENT_PLANS_DIR,
} from "./shadow.js";

// ── Sentinel markers ──────────────────────────────────────────────

export const MANAGED_BLOCK_START = "# >>> kspec managed";
export const MANAGED_BLOCK_END = "# <<< kspec managed";

// ── Canonical transient directory list ────────────────────────────

/**
 * Build the canonical list of transient paths that kspec may create
 * at the project root. Accepts optional overrides for the shadow
 * directory and dispatch worktree root for custom-configured projects.
 */
export function buildKspecGitignoreEntries(
  shadowDir?: string,
  worktreeRoot?: string,
): string[] {
  const dir = shadowDir ?? SHADOW_WORKTREE_DIR;
  const wtRoot = worktreeRoot ?? ".kspec-worktrees";
  const entries = [
    `${dir}/`,
    `${SESSIONS_WORKTREE_DIR}/`,
    `${TRANSIENT_PLANS_DIR}/`,
  ];
  // Only add worktree root to .gitignore when it's a relative path (inside
  // the repo). Absolute paths point outside the project root and cannot be
  // matched by .gitignore patterns, which are repository-relative.
  if (!path.isAbsolute(wtRoot)) {
    entries.push(`${wtRoot}/`);
  }
  entries.push(
    ".kspec-dispatch-workspace.json",
    ".kspec-dispatch-shadow-mutation",
  );
  return entries;
}

/**
 * Default entries using the default shadow directory (.kspec/).
 */
export const KSPEC_GITIGNORE_ENTRIES: readonly string[] =
  buildKspecGitignoreEntries();

// ── Managed block helpers ─────────────────────────────────────────

export interface ManagedBlockResult {
  /** Whether any entries were added (block created or expanded) */
  changed: boolean;
  /** Entries that were added in this invocation */
  entriesAdded: string[];
  /** Whether the managed block was newly created (vs updated) */
  blockCreated: boolean;
  /** Whether the step was skipped (file exists, no managed block, no force) */
  skipped: boolean;
  /** Path to backup file if force-created over existing file */
  backupPath?: string;
}

/**
 * Parse a gitignore file into three regions:
 * - before: lines before the managed block (or the entire file if no block)
 * - block:  lines inside the managed block (excluding sentinels)
 * - after:  lines after the managed block
 *
 * Returns null for block/after when no managed block exists.
 */
export function parseManagedBlock(content: string): {
  before: string[];
  block: string[] | null;
  after: string[] | null;
} {
  const lines = content.split("\n");
  let startIdx = -1;
  let endIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === MANAGED_BLOCK_START && startIdx === -1) {
      startIdx = i;
    } else if (trimmed === MANAGED_BLOCK_END && startIdx !== -1) {
      endIdx = i;
      break;
    }
  }

  if (startIdx === -1 || endIdx === -1) {
    // No managed block found
    return { before: lines, block: null, after: null };
  }

  return {
    before: lines.slice(0, startIdx),
    block: lines.slice(startIdx + 1, endIdx),
    after: lines.slice(endIdx + 1),
  };
}

/**
 * Serialize the three regions back into a gitignore string.
 * Ensures a trailing newline.
 */
export function serializeManagedBlock(
  before: string[],
  blockLines: string[],
  after: string[],
): string {
  const parts = [
    ...before,
    MANAGED_BLOCK_START,
    ...blockLines,
    MANAGED_BLOCK_END,
    ...after,
  ];

  let result = parts.join("\n");
  if (!result.endsWith("\n")) {
    result += "\n";
  }
  return result;
}

/**
 * Ensure all canonical kspec entries exist inside the managed block.
 *
 * Rules:
 * - If no managed block exists, create one at the end of the file
 * - If managed block exists, add any missing entries
 * - Never remove entries (even user-added ones inside the block)
 * - Returns what changed
 */
export function updateManagedBlock(
  content: string,
  entries: readonly string[] = KSPEC_GITIGNORE_ENTRIES,
): { newContent: string; result: ManagedBlockResult } {
  const parsed = parseManagedBlock(content);

  const result: ManagedBlockResult = {
    changed: false,
    entriesAdded: [],
    blockCreated: false,
    skipped: false,
  };

  if (parsed.block === null) {
    // No managed block — create one at the end
    result.blockCreated = true;
    result.changed = true;
    result.entriesAdded = [...entries];

    const before = parsed.before;
    // Ensure there's a blank line before the block if the file has content
    const hasContent = before.some((line) => line.trim().length > 0);
    if (hasContent) {
      const lastLine = before[before.length - 1];
      if (lastLine !== undefined && lastLine.trim().length > 0) {
        before.push("");
      }
    }

    const newContent = serializeManagedBlock(before, [...entries], [""]);
    return { newContent, result };
  }

  // Block exists — find missing entries
  const existingTrimmed = new Set(parsed.block.map((line) => line.trim()));
  const missing: string[] = [];

  for (const entry of entries) {
    if (!existingTrimmed.has(entry)) {
      missing.push(entry);
    }
  }

  if (missing.length === 0) {
    // All entries already present — no change
    const newContent = serializeManagedBlock(parsed.before, parsed.block, parsed.after!);
    return { newContent, result };
  }

  // Add missing entries to the block
  result.changed = true;
  result.entriesAdded = missing;

  const updatedBlock = [...parsed.block, ...missing];
  const newContent = serializeManagedBlock(parsed.before, updatedBlock, parsed.after!);
  return { newContent, result };
}

// ── File-level operations ─────────────────────────────────────────

export interface EnsureKspecGitignoreOptions {
  /** Override the shadow directory name (default: .kspec) */
  shadowDir?: string;
  /** Override the dispatch worktree root (default: .kspec-worktrees) */
  worktreeRoot?: string;
  /** Force creation of managed block even on existing file without one (backs up first) */
  force?: boolean;
}

/**
 * Ensure the root .gitignore has a managed block with all kspec entries.
 * Creates the file if it doesn't exist.
 *
 * Trait: @trait-idempotent-file-scaffold
 * - File does not exist → create with managed block ("created")
 * - File exists with managed block → update within block (add missing entries)
 * - File exists without managed block, no force → preserve byte-for-byte ("skipped")
 * - File exists without managed block, force → backup then create block
 *
 * @returns Result describing what changed
 */
export async function ensureKspecGitignore(
  projectRoot: string,
  options?: EnsureKspecGitignoreOptions,
): Promise<ManagedBlockResult> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const entries = buildKspecGitignoreEntries(options?.shadowDir, options?.worktreeRoot);
  const force = options?.force ?? false;

  let content = "";
  let fileExists = false;
  try {
    content = await fs.readFile(gitignorePath, "utf-8");
    fileExists = true;
  } catch {
    // File doesn't exist, will create
  }

  // AC: @trait-idempotent-file-scaffold ac-existing-file-preserved-without-force
  // When file exists but has no managed block and force is not set,
  // preserve the file byte-for-byte and report "skipped".
  if (fileExists) {
    const parsed = parseManagedBlock(content);
    if (parsed.block === null && !force) {
      return {
        changed: false,
        entriesAdded: [],
        blockCreated: false,
        skipped: true,
      };
    }

    // AC: @trait-idempotent-file-scaffold ac-force-backs-up-before-overwrite
    // When file exists without managed block and force is set, backup first.
    if (parsed.block === null && force) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${gitignorePath}.backup-${timestamp}`;
      await fs.copyFile(gitignorePath, backupPath);

      const { newContent, result } = updateManagedBlock(content, entries);
      if (result.changed) {
        await fs.writeFile(gitignorePath, newContent, "utf-8");
      }
      result.backupPath = backupPath;
      return result;
    }
  }

  const { newContent, result } = updateManagedBlock(content, entries);

  if (result.changed) {
    await fs.writeFile(gitignorePath, newContent, "utf-8");
  }

  return result;
}

/**
 * Check whether the managed block needs any entries added.
 * Does not modify the file.
 *
 * When force is false, files without a managed block are reported as
 * NOT needing update (they would be skipped by ensureKspecGitignore).
 */
export async function needsKspecGitignoreUpdate(
  projectRoot: string,
  options?: EnsureKspecGitignoreOptions,
): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const entries = buildKspecGitignoreEntries(options?.shadowDir, options?.worktreeRoot);
  const force = options?.force ?? false;

  let content = "";
  try {
    content = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    // File doesn't exist — definitely needs update
    return true;
  }

  // File exists without managed block and no force → would be skipped
  const parsed = parseManagedBlock(content);
  if (parsed.block === null && !force) {
    return false;
  }

  const { result } = updateManagedBlock(content, entries);
  return result.changed;
}
