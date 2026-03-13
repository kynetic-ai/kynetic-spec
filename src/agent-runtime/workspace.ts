import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { initContext } from "../parser/index.js";
import { acquireFileLock } from "../parser/file-lock.js";
import {
  findDispatchWorkspaceByTaskRef,
  getDispatchWorkspaceRegistryPath,
  loadDispatchWorkspaceRegistry,
  saveDispatchWorkspaceRecord,
  type LoadedDispatchWorkspaceRecord,
} from "../parser/dispatch-workspaces.js";
import { loadProjectConfig } from "../parser/config.js";
import { commitIfShadow } from "../parser/shadow.js";
import type {
  DispatchWorkspaceBootstrapState,
  DispatchWorkspaceBootstrapRoleState,
  DispatchWorkspaceBootstrapStepResult,
  DispatchWorkspaceCleanupState as RegistryCleanupState,
  DispatchWorkspaceHealthState,
  DispatchWorkspaceIntegrationState as RegistryIntegrationRecord,
  DispatchWorkspaceIntegrationStatus,
  DispatchWorkspaceIntegrationOutcome as RegistryIntegrationOutcome,
  DispatchWorkspaceIssue,
  DispatchWorkspaceLifecycleState,
  DispatchWorkspacePublicationMode as RegistryPublicationMode,
  DispatchWorkspaceRecord,
  DispatchWorkspaceRole as RegistryRole,
  DispatchWorkspaceWorktree,
} from "../schema/index.js";

const DISPATCH_WORKSPACE_METADATA_FILE = ".kspec-dispatch-workspace.json";
const DISPATCH_BRANCH_PREFIX = "dispatch/task/";
const DISPATCH_SHADOW_MUTATION_LOCK_FILE = ".kspec-dispatch-shadow-mutation";

interface GitResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface ResolvedDispatchWorkspaceConfig {
  baseBranch: string;
  baseBranchStartPoint: string;
  baseBranchSource: "configured" | "remote-head" | "current-branch" | "default";
  worktreeRoot: string;
}

export interface DispatchWorkspaceMetadata {
  workspaceId: string;
  taskRef: string;
  taskSlug: string;
  baseBranch: string;
  baseBranchPoint: string;
  mergeTargetBranch: string;
  integrationTargetBranch: string;
  integrationTargetCommit: string;
  canonicalBranch: string;
  canonicalBranchHead: string;
  publicationMode: DispatchWorkspacePublicationMode;
  integrationState: DispatchWorkspaceIntegrationState;
  integrationOutcome: DispatchWorkspaceIntegrationOutcome;
  integrationUpdatedAt: string;
  worktreeRoot: string;
  workerWorktreeDir: string;
  reviewerWorktreeDir: string | null;
  lifecycleState: DispatchWorkspaceLifecycleState;
  activeRole: RegistryRole | null;
  bootstrapState: DispatchWorkspaceBootstrapState;
  healthState: DispatchWorkspaceHealthState;
  cleanupState: RegistryCleanupState;
  healthStatus: "healthy" | "unhealthy";
  healthReason: string | null;
  bootstrap: DispatchWorkspaceBootstrapState;
  cleanupEligible: boolean;
  cleanupReason: string | null;
  cleanupScheduledAt: string | null;
  cleanupBlockedReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastReconciledAt: string | null;
  lastActiveAt: string | null;
  closedAt: string | null;
}

export interface DispatchWorkspaceHealth {
  exists: boolean;
  healthy: boolean;
  reason: string | null;
  metadata: DispatchWorkspaceMetadata | null;
}

export type DispatchWorkspaceRole = "worker" | "reviewer";

export type DispatchWorkspacePublicationMode = RegistryPublicationMode;

export type DispatchWorkspaceIntegrationState = DispatchWorkspaceIntegrationStatus;

export type DispatchWorkspaceIntegrationOutcome = RegistryIntegrationOutcome;

export type { DispatchWorkspaceBootstrapRoleState, DispatchWorkspaceBootstrapStepResult };

export function getDispatchShadowMutationLockPath(projectDir: string): string {
  return path.join(projectDir, DISPATCH_SHADOW_MUTATION_LOCK_FILE);
}

function emptyBootstrapRoleState(): DispatchWorkspaceBootstrapRoleState {
  return {
    status: "not_run",
    configHash: null,
    canonicalBranchHead: null,
    lastRunAt: null,
    invalidationReasons: [],
    steps: [],
    failureMessage: null,
  };
}

export function normalizeDispatchBootstrapState(
  bootstrap?: Partial<DispatchWorkspaceBootstrapState> | null,
): DispatchWorkspaceBootstrapState {
  const workerState = bootstrap?.roleStates?.worker ?? emptyBootstrapRoleState();
  const reviewerState = bootstrap?.roleStates?.reviewer ?? emptyBootstrapRoleState();
  const lastRole = bootstrap?.lastRole ?? null;

  if (!bootstrap?.roleStates && bootstrap) {
    const migrated: DispatchWorkspaceBootstrapRoleState = {
      status: bootstrap.status ?? "not_run",
      configHash: bootstrap.configHash ?? null,
      canonicalBranchHead: bootstrap.canonicalBranchHead ?? null,
      lastRunAt: bootstrap.lastRunAt ?? null,
      invalidationReasons: [...(bootstrap.invalidationReasons ?? [])],
      steps: [...(bootstrap.steps ?? [])],
      failureMessage: bootstrap.failureMessage ?? null,
    };
    if (lastRole === "reviewer") {
      return {
        ...migrated,
        lastRole,
        roleStates: {
          worker: emptyBootstrapRoleState(),
          reviewer: migrated,
        },
      };
    }
    return {
      ...migrated,
      lastRole: lastRole ?? "worker",
      roleStates: {
        worker: migrated,
        reviewer: emptyBootstrapRoleState(),
      },
    };
  }

  const activeRole = lastRole === "reviewer" ? "reviewer" : "worker";
  const activeState = activeRole === "reviewer" ? reviewerState : workerState;
  return {
    ...activeState,
    lastRole,
    roleStates: {
      worker: {
        ...workerState,
        invalidationReasons: [...workerState.invalidationReasons],
        steps: [...workerState.steps],
      },
      reviewer: {
        ...reviewerState,
        invalidationReasons: [...reviewerState.invalidationReasons],
        steps: [...reviewerState.steps],
      },
    },
  };
}

export interface ProvisionDispatchWorkspaceOptions {
  projectDir: string;
  taskRef: string;
  role?: DispatchWorkspaceRole;
  cleanupState?: ResolveDispatchWorkspaceCleanupStateOptions;
  task?: {
    title?: string;
    slugs?: string[];
  };
}

export interface ProvisionedDispatchWorkspace {
  cwd: string;
  metadataPath: string;
  metadata: DispatchWorkspaceMetadata;
}

export interface DispatchWorkspaceCleanupState {
  cleanupEligible: boolean;
  cleanupReason: string | null;
}

export interface DispatchWorkspaceReapResult {
  taskRef: string;
  action: "none" | "reviewer_cleaned" | "reaped" | "cleanup_blocked";
  blockedReason: string | null;
}

export interface ResolveDispatchWorkspaceCleanupStateOptions {
  integrationState?: "pending" | "in_progress" | "merged" | "abandoned" | "reset" | null;
  taskStatus?: "pending" | "in_progress" | "needs_work" | "pending_review" | "blocked" | "completed" | "cancelled" | null;
}

export interface ReconcileDispatchWorkspaceLifecycleOptions {
  projectDir: string;
  taskRef: string;
  cleanupState: ResolveDispatchWorkspaceCleanupStateOptions;
  task?: {
    title?: string;
    slugs?: string[];
  };
}

export class DispatchWorkspaceError extends Error {
  suggestion: string;

  constructor(message: string, suggestion: string) {
    super(message);
    this.name = "DispatchWorkspaceError";
    this.suggestion = suggestion;
  }
}

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
  };
}

