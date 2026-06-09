/**
 * JSON Export Module
 *
 * Generates JSON snapshots of kspec data for static site hosting.
 * Handles reference resolution, trait expansion, and validation inclusion.
 *
 * AC: @gh-pages-export ac-1, ac-2, ac-3, ac-4, ac-5
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AlignmentIndex,
  buildIndexes,
  computeACCoverage,
  copyResourceForStaticExport,
  findPlanByRef,
  getResourcesDir,
  getTaskDir,
  initContext,
  loadAllItems,
  loadInboxItems,
  loadMetaContext,
  loadPlans,
  loadResourceManifest,
  loadReviewRecords,
  loadTriageRecords,
  projectResolvedTaskResources,
  resolveTaskResources,
  scanTestCoverage,
  STATIC_EXPORT_RESOURCES_PREFIX,
  type LoadedSpecItem,
  type LoadedTask,
  type ResolvedTaskResource,
  ReferenceIndex,
  validate,
} from "../parser/index.js";
import { computeDisposition } from "../parser/review-operations.js";
import { getReviewDir, type LoadedReviewRecord } from "../parser/review-storage-manager.js";
import { resolveTaskDataManager } from "../parser/task-data-manager.js";
import { loadSessionContext } from "../parser/meta.js";
import { TraitIndex } from "../parser/traits.js";
import {
  countPlanTaskProgress,
  getLinkedPlanSummaryTasks,
  isCountedInPlanSummary,
} from "../lib/plan-summary.js";
import { getPlanDir } from "../parser/plan-storage-manager.js";
import type {
  ExportedItem,
  ExportedPlan,
  ExportedPlanResource,
  ExportedReview,
  ExportedReviewResource,
  ExportedTask,
  ExportedTaskResource,
  ExportedValidation,
  ExportStats,
  InheritedAC,
  KspecSnapshot,
} from "./types.js";

/** Entity-type tag used in the static export resource layout for plans. */
const PLAN_EXPORT_ENTITY_TYPE = "plan";

/** Entity-type tag used in the static export resource layout for tasks. */
const TASK_EXPORT_ENTITY_TYPE = "task";

/**
 * Rewrite `./resources/<path>` markdown link/image targets so they point at
 * the exported static-asset location. Shared by plan and task rewriting: the
 * caller supplies a map from each owner-relative `<path>` to its
 * snapshot-relative `exported_path`. Only paths present in the map are
 * rewritten — undeclared (plan) or non-`present` (task) references are left
 * untouched so the rendered static UI surfaces the raw author guidance
 * instead of silently substituting a broken or drifted URL.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 */
