import chalk from 'chalk';
import type { Task, TaskStatus } from '../schema/index.js';

/**
 * Output options
 */
export interface OutputOptions {
  json?: boolean;
}

/**
 * Global output format (set by --json flag)
 */
let globalJsonMode = false;

export function setJsonMode(enabled: boolean): void {
  globalJsonMode = enabled;
}

export function isJsonMode(): boolean {
  return globalJsonMode;
}

/**
 * Output data - JSON if --json flag, otherwise formatted
 */
export function output(data: unknown, formatter?: () => void): void {
  if (globalJsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else if (formatter) {
    formatter();
  } else {
    console.log(data);
  }
}

/**
 * Output success message
 */
export function success(message: string, data?: Record<string, unknown>): void {
  if (globalJsonMode) {
    console.log(JSON.stringify({ success: true, message, ...data }));
  } else {
    console.log(chalk.green('OK'), message);
  }
}

/**
 * Output error message
 */
export function error(message: string, details?: unknown): void {
  if (globalJsonMode) {
    console.error(JSON.stringify({ success: false, error: message, details }));
  } else {
    console.error(chalk.red('✗'), message);
    if (details) {
      console.error(chalk.gray(String(details)));
    }
  }
}

/**
 * Output warning message
 */
export function warn(message: string): void {
  if (globalJsonMode) {
    // Warnings are suppressed in JSON mode
  } else {
    console.warn(chalk.yellow('⚠'), message);
  }
}

/**
 * Output info message
 */
export function info(message: string): void {
  if (globalJsonMode) {
    // Info messages suppressed in JSON mode
  } else {
    console.log(chalk.blue('ℹ'), message);
  }
}

/**
 * Get color for task status
 */
function statusColor(status: TaskStatus): (text: string) => string {
  switch (status) {
    case 'pending':
      return (t: string) => chalk.gray(t);
    case 'in_progress':
      return (t: string) => chalk.blue(t);
    case 'blocked':
      return (t: string) => chalk.red(t);
    case 'completed':
      return (t: string) => chalk.green(t);
    case 'cancelled':
      return (t: string) => chalk.strikethrough.gray(t);
    default:
      return (t: string) => chalk.white(t);
  }
}

/**
 * Format a task reference (short ULID + slug if available)
 */
export function formatTaskRef(task: Task): string {
  const shortId = task._ulid.slice(0, 8);
  if (task.slugs.length > 0) {
    return `${shortId} (${task.slugs[0]})`;
  }
  return shortId;
}

/**
 * Format task for display
 */
export function formatTask(task: Task, verbose = false): string {
  const ref = formatTaskRef(task);
  const status = statusColor(task.status)(`[${task.status}]`);
  const priority = task.priority <= 2 ? chalk.red(`P${task.priority}`) : chalk.gray(`P${task.priority}`);

  let line = `${ref} ${status} ${priority} ${task.title}`;

  if (verbose) {
    if (task.spec_ref) {
      line += chalk.gray(` (spec: ${task.spec_ref})`);
    }
    if (task.depends_on.length > 0) {
      line += chalk.gray(` deps: [${task.depends_on.join(', ')}]`);
    }
    if (task.tags.length > 0) {
      line += chalk.cyan(` #${task.tags.join(' #')}`);
    }
  }

  return line;
}

/**
 * Format a list of tasks
 */
export function formatTaskList(tasks: Task[], verbose = false): void {
  if (tasks.length === 0) {
    console.log(chalk.gray('No tasks found'));
    return;
  }

  for (const task of tasks) {
    console.log(formatTask(task, verbose));
  }

  console.log(chalk.gray(`\n${tasks.length} task(s)`));
}

/**
 * Format task details
 */
export function formatTaskDetails(task: Task): void {
  console.log(chalk.bold(task.title));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`ULID:      ${task._ulid}`);
  if (task.slugs.length > 0) {
    console.log(`Slugs:     ${task.slugs.join(', ')}`);
  }
  console.log(`Type:      ${task.type}`);
  console.log(`Status:    ${statusColor(task.status)(task.status)}`);
  console.log(`Priority:  ${task.priority}`);

  if (task.spec_ref) {
    console.log(`Spec ref:  ${task.spec_ref}`);
  }

  if (task.depends_on.length > 0) {
    console.log(`Depends:   ${task.depends_on.join(', ')}`);
  }

  if (task.blocked_by.length > 0) {
    console.log(chalk.red(`Blocked:   ${task.blocked_by.join(', ')}`));
  }

  if (task.tags.length > 0) {
    console.log(`Tags:      ${task.tags.join(', ')}`);
  }

  console.log(`Created:   ${task.created_at}`);
  if (task.started_at) {
    console.log(`Started:   ${task.started_at}`);
  }
  if (task.completed_at) {
    console.log(`Completed: ${task.completed_at}`);
  }

  if (task.notes.length > 0) {
    console.log(chalk.gray('\n─── Notes ───'));
    for (const note of task.notes) {
      const author = note.author || 'unknown';
      console.log(chalk.gray(`[${note.created_at}] ${author}:`));
      console.log(note.content);
    }
  }

  if (task.todos.length > 0) {
    console.log(chalk.gray('\n─── Todos ───'));
    for (const todo of task.todos) {
      const check = todo.done ? chalk.green('✓') : chalk.gray('○');
      const text = todo.done ? chalk.strikethrough.gray(todo.text) : todo.text;
      console.log(`${check} [${todo.id}] ${text}`);
    }
  }
}
