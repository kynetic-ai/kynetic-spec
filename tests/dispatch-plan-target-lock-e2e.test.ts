/**
 * End-to-end regression for the manual_merge plan-target lock incident.
 *
 * The incident was the cross-product of: plan-scoped integration target,
 * manual_merge reviewer helper guidance that required a persistent target
 * checkout, dispatch auxiliary worktrees (worker / reviewer) under
 * `.kspec-worktrees`, and the dispatch-root periodic target push/sync.
 * Unit tests around each piece (the helper, the degraded-state map, the
 * mutation-scope resolver) are necessary but not sufficient — the only
 * regression that catches the original combined failure is one that drives
 * the full pipeline against a real plan-scoped task in a temp repo.
 *
 * This test provisions a real plan-scoped task whose integration target
 * branch is distinct from the dispatch root's branch, runs the real
 * `templates/skills/merge/scripts/detached-reviewer-merge.sh` against the
 * canonical reviewer snapshot, then drives the dispatch engine through the
 * full periodic-sync push path. The test exercises three distinct phases
 * that together prove the incident's full surface area:
 *
 *   Phase A (clean lock-free path):
 *     - Helper exits with no aux/helper worktree holding the plan target.
 *     - Periodic-sync push from the dispatch root pushes the post-merge
 *       plan target ref to the remote without entering degraded state.
 *
 *   Phase B (occupied-target refusal):
 *     - A simulated foreign worktree takes ownership of the plan target
 *       branch (the structural failure mode the incident exposed).
 *     - Periodic-sync push detects the occupant via the mutation-scope
 *       resolver, refuses BEFORE moving refs, and records the blocking
 *       worktree path in degraded state with operator-actionable guidance.
 *     - Other active targets remain unaffected (scoped degradation).
 *
 *   Phase C (recovery without restart):
 *     - The blocking worktree is removed (operator recovery action).
 *     - The next periodic-sync push succeeds and clears the degraded
 *       entry for the plan target without requiring a dispatch restart.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import * as workspaceModule from "../src/agent-runtime/workspace.js";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import {
  buildTestSubprocessEnv,
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspecOutput as kspec,
} from "./helpers/cli.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";

ensureSplitBackendRegistered();

const MERGE_HELPER_PATH = path.resolve(
  __dirname,
  "..",
  "templates",
  "skills",
  "merge",
  "scripts",
  "detached-reviewer-merge.sh",
);

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
    env: workspaceModule.buildDispatchGitEnv(),
  }).trim();
}

interface WorktreeListing {
  path: string;
  branch: string | null;
  detached: boolean;
}

function parseWorktreeList(repoDir: string): WorktreeListing[] {
  const output = execSync("git worktree list --porcelain", {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const entries: WorktreeListing[] = [];
  let current: Partial<WorktreeListing> = {};

  const flush = (): void => {
    if (current.path !== undefined) {
      entries.push({
        path: current.path,
        branch: current.branch ?? null,
        detached: current.detached ?? false,
      });
    }
    current = {};
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length), branch: null, detached: false };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return entries;
}

function worktreesOnBranch(repoDir: string, branch: string): string[] {
  const targetRef = `refs/heads/${branch}`;
  return parseWorktreeList(repoDir)
    .filter((entry) => entry.branch === targetRef)
    .map((entry) => entry.path);
}

async function setupProjectWithRemote(): Promise<{
  projectDir: string;
  remoteDir: string;
}> {
  const remoteDir = await createTempDir("kspec-plan-target-lock-remote-");
  git(remoteDir, "init --bare");

  const projectDir = await createTempDir("kspec-plan-target-lock-project-");
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "seed\n", "utf-8");
  git(projectDir, "add README.md");
  git(projectDir, 'commit -m "init"');
  git(projectDir, "checkout -b dev");
  await fs.writeFile(path.join(projectDir, "dev.txt"), "dev\n", "utf-8");
  git(projectDir, "add dev.txt");
  git(projectDir, 'commit -m "dev branch"');
  git(projectDir, `remote add origin "${remoteDir}"`);
  git(projectDir, "push -u origin dev");

  return { projectDir, remoteDir };
}

async function setupProjectFiles(projectDir: string, baseBranch = "dev"): Promise<void> {
  await fs.writeFile(
    path.join(projectDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: Plan Target Lock Regression Project\n',
    "utf-8",
  );
  await fs.writeFile(
    path.join(projectDir, "kynetic.meta.yaml"),
    [
      'kynetic_meta: "1.0"',
      "agents:",
      "  - _ulid: 01AGNT00000000000000000000",
      "    id: test-worker",
      '    name: "Test Worker"',
      "    dispatch:",
      "      - on: task.ready",
      "    concurrency:",
      "      max_concurrent: 1",
      "    adapter: mock-acp",
      "    auto_approve: false",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(projectDir, "kspec.config.yaml"),
    [
      "dispatch:",
      `  base_branch: ${baseBranch}`,
      "  publication_mode: manual_merge",
      "  sync_interval: 60",
      "  remote_sync: true",
      "agent:",
      "  skills:",
      '    task_work: "$kspec-task-work"',
      '    pr_review: "$kspec-review"',
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(path.join(projectDir, "project.tasks.yaml"), "tasks: []\n", "utf-8");
}

async function createTrackedBranchFromDev(
  projectDir: string,
  branch: string,
  fileName: string,
  content: string,
  message: string,
): Promise<string> {
  const previousBranch = git(projectDir, "branch --show-current");
  git(projectDir, `checkout -b ${branch} dev`);
  await fs.writeFile(path.join(projectDir, fileName), content, "utf-8");
  git(projectDir, `add ${fileName}`);
  git(projectDir, `commit -m "${message}"`);
  git(projectDir, `push -u origin ${branch}`);
  if (previousBranch) {
    git(projectDir, `checkout ${previousBranch}`);
  }
  return git(projectDir, `rev-parse ${branch}`);
}

function runMergeHelper(
  cwd: string,
  envOverrides: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  const base = buildTestSubprocessEnv(envOverrides);
  for (const key of Object.keys(base)) {
    if (key.startsWith("KSPEC_DISPATCH_") && !(key in envOverrides)) {
      delete base[key];
    }
  }
  const result = spawnSync("bash", [MERGE_HELPER_PATH], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: base,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

async function cleanupProjectAndWorktrees(dir: string): Promise<void> {
  try {
    const entries = parseWorktreeList(dir);
    for (const entry of entries) {
      if (entry.path !== dir) {
        try {
          execSync(`git worktree remove --force "${entry.path}"`, {
            cwd: dir,
            stdio: "pipe",
            env: workspaceModule.buildDispatchGitEnv(),
          });
        } catch {
          // worktree may already be gone
        }
      }
    }
    execSync("git worktree prune", {
      cwd: dir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });
  } catch {
    // not a git repo or already cleaned up
  }
  await cleanupTempDir(dir);
}

// The dispatch engine and merge helper are internal automation surfaces; the
// trait-error-guidance AC family targets user-facing CLI error formatting,
// which is not what this regression exercises.
// AC: @trait-error-guidance ac-1 — N/A: internal dispatch + merge-helper integration regression, not a user-facing CLI command.
// AC: @trait-error-guidance ac-2 — N/A: internal dispatch + merge-helper integration regression, not a user-facing CLI command.
// AC: @trait-error-guidance ac-3 — N/A: internal dispatch + merge-helper integration regression, not a user-facing CLI command.
// AC: @trait-error-guidance ac-4 — N/A: internal dispatch + merge-helper integration regression, not a user-facing CLI command.
// AC: @trait-error-guidance ac-5 — N/A: internal dispatch + merge-helper integration regression, not a user-facing CLI command.
// AC: @trait-error-guidance ac-6 — N/A: internal dispatch + merge-helper integration regression, not a user-facing CLI command.

describe("dispatch plan-target lock E2E regression (manual_merge)", () => {
  let projectDir: string | undefined;
  let remoteDir: string | undefined;

  beforeEach(async () => {
    // Defensive mock: engine.start() with reconcileIntervalMs=0 does not
    // currently spawn invocations, but if some startup path changes to do so
    // the test must not actually try to run an adapter.
    vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as never,
      outcome: "success",
      durationMs: 1,
      turnCount: 1,
    } as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (projectDir) await cleanupProjectAndWorktrees(projectDir);
    if (remoteDir) await cleanupTempDir(remoteDir);
    projectDir = undefined;
    remoteDir = undefined;
  });

  // AC: @dispatch-integration-mutation-scope ac-auxiliary-worktrees-do-not-hold-target-locks
  // AC: @dispatch-integration-mutation-scope ac-occupied-target-refusal-identifies-blocker
  // AC: @dispatch-remote-branch-sync ac-push-target-periodic
  // AC: @dispatch-remote-branch-sync ac-occupied-checkout-degraded-recovery
  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-target-branch-lock
  it("drives the plan-target merge → periodic push → occupied refusal → recovery cycle without operator restart", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    // Plan-scoped integration target distinct from the configured base
    // branch ("dev"). Seed the branch on both local and origin so the
    // engine's start-time target sync sees a non-divergent state.
    const planTarget = "plan/lock-regression";
    await createTrackedBranchFromDev(
      projectDir,
      planTarget,
      "plan-seed.txt",
      "plan seed\n",
      "seed plan integration target",
    );

    // Plan record + plan-scoped task wired to the plan target branch.
    kspec(
      'plan add --title "Lock Regression Plan" --content "manual_merge plan target lock regression" --slug lock-regression-plan',
      projectDir,
    );
    kspec(`plan set @lock-regression-plan --branch "${planTarget}"`, projectDir);
    const taskTitle = "Plan target lock regression task";
    kspec(
      `task add --title "${taskTitle}" --slug task-plan-target-lock-regression --plan-ref @lock-regression-plan`,
      projectDir,
    );
    kspec("task start @task-plan-target-lock-regression", projectDir);

    // Dispatch root stays on "dev" — the configured base branch and NOT
    // the plan target. This forces the dispatch-root sync/push path to use
    // the no-checkout mutation scope on the plan target (the path that
    // refuses when any auxiliary worktree holds the target lock).
    git(projectDir, "checkout dev");

    // Provision the worker workspace via the real dispatch code path. This
    // creates an actual worker worktree under `.kspec-worktrees/` on the
    // canonical `dispatch/task/.../<id>` branch with the plan target as
    // its recorded integration target, and persists a workspace registry
    // entry the engine will discover on start.
    const workerWorkspace = await workspaceModule.provisionDispatchWorkspace({
      projectDir,
      taskRef: "@task-plan-target-lock-regression",
      taskStatus: "in_progress",
      task: {
        title: taskTitle,
        slugs: ["task-plan-target-lock-regression"],
        plan_ref: "@lock-regression-plan",
      },
    });

    expect(workerWorkspace.metadata.publicationMode).toBe("manual_merge");
    expect(workerWorkspace.metadata.integrationTargetBranch).toBe(planTarget);
    expect(workerWorkspace.metadata.mergeTargetBranch).toBe(planTarget);
    expect(workerWorkspace.cwd.startsWith(path.join(projectDir, ".kspec-worktrees"))).toBe(true);

    // The worker worktree itself must be on the canonical branch, NOT on
    // the plan target. If provisioning ever started reusing the plan
    // target as the worker's checkout, the periodic-sync push would refuse
    // for the same reason the original incident did.
    const workerWorktreeListing = parseWorktreeList(projectDir).find(
      (entry) => entry.path === workerWorkspace.cwd,
    );
    expect(workerWorktreeListing).toBeTruthy();
    expect(workerWorktreeListing?.branch).toBe(
      `refs/heads/${workerWorkspace.metadata.canonicalBranch}`,
    );
    expect(worktreesOnBranch(projectDir, planTarget)).toEqual([]);

    // Worker commits the reviewed change and pushes the canonical branch
    // so dispatch's remote tracking has the branch to manipulate later.
    await fs.writeFile(path.join(workerWorkspace.cwd, "feature.txt"), "feature content\n", "utf-8");
    git(workerWorkspace.cwd, "add feature.txt");
    git(workerWorkspace.cwd, 'commit -m "feat: plan-scoped feature"');
    git(workerWorkspace.cwd, "push -u origin HEAD");
    const canonicalBranch = workerWorkspace.metadata.canonicalBranch;
    const canonicalHead = git(workerWorkspace.cwd, "rev-parse HEAD");

    // Start the dispatch engine. With reconcileIntervalMs=0 the engine
    // performs its startup sync but does not loop. The active target set
    // is rebuilt from the workspace registry, so the plan target must
    // appear alongside the configured base.
    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    // Helper to drive the periodic-sync push path the same way the
    // dispatch engine's reconcile loop does. Keeps the typed cast in one
    // place so each phase reads as a "trigger periodic sync" statement.
    const drivePeriodicSyncPush = (): Promise<void> =>
      (
        engine as never as {
          _pushActiveTargetsAsync: (trigger: string) => Promise<void>;
        }
      )._pushActiveTargetsAsync("periodic-sync");
    let occupantWorktree: string | undefined;
    try {
      await engine.start();

      expect(new Set(engine.getTargetSyncStatus().activeTargets)).toEqual(
        new Set(["dev", planTarget]),
      );

      // Start-time sync must have run the mutation-scope resolver against
      // the plan target without refusing (no aux worktree owns it) and
      // without entering degraded state (local and origin are in sync).
      const startStatus = engine.getTargetSyncStatus();
      expect(startStatus.degraded.active).toBe(false);
      expect(startStatus.degradedTargets).toEqual([]);
      expect(startStatus.targetSyncTimestamps[planTarget]).toBeGreaterThan(0);
      expect(engine.getDegradedState()).toEqual([]);

      // Provision the reviewer's detached worktree at the canonical branch
      // tip. The supported merge helper runs from this snapshot. Because a
      // worker record already exists, this path reuses the existing
      // canonical branch and adds a separate detached worktree under
      // `.kspec-worktrees/`.
      const reviewerWorkspace = await workspaceModule.provisionDispatchWorkspace({
        projectDir,
        taskRef: "@task-plan-target-lock-regression",
        role: "reviewer",
        taskStatus: "pending_review",
        task: {
          title: taskTitle,
          slugs: ["task-plan-target-lock-regression"],
          plan_ref: "@lock-regression-plan",
        },
      });
      const reviewerCwd = reviewerWorkspace.cwd;
      expect(reviewerCwd.startsWith(path.join(projectDir, ".kspec-worktrees"))).toBe(true);
      expect(reviewerCwd).not.toBe(workerWorkspace.cwd);

      // Pre-condition: the plan target branch is not checked out anywhere.
      // Worker worktree is on the canonical branch and the reviewer
      // worktree is detached HEAD. Any auxiliary worktree holding the plan
      // target here would be a setup bug — the incident's root cause was
      // exactly such a hidden checkout.
      expect(worktreesOnBranch(projectDir, planTarget)).toEqual([]);
      const reviewerListing = parseWorktreeList(projectDir).find(
        (entry) => entry.path === reviewerCwd,
      );
      expect(reviewerListing).toBeTruthy();
      expect(reviewerListing?.branch).toBeNull();
      expect(reviewerListing?.detached).toBe(true);

      const planHeadBefore = git(projectDir, `rev-parse refs/heads/${planTarget}`);
      const planRemoteBefore = git(projectDir, `rev-parse refs/remotes/origin/${planTarget}`);
      expect(planRemoteBefore).toBe(planHeadBefore);

      // ───── PHASE A: clean lock-free helper + periodic-sync push ─────
      //
      // Run the REAL detached-reviewer-merge.sh helper against the plan
      // target. This is the supported manual_merge reviewer path; using
      // the real script (not a mock) is what makes this an incident-shape
      // regression rather than helper-internal coverage.
      const helperResult = runMergeHelper(reviewerCwd, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: planTarget,
      });

      expect(
        helperResult.exitCode,
        `helper failed:\nstdout=${helperResult.stdout}\nstderr=${helperResult.stderr}`,
      ).toBe(0);
      expect(helperResult.stdout).toContain("success: merged");
      expect(helperResult.stdout).toContain(canonicalBranch);
      expect(helperResult.stdout).toContain(planTarget);

      // The plan target ref advanced locally and now contains the
      // reviewed change. The remote ref is still at its pre-helper tip —
      // pushing it is dispatch's job, not the helper's.
      const planHeadAfter = git(projectDir, `rev-parse refs/heads/${planTarget}`);
      expect(planHeadAfter).not.toBe(planHeadBefore);
      const featureInPlanTarget = execSync(`git show "refs/heads/${planTarget}:feature.txt"`, {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(featureInPlanTarget).toBe("feature content\n");
      git(projectDir, "fetch origin");
      expect(git(projectDir, `rev-parse refs/remotes/origin/${planTarget}`)).toBe(planHeadBefore);

      // Helper-lock invariant: NO worktree — auxiliary, helper-owned, or
      // otherwise — holds the plan target branch after the helper exits.
      // This is the incident's primary structural invariant and what
      // ac-helper-leaves-no-target-branch-lock /
      // ac-auxiliary-worktrees-do-not-hold-target-locks demand.
      expect(worktreesOnBranch(projectDir, planTarget)).toEqual([]);

      const auxWorktrees = parseWorktreeList(projectDir).filter(
        (entry) => entry.path !== projectDir,
      );
      for (const aux of auxWorktrees) {
        expect(
          aux.branch,
          `auxiliary worktree ${aux.path} unexpectedly holds the plan target lock`,
        ).not.toBe(`refs/heads/${planTarget}`);
      }

      // Dispatch root checkout is still on its base branch — the helper
      // did not move the root's HEAD or check out the plan target there.
      expect(git(projectDir, "branch --show-current")).toBe("dev");

      // Drive the periodic-sync push path. With unpushed commits on the
      // plan target and no occupant, this must push the post-merge ref to
      // origin without entering degraded state.
      // AC: @dispatch-remote-branch-sync ac-push-target-periodic
      await drivePeriodicSyncPush();

      git(projectDir, "fetch origin");
      expect(git(projectDir, `rev-parse refs/remotes/origin/${planTarget}`)).toBe(planHeadAfter);
      expect(engine.getDegradedState()).toEqual([]);
      const phaseAStatus = engine.getTargetSyncStatus();
      expect(phaseAStatus.degraded.active).toBe(false);
      expect(phaseAStatus.degradedTargets).toEqual([]);

      // ───── PHASE B: occupied-target refusal via periodic-sync push ─────
      //
      // Manufacture a foreign worktree that holds the plan target branch.
      // This is the structural failure mode the incident produced — an
      // unexpected checkout of the integration target blocking dispatch
      // sync/push. Placed OUTSIDE .kspec-worktrees to model a foreign
      // operator checkout rather than a dispatch-owned aux worktree, and
      // to keep helper-lock invariants in earlier assertions unambiguous.
      occupantWorktree = `${projectDir}-plan-target-occupant`;
      execSync(`git worktree add "${occupantWorktree}" "${planTarget}"`, {
        cwd: projectDir,
        stdio: "pipe",
        env: workspaceModule.buildDispatchGitEnv(),
      });

      // Advance the plan target locally so the periodic-sync push path
      // does NOT take the no-commits-to-push early return. The occupant
      // owns the checkout, so we publish the new commit via the occupant
      // worktree itself (which is the only place HEAD points at the plan
      // target).
      await fs.writeFile(
        path.join(occupantWorktree, "post-merge-touch.txt"),
        "post-merge change while occupied\n",
        "utf-8",
      );
      git(occupantWorktree, "add post-merge-touch.txt");
      git(occupantWorktree, 'commit -m "chore: advance plan target while occupied"');
      const planHeadOccupied = git(projectDir, `rev-parse refs/heads/${planTarget}`);
      expect(planHeadOccupied).not.toBe(planHeadAfter);
      const planRemoteBeforeRefusal = git(
        projectDir,
        `rev-parse refs/remotes/origin/${planTarget}`,
      );
      expect(planRemoteBeforeRefusal).toBe(planHeadAfter);

      // Drive the periodic-sync push path with the occupant in place.
      // The mutation-scope resolver must refuse before moving any refs,
      // identify the blocking worktree path, and surface operator-
      // actionable recovery guidance via degraded state.
      // AC: @dispatch-integration-mutation-scope ac-occupied-target-refusal-identifies-blocker
      // AC: @dispatch-remote-branch-sync ac-push-target-periodic
      await drivePeriodicSyncPush();

      // Refusal-before-mutation: neither the local ref nor the remote ref
      // moved as a side effect of the refused push.
      expect(git(projectDir, `rev-parse refs/heads/${planTarget}`)).toBe(planHeadOccupied);
      git(projectDir, "fetch origin");
      expect(git(projectDir, `rev-parse refs/remotes/origin/${planTarget}`)).toBe(
        planRemoteBeforeRefusal,
      );

      // Degraded state must identify the blocking worktree path so an
      // operator can resolve the lock without reading dispatch source.
      const degradedDuringRefusal = engine.getDegradedState();
      const planDegraded = degradedDuringRefusal.find((entry) => entry.branch === planTarget);
      expect(
        planDegraded,
        `expected plan target "${planTarget}" to be in degraded state but got: ${JSON.stringify(degradedDuringRefusal)}`,
      ).toBeTruthy();
      expect(planDegraded?.kind).toBe("occupied-checkout");
      expect(planDegraded?.reason).toContain(occupantWorktree);
      expect(planDegraded?.reason).toContain(planTarget);
      // The resolver's suggestion text must call out a concrete operator
      // action ("Check out a different branch in <worktree>") rather than
      // a generic failure message.
      expect(planDegraded?.reason).toMatch(/Check out a different branch/i);

      // Scoped degradation: the configured base branch is not degraded.
      // Other targets must continue normal sync operations even when the
      // plan target is blocked.
      expect(
        degradedDuringRefusal.find((entry) => entry.branch === "dev"),
        "dev must not be degraded by an occupant on the plan target",
      ).toBeUndefined();

      // Status API mirrors the degraded map.
      const refusalStatus = engine.getTargetSyncStatus();
      expect(refusalStatus.degraded.active).toBe(true);
      expect(refusalStatus.degradedTargets.map((d) => d.branch)).toContain(planTarget);
      const refusalDegradedTarget = refusalStatus.degradedTargets.find(
        (d) => d.branch === planTarget,
      );
      expect(refusalDegradedTarget?.kind).toBe("occupied-checkout");
      expect(refusalDegradedTarget?.reason).toContain(occupantWorktree);

      // ───── PHASE C: recovery without operator restart ─────
      //
      // Release the lock — this is the operator action the refusal
      // guidance directs to. The next periodic-sync push must clear the
      // degraded entry AND push the still-unpushed plan target commits.
      // AC: @dispatch-remote-branch-sync ac-occupied-checkout-degraded-recovery
      // AC: @dispatch-remote-branch-sync ac-push-target-periodic
      execSync(`git worktree remove --force "${occupantWorktree}"`, {
        cwd: projectDir,
        stdio: "pipe",
        env: workspaceModule.buildDispatchGitEnv(),
      });
      occupantWorktree = undefined;

      await drivePeriodicSyncPush();

      // Recovery push succeeded: the unpushed local commits made in the
      // occupied-state phase are now on origin.
      git(projectDir, "fetch origin");
      expect(git(projectDir, `rev-parse refs/remotes/origin/${planTarget}`)).toBe(planHeadOccupied);

      // Degraded state cleared without dispatch restart — the incident's
      // operational symptom was the engine staying degraded until restart.
      expect(
        engine.getDegradedState().find((entry) => entry.branch === planTarget),
        `plan target should have recovered but degraded state still contains it: ${JSON.stringify(engine.getDegradedState())}`,
      ).toBeUndefined();
      const recoveryStatus = engine.getTargetSyncStatus();
      expect(recoveryStatus.degraded.active).toBe(false);
      expect(recoveryStatus.degradedTargets).toEqual([]);
      expect(recoveryStatus.targetSyncTimestamps[planTarget]).toBeGreaterThan(0);

      // Dispatch root never moved off its base branch through any phase.
      expect(git(projectDir, "branch --show-current")).toBe("dev");

      // The helper-lock invariant still holds after the full cycle.
      expect(worktreesOnBranch(projectDir, planTarget)).toEqual([]);
    } finally {
      if (occupantWorktree !== undefined) {
        try {
          execSync(`git worktree remove --force "${occupantWorktree}"`, {
            cwd: projectDir,
            stdio: "pipe",
            env: workspaceModule.buildDispatchGitEnv(),
          });
        } catch {
          // Already removed or never created.
        }
      }
      await engine.stop();
    }
  }, 60_000);
});
