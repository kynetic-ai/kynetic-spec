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
  type KspecContext,
} from '../../parser/index.js';
import { commitIfShadow } from '../../parser/shadow.js';
import { output, success, error, warn, info, isJsonMode } from '../output.js';
import type { TaskInput } from '../../schema/index.js';
import { errors } from '../../strings/index.js';

/**
 * Fields that contain nested spec items (mirrors yaml.ts)
 */
const NESTED_ITEM_FIELDS = ['modules', 'features', 'requirements', 'constraints', 'decisions'];

/**
 * Get the parent path from a child's _path.
 * e.g., "features[0].requirements[1]" -> "features[0]"
 * Returns empty string for top-level items.
 */
function getParentPath(childPath: string | undefined): string {
  if (!childPath) return '';
  const lastDotIndex = childPath.lastIndexOf('.');
  if (lastDotIndex === -1) return '';
  return childPath.slice(0, lastDotIndex);
}

/**
 * Check if an item is a direct child of another item based on _path.
 * Direct children have a path that extends the parent's path by exactly one field[index].
 */
function isDirectChildOf(child: LoadedSpecItem, parent: LoadedSpecItem): boolean {
  const childPath = child._path || '';
  const parentPath = parent._path || '';

  // If paths are equal, not a child
  if (childPath === parentPath) return false;

  // Child path must start with parent path
  if (parentPath && !childPath.startsWith(parentPath + '.')) return false;

  // For root parent (empty path), child must be a top-level path like "features[0]"
  if (!parentPath) {
    // Direct child of root has no '.' in its path
    return !childPath.includes('.');
  }

  // Get the remaining path after parent
  const remaining = childPath.slice(parentPath.length + 1);

  // Direct child has no additional '.' (e.g., "requirements[0]" not "requirements[0].something")
  return !remaining.includes('.');
}

/**
 * Find the parent spec item of a given item.
 * Returns undefined for root-level items.
 */
function findParentItem(
  item: LoadedSpecItem,
  allItems: LoadedSpecItem[]
): LoadedSpecItem | undefined {
  const parentPath = getParentPath(item._path);

  // Root-level item or no path
  if (!parentPath && !item._path) return undefined;
  if (!parentPath) return undefined;

  // Find item with matching path in the same source file
  return allItems.find(
    i => i._path === parentPath && i._sourceFile === item._sourceFile
  );
}

/**
 * Get direct children of a spec item.
 * Only returns immediate children, not grandchildren.
 */
function getDirectChildren(
  parent: LoadedSpecItem,
  allItems: LoadedSpecItem[]
): LoadedSpecItem[] {
  return allItems.filter(
    item => item._sourceFile === parent._sourceFile && isDirectChildOf(item, parent)
  );
}

/**
 * Collect an item and all its descendants in topological order (parent first).
 * This ensures parent tasks are created before child tasks.
 */
