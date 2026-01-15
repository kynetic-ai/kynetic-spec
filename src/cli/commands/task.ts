import { Command } from 'commander';
import { ulid } from 'ulid';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  saveTask,
  createTask,
  createNote,
  ReferenceIndex,
  type LoadedTask,
} from '../../parser/index.js';
import {
  output,
  formatTaskDetails,
  success,
  error,
  warn,
} from '../output.js';
import type { Task, TaskInput } from '../../schema/index.js';

/**
 * Find a task by reference with detailed error reporting.
 * Returns the task or exits with appropriate error.
 */
function resolveTaskRef(
  ref: string,
  tasks: LoadedTask[],
  index: ReferenceIndex
): LoadedTask {
  const result = index.resolve(ref);

  if (!result.ok) {
    switch (result.error) {
      case 'not_found':
        error(`Task not found: ${ref}`);
        break;
      case 'ambiguous':
        error(`Reference "${ref}" is ambiguous. Matches:`);
        for (const candidate of result.candidates) {
          const task = tasks.find(t => t._ulid === candidate);
          const slug = task?.slugs[0] || '';
          console.error(`  - ${index.shortUlid(candidate)} ${slug ? `(${slug})` : ''}`);
        }
        break;
      case 'duplicate_slug':
        error(`Slug "${ref}" maps to multiple items. Use ULID instead:`);
        for (const candidate of result.candidates) {
          console.error(`  - ${index.shortUlid(candidate)}`);
        }
        break;
    }
    process.exit(3);
  }

  // Check if it's actually a task
  const task = tasks.find(t => t._ulid === result.ulid);
  if (!task) {
    error(`Reference "${ref}" is not a task (it's a spec item)`);
    process.exit(3);
  }

  return task;
}

/**
 * Register the 'task' command group (singular - operations on individual tasks)
 */
