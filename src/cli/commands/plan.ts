/**
 * Plan CLI commands
 * AC: @plan-crud ac-1, ac-2, ac-3, ac-4, ac-7, ac-8, ac-9, ac-30, ac-31
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Option, type Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  computePlanBranchName,
  findBranchOnRemote,
  gitCheckout,
  gitCheckoutNew,
  gitCreateBranchFrom,
  gitRefExists,
  reportBranchResult,
} from "../branch-helper.js";
import {
  addChildItem,
  addProjectLevelTraitItem,
  buildIndexes,
  createPlan,
  createSpecItem,
  deletePlan,
  findPlanByRef,
  filterPlansByStatus,
  getAuthor,
  initContext,
  type LoadedPlan,
  type LoadedSpecItem,
  type LoadedTask,
  loadPlans,
  mutatePlanAtomically,
  savePlan,
  shortestUniqueUlid,
} from "../../parser/index.js";
import { resolveTaskDataManager } from "../../parser/task-data-manager.js";
import { commitIfShadow } from "../../parser/shadow.js";
import {
  parsePlanDocument,
  topologicalSort,
  type PlanSpec,
  type PlanTask,
} from "../../parser/plan-document.js";
import type { Note, PlanInput, SpecItemInput, TaskInput } from "../../schema/index.js";
import { PlanStatusSchema } from "../../schema/index.js";
import { errors } from "../../strings/index.js";
import { fieldLabels } from "../../strings/labels.js";
import { getCurrentBranch, isGitRepo } from "../../utils/git.js";
import { formatRelativeTime as formatRelativeTimeUtil } from "../../utils/time.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, isJsonMode, output, success, warn } from "../output.js";
import { validateEnumOption } from "../validators.js";
import { ulid } from "ulid";
import { registerPlanImportCommand } from "./plan-import.js";
import { registerPlanResourceCommands } from "./plan-resource.js";
import { getLinkedPlanSummaryTasks, isCountedInPlanSummary } from "../../lib/plan-summary.js";
import { resolveDispatchWorkspaceConfig } from "../../agent-runtime/workspace.js";
import {
  assertSafeResourceMutationPath,
  computeResourceMetadata,
  getResourcesDir,
  loadResourceManifest,
  parseResourceReference,
  validateResourceId,
  writeResourceManifest,
} from "../../parser/entity-local-resources.js";
import { getPlanDir } from "../../parser/plan-storage-manager.js";
import { getTaskDir } from "../../parser/split-backend.js";
import type { ResourceMetadata, TaskResourceRef } from "../../schema/resources.js";

/**
 * Format relative time for display
 */
function formatRelativeTime(dateStr: string): string {
  return formatRelativeTimeUtil(new Date(dateStr));
}

/**
 * Resolve plan ref with error handling
 * AC: @plan-crud ac-8 - get plan by reference
 */
function resolvePlanRef(ref: string, plans: LoadedPlan[]): LoadedPlan {
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;
  const plan = plans.find(
    (p) =>
      p._ulid === cleanRef ||
      p._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
      p.slugs.includes(cleanRef),
  );

  if (!plan) {
    exitDeriveWithGuidance(
      errors.reference.planNotFound(ref),
      EXIT_CODES.NOT_FOUND,
      "Check available plans with: kspec plan list",
      {
        ref,
        entity: "plan",
      },
    );
  }

  return plan;
}

function shortPlanRef(plan: LoadedPlan, plans: LoadedPlan[]): string {
  return shortestUniqueUlid(
    plan._ulid,
    plans.map((candidate) => candidate._ulid),
  );
}

