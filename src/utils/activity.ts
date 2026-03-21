/**
 * Task activity — assembles task activity timelines from persisted data.
 *
 * Primary source: in-file history entries (task.yaml) and note entries (notes.yaml).
 * Fallback: lightweight git log for pre-migration tasks without history entries.
 *
 * AC: @task-activity-in-file ac-1 — timeline from persisted data without VCS queries
 * AC: @task-activity-in-file ac-2 — all changes present in chronological order
 * AC: @task-activity-in-file ac-3 — pre-migration fallback with source indication
 *
 * Legacy AC references retained for backward compatibility:
 * AC: @task-activity-git-query ac-1, ac-2 (raw extraction — legacy)
 * AC: @task-activity-git-query ac-3, ac-4 (normalization — legacy)
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HistoryEntry } from "../parser/task-data-manager.js";
import type { Note } from "../schema/task.js";

export interface RawTaskCommit {
  hash: string;
  fullHash: string;
  timestamp: string;
  author: string;
  message: string;
  diff: string;
}

/**
 * Find the line range for a task's YAML block in project.tasks.yaml.
 *
 * Uses the _ulid-first invariant (@yaml-serialization-invariants ac-1):
 * each task record starts with `- _ulid:` and the next record starts
 * with the next `- _ulid:` (or EOF).
 *
 * @returns [startLine, endLine] (1-indexed, inclusive) or null if not found
 */
export function findTaskBlockLines(
  specDir: string,
  taskUlid: string,
): [number, number] | null {
  const tasksFile = path.join(specDir, "project.tasks.yaml");
  let content: string;
  try {
    content = readFileSync(tasksFile, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  let startLine: number | null = null;
  let endLine: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("- _ulid: ")) {
      if (startLine !== null) {
        // Found the next task block — end is the line before
        endLine = i; // 0-indexed, so this is line i+1 in 1-indexed, but we want the previous
        break;
      }
      const ulid = line.slice("- _ulid: ".length).trim();
      if (ulid === taskUlid) {
        startLine = i + 1; // Convert to 1-indexed
      }
    }
  }

  if (startLine === null) return null;

  // If no next _ulid found, block extends to EOF
  if (endLine === null) {
    // Find last non-empty line
    let lastNonEmpty = lines.length;
    while (lastNonEmpty > 0 && lines[lastNonEmpty - 1].trim() === "") {
      lastNonEmpty--;
    }
    endLine = lastNonEmpty; // Already 1-indexed (length of array)
  }

  return [startLine, endLine];
}

/**
 * Query shadow branch git history for all commits that modified a task's
 * YAML block using git log -L (line range tracking).
 *
 * AC: @task-activity-git-query ac-1 — returns all commits that modified the task's data
 * AC: @task-activity-git-query ac-2 — only includes changes to the specific task's block
 *
 * @param specDir - Path to the .kspec worktree directory
 * @param taskUlid - The task's full ULID
 * @returns Array of raw commit objects in reverse chronological order (newest first)
 */
export function getRawTaskCommits(
  specDir: string,
  taskUlid: string,
): RawTaskCommit[] {
  const blockLines = findTaskBlockLines(specDir, taskUlid);
  if (!blockLines) return [];

  const [startLine, endLine] = blockLines;

  try {
    // git log -L tracks all commits that touched the specified line range.
    // This captures the complete history regardless of commit message content,
    // including manual edits, batch operations, and field reordering.
    const output = execSync(
      `git log -L ${startLine},${endLine}:project.tasks.yaml --format="%H%x00%aI%x00%an%x00%s%x00"`,
      {
        cwd: specDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024, // 10MB for large histories
      },
    );

    return parseGitLogLOutput(output);
  } catch {
    return [];
  }
}

/**
 * Parse the output of git log -L with our custom format.
 *
 * Output structure per commit:
 *   <fullHash>\0<isoDate>\0<author>\0<subject>\0\n
 *   \n
 *   diff --git a/... b/...\n
 *   --- a/...\n
 *   +++ b/...\n
 *   @@ ... @@\n
 *   <diff lines>\n
 *   \n
 *   <next commit header...>
 */
