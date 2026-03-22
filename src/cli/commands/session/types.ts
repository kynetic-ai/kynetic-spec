/**
 * Session command types and interfaces.
 *
 * All types used across session sub-modules live here to prevent circular dependencies.
 */

import type { ObservationType } from "../../../schema/index.js";
import type { GitWorkingTree } from "../../../utils/index.js";
import type { SessionContext as StoredSessionContext } from "../../../schema/index.js";

// ─── Session Start Types ────────────────────────────────────────────────────

export interface SessionStartContext {
  /** When this context was generated */
  generated_at: string;

  /** Current git branch */
  branch: string | null;

  /** Session context (focus, threads, questions) */
  context: StoredSessionContext | null;

  /** Tasks currently in progress */
  active_tasks: ActiveTaskSummary[];

  /** Tasks awaiting review (code done, PR pending) */
  pending_review_tasks: ActiveTaskSummary[];

  /** Recent notes from active tasks */
  recent_notes: NoteSummary[];

  /** Incomplete todos from active tasks */
  active_todos: TodoSummary[];

  /** Tasks ready to be picked up */
  ready_tasks: ReadyTaskSummary[];

  /** Blocked tasks with blockers */
  blocked_tasks: BlockedTaskSummary[];

  /** Recently completed tasks */
  recently_completed: CompletedTaskSummary[];

  /** Recent git commits */
  recent_commits: CommitSummary[];

  /** Unified activity timeline (merged tasks + commits, deduplicated) */
  activity_timeline: ActivityItem[];

  /** Working tree status */
  working_tree: GitWorkingTree | null;

  /** Inbox items awaiting triage (oldest first) */
  inbox_items: InboxSummary[];

  /** Inbox triage statistics */
  inbox_stats: InboxStats;

  /** Unresolved observations (full mode only) */
  observations: ObservationSummary[];

  /** Summary statistics */
  stats: SessionStats;

  /** Computed/derived fields aggregating other context data */
  computed: SessionContextComputed;
}

export interface ActiveTaskSummary {
  ref: string;
  slug: string | null;
  title: string;
  description: string | null;
  status: "in_progress" | "needs_work" | "pending_review";
  started_at: string | null;
  priority: number;
  spec_ref: string | null;
  note_count: number;
  last_note_at: string | null;
  todo_count: number;
  incomplete_todos: number;
}

export interface NoteSummary {
  task_ref: string;
  task_title: string;
  task_status: "in_progress" | "pending_review" | "needs_work" | "completed";
  note_ulid: string;
  created_at: string;
  author: string | null;
  content: string;
}

export interface TodoSummary {
  task_ref: string;
  task_title: string;
  id: number;
  text: string;
  added_at: string;
  added_by: string | null;
}

export interface ReadyTaskSummary {
  ref: string;
  slug: string | null;
  title: string;
  description: string | null;
  priority: number;
  spec_ref: string | null;
  tags: string[];
  unlocks: number;
}

export interface BlockedTaskSummary {
  ref: string;
  slug: string | null;
  title: string;
  description: string | null;
  blocked_by: string[];
  unmet_deps: string[];
  unlocks: number;
}

export interface CompletedTaskSummary {
  ref: string;
  slug: string | null;
  title: string;
  completed_at: string;
  closed_reason: string | null;
  origin?: "manual" | "derived" | "observation_promotion";
}

export interface CommitSummary {
  hash: string;
  full_hash: string;
  date: string;
  message: string;
  author: string;
  task_refs: string[];
}

/**
 * A single entry in the unified activity timeline.
 * Merges completed tasks and git commits into a chronological view.
 * Commits linked to tasks via Task: @slug trailer are deduplicated into combined entries.
 */
export type ActivityItem =
  | { type: "task_completion"; date: string; task: CompletedTaskSummary }
  | { type: "commit"; date: string; commit: CommitSummary }
  | {
      type: "linked_commit";
      date: string;
      commit: CommitSummary;
      task: CompletedTaskSummary;
    };

export interface SessionStats {
  total_tasks: number;
  in_progress: number;
  needs_work: number;
  pending_review: number;
  ready: number;
  blocked: number;
  completed: number;
  inbox_items: number;
}

/**
 * Computed/derived fields for JSON consumers.
 * Aggregates data from other session context fields into a single
 * convenient object. Raw source arrays are preserved unchanged.
 */
export interface SessionContextComputed {
  /** Count of inbox items with no triage record */
  inbox_untriaged_count: number;
  /** Count of inbox items triaged with 'defer' action */
  inbox_deferred_count: number;
  /** Total inbox item count */
  inbox_total: number;
  /** Map of task ref (short ULID) to count of pending tasks it unblocks */
  task_unlocks: Record<string, number>;
  /** Unified activity timeline (same as activity_timeline, for computed namespace) */
  recent_activity: ActivityItem[];
}

export interface InboxSummary {
  ref: string;
  text: string;
  created_at: string;
  tags: string[];
  added_by: string | null;
  triaged: boolean;
  triage_action: string | null;
}

export interface InboxStats {
  total: number;
  untriaged: number;
  deferred: number;
  triaged: number;
}

export interface ObservationSummary {
  ref: string;
  type: ObservationType;
  content: string;
  created_at: string;
  author: string | null;
  resolved: boolean;
  workflow_ref: string | null;
}

export interface SessionOptions {
  brief?: boolean;
  full?: boolean;
  since?: string;
  git?: boolean;
  limit?: string;
  eligible?: boolean; // Only include automation-eligible tasks in ready_tasks
}

// ─── Checkpoint Types ───────────────────────────────────────────────────────

export interface CheckpointResult {
  /** Whether session can end cleanly */
  ok: boolean;

  /** Human-readable message for Claude Code */
  message: string;

  /** Issues that need attention before stopping */
  issues: CheckpointIssue[];

  /** Instructions for the agent */
  instructions: string[];
}

export interface CheckpointIssue {
  type: "uncommitted_changes";
  description: string;
  details?: Record<string, unknown>;
}

export interface CheckpointOptions {
  force?: boolean;
  /** Set when stop hook is already active (retry after previous block) */
  stopHookActive?: boolean;
}

/** Claude Code hook input for Stop hooks */
export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
}

// ─── Iteration Stats Types ──────────────────────────────────────────────────

/**
 * Stats for tasks completed/started within a time window.
 * Used by dispatch agents to track task completions per iteration.
 */
export interface IterationStats {
  /** Number of tasks completed since the given time */
  tasks_completed: number;
  /** Number of tasks started since the given time */
  tasks_started: number;
  /** References of completed tasks */
  completed_refs: string[];
}
