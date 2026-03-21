/**
 * Session context data gathering.
 *
 * Loads and aggregates all data needed for session start output.
 */

import {
  getReadyTasks,
  type KspecContext,
  type LoadedTask,
  loadAllItems,
  loadInboxItems,
  loadSessionContext,
  loadTriageRecords,
  ReferenceIndex,
  shortestUniqueUlid,
} from "../../../parser/index.js";
import { resolveTaskDataManager } from "../../../parser/task-data-manager.js";
import { loadMetaContext } from "../../../parser/meta.js";
import {
  type GitWorkingTree,
  getCurrentBranch,
  getRecentCommits,
  getWorkingTreeStatus,
  isGitRepo,
  parseTimeSpec,
} from "../../../utils/index.js";
import { isNoteSuperseded } from "../../output.js";
import type {
  ActiveTaskSummary,
  ActivityItem,
  BlockedTaskSummary,
  CommitSummary,
  CompletedTaskSummary,
  InboxStats,
  InboxSummary,
  IterationStats,
  NoteSummary,
  ObservationSummary,
  ReadyTaskSummary,
  SessionStartContext,
  SessionContextComputed,
  SessionOptions,
  SessionStats,
  TodoSummary,
} from "./types.js";
import { getDisplayRef } from "./format.js";

// ─── Mapper Functions ───────────────────────────────────────────────────────

/**
 * Build a reverse dependency map: for each task ULID, count how many
 * pending tasks depend on it. Unresolvable refs are silently skipped.
 */
function computeUnlocksMap(
  allTasks: LoadedTask[],
  index: ReferenceIndex,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const task of allTasks) {
    // Only count pending tasks as "unlockable" downstream work per spec
    if (task.status !== "pending") continue;

    for (const depRef of task.depends_on) {
      const result = index.resolve(depRef);
      if (!result.ok) continue; // AC: unresolvable refs silently skipped
      const depUlid = result.item._ulid;
      counts.set(depUlid, (counts.get(depUlid) || 0) + 1);
    }
  }

  return counts;
}

function toActiveTaskSummary(
  task: LoadedTask,
  index: ReferenceIndex,
): ActiveTaskSummary {
  const lastNote =
    task.notes.length > 0 ? task.notes[task.notes.length - 1] : null;
  const incompleteTodos = task.todos.filter((t) => !t.done).length;
  return {
    ref: index.shortUlid(task._ulid),
    slug: task.slugs.length > 0 ? task.slugs[0] : null,
    title: task.title,
    description: task.description || null,
    status: task.status as "in_progress" | "needs_work" | "pending_review",
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
  unlocksMap: Map<string, number>,
): ReadyTaskSummary {
  return {
    ref: index.shortUlid(task._ulid),
    slug: task.slugs.length > 0 ? task.slugs[0] : null,
    title: task.title,
    description: task.description || null,
    priority: task.priority,
    spec_ref: task.spec_ref || null,
    tags: task.tags,
    unlocks: unlocksMap.get(task._ulid) || 0,
  };
}

function toBlockedTaskSummary(
  task: LoadedTask,
  index: ReferenceIndex,
  unlocksMap: Map<string, number>,
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
    slug: task.slugs.length > 0 ? task.slugs[0] : null,
    title: task.title,
    description: task.description || null,
    blocked_by: task.blocked_by,
    unmet_deps: unmetDeps,
    unlocks: unlocksMap.get(task._ulid) || 0,
  };
}

function toCompletedTaskSummary(
  task: LoadedTask,
  index: ReferenceIndex,
): CompletedTaskSummary {
  return {
    ref: index.shortUlid(task._ulid),
    slug: task.slugs.length > 0 ? task.slugs[0] : null,
    title: task.title,
    completed_at: task.completed_at || "",
    closed_reason: task.closed_reason || null,
    origin: task.origin,
  };
}