export function parseGitLogLOutput(output: string): RawTaskCommit[] {
  if (!output.trim()) return [];

  const commits: RawTaskCommit[] = [];

  // Split on the format boundary: each commit starts with a line containing NUL bytes
  // The format produces: HASH\0DATE\0AUTHOR\0SUBJECT\0
  // followed by blank line then diff output
  const lines = output.split("\n");
  let i = 0;

  while (i < lines.length) {
    // Find the next commit header (contains NUL bytes)
    if (!lines[i].includes("\x00")) {
      i++;
      continue;
    }

    const parts = lines[i].split("\x00");
    if (parts.length < 4) {
      i++;
      continue;
    }

    const [fullHash, timestamp, author, message] = parts;

    // Collect diff lines until next commit header or end
    i++;
    const diffLines: string[] = [];

    while (i < lines.length) {
      if (lines[i].includes("\x00")) break; // Next commit
      diffLines.push(lines[i]);
      i++;
    }

    // Trim leading/trailing blank lines from diff
    const diff = diffLines.join("\n").trim();

    commits.push({
      hash: fullHash.slice(0, 7),
      fullHash,
      timestamp,
      author,
      message,
      diff,
    });
  }

  return commits;
}

// ─── Activity Entry Types ───

export type ActivityType =
  | "created"
  | "started"
  | "submitted"
  | "completed"
  | "blocked"
  | "needs_work"
  | "cancelled"
  | "note_added"
  | "state_change"
  | "review_linked"
  | "field_updated"
  | "unknown";

/**
 * Source of the activity entry.
 *
 * AC: @task-activity-in-file ac-3 — indicates whether entry is from stored history
 * or best-effort recovery (git fallback).
 */
export type ActivitySource = "history" | "note" | "git_fallback" | "review";

export interface ActivityEntry {
  type: ActivityType;
  timestamp: string;
  author: string;
  summary: string;
  /** Commit hash for traceability (empty for in-file history entries) */
  commitHash: string;
  /** Additional detail (e.g., from/to for state changes, field name) */
  detail?: Record<string, string>;
  /**
   * Source of this entry: "history" for stored history entries, "note" for
   * note entries, "git_fallback" for pre-migration recovery, "review" for
   * review events. Omitted for legacy entries.
   *
   * AC: @task-activity-in-file ac-3
   */
  source?: ActivitySource;
}

// ─── Commit Message Parsing (AC: @task-activity-git-query ac-3) ───

/**
 * Map shadow branch auto-commit message patterns to activity types.
 *
 * AC: @task-activity-git-query ac-3 — operation type parsed from commit message
 */
const MESSAGE_PATTERNS: Array<{
  pattern: RegExp;
  type: ActivityType;
  summary: (match: RegExpMatchArray) => string;
}> = [
  {
    pattern: /^Start @/,
    type: "started",
    summary: () => "Task started",
  },
  {
    pattern: /^Complete @([^:]+)(?:: (.+))?$/,
    type: "completed",
    summary: (m) => (m[2] ? `Task completed: ${m[2]}` : "Task completed"),
  },
  {
    pattern: /^Note on @/,
    type: "note_added",
    summary: () => "Note added",
  },
  {
    pattern: /^Add task @/,
    type: "created",
    summary: () => "Task created",
  },
  {
    pattern: /^task-submit @/,
    type: "submitted",
    summary: () => "Task submitted for review",
  },
  {
    pattern: /^task-needs-work @/,
    type: "needs_work",
    summary: () => "Task returned for changes",
  },
  {
    pattern: /^task-block @/,
    type: "blocked",
    summary: () => "Task blocked",
  },
  {
    pattern: /^task-cancel @/,
    type: "cancelled",
    summary: () => "Task cancelled",
  },
  {
    pattern: /^task-set @|^Update @/,
    type: "field_updated",
    summary: () => "Task updated",
  },
  {
    pattern: /^batch: \d+ commands?$/,
    type: "field_updated",
    summary: (m) => m[0],
  },
  {
    pattern: /^spec-sync @/,
    type: "field_updated",
    summary: () => "Spec sync",
  },
];

