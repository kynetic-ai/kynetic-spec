/**
 * Plan revision-one backfill.
 *
 * Adds revision 1 to pre-existing plans that have no revision history. The
 * revision points at the current shadow HEAD, which designates the plan body
 * as it exists when the upgrade runs.
 *
 * Spec: @plan-revisions
 */

import { runWithBuffer } from "../cli/batch-write-buffer.js";
import { buildIdentityConfigFromContext } from "../identity/actor-write-context.js";
import { resolveActorForWrite } from "../identity/actor-write.js";
import { KSPEC_UPGRADE_ACTOR } from "../identity/system-actors.js";
import type { LoadedPlan } from "./plans.js";
import { loadPlans, mutatePlanAtomically } from "./plans.js";
import { getCurrentShadowCommit } from "./plan-revisions.js";
import type { KspecContext } from "./yaml.js";

export const PLAN_REVISION_BACKFILL_STEP_NAME = "Plan revision backfill";
export const PLAN_REVISION_BACKFILL_NOTE = "Backfilled revision 1 during kspec upgrade";

export interface PlanRevisionBackfillEntry {
  readonly ulid: string;
  readonly title: string;
  readonly revisionCount: number;
}

export interface PlanRevisionBackfillReport {
  readonly dryRun: boolean;
  readonly generatedAt: string;
  readonly shadowCommit: string;
  readonly plansScanned: number;
  readonly backfillCount: number;
  readonly skippedWithRevisions: number;
  readonly entries: PlanRevisionBackfillEntry[];
}

export interface PlanRevisionBackfillApplyResult {
  readonly backfilled: number;
  readonly author: string;
  readonly generatedAt: string;
  readonly shadowCommit: string;
}

function revisionCount(plan: LoadedPlan): number {
  return Array.isArray(plan.revisions) ? plan.revisions.length : 0;
}

async function resolveBackfillAuthor(ctx: KspecContext): Promise<string> {
  const identity = await buildIdentityConfigFromContext(ctx);
  const result = resolveActorForWrite({
    explicit: KSPEC_UPGRADE_ACTOR.canonicalId,
    identity: {
      ...identity,
      agents: [
        ...identity.agents.filter((agent) => agent.canonicalId !== KSPEC_UPGRADE_ACTOR.canonicalId),
        KSPEC_UPGRADE_ACTOR,
      ],
    },
    configAuthor: ctx.config?.identity?.author,
    field: "author",
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.actor;
}

export async function computePlanRevisionBackfillReport(
  ctx: KspecContext,
  options: { dryRun?: boolean; generatedAt?: string; shadowCommit?: string } = {},
): Promise<PlanRevisionBackfillReport> {
  const plans = await loadPlans(ctx);
  const entries = plans
    .filter((plan) => revisionCount(plan) === 0)
    .map((plan) => ({
      ulid: plan._ulid,
      title: plan.title,
      revisionCount: 0,
    }));

  return {
    dryRun: options.dryRun ?? false,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    shadowCommit: options.shadowCommit ?? getCurrentShadowCommit(ctx),
    plansScanned: plans.length,
    backfillCount: entries.length,
    skippedWithRevisions: plans.length - entries.length,
    entries,
  };
}

export async function applyPlanRevisionBackfill(
  ctx: KspecContext,
  report: PlanRevisionBackfillReport,
): Promise<PlanRevisionBackfillApplyResult> {
  if (report.backfillCount === 0) {
    return {
      backfilled: 0,
      author: KSPEC_UPGRADE_ACTOR.canonicalId,
      generatedAt: report.generatedAt,
      shadowCommit: report.shadowCommit,
    };
  }

  const author = await resolveBackfillAuthor(ctx);
  let backfilled = 0;

  await runWithBuffer(ctx.specDir, async () => {
    const plans = await loadPlans(ctx);
    for (const plan of plans) {
      if (revisionCount(plan) > 0) continue;
      await mutatePlanAtomically(ctx, plan, (latestPlan) => {
        if (revisionCount(latestPlan) > 0) {
          return latestPlan;
        }
        backfilled += 1;
        return {
          ...latestPlan,
          revisions: [
            {
              ordinal: 1,
              author,
              note: PLAN_REVISION_BACKFILL_NOTE,
              created_at: report.generatedAt,
              shadow_commit: report.shadowCommit,
            },
          ],
        };
      });
    }
  });

  return {
    backfilled,
    author,
    generatedAt: report.generatedAt,
    shadowCommit: report.shadowCommit,
  };
}
