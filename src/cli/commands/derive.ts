import { Command } from 'commander';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  saveTask,
  createTask,
  ReferenceIndex,
  AlignmentIndex,
  type LoadedTask,
  type LoadedSpecItem,
} from '../../parser/index.js';
import { output, success, error, warn, info } from '../output.js';
import type { TaskInput } from '../../schema/index.js';

/**
 * Resolve a spec item reference.
 * Returns the spec item or exits with error.
 */
function resolveSpecRef(
  ref: string,
  items: LoadedSpecItem[],
  tasks: LoadedTask[],
  index: ReferenceIndex
): LoadedSpecItem {
  const result = index.resolve(ref);

  if (!result.ok) {
    switch (result.error) {
      case 'not_found':
        error(`Spec item not found: ${ref}`);
        break;
      case 'ambiguous':
        error(`Reference "${ref}" is ambiguous. Matches:`);
        for (const candidate of result.candidates) {
          const item = items.find(i => i._ulid === candidate);
          const slug = item?.slugs[0] || '';
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

  // Check if it's actually a spec item (not a task)
  const item = items.find(i => i._ulid === result.ulid);
  if (!item) {
    // Check if it's a task
    const task = tasks.find(t => t._ulid === result.ulid);
    if (task) {
      error(`Reference "${ref}" is a task, not a spec item. Derive only works on spec items.`);
    } else {
      error(`Spec item not found: ${ref}`);
    }
    process.exit(3);
  }

  return item;
}

/**
 * Generate a slug from a spec item title.
 * Converts "My Feature Title" -> "task-my-feature-title"
 */
function generateSlugFromTitle(title: string): string {
  return (
    'task-' +
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50)
  );
}

/**
 * Convert spec priority to task priority (number).
 * Spec can use 'high', 'medium', 'low' or numeric 1-5.
 */
function normalizePriority(priority: string | number | undefined): number {
  if (priority === undefined) return 3;
  if (typeof priority === 'number') return priority;
  switch (priority) {
    case 'high':
      return 1;
    case 'medium':
      return 3;
    case 'low':
      return 5;
    default:
      return 3;
  }
}

/**
 * Result of deriving a task from a spec item
 */
interface DeriveResult {
  specItem: LoadedSpecItem;
  action: 'created' | 'skipped' | 'would_create';
  task?: LoadedTask;
  reason?: string;
}

/**
 * Derive a task from a spec item.
 * Returns result describing what happened.
 */
async function deriveTaskFromSpec(
  ctx: Awaited<ReturnType<typeof initContext>>,
  specItem: LoadedSpecItem,
  existingTasks: LoadedTask[],
  items: LoadedSpecItem[],
  index: ReferenceIndex,
  alignmentIndex: AlignmentIndex,
  options: { force: boolean; dryRun: boolean }
): Promise<DeriveResult> {
  // Check if a task already exists for this spec
  const linkedTasks = alignmentIndex.getTasksForSpec(specItem._ulid);

  if (linkedTasks.length > 0 && !options.force) {
    return {
      specItem,
      action: 'skipped',
      task: linkedTasks[0],
      reason: `Task already exists: ${index.shortUlid(linkedTasks[0]._ulid)}`,
    };
  }

  // Check if slug would collide with existing task
  const baseSlug = generateSlugFromTitle(specItem.title);
  let slug = baseSlug;
  let slugSuffix = 1;

  // Find unique slug if needed
  while (existingTasks.some(t => t.slugs.includes(slug))) {
    slug = `${baseSlug}-${slugSuffix}`;
    slugSuffix++;
  }

  // Build task input
  const taskInput: TaskInput = {
    title: `Implement: ${specItem.title}`,
    type: 'task',
    spec_ref: `@${specItem.slugs[0] || specItem._ulid}`,
    derivation: 'auto',
    priority: normalizePriority(specItem.priority),
    slugs: [slug],
    tags: [...(specItem.tags || [])],
  };

  // Dry run - don't actually create
  if (options.dryRun) {
    const previewTask = createTask(taskInput) as LoadedTask;
    return {
      specItem,
      action: 'would_create',
      task: previewTask,
    };
  }

  // Create and save the task
  const newTask = createTask(taskInput);
  await saveTask(ctx, newTask);

  // Add to existing tasks list for slug collision checks
  existingTasks.push(newTask as LoadedTask);

  return {
    specItem,
    action: 'created',
    task: newTask as LoadedTask,
  };
}

/**
 * Register the 'derive' command
 */
export function registerDeriveCommand(program: Command): void {
  program
    .command('derive [ref]')
    .description('Create task(s) from spec item(s)')
    .option('--all', 'Derive tasks for all spec items without linked tasks')
    .option('--force', 'Create task even if one already exists for the spec')
    .option('--dry-run', 'Show what would be created without making changes')
    .action(async (ref: string | undefined, options) => {
      try {
        // Validate arguments
        if (!ref && !options.all) {
          error('Either provide a spec reference or use --all');
          console.error('Usage:');
          console.error('  kspec derive @spec-ref');
          console.error('  kspec derive --all');
          process.exit(2);
        }

        if (ref && options.all) {
          error('Cannot use both a specific reference and --all');
          process.exit(2);
        }

        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);

        // Build alignment index
        const alignmentIndex = new AlignmentIndex(tasks, items);
        alignmentIndex.buildLinks(index);

        // Collect spec items to process
        let specsToDerive: LoadedSpecItem[];

        if (options.all) {
          // Get all spec items without linked tasks
          specsToDerive = items.filter(item => {
            const linkedTasks = alignmentIndex.getTasksForSpec(item._ulid);
            return linkedTasks.length === 0 || options.force;
          });

          if (specsToDerive.length === 0) {
            info('All spec items already have linked tasks');
            return;
          }
        } else {
          // Single spec item
          const specItem = resolveSpecRef(ref!, items, tasks, index);
          specsToDerive = [specItem];
        }

        // Process each spec item
        const results: DeriveResult[] = [];

        for (const specItem of specsToDerive) {
          const result = await deriveTaskFromSpec(
            ctx,
            specItem,
            tasks,
            items,
            index,
            alignmentIndex,
            { force: options.force || false, dryRun: options.dryRun || false }
          );
          results.push(result);
        }

        // Output results
        output(results, () => {
          const created = results.filter(r => r.action === 'created');
          const skipped = results.filter(r => r.action === 'skipped');
          const wouldCreate = results.filter(r => r.action === 'would_create');

          if (options.dryRun) {
            console.log('Dry run - no changes made\n');
          }

          if (wouldCreate.length > 0) {
            console.log('Would create:');
            for (const r of wouldCreate) {
              const taskSlug = r.task?.slugs[0] || '';
              console.log(`  + ${r.specItem.title}`);
              console.log(`    -> Task: ${r.task?.title} (${taskSlug})`);
            }
            console.log('');
          }

          if (created.length > 0) {
            console.log('Created:');
            for (const r of created) {
              const shortUlid = index.shortUlid(r.task!._ulid);
              const taskSlug = r.task?.slugs[0] || '';
              console.log(`  + ${shortUlid} ${r.task?.title}`);
              if (taskSlug) {
                console.log(`    slug: ${taskSlug}`);
              }
            }
            console.log('');
          }

          if (skipped.length > 0 && !options.all) {
            // Only show skipped for single derive (--all silently skips)
            console.log('Skipped:');
            for (const r of skipped) {
              console.log(`  - ${r.specItem.title}`);
              console.log(`    ${r.reason}`);
            }
            console.log('');
          }

          // Summary
          if (options.dryRun) {
            console.log(`Would create ${wouldCreate.length} task(s)`);
          } else {
            if (created.length > 0) {
              console.log(`Created ${created.length} task(s)`);
            }
            if (skipped.length > 0 && options.all) {
              console.log(`Skipped ${skipped.length} spec(s) (already have tasks)`);
            }
          }
        });
      } catch (err) {
        error('Failed to derive tasks', err);
        process.exit(1);
      }
    });
}