/**
 * Parse a shadow branch commit message into an activity type.
 *
 * AC: @task-activity-git-query ac-3
 */
export function parseCommitMessage(message: string): {
  type: ActivityType;
  summary: string;
} {
  for (const { pattern, type, summary } of MESSAGE_PATTERNS) {
    const match = message.match(pattern);
    if (match) {
      return { type, summary: summary(match) };
    }
  }
  return { type: "unknown", summary: message };
}

// ─── Diff Parsing (AC: @task-activity-git-query ac-4) ───

interface DiffChange {
  field: string;
  oldValue?: string;
  newValue?: string;
}

/**
 * Parse YAML diff hunks to extract field-level changes.
 *
 * Identifies scalar field changes (status, priority, etc.) and array
 * insertions (notes, todos) from unified diff format.
 *
 * AC: @task-activity-git-query ac-4
 */
export function parseDiffChanges(diff: string): DiffChange[] {
  if (!diff) return [];

  const changes: DiffChange[] = [];
  const lines = diff.split("\n");

  // Track removed/added values for top-level scalar fields
  const removed = new Map<string, string>();
  const added = new Map<string, string>();

  // Track YAML map headers (keys with no scalar value, e.g. "submission_linkage:")
  // whose nested child fields should be grouped under the parent key
  const addedMaps = new Set<string>();
  const removedMaps = new Set<string>();

  // Track fields that are children of a map section (should be suppressed)
  const mapChildFields = new Set<string>();

  // Detect new note insertions (new _ulid entries under notes)
  let inNotesSection = false;
  let foundNewNote = false;

  // Track current map section context for grouping nested fields
  // When we see "+  submission_linkage:" (map header), child fields like
  // "+    branch: ..." are nested under it and should not be top-level
  let currentAddedMap: { name: string; indent: number } | null = null;
  let currentRemovedMap: { name: string; indent: number } | null = null;

  for (const line of lines) {
    // Skip diff headers
    if (
      line.startsWith("diff --git") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("@@")
    ) {
      continue;
    }

    // Context and changed lines — detect section context
    const content = line.slice(1); // Remove +/- prefix
    const trimmed = content.trimStart();
    const indent = content.length - trimmed.length;

    // Track if we're in the notes section
    if (/^\s*notes:/.test(content)) {
      inNotesSection = true;
      continue;
    }
    // Exit notes section when we hit a non-indented field
    if (inNotesSection && /^  \w/.test(content) && !content.startsWith("    ")) {
      inNotesSection = false;
    }

    if (line.startsWith("-")) {
      // Check for map header (field with no scalar value): "key:" or "key: "
      const mapHeaderMatch = trimmed.match(/^(\w[\w_]*?):\s*$/);
      if (mapHeaderMatch && !inNotesSection) {
        removedMaps.add(mapHeaderMatch[1]);
        currentRemovedMap = { name: mapHeaderMatch[1], indent };
        continue;
      }

      // Check if this is a child of a removed map section
      if (currentRemovedMap && indent > currentRemovedMap.indent) {
        mapChildFields.add(trimmed.match(/^-?\s*(\w[\w_]*?):/)?.[1] ?? "");
        continue;
      }
      // Not a child — clear map context
      currentRemovedMap = null;

      // Removed line — top-level scalar field (indented 2 spaces under list item)
      const scalarMatch = trimmed.match(/^(\w[\w_]*?):\s+(.+)$/);
      if (scalarMatch && !inNotesSection) {
        removed.set(scalarMatch[1], scalarMatch[2]);
      }
    } else if (line.startsWith("+")) {
      // Check for map header (field with no scalar value): "key:" or "key: "
      const mapHeaderMatch = trimmed.match(/^(\w[\w_]*?):\s*$/);
      if (mapHeaderMatch && !inNotesSection) {
        addedMaps.add(mapHeaderMatch[1]);
        currentAddedMap = { name: mapHeaderMatch[1], indent };
        continue;
      }

      // Check if this is a child of an added map section
      if (currentAddedMap && indent > currentAddedMap.indent) {
        mapChildFields.add(trimmed.match(/^-?\s*(\w[\w_]*?):/)?.[1] ?? "");

        // Still detect new notes inside nested sections
        if (
          inNotesSection &&
          (trimmed.startsWith("_ulid:") || trimmed.startsWith("- _ulid:"))
        ) {
          foundNewNote = true;
        }
        continue;
      }
      // Not a child — clear map context
      currentAddedMap = null;

      // Added line
      const scalarMatch = trimmed.match(/^(\w[\w_]*?):\s+(.+)$/);
      if (scalarMatch && !inNotesSection) {
        added.set(scalarMatch[1], scalarMatch[2]);
      }

      // Detect new note (_ulid added inside notes section)
      // In YAML arrays, entries start with "- _ulid:" so check both forms
      if (
        inNotesSection &&
        (trimmed.startsWith("_ulid:") || trimmed.startsWith("- _ulid:"))
      ) {
        foundNewNote = true;
      }
    } else {
      // Context line — reset map tracking
      currentAddedMap = null;
      currentRemovedMap = null;
    }
  }

  // Produce changes for scalar fields that changed (excluding map children)
  for (const [field, newValue] of added) {
    if (mapChildFields.has(field)) continue;
    const oldValue = removed.get(field);
    if (oldValue !== undefined && oldValue !== newValue) {
      changes.push({ field, oldValue, newValue });
    } else if (oldValue === undefined) {
      // Field was added (not present before)
      changes.push({ field, newValue });
    }
  }

  // Produce changes for YAML map fields
  // A map was added (null → map, or absent → map)
  for (const mapField of addedMaps) {
    const wasRemoved = removedMaps.has(mapField);
    const wasScalarNull = removed.has(mapField);
    if (wasRemoved) {
      // Map replaced with a new map (unusual but handle it)
      changes.push({ field: mapField, oldValue: "(map)", newValue: "(map)" });
    } else if (wasScalarNull) {
      // null → map (the common submission_linkage case)
      changes.push({ field: mapField, oldValue: removed.get(mapField), newValue: "(map)" });
    } else {
      // Map added where field didn't exist before
      changes.push({ field: mapField, newValue: "(map)" });
    }
  }

  // A map was removed but not re-added (map → null or map → scalar)
  for (const mapField of removedMaps) {
    if (addedMaps.has(mapField)) continue; // Already handled above
    const scalarValue = added.get(mapField);
    if (scalarValue !== undefined) {
      // map → scalar (e.g. submission_linkage map → submission_linkage: null)
      changes.push({ field: mapField, oldValue: "(map)", newValue: scalarValue });
    } else {
      // Map removed entirely
      changes.push({ field: mapField, oldValue: "(map)" });
    }
  }

  // Note insertion
  if (foundNewNote) {
    changes.push({ field: "notes", newValue: "new note added" });
  }

  return changes;
}

