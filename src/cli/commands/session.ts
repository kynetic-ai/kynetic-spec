/**
 * Session management commands
 *
 * Provides context for starting/resuming work sessions.
 */

import chalk from "chalk";
import type { Command } from "commander";
import {
  getReadyTasks,
  initContext,
  type KspecContext,
  type LoadedTask,
  loadAllItems,
  loadAllTasks,
  loadInboxItems,
  loadSessionContext,
  ReferenceIndex,
} from "../../parser/index.js";
import {
  ShadowError,
  type ShadowSyncResult,
  shadowPull,
} from "../../parser/shadow.js";
import type { SessionContext as StoredSessionContext } from "../../schema/index.js";
import {
  type SessionLogSummary,
  type SessionLogDetail,
  type SessionLogStats,
  type ToolUsageStats,
  type TimePeriodStats,
  type IterationSummary,
  type SessionSearchResult,
  type SearchMatch,
  getAllSessionLogSummaries,
  getSessionLogDetail,
  resolveSessionId,
  readEvents,
  readSessionContext,
  computeSessionLogStats,
  computeToolUsageStats,
  computeTimePeriodStats,
  listSessions,
  searchSessionEvents,
} from "../../sessions/store.js";
import type { SessionEvent, SessionStatus } from "../../sessions/types.js";
import {
  errors,
  hints,
  sessionHeaders,
  sessionPrompt,
} from "../../strings/index.js";
import {
  formatCommitGuidance,
  formatRelativeTime,
  type GitWorkingTree,
  getCurrentBranch,
  getRecentCommits,
  getWorkingTreeStatus,
  isGitRepo,
  parseTimeSpec,
} from "../../utils/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, isJsonMode, output } from "../output.js";

// ─── Types ───────────────────────────────────────────────────────────────────

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
  type: "uncommitted_changes" | "in_progress_task" | "incomplete_todo";
  description: string;
  details?: Record<string, unknown>;
}

export interface SessionContext {
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

  /** Working tree status */
  working_tree: GitWorkingTree | null;

  /** Inbox items awaiting triage (oldest first) */
  inbox_items: InboxSummary[];

  /** Summary statistics */
  stats: SessionStats;
}

export interface ActiveTaskSummary {
  ref: string;
  title: string;
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
  task_status: "in_progress" | "pending_review" | "completed";
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
  title: string;
  priority: number;
  spec_ref: string | null;
  tags: string[];
}

export interface BlockedTaskSummary {
  ref: string;
  title: string;
  blocked_by: string[];
  unmet_deps: string[];
}

export interface CompletedTaskSummary {
  ref: string;
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
}

export interface SessionStats {
  total_tasks: number;
  in_progress: number;
  pending_review: number;
  ready: number;
  blocked: number;
  completed: number;
  inbox_items: number;
}

export interface InboxSummary {
  ref: string;
  text: string;
  created_at: string;
  tags: string[];
  added_by: string | null;
}

export interface SessionOptions {
  brief?: boolean;
  full?: boolean;
  since?: string;
  git?: boolean;
  limit?: string;
  eligible?: boolean; // Only include automation-eligible tasks in ready_tasks
}

// ─── Data Gathering ──────────────────────────────────────────────────────────

function toActiveTaskSummary(
  task: LoadedTask,
  index: ReferenceIndex,
): ActiveTaskSummary {
  const lastNote =
    task.notes.length > 0 ? task.notes[task.notes.length - 1] : null;
  const incompleteTodos = task.todos.filter((t) => !t.done).length;
  return {
    ref: index.shortUlid(task._ulid),
    title: task.title,
    started_at: task.started_at || null,
    priority: task.priority,
    spec_ref: task.spec_ref || null,
    note_count: task.notes.length,
    last_note_at: lastNote ? lastNote.created_at : null,
    todo_count: task.todos.length,
    incomplete_todos: incompleteTodos,
  };
}

function toReadyTaskSummary(
  task: LoadedTask,
  index: ReferenceIndex,
): ReadyTaskSummary {
  return {
    ref: index.shortUlid(task._ulid),
    title: task.title,
    priority: task.priority,
    spec_ref: task.spec_ref || null,
    tags: task.tags,
  };
}

function toBlockedTaskSummary(
  task: LoadedTask,
  _allTasks: LoadedTask[],
  index: ReferenceIndex,
): BlockedTaskSummary {
  // Find unmet dependencies
  const unmetDeps: string[] = [];
  for (const depRef of task.depends_on) {
    const result = index.resolve(depRef);
    if (result.ok) {
      const depItem = result.item;
      if ("status" in depItem && depItem.status !== "completed") {
        unmetDeps.push(depRef);
      }
    }
  }

  return {
    ref: index.shortUlid(task._ulid),
    title: task.title,
    blocked_by: task.blocked_by,
    unmet_deps: unmetDeps,
  };
}

function toCompletedTaskSummary(
  task: LoadedTask,
  index: ReferenceIndex,
): CompletedTaskSummary {
  return {
    ref: index.shortUlid(task._ulid),
    title: task.title,
    completed_at: task.completed_at || "",
    closed_reason: task.closed_reason || null,
    origin: task.origin,
  };
}

function collectRecentNotes(
  tasks: LoadedTask[],
  index: ReferenceIndex,
  options: { limit: number; since: Date | null },
): NoteSummary[] {
  const allNotes: NoteSummary[] = [];

  for (const task of tasks) {
    // Only include notes from in_progress, pending_review, or completed tasks
    const taskStatus = task.status as "in_progress" | "pending_review" | "completed";
    if (!["in_progress", "pending_review", "completed"].includes(taskStatus)) {
      continue;
    }

    for (const note of task.notes) {
      const noteDate = new Date(note.created_at);

      // Filter by since date if provided
      if (options.since && noteDate < options.since) {
        continue;
      }

      allNotes.push({
        task_ref: index.shortUlid(task._ulid),
        task_title: task.title,
        task_status: taskStatus,
        note_ulid: note._ulid.slice(0, 8),
        created_at: note.created_at,
        author: note.author || null,
        content: note.content,
      });
    }
  }

  // Sort by date descending, take limit
  return allNotes
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .slice(0, options.limit);
}

function collectIncompleteTodos(
  tasks: LoadedTask[],
  index: ReferenceIndex,
  options: { limit: number },
): TodoSummary[] {
  const allTodos: TodoSummary[] = [];

  for (const task of tasks) {
    for (const todo of task.todos) {
      // Only include incomplete todos
      if (todo.done) continue;

      allTodos.push({
        task_ref: index.shortUlid(task._ulid),
        task_title: task.title,
        id: todo.id,
        text: todo.text,
        added_at: todo.added_at,
        added_by: todo.added_by || null,
      });
    }
  }

  // Sort by added_at descending (most recent first), take limit
  return allTodos
    .sort(
      (a, b) => new Date(b.added_at).getTime() - new Date(a.added_at).getTime(),
    )
    .slice(0, options.limit);
}

/**
 * Gather session context data
 */