function resolveDispatchMutationLockTimeoutMs(): number | undefined {
  const raw = process.env.KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function runGitOrThrow(
  cwd: string,
  args: string[],
  message: string,
  suggestion: string,
): string {
  const result = runGit(cwd, args);
  if (result.status === 0) {
    return result.stdout;
  }
  const detail = result.stderr || result.stdout || "git command failed";
  throw new DispatchWorkspaceError(`${message}: ${detail}`, suggestion);
}

function listGitRemotes(projectDir: string): string[] {
  const result = runGit(projectDir, ["remote"]);
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  const remotes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const originFirst = remotes.filter((remote) => remote === "origin");
  const rest = remotes.filter((remote) => remote !== "origin");
  return [...originFirst, ...rest];
}

function refExists(projectDir: string, ref: string): boolean {
  const result = runGit(projectDir, ["show-ref", "--verify", "--quiet", ref]);
  return result.status === 0;
}

function resolveBranchStartPoint(
  projectDir: string,
  branch: string,
): { startPoint: string; branch: string } | null {
  if (refExists(projectDir, `refs/heads/${branch}`)) {
    return { startPoint: branch, branch };
  }

  for (const remote of listGitRemotes(projectDir)) {
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    if (refExists(projectDir, remoteRef)) {
      return { startPoint: `${remote}/${branch}`, branch };
    }
  }

  return null;
}

function resolveRemoteHeadBranch(projectDir: string): string | null {
  for (const remote of listGitRemotes(projectDir)) {
    const result = runGit(projectDir, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
    if (result.status !== 0 || !result.stdout) continue;
    const prefix = `refs/remotes/${remote}/`;
    if (result.stdout.startsWith(prefix)) {
      return result.stdout.slice(prefix.length);
    }
  }
  return null;
}

function resolveCurrentBranch(projectDir: string): string | null {
  const result = runGit(projectDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

function normalizeTaskSlug(taskRef: string, task?: { title?: string; slugs?: string[] }): string {
  const preferred = task?.slugs?.[0] ?? task?.title ?? taskRef.replace(/^@/, "task");
  const normalized = preferred
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
  return normalized || "task";
}

function shortTaskId(taskRef: string): string {
  return taskRef.replace(/^@/, "").slice(0, 8).toLowerCase();
}

function workspaceIdFor(taskRef: string): string {
  return `dispatch-workspace-${taskRef.replace(/^@/, "")}`;
}

function resolveCommit(cwd: string, ref: string): string {
  return runGitOrThrow(
    cwd,
    ["rev-parse", `${ref}^{commit}`],
    `Failed to resolve commit for "${ref}"`,
    "Inspect the dispatch branch/base branch references and retry.",
  );
}

function metadataPathFor(worktreeDir: string): string {
  return path.join(worktreeDir, DISPATCH_WORKSPACE_METADATA_FILE);
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  return result.status === 0;
}

function hasGitHubRemote(projectDir: string): boolean {
  for (const remote of listGitRemotes(projectDir)) {
    const result = runGit(projectDir, ["remote", "get-url", remote]);
    if (result.status !== 0 || !result.stdout) {
      continue;
    }
    if (
      result.stdout.includes("github.com/") ||
      result.stdout.includes("github.com:")
    ) {
      return true;
    }
  }
  return false;
}

function resolvePublicationMode(projectDir: string): DispatchWorkspacePublicationMode {
  return commandAvailable("gh") && hasGitHubRemote(projectDir)
    ? "pull_request"
    : "manual_merge";
}

function resolveWorkspacePublicationMode(
  projectDir: string,
  existingRecord: LoadedDispatchWorkspaceRecord | undefined,
): DispatchWorkspacePublicationMode {
  if (!existingRecord) {
    return resolvePublicationMode(projectDir);
  }

  switch (existingRecord.integration.status) {
    case "pending":
    case "in_progress":
      return resolvePublicationMode(projectDir);
    default:
      return existingRecord.integration.publication_mode;
  }
}

function isDispatchBranch(branch: string | null | undefined): branch is string {
  return Boolean(branch && branch.startsWith(DISPATCH_BRANCH_PREFIX));
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readWorkspaceMetadata(worktreeDir: string): Promise<DispatchWorkspaceMetadata | null> {
  try {
    const raw = await fs.readFile(metadataPathFor(worktreeDir), "utf-8");
    return JSON.parse(raw) as DispatchWorkspaceMetadata;
  } catch {
    return null;
  }
}

async function writeWorkspaceMetadata(
  worktreeDir: string,
  metadata: DispatchWorkspaceMetadata,
): Promise<string> {
  const metadataPath = metadataPathFor(worktreeDir);
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  return metadataPath;
}

function resolveIntegrationOutcome(
  publicationMode: DispatchWorkspacePublicationMode,
  integrationState: DispatchWorkspaceIntegrationState,
): DispatchWorkspaceIntegrationOutcome {
  switch (integrationState) {
    case "merged":
      return "merged";
    case "abandoned":
      return "abandoned";
    case "reset":
      return "reset";
    case "pending":
    default:
      return publicationMode === "pull_request" ? "pull_request" : "manual_merge";
  }
}

function parseWorktreeList(projectDir: string): Array<{ path: string; branch: string | null }> {
  const result = runGit(projectDir, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  const entries: Array<{ path: string; branch: string | null }> = [];
  const blocks = result.stdout.split(/\n\s*\n/).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!worktreePath) continue;
    const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? null;
    entries.push({ path: worktreePath, branch: branchRef });
  }
  return entries;
}

function normalizeBranchRef(branch: string | null | undefined): string | null {
  return branch ? branch.replace(/^refs\/heads\//, "") : null;
}

function findExistingWorktreeForBranch(projectDir: string, canonicalBranch: string): string | null {
  const branchRef = `refs/heads/${canonicalBranch}`;
  return parseWorktreeList(projectDir).find((entry) => entry.branch === branchRef)?.path ?? null;
}

function findWorktreeByPath(projectDir: string, worktreeDir: string): { path: string; branch: string | null } | null {
  const normalized = path.resolve(worktreeDir);
  return parseWorktreeList(projectDir).find((entry) => path.resolve(entry.path) === normalized) ?? null;
}

function pathExists(targetPath: string): boolean {
  return spawnSync("bash", ["-lc", `test -e "${targetPath.replace(/(["\\$`])/g, "\\$1")}"`], {
    stdio: "ignore",
  }).status === 0;
}

function defaultBootstrapState(now: string): DispatchWorkspaceBootstrapState {
  return {
    ...emptyBootstrapRoleState(),
    lastRole: null,
    roleStates: {
      worker: emptyBootstrapRoleState(),
      reviewer: emptyBootstrapRoleState(),
    },
  };
}

function createCleanupRecord(
  state: DispatchWorkspaceCleanupState,
  now: string,
): RegistryCleanupState {
  return {
    status: state.cleanupEligible ? "scheduled" : "not_scheduled",
    eligible: state.cleanupEligible,
    reason: state.cleanupReason,
    detail: state.cleanupReason,
    updated_at: now,
  };
}

function resolveCleanupRecord(
  cleanupState: ResolveDispatchWorkspaceCleanupStateOptions | undefined,
  existingRecord: LoadedDispatchWorkspaceRecord | undefined,
  now: string,
): RegistryCleanupState {
  if (cleanupState) {
    return createCleanupRecord(
      resolveDispatchWorkspaceCleanupState(cleanupState),
      now,
    );
  }
  if (existingRecord) {
    return {
      ...existingRecord.cleanup,
      updated_at: now,
    };
  }
  return createCleanupRecord(resolveDispatchWorkspaceCleanupState({}), now);
}

function resolveIntegrationRecord(
  targetBranch: string,
  targetCommit: string,
  publicationMode: DispatchWorkspacePublicationMode,
  cleanupState: ResolveDispatchWorkspaceCleanupStateOptions | undefined,
  existingRecord: LoadedDispatchWorkspaceRecord | undefined,
  now: string,
): RegistryIntegrationRecord {
  const status = cleanupState?.integrationState ?? existingRecord?.integration.status ?? "pending";
  return {
    status,
    target_branch: targetBranch,
    target_commit: existingRecord?.integration.target_commit ?? targetCommit,
    publication_mode: publicationMode,
    outcome: resolveIntegrationOutcome(publicationMode, status),
    detail: cleanupState?.integrationState ? `integration:${cleanupState.integrationState}` : existingRecord?.integration.detail ?? null,
    updated_at: now,
  };
}

function resolveRegistryStateForTaskStatus(
  taskStatus: ResolveDispatchWorkspaceCleanupStateOptions["taskStatus"],
  existingRecord: LoadedDispatchWorkspaceRecord,
  now: string,
): {
  integration: RegistryIntegrationRecord;
  cleanup: RegistryCleanupState;
} {
  if (taskStatus === "completed") {
    const cleanupState = {
      integrationState: "merged" as const,
      taskStatus,
    };
    return {
      integration: resolveIntegrationRecord(
        existingRecord.integration.target_branch,
        existingRecord.integration.target_commit,
        existingRecord.integration.publication_mode,
        cleanupState,
        existingRecord,
        now,
      ),
      cleanup: existingRecord.cleanup.status === "blocked"
        || existingRecord.cleanup.status === "completed"
        ? {
            ...existingRecord.cleanup,
            updated_at: now,
          }
        : resolveCleanupRecord(cleanupState, existingRecord, now),
    };
  }

  if (taskStatus === "cancelled") {
    const cleanupState = {
      integrationState: "abandoned" as const,
      taskStatus,
    };
    return {
      integration: resolveIntegrationRecord(
        existingRecord.integration.target_branch,
        existingRecord.integration.target_commit,
        existingRecord.integration.publication_mode,
        cleanupState,
        existingRecord,
        now,
      ),
      cleanup: existingRecord.cleanup.status === "blocked"
        || existingRecord.cleanup.status === "completed"
        ? {
            ...existingRecord.cleanup,
            updated_at: now,
          }
        : resolveCleanupRecord(cleanupState, existingRecord, now),
    };
  }

  const shouldResetLifecycle = existingRecord.lifecycle_state === "closing"
    || existingRecord.integration.status === "merged"
    || existingRecord.integration.status === "abandoned"
    || existingRecord.cleanup.status !== "not_scheduled"
    || existingRecord.cleanup.eligible;
  if (taskStatus && shouldResetLifecycle) {
    const cleanupState = {
      integrationState: "reset" as const,
      taskStatus,
    };
    return {
      integration: resolveIntegrationRecord(
        existingRecord.integration.target_branch,
        existingRecord.integration.target_commit,
        existingRecord.integration.publication_mode,
        cleanupState,
        existingRecord,
        now,
      ),
      cleanup: resolveCleanupRecord(cleanupState, existingRecord, now),
    };
  }

  return {
    integration: {
      ...existingRecord.integration,
      updated_at: now,
    },
    cleanup: {
      ...existingRecord.cleanup,
      updated_at: now,
    },
  };
}

function resolveLifecycleState(
  taskStatus: ResolveDispatchWorkspaceCleanupStateOptions["taskStatus"],
  health: DispatchWorkspaceHealthState,
  integration: RegistryIntegrationRecord,
  cleanup: RegistryCleanupState,
  activeRole: RegistryRole | null,
): DispatchWorkspaceLifecycleState {
  const resetReopenedTask = integration.status === "reset"
    && taskStatus !== null
    && taskStatus !== "completed"
    && taskStatus !== "cancelled";
  if (cleanup.status === "completed") return "closed";
  if (cleanup.status === "blocked") return "cleanup_blocked";
  if (health.status !== "healthy") return "stale";
  if (!resetReopenedTask && (cleanup.eligible || integration.status === "merged" || integration.status === "abandoned")) {
    return "closing";
  }
  if (activeRole === "reviewer") return "integrating";
  if (activeRole === "worker") return "active";
  if (integration.status === "in_progress" || taskStatus === "pending_review") {
    return "integrating";
  }
  return "ready";
}

function createHealthyState(now: string): DispatchWorkspaceHealthState {
  return {
    status: "healthy",
    summary: "Workspace record matches current git branch and worktree state.",
    issues: [],
    updated_at: now,
  };
}

function buildIssue(
  code: string,
  message: string,
  suggestion: string,
): DispatchWorkspaceIssue {
  return {
    code,
    message,
    suggestion,
  };
}

function reconcileWorkspaceHealth(
  projectDir: string,
  record: DispatchWorkspaceRecord,
  now: string,
): DispatchWorkspaceHealthState {
  const issues: DispatchWorkspaceIssue[] = [];
  const branchRef = `refs/heads/${record.canonical_branch}`;
  const branchExists = refExists(projectDir, branchRef);
  if (!branchExists) {
    issues.push(buildIssue(
      "missing_canonical_branch",
      `Canonical branch "${record.canonical_branch}" is missing.`,
      "Re-provision the workspace or restore the branch before dispatch resumes.",
    ));
  }

  const workerRegistered = findExistingWorktreeForBranch(projectDir, record.canonical_branch);
  const workerExists = pathExists(record.worktrees.worker.path);
  if (!workerExists || (!workerRegistered && record.lifecycle_state !== "closed")) {
    issues.push(buildIssue(
      "missing_worker_worktree",
      `Worker worktree "${record.worktrees.worker.path}" is missing or no longer registered.`,
      "Re-provision the worker worktree from the recorded canonical branch.",
    ));
  }

  if (record.worktrees.reviewer) {
    const reviewerRegistered = findWorktreeByPath(projectDir, record.worktrees.reviewer.path);
    const reviewerExists = pathExists(record.worktrees.reviewer.path);
    if (!reviewerExists || !reviewerRegistered) {
      issues.push(buildIssue(
        "missing_reviewer_worktree",
        `Reviewer worktree "${record.worktrees.reviewer.path}" is missing or no longer registered.`,
        "Recreate the detached reviewer snapshot before running review again.",
      ));
    }
  }

  if (issues.length === 0) {
    return createHealthyState(now);
  }

  const invalid = issues.some((issue) => issue.code === "missing_canonical_branch");
  return {
    status: invalid ? "invalid" : "stale",
    summary: invalid
      ? "Workspace registry record is invalid because required git state is missing."
      : "Workspace registry record is stale and needs reconciliation.",
    issues,
    updated_at: now,
  };
}

function toMetadata(record: DispatchWorkspaceRecord): DispatchWorkspaceMetadata {
  const bootstrapState = normalizeDispatchBootstrapState(record.bootstrap);
  const primaryBootstrapState =
    bootstrapState.lastRole === "reviewer"
      ? bootstrapState.roleStates.reviewer
      : bootstrapState.roleStates.worker;
  const healthStatus =
    primaryBootstrapState.status === "failed"
      ? "unhealthy"
      : record.health.status === "healthy" && !record.cleanup.eligible
        ? "healthy"
        : "unhealthy";
  const healthReason =
    primaryBootstrapState.failureMessage
    ?? (record.cleanup.eligible ? record.cleanup.reason ?? "workspace-marked-for-cleanup" : null)
    ?? (record.health.issues[0]?.message ?? null);
  return {
    workspaceId: record.workspace_id,
    taskRef: record.task_ref,
    taskSlug: record.task_slug,
    baseBranch: record.resolved_base_branch,
    baseBranchPoint: record.base_branch_point,
    mergeTargetBranch: record.integration.target_branch,
    integrationTargetBranch: record.integration.target_branch,
    integrationTargetCommit: record.integration.target_commit,
    canonicalBranch: record.canonical_branch,
    canonicalBranchHead: record.canonical_branch_head,
    publicationMode: record.integration.publication_mode,
    integrationState: record.integration.status,
    integrationOutcome: record.integration.outcome,
    integrationUpdatedAt: record.integration.updated_at,
    worktreeRoot: record.worktree_root,
    workerWorktreeDir: record.worktrees.worker.path,
    reviewerWorktreeDir: record.worktrees.reviewer?.path ?? null,
    lifecycleState: record.lifecycle_state,
    activeRole: record.active_role ?? null,
    bootstrapState,
    healthState: record.health,
    cleanupState: record.cleanup,
    healthStatus,
    healthReason,
    bootstrap: bootstrapState,
    cleanupEligible: record.cleanup.eligible,
    cleanupReason: record.cleanup.reason ?? null,
    cleanupScheduledAt: record.cleanup.eligible
      ? (record.timestamps.closed_at ?? record.cleanup.updated_at)
      : null,
    cleanupBlockedReason: record.cleanup.status === "blocked"
      ? (record.cleanup.reason ?? record.cleanup.detail ?? null)
      : null,
    createdAt: record.timestamps.created_at,
    updatedAt: record.timestamps.updated_at,
    lastReconciledAt: record.timestamps.last_reconciled_at ?? null,
    lastActiveAt: record.timestamps.last_active_at ?? null,
    closedAt: record.timestamps.closed_at ?? null,
  };
}

async function loadWorkspaceRecord(
  projectDir: string,
  taskRef: string,
): Promise<LoadedDispatchWorkspaceRecord | undefined> {
  const ctx = await initContext(projectDir);
  return findDispatchWorkspaceByTaskRef(ctx, taskRef, { includeClosed: true });
}

async function persistWorkspaceRecord(
  projectDir: string,
  record: DispatchWorkspaceRecord,
): Promise<string> {
  const lockPath = getDispatchShadowMutationLockPath(projectDir);
  const timeoutMs = resolveDispatchMutationLockTimeoutMs();
  let registryPath = "";

  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireFileLock(lockPath, timeoutMs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DispatchWorkspaceError(
      `Dispatch shadow mutation lock unavailable while persisting workspace registry for ${record.task_ref}: ${reason}`,
      `Wait for the overlapping kspec mutation to finish, or remove ${path.basename(lockPath)}.lock if the lock holder is gone.`,
    );
  }

  try {
    const ctx = await initContext(projectDir);
    registryPath = getDispatchWorkspaceRegistryPath(ctx);
    await saveDispatchWorkspaceRecord(ctx, {
      ...record,
      _sourceFile: registryPath,
    });

    if (ctx.shadow?.enabled) {
      const committed = await commitIfShadow(
        ctx.shadow,
        "dispatch-workspace-registry",
        record.task_ref,
      );
      if (!committed) {
        const shadowStatus = runGit(ctx.shadow.worktreeDir, ["status", "--porcelain"]);
        const hasPendingShadowChanges = shadowStatus.status !== 0 || shadowStatus.stdout.trim().length > 0;
        if (hasPendingShadowChanges) {
          throw new DispatchWorkspaceError(
            `Dispatch workspace registry write succeeded but could not be durably committed on the shadow branch for ${record.task_ref}.`,
            "Resolve the shadow branch commit issue, then rerun dispatch reconciliation or workspace provisioning so the registry state becomes durable.",
          );
        }
      }
    }
  } finally {
    await release?.();
  }

  const workerDir = record.worktrees.worker.path;
  if (workerDir && pathExists(workerDir)) {
    await writeWorkspaceMetadata(workerDir, toMetadata(record));
  }

  return registryPath;
}

export async function persistDispatchWorkspaceMetadata(
  projectDir: string,
  metadata: DispatchWorkspaceMetadata,
): Promise<string> {
  const existingRecord = await loadWorkspaceRecord(projectDir, metadata.taskRef);
  if (!existingRecord) {
    throw new DispatchWorkspaceError(
      `Cannot persist dispatch metadata for ${metadata.taskRef}: workspace registry record is missing.`,
      "Re-provision the dispatch workspace before retrying bootstrap persistence.",
    );
  }

  const now = metadata.updatedAt || new Date().toISOString();
  return persistWorkspaceRecord(projectDir, {
    ...existingRecord,
    task_slug: metadata.taskSlug,
    base_branch_point: metadata.baseBranchPoint,
    canonical_branch_head: metadata.canonicalBranchHead,
    bootstrap: normalizeDispatchBootstrapState(metadata.bootstrap),
    timestamps: {
      ...existingRecord.timestamps,
      updated_at: now,
      last_reconciled_at: metadata.lastReconciledAt ?? existingRecord.timestamps.last_reconciled_at,
      last_active_at: metadata.lastActiveAt ?? existingRecord.timestamps.last_active_at,
      closed_at: metadata.closedAt ?? existingRecord.timestamps.closed_at,
    },
  });
}

async function findWorkspaceRegistrationByTaskRef(
  projectDir: string,
  taskRef: string,
  task?: { title?: string; slugs?: string[] },
): Promise<{ canonicalBranch: string; workerWorktreeDir: string; metadata: DispatchWorkspaceMetadata } | null> {
  const slug = normalizeTaskSlug(taskRef, task);
  const shortId = shortTaskId(taskRef);
  const canonicalBranch = `dispatch/task/${slug}/${shortId}`;
  const workerWorktreeDir = findExistingWorktreeForBranch(projectDir, canonicalBranch);
  if (!workerWorktreeDir) {
    return null;
  }

  const metadata = await readWorkspaceMetadata(workerWorktreeDir);
  if (!metadata) {
    return null;
  }

  return { canonicalBranch, workerWorktreeDir, metadata };
}

async function recoverWorkspaceRecordFromMetadata(
  projectDir: string,
  resolvedConfig: ResolvedDispatchWorkspaceConfig,
  candidatePath: string,
): Promise<DispatchWorkspaceRecord | null> {
  const metadata = await readWorkspaceMetadata(candidatePath);
  if (!metadata) {
    return null;
  }

  const existingRecord = await loadWorkspaceRecord(projectDir, metadata.taskRef);
  if (existingRecord) {
    return existingRecord;
  }

  const workerWorktreeDir = path.resolve(metadata.workerWorktreeDir || candidatePath);
  if (!isPathInside(resolvedConfig.worktreeRoot, workerWorktreeDir)) {
    return null;
  }

  const workerRegistration = findWorktreeByPath(projectDir, workerWorktreeDir);
  const reviewerWorktreeDir = metadata.reviewerWorktreeDir
    ? path.resolve(metadata.reviewerWorktreeDir)
    : null;
  const reviewerRegistration = reviewerWorktreeDir
    ? findWorktreeByPath(projectDir, reviewerWorktreeDir)
    : null;
  if (!workerRegistration && !reviewerRegistration) {
    return null;
  }

  const taskSlug = normalizeTaskSlug(metadata.taskRef, {
    title: metadata.taskSlug,
    slugs: [metadata.taskSlug],
  });
  const canonicalBranch = isDispatchBranch(metadata.canonicalBranch)
    ? metadata.canonicalBranch
    : `dispatch/task/${taskSlug}/${shortTaskId(metadata.taskRef)}`;
  const currentWorkerBranch = normalizeBranchRef(workerRegistration?.branch);

  if (workerRegistration && currentWorkerBranch !== canonicalBranch) {
    try {
      runGitOrThrow(
        workerWorktreeDir,
        ["checkout", "-B", canonicalBranch],
        `Failed to normalize legacy dispatch branch for ${metadata.taskRef}`,
        "Repair or remove the legacy dispatch worktree before retrying reconciliation.",
      );
    } catch {
      // Persist a stale record below so the dispatcher can surface a concrete
      // task-linked recovery path instead of silently dropping the workspace.
    }
  }

  const now = new Date().toISOString();
  const baseBranchPoint = metadata.baseBranchPoint
    || metadata.integrationTargetCommit
    || metadata.canonicalBranchHead
    || resolvedConfig.baseBranchStartPoint;
  const publicationMode = metadata.publicationMode ?? resolvePublicationMode(projectDir);
  const integration: RegistryIntegrationRecord = {
    status: metadata.integrationState ?? "pending",
    target_branch: metadata.integrationTargetBranch || metadata.mergeTargetBranch || metadata.baseBranch || resolvedConfig.baseBranch,
    target_commit: metadata.integrationTargetCommit || baseBranchPoint,
    publication_mode: publicationMode,
    outcome: metadata.integrationOutcome ?? resolveIntegrationOutcome(
      publicationMode,
      metadata.integrationState ?? "pending",
    ),
    detail: metadata.cleanupState?.detail ?? null,
    updated_at: metadata.integrationUpdatedAt ?? now,
  };
  const cleanup: RegistryCleanupState = metadata.cleanupState
    ? {
        ...metadata.cleanupState,
        updated_at: now,
      }
    : createCleanupRecord({
        cleanupEligible: metadata.cleanupEligible,
        cleanupReason: metadata.cleanupReason,
      }, now);
  const canonicalBranchHead = refExists(projectDir, `refs/heads/${canonicalBranch}`)
    ? resolveCommit(projectDir, canonicalBranch)
    : workerRegistration
      ? resolveCommit(workerWorktreeDir, "HEAD")
      : metadata.canonicalBranchHead;
  const reviewerWorktree = reviewerWorktreeDir && pathExists(reviewerWorktreeDir)
    ? buildWorktreeRecord(
        reviewerWorktreeDir,
        "detached",
        null,
        reviewerRegistration ? resolveCommit(reviewerWorktreeDir, "HEAD") : null,
        now,
      )
    : null;
  const provisionalRecord: DispatchWorkspaceRecord = {
    workspace_id: metadata.workspaceId || workspaceIdFor(metadata.taskRef),
    task_ref: metadata.taskRef,
    task_slug: taskSlug,
    worktree_root: resolvedConfig.worktreeRoot,
    resolved_base_branch: metadata.baseBranch || resolvedConfig.baseBranch,
    base_branch_point: baseBranchPoint,
    canonical_branch: canonicalBranch,
    canonical_branch_head: canonicalBranchHead,
    lifecycle_state: metadata.lifecycleState ?? "ready",
    active_role: metadata.activeRole ?? null,
    worktrees: {
      worker: buildWorktreeRecord(
        workerWorktreeDir,
        "branch",
        canonicalBranch,
        workerRegistration ? resolveCommit(workerWorktreeDir, "HEAD") : canonicalBranchHead,
        now,
      ),
      reviewer: reviewerWorktree,
    },
    bootstrap: normalizeDispatchBootstrapState(metadata.bootstrap),
    integration,
    health: createHealthyState(now),
    cleanup,
    timestamps: {
      created_at: metadata.createdAt ?? now,
      updated_at: now,
      last_reconciled_at: now,
      last_active_at: metadata.lastActiveAt ?? null,
      closed_at: metadata.closedAt ?? null,
    },
  };
  const health = reconcileWorkspaceHealth(projectDir, provisionalRecord, now);
  const record: DispatchWorkspaceRecord = {
    ...provisionalRecord,
    lifecycle_state: resolveLifecycleState(
      null,
      health,
      integration,
      cleanup,
      metadata.activeRole ?? null,
    ),
    health,
  };
  await persistWorkspaceRecord(projectDir, record);
  return record;
}

async function ensureUsableWorktreeRoot(
  projectDir: string,
  worktreeRoot: string,
): Promise<void> {
  const shadowDir = path.join(projectDir, ".kspec");
  const relativeToShadow = path.relative(shadowDir, worktreeRoot);
  const insideShadow = relativeToShadow === "" || (!relativeToShadow.startsWith("..") && !path.isAbsolute(relativeToShadow));
  if (insideShadow) {
    throw new DispatchWorkspaceError(
      `Resolved dispatch worktree root "${worktreeRoot}" is inside the shadow worktree.`,
      "Set dispatch.worktree_root to a directory outside .kspec/.",
    );
  }

  try {
    await fs.mkdir(worktreeRoot, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DispatchWorkspaceError(
      `Cannot create dispatch worktree root "${worktreeRoot}": ${message}`,
      "Fix the path or permissions for dispatch.worktree_root and try again.",
    );
  }

  const stat = await fs.stat(worktreeRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new DispatchWorkspaceError(
      `Resolved dispatch worktree root "${worktreeRoot}" is not a directory.`,
      "Choose a directory path for dispatch.worktree_root.",
    );
  }
}

async function assertPathSafeForWorktree(worktreeDir: string, projectDir: string): Promise<void> {
  const existing = await fs.stat(worktreeDir).catch(() => null);
  if (!existing) return;

  const registered = parseWorktreeList(projectDir).some((entry) => entry.path === worktreeDir);
  if (registered) return;

  const entries = await fs.readdir(worktreeDir).catch(() => []);
  if (entries.length > 0) {
    throw new DispatchWorkspaceError(
      `Dispatch worktree path "${worktreeDir}" already exists and is not a registered git worktree.`,
      "Remove or rename that directory, or choose a different dispatch.worktree_root.",
    );
  }
}

export async function resolveDispatchWorkspaceConfig(
  projectDir: string,
): Promise<ResolvedDispatchWorkspaceConfig> {
  const { config } = await loadProjectConfig(projectDir, projectDir);
  const configuredBaseBranch = config.dispatch.base_branch?.trim() || null;
  const rawRoot = config.dispatch.worktree_root?.trim() || ".kspec-worktrees";
  const worktreeRoot = path.isAbsolute(rawRoot)
    ? rawRoot
    : path.resolve(projectDir, rawRoot);

  if (configuredBaseBranch) {
    const resolved = resolveBranchStartPoint(projectDir, configuredBaseBranch);
    if (!resolved) {
      throw new DispatchWorkspaceError(
        `Configured dispatch.base_branch "${configuredBaseBranch}" does not exist in this repository.`,
        "Create or fetch that branch, or update kspec.config.yaml to a valid base branch.",
      );
    }
    return {
      baseBranch: configuredBaseBranch,
      baseBranchStartPoint: resolved.startPoint,
      baseBranchSource: "configured",
      worktreeRoot,
    };
  }

  const remoteHeadBranch = resolveRemoteHeadBranch(projectDir);
  if (remoteHeadBranch) {
    const resolved = resolveBranchStartPoint(projectDir, remoteHeadBranch);
    if (resolved) {
      return {
        baseBranch: remoteHeadBranch,
        baseBranchStartPoint: resolved.startPoint,
        baseBranchSource: "remote-head",
        worktreeRoot,
      };
    }
  }

  const currentBranch = resolveCurrentBranch(projectDir);
  if (currentBranch) {
    const resolved = resolveBranchStartPoint(projectDir, currentBranch) ?? {
      startPoint: currentBranch,
      branch: currentBranch,
    };
    return {
      baseBranch: currentBranch,
      baseBranchStartPoint: resolved.startPoint,
      baseBranchSource: "current-branch",
      worktreeRoot,
    };
  }

  return {
    baseBranch: "main",
    baseBranchStartPoint: "main",
    baseBranchSource: "default",
    worktreeRoot,
  };
}

export function resolveDispatchWorkspaceCleanupState(
  options: ResolveDispatchWorkspaceCleanupStateOptions,
): DispatchWorkspaceCleanupState {
  if (options.integrationState === "merged") {
    return { cleanupEligible: true, cleanupReason: "integrated-into-base-branch" };
  }
  if (options.integrationState === "abandoned") {
    return { cleanupEligible: true, cleanupReason: "task-abandoned" };
  }
  if (options.integrationState === "reset") {
    return { cleanupEligible: true, cleanupReason: "task-reset" };
  }
  if (options.taskStatus === "completed" || options.taskStatus === "cancelled") {
    return { cleanupEligible: true, cleanupReason: "task-closed" };
  }
  return { cleanupEligible: false, cleanupReason: null };
}

function resolveBaseBranchPoint(
  projectDir: string,
  canonicalBranch: string,
  resolvedBaseStartPoint: string,
  existingRecord: LoadedDispatchWorkspaceRecord | undefined,
): string {
  if (existingRecord?.base_branch_point) {
    return existingRecord.base_branch_point;
  }

  if (refExists(projectDir, `refs/heads/${canonicalBranch}`)) {
    const mergeBase = runGit(projectDir, ["merge-base", canonicalBranch, resolvedBaseStartPoint]);
    if (mergeBase.status === 0 && mergeBase.stdout) {
      return mergeBase.stdout;
    }
  }

  return resolveCommit(projectDir, resolvedBaseStartPoint);
}

function buildWorktreeRecord(
  worktreePath: string,
  branchMode: DispatchWorkspaceWorktree["branch_mode"],
  branchRef: string | null,
  head: string | null,
  now: string,
): DispatchWorkspaceWorktree {
  return {
    path: worktreePath,
    branch_mode: branchMode,
    branch_ref: branchRef,
    head,
    last_seen_at: now,
  };
}

export async function reconcileDispatchWorkspaceRegistry(
  projectDir: string,
  taskStatusByRef?: Map<string, ResolveDispatchWorkspaceCleanupStateOptions["taskStatus"]>,
  activeRoleByTaskRef?: Map<string, RegistryRole>,
): Promise<void> {
  const ctx = await initContext(projectDir);
  const records = await loadDispatchWorkspaceRegistry(ctx);

  for (const record of records) {
    if (record.lifecycle_state === "closed") continue;

    const now = new Date().toISOString();
    const currentTaskStatus = taskStatusByRef?.get(record.task_ref) ?? null;
    const health = reconcileWorkspaceHealth(projectDir, record, now);
    const canonicalBranchHead = refExists(projectDir, `refs/heads/${record.canonical_branch}`)
      ? resolveCommit(projectDir, record.canonical_branch)
      : record.canonical_branch_head;
    const { cleanup, integration } = resolveRegistryStateForTaskStatus(
      currentTaskStatus,
      record,
      now,
    );
    const activeRole = activeRoleByTaskRef?.get(record.task_ref) ?? null;
    const lifecycleState = resolveLifecycleState(
      currentTaskStatus,
      health,
      integration,
      cleanup,
      activeRole,
    );
    const closedAt = lifecycleState === "closed"
      ? (record.timestamps.closed_at ?? now)
      : null;

    await persistWorkspaceRecord(projectDir, {
      ...record,
      canonical_branch_head: canonicalBranchHead,
      lifecycle_state: lifecycleState,
      active_role: activeRole,
      health,
      cleanup,
      integration,
      timestamps: {
        ...record.timestamps,
        updated_at: now,
        last_reconciled_at: now,
        closed_at: closedAt,
      },
    });
  }
}

async function safelyRemoveDispatchWorktree(
  projectDir: string,
  worktreeRoot: string,
  worktreeDir: string,
): Promise<void> {
  const shadowDir = path.join(projectDir, ".kspec");
  if (!isPathInside(worktreeRoot, worktreeDir)) {
    throw new DispatchWorkspaceError(
      `Refusing to remove worktree outside dispatch root: "${worktreeDir}"`,
      "Inspect dispatch workspace metadata and worktree paths before retrying cleanup.",
    );
  }
  if (
    path.resolve(worktreeDir) === path.resolve(projectDir) ||
    path.resolve(worktreeDir) === path.resolve(shadowDir)
  ) {
    throw new DispatchWorkspaceError(
      `Refusing to remove protected worktree path "${worktreeDir}"`,
      "Only dispatcher-managed worktrees under dispatch.worktree_root may be cleaned up.",
    );
  }

  const registration = findWorktreeByPath(projectDir, worktreeDir);
  if (registration) {
    runGitOrThrow(
      projectDir,
      ["worktree", "remove", "--force", worktreeDir],
      `Failed to remove dispatch worktree "${worktreeDir}"`,
      "Inspect git worktree state and remove stale registrations before retrying cleanup.",
    );
    return;
  }

  await fs.rm(worktreeDir, { recursive: true, force: true });
}

function deleteDispatchBranch(projectDir: string, branch: string): void {
  if (!isDispatchBranch(branch)) {
    throw new DispatchWorkspaceError(
      `Refusing to delete non-dispatch branch "${branch}"`,
      "Only canonical dispatch/task/* branches are eligible for dispatcher cleanup.",
    );
  }

  if (!refExists(projectDir, `refs/heads/${branch}`)) {
    return;
  }

  runGitOrThrow(
    projectDir,
    ["branch", "-D", branch],
    `Failed to delete dispatch branch "${branch}"`,
    "Inspect branch state and active worktree registrations before retrying cleanup.",
  );
}

function listDispatchBranches(projectDir: string): string[] {
  const result = runGit(projectDir, [
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${DISPATCH_BRANCH_PREFIX}`,
  ]);
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function reconcileDispatchWorkspaceLifecycle(
  options: ReconcileDispatchWorkspaceLifecycleOptions,
): Promise<ProvisionedDispatchWorkspace | null> {
  const { projectDir, taskRef, cleanupState, task } = options;
  const existingRecord = await loadWorkspaceRecord(projectDir, taskRef);
  if (!existingRecord) {
    return null;
  }

  const now = new Date().toISOString();
  const health = reconcileWorkspaceHealth(projectDir, existingRecord, now);
  const cleanup = resolveCleanupRecord(cleanupState, existingRecord, now);
  const integration = resolveIntegrationRecord(
    existingRecord.integration.target_branch,
    existingRecord.integration.target_commit,
    existingRecord.integration.publication_mode,
    cleanupState,
    existingRecord,
    now,
  );
  const lifecycleState = resolveLifecycleState(
    cleanupState.taskStatus ?? null,
    health,
    integration,
    cleanup,
    null,
  );
  const canonicalBranchHead = refExists(projectDir, `refs/heads/${existingRecord.canonical_branch}`)
    ? resolveCommit(projectDir, existingRecord.canonical_branch)
    : existingRecord.canonical_branch_head;
  const updatedTaskSlug = normalizeTaskSlug(taskRef, task) || existingRecord.task_slug;
  const record: DispatchWorkspaceRecord = {
    ...existingRecord,
    task_slug: updatedTaskSlug,
    canonical_branch_head: canonicalBranchHead,
    lifecycle_state: lifecycleState,
    active_role: null,
    health,
    cleanup,
    integration,
    timestamps: {
      ...existingRecord.timestamps,
      updated_at: now,
      last_reconciled_at: now,
      closed_at: lifecycleState === "closed"
        ? (existingRecord.timestamps.closed_at ?? now)
        : null,
    },
  };
  const metadataPath = await persistWorkspaceRecord(projectDir, record);

  return {
    cwd: record.worktrees.worker.path,
    metadataPath,
    metadata: toMetadata(record),
  };
}

export async function cleanupReviewerDispatchWorkspace(
  projectDir: string,
  taskRef: string,
  task?: { title?: string; slugs?: string[] },
): Promise<DispatchWorkspaceReapResult> {
  const existing = await findWorkspaceRegistrationByTaskRef(projectDir, taskRef, task);
  const existingRecord = await loadWorkspaceRecord(projectDir, taskRef);
  if (!existing || !existing.metadata.reviewerWorktreeDir || !existingRecord) {
    return { taskRef, action: "none", blockedReason: null };
  }

  await safelyRemoveDispatchWorktree(
    projectDir,
    existing.metadata.worktreeRoot,
    existing.metadata.reviewerWorktreeDir,
  );

  const now = new Date().toISOString();
  const lifecycleState = existingRecord.cleanup.eligible ? "closing" : "ready";
  const updatedMetadata: DispatchWorkspaceMetadata = {
    ...existing.metadata,
    reviewerWorktreeDir: null,
    lifecycleState,
    cleanupBlockedReason: null,
    updatedAt: now,
  };
  const updatedRecord: DispatchWorkspaceRecord = {
    ...existingRecord,
    lifecycle_state: lifecycleState,
    worktrees: {
      ...existingRecord.worktrees,
      reviewer: null,
    },
    health: reconcileWorkspaceHealth(projectDir, {
      ...existingRecord,
      worktrees: {
        ...existingRecord.worktrees,
        reviewer: null,
      },
    }, now),
    timestamps: {
      ...existingRecord.timestamps,
      updated_at: now,
      last_reconciled_at: now,
    },
  };
  await persistWorkspaceRecord(projectDir, updatedRecord);
  return { taskRef, action: "reviewer_cleaned", blockedReason: null };
}

export async function reapDispatchWorkspace(
  projectDir: string,
  taskRef: string,
  options?: {
    activeTaskRefs?: Iterable<string>;
    task?: { title?: string; slugs?: string[] };
  },
): Promise<DispatchWorkspaceReapResult> {
  const existing = await findWorkspaceRegistrationByTaskRef(projectDir, taskRef, options?.task);
  if (!existing) {
    return { taskRef, action: "none", blockedReason: null };
  }

  const activeTaskRefs = new Set(options?.activeTaskRefs ?? []);
  if (activeTaskRefs.has(taskRef)) {
    const blockedReason =
      "Cleanup blocked: canonical branch still has an active dispatch invocation.";
    const metadata: DispatchWorkspaceMetadata = {
      ...existing.metadata,
      lifecycleState: "cleanup_blocked",
      cleanupBlockedReason: blockedReason,
      cleanupScheduledAt: existing.metadata.cleanupScheduledAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeWorkspaceMetadata(existing.workerWorktreeDir, metadata);
    return { taskRef, action: "cleanup_blocked", blockedReason };
  }

  if (!existing.metadata.cleanupEligible) {
    const blockedReason =
      "Cleanup blocked: workspace integration outcome is unresolved, so the canonical branch must be retained.";
    const metadata: DispatchWorkspaceMetadata = {
      ...existing.metadata,
      lifecycleState: "cleanup_blocked",
      cleanupBlockedReason: blockedReason,
      cleanupScheduledAt: existing.metadata.cleanupScheduledAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeWorkspaceMetadata(existing.workerWorktreeDir, metadata);
    return { taskRef, action: "cleanup_blocked", blockedReason };
  }

  if (existing.metadata.reviewerWorktreeDir) {
    await safelyRemoveDispatchWorktree(
      projectDir,
      existing.metadata.worktreeRoot,
      existing.metadata.reviewerWorktreeDir,
    );
  }
  await safelyRemoveDispatchWorktree(
    projectDir,
    existing.metadata.worktreeRoot,
    existing.workerWorktreeDir,
  );
  deleteDispatchBranch(projectDir, existing.metadata.canonicalBranch);
  return { taskRef, action: "reaped", blockedReason: null };
}

export async function reconcileDispatchWorkspaceArtifacts(
  projectDir: string,
  options?: { activeTaskRefs?: Iterable<string> },
): Promise<void> {
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
  await ensureUsableWorktreeRoot(projectDir, resolvedConfig.worktreeRoot);
  const activeTaskRefs = new Set(options?.activeTaskRefs ?? []);
  const worktreeEntries = parseWorktreeList(projectDir);
  const entriesUnderRoot = worktreeEntries.filter((entry) =>
    isPathInside(resolvedConfig.worktreeRoot, entry.path)
  );

  const referencedReviewerDirs = new Set<string>();
  const trackedBranches = new Set<string>();

  for (const entry of entriesUnderRoot) {
    const recoveredRecord = await recoverWorkspaceRecordFromMetadata(
      projectDir,
      resolvedConfig,
      entry.path,
    );
    const metadata = recoveredRecord
      ? toMetadata(recoveredRecord)
      : await readWorkspaceMetadata(entry.path);
    const branchName = normalizeBranchRef(entry.branch);
    if (!metadata && !isDispatchBranch(branchName)) {
      continue;
    }
    if (!metadata) {
      await safelyRemoveDispatchWorktree(projectDir, resolvedConfig.worktreeRoot, entry.path);
      if (branchName && isDispatchBranch(branchName)) {
        deleteDispatchBranch(projectDir, branchName);
      }
      continue;
    }

    trackedBranches.add(metadata.canonicalBranch);
    if (metadata.reviewerWorktreeDir) {
      referencedReviewerDirs.add(path.resolve(metadata.reviewerWorktreeDir));
      const reviewerRegistration = findWorktreeByPath(projectDir, metadata.reviewerWorktreeDir);
      if (!reviewerRegistration) {
        const updatedMetadata: DispatchWorkspaceMetadata = {
          ...metadata,
          reviewerWorktreeDir: null,
          updatedAt: new Date().toISOString(),
        };
        await writeWorkspaceMetadata(entry.path, updatedMetadata);
      }
    }

    if (metadata.cleanupEligible) {
      await reapDispatchWorkspace(projectDir, metadata.taskRef, {
        activeTaskRefs,
        task: {
          title: metadata.taskSlug,
          slugs: [metadata.taskSlug],
        },
      });
    }
  }

  for (const entry of entriesUnderRoot) {
    if (entry.branch === null && entry.path.endsWith("-review")) {
      if (!referencedReviewerDirs.has(path.resolve(entry.path))) {
        await safelyRemoveDispatchWorktree(projectDir, resolvedConfig.worktreeRoot, entry.path);
      }
    }
  }

  const rootEntries = await fs.readdir(resolvedConfig.worktreeRoot, { withFileTypes: true }).catch(() => []);
  for (const dirent of rootEntries) {
    const candidate = path.join(resolvedConfig.worktreeRoot, dirent.name);
    if (findWorktreeByPath(projectDir, candidate)) {
      continue;
    }
    await fs.rm(candidate, { recursive: true, force: true });
  }

  for (const branch of listDispatchBranches(projectDir)) {
    if (trackedBranches.has(branch)) {
      continue;
    }
    deleteDispatchBranch(projectDir, branch);
  }
}

async function ensureReviewerWorktree(
  projectDir: string,
  reviewerWorktreeDir: string,
  canonicalBranch: string,
): Promise<void> {
  const existingRegistration = findWorktreeByPath(projectDir, reviewerWorktreeDir);
  if (!existingRegistration) {
    await assertPathSafeForWorktree(reviewerWorktreeDir, projectDir);
    runGitOrThrow(
      projectDir,
      ["worktree", "add", "--detach", reviewerWorktreeDir, canonicalBranch],
      `Failed to create detached reviewer worktree for "${canonicalBranch}"`,
      "Inspect git worktree state and remove stale reviewer worktrees before retrying.",
    );
    return;
  }

  runGitOrThrow(
    reviewerWorktreeDir,
    ["checkout", "--detach", canonicalBranch],
    `Failed to refresh reviewer snapshot for "${canonicalBranch}"`,
    "Inspect reviewer worktree state and remove or repair it before retrying.",
  );
  runGitOrThrow(
    reviewerWorktreeDir,
    ["reset", "--hard", canonicalBranch],
    `Failed to align reviewer snapshot with "${canonicalBranch}"`,
    "Inspect reviewer worktree state and remove or repair it before retrying.",
  );
}

export async function provisionDispatchWorkspace(
  options: ProvisionDispatchWorkspaceOptions,
): Promise<ProvisionedDispatchWorkspace> {
  const { projectDir, taskRef, task, role = "worker", cleanupState } = options;
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
  await ensureUsableWorktreeRoot(projectDir, resolvedConfig.worktreeRoot);

  const existingRecord = await loadWorkspaceRecord(projectDir, taskRef);
  const taskSlug = existingRecord?.task_slug ?? normalizeTaskSlug(taskRef, task);
  const shortId = shortTaskId(taskRef);
  const canonicalBranch = existingRecord?.canonical_branch ?? `dispatch/task/${taskSlug}/${shortId}`;
  const workspaceId = existingRecord?.workspace_id ?? workspaceIdFor(taskRef);
  const workerWorktreeDir = existingRecord?.worktrees.worker.path
    ?? findExistingWorktreeForBranch(projectDir, canonicalBranch)
    ?? path.join(resolvedConfig.worktreeRoot, `${taskSlug}-${shortId}`);
  const reviewerWorktreeDir = existingRecord?.worktrees.reviewer?.path
    ?? path.join(resolvedConfig.worktreeRoot, `${taskSlug}-${shortId}-review`);
  const baseBranch = existingRecord?.resolved_base_branch ?? resolvedConfig.baseBranch;
  const baseBranchPoint = resolveBaseBranchPoint(
    projectDir,
    canonicalBranch,
    resolvedConfig.baseBranchStartPoint,
    existingRecord,
  );
  const mergeTargetBranch = existingRecord?.integration.target_branch ?? baseBranch;
  const integrationTargetCommit = existingRecord?.integration.target_commit ?? baseBranchPoint;
  const publicationMode = resolveWorkspacePublicationMode(projectDir, existingRecord);
  const now = new Date().toISOString();
  const provisioningRecord: DispatchWorkspaceRecord = {
    workspace_id: workspaceId,
    task_ref: taskRef,
    task_slug: taskSlug,
    worktree_root: resolvedConfig.worktreeRoot,
    resolved_base_branch: baseBranch,
    base_branch_point: baseBranchPoint,
    canonical_branch: canonicalBranch,
    canonical_branch_head: existingRecord?.canonical_branch_head ?? baseBranchPoint,
    lifecycle_state: "provisioning",
    active_role: null,
    worktrees: {
      worker: buildWorktreeRecord(
        workerWorktreeDir,
        "branch",
        canonicalBranch,
        existingRecord?.worktrees.worker.head ?? baseBranchPoint,
        now,
      ),
      reviewer: existingRecord?.worktrees.reviewer ?? null,
    },
    bootstrap: existingRecord?.bootstrap ?? defaultBootstrapState(now),
    integration: resolveIntegrationRecord(
      mergeTargetBranch,
      integrationTargetCommit,
      publicationMode,
      cleanupState,
      existingRecord,
      now,
    ),
    health: createHealthyState(now),
    cleanup: resolveCleanupRecord(cleanupState, existingRecord, now),
    timestamps: {
      created_at: existingRecord?.timestamps.created_at ?? now,
      updated_at: now,
      last_reconciled_at: existingRecord?.timestamps.last_reconciled_at ?? now,
      last_active_at: existingRecord?.timestamps.last_active_at ?? null,
      closed_at: null,
    },
  };
  const metadataPath = await persistWorkspaceRecord(projectDir, provisioningRecord);

  await assertPathSafeForWorktree(workerWorktreeDir, projectDir);
  const existingWorkerWorktree = findExistingWorktreeForBranch(projectDir, canonicalBranch);
  if (!existingWorkerWorktree) {
    const branchExists = refExists(projectDir, `refs/heads/${canonicalBranch}`);
    if (branchExists) {
      runGitOrThrow(
        projectDir,
        ["worktree", "add", workerWorktreeDir, canonicalBranch],
        `Failed to attach existing dispatch branch "${canonicalBranch}"`,
        "Inspect git worktree state and remove stale registrations before retrying.",
      );
    } else {
      runGitOrThrow(
        projectDir,
        ["worktree", "add", "-b", canonicalBranch, workerWorktreeDir, resolvedConfig.baseBranchStartPoint],
        `Failed to create dispatch worktree for ${taskRef} from "${resolvedConfig.baseBranchStartPoint}"`,
        "Ensure the base branch exists locally or on a tracked remote, then retry dispatch.",
      );
    }
  }

  let reviewerRecord: DispatchWorkspaceWorktree | null = existingRecord?.worktrees.reviewer ?? null;
  if (role === "reviewer") {
    await ensureReviewerWorktree(projectDir, reviewerWorktreeDir, canonicalBranch);
    reviewerRecord = buildWorktreeRecord(
      reviewerWorktreeDir,
      "detached",
      null,
      resolveCommit(reviewerWorktreeDir, "HEAD"),
      now,
    );
  }

  const canonicalBranchHead = resolveCommit(projectDir, canonicalBranch);
  const health = reconcileWorkspaceHealth(projectDir, {
    ...provisioningRecord,
    canonical_branch_head: canonicalBranchHead,
    worktrees: {
      worker: buildWorktreeRecord(
        workerWorktreeDir,
        "branch",
        canonicalBranch,
        canonicalBranchHead,
        now,
      ),
      reviewer: reviewerRecord,
    },
  }, now);
  const integration = resolveIntegrationRecord(
    mergeTargetBranch,
    integrationTargetCommit,
    publicationMode,
    cleanupState,
    existingRecord,
    now,
  );
  const cleanup = resolveCleanupRecord(cleanupState, existingRecord, now);
  const record: DispatchWorkspaceRecord = {
    ...provisioningRecord,
    canonical_branch_head: canonicalBranchHead,
    lifecycle_state: resolveLifecycleState(
      cleanupState?.taskStatus ?? null,
      health,
      integration,
      cleanup,
      null,
    ),
    worktrees: {
      worker: buildWorktreeRecord(
        workerWorktreeDir,
        "branch",
        canonicalBranch,
        canonicalBranchHead,
        now,
      ),
      reviewer: reviewerRecord,
    },
    integration,
    health,
    cleanup,
    timestamps: {
      ...provisioningRecord.timestamps,
      updated_at: now,
      last_reconciled_at: now,
    },
  };
  await persistWorkspaceRecord(projectDir, record);

  return {
    cwd: role === "reviewer" && reviewerRecord ? reviewerRecord.path : workerWorktreeDir,
    metadataPath,
    metadata: toMetadata(record),
  };
}

export async function markDispatchWorkspaceActive(options: {
  projectDir: string;
  taskRef: string;
  role: DispatchWorkspaceRole;
}): Promise<ProvisionedDispatchWorkspace | null> {
  const existingRecord = await loadWorkspaceRecord(options.projectDir, options.taskRef);
  if (!existingRecord) return null;

  const now = new Date().toISOString();
  const health = reconcileWorkspaceHealth(options.projectDir, existingRecord, now);
  const lifecycleState = resolveLifecycleState(
    null,
    health,
    {
      ...existingRecord.integration,
      updated_at: now,
    },
    {
      ...existingRecord.cleanup,
      updated_at: now,
    },
    options.role,
  );
  const canonicalBranchHead = refExists(options.projectDir, `refs/heads/${existingRecord.canonical_branch}`)
    ? resolveCommit(options.projectDir, existingRecord.canonical_branch)
    : existingRecord.canonical_branch_head;
  const record: DispatchWorkspaceRecord = {
    ...existingRecord,
    canonical_branch_head: canonicalBranchHead,
    lifecycle_state: lifecycleState,
    active_role: options.role,
    health,
    timestamps: {
      ...existingRecord.timestamps,
      updated_at: now,
      last_reconciled_at: now,
      last_active_at: now,
    },
  };
  const metadataPath = await persistWorkspaceRecord(options.projectDir, record);

  return {
    cwd: options.role === "reviewer" && record.worktrees.reviewer
      ? record.worktrees.reviewer.path
      : record.worktrees.worker.path,
    metadataPath,
    metadata: toMetadata(record),
  };
}

export async function markDispatchWorkspaceIdle(options: {
  projectDir: string;
  taskRef: string;
  taskStatus: ResolveDispatchWorkspaceCleanupStateOptions["taskStatus"] | null;
}): Promise<ProvisionedDispatchWorkspace | null> {
  const existingRecord = await loadWorkspaceRecord(options.projectDir, options.taskRef);
  if (!existingRecord) return null;

  const now = new Date().toISOString();
  const health = reconcileWorkspaceHealth(options.projectDir, existingRecord, now);
  const cleanup = {
    ...existingRecord.cleanup,
    updated_at: now,
  };
  const integration = {
    ...existingRecord.integration,
    updated_at: now,
  };
  const lifecycleState = resolveLifecycleState(
    options.taskStatus,
    health,
    integration,
    cleanup,
    null,
  );
  const record: DispatchWorkspaceRecord = {
    ...existingRecord,
    lifecycle_state: lifecycleState,
    active_role: null,
    health,
    cleanup,
    integration,
    timestamps: {
      ...existingRecord.timestamps,
      updated_at: now,
      last_reconciled_at: now,
      closed_at: lifecycleState === "closed"
        ? (existingRecord.timestamps.closed_at ?? now)
        : null,
    },
  };
  const metadataPath = await persistWorkspaceRecord(options.projectDir, record);

  return {
    cwd: record.worktrees.worker.path,
    metadataPath,
    metadata: toMetadata(record),
  };
}

export async function getDispatchWorkspaceHealth(
  options: ProvisionDispatchWorkspaceOptions,
): Promise<DispatchWorkspaceHealth> {
  const { projectDir, taskRef, role = "worker" } = options;
  const existingRecord = await loadWorkspaceRecord(projectDir, taskRef);
  if (!existingRecord) {
    return {
      exists: false,
      healthy: true,
      reason: null,
      metadata: null,
    };
  }

  const now = new Date().toISOString();
  const health = reconcileWorkspaceHealth(projectDir, existingRecord, now);
  const cleanup = {
    ...existingRecord.cleanup,
    updated_at: now,
  };
  const metadata = toMetadata({
    ...existingRecord,
    health,
    cleanup,
    timestamps: {
      ...existingRecord.timestamps,
      updated_at: now,
    },
  });
  const reviewerWorktree = existingRecord.worktrees.reviewer;
  const reviewerMissingRecordedWorktree = role === "reviewer"
    && reviewerWorktree != null
    && !pathExists(reviewerWorktree.path);
  const healthy = health.status === "healthy"
    && !cleanup.eligible
    && metadata.bootstrap.roleStates[role].status !== "failed"
    && !reviewerMissingRecordedWorktree;
  const primaryIssue = health.issues[0];
  const reason = reviewerMissingRecordedWorktree
    ? "missing-reviewer-worktree"
    : metadata.bootstrap.roleStates[role].status === "failed"
      ? (metadata.bootstrap.roleStates[role].failureMessage ?? "bootstrap-failed")
    : cleanup.eligible
      ? (cleanup.reason ?? "workspace-marked-for-cleanup")
      : primaryIssue
        ? primaryIssue.code.replace(/_/g, "-")
        : health.status === "healthy"
          ? null
          : health.status;

  return {
    exists: true,
    healthy,
    reason,
    metadata,
  };
}
