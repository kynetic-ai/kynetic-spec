/**
 * Session management commands
 *
 * Provides context for starting/resuming work sessions.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  loadInboxItems,
  getReadyTasks,
  ReferenceIndex,
  type LoadedTask,
  type LoadedInboxItem,
  type KspecContext,
} from '../../parser/index.js';
import { output, error, info, isJsonMode } from '../output.js';
import {
  parseTimeSpec,
  formatRelativeTime,
  isGitRepo,
  getRecentCommits,
  getCurrentBranch,
  getWorkingTreeStatus,
  type GitCommit,
  type GitWorkingTree,
} from '../../utils/index.js';
import type { Note, Todo } from '../../schema/index.js';

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
  type: 'uncommitted_changes' | 'in_progress_task' | 'incomplete_todo';
  description: string;
  details?: Record<string, unknown>;
}

export interface SessionContext {
  /** When this context was generated */
  generated_at: string;

  /** Current git branch */
  branch: string | null;

  /** Tasks currently in progress */
  active_tasks: ActiveTaskSummary[];

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
}

// ─── Data Gathering ──────────────────────────────────────────────────────────

function toActiveTaskSummary(
  task: LoadedTask,
  index: ReferenceIndex
): ActiveTaskSummary {
  const lastNote =
    task.notes.length > 0 ? task.notes[task.notes.length - 1] : null;
  const incompleteTodos = task.todos.filter(t => !t.done).length;
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
  index: ReferenceIndex
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
  allTasks: LoadedTask[],
  index: ReferenceIndex
): BlockedTaskSummary {
  // Find unmet dependencies
  const unmetDeps: string[] = [];
  for (const depRef of task.depends_on) {
    const result = index.resolve(depRef);
    if (result.ok) {
      const depItem = result.item;
      if ('status' in depItem && depItem.status !== 'completed') {
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
  index: ReferenceIndex
): CompletedTaskSummary {
  return {
    ref: index.shortUlid(task._ulid),
    title: task.title,
    completed_at: task.completed_at || '',
    closed_reason: task.closed_reason || null,
  };
}

function collectRecentNotes(
  tasks: LoadedTask[],
  index: ReferenceIndex,
  options: { limit: number; since: Date | null }
): NoteSummary[] {
  const allNotes: NoteSummary[] = [];

  for (const task of tasks) {
    for (const note of task.notes) {
      const noteDate = new Date(note.created_at);

      // Filter by since date if provided
      if (options.since && noteDate < options.since) {
        continue;
      }

      allNotes.push({
        task_ref: index.shortUlid(task._ulid),
        task_title: task.title,
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
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    .slice(0, options.limit);
}

function collectIncompleteTodos(
  tasks: LoadedTask[],
  index: ReferenceIndex,
  options: { limit: number }
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
      (a, b) =>
        new Date(b.added_at).getTime() - new Date(a.added_at).getTime()
    )
    .slice(0, options.limit);
}

/**
 * Gather session context data
 */
export async function gatherSessionContext(
  ctx: KspecContext,
  options: SessionOptions
): Promise<SessionContext> {
  const limit = parseInt(options.limit || '5', 10);
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
    in_progress: allTasks.filter((t) => t.status === 'in_progress').length,
    ready: getReadyTasks(allTasks).length,
    blocked: allTasks.filter((t) => t.status === 'blocked').length,
    completed: allTasks.filter((t) => t.status === 'completed').length,
    inbox_items: inboxItems.length,
  };

  // Get active tasks
  const activeTasks = allTasks
    .filter((t) => t.status === 'in_progress')
    .sort((a, b) => a.priority - b.priority)
    .slice(0, options.full ? undefined : limit)
    .map((t) => toActiveTaskSummary(t, index));

  // Get recent notes from active tasks
  const recentNotes = collectRecentNotes(
    allTasks.filter((t) => t.status === 'in_progress'),
    index,
    { limit: options.full ? limit * 2 : limit, since: sinceDate }
  );

  // Get incomplete todos from active tasks
  const activeTodos = collectIncompleteTodos(
    allTasks.filter((t) => t.status === 'in_progress'),
    index,
    { limit: options.full ? limit * 2 : limit }
  );

  // Get ready tasks
  const readyTasks = getReadyTasks(allTasks)
    .slice(0, options.full ? undefined : limit)
    .map((t) => toReadyTaskSummary(t, index));

  // Get blocked tasks
  const blockedTasks = allTasks
    .filter((t) => t.status === 'blocked')
    .slice(0, options.full ? undefined : limit)
    .map((t) => toBlockedTaskSummary(t, allTasks, index));

  // Get recently completed tasks
  const recentlyCompleted = allTasks
    .filter((t) => {
      if (t.status !== 'completed' || !t.completed_at) return false;
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
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, options.full ? undefined : limit)
    .map((item) => ({
      ref: item._ulid.slice(0, 8),
      text: item.text,
      created_at: item.created_at,
      tags: item.tags,
      added_by: item.added_by || null,
    }));

  return {
    generated_at: new Date().toISOString(),
    branch,
    active_tasks: activeTasks,
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
  options: CheckpointOptions
): Promise<CheckpointResult> {
  const issues: CheckpointIssue[] = [];
  const instructions: string[] = [];

  // Load tasks
  const allTasks = await loadAllTasks(ctx);

  // Check for in-progress tasks
  const inProgressTasks = allTasks.filter((t) => t.status === 'in_progress');
  for (const task of inProgressTasks) {
    const ref = task.slugs[0] ? `@${task.slugs[0]}` : `@${task._ulid.slice(0, 8)}`;
    issues.push({
      type: 'in_progress_task',
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
        type: 'incomplete_todo',
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
        type: 'uncommitted_changes',
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
    instructions.push('Before ending this session, please:');

    const hasInProgress = issues.some((i) => i.type === 'in_progress_task');
    const hasUncommitted = issues.some((i) => i.type === 'uncommitted_changes');
    const hasIncompleteTodos = issues.some((i) => i.type === 'incomplete_todo');

    if (hasInProgress) {
      instructions.push(
        '1. Add notes to in-progress tasks documenting current state'
      );
      instructions.push(
        '2. Either complete the tasks or leave them in_progress with clear notes for next session'
      );
    }

    if (hasIncompleteTodos) {
      instructions.push(
        '3. Complete or acknowledge incomplete todos on active tasks'
      );
    }

    if (hasUncommitted) {
      instructions.push('4. Commit your changes with a descriptive message');
    }

    instructions.push('');
    instructions.push(
      'Use: kspec task note @task "Progress notes..." to document state'
    );
    instructions.push(
      'Use: kspec task complete @task --reason "Summary" if task is done'
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
    message = '[kspec] Session checkpoint passed - ready to end session';
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
    console.log('');

    for (const issue of result.issues) {
      const icon =
        issue.type === 'uncommitted_changes'
          ? chalk.yellow('⚠')
          : issue.type === 'in_progress_task'
            ? chalk.blue('●')
            : chalk.gray('○');
      console.log(`  ${icon} ${issue.description}`);
    }

    if (result.instructions.length > 0) {
      console.log('');
      for (const instruction of result.instructions) {
        console.log(chalk.gray(instruction));
      }
    }
  }
}

function formatSessionContext(ctx: SessionContext, options: SessionOptions): void {
  const isBrief = !options.full;

  // Header
  console.log(chalk.bold.blue('\n=== Session Context ==='));
  const age = formatRelativeTime(new Date(ctx.generated_at));
  if (ctx.branch) {
    console.log(chalk.gray(`Branch: ${ctx.branch} | Generated: ${age}`));
  } else {
    console.log(chalk.gray(`Generated: ${age}`));
  }

  // Stats summary
  const inboxNote = ctx.stats.inbox_items > 0
    ? ` | Inbox: ${ctx.stats.inbox_items}`
    : '';
  console.log(
    chalk.gray(
      `Tasks: ${ctx.stats.in_progress} active, ${ctx.stats.ready} ready, ` +
        `${ctx.stats.blocked} blocked, ${ctx.stats.completed}/${ctx.stats.total_tasks} completed${inboxNote}`
    )
  );

  // Active tasks section
  if (ctx.active_tasks.length > 0) {
    console.log(chalk.bold.cyan('\n--- Active Work ---'));
    for (const task of ctx.active_tasks) {
      const started = task.started_at
        ? chalk.gray(` (started ${formatRelativeTime(new Date(task.started_at))})`)
        : '';
      const priority =
        task.priority <= 2
          ? chalk.red(`P${task.priority}`)
          : chalk.gray(`P${task.priority}`);
      console.log(
        `  ${chalk.blue('[in_progress]')} ${priority} ${task.ref} ${task.title}${started}`
      );
    }
  } else {
    console.log(chalk.gray('\n--- No Active Work ---'));
  }

  // Recently completed section
  if (ctx.recently_completed.length > 0) {
    console.log(chalk.bold.green('\n--- Recently Completed ---'));
    for (const task of ctx.recently_completed) {
      const completedAge = formatRelativeTime(new Date(task.completed_at));
      let reason = '';
      if (task.closed_reason) {
        const maxLen = isBrief ? 60 : 120;
        const truncated = task.closed_reason.length > maxLen
          ? task.closed_reason.slice(0, maxLen).trim() + '...'
          : task.closed_reason;
        reason = chalk.gray(` - ${truncated}`);
      }
      console.log(
        `  ${chalk.green('[completed]')} ${task.ref} ${task.title} ${chalk.gray(`(${completedAge})`)}${reason}`
      );
    }
  }

  // Recent notes section
  if (ctx.recent_notes.length > 0) {
    console.log(chalk.bold.cyan('\n--- Recent Notes ---'));
    for (const note of ctx.recent_notes) {
      const age = formatRelativeTime(new Date(note.created_at));
      const author = note.author ? chalk.gray(` by ${note.author}`) : '';
      console.log(`  ${chalk.yellow(age)} on ${note.task_ref}${author}:`);

      // Truncate content in brief mode
      let content = note.content.trim();
      if (isBrief && content.length > 200) {
        content = content.slice(0, 200).trim() + '...';
      }

      // Indent content, limit lines in brief mode
      const lines = content.split('\n');
      const maxLines = isBrief ? 3 : lines.length;
      for (const line of lines.slice(0, maxLines)) {
        console.log(`    ${chalk.white(line)}`);
      }
      if (isBrief && lines.length > maxLines) {
        console.log(chalk.gray(`    ... (${lines.length - maxLines} more lines)`));
      }
    }
  }

  // Incomplete todos section
  if (ctx.active_todos.length > 0) {
    console.log(chalk.bold.yellow('\n--- Incomplete Todos ---'));
    for (const todo of ctx.active_todos) {
      console.log(`  ${chalk.yellow('[ ]')} ${todo.task_ref}#${todo.id}: ${todo.text}`);
    }
  }

  // Ready tasks section
  if (ctx.ready_tasks.length > 0) {
    console.log(chalk.bold.cyan('\n--- Ready to Pick Up ---'));
    for (const task of ctx.ready_tasks) {
      const priority =
        task.priority <= 2
          ? chalk.red(`P${task.priority}`)
          : chalk.gray(`P${task.priority}`);
      const tags =
        task.tags.length > 0 ? chalk.cyan(` #${task.tags.join(' #')}`) : '';
      console.log(`  ${priority} ${task.ref} ${task.title}${tags}`);
    }
  }

  // Blocked tasks section
  if (ctx.blocked_tasks.length > 0) {
    console.log(chalk.bold.red('\n--- Blocked ---'));
    for (const task of ctx.blocked_tasks) {
      console.log(`  ${chalk.red('[blocked]')} ${task.ref} ${task.title}`);
      if (task.blocked_by.length > 0) {
        console.log(chalk.gray(`    Blockers: ${task.blocked_by.join(', ')}`));
      }
      if (task.unmet_deps.length > 0) {
        console.log(chalk.gray(`    Waiting on: ${task.unmet_deps.join(', ')}`));
      }
    }
  }

  // Git commits section
  if (ctx.recent_commits.length > 0) {
    console.log(chalk.bold.cyan('\n--- Recent Commits ---'));
    for (const commit of ctx.recent_commits) {
      const age = formatRelativeTime(new Date(commit.date));
      console.log(
        `  ${chalk.yellow(commit.hash)} ${commit.message} ${chalk.gray(`(${age}, ${commit.author})`)}`
      );
    }
  }

  // Inbox section (oldest first to encourage triage)
  if (ctx.inbox_items.length > 0) {
    console.log(chalk.bold.magenta('\n--- Inbox (oldest first) ---'));
    for (const item of ctx.inbox_items) {
      const age = formatRelativeTime(new Date(item.created_at));
      const author = item.added_by ? ` by ${item.added_by}` : '';
      const tags = item.tags.length > 0 ? chalk.cyan(` [${item.tags.join(', ')}]`) : '';
      // Truncate text in brief mode
      let text = item.text;
      if (isBrief && text.length > 60) {
        text = text.slice(0, 60).trim() + '...';
      }
      console.log(`  ${chalk.magenta(item.ref)} ${chalk.gray(`(${age}${author})`)}${tags}`);
      console.log(`    ${text}`);
    }
    console.log(chalk.gray('  Use: kspec inbox promote <ref> to convert to task'));
  }

  // Working tree section
  if (ctx.working_tree && !ctx.working_tree.clean) {
    console.log(chalk.bold.yellow('\n--- Working Tree ---'));

    if (ctx.working_tree.staged.length > 0) {
      console.log(chalk.green('  Staged:'));
      for (const file of ctx.working_tree.staged) {
        console.log(`    ${chalk.green(file.status[0].toUpperCase())} ${file.path}`);
      }
    }

    if (ctx.working_tree.unstaged.length > 0) {
      console.log(chalk.red('  Modified:'));
      for (const file of ctx.working_tree.unstaged) {
        console.log(`    ${chalk.red(file.status[0].toUpperCase())} ${file.path}`);
      }
    }

    if (ctx.working_tree.untracked.length > 0) {
      console.log(chalk.gray('  Untracked:'));
      const limit = isBrief ? 5 : ctx.working_tree.untracked.length;
      for (const path of ctx.working_tree.untracked.slice(0, limit)) {
        console.log(`    ${chalk.gray('?')} ${path}`);
      }
      if (isBrief && ctx.working_tree.untracked.length > limit) {
        console.log(chalk.gray(`    ... and ${ctx.working_tree.untracked.length - limit} more`));
      }
    }
  } else if (ctx.working_tree?.clean) {
    console.log(chalk.gray('\n--- Working Tree: Clean ---'));
  }

  console.log(''); // Final newline
}

// ─── Command Registration ────────────────────────────────────────────────────

async function sessionStartAction(options: SessionOptions): Promise<void> {
  try {
    const ctx = await initContext();
    const sessionCtx = await gatherSessionContext(ctx, options);

    output(sessionCtx, () => formatSessionContext(sessionCtx, options));
  } catch (err) {
    error('Failed to gather session context', err);
    process.exit(1);
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
    let data = '';
    const timeout = setTimeout(() => {
      process.stdin.removeAllListeners();
      resolve(data || null);
    }, 100); // 100ms timeout for stdin

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      resolve(data || null);
    });
    process.stdin.on('error', () => {
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

async function sessionCheckpointAction(options: CheckpointOptions): Promise<void> {
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
        const issueLines = result.issues.map(i => `- ${i.description}`).join('\n');
        const instructionLines = result.instructions.filter(i => i.trim()).join('\n');
        const reason = `${result.message}\n\nIssues:\n${issueLines}\n\n${instructionLines}`;
        console.log(JSON.stringify({ decision: 'block', reason }));
      }
      // If ok, exit silently (Claude Code expects no output when allowing stop)
    } else {
      formatCheckpointResult(result);
      if (!result.ok) {
        process.exit(1);
      }
    }
  } catch (err) {
    error('Failed to run checkpoint', err);
    process.exit(1);
  }
}

/**
 * Register the 'session' command group and aliases
 */
export function registerSessionCommands(program: Command): void {
  const session = program
    .command('session')
    .description('Session management and context');

  session
    .command('start')
    .alias('resume')
    .description('Surface relevant context for starting a new working session')
    .option('--brief', 'Compact summary (default)')
    .option('--full', 'Comprehensive context dump')
    .option('--since <time>', 'Filter by recency (ISO8601 or relative: 1h, 2d, 1w)')
    .option('--no-git', 'Skip git commit information')
    .option('-n, --limit <n>', 'Limit items per section', '5')
    .action(sessionStartAction);

  session
    .command('checkpoint')
    .description('Pre-stop hook: check for uncommitted work before ending session')
    .option('--force', 'Allow session end regardless of issues')
    .action(sessionCheckpointAction);

  // Top-level alias: kspec context
  program
    .command('context')
    .description('Alias for session start - surface session context')
    .option('--brief', 'Compact summary (default)')
    .option('--full', 'Comprehensive context dump')
    .option('--since <time>', 'Filter by recency (ISO8601 or relative: 1h, 2d, 1w)')
    .option('--no-git', 'Skip git commit information')
    .option('-n, --limit <n>', 'Limit items per section', '5')
    .action(sessionStartAction);
}