export async function gatherSessionContext(
  ctx: KspecContext,
  options: SessionOptions,
): Promise<SessionContext> {
  const limit = parseInt(options.limit || "10", 10);
  const sinceDate = options.since ? parseTimeSpec(options.since) : null;
  const showGit = options.git !== false; // default true

  // Load all data
  const allTasks = await loadAllTasks(ctx);
  const items = await loadAllItems(ctx);
  const inboxItems = await loadInboxItems(ctx);
  const index = new ReferenceIndex(allTasks, items);

  // Compute stats
  const stats: SessionStats = {
    total_tasks: allTasks.length,
    in_progress: allTasks.filter((t) => t.status === "in_progress").length,
    pending_review: allTasks.filter((t) => t.status === "pending_review")
      .length,
    ready: getReadyTasks(allTasks).length,
    blocked: allTasks.filter((t) => t.status === "blocked").length,
    completed: allTasks.filter((t) => t.status === "completed").length,
    inbox_items: inboxItems.length,
  };

  // Get active tasks (optionally filtered to automation-eligible only)
  // AC: @cli-ralph ac-16
  const activeTasks = allTasks
    .filter((t) => t.status === "in_progress")
    .filter((t) => !options.eligible || t.automation === "eligible")
    .sort((a, b) => a.priority - b.priority)
    .slice(0, options.full ? undefined : limit)
    .map((t) => toActiveTaskSummary(t, index));

  // Get pending review tasks
  const pendingReviewTasks = allTasks
    .filter((t) => t.status === "pending_review")
    .sort((a, b) => a.priority - b.priority)
    .slice(0, options.full ? undefined : limit)
    .map((t) => toActiveTaskSummary(t, index));

  // Get recent notes from active, pending_review, and recently completed tasks
  // AC: @cmd-session-start ac-1, ac-2
  const recentlyCompletedForNotes = allTasks
    .filter((t) => t.status === "completed" && t.completed_at)
    .sort((a, b) => {
      const aDate = new Date(a.completed_at || 0);
      const bDate = new Date(b.completed_at || 0);
      return bDate.getTime() - aDate.getTime();
    })
    .slice(0, 5); // Last 3-5 completed tasks per AC-2

  const tasksForNotes = [
    ...allTasks.filter((t) => t.status === "in_progress"),
    ...allTasks.filter((t) => t.status === "pending_review"),
    ...recentlyCompletedForNotes,
  ];

  const recentNotes = collectRecentNotes(
    tasksForNotes,
    index,
    { limit: options.full ? limit * 2 : limit, since: sinceDate },
  );

  // Get incomplete todos from active tasks
  const activeTodos = collectIncompleteTodos(
    allTasks.filter((t) => t.status === "in_progress"),
    index,
    { limit: options.full ? limit * 2 : limit },
  );

  // Get ready tasks (optionally filtered to automation-eligible only)
  const readyTasks = getReadyTasks(allTasks)
    .filter((t) => !options.eligible || t.automation === "eligible")
    .slice(0, options.full ? undefined : limit)
    .map((t) => toReadyTaskSummary(t, index));

  // Get blocked tasks
  const blockedTasks = allTasks
    .filter((t) => t.status === "blocked")
    .slice(0, options.full ? undefined : limit)
    .map((t) => toBlockedTaskSummary(t, allTasks, index));

  // Get recently completed tasks
  const recentlyCompleted = allTasks
    .filter((t) => {
      if (t.status !== "completed" || !t.completed_at) return false;
      const completedDate = new Date(t.completed_at);
      if (sinceDate && completedDate < sinceDate) return false;
      return true;
    })
    .sort((a, b) => {
      // Sort by completed_at descending (most recent first)
      const aDate = new Date(a.completed_at || 0);
      const bDate = new Date(b.completed_at || 0);
      return bDate.getTime() - aDate.getTime();
    })
    .slice(0, options.full ? undefined : limit)
    .map((t) => toCompletedTaskSummary(t, index));

  // Get git info
  let branch: string | null = null;
  let recentCommits: CommitSummary[] = [];
  let workingTree: GitWorkingTree | null = null;

  if (showGit && isGitRepo(ctx.rootDir)) {
    branch = getCurrentBranch(ctx.rootDir);

    const commits = getRecentCommits({
      limit: options.full ? limit * 2 : limit,
      since: sinceDate || undefined,
      cwd: ctx.rootDir,
    });

    recentCommits = commits.map((c) => ({
      hash: c.hash,
      full_hash: c.fullHash,
      date: c.date.toISOString(),
      message: c.message,
      author: c.author,
    }));

    workingTree = getWorkingTreeStatus(ctx.rootDir);
  }

  // Get inbox items (oldest first to encourage triage)
  const inboxSummaries: InboxSummary[] = inboxItems
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )
    .slice(0, options.full ? undefined : limit)
    .map((item) => ({
      ref: item._ulid.slice(0, 8),
      text: item.text,
      created_at: item.created_at,
      tags: item.tags,
      added_by: item.added_by || null,
    }));

  // Load session context (focus, threads, questions)
  const sessionContext = await loadSessionContext(ctx);

  return {
    generated_at: new Date().toISOString(),
    branch,
    context: sessionContext,
    active_tasks: activeTasks,
    pending_review_tasks: pendingReviewTasks,
    recent_notes: recentNotes,
    active_todos: activeTodos,
    ready_tasks: readyTasks,
    blocked_tasks: blockedTasks,
    recently_completed: recentlyCompleted,
    recent_commits: recentCommits,
    working_tree: workingTree,
    inbox_items: inboxSummaries,
    stats,
  };
}

// ─── Iteration Stats ─────────────────────────────────────────────────────────

/**
 * Stats for tasks completed/started within a time window.
 * Used by ralph to track task completions per iteration.
 */
export interface IterationStats {
  /** Number of tasks completed since the given time */
  tasks_completed: number;
  /** Number of tasks started since the given time */
  tasks_started: number;
  /** References of completed tasks */
  completed_refs: string[];
}

/**
 * Get iteration stats - tasks completed/started since a given time.
 * AC: @ralph-task-limit ac-detection
 */
export async function getIterationStats(
  ctx: KspecContext,
  since: Date,
): Promise<IterationStats> {
  const allTasks = await loadAllTasks(ctx);

  const completedSince = allTasks.filter((t) => {
    if (t.status !== "completed" || !t.completed_at) return false;
    return new Date(t.completed_at) >= since;
  });

  const startedSince = allTasks.filter((t) => {
    if (!t.started_at) return false;
    return new Date(t.started_at) >= since;
  });

  // Use first slug or ULID prefix as ref
  const getRef = (t: LoadedTask) =>
    t.slugs.length > 0 ? `@${t.slugs[0]}` : `@${t._ulid.slice(0, 8)}`;

  return {
    tasks_completed: completedSince.length,
    tasks_started: startedSince.length,
    completed_refs: completedSince.map(getRef),
  };
}

// ─── Checkpoint ──────────────────────────────────────────────────────────────

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

/**
 * Perform session checkpoint - check for uncommitted work before ending session.
 *
 * This is designed for use as a Claude Code stop hook. It checks for:
 * - Uncommitted git changes (staged, unstaged, untracked)
 * - Tasks in in_progress status
 * - Incomplete todos on active tasks
 *
 * Returns a structured result indicating whether the session can end cleanly.
 */