/**
 * Translate diff changes into typed activity entries.
 *
 * AC: @task-activity-git-query ac-4
 */
function diffChangesToEntries(
  changes: DiffChange[],
  commit: RawTaskCommit,
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const change of changes) {
    switch (change.field) {
      case "status":
        entries.push({
          type: "state_change",
          timestamp: commit.timestamp,
          author: commit.author,
          summary: `Status: ${change.oldValue ?? "—"} → ${change.newValue}`,
          commitHash: commit.hash,
          detail: {
            from: change.oldValue ?? "",
            to: change.newValue ?? "",
          },
        });
        break;

      case "notes":
        entries.push({
          type: "note_added",
          timestamp: commit.timestamp,
          author: commit.author,
          summary: "Note added",
          commitHash: commit.hash,
        });
        break;

      case "review_ref":
        entries.push({
          type: "review_linked",
          timestamp: commit.timestamp,
          author: commit.author,
          summary: `Review linked: ${change.newValue ?? ""}`,
          commitHash: commit.hash,
          detail: { ref: change.newValue ?? "" },
        });
        break;

      case "submission_linkage":
        entries.push({
          type: "submitted",
          timestamp: commit.timestamp,
          author: commit.author,
          summary: "Submission linkage captured",
          commitHash: commit.hash,
        });
        break;

      default:
        entries.push({
          type: "field_updated",
          timestamp: commit.timestamp,
          author: commit.author,
          summary: `Updated ${change.field}`,
          commitHash: commit.hash,
          detail: {
            field: change.field,
            ...(change.oldValue !== undefined && { from: change.oldValue }),
            ...(change.newValue !== undefined && { to: change.newValue }),
          },
        });
        break;
    }
  }

  return entries;
}

