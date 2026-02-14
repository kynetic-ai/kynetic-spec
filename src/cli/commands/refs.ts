/**
 * Unified cross-reference lookup command.
 *
 * Shows all inbound references to a given entity across all entity types.
 * AC: @unified-cross-reference-lookup
 */

import chalk from "chalk";
import type { Command } from "commander";
import {
  buildIndexes,
  initContext,
  loadMetaContext,
} from "../../parser/index.js";
import type {
  LoadedMetaItem,
  LoadedWorkflow,
} from "../../parser/meta.js";
import { ReferenceIndex } from "../../parser/refs.js";
import type {
  AnyLoadedItem,
  LoadedSpecItem,
  LoadedTask,
} from "../../parser/yaml.js";
import { errors } from "../../strings/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output } from "../output.js";

/**
 * Reference types we scan for
 */
const REFERENCE_FIELDS = {
  // Task reference fields
  task: ["spec_ref", "depends_on", "meta_ref", "plan_ref", "blocked_by"],
  // Spec item reference fields
  spec: [
    "depends_on",
    "implements",
    "relates_to",
    "supersedes",
    "traits",
    "tests",
  ],
} as const;

/**
 * A single reference found
 */
interface FoundReference {
  /** The ULID of the referencing entity */
  ulid: string;
  /** Slug or short ULID for display */
  ref: string;
  /** Title/name of the referencing entity */
  title: string;
  /** Entity type (task, feature, requirement, etc.) */
  type: string;
  /** The field that contains the reference */
  field: string;
}

/**
 * Grouped references by relationship type
 */
interface GroupedReferences {
  /** Tasks with spec_ref pointing to target */
  "tasks_spec_ref": FoundReference[];
  /** Tasks with depends_on including target */
  "tasks_depends_on": FoundReference[];
  /** Tasks with meta_ref pointing to target */
  "tasks_meta_ref": FoundReference[];
  /** Tasks with plan_ref pointing to target */
  "tasks_plan_ref": FoundReference[];
  /** Tasks with blocked_by including target */
  "tasks_blocked_by": FoundReference[];
  /** Specs with depends_on including target */
  "specs_depends_on": FoundReference[];
  /** Specs with implements including target */
  "specs_implements": FoundReference[];
  /** Specs with relates_to including target */
  "specs_relates_to": FoundReference[];
  /** Specs with supersedes including target */
  "specs_supersedes": FoundReference[];
  /** Specs with traits including target */
  "specs_traits": FoundReference[];
  /** Specs with tests including target */
  "specs_tests": FoundReference[];
}

/**
 * Check if a reference field value contains the target
 */
function containsRef(
  value: unknown,
  targetUlid: string,
  refIndex: ReferenceIndex,
): boolean {
  if (!value) return false;

  if (typeof value === "string") {
    // Resolve the reference and compare ULIDs
    const resolved = refIndex.resolve(value);
    return resolved.ok && resolved.ulid === targetUlid;
  }

  if (Array.isArray(value)) {
    return value.some((v) => containsRef(v, targetUlid, refIndex));
  }

  return false;
}

/**
 * Get display reference for an entity
 */
function getDisplayRef(
  entity: AnyLoadedItem | LoadedMetaItem,
  refIndex: ReferenceIndex,
): string {
  // Prefer slug
  if ("slugs" in entity && entity.slugs.length > 0) {
    return `@${entity.slugs[0]}`;
  }
  // For meta items, use id
  if ("id" in entity && entity.id) {
    return `@${entity.id}`;
  }
  // Fall back to short ULID
  return refIndex.shortUlid(entity._ulid);
}

/**
 * Get title/name from an entity
 */
function getTitle(entity: AnyLoadedItem | LoadedMetaItem): string {
  if ("title" in entity) return entity.title;
  if ("name" in entity) return entity.name;
  if ("id" in entity) return entity.id;
  return "(unknown)";
}

