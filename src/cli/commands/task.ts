import { Command } from 'commander';
import { ulid } from 'ulid';
import chalk from 'chalk';
import * as path from 'node:path';
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
import { executeBatchOperation, formatBatchOutput } from '../batch.js';
import { EXIT_CODES } from '../exit-codes.js';

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
    // AC: @cli-exit-codes consistent-usage - NOT_FOUND for missing resources
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  // Check if it's actually a task
  const task = tasks.find(t => t._ulid === result.ulid);
  if (!task) {
    error(errors.reference.notTask(ref));
    // AC: @cli-exit-codes consistent-usage - NOT_FOUND for missing resources
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  return task;
}

/**
 * Batch-compatible resolver that returns null instead of calling process.exit().
 * Used by executeBatchOperation to handle errors without terminating the process.
 * AC: @multi-ref-batch ac-4, ac-8 - Partial failure handling and ref resolution
 */
function resolveTaskRefForBatch(
  ref: string,
  tasks: LoadedTask[],
  index: ReferenceIndex
): { task: LoadedTask | null; error?: string } {
  const result = index.resolve(ref);

  if (!result.ok) {
    let errorMsg: string;
    switch (result.error) {
      case 'not_found':
        errorMsg = `Reference "${ref}" not found`;
        break;
      case 'ambiguous':
        errorMsg = `Reference "${ref}" is ambiguous (matches ${result.candidates.length} items)`;
        break;
      case 'duplicate_slug':
        errorMsg = `Slug "${ref}" maps to multiple items`;
        break;
    }
    return { task: null, error: errorMsg };
  }

  // Check if it's actually a task
  const task = tasks.find(t => t._ulid === result.ulid);
  if (!task) {
    return { task: null, error: `Reference "${ref}" is not a task` };
  }

  return { task };
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
        process.exit(EXIT_CODES.ERROR);
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
            process.exit(EXIT_CODES.ERROR);
          }
        }

        // Validate meta_ref if provided (AC-meta-ref-3, AC-meta-ref-4)
        if (options.metaRef) {
          const metaRefResult = refIndex.resolve(options.metaRef);

          if (!metaRefResult.ok) {
            error(errors.reference.metaRefNotFound(options.metaRef));
            process.exit(EXIT_CODES.NOT_FOUND);
          }

          // Check if the resolved item is a meta item (not a spec item or task)
          const isTask = tasks.some(t => t._ulid === metaRefResult.ulid);
          const isSpecItem = items.some(i => i._ulid === metaRefResult.ulid);

          if (isTask || isSpecItem) {
            error(errors.reference.metaRefPointsToSpec(options.metaRef));
            process.exit(EXIT_CODES.NOT_FOUND);
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
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task set <ref>
  // TODO: Add batch support with --refs flag (see @multi-ref-batch)
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
            process.exit(EXIT_CODES.ERROR);
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
            process.exit(EXIT_CODES.NOT_FOUND);
          }
          // Check it's not a task
          const isTask = tasks.some(t => t._ulid === specResult.ulid);
          if (isTask) {
            error(errors.reference.specRefIsTask(options.specRef));
            process.exit(EXIT_CODES.NOT_FOUND);
          }
          updatedTask.spec_ref = options.specRef;
          changes.push('spec_ref');
        }

        if (options.metaRef) {
          // Validate the meta ref exists and is a meta item
          const metaRefResult = index.resolve(options.metaRef);
          if (!metaRefResult.ok) {
            error(errors.reference.metaRefNotFound(options.metaRef));
            process.exit(EXIT_CODES.NOT_FOUND);
          }

          // Check if the resolved item is a meta item (not a spec item or task)
          const isTask = tasks.some(t => t._ulid === metaRefResult.ulid);
          const isSpecItem = items.some(i => i._ulid === metaRefResult.ulid);

          if (isTask || isSpecItem) {
            error(errors.reference.metaRefPointsToSpec(options.metaRef));
            process.exit(EXIT_CODES.NOT_FOUND);
          }

          updatedTask.meta_ref = options.metaRef;
          changes.push('meta_ref');
        }

        if (options.priority) {
          const priority = parseInt(options.priority, 10);
          if (isNaN(priority) || priority < 1 || priority > 5) {
            error(errors.validation.priorityOutOfRange);
            process.exit(EXIT_CODES.NOT_FOUND);
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
              process.exit(EXIT_CODES.NOT_FOUND);
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
        process.exit(EXIT_CODES.ERROR);
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
          process.exit(EXIT_CODES.ERROR);
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
          process.exit(EXIT_CODES.ERROR);
        }

        // Check for unknown fields if strict mode
        if (!options.allowUnknown) {
          const knownFields = Object.keys(TaskInputSchema.shape);
          const providedFields = Object.keys(patchData);
          const unknownFields = providedFields.filter(f => !knownFields.includes(f));

          if (unknownFields.length > 0) {
            error(errors.validation.unknownFields(unknownFields));
            process.exit(EXIT_CODES.ERROR);
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
        process.exit(EXIT_CODES.ERROR);
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
          process.exit(EXIT_CODES.VALIDATION_FAILED); // Exit code 4 = invalid state
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

        // Show spec context and AC guidance (suppressed in JSON mode)
        if (!isJsonMode() && foundTask.spec_ref) {
          const specResult = index.resolve(foundTask.spec_ref);
          if (specResult.ok) {
            const specItem = items.find(i => i._ulid === specResult.ulid);
            if (specItem) {
              console.log('');
              console.log('--- Spec Context ---');
              console.log(`Implementing: ${specItem.title}`);
              if (specItem.description) {
                console.log(`\n${specItem.description}`);
              }

              if (specItem.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
                console.log(`\nAcceptance Criteria (${specItem.acceptance_criteria.length}):`);
                for (const ac of specItem.acceptance_criteria) {
                  console.log(`  [${ac.id}]`);
                  console.log(`    Given: ${ac.given}`);
                  console.log(`    When: ${ac.when}`);
                  console.log(`    Then: ${ac.then}`);
                }
                console.log('');
                console.log('Remember: Add test coverage for each AC and mark tests with // AC: @spec-ref ac-N');
              }
              console.log('');
            }
          }
        }

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
            // Commit the spec status change
            await commitIfShadow(ctx.shadow, 'spec-sync', syncResult.specUlid.slice(0, 8), `${syncResult.previousStatus} -> ${syncResult.newStatus}`);
          }
        }
      } catch (err) {
        error(errors.failures.startTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task complete <ref> | --refs <refs...>
  // AC: @multi-ref-batch ac-1 - Basic multi-ref syntax
  // AC: @multi-ref-batch ac-2 - Backward compatibility
  task
    .command('complete [ref]')
    .description('Complete a task (in_progress -> completed)')
    .option('--refs <refs...>', 'Complete multiple tasks by ref')
    .option('--reason <reason>', 'Completion reason/notes')
    .option('--no-sync', 'Skip syncing spec implementation status')
    .action(async (ref: string | undefined, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);

        // AC: @multi-ref-batch ac-1, ac-2, ac-3, ac-4
        const result = await executeBatchOperation({
          positionalRef: ref,
          refsFlag: options.refs,
          context: { ctx, tasks, items, index, options },
          items: tasks,
          index,
          resolveRef: (refStr, taskList, idx) => {
            const resolved = resolveTaskRefForBatch(refStr, taskList, idx);
            return { item: resolved.task, error: resolved.error };
          },
          executeOperation: async (foundTask, { ctx, tasks, items, index, options }) => {
            try {
              if (foundTask.status === 'completed') {
                return {
                  success: false,
                  error: 'Task is already completed',
                };
              }

              if (foundTask.status !== 'in_progress' && foundTask.status !== 'pending') {
                return {
                  success: false,
                  error: errors.status.cannotComplete(foundTask.status),
                };
              }

              const now = new Date().toISOString();

              // Update status
              const updatedTask: Task = {
                ...foundTask,
                status: 'completed',
                completed_at: now,
                closed_reason: options.reason || null,
                started_at: foundTask.started_at || now,
              };

              await saveTask(ctx, updatedTask);
              await commitIfShadow(ctx.shadow, 'task-complete', foundTask.slugs[0] || index.shortUlid(foundTask._ulid), options.reason);

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
                if (syncResult && !isJsonMode()) {
                  info(`Synced spec "${syncResult.specTitle}" implementation: ${syncResult.previousStatus} -> ${syncResult.newStatus}`);
                  await commitIfShadow(ctx.shadow, 'spec-sync', syncResult.specUlid.slice(0, 8), `${syncResult.previousStatus} -> ${syncResult.newStatus}`);
                }
              }

              // Show AC reminder for single-ref mode only (not in batch)
              if (!options.refs && foundTask.spec_ref && !isJsonMode()) {
                const specResult = index.resolve(foundTask.spec_ref);
                if (specResult.ok && specResult.item) {
                  const specItem = items.find(i => i._ulid === specResult.ulid);
                  if (specItem && specItem.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
                    const count = specItem.acceptance_criteria.length;
                    console.log(`\n⚠ Linked spec ${foundTask.spec_ref} has ${count} acceptance criteri${count === 1 ? 'on' : 'a'} - verify they are covered\n`);
                  }
                }
              }

              return {
                success: true,
                message: `Completed task: ${index.shortUlid(updatedTask._ulid)}`,
                data: updatedTask,
              };
            } catch (err) {
              return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },
          getUlid: (task) => task._ulid,
        });

        // AC: @multi-ref-batch ac-5, ac-6
        formatBatchOutput(result, 'Complete');

        // Show commit guidance for single-ref mode only
        if (!options.refs && result.success && result.results.length === 1 && !isJsonMode()) {
          const taskData = result.results[0].data as Task | undefined;
          if (taskData) {
            const guidance = formatCommitGuidance(taskData);
            printCommitGuidance(guidance);
          }
        }
      } catch (err) {
        error(errors.failures.completeTask, err);
        process.exit(EXIT_CODES.ERROR);
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
          process.exit(EXIT_CODES.VALIDATION_FAILED);
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
        process.exit(EXIT_CODES.ERROR);
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
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task cancel <ref> | --refs <refs...>
  // AC: @multi-ref-batch ac-1, ac-2
  task
    .command('cancel [ref]')
    .description('Cancel a task')
    .option('--refs <refs...>', 'Cancel multiple tasks by ref')
    .option('--reason <reason>', 'Cancellation reason')
    .action(async (ref: string | undefined, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);

        const result = await executeBatchOperation({
          positionalRef: ref,
          refsFlag: options.refs,
          context: { ctx, tasks, items, index, options },
          items: tasks,
          index,
          resolveRef: (refStr, taskList, idx) => {
            const resolved = resolveTaskRefForBatch(refStr, taskList, idx);
            return { item: resolved.task, error: resolved.error };
          },
          executeOperation: async (foundTask, { ctx, index, options }) => {
            try {
              if (foundTask.status === 'completed' || foundTask.status === 'cancelled') {
                return {
                  success: false,
                  error: `Task is already ${foundTask.status}`,
                };
              }

              const updatedTask: Task = {
                ...foundTask,
                status: 'cancelled',
                closed_reason: options.reason || null,
              };

              await saveTask(ctx, updatedTask);
              await commitIfShadow(ctx.shadow, 'task-cancel', foundTask.slugs[0] || index.shortUlid(foundTask._ulid));

              return {
                success: true,
                message: `Cancelled task: ${index.shortUlid(updatedTask._ulid)}`,
                data: updatedTask,
              };
            } catch (err) {
              return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },
          getUlid: (task) => task._ulid,
        });

        formatBatchOutput(result, 'Cancel');
      } catch (err) {
        error(errors.failures.cancelTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task delete <ref> | --refs <refs...>
  // AC: @multi-ref-batch ac-1, ac-2
  task
    .command('delete [ref]')
    .description('Delete a task permanently')
    .option('--refs <refs...>', 'Delete multiple tasks by ref')
    .option('--force', 'Skip confirmation (required for --refs)')
    .option('--dry-run', 'Show what would be deleted without deleting')
    .action(async (ref: string | undefined, options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);

        // For batch mode (--refs), require --force
        if (options.refs && options.refs.length > 0 && !options.force && !options.dryRun) {
          error('Batch delete requires --force flag');
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        const result = await executeBatchOperation({
          positionalRef: ref,
          refsFlag: options.refs,
          context: { ctx, tasks, items, index, options },
          items: tasks,
          index,
          resolveRef: (refStr, taskList, idx) => {
            const resolved = resolveTaskRefForBatch(refStr, taskList, idx);
            return { item: resolved.task, error: resolved.error };
          },
          executeOperation: async (foundTask, { ctx, index, options }) => {
            try {
              const taskDisplay = `${foundTask.title} (${index.shortUlid(foundTask._ulid)})`;

              if (options.dryRun) {
                return {
                  success: true,
                  message: `Would delete: ${taskDisplay}`,
                };
              }

              // For single-ref mode (not --refs), prompt for confirmation unless --force
              if (!options.refs && !options.force) {
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
                  return {
                    success: false,
                    error: 'Deletion cancelled by user',
                  };
                }
              }

              await deleteTask(ctx, foundTask);
              await commitIfShadow(ctx.shadow, 'task-delete', foundTask.slugs[0] || index.shortUlid(foundTask._ulid), foundTask.title);

              return {
                success: true,
                message: `Deleted task: ${taskDisplay}`,
              };
            } catch (err) {
              return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },
          getUlid: (task) => task._ulid,
        });

        formatBatchOutput(result, 'Delete');
      } catch (err) {
        error(errors.failures.deleteTask, err);
        process.exit(EXIT_CODES.ERROR);
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
        process.exit(EXIT_CODES.ERROR);
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
        process.exit(EXIT_CODES.ERROR);
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

        // Import scanTestCoverage (we'll need to export it from validate.ts)
        // For now, duplicate the logic here
        const scanTestCoverage = async (rootDir: string): Promise<Set<string>> => {
          const coveredACs = new Set<string>();
          const testsDir = path.join(rootDir, 'tests');
          const fs = await import('node:fs/promises');

          try {
            await fs.access(testsDir);
            const files = await fs.readdir(testsDir);
            const testFiles = files.filter(f => f.endsWith('.test.ts') || f.endsWith('.test.js'));

            for (const file of testFiles) {
              const filePath = path.join(testsDir, file);
              const content = await fs.readFile(filePath, 'utf-8');
              const acPattern = /\/\/\s*AC:\s*(@[\w-]+)(?:\s+(ac-\d+(?:\s*,\s*ac-\d+)*))?/g;
              let match;

              while ((match = acPattern.exec(content)) !== null) {
                const specRef = match[1];
                const acList = match[2];

                if (acList) {
                  const acs = acList.split(',').map(ac => ac.trim());
                  for (const ac of acs) {
                    coveredACs.add(`${specRef} ${ac}`);
                  }
                } else {
                  coveredACs.add(specRef);
                }
              }
            }
          } catch (err) {
            // Tests directory doesn't exist or can't be read
          }

          return coveredACs;
        };

        // Gather review context
        const reviewContext: {
          task: typeof foundTask;
          spec: LoadedSpecItem | null;
          diff: string | null;
          started_at: string | null;
          testCoverage?: { covered: string[]; uncovered: string[] };
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

            // Check test coverage for ACs if spec has them
            if (specItem && specItem.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
              const coveredACs = await scanTestCoverage(ctx.rootDir);
              const covered: string[] = [];
              const uncovered: string[] = [];

              for (const ac of specItem.acceptance_criteria) {
                // Build possible references
                const possibleRefs: string[] = [];
                if (specItem.slugs && specItem.slugs.length > 0) {
                  possibleRefs.push(`@${specItem.slugs[0]} ${ac.id}`);
                  possibleRefs.push(`@${specItem.slugs[0]}`);
                }
                possibleRefs.push(`@${specItem._ulid.slice(0, 8)} ${ac.id}`);
                possibleRefs.push(`@${specItem._ulid.slice(0, 8)}`);

                const isCovered = possibleRefs.some(ref => coveredACs.has(ref));
                if (isCovered) {
                  covered.push(ac.id);
                } else {
                  uncovered.push(ac.id);
                }
              }

              reviewContext.testCoverage = { covered, uncovered };
            }
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
                const isCovered = reviewContext.testCoverage?.covered.includes(ac.id);
                const coverageMarker = isCovered ? chalk.green('✓') : chalk.yellow('○');
                console.log(`  ${coverageMarker} [${ac.id}]`);
                console.log(`    Given: ${ac.given}`);
                console.log(`    When: ${ac.when}`);
                console.log(`    Then: ${ac.then}`);
              }

              // Test coverage summary
              if (reviewContext.testCoverage) {
                const { covered, uncovered } = reviewContext.testCoverage;
                console.log();
                if (uncovered.length === 0) {
                  console.log(chalk.green(`  ✓ All ${covered.length} AC(s) have test coverage`));
                } else {
                  console.log(chalk.yellow(`  Test coverage: ${covered.length}/${covered.length + uncovered.length} ACs covered`));
                  console.log(chalk.yellow(`  Missing coverage for: ${uncovered.join(', ')}`));
                }
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
        process.exit(EXIT_CODES.ERROR);
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
        process.exit(EXIT_CODES.ERROR);
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
        process.exit(EXIT_CODES.ERROR);
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
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        const todoIndex = foundTask.todos.findIndex(t => t.id === id);
        if (todoIndex === -1) {
          error(errors.todo.notFound(id));
          process.exit(EXIT_CODES.NOT_FOUND);
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
        process.exit(EXIT_CODES.ERROR);
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
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        const todoIndex = foundTask.todos.findIndex(t => t.id === id);
        if (todoIndex === -1) {
          error(errors.todo.notFound(id));
          process.exit(EXIT_CODES.NOT_FOUND);
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
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
