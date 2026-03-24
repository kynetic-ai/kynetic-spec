/**
 * Session human output formatting.
 *
 * Formats session context and checkpoint results for human-readable CLI output.
 */

import chalk from "chalk";
import { formatRelativeTime } from "../../../utils/index.js";
import { hints, sessionHeaders } from "../../../strings/index.js";
import type {
  CheckpointResult,
  CompletedTaskSummary,
  CommitSummary,
  NoteSummary,
  SessionStartContext,
  SessionOptions,
} from "./types.js";

// ─── Shared Formatting Helpers ──────────────────────────────────────────────

/**
 * Display ref as @slug when available, @short-ulid when not.
 * AC: @cmd-session-start ac-slug-display, ac-slug-fallback
 */
export function getDisplayRef(item: { ref: string; slug?: string | null }): string {
  return item.slug ? `@${item.slug}` : `@${item.ref}`;
}

/**
 * Format priority with color coding.
 * P1-P2: red (high priority), P3+: gray.
 */
export function formatPriority(level: number): string {
  return level <= 2 ? chalk.red(`P${level}`) : chalk.gray(`P${level}`);
}

/**
 * Format task status with color coding.
 */
export function statusColor(status: string): ReturnType<typeof chalk.red> {
  switch (status) {
    case "in_progress":
      return chalk.blue("[in_progress]");
    case "needs_work":
      return chalk.red("[needs_work]");
    case "pending_review":
      return chalk.yellow("[pending_review]");
    case "blocked":
      return chalk.red("[blocked]");
    case "completed":
      return chalk.green("[completed]");
    default:
      return chalk.gray(`[${status}]`);
  }
}

/**
 * Format an inline note for display under a task entry.
 */
function formatInlineNote(note: NoteSummary, isFull: boolean): void {
  const noteAge = formatRelativeTime(new Date(note.created_at));
  const author = note.author ? chalk.gray(` by ${note.author}`) : "";
  console.log(`    ${chalk.yellow("Note")} ${chalk.gray(`(${noteAge}${author})`)}`);

  let content = note.content.trim();
  if (!isFull && content.length > 200) {
    content = `${content.slice(0, 200).trim()}...`;
  }
  const lines = content.split("\n");
  const maxLines = isFull ? lines.length : 3;
  for (const line of lines.slice(0, maxLines)) {
    console.log(`      ${chalk.white(line)}`);
  }
  if (!isFull && lines.length > maxLines) {
    console.log(chalk.gray(`      ... (${lines.length - maxLines} more lines)`));
  }
}

// ─── Checkpoint Formatting ──────────────────────────────────────────────────

export function formatCheckpointResult(result: CheckpointResult): void {
  if (result.ok) {
    console.log(chalk.green(result.message));
  } else {
    console.log(chalk.yellow(result.message));
    console.log("");

    for (const issue of result.issues) {
      console.log(`  ${chalk.yellow("⚠")} ${issue.description}`);
    }

    if (result.instructions.length > 0) {
      console.log("");
      for (const instruction of result.instructions) {
        console.log(chalk.gray(instruction));
      }
    }
  }
}

// ─── Session Context Formatting ─────────────────────────────────────────────