// ─── Main Normalizer ───

/**
 * Normalize raw git commit data into typed activity entries.
 *
 * For each commit, attempts diff-based field change detection first.
 * Falls back to commit message parsing when diff is unavailable or
 * yields no changes.
 *
 * Returns entries in chronological order (oldest first).
 *
 * AC: @task-activity-git-query ac-3 — commit message → activity type
 * AC: @task-activity-git-query ac-4 — diff → typed field changes
 */
export function normalizeTaskActivity(
  rawCommits: RawTaskCommit[],
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const commit of rawCommits) {
    // Try diff-based detection first (ac-4)
    const diffChanges = parseDiffChanges(commit.diff);

    if (diffChanges.length > 0) {
      // Diff produced typed changes — use them
      entries.push(...diffChangesToEntries(diffChanges, commit));
    } else {
      // Fall back to commit message parsing (ac-3)
      const { type, summary } = parseCommitMessage(commit.message);
      entries.push({
        type,
        timestamp: commit.timestamp,
        author: commit.author,
        summary,
        commitHash: commit.hash,
      });
    }
  }

  // Reverse: rawCommits are newest-first (git log order),
  // but activity timeline should be chronological (oldest first)
  return entries.reverse();
}

// ─── In-File Activity Timeline ───────────────────────────────────────────────

/**
 * Map a history entry command to an ActivityType.
 *
 * History entries store the kspec command that triggered the change
 * (e.g., "task-start", "task-set", "task-submit"). This maps them
 * to the same ActivityType used by the legacy git-based approach.
 */
function commandToActivityType(
  command: string,
  changes: Record<string, unknown>,
): ActivityType {
  // Status-changing commands have specific types
  switch (command) {
    case "task-add":
    case "Add task":
      return "created";
    case "task-start":
    case "Start":
      return "started";
    case "task-submit":
      return "submitted";
    case "task-complete":
    case "Complete":
      return "completed";
    case "task-block":
      return "blocked";
    case "task-needs-work":
      return "needs_work";
    case "task-cancel":
      return "cancelled";
  }

  // If the changes include a status field, it's a state change
  if ("status" in changes) {
    return "state_change";
  }

  // If the changes include review_ref, it's a review linkage
  if ("review_ref" in changes) {
    return "review_linked";
  }

  return "field_updated";
}

/**
 * Build a summary string from a history entry's changes.
 */
function historyEntryToSummary(
  command: string,
  changes: Record<string, { previous: unknown; new: unknown }>,
): string {
  const fields = Object.keys(changes);

  // Known lifecycle commands get their own summary — check these first
  // so that "task-add" with a status change says "Task created", not
  // "Status: undefined → pending".
  switch (command) {
    case "task-add":
    case "Add task":
      return "Task created";
    case "task-start":
    case "Start":
      return "Task started";
    case "task-submit":
      return "Task submitted for review";
    case "task-complete":
    case "Complete":
      return "Task completed";
    case "task-block":
      return "Task blocked";
    case "task-needs-work":
      return "Task returned for changes";
    case "task-cancel":
      return "Task cancelled";
  }

  // Single status change — show transition
  if (fields.length === 1 && fields[0] === "status") {
    const c = changes.status;
    return `Status: ${String(c.previous ?? "—")} → ${String(c.new)}`;
  }

  // For review_ref changes, include the ref
  if (fields.includes("review_ref")) {
    const ref = changes.review_ref;
    return `Review linked: ${String(ref.new ?? "")}`;
  }

  // Generic field update
  return `Updated ${fields.join(", ")}`;
}

/**
 * Convert history entries from task.yaml into ActivityEntry[].
 *
 * Each history entry records a mutation with timestamp, author, command,
 * and field-level changes. These are converted to the same ActivityEntry
 * format used throughout the CLI and daemon.
 *
 * AC: @task-activity-in-file ac-1 — field changes from stored history entries
 * AC: @task-activity-in-file ac-2 — all changes with timestamps, authors, commands, field details
 */
