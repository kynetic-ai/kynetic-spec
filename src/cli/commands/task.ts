import { Command } from 'commander';
import { ulid } from 'ulid';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  saveTask,
  createTask,
  createNote,
  createTodo,
  syncSpecImplementationStatus,
  ReferenceIndex,
  checkSlugUniqueness,
  type LoadedTask,
} from '../../parser/index.js';
import { commitIfShadow } from '../../parser/shadow.js';
import {
  output,
  formatTaskDetails,
  success,
  error,
  warn,
  info,
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

        // Check slug uniqueness if provided
        if (options.slug) {
          const refIndex = new ReferenceIndex(tasks, items);
          const slugCheck = checkSlugUniqueness(refIndex, [options.slug]);
          if (!slugCheck.ok) {
            error(`Slug '${slugCheck.slug}' already exists (used by ${slugCheck.existingUlid})`);
            process.exit(1);
          }
        }

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
        await commitIfShadow(ctx.shadow, 'task-add', newTask.slugs[0] || newTask._ulid.slice(0, 8), newTask.title);

        // Build index including the new task for accurate short ULID
        const index = new ReferenceIndex([...tasks, newTask], items);
        success(`Created task: ${index.shortUlid(newTask._ulid)}`, { task: newTask });
      } catch (err) {
        error('Failed to create task', err);
        process.exit(1);
      }
    });

  // kspec task set <ref>
  task
    .command('set <ref>')
    .description('Update task fields')
    .option('--title <title>', 'Update task title')
    .option('--spec-ref <ref>', 'Link to spec item')
    .option('--priority <n>', 'Set priority (1-5)')
    .option('--slug <slug>', 'Add a slug alias')
    .option('--tag <tag...>', 'Add tags')
    .option('--depends-on <refs...>', 'Set dependencies (replaces existing)')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        // Check slug uniqueness if adding a new slug
        if (options.slug) {
          const slugCheck = checkSlugUniqueness(index, [options.slug], foundTask._ulid);
          if (!slugCheck.ok) {
            error(`Slug '${slugCheck.slug}' already exists (used by ${slugCheck.existingUlid})`);
            process.exit(1);
          }
        }

        // Build updated task with only provided options
        const updatedTask: Task = { ...foundTask };
        const changes: string[] = [];

        if (options.title) {
          updatedTask.title = options.title;
          changes.push('title');
        }

        if (options.specRef) {
          // Validate the spec ref exists and is a spec item
          const specResult = index.resolve(options.specRef);
          if (!specResult.ok) {
            error(`Spec reference not found: ${options.specRef}`);
            process.exit(3);
          }
          // Check it's not a task
          const isTask = tasks.some(t => t._ulid === specResult.ulid);
          if (isTask) {
            error(`Reference "${options.specRef}" is a task, not a spec item`);
            process.exit(3);
          }
          updatedTask.spec_ref = options.specRef;
          changes.push('spec_ref');
        }

        if (options.priority) {
          const priority = parseInt(options.priority, 10);
          if (isNaN(priority) || priority < 1 || priority > 5) {
            error('Priority must be between 1 and 5');
            process.exit(3);
          }
          updatedTask.priority = priority;
          changes.push('priority');
        }

        if (options.slug) {
          if (!updatedTask.slugs.includes(options.slug)) {
            updatedTask.slugs = [...updatedTask.slugs, options.slug];
            changes.push('slug');
          }
        }

        if (options.tag) {
          const newTags = options.tag.filter((t: string) => !updatedTask.tags.includes(t));
          if (newTags.length > 0) {
            updatedTask.tags = [...updatedTask.tags, ...newTags];
            changes.push('tags');
          }
        }

        if (options.dependsOn) {
          // Validate all dependency refs
          for (const depRef of options.dependsOn) {
            const depResult = index.resolve(depRef);
            if (!depResult.ok) {
              error(`Dependency reference not found: ${depRef}`);
              process.exit(3);
            }
          }
          updatedTask.depends_on = options.dependsOn;
          changes.push('depends_on');
        }

        if (changes.length === 0) {
          warn('No changes specified');
          return;
        }

        await saveTask(ctx, updatedTask);
        await commitIfShadow(ctx.shadow, 'task-set', foundTask.slugs[0] || index.shortUlid(foundTask._ulid), changes.join(', '));
        success(`Updated task: ${index.shortUlid(updatedTask._ulid)} (${changes.join(', ')})`, { task: updatedTask });
      } catch (err) {
        error('Failed to update task', err);
        process.exit(1);
      }
    });

  // kspec task start <ref>
  task
    .command('start <ref>')
    .description('Start working on a task (pending -> in_progress)')
    .option('--no-sync', 'Skip syncing spec implementation status')
    .action(async (ref: string, options) => {
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
        await commitIfShadow(ctx.shadow, 'task-start', foundTask.slugs[0] || index.shortUlid(foundTask._ulid));
        success(`Started task: ${index.shortUlid(updatedTask._ulid)}`, { task: updatedTask });

        // Sync spec implementation status (unless --no-sync)
        if (options.sync !== false && foundTask.spec_ref) {
          const updatedTasks = tasks.map(t =>
            t._ulid === updatedTask._ulid ? { ...t, ...updatedTask } : t
          );
          const syncResult = await syncSpecImplementationStatus(
            ctx,
            updatedTask as LoadedTask,
            updatedTasks as LoadedTask[],
            items,
            index
          );
          if (syncResult) {
            info(`Synced spec "${syncResult.specTitle}" implementation: ${syncResult.previousStatus} -> ${syncResult.newStatus}`);
          }
        }
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
    .option('--no-sync', 'Skip syncing spec implementation status')
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
        await commitIfShadow(ctx.shadow, 'task-complete', foundTask.slugs[0] || index.shortUlid(foundTask._ulid), options.reason);
        success(`Completed task: ${index.shortUlid(updatedTask._ulid)}`, { task: updatedTask });

        // Sync spec implementation status (unless --no-sync)
        if (options.sync !== false && foundTask.spec_ref) {
          // Update task list to reflect the change we just made
          const updatedTasks = tasks.map(t =>
            t._ulid === updatedTask._ulid ? { ...t, ...updatedTask } : t
          );
          const syncResult = await syncSpecImplementationStatus(
            ctx,
            updatedTask as LoadedTask,
            updatedTasks as LoadedTask[],
            items,
            index
          );
          if (syncResult) {
            info(`Synced spec "${syncResult.specTitle}" implementation: ${syncResult.previousStatus} -> ${syncResult.newStatus}`);
          }
        }
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
        await commitIfShadow(ctx.shadow, 'task-block', foundTask.slugs[0] || index.shortUlid(foundTask._ulid));
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
        await commitIfShadow(ctx.shadow, 'task-unblock', foundTask.slugs[0] || index.shortUlid(foundTask._ulid));
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
        await commitIfShadow(ctx.shadow, 'task-cancel', foundTask.slugs[0] || index.shortUlid(foundTask._ulid));
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
        await commitIfShadow(ctx.shadow, 'task-note', foundTask.slugs[0] || index.shortUlid(foundTask._ulid));
        success(`Added note to task: ${index.shortUlid(updatedTask._ulid)}`, { note });

        // Proactive alignment guidance for tasks with spec_ref
        if (foundTask.spec_ref) {
          console.log('');
          console.log('\x1b[33m--- Alignment Check ---\x1b[0m');
          console.log('Did your implementation add anything beyond the original spec?');
          console.log('If so, consider updating the spec:');
          console.log(`  kspec item set ${foundTask.spec_ref} --description "Updated description"`);
          console.log('Or add acceptance criteria for new features.');
        }
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

  // kspec task todos <ref>
  task
    .command('todos <ref>')
    .description('Show todos for a task')
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        output(foundTask.todos, () => {
          if (foundTask.todos.length === 0) {
            console.log('No todos');
          } else {
            for (const todo of foundTask.todos) {
              const status = todo.done ? '[x]' : '[ ]';
              const doneInfo = todo.done && todo.done_at ? ` (done ${todo.done_at})` : '';
              console.log(`${status} ${todo.id}. ${todo.text}${doneInfo}`);
            }
          }
        });
      } catch (err) {
        error('Failed to get todos', err);
        process.exit(1);
      }
    });

  // Create subcommand group for todo operations
  const todoCmd = task
    .command('todo')
    .description('Manage task todos');

  // kspec task todo add <ref> <text>
  todoCmd
    .command('add <ref> <text>')
    .description('Add a todo to a task')
    .option('--author <author>', 'Todo author')
    .action(async (ref: string, text: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        // Calculate next ID (max existing + 1, or 1 if none)
        const nextId = foundTask.todos.length > 0
          ? Math.max(...foundTask.todos.map(t => t.id)) + 1
          : 1;

        const todo = createTodo(nextId, text, options.author);

        const updatedTask: Task = {
          ...foundTask,
          todos: [...foundTask.todos, todo],
        };

        await saveTask(ctx, updatedTask);
        await commitIfShadow(ctx.shadow, 'task-note', foundTask.slugs[0] || index.shortUlid(foundTask._ulid));
        success(`Added todo #${todo.id} to task: ${index.shortUlid(updatedTask._ulid)}`, { todo });
      } catch (err) {
        error('Failed to add todo', err);
        process.exit(1);
      }
    });

  // kspec task todo done <ref> <id>
  todoCmd
    .command('done <ref> <id>')
    .description('Mark a todo as done')
    .action(async (ref: string, idStr: string) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        const id = parseInt(idStr, 10);
        if (isNaN(id)) {
          error(`Invalid todo ID: ${idStr}`);
          process.exit(3);
        }

        const todoIndex = foundTask.todos.findIndex(t => t.id === id);
        if (todoIndex === -1) {
          error(`Todo #${id} not found`);
          process.exit(3);
        }

        if (foundTask.todos[todoIndex].done) {
          warn(`Todo #${id} is already done`);
          return;
        }

        const updatedTodos = [...foundTask.todos];
        updatedTodos[todoIndex] = {
          ...updatedTodos[todoIndex],
          done: true,
          done_at: new Date().toISOString(),
        };

        const updatedTask: Task = {
          ...foundTask,
          todos: updatedTodos,
        };

        await saveTask(ctx, updatedTask);
        await commitIfShadow(ctx.shadow, 'task-note', foundTask.slugs[0] || index.shortUlid(foundTask._ulid));
        success(`Marked todo #${id} as done`, { todo: updatedTodos[todoIndex] });
      } catch (err) {
        error('Failed to mark todo as done', err);
        process.exit(1);
      }
    });

  // kspec task todo undone <ref> <id>
  todoCmd
    .command('undone <ref> <id>')
    .description('Mark a todo as not done')
    .action(async (ref: string, idStr: string) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        const id = parseInt(idStr, 10);
        if (isNaN(id)) {
          error(`Invalid todo ID: ${idStr}`);
          process.exit(3);
        }

        const todoIndex = foundTask.todos.findIndex(t => t.id === id);
        if (todoIndex === -1) {
          error(`Todo #${id} not found`);
          process.exit(3);
        }

        if (!foundTask.todos[todoIndex].done) {
          warn(`Todo #${id} is not done`);
          return;
        }

        const updatedTodos = [...foundTask.todos];
        updatedTodos[todoIndex] = {
          ...updatedTodos[todoIndex],
          done: false,
          done_at: undefined,
        };

        const updatedTask: Task = {
          ...foundTask,
          todos: updatedTodos,
        };

        await saveTask(ctx, updatedTask);
        await commitIfShadow(ctx.shadow, 'task-note', foundTask.slugs[0] || index.shortUlid(foundTask._ulid));
        success(`Marked todo #${id} as not done`, { todo: updatedTodos[todoIndex] });
      } catch (err) {
        error('Failed to mark todo as not done', err);
        process.exit(1);
      }
    });
}
