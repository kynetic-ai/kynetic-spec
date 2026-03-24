/**
 * Shared type definitions for session start tests.
 *
 * These interfaces mirror the source types in src/cli/commands/session/types.ts
 * but with all SessionContext fields optional, so each test file can use only
 * the subset it needs without maintaining separate interface copies.
 */

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
}

export interface CommitSummary {
  hash: string;
  full_hash: string;
  date: string;
  message: string;
  author: string;
  task_refs: string[];
}

export interface ActivityItem {
  type: "task_completion" | "commit" | "linked_commit";
  date: string;
  commit?: CommitSummary;
  task?: CompletedTaskSummary;
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

export interface SessionContextComputed {
  inbox_untriaged_count: number;
  inbox_deferred_count: number;
  inbox_total: number;
  task_unlocks: Record<string, number>;
  recent_activity: ActivityItem[];
}

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

export interface WorkingTree {
  clean: boolean;
  staged: Array<{ status: string; path: string }>;
  unstaged: Array<{ status: string; path: string }>;
  untracked: string[];
}

/**
 * Comprehensive SessionContext with all fields optional.
 *
 * Each test file uses only the subset of fields it needs. TypeScript's
 * structural typing means kspecJson<SessionContext> will work correctly
 * even when the actual response has more fields than the test accesses.
 */
export interface SessionContext {
  generated_at?: string;
  branch?: string | null;
  active_tasks?: ActiveTaskSummary[];
  pending_review_tasks?: ActiveTaskSummary[];
  ready_tasks?: ReadyTaskSummary[];
  blocked_tasks?: BlockedTaskSummary[];
  recently_completed?: CompletedTaskSummary[];
  recent_commits?: CommitSummary[];
  activity_timeline?: ActivityItem[];
  recent_notes?: NoteSummary[];
  inbox_items?: InboxSummary[];
  inbox_stats?: InboxStats;
  observations?: Array<{ ref: string; type: string; content: string }>;
  stats?: SessionStats;
  working_tree?: WorkingTree | null;
  computed?: SessionContextComputed;
}