export async function performCheckpoint(
  ctx: KspecContext,
  options: CheckpointOptions,
): Promise<CheckpointResult> {
  const issues: CheckpointIssue[] = [];
  const instructions: string[] = [];

  // Load tasks
  const allTasks = await loadAllTasks(ctx);

  // Check for in-progress tasks
  const inProgressTasks = allTasks.filter((t) => t.status === "in_progress");
  for (const task of inProgressTasks) {
    const ref = task.slugs[0]
      ? `@${task.slugs[0]}`
      : `@${task._ulid.slice(0, 8)}`;
    issues.push({
      type: "in_progress_task",
      description: `Task ${ref} is still in progress: ${task.title}`,
      details: {
        ref,
        title: task.title,
        started_at: task.started_at,
      },
    });

    // Check for incomplete todos on this task
    const incompleteTodos = task.todos.filter((t) => !t.done);
    for (const todo of incompleteTodos) {
      issues.push({
        type: "incomplete_todo",
        description: `Incomplete todo on ${ref}: ${todo.text}`,
        details: {
          task_ref: ref,
          todo_id: todo.id,
          text: todo.text,
        },
      });
    }
  }

  // Check for uncommitted git changes
  if (isGitRepo(ctx.rootDir)) {
    const workingTree = getWorkingTreeStatus(ctx.rootDir);
    if (!workingTree.clean) {
      const changeCount =
        workingTree.staged.length +
        workingTree.unstaged.length +
        workingTree.untracked.length;

      issues.push({
        type: "uncommitted_changes",
        description: `${changeCount} uncommitted changes in working tree`,
        details: {
          staged: workingTree.staged.length,
          unstaged: workingTree.unstaged.length,
          untracked: workingTree.untracked.length,
        },
      });
    }
  }

  // Build instructions based on issues
  if (issues.length > 0 && !options.force) {
    instructions.push(
      "If you've been instructed to ignore this message or are working on",
    );
    instructions.push(
      "unrelated things to any in progress tasks then disregard this message,",
    );
    instructions.push("otherwise before ending this session, please:");

    const hasInProgress = issues.some((i) => i.type === "in_progress_task");
    const hasUncommitted = issues.some((i) => i.type === "uncommitted_changes");
    const hasIncompleteTodos = issues.some((i) => i.type === "incomplete_todo");

    let step = 1;

    if (hasInProgress) {
      instructions.push(
        `${step++}. Read in-progress task notes to get full context of the current task status`,
      );
      instructions.push(
        `${step++}. Add notes documenting current state if any context is missing from this session`,
      );
      instructions.push(
        `${step++}. Complete the task if you've completed the objectives and no AC are left uncovered\notherwise leave it in progress for a future session`,
      );
    }

    if (hasIncompleteTodos) {
      instructions.push(
        `${step++}. Complete or acknowledge incomplete todos on active tasks`,
      );
    }

    if (hasUncommitted) {
      instructions.push(
        `${step++}. Commit your changes with a descriptive message`,
      );

      // Add WIP commit guidance if there are in-progress tasks
      if (inProgressTasks.length > 0) {
        const task = inProgressTasks[0];
        const guidance = formatCommitGuidance(task, { wip: true });
        instructions.push("");
        instructions.push("Suggested WIP commit:");
        instructions.push(`  ${guidance.message}`);
        instructions.push("");
        for (const trailer of guidance.trailers) {
          instructions.push(`  ${trailer}`);
        }
      }
    }

    instructions.push("");
    instructions.push("Use: kspec task @task to get current task state");
    instructions.push(
      'Use: kspec task note @task "Progress notes..." to document state',
    );
    instructions.push(
      'Use: kspec task complete @task --reason "Summary" if task is done',
    );
  }

  // Allow stop if:
  // - No issues found
  // - --force flag passed
  // - This is a retry (stop_hook_active = true from previous block)
  const isRetry = options.stopHookActive === true;
  const ok = issues.length === 0 || options.force === true || isRetry;

  let message: string;
  if (isRetry && issues.length > 0) {
    message = `[kspec] Session checkpoint: ${issues.length} issue(s) acknowledged - allowing stop`;
  } else if (ok) {
    message = "[kspec] Session checkpoint passed - ready to end session";
  } else {
    message = `[kspec] Session checkpoint: ${issues.length} issue(s) need attention`;
  }

  return {
    ok,
    message,
    issues,
    instructions,
  };
}

// ─── Output Formatting ───────────────────────────────────────────────────────

function formatCheckpointResult(result: CheckpointResult): void {
  if (result.ok) {
    console.log(chalk.green(result.message));
  } else {
    console.log(chalk.yellow(result.message));
    console.log("");

    for (const issue of result.issues) {
      const icon =
        issue.type === "uncommitted_changes"
          ? chalk.yellow("⚠")
          : issue.type === "in_progress_task"
            ? chalk.blue("●")
            : chalk.gray("○");
      console.log(`  ${icon} ${issue.description}`);
    }

    if (result.instructions.length > 0) {
      console.log("");
      for (const instruction of result.instructions) {
        console.log(chalk.gray(instruction));
      }
    }
  }
}

