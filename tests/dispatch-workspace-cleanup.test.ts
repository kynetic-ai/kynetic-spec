import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  buildDispatchArtifactProtectionState,
  cleanupReviewerDispatchWorkspace,
  provisionDispatchWorkspace,
  reconcileDispatchWorkspaceLifecycle,
  reconcileDispatchWorkspaceArtifacts,
  reapDispatchWorkspace,
} from "../src/agent-runtime/workspace.js";
import {
  loadDispatchWorkspaceRegistry,
  saveDispatchWorkspaceRecord,
} from "../src/parser/dispatch-workspaces.js";
import { initContext } from "../src/parser/index.js";
import type {
  DispatchWorkspaceLifecycleState,
  DispatchWorkspaceRecord,
} from "../src/schema/index.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
  testUlid,
} from "./helpers/cli.js";

const WORKSPACE_METADATA_FILE = ".kspec-dispatch-workspace.json";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

async function seedRepo(dir: string): Promise<void> {
  initGitRepo(dir);
  await fs.writeFile(path.join(dir, "README.md"), "seed\n", "utf-8");
  git(dir, "add README.md");
  git(dir, 'commit -m "init"');
}

async function setupProjectWithReviewerAgent(dir: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: Test Project\n',
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "kynetic.meta.yaml"),
    [
      'kynetic_meta: "1.0"',
      "agents:",
      "  - _ulid: 01AGNT00000000000000000000",
      "    id: pr-reviewer",
      '    name: "PR Reviewer"',
      "    dispatch:",
      "      - on: task.pending_review",
      "    concurrency:",
      "      max_concurrent: 1",
      "    adapter: mock-acp",
      "    auto_approve: false",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(path.join(dir, "project.tasks.yaml"), "tasks: []\n", "utf-8");
}

function workspaceMetadataPath(workspaceDir: string): string {
  return path.join(workspaceDir, WORKSPACE_METADATA_FILE);
}

async function readRegistryWorkspaces(dir: string): Promise<Array<Record<string, unknown>>> {
  const registryPath = path.join(dir, "project.dispatch-workspaces.yaml");
  const raw = YAML.parse(await readTestOutput(registryPath)) as {
    workspaces?: Array<Record<string, unknown>>;
  };
  return raw.workspaces ?? [];
}

async function setLifecycleStateThroughRegistry(
  projectDir: string,
  taskRef: string,
  lifecycleState: DispatchWorkspaceLifecycleState,
): Promise<DispatchWorkspaceRecord> {
  const ctx = await initContext(projectDir);
  const records = await loadDispatchWorkspaceRegistry(ctx);
  const existing = records.find((record) => record.task_ref === taskRef);
  if (!existing) {
    throw new Error(`No registry record found for ${taskRef}`);
  }
  const now = new Date().toISOString();
  const updated: DispatchWorkspaceRecord = {
    ...existing,
    lifecycle_state: lifecycleState,
    timestamps: { ...existing.timestamps, updated_at: now },
  };
  await saveDispatchWorkspaceRecord(ctx, updated);
  return updated;
}

function captureDispatchCleanupDiagnostics(): {
  capture: () => string[];
  restore: () => void;
} {
  const previousDiagnostics = process.env.KSPEC_DISPATCH_CLEANUP_DIAGNOSTICS;
  process.env.KSPEC_DISPATCH_CLEANUP_DIAGNOSTICS = "1";
  const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  return {
    capture: () =>
      spy.mock.calls
        .map((args) => String(args[0] ?? ""))
        .filter((line) => line.includes("[dispatch-cleanup]")),
    restore: () => {
      if (previousDiagnostics === undefined) {
        delete process.env.KSPEC_DISPATCH_CLEANUP_DIAGNOSTICS;
      } else {
        process.env.KSPEC_DISPATCH_CLEANUP_DIAGNOSTICS = previousDiagnostics;
      }
      spy.mockRestore();
    },
  };
}