/**
 * Get entity type
 */
function getType(entity: AnyLoadedItem | LoadedMetaItem): string {
  if ("type" in entity && entity.type) return entity.type;
  return "unknown";
}

/**
 * Check if entity is a task (has string status)
 */
function isTask(entity: AnyLoadedItem): entity is LoadedTask {
  return "status" in entity && typeof entity.status === "string";
}

/**
 * Scan all entities for references to target
 * AC: @unified-cross-reference-lookup ac-task-spec-ref through ac-supersedes
 */
function findAllReferences(
  targetUlid: string,
  tasks: LoadedTask[],
  items: LoadedSpecItem[],
  workflows: LoadedWorkflow[],
  refIndex: ReferenceIndex,
): GroupedReferences {
  const groups: GroupedReferences = {
    tasks_spec_ref: [],
    tasks_depends_on: [],
    tasks_meta_ref: [],
    tasks_plan_ref: [],
    tasks_blocked_by: [],
    specs_depends_on: [],
    specs_implements: [],
    specs_relates_to: [],
    specs_supersedes: [],
    specs_traits: [],
    specs_tests: [],
  };

  // Scan tasks
  // AC: @unified-cross-reference-lookup ac-task-spec-ref, ac-task-depends-on, ac-meta-ref
  for (const task of tasks) {
    const taskObj = task as unknown as Record<string, unknown>;

    for (const field of REFERENCE_FIELDS.task) {
      if (containsRef(taskObj[field], targetUlid, refIndex)) {
        const ref: FoundReference = {
          ulid: task._ulid,
          ref: getDisplayRef(task, refIndex),
          title: task.title,
          type: "task",
          field,
        };

        const key = `tasks_${field}` as keyof GroupedReferences;
        if (key in groups) {
          groups[key].push(ref);
        }
      }
    }
  }

  // Scan spec items
  // AC: @unified-cross-reference-lookup ac-spec-depends-on through ac-trait-references
  for (const item of items) {
    const itemObj = item as unknown as Record<string, unknown>;

    for (const field of REFERENCE_FIELDS.spec) {
      if (containsRef(itemObj[field], targetUlid, refIndex)) {
        const ref: FoundReference = {
          ulid: item._ulid,
          ref: getDisplayRef(item, refIndex),
          title: item.title,
          type: item.type || "spec",
          field,
        };

        const key = `specs_${field}` as keyof GroupedReferences;
        if (key in groups) {
          groups[key].push(ref);
        }
      }
    }
  }

  return groups;
}

/**
 * Format section header for human output
 * AC: @unified-cross-reference-lookup ac-grouped-output
 */
function formatSectionHeader(
  entityType: string,
  field: string,
): string {
  const fieldLabel = field.replace(/_/g, " ");
  return `${entityType} (${fieldLabel})`;
}

/**
 * Count total references across all groups
 */
function countTotalReferences(groups: GroupedReferences): number {
  return Object.values(groups).reduce((sum, arr) => sum + arr.length, 0);
}

/**
 * Format human-readable output
 * AC: @unified-cross-reference-lookup ac-grouped-output, ac-no-refs
 */
