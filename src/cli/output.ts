import chalk from 'chalk';
import type { Task, TaskStatus } from '../schema/index.js';
import type { ReferenceIndex } from '../parser/index.js';

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
 * @param task The task to format
 * @param index Optional ReferenceIndex for dynamic short ULID computation
 */
export function formatTaskRef(task: Task, index?: ReferenceIndex): string {
  const shortId = index ? index.shortUlid(task._ulid) : task._ulid.slice(0, 8);
  if (task.slugs.length > 0) {
    return `${shortId} (${task.slugs[0]})`;
  }
  return shortId;
}

/**
 * Format task for display
 */
export function formatTask(task: Task, verbose = false, index?: ReferenceIndex): string {
  const ref = formatTaskRef(task, index);
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
export function formatTaskList(tasks: Task[], verbose = false, index?: ReferenceIndex): void {
  if (tasks.length === 0) {
    console.log(chalk.gray('No tasks found'));
    return;
  }

  for (const task of tasks) {
    console.log(formatTask(task, verbose, index));
  }

  console.log(chalk.gray(`\n${tasks.length} task(s)`));
}

/**
 * Format task details
 */
export function formatTaskDetails(task: Task, index?: ReferenceIndex): void {
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
    if (index) {
      console.log(`Depends:`);
      for (const ref of task.depends_on) {
        const result = index.resolve(ref);
        if (result.ok) {
          const item = result.item;
          const status = 'status' in item && typeof item.status === 'string'
            ? statusColor(item.status as TaskStatus)(`[${item.status}]`)
            : chalk.gray('[spec]');
          console.log(`  ${ref} ${chalk.gray('→')} ${item.title} ${status}`);
        } else {
          console.log(`  ${ref} ${chalk.red('(unresolved)')}`);
        }
      }
    } else {
      console.log(`Depends:   ${task.depends_on.join(', ')}`);
    }
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

  // Show resolved spec information
  if (task.spec_ref && index) {
    const result = index.resolve(task.spec_ref);
    if (result.ok) {
      const spec = result.item;
      console.log(chalk.gray('\n─── Spec Context ───'));
      console.log(chalk.cyan(spec.title));
      if (spec.type) {
        console.log(chalk.gray(`Type: ${spec.type}`));
      }
      // Show implementation status
      if ('status' in spec && spec.status && typeof spec.status === 'object') {
        const status = spec.status as { maturity?: string; implementation?: string };
        if (status.implementation) {
          const implColor = status.implementation === 'verified' ? chalk.green
            : status.implementation === 'implemented' ? chalk.cyan
            : status.implementation === 'in_progress' ? chalk.yellow
            : chalk.gray;
          console.log(chalk.gray('Implementation: ') + implColor(status.implementation));
        }
      }
      if ('description' in spec && spec.description) {
        console.log(chalk.gray('Description:'));
        // Indent description lines
        const desc = String(spec.description).trim();
        for (const line of desc.split('\n')) {
          console.log(chalk.gray(`  ${line}`));
        }
      }
      if ('acceptance_criteria' in spec && Array.isArray(spec.acceptance_criteria) && spec.acceptance_criteria.length > 0) {
        console.log(chalk.gray('Acceptance Criteria:'));
        for (const ac of spec.acceptance_criteria) {
          if (ac && typeof ac === 'object' && 'id' in ac) {
            const acObj = ac as { id: string; given?: string; when?: string; then?: string };
            console.log(chalk.gray(`  [${acObj.id}]`));
            if (acObj.given) console.log(chalk.gray(`    Given: ${acObj.given}`));
            if (acObj.when) console.log(chalk.gray(`    When: ${acObj.when}`));
            if (acObj.then) console.log(chalk.gray(`    Then: ${acObj.then}`));
          }
        }
      }
      // Show traceability if present
      if ('traceability' in spec && spec.traceability && typeof spec.traceability === 'object') {
        const trace = spec.traceability as {
          implementation?: Array<{ path: string; function?: string; lines?: string }>;
          tests?: Array<{ path: string }>;
          commits?: string[];
          issues?: string[];
        };
        const hasTrace = trace.implementation?.length || trace.tests?.length || trace.commits?.length || trace.issues?.length;
        if (hasTrace) {
          console.log(chalk.gray('Traceability:'));
          if (trace.implementation?.length) {
            for (const impl of trace.implementation) {
              let loc = `  Code: ${impl.path}`;
              if (impl.function) loc += `::${impl.function}`;
              if (impl.lines) loc += `:${impl.lines}`;
              console.log(chalk.gray(loc));
            }
          }
          if (trace.tests?.length) {
            for (const test of trace.tests) {
              console.log(chalk.gray(`  Test: ${test.path}`));
            }
          }
          if (trace.commits?.length) {
            console.log(chalk.gray(`  Commits: ${trace.commits.join(', ')}`));
          }
          if (trace.issues?.length) {
            console.log(chalk.gray(`  Issues: ${trace.issues.join(', ')}`));
          }
        }
      }
    }
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