describe("dispatch workspace cleanup", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-workspace-cleanup-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-1
  it("removes reviewer snapshots after review while keeping the canonical worker worktree", async () => {
    await seedRepo(tempDir);
    await setupProjectWithReviewerAgent(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 21)}`;
    const workerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Cleanup Reviewer Snapshot",
        slugs: ["task-cleanup-reviewer-snapshot"],
      },
    });
    const reviewerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: {
        title: "Cleanup Reviewer Snapshot",
        slugs: ["task-cleanup-reviewer-snapshot"],
      },
    });
    expect(reviewerWorkspace.cwd).toBe(
      path.join(tempDir, ".kspec-worktrees", "task-cleanup-reviewer-snapshot-01task00-review"),
    );

    const result = await cleanupReviewerDispatchWorkspace(tempDir, taskRef, {
      title: "Cleanup Reviewer Snapshot",
      slugs: ["task-cleanup-reviewer-snapshot"],
    });
    expect(result).toEqual({
      taskRef,
      action: "reviewer_cleaned",
      blockedReason: null,
    });

    await expect(fs.access(reviewerWorkspace.cwd)).rejects.toThrow();

    await fs.access(workerWorkspace.cwd);
    const metadata = JSON.parse(
      await readTestOutput(workspaceMetadataPath(workerWorkspace.cwd)),
    ) as { reviewerWorktreeDir: string | null };
    expect(metadata.reviewerWorktreeDir).toBeNull();
  });

  // AC: @dispatch-workspace-cleanup-policy ac-2
  // AC: @dispatch-workspace-cleanup-policy ac-3
  it("schedules closing cleanup and reaps dispatch worktrees plus canonical branch", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 22)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Reap Closed Workspace",
        slugs: ["task-reap-closed-workspace"],
      },
    });

    const reconciled = await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: {
        title: "Reap Closed Workspace",
        slugs: ["task-reap-closed-workspace"],
      },
    });

    expect(reconciled?.metadata.lifecycleState).toBe("closing");
    expect(reconciled?.metadata.cleanupScheduledAt).toBeTruthy();

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await expect(fs.access(workspace.cwd)).rejects.toThrow();
    expect(git(tempDir, "branch --list dispatch/task/task-reap-closed-workspace/01task00")).toBe(
      "",
    );
  });

  // AC: @dispatch-workspace-cleanup-policy ac-4
  it("marks cleanup_blocked when branch deletion is attempted while the task still has active ownership", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 23)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Blocked Cleanup Workspace",
        slugs: ["task-blocked-cleanup-workspace"],
      },
    });

    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: {
        title: "Blocked Cleanup Workspace",
        slugs: ["task-blocked-cleanup-workspace"],
      },
    });

    const result = await reapDispatchWorkspace(tempDir, taskRef, {
      activeTaskIds: [taskRef],
      task: {
        title: "Blocked Cleanup Workspace",
        slugs: ["task-blocked-cleanup-workspace"],
      },
    });

    expect(result).toEqual({
      taskRef,
      action: "cleanup_blocked",
      blockedReason: "Cleanup blocked: canonical branch still has an active dispatch invocation.",
    });

    const metadata = JSON.parse(await readTestOutput(workspaceMetadataPath(workspace.cwd))) as {
      lifecycleState: string;
      cleanupBlockedReason: string | null;
    };
    expect(metadata.lifecycleState).toBe("cleanup_blocked");
    expect(metadata.cleanupBlockedReason).toContain("active dispatch invocation");
    await fs.access(workspace.cwd);
    expect(
      git(tempDir, "branch --list dispatch/task/task-blocked-cleanup-workspace/01task00"),
    ).toContain("dispatch/task/task-blocked-cleanup-workspace/01task00");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-4
  it("marks cleanup_blocked when branch deletion is attempted before integration is resolved", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 25)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Unresolved Integration Cleanup Workspace",
        slugs: ["task-unresolved-integration-cleanup-workspace"],
      },
    });

    const result = await reapDispatchWorkspace(tempDir, taskRef, {
      task: {
        title: "Unresolved Integration Cleanup Workspace",
        slugs: ["task-unresolved-integration-cleanup-workspace"],
      },
    });

    expect(result).toEqual({
      taskRef,
      action: "cleanup_blocked",
      blockedReason:
        "Cleanup blocked: workspace integration outcome is unresolved, so the canonical branch must be retained.",
    });

    const metadata = JSON.parse(await readTestOutput(workspaceMetadataPath(workspace.cwd))) as {
      lifecycleState: string;
      cleanupBlockedReason: string | null;
      cleanupScheduledAt: string | null;
    };
    expect(metadata.lifecycleState).toBe("cleanup_blocked");
    expect(metadata.cleanupBlockedReason).toContain("integration outcome is unresolved");
    expect(metadata.cleanupScheduledAt).toBeTruthy();
    await fs.access(workspace.cwd);
    expect(
      git(
        tempDir,
        "branch --list dispatch/task/task-unresolved-integration-cleanup-workspace/01task00",
      ),
    ).toContain("dispatch/task/task-unresolved-integration-cleanup-workspace/01task00");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-5
  // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
  it("cleans orphaned dispatch worktrees and branches during reconciliation", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 24)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Orphan Cleanup Workspace",
        slugs: ["task-orphan-cleanup-workspace"],
      },
    });

    // Make this a true orphan: no metadata file AND no registry record.
    // The centralized protection helper preserves dispatcher-managed
    // artifacts whose canonical branch belongs to a non-closed registry
    // record, so clearing the registry is required to exercise the
    // legitimate orphan-cleanup path.
    await fs.rm(workspaceMetadataPath(workspace.cwd), { force: true });
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );
    await fs.mkdir(path.join(tempDir, ".kspec-worktrees", "orphan-dir"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, ".kspec-worktrees", "orphan-dir", "leftover.txt"),
      "orphan\n",
      "utf-8",
    );
    git(tempDir, "branch dispatch/task/orphaned/no-metadata");

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await expect(fs.access(workspace.cwd)).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, ".kspec-worktrees", "orphan-dir"))).rejects.toThrow();
    expect(git(tempDir, "branch --list dispatch/task/task-orphan-cleanup-workspace/01task00")).toBe(
      "",
    );
    expect(git(tempDir, "branch --list dispatch/task/orphaned/no-metadata")).toBe("");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-5
  // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
  it("prunes stale git worktree registrations when the dispatch directory is already gone", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 27)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Stale Registration Cleanup Workspace",
        slugs: ["task-stale-registration-cleanup-workspace"],
      },
    });

    await fs.rm(workspace.cwd, { recursive: true, force: true });
    // Clear the registry so the stale registration is treated as a true
    // orphan; otherwise the protection helper preserves the branch on behalf
    // of the still-open registry record.
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );
    expect(git(tempDir, "worktree list --porcelain")).toContain(`worktree ${workspace.cwd}`);

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    expect(git(tempDir, "worktree list --porcelain")).not.toContain(`worktree ${workspace.cwd}`);
    expect(
      git(
        tempDir,
        "branch --list dispatch/task/task-stale-registration-cleanup-workspace/01task00",
      ),
    ).toBe("");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
  it("preserves a registry-backed worktree and its canonical branch when the metadata file is missing", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 28)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Registry Backed Metadata Missing Workspace",
        slugs: ["task-registry-backed-metadata-missing-workspace"],
      },
    });

    // Remove only the metadata file. The registry record for this workspace
    // still exists (lifecycle_state=ready) and must protect both the worktree
    // directory and the dispatch branch from blind deletion until cleanup
    // policy classification determines cleanup is safe.
    await fs.rm(workspaceMetadataPath(workspace.cwd), { force: true });

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await fs.access(workspace.cwd);
    expect(
      git(
        tempDir,
        "branch --list dispatch/task/task-registry-backed-metadata-missing-workspace/01task00",
      ),
    ).toContain("dispatch/task/task-registry-backed-metadata-missing-workspace/01task00");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("preserves an in-flight task ref's worktree, reviewer dir, and dispatch branch across all cleanup surfaces", async () => {
    await seedRepo(tempDir);
    await setupProjectWithReviewerAgent(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 29)}`;
    const workerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "In Flight Protection Workspace",
        slugs: ["task-in-flight-protection-workspace"],
      },
    });
    const reviewerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: {
        title: "In Flight Protection Workspace",
        slugs: ["task-in-flight-protection-workspace"],
      },
    });

    // Simulate the queue-to-spawn race: metadata files removed (would happen
    // mid-provisioning), but the dispatch engine still has the task in-flight.
    await fs.rm(workspaceMetadataPath(workerWorkspace.cwd), { force: true });
    await fs.rm(workspaceMetadataPath(reviewerWorkspace.cwd), { force: true });

    await reconcileDispatchWorkspaceArtifacts(tempDir, {
      activeTaskIds: [taskRef],
    });

    await fs.access(workerWorkspace.cwd);
    await fs.access(reviewerWorkspace.cwd);
    expect(
      git(tempDir, "branch --list dispatch/task/task-in-flight-protection-workspace/01task00"),
    ).toContain("dispatch/task/task-in-flight-protection-workspace/01task00");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("preserves the canonical dispatch branch when an active task ref has no registry record yet (queue-to-spawn race)", async () => {
    await seedRepo(tempDir);
    await setupProjectWithReviewerAgent(tempDir);
    git(tempDir, "checkout -b agent-dev");

    // Reserve a canonical dispatch branch the way the engine would during the
    // queue-to-spawn window, BEFORE any registry record is written and BEFORE
    // any worker worktree is provisioned. The registry file is empty.
    const taskRef = `@${testUlid("TASK", 30)}`;
    const reservedBranch = "dispatch/task/task-queue-to-spawn-protection/01task00";
    git(tempDir, `branch ${reservedBranch}`);
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [],
      }),
      "utf-8",
    );

    await reconcileDispatchWorkspaceArtifacts(tempDir, {
      activeTaskIds: [taskRef],
    });

    // The reserved branch shares the short-id segment with the active task ref
    // (`01task00`), so cleanup must preserve it even though no registry record
    // exists yet — otherwise the queue-to-spawn window can delete a canonical
    // branch out from under an in-flight invocation.
    expect(git(tempDir, `branch --list ${reservedBranch}`)).toContain(reservedBranch);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("blocks blind deletion across all destructive surfaces when the registry cannot be parsed", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 31)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Untrusted Registry Workspace",
        slugs: ["task-untrusted-registry-workspace"],
      },
    });

    // Pre-create an orphan-looking dispatch branch and a root directory candidate.
    // Both would be eligible for blind deletion under the prior fallback that
    // treated untracked dispatch branches/root entries as orphans. Under the
    // no-blind-deletion contract, they must be preserved when registry
    // classification is unavailable.
    git(tempDir, "branch dispatch/task/task-untrusted-registry-workspace/01orphan");
    await fs.mkdir(path.join(tempDir, ".kspec-worktrees", "untrusted-root-candidate"), {
      recursive: true,
    });

    // Remove the metadata file so the metadata-less worktree surface is
    // exercised too. With no metadata and no trustable registry, blind
    // deletion would have removed both the worktree dir and its dispatch
    // branch — the protection contract must preserve them instead.
    await fs.rm(workspaceMetadataPath(workspace.cwd), { force: true });

    // Corrupt the registry so loadDispatchWorkspaceRegistry throws and the
    // protection helper enters no-blind-deletion mode.
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      "kynetic_dispatch_workspaces: 1.0\nworkspaces: [\n  {invalid yaml here\n",
      "utf-8",
    );

    const diag = captureDispatchCleanupDiagnostics();
    let capturedCalls: string[] = [];
    try {
      await reconcileDispatchWorkspaceArtifacts(tempDir);
      capturedCalls = diag.capture();
    } finally {
      diag.restore();
    }

    // Every dispatcher-managed artifact under the worktree root must survive.
    await fs.access(workspace.cwd);
    await fs.access(path.join(tempDir, ".kspec-worktrees", "untrusted-root-candidate"));
    expect(
      git(tempDir, "branch --list dispatch/task/task-untrusted-registry-workspace/01task00"),
    ).toContain("dispatch/task/task-untrusted-registry-workspace/01task00");
    expect(
      git(tempDir, "branch --list dispatch/task/task-untrusted-registry-workspace/01orphan"),
    ).toContain("dispatch/task/task-untrusted-registry-workspace/01orphan");

    // Diagnostic identifies the cleanup surface and surfaces the registry
    // failure reason so logs are actionable for operators.
    const diagnosticMessages = capturedCalls.filter((line) => line.includes("[dispatch-cleanup]"));
    expect(diagnosticMessages.length).toBeGreaterThan(0);
    expect(diagnosticMessages.some((line) => line.includes("registry"))).toBe(true);
    // At least one surface label must show up so the diagnostic is
    // surface-aware, not generic.
    expect(
      diagnosticMessages.some((line) =>
        /metadata-less-worktree|root-directory|dispatch-branch/.test(line),
      ),
    ).toBe(true);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
  it("emits surface-labeled preservation diagnostics for every destructive cleanup surface", async () => {
    await seedRepo(tempDir);
    await setupProjectWithReviewerAgent(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 32)}`;
    const workerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Diagnostic Surface Workspace",
        slugs: ["task-diagnostic-surface-workspace"],
      },
    });
    const reviewerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: {
        title: "Diagnostic Surface Workspace",
        slugs: ["task-diagnostic-surface-workspace"],
      },
    });

    // Simulate the queue-to-spawn race: metadata removed from both
    // worker and reviewer worktrees, AND the registry record cleared. With
    // an active task ref, the protection helper must preserve each surface
    // through its deterministic short-id lineage so diagnostics surface all
    // of them with the active/in-flight protection source.
    await fs.rm(workspaceMetadataPath(workerWorkspace.cwd), { force: true });
    await fs.rm(workspaceMetadataPath(reviewerWorkspace.cwd), { force: true });
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    const diag = captureDispatchCleanupDiagnostics();
    let capturedCalls: string[] = [];
    try {
      await reconcileDispatchWorkspaceArtifacts(tempDir, {
        activeTaskIds: [taskRef],
      });
      capturedCalls = diag.capture();
    } finally {
      diag.restore();
    }

    const diagnosticMessages = capturedCalls.filter((line) => line.includes("[dispatch-cleanup]"));

    // The worker worktree surfaces through the metadata-less-worktree gate
    // (the entry has a tracked dispatch branch and missing metadata).
    expect(
      diagnosticMessages.some(
        (line) => line.includes("metadata-less-worktree") && line.includes(workerWorkspace.cwd),
      ),
    ).toBe(true);
    // The reviewer worktree surfaces through the reviewer-snapshot gate
    // (the entry is detached with branch=null and path ends in -review).
    expect(
      diagnosticMessages.some(
        (line) => line.includes("reviewer-snapshot") && line.includes(reviewerWorkspace.cwd),
      ),
    ).toBe(true);
    // Protection-source reason text is forwarded into the diagnostic so the
    // operator can identify why preservation occurred.
    expect(diagnosticMessages.some((line) => /active or in-flight/.test(line))).toBe(true);

    // Filesystem state must still be preserved.
    await fs.access(workerWorkspace.cwd);
    await fs.access(reviewerWorkspace.cwd);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("skips reap and emits a reap-candidate diagnostic when the closing workspace's task ref is active", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 33)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Reap Skip Workspace",
        slugs: ["task-reap-skip-workspace"],
      },
    });

    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: {
        title: "Reap Skip Workspace",
        slugs: ["task-reap-skip-workspace"],
      },
    });

    const diag = captureDispatchCleanupDiagnostics();
    let capturedCalls: string[] = [];
    try {
      await reconcileDispatchWorkspaceArtifacts(tempDir, {
        activeTaskIds: [taskRef],
      });
      capturedCalls = diag.capture();
    } finally {
      diag.restore();
    }

    // Reap is skipped, so the worktree and canonical branch must survive.
    await fs.access(workspace.cwd);
    expect(git(tempDir, "branch --list dispatch/task/task-reap-skip-workspace/01task00")).toContain(
      "dispatch/task/task-reap-skip-workspace/01task00",
    );

    // The reap-candidate surface must emit a diagnostic identifying the
    // surface AND the active/in-flight protection source.
    const diagnosticMessages = capturedCalls.filter((line) => line.includes("[dispatch-cleanup]"));
    expect(
      diagnosticMessages.some(
        (line) =>
          line.includes("reap-candidate") &&
          line.includes(taskRef) &&
          /active or in-flight/.test(line),
      ),
    ).toBe(true);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-preservation-diagnostics-quiet-by-default
  it("does not emit preservation diagnostics when detailed cleanup diagnostics are not opted in", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 27)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Quiet Preservation Diagnostics",
        slugs: ["task-quiet-preservation-diagnostics"],
      },
    });

    // Force a preservation scenario: metadata removed and registry cleared,
    // but the task is active. The protection helper must preserve the
    // metadata-less worktree and its canonical dispatch branch — exactly the
    // path that would otherwise emit a `[dispatch-cleanup]` diagnostic.
    await fs.rm(workspaceMetadataPath(workspace.cwd), { force: true });
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    // Explicitly clear the opt-in so an inherited env var cannot leak into
    // the assertion. The diagnostic gate must default to quiet.
    const previousDiagnostics = process.env.KSPEC_DISPATCH_CLEANUP_DIAGNOSTICS;
    delete process.env.KSPEC_DISPATCH_CLEANUP_DIAGNOSTICS;
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    let diagnosticCalls: string[] = [];
    try {
      await reconcileDispatchWorkspaceArtifacts(tempDir, { activeTaskIds: [taskRef] });
      // Snapshot the spy's call history BEFORE mockRestore(): mockRestore
      // clears the recorded calls, so reading them after restore would
      // always observe an empty array and silently pass even if a
      // diagnostic line had been emitted.
      diagnosticCalls = debugSpy.mock.calls
        .map((args) => String(args[0] ?? ""))
        .filter((line) => line.includes("[dispatch-cleanup]"));
    } finally {
      debugSpy.mockRestore();
      if (previousDiagnostics === undefined) {
        delete process.env.KSPEC_DISPATCH_CLEANUP_DIAGNOSTICS;
      } else {
        process.env.KSPEC_DISPATCH_CLEANUP_DIAGNOSTICS = previousDiagnostics;
      }
    }

    // Preservation must still have occurred — workspace and branch survive.
    await fs.access(workspace.cwd);
    expect(
      git(tempDir, "branch --list dispatch/task/task-quiet-preservation-diagnostics/01task00"),
    ).toContain("dispatch/task/task-quiet-preservation-diagnostics/01task00");

    // No `[dispatch-cleanup]` diagnostic was emitted on the quiet path.
    expect(diagnosticCalls).toEqual([]);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-preservation-diagnostics-opt-in
  it("emits a preservation diagnostic identifying surface, artifact, and reason when the opt-in is enabled", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 28)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Opt In Preservation Diagnostics",
        slugs: ["task-opt-in-preservation-diagnostics"],
      },
    });

    // Same preservation scenario as the quiet-by-default test so the only
    // observable difference is the opt-in env var.
    await fs.rm(workspaceMetadataPath(workspace.cwd), { force: true });
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    const diag = captureDispatchCleanupDiagnostics();
    let capturedCalls: string[] = [];
    try {
      await reconcileDispatchWorkspaceArtifacts(tempDir, { activeTaskIds: [taskRef] });
      capturedCalls = diag.capture();
    } finally {
      diag.restore();
    }

    // Preservation occurred — workspace and branch survive.
    await fs.access(workspace.cwd);
    expect(
      git(tempDir, "branch --list dispatch/task/task-opt-in-preservation-diagnostics/01task00"),
    ).toContain("dispatch/task/task-opt-in-preservation-diagnostics/01task00");

    // At least one diagnostic identifies surface, artifact, and reason.
    const diagnosticMessages = capturedCalls.filter((line) => line.includes("[dispatch-cleanup]"));
    expect(diagnosticMessages.length).toBeGreaterThan(0);
    const surfaceLabeled = diagnosticMessages.find(
      (line) =>
        line.includes("metadata-less-worktree") &&
        line.includes(workspace.cwd) &&
        /active or in-flight/.test(line),
    );
    expect(surfaceLabeled).toBeDefined();
  });

  // AC: @dispatch-workspace-cleanup-policy ac-6
  // AC: @dispatch-workspace-cleanup-policy ac-7
  it("reconstructs a missing registry record and normalizes legacy branch layouts from metadata-backed worktrees", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 26)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Legacy Dispatch Upgrade Workspace",
        slugs: ["task-legacy-dispatch-upgrade-workspace"],
      },
    });

    const legacyBranch = "feat/legacy-dispatch-upgrade";
    git(workspace.cwd, `checkout -b ${legacyBranch}`);
    git(tempDir, `branch -D ${workspace.metadata.canonicalBranch}`);

    const metadataFile = workspaceMetadataPath(workspace.cwd);
    const metadata = JSON.parse(await readTestOutput(metadataFile)) as {
      canonicalBranch: string;
      canonicalBranchHead: string;
    };
    metadata.canonicalBranch = legacyBranch;
    metadata.canonicalBranchHead = git(workspace.cwd, "rev-parse HEAD");
    await fs.writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [],
      }),
      "utf-8",
    );

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    const [record] = await readRegistryWorkspaces(tempDir);
    expect(record).toMatchObject({
      task_ref: taskRef,
      canonical_branch: workspace.metadata.canonicalBranch,
      task_slug: "task-legacy-dispatch-upgrade-workspace",
      worktrees: {
        worker: {
          path: workspace.cwd,
          branch_ref: workspace.metadata.canonicalBranch,
        },
      },
    });
    expect(git(workspace.cwd, "branch --show-current")).toBe(workspace.metadata.canonicalBranch);
    expect(git(tempDir, `rev-parse ${workspace.metadata.canonicalBranch}`)).toBe(
      git(workspace.cwd, "rev-parse HEAD"),
    );
  });
});

describe("dispatch artifact cleanup protection (positive and regression cases)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-cleanup-protection-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  // AC: @dispatch-workspace-registry ac-partial-provisioning-classified-before-cleanup
  it("preserves every cleanup surface when the registry record is in provisioning lifecycle state", async () => {
    await seedRepo(tempDir);
    await setupProjectWithReviewerAgent(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 40)}`;
    const workerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Provisioning State Workspace",
        slugs: ["task-provisioning-state-workspace"],
      },
    });
    const reviewerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: {
        title: "Provisioning State Workspace",
        slugs: ["task-provisioning-state-workspace"],
      },
    });

    await setLifecycleStateThroughRegistry(tempDir, taskRef, "provisioning");

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await fs.access(workerWorkspace.cwd);
    await fs.access(reviewerWorkspace.cwd);
    expect(
      git(tempDir, "branch --list dispatch/task/task-provisioning-state-workspace/01task00"),
    ).toContain("dispatch/task/task-provisioning-state-workspace/01task00");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it.each(["stale", "integrating", "cleanup_blocked"] as const)(
    "preserves dispatcher-managed artifacts for non-closed lifecycle state %s",
    async (state) => {
      await seedRepo(tempDir);
      git(tempDir, "checkout -b agent-dev");

      const taskRef = `@${testUlid("TASK", 41)}`;
      const slug = `task-non-closed-state-${state.replace("_", "-")}`;
      const workspace = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        task: { title: slug, slugs: [slug] },
      });

      await setLifecycleStateThroughRegistry(tempDir, taskRef, state);

      await reconcileDispatchWorkspaceArtifacts(tempDir);

      await fs.access(workspace.cwd);
      expect(git(tempDir, `branch --list dispatch/task/${slug}/01task00`)).toContain(
        `dispatch/task/${slug}/01task00`,
      );
    },
  );

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("preserves the canonical dispatch branch through orphan-branch sweep when the registry record is non-closed", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 42)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Non-Closed Branch Sweep Preservation",
        slugs: ["task-non-closed-branch-sweep-preservation"],
      },
    });
    const canonicalBranch = workspace.metadata.canonicalBranch;

    // Detach the worktree from the branch so the branch becomes an
    // "orphan" candidate from the worktree-list perspective: the dispatch
    // branch is no longer covered by a worktree entry's branch field, so the
    // orphan-branch sweep is the only surface that can delete it. The
    // non-closed registry record must still preserve the branch.
    await fs.rm(workspace.cwd, { recursive: true, force: true });
    git(tempDir, "worktree prune");

    expect(git(tempDir, `branch --list ${canonicalBranch}`)).toContain(canonicalBranch);

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    expect(git(tempDir, `branch --list ${canonicalBranch}`)).toContain(canonicalBranch);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("preserves a closing workspace's branch and worktree while integration is still unresolved", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 43)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Closing Unresolved Integration",
        slugs: ["task-closing-unresolved-integration"],
      },
    });

    // Mark the record as closing with integration still in_progress so the
    // protection helper classifies it as not-yet-reap-eligible.
    const ctx = await initContext(tempDir);
    const records = await loadDispatchWorkspaceRegistry(ctx);
    const existing = records.find((record) => record.task_ref === taskRef)!;
    const now = new Date().toISOString();
    await saveDispatchWorkspaceRecord(ctx, {
      ...existing,
      lifecycle_state: "closing",
      integration: {
        ...existing.integration,
        status: "in_progress",
        updated_at: now,
      },
      cleanup: {
        ...existing.cleanup,
        status: "scheduled",
        eligible: true,
        reason: "integrated-into-base-branch",
        detail: "integrated-into-base-branch",
        updated_at: now,
      },
      timestamps: { ...existing.timestamps, updated_at: now },
    });

    const diag = captureDispatchCleanupDiagnostics();
    let diagnostics: string[] = [];
    try {
      await reconcileDispatchWorkspaceArtifacts(tempDir);
      diagnostics = diag.capture();
    } finally {
      diag.restore();
    }

    await fs.access(workspace.cwd);
    expect(
      git(tempDir, "branch --list dispatch/task/task-closing-unresolved-integration/01task00"),
    ).toContain("dispatch/task/task-closing-unresolved-integration/01task00");

    // The reap-candidate surface emits a preservation diagnostic identifying
    // the protection source so operators can see why cleanup is waiting.
    expect(
      diagnostics.some(
        (line) =>
          line.includes("reap-candidate") &&
          line.includes(taskRef) &&
          /not yet cleanup-eligible/.test(line),
      ),
    ).toBe(true);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("preserves a detached reviewer-snapshot dir whose basename matches an active task short-id", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    // Reserve a detached reviewer-snapshot worktree the way the dispatcher
    // would during the queue-to-spawn window: the directory exists under the
    // worktree root, its basename ends in -review with the task's short-id,
    // and there is no metadata file and no registry record yet.
    const taskRef = `@${testUlid("TASK", 44)}`;
    const reviewerDir = path.join(
      tempDir,
      ".kspec-worktrees",
      `task-reviewer-shortid-preservation-01task00-review`,
    );
    await fs.mkdir(path.dirname(reviewerDir), { recursive: true });
    git(tempDir, `worktree add --detach ${reviewerDir} HEAD`);
    await fs.access(reviewerDir);

    // Clear the registry to force the reviewer-snapshot surface to rely on
    // the short-id basename protection (not the protectedPaths overlap path).
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    const diag = captureDispatchCleanupDiagnostics();
    let diagnostics: string[] = [];
    try {
      await reconcileDispatchWorkspaceArtifacts(tempDir, { activeTaskIds: [taskRef] });
      diagnostics = diag.capture();
    } finally {
      diag.restore();
    }

    await fs.access(reviewerDir);
    expect(
      diagnostics.some((line) => line.includes("reviewer-snapshot") && line.includes(reviewerDir)),
    ).toBe(true);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  it("preserves a direct-child root-directory candidate whose path overlaps a non-closed worker record", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 45)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Root Candidate Overlap Worker",
        slugs: ["task-root-candidate-overlap-worker"],
      },
    });

    const workerPath = workspace.cwd;
    const worktreeRoot = path.dirname(workerPath);
    expect(workerPath).toBe(path.join(worktreeRoot, "task-root-candidate-overlap-worker-01task00"));

    // Strip the worker dir's git worktree registration AND its on-disk
    // .git pointer + metadata, but leave the still-active registry record
    // pinning the same path. Recreating an empty dir produces a real direct
    // child of the worktree root that:
    //   - is NOT a registered git worktree (so findWorktreeByPath does not skip it),
    //   - has NO .kspec-dispatch-workspace.json metadata (so the metadata gate
    //     does not skip it),
    //   - has NO .git marker file (so the gitMarker gate does not skip it).
    // Root-directory pruning therefore reaches the protection helper for this
    // candidate, and the candidate path equals the protected worker.path on
    // the non-closed registry record so `pathsOverlap` returns true.
    git(tempDir, `worktree remove --force ${workerPath}`);
    await expect(fs.access(workerPath)).rejects.toThrow();
    await fs.mkdir(workerPath, { recursive: true });

    // Sanity: registry record still pins the worker path. This is what
    // populates `protectedPaths` and lets evaluateWorkspacePath match.
    const registryBefore = await readRegistryWorkspaces(tempDir);
    expect(registryBefore[0]?.worktrees).toMatchObject({
      worker: { path: workerPath },
    });

    // Sanity: the recreated candidate exists but is not registered with git
    // and has no metadata/.git marker, so the earlier skip gates in
    // reconcileDispatchWorkspaceArtifacts do not short-circuit it.
    const worktreeListing = git(tempDir, "worktree list --porcelain");
    expect(worktreeListing.includes(workerPath)).toBe(false);
    await expect(fs.access(path.join(workerPath, WORKSPACE_METADATA_FILE))).rejects.toThrow();
    await expect(fs.access(path.join(workerPath, ".git"))).rejects.toThrow();

    const diag = captureDispatchCleanupDiagnostics();
    let diagnostics: string[] = [];
    try {
      await reconcileDispatchWorkspaceArtifacts(tempDir);
      diagnostics = diag.capture();
    } finally {
      diag.restore();
    }

    // Candidate dir survives root-directory pruning because the helper
    // saw the path overlap with the protected worker record.
    await fs.access(workerPath);

    // The root-directory surface emitted a preserve diagnostic identifying
    // the surface label, the preserved path, and the overlap reason from
    // the protection helper. Without the `protection.evaluateWorkspacePath`
    // consultation in root-directory pruning this diagnostic would not exist
    // (and the dir would be deleted).
    expect(
      diagnostics.some(
        (line) =>
          line.includes("root-directory") &&
          line.includes(workerPath) &&
          line.includes("overlaps non-closed workspace path"),
      ),
    ).toBe(true);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // Cleanup-positive control: closed records are still removed when no
  // protection source applies, so the conservative policy does not
  // permanently disable cleanup.
  it("removes a truly orphan dispatch branch with no registry record and no active task ref", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    git(tempDir, "branch dispatch/task/truly-orphan-cleanup-positive/01orphan");

    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    expect(git(tempDir, "branch --list dispatch/task/truly-orphan-cleanup-positive/01orphan")).toBe(
      "",
    );
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  it("removes a truly orphan reviewer snapshot worktree when no registry record references it", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const reviewerDir = path.join(
      tempDir,
      ".kspec-worktrees",
      "task-orphan-reviewer-snapshot-review",
    );
    await fs.mkdir(path.dirname(reviewerDir), { recursive: true });
    git(tempDir, `worktree add --detach ${reviewerDir} HEAD`);
    await fs.access(reviewerDir);

    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await expect(fs.access(reviewerDir)).rejects.toThrow();
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  it("removes a truly orphan root-directory entry that no workspace path overlaps", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const orphanRoot = path.join(tempDir, ".kspec-worktrees", "task-truly-orphan-root-candidate");
    await fs.mkdir(orphanRoot, { recursive: true });
    await fs.writeFile(path.join(orphanRoot, "leftover.txt"), "orphan\n", "utf-8");

    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await expect(fs.access(orphanRoot)).rejects.toThrow();
  });

  // AC: @dispatch-workspace-cleanup-policy ac-corrupt-metadata-cleanup-eligible
  // Regression: a dispatcher-managed worktree whose .kspec-dispatch-workspace.json
  // is unparseable must be classified as cleanup-eligible (not preserved
  // indefinitely) when the registry is loaded successfully, no non-closed
  // record protects the workspace, and no activeTaskIds option protects the
  // task. Without this classification the artifact would survive every
  // reconciliation pass and silently accumulate as dispatch-owned cruft under
  // the worktree root.
  it("removes a dispatcher-managed worktree with corrupt metadata when no protection source applies", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 50)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Corrupt Metadata Cleanup",
        slugs: ["task-corrupt-metadata-cleanup"],
      },
    });

    // Corrupt the on-disk metadata so it cannot be parsed. The registry loads
    // successfully (no parse error) but contains no record protecting this
    // workspace, and no activeTaskIds option is supplied. Under the clarified
    // policy this is a "trusted registry/protection state + untrusted artifact
    // metadata + no protected owner" classification — cleanup-eligible.
    await fs.writeFile(
      workspaceMetadataPath(workspace.cwd),
      "{ not-valid-json: ${tempDir} <<<corrupt>>>",
      "utf-8",
    );
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await expect(fs.access(workspace.cwd)).rejects.toThrow();
    expect(git(tempDir, "branch --list dispatch/task/task-corrupt-metadata-cleanup/01task00")).toBe(
      "",
    );
    expect(git(tempDir, "worktree list --porcelain")).not.toContain(`worktree ${workspace.cwd}`);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-dispatch-root-unknown-entries-owned
  // Regression: both unknown files and unknown directories placed directly
  // under the configured dispatch worktree root must be classified as
  // dispatch-owned garbage when registry/protection state is trusted and no
  // protected workspace path equals or contains them. The earlier behavior
  // preserved unknown root entries as user/operator data — that defeated the
  // dispatch-owned ownership contract for the worktree root.
  it("removes unknown files and directories directly under the worktree root when no workspace path overlaps", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const worktreeRoot = path.join(tempDir, ".kspec-worktrees");
    await fs.mkdir(worktreeRoot, { recursive: true });

    const unknownFile = path.join(worktreeRoot, "scratch-note.txt");
    await fs.writeFile(unknownFile, "operator scratch\n", "utf-8");

    const unknownDir = path.join(worktreeRoot, "scratch-dir");
    await fs.mkdir(unknownDir, { recursive: true });
    await fs.writeFile(path.join(unknownDir, "inner.txt"), "inner\n", "utf-8");

    // Registry loads successfully and contains no record. With no
    // activeTaskIds option and no protected path overlap, both entries
    // classify as dispatch-owned garbage.
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await expect(fs.access(unknownFile)).rejects.toThrow();
    await expect(fs.access(unknownDir)).rejects.toThrow();
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  it("reaps a closing workspace with no active ownership and resolved integration", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 46)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Closing Resolved Integration Reaped",
        slugs: ["task-closing-resolved-integration-reaped"],
      },
    });

    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: {
        title: "Closing Resolved Integration Reaped",
        slugs: ["task-closing-resolved-integration-reaped"],
      },
    });

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await expect(fs.access(workspace.cwd)).rejects.toThrow();
    expect(
      git(tempDir, "branch --list dispatch/task/task-closing-resolved-integration-reaped/01task00"),
    ).toBe("");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  it("preserves the canonical dispatch branch when the registry file is unreadable due to permissions", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    // Reserve a dispatch branch the way the engine would; do not write any
    // registry record.
    const reservedBranch = "dispatch/task/task-registry-load-failed-branch/01reserve";
    git(tempDir, `branch ${reservedBranch}`);

    // Corrupt the registry so load fails — branch sweep must enter
    // no-blind-deletion mode for dispatch-branch surface.
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      "kynetic_dispatch_workspaces: 1.0\nworkspaces: [\n  {invalid: yaml,\n",
      "utf-8",
    );

    const diag = captureDispatchCleanupDiagnostics();
    let diagnostics: string[] = [];
    try {
      await reconcileDispatchWorkspaceArtifacts(tempDir);
      diagnostics = diag.capture();
    } finally {
      diag.restore();
    }

    expect(git(tempDir, `branch --list ${reservedBranch}`)).toContain(reservedBranch);
    expect(
      diagnostics.some(
        (line) =>
          line.includes("dispatch-branch") &&
          line.includes(reservedBranch) &&
          /registry/.test(line),
      ),
    ).toBe(true);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  // Behavioral guardrail: every destructive surface must reach the protected
  // decision through the centralized helper. This drives each surface
  // (metadata-less-worktree, reviewer-snapshot, root-directory, dispatch-branch)
  // in one pass to prove the protection helper is wired in across all of them.
  it("emits a preservation diagnostic for each destructive cleanup surface in a single pass under active protection", async () => {
    await seedRepo(tempDir);
    await setupProjectWithReviewerAgent(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 47)}`;
    const workerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Multi Surface Diagnostic",
        slugs: ["task-multi-surface-diagnostic"],
      },
    });
    const reviewerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: {
        title: "Multi Surface Diagnostic",
        slugs: ["task-multi-surface-diagnostic"],
      },
    });
    // Reserve an extra unrelated dispatch branch under the same short-id so
    // the dispatch-branch surface has something to evaluate without a record.
    const reservedBranch = "dispatch/task/task-multi-surface-diagnostic-extra/01task00";
    git(tempDir, `branch ${reservedBranch}`);
    // Pre-create a bare root-directory candidate (no .git marker, no
    // metadata) that ALSO shares the active short-id so the root-directory
    // surface evaluates it through the protection helper.
    const rootCandidate = path.join(
      tempDir,
      ".kspec-worktrees",
      "task-multi-surface-diagnostic-extra-01task00",
    );
    await fs.mkdir(rootCandidate, { recursive: true });

    // Strip metadata and clear the registry so every surface re-classifies
    // against the active task ref protection source.
    await fs.rm(workspaceMetadataPath(workerWorkspace.cwd), { force: true });
    await fs.rm(workspaceMetadataPath(reviewerWorkspace.cwd), { force: true });
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    const diag = captureDispatchCleanupDiagnostics();
    let diagnostics: string[] = [];
    try {
      await reconcileDispatchWorkspaceArtifacts(tempDir, { activeTaskIds: [taskRef] });
      diagnostics = diag.capture();
    } finally {
      diag.restore();
    }

    // All four surfaces below evaluate at least one artifact through the
    // protection helper and must emit a preservation diagnostic identifying
    // their surface.
    for (const surface of [
      "metadata-less-worktree",
      "reviewer-snapshot",
      "root-directory",
      "dispatch-branch",
    ] as const) {
      expect(diagnostics.some((line) => line.includes(surface))).toBe(true);
    }

    // Filesystem state confirms preservation outcome matches the diagnostic.
    await fs.access(workerWorkspace.cwd);
    await fs.access(reviewerWorkspace.cwd);
    await fs.access(rootCandidate);
    expect(git(tempDir, `branch --list ${reservedBranch}`)).toContain(reservedBranch);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  // Regression: bootstrap-like nested files under a worker workspace must
  // survive reconcileDispatchWorkspaceArtifacts() when the task ref is
  // protected as in-flight, even when neither metadata nor a registry record
  // is present. This mirrors the queue-to-spawn bootstrap race where
  // `npm install` is mid-write inside a worker workspace that has not yet
  // committed its provisioning artifacts.
  it("preserves bootstrap-like nested files under a worker workspace while the task is in-flight (regression)", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 48)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Bootstrap Race Regression",
        slugs: ["task-bootstrap-race-regression"],
      },
    });

    // Bootstrap-like fixture: package.json + a nested binary symlink target
    // that npm/pnpm/yarn would have created. These are dispatcher-managed
    // tree contents that cleanup must never blow away while the spawn is
    // still in-flight.
    const nodeModulesDir = path.join(workspace.cwd, "node_modules", "some-dep", "bin");
    await fs.mkdir(nodeModulesDir, { recursive: true });
    const sentinelFiles = [
      path.join(workspace.cwd, "package.json"),
      path.join(nodeModulesDir, "tool.js"),
      path.join(workspace.cwd, "node_modules", "some-dep", "package.json"),
    ];
    await fs.writeFile(sentinelFiles[0]!, '{"name":"bootstrap-race-regression"}\n', "utf-8");
    await fs.writeFile(sentinelFiles[1]!, "console.log('hi')\n", "utf-8");
    await fs.writeFile(sentinelFiles[2]!, '{"name":"some-dep","version":"1.0.0"}\n', "utf-8");

    // Simulate the queue-to-spawn window: metadata removed mid-provisioning,
    // and the registry not yet written. Only the in-memory in-flight task
    // ref signals that this workspace must be protected.
    await fs.rm(workspaceMetadataPath(workspace.cwd), { force: true });
    await fs.writeFile(
      path.join(tempDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    await reconcileDispatchWorkspaceArtifacts(tempDir, {
      activeTaskIds: [taskRef],
    });

    // Parent worker workspace and every nested bootstrap file must survive.
    await fs.access(workspace.cwd);
    for (const file of sentinelFiles) {
      await fs.access(file);
    }
    // Canonical dispatch branch must also survive the in-flight window.
    expect(
      git(tempDir, "branch --list dispatch/task/task-bootstrap-race-regression/01task00"),
    ).toContain("dispatch/task/task-bootstrap-race-regression/01task00");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  // Helper-level: a load-failed registry snapshot must mark dispatcher-managed
  // artifacts as preserved with an actionable diagnostic instead of returning
  // delete. Exercising the pure helper protects the policy contract even if
  // future cleanup surfaces are added.
  it("classifies a load-failed registry snapshot as no-blind-deletion across surfaces", () => {
    const protection = buildDispatchArtifactProtectionState({
      worktreeRoot: "/projects/example/.kspec-worktrees",
      activeOrInFlightTaskRefs: [],
      registry: {
        status: "load-failed",
        reason: "YAML parse error at line 3",
      },
    });

    expect(protection.registryTrusted).toBe(false);
    expect(protection.registryFailureDiagnostic).toMatch(/YAML parse error/);

    const branchDecision = protection.evaluateDispatchBranch("dispatch/task/some-task/01abcdef");
    expect(branchDecision.preserve).toBe(true);
    expect(branchDecision.reason).toMatch(/YAML parse error/);

    const pathDecision = protection.evaluateWorkspacePath(
      "/projects/example/.kspec-worktrees/some-task-01abcdef",
    );
    expect(pathDecision.preserve).toBe(true);
    expect(pathDecision.reason).toMatch(/YAML parse error/);

    // Non-dispatch artifacts outside the worktree root remain deletable so
    // the conservative policy does not over-preserve foreign paths/branches.
    const foreignBranch = protection.evaluateDispatchBranch("feat/foreign-branch");
    expect(foreignBranch.preserve).toBe(false);
    const foreignPath = protection.evaluateWorkspacePath("/elsewhere/cache");
    expect(foreignPath.preserve).toBe(false);
  });
});

// AC: @trait-error-guidance ac-1 — N/A: cleanup runs in the dispatch runtime and reports through task notes/logging, not direct CLI errors.
// AC: @trait-error-guidance ac-2 — N/A: dispatcher guidance is recorded in metadata/task notes rather than a user-facing command response here.
// AC: @trait-error-guidance ac-3 — N/A: cleanup reconciliation does not surface reference lookup errors to a direct CLI caller in this module test.
// AC: @trait-error-guidance ac-4 — N/A: invalid task state transitions are enforced by task commands, not by workspace cleanup helpers.
// AC: @trait-error-guidance ac-5 — N/A: cleanup helpers do not expose field-validation error payloads in this library-level path.
// AC: @trait-error-guidance ac-6 — N/A: workspace cleanup helpers do not implement a JSON CLI error mode.
