import { Command } from 'commander';
import { ulid } from 'ulid';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  saveTask,
  deleteTask,
  createTask,
  createNote,
  createTodo,
  syncSpecImplementationStatus,
  ReferenceIndex,
  checkSlugUniqueness,
  type LoadedTask,
  type LoadedSpecItem,
} from '../../parser/index.js';
import { commitIfShadow } from '../../parser/shadow.js';
import {
  output,
  formatTaskDetails,
  success,
  error,
  warn,
  info,
  isJsonMode,
} from '../output.js';
import { formatCommitGuidance, printCommitGuidance } from '../../utils/commit.js';
import type { Task, TaskInput } from '../../schema/index.js';
import { alignmentCheck, errors } from '../../strings/index.js';

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
        error(errors.reference.taskNotFound(ref));
        break;
      case 'ambiguous':
        error(errors.reference.ambiguous(ref));
        for (const candidate of result.candidates) {
          const task = tasks.find(t => t._ulid === candidate);
          const slug = task?.slugs[0] || '';
          console.error(`  - ${index.shortUlid(candidate)} ${slug ? `(${slug})` : ''}`);
        }
        break;
      case 'duplicate_slug':
        error(errors.reference.slugMapsToMultiple(ref));
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
    error(errors.reference.notTask(ref));
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
        error(errors.failures.getTask, err);
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
    .option('--meta-ref <ref>', 'Reference to meta item (workflow, agent, or convention)')
    .option('--priority <n>', 'Priority (1-5)', '3')
    .option('--slug <slug>', 'Human-friendly slug')
    .option('--tag <tag...>', 'Tags')
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);

        // Load meta items for validation
        const { loadMetaContext } = await import('../../parser/meta.js');
        const metaContext = await loadMetaContext(ctx);
        const allMetaItems = [
          ...metaContext.agents,
          ...metaContext.workflows,
          ...metaContext.conventions,
          ...metaContext.observations,
        ];

        // Build index for reference validation
        const refIndex = new ReferenceIndex(tasks, items, allMetaItems);

        // Check slug uniqueness if provided
        if (options.slug) {
          const slugCheck = checkSlugUniqueness(refIndex, [options.slug]);
          if (!slugCheck.ok) {
            error(errors.slug.alreadyExists(slugCheck.slug, slugCheck.existingUlid));
            process.exit(1);
          }
        }

        // Validate meta_ref if provided (AC-meta-ref-3, AC-meta-ref-4)
        if (options.metaRef) {
          const metaRefResult = refIndex.resolve(options.metaRef);

          if (!metaRefResult.ok) {
            error(errors.reference.metaRefNotFound(options.metaRef));
            process.exit(3);
          }

          // Check if the resolved item is a meta item (not a spec item or task)
          const isTask = tasks.some(t => t._ulid === metaRefResult.ulid);
          const isSpecItem = items.some(i => i._ulid === metaRefResult.ulid);

          if (isTask || isSpecItem) {
            error(errors.reference.metaRefPointsToSpec(options.metaRef));
            process.exit(3);
          }
        }

        const input: TaskInput = {
          title: options.title,
          type: options.type,
          spec_ref: options.specRef || null,
          meta_ref: options.metaRef || null,
          priority: parseInt(options.priority, 10),
          slugs: options.slug ? [options.slug] : [],
          tags: options.tag || [],
        };

        const newTask = createTask(input);
        await saveTask(ctx, newTask);
        await commitIfShadow(ctx.shadow, 'task-add', newTask.slugs[0] || newTask._ulid.slice(0, 8), newTask.title);

        // Build index including the new task for accurate short ULID
        const index = new ReferenceIndex([...tasks, newTask], items, allMetaItems);
        success(`Created task: ${index.shortUlid(newTask._ulid)}`, { task: newTask });
      } catch (err) {
        error(errors.failures.createTask, err);
        process.exit(1);
      }
    });

  // kspec task set <ref>
  task
    .command('set <ref>')
    .description('Update task fields')
    .option('--title <title>', 'Update task title')
    .option('--spec-ref <ref>', 'Link to spec item')
    .option('--meta-ref <ref>', 'Link to meta item (workflow, agent, or convention)')
    .option('--priority <n>', 'Set priority (1-5)')
    .option('--slug <slug>', 'Add a slug alias')
    .option('--tag <tag...>', 'Add tags')
    .option('--depends-on <refs...>', 'Set dependencies (replaces existing)')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);

        // Load meta items for validation
        const { loadMetaContext } = await import('../../parser/meta.js');
        const metaContext = await loadMetaContext(ctx);
        const allMetaItems = [
          ...metaContext.agents,
          ...metaContext.workflows,
          ...metaContext.conventions,
          ...metaContext.observations,
        ];

        const index = new ReferenceIndex(tasks, items, allMetaItems);
        const foundTask = resolveTaskRef(ref, tasks, index);

        // Check slug uniqueness if adding a new slug
        if (options.slug) {
          const slugCheck = checkSlugUniqueness(index, [options.slug], foundTask._ulid);
          if (!slugCheck.ok) {
            error(errors.slug.alreadyExists(slugCheck.slug, slugCheck.existingUlid));
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
            error(errors.reference.specRefNotFound(options.specRef));
            process.exit(3);
          }
          // Check it's not a task
          const isTask = tasks.some(t => t._ulid === specResult.ulid);
          if (isTask) {
            error(errors.reference.specRefIsTask(options.specRef));
            process.exit(3);
          }
          updatedTask.spec_ref = options.specRef;
          changes.push('spec_ref');
        }

        if (options.metaRef) {
          // Validate the meta ref exists and is a meta item
          const metaRefResult = index.resolve(options.metaRef);
          if (!metaRefResult.ok) {
            error(errors.reference.metaRefNotFound(options.metaRef));
            process.exit(3);
          }

          // Check if the resolved item is a meta item (not a spec item or task)
          const isTask = tasks.some(t => t._ulid === metaRefResult.ulid);
          const isSpecItem = items.some(i => i._ulid === metaRefResult.ulid);

          if (isTask || isSpecItem) {
            error(errors.reference.metaRefPointsToSpec(options.metaRef));
            process.exit(3);
          }

          updatedTask.meta_ref = options.metaRef;
          changes.push('meta_ref');
        }

        if (options.priority) {
          const priority = parseInt(options.priority, 10);
          if (isNaN(priority) || priority < 1 || priority > 5) {
            error(errors.validation.priorityOutOfRange);
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
              error(errors.reference.depNotFound(depRef));
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
        error(errors.failures.updateTask, err);
        process.exit(1);
      }
    });

  // kspec task patch <ref>
  task
    .command('patch <ref>')
    .description('Update task with JSON data')
    .option('--data <json>', 'JSON object with fields to update')
    .option('--dry-run', 'Show what would change without writing')
    .option('--allow-unknown', 'Allow unknown fields (for extending format)')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);

        // Load meta items for validation
        const { loadMetaContext } = await import('../../parser/meta.js');
        const metaContext = await loadMetaContext(ctx);
        const allMetaItems = [
          ...metaContext.agents,
          ...metaContext.workflows,
          ...metaContext.conventions,
          ...metaContext.observations,
        ];

        const index = new ReferenceIndex(tasks, items, allMetaItems);
        const foundTask = resolveTaskRef(ref, tasks, index);

        // Get JSON data from --data flag or stdin
        let jsonData: string;
        if (options.data) {
          jsonData = options.data;
        } else {
          // Read from stdin
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk);
          }
          jsonData = Buffer.concat(chunks).toString('utf-8');
        }

        // Parse JSON
        let patchData: Record<string, unknown>;
        try {
          patchData = JSON.parse(jsonData);
        } catch (parseErr) {
          error(errors.validation.invalidJson, parseErr);
          process.exit(1);
        }

        // Validate against TaskInputSchema (partial)
        const { TaskInputSchema } = await import('../../schema/index.js');

        // Create a partial schema for validation
        const partialSchema = options.allowUnknown
          ? TaskInputSchema.partial().passthrough()
          : TaskInputSchema.partial().strict();

        let validatedPatch: Partial<TaskInput>;
        try {
          validatedPatch = partialSchema.parse(patchData);
        } catch (validationErr) {
          error(errors.validation.invalidPatchData(String(validationErr)), validationErr);
          process.exit(1);
        }

        // Check for unknown fields if strict mode
        if (!options.allowUnknown) {
          const knownFields = Object.keys(TaskInputSchema.shape);
          const providedFields = Object.keys(patchData);
          const unknownFields = providedFields.filter(f => !knownFields.includes(f));

          if (unknownFields.length > 0) {
            error(errors.validation.unknownFields(unknownFields));
            process.exit(1);
          }
        }

        // Build updated task
        const updatedTask: Task = { ...foundTask, ...validatedPatch };

        // Track changes for output
        const changes = Object.keys(validatedPatch);

        if (options.dryRun) {
          info('Dry run - no changes will be written');
          info(`Would update: ${changes.join(', ')}`);
          output({ changes, updated: updatedTask }, () => {
            console.log(`\nChanges: ${changes.join(', ')}\n`);
            return formatTaskDetails(updatedTask, index);
          });
          return;
        }

        await saveTask(ctx, updatedTask);
        await commitIfShadow(ctx.shadow, 'task-patch', foundTask.slugs[0] || index.shortUlid(foundTask._ulid), changes.join(', '));
        success(`Patched task: ${index.shortUlid(updatedTask._ulid)} (${changes.join(', ')})`, { task: updatedTask });
      } catch (err) {
        error(errors.failures.patchTask, err);
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
          error(errors.status.cannotStart(foundTask.status));
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
        error(errors.failures.startTask, err);
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
          error(errors.status.cannotComplete(foundTask.status));
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

        // Output commit guidance (suppressed in JSON mode)
        if (!isJsonMode()) {
          const guidance = formatCommitGuidance(updatedTask);
          printCommitGuidance(guidance);
        }

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

        // AC: @task-completion-guardrails ac-2
        // Show reminder about acceptance criteria if spec has them
        // AC: @task-completion-guardrails ac-3
        // Only show for tasks with spec_ref (skipped for non-spec tasks)
        if (foundTask.spec_ref && !isJsonMode()) {
          const specResult = index.resolve(foundTask.spec_ref);
          if (specResult.ok && specResult.item) {
            const specItem = items.find(i => i._ulid === specResult.ulid);
            if (specItem && specItem.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
              const count = specItem.acceptance_criteria.length;
              console.log(`\n⚠ Linked spec ${foundTask.spec_ref} has ${count} acceptance criteri${count === 1 ? 'on' : 'a'} - verify they are covered\n`);
            }
          }
        }
      } catch (err) {
        error(errors.failures.completeTask, err);
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
          error(errors.status.cannotBlock(foundTask.status));
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
        error(errors.failures.blockTask, err);
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
        error(errors.failures.unblockTask, err);
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
        error(errors.failures.cancelTask, err);
        process.exit(1);
      }
    });

  // kspec task delete <ref>
  task
    .command('delete <ref>')
    .description('Delete a task permanently')
    .option('--force', 'Skip confirmation')
    .option('--dry-run', 'Show what would be deleted without deleting')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        const taskDisplay = `${foundTask.title} (${index.shortUlid(foundTask._ulid)})`;

        if (options.dryRun) {
          info(`Would delete task: ${taskDisplay}`);
          console.log(`  Source file: ${foundTask._sourceFile}`);
          console.log(`  Status: ${foundTask.status}`);
          if (foundTask.notes.length > 0) {
            console.log(`  Notes: ${foundTask.notes.length}`);
          }
          return;
        }

        // Confirm unless --force
        if (!options.force) {
          const readline = await import('readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await new Promise<string>((resolve) => {
            rl.question(`Delete task "${taskDisplay}"? [y/N] `, resolve);
          });
          rl.close();

          if (answer.toLowerCase() !== 'y') {
            info('Deletion cancelled');
            return;
          }
        }

        await deleteTask(ctx, foundTask);
        await commitIfShadow(ctx.shadow, 'task-delete', foundTask.slugs[0] || index.shortUlid(foundTask._ulid), foundTask.title);
        success(`Deleted task: ${taskDisplay}`);
      } catch (err) {
        error(errors.failures.deleteTask, err);
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
          console.log(alignmentCheck.header);
          console.log(alignmentCheck.beyondSpec);
          console.log(alignmentCheck.updateSpec(foundTask.spec_ref));
          console.log(alignmentCheck.addAC);

          // Check if linked spec has acceptance criteria and remind about test coverage
          const specResult = index.resolve(foundTask.spec_ref);
          if (specResult.ok && specResult.item) {
            const specItem = specResult.item as { acceptance_criteria?: unknown[] };
            if (specItem.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
              console.log('');
              console.log(alignmentCheck.testCoverage(specItem.acceptance_criteria.length));
            }
          }
        }
      } catch (err) {
        error(errors.failures.addNote, err);
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
        error(errors.failures.getNotes, err);
        process.exit(1);
      }
    });

  // kspec task review <ref>
  task
    .command('review <ref>')
    .description('Get task context for review (task details, spec, ACs, git diff)')
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);
        const foundTask = resolveTaskRef(ref, tasks, index);

        // Import getDiffSince from utils
        const { getDiffSince } = await import('../../utils/index.js');

        // Gather review context
        const reviewContext: {
          task: typeof foundTask;
          spec: LoadedSpecItem | null;
          diff: string | null;
          started_at: string | null;
        } = {
          task: foundTask,
          spec: null,
          diff: null,
          started_at: foundTask.started_at || null,
        };

        // Get spec item if task has spec_ref
        if (foundTask.spec_ref) {
          const specResult = index.resolve(foundTask.spec_ref);
          if (specResult.ok) {
            const specItem = items.find(i => i._ulid === specResult.ulid);
            reviewContext.spec = specItem || null;
          }
        }

        // Get git diff since task started
        if (foundTask.started_at) {
          const startedDate = new Date(foundTask.started_at);
          reviewContext.diff = getDiffSince(startedDate, ctx.rootDir);
        }

        output(reviewContext, () => {
          console.log('='.repeat(60));
          console.log('Task Review Context');
          console.log('='.repeat(60));
          console.log();

          // Task details
          console.log('TASK DETAILS');
          console.log('-'.repeat(60));
          console.log(formatTaskDetails(foundTask, index));
          console.log();

          // Spec details
          if (reviewContext.spec) {
            console.log('LINKED SPEC');
            console.log('-'.repeat(60));
            console.log(`Title: ${reviewContext.spec.title}`);
            console.log(`Type: ${reviewContext.spec.type}`);
            if (reviewContext.spec.description) {
              console.log(`\nDescription:\n${reviewContext.spec.description}`);
            }
            if (reviewContext.spec.acceptance_criteria && reviewContext.spec.acceptance_criteria.length > 0) {
              console.log(`\nAcceptance Criteria (${reviewContext.spec.acceptance_criteria.length}):`);
              for (const ac of reviewContext.spec.acceptance_criteria) {
                console.log(`  [${ac.id}]`);
                console.log(`    Given: ${ac.given}`);
                console.log(`    When: ${ac.when}`);
                console.log(`    Then: ${ac.then}`);
              }
            }
            console.log();
          }

          // Git diff
          if (reviewContext.diff) {
            console.log('CHANGES SINCE TASK STARTED');
            console.log('-'.repeat(60));
            console.log(`Started at: ${foundTask.started_at}`);
            console.log();
            console.log(reviewContext.diff);
            console.log();
          } else if (foundTask.started_at) {
            console.log('CHANGES SINCE TASK STARTED');
            console.log('-'.repeat(60));
            console.log(`Started at: ${foundTask.started_at}`);
            console.log('No changes detected');
            console.log();
          }

          console.log('='.repeat(60));
          console.log('Review Checklist:');
          console.log('- Does the implementation match the task description?');
          if (reviewContext.spec) {
            console.log('- Are all acceptance criteria covered?');
            console.log('- Is test coverage adequate?');
          }
          console.log('- Are there any gaps or issues?');
          console.log('='.repeat(60));
        });
      } catch (err) {
        error('Failed to generate review context', err);
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
        error(errors.failures.getTodos, err);
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
        error(errors.failures.addTodo, err);
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
          error(errors.todo.invalidId(idStr));
          process.exit(3);
        }

        const todoIndex = foundTask.todos.findIndex(t => t.id === id);
        if (todoIndex === -1) {
          error(errors.todo.notFound(id));
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
        error(errors.failures.markTodoDone, err);
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
          error(errors.todo.invalidId(idStr));
          process.exit(3);
        }

        const todoIndex = foundTask.todos.findIndex(t => t.id === id);
        if (todoIndex === -1) {
          error(errors.todo.notFound(id));
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
        error(errors.failures.markTodoNotDone, err);
        process.exit(1);
      }
    });
}
