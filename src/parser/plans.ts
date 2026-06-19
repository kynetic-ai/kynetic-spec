/**
 * Plan manifest loading and operations.
 *
 * Plans are durable artifacts that capture implementation context before
 * translating to specs and tasks. They persist in project.plans.yaml.
 *
 * AC: @plan-crud ac-1 - Plans stored in project.plans.yaml
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ulid } from "ulid";
import { withFileLock } from "./file-lock.js";
import { type Plan, type PlanInput, PlanSchema, PlansFileSchema } from "../schema/index.js";
import type { KspecContext } from "./yaml.js";
import { readYamlFile, warnSkippedRecord, writeYamlFilePreserveFormat } from "./yaml.js";
import {
  assertPlanStorageCompatible,
  assertPlanStorageWritable,
} from "./entity-storage-compatibility.js";
import {
  deletePlanFromFolder,
  findPlanByRefInFolders,
  loadPlansFromFolders,
  mutatePlanInFolder,
  savePlanToFolder,
} from "./plan-storage-manager.js";

/**
 * Detect whether the project's manifest declares folder-backed plan
 * storage. The dispatcher routes loadPlans/findPlanByRef/savePlan/
 * mutatePlanAtomically/deletePlan through the folder manager when this
 * returns true, and through the legacy monolithic implementation
 * otherwise. The lenient compatibility gate still fires on either side,
 * so partial/incompatible manifests raise the deterministic error
 * codes rather than dual-reading or silently migrating.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
function usesFolderStorage(ctx: KspecContext): boolean {
  return ctx.manifest?.plan_storage?.format === "folder";
}

/**
 * Loaded plan with runtime metadata
 */
export interface LoadedPlan extends Plan {
  _sourceFile?: string;
}

/**
 * Get the plans file path.
 * AC: @plan-crud ac-1 - stored in project.plans.yaml
 */
export function getPlansFilePath(ctx: KspecContext): string {
  return path.join(ctx.specDir, "project.plans.yaml");
}

/**
 * Parse plans from raw YAML payload.
 *
 * Supports the canonical { kynetic_plans, plans } shape and a fallback
 * { plans } shape for older files without version metadata.
 */
function parsePlansFromRaw(raw: unknown, source = "project.plans.yaml"): Plan[] {
  const parsed = PlansFileSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data.plans;
  }

  if (raw && typeof raw === "object" && "plans" in raw) {
    const fallbackPlans = (raw as { plans?: unknown }).plans;
    if (Array.isArray(fallbackPlans)) {
      const plans: Plan[] = [];
      for (const plan of fallbackPlans) {
        const planResult = PlanSchema.safeParse(plan);
        if (planResult.success) {
          plans.push(planResult.data);
        } else {
          const rawPlan = plan as Record<string, unknown> | null;
          const planId =
            rawPlan && typeof rawPlan._ulid === "string" ? rawPlan._ulid : "<unknown-plan>";
          warnSkippedRecord("plan", planId, source, planResult.error);
        }
      }
      return plans;
    }
  }

  return [];
}

/**
 * Load plans from an explicit file path.
 */
async function loadPlansFromFile(plansPath: string): Promise<Plan[]> {
  const raw = await readYamlFile<unknown>(plansPath);
  return parsePlansFromRaw(raw, plansPath);
}

/**
 * Extract the raw plan array and format info from a YAML file.
 * Does NOT run schema validation — preserves original data for round-trip stability.
 */
async function extractRawPlanArray(
  filePath: string,
): Promise<{ rawPlans: unknown[]; wrapperObj?: Record<string, unknown> }> {
  let existingRaw: unknown = null;

  try {
    existingRaw = await readYamlFile<unknown>(filePath);
  } catch {
    // File doesn't exist
    return { rawPlans: [] };
  }

  if (!existingRaw || typeof existingRaw !== "object") {
    return { rawPlans: [] };
  }

  if ("plans" in existingRaw) {
    const wrapper = existingRaw as Record<string, unknown>;
    const plans = wrapper.plans;
    return {
      rawPlans: Array.isArray(plans) ? plans : [],
      wrapperObj: wrapper,
    };
  }

  return { rawPlans: [] };
}