function formatSessionContext(
  ctx: SessionContext,
  options: SessionOptions,
): void {
  const isBrief = !options.full;

  // Header
  console.log(`\n${sessionHeaders.title}`);
  const age = formatRelativeTime(new Date(ctx.generated_at));
  if (ctx.branch) {
    console.log(chalk.gray(`Branch: ${ctx.branch} | Generated: ${age}`));
  } else {
    console.log(chalk.gray(`Generated: ${age}`));
  }

  // Stats summary
  const pendingReviewNote =
    ctx.stats.pending_review > 0
      ? `${ctx.stats.pending_review} awaiting review, `
      : "";
  const inboxNote =
    ctx.stats.inbox_items > 0 ? ` | Inbox: ${ctx.stats.inbox_items}` : "";
  console.log(
    chalk.gray(
      `Tasks: ${ctx.stats.in_progress} active, ${pendingReviewNote}${ctx.stats.ready} ready, ` +
        `${ctx.stats.blocked} blocked, ${ctx.stats.completed}/${ctx.stats.total_tasks} completed${inboxNote}`,
    ),
  );

  // Session context section (focus, threads, questions)
  if (
    ctx.context &&
    (ctx.context.focus ||
      ctx.context.threads.length > 0 ||
      ctx.context.open_questions.length > 0)
  ) {
    console.log("\n--- Session Context ---");

    if (ctx.context.focus) {
      console.log(`  ${chalk.cyan("Focus:")} ${ctx.context.focus}`);
    }

    if (ctx.context.threads.length > 0) {
      console.log(`  ${chalk.cyan("Active Threads:")}`);
      for (const thread of ctx.context.threads) {
        console.log(`    - ${thread}`);
      }
    }

    if (ctx.context.open_questions.length > 0) {
      console.log(`  ${chalk.cyan("Open Questions:")}`);
      for (const question of ctx.context.open_questions) {
        console.log(`    - ${question}`);
      }
    }
  }

  // Active tasks section
  if (ctx.active_tasks.length > 0) {
    console.log(`\n${sessionHeaders.activeWork}`);
    for (const task of ctx.active_tasks) {
      const started = task.started_at
        ? chalk.gray(
            ` (started ${formatRelativeTime(new Date(task.started_at))})`,
          )
        : "";
      const priority =
        task.priority <= 2
          ? chalk.red(`P${task.priority}`)
          : chalk.gray(`P${task.priority}`);
      console.log(
        `  ${chalk.blue("[in_progress]")} ${priority} ${task.ref} ${task.title}${started}`,
      );
    }
  } else {
    console.log(`\n${sessionHeaders.noActiveWork}`);
  }

  // Awaiting review section
  if (ctx.pending_review_tasks.length > 0) {
    console.log(`\n${sessionHeaders.awaitingReview}`);
    for (const task of ctx.pending_review_tasks) {
      const priority =
        task.priority <= 2
          ? chalk.red(`P${task.priority}`)
          : chalk.gray(`P${task.priority}`);
      console.log(
        `  ${chalk.yellow("[pending_review]")} ${priority} ${task.ref} ${task.title}`,
      );
    }
  }

  // Recently completed section
  if (ctx.recently_completed.length > 0) {
    console.log(`\n${sessionHeaders.recentlyCompleted}`);
    const observationPromotedTasks: string[] = [];
    for (const task of ctx.recently_completed) {
      const completedAge = formatRelativeTime(new Date(task.completed_at));
      let reason = "";
      if (task.closed_reason) {
        const maxLen = isBrief ? 60 : 120;
        const truncated =
          task.closed_reason.length > maxLen
            ? `${task.closed_reason.slice(0, maxLen).trim()}...`
            : task.closed_reason;
        reason = chalk.gray(` - ${truncated}`);
      }
      console.log(
        `  ${chalk.green("[completed]")} ${task.ref} ${task.title} ${chalk.gray(`(${completedAge})`)}${reason}`,
      );

      // Track tasks that came from observations
      if (task.origin === "observation_promotion") {
        observationPromotedTasks.push(task.ref);
      }
    }

    // Show reminder about resolving observations
    if (observationPromotedTasks.length > 0) {
      console.log(
        chalk.yellow(
          `\n  ℹ Consider resolving linked observations: ${observationPromotedTasks.join(", ")}`,
        ),
      );
      console.log(
        chalk.gray(`    Run: kspec meta observations --pending-resolution`),
      );
    }
  }

  // Recent notes section - grouped by task status
  // AC: @cmd-session-start ac-1, ac-2
  if (ctx.recent_notes.length > 0) {
    console.log(`\n${sessionHeaders.recentNotes}`);

    // Group notes by task status
    const inProgressNotes = ctx.recent_notes.filter(
      (n) => n.task_status === "in_progress",
    );
    const pendingReviewNotes = ctx.recent_notes.filter(
      (n) => n.task_status === "pending_review",
    );
    const completedNotes = ctx.recent_notes.filter(
      (n) => n.task_status === "completed",
    );

    // Helper to format a single note
    const formatNote = (note: NoteSummary) => {
      const age = formatRelativeTime(new Date(note.created_at));
      const author = note.author ? chalk.gray(` by ${note.author}`) : "";
      console.log(`    ${chalk.yellow(age)} on ${note.task_ref}${author}:`);

      // Truncate content in brief mode
      let content = note.content.trim();
      if (isBrief && content.length > 200) {
        content = `${content.slice(0, 200).trim()}...`;
      }

      // Indent content, limit lines in brief mode
      const lines = content.split("\n");
      const maxLines = isBrief ? 3 : lines.length;
      for (const line of lines.slice(0, maxLines)) {
        console.log(`      ${chalk.white(line)}`);
      }
      if (isBrief && lines.length > maxLines) {
        console.log(
          chalk.gray(`      ... (${lines.length - maxLines} more lines)`),
        );
      }
    };

    // AC: @cmd-session-start ac-1 - In Progress notes
    if (inProgressNotes.length > 0) {
      console.log(`  ${chalk.blue("In Progress:")}`);
      for (const note of inProgressNotes) {
        formatNote(note);
      }
    }

    // AC: @cmd-session-start ac-1 - Pending Review notes (grouped separately)
    if (pendingReviewNotes.length > 0) {
      console.log(`  ${chalk.yellow("Pending Review:")}`);
      for (const note of pendingReviewNotes) {
        formatNote(note);
      }
    }

    // AC: @cmd-session-start ac-2 - Recently Completed notes
    if (completedNotes.length > 0) {
      console.log(`  ${chalk.green("Recently Completed:")}`);
      for (const note of completedNotes) {
        formatNote(note);
      }
    }
  }

  // Incomplete todos section
  if (ctx.active_todos.length > 0) {
    console.log(`\n${sessionHeaders.incompleteTodos}`);
    for (const todo of ctx.active_todos) {
      console.log(
        `  ${chalk.yellow("[ ]")} ${todo.task_ref}#${todo.id}: ${todo.text}`,
      );
    }
  }

  // Ready tasks section
  if (ctx.ready_tasks.length > 0) {
    console.log(`\n${sessionHeaders.readyTasks}`);
    for (const task of ctx.ready_tasks) {
      const priority =
        task.priority <= 2
          ? chalk.red(`P${task.priority}`)
          : chalk.gray(`P${task.priority}`);
      const tags =
        task.tags.length > 0 ? chalk.cyan(` #${task.tags.join(" #")}`) : "";
      console.log(`  ${priority} ${task.ref} ${task.title}${tags}`);
    }
  }

  // Blocked tasks section
  if (ctx.blocked_tasks.length > 0) {
    console.log(`\n${sessionHeaders.blocked}`);
    for (const task of ctx.blocked_tasks) {
      console.log(`  ${chalk.red("[blocked]")} ${task.ref} ${task.title}`);
      if (task.blocked_by.length > 0) {
        console.log(chalk.gray(`    Blockers: ${task.blocked_by.join(", ")}`));
      }
      if (task.unmet_deps.length > 0) {
        console.log(
          chalk.gray(`    Waiting on: ${task.unmet_deps.join(", ")}`),
        );
      }
    }
  }

  // Git commits section
  if (ctx.recent_commits.length > 0) {
    console.log(`\n${sessionHeaders.recentCommits}`);
    for (const commit of ctx.recent_commits) {
      const age = formatRelativeTime(new Date(commit.date));
      console.log(
        `  ${chalk.yellow(commit.hash)} ${commit.message} ${chalk.gray(`(${age}, ${commit.author})`)}`,
      );
    }
  }

  // Inbox section (oldest first to encourage triage)
  if (ctx.inbox_items.length > 0) {
    console.log(`\n${sessionHeaders.inbox}`);
    for (const item of ctx.inbox_items) {
      const age = formatRelativeTime(new Date(item.created_at));
      const author = item.added_by ? ` by ${item.added_by}` : "";
      const tags =
        item.tags.length > 0 ? chalk.cyan(` [${item.tags.join(", ")}]`) : "";
      // Truncate text in brief mode
      let text = item.text;
      if (isBrief && text.length > 60) {
        text = `${text.slice(0, 60).trim()}...`;
      }
      console.log(
        `  ${chalk.magenta(item.ref)} ${chalk.gray(`(${age}${author})`)}${tags}`,
      );
      console.log(`    ${text}`);
    }
    console.log(`  ${hints.inboxPromote}`);
  }

  // Working tree section
  if (ctx.working_tree && !ctx.working_tree.clean) {
    console.log(`\n${sessionHeaders.workingTree}`);

    if (ctx.working_tree.staged.length > 0) {
      console.log(chalk.green("  Staged:"));
      for (const file of ctx.working_tree.staged) {
        console.log(
          `    ${chalk.green(file.status[0].toUpperCase())} ${file.path}`,
        );
      }
    }

    if (ctx.working_tree.unstaged.length > 0) {
      console.log(chalk.red("  Modified:"));
      for (const file of ctx.working_tree.unstaged) {
        console.log(
          `    ${chalk.red(file.status[0].toUpperCase())} ${file.path}`,
        );
      }
    }

    if (ctx.working_tree.untracked.length > 0) {
      console.log(chalk.gray("  Untracked:"));
      const limit = isBrief ? 5 : ctx.working_tree.untracked.length;
      for (const path of ctx.working_tree.untracked.slice(0, limit)) {
        console.log(`    ${chalk.gray("?")} ${path}`);
      }
      if (isBrief && ctx.working_tree.untracked.length > limit) {
        console.log(
          chalk.gray(
            `    ... and ${ctx.working_tree.untracked.length - limit} more`,
          ),
        );
      }
    }
  } else if (ctx.working_tree?.clean) {
    console.log(`\n${sessionHeaders.workingTreeClean}`);
  }

  // Quick Commands section - contextual hints based on state
  const quickCommands: string[] = [];

  if (ctx.active_tasks.length > 0) {
    const ref = ctx.active_tasks[0].ref;
    quickCommands.push(
      `kspec task note @${ref} "Progress..."  ${chalk.gray("# document work")}`,
    );
    quickCommands.push(
      `kspec task complete @${ref} --reason "..."  ${chalk.gray("# finish task")}`,
    );
  } else if (ctx.ready_tasks.length > 0) {
    const ref = ctx.ready_tasks[0].ref;
    quickCommands.push(
      `kspec task start @${ref}  ${chalk.gray("# begin work")}`,
    );
  }

  if (ctx.inbox_items.length > 0) {
    const ref = ctx.inbox_items[0].ref;
    quickCommands.push(
      `kspec inbox promote @${ref} --title "..."  ${chalk.gray("# convert to task")}`,
    );
  }

  if (ctx.working_tree && !ctx.working_tree.clean) {
    quickCommands.push(
      `git add . && git commit -m "..."  ${chalk.gray("# commit changes")}`,
    );
  }

  if (quickCommands.length > 0) {
    console.log(`\n${sessionHeaders.quickCommands}`);
    for (const hint of quickCommands) {
      console.log(`  ${hint}`);
    }
  }

  console.log(""); // Final newline
}

