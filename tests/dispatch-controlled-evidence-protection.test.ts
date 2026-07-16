import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDispatchArtifactProtectionState,
  provisionDispatchWorkspace,
  reapDispatchWorkspace,
  reconcileDispatchWorkspaceArtifacts,
  reconcileDispatchWorkspaceLifecycle,
  reconcileDispatchWorkspaceRegistry,
} from "../src/agent-runtime/workspace.js";
import {
  getOrCreateDispatchControlStore,
  unregisterDispatchControlStore,
} from "../src/agent-runtime/dispatch-control-store.js";
import { initContext } from "../src/parser/index.js";
import { loadDispatchWorkspaceRegistry } from "../src/parser/dispatch-workspaces.js";
import { createSession, getSession } from "../src/sessions/store.js";
import type { DispatchWorkspaceRecord } from "../src/schema/index.js";
import { cleanupTempDir, createTempDir, initGitRepo, kspec, testUlid } from "./helpers/cli.js";

const WORKTREE_ROOT = "/tmp/kspec-controlled-evidence-protection";
const TASK_ID = "01KRF37Y941E2T8D1ATFV63JB0";
const TASK_REF = `@${TASK_ID}`;
const TASK_SLUG = "task-controlled-evidence";

function closingRecord(taskId = TASK_ID): DispatchWorkspaceRecord {
  const taskRef = `@${taskId}`;
  const taskSlug = taskId === TASK_ID ? TASK_SLUG : "task-unrelated-terminal";
  const shortId = taskId.slice(0, 8).toLowerCase();
  const workerPath = path.join(WORKTREE_ROOT, `${taskSlug}-${shortId}`);
  return {
    workspace_id: `dispatch-workspace-${taskId}`,
    task_id: taskId,
    task_ref: taskRef,
    task_slug: taskSlug,
    worktree_root: WORKTREE_ROOT,
    resolved_base_branch: "dev",
    base_branch_point: "0".repeat(40),
    canonical_branch: `dispatch/task/${taskSlug}/${shortId}`,
    canonical_branch_head: "1".repeat(40),
    branch_provenance: {
      ownership: "dispatcher-managed",
      source: "provisioned",
      remote_ref: null,
      adopted_from: null,
      adopted_at: null,
      rehydrated: null,
    },
    lifecycle_state: "closing",
    active_role: null,
    worktrees: {
      worker: {
        path: workerPath,
        branch_mode: "branch",
        branch_ref: `dispatch/task/${taskSlug}/${shortId}`,
        head: "1".repeat(40),
        last_seen_at: "2026-07-15T00:00:00.000Z",
      },
      reviewer: {
        path: `${workerPath}-review`,
        branch_mode: "detached",
        branch_ref: null,
        head: "1".repeat(40),
        last_seen_at: "2026-07-15T00:00:00.000Z",
      },
    },
    bootstrap: {
      lastRole: null,
      roleStates: {
        worker: {
          status: "not_run",
          configHash: null,
          canonicalBranchHead: null,
          lastRunAt: null,
          invalidationReasons: [],
          steps: [],
          failureMessage: null,
        },
        reviewer: {
          status: "not_run",
          configHash: null,
          canonicalBranchHead: null,
          lastRunAt: null,
          invalidationReasons: [],
          steps: [],
          failureMessage: null,
        },
      },
    },
    integration: {
      status: "merged",
      target_branch: "dev",
      target_commit: "0".repeat(40),
      publication_mode: "manual_merge",
      outcome: "merged",
      detail: null,
      updated_at: "2026-07-15T00:00:00.000Z",
    },
    health: {
      status: "healthy",
      summary: "ok",
      issues: [],
      updated_at: "2026-07-15T00:00:00.000Z",
    },
    cleanup: {
      status: "scheduled",
      eligible: true,
      reason: "task completed",
      detail: null,
      updated_at: "2026-07-15T00:00:00.000Z",
    },
    timestamps: {
      created_at: "2026-07-15T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
      last_reconciled_at: null,
      last_active_at: null,
      closed_at: null,
    },
  };
}

describe("controlled dispatch evidence protection", () => {
  // AC: @dispatch-workspace-cleanup-policy ac-controlled-evidence-protected
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it.each([
    ["active", { activeOrInFlightTaskRefs: [TASK_REF] }],
    ["final-gate in-flight", { finalGateInFlightTaskRefs: [TASK_REF] }],
    ["paused-held", { pausedHeldTaskRefs: [TASK_REF] }],
    ["stopped pending cleanup", { stoppedPendingCleanupTaskRefs: [TASK_REF] }],
  ] as const)("preserves %s evidence across every destructive surface", (_state, evidence) => {
    const record = closingRecord();
    const protection = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      ...evidence,
      registry: { status: "loaded", records: [record] },
    });

    expect(protection.evaluateTaskRef(TASK_REF).preserve).toBe(true);
    expect(protection.evaluateClosingRecordForReap(record).preserve).toBe(true);
    expect(protection.evaluateDispatchBranch(record.canonical_branch).preserve).toBe(true);
    expect(protection.evaluateWorkspacePath(record.worktrees.worker.path).preserve).toBe(true);
    expect(protection.evaluateWorkspacePath(record.worktrees.reviewer!.path).preserve).toBe(true);
    expect(protection.evaluateWorkspacePath(WORKTREE_ROOT).preserve).toBe(true);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-controlled-evidence-protected
  it("does not treat lifecycle control as cleanup eligibility for unrelated evidence", () => {
    const controlled = closingRecord();
    const unrelated = closingRecord("01KRF37Y941E2T8D1ATFV63JB9");
    const protection = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      pausedHeldTaskRefs: [TASK_REF],
      registry: { status: "loaded", records: [controlled, unrelated] },
    });

    expect(protection.evaluateClosingRecordForReap(controlled).preserve).toBe(true);
    expect(protection.evaluateClosingRecordForReap(unrelated).preserve).toBe(false);
  });
});

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
}

