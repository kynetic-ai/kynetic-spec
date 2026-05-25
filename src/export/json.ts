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
  initContext,
  loadAllItems,
  loadInboxItems,
  loadMetaContext,
  loadPlans,
  loadTriageRecords,
  scanTestCoverage,
  type LoadedSpecItem,
  type LoadedTask,
  ReferenceIndex,
  validate,
} from "../parser/index.js";
import { resolveTaskDataManager } from "../parser/task-data-manager.js";
import { loadSessionContext } from "../parser/meta.js";
import { TraitIndex } from "../parser/traits.js";
import {
  countPlanTaskProgress,
  getLinkedPlanSummaryTasks,
  isCountedInPlanSummary,
} from "../lib/plan-summary.js";
import {
  copyResourceForStaticExport,
  getResourcesDir,
  loadResourceManifest,
  STATIC_EXPORT_RESOURCES_PREFIX,
} from "../parser/entity-local-resources.js";
import { getPlanDir } from "../parser/plan-storage-manager.js";
import type {
  ExportedItem,
  ExportedPlan,
  ExportedPlanResource,
  ExportedTask,
  ExportedValidation,
  ExportStats,
  InheritedAC,
  KspecSnapshot,
} from "./types.js";

/** Entity-type tag used in the static export resource layout for plans. */
const PLAN_EXPORT_ENTITY_TYPE = "plan";

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
  const byPath = new Map<string, ExportedPlanResource>();
  for (const r of resources) byPath.set(r.path, r);
  const pattern =
    /(!?\[[^\]]*\]\()(\.\/resources\/[^\s)"']+)(\))|(^\s*\[[^\]]+\]:\s+)(\.\/resources\/[^\s"']+)/gm;
  return markdown.replace(pattern, (
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
    const resource = byPath.get(relative);
    if (!resource) return match;
    if (refDefPrefix !== undefined && refDefTarget !== undefined) {
      return `${refDefPrefix}${resource.exported_path}`;
    }
    return `${inlinePrefix ?? ""}${resource.exported_path}${inlineSuffix ?? ""}`;
  });
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
    const exported_path = [STATIC_EXPORT_RESOURCES_PREFIX, PLAN_EXPORT_ENTITY_TYPE, ulid, entry.path]
      .join("/");
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
        // Skip the resource on copy failure rather than aborting the whole
        // export — the rest of the plan data is still useful. The author can
        // re-export after fixing the manifest entry the resolver rejected.
        continue;
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
    plans: await expandPlans(ctx, plans, tasks, assetsOutputDir),
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

  return {
    taskCount: snapshot.tasks.length,
    itemCount: snapshot.items.length,
    inboxCount: snapshot.inbox.length,
    planCount: snapshot.plans?.length ?? 0,
    triageCount: snapshot.triage?.length ?? 0,
    observationCount: snapshot.observations.length,
    agentCount: snapshot.agents.length,
    workflowCount: snapshot.workflows.length,
    conventionCount: snapshot.conventions.length,
    estimatedSizeBytes: Buffer.byteLength(jsonString, "utf-8"),
  };
}

/**
 * Format bytes to human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