function collectItemsRecursively(
  root: LoadedSpecItem,
  allItems: LoadedSpecItem[]
): LoadedSpecItem[] {
  const result: LoadedSpecItem[] = [root];
  const children = getDirectChildren(root, allItems);

  for (const child of children) {
    const descendants = collectItemsRecursively(child, allItems);
    result.push(...descendants);
  }

  return result;
}

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
        error(errors.reference.specNotFound(ref));
        break;
      case 'ambiguous':
        error(errors.reference.ambiguous(ref));
        for (const candidate of result.candidates) {
          const item = items.find(i => i._ulid === candidate);
          const slug = item?.slugs[0] || '';
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

  // Check if it's actually a spec item (not a task)
  const item = items.find(i => i._ulid === result.ulid);
  if (!item) {
    // Check if it's a task
    const task = tasks.find(t => t._ulid === result.ulid);
    if (task) {
      error(errors.reference.notSpecItem(ref));
    } else {
      error(errors.reference.specNotFound(ref));
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
  /** Task ref that was used for depends_on (if any) */
  dependsOn?: string[];
}

/**
 * Derive a task from a spec item.
 * Returns result describing what happened.
 *
 * @param dependsOn - Task references to add as dependencies (for hierarchy-based deps)
 * @param priority - Priority override (1-5), if not provided uses spec's priority
 */
async function deriveTaskFromSpec(
  ctx: KspecContext,
  specItem: LoadedSpecItem,
  existingTasks: LoadedTask[],
  items: LoadedSpecItem[],
  index: ReferenceIndex,
  alignmentIndex: AlignmentIndex,
  options: { force: boolean; dryRun: boolean; dependsOn?: string[]; priority?: number }
): Promise<DeriveResult> {
  // Check if a task already exists for this spec
  const linkedTasks = alignmentIndex.getTasksForSpec(specItem._ulid);

  if (linkedTasks.length > 0 && !options.force) {
    const taskRef = linkedTasks[0].slugs[0]
      ? `@${linkedTasks[0].slugs[0]}`
      : `@${index.shortUlid(linkedTasks[0]._ulid)}`;
    return {
      specItem,
      action: 'skipped',
      task: linkedTasks[0],
      reason: `task exists: ${taskRef}`,
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

  // Build task input with depends_on
  const taskInput: TaskInput = {
    title: `Implement: ${specItem.title}`,
    type: 'task',
    spec_ref: `@${specItem.slugs[0] || specItem._ulid}`,
    derivation: 'auto',
    priority: options.priority ?? normalizePriority(specItem.priority),
    slugs: [slug],
    tags: [...(specItem.tags || [])],
    depends_on: options.dependsOn || [],
  };

  // Dry run - don't actually create
  if (options.dryRun) {
    const previewTask = createTask(taskInput) as LoadedTask;
    return {
      specItem,
      action: 'would_create',
      task: previewTask,
      dependsOn: options.dependsOn,
    };
  }

  // Create and save the task
  const newTask = createTask(taskInput);
  await saveTask(ctx, newTask);
  const specSlug = specItem.slugs[0] || specItem._ulid.slice(0, 8);
  await commitIfShadow(ctx.shadow, 'derive', specSlug);

  // Add to existing tasks list for slug collision checks
  existingTasks.push(newTask as LoadedTask);

  return {
    specItem,
    action: 'created',
    task: newTask as LoadedTask,
    dependsOn: options.dependsOn,
  };
}

/**
 * Get a task reference string for use in depends_on.
 * Prefers slug over ULID for readability.
 */
function getTaskRef(task: LoadedTask, index: ReferenceIndex): string {
  return task.slugs[0] ? `@${task.slugs[0]}` : `@${index.shortUlid(task._ulid)}`;
}

/**
 * Find or get the task for a parent spec item.
 * Looks in:
 * 1. Tasks created in this derive session (specToTaskMap)
 * 2. Existing tasks linked to the parent spec (alignmentIndex)
 */
function getParentTaskRef(
  parentSpec: LoadedSpecItem,
  specToTaskMap: Map<string, LoadedTask>,
  alignmentIndex: AlignmentIndex,
  index: ReferenceIndex
): string | undefined {
  // Check if we created a task for this parent in this session
  const sessionTask = specToTaskMap.get(parentSpec._ulid);
  if (sessionTask) {
    return getTaskRef(sessionTask, index);
  }

  // Check if an existing task is linked to this parent spec
  const linkedTasks = alignmentIndex.getTasksForSpec(parentSpec._ulid);
  if (linkedTasks.length > 0) {
    return getTaskRef(linkedTasks[0], index);
  }

  return undefined;
}

/**
 * Register the 'derive' command
 */
export function registerDeriveCommand(program: Command): void {
  program
    .command('derive [ref]')
    .description('Create task(s) from spec item(s)')
    .option('--all', 'Derive tasks for all spec items without linked tasks')
    .option('--flat', 'Only derive for the specified item, not children (default: recursive)')
    .option('--force', 'Create task even if one already exists for the spec')
    .option('--dry-run', 'Show what would be created without making changes')
    .option('--priority <n>', 'Set priority for created task(s) (1-5)', parseInt)
    .action(async (ref: string | undefined, options) => {
      try {
        // Validate arguments
        if (!ref && !options.all) {
          error(errors.usage.deriveNoRef);
          console.error('Usage:');
          console.error('  kspec derive @spec-ref');
          console.error('  kspec derive @spec-ref --flat');
          console.error('  kspec derive --all');
          process.exit(2);
        }

        if (ref && options.all) {
          error(errors.usage.deriveRefAndAll);
          process.exit(2);
        }

        // Validate priority if provided
        if (options.priority !== undefined) {
          if (isNaN(options.priority) || options.priority < 1 || options.priority > 5) {
            error('Priority must be a number between 1 and 5');
            process.exit(2);
          }
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
            if (isJsonMode()) {
              console.log(JSON.stringify([]));
            } else {
              info('Nothing to derive (all items have tasks)');
            }
            return;
          }
        } else {
          // Single spec item - recursive by default, flat if --flat
          const specItem = resolveSpecRef(ref!, items, tasks, index);

          if (options.flat) {
            specsToDerive = [specItem];
          } else {
            // Recursive: collect item and all descendants
            specsToDerive = collectItemsRecursively(specItem, items);
          }
        }

        // Track spec ULID -> created task for dependency resolution
        const specToTaskMap = new Map<string, LoadedTask>();

        // Process each spec item in order (parents before children due to topological sort)
        const results: DeriveResult[] = [];

        for (const specItem of specsToDerive) {
          // Determine depends_on based on parent spec's task
          let dependsOn: string[] | undefined;

          if (!options.flat && !options.all) {
            // Find the parent spec item
            const parentSpec = findParentItem(specItem, items);

            if (parentSpec) {
              const parentTaskRef = getParentTaskRef(
                parentSpec,
                specToTaskMap,
                alignmentIndex,
                index
              );
              if (parentTaskRef) {
                dependsOn = [parentTaskRef];
              }
            }
          }

          const result = await deriveTaskFromSpec(
            ctx,
            specItem,
            tasks,
            items,
            index,
            alignmentIndex,
            {
              force: options.force || false,
              dryRun: options.dryRun || false,
              dependsOn,
              priority: options.priority,
            }
          );

          // Track created/would_create tasks for dependency resolution
          if (result.task && (result.action === 'created' || result.action === 'would_create')) {
            specToTaskMap.set(specItem._ulid, result.task);
          }
          // Also track skipped tasks (existing) for dependency resolution
          if (result.action === 'skipped' && result.task) {
            specToTaskMap.set(specItem._ulid, result.task);
          }

          results.push(result);
        }

        // Output results
        if (isJsonMode()) {
          // JSON output format - simplified per AC
          const jsonOutput = results.map(r => ({
            ulid: r.task?._ulid || null,
            slug: r.task?.slugs[0] || null,
            spec_ref: `@${r.specItem.slugs[0] || r.specItem._ulid}`,
            depends_on: r.task?.depends_on || [],
            action: r.action,
          }));
          console.log(JSON.stringify(jsonOutput, null, 2));
          return; // Don't call output() which would output full results in global JSON mode
        } else {
          // Human-readable output
          output(results, () => {
            const created = results.filter(r => r.action === 'created');
            const skipped = results.filter(r => r.action === 'skipped');
            const wouldCreate = results.filter(r => r.action === 'would_create');

            if (options.dryRun) {
              console.log('Would create:');
              for (const r of wouldCreate) {
                const taskSlug = r.task?.slugs[0] || '';
                const deps = r.dependsOn?.length ? ` (depends: ${r.dependsOn.join(', ')})` : '';
                console.log(`  + ${r.specItem.title}`);
                console.log(`    -> ${taskSlug}${deps}`);
              }
              if (skipped.length > 0) {
                console.log('\nSkipped:');
                for (const r of skipped) {
                  const specRef = r.specItem.slugs[0] ? `@${r.specItem.slugs[0]}` : `@${index.shortUlid(r.specItem._ulid)}`;
                  console.log(`  - ${specRef} (${r.reason})`);
                }
              }
              console.log(`\nWould create ${wouldCreate.length} task(s)`);
              if (skipped.length > 0) {
                console.log(`Skipped ${skipped.length} (already have tasks)`);
              }
              return;
            }

            if (created.length > 0) {
              for (const r of created) {
                const taskSlug = r.task?.slugs[0] || '';
                const deps = r.dependsOn?.length ? ` (depends: ${r.dependsOn.join(', ')})` : '';
                console.log(`OK Created task: ${taskSlug}${deps}`);
              }
            }

            if (skipped.length > 0 && !options.all) {
              // Show skipped for explicit derive (not --all)
              for (const r of skipped) {
                const specRef = r.specItem.slugs[0] ? `@${r.specItem.slugs[0]}` : `@${index.shortUlid(r.specItem._ulid)}`;
                console.log(`Skipped ${specRef} (${r.reason})`);
              }
            }

            // Summary
            if (created.length > 0 || skipped.length > 0) {
              console.log('');
              if (created.length > 0) {
                console.log(`Created ${created.length} task(s)`);
              }
              if (skipped.length > 0) {
                console.log(`Skipped ${skipped.length} (already have tasks)`);
              }
            }
          });
        }
      } catch (err) {
        error(errors.failures.deriveTasks, err);
        process.exit(1);
      }
    });
}
