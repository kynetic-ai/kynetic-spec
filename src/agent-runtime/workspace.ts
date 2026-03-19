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
  DispatchWorkspaceBranchProvenance,
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

interface RunGitOptions {
  timeout?: number;
}

const DISPATCH_GIT_ENV_KEYS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
] as const;

export interface ResolvedDispatchWorkspaceConfig {
  baseBranch: string;
  baseBranchStartPoint: string;
  baseBranchSource: "configured" | "remote-head" | "current-branch" | "default";
  worktreeRoot: string;
  publicationMode: "pull_request" | "manual_merge" | "auto";
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
  branchProvenance: DispatchWorkspaceBranchProvenance;
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
  /** Submission linkage from the task, used to adopt an existing branch when no workspace record exists. */
  submissionLinkage?: {
    branch: string | null;
    commit: string;
    remote?: string | null;
    remote_url?: string | null;
    upstream_ref?: string | null;
    review_url?: string | null;
    captured_at: string;
  } | null;
  /**
   * The task status that triggered provisioning. Used to determine
   * whether adoption is required (pending_review, needs_work) vs optional.
   */
  taskStatus?: string;
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

function runGit(cwd: string, args: string[], options: RunGitOptions = {}): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    env: buildDispatchGitEnv(),
    encoding: "utf-8",
    stdio: "pipe",
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
  };
}

export function buildDispatchGitEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of DISPATCH_GIT_ENV_KEYS) {
    delete env[key];
  }
  return env;
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

/**
 * Attempt to restore a missing local branch from a remote ref.
 * Iterates configured remotes (origin first) and creates the local branch
 * from the first matching remote ref. Returns true if the branch was restored.
 * On failure, logs at debug level and returns false (graceful degradation).
 */