function formatHumanOutput(
  targetRef: string,
  groups: GroupedReferences,
): void {
  const total = countTotalReferences(groups);

  if (total === 0) {
    // AC: @unified-cross-reference-lookup ac-no-refs
    console.log(chalk.gray(`No references found for ${targetRef}`));
    return;
  }

  console.log(chalk.bold(`References to ${targetRef}`));
  console.log(chalk.gray("─".repeat(40)));

  // Define display order
  const sections: Array<{
    key: keyof GroupedReferences;
    entityType: string;
    field: string;
  }> = [
    { key: "tasks_spec_ref", entityType: "Tasks", field: "spec_ref" },
    { key: "tasks_depends_on", entityType: "Tasks", field: "depends_on" },
    { key: "tasks_meta_ref", entityType: "Tasks", field: "meta_ref" },
    { key: "tasks_plan_ref", entityType: "Tasks", field: "plan_ref" },
    { key: "tasks_blocked_by", entityType: "Tasks", field: "blocked_by" },
    { key: "specs_depends_on", entityType: "Specs", field: "depends_on" },
    { key: "specs_implements", entityType: "Specs", field: "implements" },
    { key: "specs_relates_to", entityType: "Specs", field: "relates_to" },
    { key: "specs_supersedes", entityType: "Specs", field: "supersedes" },
    { key: "specs_traits", entityType: "Specs", field: "traits" },
    { key: "specs_tests", entityType: "Specs", field: "tests" },
  ];

  for (const section of sections) {
    const refs = groups[section.key];
    if (refs.length === 0) continue;

    console.log(
      `\n${chalk.cyan(formatSectionHeader(section.entityType, section.field))}`,
    );

    for (const ref of refs) {
      const typeLabel = chalk.gray(`[${ref.type}]`);
      console.log(`  ${chalk.yellow(ref.ref)} ${typeLabel} ${ref.title}`);
    }
  }

  console.log(chalk.gray(`\n${total} reference(s) found`));
}

/**
 * Build JSON output structure
 * AC: @unified-cross-reference-lookup ac-json-structured
 */
function buildJsonOutput(
  targetRef: string,
  targetUlid: string,
  groups: GroupedReferences,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    target: targetRef,
    target_ulid: targetUlid,
  };

  // Add non-empty groups
  for (const [key, refs] of Object.entries(groups)) {
    if (refs.length > 0) {
      result[key] = (refs as FoundReference[]).map((r) => ({
        ref: r.ref,
        ulid: r.ulid,
        title: r.title,
        type: r.type,
      }));
    }
  }

  result.total = countTotalReferences(groups);

  return result;
}

/**
 * Register the refs command
 * AC: @unified-cross-reference-lookup
 */
export function registerRefsCommand(program: Command): void {
  program
    .command("refs <ref>")
    .description(
      "Show all inbound references to an entity (reverse lookup)",
    )
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const { tasks, items } = await buildIndexes(ctx);

        // Load meta context for workflows
        const metaCtx = await loadMetaContext(ctx);

        // Build reference index with meta items included
        // This allows resolving references to workflows, agents, etc.
        const allMetaItems: LoadedMetaItem[] = [
          ...metaCtx.agents,
          ...metaCtx.workflows,
          ...metaCtx.conventions,
          ...metaCtx.observations,
        ];
        const refIndex = new ReferenceIndex(tasks, items, allMetaItems);

        // AC: @unified-cross-reference-lookup ac-ref-resolution
        // Resolve target reference
        const resolved = refIndex.resolve(ref);
        if (!resolved.ok) {
          if (resolved.error === "not_found") {
            error(
              errors.reference.itemNotFound(ref),
              "Try: kspec search <pattern>",
            );
            process.exit(EXIT_CODES.NOT_FOUND);
          } else if (resolved.error === "ambiguous") {
            error(errors.reference.ambiguous(ref));
            for (const candidate of resolved.candidates) {
              console.error(`  ${candidate}`);
            }
            process.exit(EXIT_CODES.USAGE_ERROR);
          } else {
            error(errors.reference.slugMapsToMultiple(ref));
            for (const candidate of resolved.candidates) {
              console.error(`  ${candidate}`);
            }
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
        }

        const targetUlid = resolved.ulid;
        const targetRef = getDisplayRef(resolved.item, refIndex);

        // Find all references
        const groups = findAllReferences(
          targetUlid,
          tasks,
          items,
          metaCtx.workflows,
          refIndex,
        );

        // Output
        output(buildJsonOutput(targetRef, targetUlid, groups), () => {
          formatHumanOutput(targetRef, groups);
        });
      } catch (err) {
        error("Failed to find references", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