function rewriteResourceLinksForStaticExport(
  markdown: string,
  exportedPathByPath: Map<string, string>,
): string {
  if (!markdown || exportedPathByPath.size === 0) return markdown;
  const pattern =
    /(!?\[[^\]]*\]\()(\.\/resources\/[^\s)"']+)(\))|(^\s*\[[^\]]+\]:\s+)(\.\/resources\/[^\s"']+)/gm;
  return markdown.replace(
    pattern,
    (
      match,
      inlinePrefix?: string,
      inlineTarget?: string,
      inlineSuffix?: string,
      refDefPrefix?: string,
      refDefTarget?: string,
    ) => {
      const target = inlineTarget ?? refDefTarget;
      if (!target) return match;
      const relative = target.slice("./resources/".length);
      const exportedPath = exportedPathByPath.get(relative);
      if (exportedPath === undefined) return match;
      if (refDefPrefix !== undefined && refDefTarget !== undefined) {
        return `${refDefPrefix}${exportedPath}`;
      }
      return `${inlinePrefix ?? ""}${exportedPath}${inlineSuffix ?? ""}`;
    },
  );
}

/**
 * Rewrite plan markdown so `./resources/<path>` link/image targets point at
 * the exported file location. Mirrors the daemon-side rewrite contract but
 * uses the static-export path layout (`assets/resources/plan/<ulid>/<path>`).
 *
 * Unresolved references are intentionally left untouched so the rendered
 * static UI surfaces the raw author guidance instead of silently substituting
 * a broken URL.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 */
export function rewritePlanContentForStaticExport(
  markdown: string,
  resources: ExportedPlanResource[],
): string {
  if (!markdown || resources.length === 0) return markdown;
  const byPath = new Map<string, string>();
  for (const r of resources) byPath.set(r.path, r.exported_path);
  return rewriteResourceLinksForStaticExport(markdown, byPath);
}

/**
 * Rewrite task description markdown so `./resources/<path>` link/image targets
 * point at the exported task asset location
 * (`assets/resources/task/<task-ulid>/<path>`). Only `present` task resources
 * (whether plan-owned or materialized task-owned) carry an `exported_path`, so
 * only those references are rewritten. Drifted, missing, and unresolved
 * references are left raw so the static UI surfaces their status and the
 * author's original reference instead of silently serving replacement bytes.
 *
 * AC: @static-export-resource-assets-complete ac-static-task-plan-owned-asset-uses-recorded-hash
 * AC: @static-export-resource-assets-complete ac-static-task-materialized-asset-exists
 * AC: @static-export-resource-assets-complete ac-static-task-drift-is-visible-not-rewritten
 */
export function rewriteTaskContentForStaticExport(
  markdown: string,
  resources: ExportedTaskResource[],
): string {
  if (!markdown || resources.length === 0) return markdown;
  const byPath = new Map<string, string>();
  for (const r of resources) {
    if (r.status === "present" && r.exported_path !== undefined) {
      byPath.set(r.path, r.exported_path);
    }
  }
  return rewriteResourceLinksForStaticExport(markdown, byPath);
}

/**
 * Error thrown by {@link exportPlanResources} when one of a plan's declared
 * resources fails the symlink-safe copy step. The export pipeline surfaces
 * this as an actionable failure so the snapshot never silently omits the
 * resource (which would also leave the markdown's `./resources/<path>` link
 * unresolved). Carries the plan ULID, the failing relative path, and the
 * resolver's actionable error message so the author can fix the offending
 * manifest entry.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export class PlanResourceExportError extends Error {
  readonly planUlid: string;
  readonly resourcePath: string;
  readonly reason: string;

  constructor(planUlid: string, resourcePath: string, reason: string) {
    super(
      `Failed to export plan resource "${resourcePath}" for plan ${planUlid}: ${reason}. ` +
        `Fix the manifest entry or owning resources/ layout (no symlinks, no path traversal) and re-run the export.`,
    );
    this.name = "PlanResourceExportError";
    this.planUlid = planUlid;
    this.resourcePath = resourcePath;
    this.reason = reason;
  }
}

/**
 * Load a plan's resource manifest and project the entries to
 * `ExportedPlanResource`. When `assetsOutputDir` is supplied the resource
 * file bytes are copied under
 * `<assetsOutputDir>/assets/resources/plan/<plan-ulid>/<relative-path>` —
 * symlink-safe via `copyResourceForStaticExport`. The recorded
 * `exported_path` is the POSIX-relative path the static UI uses regardless
 * of whether the bytes were physically copied (the snapshot stays
 * internally consistent for purely-stdout exports too).
 *
 * Copy failures (symlinked resources/ root, intermediate symlink escapes,
 * undeclared paths, missing files) surface as {@link PlanResourceExportError}
 * so the export aborts with actionable guidance instead of producing a
 * snapshot whose `resources` array silently drops the entry while the
 * rewritten markdown still points at the would-be exported path.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 * AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
 */
async function exportPlanResources(
  ctx: Awaited<ReturnType<typeof initContext>>,
  ulid: string,
  assetsOutputDir: string | null,
): Promise<ExportedPlanResource[]> {
  const planDir = getPlanDir(ctx, ulid);
  let manifest;
  try {
    manifest = await loadResourceManifest(planDir);
  } catch {
    return [];
  }
  const ownerResourcesDir = getResourcesDir(planDir);
  const exported: ExportedPlanResource[] = [];
  for (const entry of manifest.resources) {
    const exported_path = [
      STATIC_EXPORT_RESOURCES_PREFIX,
      PLAN_EXPORT_ENTITY_TYPE,
      ulid,
      entry.path,
    ].join("/");
    if (assetsOutputDir) {
      const result = await copyResourceForStaticExport({
        ownerResourcesDir,
        relativePath: entry.path,
        exportRoot: assetsOutputDir,
        entityType: PLAN_EXPORT_ENTITY_TYPE,
        entityUlid: ulid,
        manifest,
      });
      if (!result.ok) {
        throw new PlanResourceExportError(ulid, entry.path, result.error);
      }
    }
    exported.push({
      id: entry.id,
      label: entry.label,
      path: entry.path,
      content_type: entry.content_type,
      bytes: entry.bytes,
      sha256: entry.sha256,
      git_commit: entry.git_commit,
      git_path: entry.git_path,
      description: entry.description,
      exported_path,
    });
  }
  return exported;
}

/**
 * Error thrown by {@link exportTaskResources} when a `present` task resource
 * fails the symlink-safe copy step. Mirrors {@link PlanResourceExportError}:
 * the export aborts with actionable guidance rather than silently shipping a
 * snapshot whose rewritten task markdown points at an asset that was never
 * written. Carries the task ULID, the failing relative path, and the
 * resolver's actionable error message.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export class TaskResourceExportError extends Error {
  readonly taskUlid: string;
  readonly resourcePath: string;
  readonly reason: string;

  constructor(taskUlid: string, resourcePath: string, reason: string) {
    super(
      `Failed to export task resource "${resourcePath}" for task ${taskUlid}: ${reason}. ` +
        `Fix the manifest entry or owning resources/ layout (no symlinks, no path traversal) and re-run the export.`,
    );
    this.name = "TaskResourceExportError";
    this.taskUlid = taskUlid;
    this.resourcePath = resourcePath;
    this.reason = reason;
  }
}

/**
 * Resolve the owning entity's `resources/` directory for a task resource
 * reference so its bytes can be copied into the static asset tree. Plan-owned
 * references resolve through the owning plan's resource tree; task-owned
 * (materialized) references resolve through the task's own resource tree.
 * Returns `null` when the owning entity cannot be located — callers treat
 * that the same as an unresolved reference and do not advertise an asset.
 */
async function resolveTaskResourceOwnerDir(
  ctx: Awaited<ReturnType<typeof initContext>>,
  resolved: ResolvedTaskResource,
  task: LoadedTask,
): Promise<string | null> {
  if (resolved.reference.owner_type === "plan") {
    const plan = await findPlanByRef(ctx, resolved.reference.owner_ref);
    if (!plan) return null;
    return getResourcesDir(getPlanDir(ctx, plan._ulid));
  }
  return getResourcesDir(getTaskDir(ctx, task._ulid));
}

/**
 * Resolve a task's `resource_refs` against the owning entities' current state
 * and project them for the static export. For every reference that resolves to
 * a `present` resource — i.e. the owning manifest still declares the path and
 * its current hash matches the hash recorded on the task at derivation time —
 * the bytes are copied (when `assetsOutputDir` is supplied) into the static
 * asset tree at `assets/resources/task/<task-ulid>/<relative-path>` and the
 * entry gains an `exported_path` pointer.
 *
 * Drifted, missing, and unresolved references keep their status and message
 * but never receive an `exported_path`: the export must not advertise an asset
 * path for bytes that do not match the task's recorded resource hash. The
 * `present` status is the gate that guarantees the copied bytes match the
 * recorded hash, so plan-owned and task-owned copies share the same contract.
 *
 * Copy failures (symlinked resources/ root, intermediate symlink escapes)
 * surface as {@link TaskResourceExportError} so the export aborts with
 * actionable guidance instead of producing a snapshot whose rewritten task
 * markdown points at a never-written asset.
 *
 * AC: @static-export-resource-assets-complete ac-static-task-plan-owned-asset-uses-recorded-hash
 * AC: @static-export-resource-assets-complete ac-static-task-materialized-asset-exists
 * AC: @static-export-resource-assets-complete ac-static-task-drift-is-visible-not-rewritten
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
async function exportTaskResources(
  ctx: Awaited<ReturnType<typeof initContext>>,
  task: LoadedTask,
  assetsOutputDir: string | null,
): Promise<ExportedTaskResource[]> {
  const resolved = await resolveTaskResources(ctx, task);
  if (resolved.length === 0) return [];

  // Project to the canonical daemon shape first so static and live consumers
  // render the same fields; the loop only decides asset copy + exported_path.
  const projected = projectResolvedTaskResources(resolved);

  const out: ExportedTaskResource[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const entry = resolved[i];
    const base = projected[i];

    // Only present references serve the bytes the task was derived against.
    // Drift/missing/unresolved entries are surfaced with status only — no
    // asset path is advertised for bytes that differ from the recorded hash.
    if (entry.status !== "present" || entry.current === null) {
      out.push(base);
      continue;
    }

    const exported_path = [
      STATIC_EXPORT_RESOURCES_PREFIX,
      TASK_EXPORT_ENTITY_TYPE,
      task._ulid,
      entry.reference.path,
    ].join("/");

    if (assetsOutputDir) {
      const ownerResourcesDir = await resolveTaskResourceOwnerDir(ctx, entry, task);
      if (ownerResourcesDir === null) {
        // The owner vanished between resolution and copy; surface as
        // unresolved rather than advertising an asset we cannot produce.
        out.push({
          ...base,
          status: "unresolved",
          message: `Owning ${entry.reference.owner_type} ${entry.reference.owner_ref} could not be located while copying resource "${entry.reference.path}".`,
        });
        continue;
      }
      const result = await copyResourceForStaticExport({
        ownerResourcesDir,
        relativePath: entry.reference.path,
        exportRoot: assetsOutputDir,
        entityType: TASK_EXPORT_ENTITY_TYPE,
        entityUlid: task._ulid,
        // The resolver gates on a single-entry manifest carrying the current
        // declared path; copyResourceForStaticExport only needs the path to
        // appear in the manifest to clear its declared-path check.
        manifest: { resources: [entry.current] },
      });
      if (!result.ok) {
        throw new TaskResourceExportError(task._ulid, entry.reference.path, result.error);
      }
    }

    out.push({ ...base, exported_path });
  }
  return out;
}

/**
 * Get the kspec version from package.json
 */
async function getKspecVersion(): Promise<string> {
  try {
    // Try to find package.json relative to this module
    const packagePath = path.resolve(import.meta.dirname || __dirname, "../../package.json");
    const packageJson = JSON.parse(await fs.readFile(packagePath, "utf-8"));
    return packageJson.version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Resolve spec_ref to its title for display.
 * AC: @gh-pages-export ac-3
 */
function resolveSpecRefTitle(
  specRef: string | null | undefined,
  items: LoadedSpecItem[],
  refIndex: ReferenceIndex,
): string | undefined {
  if (!specRef) return undefined;

  const result = refIndex.resolve(specRef);
  if (!result.ok) return undefined;

  const item = items.find((i) => i._ulid === result.ulid);
  return item?.title;
}

/**
 * Expand tasks with resolved spec reference titles.
 * AC: @gh-pages-export ac-3
 */
function expandTasks(
  tasks: LoadedTask[],
  items: LoadedSpecItem[],
  refIndex: ReferenceIndex,
): ExportedTask[] {
  return tasks.map((task) => {
    const exportedTask: ExportedTask = { ...task };

    if (task.spec_ref) {
      const title = resolveSpecRefTitle(task.spec_ref, items, refIndex);
      if (title) {
        exportedTask.spec_ref_title = title;
      }
    }

    return exportedTask;
  });
}

/**
 * Attach resolved task resources to each exported task and rewrite the task
 * description markdown so `./resources/<path>` references for `present`
 * resources point at the exported asset tree. When `assetsOutputDir` is
 * supplied the resource bytes are copied to disk as a side effect.
 *
 * Tasks without resource references are returned unchanged. Drift/missing/
 * unresolved references are exposed via `resolved_resources` status but never
 * rewritten or advertised, so the static UI surfaces the author's reference
 * and the drift status instead of replacement bytes.
 *
 * AC: @static-export-resource-assets-complete ac-static-task-plan-owned-asset-uses-recorded-hash
 * AC: @static-export-resource-assets-complete ac-static-task-materialized-asset-exists
 * AC: @static-export-resource-assets-complete ac-static-task-drift-is-visible-not-rewritten
 */
async function attachTaskResources(
  ctx: Awaited<ReturnType<typeof initContext>>,
  tasks: ExportedTask[],
  assetsOutputDir: string | null,
): Promise<ExportedTask[]> {
  const out: ExportedTask[] = [];
  for (const task of tasks) {
    if (!task.resource_refs || task.resource_refs.length === 0) {
      out.push(task);
      continue;
    }
    const resolved_resources = await exportTaskResources(ctx, task, assetsOutputDir);
    const description =
      task.description !== undefined
        ? rewriteTaskContentForStaticExport(task.description, resolved_resources)
        : task.description;
    out.push({ ...task, resolved_resources, description });
  }
  return out;
}

/**
 * Get inherited ACs from traits for a spec item.
 * AC: @gh-pages-export ac-4
 */
function getInheritedACs(item: LoadedSpecItem, traitIndex: TraitIndex): InheritedAC[] {
  const inheritedAC = traitIndex.getInheritedAC(item._ulid);

  return inheritedAC.map(({ trait, ac }) => ({
    ...ac,
    _inherited_from: `@${trait.slug}`,
  }));
}

/**
 * Expand items with inherited ACs from traits and test coverage.
 * AC: @gh-pages-export ac-4
 * AC: @web-dashboard ac-15 - Add test coverage for static mode
 */
function expandItems(
  items: LoadedSpecItem[],
  traitIndex: TraitIndex,
  coveredACs: Set<string>,
): ExportedItem[] {
  return items.map((item) => {
    // Compute coverage for acceptance criteria using shared utility
    const acWithCoverage =
      item.acceptance_criteria && item.acceptance_criteria.length > 0
        ? computeACCoverage(item, coveredACs)
        : item.acceptance_criteria;

    const exportedItem: ExportedItem = {
      ...item,
      acceptance_criteria: acWithCoverage,
    };

    // Get inherited ACs from traits
    const inheritedACs = getInheritedACs(item, traitIndex);
    if (inheritedACs.length > 0) {
      exportedItem.inherited_acs = inheritedACs;
    }

    return exportedItem;
  });
}

/**
 * Convert validation result to exported format.
 * AC: @gh-pages-export ac-5
 */
function convertValidationResult(result: Awaited<ReturnType<typeof validate>>): ExportedValidation {
  return {
    valid: result.valid,
    errorCount: result.schemaErrors.length + result.refErrors.length,
    warningCount: result.orphans.length + result.completenessWarnings.length,
    schemaErrors: result.schemaErrors,
    refErrors: result.refErrors,
    refWarnings: result.refWarnings,
    orphans: result.orphans,
    completenessWarnings: result.completenessWarnings,
    traitCycles: result.traitCycleErrors,
    errors: [
      ...result.schemaErrors.map((e) => ({
        file: e.file,
        message: e.message,
        path: e.path,
      })),
      ...result.refErrors.map((e) => ({
        file: e.sourceFile || "unknown",
        message: e.message,
      })),
    ],
    warnings: [
      ...result.orphans.map((o) => ({
        file: "orphan",
        message: `Orphaned ${o.type}: ${o.title}`,
      })),
      ...result.completenessWarnings.map((w) => ({
        file: w.itemRef,
        message: w.message,
      })),
    ],
  };
}

/**
 * Project a single loaded review record onto the bounded {@link ExportedReview}
 * shape. Resource metadata is read from the review's `resources.yaml` and
 * each entry receives the snapshot-relative `exported_path` consumers use
 * to load resource bytes from the static asset tree.
 *
 * The function never reads resource file bytes — only the manifest is
 * consulted. Asset bytes are copied by {@link copyReviewResourceAssets}
 * during the export write phase.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 * AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 */
async function expandReview(
  ctx: Awaited<ReturnType<typeof initContext>>,
  review: LoadedReviewRecord,
): Promise<ExportedReview> {
  const reviewDir = getReviewDir(ctx, review._ulid);
  const manifest = await loadResourceManifest(reviewDir);
  const resources: ExportedReviewResource[] = manifest.resources.map((resource) => ({
    ...resource,
    exported_path: path.posix.join(
      STATIC_EXPORT_RESOURCES_PREFIX,
      "review",
      review._ulid,
      resource.path,
    ),
  }));

  return {
    _ulid: review._ulid,
    slugs: review.slugs,
    title: review.title,
    lifecycle_state: review.lifecycle_state,
    author: review.author,
    subject: review.subject,
    related_refs: review.related_refs,
    external_links: review.external_links,
    created_at: review.created_at,
    updated_at: review.updated_at ?? null,
    examined_commit: review.examined_commit ?? null,
    disposition: computeDisposition(review),
    resources,
  };
}

async function expandReviews(
  ctx: Awaited<ReturnType<typeof initContext>>,
  reviews: LoadedReviewRecord[],
): Promise<ExportedReview[]> {
  const expanded: ExportedReview[] = [];
  for (const review of reviews) {
    expanded.push(await expandReview(ctx, review));
  }
  return expanded;
}

async function expandPlans(
  ctx: Awaited<ReturnType<typeof initContext>>,
  plans: Awaited<ReturnType<typeof loadPlans>>,
  tasks: LoadedTask[],
  assetsOutputDir: string | null,
): Promise<ExportedPlan[]> {
  const out: ExportedPlan[] = [];
  for (const plan of plans) {
    const linkedTasks = getLinkedPlanSummaryTasks(plan, tasks);
    const countedTasks = linkedTasks.filter((task) => isCountedInPlanSummary(task));

    const resources = await exportPlanResources(ctx, plan._ulid, assetsOutputDir);
    const content = rewritePlanContentForStaticExport(plan.content, resources);

    out.push({
      _ulid: plan._ulid,
      slugs: plan.slugs,
      title: plan.title,
      status: plan.status,
      created_at: plan.created_at,
      approved_at: plan.approved_at ?? undefined,
      completed_at: plan.completed_at ?? undefined,
      derived_specs: plan.derived_specs,
      derived_tasks: plan.derived_tasks,
      spec_count: plan.derived_specs.length,
      task_count: countedTasks.length,
      task_progress: countPlanTaskProgress(linkedTasks),
      content,
      resources,
      // Forward-compatible: keep emitting module_ref/source_path so existing
      // consumers continue to see the same fields.
      ...({ module_ref: plan.module_ref ?? null, source_path: plan.source_path ?? null } as Record<
        string,
        unknown
      >),
    } as ExportedPlan);
  }
  return out;
}

function buildAlignmentResponse(
  tasks: LoadedTask[],
  items: LoadedSpecItem[],
  refIndex: ReferenceIndex,
) {
  const alignmentIndex = new AlignmentIndex(tasks, items);
  alignmentIndex.buildLinks(refIndex);

  let specsWithTasks = 0;
  let alignedSpecs = 0;
  let orphanedSpecs = 0;

  for (const item of items) {
    const summary = alignmentIndex.getImplementationSummary(item._ulid);
    if (!summary) continue;
    if (summary.linkedTasks.length > 0) {
      specsWithTasks += 1;
    } else {
      orphanedSpecs += 1;
    }
    if (summary.isAligned) {
      alignedSpecs += 1;
    }
  }

  return {
    stats: {
      totalSpecs: items.length,
      specsWithTasks,
      alignedSpecs,
      orphanedSpecs,
    },
    warnings: alignmentIndex.findAlignmentWarnings(),
  };
}

/**
 * Generate a JSON snapshot of all kspec data.
 *
 * When `assetsOutputDir` is supplied, plan-owned local resource files are
 * copied under `<assetsOutputDir>/assets/resources/plan/<plan-ulid>/<path>`
 * so the static UI can resolve `./resources/<path>` references through the
 * exported asset layout. The snapshot's plan content markdown is rewritten
 * to point at those exported paths whether or not bytes are copied, so the
 * JSON stays internally consistent.
 *
 * AC: @gh-pages-export ac-1, ac-2, ac-3, ac-4, ac-5
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 */
export async function generateJsonSnapshot(
  includeValidation = false,
  options: { assetsOutputDir?: string | null } = {},
): Promise<KspecSnapshot> {
  const ctx = await initContext();
  const assetsOutputDir = options.assetsOutputDir ?? null;

  // Load all data
  const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
  const items = await loadAllItems(ctx);
  const inboxItems = await loadInboxItems(ctx);
  const metaContext = await loadMetaContext(ctx);
  const plans = await loadPlans(ctx);
  // Review export is best-effort — legacy (pre-folder) projects either return
  // empty arrays or surface their compatibility error before this point, but
  // either way an export that crashes the moment a project has no reviews
  // would be a regression for downstream consumers. Wrap defensively.
  let reviews: LoadedReviewRecord[] = [];
  try {
    reviews = await loadReviewRecords(ctx);
  } catch {
    reviews = [];
  }
  const sessionContext = await loadSessionContext(ctx);
  const triageRecords = await loadTriageRecords(ctx);

  // Build indexes
  const { refIndex, traitIndex } = await buildIndexes(ctx);

  // Scan test coverage for AC annotations
  const coveredACs = await scanTestCoverage(
    ctx.rootDir,
    ctx.config.coverage.scan_paths,
    ctx.config.coverage.exclude_patterns,
  );

  // Expand tasks with resolved spec references, then attach resolved task
  // resources (copying present-resource bytes when assetsOutputDir is set and
  // rewriting `./resources/<path>` references in task descriptions).
  const exportedTasks = await attachTaskResources(
    ctx,
    expandTasks(tasks, items, refIndex),
    assetsOutputDir,
  );

  // Expand items with inherited ACs and test coverage
  const exportedItems = expandItems(items, traitIndex, coveredACs);

  // Build the snapshot
  const snapshot: KspecSnapshot = {
    version: await getKspecVersion(),
    exported_at: new Date().toISOString(),
    project: {
      name: ctx.manifest?.project?.name || "Unknown Project",
      version: ctx.manifest?.project?.version,
    },
    tasks: exportedTasks,
    items: exportedItems,
    inbox: inboxItems,
    plans: await expandPlans(ctx, plans, tasks, assetsOutputDir),
    reviews: await expandReviews(ctx, reviews),
    triage: triageRecords,
    session: sessionContext,
    observations: metaContext.observations,
    agents: metaContext.agents,
    workflows: metaContext.workflows,
    conventions: metaContext.conventions,
  };

  // Include validation if requested
  if (includeValidation) {
    const validationResult = await validate(ctx, {
      schema: true,
      refs: true,
      orphans: true,
      completeness: true,
    });
    snapshot.validation = convertValidationResult(validationResult);
    snapshot.alignment = buildAlignmentResponse(tasks, items, refIndex);
  } else {
    snapshot.alignment = buildAlignmentResponse(tasks, items, refIndex);
  }

  return snapshot;
}

/**
 * Calculate export statistics for dry-run.
 * AC: @gh-pages-export ac-7
 */
export function calculateExportStats(snapshot: KspecSnapshot): ExportStats {
  const jsonString = JSON.stringify(snapshot);
  const reviewResourceCount = (snapshot.reviews ?? []).reduce(
    (acc, r) => acc + r.resources.length,
    0,
  );

  return {
    taskCount: snapshot.tasks.length,
    itemCount: snapshot.items.length,
    inboxCount: snapshot.inbox.length,
    planCount: snapshot.plans?.length ?? 0,
    reviewCount: snapshot.reviews?.length ?? 0,
    reviewResourceCount,
    triageCount: snapshot.triage?.length ?? 0,
    observationCount: snapshot.observations.length,
    agentCount: snapshot.agents.length,
    workflowCount: snapshot.workflows.length,
    conventionCount: snapshot.conventions.length,
    estimatedSizeBytes: Buffer.byteLength(jsonString, "utf-8"),
  };
}

/**
 * Copy every declared review resource into the static export's asset tree
 * at the documented `assets/resources/review/<review-ulid>/<relative-path>`
 * layout. The snapshot's per-resource `exported_path` already names this
 * location so consumers do not need to re-derive it.
 *
 * Resource copies go through `copyResourceForStaticExport` (the trait
 * foundation's symlink-safe copier), so a malicious manifest pointing at
 * a symlinked file outside the review's resources/ tree is rejected with
 * the same actionable error the daemon would surface.
 *
 * The helper is a no-op when the snapshot carries no `reviews` array, no
 * reviews, or no resources — callers can safely invoke it for every
 * export without checking upfront.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export async function copyReviewResourceAssets(
  snapshot: KspecSnapshot,
  exportRoot: string,
): Promise<Array<{ review_ulid: string; resource_id: string; exported_path: string }>> {
  if (!snapshot.reviews || snapshot.reviews.length === 0) return [];
  const ctx = await initContext();
  const copied: Array<{ review_ulid: string; resource_id: string; exported_path: string }> = [];
  for (const review of snapshot.reviews) {
    if (review.resources.length === 0) continue;
    const reviewDir = getReviewDir(ctx, review._ulid);
    const ownerResourcesDir = getResourcesDir(reviewDir);
    const manifest = { resources: review.resources.map(({ exported_path: _e, ...r }) => r) };
    for (const resource of review.resources) {
      const result = await copyResourceForStaticExport({
        ownerResourcesDir,
        relativePath: resource.path,
        exportRoot,
        entityType: "review",
        entityUlid: review._ulid,
        manifest,
      });
      if (!result.ok) {
        // Surface a clean error so the export command can decide whether to
        // abort the whole export or skip this one resource — for now we
        // throw so the user sees the failure rather than silently shipping
        // an export with missing files.
        throw new Error(
          `Failed to copy review resource ${resource.id} (${resource.path}) for review ${review._ulid}: ${result.error}`,
        );
      }
      copied.push({
        review_ulid: review._ulid,
        resource_id: resource.id,
        exported_path: result.value.exportedPath,
      });
    }
  }
  return copied;
}

/**
 * Format bytes to human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