// ─── Command Registration ────────────────────────────────────────────────────

async function sessionStartAction(options: SessionOptions): Promise<void> {
  try {
    const ctx = await initContext();

    // AC: @shadow-sync ac-2 - Pull remote changes before showing session context
    let syncResult: ShadowSyncResult | null = null;
    if (ctx.shadow?.enabled) {
      syncResult = await shadowPull(ctx.shadow.worktreeDir);
      // AC: @shadow-sync ac-3 - Warn about conflicts but continue with local state
      if (syncResult.hadConflict) {
        console.log(
          chalk.yellow(
            "⚠ Shadow sync conflict detected. Run `kspec shadow resolve` to fix.",
          ),
        );
        console.log(chalk.gray("  Continuing with local state..."));
        console.log("");
      } else if (syncResult.pulled) {
        console.log(chalk.gray("ℹ Synced shadow branch from remote"));
      }
    }

    const sessionCtx = await gatherSessionContext(ctx, options);

    output(sessionCtx, () => formatSessionContext(sessionCtx, options));
  } catch (err) {
    error(errors.failures.gatherSessionContext, err);
    process.exit(EXIT_CODES.ERROR);
  }
}

/**
 * Read stdin if available (non-blocking check for hook input)
 */
async function readStdinIfAvailable(): Promise<string | null> {
  // Check if stdin is a TTY (interactive) - if so, don't try to read
  if (process.stdin.isTTY) {
    return null;
  }

  return new Promise((resolve) => {
    let data = "";
    const timeout = setTimeout(() => {
      process.stdin.removeAllListeners();
      resolve(data || null);
    }, 100); // 100ms timeout for stdin

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      resolve(data || null);
    });
    process.stdin.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
    process.stdin.resume();
  });
}

/**
 * Parse Claude Code hook input from stdin
 */
function parseHookInput(stdin: string | null): StopHookInput | null {
  if (!stdin) return null;
  try {
    return JSON.parse(stdin.trim()) as StopHookInput;
  } catch {
    return null;
  }
}

// ─── Prompt Check (UserPromptSubmit Hook) ────────────────────────────────────

/**
 * Output spec-first reminder for UserPromptSubmit hook.
 *
 * This is a simple context injection - always outputs the reminder,
 * and Claude (Opus) is smart enough to apply it when relevant.
 */
async function sessionPromptCheckAction(): Promise<void> {
  // Lean, instructive reminder with kspec prefix
  console.log(sessionPrompt.specCheck);
}

async function sessionCheckpointAction(
  options: CheckpointOptions,
): Promise<void> {
  try {
    // Read stdin for Claude Code hook input
    const stdin = await readStdinIfAvailable();
    const hookInput = parseHookInput(stdin);

    // Check if this is a retry (stop hook already active)
    if (hookInput?.stop_hook_active) {
      options.stopHookActive = true;
    }

    const ctx = await initContext();
    const result = await performCheckpoint(ctx, options);

    // Output format depends on mode:
    // - JSON mode (--json): Output Claude Code hook format {"decision": "block", "reason": "..."}
    // - Human mode: Output formatted checkpoint result
    if (isJsonMode()) {
      if (!result.ok) {
        // Build reason message with issues and instructions
        const issueLines = result.issues
          .map((i) => `- ${i.description}`)
          .join("\n");
        const instructionLines = result.instructions
          .filter((i) => i.trim())
          .join("\n");
        const reason = `${result.message}\n\nIssues:\n${issueLines}\n\n${instructionLines}`;
        console.log(JSON.stringify({ decision: "block", reason }));
      }
      // If ok, exit silently (Claude Code expects no output when allowing stop)
    } else {
      formatCheckpointResult(result);
      if (!result.ok) {
        process.exit(EXIT_CODES.ERROR);
      }
    }
  } catch (err) {
    // Handle RUNNING_FROM_SHADOW gracefully - skip with warning instead of erroring
    // This happens when the stop hook runs while cwd is inside .kspec/ directory
    if (err instanceof ShadowError && err.code === "RUNNING_FROM_SHADOW") {
      if (!isJsonMode()) {
        console.log(
          chalk.yellow(
            "[kspec] Session checkpoint skipped - running from inside .kspec/ directory",
          ),
        );
      }
      // Allow stop to proceed (exit successfully, no JSON output blocks the stop)
      return;
    }
    error(errors.failures.runCheckpoint, err);
    process.exit(EXIT_CODES.ERROR);
  }
}

// ─── Session Log List ─────────────────────────────────────────────────────────

interface SessionLogListOptions {
  status?: string;
  agent?: string;
  since?: string;
  sort?: string;
  count?: boolean;
  limit?: string;
}

type SortField =
  | "started_at"
  | "duration"
  | "events"
  | "iterations"
  | "tasks_completed";

const VALID_SORT_FIELDS: SortField[] = [
  "started_at",
  "duration",
  "events",
  "iterations",
  "tasks_completed",
];

/**
 * Format a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${totalSec}s`;
}

/**
 * Sort session summaries by the specified field.
 * Default: started_at descending.
 *
 * AC: @session-log-list ac-5
 */
function sortSessions(
  sessions: SessionLogSummary[],
  sortField: SortField,
): SessionLogSummary[] {
  return [...sessions].sort((a, b) => {
    switch (sortField) {
      case "started_at":
        return (
          new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
        );
      case "duration":
        return b.duration_ms - a.duration_ms;
      case "events":
        return b.event_count - a.event_count;
      case "iterations":
        return b.iteration_count - a.iteration_count;
      case "tasks_completed":
        return b.tasks_completed - a.tasks_completed;
      default:
        return (
          new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
        );
    }
  });
}

/**
 * Format the session log list as a table.
 *
 * AC: @session-log-list ac-1
 */
function formatSessionLogList(sessions: SessionLogSummary[]): void {
  if (sessions.length === 0) {
    // AC: @session-log-list ac-6
    console.log("No sessions found.");
    return;
  }

  // Table header
  console.log(
    chalk.gray(
      `${"ID".padEnd(10)} ${"Status".padEnd(11)} ${"Agent".padEnd(20)} ${"Started".padEnd(16)} ${"Duration".padEnd(10)} ${"Events".padEnd(8)} ${"Iters".padEnd(7)} Tasks`,
    ),
  );
  console.log(chalk.gray("─".repeat(95)));

  for (const s of sessions) {
    const id = s.id.slice(0, 8);
    const statusColor =
      s.status === "completed"
        ? chalk.green
        : s.status === "active"
          ? chalk.blue
          : chalk.yellow;
    const status = statusColor(s.status.padEnd(11));
    const agent = s.agent_type.slice(0, 20).padEnd(20);
    const started = formatRelativeTime(new Date(s.started_at)).padEnd(16);
    const duration = formatDuration(s.duration_ms).padEnd(10);
    const events = String(s.event_count).padEnd(8);
    const iters = String(s.iteration_count).padEnd(7);
    const tasks = String(s.tasks_completed);

    console.log(
      `${chalk.yellow(id)} ${status} ${chalk.gray(agent)} ${chalk.gray(started)} ${duration} ${events} ${iters} ${tasks}`,
    );
  }

  console.log(chalk.gray(`\n${sessions.length} session(s)`));
}

