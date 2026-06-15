import type { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  AlignmentIndex,
  createNote,
  createTask,
  initContext,
  type KspecContext,
  type LoadedSpecItem,
  type LoadedTask,
  loadAllItems,
  ReferenceIndex,
} from "../../parser/index.js";
import { resolveTaskDataManager } from "../../parser/task-data-manager.js";
import { normalizeRefInput } from "../../schema/index.js";
import type { TaskInput } from "../../schema/index.js";
import { errors } from "../../strings/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, isJsonMode, output, warn } from "../output.js";
import { resolveCliActor } from "../actor.js";
import { parseIntOption } from "../validators.js";

/**
 * Fields that contain nested spec items (mirrors yaml.ts)
 */
const _NESTED_ITEM_FIELDS = ["modules", "features", "requirements", "constraints", "decisions"];

/**
 * Get the parent path from a child's _path.
 * e.g., "features[0].requirements[1]" -> "features[0]"
 * Returns empty string for top-level items.
 */
function getParentPath(childPath: string | undefined): string {
  if (!childPath) return "";
  const lastDotIndex = childPath.lastIndexOf(".");
  if (lastDotIndex === -1) return "";
  return childPath.slice(0, lastDotIndex);
}

/**
 * Check if an item is a direct child of another item based on _path.
 * Direct children have a path that extends the parent's path by exactly one field[index].
 */
function isDirectChildOf(child: LoadedSpecItem, parent: LoadedSpecItem): boolean {
  const childPath = child._path || "";
  const parentPath = parent._path || "";

  // If paths are equal, not a child
  if (childPath === parentPath) return false;

  // Child path must start with parent path
  if (parentPath && !childPath.startsWith(`${parentPath}.`)) return false;

  // For root parent (empty path), child must be a top-level path like "features[0]"
  if (!parentPath) {
    // Direct child of root has no '.' in its path
    return !childPath.includes(".");
  }

  // Get the remaining path after parent
  const remaining = childPath.slice(parentPath.length + 1);

  // Direct child has no additional '.' (e.g., "requirements[0]" not "requirements[0].something")
  return !remaining.includes(".");
}

/**
 * Find the parent spec item of a given item.
 * Returns undefined for root-level items.
 */
function findParentItem(
  item: LoadedSpecItem,
  allItems: LoadedSpecItem[],
): LoadedSpecItem | undefined {
  const parentPath = getParentPath(item._path);

  // Root-level item or no path
  if (!parentPath && !item._path) return undefined;
  if (!parentPath) return undefined;

  // Find item with matching path in the same source file
  return allItems.find((i) => i._path === parentPath && i._sourceFile === item._sourceFile);
}

/**
 * Get direct children of a spec item.
 * Only returns immediate children, not grandchildren.
 */
function getDirectChildren(parent: LoadedSpecItem, allItems: LoadedSpecItem[]): LoadedSpecItem[] {
  return allItems.filter(
    (item) => item._sourceFile === parent._sourceFile && isDirectChildOf(item, parent),
  );
}

/**
 * Collect an item and all its descendants in topological order (parent first).
 * This ensures parent tasks are created before child tasks.
 */
