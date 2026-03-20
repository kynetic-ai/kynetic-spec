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
import type { AcceptanceCriterion, InboxItem } from "../schema/index.js";
import {
  AlignmentIndex,
  buildIndexes,
  computeACCoverage,
  initContext,
  loadAllItems,
  loadAllTasks,
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
import { loadSessionContext } from "../parser/meta.js";
import { TraitIndex } from "../parser/traits.js";
import {
  countPlanTaskProgress,
  getLinkedPlanSummaryTasks,
  isCountedInPlanSummary,
} from "../lib/plan-summary.js";
import type {
  ExportedItem,
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
    const packagePath = path.resolve(
      import.meta.dirname || __dirname,
      "../../package.json"
    );
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
  refIndex: ReferenceIndex
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
  refIndex: ReferenceIndex
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
function getInheritedACs(
  item: LoadedSpecItem,
  traitIndex: TraitIndex
): InheritedAC[] {
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
  coveredACs: Set<string>
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
function convertValidationResult(
  result: Awaited<ReturnType<typeof validate>>
): ExportedValidation {
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

function expandPlans(
  plans: Awaited<ReturnType<typeof loadPlans>>,
  tasks: LoadedTask[]
) {
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

function buildAlignmentResponse(tasks: LoadedTask[], items: LoadedSpecItem[], refIndex: ReferenceIndex) {
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
export async function generateJsonSnapshot(
  includeValidation = false
): Promise<KspecSnapshot> {
  const ctx = await initContext();

  // Load all data
  const tasks = await loadAllTasks(ctx);
  const items = await loadAllItems(ctx);
  const inboxItems = await loadInboxItems(ctx);
  const metaContext = await loadMetaContext(ctx);
  const plans = await loadPlans(ctx);
  const sessionContext = await loadSessionContext(ctx);
  const triageRecords = await loadTriageRecords(ctx);

  // Build indexes
  const { refIndex, traitIndex } = await buildIndexes(ctx);

  // Scan test coverage for AC annotations
  const coveredACs = await scanTestCoverage(ctx.rootDir);

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
