import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { buildDispatchArtifactProtectionState } from "../src/agent-runtime/workspace.js";
import type {
  DispatchWorkspaceIntegrationStatus,
  DispatchWorkspaceLifecycleState,
  DispatchWorkspaceRecord,
} from "../src/schema/index.js";
import { testUlid } from "./helpers/cli.js";

const WORKTREE_ROOT = "/tmp/kspec-dispatch-protection-fixture";

interface RecordOverrides {
  taskRef?: string;
  taskSlug?: string;
  workspaceId?: string;
  lifecycle?: DispatchWorkspaceLifecycleState;
  integrationStatus?: DispatchWorkspaceIntegrationStatus;
  canonicalBranch?: string;
  workerPath?: string;
  reviewerPath?: string | null;
  worktreeRoot?: string;
  cleanupEligible?: boolean;
}

function makeRecord(overrides: RecordOverrides = {}): DispatchWorkspaceRecord {
  const taskRef = overrides.taskRef ?? `@${testUlid("TASK")}`;
  const taskSlug = overrides.taskSlug ?? "task-protection-fixture";
  const root = overrides.worktreeRoot ?? WORKTREE_ROOT;
  const workerPath = overrides.workerPath ?? path.join(root, `${taskSlug}-01task00`);
  const reviewerPath =
    overrides.reviewerPath === undefined ? null : overrides.reviewerPath;
  return {
    workspace_id: overrides.workspaceId ?? `ws-${taskSlug}`,
    task_ref: taskRef,
    task_slug: taskSlug,
    worktree_root: root,
    resolved_base_branch: "dev",
    base_branch_point: "0".repeat(40),
    canonical_branch:
      overrides.canonicalBranch ?? `dispatch/task/${taskSlug}/01task00`,
    canonical_branch_head: "0".repeat(40),
    branch_provenance: {
      ownership: "dispatcher-managed",
      source: "provisioned",
      remote_ref: null,
      adopted_from: null,
      adopted_at: null,
      rehydrated: null,
    },
    lifecycle_state: overrides.lifecycle ?? "ready",
    active_role: null,
    worktrees: {
      worker: {
        path: workerPath,
        branch_mode: "branch",
        branch_ref: overrides.canonicalBranch ?? `dispatch/task/${taskSlug}/01task00`,
        head: "0".repeat(40),
        last_seen_at: "2026-05-12T00:00:00.000Z",
      },
      reviewer: reviewerPath
        ? {
            path: reviewerPath,
            branch_mode: "detached",
            branch_ref: null,
            head: "0".repeat(40),
            last_seen_at: "2026-05-12T00:00:00.000Z",
          }
        : null,
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
      status: overrides.integrationStatus ?? "pending",
      target_branch: "dev",
      target_commit: "0".repeat(40),
      publication_mode: "manual_merge",
      outcome: "manual_merge",
      detail: null,
      updated_at: "2026-05-12T00:00:00.000Z",
    },
    health: {
      status: "healthy",
      summary: "ok",
      issues: [],
      updated_at: "2026-05-12T00:00:00.000Z",
    },
    cleanup: {
      status: "not_scheduled",
      eligible: overrides.cleanupEligible ?? false,
      reason: null,
      detail: null,
      updated_at: "2026-05-12T00:00:00.000Z",
    },
    timestamps: {
      created_at: "2026-05-12T00:00:00.000Z",
      updated_at: "2026-05-12T00:00:00.000Z",
      last_reconciled_at: null,
      last_active_at: null,
      closed_at: null,
    },
  };
}