export function registerTaskCommands(program: Command): void {
  const task = program
    .command('task')
    .description('Operations on individual tasks');

  // kspec task get <ref>
  task
    .command('get <ref>')
    .description('Get task details')
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        output(foundTask, () => formatTaskDetails(foundTask, index));
      } catch (err) {
        error('Failed to get task', err);
        process.exit(1);
      }
    });

  // kspec task add
  task
    .command('add')
    .description('Create a new task')
    .requiredOption('--title <title>', 'Task title')
    .option('--type <type>', 'Task type (task, epic, bug, spike, infra)', 'task')
    .option('--spec-ref <ref>', 'Reference to spec item')
    .option('--priority <n>', 'Priority (1-5)', '3')
    .option('--slug <slug>', 'Human-friendly slug')
    .option('--tag <tag...>', 'Tags')
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);

        const input: TaskInput = {
          title: options.title,
          type: options.type,
          spec_ref: options.specRef || null,
          priority: parseInt(options.priority, 10),
          slugs: options.slug ? [options.slug] : [],
          tags: options.tag || [],
        };

        const newTask = createTask(input);
        await saveTask(ctx, newTask);

        // Build index including the new task for accurate short ULID
        const index = new ReferenceIndex([...tasks, newTask], items);
        success(`Created task: ${index.shortUlid(newTask._ulid)}`, { task: newTask });
      } catch (err) {
        error('Failed to create task', err);
        process.exit(1);
      }
    });

  // kspec task start <ref>
  task
    .command('start <ref>')
    .description('Start working on a task (pending -> in_progress)')
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        if (foundTask.status === 'in_progress') {
          warn('Task is already in progress');
          output(foundTask, () => formatTaskDetails(foundTask));
          return;
        }

        if (foundTask.status !== 'pending') {
          error(`Cannot start task with status: ${foundTask.status}`);
          process.exit(4); // Exit code 4 = invalid state
        }

        // Update status
        const updatedTask: Task = {
          ...foundTask,
          status: 'in_progress',
          started_at: new Date().toISOString(),
        };

        await saveTask(ctx, updatedTask);
        success(`Started task: ${index.shortUlid(updatedTask._ulid)}`, { task: updatedTask });
      } catch (err) {
        error('Failed to start task', err);
        process.exit(1);
      }
    });

  // kspec task complete <ref>
  task
    .command('complete <ref>')
    .description('Complete a task (in_progress -> completed)')
    .option('--reason <reason>', 'Completion reason/notes')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        if (foundTask.status === 'completed') {
          warn('Task is already completed');
          output(foundTask, () => formatTaskDetails(foundTask));
          return;
        }

        if (foundTask.status !== 'in_progress' && foundTask.status !== 'pending') {
          error(`Cannot complete task with status: ${foundTask.status}`);
          process.exit(4);
        }

        const now = new Date().toISOString();

        // Update status
        const updatedTask: Task = {
          ...foundTask,
          status: 'completed',
          completed_at: now,
          closed_reason: options.reason || null,
          started_at: foundTask.started_at || now, // Set started_at if not already
        };

        await saveTask(ctx, updatedTask);
        success(`Completed task: ${index.shortUlid(updatedTask._ulid)}`, { task: updatedTask });
      } catch (err) {
        error('Failed to complete task', err);
        process.exit(1);
      }
    });

  // kspec task block <ref>
  task
    .command('block <ref>')
    .description('Block a task')
    .requiredOption('--reason <reason>', 'Reason for blocking')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        if (foundTask.status === 'completed' || foundTask.status === 'cancelled') {
          error(`Cannot block task with status: ${foundTask.status}`);
          process.exit(4);
        }

        const updatedTask: Task = {
          ...foundTask,
          status: 'blocked',
          blocked_by: [...foundTask.blocked_by, options.reason],
        };

        await saveTask(ctx, updatedTask);
        success(`Blocked task: ${index.shortUlid(updatedTask._ulid)}`, { task: updatedTask });
      } catch (err) {
        error('Failed to block task', err);
        process.exit(1);
      }
    });

  // kspec task unblock <ref>
  task
    .command('unblock <ref>')
    .description('Unblock a task')
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        if (foundTask.status !== 'blocked') {
          warn('Task is not blocked');
          return;
        }

        const updatedTask: Task = {
          ...foundTask,
          status: 'pending',
          blocked_by: [],
        };

        await saveTask(ctx, updatedTask);
        success(`Unblocked task: ${index.shortUlid(updatedTask._ulid)}`, { task: updatedTask });
      } catch (err) {
        error('Failed to unblock task', err);
        process.exit(1);
      }
    });

  // kspec task cancel <ref>
  task
    .command('cancel <ref>')
    .description('Cancel a task')
    .option('--reason <reason>', 'Cancellation reason')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        if (foundTask.status === 'completed' || foundTask.status === 'cancelled') {
          warn(`Task is already ${foundTask.status}`);
          return;
        }

        const updatedTask: Task = {
          ...foundTask,
          status: 'cancelled',
          closed_reason: options.reason || null,
        };

        await saveTask(ctx, updatedTask);
        success(`Cancelled task: ${index.shortUlid(updatedTask._ulid)}`, { task: updatedTask });
      } catch (err) {
        error('Failed to cancel task', err);
        process.exit(1);
      }
    });

  // kspec task note <ref> <message>
  task
    .command('note <ref> <message>')
    .description('Add a note to a task')
    .option('--author <author>', 'Note author')
    .option('--supersedes <ulid>', 'ULID of note this supersedes')
    .action(async (ref: string, message: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        const note = createNote(message, options.author, options.supersedes);

        const updatedTask: Task = {
          ...foundTask,
          notes: [...foundTask.notes, note],
        };

        await saveTask(ctx, updatedTask);
        success(`Added note to task: ${index.shortUlid(updatedTask._ulid)}`, { note });
      } catch (err) {
        error('Failed to add note', err);
        process.exit(1);
      }
    });

  // kspec task notes <ref>
  task
    .command('notes <ref>')
    .description('Show notes for a task')
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        output(foundTask.notes, () => {
          if (foundTask.notes.length === 0) {
            console.log('No notes');
          } else {
            for (const note of foundTask.notes) {
              const author = note.author || 'unknown';
              console.log(`[${note.created_at}] ${author}:`);
              console.log(note.content);
              console.log('');
            }
          }
        });
      } catch (err) {
        error('Failed to get notes', err);
        process.exit(1);
      }
    });
}