/**
 * Write raw plan array back to file, preserving the wrapper format.
 */
async function writeRawPlanArray(
  filePath: string,
  rawPlans: unknown[],
  wrapperObj?: Record<string, unknown>,
): Promise<void> {
  // Plans always use wrapper format { kynetic_plans, plans }
  const output = wrapperObj
    ? { ...wrapperObj, plans: rawPlans }
    : { kynetic_plans: "1.0", plans: rawPlans };
  await writeYamlFilePreserveFormat(filePath, output);
}

/**
 * Find plan index in a raw array by ULID match.
 */
function findRawPlanIndex(rawPlans: unknown[], planUlid: string): number {
  return rawPlans.findIndex(
    (p) => p && typeof p === "object" && (p as Record<string, unknown>)._ulid === planUlid,
  );
}

/**
 * Merge a schema-normalized plan onto the original raw plan data.
 * Only adds fields that were in the original raw data or that contain
 * non-default values. This prevents Zod defaults from polluting YAML
 * output with fields that weren't originally present.
 *
 * Fields present in rawPlan are always updated with the new value.
 * Fields NOT in rawPlan are only added if they carry meaningful data
 * (i.e. non-empty arrays, non-null values, etc.).
 */
function mergePlanPreservingRawShape(
  rawPlan: Record<string, unknown>,
  normalizedPlan: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(normalizedPlan)) {
    if (key === "branch" && (value === null || value === undefined)) {
      continue;
    }

    if (key in rawPlan) {
      // Field existed in raw — always include (even if value changed)
      result[key] = value;
    } else {
      // Field was added by schema normalization — only include if non-trivial
      const isEmptyArray = Array.isArray(value) && value.length === 0;
      const isNull = value === null || value === undefined;
      if (!isEmptyArray && !isNull) {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Strip runtime metadata before serialization.
 */
function stripPlanMetadata(plan: Plan | LoadedPlan): Plan {
  const { _sourceFile, ...cleanPlan } = plan as LoadedPlan;
  return cleanPlan as Plan;
}

/**
 * Load all plans from the project.
 * AC: @plan-crud ac-7, ac-31 - listing plans
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
export async function loadPlans(ctx: KspecContext): Promise<LoadedPlan[]> {
  if (usesFolderStorage(ctx)) {
    return loadPlansFromFolders(ctx);
  }
  await assertPlanStorageCompatible(ctx);
  const { getEntityCacheContext } = await import("./yaml.js");
  const cacheContext = getEntityCacheContext();
  if (cacheContext) {
    const cache = cacheContext.cacheAccessor(cacheContext.projectPath) as
      | {
          getDomainState?(domain: string): string | null | undefined;
          getPlansIndex?(): Array<{ _ulid: string }> | null;
          getPlanDetail?(ulid: string): LoadedPlan | null;
        }
      | null
      | undefined;
    if (cache?.getDomainState?.("plans") === "ready") {
      const planIndex = cache.getPlansIndex?.();
      if (planIndex) {
        const cachedPlans = planIndex
          .map((plan) => cache.getPlanDetail?.(plan._ulid) ?? null)
          .filter((plan): plan is LoadedPlan => plan !== null);
        if (cachedPlans.length === planIndex.length) {
          return cachedPlans;
        }
      }
    }
  }

  const plansPath = getPlansFilePath(ctx);

  try {
    const plans = await loadPlansFromFile(plansPath);
    return plans.map((plan) => ({
      ...plan,
      _sourceFile: plansPath,
    }));
  } catch {
    // File doesn't exist or parse error
    return [];
  }
}

/**
 * Find a plan by reference (ULID, short ULID, or slug)
 * AC: @plan-crud ac-8 - get plan by reference
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 */
export async function findPlanByRef(
  ctx: KspecContext,
  ref: string,
): Promise<LoadedPlan | undefined> {
  if (usesFolderStorage(ctx)) {
    return findPlanByRefInFolders(ctx, ref);
  }
  const plans = await loadPlans(ctx);
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;

  return plans.find(
    (p) =>
      // Match full ULID
      p._ulid === cleanRef ||
      // Match short ULID (prefix)
      p._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
      // Match any slug
      p.slugs.includes(cleanRef),
  );
}

/**
 * Create a new plan from input
 * AC: @plan-crud ac-1, ac-2 - creating plans
 */
export function createPlan(input: PlanInput, _author?: string): Plan {
  const now = new Date().toISOString();

  return {
    _ulid: input._ulid ?? ulid(),
    slugs: input.slugs ?? [],
    title: input.title,
    content: input.content ?? "",
    status: input.status ?? "draft",
    derived_tasks: input.derived_tasks ?? [],
    derived_specs: input.derived_specs ?? [],
    source_path: input.source_path ?? null,
    module_ref: input.module_ref ?? null,
    branch: input.branch ?? null,
    created_at: input.created_at ?? now,
    approved_at: input.approved_at ?? null,
    completed_at: input.completed_at ?? null,
    notes: input.notes ?? [],
    revisions: input.revisions ?? [],
  };
}

/**
 * Save a single plan (create or update)
 * AC: @plan-crud ac-1, ac-3 - save plan changes
 * Uses file lock to prevent TOCTOU race on concurrent writes.
 *
 * Non-target plans are preserved as raw data (no schema parsing) to ensure
 * round-trip stability — fields not present in the original YAML won't be
 * added by Zod defaults.
 */
export async function savePlan(ctx: KspecContext, plan: LoadedPlan): Promise<void> {
  if (usesFolderStorage(ctx)) {
    return savePlanToFolder(ctx, plan);
  }
  await assertPlanStorageWritable(ctx);
  const plansPath = getPlansFilePath(ctx);

  // Lock the file to prevent concurrent read-modify-write races
  await withFileLock(plansPath, async () => {
    // Ensure directory exists
    const dir = path.dirname(plansPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw plan data without schema normalization
    const { rawPlans, wrapperObj } = await extractRawPlanArray(plansPath);

    // Strip runtime metadata before saving
    const cleanPlan = stripPlanMetadata(plan);

    // Update existing or add new — replace only the target plan
    const existingIndex = findRawPlanIndex(rawPlans, plan._ulid);
    if (existingIndex >= 0) {
      // Merge onto raw data to avoid adding Zod defaults for absent fields
      const rawTarget = rawPlans[existingIndex] as Record<string, unknown>;
      rawPlans[existingIndex] = mergePlanPreservingRawShape(
        rawTarget,
        cleanPlan as Record<string, unknown>,
      );
    } else {
      rawPlans.push(cleanPlan);
    }

    await writeRawPlanArray(plansPath, rawPlans, wrapperObj);
  });
}

/**
 * Atomically mutate a plan using the latest on-disk state.
 *
 * The callback receives the current plan value while holding the plan file lock,
 * so concurrent writers do not clobber unrelated fields (for example status vs notes).
 *
 * Non-target plans are preserved as raw data (no schema parsing) to ensure
 * round-trip stability.
 */
export async function mutatePlanAtomically(
  ctx: KspecContext,
  plan: LoadedPlan,
  mutate: (latestPlan: LoadedPlan) => Plan | LoadedPlan | Promise<Plan | LoadedPlan>,
): Promise<LoadedPlan> {
  if (usesFolderStorage(ctx)) {
    return mutatePlanInFolder(ctx, plan, mutate);
  }
  // Mutate-only operations update an existing plan in place and require
  // that plan to already exist in the monolithic file; they cannot
  // introduce a partial folder layout the way `savePlan` (create-or-update)
  // or `deletePlan` (orphan-folder maker) can. The compatibility gate
  // (lenient manifest + partial-layout detector) is sufficient — applying
  // the broader writable gate would block valid updates under a consistent
  // folder-backed layout. The strict monolithic-write rule still applies
  // to save/delete.
  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  await assertPlanStorageCompatible(ctx);
  const plansPath = plan._sourceFile || getPlansFilePath(ctx);
  let updatedPlan: LoadedPlan | undefined;

  await withFileLock(plansPath, async () => {
    // Ensure directory exists (important for default path in new repos)
    const dir = path.dirname(plansPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw plan data without schema normalization for non-target plans
    const { rawPlans, wrapperObj } = await extractRawPlanArray(plansPath);

    const planIndex = findRawPlanIndex(rawPlans, plan._ulid);
    if (planIndex === -1) {
      throw new Error(`Plan not found in file: ${plan._ulid}`);
    }

    // Schema-parse only the target plan for the mutation callback
    const rawTarget = rawPlans[planIndex];
    const parsed = PlanSchema.safeParse(rawTarget);
    if (!parsed.success) {
      throw new Error(`Invalid plan data for ${plan._ulid}: ${parsed.error.message}`);
    }
    const latestPlan: LoadedPlan = { ...parsed.data, _sourceFile: plansPath };

    const mutatedPlan = await mutate(latestPlan);
    const cleanMutatedPlan = stripPlanMetadata(mutatedPlan);

    // Merge onto raw data to avoid adding Zod defaults for absent fields
    rawPlans[planIndex] = mergePlanPreservingRawShape(
      rawTarget as Record<string, unknown>,
      cleanMutatedPlan as Record<string, unknown>,
    );

    await writeRawPlanArray(plansPath, rawPlans, wrapperObj);

    updatedPlan = {
      ...cleanMutatedPlan,
      _sourceFile: plansPath,
    };
  });

  if (!updatedPlan) {
    throw new Error(`Failed to mutate plan atomically: ${plan._ulid}`);
  }

  return updatedPlan;
}

/**
 * Delete a plan by ULID.
 *
 * Non-target plans are preserved as raw data (no schema parsing) to ensure
 * round-trip stability.
 *
 * Throws if the plan is not found (ENOENT-style) or on I/O failure,
 * matching the contract of savePlan and mutatePlanAtomically.
 *
 * AC: @plan-crud ac-40
 */
export async function deletePlan(ctx: KspecContext, planUlid: string): Promise<void> {
  if (usesFolderStorage(ctx)) {
    return deletePlanFromFolder(ctx, planUlid);
  }
  await assertPlanStorageWritable(ctx);
  const plansPath = getPlansFilePath(ctx);

  // Lock the file to prevent concurrent read-modify-write races
  await withFileLock(plansPath, async () => {
    // Load raw plan data without schema normalization
    const { rawPlans, wrapperObj } = await extractRawPlanArray(plansPath);

    // Find plan to delete by ULID match on raw data
    const index = findRawPlanIndex(rawPlans, planUlid);
    if (index < 0) {
      const err = new Error(`Plan not found: ${planUlid}`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    }

    // Remove plan
    rawPlans.splice(index, 1);

    await writeRawPlanArray(plansPath, rawPlans, wrapperObj);
  });
}

/**
 * Filter plans by status
 * AC: @plan-crud ac-7 - list with status filter
 */
export function filterPlansByStatus(plans: LoadedPlan[], status?: string): LoadedPlan[] {
  if (!status) return plans;
  return plans.filter((p) => p.status === status);
}

/**
 * Get plan statistics
 */
export function getPlanStats(plans: LoadedPlan[]): {
  total: number;
  byStatus: Record<string, number>;
} {
  const byStatus: Record<string, number> = {};

  for (const plan of plans) {
    byStatus[plan.status] = (byStatus[plan.status] ?? 0) + 1;
  }

  return {
    total: plans.length,
    byStatus,
  };
}