export function historyToActivity(history: HistoryEntry[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const entry of history) {
    const fields = Object.keys(entry.changes);
    const type = commandToActivityType(entry.command, entry.changes);
    const summary = historyEntryToSummary(
      entry.command,
      entry.changes as Record<string, { previous: unknown; new: unknown }>,
    );

    // For single-field changes, include detail with from/to values
    const detail: Record<string, string> | undefined =
      fields.length === 1
        ? {
            field: fields[0],
            ...(entry.changes[fields[0]].previous !== undefined && {
              from: String(entry.changes[fields[0]].previous),
            }),
            ...(entry.changes[fields[0]].new !== undefined && {
              to: String(entry.changes[fields[0]].new),
            }),
          }
        : undefined;

    entries.push({
      type,
      timestamp: entry.timestamp,
      author: entry.author,
      summary,
      commitHash: "",
      detail,
      source: "history",
    });
  }

  return entries;
}

/**
 * Convert note entries from notes.yaml into ActivityEntry[].
 *
 * Each note has a created_at timestamp and optional author. These become
 * "note_added" activity entries merged into the timeline.
 *
 * AC: @task-activity-in-file ac-1 — note events from stored note entries
 */
export function notesToActivity(notes: Note[]): ActivityEntry[] {
  return notes.map((note) => ({
    type: "note_added" as ActivityType,
    timestamp: note.created_at,
    author: note.author ?? "unknown",
    summary: "Note added",
    commitHash: "",
    source: "note" as ActivitySource,
  }));
}

/**
 * Assemble the full activity timeline from in-file history and notes.
 *
 * Merges history entries (field changes from task.yaml) and note entries
 * (from notes.yaml) into a single chronologically-sorted timeline.
 *
 * This is the primary activity source for tasks in split format.
 * No version control queries are executed.
 *
 * AC: @task-activity-in-file ac-1 — assembled from persisted data without VCS queries
 * AC: @task-activity-in-file ac-2 — all changes in chronological order
 *
 * @param history - History entries from task.yaml
 * @param notes - Note entries from notes.yaml
 * @returns ActivityEntry[] in chronological order (oldest first)
 */
export function assembleActivityFromFiles(
  history: HistoryEntry[],
  notes: Note[],
): ActivityEntry[] {
  const historyEntries = historyToActivity(history);
  const noteEntries = notesToActivity(notes);

  // Merge and sort chronologically (oldest first)
  const merged = [...historyEntries, ...noteEntries];
  merged.sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return merged;
}

/**
 * Lightweight git log fallback for pre-migration tasks.
 *
 * Uses `git log -- tasks/<ulid>/` which is fast (per-directory, not line-range
 * tracking). This is only used for tasks created before the storage migration
 * that lack history entries in their task.yaml.
 *
 * AC: @task-activity-in-file ac-3 — pre-migration best-effort recovery
 *
 * @param specDir - Path to the .kspec worktree directory
 * @param taskUlid - The task's full ULID
 * @returns ActivityEntry[] in chronological order, each marked with source: "git_fallback"
 */
export function getPreMigrationActivity(
  specDir: string,
  taskUlid: string,
): ActivityEntry[] {
  try {
    const output = execSync(
      `git log --format="%H%x00%aI%x00%an%x00%s%x00" -- "tasks/${taskUlid}/"`,
      {
        cwd: specDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    if (!output.trim()) return [];

    const entries: ActivityEntry[] = [];
    for (const line of output.split("\n")) {
      if (!line.includes("\x00")) continue;
      const parts = line.split("\x00");
      if (parts.length < 4) continue;

      const [fullHash, timestamp, author, message] = parts;
      const { type, summary } = parseCommitMessage(message);

      entries.push({
        type,
        timestamp,
        author,
        summary,
        commitHash: fullHash.slice(0, 7),
        source: "git_fallback",
      });
    }

    // git log returns newest-first, reverse to chronological
    return entries.reverse();
  } catch {
    return [];
  }
}
