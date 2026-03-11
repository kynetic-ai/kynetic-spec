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
import {
  type Plan,
  type PlanInput,
  PlanSchema,
  type PlansFile,
  PlansFileSchema,
} from "../schema/index.js";
import type { KspecContext } from "./yaml.js";
import {
  getAuthor,
  readYamlFile,
  writeYamlFilePreserveFormat,
} from "./yaml.js";

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
function parsePlansFromRaw(raw: unknown): Plan[] {
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
  return parsePlansFromRaw(raw);
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
 */
export async function loadPlans(ctx: KspecContext): Promise<LoadedPlan[]> {
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
 */
export async function findPlanByRef(
  ctx: KspecContext,
  ref: string,
): Promise<LoadedPlan | undefined> {
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
export function createPlan(input: PlanInput, author?: string): Plan {
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
    created_at: input.created_at ?? now,
    approved_at: input.approved_at ?? null,
    completed_at: input.completed_at ?? null,
    notes: input.notes ?? [],
  };
}

/**
 * Save a single plan (create or update)
 * AC: @plan-crud ac-1, ac-3 - save plan changes
 * Uses file lock to prevent TOCTOU race on concurrent writes.
 */
export async function savePlan(
  ctx: KspecContext,
  plan: LoadedPlan,
): Promise<void> {
  const plansPath = getPlansFilePath(ctx);

  // Lock the file to prevent concurrent read-modify-write races
  await withFileLock(plansPath, async () => {
    // Ensure directory exists
    const dir = path.dirname(plansPath);
    await fs.mkdir(dir, { recursive: true });

    // Load existing plans (inside lock to prevent TOCTOU)
    let plans: Plan[] = [];
    try {
      plans = await loadPlansFromFile(plansPath);
    } catch {
      // File doesn't exist yet, start fresh
    }

    const cleanPlan = stripPlanMetadata(plan);

    // Update or add
    const existingIndex = plans.findIndex((p) => p._ulid === plan._ulid);
    if (existingIndex >= 0) {
      plans[existingIndex] = cleanPlan;
    } else {
      plans.push(cleanPlan);
    }

    // Save back to file
    const plansFile: PlansFile = {
      kynetic_plans: "1.0",
      plans,
    };

    await writeYamlFilePreserveFormat(plansPath, plansFile);
  });
}

/**
 * Atomically mutate a plan using the latest on-disk state.
 *
 * The callback receives the current plan value while holding the plan file lock,
 * so concurrent writers do not clobber unrelated fields (for example status vs notes).
 */
export async function mutatePlanAtomically(
  ctx: KspecContext,
  plan: LoadedPlan,
  mutate: (latestPlan: LoadedPlan) => Plan | LoadedPlan | Promise<Plan | LoadedPlan>,
): Promise<LoadedPlan> {
  const plansPath = plan._sourceFile || getPlansFilePath(ctx);
  let updatedPlan: LoadedPlan | undefined;

  await withFileLock(plansPath, async () => {
    // Ensure directory exists (important for default path in new repos)
    const dir = path.dirname(plansPath);
    await fs.mkdir(dir, { recursive: true });

    let plans: Plan[] = [];
    try {
      plans = await loadPlansFromFile(plansPath);
    } catch {
      throw new Error(`Plans file not found: ${plansPath}`);
    }

    const planIndex = plans.findIndex((candidate) => candidate._ulid === plan._ulid);
    if (planIndex === -1) {
      throw new Error(`Plan not found in file: ${plan._ulid}`);
    }

    const latestPlan: LoadedPlan = {
      ...plans[planIndex],
      _sourceFile: plansPath,
    };

    const mutatedPlan = await mutate(latestPlan);
    const cleanMutatedPlan = stripPlanMetadata(mutatedPlan);
    plans[planIndex] = cleanMutatedPlan;

    const plansFile: PlansFile = {
      kynetic_plans: "1.0",
      plans,
    };
    await writeYamlFilePreserveFormat(plansPath, plansFile);

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
 * Delete a plan by ULID
 */
export async function deletePlan(
  ctx: KspecContext,
  planUlid: string,
): Promise<boolean> {
  const plansPath = getPlansFilePath(ctx);

  // Lock the file to prevent concurrent read-modify-write races
  return withFileLock(plansPath, async () => {
    try {
      const plans = await loadPlansFromFile(plansPath);

      // Find plan to delete
      const index = plans.findIndex((p) => p._ulid === planUlid);
      if (index < 0) {
        return false;
      }

      // Remove plan
      plans.splice(index, 1);

      // Save back
      const plansFile: PlansFile = {
        kynetic_plans: "1.0",
        plans,
      };

      await writeYamlFilePreserveFormat(plansPath, plansFile);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Filter plans by status
 * AC: @plan-crud ac-7 - list with status filter
 */
export function filterPlansByStatus(
  plans: LoadedPlan[],
  status?: string,
): LoadedPlan[] {
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