function collectRecentNotes(
  tasks: LoadedTask[],
  index: ReferenceIndex,
  options: { limit: number | undefined; since: Date | null },
): NoteSummary[] {
  const allNotes: NoteSummary[] = [];

  for (const task of tasks) {
    const noteUlids = task.notes.map((note) => note._ulid);
    // Only include notes from in_progress, pending_review, or completed tasks
    const taskStatus = task.status as "in_progress" | "pending_review" | "needs_work" | "completed";
    if (!["in_progress", "pending_review", "needs_work", "completed"].includes(taskStatus)) {
      continue;
    }

    for (const note of task.notes) {
      const noteDate = new Date(note.created_at);

      // Filter by since date if provided
      if (options.since && noteDate < options.since) {
        continue;
      }

      // Filter out superseded notes
      if (isNoteSuperseded(note, task.notes)) {
        continue;
      }

      allNotes.push({
        task_ref: index.shortUlid(task._ulid),
        task_title: task.title,
        task_status: taskStatus,
        note_ulid: shortestUniqueUlid(note._ulid, noteUlids),
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
 * Build a unified activity timeline from completed tasks and git commits.
 *
 * - Commits with Task: @slug trailers are matched to completed tasks and shown
 *   as combined "linked_commit" entries (AC: ac-activity-trailer-link, ac-activity-dedup)
 * - Unlinked commits appear as standalone "commit" entries
 * - Tasks not linked to any commit appear as standalone "task_completion" entries
 * - All items sorted most recent first (AC: ac-activity-sort)
 *
 * @param completedTasks - Completed task summaries
 * @param commits - Recent commit summaries (with task_refs parsed from trailers)
 * @param taskRefResolver - Maps a trailer ref (slug or ULID prefix) to a completed task's ref (short ULID)
 */
function buildActivityTimeline(
  completedTasks: CompletedTaskSummary[],
  commits: CommitSummary[],
  taskRefResolver: Map<string, string>,
): ActivityItem[] {
  const items: ActivityItem[] = [];

  // Build lookup from short ULID ref to CompletedTaskSummary
  const taskByRef = new Map<string, CompletedTaskSummary>();
  for (const task of completedTasks) {
    taskByRef.set(task.ref, task);
  }

  // Track which tasks have been linked to a commit (for dedup)
  const linkedTaskRefs = new Set<string>();

  for (const commit of commits) {
    if (commit.task_refs.length > 0) {
      let linkedTask: CompletedTaskSummary | undefined;
      for (const trailerRef of commit.task_refs) {
        // Resolve the trailer ref (slug or ULID) to the short ULID ref
        const resolvedRef = taskRefResolver.get(trailerRef);
        if (resolvedRef) {
          linkedTask = taskByRef.get(resolvedRef);
        }
        // Also try direct match on short ULID ref
        if (!linkedTask) {
          linkedTask = taskByRef.get(trailerRef);
        }
        if (linkedTask) {
          linkedTaskRefs.add(linkedTask.ref);
          // Use the later of commit date and task completion date for sort accuracy
          const commitTime = new Date(commit.date).getTime();
          const taskTime = new Date(linkedTask.completed_at).getTime();
          const laterDate =
            taskTime > commitTime ? linkedTask.completed_at : commit.date;
          items.push({
            type: "linked_commit",
            date: laterDate,
            commit,
            task: linkedTask,
          });
          break; // One linked entry per commit
        }
      }
      if (!linkedTask) {
        // Task ref in trailer but no matching completed task found
        items.push({ type: "commit", date: commit.date, commit });
      }
    } else {
      items.push({ type: "commit", date: commit.date, commit });
    }
  }

  // Add task completions not already linked to a commit
  for (const task of completedTasks) {
    if (!linkedTaskRefs.has(task.ref)) {
      items.push({
        type: "task_completion",
        date: task.completed_at,
        task,
      });
    }
  }

  // AC: @session-start-activity-timeline ac-activity-sort
  // Sort most recent first
  items.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  return items;
}

// ─── Main Gather Function ───────────────────────────────────────────────────

/**
 * Gather session context data
 */
export async function gatherSessionContext(
  ctx: KspecContext,
  options: SessionOptions,
): Promise<SessionStartContext> {
  const limit = parseInt(options.limit || "10", 10);
  if (Number.isNaN(limit) || limit <= 0) {
    throw new RangeError(
      `Invalid limit: "${options.limit}". Must be a positive integer.`,
    );
  }
  const sinceDate = options.since ? parseTimeSpec(options.since) : null;
  const showGit = options.git !== false; // default true

  // Load all data
  const allTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
  const items = await loadAllItems(ctx);
  const inboxItems = await loadInboxItems(ctx);
  const triageRecords = await loadTriageRecords(ctx);
  const inboxUlids = inboxItems.map((item) => item._ulid);
  const index = new ReferenceIndex(allTasks, items);

  // AC: @session-start-inbox-triage ac-inbox-untriaged-def
  // Build lookup: inbox ULID → triage record (most recent if multiple)
  const triageByInboxRef = new Map<string, { action?: string }>();
  for (const record of triageRecords) {
    triageByInboxRef.set(record.inbox_ref, { action: record.action });
  }

  // ── Single-pass task bucketing ──────────────────────────────────────────
  // Bucket all tasks by status in one pass instead of 14+ separate .filter() calls.
  const tasksByStatus = new Map<string, LoadedTask[]>();
  for (const task of allTasks) {
    const existing = tasksByStatus.get(task.status);
    if (existing) {
      existing.push(task);
    } else {
      tasksByStatus.set(task.status, [task]);
    }
  }

  // Helper to get a status bucket (returns empty array if none)
  const bucket = (status: string): LoadedTask[] =>
    tasksByStatus.get(status) || [];

  // Cache getReadyTasks (expensive: checks dependencies for every pending task)
  const allReadyTasks = getReadyTasks(allTasks);

  // Cache sorted completed tasks (used for notes and recentlyCompleted list)
  const completedWithDate = bucket("completed")
    .filter((t) => t.completed_at)
    .sort((a, b) => {
      const aDate = new Date(a.completed_at || 0);
      const bDate = new Date(b.completed_at || 0);
      return bDate.getTime() - aDate.getTime();
    });

  // Active tasks = in_progress + needs_work
  const activeStatusTasks = [...bucket("in_progress"), ...bucket("needs_work")];

  // Compute stats from buckets
  const stats: SessionStats = {
    total_tasks: allTasks.length,
    in_progress: bucket("in_progress").length,
    needs_work: bucket("needs_work").length,
    pending_review: bucket("pending_review").length,
    ready: allReadyTasks.length,
    blocked: bucket("blocked").length,
    completed: bucket("completed").length,
    inbox_items: inboxItems.length,
  };

  // Get active tasks (in_progress + needs_work, optionally filtered to automation-eligible only)
  // AC: @cli-ralph ac-16
  const activeTasks = activeStatusTasks
    .filter((t) => !options.eligible || t.automation === "eligible")
    .sort((a, b) => a.priority - b.priority)
    .slice(0, options.full ? undefined : limit)
    .map((t) => toActiveTaskSummary(t, index));

  // Get pending review tasks
  const pendingReviewTasks = bucket("pending_review")
    .sort((a, b) => a.priority - b.priority)
    .slice(0, options.full ? undefined : limit)
    .map((t) => toActiveTaskSummary(t, index));

  // Get recent notes from active, pending_review, and recently completed tasks
  // AC: @cmd-session-start ac-1, ac-2
  // Collect notes per-status first to prevent one status from starving others
  // In full mode, uncap notes (consistent with other sections that use undefined in full mode).
  // In non-full mode, split limit across 3 status buckets to prevent starvation.
  const noteLimitPerStatus = options.full ? undefined : Math.ceil(limit / 3);

  const inProgressNotes = collectRecentNotes(
    activeStatusTasks,
    index,
    { limit: noteLimitPerStatus, since: sinceDate },
  );

  const pendingReviewNotes = collectRecentNotes(
    bucket("pending_review"),
    index,
    { limit: noteLimitPerStatus, since: sinceDate },
  );

  const recentlyCompletedForNotes = completedWithDate
    .slice(0, 5); // Last 3-5 completed tasks per AC-2

  const completedNotes = collectRecentNotes(
    recentlyCompletedForNotes,
    index,
    { limit: noteLimitPerStatus, since: sinceDate },
  );

  // Combine notes from all statuses, preserving representation from each.
  // In non-full mode, apply final cap to handle ceil() rounding across 3 buckets.
  const noteLimit = options.full ? undefined : limit;
  const recentNotes = [...inProgressNotes, ...pendingReviewNotes, ...completedNotes]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .slice(0, noteLimit);

  // Get incomplete todos from active tasks
  const activeTodos = collectIncompleteTodos(
    activeStatusTasks,
    index,
    { limit: options.full ? limit * 2 : limit },
  );

  // Compute reverse dependency map for "unlocks N" annotations
  const unlocksMap = computeUnlocksMap(allTasks, index);

  // AC: @cmd-session-start ac-primer-default, ac-full-sections
  // Primer: top 5 ready tasks; Full: all ready tasks
  // Respect --limit as upper bound when provided
  const readyLimit = options.full ? undefined : Math.min(limit, 5);
  const readyTasks = allReadyTasks
    .filter((t) => !options.eligible || t.automation === "eligible")
    .slice(0, readyLimit)
    .map((t) => toReadyTaskSummary(t, index, unlocksMap));

  // Get blocked tasks
  const blockedTasks = bucket("blocked")
    .slice(0, options.full ? undefined : limit)
    .map((t) => toBlockedTaskSummary(t, index, unlocksMap));

  // Get recently completed tasks (reuse cached sorted list)
  const recentlyCompleted = completedWithDate
    .filter((t) => {
      if (!sinceDate) return true;
      const completedDate = new Date(t.completed_at || 0);
      return completedDate >= sinceDate;
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
      task_refs: c.taskRefs,
    }));

    workingTree = getWorkingTreeStatus(ctx.rootDir);
  }

  // Get inbox items with triage status (oldest first to encourage triage)
  // AC: @session-start-inbox-triage ac-inbox-untriaged-def
  const allInboxSummaries: InboxSummary[] = inboxItems
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )
    .map((item) => {
      const triageInfo = triageByInboxRef.get(item._ulid);
      return {
        ref: shortestUniqueUlid(item._ulid, inboxUlids),
        text: item.text,
        created_at: item.created_at,
        tags: item.tags,
        added_by: item.added_by || null,
        triaged: !!triageInfo,
        triage_action: triageInfo?.action ?? null,
      };
    });

  // AC: @session-start-inbox-triage ac-inbox-stat-line, ac-inbox-all-triaged
  const inboxStats: InboxStats = {
    total: allInboxSummaries.length,
    untriaged: allInboxSummaries.filter((i) => !i.triaged).length,
    deferred: allInboxSummaries.filter((i) => i.triage_action === "defer")
      .length,
    triaged: allInboxSummaries.filter((i) => i.triaged).length,
  };

  // JSON always gets full list with triage status; human display filters in formatSessionContext

  // Load session context (focus, threads, questions)
  const sessionContext = await loadSessionContext(ctx);

  // Build task ref resolver for activity timeline: maps slug/ULID to short ref
  // This allows commits with Task: @task-slug trailers to match completed tasks
  const taskRefResolver = new Map<string, string>();
  for (const task of allTasks) {
    if (task.status !== "completed") continue;
    const shortRef = index.shortUlid(task._ulid);
    // Map each slug to the short ref
    for (const slug of task.slugs) {
      taskRefResolver.set(slug, shortRef);
    }
    // Also map the full ULID and short ULID to itself
    taskRefResolver.set(task._ulid, shortRef);
    taskRefResolver.set(shortRef, shortRef);
  }

  // Build unified activity timeline
  // AC: @session-start-activity-timeline ac-activity-merge
  // AC: @cmd-session-start ac-primer-default, ac-full-sections
  // Primer: 10 items; Full: 20 items
  // Respect --limit as upper bound when provided
  const activityLimit = options.full ? Math.min(limit * 2, 20) : Math.min(limit, 10);
  const activityTimeline = buildActivityTimeline(
    recentlyCompleted,
    recentCommits,
    taskRefResolver,
  ).slice(0, activityLimit);

  // AC: @cmd-session-start ac-full-sections — observations section (full mode only)
  let observations: ObservationSummary[] = [];
  if (options.full) {
    const metaCtx = await loadMetaContext(ctx);
    const observationUlids = metaCtx.observations.map((observation) => observation._ulid);
    observations = metaCtx.observations
      .filter((o) => !o.resolved)
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .map((o) => ({
        ref: shortestUniqueUlid(o._ulid, observationUlids),
        type: o.type,
        content: o.content,
        created_at: o.created_at,
        author: o.author || null,
        resolved: o.resolved,
        workflow_ref: o.workflow_ref || null,
      }));
  }

  // AC: @session-start-computed-json ac-computed-unlocks
  // Build task_unlocks map: short ULID ref → count of pending dependents
  const taskUnlocks: Record<string, number> = {};
  for (const [taskUlid, count] of unlocksMap) {
    if (count > 0) {
      taskUnlocks[index.shortUlid(taskUlid)] = count;
    }
  }

  // AC: @session-start-computed-json ac-computed-inbox, ac-computed-unlocks, ac-computed-activity
  const computed: SessionContextComputed = {
    inbox_untriaged_count: inboxStats.untriaged,
    inbox_deferred_count: inboxStats.deferred,
    inbox_total: inboxStats.total,
    task_unlocks: taskUnlocks,
    recent_activity: activityTimeline,
  };

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
    activity_timeline: activityTimeline,
    working_tree: workingTree,
    inbox_items: allInboxSummaries,
    inbox_stats: inboxStats,
    observations,
    stats,
    computed,
  };
}

// ─── Iteration Stats ────────────────────────────────────────────────────────

/**
 * Get iteration stats - tasks completed/started since a given time.
 * AC: @ralph-task-limit ac-detection
 */
export async function getIterationStats(
  ctx: KspecContext,
  since: Date,
): Promise<IterationStats> {
  const allTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
  const items = await loadAllItems(ctx);
  const index = new ReferenceIndex(allTasks, items);

  // Count both completed and pending_review (submitted) tasks toward the limit.
  // Submit means the agent's work is done — it should count the same as complete.
  // AC: @ralph-task-limit ac-detection
  const completedSince = allTasks.filter((t) => {
    if (t.status === "completed" && t.completed_at) {
      return new Date(t.completed_at) >= since;
    }
    if (t.status === "pending_review" && t.submitted_at) {
      return new Date(t.submitted_at) >= since;
    }
    return false;
  });

  const startedSince = allTasks.filter((t) => {
    if (!t.started_at) return false;
    return new Date(t.started_at) >= since;
  });

  return {
    tasks_completed: completedSince.length,
    tasks_started: startedSince.length,
    completed_refs: completedSince.map((t) =>
      getDisplayRef({ ref: index.shortUlid(t._ulid), slug: t.slugs[0] || null }),
    ),
  };
}