async function resolveDeriveModuleRef(
  ctx: Awaited<ReturnType<typeof initContext>>,
  plans: LoadedPlan[],
  foundPlan: LoadedPlan,
  moduleOption?: string,
): Promise<string | null> {
  const moduleRef = moduleOption ?? foundPlan.module_ref ?? null;
  if (!moduleRef) {
    return null;
  }

  const { refIndex } = await buildIndexes(ctx, plans);
  const moduleResult = refIndex.resolve(moduleRef);
  if (!moduleResult.ok) {
    exitDeriveWithGuidance(
      errors.reference.itemNotFound(moduleRef),
      EXIT_CODES.NOT_FOUND,
      "Check available modules with: kspec item list --type module",
      {
        ref: moduleRef,
        entity: "module",
      },
    );
  }

  const moduleItem = moduleResult.item as LoadedSpecItem;
  if (moduleItem.type !== "module") {
    exitDeriveWithGuidance(
      `${moduleRef} is not a module (type: ${moduleItem.type})`,
      EXIT_CODES.USAGE_ERROR,
      "Pass a module @ref from: kspec item list --type module",
      {
        field: "module",
        value: moduleItem.type,
      },
    );
  }

  return moduleRef.startsWith("@") ? moduleRef : `@${moduleRef}`;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function toRef(ref: string): string {
  return ref.startsWith("@") ? ref : `@${ref}`;
}

function canonicalRef(item: { _ulid: string; slugs: string[] }): string {
  return `@${item.slugs[0] || item._ulid}`;
}

function nextUniqueSlug(baseSlug: string, reservedSlugs: Set<string>): string {
  let slug = baseSlug;
  let counter = 1;
  while (reservedSlugs.has(slug)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  reservedSlugs.add(slug);
  return slug;
}

function createNote(content: string, author?: string): Note {
  return {
    _ulid: ulid(),
    created_at: new Date().toISOString(),
    author,
    content,
  };
}

interface DeriveOptions {
  module?: string;
  tasks?: boolean;
  dryRun?: boolean;
  /**
   * Copy plan-owned resources into each derived task's resources/ tree
   * instead of recording plan-owned references. See
   * @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource.
   */
  materializeResources?: boolean;
}

interface DeriveWarning {
  kind: "spec" | "task" | "plan";
  ref?: string;
  message: string;
}

interface DeriveSkipped {
  kind: "spec" | "task";
  ref: string;
  title: string;
  reason: string;
}

interface DeriveResult {
  dry_run: boolean;
  plan_ref: string;
  module_ref: string;
  plan_branch: string | null;
  tasks_included: boolean;
  created_specs: string[];
  created_tasks: string[];
  skipped: DeriveSkipped[];
  errors: Array<{ type: string; message: string }>;
}

interface MaterializedSpec {
  localSlug: string;
  ref: string;
  item: LoadedSpecItem;
  source: PlanSpec;
}

interface PendingTaskPlan {
  localKey: string;
  ref: string;
  input: TaskInput;
  /**
   * Plan-manifest entries the task references via its `resource_refs`. Kept
   * separate from `input.resource_refs` so the post-creation materialization
   * step can copy bytes from the plan directory into the new task directory
   * without re-resolving the references.
   *
   * AC: @plan-resource-derivation-semantics-1 ac-derived-task-keeps-plan-resource-reference
   * AC: @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource
   */
  planResources: ResourceMetadata[];
}

function exitDeriveWithGuidance(
  message: string,
  exitCode: number,
  suggestion?: string,
  details?: Record<string, unknown>,
): never {
  if (suggestion) {
    if (isJsonMode()) {
      error(message, {
        ...details,
        suggestion,
        guidance: suggestion,
      });
    } else {
      error(message);
      console.error(`Suggestion: ${suggestion}`);
    }
  } else {
    error(message, isJsonMode() ? details : undefined);
  }

  process.exit(exitCode);
}

function emitDeriveResult(result: DeriveResult, options?: { tasksIncluded?: boolean }): void {
  output(result, () => {
    if (result.dry_run) {
      console.log("Dry run - no changes made\n");
    }

    console.log(`Plan: ${result.plan_ref}`);
    console.log(`Module: ${result.module_ref}`);
    console.log(
      `Tasks: ${options?.tasksIncluded === false ? "skipped (--no-tasks)" : "included (default)"}`,
    );
    console.log(`Created specs: ${result.created_specs.length}`);
    for (const ref of result.created_specs) {
      console.log(`  - ${ref}`);
    }

    console.log(`Created tasks: ${result.created_tasks.length}`);
    for (const ref of result.created_tasks) {
      console.log(`  - ${ref}`);
    }

    if (result.plan_branch) {
      console.log(`Tasks will target plan branch: ${result.plan_branch}`);
    } else {
      console.log(
        `Tip: Run kspec plan branch ${result.plan_ref} to create a shared branch for task stacking. Without it, tasks target the default integration branch.`,
      );
    }

    if (result.skipped.length > 0) {
      console.log(`Skipped: ${result.skipped.length}`);
      for (const skipped of result.skipped) {
        console.log(`  - ${skipped.ref} (${skipped.title}): ${skipped.reason}`);
      }
    }

    if (result.errors.length > 0) {
      console.log(`Errors: ${result.errors.length}`);
      for (const err of result.errors) {
        console.log(`  - [${err.type}] ${err.message}`);
      }
    }
  });
}

function reportWarnings(warnings: DeriveWarning[]): void {
  for (const warning of warnings) {
    warn(warning.ref ? `${warning.ref}: ${warning.message}` : warning.message);
  }
}

function normalizeSpecTraits(
  spec: PlanSpec,
  refIndex: Awaited<ReturnType<typeof buildIndexes>>["refIndex"],
  createdSpecs: Map<string, MaterializedSpec>,
  warnings: DeriveWarning[],
): string[] {
  const normalized = new Set<string>();

  for (const rawTrait of spec.traits || []) {
    const traitRef = toRef(rawTrait);
    const localTrait = createdSpecs.get(traitRef.slice(1));
    if (localTrait?.item.type === "trait") {
      normalized.add(localTrait.ref);
      continue;
    }

    const resolved = refIndex.resolve(traitRef);
    if (resolved.ok) {
      const item = resolved.item as LoadedSpecItem;
      if (item.type !== "trait") {
        warnings.push({
          kind: "spec",
          ref: spec.slug ? `@${spec.slug}` : undefined,
          message: `${traitRef} resolved to ${item.type}, not a trait. Storing normalized reference for later review.`,
        });
        normalized.add(traitRef);
        continue;
      }

      normalized.add(canonicalRef(item));
      continue;
    }

    normalized.add(traitRef);
  }

  return [...normalized];
}

function normalizeSpecDependencies(
  spec: PlanSpec,
  refIndex: Awaited<ReturnType<typeof buildIndexes>>["refIndex"],
  createdSpecs: Map<string, MaterializedSpec>,
  warnings: DeriveWarning[],
): string[] {
  return (spec.depends_on || []).map((rawDependency) => {
    const dependencyRef = toRef(rawDependency);
    const localDependency = createdSpecs.get(dependencyRef.slice(1));
    if (localDependency) {
      return localDependency.ref;
    }

    const resolved = refIndex.resolve(dependencyRef);
    if (resolved.ok) {
      const item = resolved.item as LoadedSpecItem;
      return canonicalRef(item);
    }

    warnings.push({
      kind: "spec",
      ref: spec.slug ? `@${spec.slug}` : undefined,
      message: `Unresolved dependency ${dependencyRef}. Keeping the reference as-is for later resolution.`,
    });
    return dependencyRef;
  });
}

async function materializePlanSpecs(
  ctx: Awaited<ReturnType<typeof initContext>>,
  foundPlan: LoadedPlan,
  moduleRef: string,
  parsedPlan: ReturnType<typeof parsePlanDocument>,
  refIndex: Awaited<ReturnType<typeof buildIndexes>>["refIndex"],
  items: LoadedSpecItem[],
  reservedSlugs: Set<string>,
  dryRun: boolean,
  warnings: DeriveWarning[],
  skipped: DeriveSkipped[],
): Promise<MaterializedSpec[]> {
  const sortResult = topologicalSort(parsedPlan.specs);
  if (sortResult.error) {
    exitDeriveWithGuidance(
      sortResult.error.message,
      EXIT_CODES.USAGE_ERROR,
      "Fix the parent references in the plan content so they form an acyclic tree.",
      {
        type: sortResult.error.type,
      },
    );
  }

  const createdSpecs = new Map<string, MaterializedSpec>();
  const materialized: MaterializedSpec[] = [];

  const moduleResult = refIndex.resolve(moduleRef);
  if (!moduleResult.ok) {
    exitDeriveWithGuidance(
      errors.reference.itemNotFound(moduleRef),
      EXIT_CODES.NOT_FOUND,
      "Check available modules with: kspec item list --type module",
      {
        ref: moduleRef,
        entity: "module",
      },
    );
  }
  const moduleItem = moduleResult.item as LoadedSpecItem;

  for (const spec of sortResult.sorted) {
    const localSlug = spec.slug || slugify(spec.title);
    const itemType = (spec.type || "feature") as SpecItemInput["type"];
    const itemSlug = nextUniqueSlug(localSlug, reservedSlugs);
    const itemRef = `@${itemSlug}`;

    let parent: LoadedSpecItem | null = null;

    if (!(itemType === "trait" && !spec.parent)) {
      if (spec.parent) {
        const localParent = createdSpecs.get(
          spec.parent.startsWith("@") ? spec.parent.slice(1) : spec.parent,
        );
        if (localParent) {
          parent = localParent.item;
        } else {
          const resolvedParent = refIndex.resolve(spec.parent);
          if (!resolvedParent.ok) {
            const reason = `Parent ${toRef(spec.parent)} not found. Use an existing @ref or add the parent spec to the plan.`;
            warnings.push({ kind: "spec", ref: itemRef, message: reason });
            skipped.push({
              kind: "spec",
              ref: itemRef,
              title: spec.title,
              reason,
            });
            continue;
          }
          parent = resolvedParent.item as LoadedSpecItem;
        }
      } else {
        parent = moduleItem;
      }
    }

    const input: SpecItemInput = {
      title: spec.title,
      type: itemType,
      slugs: [itemSlug],
      description: spec.description,
      priority: spec.priority,
      tags: [],
      acceptance_criteria: spec.acceptance_criteria,
      depends_on: normalizeSpecDependencies(spec, refIndex, createdSpecs, warnings),
      implements: [],
      relates_to: [],
      tests: [],
      traits: normalizeSpecTraits(spec, refIndex, createdSpecs, warnings),
      notes: [],
    };

    const newItem = createSpecItem(input);

    let createdItem: LoadedSpecItem;
    if (dryRun) {
      createdItem = {
        ...newItem,
        _sourceFile: parent?._sourceFile,
      } as LoadedSpecItem;
    } else if (itemType === "trait" && !spec.parent) {
      const addResult = await addProjectLevelTraitItem(ctx, newItem);
      createdItem = {
        ...(addResult.item as LoadedSpecItem),
        _sourceFile: ctx.manifestPath || undefined,
        _path: addResult.path,
      };
    } else {
      const addResult = await addChildItem(ctx, parent!, newItem);
      createdItem = {
        ...(addResult.item as LoadedSpecItem),
        _sourceFile: parent!._sourceFile,
        _path: addResult.path,
      };
    }

    const materializedSpec: MaterializedSpec = {
      localSlug,
      ref: itemRef,
      item: createdItem,
      source: spec,
    };
    createdSpecs.set(localSlug, materializedSpec);
    materialized.push(materializedSpec);
  }

  return materialized;
}

/**
 * Compute the task-owned resource id that materialization will produce for a
 * given plan resource. Centralized so the pre-flight validation and the
 * runtime materialize loop cannot drift apart.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource
 */
function buildMaterializedResourceId(planResourceId: string): string {
  return `plan-${planResourceId}`;
}

/**
 * Pre-flight validation for `--materialize-resources`. Verifies, BEFORE any
 * task is created on disk, that every materialization is safe to perform:
 *
 *   1. The resulting task resource id (`plan-<original-id>`) must satisfy the
 *      resource id contract. Without this, a plan resource id close to the
 *      128-character ceiling would produce a 133+ character task id and
 *      `computeResourceMetadata` would reject it AFTER `createTask` already
 *      wrote the derived task — leaving partial state on disk.
 *
 *   2. Each source path under the plan's `resources/` directory must walk a
 *      symlink-free chain. `fs.copyFile` follows symlinks, so a pre-existing
 *      symlink at the plan resource leaf or an intermediate directory would
 *      let materialization import bytes from outside the plan tree.
 *
 * Failing fast here keeps the derive transactional: either every
 * materialization will succeed or no task is created. The runtime materialize
 * function re-applies the same guards as defense in depth.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
async function preflightMaterializationSafety(
  ctx: Awaited<ReturnType<typeof initContext>>,
  planUlid: string,
  taskPlans: PendingTaskPlan[],
): Promise<void> {
  const planResourcesDir = getResourcesDir(getPlanDir(ctx, planUlid));
  for (const taskPlan of taskPlans) {
    for (const planResource of taskPlan.planResources) {
      const materializedId = buildMaterializedResourceId(planResource.id);
      const idValidation = validateResourceId(materializedId);
      if (!idValidation.ok) {
        exitDeriveWithGuidance(
          `Plan resource "${planResource.id}" cannot be materialized: ${idValidation.error}`,
          EXIT_CODES.USAGE_ERROR,
          'Rename the plan resource to fit within 123 characters before the "plan-" prefix is added, then re-run derive with --materialize-resources.',
          {
            plan_resource_id: planResource.id,
            materialized_id: materializedId,
            task_ref: taskPlan.ref,
          },
        );
      }

      const safeSource = await assertSafeResourceMutationPath({
        ownerResourcesDir: planResourcesDir,
        relativePath: planResource.path,
      });
      if (!safeSource.ok) {
        exitDeriveWithGuidance(
          `Plan resource "${planResource.id}" cannot be materialized: ${safeSource.error}`,
          EXIT_CODES.USAGE_ERROR,
          "Replace the symlinked plan resource file with a regular file before re-running derive with --materialize-resources.",
          {
            plan_resource_id: planResource.id,
            path: planResource.path,
            task_ref: taskPlan.ref,
          },
        );
      }
    }
  }
}

/**
 * Copy plan-owned resource files into a derived task's resources tree at
 * `.kspec/tasks/<task-ulid>/resources/plan/<plan-ulid>/<original-relative-path>`,
 * rewrite the task's manifest entries with id `plan-<original-id>`, and
 * update the task's `resource_refs` so they point at the task-owned copy.
 *
 * Materialization is opt-in via `--materialize-resources`. The default
 * behavior keeps the reference plan-owned and never copies bytes
 * (`ac-derived-task-keeps-plan-resource-reference`).
 *
 * Pre-flight safety (id length + source symlink containment) is enforced by
 * `preflightMaterializationSafety` BEFORE any task is created. This function
 * re-applies the same guards as defense in depth — a failure here would
 * indicate a TOCTOU race between preflight and copy.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
async function materializePlanResourcesForTask(options: {
  ctx: Awaited<ReturnType<typeof initContext>>;
  planUlid: string;
  taskUlid: string;
  taskCanonicalRef: string;
  planResources: ResourceMetadata[];
  recordedAt: string;
}): Promise<void> {
  if (options.planResources.length === 0) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const planResourcesDir = getResourcesDir(getPlanDir(options.ctx, options.planUlid));
  const taskResourcesDir = getResourcesDir(getTaskDir(options.ctx, options.taskUlid));
  const taskSubPrefix = path.posix.join("plan", options.planUlid);

  const taskMetadata: ResourceMetadata[] = [];
  const taskResourceRefs: TaskResourceRef[] = [];

  for (const planResource of options.planResources) {
    // Defense in depth: assertSafeResourceMutationPath was already called by
    // preflightMaterializationSafety before any task was created. Re-applying
    // it here closes the TOCTOU window between preflight and copy — without
    // this, an attacker replacing the plan resource with a symlink between
    // preflight and the copy would still escape.
    const safeSource = await assertSafeResourceMutationPath({
      ownerResourcesDir: planResourcesDir,
      relativePath: planResource.path,
    });
    if (!safeSource.ok) {
      throw new Error(
        `Refusing to materialize plan resource ${planResource.id}: ${safeSource.error}`,
      );
    }
    const destinationRelative = path.posix.join(taskSubPrefix, planResource.path);
    const safeDestination = await assertSafeResourceMutationPath({
      ownerResourcesDir: taskResourcesDir,
      relativePath: destinationRelative,
    });
    if (!safeDestination.ok) {
      throw new Error(
        `Refusing to materialize plan resource ${planResource.id}: ${safeDestination.error}`,
      );
    }

    const sourceAbs = safeSource.value.absolutePath;
    const destinationAbs = safeDestination.value.absolutePath;
    await fs.mkdir(path.dirname(destinationAbs), { recursive: true });
    await fs.copyFile(sourceAbs, destinationAbs);

    const computed = await computeResourceMetadata({
      id: buildMaterializedResourceId(planResource.id),
      relativePath: destinationRelative,
      absolutePath: destinationAbs,
      contentType: planResource.content_type,
      label: planResource.label,
      description: planResource.description,
    });
    if (!computed.ok) {
      throw new Error(
        `Failed to compute task resource metadata for ${destinationRelative}: ${computed.error}`,
      );
    }
    taskMetadata.push(computed.value);
    taskResourceRefs.push({
      owner_type: "task",
      owner_ref: options.taskCanonicalRef,
      id: computed.value.id,
      path: computed.value.path,
      sha256: computed.value.sha256,
      git_commit: computed.value.git_commit,
      git_path: computed.value.git_path,
      recorded_at: options.recordedAt,
    });
  }

  await writeResourceManifest(getTaskDir(options.ctx, options.taskUlid), {
    resources: taskMetadata,
  });

  // Patch the task's `resource_refs` to point at task-owned copies. The
  // task data manager takes a ref string and resolves it; ULID is a stable
  // canonical ref so we pass it through directly.
  await resolveTaskDataManager(options.ctx).mutateTask(
    options.ctx,
    `@${options.taskUlid}`,
    (latest) => ({
      ...latest,
      resource_refs: taskResourceRefs,
    }),
  );
}

function buildTaskPlans(
  planRef: string,
  specItems: MaterializedSpec[],
  deriveFromSpecs: boolean | undefined,
  additionalTasks: PlanTask[] | undefined,
  refIndex: Awaited<ReturnType<typeof buildIndexes>>["refIndex"],
  allTasks: LoadedTask[],
  reservedSlugs: Set<string>,
  author: string | undefined,
  warnings: DeriveWarning[],
  planResourceManifest: ResourceMetadata[],
  recordedAt: string,
): PendingTaskPlan[] {
  const taskPlans: PendingTaskPlan[] = [];
  const specTaskRefByLocalSlug = new Map<string, string>();
  const taskRefByLocalKey = new Map<string, string>();
  const shouldDeriveFromSpecs = deriveFromSpecs !== false;

  if (shouldDeriveFromSpecs) {
    for (const specItem of specItems) {
      const taskSlug = nextUniqueSlug(slugify(`implement-${specItem.source.title}`), reservedSlugs);
      const taskRef = `@${taskSlug}`;
      specTaskRefByLocalSlug.set(specItem.localSlug, taskRef);
      taskRefByLocalKey.set(specItem.localSlug, taskRef);
    }
  }

  for (const task of additionalTasks || []) {
    const localKey = task.slug || slugify(task.title);
    const taskSlug = nextUniqueSlug(task.slug || localKey, reservedSlugs);
    taskRefByLocalKey.set(localKey, `@${taskSlug}`);
  }

  if (shouldDeriveFromSpecs) {
    for (const specItem of specItems) {
      const taskRef = specTaskRefByLocalSlug.get(specItem.localSlug)!;
      const taskSlug = taskRef.slice(1);
      const dependsOn = (specItem.item.depends_on || []).map((dependencyRef) => {
        const localDependency = specTaskRefByLocalSlug.get(dependencyRef.slice(1));
        return localDependency || dependencyRef;
      });

      const notes = specItem.source.implementation_notes
        ? [createNote(specItem.source.implementation_notes, author)]
        : [];

      taskPlans.push({
        localKey: specItem.localSlug,
        ref: taskRef,
        input: {
          title: `Implement ${specItem.source.title}`,
          type: "task",
          slugs: [taskSlug],
          spec_ref: specItem.ref,
          plan_ref: planRef,
          priority: specItem.source.priority ?? 3,
          tags: [],
          depends_on: dependsOn,
          notes,
          origin: "derived",
          derivation: "auto",
        },
        planResources: [],
      });
    }
  }

  for (const task of additionalTasks || []) {
    const localKey = task.slug || slugify(task.title);
    const taskRef = taskRefByLocalKey.get(localKey)!;
    const taskSlug = taskRef.slice(1);

    const specRef = task.spec_ref
      ? (() => {
          const localSpec = specItems.find(
            (candidate) =>
              candidate.localSlug ===
              (task.spec_ref!.startsWith("@") ? task.spec_ref!.slice(1) : task.spec_ref!),
          );
          if (localSpec) {
            return localSpec.ref;
          }

          const resolved = refIndex.resolve(task.spec_ref!);
          if (resolved.ok) {
            return canonicalRef(resolved.item as LoadedSpecItem);
          }

          warnings.push({
            kind: "task",
            ref: taskRef,
            message: `Unresolved spec_ref ${toRef(task.spec_ref!)} on additional task. Keeping normalized reference.`,
          });
          return toRef(task.spec_ref!);
        })()
      : null;

    const dependsOn = (task.depends_on || []).map((dependencyRef) => {
      const normalized = toRef(dependencyRef);
      const localTaskDependency = taskRefByLocalKey.get(normalized.slice(1));
      if (localTaskDependency) {
        return localTaskDependency;
      }

      const resolved = refIndex.resolve(normalized);
      if (resolved.ok) {
        return canonicalRef(resolved.item as LoadedSpecItem);
      }

      warnings.push({
        kind: "task",
        ref: taskRef,
        message: `Unresolved depends_on ${normalized} on additional task. Keeping normalized reference.`,
      });
      return normalized;
    });

    // Validate resource_refs against the plan's resource manifest. Each
    // reference must use the ./resources/<rel> form and resolve to a declared
    // entry. Unresolved refs are a fatal derive error — the alternative
    // (skip + warn) would silently drop the link the author wrote.
    // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
    // AC: @plan-resource-derivation-semantics-1 ac-derived-task-keeps-plan-resource-reference
    // AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
    const planResources: ResourceMetadata[] = [];
    const taskResourceRefs: TaskResourceRef[] = [];
    for (const rawRef of task.resource_refs || []) {
      const parsed = parseResourceReference(rawRef);
      if (!parsed.ok) {
        exitDeriveWithGuidance(
          `Task "${task.slug || task.title}" declares an invalid resource_refs entry "${rawRef}": ${parsed.error}`,
          EXIT_CODES.USAGE_ERROR,
          'Use the form "./resources/<relative-path>" where the path is declared on the plan.',
          { task: task.slug || task.title, resource_ref: rawRef },
        );
      }
      const declared = planResourceManifest.find((r) => r.path === parsed.value.relativePath);
      if (!declared) {
        exitDeriveWithGuidance(
          `Task "${task.slug || task.title}" references plan resource "${rawRef}" which is not declared on the plan.`,
          EXIT_CODES.USAGE_ERROR,
          'Attach the resource first with "kspec plan resource add" or remove the resource_refs entry.',
          { task: task.slug || task.title, resource_ref: rawRef },
        );
      }
      planResources.push(declared);
      taskResourceRefs.push({
        owner_type: "plan",
        owner_ref: planRef,
        id: declared.id,
        path: declared.path,
        sha256: declared.sha256,
        git_commit: declared.git_commit,
        git_path: declared.git_path,
        recorded_at: recordedAt,
      });
    }

    taskPlans.push({
      localKey,
      ref: taskRef,
      input: {
        title: task.title,
        type: "task",
        slugs: [taskSlug],
        description: task.description,
        spec_ref: specRef,
        plan_ref: planRef,
        priority: task.priority ?? 3,
        tags: task.tags || [],
        depends_on: dependsOn,
        notes: [],
        origin: "derived",
        resource_refs: taskResourceRefs.length > 0 ? taskResourceRefs : undefined,
      },
      planResources,
    });
  }

  const existingTaskSlugs = new Set(allTasks.flatMap((task) => task.slugs));
  for (const taskPlan of taskPlans) {
    if (existingTaskSlugs.has(taskPlan.input.slugs?.[0] || "")) {
      warnings.push({
        kind: "task",
        ref: taskPlan.ref,
        message: "Task slug collided with existing work and was renumbered.",
      });
    }
  }

  return taskPlans;
}

/**
 * Register the 'plan' command group
 */
export function registerPlanCommands(program: Command): void {
  const plan = program.command("plan").description("Manage implementation plans");

  // Register plan import subcommand
  registerPlanImportCommand(plan);

  // Register plan resource attachment subcommands
  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  registerPlanResourceCommands(plan);

  // kspec plan rebuild-index
  // AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  registerPlanRebuildIndexCommand(plan);

  // kspec plan add
  // AC: @plan-crud ac-1, ac-2
  markMutating(plan.command("add"))
    .description("Create a new plan")
    .requiredOption("--title <title>", "Plan title")
    .option("--content <text>", "Plan content (markdown)")
    .option("--content-file <path>", "Read content from markdown file")
    .option("--status <status>", "Initial status (default: draft)")
    .option("--slug <slug>", "Optional slug for the plan")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec plan add --title "User Auth" --content "Implement JWT auth..."
  $ kspec plan add --title "API Refactor" --content-file ./plan.md`,
    )
    .action(async (options) => {
      try {
        const ctx = await initContext();

        // Validate content options
        if (options.content && options.contentFile) {
          error("Cannot specify both --content and --content-file. Choose one.");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // Read content from file if specified
        // AC: @plan-crud ac-2
        let content = options.content || "";
        if (options.contentFile) {
          const contentPath = path.resolve(process.cwd(), options.contentFile);
          try {
            content = await fs.readFile(contentPath, "utf-8");
          } catch (err) {
            error(`Failed to read content file: ${options.contentFile}`, err);
            process.exit(EXIT_CODES.ERROR);
          }
        }

        // Validate title is non-empty
        if (!options.title || options.title.trim().length === 0) {
          error("Plan title cannot be empty.");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // Generate URL-safe slug from title
        // oxlint-disable-next-line unicorn/consistent-function-scoping
        const generateSlug = (title: string): string => {
          return title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 50);
        };

        // Auto-namespace plan slugs with "plan-" prefix to prevent collision with spec slugs
        // If user provides a slug, check for collision with spec items and plans
        // If no slug provided, auto-generate with "plan-" prefix and ensure uniqueness
        const plans = await loadPlans(ctx);
        let planSlug = options.slug || `plan-${generateSlug(options.title)}`;

        // Check for collision with spec items and plans
        const { refIndex } = await buildIndexes(ctx, plans);
        if (options.slug) {
          // Manual slug: check for collision across all namespaces (specs/tasks/plans)
          if (!refIndex.isSlugAvailable(options.slug)) {
            error(
              `Slug "${options.slug}" collides with existing item. Use a different slug or omit --slug for auto-namespaced slug.`,
            );
            process.exit(EXIT_CODES.CONFLICT);
          }
        } else {
          // Auto-generated slug: ensure uniqueness across all namespaces
          let counter = 1;
          const baseSlug = planSlug;
          while (!refIndex.isSlugAvailable(planSlug)) {
            planSlug = `${baseSlug}-${counter}`;
            counter++;
          }
        }

        const statusResult = validateEnumOption(
          options.status || "draft",
          PlanStatusSchema.options,
          "plan status",
        );
        if (!statusResult.ok) {
          error(statusResult.error);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const input: PlanInput = {
          title: options.title,
          content,
          status: statusResult.value,
          slugs: [planSlug],
        };

        const newPlan = createPlan(input);
        await savePlan(ctx, newPlan);
        const planRef = shortPlanRef(newPlan, [...plans, newPlan]);

        // AC: @plan-crud ac-1 - auto-commit to shadow branch
        await commitIfShadow(
          ctx.shadow,
          "plan-add",
          newPlan.slugs[0] || newPlan._ulid.slice(0, 8),
          options.title,
        );

        success(`Created plan: ${planRef} - ${newPlan.title}`, {
          plan: newPlan,
        });
      } catch (err) {
        error(errors.failures.createPlan, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan get <ref>
  // AC: @plan-crud ac-8, ac-30
  plan
    .command("get <ref>")
    .description("Show plan details")
    .option("--json", "Output as JSON")
    .action(async (ref: string, _options) => {
      try {
        const ctx = await initContext();
        const plans = await loadPlans(ctx);
        const foundPlan = resolvePlanRef(ref, plans);

        // AC: @plan-crud ac-30 - JSON output
        output(foundPlan, () => {
          // AC: @plan-crud ac-8 - full plan display
          console.log(`${fieldLabels.ulid}     ${foundPlan._ulid}`);
          console.log(`${fieldLabels.title}    ${foundPlan.title}`);
          console.log(`${fieldLabels.status}   ${foundPlan.status}`);

          if (foundPlan.slugs.length > 0) {
            console.log(`Slugs:    ${foundPlan.slugs.join(", ")}`);
          }

          if (foundPlan.module_ref) {
            console.log(`Module:   ${foundPlan.module_ref}`);
          }

          if (foundPlan.branch) {
            console.log(`Branch:   ${foundPlan.branch}`);
          }

          if (foundPlan.source_path) {
            console.log(`Source:   ${foundPlan.source_path}`);
          }

          console.log(
            `${fieldLabels.created}  ${foundPlan.created_at} (${formatRelativeTime(foundPlan.created_at)})`,
          );

          if (foundPlan.approved_at) {
            console.log(
              `Approved: ${foundPlan.approved_at} (${formatRelativeTime(foundPlan.approved_at)})`,
            );
          }

          if (foundPlan.completed_at) {
            console.log(
              `Completed: ${foundPlan.completed_at} (${formatRelativeTime(foundPlan.completed_at)})`,
            );
          }

          // Show derived work
          if (foundPlan.derived_tasks.length > 0 || foundPlan.derived_specs.length > 0) {
            console.log("\nDerived Work:");
            if (foundPlan.derived_specs.length > 0) {
              console.log(`  Specs: ${foundPlan.derived_specs.join(", ")}`);
            }
            if (foundPlan.derived_tasks.length > 0) {
              console.log(`  Tasks: ${foundPlan.derived_tasks.join(", ")}`);
            }
          }

          // Show content
          if (foundPlan.content) {
            console.log("\n─── Content ───");
            console.log(foundPlan.content);
          }

          // Show notes
          if (foundPlan.notes.length > 0) {
            console.log("\n─── Notes ───");
            for (const note of foundPlan.notes) {
              const age = formatRelativeTime(note.created_at);
              const author = note.author ? ` by ${note.author}` : "";
              console.log(`\n[${age}${author}]`);
              console.log(note.content);
            }
          }
        });
      } catch (err) {
        error(errors.failures.getPlan, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan branch <ref>
  // AC: @plan-branch-creation ac-deterministic-name, ac-forks-from-base, ac-updates-plan-record,
  // ac-resume-local, ac-rehydrate-remote, ac-custom-name, ac-reports-result
  markMutating(plan.command("branch <ref>"))
    .description("Create or resume the deterministic branch for a plan")
    .option("--name <branch-name>", "Override the deterministic branch name")
    .action(async (ref: string, options: { name?: string }) => {
      try {
        const ctx = await initContext();

        if (!isGitRepo()) {
          error("Not a git repository. Run this command from inside a git repo.");
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const plans = await loadPlans(ctx);
        const foundPlan = resolvePlanRef(ref, plans);
        const planRef = canonicalRef(foundPlan);
        const requestedName = options.name?.trim() || null;
        const branchName =
          requestedName ?? foundPlan.branch ?? computePlanBranchName(foundPlan._ulid, foundPlan);

        const localExists = gitRefExists(`refs/heads/${branchName}`);
        let action: "created" | "switched" | "rehydrated" | "already_on_branch";
        let source: string | undefined;

        if (localExists) {
          if (getCurrentBranch() === branchName) {
            action = "already_on_branch";
          } else {
            gitCheckout(branchName);
            action = "switched";
          }
        } else {
          const remoteSource = findBranchOnRemote(branchName);
          if (remoteSource) {
            gitCreateBranchFrom(branchName, remoteSource);
            gitCheckout(branchName);
            action = "rehydrated";
            source = remoteSource;
          } else {
            const resolvedConfig = await resolveDispatchWorkspaceConfig(ctx.projectRoot);
            gitCheckoutNew(branchName, resolvedConfig.baseBranchStartPoint);
            action = "created";
          }
        }

        const changeDetail = `branch: ${foundPlan.branch ?? "null"} → ${branchName}`;
        const planRecordUpdated = foundPlan.branch !== branchName;
        if (planRecordUpdated) {
          const updatedPlan = await mutatePlanAtomically(ctx, foundPlan, (latestPlan) => ({
            ...latestPlan,
            branch: branchName,
          }));
          await commitIfShadow(
            ctx.shadow,
            "plan-branch",
            updatedPlan.slugs[0] || updatedPlan._ulid.slice(0, 8),
            changeDetail,
          );
        }

        reportBranchResult({
          branch: branchName,
          action,
          source,
          guidance:
            "The plan record now points dispatch-aware follow-up work at this shared branch.",
          subject: {
            label: "Plan",
            ref: planRef,
            jsonKey: "plan_ref",
          },
          extraJson: {
            plan_record_updated: planRecordUpdated,
          },
          extraInfo: [
            `Plan record ${planRecordUpdated ? "updated" : "already matched"}: ${branchName}`,
          ],
        });
      } catch (err) {
        const details =
          err instanceof Error
            ? {
                message: err.message,
                suggestion:
                  'Check the plan ref with "kspec plan list", verify the target branch exists or the dispatch base branch is configured, then retry.',
              }
            : {
                suggestion:
                  'Check the plan ref with "kspec plan list", verify the target branch exists or the dispatch base branch is configured, then retry.',
              };
        error("Failed to create or resume plan branch", details);
        // Runtime git failure exit code per @trait-semantic-exit-codes ac-4.
        process.exit(3);
      }
    });

  plan
    .command("export <ref>")
    .description("Export stored plan content to stdout or a file")
    .option("--output <path>", "Write plan content to the specified file")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec plan export @plan-ref
  $ kspec plan export @plan-ref --output ./plan.md
  $ kspec plan export @plan-ref --json`,
    )
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const foundPlan = await findPlanByRef(ctx, ref);

        if (!foundPlan) {
          error(errors.reference.planNotFound(ref));
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        if (foundPlan.content.length === 0) {
          error("Plan has no content to export");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        if (isJsonMode()) {
          output(foundPlan);
          return;
        }

        if (options.output) {
          const outputPath = path.resolve(process.cwd(), options.output);
          try {
            await fs.writeFile(outputPath, foundPlan.content, "utf-8");
          } catch (err) {
            error(`Failed to write plan export file: ${options.output}`, err);
            process.exit(EXIT_CODES.ERROR);
          }
          success(`Exported plan content to ${options.output}`);
          return;
        }

        process.stdout.write(foundPlan.content);
      } catch (err) {
        error("Failed to export plan", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan set <ref>
  // AC: @plan-crud ac-3, ac-4
  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured (--content-file)
  markMutating(plan.command("set <ref>"))
    .description("Update plan fields")
    .option("--title <title>", "Update title")
    .option("--status <status>", "Update status")
    .option("--slug <slug>", "Add a slug")
    .option("--branch <name>", "Set or clear the plan branch (use null or empty string to clear)")
    .option(
      "--content-file <path>",
      "Replace plan markdown content from a file (validates ./resources/<rel> links against the plan's attached resources)",
    )
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const plans = await loadPlans(ctx);
        const foundPlan = resolvePlanRef(ref, plans);
        const foundPlanRef = shortPlanRef(foundPlan, plans);
        const terminalTransitionError = "__PLAN_TERMINAL_STATUS_TRANSITION__";

        const changes: string[] = [];

        if (options.slug) {
          if (!foundPlan.slugs.includes(options.slug)) {
            // Check for collision with specs/tasks/plans
            const { refIndex } = await buildIndexes(ctx, plans);
            if (!refIndex.isSlugAvailable(options.slug)) {
              error(`Slug "${options.slug}" collides with existing item. Use a different slug.`);
              process.exit(EXIT_CODES.CONFLICT);
            }
          }
        }

        if (
          !options.title &&
          !options.status &&
          !options.slug &&
          options.branch === undefined &&
          !options.contentFile
        ) {
          info("No changes specified");
          return;
        }

        // Read and validate --content-file before mutating. The content
        // becomes the new plan.md body and every ./resources/<rel> link must
        // already resolve against the plan's attached resources.yaml.
        // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
        let newContent: string | undefined;
        if (options.contentFile) {
          const contentPath = path.resolve(process.cwd(), options.contentFile);
          try {
            newContent = await fs.readFile(contentPath, "utf-8");
          } catch (err) {
            error(`Failed to read content file: ${options.contentFile}`, err);
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
          try {
            const { assertMarkdownLinksResolveAgainstPlan, PlanImportResourceError } =
              await import("../../parser/plan-resource-import.js");
            const { getPlanDir } = await import("../../parser/plan-storage-manager.js");
            await assertMarkdownLinksResolveAgainstPlan(
              getPlanDir(ctx, foundPlan._ulid),
              newContent,
              contentPath,
            );
            void PlanImportResourceError; // type-only side import
          } catch (err) {
            if (err instanceof Error && err.name === "PlanImportResourceError") {
              const planResourceError = err as Error & {
                code?: string;
                resourceId?: string | null;
                path?: string | null;
                sourceFile?: string | null;
                line?: number | null;
              };
              if (isJsonMode()) {
                error(planResourceError.message, {
                  code: planResourceError.code ?? null,
                  resource_id: planResourceError.resourceId ?? null,
                  path: planResourceError.path ?? null,
                  source_file: planResourceError.sourceFile ?? null,
                  line: planResourceError.line ?? null,
                });
              } else {
                error(planResourceError.message);
              }
              process.exit(EXIT_CODES.USAGE_ERROR);
            }
            throw err;
          }
        }

        let statusValue: LoadedPlan["status"] | undefined;
        if (options.status) {
          const statusResult = validateEnumOption(
            options.status,
            PlanStatusSchema.options,
            "plan status",
          );
          if (!statusResult.ok) {
            error(statusResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          statusValue = statusResult.value;
        }

        let updatedPlan: LoadedPlan;
        try {
          updatedPlan = await mutatePlanAtomically(ctx, foundPlan, (latestPlan) => {
            // AC: @plan-crud ac-4 - prevent transitions from terminal states
            if (
              statusValue &&
              (latestPlan.status === "completed" || latestPlan.status === "rejected")
            ) {
              throw new Error(terminalTransitionError);
            }

            const nextPlan: LoadedPlan = {
              ...latestPlan,
              slugs: [...latestPlan.slugs],
              derived_tasks: [...latestPlan.derived_tasks],
              derived_specs: [...latestPlan.derived_specs],
              notes: [...latestPlan.notes],
            };

            if (options.title) {
              nextPlan.title = options.title;
              changes.push("title");
            }

            if (statusValue) {
              const oldStatus = latestPlan.status;
              nextPlan.status = statusValue;
              changes.push(`status: ${oldStatus} → ${statusValue}`);

              // AC: @plan-crud ac-3 - set approved_at timestamp when transitioning to approved
              if (statusValue === "approved" && !nextPlan.approved_at) {
                nextPlan.approved_at = new Date().toISOString();
              }
            }

            if (options.slug && !nextPlan.slugs.includes(options.slug)) {
              nextPlan.slugs.push(options.slug);
              changes.push(`slug: +${options.slug}`);
            }

            if (options.branch !== undefined) {
              const normalizedBranch =
                options.branch === "null" || options.branch.trim() === "" ? null : options.branch;
              if (normalizedBranch !== latestPlan.branch) {
                nextPlan.branch = normalizedBranch;
                changes.push(
                  `branch: ${latestPlan.branch ?? "null"} → ${normalizedBranch ?? "null"}`,
                );
              }
            }

            if (newContent !== undefined && newContent !== latestPlan.content) {
              nextPlan.content = newContent;
              changes.push("content");
            }

            return nextPlan;
          });
        } catch (err) {
          if (err instanceof Error && err.message === terminalTransitionError) {
            error("Cannot transition from terminal status");
            process.exit(EXIT_CODES.CONFLICT);
          }
          throw err;
        }

        if (changes.length === 0) {
          info("No changes specified");
          return;
        }

        await commitIfShadow(
          ctx.shadow,
          "plan-set",
          updatedPlan.slugs[0] || updatedPlan._ulid.slice(0, 8),
          changes.join(", "),
        );

        success(`Updated plan: ${foundPlanRef}`, {
          changes,
          plan: updatedPlan,
        });
      } catch (err) {
        error(errors.failures.updatePlan, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan list
  // AC: @plan-crud ac-7, ac-31
  plan
    .command("list")
    .description("List plans")
    .option("--status <status>", "Filter by status")
    .option("--json", "Output as JSON array")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        let plans = await loadPlans(ctx);
        const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);

        // AC: @plan-crud ac-7 - status filter
        if (options.status) {
          const statusResult = validateEnumOption(
            options.status,
            PlanStatusSchema.options,
            "plan status",
          );
          if (!statusResult.ok) {
            error(statusResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          plans = filterPlansByStatus(plans, statusResult.value);
        }

        // Sort by created date (newest first)
        plans.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        // AC: @plan-crud ac-31 - JSON output
        output(plans, () => {
          if (plans.length === 0) {
            console.log("No plans found");
            return;
          }

          console.log(`Plans (${plans.length}):\n`);

          for (const p of plans) {
            const ref = shortPlanRef(p, plans);
            const age = formatRelativeTime(p.created_at);
            const taskCount = getLinkedPlanSummaryTasks(p, tasks).filter((task) =>
              isCountedInPlanSummary(task),
            ).length;
            const taskLabel =
              taskCount > 0 ? ` [${taskCount} task${taskCount > 1 ? "s" : ""}]` : "";

            console.log(`  ${ref} [${p.status}]${taskLabel} ${p.title}`);
            console.log(`         Created ${age}`);

            if (p.approved_at) {
              console.log(`         Approved ${formatRelativeTime(p.approved_at)}`);
            }

            console.log("");
          }
        });
      } catch (err) {
        error(errors.failures.listPlans, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan note <ref> <text>
  // AC: @plan-crud ac-9
  markMutating(plan.command("note <ref> <text>"))
    .description("Add a note to a plan")
    .action(async (ref: string, text: string) => {
      try {
        const ctx = await initContext();
        const author = getAuthor(ctx.config?.identity?.author);
        const plans = await loadPlans(ctx);
        const foundPlan = resolvePlanRef(ref, plans);
        const foundPlanRef = shortPlanRef(foundPlan, plans);

        // AC: @plan-crud ac-9 - append note with ULID, timestamp, author
        const note = {
          _ulid: ulid(),
          created_at: new Date().toISOString(),
          author,
          content: text,
        };

        const updatedPlan = await mutatePlanAtomically(ctx, foundPlan, (latestPlan) => ({
          ...latestPlan,
          notes: [...latestPlan.notes, note],
        }));

        await commitIfShadow(
          ctx.shadow,
          "plan-note",
          updatedPlan.slugs[0] || updatedPlan._ulid.slice(0, 8),
        );

        success(`Added note to plan: ${foundPlanRef}`, {
          note,
        });
      } catch (err) {
        error(errors.failures.addPlanNote, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan delete <ref>
  // AC: @plan-crud ac-40 through ac-53
  markMutating(plan.command("delete <ref>"))
    .description("Delete a plan (draft or rejected only)")
    .option("--force", "Skip confirmation")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec plan delete @plan-ref
  $ kspec plan delete @plan-ref --force
  $ kspec plan delete @plan-ref --json`,
    )
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const plans = await loadPlans(ctx);

        // AC: @plan-crud ac-51 — resolve ref; not-found is distinct from refusal
        const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;
        const foundPlan = plans.find(
          (p) =>
            p._ulid === cleanRef ||
            p._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
            p.slugs.includes(cleanRef),
        );

        if (!foundPlan) {
          error(`Plan not found: ${ref}`, isJsonMode() ? { error: "not_found", ref } : undefined);
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        const planRef = shortPlanRef(foundPlan, plans);

        // Collect all refusal reasons (do not short-circuit)
        const refusalReasons: Array<{
          reason: string;
          items?: Array<{ ref: string; title?: string }>;
        }> = [];

        // AC: @plan-crud ac-41 — status gate
        const deletableStatuses = ["draft", "rejected"];
        if (!deletableStatuses.includes(foundPlan.status)) {
          refusalReasons.push({
            reason: "status-blocked",
            items: [{ ref: `status:${foundPlan.status}` }],
          });
        }

        // AC: @plan-crud ac-42, ac-43 — derived work check
        const { refIndex, tasks } = await buildIndexes(ctx, plans);
        const blockingDerivedItems: Array<{ ref: string; title?: string }> = [];

        for (const derivedRef of [...foundPlan.derived_specs, ...foundPlan.derived_tasks]) {
          const resolveResult = refIndex.resolve(derivedRef);
          if (resolveResult.ok) {
            const item = resolveResult.item;
            const itemTitle = "title" in item ? (item.title as string) : undefined;
            const itemRef = `@${("slugs" in item && Array.isArray(item.slugs) && item.slugs[0]) || refIndex.shortUlid(resolveResult.ulid)}`;
            blockingDerivedItems.push({ ref: itemRef, title: itemTitle });
          }
          // Orphan entries (unresolvable) are skipped per ac-43
        }

        if (blockingDerivedItems.length > 0) {
          refusalReasons.push({
            reason: "derived-work-blocked",
            items: blockingDerivedItems,
          });
        }

        // AC: @plan-crud ac-44 — referencing tasks check (via ReferenceIndex resolution)
        const referencingTasks: Array<{ ref: string; title?: string }> = [];
        for (const task of tasks) {
          if (!task.plan_ref) continue;
          const resolveResult = refIndex.resolve(task.plan_ref);
          if (resolveResult.ok && resolveResult.ulid === foundPlan._ulid) {
            const taskRef = `@${task.slugs[0] || refIndex.shortUlid(task._ulid)}`;
            referencingTasks.push({ ref: taskRef, title: task.title });
          }
        }

        if (referencingTasks.length > 0) {
          refusalReasons.push({
            reason: "referencing-tasks-blocked",
            items: referencingTasks,
          });
        }

        // AC: @plan-crud ac-50 — emit all refusal reasons if any
        if (refusalReasons.length > 0) {
          const parts: string[] = [];
          for (const r of refusalReasons) {
            if (r.reason === "status-blocked") {
              parts.push(
                `Plan status "${foundPlan.status}" prevents removal (must be draft or rejected)`,
              );
            } else if (r.reason === "derived-work-blocked") {
              const refs = r.items!.map((i) => i.ref).join(", ");
              parts.push(`Derived work still resolves: ${refs}`);
            } else if (r.reason === "referencing-tasks-blocked") {
              const refs = r.items!.map((i) => i.ref).join(", ");
              parts.push(`Tasks reference this plan: ${refs}`);
            }
          }
          error(
            `Cannot delete plan: ${parts.join("; ")}`,
            isJsonMode()
              ? {
                  error: "refused",
                  ref: `@${foundPlan.slugs[0] || planRef}`,
                  reasons: refusalReasons,
                }
              : undefined,
          );
          process.exit(EXIT_CODES.CONFLICT);
        }

        // AC: @plan-crud ac-45, ac-46 — confirmation
        if (!options.force) {
          if (isJsonMode()) {
            error("Confirmation required. Use --force with --json");
            process.exit(EXIT_CODES.USAGE_ERROR);
          }

          const isTTY = process.env.KSPEC_TEST_TTY === "true" || process.stdin.isTTY;
          if (!isTTY) {
            error("Non-interactive environment. Use --force to proceed");
            process.exit(EXIT_CODES.USAGE_ERROR);
          }

          const readline = await import("node:readline");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const response = await new Promise<string>((resolve) => {
            rl.question(`Delete plan "${foundPlan.title}"? [y/N] `, (answer) => {
              rl.close();
              resolve(answer.trim());
            });
          });

          if (response.toLowerCase() !== "y") {
            console.log("Cancelled");
            process.exit(0);
          }
        }

        // AC: @plan-crud ac-40, ac-47 — perform deletion
        try {
          await deletePlan(ctx, foundPlan._ulid);
        } catch (err) {
          // AC: @plan-crud ac-53 — concurrent removal yields not-found
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
            error(`Plan not found: ${ref}`, isJsonMode() ? { error: "not_found", ref } : undefined);
            process.exit(EXIT_CODES.NOT_FOUND);
          }
          throw err;
        }

        // AC: @plan-crud ac-48 — shadow branch commit
        await commitIfShadow(
          ctx.shadow,
          "plan-delete",
          foundPlan.slugs[0] || foundPlan._ulid.slice(0, 8),
        );

        // AC: @plan-crud ac-49 — branch is NOT deleted (only the plan record)
        success(`Deleted plan: ${planRef} - ${foundPlan.title}`, {
          deleted: true,
          ulid: foundPlan._ulid,
          slug: foundPlan.slugs[0] || null,
          title: foundPlan.title,
        });
      } catch (err) {
        error(errors.failures.deletePlan, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan derive <ref>
  // AC: @plan-derive-enhanced ac-parse-content through ac-commit
  markMutating(plan.command("derive <ref>"))
    .description("Materialize plan content into specs and tasks")
    .option("--module <ref>", "Module context for derivation (overrides stored plan module)")
    .addOption(
      new Option(
        "--tasks",
        "Derive tasks (default; accepted for backward compatibility)",
      ).hideHelp(),
    )
    .option("--no-tasks", "Skip task derivation")
    .option("--dry-run", "Preview derived specs/tasks without saving changes")
    .option(
      "--materialize-resources",
      "Copy plan-owned resources into each derived task's resources/ tree instead of recording plan-owned references",
    )
    .addHelpText(
      "after",
      `
Examples:
  $ kspec plan derive @plan-ref --module @core
  $ kspec plan derive @plan-ref
  $ kspec plan derive @plan-ref --module @core --no-tasks --dry-run
  $ kspec plan derive @plan-ref --materialize-resources`,
    )
    .action(async (ref: string, options: DeriveOptions) => {
      try {
        const deriveTasks = options.tasks !== false;
        const ctx = await initContext();
        const plans = await loadPlans(ctx);
        const foundPlan = resolvePlanRef(ref, plans);
        const planRef = canonicalRef(foundPlan);
        const author = getAuthor(ctx.config?.identity?.author);

        if (foundPlan.status === "active") {
          exitDeriveWithGuidance(
            "Plan already derived. Manage specs directly via kspec item set.",
            EXIT_CODES.CONFLICT,
            `Update derived work directly, for example: kspec item set ${planRef} ...`,
            {
              current_status: foundPlan.status,
              valid_next_states: ["manage-derived-work"],
            },
          );
        }

        if (foundPlan.status !== "approved") {
          exitDeriveWithGuidance(
            `Plan must be in approved status to derive (current: ${foundPlan.status})`,
            EXIT_CODES.CONFLICT,
            `Approve the plan first with: kspec plan set ${planRef} --status approved`,
            {
              current_status: foundPlan.status,
              valid_next_states: ["approved"],
            },
          );
        }

        const parsedPlan = parsePlanDocument(foundPlan.content);
        const errorsList: Array<{ type: string; message: string }> = [];
        const warnings: DeriveWarning[] = [];
        const skipped: DeriveSkipped[] = [];

        for (const parseError of parsedPlan.errors) {
          if (parseError.type === "yaml") {
            exitDeriveWithGuidance(
              parseError.message,
              EXIT_CODES.USAGE_ERROR,
              "Fix the YAML block in the plan document and run kspec plan derive again.",
              {
                type: parseError.type,
              },
            );
          }
          errorsList.push({
            type: parseError.type,
            message: parseError.message,
          });
        }

        const hasSpecsToMaterialize = parsedPlan.specs.length > 0;
        const hasManualTasksToMaterialize = Boolean(
          deriveTasks &&
          parsedPlan.tasks.additional_tasks &&
          parsedPlan.tasks.additional_tasks.length > 0,
        );

        // AC: @plan-import-format-guidance ac-empty-plan-derive-fails
        if (!hasSpecsToMaterialize && !hasManualTasksToMaterialize) {
          exitDeriveWithGuidance(
            "Plan has no derivable work. Expected a ## Specs section with spec definitions " +
              "and/or a ## Tasks section with task definitions or derive_from_specs: true, " +
              "but neither section contains derivable content.",
            EXIT_CODES.USAGE_ERROR,
            `Update the plan document and re-import: kspec plan import <path> --into ${planRef}`,
          );
        }

        let moduleRef = "";
        if (hasSpecsToMaterialize) {
          const resolvedModuleRef = await resolveDeriveModuleRef(
            ctx,
            plans,
            foundPlan,
            options.module,
          );
          if (!resolvedModuleRef) {
            exitDeriveWithGuidance(
              "Plan derive requires --module when the plan has no stored module ref",
              EXIT_CODES.USAGE_ERROR,
              `Re-run with a module, for example: kspec plan derive ${planRef} --module @your-module`,
              {
                field: "module",
                value: null,
              },
            );
          }
          moduleRef = resolvedModuleRef;
        } else {
          moduleRef = foundPlan.module_ref ?? options.module ?? "";
        }

        const { refIndex, items, tasks } = await buildIndexes(ctx, plans);
        const reservedSlugs = new Set([
          ...plans.flatMap((plan) => plan.slugs),
          ...items.flatMap((item) => item.slugs),
          ...tasks.flatMap((task) => task.slugs),
        ]);

        const materializedSpecs = hasSpecsToMaterialize
          ? await materializePlanSpecs(
              ctx,
              foundPlan,
              moduleRef,
              parsedPlan,
              refIndex,
              items,
              reservedSlugs,
              Boolean(options.dryRun),
              warnings,
              skipped,
            )
          : [];

        const createdSpecRefs = materializedSpecs.map((item) => item.ref);

        // Load the plan's resource manifest once; passed into task plan
        // building so manual task resource_refs can be validated and
        // recorded with their hash+git version metadata.
        // AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
        const planResourceManifest = (await loadResourceManifest(getPlanDir(ctx, foundPlan._ulid)))
          .resources;
        const recordedAt = new Date().toISOString();

        let taskPlans: PendingTaskPlan[] = [];
        if (deriveTasks) {
          taskPlans = buildTaskPlans(
            planRef,
            materializedSpecs,
            parsedPlan.tasks.derive_from_specs,
            parsedPlan.tasks.additional_tasks,
            refIndex,
            tasks,
            reservedSlugs,
            author,
            warnings,
            planResourceManifest,
            recordedAt,
          );
        }

        const createdTaskRefs = taskPlans.map((taskPlan) => taskPlan.ref);

        if (!options.dryRun) {
          // Pre-flight: validate every materialization is safe BEFORE any
          // task is created. Without this, a failure during materialization
          // (long id, symlinked source) would leave partial derived tasks on
          // disk because createTask already wrote them. The runtime
          // materialize function re-applies the same guards as defense in
          // depth.
          // AC: @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource
          // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
          if (options.materializeResources) {
            await preflightMaterializationSafety(ctx, foundPlan._ulid, taskPlans);
          }

          for (const taskPlan of taskPlans) {
            const created = await resolveTaskDataManager(ctx).createTask(ctx, taskPlan.input);
            // Materialize task-owned copies when explicitly requested. The
            // default mode keeps the reference pointing at the plan-owned
            // resource (no bytes copied) — see ac-derived-task-keeps-plan-
            // resource-reference.
            // AC: @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource
            if (options.materializeResources && taskPlan.planResources.length > 0) {
              await materializePlanResourcesForTask({
                ctx,
                planUlid: foundPlan._ulid,
                taskUlid: created._ulid,
                taskCanonicalRef: canonicalRef(created),
                planResources: taskPlan.planResources,
                recordedAt,
              });
            }
          }

          const updatedPlan = await mutatePlanAtomically(ctx, foundPlan, (latestPlan) => {
            const nextPlan: LoadedPlan = {
              ...latestPlan,
              slugs: [...latestPlan.slugs],
              derived_tasks: [...latestPlan.derived_tasks],
              derived_specs: [...latestPlan.derived_specs],
              notes: [...latestPlan.notes],
            };

            for (const specRef of createdSpecRefs) {
              if (!nextPlan.derived_specs.includes(specRef)) {
                nextPlan.derived_specs.push(specRef);
              }
            }

            for (const taskRef of createdTaskRefs) {
              if (!nextPlan.derived_tasks.includes(taskRef)) {
                nextPlan.derived_tasks.push(taskRef);
              }
            }

            nextPlan.status = "active";

            if (parsedPlan.implementationNotes?.trim()) {
              nextPlan.notes.push(createNote(parsedPlan.implementationNotes.trim(), author));
            }

            return nextPlan;
          });

          await commitIfShadow(
            ctx.shadow,
            "plan-derive",
            updatedPlan.slugs[0] || updatedPlan._ulid.slice(0, 8),
            `${createdSpecRefs.length} specs${deriveTasks ? `, ${createdTaskRefs.length} tasks` : ""}`,
          );
        } else if (parsedPlan.implementationNotes?.trim()) {
          warnings.push({
            kind: "plan",
            ref: planRef,
            message: "Global implementation notes would be added to the plan during execution.",
          });
        }

        reportWarnings(warnings);
        emitDeriveResult(
          {
            dry_run: Boolean(options.dryRun),
            plan_ref: planRef,
            module_ref: moduleRef,
            plan_branch: foundPlan.branch ?? null,
            tasks_included: deriveTasks,
            created_specs: createdSpecRefs,
            created_tasks: createdTaskRefs,
            skipped,
            errors: errorsList,
          },
          {
            tasksIncluded: deriveTasks,
          },
        );
      } catch (err) {
        error("Failed to derive plan content", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

/**
 * Register `kspec plan rebuild-index`. Validates that the lean index in
 * `.kspec/project.plans.yaml` agrees with the per-plan folders under
 * `.kspec/plans/<ulid>/`. Exit codes and JSON envelope are defined by
 * @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection and
 * @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders.
 *
 * Flag semantics:
 *   default       — validate, exit 1 on drift, never writes
 *   --dry-run     — same as default, never writes (explicit preview marker)
 *   --repair      — rewrite the lean index from folders
 *   --force       — only with --repair; permits dropping stale entries
 *                   whose folders are missing
 *   --json        — emits a structured envelope (status, summary, changes,
 *                   conflicts) and uses exit codes 0/1/2 per status
 */
function registerPlanRebuildIndexCommand(plan: Command): void {
  markMutating(plan.command("rebuild-index"))
    .description("Rebuild the plan index from .kspec/plans/<ulid>/ folders")
    .option("--repair", "Rewrite .kspec/project.plans.yaml from plan folders")
    .option("--force", "With --repair, drop stale index entries whose folders are missing")
    .option("--dry-run", "Report drift without writing — same as default")
    .addHelpText(
      "after",
      `
Exit codes:
  0  clean or repaired
  1  drift detected without --repair
  2  blocked by conflicts (e.g. stale entry without --force)

Examples:
  $ kspec plan rebuild-index                  # validate, fail if drift
  $ kspec plan rebuild-index --dry-run        # preview drift only
  $ kspec plan rebuild-index --repair         # apply additive drift
  $ kspec plan rebuild-index --repair --force # drop stale index entries`,
    )
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const isDryRun = Boolean(options.dryRun);
        const isRepair = Boolean(options.repair) && !isDryRun;
        const isForce = Boolean(options.force);

        if (isForce && !options.repair) {
          error("--force can only be used with --repair");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        const { computePlanIndexDrift, rebuildPlanIndex, getPlanIndexFilePath } =
          await import("../../parser/plan-storage-manager.js");

        const report = await computePlanIndexDrift(ctx, { force: isForce });
        const driftCount = report.changes.length;
        const conflictCount = report.conflicts.length;

        const baseEnvelope = {
          domain: "plans",
          dry_run: isDryRun,
          repair: isRepair,
          force: isForce,
          summary: {
            folders: report.folders,
            index_entries: report.indexEntries,
            added: report.added,
            updated: report.updated,
            removed_stale: report.removedStale,
            conflicts: conflictCount,
          },
          changes: report.changes.map((c) => ({
            kind: c.kind,
            ref: c.ref,
            path: c.path,
          })),
          conflicts: report.conflicts.map((c) => ({
            code: c.code,
            ref: c.ref,
            path: c.path,
            message: c.message,
          })),
        };

        // Blocked: conflicts that cannot be cleared by the current flag set.
        if (conflictCount > 0) {
          output({ ...baseEnvelope, status: "blocked" }, () => {
            warn(
              `${conflictCount} conflict(s) prevent index rebuild. ` +
                `Use --force with --repair where applicable.`,
            );
            for (const conflict of report.conflicts) {
              const refSuffix = conflict.ref ? ` (ref: ${conflict.ref})` : "";
              console.error(`  ${conflict.code}: ${conflict.message}${refSuffix}`);
            }
          });
          process.exit(2);
        }

        // Clean: no drift at all.
        if (driftCount === 0) {
          output({ ...baseEnvelope, status: "clean" }, () => {
            success(`Plan index is up to date (${report.folders} folder(s))`);
          });
          return;
        }

        // Repair path — write the new index from folders.
        if (isRepair) {
          await rebuildPlanIndex(ctx, { force: isForce });
          await commitIfShadow(
            ctx.shadow,
            "plan-rebuild-index",
            undefined,
            `${report.added} added, ${report.updated} updated, ${report.removedStale} stale dropped`,
          );
          output({ ...baseEnvelope, status: "repaired" }, () => {
            for (const change of report.changes) {
              console.log(`  ${change.kind}  ${change.ref}  (${change.path})`);
            }
            success(
              `Rebuilt plan index from ${report.folders} folder(s): ` +
                `${report.added} added, ${report.updated} updated, ` +
                `${report.removedStale} stale dropped`,
            );
          });
          return;
        }

        // Drift detected but not repairing — print summary and exit 1.
        const indexPath = getPlanIndexFilePath(ctx);
        output({ ...baseEnvelope, status: "drift" }, () => {
          if (isDryRun) {
            warn("DRY RUN — no changes will be written");
          }
          for (const change of report.changes) {
            console.log(`  ${change.kind}  ${change.ref}  (${change.path})`);
          }
          info(
            `${driftCount} drift change(s) found. ` +
              `Re-run with --repair to rewrite ${indexPath}.`,
          );
        });
        process.exit(1);
      } catch (err) {
        error("Failed to rebuild plan index", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
