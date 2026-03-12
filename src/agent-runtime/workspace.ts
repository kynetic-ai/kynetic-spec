import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { initContext } from "../parser/index.js";
import {
  findDispatchWorkspaceByTaskRef,
  getDispatchWorkspaceRegistryPath,
  loadDispatchWorkspaceRegistry,
  saveDispatchWorkspaceRecord,
  type LoadedDispatchWorkspaceRecord,
} from "../parser/dispatch-workspaces.js";
import { loadProjectConfig } from "../parser/config.js";
import type {
  DispatchWorkspaceBootstrapState,
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
    status: "not_started",
    detail: null,
    updated_at: now,
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
    bootstrapState: record.bootstrap,
    healthState: record.health,
    cleanupState: record.cleanup,
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
  const ctx = await initContext(projectDir);
  const registryPath = getDispatchWorkspaceRegistryPath(ctx);
  await saveDispatchWorkspaceRecord(ctx, {
    ...record,
    _sourceFile: registryPath,
  });
  return registryPath;
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
  const reviewerWorktree = existingRecord.worktrees.reviewer;
  const reviewerMissingRecordedWorktree = role === "reviewer"
    && reviewerWorktree != null
    && !pathExists(reviewerWorktree.path);
  const healthy = health.status === "healthy"
    && !cleanup.eligible
    && !reviewerMissingRecordedWorktree;
  const primaryIssue = health.issues[0];
  const reason = reviewerMissingRecordedWorktree
    ? "missing-reviewer-worktree"
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
    metadata: toMetadata({
      ...existingRecord,
      health,
      cleanup,
      timestamps: {
        ...existingRecord.timestamps,
        updated_at: now,
      },
    }),
  };
}