export function formatSessionContext(ctx: SessionStartContext, options: SessionOptions): void {
  const isFull = !!options.full;

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
    ctx.stats.pending_review > 0 ? `${ctx.stats.pending_review} awaiting review, ` : "";
  const inboxNote = ctx.stats.inbox_items > 0 ? ` | Inbox: ${ctx.stats.inbox_items}` : "";
  console.log(
    chalk.gray(
      `Tasks: ${ctx.stats.in_progress} active, ${pendingReviewNote}${ctx.stats.ready} ready, ` +
        `${ctx.stats.blocked} blocked, ${ctx.stats.completed}/${ctx.stats.total_tasks} completed${inboxNote}`,
    ),
  );

  // Session context section (focus, threads, questions)
  if (
    ctx.context &&
    (ctx.context.focus || ctx.context.threads.length > 0 || ctx.context.open_questions.length > 0)
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

  // ── Section ordering per AC: @cmd-session-start ac-section-order ──
  // active tasks → pending review → blocked → ready → recent activity → inbox → working tree → quick commands
  // AC: @cmd-session-start ac-empty-skip — empty sections omitted entirely

  // ── Active tasks section ──
  // AC: @cmd-session-start ac-active-detail, ac-needs-work-indicator
  if (ctx.active_tasks.length > 0) {
    console.log(`\n${sessionHeaders.activeWork}`);

    // Collect notes relevant to active tasks for inline display
    const activeTaskNotes = ctx.recent_notes.filter(
      (n) => n.task_status === "in_progress" || n.task_status === "needs_work",
    );

    for (const task of ctx.active_tasks) {
      const started = task.started_at
        ? chalk.gray(` (started ${formatRelativeTime(new Date(task.started_at))})`)
        : "";

      // AC: @cmd-session-start ac-needs-work-indicator
      const statusLabel = statusColor(task.status);

      console.log(
        `  ${statusLabel} ${formatPriority(task.priority)} ${getDisplayRef(task)} ${task.title}${started}`,
      );

      // AC: @cmd-session-start ac-active-detail — show description
      if (task.description) {
        console.log(chalk.gray(`    ${task.description}`));
      }

      // AC: @cmd-session-start ac-active-detail — show recent notes inline
      const taskNotes = activeTaskNotes.filter((n) => n.task_ref === task.ref);
      if (taskNotes.length > 0) {
        formatInlineNote(taskNotes[0], isFull); // already sorted most recent first
      }
    }
  }

  // ── Awaiting review section ──
  // AC: @cmd-session-start ac-review-detail
  if (ctx.pending_review_tasks.length > 0) {
    console.log(`\n${sessionHeaders.awaitingReview}`);

    const reviewNotes = ctx.recent_notes.filter((n) => n.task_status === "pending_review");

    for (const task of ctx.pending_review_tasks) {
      console.log(
        `  ${chalk.yellow("[pending_review]")} ${formatPriority(task.priority)} ${getDisplayRef(task)} ${task.title}`,
      );

      // AC: @cmd-session-start ac-review-detail — show recent notes
      const taskNotes = reviewNotes.filter((n) => n.task_ref === task.ref);
      if (taskNotes.length > 0) {
        formatInlineNote(taskNotes[0], isFull);
      }
    }
  }

  // ── Blocked tasks section ──
  if (ctx.blocked_tasks.length > 0) {
    console.log(`\n${sessionHeaders.blocked}`);
    for (const task of ctx.blocked_tasks) {
      const unlocks = task.unlocks > 0 ? chalk.green(` unlocks ${task.unlocks}`) : "";
      console.log(`  ${chalk.red("[blocked]")} ${getDisplayRef(task)} ${task.title}${unlocks}`);
      if (task.blocked_by.length > 0) {
        console.log(chalk.gray(`    Blockers: ${task.blocked_by.join(", ")}`));
      }
      if (task.unmet_deps.length > 0) {
        console.log(chalk.gray(`    Waiting on: ${task.unmet_deps.join(", ")}`));
      }
    }
  }

  // ── Ready tasks section ──
  if (ctx.ready_tasks.length > 0) {
    console.log(`\n${sessionHeaders.readyTasks}`);
    for (const task of ctx.ready_tasks) {
      const tags = task.tags.length > 0 ? chalk.cyan(` #${task.tags.join(" #")}`) : "";
      const unlocks = task.unlocks > 0 ? chalk.green(` unlocks ${task.unlocks}`) : "";
      console.log(
        `  ${formatPriority(task.priority)} ${getDisplayRef(task)} ${task.title}${unlocks}${tags}`,
      );
    }
  }

  // ── Recent Activity timeline ──
  // AC: @session-start-activity-timeline ac-activity-merge
  if (ctx.activity_timeline.length > 0) {
    formatActivityTimeline(ctx.activity_timeline, isFull);
  }

  // ── Inbox section ──
  // AC: @session-start-inbox-triage ac-inbox-stat-line, ac-inbox-full-list, ac-inbox-all-triaged
  if (ctx.inbox_stats.total > 0) {
    console.log(`\n${sessionHeaders.inbox}`);
    // Stat line always shown (primer and full)
    const statParts = [
      `${ctx.inbox_stats.untriaged} untriaged`,
      `${ctx.inbox_stats.deferred} deferred`,
      `${ctx.inbox_stats.total} total`,
    ];
    console.log(`  ${statParts.join(" | ")}`);

    // AC: @cmd-session-start ac-full-sections, @session-start-inbox-triage ac-inbox-full-list
    // Full mode: list untriaged items (up to 20)
    // AC: @cmd-session-start ac-slug-fallback — inbox uses @short-ulid
    const untriagedItems = ctx.inbox_items.filter((i) => !i.triaged).slice(0, 20);
    if (isFull && untriagedItems.length > 0) {
      console.log("");
      for (const item of untriagedItems) {
        const itemAge = formatRelativeTime(new Date(item.created_at));
        const author = item.added_by ? ` by ${item.added_by}` : "";
        const tags = item.tags.length > 0 ? chalk.cyan(` [${item.tags.join(", ")}]`) : "";
        console.log(
          `  ${chalk.magenta(`@${item.ref}`)} ${chalk.gray(`(${itemAge}${author})`)}${tags}`,
        );
        console.log(`    ${item.text}`);
      }
    }
    if (ctx.inbox_stats.untriaged > 0) {
      console.log(`  ${hints.inboxTriage}`);
    }
  }

  // ── Observations section (full mode only) ──
  // AC: @cmd-session-start ac-full-sections
  if (isFull && ctx.observations.length > 0) {
    console.log(`\n${chalk.yellow.bold("--- Observations (unresolved) ---")}`);
    for (const obs of ctx.observations) {
      const obsAge = formatRelativeTime(new Date(obs.created_at));
      const author = obs.author ? ` by ${obs.author}` : "";
      const typeLabel = chalk.cyan(`[${obs.type}]`);
      console.log(
        `  ${typeLabel} ${chalk.gray(`@${obs.ref}`)} ${chalk.gray(`(${obsAge}${author})`)}`,
      );
      console.log(`    ${obs.content}`);
    }
  }

  // ── Session metadata section (full mode only) ──
  // AC: @cmd-session-start ac-full-sections
  if (isFull && ctx.context && ctx.context.updated_at) {
    console.log(`\n${chalk.gray.bold("--- Session Metadata ---")}`);
    console.log(
      chalk.gray(`  Last updated: ${formatRelativeTime(new Date(ctx.context.updated_at))}`),
    );
  }

  // ── Working tree section ──
  // AC: @cmd-session-start ac-dirty-tree-only — only shown when dirty
  if (ctx.working_tree && !ctx.working_tree.clean) {
    console.log(`\n${sessionHeaders.workingTree}`);

    if (ctx.working_tree.staged.length > 0) {
      console.log(chalk.green("  Staged:"));
      for (const file of ctx.working_tree.staged) {
        console.log(`    ${chalk.green(file.status[0].toUpperCase())} ${file.path}`);
      }
    }

    if (ctx.working_tree.unstaged.length > 0) {
      console.log(chalk.red("  Modified:"));
      for (const file of ctx.working_tree.unstaged) {
        console.log(`    ${chalk.red(file.status[0].toUpperCase())} ${file.path}`);
      }
    }

    if (ctx.working_tree.untracked.length > 0) {
      console.log(chalk.gray("  Untracked:"));
      const untrackedLimit = isFull ? ctx.working_tree.untracked.length : 5;
      for (const filePath of ctx.working_tree.untracked.slice(0, untrackedLimit)) {
        console.log(`    ${chalk.gray("?")} ${filePath}`);
      }
      if (!isFull && ctx.working_tree.untracked.length > untrackedLimit) {
        console.log(
          chalk.gray(`    ... and ${ctx.working_tree.untracked.length - untrackedLimit} more`),
        );
      }
    }
  }

  // ── Quick Commands section ──
  const quickCommands: string[] = [];

  if (ctx.active_tasks.length > 0) {
    const ref = getDisplayRef(ctx.active_tasks[0]);
    quickCommands.push(`kspec task note ${ref} "Progress..."  ${chalk.gray("# document work")}`);
    quickCommands.push(`kspec task submit ${ref}  ${chalk.gray("# submit for review")}`);
  } else if (ctx.ready_tasks.length > 0) {
    const ref = getDisplayRef(ctx.ready_tasks[0]);
    quickCommands.push(`kspec task start ${ref}  ${chalk.gray("# begin work")}`);
  }

  if (ctx.inbox_stats.untriaged > 0) {
    quickCommands.push(`kspec triage inbox  ${chalk.gray("# triage untriaged inbox items")}`);
  }

  if (ctx.working_tree && !ctx.working_tree.clean) {
    quickCommands.push(`git add . && git commit -m "..."  ${chalk.gray("# commit changes")}`);
  }

  if (quickCommands.length > 0) {
    console.log(`\n${sessionHeaders.quickCommands}`);
    for (const hint of quickCommands) {
      console.log(`  ${hint}`);
    }
  }

  console.log(""); // Final newline
}

// ─── Activity Timeline Formatting ───────────────────────────────────────────

/**
 * Format the activity timeline section with hierarchical grouping.
 * AC: @session-start-activity-timeline ac-activity-hierarchy, ac-activity-dedup
 */
function formatActivityTimeline(
  timeline: SessionStartContext["activity_timeline"],
  isFull: boolean,
): void {
  console.log(`\n${sessionHeaders.recentActivity}`);
  const observationPromotedTasks: string[] = [];

  // AC: @session-start-activity-timeline ac-activity-hierarchy, ac-activity-dedup
  // Group linked commits by task, then interleave with standalone entries
  type ActivityGroup =
    | {
        kind: "task_group";
        task: CompletedTaskSummary;
        commits: Array<{ commit: CommitSummary; date: string }>;
        sortDate: string;
      }
    | { kind: "task_completion"; task: CompletedTaskSummary; date: string }
    | { kind: "orphan_commit"; commit: CommitSummary; date: string };

  const taskGroups = new Map<
    string,
    {
      task: CompletedTaskSummary;
      commits: Array<{ commit: CommitSummary; date: string }>;
      sortDate: string;
    }
  >();
  const groups: ActivityGroup[] = [];

  for (const item of timeline) {
    if (item.type === "linked_commit") {
      const key = item.task.ref;
      let group = taskGroups.get(key);
      if (!group) {
        group = { task: item.task, commits: [], sortDate: item.date };
        taskGroups.set(key, group);
      }
      group.commits.push({ commit: item.commit, date: item.commit.date });
      // Update sortDate to the most recent event in the group
      if (new Date(item.date).getTime() > new Date(group.sortDate).getTime()) {
        group.sortDate = item.date;
      }
    } else if (item.type === "task_completion") {
      groups.push({ kind: "task_completion", task: item.task, date: item.date });
    } else if (item.type === "commit") {
      groups.push({ kind: "orphan_commit", commit: item.commit, date: item.date });
    }
  }

  // Add task groups to the groups array
  for (const group of taskGroups.values()) {
    // AC: @session-start-activity-timeline ac-activity-sort
    // Sort commits within a group chronologically (oldest first)
    group.commits.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    groups.push({ kind: "task_group", ...group });
  }

  // AC: @session-start-activity-timeline ac-activity-sort
  // Sort groups by most recent event, most recent first
  groups.sort(
    (a, b) =>
      new Date(b.kind === "task_group" ? b.sortDate : b.date).getTime() -
      new Date(a.kind === "task_group" ? a.sortDate : a.date).getTime(),
  );

  for (const group of groups) {
    if (group.kind === "task_completion") {
      // Standalone completed task (not linked to any commit)
      let reason = "";
      if (group.task.closed_reason) {
        const maxLen = isFull ? 120 : 60;
        const truncated =
          group.task.closed_reason.length > maxLen
            ? `${group.task.closed_reason.slice(0, maxLen).trim()}...`
            : group.task.closed_reason;
        reason = chalk.gray(` - ${truncated}`);
      }
      // AC: @cmd-session-start ac-slug-display
      const taskDisplay = getDisplayRef(group.task);
      // AC: @cmd-session-start ac-relative-time-human
      const itemAge = formatRelativeTime(new Date(group.date));
      console.log(
        `  ${chalk.green("✓")} ${taskDisplay} ${group.task.title} ${chalk.gray(`(${itemAge})`)}${reason}`,
      );
      if (group.task.origin === "observation_promotion") {
        observationPromotedTasks.push(taskDisplay);
      }
    } else if (group.kind === "task_group") {
      // AC: @session-start-activity-timeline ac-activity-hierarchy, ac-activity-trailer-link
      // Task as top-level entry with linked commits nested beneath
      const taskDisplay = getDisplayRef(group.task);
      const groupAge = formatRelativeTime(new Date(group.sortDate));
      console.log(
        `  ${chalk.green("✓")} ${taskDisplay} ${group.task.title} ${chalk.gray(`(${groupAge})`)}`,
      );
      if (group.task.origin === "observation_promotion") {
        observationPromotedTasks.push(taskDisplay);
      }
      // Render nested commits with visual connectors
      for (let i = 0; i < group.commits.length; i++) {
        const { commit, date } = group.commits[i];
        const isLast = i === group.commits.length - 1;
        const connector = isLast ? "└─" : "├─";
        const commitAge = formatRelativeTime(new Date(date));
        console.log(
          `    ${chalk.gray(connector)} ${chalk.yellow(commit.hash)} ${commit.message} ${chalk.gray(`(${commitAge}, ${commit.author})`)}`,
        );
      }
    } else if (group.kind === "orphan_commit") {
      // AC: @session-start-activity-timeline ac-activity-orphan
      // Orphan commit: visually distinct from task entries
      const commitAge = formatRelativeTime(new Date(group.date));
      console.log(
        `  ${chalk.gray("○")} ${chalk.yellow(group.commit.hash)} ${group.commit.message} ${chalk.gray(`(${commitAge}, ${group.commit.author})`)}`,
      );
    }
  }

  // Show reminder about resolving observations
  if (observationPromotedTasks.length > 0) {
    console.log(
      chalk.yellow(
        `\n  ℹ Consider resolving linked observations: ${observationPromotedTasks.join(", ")}`,
      ),
    );
    console.log(chalk.gray(`    Run: kspec meta observations --pending-resolution`));
  }
}