function tryRestoreBranchFromRemote(projectDir: string, branch: string): boolean {
  for (const remote of listGitRemotes(projectDir)) {
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    if (!refExists(projectDir, remoteRef)) continue;
    const result = runGit(projectDir, ["branch", branch, `${remote}/${branch}`]);
    if (result.status === 0) {
      return true;
    }
    console.debug(
      `[dispatch] Failed to restore branch "${branch}" from ${remote}: ${result.stderr || result.stdout}`,
    );
  }
  return false;
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

function resolvePublicationMode(
  projectDir: string,
  configuredMode?: "pull_request" | "manual_merge" | "auto",
): DispatchWorkspacePublicationMode {
  if (configuredMode && configuredMode !== "auto") {
    return configuredMode;
  }
  return commandAvailable("gh") && hasGitHubRemote(projectDir)
    ? "pull_request"
    : "manual_merge";
}

function resolveWorkspacePublicationMode(
  projectDir: string,
  existingRecord: LoadedDispatchWorkspaceRecord | undefined,
  configuredMode?: "pull_request" | "manual_merge" | "auto",
): DispatchWorkspacePublicationMode {
  if (!existingRecord) {
    return resolvePublicationMode(projectDir, configuredMode);
  }

  switch (existingRecord.integration.status) {
    case "pending":
    case "in_progress":
      return resolvePublicationMode(projectDir, configuredMode);
    default:
      return existingRecord.integration.publication_mode;
  }
}

// AC: @dispatch-workspace-configuration ac-6 — detect and handle stale integration target
// When an existing workspace record's integration.target_branch differs from an
// explicitly configured dispatch.base_branch, either auto-update (if integration is
// still pending) or surface the conflict as an error (if integration is active).
// Only triggers for explicitly configured base branches — auto-detected values
// (remote-head, current-branch, default) are inherently unstable and should not
// cause retargeting.
function resolveStaleIntegrationTarget(
  existingRecord: LoadedDispatchWorkspaceRecord | undefined,
  configuredBaseBranch: string,
  baseBranchSource: ResolvedDispatchWorkspaceConfig["baseBranchSource"],
  resolvedBaseBranch: string,
): string {
  if (!existingRecord) {
    return resolvedBaseBranch;
  }

  const recordedTarget = existingRecord.integration.target_branch;

  // Only detect staleness when base_branch is explicitly configured.
  // Auto-detected sources (remote-head, current-branch, default) are unstable
  // and should not override a previously recorded target.
  if (baseBranchSource !== "configured") {
    return recordedTarget;
  }

  // No mismatch — the workspace already targets the configured branch
  if (recordedTarget === configuredBaseBranch) {
    return recordedTarget;
  }

  // Mismatch detected: config changed since workspace was provisioned.
  // When integration is still pending, auto-update to the current config.
  if (existingRecord.integration.status === "pending") {
    return configuredBaseBranch;
  }

  // Active integration state — cannot silently retarget. Surface the conflict.
  throw new DispatchWorkspaceError(
    `Workspace for ${existingRecord.task_ref} targets integration branch "${recordedTarget}" ` +
      `but dispatch.base_branch is now "${configuredBaseBranch}". ` +
      `The workspace has active integration state (${existingRecord.integration.status}) ` +
      `and cannot be silently retargeted.`,
    `Either revert dispatch.base_branch to "${recordedTarget}" to match the existing workspace, ` +
      `or reset the workspace integration state before re-provisioning ` +
      `(kspec dispatch workspace reset ${existingRecord.task_ref}).`,
  );
}

// AC: @adopt-existing-task-branch-lineage ac-2 — rehydrate adopted branch from remote
function rehydrateAdoptedBranch(
  projectDir: string,
  branchName: string,
  remote: string | null,
  remoteUrl: string | null,
): boolean {
  // Try the specified remote first, then fall back to all remotes
  const remotes = remote
    ? [remote, ...listGitRemotes(projectDir).filter((r) => r !== remote)]
    : listGitRemotes(projectDir);
  for (const remoteName of remotes) {
    // Fetch the specific branch from the remote
    const fetchResult = runGit(projectDir, [
      "fetch", remoteName, `${branchName}:${branchName}`,
    ]);
    if (fetchResult.status === 0) {
      return true;
    }
    // Also try refs/heads/<branch> in case the remote ref name differs
    const fetchAlt = runGit(projectDir, [
      "fetch", remoteName, `refs/heads/${branchName}:refs/heads/${branchName}`,
    ]);
    if (fetchAlt.status === 0) {
      return true;
    }
  }
  // Fall back to fetching directly from the remote URL when named remotes
  // don't have the branch (e.g. fork URL not configured as a named remote)
  if (remoteUrl) {
    const fetchUrl = runGit(projectDir, [
      "fetch", remoteUrl, `${branchName}:${branchName}`,
    ]);
    if (fetchUrl.status === 0) {
      return true;
    }
  }
  return false;
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

function defaultBranchProvenance(): DispatchWorkspaceBranchProvenance {
  return {
    ownership: "dispatcher-managed",
    source: "provisioned",
    remote_ref: null,
    adopted_from: null,
    adopted_at: null,
    rehydrated: null,
  };
}

function adoptedBranchProvenance(
  adoptedFrom: string,
  remoteRef: string | null,
  now: string,
  rehydrated: boolean,
): DispatchWorkspaceBranchProvenance {
  return {
    ownership: "adopted",
    source: "task-submission-linkage",
    remote_ref: remoteRef,
    adopted_from: adoptedFrom,
    adopted_at: now,
    rehydrated,
  };
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
    target_commit: (existingRecord && existingRecord.integration.target_branch === targetBranch)
      ? existingRecord.integration.target_commit
      : targetCommit,
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

// AC: @adopted-branch-cleanup-and-recoverability ac-3
function reconcileWorkspaceHealth(
  projectDir: string,
  record: DispatchWorkspaceRecord,
  now: string,
): DispatchWorkspaceHealthState {
  const issues: DispatchWorkspaceIssue[] = [];
  const branchRef = `refs/heads/${record.canonical_branch}`;
  let branchExists = refExists(projectDir, branchRef);
  if (!branchExists) {
    branchExists = tryRestoreBranchFromRemote(projectDir, record.canonical_branch);
  }
  if (!branchExists) {
    const isAdopted = record.branch_provenance?.ownership === "adopted";
    const hasRemoteLocator = Boolean(record.branch_provenance?.remote_ref);
    if (isAdopted && hasRemoteLocator) {
      issues.push(buildIssue(
        "missing_adopted_branch_recoverable",
        `Adopted canonical branch "${record.canonical_branch}" is missing locally but a remote locator is known (${record.branch_provenance.remote_ref}).`,
        `Rehydrate the adopted branch from the remote locator with: git fetch <remote> ${record.canonical_branch}:${record.canonical_branch}`,
      ));
    } else if (isAdopted) {
      issues.push(buildIssue(
        "missing_adopted_branch",
        `Adopted canonical branch "${record.canonical_branch}" is missing locally and no remote locator is recorded.`,
        "Locate the original branch source and manually restore it, or re-submit the task with updated submission linkage.",
      ));
    } else {
      issues.push(buildIssue(
        "missing_canonical_branch",
        `Canonical branch "${record.canonical_branch}" is missing.`,
        "Re-provision the workspace or restore the branch before dispatch resumes.",
      ));
    }
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

  const hasUnrecoverableBranch = issues.some(
    (issue) => issue.code === "missing_canonical_branch" || issue.code === "missing_adopted_branch",
  );
  return {
    status: hasUnrecoverableBranch ? "invalid" : "stale",
    summary: hasUnrecoverableBranch
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
    branchProvenance: record.branch_provenance ?? defaultBranchProvenance(),
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

/**
 * Save a workspace record to the registry file and update worktree metadata.
 * Does NOT acquire the dispatch shadow mutation lock or trigger a shadow commit.
 * Callers MUST hold the dispatch shadow mutation lock (via
 * {@link withDispatchShadowMutationLock}) and follow up with
 * {@link commitWorkspaceRegistryToShadow}.
 */
async function saveWorkspaceRecordToRegistry(
  projectDir: string,
  record: DispatchWorkspaceRecord,
): Promise<string> {
  const ctx = await initContext(projectDir);
  const registryPath = getDispatchWorkspaceRegistryPath(ctx);
  await saveDispatchWorkspaceRecord(ctx, {
    ...record,
    _sourceFile: registryPath,
  });

  const workerDir = record.worktrees.worker.path;
  if (workerDir && pathExists(workerDir)) {
    await writeWorkspaceMetadata(workerDir, toMetadata(record));
  }

  return registryPath;
}

/**
 * Run a callback inside the dispatch shadow mutation file lock.
 * Serializes with other shadow writers across processes.
 *
 * AC: @dispatch-workspace-registry ac-8
 */
async function withDispatchShadowMutationLock<T>(
  projectDir: string,
  taskRef: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = getDispatchShadowMutationLockPath(projectDir);
  const timeoutMs = resolveDispatchMutationLockTimeoutMs();

  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireFileLock(lockPath, timeoutMs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DispatchWorkspaceError(
      `Dispatch shadow mutation lock unavailable while committing workspace registry for ${taskRef}: ${reason}`,
      `Wait for the overlapping kspec mutation to finish, or remove ${path.basename(lockPath)}.lock if the lock holder is gone.`,
    );
  }

  try {
    return await fn();
  } finally {
    await release?.();
  }
}

/**
 * Commit pending workspace registry changes on the shadow branch.
 * MUST be called while the dispatch shadow mutation lock is held.
 * Does NOT acquire the lock itself — callers are responsible for
 * wrapping the write-then-commit sequence inside
 * {@link withDispatchShadowMutationLock}.
 *
 * AC: @dispatch-workspace-registry ac-8
 */
async function commitWorkspaceRegistryToShadow(
  projectDir: string,
  taskRef: string,
): Promise<void> {
  const ctx = await initContext(projectDir);
  if (!ctx.shadow?.enabled) return;

  const bareRef = taskRef.replace(/^@/, "");
  const committed = await commitIfShadow(
    ctx.shadow,
    "dispatch-workspace-registry",
    bareRef,
  );
  if (!committed) {
    const shadowStatus = runGit(ctx.shadow.worktreeDir, ["status", "--porcelain"]);
    const hasPendingShadowChanges = shadowStatus.status !== 0 || shadowStatus.stdout.trim().length > 0;
    if (hasPendingShadowChanges) {
      throw new DispatchWorkspaceError(
        `Dispatch workspace registry write succeeded but could not be durably committed on the shadow branch for ${taskRef}.`,
        "Resolve the shadow branch commit issue, then rerun dispatch reconciliation or workspace provisioning so the registry state becomes durable.",
      );
    }
  }
}

/**
 * Persist a single workspace record: acquire the dispatch shadow mutation
 * lock, save to registry, then durably commit — all within the lock scope
 * so the write is never visible without a matching shadow commit.
 *
 * AC: @dispatch-workspace-registry ac-8
 */
async function persistWorkspaceRecord(
  projectDir: string,
  record: DispatchWorkspaceRecord,
): Promise<string> {
  return withDispatchShadowMutationLock(projectDir, record.task_ref, async () => {
    const registryPath = await saveWorkspaceRecordToRegistry(projectDir, record);
    await commitWorkspaceRegistryToShadow(projectDir, record.task_ref);
    return registryPath;
  });
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
  // Try the deterministic dispatch/task/* branch first (most common path).
  const slug = normalizeTaskSlug(taskRef, task);
  const shortId = shortTaskId(taskRef);
  const syntheticBranch = `dispatch/task/${slug}/${shortId}`;
  const workerWorktreeDir = findExistingWorktreeForBranch(projectDir, syntheticBranch);
  if (workerWorktreeDir) {
    const metadata = await readWorkspaceMetadata(workerWorktreeDir);
    if (metadata) {
      return { canonicalBranch: syntheticBranch, workerWorktreeDir, metadata };
    }
  }

  // Fall back to registry lookup — adopted branches use a non-dispatch canonical
  // branch name, so the synthetic prefix won't match.
  const record = await loadWorkspaceRecord(projectDir, taskRef);
  if (!record) {
    return null;
  }
  const registryBranch = record.canonical_branch;
  const registryWorktreeDir = findExistingWorktreeForBranch(projectDir, registryBranch);
  if (!registryWorktreeDir) {
    return null;
  }
  const metadata = await readWorkspaceMetadata(registryWorktreeDir);
  if (!metadata) {
    return null;
  }
  return { canonicalBranch: registryBranch, workerWorktreeDir: registryWorktreeDir, metadata };
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
  const hasAdoptedProvenance = metadata.branchProvenance?.ownership === "adopted";
  // When branch_provenance is missing (legacy workspace) AND the canonical branch
  // is not a dispatch branch, infer adopted status to preserve the branch identity
  // instead of normalizing it back to dispatch/task/* (AC-2).
  const inferredAdopted = !metadata.branchProvenance && !isDispatchBranch(metadata.canonicalBranch);
  const canonicalBranch = (hasAdoptedProvenance || inferredAdopted)
    ? metadata.canonicalBranch
    : isDispatchBranch(metadata.canonicalBranch)
      ? metadata.canonicalBranch
      : `dispatch/task/${taskSlug}/${shortTaskId(metadata.taskRef)}`;
  const currentWorkerBranch = normalizeBranchRef(workerRegistration?.branch);

  if (workerRegistration && currentWorkerBranch !== canonicalBranch && !hasAdoptedProvenance && !inferredAdopted) {
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
  const publicationMode = metadata.publicationMode ?? resolvePublicationMode(projectDir, resolvedConfig.publicationMode);
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
  const branchProvenance: DispatchWorkspaceBranchProvenance = metadata.branchProvenance
    ?? (isDispatchBranch(metadata.canonicalBranch)
      ? defaultBranchProvenance()
      : adoptedBranchProvenance(metadata.canonicalBranch, null, now, false));
  const provisionalRecord: DispatchWorkspaceRecord = {
    workspace_id: metadata.workspaceId || workspaceIdFor(metadata.taskRef),
    task_ref: metadata.taskRef,
    task_slug: taskSlug,
    worktree_root: resolvedConfig.worktreeRoot,
    resolved_base_branch: metadata.baseBranch || resolvedConfig.baseBranch,
    base_branch_point: baseBranchPoint,
    canonical_branch: canonicalBranch,
    canonical_branch_head: canonicalBranchHead,
    branch_provenance: branchProvenance,
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
  const publicationMode = config.dispatch.publication_mode;
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
      publicationMode,
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
        publicationMode,
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
      publicationMode,
    };
  }

  const defaultBranch = "main";
  const resolved = resolveBranchStartPoint(projectDir, defaultBranch);
  if (resolved) {
    return {
      baseBranch: defaultBranch,
      baseBranchStartPoint: resolved.startPoint,
      baseBranchSource: "default",
      worktreeRoot,
      publicationMode,
    };
  }
  throw new DispatchWorkspaceError(
    'No base branch could be resolved: no configured dispatch.base_branch, no remote HEAD, ' +
      'no current branch, and default "main" does not exist.',
    "Set dispatch.base_branch in kspec.config.yaml, or ensure the repository has a main branch.",
  );
}

export interface DispatchIntegrationMutationScope {
  projectDir: string;
  integrationBranch: string;
  currentBranch: string;
}

export function resolveDispatchIntegrationMutationScope(
  projectDir: string,
  integrationBranch: string,
): DispatchIntegrationMutationScope {
  const currentBranch = resolveCurrentBranch(projectDir);
  if (!currentBranch) {
    throw new DispatchWorkspaceError(
      `Dispatch cannot determine a safe mutation surface for integration target "${integrationBranch}" in ${projectDir}.`,
      `Check out "${integrationBranch}" in the shared dispatch checkout at ${projectDir} and retry.`,
    );
  }

  if (currentBranch !== integrationBranch) {
    throw new DispatchWorkspaceError(
      `Dispatch refuses to mutate integration target "${integrationBranch}" from shared checkout ${projectDir} because the current branch is "${currentBranch}".`,
      `Check out "${integrationBranch}" in ${projectDir}, or restart dispatch from a shared checkout that already has "${integrationBranch}" checked out.`,
    );
  }

  return {
    projectDir,
    integrationBranch,
    currentBranch,
  };
}

export function runDispatchIntegrationTargetGit(
  projectDir: string,
  integrationBranch: string,
  args: string[],
  options: RunGitOptions = {},
): GitResult {
  const scope = resolveDispatchIntegrationMutationScope(projectDir, integrationBranch);
  return runGit(scope.projectDir, args, options);
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

/**
 * Compare two sub-objects by their serializable fields, excluding `updated_at`
 * timestamps that are consequences of change rather than triggers.
 *
 * AC: @dispatch-workspace-registry ac-10
 */
function deepEqualExcludingTimestamps(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const keysA = Object.keys(a).filter((k) => k !== "updated_at");
  const keysB = Object.keys(b).filter((k) => k !== "updated_at");
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    const va = a[key];
    const vb = b[key];
    if (va === vb) continue;
    if (va === null || vb === null || va === undefined || vb === undefined) return false;
    if (typeof va === "object" && typeof vb === "object") {
      if (Array.isArray(va) && Array.isArray(vb)) {
        if (va.length !== vb.length) return false;
        for (let i = 0; i < va.length; i++) {
          if (typeof va[i] === "object" && va[i] !== null && typeof vb[i] === "object" && vb[i] !== null) {
            if (!deepEqualExcludingTimestamps(va[i] as Record<string, unknown>, vb[i] as Record<string, unknown>)) return false;
          } else if (va[i] !== vb[i]) {
            return false;
          }
        }
        continue;
      }
      if (!deepEqualExcludingTimestamps(va as Record<string, unknown>, vb as Record<string, unknown>)) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Determine whether the computed reconciliation state differs from the
 * existing persisted record in any meaningful field. Timestamps are NOT
 * considered meaningful triggers — they are consequences of real changes.
 *
 * Fields compared (meaningful):
 * - canonical_branch_head
 * - lifecycle_state
 * - active_role
 * - health (deep compare, excluding updated_at)
 * - cleanup (deep compare, excluding updated_at)
 * - integration (deep compare, excluding updated_at)
 *
 * AC: @dispatch-workspace-registry ac-10
 */
export function isWorkspaceRecordDirty(
  existing: DispatchWorkspaceRecord,
  computed: {
    canonical_branch_head: string;
    lifecycle_state: DispatchWorkspaceLifecycleState;
    active_role: RegistryRole | null;
    health: DispatchWorkspaceHealthState;
    cleanup: RegistryCleanupState;
    integration: RegistryIntegrationRecord;
  },
): boolean {
  if (existing.canonical_branch_head !== computed.canonical_branch_head) return true;
  if (existing.lifecycle_state !== computed.lifecycle_state) return true;
  if ((existing.active_role ?? null) !== (computed.active_role ?? null)) return true;
  if (!deepEqualExcludingTimestamps(
    existing.health as unknown as Record<string, unknown>,
    computed.health as unknown as Record<string, unknown>,
  )) return true;
  if (!deepEqualExcludingTimestamps(
    existing.cleanup as unknown as Record<string, unknown>,
    computed.cleanup as unknown as Record<string, unknown>,
  )) return true;
  if (!deepEqualExcludingTimestamps(
    existing.integration as unknown as Record<string, unknown>,
    computed.integration as unknown as Record<string, unknown>,
  )) return true;
  return false;
}

export async function reconcileDispatchWorkspaceRegistry(
  projectDir: string,
  taskStatusByRef?: Map<string, ResolveDispatchWorkspaceCleanupStateOptions["taskStatus"]>,
  activeRoleByTaskRef?: Map<string, RegistryRole>,
): Promise<void> {
  const ctx = await initContext(projectDir);
  const records = await loadDispatchWorkspaceRegistry(ctx);
  const nonClosedRecords = records.filter((r) => r.lifecycle_state !== "closed");
  if (nonClosedRecords.length === 0) return;

  // Use the first non-closed record's task_ref for lock/commit attribution.
  const lockTaskRef = nonClosedRecords[0].task_ref;

  // AC: @dispatch-workspace-registry ac-8 — all registry writes + commit
  // happen inside the shadow mutation lock so no write is visible without
  // a matching durable commit.
  await withDispatchShadowMutationLock(projectDir, lockTaskRef, async () => {
    let lastTaskRef: string | null = null;
    let anyDirty = false;

    for (const record of nonClosedRecords) {
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

      // AC: @dispatch-workspace-registry ac-10 — skip save when no meaningful
      // field has changed. Timestamps must not change unless a real field differs.
      const dirty = isWorkspaceRecordDirty(record, {
        canonical_branch_head: canonicalBranchHead,
        lifecycle_state: lifecycleState,
        active_role: activeRole,
        health,
        cleanup,
        integration,
      });

      if (dirty) {
        const closedAt = lifecycleState === "closed"
          ? (record.timestamps.closed_at ?? now)
          : null;

        await saveWorkspaceRecordToRegistry(projectDir, {
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
        anyDirty = true;
      }
      lastTaskRef = record.task_ref;
    }

    // Commit all registry changes once after the loop rather than per-record.
    // AC: @dispatch-workspace-registry ac-10 — only commit when at least one
    // record had a meaningful change.
    if (anyDirty && lastTaskRef) {
      await commitWorkspaceRegistryToShadow(projectDir, lastTaskRef);
    }
  });
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

// AC: @adopted-branch-cleanup-and-recoverability ac-4
// Removes a local branch ref that was created by dispatch solely for
// rehydrating an adopted externally-owned branch. This is distinct from
// deleteDispatchBranch, which refuses non-dispatch branches. This function
// is the cleanup counterpart: it safely removes the local mirror ref without
// affecting the externally-owned branch lineage on the remote.
function deleteRehydratedAdoptedBranch(projectDir: string, branch: string): void {
  if (!refExists(projectDir, `refs/heads/${branch}`)) {
    return;
  }
  // Safety: never delete protected branch names
  if (branch === "main" || branch === "master" || branch === "develop") {
    return;
  }
  runGitOrThrow(
    projectDir,
    ["branch", "-D", branch],
    `Failed to delete rehydrated adopted branch "${branch}"`,
    "Inspect branch state and active worktree registrations before retrying cleanup.",
  );
}

// ─── Dispatch Branch Push Lifecycle ──────────────────────────────────────────

/**
 * Check whether a branch has upstream tracking configured.
 * AC: @dispatch-remote-branch-sync ac-first-push-sets-tracking
 */
function hasUpstreamTracking(projectDir: string, branch: string): boolean {
  const result = runGit(projectDir, ["rev-parse", "--verify", "--quiet", `${branch}@{u}`]);
  return result.status === 0;
}

/**
 * Check whether a local branch has commits ahead of its upstream.
 * Returns false when there is no upstream or on error.
 */
function isLocalBranchAheadOfUpstream(projectDir: string, branch: string): boolean {
  const result = runGit(projectDir, [
    "rev-list", "--left-right", "--count", `${branch}...${branch}@{u}`,
  ]);
  if (result.status !== 0) return false;
  const [aheadStr] = result.stdout.trim().split("\t");
  const ahead = parseInt(aheadStr, 10);
  return ahead > 0;
}

export interface PushDispatchBranchResult {
  pushed: boolean;
  firstPush: boolean;
  error: string | null;
}

/**
 * Push a dispatch branch to remote after an invocation completes.
 *
 * Detects whether upstream tracking exists to decide first-push vs normal-push:
 * - First push: uses --force-with-lease to safely replace stale remote refs,
 *   then sets upstream tracking with -u.
 * - Subsequent push: normal push (tracking already established).
 *
 * AC: @dispatch-remote-branch-sync ac-first-push-sets-tracking
 * AC: @dispatch-remote-branch-sync ac-first-push-replaces-stale-ref
 * AC: @dispatch-remote-branch-sync ac-subsequent-push
 * AC: @dispatch-remote-branch-sync ac-push-non-fatal
 * AC: @dispatch-remote-branch-sync ac-no-remote
 */
export function pushDispatchBranch(
  projectDir: string,
  canonicalBranch: string,
  remote: string,
): PushDispatchBranchResult {
  // AC: @dispatch-remote-branch-sync ac-no-remote
  if (!remote) {
    return { pushed: false, firstPush: false, error: null };
  }

  const isFirstPush = !hasUpstreamTracking(projectDir, canonicalBranch);

  if (isFirstPush) {
    // AC: @dispatch-remote-branch-sync ac-first-push-sets-tracking
    // AC: @dispatch-remote-branch-sync ac-first-push-replaces-stale-ref
    // Use --force-with-lease to safely replace stale remote refs from previous runs.
    // --force-with-lease verifies the remote ref hasn't been updated by a concurrent
    // writer (it succeeds if the remote ref is empty or matches our expected value).
    const result = runGit(projectDir, [
      "push", "-u", "--force-with-lease", remote, canonicalBranch,
    ]);
    if (result.status !== 0) {
      // AC: @dispatch-remote-branch-sync ac-push-non-fatal
      return {
        pushed: false,
        firstPush: true,
        error: result.stderr || result.stdout || "push failed",
      };
    }
    return { pushed: true, firstPush: true, error: null };
  }

  // AC: @dispatch-remote-branch-sync ac-subsequent-push
  // Check if there are commits to push before attempting
  if (!isLocalBranchAheadOfUpstream(projectDir, canonicalBranch)) {
    return { pushed: false, firstPush: false, error: null };
  }
  const result = runGit(projectDir, ["push", remote, canonicalBranch]);
  if (result.status !== 0) {
    // AC: @dispatch-remote-branch-sync ac-push-non-fatal
    return {
      pushed: false,
      firstPush: false,
      error: result.stderr || result.stdout || "push failed",
    };
  }
  return { pushed: true, firstPush: false, error: null };
}

export interface PushIntegrationTargetResult {
  pushed: boolean;
  skipped: boolean;
  error: string | null;
}

/**
 * Push the integration target branch to remote.
 *
 * Called after reviewer merges and during periodic sync when the local
 * integration target has commits not yet on the remote.
 *
 * AC: @dispatch-remote-branch-sync ac-push-target-after-merge
 * AC: @dispatch-remote-branch-sync ac-push-target-periodic
 * AC: @dispatch-remote-branch-sync ac-push-non-fatal
 * AC: @dispatch-remote-branch-sync ac-no-remote
 */
export function pushIntegrationTarget(
  projectDir: string,
  integrationBranch: string,
  remote: string,
): PushIntegrationTargetResult {
  // AC: @dispatch-remote-branch-sync ac-no-remote
  if (!remote) {
    return { pushed: false, skipped: true, error: null };
  }

  // Check if the local branch is ahead of remote before pushing
  const hasTracking = hasUpstreamTracking(projectDir, integrationBranch);
  if (hasTracking && !isLocalBranchAheadOfUpstream(projectDir, integrationBranch)) {
    return { pushed: false, skipped: true, error: null };
  }

  // For integration target, always use -u to ensure tracking is established
  let result: GitResult;
  try {
    result = runDispatchIntegrationTargetGit(projectDir, integrationBranch, [
      "push",
      "-u",
      remote,
      integrationBranch,
    ]);
  } catch (err) {
    if (err instanceof DispatchWorkspaceError) {
      return {
        pushed: false,
        skipped: false,
        error: `${err.message} Resolution: ${err.suggestion}`,
      };
    }
    throw err;
  }
  if (result.status !== 0) {
    // AC: @dispatch-remote-branch-sync ac-push-non-fatal
    return {
      pushed: false,
      skipped: false,
      error: result.stderr || result.stdout || "push failed",
    };
  }
  return { pushed: true, skipped: false, error: null };
}

/**
 * Delete a remote dispatch branch ref during workspace cleanup.
 * Non-fatal: logs a warning on failure but does not throw.
 *
 * AC: @dispatch-remote-branch-sync ac-cleanup-remote-branch
 * AC: @dispatch-remote-branch-sync ac-no-remote
 */
export function deleteRemoteDispatchBranch(
  projectDir: string,
  canonicalBranch: string,
  remote: string,
): { deleted: boolean; error: string | null } {
  // AC: @dispatch-remote-branch-sync ac-no-remote
  if (!remote) {
    return { deleted: false, error: null };
  }

  // Only delete if the branch has been pushed (has upstream tracking)
  if (!hasUpstreamTracking(projectDir, canonicalBranch)) {
    return { deleted: false, error: null };
  }

  const result = runGit(projectDir, ["push", remote, "--delete", canonicalBranch]);
  if (result.status !== 0) {
    // AC: @dispatch-remote-branch-sync ac-cleanup-remote-branch — deletion failure is non-fatal
    return {
      deleted: false,
      error: result.stderr || result.stdout || "remote branch deletion failed",
    };
  }
  return { deleted: true, error: null };
}

/**
 * Resolve the first configured git remote name, or null if none.
 * AC: @dispatch-remote-branch-sync ac-no-remote
 */
export function resolveDispatchRemote(projectDir: string): string | null {
  const remotes = listGitRemotes(projectDir);
  return remotes.length > 0 ? remotes[0] : null;
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

  // Re-read the record inside the lock to avoid a TOCTOU race where a
  // concurrent writer (e.g. handleStateChange → reconcileDispatchWorkspaceLifecycle)
  // updates the registry between our initial read and the write below.
  await withDispatchShadowMutationLock(projectDir, taskRef, async () => {
    const latestRecord = await loadWorkspaceRecord(projectDir, taskRef);
    if (!latestRecord) return;

    const now = new Date().toISOString();
    const lifecycleState = latestRecord.cleanup.eligible ? "closing" : "ready";
    const updatedRecord: DispatchWorkspaceRecord = {
      ...latestRecord,
      lifecycle_state: lifecycleState,
      worktrees: {
        ...latestRecord.worktrees,
        reviewer: null,
      },
      health: reconcileWorkspaceHealth(projectDir, {
        ...latestRecord,
        worktrees: {
          ...latestRecord.worktrees,
          reviewer: null,
        },
      }, now),
      timestamps: {
        ...latestRecord.timestamps,
        updated_at: now,
        last_reconciled_at: now,
      },
    };
    await saveWorkspaceRecordToRegistry(projectDir, updatedRecord);
    await commitWorkspaceRegistryToShadow(projectDir, taskRef);
  });
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
  // AC: @dispatch-remote-branch-sync ac-cleanup-remote-branch
  // Delete the remote dispatch branch before deleting the local one.
  // Non-fatal: failure is logged but does not block cleanup.
  if (existing.metadata.branchProvenance.ownership !== "adopted") {
    const remote = resolveDispatchRemote(projectDir);
    if (remote) {
      const remoteResult = deleteRemoteDispatchBranch(
        projectDir,
        existing.metadata.canonicalBranch,
        remote,
      );
      if (remoteResult.error) {
        console.warn(
          `[dispatch] Failed to delete remote branch "${existing.metadata.canonicalBranch}" on ${remote}: ${remoteResult.error}`,
        );
      }
    }
  }

  // AC: @adopted-branch-cleanup-and-recoverability ac-1, ac-2, ac-4
  // Dispatcher-managed branches are always deleted on cleanup.
  // Adopted branches are preserved unless they were rehydrated (local ref
  // created by dispatch solely for adoption), in which case only the local
  // dispatch-side mirror ref is removed — the externally-owned branch lineage
  // lives on the remote and is not mutated.
  if (existing.metadata.branchProvenance.ownership !== "adopted") {
    deleteDispatchBranch(projectDir, existing.metadata.canonicalBranch);
  } else if (existing.metadata.branchProvenance.rehydrated) {
    deleteRehydratedAdoptedBranch(projectDir, existing.metadata.canonicalBranch);
  }
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
  const { projectDir, taskRef, task, role = "worker", cleanupState, submissionLinkage, taskStatus } = options;
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
  await ensureUsableWorktreeRoot(projectDir, resolvedConfig.worktreeRoot);

  const existingRecord = await loadWorkspaceRecord(projectDir, taskRef);
  const taskSlug = existingRecord?.task_slug ?? normalizeTaskSlug(taskRef, task);
  const shortId = shortTaskId(taskRef);

  // AC: @adopt-existing-task-branch-lineage ac-1, ac-2, ac-3, ac-4
  // When no workspace record exists but submission linkage provides a branch,
  // adopt that existing branch lineage instead of creating a fresh dispatch branch.
  // For pending_review or needs_work tasks without either, fail explicitly.
  const isReviewOrFixCycle = taskStatus === "pending_review" || taskStatus === "needs_work";
  let adoptedBranch: string | null = null;
  let adoptionRemoteRef: string | null = null;
  let adoptionRehydrated = false;

  if (!existingRecord && submissionLinkage?.branch) {
    const linkageBranch = submissionLinkage.branch;
    const branchExistsLocally = refExists(projectDir, `refs/heads/${linkageBranch}`);

    if (branchExistsLocally) {
      // AC: @adopt-existing-task-branch-lineage ac-1 — adopt the local branch directly
      adoptedBranch = linkageBranch;
    } else {
      // AC: @adopt-existing-task-branch-lineage ac-2 — rehydrate from remote
      const rehydrated = rehydrateAdoptedBranch(
        projectDir,
        linkageBranch,
        submissionLinkage.remote ?? null,
        submissionLinkage.remote_url ?? null,
      );
      if (rehydrated) {
        adoptedBranch = linkageBranch;
        adoptionRehydrated = true;
        adoptionRemoteRef = submissionLinkage.remote
          ? `${submissionLinkage.remote}/${linkageBranch}`
          : null;
      }
    }
  }

  // AC: @adopt-existing-task-branch-lineage ac-4 — explicit failure when no record
  // and no recoverable submission linkage for review/fix-cycle tasks.
  if (!existingRecord && !adoptedBranch && isReviewOrFixCycle) {
    const detail = submissionLinkage
      ? submissionLinkage.branch
        ? `Submission linkage references branch "${submissionLinkage.branch}" but it could not be found locally or on any remote.`
        : `Submission linkage exists but records no branch name (detached HEAD at ${submissionLinkage.commit}).`
      : `Task ${taskRef} has no submission linkage recorded.`;
    throw new DispatchWorkspaceError(
      `Cannot provision workspace for ${taskRef} in ${taskStatus}: no existing workspace record and no recoverable branch lineage. ${detail}`,
      `Ensure the task has submission linkage with a valid branch (kspec task set ${taskRef} --submission-linkage), or manually create the workspace branch and re-submit.`,
    );
  }

  const canonicalBranch = existingRecord?.canonical_branch
    ?? (adoptedBranch || `dispatch/task/${taskSlug}/${shortId}`);
  const branchProvenance: DispatchWorkspaceBranchProvenance = existingRecord?.branch_provenance
    ?? (adoptedBranch
      ? adoptedBranchProvenance(adoptedBranch, adoptionRemoteRef, new Date().toISOString(), adoptionRehydrated)
      : defaultBranchProvenance());
  const workspaceId = existingRecord?.workspace_id ?? workspaceIdFor(taskRef);
  const workerWorktreeDir = existingRecord?.worktrees.worker.path
    ?? findExistingWorktreeForBranch(projectDir, canonicalBranch)
    ?? path.join(resolvedConfig.worktreeRoot, `${taskSlug}-${shortId}`);
  const reviewerWorktreeDir = existingRecord?.worktrees.reviewer?.path
    ?? path.join(resolvedConfig.worktreeRoot, `${taskSlug}-${shortId}-review`);
  // AC: @dispatch-workspace-configuration ac-6 — detect stale integration target
  // when dispatch.base_branch config has changed since the workspace was provisioned.
  const mergeTargetBranch = resolveStaleIntegrationTarget(
    existingRecord,
    resolvedConfig.baseBranch,
    resolvedConfig.baseBranchSource,
    existingRecord?.resolved_base_branch ?? resolvedConfig.baseBranch,
  );
  // When the integration target was updated to match config, also update resolved_base_branch.
  const baseBranch = mergeTargetBranch === resolvedConfig.baseBranch
    ? resolvedConfig.baseBranch
    : (existingRecord?.resolved_base_branch ?? resolvedConfig.baseBranch);
  const baseBranchPoint = resolveBaseBranchPoint(
    projectDir,
    canonicalBranch,
    resolvedConfig.baseBranchStartPoint,
    existingRecord,
  );
  // When the integration target changed, resolve the commit from the new base branch
  // rather than reusing the stale base_branch_point from the existing record.
  const integrationTargetUpdated = existingRecord
    && existingRecord.integration.target_branch !== mergeTargetBranch;
  const integrationTargetCommit = integrationTargetUpdated
    ? resolveCommit(projectDir, resolvedConfig.baseBranchStartPoint)
    : (existingRecord?.integration.target_commit ?? baseBranchPoint);
  const publicationMode = resolveWorkspacePublicationMode(projectDir, existingRecord, resolvedConfig.publicationMode);
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
    branch_provenance: branchProvenance,
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
  // Perform git worktree operations before acquiring the shadow mutation lock
  // so we don't hold the lock during potentially slow git operations.
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

  // AC: @dispatch-workspace-registry ac-8 — both the provisioning and final
  // registry writes happen inside the shadow mutation lock, followed by a
  // single durable commit, so no uncommitted state is left on disk.
  const metadataPath = await withDispatchShadowMutationLock(projectDir, taskRef, async () => {
    const regPath = await saveWorkspaceRecordToRegistry(projectDir, provisioningRecord);
    await saveWorkspaceRecordToRegistry(projectDir, record);
    await commitWorkspaceRegistryToShadow(projectDir, taskRef);
    return regPath;
  });

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

  // If a lifecycle reconciliation (e.g. task completed/cancelled) has already
  // moved the record into a terminal state, don't regress it.  The taskStatus
  // passed here is from the invocation's original dispatch event and may be
  // stale relative to the current record.
  const terminalStates = new Set(["closing", "cleanup_blocked", "closed"]);
  if (terminalStates.has(existingRecord.lifecycle_state)) {
    const now = new Date().toISOString();
    const record: DispatchWorkspaceRecord = {
      ...existingRecord,
      active_role: null,
      timestamps: {
        ...existingRecord.timestamps,
        updated_at: now,
        last_reconciled_at: now,
      },
    };
    const metadataPath = await persistWorkspaceRecord(options.projectDir, record);
    return {
      cwd: record.worktrees.worker.path,
      metadataPath,
      metadata: toMetadata(record),
    };
  }

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

// ─── Review and Fix-Cycle Workspace Discovery ───────────────────────────────

/**
 * Result of workspace discovery attempt for review or fix-cycle tasks.
 *
 * AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1 through ac-4
 */
export interface WorkspaceDiscoveryResult {
  /** Whether a recoverable workspace was found. */
  recovered: boolean;
  /** Source that provided recovery, if any. */
  recoverySource:
    | "registry-state"
    | "metadata-backed-worktree"
    | "task-submission-linkage"
    | "remote-or-review-locator"
    | null;
  /** Updated health after recovery attempt. */
  health: DispatchWorkspaceHealth;
  /** Diagnostics when recovery fails — task-linked messages with guidance. */
  diagnostics: WorkspaceDiscoveryDiagnostic[];
  /** When multiple branch signals conflict, details of the conflict. */
  conflictingSignals: BranchSignal[] | null;
}

export interface WorkspaceDiscoveryDiagnostic {
  taskRef: string;
  code: string;
  message: string;
  suggestion: string;
}

export interface BranchSignal {
  source: string;
  branch: string;
}

/**
 * Submission linkage shape for discovery. Matches the SubmissionLinkage type
 * from schema/common.ts but defined here to avoid circular imports.
 */
interface DiscoverySubmissionLinkage {
  branch: string | null;
  commit: string;
  remote?: string | null;
  remote_url?: string | null;
  upstream_ref?: string | null;
  review_url?: string | null;
  captured_at: string;
}

/**
 * Attempt workspace discovery and recovery for a `pending_review` or
 * `needs_work` dispatch entry that has no healthy local workspace candidate.
 *
 * Applies explicit precedence ordering (AC-4):
 *   1. Existing registry state
 *   2. Metadata-backed worktrees
 *   3. Recorded task submission linkage
 *   4. Remote or review-derived discovery
 *
 * If recovery succeeds, the workspace is adopted or re-registered so normal
 * provisioning can proceed (AC-2).
 *
 * If no trustworthy recovery path exists, returns structured diagnostics
 * with task-linked recovery guidance (AC-3).
 *
 * When multiple branch signals exist and cannot be reconciled, blocks with
 * diagnostics rather than guessing (AC-4).
 *
 * AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1
 * AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-2
 * AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-3
 * AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-4
 */
export async function discoverWorkspaceForReviewOrFixCycle(options: {
  projectDir: string;
  taskRef: string;
  role?: DispatchWorkspaceRole;
  task?: {
    title?: string;
    slugs?: string[];
    submission_linkage?: DiscoverySubmissionLinkage | null;
    review_url?: string;
  };
}): Promise<WorkspaceDiscoveryResult> {
  const { projectDir, taskRef, role = "worker", task } = options;
  const diagnostics: WorkspaceDiscoveryDiagnostic[] = [];
  const branchSignals: BranchSignal[] = [];

  // Phase 1: Registry state — the highest precedence source.
  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1, ac-4
  const existingRecord = await loadWorkspaceRecord(projectDir, taskRef);
  if (existingRecord) {
    branchSignals.push({
      source: "registry-state",
      branch: existingRecord.canonical_branch,
    });
    // Registry record exists but workspace may be unhealthy.
    // Attempt to reconcile: restore branch from remote if missing.
    // reconcileWorkspaceHealth internally calls tryRestoreBranchFromRemote.
    const now = new Date().toISOString();
    const health = reconcileWorkspaceHealth(projectDir, existingRecord, now);
    // Recovery is successful if the canonical branch is intact (healthy or
    // stale). Stale means worktrees are missing but the branch exists —
    // provisioning can recreate them. Only "invalid" (missing canonical
    // branch) is truly unrecoverable from registry state alone.
    if (health.status !== "invalid") {
      return {
        recovered: true,
        recoverySource: "registry-state",
        health: await getDispatchWorkspaceHealth({ projectDir, taskRef, role, task }),
        diagnostics: [],
        conflictingSignals: null,
      };
    }
    // Registry exists but canonical branch is missing everywhere —
    // continue to collect other signals for potential conflict detection
    // or alternative recovery.
  }

  // Phase 2: Metadata-backed worktrees — scan worktree root for metadata
  // files that reference this task.
  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1
  let metadataCandidate: { branch: string; worktreeDir: string } | null = null;
  try {
    const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
    const worktreeEntries = parseWorktreeList(projectDir);
    const entriesUnderRoot = worktreeEntries.filter((entry) =>
      isPathInside(resolvedConfig.worktreeRoot, entry.path)
    );
    for (const entry of entriesUnderRoot) {
      const metadata = await readWorkspaceMetadata(entry.path);
      if (metadata && metadata.taskRef === taskRef) {
        metadataCandidate = {
          branch: metadata.canonicalBranch,
          worktreeDir: entry.path,
        };
        branchSignals.push({
          source: "metadata-backed-worktree",
          branch: metadata.canonicalBranch,
        });
        break;
      }
    }
  } catch {
    // Config or worktree listing failure is non-fatal for discovery.
  }

  // If we recovered from metadata but had no registry record, attempt
  // to reconstruct the registry record from the worktree metadata.
  if (metadataCandidate && !existingRecord) {
    try {
      const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
      const recovered = await recoverWorkspaceRecordFromMetadata(
        projectDir,
        resolvedConfig,
        metadataCandidate.worktreeDir,
      );
      if (recovered) {
        await withDispatchShadowMutationLock(projectDir, taskRef, async () => {
          await saveWorkspaceRecordToRegistry(projectDir, recovered);
          await commitWorkspaceRegistryToShadow(projectDir, taskRef);
        });
        // Re-check health after metadata recovery. The record is restored
        // but the workspace may still be unhealthy (e.g. missing worktrees).
        // Only consider this recovered if the canonical branch is intact
        // so provisioning can recreate missing worktrees.
        const postRecoveryHealth = reconcileWorkspaceHealth(
          projectDir, recovered, new Date().toISOString(),
        );
        if (postRecoveryHealth.status !== "invalid") {
          return {
            recovered: true,
            recoverySource: "metadata-backed-worktree",
            health: await getDispatchWorkspaceHealth({ projectDir, taskRef, role, task }),
            diagnostics: [],
            conflictingSignals: null,
          };
        }
        // Record restored but workspace is invalid — continue collecting
        // signals for potential alternative recovery.
      }
    } catch {
      // Recovery failure is non-fatal; continue to next source.
    }
  }

  // Phase 3: Task submission linkage — use the captured branch/commit
  // from the task's submission to discover or adopt the branch.
  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1, ac-4
  const submissionLinkage = task?.submission_linkage;
  if (submissionLinkage?.branch) {
    branchSignals.push({
      source: "task-submission-linkage",
      branch: submissionLinkage.branch,
    });

    // Check if the branch exists locally or on a remote.
    const branchRef = `refs/heads/${submissionLinkage.branch}`;
    let branchAvailable = refExists(projectDir, branchRef);
    let branchRehydrated = false;
    if (!branchAvailable) {
      branchAvailable = tryRestoreBranchFromRemote(projectDir, submissionLinkage.branch);
      branchRehydrated = branchAvailable;
    }

    if (branchAvailable && !existingRecord) {
      // Adopt the submission branch as the canonical branch for this task.
      try {
        const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
        const now = new Date().toISOString();
        const taskSlug = normalizeTaskSlug(taskRef, task);
        const shortId = shortTaskId(taskRef);
        const workspaceId = workspaceIdFor(taskRef);
        const workerWorktreeDir = findExistingWorktreeForBranch(projectDir, submissionLinkage.branch)
          ?? path.join(resolvedConfig.worktreeRoot, `${taskSlug}-${shortId}`);
        const baseBranch = resolvedConfig.baseBranch;
        const baseBranchPoint = resolvedConfig.baseBranchStartPoint;
        const publicationMode = resolvePublicationMode(projectDir, resolvedConfig.publicationMode);

        const adoptedRecord: DispatchWorkspaceRecord = {
          workspace_id: workspaceId,
          task_ref: taskRef,
          task_slug: taskSlug,
          worktree_root: resolvedConfig.worktreeRoot,
          resolved_base_branch: baseBranch,
          base_branch_point: baseBranchPoint,
          canonical_branch: submissionLinkage.branch,
          canonical_branch_head: submissionLinkage.commit,
          branch_provenance: adoptedBranchProvenance(
            submissionLinkage.branch,
            submissionLinkage.remote ?? null,
            now,
            branchRehydrated,
          ),
          lifecycle_state: "ready",
          active_role: null,
          worktrees: {
            worker: buildWorktreeRecord(
              workerWorktreeDir,
              "branch",
              submissionLinkage.branch,
              submissionLinkage.commit,
              now,
            ),
            reviewer: null,
          },
          bootstrap: defaultBootstrapState(now),
          integration: {
            status: "pending",
            target_branch: baseBranch,
            target_commit: baseBranchPoint,
            publication_mode: publicationMode,
            outcome: resolveIntegrationOutcome(publicationMode, "pending"),
            detail: null,
            updated_at: now,
          },
          health: createHealthyState(now),
          cleanup: {
            status: "not_scheduled",
            eligible: false,
            reason: null,
            detail: null,
            updated_at: now,
          },
          timestamps: {
            created_at: now,
            updated_at: now,
            last_reconciled_at: now,
            last_active_at: null,
            closed_at: null,
          },
        };

        await withDispatchShadowMutationLock(projectDir, taskRef, async () => {
          await saveWorkspaceRecordToRegistry(projectDir, adoptedRecord);
          await commitWorkspaceRegistryToShadow(projectDir, taskRef);
        });

        console.log(
          `[dispatch] Adopted branch "${submissionLinkage.branch}" from task submission linkage for ${taskRef}`,
        );

        return {
          recovered: true,
          recoverySource: "task-submission-linkage",
          health: await getDispatchWorkspaceHealth({ projectDir, taskRef, role, task }),
          diagnostics: [],
          conflictingSignals: null,
        };
      } catch {
        // Adoption failure is non-fatal; continue to next source.
      }
    }
  }

  // Phase 4: Remote or review-derived discovery — try the deterministic
  // dispatch branch name on remotes as a last resort.
  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1, ac-4
  if (!existingRecord) {
    const taskSlug = normalizeTaskSlug(taskRef, task);
    const shortId = shortTaskId(taskRef);
    const syntheticBranch = `dispatch/task/${taskSlug}/${shortId}`;
    const restoredFromRemote = tryRestoreBranchFromRemote(projectDir, syntheticBranch);
    if (restoredFromRemote) {
      branchSignals.push({
        source: "remote-or-review-locator",
        branch: syntheticBranch,
      });
      try {
        const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
        const now = new Date().toISOString();
        const workspaceId = workspaceIdFor(taskRef);
        const workerWorktreeDir = findExistingWorktreeForBranch(projectDir, syntheticBranch)
          ?? path.join(resolvedConfig.worktreeRoot, `${taskSlug}-${shortId}`);
        const baseBranch = resolvedConfig.baseBranch;
        const baseBranchPoint = resolvedConfig.baseBranchStartPoint;
        const publicationMode = resolvePublicationMode(projectDir, resolvedConfig.publicationMode);

        const remoteRecord: DispatchWorkspaceRecord = {
          workspace_id: workspaceId,
          task_ref: taskRef,
          task_slug: taskSlug,
          worktree_root: resolvedConfig.worktreeRoot,
          resolved_base_branch: baseBranch,
          base_branch_point: baseBranchPoint,
          canonical_branch: syntheticBranch,
          canonical_branch_head: resolveCommit(projectDir, syntheticBranch),
          branch_provenance: defaultBranchProvenance(),
          lifecycle_state: "ready",
          active_role: null,
          worktrees: {
            worker: buildWorktreeRecord(
              workerWorktreeDir,
              "branch",
              syntheticBranch,
              resolveCommit(projectDir, syntheticBranch),
              now,
            ),
            reviewer: null,
          },
          bootstrap: defaultBootstrapState(now),
          integration: {
            status: "pending",
            target_branch: baseBranch,
            target_commit: baseBranchPoint,
            publication_mode: publicationMode,
            outcome: resolveIntegrationOutcome(publicationMode, "pending"),
            detail: null,
            updated_at: now,
          },
          health: createHealthyState(now),
          cleanup: {
            status: "not_scheduled",
            eligible: false,
            reason: null,
            detail: null,
            updated_at: now,
          },
          timestamps: {
            created_at: now,
            updated_at: now,
            last_reconciled_at: now,
            last_active_at: null,
            closed_at: null,
          },
        };

        await withDispatchShadowMutationLock(projectDir, taskRef, async () => {
          await saveWorkspaceRecordToRegistry(projectDir, remoteRecord);
          await commitWorkspaceRegistryToShadow(projectDir, taskRef);
        });

        console.log(
          `[dispatch] Restored dispatch branch "${syntheticBranch}" from remote for ${taskRef}`,
        );

        return {
          recovered: true,
          recoverySource: "remote-or-review-locator",
          health: await getDispatchWorkspaceHealth({ projectDir, taskRef, role, task }),
          diagnostics: [],
          conflictingSignals: null,
        };
      } catch {
        // Remote recovery failure is non-fatal; fall through to diagnostics.
      }
    }
  }

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-4
  // Check for conflicting branch signals before emitting final diagnostics.
  const uniqueBranches = new Set(branchSignals.map((s) => s.branch));
  if (uniqueBranches.size > 1) {
    diagnostics.push({
      taskRef,
      code: "conflicting-branch-signals",
      message: `Multiple branch signals exist for ${taskRef} that cannot be reconciled safely: ${branchSignals.map((s) => `${s.source}="${s.branch}"`).join(", ")}.`,
      suggestion:
        "Inspect task submission linkage and workspace registry state. Use `kspec task set @ref --submission-linkage` to repair the branch-of-record, or delete stale workspace records.",
    });
    return {
      recovered: false,
      recoverySource: null,
      health: await getDispatchWorkspaceHealth({ projectDir, taskRef, role, task }),
      diagnostics,
      conflictingSignals: branchSignals,
    };
  }

  // If we had a registry record but it was unhealthy and no other source
  // helped, the registry recovery is our best signal. Re-check health.
  if (existingRecord && branchSignals.length === 1) {
    const updatedHealth = await getDispatchWorkspaceHealth({ projectDir, taskRef, role, task });
    if (updatedHealth.healthy) {
      return {
        recovered: true,
        recoverySource: "registry-state",
        health: updatedHealth,
        diagnostics: [],
        conflictingSignals: null,
      };
    }
  }

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-3
  // No trustworthy recovery path exists — emit explicit diagnostics.
  diagnostics.push({
    taskRef,
    code: "no-recoverable-workspace",
    message: `No trustworthy recovery path exists for ${taskRef}. Attempted: registry state, metadata-backed worktrees, task submission linkage, and remote/review locators.`,
    suggestion: existingRecord
      ? "The workspace registry record exists but the canonical branch is missing. Restore the branch from a backup, push it to a remote, or use `kspec task set @ref --submission-linkage` to update the branch-of-record."
      : "No workspace record or branch could be found for this task. Ensure the task was submitted with `kspec task submit` (which captures submission linkage), or manually provision a workspace with `kspec agent workspace provision`.",
  });

  return {
    recovered: false,
    recoverySource: null,
    health: await getDispatchWorkspaceHealth({ projectDir, taskRef, role, task }),
    diagnostics,
    conflictingSignals: null,
  };
}
