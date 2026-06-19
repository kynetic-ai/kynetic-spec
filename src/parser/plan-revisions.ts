import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { PlanRevision } from "../schema/plan.js";
import type { LoadedPlan } from "./plans.js";
import { mutatePlanAtomically } from "./plans.js";
import { getPlanDocumentFilePath } from "./plan-storage-manager.js";
import type { KspecContext } from "./yaml.js";

function requireShadowWorktree(ctx: KspecContext): string {
  if (!ctx.shadow?.enabled) {
    throw new Error("Plan revisions require an enabled shadow branch");
  }
  return ctx.shadow.worktreeDir;
}

export function getCurrentShadowCommit(ctx: KspecContext): string {
  const worktreeDir = requireShadowWorktree(ctx);
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktreeDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export async function appendPlanRevision(
  ctx: KspecContext,
  plan: LoadedPlan,
  input: {
    author: string;
    note: string;
    shadowCommit: string;
    createdAt?: string;
  },
): Promise<LoadedPlan> {
  const note = input.note.trim();
  if (!note) {
    throw new Error("Revision note is required");
  }

  return mutatePlanAtomically(ctx, plan, (latestPlan) => {
    const revisions = [...latestPlan.revisions];
    const nextRevision: PlanRevision = {
      ordinal: revisions.length + 1,
      author: input.author,
      note,
      created_at: input.createdAt ?? new Date().toISOString(),
      shadow_commit: input.shadowCommit,
    };

    return {
      ...latestPlan,
      revisions: [...revisions, nextRevision],
    };
  });
}

export function resolvePlanRevisionContent(
  ctx: KspecContext,
  plan: Pick<LoadedPlan, "_ulid">,
  revision: Pick<PlanRevision, "shadow_commit">,
): string {
  const worktreeDir = requireShadowWorktree(ctx);
  const documentPath = getPlanDocumentFilePath(ctx, plan._ulid);
  const relativePath = path.relative(worktreeDir, documentPath).replace(/\\/g, "/");
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Plan document is outside the shadow worktree: ${documentPath}`);
  }

  return execFileSync("git", ["show", `${revision.shadow_commit}:${relativePath}`], {
    cwd: worktreeDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