async function seedDispatchProject(projectDir: string): Promise<void> {
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "seed\n", "utf-8");
  git(projectDir, "add README.md");
  git(projectDir, 'commit -m "init"');
  const initialized = kspec("init --no-prompt", projectDir, { env: { KSPEC_AUTHOR: "@test" } });
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
  git(projectDir, "checkout -b agent-dev");
}

async function controlTask(
  projectDir: string,
  taskId: string,
  state: "paused" | "pending_cleanup",
): Promise<void> {
  const store = getOrCreateDispatchControlStore(projectDir);
  await store.loadCommitted();
  const now = "2026-07-15T00:00:00.000Z";
  await store.mutate(`test-${state}`, (snapshot) => ({
    ...snapshot,
    revision: snapshot.revision + 1,
    tasks: {
      ...snapshot.tasks,
      [taskId]: {
        mode: state === "paused" ? "paused" : "stopped",
        reason: "test controlled evidence",
        actor: "test",
        source: "recovery",
        controlled_at: now,
        updated_at: now,
      },
    },
    pending_cleanup:
      state === "pending_cleanup"
        ? {
            ...snapshot.pending_cleanup,
            [taskId]: {
              cleanup_id: testUlid("CLEN", 1),
              status: "pending",
              phase: "owned",
              targets: [],
            },
          }
        : snapshot.pending_cleanup,
  }));
}

