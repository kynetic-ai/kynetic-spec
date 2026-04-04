/**
 * Task activity — assembles task activity timelines from persisted data.
 *
 * Task history comes from in-file history entries in task.yaml and note entries
 * from notes.yaml. No version control queries are used.
 *
 * AC: @task-activity-in-file ac-1 — timeline from persisted data without VCS queries
 * AC: @task-activity-in-file ac-2 — all changes present in chronological order
 * AC: @task-activity-in-file ac-3 — no git-based recovery for pre-migration tasks
 */

import type { HistoryEntry } from "../parser/task-data-manager.js";
import type { Note } from "../schema/task.js";

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
 * AC: @task-activity-in-file ac-3 — timeline entries come only from stored
 * history, notes, and linked reviews.
 */
export type ActivitySource = "history" | "note" | "review";

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
   * The originating command that produced this change (e.g. "task-start",
   * "task-set"). Present for stored-history entries; absent for notes and
   * review events.
   *
   * AC: @task-activity-in-file ac-2
   */
  command?: string;
  /**
   * Source of this entry: "history" for stored history entries, "note" for
   * note entries, and "review" for review events.
   *
   * AC: @task-activity-in-file ac-3
   */
  source?: ActivitySource;
}

/**
 * Map a history entry command to an ActivityType.
 *
 * History entries store the kspec command that triggered the change
 * (e.g., "task-start", "task-set", "task-submit").
 */
function commandToActivityType(command: string, changes: Record<string, unknown>): ActivityType {
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

  if ("status" in changes) {
    return "state_change";
  }

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

  if (fields.length === 1 && fields[0] === "status") {
    const c = changes.status;
    return `Status: ${String(c.previous ?? "—")} → ${String(c.new)}`;
  }

  if (fields.includes("review_ref")) {
    const ref = changes.review_ref;
    return `Review linked: ${String(ref.new ?? "")}`;
  }

  return `Updated ${fields.join(", ")}`;
}

/**
 * Convert history entries from task.yaml into ActivityEntry[].
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

    const detail: Record<string, string> = {};
    for (const field of fields) {
      const change = entry.changes[field];
      if (fields.length === 1) {
        detail.field = field;
        if (change.previous !== undefined) {
          detail.from = String(change.previous);
        }
        if (change.new !== undefined) {
          detail.to = String(change.new);
        }
      } else {
        if (change.previous !== undefined) {
          detail[`${field}.from`] = String(change.previous);
        }
        if (change.new !== undefined) {
          detail[`${field}.to`] = String(change.new);
        }
      }
    }

    entries.push({
      type,
      timestamp: entry.timestamp,
      author: entry.author,
      summary,
      commitHash: "",
      detail: Object.keys(detail).length > 0 ? detail : undefined,
      command: entry.command,
      source: "history",
    });
  }

  return entries;
}

/**
 * Convert note entries from notes.yaml into ActivityEntry[].
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
 * AC: @task-activity-in-file ac-1 — assembled from persisted data without VCS queries
 * AC: @task-activity-in-file ac-2 — all changes in chronological order
 * AC: @task-activity-in-file ac-3 — empty when no in-file history or notes exist
 */
export function assembleActivityFromFiles(history: HistoryEntry[], notes: Note[]): ActivityEntry[] {
  const historyEntries = historyToActivity(history);
  const noteEntries = notesToActivity(notes);

  const merged = [...historyEntries, ...noteEntries];
  merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return merged;
}