function collectItemsRecursively(
  root: LoadedSpecItem,
  allItems: LoadedSpecItem[],
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
  index: ReferenceIndex,
): LoadedSpecItem {
  const result = index.resolve(ref);

  if (!result.ok) {
    switch (result.error) {
      case "not_found":
        error(errors.reference.specNotFound(ref));
        break;
      case "ambiguous":
        error(errors.reference.ambiguous(ref));
        for (const candidate of result.candidates) {
          const item = items.find((i) => i._ulid === candidate);
          const slug = item?.slugs[0] || "";
          console.error(`  - ${index.shortUlid(candidate)} ${slug ? `(${slug})` : ""}`);
        }
        break;
      case "duplicate_slug":
        error(errors.reference.slugMapsToMultiple(ref));
        for (const candidate of result.candidates) {
          console.error(`  - ${index.shortUlid(candidate)}`);
        }
        break;
    }
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  // Check if it's actually a spec item (not a task)
  const item = items.find((i) => i._ulid === result.ulid);
  if (!item) {
    // Check if it's a task
    const task = tasks.find((t) => t._ulid === result.ulid);
    if (task) {
      error(errors.reference.notSpecItem(ref));
    } else {
      error(errors.reference.specNotFound(ref));
    }
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  return item;
}

/**
 * Generate a slug from a spec item title.
 * Converts "My Feature Title" -> "task-my-feature-title"
 */
function generateSlugFromTitle(title: string): string {
  return (
    "task-" +
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50)
  );
}

/**
 * Convert spec priority to task priority (number).
 * Spec can use 'high', 'medium', 'low' or numeric 1-5.
 */
function normalizePriority(priority: string | number | undefined): number {
  if (priority === undefined) return 3;
  if (typeof priority === "number") return priority;
  switch (priority) {
    case "high":
      return 1;
    case "medium":
      return 3;
    case "low":
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
  action: "created" | "skipped" | "would_create";
  task?: LoadedTask;
  reason?: string;
  /** Task ref that was used for depends_on (if any) */
  dependsOn?: string[];
  /** Non-fatal warnings discovered while deriving this task */
  warnings?: string[];
  /** Number of acceptance criteria on the spec item */
  acCount: number;
}

/**
 * Generate implementation notes from spec item for newly derived task.
 * Includes description and acceptance criteria summary.
 */
function generateImplementationNotes(specItem: LoadedSpecItem): string | undefined {
  const parts: string[] = [];

  // Add description if present
  if (specItem.description) {
    parts.push(specItem.description.trim());
  }

  // Add acceptance criteria summary if present
  if (specItem.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
    const acSection = ["", "Acceptance Criteria:"];
    for (const ac of specItem.acceptance_criteria) {
      const summary = `${ac.given ? `Given ${ac.given}, ` : ""}when ${ac.when}, then ${ac.then}`;
      acSection.push(`- ${ac.id}: ${summary}`);
    }
    parts.push(acSection.join("\n"));
  }

  // Return combined content, or undefined if nothing to add
  return parts.length > 0 ? parts.join("\n\n") : undefined;
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
  _items: LoadedSpecItem[],
  index: ReferenceIndex,
  alignmentIndex: AlignmentIndex<LoadedTask>,
  options: {
    force: boolean;
    dryRun: boolean;
    dependsOn?: string[];
    priority?: number;
    title?: string;
  },
): Promise<DeriveResult> {
  // Count acceptance criteria for display
  const acCount = specItem.acceptance_criteria?.length ?? 0;

  // Check if a task already exists for this spec
  // AC: @cmd-derive ac-15 - skip cancelled tasks
  const linkedTasks = alignmentIndex.getTasksForSpec(specItem._ulid);
  const activeTasks = linkedTasks.filter((task) => task.status !== "cancelled");

  if (activeTasks.length > 0 && !options.force) {
    const taskRef = activeTasks[0].slugs[0]
      ? `@${activeTasks[0].slugs[0]}`
      : `@${index.shortUlid(activeTasks[0]._ulid)}`;
    return {
      specItem,
      action: "skipped",
      task: activeTasks[0],
      reason: `task exists: ${taskRef}`,
      acCount,
    };
  }

  // Check if slug would collide with existing task
  const baseSlug = generateSlugFromTitle(specItem.title);
  let slug = baseSlug;
  let slugSuffix = 1;

  // Find unique slug if needed
  while (existingTasks.some((t) => t.slugs.includes(slug))) {
    slug = `${baseSlug}-${slugSuffix}`;
    slugSuffix++;
  }

  // Generate implementation notes from spec
  // AC: @cmd-derive ac-author
  const noteContent = generateImplementationNotes(specItem);
  // AC: @actor-identity-resolution ac-7 ac-8 — canonical author or rejection.
  const initialNotes = noteContent
    ? [
        createNote(
          `Implementation notes (auto-generated from spec):\n\n${noteContent}`,
          await resolveCliActor(ctx, undefined, "author"),
        ),
      ]
    : [];

  // Build task input with depends_on and initial notes
  // AC: @derive-title-override ac-1 - use provided title if specified
  const taskInput: TaskInput = {
    title: options.title ?? `Implement: ${specItem.title}`,
    type: "task",
    spec_ref: `@${specItem.slugs[0] || specItem._ulid}`,
    derivation: "auto",
    priority: options.priority ?? normalizePriority(specItem.priority),
    slugs: [slug],
    tags: [...(specItem.tags || [])],
    depends_on: (options.dependsOn || []).map(normalizeRefInput),
    notes: initialNotes,
  };

  // Dry run - don't actually create
  if (options.dryRun) {
    const previewTask = createTask(taskInput) as LoadedTask;
    return {
      specItem,
      action: "would_create",
      task: previewTask,
      dependsOn: options.dependsOn,
      acCount,
    };
  }

  // Create and save the task via task data manager
  const specSlug = specItem.slugs[0] || specItem._ulid.slice(0, 8);
  const newTask = await resolveTaskDataManager(ctx).createTask(ctx, taskInput, {
    operation: "derive",
    ref: specSlug,
  });

  // Add to existing tasks list for slug collision checks
  existingTasks.push(newTask);

  return {
    specItem,
    action: "created",
    task: newTask,
    dependsOn: options.dependsOn,
    acCount,
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
 *
 * Only returns tasks that are NOT in 'cancelled' state (AC-15).
 */
function getParentTaskRef(
  parentSpec: LoadedSpecItem,
  specToTaskMap: Map<string, LoadedTask>,
  alignmentIndex: AlignmentIndex<LoadedTask>,
  index: ReferenceIndex,
): string | undefined {
  // Check if we created a task for this parent in this session
  const sessionTask = specToTaskMap.get(parentSpec._ulid);
  if (sessionTask && sessionTask.status !== "cancelled") {
    return getTaskRef(sessionTask, index);
  }

  // Check if an existing task is linked to this parent spec
  // AC: @cmd-derive ac-15 - skip cancelled tasks
  const linkedTasks = alignmentIndex.getTasksForSpec(parentSpec._ulid);
  const activeTask = linkedTasks.find((task) => task.status !== "cancelled");
  if (activeTask) {
    return getTaskRef(activeTask, index);
  }

  return undefined;
}

function dedupeRefs(refs: string[] | undefined): string[] | undefined {
  if (!refs || refs.length === 0) return undefined;
  return Array.from(new Set(refs.map(normalizeRefInput)));
}

/**
 * Sort specs so same-run task dependency resolution is stable.
 * Orders specs by:
 * 1. Parent-before-child when both are being derived
 * 2. depended-on spec before consumer when both are being derived
 *
 * Falls back to original order for any cyclic/unresolvable subset.
 */
function sortSpecsForDerive(
  specs: LoadedSpecItem[],
  allItems: LoadedSpecItem[],
  index: ReferenceIndex,
): LoadedSpecItem[] {
  if (specs.length <= 1) return specs;

  const specMap = new Map(specs.map((spec) => [spec._ulid, spec]));
  const originalOrder = new Map(specs.map((spec, idx) => [spec._ulid, idx]));
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const spec of specs) {
    outgoing.set(spec._ulid, new Set());
    indegree.set(spec._ulid, 0);
  }

  const addEdge = (from: string, to: string): void => {
    if (from === to || !specMap.has(from) || !specMap.has(to)) return;
    const fromEdges = outgoing.get(from);
    if (!fromEdges || fromEdges.has(to)) return;
    fromEdges.add(to);
    indegree.set(to, (indegree.get(to) || 0) + 1);
  };

  for (const spec of specs) {
    const parentSpec = findParentItem(spec, allItems);
    if (parentSpec && specMap.has(parentSpec._ulid)) {
      addEdge(parentSpec._ulid, spec._ulid);
    }

    for (const depRef of spec.depends_on || []) {
      const resolved = index.resolve(depRef);
      if (resolved.ok && specMap.has(resolved.ulid)) {
        addEdge(resolved.ulid, spec._ulid);
      }
    }
  }

  const ready = specs
    .filter((spec) => indegree.get(spec._ulid) === 0)
    .toSorted((a, b) => (originalOrder.get(a._ulid) || 0) - (originalOrder.get(b._ulid) || 0));
  const sorted: LoadedSpecItem[] = [];

  while (ready.length > 0) {
    const current = ready.shift();
    if (!current) break;
    sorted.push(current);

    for (const target of outgoing.get(current._ulid) || []) {
      const nextIndegree = (indegree.get(target) || 0) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) {
        const nextSpec = specMap.get(target);
        if (!nextSpec) continue;
        ready.push(nextSpec);
        ready.sort((a, b) => (originalOrder.get(a._ulid) || 0) - (originalOrder.get(b._ulid) || 0));
      }
    }
  }

  if (sorted.length === specs.length) {
    return sorted;
  }

  const sortedIds = new Set(sorted.map((spec) => spec._ulid));
  const remaining = specs.filter((spec) => !sortedIds.has(spec._ulid));
  return [...sorted, ...remaining];
}

/**
 * Resolve spec-level depends_on references to active task refs.
 * Uses tasks created in the current derive session first, then falls back to
 * existing non-cancelled tasks linked to the depended-on spec.
 */
function resolveSpecDependencyTaskRefs(
  specItem: LoadedSpecItem,
  specToTaskMap: Map<string, LoadedTask>,
  alignmentIndex: AlignmentIndex<LoadedTask>,
  index: ReferenceIndex,
): { taskRefs: string[]; warnings: string[] } {
  const taskRefs: string[] = [];
  const warnings: string[] = [];

  for (const depRef of specItem.depends_on || []) {
    const resolved = index.resolve(depRef);
    if (!resolved.ok) {
      warnings.push(
        `Spec dependency ${depRef} for @${specItem.slugs[0] || specItem._ulid} could not be resolved; skipping task dependency link.`,
      );
      continue;
    }

    const dependencyTask =
      specToTaskMap.get(resolved.ulid) ||
      alignmentIndex.getTasksForSpec(resolved.ulid).find((task) => task.status !== "cancelled");

    if (dependencyTask) {
      taskRefs.push(getTaskRef(dependencyTask, index));
      continue;
    }

    warnings.push(
      `Spec dependency ${depRef} for @${specItem.slugs[0] || specItem._ulid} has no active derived task; created task without linking it.`,
    );
  }

  return {
    taskRefs: Array.from(new Set(taskRefs)),
    warnings,
  };
}

/**
 * Register the 'derive' command
 */
export function registerDeriveCommand(program: Command): void {
  markMutating(program.command("derive [ref]"))
    .description("Create task(s) from spec item(s)")
    .option("--all", "Derive tasks for all spec items without linked tasks")
    .option("--flat", "Only derive for the specified item, not children (default: recursive)")
    .option("--force", "Create task even if one already exists for the spec")
    .option("--dry-run", "Show what would be created without making changes")
    .option("--priority <n>", "Set priority for created task(s) (1-5)")
    .option("--title <title>", "Override task title (default: 'Implement: {spec title}')")
    .action(async (ref: string | undefined, options) => {
      try {
        // Validate arguments
        if (!ref && !options.all) {
          error(errors.usage.deriveNoRef);
          console.error("Usage:");
          console.error("  kspec derive @spec-ref");
          console.error("  kspec derive @spec-ref --flat");
          console.error("  kspec derive --all");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        if (ref && options.all) {
          error(errors.usage.deriveRefAndAll);
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // Validate priority if provided
        if (options.priority !== undefined) {
          const priorityResult = parseIntOption(options.priority, {
            min: 1,
            max: 5,
            name: "Priority",
          });
          if (!priorityResult.ok) {
            error(priorityResult.error);
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
          // Replace raw string with validated number for downstream use
          options.priority = priorityResult.value;
        }

        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);

        // Build alignment index
        const alignmentIndex = new AlignmentIndex(tasks, items);
        alignmentIndex.buildLinks(index);

        // Collect spec items to process
        let specsToDerive: LoadedSpecItem[];

        if (options.all) {
          // Get all spec items without linked tasks
          specsToDerive = items.filter((item) => {
            const linkedTasks = alignmentIndex.getTasksForSpec(item._ulid);
            return linkedTasks.length === 0 || options.force;
          });

          if (specsToDerive.length === 0) {
            if (isJsonMode()) {
              console.log(JSON.stringify([]));
            } else {
              info("Nothing to derive (all items have tasks)");
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

        specsToDerive = sortSpecsForDerive(specsToDerive, items, index);

        // Track spec ULID -> created task for dependency resolution
        const specToTaskMap = new Map<string, LoadedTask>();

        // Process each spec item in order (parents before children due to topological sort)
        const results: DeriveResult[] = [];

        for (const specItem of specsToDerive) {
          // Determine depends_on based on parent spec's task
          const dependsOn: string[] = [];
          const warnings: string[] = [];

          if (!options.flat && !options.all) {
            // Find the parent spec item
            const parentSpec = findParentItem(specItem, items);

            if (parentSpec) {
              const parentTaskRef = getParentTaskRef(
                parentSpec,
                specToTaskMap,
                alignmentIndex,
                index,
              );
              if (parentTaskRef) {
                dependsOn.push(parentTaskRef);
              }
            }
          }

          const specDependencyResolution = resolveSpecDependencyTaskRefs(
            specItem,
            specToTaskMap,
            alignmentIndex,
            index,
          );
          dependsOn.push(...specDependencyResolution.taskRefs);
          warnings.push(...specDependencyResolution.warnings);

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
              dependsOn: dedupeRefs(dependsOn),
              priority: options.priority,
              title: options.title,
            },
          );
          result.warnings = warnings;

          // Track created/would_create tasks for dependency resolution
          if (result.task && (result.action === "created" || result.action === "would_create")) {
            specToTaskMap.set(specItem._ulid, result.task);
          }
          // Also track skipped tasks (existing) for dependency resolution
          if (result.action === "skipped" && result.task) {
            specToTaskMap.set(specItem._ulid, result.task);
          }

          results.push(result);
        }

        // Output results
        if (isJsonMode()) {
          // JSON output format - simplified per AC
          const jsonOutput = results.map((r) => ({
            ulid: r.task?._ulid || null,
            slug: r.task?.slugs[0] || null,
            spec_ref: `@${r.specItem.slugs[0] || r.specItem._ulid}`,
            depends_on: r.task?.depends_on || [],
            action: r.action,
            ac_count: r.acCount,
          }));
          console.log(JSON.stringify(jsonOutput, null, 2));
          return; // Don't call output() which would output full results in global JSON mode
        } else {
          // Human-readable output
          output(results, () => {
            const created = results.filter((r) => r.action === "created");
            const skipped = results.filter((r) => r.action === "skipped");
            const wouldCreate = results.filter((r) => r.action === "would_create");

            if (options.dryRun) {
              console.log("Would create:");
              for (const r of wouldCreate) {
                const taskSlug = r.task?.slugs[0] || "";
                const deps = r.dependsOn?.length ? ` (depends: ${r.dependsOn.join(", ")})` : "";
                const acInfo = r.acCount > 0 ? ` (${r.acCount} ACs)` : "";
                console.log(`  + ${r.specItem.title}${acInfo}`);
                console.log(`    -> ${taskSlug}${deps}`);
                // Complexity warning for specs with many ACs
                if (r.acCount > 5) {
                  warn(`This spec has ${r.acCount} ACs — consider splitting before implementing.`);
                }
                for (const warningMessage of r.warnings || []) {
                  warn(warningMessage);
                }
              }
              if (skipped.length > 0) {
                console.log("\nSkipped:");
                for (const r of skipped) {
                  const specRef = r.specItem.slugs[0]
                    ? `@${r.specItem.slugs[0]}`
                    : `@${index.shortUlid(r.specItem._ulid)}`;
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
                const taskSlug = r.task?.slugs[0] || "";
                const deps = r.dependsOn?.length ? ` (depends: ${r.dependsOn.join(", ")})` : "";
                const acInfo = r.acCount > 0 ? ` (${r.acCount} ACs)` : "";
                console.log(`OK Created task: ${taskSlug}${acInfo}${deps}`);
                // Complexity warning for specs with many ACs
                if (r.acCount > 5) {
                  warn(`This spec has ${r.acCount} ACs — consider splitting before implementing.`);
                }
                for (const warningMessage of r.warnings || []) {
                  warn(warningMessage);
                }
              }
            }

            if (skipped.length > 0 && !options.all) {
              // Show skipped for explicit derive (not --all)
              for (const r of skipped) {
                const specRef = r.specItem.slugs[0]
                  ? `@${r.specItem.slugs[0]}`
                  : `@${index.shortUlid(r.specItem._ulid)}`;
                console.log(`Skipped ${specRef} (${r.reason})`);
              }
            }

            // Summary
            if (created.length > 0 || skipped.length > 0) {
              console.log("");
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
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
