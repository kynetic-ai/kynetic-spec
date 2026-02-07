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
 * Load all plans from the project.
 * AC: @plan-crud ac-7, ac-31 - listing plans
 */
export async function loadPlans(ctx: KspecContext): Promise<LoadedPlan[]> {
  const plansPath = getPlansFilePath(ctx);

  try {
    const raw = await readYamlFile<unknown>(plansPath);

    // Validate and parse plans file
    const parsed = PlansFileSchema.safeParse(raw);
    if (!parsed.success) {
      return [];
    }

    // Add source file metadata to each plan
    return parsed.data.plans.map((plan) => ({
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
    created_at: input.created_at ?? now,
    approved_at: input.approved_at ?? null,
    completed_at: input.completed_at ?? null,
    notes: input.notes ?? [],
  };
}

/**
 * Acquire a simple mkdir-based file lock. Returns a release function.
 * Uses mkdir atomicity on POSIX filesystems to prevent concurrent writes.
 */
async function acquireLock(
  lockPath: string,
  timeoutMs = 5000,
): Promise<() => Promise<void>> {
  const start = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockPath);
      return async () => {
        try {
          await fs.rmdir(lockPath);
        } catch {
          // Lock already released
        }
      };
    } catch {
      if (Date.now() - start > timeoutMs) {
        // Stale lock — force remove and retry once
        try {
          await fs.rmdir(lockPath);
        } catch {
          // ignore
        }
        try {
          await fs.mkdir(lockPath);
          return async () => {
            try {
              await fs.rmdir(lockPath);
            } catch {
              // Lock already released
            }
          };
        } catch {
          throw new Error(`Failed to acquire lock: ${lockPath}`);
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
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
  const lockPath = `${plansPath}.lock`;

  // Ensure directory exists
  const dir = path.dirname(plansPath);
  await fs.mkdir(dir, { recursive: true });

  // Acquire lock for atomic read-modify-write
  const releaseLock = await acquireLock(lockPath);
  try {
    // Load existing plans (inside lock to prevent TOCTOU)
    const plans = await loadPlans(ctx);

    // Strip runtime metadata before saving
    const { _sourceFile, ...cleanPlan } = plan;

    // Update or add
    const existingIndex = plans.findIndex((p) => p._ulid === plan._ulid);
    if (existingIndex >= 0) {
      plans[existingIndex] = cleanPlan as Plan;
    } else {
      plans.push(cleanPlan as Plan);
    }

    // Save back to file
    const plansFile: PlansFile = {
      kynetic_plans: "1.0",
      plans: plans.map(({ _sourceFile, ...p }) => p as Plan),
    };

    await writeYamlFilePreserveFormat(plansPath, plansFile);
  } finally {
    await releaseLock();
  }
}

/**
 * Delete a plan by ULID
 */
export async function deletePlan(
  ctx: KspecContext,
  planUlid: string,
): Promise<boolean> {
  const plansPath = getPlansFilePath(ctx);

  try {
    const plans = await loadPlans(ctx);

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
      plans: plans.map(({ _sourceFile, ...p }) => p as Plan),
    };

    await writeYamlFilePreserveFormat(plansPath, plansFile);
    return true;
  } catch {
    return false;
  }
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