/**
 * Session log list action handler.
 */
async function sessionLogListAction(
  options: SessionLogListOptions,
): Promise<void> {
  try {
    const ctx = await initContext();
    let sessions = await getAllSessionLogSummaries(ctx.specDir);

    // AC: @session-log-list ac-2 - Filter by status
    if (options.status) {
      const statusFilter = options.status as SessionStatus;
      sessions = sessions.filter((s) => s.status === statusFilter);
    }

    // AC: @session-log-list ac-4 - Filter by agent type
    if (options.agent) {
      const agentFilter = options.agent;
      sessions = sessions.filter((s) => s.agent_type === agentFilter);
    }

    // AC: @session-log-list ac-3 - Filter by since date
    if (options.since) {
      const sinceDate = parseTimeSpec(options.since);
      if (sinceDate) {
        sessions = sessions.filter(
          (s) => new Date(s.started_at) >= sinceDate,
        );
      }
    }

    // AC: @session-log-list ac-5 - Sort
    const sortField: SortField =
      options.sort && VALID_SORT_FIELDS.includes(options.sort as SortField)
        ? (options.sort as SortField)
        : "started_at";
    sessions = sortSessions(sessions, sortField);

    // AC: @session-log-list ac-7 - Limit output count
    if (options.count) {
      // AC: @trait-filterable-list ac-8
      output({ count: sessions.length }, () => {
        console.log(sessions.length);
      });
      return;
    }

    // Apply --limit (after filtering/sorting, before display)
    if (options.limit) {
      const limit = parseInt(options.limit, 10);
      if (!Number.isNaN(limit) && limit > 0) {
        sessions = sessions.slice(0, limit);
      }
    }

    output(sessions, () => formatSessionLogList(sessions));
  } catch (err) {
    error("Failed to list session logs", err);
    process.exit(EXIT_CODES.ERROR);
  }
}

// ─── Session Log Show ─────────────────────────────────────────────────────────

interface SessionLogShowOptions {
  events?: boolean;
  type?: string;
  limit?: string;
  context?: string;
}

/**
 * Format an event timestamp as relative time from session start.
 */
function formatEventTimestamp(
  eventTs: number,
  sessionStartTs: number,
): string {
  const relativeMs = eventTs - sessionStartTs;
  const totalSec = Math.floor(relativeMs / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) {
    return `+${minutes}m${seconds}s`;
  }
  return `+${seconds}s`;
}

/**
 * Summarize event data for display.
 * Returns a short string describing the event payload.
 */