describe("controlled evidence physical cleanup", () => {
  const projectDirs: string[] = [];

  afterEach(async () => {
    for (const projectDir of projectDirs.splice(0)) {
      unregisterDispatchControlStore(projectDir);
      await cleanupTempDir(projectDir);
    }
  });

  // AC: @dispatch-workspace-cleanup-policy ac-controlled-evidence-protected
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it.each(["paused", "pending_cleanup"] as const)(
    "preserves session workspace, reviewer snapshot, branch, and registry audit evidence for %s control",
    async (controlState) => {
      const projectDir = await createTempDir("kspec-controlled-evidence-");
      projectDirs.push(projectDir);
      await seedDispatchProject(projectDir);
      const taskId = testUlid(controlState === "paused" ? "PASS" : "STPP", 1);
      const taskRef = `@${taskId}`;
      const task = { title: "Controlled Evidence", slugs: [`task-${controlState}-evidence`] };
      const worker = await provisionDispatchWorkspace({ projectDir, taskRef, task });
      const reviewer = await provisionDispatchWorkspace({
        projectDir,
        taskRef,
        task,
        role: "reviewer",
      });
      const sessionId = testUlid("SESS", 1);
      await createSession(path.join(projectDir, ".kspec-sessions"), {
        id: sessionId,
        task_id: taskId,
        task_ref: taskRef,
        agent_type: "task-worker",
        status: "completed",
      });
      const remoteDir = path.join(projectDir, "dispatch-remote.git");
      git(projectDir, `init --bare ${remoteDir}`);
      git(projectDir, `remote add origin ${remoteDir}`);
      git(projectDir, `push -u origin ${worker.metadata.canonicalBranch}`);
      await reconcileDispatchWorkspaceLifecycle({
        projectDir,
        taskRef,
        task,
        cleanupState: { integrationState: "merged", taskStatus: "completed" },
      });
      await controlTask(projectDir, taskId, controlState);
      unregisterDispatchControlStore(projectDir);

      const result = await reapDispatchWorkspace(projectDir, taskRef, { task });
      expect(result.action).toBe("cleanup_blocked");
      expect(await fs.stat(worker.cwd).then(() => true)).toBe(true);
      expect(await fs.stat(reviewer.cwd).then(() => true)).toBe(true);
      expect(git(projectDir, `branch --list ${worker.metadata.canonicalBranch}`)).toContain(
        worker.metadata.canonicalBranch,
      );
      expect(
        git(projectDir, `--git-dir=${remoteDir} branch --list ${worker.metadata.canonicalBranch}`),
      ).toContain(worker.metadata.canonicalBranch);
      expect(await getSession(path.join(projectDir, ".kspec-sessions"), sessionId)).not.toBeNull();

      await reconcileDispatchWorkspaceArtifacts(projectDir);
      expect(await fs.stat(worker.cwd).then(() => true)).toBe(true);
      expect(await fs.stat(reviewer.cwd).then(() => true)).toBe(true);
      expect(git(projectDir, `branch --list ${worker.metadata.canonicalBranch}`)).toContain(
        worker.metadata.canonicalBranch,
      );
      expect(
        git(projectDir, `--git-dir=${remoteDir} branch --list ${worker.metadata.canonicalBranch}`),
      ).toContain(worker.metadata.canonicalBranch);
      expect(await getSession(path.join(projectDir, ".kspec-sessions"), sessionId)).not.toBeNull();
      const records = await loadDispatchWorkspaceRegistry(await initContext(projectDir));
      const record = records.find((candidate) => candidate.task_id === taskId);
      expect(record?.cleanup.status).not.toBe("completed");
      expect(record?.lifecycle_state).not.toBe("closed");
    },
  );

  // AC: @dispatch-workspace-cleanup-policy ac-controlled-evidence-protected
  it("keeps stopped pending-cleanup audit state open when terminal reconciliation sees missing artifacts", async () => {
    const projectDir = await createTempDir("kspec-controlled-terminal-");
    projectDirs.push(projectDir);
    await seedDispatchProject(projectDir);
    const taskId = testUlid("ADDT", 1);
    const taskRef = `@${taskId}`;
    const task = { title: "Controlled Audit", slugs: ["task-controlled-audit"] };
    const workspace = await provisionDispatchWorkspace({ projectDir, taskRef, task });
    await reconcileDispatchWorkspaceLifecycle({
      projectDir,
      taskRef,
      task,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
    });
    await controlTask(projectDir, taskId, "pending_cleanup");
    unregisterDispatchControlStore(projectDir);

    await fs.rm(workspace.cwd, { recursive: true, force: true });
    git(projectDir, "worktree prune");
    git(projectDir, `branch -D ${workspace.metadata.canonicalBranch}`);
    await reconcileDispatchWorkspaceRegistry(
      projectDir,
      new Map([[taskRef, "completed" as const]]),
    );

    const records = await loadDispatchWorkspaceRegistry(await initContext(projectDir));
    const record = records.find((candidate) => candidate.task_ref === taskRef);
    expect(record?.cleanup.status).not.toBe("completed");
    expect(record?.lifecycle_state).not.toBe("closed");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-controlled-evidence-protected
  it("continues cleanup for an unrelated integrated terminal workspace", async () => {
    const projectDir = await createTempDir("kspec-controlled-unrelated-");
    projectDirs.push(projectDir);
    await seedDispatchProject(projectDir);
    const protectedId = testUlid("PRTD", 1);
    const unrelatedId = testUlid("RSTB", 1);
    const protectedRef = `@${protectedId}`;
    const unrelatedRef = `@${unrelatedId}`;
    const protectedTask = { title: "Protected", slugs: ["task-protected"] };
    const unrelatedTask = { title: "Unrelated", slugs: ["task-unrelated"] };
    const protectedWorkspace = await provisionDispatchWorkspace({
      projectDir,
      taskRef: protectedRef,
      task: protectedTask,
    });
    const unrelatedWorkspace = await provisionDispatchWorkspace({
      projectDir,
      taskRef: unrelatedRef,
      task: unrelatedTask,
    });
    for (const [taskRef, task] of [
      [protectedRef, protectedTask],
      [unrelatedRef, unrelatedTask],
    ] as const) {
      await reconcileDispatchWorkspaceLifecycle({
        projectDir,
        taskRef,
        task,
        cleanupState: { integrationState: "merged", taskStatus: "completed" },
      });
    }
    await controlTask(projectDir, protectedId, "paused");
    unregisterDispatchControlStore(projectDir);

    await reconcileDispatchWorkspaceArtifacts(projectDir);

    expect(await fs.stat(protectedWorkspace.cwd).then(() => true)).toBe(true);
    await expect(fs.stat(unrelatedWorkspace.cwd)).rejects.toThrow();
    expect(
      git(projectDir, `branch --list ${protectedWorkspace.metadata.canonicalBranch}`),
    ).toContain(protectedWorkspace.metadata.canonicalBranch);
    expect(git(projectDir, `branch --list ${unrelatedWorkspace.metadata.canonicalBranch}`)).toBe(
      "",
    );
  });
});

// AC: @trait-error-guidance ac-1 — N/A: protection is an internal runtime decision, not a CLI error surface.
// AC: @trait-error-guidance ac-2 — N/A: callers translate protection reasons into recovery diagnostics.
// AC: @trait-error-guidance ac-3 — N/A: protection does not resolve user-supplied references.
// AC: @trait-error-guidance ac-4 — N/A: protection does not perform task state transitions.
// AC: @trait-error-guidance ac-5 — N/A: schema validation is owned by the registry and lifecycle stores.
// AC: @trait-error-guidance ac-6 — N/A: protection has no JSON CLI mode.
