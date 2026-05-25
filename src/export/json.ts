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
  getResourcesDir,
  initContext,
  loadAllItems,
  loadInboxItems,
  loadMetaContext,
  loadPlans,
  loadResourceManifest,
  loadReviewRecords,
  loadTriageRecords,
  scanTestCoverage,
  STATIC_EXPORT_RESOURCES_PREFIX,
  type LoadedSpecItem,
  type LoadedTask,
  ReferenceIndex,
  validate,
} from "../parser/index.js";
import { computeDisposition } from "../parser/review-operations.js";
import {
  getReviewDir,
  type LoadedReviewRecord,
} from "../parser/review-storage-manager.js";
import { resolveTaskDataManager } from "../parser/task-data-manager.js";
import { loadSessionContext } from "../parser/meta.js";
import { TraitIndex } from "../parser/traits.js";
import {
  countPlanTaskProgress,
  getLinkedPlanSummaryTasks,
  isCountedInPlanSummary,
} from "../lib/plan-summary.js";
import type {
  ExportedItem,
  ExportedReview,
  ExportedReviewResource,
  ExportedTask,
  ExportedValidation,
  ExportStats,
  InheritedAC,
  KspecSnapshot,
} from "./types.js";

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

function expandPlans(plans: Awaited<ReturnType<typeof loadPlans>>, tasks: LoadedTask[]) {
  return plans.map((plan) => {
    const linkedTasks = getLinkedPlanSummaryTasks(plan, tasks);
    const countedTasks = linkedTasks.filter((task) => isCountedInPlanSummary(task));

    return {
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
      content: plan.content,
      module_ref: plan.module_ref ?? null,
      source_path: plan.source_path ?? null,
    };
  });
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
 * AC: @gh-pages-export ac-1, ac-2, ac-3, ac-4, ac-5
 */
export async function generateJsonSnapshot(includeValidation = false): Promise<KspecSnapshot> {
  const ctx = await initContext();

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

  // Expand tasks with resolved spec references
  const exportedTasks = expandTasks(tasks, items, refIndex);

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
    plans: expandPlans(plans, tasks),
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