function summarizeEventData(event: SessionEvent): string {
  const data = event.data as Record<string, unknown> | null;
  if (!data) return "";

  // Handle tool_call events
  if (event.type === "session.update") {
    const update = data.update as {
      sessionUpdate?: string;
      rawInput?: { command?: string };
      _meta?: { claudeCode?: { toolName?: string } };
    } | null;
    if (update?.sessionUpdate === "tool_call") {
      const toolName = update._meta?.claudeCode?.toolName || "unknown";
      const command = update.rawInput?.command;
      if (command) {
        const truncated =
          command.length > 60 ? command.slice(0, 57) + "..." : command;
        return `${toolName}: ${truncated}`;
      }
      return toolName;
    }
  }

  // Handle prompt.sent events
  if (event.type === "prompt.sent") {
    const prompt = data.prompt as string | null;
    if (prompt) {
      const truncated =
        prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
      return truncated;
    }
  }

  // Handle session.start/end
  if (event.type === "session.start") {
    return "Session started";
  }
  if (event.type === "session.end") {
    const reason = data.reason as string | null;
    return reason ? `Session ended: ${reason}` : "Session ended";
  }

  // Default: show first key
  const keys = Object.keys(data);
  if (keys.length > 0) {
    return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", ..." : ""}}`;
  }
  return "";
}

/**
 * Format the session log show output.
 *
 * AC: @session-log-show ac-1
 */
function formatSessionLogShow(
  detail: SessionLogDetail,
  events: SessionEvent[] | null,
  contextSnapshot: unknown | null,
  sessionStartTs: number,
): void {
  // AC: @session-log-show ac-1 - Session metadata
  console.log(chalk.bold(`Session ${detail.id.slice(0, 8)}`));
  console.log(chalk.gray("─".repeat(60)));
  console.log(`  ID:        ${detail.id}`);

  const statusColor =
    detail.status === "completed"
      ? chalk.green
      : detail.status === "active"
        ? chalk.blue
        : chalk.yellow;
  console.log(`  Status:    ${statusColor(detail.status)}`);
  console.log(`  Agent:     ${detail.agent_type}`);
  if (detail.task_id) {
    console.log(`  Task:      ${detail.task_id}`);
  }
  console.log(`  Started:   ${detail.started_at}`);
  if (detail.ended_at) {
    console.log(`  Ended:     ${detail.ended_at}`);
  }
  console.log(`  Duration:  ${formatDuration(detail.duration_ms)}`);
  console.log(`  Events:    ${detail.event_count}`);
  console.log(`  Iterations: ${detail.iteration_count}`);

  // AC: @session-log-show ac-2 - Per-iteration summary
  if (detail.iterations.length > 0) {
    console.log("\n" + chalk.bold("Iterations"));
    console.log(chalk.gray("─".repeat(60)));
    for (const iter of detail.iterations) {
      const taskInfo: string[] = [];
      if (iter.tasks_started.length > 0) {
        taskInfo.push(`started: ${iter.tasks_started.join(", ")}`);
      }
      if (iter.tasks_completed.length > 0) {
        taskInfo.push(`completed: ${iter.tasks_completed.join(", ")}`);
      }
      const taskStr = taskInfo.length > 0 ? ` | ${taskInfo.join(" | ")}` : "";
      console.log(
        `  ${chalk.cyan(`[${iter.iteration}]`)} ${iter.event_count} events${taskStr}`,
      );
    }
  }

  // AC: @session-log-show ac-3 - Event timeline
  if (events !== null) {
    console.log("\n" + chalk.bold("Events"));
    console.log(chalk.gray("─".repeat(60)));
    if (events.length === 0) {
      console.log(chalk.gray("  No events to display."));
    } else {
      for (const event of events) {
        const timestamp = formatEventTimestamp(event.ts, sessionStartTs);
        const summary = summarizeEventData(event);
        const typeColor =
          event.type === "session.start" || event.type === "session.end"
            ? chalk.green
            : event.type === "session.update"
              ? chalk.blue
              : chalk.gray;
        console.log(
          `  ${chalk.yellow(timestamp.padEnd(10))} ${typeColor(event.type.padEnd(16))} ${chalk.gray(summary)}`,
        );
      }
    }
  }

  // AC: @session-log-show ac-6 - Context snapshot
  if (contextSnapshot !== null) {
    console.log("\n" + chalk.bold("Context Snapshot"));
    console.log(chalk.gray("─".repeat(60)));
    console.log(JSON.stringify(contextSnapshot, null, 2));
  }
}

/**
 * Session log show action handler.
 */
async function sessionLogShowAction(
  sessionRef: string,
  options: SessionLogShowOptions,
): Promise<void> {
  try {
    const ctx = await initContext();

    // AC: @session-log-show ac-7, ac-8, ac-9 - Resolve session ID
    const resolution = await resolveSessionId(ctx.specDir, sessionRef);

    if (!resolution.ok) {
      if (resolution.error === "not_found") {
        // AC: @session-log-show ac-9
        error(`Session not found: ${sessionRef}`);
        process.exit(EXIT_CODES.NOT_FOUND);
      } else {
        // AC: @session-log-show ac-8
        error(
          `Ambiguous session ID prefix. Matches:\n  ${resolution.matches.join("\n  ")}\nPlease provide a more specific prefix.`,
        );
        process.exit(EXIT_CODES.VALIDATION_FAILED);
      }
    }

    const sessionId = resolution.id;

    // Get session detail
    const detail = await getSessionLogDetail(ctx.specDir, sessionId);
    if (!detail) {
      error(`Session not found: ${sessionId}`);
      process.exit(EXIT_CODES.NOT_FOUND);
    }

    // AC: @session-log-show ac-3, ac-4, ac-5 - Event timeline
    let events: SessionEvent[] | null = null;
    if (options.events) {
      let allEvents = await readEvents(ctx.specDir, sessionId);

      // AC: @session-log-show ac-4 - Filter by type
      if (options.type) {
        const typeFilter = options.type;
        allEvents = allEvents.filter((e) => e.type === typeFilter);
      }

      // AC: @session-log-show ac-5 - Limit to last N events
      if (options.limit) {
        const limit = parseInt(options.limit, 10);
        if (!Number.isNaN(limit) && limit > 0) {
          allEvents = allEvents.slice(-limit);
        }
      }

      events = allEvents;
    }

    // AC: @session-log-show ac-6 - Context snapshot
    let contextSnapshot: unknown | null = null;
    if (options.context) {
      const iterNum = parseInt(options.context, 10);
      if (!Number.isNaN(iterNum) && iterNum > 0) {
        contextSnapshot = await readSessionContext(
          ctx.specDir,
          sessionId,
          iterNum,
        );
        if (contextSnapshot === null) {
          error(`No context snapshot found for iteration ${iterNum}`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }
      } else {
        error(`Invalid iteration number: ${options.context}`);
        process.exit(EXIT_CODES.USAGE_ERROR);
      }
    }

    const sessionStartTs = new Date(detail.started_at).getTime();

    // Build JSON output structure
    const jsonOutput = {
      ...detail,
      ...(events !== null ? { events } : {}),
      ...(contextSnapshot !== null ? { context: contextSnapshot } : {}),
    };

    output(jsonOutput, () =>
      formatSessionLogShow(detail, events, contextSnapshot, sessionStartTs),
    );
  } catch (err) {
    error("Failed to show session log", err);
    process.exit(EXIT_CODES.ERROR);
  }
}

// ─── Session Log Stats ─────────────────────────────────────────────────────────

interface SessionLogStatsOptions {
  since?: string;
  agent?: string;
  toolUsage?: boolean;
  byDay?: boolean;
  byWeek?: boolean;
}

/**
 * Full stats output including optional tool usage and time period data.
 */
interface SessionLogStatsOutput {
  stats: SessionLogStats;
  tool_usage?: ToolUsageStats[];
  time_periods?: TimePeriodStats[];
}

/**
 * Format a duration in milliseconds to human-readable format.
 * Reuses formatDuration from session log list but handles hours/minutes/seconds.
 */
function formatDurationLong(ms: number): string {
  if (ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Format the session log stats output.
 *
 * AC: @session-log-stats ac-1, ac-2, ac-3
 */
function formatSessionLogStats(
  stats: SessionLogStats,
  toolUsage: ToolUsageStats[] | null,
  timePeriods: TimePeriodStats[] | null,
  groupBy: "day" | "week" | null,
): void {
  // AC: @session-log-stats ac-1 - Totals
  console.log(chalk.bold("Session Statistics"));
  console.log(chalk.gray("─".repeat(50)));
  console.log(`  Total Sessions:     ${stats.total_sessions}`);
  console.log(`  Total Events:       ${stats.total_events}`);
  console.log(`  Total Iterations:   ${stats.total_iterations}`);
  console.log(`  Tasks Completed:    ${stats.total_tasks_completed}`);
  console.log(`  Total Duration:     ${formatDurationLong(stats.total_duration_ms)}`);

  // AC: @session-log-stats ac-2 - Averages
  console.log("\n" + chalk.bold("Averages"));
  console.log(chalk.gray("─".repeat(50)));
  console.log(`  Avg Duration/Session:     ${formatDurationLong(stats.avg_duration_ms)}`);
  console.log(`  Avg Iterations/Session:   ${stats.avg_iterations_per_session}`);
  console.log(`  Avg Tasks/Session:        ${stats.avg_tasks_per_session}`);

  // AC: @session-log-stats ac-3 - Status breakdown
  if (stats.status_breakdown.length > 0) {
    console.log("\n" + chalk.bold("Status Breakdown"));
    console.log(chalk.gray("─".repeat(50)));
    for (const item of stats.status_breakdown) {
      const statusColor =
        item.status === "completed"
          ? chalk.green
          : item.status === "active"
            ? chalk.blue
            : chalk.yellow;
      console.log(
        `  ${statusColor(item.status.padEnd(12))} ${String(item.count).padEnd(6)} ${item.percentage}%`,
      );
    }
  }

  // AC: @session-log-stats ac-6 - Tool usage
  if (toolUsage !== null && toolUsage.length > 0) {
    console.log("\n" + chalk.bold("Top Tool Usage"));
    console.log(chalk.gray("─".repeat(50)));
    for (const tool of toolUsage) {
      console.log(
        `  ${tool.tool_name.padEnd(20)} ${String(tool.count).padEnd(8)} ${tool.percentage}%`,
      );
    }
  }

  // AC: @session-log-stats ac-7 - Time periods
  if (timePeriods !== null && timePeriods.length > 0) {
    const label = groupBy === "week" ? "By Week" : "By Day";
    console.log("\n" + chalk.bold(label));
    console.log(chalk.gray("─".repeat(50)));
    console.log(
      chalk.gray(
        `  ${"Period".padEnd(14)} ${"Sessions".padEnd(10)} ${"Tasks".padEnd(8)} Duration`,
      ),
    );
    for (const period of timePeriods) {
      console.log(
        `  ${period.period.padEnd(14)} ${String(period.sessions_count).padEnd(10)} ${String(period.tasks_completed).padEnd(8)} ${formatDurationLong(period.total_duration_ms)}`,
      );
    }
  }
}

/**
 * Session log stats action handler.
 */
async function sessionLogStatsAction(
  options: SessionLogStatsOptions,
): Promise<void> {
  try {
    const ctx = await initContext();
    let sessions = await getAllSessionLogSummaries(ctx.specDir);

    // AC: @session-log-stats ac-4 - Filter by since
    if (options.since) {
      const sinceDate = parseTimeSpec(options.since);
      if (sinceDate) {
        sessions = sessions.filter(
          (s) => new Date(s.started_at) >= sinceDate,
        );
      }
    }

    // AC: @session-log-stats ac-5 - Filter by agent type
    if (options.agent) {
      const agentFilter = options.agent;
      sessions = sessions.filter((s) => s.agent_type === agentFilter);
    }

    // AC: @session-log-stats ac-8 - No sessions match criteria
    if (sessions.length === 0) {
      output({ message: "No sessions match criteria" }, () => {
        console.log("No sessions match criteria.");
      });
      return;
    }

    // Compute base stats
    const stats = computeSessionLogStats(sessions);

    // AC: @session-log-stats ac-6 - Tool usage (optional)
    let toolUsage: ToolUsageStats[] | null = null;
    if (options.toolUsage) {
      const sessionIds = sessions.map((s) => s.id);
      toolUsage = await computeToolUsageStats(ctx.specDir, sessionIds);
    }

    // AC: @session-log-stats ac-7 - Time periods (optional)
    let timePeriods: TimePeriodStats[] | null = null;
    let groupBy: "day" | "week" | null = null;
    if (options.byDay) {
      groupBy = "day";
      timePeriods = computeTimePeriodStats(sessions, "day");
    } else if (options.byWeek) {
      groupBy = "week";
      timePeriods = computeTimePeriodStats(sessions, "week");
    }

    // Build output structure
    const jsonOutput: SessionLogStatsOutput = { stats };
    if (toolUsage !== null) {
      jsonOutput.tool_usage = toolUsage;
    }
    if (timePeriods !== null) {
      jsonOutput.time_periods = timePeriods;
    }

    output(jsonOutput, () =>
      formatSessionLogStats(stats, toolUsage, timePeriods, groupBy),
    );
  } catch (err) {
    error("Failed to compute session log stats", err);
    process.exit(EXIT_CODES.ERROR);
  }
}

// ─── Session Log Search ─────────────────────────────────────────────────────────

interface SessionLogSearchOptions {
  type?: string;
  since?: string;
  agent?: string;
  limit?: string;
}

/**
 * Format relative timestamp from event timestamp (Unix ms) to session start.
 */
function formatSearchTimestamp(eventTs: number): string {
  return new Date(eventTs).toISOString();
}

/**
 * Format the session log search output.
 *
 * AC: @session-log-search ac-1, ac-4
 */
function formatSessionLogSearch(results: SessionSearchResult[]): void {
  if (results.length === 0) {
    // AC: @session-log-search ac-6
    console.log("No matches found.");
    return;
  }

  let totalMatches = 0;
  for (const session of results) {
    totalMatches += session.matches.length;
  }

  console.log(chalk.bold(`Found ${totalMatches} match(es) in ${results.length} session(s)`));
  console.log(chalk.gray("─".repeat(60)));

  for (const session of results) {
    // Session header
    console.log(
      `\n${chalk.cyan(`Session ${session.session_id.slice(0, 8)}`)} ` +
        `${chalk.gray(`(${session.agent_type}, started ${formatRelativeTime(new Date(session.started_at))})`)}`
    );

    // AC: @session-log-search ac-4 - Show matches with session ID, timestamp, type, excerpt
    for (const match of session.matches) {
      const ts = formatSearchTimestamp(match.timestamp);
      const typeColor =
        match.event_type === "session.start" || match.event_type === "session.end"
          ? chalk.green
          : match.event_type === "session.update"
            ? chalk.blue
            : chalk.gray;
      console.log(
        `  ${chalk.yellow(ts)} ${typeColor(match.event_type.padEnd(16))}`,
      );
      // Content excerpt on next line, indented
      console.log(`    ${chalk.gray(match.content_excerpt)}`);
    }
  }
}

/**
 * Session log search action handler.
 *
 * AC: @session-log-search ac-1 through ac-7
 */
async function sessionLogSearchAction(
  pattern: string,
  options: SessionLogSearchOptions,
): Promise<void> {
  try {
    const ctx = await initContext();

    // Parse options - validate limit as positive integer
    let limit = 50;
    if (options.limit) {
      const parsed = parseInt(options.limit, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        error(`Invalid limit: ${options.limit}. Must be a positive integer.`);
        process.exit(EXIT_CODES.USAGE_ERROR);
      }
      limit = parsed;
    }
    const sinceDate = options.since ? parseTimeSpec(options.since) : undefined;

    // AC: @session-log-search ac-1, ac-2, ac-3, ac-5, ac-7
    const results = await searchSessionEvents(ctx.specDir, pattern, {
      eventType: options.type,
      sinceDate: sinceDate || undefined,
      agentType: options.agent,
      limit,
    });

    // AC: @session-log-search ac-6 - No matches found message
    // exit code 0 regardless (per @trait-semantic-exit-codes ac-5)

    output(results, () => formatSessionLogSearch(results));
  } catch (err) {
    error("Failed to search session logs", err);
    process.exit(EXIT_CODES.ERROR);
  }
}

/**
 * Register the 'session' command group and aliases
 */
export function registerSessionCommands(program: Command): void {
  const session = program
    .command("session")
    .description("Session management and context");

  session
    .command("start")
    .alias("resume")
    .description("Surface relevant context for starting a new working session")
    .option("--brief", "Compact summary (default)")
    .option("--full", "Comprehensive context dump")
    .option(
      "--since <time>",
      "Filter by recency (ISO8601 or relative: 1h, 2d, 1w)",
    )
    .option("--no-git", "Skip git commit information")
    .option("-n, --limit <n>", "Limit items per section", "10")
    .action(sessionStartAction);

  // Session log subcommand group
  const log = session
    .command("log")
    .description("Session log analysis commands");

  log
    .command("list")
    .description("List session logs with summary statistics")
    .option(
      "-s, --status <status>",
      "Filter by status (active, completed, abandoned)",
    )
    .option("--agent <type>", "Filter by agent type")
    .option(
      "--since <time>",
      "Only show sessions started after this time (ISO8601 or relative: 1h, 2d, 1w)",
    )
    .option(
      "--sort <field>",
      "Sort by field (started_at, duration, events, iterations, tasks_completed)",
      "started_at",
    )
    .option("--count", "Show only the count of matching sessions")
    .option("-n, --limit <n>", "Limit number of sessions shown")
    .action(sessionLogListAction);

  log
    .command("show <session-id>")
    .description("Show detailed view of a single session")
    .option("-e, --events", "Include chronological event timeline")
    .option("-t, --type <type>", "Filter events by type (e.g., tool.call)")
    .option("-n, --limit <n>", "Show only the last N events")
    .option("-c, --context <n>", "Show context snapshot for iteration N")
    .action(sessionLogShowAction);

  log
    .command("stats")
    .description("Aggregate analytics across sessions")
    .option(
      "--since <time>",
      "Only include sessions started after this time (ISO8601 or relative: 1h, 2d, 1w)",
    )
    .option("--agent <type>", "Only include sessions with this agent type")
    .option("--tool-usage", "Display top 10 tool calls by frequency")
    .option("--by-day", "Group stats by day")
    .option("--by-week", "Group stats by week")
    .action(sessionLogStatsAction);

  log
    .command("search <pattern>")
    .description("Search across session events by content")
    .option("-t, --type <type>", "Only search events of this type (e.g., session.update)")
    .option(
      "--since <time>",
      "Only search sessions started after this time (ISO8601 or relative: 1h, 2d, 1w)",
    )
    .option("--agent <type>", "Only search sessions with this agent type")
    .option("-n, --limit <n>", "Maximum matches to return (default: 50)")
    .action(sessionLogSearchAction);

  session
    .command("checkpoint")
    .description(
      "Pre-stop hook: check for uncommitted work before ending session",
    )
    .option("--force", "Allow session end regardless of issues")
    .action(sessionCheckpointAction);

  session
    .command("prompt-check")
    .description("UserPromptSubmit hook: inject spec-first reminder")
    .action(sessionPromptCheckAction);

  // Top-level alias: kspec context
  program
    .command("context")
    .description("Alias for session start - surface session context")
    .option("--brief", "Compact summary (default)")
    .option("--full", "Comprehensive context dump")
    .option(
      "--since <time>",
      "Filter by recency (ISO8601 or relative: 1h, 2d, 1w)",
    )
    .option("--no-git", "Skip git commit information")
    .option("-n, --limit <n>", "Limit items per section", "10")
    .action(sessionStartAction);
}