describe("buildDispatchArtifactProtectionState", () => {
  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  it("preserves dispatcher artifacts for active task refs even when no registry record exists", () => {
    const activeTaskRef = `@${testUlid("ACTV")}`;
    const state = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      activeOrInFlightTaskRefs: [activeTaskRef],
      registry: { status: "loaded", records: [] },
    });

    expect(state.evaluateTaskRef(activeTaskRef).preserve).toBe(true);
    expect(state.evaluateTaskRef(activeTaskRef).reason).toMatch(/active or in-flight/);
    expect(state.registryTrusted).toBe(true);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("preserves the same in-flight task across worktree, branch, and path surfaces", () => {
    const taskRef = `@${testUlid("INFL")}`;
    const taskSlug = "task-in-flight-protection";
    const workerPath = path.join(WORKTREE_ROOT, `${taskSlug}-01task00`);
    const reviewerPath = path.join(WORKTREE_ROOT, `${taskSlug}-01task00-review`);
    const canonicalBranch = `dispatch/task/${taskSlug}/01task00`;
    const record = makeRecord({
      taskRef,
      taskSlug,
      lifecycle: "provisioning",
      workerPath,
      reviewerPath,
      canonicalBranch,
    });

    const state = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      activeOrInFlightTaskRefs: [taskRef],
      registry: { status: "loaded", records: [record] },
    });

    expect(state.evaluateTaskRef(taskRef).preserve).toBe(true);
    expect(state.evaluateDispatchBranch(canonicalBranch).preserve).toBe(true);
    expect(state.evaluateWorkspacePath(workerPath).preserve).toBe(true);
    expect(state.evaluateWorkspacePath(reviewerPath).preserve).toBe(true);
    // Ancestor of the protected path is also preserved so blind root-directory
    // pruning cannot cascade-delete the workspace dir.
    expect(state.evaluateWorkspacePath(WORKTREE_ROOT).preserve).toBe(true);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // AC: @dispatch-workspace-registry ac-partial-provisioning-classified-before-cleanup
  it("preserves records in protected lifecycle states (provisioning, ready, active, stale, integrating, cleanup_blocked)", () => {
    const states: DispatchWorkspaceLifecycleState[] = [
      "provisioning",
      "ready",
      "active",
      "stale",
      "integrating",
      "cleanup_blocked",
    ];
    for (const lifecycle of states) {
      const taskRef = `@${testUlid("LCYC")}`;
      const taskSlug = `task-${lifecycle.replace(/_/g, "-")}-fixture`;
      const record = makeRecord({ taskRef, taskSlug, lifecycle });
      const state = buildDispatchArtifactProtectionState({
        worktreeRoot: WORKTREE_ROOT,
        activeOrInFlightTaskRefs: [],
        registry: { status: "loaded", records: [record] },
      });

      const decision = state.evaluateTaskRef(taskRef);
      expect(decision.preserve, `lifecycle ${lifecycle} should be protected`).toBe(true);
      expect(state.evaluateDispatchBranch(record.canonical_branch).preserve).toBe(true);
      expect(state.evaluateWorkspacePath(record.worktrees.worker.path).preserve).toBe(true);
    }
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  it("preserves closing records that still have active or in-flight task ownership", () => {
    const taskRef = `@${testUlid("CLOS")}`;
    const record = makeRecord({
      taskRef,
      taskSlug: "task-closing-active-fixture",
      lifecycle: "closing",
      integrationStatus: "merged",
      cleanupEligible: true,
    });
    const state = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      activeOrInFlightTaskRefs: [taskRef],
      registry: { status: "loaded", records: [record] },
    });

    expect(state.evaluateTaskRef(taskRef).preserve).toBe(true);
    const reapDecision = state.evaluateClosingRecordForReap(record);
    expect(reapDecision.preserve).toBe(true);
    expect(reapDecision.reason).toMatch(/active\/in-flight/);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  it("preserves closing records whose integration status is still unresolved", () => {
    const taskRef = `@${testUlid("INTG")}`;
    const record = makeRecord({
      taskRef,
      taskSlug: "task-closing-unresolved-integration-fixture",
      lifecycle: "closing",
      integrationStatus: "in_progress",
      cleanupEligible: true,
    });
    const state = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      activeOrInFlightTaskRefs: [],
      registry: { status: "loaded", records: [record] },
    });

    const reapDecision = state.evaluateClosingRecordForReap(record);
    expect(reapDecision.preserve).toBe(true);
    expect(reapDecision.reason).toMatch(/unresolved integration/);
  });

  // AC: @dispatch-workspace-registry ac-partial-provisioning-classified-before-cleanup
  it("classifies closing records with no active ownership and resolved integration as cleanup-eligible", () => {
    const taskRef = `@${testUlid("REAP")}`;
    const record = makeRecord({
      taskRef,
      taskSlug: "task-closing-reap-eligible-fixture",
      lifecycle: "closing",
      integrationStatus: "merged",
      cleanupEligible: true,
    });
    const state = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      activeOrInFlightTaskRefs: [],
      registry: { status: "loaded", records: [record] },
    });

    const reapDecision = state.evaluateClosingRecordForReap(record);
    expect(reapDecision.preserve).toBe(false);
    expect(reapDecision.reason).toMatch(/eligible for scheduled cleanup/);
    // Closing reap-eligible records still surface their paths/branches as
    // protected because reap is the only legitimate path to delete them; blind
    // pruning surfaces must defer to reap.
    expect(state.evaluateDispatchBranch(record.canonical_branch).preserve).toBe(true);
    expect(state.evaluateWorkspacePath(record.worktrees.worker.path).preserve).toBe(true);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("does not preserve closed records", () => {
    const taskRef = `@${testUlid("CLSD")}`;
    const record = makeRecord({
      taskRef,
      taskSlug: "task-closed-fixture",
      lifecycle: "closed",
      integrationStatus: "merged",
    });
    const state = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      activeOrInFlightTaskRefs: [],
      registry: { status: "loaded", records: [record] },
    });

    expect(state.evaluateTaskRef(taskRef).preserve).toBe(false);
    expect(state.evaluateDispatchBranch(record.canonical_branch).preserve).toBe(false);
    expect(state.evaluateWorkspacePath(record.worktrees.worker.path).preserve).toBe(false);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
  it("blocks blind deletion with actionable diagnostic when registry cannot be loaded", () => {
    const state = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      activeOrInFlightTaskRefs: [],
      registry: { status: "load-failed", reason: "EACCES: permission denied" },
    });

    expect(state.registryTrusted).toBe(false);
    expect(state.registryFailureDiagnostic).toMatch(/EACCES/);
    expect(state.registryFailureDiagnostic).toMatch(/registry/i);

    const branchDecision = state.evaluateDispatchBranch("dispatch/task/task-untrusted/01task00");
    expect(branchDecision.preserve).toBe(true);
    expect(branchDecision.reason).toMatch(/registry/i);

    const pathDecision = state.evaluateWorkspacePath(
      path.join(WORKTREE_ROOT, "task-untrusted-01task00"),
    );
    expect(pathDecision.preserve).toBe(true);

    const taskDecision = state.evaluateTaskRef(`@${testUlid("UTRT")}`);
    expect(taskDecision.preserve).toBe(true);

    // Non-dispatch branches and out-of-tree paths remain unprotected so
    // unrelated cleanup surfaces are not over-blocked.
    const nonDispatch = state.evaluateDispatchBranch("feat/something-else");
    expect(nonDispatch.preserve).toBe(false);
    const outOfTree = state.evaluateWorkspacePath("/some/other/place");
    expect(outOfTree.preserve).toBe(false);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("does not protect records that belong to a different worktree root", () => {
    const taskRef = `@${testUlid("OTHR")}`;
    const otherRoot = "/tmp/some-other-dispatch-root";
    const record = makeRecord({
      taskRef,
      taskSlug: "task-other-root-fixture",
      worktreeRoot: otherRoot,
      workerPath: path.join(otherRoot, "task-other-root-fixture-01task00"),
    });
    const state = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      activeOrInFlightTaskRefs: [],
      registry: { status: "loaded", records: [record] },
    });

    expect(state.evaluateTaskRef(taskRef).preserve).toBe(false);
    expect(state.evaluateDispatchBranch(record.canonical_branch).preserve).toBe(false);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("treats root-directory candidates that contain protected workspace paths as protected", () => {
    const taskRef = `@${testUlid("ANCS")}`;
    const taskSlug = "task-ancestor-protection-fixture";
    const workerPath = path.join(WORKTREE_ROOT, "nested", `${taskSlug}-01task00`);
    const record = makeRecord({ taskRef, taskSlug, workerPath });
    const state = buildDispatchArtifactProtectionState({
      worktreeRoot: WORKTREE_ROOT,
      activeOrInFlightTaskRefs: [],
      registry: { status: "loaded", records: [record] },
    });

    const ancestorCandidate = path.join(WORKTREE_ROOT, "nested");
    expect(state.evaluateWorkspacePath(ancestorCandidate).preserve).toBe(true);
  });
});

// AC: @trait-error-guidance ac-1 — N/A: this helper is a pure decision function, not a CLI command surface.
// AC: @trait-error-guidance ac-2 — N/A: cleanup callers translate decisions into log/metadata diagnostics, not CLI error messages.
// AC: @trait-error-guidance ac-3 — N/A: protection decisions never raise reference-not-found errors.
// AC: @trait-error-guidance ac-4 — N/A: the helper does not perform state transitions.
// AC: @trait-error-guidance ac-5 — N/A: validation errors are handled by registry loading, not by this helper.
// AC: @trait-error-guidance ac-6 — N/A: the helper has no JSON CLI mode.
