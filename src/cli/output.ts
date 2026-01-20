import chalk from 'chalk';
import type { Task, TaskStatus } from '../schema/index.js';
import type { ReferenceIndex } from '../parser/index.js';
import { grepItem, formatMatchedFields } from '../utils/grep.js';
import { fieldLabels, sectionHeaders, summaries } from '../strings/labels.js';

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
 * Global verbose mode (set by --verbose flag)
 */
let globalVerboseMode = false;

export function setVerboseMode(enabled: boolean): void {
  globalVerboseMode = enabled;
}

export function getVerboseMode(): boolean {
  return globalVerboseMode;
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
      // Show suggestion if it's a ShadowError with a suggestion
      if (details && typeof details === 'object' && 'suggestion' in details) {
        const suggestion = (details as { suggestion?: string }).suggestion;
        if (suggestion) {
          console.error(chalk.yellow('  Suggestion:'), suggestion);
        }
      }
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
export function formatTask(task: Task, verbose = false, index?: ReferenceIndex, full = false): string {
  const ref = formatTaskRef(task, index);
  const status = statusColor(task.status)(`[${task.status}]`);
  const priority = task.priority <= 2 ? chalk.red(`P${task.priority}`) : chalk.gray(`P${task.priority}`);

  let line = `${ref} ${status} ${priority} ${task.title}`;

  if (verbose && !full) {
    // AC-2: Single verbose (-v) shows current behavior
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
 * Get first line of text, truncated to max length
 */
function getFirstLine(text: string | undefined, maxLength: number = 70): string | undefined {
  if (!text) return undefined;
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength - 3) + '...';
}

/**
 * Format full mode context for a task (AC-1, AC-3, AC-5)
 */
function formatFullModeContext(task: Task, index?: ReferenceIndex): void {
  const indent = '    ';

  // Show timestamps (AC-1)
  console.log(chalk.gray(`${indent}Created: ${task.created_at}`));
  if (task.started_at) {
    console.log(chalk.gray(`${indent}Started: ${task.started_at}`));
  }
  if (task.completed_at) {
    console.log(chalk.gray(`${indent}Completed: ${task.completed_at}`));
  }

  // Show notes count and most recent note (AC-1, AC-3)
  if (task.notes && task.notes.length > 0) {
    const mostRecent = task.notes[task.notes.length - 1];
    const preview = getFirstLine(mostRecent.content, 50);
    console.log(chalk.gray(`${indent}Notes: ${task.notes.length} (latest: "${preview}")`));
  }

  // Show pending todos count (AC-1, AC-3)
  if (task.todos && task.todos.length > 0) {
    const pendingCount = task.todos.filter(t => !t.done).length;
    if (pendingCount > 0) {
      console.log(chalk.gray(`${indent}Pending todos: ${pendingCount}`));
    }
  }

  // Show spec context (AC-5)
  if (task.spec_ref && index) {
    const result = index.resolve(task.spec_ref);
    if (result.ok) {
      const spec = result.item;
      const specName = 'title' in spec ? spec.title : ('name' in spec ? spec.name : ('id' in spec ? spec.id : task.spec_ref));
      console.log(chalk.gray(`${indent}Spec: ${task.spec_ref}`));
      console.log(chalk.cyan(`${indent}  ${specName}`));

      // Show spec description if available
      if ('description' in spec && spec.description) {
        const descPreview = getFirstLine(spec.description as string, 70);
        console.log(chalk.gray(`${indent}  ${descPreview}`));
      }

      // Show acceptance criteria if available
      if ('acceptance_criteria' in spec && Array.isArray(spec.acceptance_criteria)) {
        const ac = spec.acceptance_criteria;
        if (ac.length > 0) {
          console.log(chalk.gray(`${indent}  Acceptance Criteria: ${ac.length}`));
          // Show first AC as preview
          const firstAC = ac[0];
          if (typeof firstAC === 'object' && firstAC !== null && 'id' in firstAC) {
            console.log(chalk.gray(`${indent}    [${firstAC.id}] ${firstAC.then}`));
          }
        }
      }
    }
  }

  // Show tags and dependencies if present
  if (task.tags && task.tags.length > 0) {
    console.log(chalk.gray(`${indent}Tags: ${task.tags.join(', ')}`));
  }
  if (task.depends_on && task.depends_on.length > 0) {
    console.log(chalk.gray(`${indent}Depends on: ${task.depends_on.join(', ')}`));
  }
}

/**
 * Format automation status as a colored label
 * AC: @task-automation-eligibility ac-14
 */
function formatAutomationStatus(automation: string | undefined): string {
  if (!automation) {
    return chalk.gray('[unassessed]');
  }
  switch (automation) {
    case 'eligible':
      return chalk.green('[eligible]');
    case 'needs_review':
      return chalk.yellow('[needs_review]');
    case 'manual_only':
      return chalk.red('[manual_only]');
    default:
      return chalk.gray(`[${automation}]`);
  }
}

/**
 * Format a list of tasks with automation status
 * AC: @task-automation-eligibility ac-14
 */
export function formatTaskListWithAutomation(tasks: Task[], verbose = false, index?: ReferenceIndex, grepPattern?: string, full = false): void {
  if (tasks.length === 0) {
    console.log(summaries.noTasks);
    return;
  }

  for (const task of tasks) {
    const ref = formatTaskRef(task, index);
    const status = statusColor(task.status)(`[${task.status}]`);
    const priority = task.priority <= 2 ? chalk.red(`P${task.priority}`) : chalk.gray(`P${task.priority}`);
    const automationLabel = formatAutomationStatus(task.automation);

    let line = `${ref} ${status} ${priority} ${automationLabel} ${task.title}`;

    if (verbose && !full) {
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

    console.log(line);

    // Show matched fields if grep pattern provided
    if (grepPattern) {
      const match = grepItem(task as unknown as Record<string, unknown>, grepPattern);
      if (match && match.matchedFields.length > 0) {
        console.log(chalk.gray(`    matched: ${formatMatchedFields(match.matchedFields)}`));
      }
    } else if (full) {
      formatFullModeContext(task, index);
    } else {
      // Show context line: first line of description (if present)
      const context = getFirstLine(task.description);
      if (context) {
        console.log(chalk.gray(`    ${context}`));
      }
    }
  }

  console.log(summaries.taskCount(tasks.length));
}

/**
 * Format a list of tasks
 */
export function formatTaskList(tasks: Task[], verbose = false, index?: ReferenceIndex, grepPattern?: string, full = false): void {
  if (tasks.length === 0) {
    console.log(summaries.noTasks);
    return;
  }

  for (const task of tasks) {
    console.log(formatTask(task, verbose, index, full));

    // Show matched fields if grep pattern provided
    if (grepPattern) {
      const match = grepItem(task as unknown as Record<string, unknown>, grepPattern);
      if (match && match.matchedFields.length > 0) {
        console.log(chalk.gray(`    matched: ${formatMatchedFields(match.matchedFields)}`));
      }
    } else if (full) {
      // AC-1: Full mode shows richer context
      formatFullModeContext(task, index);
    } else {
      // Show context line: first line of description (if present)
      const context = getFirstLine(task.description);
      if (context) {
        console.log(chalk.gray(`    ${context}`));
      }
    }
  }

  console.log(summaries.taskCount(tasks.length));
}

/**
 * Format task details
 */
export function formatTaskDetails(task: Task, index?: ReferenceIndex): void {
  console.log(chalk.bold(task.title));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`${fieldLabels.ulid}      ${task._ulid}`);
  if (task.slugs.length > 0) {
    console.log(`${fieldLabels.slugs}     ${task.slugs.join(', ')}`);
  }
  console.log(`${fieldLabels.type}      ${task.type}`);
  console.log(`${fieldLabels.status}    ${statusColor(task.status)(task.status)}`);
  console.log(`${fieldLabels.priority}  ${task.priority}`);

  // AC: @task-automation-eligibility ac-17 - show automation status
  const automationDisplay = task.automation || 'unassessed';
  const automationColor = task.automation === 'eligible' ? chalk.green
    : task.automation === 'needs_review' ? chalk.yellow
    : task.automation === 'manual_only' ? chalk.red
    : chalk.gray;
  console.log(`${fieldLabels.automation} ${automationColor(automationDisplay)}`);

  if (task.spec_ref) {
    console.log(`${fieldLabels.specRef}  ${task.spec_ref}`);
  }

  if (task.depends_on.length > 0) {
    if (index) {
      console.log(fieldLabels.depends);
      for (const ref of task.depends_on) {
        const result = index.resolve(ref);
        if (result.ok) {
          const item = result.item;
          const status = 'status' in item && typeof item.status === 'string'
            ? statusColor(item.status as TaskStatus)(`[${item.status}]`)
            : chalk.gray('[spec]');
          // Handle both spec items (with title) and meta items (with name or id)
          const itemName = 'title' in item ? item.title : ('name' in item ? item.name : ('id' in item ? item.id : ref));
          console.log(`  ${ref} ${chalk.gray('→')} ${itemName} ${status}`);
        } else {
          console.log(`  ${ref} ${chalk.red('(unresolved)')}`);
        }
      }
    } else {
      console.log(`${fieldLabels.depends}   ${task.depends_on.join(', ')}`);
    }
  }

  if (task.blocked_by.length > 0) {
    console.log(chalk.red(`${fieldLabels.blocked}   ${task.blocked_by.join(', ')}`));
  }

  if (task.tags.length > 0) {
    console.log(`${fieldLabels.tags}      ${task.tags.join(', ')}`);
  }

  console.log(`${fieldLabels.created}   ${task.created_at}`);
  if (task.started_at) {
    console.log(`${fieldLabels.started}   ${task.started_at}`);
  }
  if (task.completed_at) {
    console.log(`${fieldLabels.completed} ${task.completed_at}`);
  }

  // Show resolved spec information
  if (task.spec_ref && index) {
    const result = index.resolve(task.spec_ref);
    if (result.ok) {
      const spec = result.item;
      console.log(`\n${sectionHeaders.specContext}`);
      // Handle both spec items (with title) and meta items (with name)
      const specName = 'title' in spec ? spec.title : ('name' in spec ? spec.name : ('id' in spec ? spec.id : task.spec_ref));
      console.log(chalk.cyan(specName));
      if ('type' in spec && spec.type) {
        console.log(chalk.gray(`${fieldLabels.type} ${spec.type}`));
      }
      // Show implementation status
      if ('status' in spec && spec.status && typeof spec.status === 'object') {
        const status = spec.status as { maturity?: string; implementation?: string };
        if (status.implementation) {
          const implColor = status.implementation === 'verified' ? chalk.green
            : status.implementation === 'implemented' ? chalk.cyan
            : status.implementation === 'in_progress' ? chalk.yellow
            : chalk.gray;
          console.log(chalk.gray(fieldLabels.implementation) + implColor(status.implementation));
        }
      }
      if ('description' in spec && spec.description) {
        console.log(chalk.gray(fieldLabels.description));
        // Indent description lines
        const desc = String(spec.description).trim();
        for (const line of desc.split('\n')) {
          console.log(chalk.gray(`  ${line}`));
        }
      }
      if ('acceptance_criteria' in spec && Array.isArray(spec.acceptance_criteria) && spec.acceptance_criteria.length > 0) {
        console.log(chalk.gray(fieldLabels.acceptanceCriteria));
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
          console.log(chalk.gray(fieldLabels.traceability));
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
    console.log(`\n${sectionHeaders.notes}`);
    for (const note of task.notes) {
      const author = note.author || 'unknown';
      console.log(chalk.gray(`[${note.created_at}] ${author}:`));
      console.log(note.content);
    }
  }

  if (task.todos.length > 0) {
    console.log(`\n${sectionHeaders.todos}`);
    for (const todo of task.todos) {
      const check = todo.done ? chalk.green('✓') : chalk.gray('○');
      const text = todo.done ? chalk.strikethrough.gray(todo.text) : todo.text;
      console.log(`${check} [${todo.id}] ${text}`);
    }
  }
}
