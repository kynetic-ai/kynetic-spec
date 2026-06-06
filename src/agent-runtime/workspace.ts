import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { initContext } from "../parser/index.js";
import { findPlanByRef } from "../parser/plans.js";
import { resolveTaskDataManager } from "../parser/task-data-manager.js";
import { acquireFileLock, type FileLockAcquireInfo } from "../parser/file-lock.js";
import {
  deleteDispatchWorkspaceRecord,
  getDispatchWorkspaceRegistryPath,
  loadDispatchWorkspaceRegistry,
  saveDispatchWorkspaceRecord,
  type LoadedDispatchWorkspaceRecord,
} from "../parser/dispatch-workspaces.js";
import { loadProjectConfig } from "../parser/config.js";
import { commitIfShadow } from "../parser/shadow.js";
import { buildTaskRefResolver, type TaskRefResolver } from "./task-identity.js";
import type { KspecContext } from "../parser/yaml.js";
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
const DISPATCH_CHECKOUT_COHERENCE_FILE = "kspec-dispatch-checkout-coherence.json";

interface GitResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

interface RunGitOptions {
  timeout?: number;
}

interface DispatchCheckoutCoherenceSnapshot {
  headCommit: string;
  tree: string;
  recordedAt: string;
}

interface DispatchCheckoutCoherenceState {
  version: 1;
  branches: Record<string, DispatchCheckoutCoherenceSnapshot>;
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

/**
 * Environment variables set on all dispatch git subprocesses to prevent
 * interactive credential prompts that would hang the daemon/dispatch engine.
 *
 * GIT_TERMINAL_PROMPT=0 tells git to fail immediately instead of prompting
 * for credentials when no credential helper is configured.
 */
const DISPATCH_GIT_ENV_OVERRIDES: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
};

export interface ResolvedDispatchWorkspaceConfig {
  baseBranch: string;
  baseBranchStartPoint: string;
  baseBranchSource: "plan" | "configured" | "remote-head" | "current-branch" | "default";
  baseBranchPlanRef?: string;
  baseBranchPlanTitle?: string;
  worktreeRoot: string;
  publicationMode: "pull_request" | "manual_merge" | "auto";
}

export interface DispatchWorkspaceMetadata {
  workspaceId: string;
  /**
   * Canonical full task ULID — authoritative workspace identity. May be null
   * for legacy metadata persisted before canonical identity tracking; resolved
   * from taskRef on registry write.
   * AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
   */
  taskId: string | null;
  /** Display task ref (slug or @ULID); never an identity key. */
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
    plan_ref?: string | null;
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
  taskStatus?:
    | "pending"
    | "in_progress"
    | "needs_work"
    | "pending_review"
    | "blocked"
    | "completed"
    | "cancelled"
    | null;
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

export interface ValidateDispatchWorkspaceForInvocationOptions {
  projectDir: string;
  taskRef: string;
  workspace: ProvisionedDispatchWorkspace;
  role?: DispatchWorkspaceRole;
  task?: {
    title?: string;
    slugs?: string[];
  };
  submissionLinkage?: ProvisionDispatchWorkspaceOptions["submissionLinkage"];
  taskStatus?: ResolveDispatchWorkspaceCleanupStateOptions["taskStatus"];
  allowRecovery?: boolean;
}

export interface ValidateDispatchWorkspaceForInvocationResult {
  workspace: ProvisionedDispatchWorkspace;
  repaired: boolean;
}

export type DispatchWorkspaceErrorCode = "occupied-checkout";

export class DispatchWorkspaceError extends Error {
  suggestion: string;
  code: DispatchWorkspaceErrorCode | null;

  constructor(message: string, suggestion: string, code: DispatchWorkspaceErrorCode | null = null) {
    super(message);
    this.name = "DispatchWorkspaceError";
    this.suggestion = suggestion;
    this.code = code;
  }
}

async function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: buildDispatchGitEnv(),
      encoding: "utf-8",
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    });
    return {
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
      status: 0,
    };
  } catch (err: unknown) {
    // execFile rejects on non-zero exit; extract stdout/stderr/code
    const e = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return {
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? "").trim(),
      status: typeof e.code === "number" ? e.code : e.killed ? null : 1,
    };
  }
}

async function probeWorkspaceExecutability(
  workspaceDir: string,
): Promise<WorkspaceExecutabilityProbeResult> {
  const stat = await fs.stat(workspaceDir).catch((error: unknown) => {
    const fsError = error as { code?: string; message?: string };
    return fsError.code === "ENOENT" ? null : { message: fsError.message ?? String(error) };
  });
  if (stat === null) {
    return {
      ok: false,
      failureType: "missing",
      detail: `Workspace path "${workspaceDir}" does not exist.`,
    };
  }
  if ("message" in stat) {
    return {
      ok: false,
      failureType: "inaccessible",
      detail: `Workspace path "${workspaceDir}" could not be inspected: ${stat.message}`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      failureType: "not-directory",
      detail: `Workspace path "${workspaceDir}" is not a directory.`,
    };
  }

  try {
    await fs.access(workspaceDir, fsConstants.R_OK | fsConstants.X_OK);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      failureType: "inaccessible",
      detail: `Workspace path "${workspaceDir}" is not accessible: ${message}`,
    };
  }

  try {
    await execFileAsync(process.execPath, ["-e", "process.exit(0)"], {
      cwd: workspaceDir,
      encoding: "utf-8",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch (error: unknown) {
    const execError = error as {
      stderr?: string;
      stdout?: string;
      message?: string;
      code?: number | string;
    };
    const stderr = typeof execError.stderr === "string" ? execError.stderr.trim() : "";
    const stdout = typeof execError.stdout === "string" ? execError.stdout.trim() : "";
    const suffix = [stderr, stdout, execError.message].filter((value) => value).join(" | ");
    return {
      ok: false,
      failureType: "not-runnable",
      detail: `Executability probe failed in "${workspaceDir}"${suffix ? `: ${suffix}` : "."}`,
    };
  }

  return {
    ok: true,
    failureType: null,
    detail: null,
  };
}

export function buildDispatchGitEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of DISPATCH_GIT_ENV_KEYS) {
    delete env[key];
  }
  Object.assign(env, DISPATCH_GIT_ENV_OVERRIDES);
  return env;
}

type WorkspaceExecutabilityFailureType =
  | "missing"
  | "not-directory"
  | "inaccessible"
  | "not-runnable";

interface WorkspaceExecutabilityProbeResult {
  ok: boolean;
  failureType: WorkspaceExecutabilityFailureType | null;
  detail: string | null;
}

function resolveDispatchMutationLockTimeoutMs(): number {
  const raw = process.env.KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS;
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function runGitOrThrow(
  cwd: string,
  args: string[],
  message: string,
  suggestion: string,
): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.status === 0) {
    return result.stdout;
  }
  const detail = result.stderr || result.stdout || "git command failed";
  throw new DispatchWorkspaceError(`${message}: ${detail}`, suggestion);
}

async function listGitRemotes(projectDir: string): Promise<string[]> {
  const result = await runGit(projectDir, ["remote"]);
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  const remotes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .toSorted();
  const originFirst = remotes.filter((remote) => remote === "origin");
  const rest = remotes.filter((remote) => remote !== "origin");
  return [...originFirst, ...rest];
}

async function refExists(projectDir: string, ref: string): Promise<boolean> {
  const result = await runGit(projectDir, ["show-ref", "--verify", "--quiet", ref]);
  return result.status === 0;
}

async function resolveBranchStartPoint(
  projectDir: string,
  branch: string,
): Promise<{ startPoint: string; branch: string } | null> {
  if (await refExists(projectDir, `refs/heads/${branch}`)) {
    return { startPoint: branch, branch };
  }

  for (const remote of await listGitRemotes(projectDir)) {
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    if (await refExists(projectDir, remoteRef)) {
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
async function tryRestoreBranchFromRemote(projectDir: string, branch: string): Promise<boolean> {
  for (const remote of await listGitRemotes(projectDir)) {
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    if (!(await refExists(projectDir, remoteRef))) continue;
    const result = await runGit(projectDir, ["branch", branch, `${remote}/${branch}`]);
    if (result.status === 0) {
      return true;
    }
    console.debug(
      `[dispatch] Failed to restore branch "${branch}" from ${remote}: ${result.stderr || result.stdout}`,
    );
  }
  return false;
}

export async function resolveRemoteHeadBranch(projectDir: string): Promise<string | null> {
  for (const remote of await listGitRemotes(projectDir)) {
    const result = await runGit(projectDir, [
      "symbolic-ref",
      "--quiet",
      `refs/remotes/${remote}/HEAD`,
    ]);
    if (result.status !== 0 || !result.stdout) continue;
    const prefix = `refs/remotes/${remote}/`;
    if (result.stdout.startsWith(prefix)) {
      return result.stdout.slice(prefix.length);
    }
  }
  return null;
}

export async function resolveCurrentBranch(projectDir: string): Promise<string | null> {
  const result = await runGit(projectDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

/**
 * Resolve the repository's default branch using the dispatcher's standard
 * fallback chain: remote HEAD → current branch → "main" literal.
 *
 * Returns both the resolved branch name and whether the result is a fallback.
 * Shared by dispatch workspace provisioning and setup config scaffolding.
 */
export async function resolveDefaultBranch(
  projectDir: string,
): Promise<{ branch: string; source: "remote-head" | "current-branch" | "fallback" }> {
  // Each candidate is verified via resolveBranchStartPoint before committing,
  // matching resolveDispatchWorkspaceConfig's fallback chain so a stale remote
  // HEAD (pointing to a deleted branch) falls through to the current branch.
  const remoteHead = await resolveRemoteHeadBranch(projectDir);
  if (remoteHead) {
    const resolved = await resolveBranchStartPoint(projectDir, remoteHead);
    if (resolved) {
      return { branch: remoteHead, source: "remote-head" };
    }
  }

  const currentBranch = await resolveCurrentBranch(projectDir);
  if (currentBranch) {
    return { branch: currentBranch, source: "current-branch" };
  }

  return { branch: "main", source: "fallback" };
}

interface DispatchCheckoutCoherenceResult {
  repaired: boolean;
  drifted: boolean;
  previousCommit: string | null;
}

async function resolveDispatchCheckoutCoherencePath(projectDir: string): Promise<string | null> {
  const result = await runGit(projectDir, [
    "rev-parse",
    "--git-path",
    DISPATCH_CHECKOUT_COHERENCE_FILE,
  ]);
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  return path.isAbsolute(result.stdout) ? result.stdout : path.join(projectDir, result.stdout);
}

async function loadDispatchCheckoutCoherenceSnapshot(
  projectDir: string,
  branch: string,
): Promise<DispatchCheckoutCoherenceSnapshot | null> {
  const coherencePath = await resolveDispatchCheckoutCoherencePath(projectDir);
  if (!coherencePath) {
    return null;
  }

  try {
    const raw = await fs.readFile(coherencePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DispatchCheckoutCoherenceState>;
    if (parsed.version !== 1 || !parsed.branches || typeof parsed.branches !== "object") {
      return null;
    }
    const snapshot = parsed.branches[branch];
    if (!snapshot || typeof snapshot.headCommit !== "string" || typeof snapshot.tree !== "string") {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

async function persistDispatchCheckoutCoherenceSnapshot(
  projectDir: string,
  branch: string,
  snapshot: DispatchCheckoutCoherenceSnapshot,
): Promise<void> {
  const coherencePath = await resolveDispatchCheckoutCoherencePath(projectDir);
  if (!coherencePath) {
    return;
  }

  let state: DispatchCheckoutCoherenceState = { version: 1, branches: {} };
  try {
    const raw = await fs.readFile(coherencePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DispatchCheckoutCoherenceState>;
    if (parsed.version === 1 && parsed.branches && typeof parsed.branches === "object") {
      state = {
        version: 1,
        branches: parsed.branches as Record<string, DispatchCheckoutCoherenceSnapshot>,
      };
    }
  } catch {
    state = { version: 1, branches: {} };
  }

  state.branches[branch] = snapshot;
  await fs.writeFile(coherencePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

async function resolveBranchTree(projectDir: string, ref: string): Promise<string | null> {
  const result = await runGit(projectDir, ["rev-parse", `${ref}^{tree}`]);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

async function resolveIndexTree(projectDir: string): Promise<string | null> {
  const result = await runGit(projectDir, ["write-tree"]);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

async function listRecentBranchReflogCommits(
  projectDir: string,
  branch: string,
  limit = 20,
): Promise<string[]> {
  const result = await runGit(projectDir, ["reflog", "show", "--format=%H", `-n${limit}`, branch]);
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  return Array.from(
    new Set(
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  );
}

function buildUnsafeCheckoutDriftError(
  integrationBranch: string,
  detail: string,
  suggestion: string,
): DispatchWorkspaceError {
  return new DispatchWorkspaceError(
    `Dispatch detected shared-checkout drift for integration target "${integrationBranch}" but refused automatic repair because ${detail}.`,
    suggestion,
  );
}

export async function ensureDispatchIntegrationTargetCheckoutCoherence(
  projectDir: string,
  integrationBranch: string,
): Promise<DispatchCheckoutCoherenceResult> {
  const headCommit = await resolveCommit(projectDir, "HEAD");
  const status = await runGit(projectDir, ["status", "--porcelain"]);
  if (status.status !== 0) {
    throw new DispatchWorkspaceError(
      `Dispatch could not inspect shared checkout state for integration target "${integrationBranch}".`,
      `Run 'git status' in ${projectDir}, fix the git error, and retry dispatch.`,
    );
  }
  const headTree = await resolveBranchTree(projectDir, "HEAD");
  if (!status.stdout) {
    if (headTree) {
      await persistDispatchCheckoutCoherenceSnapshot(projectDir, integrationBranch, {
        headCommit,
        tree: headTree,
        recordedAt: new Date().toISOString(),
      });
    }
    return { repaired: false, drifted: false, previousCommit: null };
  }

  const worktreeDiff = await runGit(projectDir, ["diff", "--quiet"]);
  if (worktreeDiff.status !== 0 && worktreeDiff.status !== 1) {
    throw new DispatchWorkspaceError(
      `Dispatch could not compare the working tree against the index for integration target "${integrationBranch}".`,
      `Run 'git diff' in ${projectDir}, resolve the git error, and retry dispatch.`,
    );
  }
  if (worktreeDiff.status === 1) {
    throw buildUnsafeCheckoutDriftError(
      integrationBranch,
      "the working tree has tracked modifications",
      `Review the local changes in ${projectDir}, then commit/stash/discard them before retrying. If the branch tip is authoritative, run 'git checkout ${integrationBranch} && git reset --hard ${integrationBranch}'.`,
    );
  }

  const indexTree = await resolveIndexTree(projectDir);
  if (!indexTree || !headTree) {
    throw new DispatchWorkspaceError(
      `Dispatch could not compare index state against HEAD for integration target "${integrationBranch}".`,
      `Run 'git status' in ${projectDir}, repair the repository state, and retry dispatch.`,
    );
  }
  if (indexTree === headTree) {
    await persistDispatchCheckoutCoherenceSnapshot(projectDir, integrationBranch, {
      headCommit,
      tree: headTree,
      recordedAt: new Date().toISOString(),
    });
    return { repaired: false, drifted: false, previousCommit: null };
  }

  const snapshot = await loadDispatchCheckoutCoherenceSnapshot(projectDir, integrationBranch);
  if (snapshot?.headCommit === headCommit) {
    throw buildUnsafeCheckoutDriftError(
      integrationBranch,
      "the index contains staged tracked changes after dispatch already observed this branch tip as coherent",
      `Inspect 'git status' and 'git diff --cached' in ${projectDir}. Commit/stash/discard those staged changes before retrying. If the branch tip is authoritative and the staged changes should be discarded, run 'git checkout ${integrationBranch} && git reset --hard ${integrationBranch}'.`,
    );
  }

  const candidateCommits = snapshot?.headCommit
    ? [snapshot.headCommit]
    : await listRecentBranchReflogCommits(projectDir, integrationBranch);
  for (const commit of candidateCommits) {
    if (commit === headCommit) continue;
    if ((await resolveBranchTree(projectDir, commit)) !== indexTree) continue;

    const repair = await runGit(projectDir, ["reset", "--hard", "HEAD"]);
    if (repair.status !== 0) {
      throw new DispatchWorkspaceError(
        `Dispatch detected shared-checkout drift for integration target "${integrationBranch}" but failed to repair it automatically.`,
        `Run 'git checkout ${integrationBranch} && git reset --hard ${integrationBranch}' in ${projectDir}, then retry dispatch.`,
      );
    }

    const repairedWorktreeDiff = await runGit(projectDir, ["diff", "--quiet"]);
    const repairedIndexDiff = await runGit(projectDir, ["diff", "--cached", "--quiet"]);
    if (repairedWorktreeDiff.status !== 0 || repairedIndexDiff.status !== 0) {
      throw new DispatchWorkspaceError(
        `Dispatch repaired shared-checkout drift for integration target "${integrationBranch}" but tracked checkout drift is still present.`,
        `Inspect 'git diff' and 'git diff --cached' in ${projectDir}, clear any remaining tracked changes, and retry dispatch.`,
      );
    }

    await persistDispatchCheckoutCoherenceSnapshot(projectDir, integrationBranch, {
      headCommit,
      tree: headTree,
      recordedAt: new Date().toISOString(),
    });
    return { repaired: true, drifted: true, previousCommit: commit };
  }

  throw buildUnsafeCheckoutDriftError(
    integrationBranch,
    "the index contains staged or drifted tracked changes that do not match a known prior branch tip",
    `Inspect 'git status' and 'git diff --cached' in ${projectDir}. Commit/stash/discard those changes, then retry dispatch. If the branch tip is authoritative, run 'git checkout ${integrationBranch} && git reset --hard ${integrationBranch}'.`,
  );
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

/**
 * Deterministic short identity segment for a task. When a canonical full task
 * ULID is known, the short id is the first 8 ULID characters so workspace
 * lineage (branch names, worktree basenames) stays stable across every display
 * alias of the same task. Falls back to the raw ref for inputs that cannot be
 * canonicalized.
 *
 * AC: @dispatch-canonical-task-identity ac-workspace-lineage-stable-across-aliases
 */
function shortTaskId(taskRefOrId: string): string {
  return taskRefOrId.replace(/^@/, "").slice(0, 8).toLowerCase();
}

/**
 * Workspace id keyed on canonical task identity so aliases of the same task
 * resolve to the same workspace record.
 *
 * AC: @dispatch-canonical-task-identity ac-workspace-lineage-stable-across-aliases
 */
function workspaceIdFor(taskRefOrId: string): string {
  return `dispatch-workspace-${taskRefOrId.replace(/^@/, "")}`;
}

/**
 * Canonical protection key for a task identifier: the ULID with any leading `@`
 * stripped and case-normalized, so an active/in-flight entry supplied as a bare
 * canonical ULID protects a record persisted under a display alias, and vice
 * versa.
 *
 * AC: @dispatch-canonical-task-identity ac-cleanup-protection-uses-canonical-task
 */
function normalizeProtectionKey(value: string): string {
  return value.replace(/^@/, "").toUpperCase();
}

/**
 * Build a task-ref resolver for the project so workspace lookups can compare
 * records by canonical task ULID rather than raw display refs.
 */
async function buildProjectTaskResolver(ctx: KspecContext): Promise<TaskRefResolver | null> {
  try {
    const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
    return buildTaskRefResolver(tasks);
  } catch {
    return null;
  }
}

/**
 * Resolve a task ref (slug, full ULID, or unique ULID prefix) to its canonical
 * full task ULID, or null when it cannot be uniquely resolved.
 */
function resolveCanonicalId(resolver: TaskRefResolver | null, taskRef: string): string | null {
  if (!resolver) return null;
  const result = resolver.resolve(taskRef);
  return result.ok ? result.ulid : null;
}

/**
 * Canonical task ULID for a workspace record: the recorded `task_id` when
 * present (already canonical), otherwise the resolution of its historical
 * `task_ref`. Returns null for unresolvable historical records so callers can
 * classify them stale rather than fork identity.
 *
 * AC: @dispatch-canonical-task-identity ac-historical-workspace-records-normalize-or-stale
 */
function recordCanonicalId(
  record: DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord,
  resolver: TaskRefResolver | null,
): string | null {
  if (record.task_id) return record.task_id;
  return resolveCanonicalId(resolver, record.task_ref);
}

/**
 * True when a workspace record represents the same canonical task as the query.
 * Prefers canonical ULID comparison; falls back to raw task_ref equality only
 * when neither side can be canonicalized (so behavior degrades safely when the
 * task index is unavailable).
 */
function recordMatchesTask(
  record: DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord,
  queryTaskRef: string,
  queryCanonicalId: string | null,
  resolver: TaskRefResolver | null,
): boolean {
  if (queryCanonicalId) {
    const recordId = recordCanonicalId(record, resolver);
    if (recordId) return recordId === queryCanonicalId;
  }
  return record.task_ref === queryTaskRef;
}

/**
 * Resolve the canonical full task ULID for a task ref, loading the project task
 * index. Returns null when the ref cannot be uniquely resolved.
 */
async function resolveProjectCanonicalId(
  projectDir: string,
  taskRef: string,
): Promise<string | null> {
  try {
    const ctx = await initContext(projectDir);
    const resolver = await buildProjectTaskResolver(ctx);
    return resolveCanonicalId(resolver, taskRef);
  } catch {
    return null;
  }
}

/**
 * Canonical short-id segment for a task ref: the first 8 characters of the
 * resolved task ULID so workspace lineage is stable across display aliases.
 * Falls back to the raw-ref short id when the ref cannot be canonicalized.
 *
 * AC: @dispatch-canonical-task-identity ac-workspace-lineage-stable-across-aliases
 */
async function canonicalShortTaskId(projectDir: string, taskRef: string): Promise<string> {
  const canonicalId = await resolveProjectCanonicalId(projectDir, taskRef);
  return canonicalId ? shortTaskId(canonicalId) : shortTaskId(taskRef);
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  return await runGitOrThrow(
    cwd,
    ["rev-parse", `${ref}^{commit}`],
    `Failed to resolve commit for "${ref}"`,
    "Inspect the dispatch branch/base branch references and retry.",
  );
}

function metadataPathFor(worktreeDir: string): string {
  return path.join(worktreeDir, DISPATCH_WORKSPACE_METADATA_FILE);
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"], { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

async function hasGitHubRemote(projectDir: string): Promise<boolean> {
  for (const remote of await listGitRemotes(projectDir)) {
    const result = await runGit(projectDir, ["remote", "get-url", remote]);
    if (result.status !== 0 || !result.stdout) {
      continue;
    }
    if (result.stdout.includes("github.com/") || result.stdout.includes("github.com:")) {
      return true;
    }
  }
  return false;
}

async function resolvePublicationMode(
  projectDir: string,
  configuredMode?: "pull_request" | "manual_merge" | "auto",
): Promise<DispatchWorkspacePublicationMode> {
  if (configuredMode && configuredMode !== "auto") {
    return configuredMode;
  }
  return (await commandAvailable("gh")) && (await hasGitHubRemote(projectDir))
    ? "pull_request"
    : "manual_merge";
}

async function resolveWorkspacePublicationMode(
  projectDir: string,
  existingRecord: LoadedDispatchWorkspaceRecord | undefined,
  configuredMode?: "pull_request" | "manual_merge" | "auto",
): Promise<DispatchWorkspacePublicationMode> {
  if (!existingRecord) {
    return await resolvePublicationMode(projectDir, configuredMode);
  }

  switch (existingRecord.integration.status) {
    case "pending":
    case "in_progress":
      return await resolvePublicationMode(projectDir, configuredMode);
    default:
      return existingRecord.integration.publication_mode;
  }
}

async function resolveTaskPlanRef(
  projectDir: string,
  taskRef: string | undefined,
  task: ProvisionDispatchWorkspaceOptions["task"] | undefined,
): Promise<string | null> {
  const inlinePlanRef = typeof task?.plan_ref === "string" ? task.plan_ref.trim() : "";
  if (inlinePlanRef) {
    return inlinePlanRef;
  }
  if (!taskRef) {
    return null;
  }

  try {
    const ctx = await initContext(projectDir);
    const loadedTask = await resolveTaskDataManager(ctx).getTask(ctx, taskRef);
    return typeof loadedTask.plan_ref === "string" && loadedTask.plan_ref.trim()
      ? loadedTask.plan_ref.trim()
      : null;
  } catch {
    return null;
  }
}

async function resolvePlanScopedBaseBranch(
  projectDir: string,
  taskRef: string | undefined,
  task: ProvisionDispatchWorkspaceOptions["task"] | undefined,
): Promise<{
  baseBranch: string;
  baseBranchStartPoint: string;
  planRef: string;
  planTitle: string;
} | null> {
  const planRef = await resolveTaskPlanRef(projectDir, taskRef, task);
  if (!planRef) {
    return null;
  }

  const ctx = await initContext(projectDir);
  const plan = await findPlanByRef(ctx, planRef);
  if (!plan) {
    console.warn(
      `[dispatch] Task ${taskRef ?? "<unknown-task>"} references plan ${planRef}, but that plan could not be found. Falling back to standard base-branch resolution.`,
    );
    return null;
  }

  const planBranch = typeof plan.branch === "string" ? plan.branch.trim() : "";
  if (!planBranch) {
    return null;
  }

  let resolved = await resolveBranchStartPoint(projectDir, planBranch);
  if (!resolved && (await ensureLocalDispatchIntegrationBranchExists(projectDir, planBranch))) {
    resolved = await resolveBranchStartPoint(projectDir, planBranch);
  }
  if (!resolved) {
    throw new DispatchWorkspaceError(
      `Task ${taskRef ?? "<unknown-task>"} references plan ${planRef} (${plan.title}) with branch "${planBranch}", but that branch could not be found locally or on any configured remote.`,
      `Create or fetch branch "${planBranch}" for plan ${planRef}, or update ${planRef} to a valid branch before provisioning the workspace.`,
    );
  }

  return {
    baseBranch: planBranch,
    baseBranchStartPoint: resolved.startPoint,
    planRef,
    planTitle: plan.title,
  };
}

// AC: @dispatch-workspace-configuration ac-6 — detect and handle stale integration target
// When an existing workspace record's integration.target_branch differs from an
// explicitly resolved plan/config integration target, either auto-update (if
// integration is still pending) or surface the conflict as an error (if
// integration is active). Auto-detected values (remote-head, current-branch,
// default) are inherently unstable and should not cause retargeting.
function resolveStaleIntegrationTarget(
  existingRecord: LoadedDispatchWorkspaceRecord | undefined,
  configuredBaseBranch: string,
  baseBranchSource: ResolvedDispatchWorkspaceConfig["baseBranchSource"],
  resolvedBaseBranch: string,
  planContext?: Pick<ResolvedDispatchWorkspaceConfig, "baseBranchPlanRef" | "baseBranchPlanTitle">,
): string {
  if (!existingRecord) {
    return resolvedBaseBranch;
  }

  const recordedTarget = existingRecord.integration.target_branch;

  const expectedTarget = baseBranchSource === "plan" ? resolvedBaseBranch : configuredBaseBranch;
  if (baseBranchSource !== "configured" && baseBranchSource !== "plan") {
    return recordedTarget;
  }

  if (recordedTarget === expectedTarget) {
    return recordedTarget;
  }

  if (existingRecord.integration.status === "pending") {
    return expectedTarget;
  }

  if (baseBranchSource === "plan") {
    const planLabel = planContext?.baseBranchPlanRef
      ? `${planContext.baseBranchPlanRef}${planContext.baseBranchPlanTitle ? ` (${planContext.baseBranchPlanTitle})` : ""}`
      : "the linked plan";
    throw new DispatchWorkspaceError(
      `Workspace for ${existingRecord.task_ref} targets integration branch "${recordedTarget}" ` +
        `but ${planLabel} now targets "${expectedTarget}". ` +
        `The workspace has active integration state (${existingRecord.integration.status}) ` +
        `and cannot be silently retargeted.`,
      planContext?.baseBranchPlanRef
        ? `Either update ${planContext.baseBranchPlanRef} back to "${recordedTarget}" with ` +
            `kspec plan set ${planContext.baseBranchPlanRef} --branch "${recordedTarget}", ` +
            `or reset the workspace integration state before re-provisioning ` +
            `(kspec dispatch workspace reset ${existingRecord.task_ref}).`
        : `Either restore the plan branch to "${recordedTarget}", or reset the workspace integration ` +
            `state before re-provisioning (kspec dispatch workspace reset ${existingRecord.task_ref}).`,
    );
  }

  throw new DispatchWorkspaceError(
    `Workspace for ${existingRecord.task_ref} targets integration branch "${recordedTarget}" ` +
      `but dispatch.base_branch is now "${expectedTarget}". ` +
      `The workspace has active integration state (${existingRecord.integration.status}) ` +
      `and cannot be silently retargeted.`,
    `Either revert dispatch.base_branch to "${recordedTarget}" to match the existing workspace, ` +
      `or reset the workspace integration state before re-provisioning ` +
      `(kspec dispatch workspace reset ${existingRecord.task_ref}).`,
  );
}

// AC: @adopt-existing-task-branch-lineage ac-2 — rehydrate adopted branch from remote
async function rehydrateAdoptedBranch(
  projectDir: string,
  branchName: string,
  remote: string | null,
  remoteUrl: string | null,
): Promise<boolean> {
  // Try the specified remote first, then fall back to all remotes
  const remotes = remote
    ? [remote, ...(await listGitRemotes(projectDir)).filter((r: string) => r !== remote)]
    : await listGitRemotes(projectDir);
  for (const remoteName of remotes) {
    // Fetch the specific branch from the remote
    const fetchResult = await runGit(projectDir, [
      "fetch",
      remoteName,
      `${branchName}:${branchName}`,
    ]);
    if (fetchResult.status === 0) {
      return true;
    }
    // Also try refs/heads/<branch> in case the remote ref name differs
    const fetchAlt = await runGit(projectDir, [
      "fetch",
      remoteName,
      `refs/heads/${branchName}:refs/heads/${branchName}`,
    ]);
    if (fetchAlt.status === 0) {
      return true;
    }
  }
  // Fall back to fetching directly from the remote URL when named remotes
  // don't have the branch (e.g. fork URL not configured as a named remote)
  if (remoteUrl) {
    const fetchUrl = await runGit(projectDir, ["fetch", remoteUrl, `${branchName}:${branchName}`]);
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

async function readWorkspaceMetadata(
  worktreeDir: string,
): Promise<DispatchWorkspaceMetadata | null> {
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

async function parseWorktreeList(
  projectDir: string,
): Promise<Array<{ path: string; branch: string | null }>> {
  const result = await runGit(projectDir, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  const entries: Array<{ path: string; branch: string | null }> = [];
  const blocks = result.stdout.split(/\n\s*\n/).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const worktreePath = lines
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length);
    if (!worktreePath) continue;
    const branchRef =
      lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? null;
    entries.push({ path: worktreePath, branch: branchRef });
  }
  return entries;
}

function normalizeBranchRef(branch: string | null | undefined): string | null {
  return branch ? branch.replace(/^refs\/heads\//, "") : null;
}

async function findExistingWorktreeForBranchUnderRoot(
  projectDir: string,
  canonicalBranch: string,
  worktreeRoot: string,
): Promise<string | null> {
  const branchRef = `refs/heads/${canonicalBranch}`;
  return (
    (await parseWorktreeList(projectDir)).find(
      (entry) => entry.branch === branchRef && isPathInside(worktreeRoot, entry.path),
    )?.path ?? null
  );
}

async function findForeignWorktreeForBranch(
  projectDir: string,
  canonicalBranch: string,
  worktreeRoot: string,
): Promise<string | null> {
  const branchRef = `refs/heads/${canonicalBranch}`;
  return (
    (await parseWorktreeList(projectDir)).find(
      (entry) => entry.branch === branchRef && !isPathInside(worktreeRoot, entry.path),
    )?.path ?? null
  );
}

async function findWorktreeByPath(
  projectDir: string,
  worktreeDir: string,
): Promise<{ path: string; branch: string | null } | null> {
  const normalized = path.resolve(worktreeDir);
  return (
    (await parseWorktreeList(projectDir)).find(
      (entry) => path.resolve(entry.path) === normalized,
    ) ?? null
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function workspaceRecordBelongsToWorktreeRoot(
  record: DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord,
  worktreeRoot: string,
): boolean {
  if (path.resolve(record.worktree_root) !== path.resolve(worktreeRoot)) {
    return false;
  }
  if (!isPathInside(worktreeRoot, record.worktrees.worker.path)) {
    return false;
  }
  return (
    record.worktrees.reviewer == null || isPathInside(worktreeRoot, record.worktrees.reviewer.path)
  );
}

function metadataBelongsToWorktreeRoot(
  metadata: DispatchWorkspaceMetadata,
  worktreeRoot: string,
): boolean {
  if (path.resolve(metadata.worktreeRoot) !== path.resolve(worktreeRoot)) {
    return false;
  }
  if (!isPathInside(worktreeRoot, metadata.workerWorktreeDir)) {
    return false;
  }
  return (
    metadata.reviewerWorktreeDir == null || isPathInside(worktreeRoot, metadata.reviewerWorktreeDir)
  );
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

function defaultBootstrapState(_now: string): DispatchWorkspaceBootstrapState {
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
    return createCleanupRecord(resolveDispatchWorkspaceCleanupState(cleanupState), now);
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
    target_commit:
      existingRecord && existingRecord.integration.target_branch === targetBranch
        ? existingRecord.integration.target_commit
        : targetCommit,
    publication_mode: publicationMode,
    outcome: resolveIntegrationOutcome(publicationMode, status),
    detail: cleanupState?.integrationState
      ? `integration:${cleanupState.integrationState}`
      : (existingRecord?.integration.detail ?? null),
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
      cleanup:
        existingRecord.cleanup.status === "blocked" || existingRecord.cleanup.status === "completed"
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
      cleanup:
        existingRecord.cleanup.status === "blocked" || existingRecord.cleanup.status === "completed"
          ? {
              ...existingRecord.cleanup,
              updated_at: now,
            }
          : resolveCleanupRecord(cleanupState, existingRecord, now),
    };
  }

  const shouldResetLifecycle =
    existingRecord.lifecycle_state === "closing" ||
    existingRecord.integration.status === "merged" ||
    existingRecord.integration.status === "abandoned" ||
    existingRecord.cleanup.status !== "not_scheduled" ||
    existingRecord.cleanup.eligible;
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
  const resetReopenedTask =
    integration.status === "reset" &&
    taskStatus !== null &&
    taskStatus !== "completed" &&
    taskStatus !== "cancelled";
  if (cleanup.status === "completed") return "closed";
  if (cleanup.status === "blocked") return "cleanup_blocked";
  if (health.status !== "healthy") return "stale";
  if (
    !resetReopenedTask &&
    (cleanup.eligible || integration.status === "merged" || integration.status === "abandoned")
  ) {
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

function buildIssue(code: string, message: string, suggestion: string): DispatchWorkspaceIssue {
  return {
    code,
    message,
    suggestion,
  };
}

// AC: @adopted-branch-cleanup-and-recoverability ac-3
// AC: @dispatch-workspace-registry ac-12
async function reconcileWorkspaceHealth(
  projectDir: string,
  record: DispatchWorkspaceRecord,
  now: string,
  taskStatus?: ResolveDispatchWorkspaceCleanupStateOptions["taskStatus"],
): Promise<DispatchWorkspaceHealthState> {
  const issues: DispatchWorkspaceIssue[] = [];
  const branchRef = `refs/heads/${record.canonical_branch}`;
  let branchExists = await refExists(projectDir, branchRef);

  // AC: @dispatch-workspace-registry ac-12 — skip branch restoration for terminal
  // tasks whose integration is merged or abandoned. These branches are expected
  // to be missing after cleanup; restoring them creates a futile restore-delete
  // cycle with artifact reconciliation.
  const isTerminalTask = taskStatus === "completed" || taskStatus === "cancelled";
  const isIntegrationResolved =
    record.integration.status === "merged" || record.integration.status === "abandoned";
  const skipBranchRestore = isTerminalTask && isIntegrationResolved;

  if (!branchExists && !skipBranchRestore) {
    branchExists = await tryRestoreBranchFromRemote(projectDir, record.canonical_branch);
  }
  if (!branchExists && skipBranchRestore) {
    // For terminal tasks with resolved integration, a missing branch is expected.
    // Return the last persisted health state rather than flagging issues.
    return record.health;
  }
  if (!branchExists) {
    const isAdopted = record.branch_provenance?.ownership === "adopted";
    const hasRemoteLocator = Boolean(record.branch_provenance?.remote_ref);
    if (isAdopted && hasRemoteLocator) {
      issues.push(
        buildIssue(
          "missing_adopted_branch_recoverable",
          `Adopted canonical branch "${record.canonical_branch}" is missing locally but a remote locator is known (${record.branch_provenance.remote_ref}).`,
          `Rehydrate the adopted branch from the remote locator with: git fetch <remote> ${record.canonical_branch}:${record.canonical_branch}`,
        ),
      );
    } else if (isAdopted) {
      issues.push(
        buildIssue(
          "missing_adopted_branch",
          `Adopted canonical branch "${record.canonical_branch}" is missing locally and no remote locator is recorded.`,
          "Locate the original branch source and manually restore it, or re-submit the task with updated submission linkage.",
        ),
      );
    } else {
      issues.push(
        buildIssue(
          "missing_canonical_branch",
          `Canonical branch "${record.canonical_branch}" is missing.`,
          "Re-provision the workspace or restore the branch before dispatch resumes.",
        ),
      );
    }
  }

  const workerRegistered = await findExistingWorktreeForBranchUnderRoot(
    projectDir,
    record.canonical_branch,
    record.worktree_root,
  );
  const workerExists = await pathExists(record.worktrees.worker.path);
  if (!workerExists || (!workerRegistered && record.lifecycle_state !== "closed")) {
    issues.push(
      buildIssue(
        "missing_worker_worktree",
        `Worker worktree "${record.worktrees.worker.path}" is missing or no longer registered.`,
        "Re-provision the worker worktree from the recorded canonical branch.",
      ),
    );
  }

  if (record.worktrees.reviewer) {
    const reviewerRegistered = await findWorktreeByPath(projectDir, record.worktrees.reviewer.path);
    const reviewerExists = await pathExists(record.worktrees.reviewer.path);
    if (!reviewerExists || !reviewerRegistered) {
      issues.push(
        buildIssue(
          "missing_reviewer_worktree",
          `Reviewer worktree "${record.worktrees.reviewer.path}" is missing or no longer registered.`,
          "Recreate the detached reviewer snapshot before running review again.",
        ),
      );
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
    primaryBootstrapState.failureMessage ??
    (record.cleanup.eligible ? (record.cleanup.reason ?? "workspace-marked-for-cleanup") : null) ??
    record.health.issues[0]?.message ??
    null;
  return {
    workspaceId: record.workspace_id,
    taskId: record.task_id ?? null,
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
    cleanupBlockedReason:
      record.cleanup.status === "blocked"
        ? (record.cleanup.reason ?? record.cleanup.detail ?? null)
        : null,
    createdAt: record.timestamps.created_at,
    updatedAt: record.timestamps.updated_at,
    lastReconciledAt: record.timestamps.last_reconciled_at ?? null,
    lastActiveAt: record.timestamps.last_active_at ?? null,
    closedAt: record.timestamps.closed_at ?? null,
  };
}

async function loadWorkspaceRecordForWorktreeRoot(
  projectDir: string,
  taskRef: string,
  worktreeRoot: string,
): Promise<LoadedDispatchWorkspaceRecord | undefined> {
  const ctx = await initContext(projectDir);
  const records = await loadDispatchWorkspaceRegistry(ctx);
  const resolver = await buildProjectTaskResolver(ctx);
  const queryCanonicalId = resolveCanonicalId(resolver, taskRef);
  // AC: @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
  // Match records by canonical task ULID so a record persisted under one alias
  // is reused when provisioning refers to the task by a different alias.
  return records
    .filter(
      (record) =>
        recordMatchesTask(record, taskRef, queryCanonicalId, resolver) &&
        workspaceRecordBelongsToWorktreeRoot(record, worktreeRoot),
    )
    .toSorted((a, b) => (a.timestamps.updated_at < b.timestamps.updated_at ? 1 : -1))[0];
}

async function loadForeignOpenWorkspaceRecord(
  projectDir: string,
  taskRef: string,
  worktreeRoot: string,
): Promise<LoadedDispatchWorkspaceRecord | undefined> {
  const ctx = await initContext(projectDir);
  const records = await loadDispatchWorkspaceRegistry(ctx);
  const resolver = await buildProjectTaskResolver(ctx);
  const queryCanonicalId = resolveCanonicalId(resolver, taskRef);
  return records
    .filter(
      (record) =>
        recordMatchesTask(record, taskRef, queryCanonicalId, resolver) &&
        record.lifecycle_state !== "closed" &&
        !workspaceRecordBelongsToWorktreeRoot(record, worktreeRoot),
    )
    .toSorted((a, b) => (a.timestamps.updated_at < b.timestamps.updated_at ? 1 : -1))[0];
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
  if (workerDir && (await pathExists(workerDir))) {
    await writeWorkspaceMetadata(workerDir, toMetadata(record));
  }

  return registryPath;
}

/**
 * Run a callback inside the dispatch shadow mutation file lock.
 * Serializes with other shadow writers across processes.
 *
 * When the lock is force-reclaimed from an alive-but-stuck holder
 * (ac-10), checks the shadow worktree for uncommitted dirty state
 * and rolls it back before proceeding (ac-11).
 *
 * AC: @dispatch-workspace-registry ac-8
 * AC: @scoped-dispatch-shadow-serialization ac-7
 * AC: @scoped-dispatch-shadow-serialization ac-11
 */
async function withDispatchShadowMutationLock<T>(
  projectDir: string,
  taskRef: string,
  fn: (acquireInfo?: FileLockAcquireInfo) => Promise<T>,
): Promise<T> {
  const lockPath = getDispatchShadowMutationLockPath(projectDir);
  const timeoutMs = resolveDispatchMutationLockTimeoutMs();

  let release: ((() => Promise<void>) & { info: FileLockAcquireInfo }) | undefined;
  try {
    release = await acquireFileLock(lockPath, { timeoutMs });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DispatchWorkspaceError(
      `Dispatch shadow mutation lock unavailable while committing workspace registry for ${taskRef}: ${reason}`,
      `Wait for the overlapping kspec mutation to finish, or remove ${path.basename(lockPath)}.lock if the lock holder is gone.`,
    );
  }

  try {
    // AC: @scoped-dispatch-shadow-serialization ac-11 — when the lock was
    // force-reclaimed from an alive-but-stuck holder, the shadow worktree
    // may contain uncommitted dirty state from the previous holder's
    // interrupted write. Roll it back before proceeding.
    if (release.info.forceReclaimed) {
      await rollbackDirtyShadowWorktree(projectDir, taskRef, release.info);
    }

    return await fn(release.info);
  } finally {
    // AC: @scoped-dispatch-shadow-serialization ac-7 — guaranteed release
    await release?.();
  }
}

/**
 * Roll back uncommitted dirty state in the shadow worktree after a
 * force-reclaim. Prevents the new holder from accidentally committing
 * partial state from the previous holder alongside its own changes.
 *
 * AC: @scoped-dispatch-shadow-serialization ac-11
 */
export async function rollbackDirtyShadowWorktree(
  projectDir: string,
  taskRef: string,
  acquireInfo: FileLockAcquireInfo,
): Promise<void> {
  let ctx;
  try {
    ctx = await initContext(projectDir);
  } catch {
    return; // No context available, nothing to roll back
  }

  if (!ctx.shadow?.enabled) return;

  const shadowDir = ctx.shadow.worktreeDir;
  const status = await runGit(shadowDir, ["status", "--porcelain"]);
  if (status.status !== 0 || status.stdout.trim().length === 0) {
    return; // No dirty state to roll back
  }

  console.warn(
    `[dispatch] Shadow worktree has uncommitted changes after force-reclaiming lock ` +
      `from PID ${acquireInfo.previousHolderPid} (held ${acquireInfo.previousHoldDurationMs}ms). ` +
      `Rolling back dirty state for ${taskRef}.`,
  );

  // Phase 1: Unstage all indexed changes (git reset HEAD).
  // `git checkout -- .` only restores the working tree — it leaves staged
  // additions/modifications in the index.  Without this reset, a new holder
  // would inherit and commit the previous holder's partial staged changes.
  await runGit(shadowDir, ["reset", "HEAD"]);

  // Phase 2: Restore modified tracked files in the working tree.
  const checkoutResult = await runGit(shadowDir, ["checkout", "--", "."]);
  if (checkoutResult.status !== 0) {
    // Fallback to hard reset if checkout fails
    await runGit(shadowDir, ["reset", "--hard", "HEAD"]);
  }

  // Clean untracked files that may have been left by the interrupted write
  await runGit(shadowDir, ["clean", "-fd"]);
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
async function commitWorkspaceRegistryToShadow(projectDir: string, taskRef: string): Promise<void> {
  const ctx = await initContext(projectDir);
  if (!ctx.shadow?.enabled) return;

  const bareRef = taskRef.replace(/^@/, "");
  const committed = await commitIfShadow(ctx.shadow, "dispatch-workspace-registry", bareRef);
  if (!committed) {
    const shadowStatus = await runGit(ctx.shadow.worktreeDir, ["status", "--porcelain"]);
    const hasPendingShadowChanges =
      shadowStatus.status !== 0 || shadowStatus.stdout.trim().length > 0;
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

/**
 * Purge a workspace record from the registry: acquire the dispatch shadow
 * mutation lock, delete the record, then durably commit — all within the
 * lock scope so the deletion is never visible without a matching shadow
 * commit. This ensures daemon restarts cannot resurrect the stale record.
 *
 * AC: @dispatch-workspace-registry ac-8
 * AC: @dispatch-workspace-registry ac-14
 */
export async function purgeDispatchWorkspaceRecord(
  projectDir: string,
  taskRef: string,
  workspaceId: string,
): Promise<void> {
  await withDispatchShadowMutationLock(projectDir, taskRef, async () => {
    const ctx = await initContext(projectDir);
    await deleteDispatchWorkspaceRecord(ctx, workspaceId);
    await commitWorkspaceRegistryToShadow(projectDir, taskRef);
  });
}

export async function persistDispatchWorkspaceMetadata(
  projectDir: string,
  metadata: DispatchWorkspaceMetadata,
): Promise<string> {
  const existingRecord = await loadWorkspaceRecordForWorktreeRoot(
    projectDir,
    metadata.taskRef,
    metadata.worktreeRoot,
  );
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
): Promise<{
  canonicalBranch: string;
  workerWorktreeDir: string;
  metadata: DispatchWorkspaceMetadata;
} | null> {
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
  // Try the deterministic dispatch/task/* branch first (most common path).
  // The short id is derived from the canonical task ULID so any display alias
  // of the task locates the same branch lineage.
  // AC: @dispatch-canonical-task-identity ac-workspace-lineage-stable-across-aliases
  const slug = normalizeTaskSlug(taskRef, task);
  const shortId = await canonicalShortTaskId(projectDir, taskRef);
  const syntheticBranch = `dispatch/task/${slug}/${shortId}`;
  const workerWorktreeDir = await findExistingWorktreeForBranchUnderRoot(
    projectDir,
    syntheticBranch,
    resolvedConfig.worktreeRoot,
  );
  if (workerWorktreeDir) {
    const metadata = await readWorkspaceMetadata(workerWorktreeDir);
    if (metadata && metadataBelongsToWorktreeRoot(metadata, resolvedConfig.worktreeRoot)) {
      return { canonicalBranch: syntheticBranch, workerWorktreeDir, metadata };
    }
  }

  // Fall back to registry lookup — adopted branches use a non-dispatch canonical
  // branch name, so the synthetic prefix won't match.
  const record = await loadWorkspaceRecordForWorktreeRoot(
    projectDir,
    taskRef,
    resolvedConfig.worktreeRoot,
  );
  if (!record) {
    return null;
  }
  const registryBranch = record.canonical_branch;
  const registryWorktreeDir = await findExistingWorktreeForBranchUnderRoot(
    projectDir,
    registryBranch,
    resolvedConfig.worktreeRoot,
  );
  if (!registryWorktreeDir) {
    return null;
  }
  const metadata = await readWorkspaceMetadata(registryWorktreeDir);
  if (!metadata || !metadataBelongsToWorktreeRoot(metadata, resolvedConfig.worktreeRoot)) {
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

  const existingRecord = await loadWorkspaceRecordForWorktreeRoot(
    projectDir,
    metadata.taskRef,
    resolvedConfig.worktreeRoot,
  );
  if (existingRecord) {
    return existingRecord;
  }

  const workerWorktreeDir = path.resolve(metadata.workerWorktreeDir || candidatePath);
  if (!isPathInside(resolvedConfig.worktreeRoot, workerWorktreeDir)) {
    return null;
  }

  const workerRegistration = await findWorktreeByPath(projectDir, workerWorktreeDir);
  const reviewerWorktreeDir = metadata.reviewerWorktreeDir
    ? path.resolve(metadata.reviewerWorktreeDir)
    : null;
  const reviewerRegistration = reviewerWorktreeDir
    ? await findWorktreeByPath(projectDir, reviewerWorktreeDir)
    : null;
  if (!workerRegistration && !reviewerRegistration) {
    return null;
  }

  const taskSlug = normalizeTaskSlug(metadata.taskRef, {
    title: metadata.taskSlug,
    slugs: [metadata.taskSlug],
  });
  // Resolve canonical identity for recovered legacy worktrees so the backfilled
  // record carries a stable task_id and derives a canonical short id.
  // AC: @dispatch-canonical-task-identity ac-historical-workspace-records-normalize-or-stale
  const recoveredCanonicalId =
    metadata.taskId ?? (await resolveProjectCanonicalId(projectDir, metadata.taskRef));
  const recoveredShortId = recoveredCanonicalId
    ? shortTaskId(recoveredCanonicalId)
    : shortTaskId(metadata.taskRef);
  const hasAdoptedProvenance = metadata.branchProvenance?.ownership === "adopted";
  // When branch_provenance is missing (legacy workspace) AND the canonical branch
  // is not a dispatch branch, infer adopted status to preserve the branch identity
  // instead of normalizing it back to dispatch/task/* (AC-2).
  const inferredAdopted = !metadata.branchProvenance && !isDispatchBranch(metadata.canonicalBranch);
  const canonicalBranch =
    hasAdoptedProvenance || inferredAdopted
      ? metadata.canonicalBranch
      : isDispatchBranch(metadata.canonicalBranch)
        ? metadata.canonicalBranch
        : `dispatch/task/${taskSlug}/${recoveredShortId}`;
  const currentWorkerBranch = normalizeBranchRef(workerRegistration?.branch);

  if (
    workerRegistration &&
    currentWorkerBranch !== canonicalBranch &&
    !hasAdoptedProvenance &&
    !inferredAdopted
  ) {
    try {
      await runGitOrThrow(
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
  const baseBranchPoint =
    metadata.baseBranchPoint ||
    metadata.integrationTargetCommit ||
    metadata.canonicalBranchHead ||
    resolvedConfig.baseBranchStartPoint;
  const publicationMode =
    metadata.publicationMode ??
    (await resolvePublicationMode(projectDir, resolvedConfig.publicationMode));
  const integration: RegistryIntegrationRecord = {
    status: metadata.integrationState ?? "pending",
    target_branch:
      metadata.integrationTargetBranch ||
      metadata.mergeTargetBranch ||
      metadata.baseBranch ||
      resolvedConfig.baseBranch,
    target_commit: metadata.integrationTargetCommit || baseBranchPoint,
    publication_mode: publicationMode,
    outcome:
      metadata.integrationOutcome ??
      resolveIntegrationOutcome(publicationMode, metadata.integrationState ?? "pending"),
    detail: metadata.cleanupState?.detail ?? null,
    updated_at: metadata.integrationUpdatedAt ?? now,
  };
  const cleanup: RegistryCleanupState = metadata.cleanupState
    ? {
        ...metadata.cleanupState,
        updated_at: now,
      }
    : createCleanupRecord(
        {
          cleanupEligible: metadata.cleanupEligible,
          cleanupReason: metadata.cleanupReason,
        },
        now,
      );
  const canonicalBranchHead = (await refExists(projectDir, `refs/heads/${canonicalBranch}`))
    ? await resolveCommit(projectDir, canonicalBranch)
    : workerRegistration
      ? await resolveCommit(workerWorktreeDir, "HEAD")
      : metadata.canonicalBranchHead;
  const reviewerWorktree =
    reviewerWorktreeDir && (await pathExists(reviewerWorktreeDir))
      ? buildWorktreeRecord(
          reviewerWorktreeDir,
          "detached",
          null,
          reviewerRegistration ? await resolveCommit(reviewerWorktreeDir, "HEAD") : null,
          now,
        )
      : null;
  const branchProvenance: DispatchWorkspaceBranchProvenance =
    metadata.branchProvenance ??
    (isDispatchBranch(metadata.canonicalBranch)
      ? defaultBranchProvenance()
      : adoptedBranchProvenance(metadata.canonicalBranch, null, now, false));
  const provisionalRecord: DispatchWorkspaceRecord = {
    workspace_id: metadata.workspaceId || workspaceIdFor(recoveredCanonicalId ?? metadata.taskRef),
    task_id: recoveredCanonicalId ?? undefined,
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
        workerRegistration ? await resolveCommit(workerWorktreeDir, "HEAD") : canonicalBranchHead,
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
  const health = await reconcileWorkspaceHealth(projectDir, provisionalRecord, now);
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

async function ensureUsableWorktreeRoot(projectDir: string, worktreeRoot: string): Promise<void> {
  const shadowDir = path.join(projectDir, ".kspec");
  const relativeToShadow = path.relative(shadowDir, worktreeRoot);
  const insideShadow =
    relativeToShadow === "" ||
    (!relativeToShadow.startsWith("..") && !path.isAbsolute(relativeToShadow));
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

async function assertPathSafeForWorktree(
  worktreeDir: string,
  projectDir: string,
  expectedBranch?: string,
): Promise<void> {
  const existing = await fs.stat(worktreeDir).catch(() => null);
  if (!existing) return;

  const registration = await findWorktreeByPath(projectDir, worktreeDir);
  if (registration) {
    const registeredBranch = normalizeBranchRef(registration.branch);
    if (expectedBranch && registeredBranch !== expectedBranch) {
      throw new DispatchWorkspaceError(
        `Dispatch worktree path "${worktreeDir}" is already registered to branch "${registeredBranch ?? "(detached)"}", not "${expectedBranch}".`,
        "Remove the conflicting worktree or choose a different dispatch.worktree_root before retrying.",
      );
    }
    return;
  }

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
  options?: {
    taskRef?: string;
    task?: ProvisionDispatchWorkspaceOptions["task"];
  },
): Promise<ResolvedDispatchWorkspaceConfig> {
  const { config } = await loadProjectConfig(projectDir, projectDir);
  const configuredBaseBranch = config.dispatch.base_branch?.trim() || null;
  const publicationMode = config.dispatch.publication_mode;
  const rawRoot = config.dispatch.worktree_root?.trim() || ".kspec-worktrees";
  const worktreeRoot = path.isAbsolute(rawRoot) ? rawRoot : path.resolve(projectDir, rawRoot);
  const planScoped = await resolvePlanScopedBaseBranch(projectDir, options?.taskRef, options?.task);

  if (planScoped) {
    return {
      baseBranch: planScoped.baseBranch,
      baseBranchStartPoint: planScoped.baseBranchStartPoint,
      baseBranchSource: "plan",
      baseBranchPlanRef: planScoped.planRef,
      baseBranchPlanTitle: planScoped.planTitle,
      worktreeRoot,
      publicationMode,
    };
  }

  if (configuredBaseBranch) {
    let resolved = await resolveBranchStartPoint(projectDir, configuredBaseBranch);
    if (
      !resolved &&
      (await ensureLocalDispatchIntegrationBranchExists(projectDir, configuredBaseBranch))
    ) {
      resolved = await resolveBranchStartPoint(projectDir, configuredBaseBranch);
    }
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

  // Fallback chain: remote HEAD → current branch → "main" literal.
  // Each step independently verifies the branch exists before committing,
  // so a stale remote HEAD (pointing to a nonexistent branch) falls through
  // to the current branch rather than throwing.
  const remoteHeadBranch = await resolveRemoteHeadBranch(projectDir);
  if (remoteHeadBranch) {
    const resolved = await resolveBranchStartPoint(projectDir, remoteHeadBranch);
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

  const currentBranch = await resolveCurrentBranch(projectDir);
  if (currentBranch) {
    const resolved = (await resolveBranchStartPoint(projectDir, currentBranch)) ?? {
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
  const resolved = await resolveBranchStartPoint(projectDir, defaultBranch);
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
    "No base branch could be resolved: no configured dispatch.base_branch, no remote HEAD, " +
      'no current branch, and default "main" does not exist.',
    "Set dispatch.base_branch in kspec.config.yaml, or ensure the repository has a main branch.",
  );
}

export interface DispatchIntegrationMutationScope {
  projectDir: string;
  integrationBranch: string;
  currentBranch: string | null;
  targetBranchCheckedOut: boolean;
  /**
   * The cwd to use when running git commands that mutate working-tree state for
   * the integration target branch. Set when the target branch is checked out
   * somewhere safe to mutate (projectDir itself, or exactly one eligible clean
   * non-auxiliary worktree). Null when the target is not checked out anywhere
   * (callers should use ref-only operations like update-ref).
   */
  mutationCwd: string | null;
}

async function ensureLocalDispatchIntegrationBranchExists(
  projectDir: string,
  integrationBranch: string,
): Promise<boolean> {
  if (await refExists(projectDir, `refs/heads/${integrationBranch}`)) {
    return true;
  }
  if (await tryRestoreBranchFromRemote(projectDir, integrationBranch)) {
    return true;
  }

  for (const remote of await listGitRemotes(projectDir)) {
    const fetchResult = await runGit(projectDir, ["fetch", remote, integrationBranch], {
      timeout: 30_000,
    });
    if (fetchResult.status !== 0) {
      console.debug(
        `[dispatch] Failed to fetch integration branch "${integrationBranch}" from ${remote}: ${fetchResult.stderr || fetchResult.stdout}`,
      );
      continue;
    }
    if (await tryRestoreBranchFromRemote(projectDir, integrationBranch)) {
      return true;
    }
  }

  return false;
}

const IN_PROGRESS_GIT_OPERATION_MARKERS: Array<{ marker: string; label: string }> = [
  { marker: "MERGE_HEAD", label: "merge" },
  { marker: "REBASE_HEAD", label: "rebase" },
  { marker: "rebase-apply", label: "rebase" },
  { marker: "rebase-merge", label: "rebase" },
  { marker: "CHERRY_PICK_HEAD", label: "cherry-pick" },
  { marker: "REVERT_HEAD", label: "revert" },
  { marker: "BISECT_LOG", label: "bisect" },
];

async function detectInProgressGitOperation(worktreePath: string): Promise<string | null> {
  for (const { marker, label } of IN_PROGRESS_GIT_OPERATION_MARKERS) {
    const markerPathResult = await runGit(worktreePath, ["rev-parse", "--git-path", marker]);
    if (markerPathResult.status !== 0 || !markerPathResult.stdout) {
      continue;
    }
    const markerPath = path.isAbsolute(markerPathResult.stdout)
      ? markerPathResult.stdout
      : path.join(worktreePath, markerPathResult.stdout);
    if (await pathExists(markerPath)) {
      return label;
    }
  }
  return null;
}

type TargetCheckoutClassification =
  | { kind: "eligible"; path: string }
  | { kind: "auxiliary"; path: string }
  | { kind: "dirty"; path: string; details: string }
  | { kind: "in_progress"; path: string; operation: string }
  | { kind: "overwrite_hazard"; path: string; hazardPaths: string[] };

/**
 * Detect untracked/ignored working-tree files that would be overwritten by
 * merging or fast-forwarding the worktree to `mergeRef`. Returns the list of
 * blocking paths (empty if none). Used so dispatch sync/push can refuse before
 * moving refs when an occupied checkout would have its untracked content
 * clobbered, instead of attempting the merge and misclassifying the resulting
 * Git error as divergence.
 *
 * Git refuses three overwrite shapes, all of which must be caught here:
 *   1. Exact-path collision: untracked file "foo.txt" vs merge writing "foo.txt".
 *   2. Directory-blocked-by-file: untracked file "foo" vs merge writing
 *      "foo/bar". Git cannot create the directory because a file holds the name.
 *   3. File-blocked-by-directory: untracked file "foo/bar" (so the directory
 *      "foo/" exists with untracked content) vs merge writing the path "foo"
 *      as a file. Git refuses to lose the directory's untracked entries.
 *
 * AC: @dispatch-integration-mutation-scope ac-dirty-occupied-target-refusal-identifies-blocker
 * AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
 */
async function detectUntrackedOverwriteHazards(
  worktreePath: string,
  mergeRef: string,
): Promise<string[]> {
  const headResult = await runGit(worktreePath, ["rev-parse", "HEAD"]);
  if (headResult.status !== 0 || !headResult.stdout) {
    return [];
  }
  const refResult = await runGit(worktreePath, ["rev-parse", "--verify", `${mergeRef}^{commit}`]);
  if (refResult.status !== 0 || !refResult.stdout) {
    return [];
  }
  const head = headResult.stdout.trim();
  const ref = refResult.stdout.trim();
  if (!head || !ref || head === ref) {
    return [];
  }

  // Paths added or modified between HEAD and the merge target. Includes only
  // paths the merge would write into the working tree; deletions cannot
  // collide with untracked working-tree files. -z gives NUL-separated entries
  // so paths with whitespace survive intact.
  const diff = await runGit(worktreePath, [
    "diff",
    "--name-only",
    "--diff-filter=ACMRT",
    "-z",
    head,
    ref,
  ]);
  if (diff.status !== 0) {
    return [];
  }
  const changedPaths = diff.stdout.split("\0").filter((p) => p.length > 0);
  if (changedPaths.length === 0) {
    return [];
  }

  // Untracked and ignored files together: Git's checkout-time overwrite check
  // refuses to clobber either category. `--others` without --exclude-standard
  // returns both untracked and ignored entries.
  const others = await runGit(worktreePath, ["ls-files", "--others", "-z"]);
  if (others.status !== 0) {
    return [];
  }
  const otherPaths = others.stdout.split("\0").filter((p) => p.length > 0);
  if (otherPaths.length === 0) {
    return [];
  }

  const hazards = new Set<string>();
  for (const other of otherPaths) {
    for (const changed of changedPaths) {
      if (pathsCollideAsTreeEntries(other, changed)) {
        hazards.add(other);
        break;
      }
    }
  }
  return [...hazards].toSorted();
}

/**
 * Whether two repo-relative paths collide as Git tree entries — i.e., Git
 * cannot have both populated in the working tree at the same time.
 *
 * Returns true for exact match, or when one path is a directory-segment
 * ancestor of the other (so creating one implies removing the other). Uses
 * "/" boundary checks so "foo" does not falsely match "foobar".
 */
function pathsCollideAsTreeEntries(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if (a.length < b.length) {
    return b.startsWith(`${a}/`);
  }
  return a.startsWith(`${b}/`);
}

async function classifyTargetWorktreeCheckout(
  worktreePath: string,
  worktreeRoot: string,
  options?: { mergeRef?: string },
): Promise<TargetCheckoutClassification> {
  // Auxiliary classification: either a dispatch-created worktree (inside the
  // configured worktree root) or any worktree carrying the dispatch workspace
  // metadata file. Catches worker, reviewer, helper, plan-scoped, and detached
  // reviewer snapshots even if they were placed outside the default root.
  if (isPathInside(worktreeRoot, worktreePath)) {
    return { kind: "auxiliary", path: worktreePath };
  }
  if (await pathExists(path.join(worktreePath, DISPATCH_WORKSPACE_METADATA_FILE))) {
    return { kind: "auxiliary", path: worktreePath };
  }

  const inProgress = await detectInProgressGitOperation(worktreePath);
  if (inProgress) {
    return { kind: "in_progress", path: worktreePath, operation: inProgress };
  }

  const trackedDiff = await runGit(worktreePath, ["diff", "--quiet"]);
  if (trackedDiff.status === 1) {
    return { kind: "dirty", path: worktreePath, details: "tracked modifications" };
  }
  const stagedDiff = await runGit(worktreePath, ["diff", "--cached", "--quiet"]);
  if (stagedDiff.status === 1) {
    return { kind: "dirty", path: worktreePath, details: "staged drift" };
  }

  if (options?.mergeRef) {
    const hazards = await detectUntrackedOverwriteHazards(worktreePath, options.mergeRef);
    if (hazards.length > 0) {
      return { kind: "overwrite_hazard", path: worktreePath, hazardPaths: hazards };
    }
  }

  return { kind: "eligible", path: worktreePath };
}

async function findAllWorktreesForBranch(projectDir: string, branch: string): Promise<string[]> {
  const branchRef = `refs/heads/${branch}`;
  return (await parseWorktreeList(projectDir))
    .filter((entry) => entry.branch === branchRef)
    .map((entry) => entry.path);
}

export interface ResolveDispatchIntegrationMutationScopeOptions {
  /**
   * When set, occupied target checkouts are additionally checked for
   * untracked/ignored working-tree paths that would be overwritten by merging
   * `mergeRef` into the target. Such a checkout is reported as an
   * `occupied-checkout` blocker instead of being treated as eligible, so the
   * caller does not attempt a merge that would surface as a divergence-style
   * Git failure.
   *
   * AC: @dispatch-integration-mutation-scope ac-dirty-occupied-target-refusal-identifies-blocker
   * AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
   */
  mergeRef?: string;
}

export async function resolveDispatchIntegrationMutationScope(
  projectDir: string,
  integrationBranch: string,
  options?: ResolveDispatchIntegrationMutationScopeOptions,
): Promise<DispatchIntegrationMutationScope> {
  const currentBranch = await resolveCurrentBranch(projectDir);

  if (currentBranch === integrationBranch) {
    await ensureDispatchIntegrationTargetCheckoutCoherence(projectDir, integrationBranch);
    if (options?.mergeRef) {
      const hazards = await detectUntrackedOverwriteHazards(projectDir, options.mergeRef);
      if (hazards.length > 0) {
        const preview = formatHazardPathsPreview(hazards);
        throw new DispatchWorkspaceError(
          `Dispatch cannot safely mutate integration target "${integrationBranch}" from ${projectDir} because the required sync would overwrite untracked/ignored files in that checkout: ${preview}.`,
          `Remove, stash, or commit the blocking files in "${projectDir}" (${preview}), or detach that checkout, before retrying.`,
          "occupied-checkout",
        );
      }
    }
    return {
      projectDir,
      integrationBranch,
      currentBranch,
      targetBranchCheckedOut: true,
      mutationCwd: projectDir,
    };
  }

  if (!(await ensureLocalDispatchIntegrationBranchExists(projectDir, integrationBranch))) {
    throw new DispatchWorkspaceError(
      `Dispatch cannot determine a safe mutation surface for integration target "${integrationBranch}" in ${projectDir}.`,
      `Create or fetch "${integrationBranch}" in ${projectDir}, or verify that a remote branch named "${integrationBranch}" exists before retrying.`,
    );
  }

  const occupied = await findAllWorktreesForBranch(projectDir, integrationBranch);
  const otherOccupied = occupied.filter(
    (candidate) => path.resolve(candidate) !== path.resolve(projectDir),
  );

  if (otherOccupied.length === 0) {
    return {
      projectDir,
      integrationBranch,
      currentBranch,
      targetBranchCheckedOut: false,
      mutationCwd: null,
    };
  }

  const workspaceConfig = await resolveDispatchWorkspaceConfig(projectDir);
  const classifyOptions = options?.mergeRef ? { mergeRef: options.mergeRef } : undefined;
  const classifications = await Promise.all(
    otherOccupied.map((p) =>
      classifyTargetWorktreeCheckout(p, workspaceConfig.worktreeRoot, classifyOptions),
    ),
  );

  const auxiliary = classifications.filter((c) => c.kind === "auxiliary");
  const dirty = classifications.filter((c) => c.kind === "dirty");
  const inProgress = classifications.filter((c) => c.kind === "in_progress");
  const overwriteHazard = classifications.filter((c) => c.kind === "overwrite_hazard");
  const eligible = classifications.filter((c) => c.kind === "eligible");

  if (auxiliary.length > 0) {
    const blocker = auxiliary[0];
    throw new DispatchWorkspaceError(
      `Dispatch cannot safely mutate integration target "${integrationBranch}" from ${projectDir} because that branch is currently checked out in dispatch auxiliary worktree "${blocker.path}".`,
      `Remove or detach the auxiliary worktree at "${blocker.path}" (for example: 'git worktree remove --force "${blocker.path}"' or 'git -C "${blocker.path}" checkout --detach') before retrying.`,
      "occupied-checkout",
    );
  }

  if (dirty.length > 0) {
    const blocker = dirty[0];
    throw new DispatchWorkspaceError(
      `Dispatch cannot safely mutate integration target "${integrationBranch}" from ${projectDir} because that branch is currently checked out in worktree "${blocker.path}" with ${blocker.details}.`,
      `Commit, stash, or discard the ${blocker.details} in "${blocker.path}", or detach that checkout, before retrying.`,
      "occupied-checkout",
    );
  }

  if (inProgress.length > 0) {
    const blocker = inProgress[0];
    throw new DispatchWorkspaceError(
      `Dispatch cannot safely mutate integration target "${integrationBranch}" from ${projectDir} because that branch is currently checked out in worktree "${blocker.path}" with an in-progress ${blocker.operation} operation.`,
      `Finish or abort the in-progress ${blocker.operation} in "${blocker.path}" (e.g. 'git -C "${blocker.path}" ${blocker.operation} --abort') before retrying.`,
      "occupied-checkout",
    );
  }

  if (overwriteHazard.length > 0) {
    const blocker = overwriteHazard[0];
    const preview = formatHazardPathsPreview(blocker.hazardPaths);
    throw new DispatchWorkspaceError(
      `Dispatch cannot safely mutate integration target "${integrationBranch}" from ${projectDir} because the required sync would overwrite untracked/ignored files in the occupied checkout "${blocker.path}": ${preview}.`,
      `Remove, stash, or commit the blocking files in "${blocker.path}" (${preview}), or detach that checkout, before retrying.`,
      "occupied-checkout",
    );
  }

  if (eligible.length > 1) {
    const paths = eligible.map((c) => c.path).join(", ");
    throw new DispatchWorkspaceError(
      `Dispatch cannot safely mutate integration target "${integrationBranch}" from ${projectDir} because that branch is checked out in multiple eligible worktrees: ${paths}.`,
      `Detach or remove all but one of: ${paths}, then retry.`,
      "occupied-checkout",
    );
  }

  const surface = eligible[0]!;
  return {
    projectDir,
    integrationBranch,
    currentBranch,
    targetBranchCheckedOut: true,
    mutationCwd: surface.path,
  };
}

function formatHazardPathsPreview(paths: string[]): string {
  if (paths.length === 0) return "";
  const PREVIEW_COUNT = 3;
  const shown = paths.slice(0, PREVIEW_COUNT);
  const remaining = paths.length - shown.length;
  const preview = shown.join(", ");
  return remaining > 0 ? `${preview} (+${remaining} more)` : preview;
}

export async function fastForwardDispatchIntegrationBranch(
  projectDir: string,
  integrationBranch: string,
  remoteRef: string,
): Promise<GitResult> {
  const localCommit = await resolveCommit(projectDir, integrationBranch);
  const remoteCommit = await resolveCommit(projectDir, remoteRef);
  if (localCommit && remoteCommit && localCommit === remoteCommit) {
    return {
      status: 0,
      stdout: "Already up to date.",
      stderr: "",
    };
  }

  const ffCheck = await runGit(projectDir, [
    "merge-base",
    "--is-ancestor",
    integrationBranch,
    remoteRef,
  ]);
  if (ffCheck.status !== 0) {
    return ffCheck.status === 1
      ? {
          status: 1,
          stdout: "",
          stderr: `fatal: Not possible to fast-forward integration target "${integrationBranch}" to ${remoteRef}.`,
        }
      : ffCheck;
  }

  const updateArgs = ["update-ref", `refs/heads/${integrationBranch}`, remoteRef];
  if (localCommit) {
    updateArgs.push(localCommit);
  }
  return await runGit(projectDir, updateArgs);
}

export async function runDispatchIntegrationTargetGit(
  projectDir: string,
  integrationBranch: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  const scope = await resolveDispatchIntegrationMutationScope(projectDir, integrationBranch);
  return await runGit(scope.projectDir, args, options);
}

/**
 * Run a git command in the resolved mutation surface for an integration target.
 * Use this when the command must execute in a worktree where the target branch
 * is checked out (e.g. `git merge --ff-only`). For ref-only/read-only commands
 * (fetch, push, rev-list), use `runDispatchIntegrationTargetGit` instead.
 *
 * AC: @dispatch-integration-mutation-scope ac-1
 * AC: @dispatch-integration-mutation-scope ac-clean-occupied-target-checkout-is-valid-mutation-surface
 */
export async function runGitInMutationSurface(
  scope: DispatchIntegrationMutationScope,
  args: string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  const cwd = scope.mutationCwd ?? scope.projectDir;
  return await runGit(cwd, args, options);
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

async function resolveBaseBranchPoint(
  projectDir: string,
  canonicalBranch: string,
  resolvedBaseBranch: string,
  resolvedBaseStartPoint: string,
  existingRecord: LoadedDispatchWorkspaceRecord | undefined,
): Promise<string> {
  if (
    existingRecord?.base_branch_point &&
    existingRecord.resolved_base_branch === resolvedBaseBranch
  ) {
    return existingRecord.base_branch_point;
  }

  if (await refExists(projectDir, `refs/heads/${canonicalBranch}`)) {
    const mergeBase = await runGit(projectDir, [
      "merge-base",
      canonicalBranch,
      resolvedBaseStartPoint,
    ]);
    if (mergeBase.status === 0 && mergeBase.stdout) {
      return mergeBase.stdout;
    }
  }

  return await resolveCommit(projectDir, resolvedBaseStartPoint);
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
          if (
            typeof va[i] === "object" &&
            va[i] !== null &&
            typeof vb[i] === "object" &&
            vb[i] !== null
          ) {
            if (
              !deepEqualExcludingTimestamps(
                va[i] as Record<string, unknown>,
                vb[i] as Record<string, unknown>,
              )
            )
              return false;
          } else if (va[i] !== vb[i]) {
            return false;
          }
        }
        continue;
      }
      if (
        !deepEqualExcludingTimestamps(va as Record<string, unknown>, vb as Record<string, unknown>)
      )
        return false;
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
  if (
    !deepEqualExcludingTimestamps(
      existing.health as unknown as Record<string, unknown>,
      computed.health as unknown as Record<string, unknown>,
    )
  )
    return true;
  if (
    !deepEqualExcludingTimestamps(
      existing.cleanup as unknown as Record<string, unknown>,
      computed.cleanup as unknown as Record<string, unknown>,
    )
  )
    return true;
  if (
    !deepEqualExcludingTimestamps(
      existing.integration as unknown as Record<string, unknown>,
      computed.integration as unknown as Record<string, unknown>,
    )
  )
    return true;
  return false;
}

/**
 * Check whether all tracked physical artifacts for a workspace record are
 * absent from the filesystem and git. Used by reconciliation self-heal to
 * detect records whose reap removed artifacts but lost the completion
 * write.
 *
 * Returns true only when BOTH the canonical branch ref is missing locally
 * AND the worker worktree path is missing from disk. Either signal alone is
 * insufficient — a branch can be missing because it was never created, and a
 * worktree can be gone because it was never provisioned.
 *
 * AC: @dispatch-workspace-registry ac-successful-cleanup-persists-completion
 */
async function workspacePhysicalArtifactsAbsent(
  projectDir: string,
  record: DispatchWorkspaceRecord,
): Promise<boolean> {
  const branchExists = await refExists(projectDir, `refs/heads/${record.canonical_branch}`);
  if (branchExists) return false;
  const workerExists = await pathExists(record.worktrees.worker.path);
  if (workerExists) return false;
  if (record.worktrees.reviewer) {
    const reviewerExists = await pathExists(record.worktrees.reviewer.path);
    if (reviewerExists) return false;
  }
  return true;
}

export async function reconcileDispatchWorkspaceRegistry(
  projectDir: string,
  taskStatusByRef?: Map<string, ResolveDispatchWorkspaceCleanupStateOptions["taskStatus"]>,
  activeRoleByTaskRef?: Map<string, RegistryRole>,
): Promise<void> {
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
  const ctx = await initContext(projectDir);
  const records = await loadDispatchWorkspaceRegistry(ctx);
  const nonClosedRecords = records.filter(
    (r) =>
      r.lifecycle_state !== "closed" &&
      workspaceRecordBelongsToWorktreeRoot(r, resolvedConfig.worktreeRoot),
  );
  if (nonClosedRecords.length === 0) return;

  // AC: @scoped-dispatch-shadow-serialization ac-9 — yield the lock between
  // individual record evaluations so concurrent CLI mutations can interleave.
  // Evaluate all records without the lock (read-only), then acquire the lock
  // only for each dirty record's save + commit cycle.
  for (const record of nonClosedRecords) {
    const now = new Date().toISOString();
    const currentTaskStatus = taskStatusByRef?.get(record.task_ref) ?? null;
    const health = await reconcileWorkspaceHealth(projectDir, record, now, currentTaskStatus);
    const canonicalBranchHead = (await refExists(
      projectDir,
      `refs/heads/${record.canonical_branch}`,
    ))
      ? await resolveCommit(projectDir, record.canonical_branch)
      : record.canonical_branch_head;
    const resolvedRegistryState = resolveRegistryStateForTaskStatus(currentTaskStatus, record, now);
    let { cleanup } = resolvedRegistryState;
    const { integration } = resolvedRegistryState;

    // AC: @dispatch-workspace-registry ac-successful-cleanup-persists-completion
    // Self-heal for lost completion writes: if a reap successfully removed
    // physical artifacts but the follow-up shadow commit was lost (crash
    // between removal and commit), the record is stuck at
    // cleanup.status=scheduled with no artifacts on disk. Heal it forward
    // by transitioning cleanup.status to completed.
    //
    // Preconditions: cleanup.eligible must be true (i.e. integration is
    // resolved and cleanup was scheduled), the cleanup status must not
    // already be completed (idempotency), and the canonical branch +
    // worker worktree must both be absent. The worker worktree check is
    // needed because a standalone missing branch can also mean the branch
    // was never created; combined with a missing worker worktree it's
    // strong evidence that a reap ran physical removal.
    if (cleanup.eligible && cleanup.status !== "completed" && cleanup.status !== "blocked") {
      const physicalArtifactsGone = await workspacePhysicalArtifactsAbsent(projectDir, record);
      if (physicalArtifactsGone) {
        cleanup = {
          ...cleanup,
          status: "completed",
          updated_at: now,
        };
      }
    }

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
      const closedAt = lifecycleState === "closed" ? (record.timestamps.closed_at ?? now) : null;

      // AC: @dispatch-workspace-registry ac-8 — registry write + commit
      // happen inside the shadow mutation lock so no write is visible
      // without a matching durable commit.
      // AC: @scoped-dispatch-shadow-serialization ac-9 — per-record lock
      // acquisition yields between records, allowing interleaving.
      await withDispatchShadowMutationLock(projectDir, record.task_ref, async () => {
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
        await commitWorkspaceRegistryToShadow(projectDir, record.task_ref);
      });
    }
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

  const registration = await findWorktreeByPath(projectDir, worktreeDir);
  if (registration) {
    if (await pathExists(worktreeDir)) {
      await runGitOrThrow(
        projectDir,
        ["worktree", "remove", "--force", worktreeDir],
        `Failed to remove dispatch worktree "${worktreeDir}"`,
        "Inspect git worktree state and remove stale registrations before retrying cleanup.",
      );
    } else {
      await runGitOrThrow(
        projectDir,
        ["worktree", "prune"],
        `Failed to prune stale dispatch worktree registration "${worktreeDir}"`,
        "Inspect git worktree state and remove stale registrations before retrying cleanup.",
      );
    }
    return;
  }

  await fs.rm(worktreeDir, { recursive: true, force: true });
}

async function deleteDispatchBranch(projectDir: string, branch: string): Promise<void> {
  if (!isDispatchBranch(branch)) {
    throw new DispatchWorkspaceError(
      `Refusing to delete non-dispatch branch "${branch}"`,
      "Only canonical dispatch/task/* branches are eligible for dispatcher cleanup.",
    );
  }

  if (!(await refExists(projectDir, `refs/heads/${branch}`))) {
    return;
  }

  await runGitOrThrow(
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
async function deleteRehydratedAdoptedBranch(projectDir: string, branch: string): Promise<void> {
  if (!(await refExists(projectDir, `refs/heads/${branch}`))) {
    return;
  }
  // Safety: never delete protected branch names
  if (branch === "main" || branch === "master" || branch === "develop") {
    return;
  }
  await runGitOrThrow(
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
async function hasUpstreamTracking(projectDir: string, branch: string): Promise<boolean> {
  const result = await runGit(projectDir, ["rev-parse", "--verify", "--quiet", `${branch}@{u}`]);
  return result.status === 0;
}

/**
 * Check whether a local branch has commits ahead of its upstream.
 * Returns false when there is no upstream or on error.
 */
async function isLocalBranchAheadOfUpstream(projectDir: string, branch: string): Promise<boolean> {
  const result = await runGit(projectDir, [
    "rev-list",
    "--left-right",
    "--count",
    `${branch}...${branch}@{u}`,
  ]);
  if (result.status !== 0) return false;
  const [aheadStr] = result.stdout.trim().split("\t");
  const ahead = parseInt(aheadStr, 10);
  return ahead > 0;
}

/**
 * Check whether an integration target branch has local commits that still need
 * to be pushed to its upstream. Branches without upstream tracking return true
 * so callers can establish tracking with the first push.
 */
export async function integrationTargetNeedsPush(
  projectDir: string,
  integrationBranch: string,
): Promise<boolean> {
  const hasTracking = await hasUpstreamTracking(projectDir, integrationBranch);
  if (!hasTracking) {
    return true;
  }
  return await isLocalBranchAheadOfUpstream(projectDir, integrationBranch);
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
export async function pushDispatchBranch(
  projectDir: string,
  canonicalBranch: string,
  remote: string,
): Promise<PushDispatchBranchResult> {
  // AC: @dispatch-remote-branch-sync ac-no-remote
  if (!remote) {
    return { pushed: false, firstPush: false, error: null };
  }

  const isFirstPush = !(await hasUpstreamTracking(projectDir, canonicalBranch));

  if (isFirstPush) {
    // AC: @dispatch-remote-branch-sync ac-first-push-sets-tracking
    // AC: @dispatch-remote-branch-sync ac-first-push-replaces-stale-ref
    // Use --force-with-lease to safely replace stale remote refs from previous runs.
    // --force-with-lease verifies the remote ref hasn't been updated by a concurrent
    // writer (it succeeds if the remote ref is empty or matches our expected value).
    const result = await runGit(projectDir, [
      "push",
      "-u",
      "--force-with-lease",
      remote,
      canonicalBranch,
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
  if (!(await isLocalBranchAheadOfUpstream(projectDir, canonicalBranch))) {
    return { pushed: false, firstPush: false, error: null };
  }
  const result = await runGit(projectDir, ["push", remote, canonicalBranch]);
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
export async function pushIntegrationTarget(
  projectDir: string,
  integrationBranch: string,
  remote: string,
): Promise<PushIntegrationTargetResult> {
  // AC: @dispatch-remote-branch-sync ac-no-remote
  if (!remote) {
    return { pushed: false, skipped: true, error: null };
  }

  // Check if the local branch is ahead of remote before pushing
  if (!(await integrationTargetNeedsPush(projectDir, integrationBranch))) {
    return { pushed: false, skipped: true, error: null };
  }

  // For integration target, always use -u to ensure tracking is established
  let result: GitResult;
  try {
    result = await runDispatchIntegrationTargetGit(projectDir, integrationBranch, [
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
export async function deleteRemoteDispatchBranch(
  projectDir: string,
  canonicalBranch: string,
  remote: string,
): Promise<{ deleted: boolean; error: string | null }> {
  // AC: @dispatch-remote-branch-sync ac-no-remote
  if (!remote) {
    return { deleted: false, error: null };
  }

  // Only delete if the branch has been pushed (has upstream tracking)
  if (!(await hasUpstreamTracking(projectDir, canonicalBranch))) {
    return { deleted: false, error: null };
  }

  const result = await runGit(projectDir, ["push", remote, "--delete", canonicalBranch]);
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
export async function resolveDispatchRemote(projectDir: string): Promise<string | null> {
  const remotes = await listGitRemotes(projectDir);
  return remotes.length > 0 ? remotes[0] : null;
}

async function listDispatchBranches(projectDir: string): Promise<string[]> {
  const result = await runGit(projectDir, [
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${DISPATCH_BRANCH_PREFIX}`,
  ]);
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function reconcileDispatchWorkspaceLifecycle(
  options: ReconcileDispatchWorkspaceLifecycleOptions,
): Promise<ProvisionedDispatchWorkspace | null> {
  const { projectDir, taskRef, cleanupState, task } = options;
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
  const existingRecord = await loadWorkspaceRecordForWorktreeRoot(
    projectDir,
    taskRef,
    resolvedConfig.worktreeRoot,
  );
  if (!existingRecord) {
    return null;
  }

  const now = new Date().toISOString();
  const health = await reconcileWorkspaceHealth(projectDir, existingRecord, now);
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
  const canonicalBranchHead = (await refExists(
    projectDir,
    `refs/heads/${existingRecord.canonical_branch}`,
  ))
    ? await resolveCommit(projectDir, existingRecord.canonical_branch)
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
      closed_at: lifecycleState === "closed" ? (existingRecord.timestamps.closed_at ?? now) : null,
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
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
  const existingRecord = await loadWorkspaceRecordForWorktreeRoot(
    projectDir,
    taskRef,
    resolvedConfig.worktreeRoot,
  );
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
    const latestRecord = await loadWorkspaceRecordForWorktreeRoot(
      projectDir,
      taskRef,
      resolvedConfig.worktreeRoot,
    );
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
      health: await reconcileWorkspaceHealth(
        projectDir,
        {
          ...latestRecord,
          worktrees: {
            ...latestRecord.worktrees,
            reviewer: null,
          },
        },
        now,
      ),
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
    activeTaskIds?: Iterable<string>;
    task?: { title?: string; slugs?: string[] };
  },
): Promise<DispatchWorkspaceReapResult> {
  const existing = await findWorkspaceRegistrationByTaskRef(projectDir, taskRef, options?.task);
  if (!existing) {
    return { taskRef, action: "none", blockedReason: null };
  }

  // AC: @dispatch-workspace-registry ac-10
  // Idempotency: if the registry already has cleanup.status=completed for
  // this workspace, do not re-run physical cleanup and do not produce a new
  // shadow commit. The record is terminal on the cleanup axis.
  const existingRegistryRecord = await loadWorkspaceRecordForWorktreeRoot(
    projectDir,
    taskRef,
    existing.metadata.worktreeRoot,
  );
  if (existingRegistryRecord?.cleanup.status === "completed") {
    return { taskRef, action: "reaped", blockedReason: null };
  }

  // Compare active/in-flight protection by canonical task identity so a record
  // discovered under one alias is protected by an invocation tracked under a
  // different alias of the same task. Protection keys are normalized (any `@`
  // stripped, case-folded) so a bare canonical ULID and a display ref of the
  // same task collapse to one key.
  // AC: @dispatch-canonical-task-identity ac-cleanup-protection-uses-canonical-task
  const activeKeys = new Set<string>();
  for (const id of options?.activeTaskIds ?? []) {
    activeKeys.add(normalizeProtectionKey(id));
  }
  const canonicalId =
    existingRegistryRecord?.task_id ?? (await resolveProjectCanonicalId(projectDir, taskRef));
  const isProtected = activeKeys.has(normalizeProtectionKey(canonicalId ?? taskRef));
  if (isProtected) {
    const blockedReason =
      "Cleanup blocked: canonical branch still has an active dispatch invocation.";
    // AC: @dispatch-workspace-registry ac-8
    // Persist the blocked transition through the shadow-mutation path so it
    // survives daemon restart and worker-worktree loss. The worker metadata
    // file is also updated for local consistency.
    await persistCleanupBlockedState(projectDir, existing, blockedReason);
    return { taskRef, action: "cleanup_blocked", blockedReason };
  }

  if (!existing.metadata.cleanupEligible) {
    const blockedReason =
      "Cleanup blocked: workspace integration outcome is unresolved, so the canonical branch must be retained.";
    // AC: @dispatch-workspace-registry ac-8
    await persistCleanupBlockedState(projectDir, existing, blockedReason);
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
    const remote = await resolveDispatchRemote(projectDir);
    if (remote) {
      const remoteResult = await deleteRemoteDispatchBranch(
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
    await deleteDispatchBranch(projectDir, existing.metadata.canonicalBranch);
  } else if (existing.metadata.branchProvenance.rehydrated) {
    await deleteRehydratedAdoptedBranch(projectDir, existing.metadata.canonicalBranch);
  }

  // AC: @dispatch-workspace-registry ac-successful-cleanup-persists-completion
  // AC: @dispatch-workspace-registry ac-successful-cleanup-populates-closed-at
  // AC: @dispatch-workspace-registry ac-8
  // Write the completion transition AFTER successful physical removal so a
  // pre-removal write cannot briefly advertise a record as closed while its
  // worktree still exists. If the shadow commit fails after this point, the
  // record is left with cleanup.status=scheduled and no physical artifacts;
  // reconciliation self-heals that state forward on its next cycle.
  await persistCleanupCompletedState(projectDir, taskRef, existingRegistryRecord);

  return { taskRef, action: "reaped", blockedReason: null };
}

/**
 * Persist a blocked cleanup transition to the workspace registry through the
 * shadow-mutation path, then mirror the state into the worker worktree's
 * on-disk metadata file for local consistency.
 *
 * AC: @dispatch-workspace-registry ac-8
 */
async function persistCleanupBlockedState(
  projectDir: string,
  existing: {
    canonicalBranch: string;
    workerWorktreeDir: string;
    metadata: DispatchWorkspaceMetadata;
  },
  blockedReason: string,
): Promise<void> {
  const now = new Date().toISOString();
  const existingRecord = await loadWorkspaceRecordForWorktreeRoot(
    projectDir,
    existing.metadata.taskRef,
    existing.metadata.worktreeRoot,
  );

  if (existingRecord) {
    const alreadyBlocked =
      existingRecord.cleanup.status === "blocked" &&
      existingRecord.cleanup.reason === blockedReason &&
      existingRecord.lifecycle_state === "cleanup_blocked";
    if (alreadyBlocked) {
      // AC: @dispatch-workspace-registry ac-10 — no-op re-entry must not
      // bump updated_at or produce a shadow commit.
      return;
    }
    const updatedRecord: DispatchWorkspaceRecord = {
      ...existingRecord,
      lifecycle_state: "cleanup_blocked",
      cleanup: {
        status: "blocked",
        eligible: existingRecord.cleanup.eligible,
        reason: blockedReason,
        detail: blockedReason,
        updated_at: now,
      },
      timestamps: {
        ...existingRecord.timestamps,
        updated_at: now,
      },
    };
    await persistWorkspaceRecord(projectDir, updatedRecord);
    // Preserve local-metadata fields that toMetadata() does not emit for
    // non-eligible cleanup state (cleanupScheduledAt is null when
    // cleanup.eligible=false). Callers of the on-disk metadata rely on
    // cleanupScheduledAt as a signal that cleanup was attempted.
    if (await pathExists(existing.workerWorktreeDir)) {
      const refreshedMetadata = await readWorkspaceMetadata(existing.workerWorktreeDir);
      if (refreshedMetadata) {
        await writeWorkspaceMetadata(existing.workerWorktreeDir, {
          ...refreshedMetadata,
          cleanupBlockedReason: blockedReason,
          cleanupScheduledAt:
            refreshedMetadata.cleanupScheduledAt ?? existing.metadata.cleanupScheduledAt ?? now,
        });
      }
    }
    return;
  }

  // Fallback path: no registry record found. Update the worker worktree
  // metadata file so local state reflects the block even without a registry
  // record to update.
  const metadata: DispatchWorkspaceMetadata = {
    ...existing.metadata,
    lifecycleState: "cleanup_blocked",
    cleanupBlockedReason: blockedReason,
    cleanupScheduledAt: existing.metadata.cleanupScheduledAt ?? now,
    updatedAt: now,
  };
  await writeWorkspaceMetadata(existing.workerWorktreeDir, metadata);
}

/**
 * Persist the cleanup-completed transition after successful physical removal.
 * Writes cleanup.status=completed, closed_at, and updated_at through the
 * shadow-mutation path.
 *
 * AC: @dispatch-workspace-registry ac-successful-cleanup-persists-completion
 * AC: @dispatch-workspace-registry ac-successful-cleanup-populates-closed-at
 * AC: @dispatch-workspace-registry ac-8
 */
async function persistCleanupCompletedState(
  projectDir: string,
  taskRef: string,
  existingRegistryRecord: LoadedDispatchWorkspaceRecord | undefined,
): Promise<void> {
  if (!existingRegistryRecord) {
    // No registry record exists to update. This is a legacy or
    // pre-registry workspace — the caller has already removed physical
    // artifacts; there is no registry state to transition.
    return;
  }

  const now = new Date().toISOString();
  const updatedRecord: DispatchWorkspaceRecord = {
    ...existingRegistryRecord,
    lifecycle_state: "closed",
    cleanup: {
      ...existingRegistryRecord.cleanup,
      status: "completed",
      updated_at: now,
    },
    timestamps: {
      ...existingRegistryRecord.timestamps,
      updated_at: now,
      closed_at: existingRegistryRecord.timestamps.closed_at ?? now,
    },
  };
  await persistWorkspaceRecord(projectDir, updatedRecord);
  // commitWorkspaceRegistryToShadow runs inside persistWorkspaceRecord and
  // will throw if the shadow commit fails. Let it propagate so callers know
  // the completion state is not durable.
  void taskRef;
}

/**
 * Decision returned by the dispatch artifact protection helper for a single
 * artifact lookup. `preserve` is the binary preserve-or-not signal cleanup
 * surfaces should consume; `reason` is actionable diagnostic text useful for
 * logs and test assertions.
 *
 * AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
 * AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
 * AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
 */
export interface DispatchArtifactProtectionDecision {
  preserve: boolean;
  reason: string | null;
}

/**
 * Centralized protection-policy state for dispatch artifact cleanup. A single
 * instance is built per cleanup pass and consulted by every destructive
 * cleanup surface (worktree deletion, reviewer snapshot pruning,
 * root-directory pruning, dispatch branch deletion) so the preserve/delete
 * decision is uniform across surfaces.
 *
 * AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
 */
export interface DispatchArtifactProtectionState {
  readonly worktreeRoot: string;
  readonly registryTrusted: boolean;
  readonly registryFailureDiagnostic: string | null;
  readonly activeOrInFlightTaskRefs: ReadonlySet<string>;
  /**
   * Short-id suffixes derived from {@link activeOrInFlightTaskRefs} via
   * {@link shortTaskId}. Used to recognize canonical dispatch branches and
   * worktree basenames during the queue-to-spawn window — when an invocation
   * is in-flight but the registry record has not yet been written.
   */
  readonly activeOrInFlightShortIds: ReadonlySet<string>;
  readonly protectedTaskRefs: ReadonlySet<string>;
  readonly protectedBranches: ReadonlySet<string>;
  readonly protectedPaths: ReadonlySet<string>;
  evaluateTaskRef(taskRef: string): DispatchArtifactProtectionDecision;
  evaluateDispatchBranch(branch: string): DispatchArtifactProtectionDecision;
  evaluateWorkspacePath(candidatePath: string): DispatchArtifactProtectionDecision;
  evaluateClosingRecordForReap(
    record: DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord,
  ): DispatchArtifactProtectionDecision;
}

/**
 * Input snapshot for {@link buildDispatchArtifactProtectionState}. The helper
 * is intentionally pure: callers do the registry I/O and pass the outcome in,
 * so the protection decision is deterministic and easy to unit-test.
 *
 * Use `registry.status: "load-failed"` to signal that the registry could not
 * be loaded or parsed; the helper will then enter no-blind-deletion mode for
 * dispatcher-managed artifacts under the configured worktree root.
 */
export type DispatchArtifactProtectionInput = {
  worktreeRoot: string;
  activeOrInFlightTaskRefs?: Iterable<string>;
  registry:
    | {
        status: "loaded";
        records: readonly (DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord)[];
      }
    | { status: "load-failed"; reason: string };
};

const DISPATCH_PROTECTED_LIFECYCLE_STATES: ReadonlySet<DispatchWorkspaceLifecycleState> = new Set([
  "provisioning",
  "ready",
  "active",
  "stale",
  "integrating",
  "cleanup_blocked",
]);

function isUnresolvedDispatchIntegration(status: DispatchWorkspaceIntegrationStatus): boolean {
  return status === "pending" || status === "in_progress";
}

function pathsOverlap(candidate: string, protectedPath: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedProtected = path.resolve(protectedPath);
  if (resolvedCandidate === resolvedProtected) return true;
  if (isPathInside(resolvedCandidate, resolvedProtected)) return true;
  if (isPathInside(resolvedProtected, resolvedCandidate)) return true;
  return false;
}

/**
 * Return the trailing short-id segment of a canonical dispatch branch
 * (`dispatch/task/<slug>/<short-id>`) or null if the branch does not match the
 * canonical 4-segment layout. Used to link active/in-flight task refs to their
 * deterministic canonical branch even when no registry record exists yet.
 */
function dispatchBranchShortIdSuffix(branch: string): string | null {
  if (!isDispatchBranch(branch)) return null;
  const parts = branch.split("/");
  if (parts.length !== 4) return null;
  const candidate = parts[3];
  return candidate && candidate.length > 0 ? candidate : null;
}

/**
 * Return true when a basename matches the canonical dispatch workspace
 * layout for a given short-id: `<slug>-<short-id>` for worker worktrees and
 * `<slug>-<short-id>-review` for reviewer worktrees.
 */
function basenameMatchesDispatchShortId(basename: string, shortId: string): boolean {
  const workerSuffix = `-${shortId}`;
  const reviewerSuffix = `-${shortId}-review`;
  return basename.endsWith(workerSuffix) || basename.endsWith(reviewerSuffix);
}

/**
 * Build a pure {@link DispatchArtifactProtectionState} from a registry
 * snapshot plus the caller-supplied active/in-flight task refs.
 *
 * Protection sources, per @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
 * and @dispatch-workspace-registry ac-partial-provisioning-classified-before-cleanup:
 *
 * - Caller-supplied active/in-flight task refs are always protected, and their
 *   deterministic canonical dispatch branch (`dispatch/task/<slug>/<short-id>`)
 *   and worker/reviewer worktree basenames (`<slug>-<short-id>` and
 *   `<slug>-<short-id>-review`) are preserved across every destructive surface
 *   even when no registry record exists yet (queue-to-spawn window).
 * - Non-closed registry records in `provisioning`, `ready`, `active`, `stale`,
 *   `integrating`, or `cleanup_blocked` lifecycle states are always protected.
 * - Non-closed records in `closing` state are protected only while
 *   active/in-flight ownership or unresolved integration remains. Otherwise the
 *   helper classifies them cleanup-eligible so scheduled
 *   {@link reapDispatchWorkspace} cleanup can advance them to `closed`.
 * - When `registry.status === "load-failed"`, the helper enters no-blind-deletion
 *   mode: every dispatcher-managed task ref, dispatch branch, and path under the
 *   configured worktree root is preserved with an actionable diagnostic until
 *   the registry can be re-classified.
 */
export function buildDispatchArtifactProtectionState(
  input: DispatchArtifactProtectionInput,
): DispatchArtifactProtectionState {
  const worktreeRoot = path.resolve(input.worktreeRoot);
  const activeOrInFlightTaskRefs = new Set(input.activeOrInFlightTaskRefs ?? []);
  // Derive short-id suffixes so a queue-to-spawn invocation whose canonical
  // branch (`dispatch/task/<slug>/<short-id>`) has been reserved but whose
  // registry record has not yet been written still protects that branch and
  // its worker/reviewer worktree basenames across every destructive cleanup
  // surface. The short-id is deterministic from the task ref alone, so this
  // closes the gap between caller-supplied active/in-flight task refs and the
  // dispatch artifacts they own.
  const activeOrInFlightShortIds = new Set<string>();
  for (const ref of activeOrInFlightTaskRefs) {
    activeOrInFlightShortIds.add(shortTaskId(ref));
  }
  // Compare task identity by canonical key (the ULID with any `@` prefix
  // stripped, case-normalized) so an active/in-flight entry supplied as a bare
  // canonical ULID protects a record persisted under a display alias, and vice
  // versa. AC: @dispatch-canonical-task-identity ac-cleanup-protection-uses-canonical-task
  const activeKeys = new Set<string>();
  for (const ref of activeOrInFlightTaskRefs) {
    activeKeys.add(normalizeProtectionKey(ref));
  }
  const protectedTaskRefs = new Set<string>(activeOrInFlightTaskRefs);
  const protectedKeys = new Set<string>(activeKeys);
  const protectedBranches = new Set<string>();
  const protectedPaths = new Set<string>();
  // Map every known display alias (task_ref) to its canonical protection key so
  // a cleanup surface that evaluates by display ref still resolves to canonical
  // identity. AC: @dispatch-canonical-task-identity ac-cleanup-protection-uses-canonical-task
  const aliasToCanonicalKey = new Map<string, string>();

  let registryTrusted = true;
  let registryFailureDiagnostic: string | null = null;

  if (input.registry.status === "load-failed") {
    registryTrusted = false;
    registryFailureDiagnostic =
      `Dispatch workspace registry unavailable (${input.registry.reason}). ` +
      `Preserving dispatcher-managed artifacts under "${worktreeRoot}" until ` +
      `registry classification can confirm cleanup eligibility.`;
  } else {
    for (const record of input.registry.records) {
      if (!workspaceRecordBelongsToWorktreeRoot(record, worktreeRoot)) continue;
      if (record.lifecycle_state === "closed") continue;

      const recordKey = normalizeProtectionKey(record.task_id ?? record.task_ref);
      aliasToCanonicalKey.set(normalizeProtectionKey(record.task_ref), recordKey);
      if (record.task_id) {
        aliasToCanonicalKey.set(normalizeProtectionKey(record.task_id), recordKey);
      }
      const taskRefActive = activeKeys.has(recordKey);
      const integrationUnresolved = isUnresolvedDispatchIntegration(record.integration.status);

      let recordProtected = false;
      if (DISPATCH_PROTECTED_LIFECYCLE_STATES.has(record.lifecycle_state)) {
        recordProtected = true;
      } else if (record.lifecycle_state === "closing") {
        recordProtected = taskRefActive || integrationUnresolved;
      }

      // Paths and branches of any non-closed record are protected from blind
      // path/branch deletion regardless of whether the record itself is
      // reap-eligible. Reap-eligible closing records are removed through
      // reapDispatchWorkspace, not by blind cleanup surfaces.
      protectedBranches.add(record.canonical_branch);
      protectedPaths.add(path.resolve(record.worktrees.worker.path));
      if (record.worktrees.reviewer) {
        protectedPaths.add(path.resolve(record.worktrees.reviewer.path));
      }
      if (recordProtected) {
        protectedTaskRefs.add(record.task_ref);
        protectedKeys.add(recordKey);
      }
    }
  }

  const evaluateTaskRef = (taskRef: string): DispatchArtifactProtectionDecision => {
    const rawKey = normalizeProtectionKey(taskRef);
    // Resolve display aliases to their canonical key so evaluating by slug or
    // ULID both find the same record's protection.
    const key = aliasToCanonicalKey.get(rawKey) ?? rawKey;
    if (activeKeys.has(key)) {
      return {
        preserve: true,
        reason: `Task ${taskRef} has an active or in-flight dispatch invocation; cleanup must preserve its artifacts.`,
      };
    }
    if (protectedKeys.has(key)) {
      return {
        preserve: true,
        reason: `Task ${taskRef} has a non-closed dispatch workspace record that is not yet cleanup-eligible.`,
      };
    }
    if (!registryTrusted) {
      return { preserve: true, reason: registryFailureDiagnostic };
    }
    return { preserve: false, reason: null };
  };

  const evaluateDispatchBranch = (branch: string): DispatchArtifactProtectionDecision => {
    if (!isDispatchBranch(branch)) {
      return { preserve: false, reason: null };
    }
    if (protectedBranches.has(branch)) {
      return {
        preserve: true,
        reason: `Dispatch branch ${branch} belongs to a non-closed workspace record; preserving until the record reaches closed.`,
      };
    }
    // Queue-to-spawn protection: even when the registry has no record yet for
    // an active/in-flight task ref, the canonical dispatch branch reserved for
    // that task must not be deleted by branch pruning surfaces. The branch's
    // trailing short-id segment is deterministic from the task ref.
    const branchShortId = dispatchBranchShortIdSuffix(branch);
    if (branchShortId && activeOrInFlightShortIds.has(branchShortId)) {
      return {
        preserve: true,
        reason: `Dispatch branch ${branch} matches an active or in-flight task; cleanup must preserve its canonical branch.`,
      };
    }
    if (!registryTrusted) {
      return { preserve: true, reason: registryFailureDiagnostic };
    }
    return { preserve: false, reason: null };
  };

  const evaluateWorkspacePath = (candidatePath: string): DispatchArtifactProtectionDecision => {
    const resolvedCandidate = path.resolve(candidatePath);
    for (const protectedPath of protectedPaths) {
      if (pathsOverlap(resolvedCandidate, protectedPath)) {
        return {
          preserve: true,
          reason: `Path ${resolvedCandidate} overlaps non-closed workspace path ${protectedPath}; cleanup must not delete or prune it.`,
        };
      }
    }
    // Queue-to-spawn protection: worker (`<slug>-<short-id>`) and reviewer
    // (`<slug>-<short-id>-review`) basenames are deterministic from the task
    // ref. Preserve these paths under the configured worktree root even when
    // no registry record exists yet, so root-directory and worktree pruning
    // never deletes an active or in-flight workspace dir.
    if (isPathInside(worktreeRoot, resolvedCandidate)) {
      const basename = path.basename(resolvedCandidate);
      for (const shortId of activeOrInFlightShortIds) {
        if (basenameMatchesDispatchShortId(basename, shortId)) {
          return {
            preserve: true,
            reason: `Path ${resolvedCandidate} matches an active or in-flight task workspace basename "${basename}"; cleanup must preserve it.`,
          };
        }
      }
    }
    if (!registryTrusted && isPathInside(worktreeRoot, resolvedCandidate)) {
      return { preserve: true, reason: registryFailureDiagnostic };
    }
    return { preserve: false, reason: null };
  };

  const evaluateClosingRecordForReap = (
    record: DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord,
  ): DispatchArtifactProtectionDecision => {
    if (record.lifecycle_state !== "closing") {
      return { preserve: false, reason: null };
    }
    if (activeKeys.has(normalizeProtectionKey(record.task_id ?? record.task_ref))) {
      return {
        preserve: true,
        reason: `Closing workspace for ${record.task_ref} still has active/in-flight ownership; reap must wait.`,
      };
    }
    if (isUnresolvedDispatchIntegration(record.integration.status)) {
      return {
        preserve: true,
        reason: `Closing workspace for ${record.task_ref} has unresolved integration status "${record.integration.status}"; reap must wait until integration resolves.`,
      };
    }
    return {
      preserve: false,
      reason: `Closing workspace for ${record.task_ref} has no active ownership and resolved integration; eligible for scheduled cleanup via reapDispatchWorkspace.`,
    };
  };

  return {
    worktreeRoot,
    registryTrusted,
    registryFailureDiagnostic,
    activeOrInFlightTaskRefs,
    activeOrInFlightShortIds,
    protectedTaskRefs,
    protectedBranches,
    protectedPaths,
    evaluateTaskRef,
    evaluateDispatchBranch,
    evaluateWorkspacePath,
    evaluateClosingRecordForReap,
  };
}

/**
 * Convenience wrapper that loads the dispatch workspace registry and assembles
 * a {@link DispatchArtifactProtectionState} for a project. Registry
 * load/parsing errors are caught and converted into a `load-failed` snapshot
 * so the helper can surface them as no-blind-deletion guidance instead of
 * propagating to cleanup callers.
 */
export async function loadDispatchArtifactProtectionState(
  projectDir: string,
  resolvedConfig: ResolvedDispatchWorkspaceConfig,
  options: { activeOrInFlightTaskRefs?: Iterable<string> } = {},
): Promise<DispatchArtifactProtectionState> {
  let registryInput: DispatchArtifactProtectionInput["registry"];
  try {
    const ctx = await initContext(projectDir);
    const records = await loadDispatchWorkspaceRegistry(ctx);
    // Backfill canonical task_id for historical records (resolvable refs) so the
    // pure protection builder can compare every record by canonical identity.
    // Unresolvable historical records keep a null task_id and fall back to their
    // raw task_ref key — they cannot be protected by a canonical alias but also
    // cannot be matched by one.
    // AC: @dispatch-canonical-task-identity ac-historical-workspace-records-normalize-or-stale
    const resolver = await buildProjectTaskResolver(ctx);
    const normalizedRecords = records.map((record) =>
      record.task_id
        ? record
        : { ...record, task_id: recordCanonicalId(record, resolver) ?? undefined },
    );
    registryInput = { status: "loaded", records: normalizedRecords };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    registryInput = { status: "load-failed", reason };
  }
  return buildDispatchArtifactProtectionState({
    worktreeRoot: resolvedConfig.worktreeRoot,
    activeOrInFlightTaskRefs: options.activeOrInFlightTaskRefs,
    registry: registryInput,
  });
}

/**
 * Identifier for a dispatch cleanup destructive surface. Used in diagnostic
 * messages emitted by {@link reconcileDispatchWorkspaceArtifacts} so logs
 * identify *which* cleanup surface preserved or blocked an artifact alongside
 * the protection-source reason.
 *
 * AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
 * AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
 */
type DispatchCleanupSurface =
  | "metadata-less-worktree"
  | "reap-candidate"
  | "reviewer-snapshot"
  | "root-directory"
  | "dispatch-branch";

function logArtifactPreservation(
  surface: DispatchCleanupSurface,
  identifier: string,
  reason: string | null,
): void {
  // Preservation diagnostics can occur on every reconciliation pass for every
  // protected artifact. Keep them opt-in so normal daemon operation does not
  // amplify deterministic cleanup blockers into unbounded log volume.
  if (process.env.KSPEC_DISPATCH_CLEANUP_DIAGNOSTICS !== "1") {
    return;
  }
  const reasonText = reason ?? "protection-source unspecified";
  console.debug(`[dispatch-cleanup] preserved ${surface} "${identifier}": ${reasonText}`);
}

export async function reconcileDispatchWorkspaceArtifacts(
  projectDir: string,
  options?: { activeTaskIds?: Iterable<string> },
): Promise<void> {
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
  await ensureUsableWorktreeRoot(projectDir, resolvedConfig.worktreeRoot);
  // Canonical full task ULIDs of active/in-flight invocations; cleanup
  // protection compares by canonical identity, not display ref.
  // AC: @dispatch-canonical-task-identity ac-cleanup-protection-uses-canonical-task
  const activeTaskIds = new Set(options?.activeTaskIds ?? []);
  const worktreeEntries = await parseWorktreeList(projectDir);
  const entriesUnderRoot = worktreeEntries.filter((entry) =>
    isPathInside(resolvedConfig.worktreeRoot, entry.path),
  );

  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  // Single source of truth consulted by every destructive cleanup surface in
  // this function. Built once from the registry snapshot plus active/in-flight
  // task refs so all surfaces converge on the same preserve/delete decision.
  let protection = await loadDispatchArtifactProtectionState(projectDir, resolvedConfig, {
    activeOrInFlightTaskRefs: activeTaskIds,
  });

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
      // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
      // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
      // A metadata-less dispatch worktree could still belong to a non-closed
      // registry record (e.g. a provisioning workspace whose metadata file
      // has not yet been written, or whose metadata file has been deleted out
      // of band). Defer to the protection state before pruning.
      const branchDecision = branchName
        ? protection.evaluateDispatchBranch(branchName)
        : { preserve: false, reason: null };
      const pathDecision = protection.evaluateWorkspacePath(entry.path);
      if (branchDecision.preserve || pathDecision.preserve) {
        if (branchName) {
          trackedBranches.add(branchName);
        }
        // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
        // Surface which protection source preserved this metadata-less
        // worktree so logs identify the cleanup surface and the reason.
        logArtifactPreservation(
          "metadata-less-worktree",
          entry.path,
          pathDecision.preserve ? pathDecision.reason : branchDecision.reason,
        );
        continue;
      }
      await safelyRemoveDispatchWorktree(projectDir, resolvedConfig.worktreeRoot, entry.path);
      if (branchName && isDispatchBranch(branchName)) {
        await deleteDispatchBranch(projectDir, branchName);
      }
      continue;
    }

    trackedBranches.add(metadata.canonicalBranch);
    if (metadata.reviewerWorktreeDir) {
      referencedReviewerDirs.add(path.resolve(metadata.reviewerWorktreeDir));
      const reviewerRegistration = await findWorktreeByPath(
        projectDir,
        metadata.reviewerWorktreeDir,
      );
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
      // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
      // AC: @dispatch-canonical-task-identity ac-cleanup-protection-uses-canonical-task
      // reapDispatchWorkspace internally re-checks the canonical protection set
      // and integration state, but routing the decision through the protection
      // helper by canonical identity keeps every destructive surface aligned.
      const reapDecision = protection.evaluateTaskRef(metadata.taskId ?? metadata.taskRef);
      if (reapDecision.preserve) {
        logArtifactPreservation("reap-candidate", metadata.taskRef, reapDecision.reason);
      } else {
        await reapDispatchWorkspace(projectDir, metadata.taskRef, {
          activeTaskIds,
          task: {
            title: metadata.taskSlug,
            slugs: [metadata.taskSlug],
          },
        });
      }
    }
  }

  // Recovery and reap may have mutated the registry. Rebuild the protection
  // state so subsequent surfaces see the latest classification.
  protection = await loadDispatchArtifactProtectionState(projectDir, resolvedConfig, {
    activeOrInFlightTaskRefs: activeTaskIds,
  });

  for (const entry of entriesUnderRoot) {
    if (entry.branch === null && entry.path.endsWith("-review")) {
      if (referencedReviewerDirs.has(path.resolve(entry.path))) continue;
      // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
      const reviewerDecision = protection.evaluateWorkspacePath(entry.path);
      if (reviewerDecision.preserve) {
        logArtifactPreservation("reviewer-snapshot", entry.path, reviewerDecision.reason);
        continue;
      }
      await safelyRemoveDispatchWorktree(projectDir, resolvedConfig.worktreeRoot, entry.path);
    }
  }

  const rootEntries = await fs
    .readdir(resolvedConfig.worktreeRoot, { withFileTypes: true })
    .catch(() => []);
  for (const dirent of rootEntries) {
    const candidate = path.join(resolvedConfig.worktreeRoot, dirent.name);
    if (await findWorktreeByPath(projectDir, candidate)) {
      continue;
    }
    const metadata = await readWorkspaceMetadata(candidate);
    if (metadata && !metadataBelongsToWorktreeRoot(metadata, resolvedConfig.worktreeRoot)) {
      continue;
    }
    const gitMarker = await fs.stat(path.join(candidate, ".git")).catch(() => null);
    if (gitMarker) {
      continue;
    }
    // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
    // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
    // Root-directory pruning must respect protected workspace paths and must
    // not delete dispatcher-managed candidates when registry classification
    // is unavailable.
    const rootDecision = protection.evaluateWorkspacePath(candidate);
    if (rootDecision.preserve) {
      logArtifactPreservation("root-directory", candidate, rootDecision.reason);
      continue;
    }
    await fs.rm(candidate, { recursive: true, force: true });
  }

  // AC: @dispatch-workspace-cleanup-policy ac-protection-applies-to-every-destructive-surface
  // AC: @dispatch-workspace-cleanup-policy ac-ambiguous-protection-blocks-blind-deletion
  // AC: @dispatch-workspace-registry ac-13 — dispatch branch deletion consults
  // the centralized protection state. Branches belonging to non-closed records
  // are preserved; a registry that cannot be loaded becomes a no-blind-deletion
  // signal instead of the previous "delete every untracked dispatch branch"
  // fallback.
  for (const branch of await listDispatchBranches(projectDir)) {
    if (trackedBranches.has(branch)) {
      continue;
    }
    const branchDecision = protection.evaluateDispatchBranch(branch);
    if (branchDecision.preserve) {
      logArtifactPreservation("dispatch-branch", branch, branchDecision.reason);
      continue;
    }
    await deleteDispatchBranch(projectDir, branch);
  }
}

async function ensureReviewerWorktree(
  projectDir: string,
  reviewerWorktreeDir: string,
  canonicalBranch: string,
): Promise<void> {
  const existingRegistration = await findWorktreeByPath(projectDir, reviewerWorktreeDir);
  if (!existingRegistration) {
    await assertPathSafeForWorktree(reviewerWorktreeDir, projectDir);
    await runGitOrThrow(
      projectDir,
      ["worktree", "add", "--detach", reviewerWorktreeDir, canonicalBranch],
      `Failed to create detached reviewer worktree for "${canonicalBranch}"`,
      "Inspect git worktree state and remove stale reviewer worktrees before retrying.",
    );
    return;
  }

  await runGitOrThrow(
    reviewerWorktreeDir,
    ["checkout", "--detach", canonicalBranch],
    `Failed to refresh reviewer snapshot for "${canonicalBranch}"`,
    "Inspect reviewer worktree state and remove or repair it before retrying.",
  );
  await runGitOrThrow(
    reviewerWorktreeDir,
    ["reset", "--hard", canonicalBranch],
    `Failed to align reviewer snapshot with "${canonicalBranch}"`,
    "Inspect reviewer worktree state and remove or repair it before retrying.",
  );
}

export async function provisionDispatchWorkspace(
  options: ProvisionDispatchWorkspaceOptions,
): Promise<ProvisionedDispatchWorkspace> {
  const {
    projectDir,
    taskRef,
    task,
    role = "worker",
    cleanupState,
    submissionLinkage,
    taskStatus,
  } = options;
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir, { taskRef, task });
  await ensureUsableWorktreeRoot(projectDir, resolvedConfig.worktreeRoot);

  const existingRecord = await loadWorkspaceRecordForWorktreeRoot(
    projectDir,
    taskRef,
    resolvedConfig.worktreeRoot,
  );
  const foreignOpenRecord = existingRecord
    ? undefined
    : await loadForeignOpenWorkspaceRecord(projectDir, taskRef, resolvedConfig.worktreeRoot);
  const taskSlug = existingRecord?.task_slug ?? normalizeTaskSlug(taskRef, task);
  // Canonical task identity keys all derived lineage (workspace id, branch,
  // worktree basenames) so aliases of the same task converge on one workspace.
  // AC: @dispatch-canonical-task-identity ac-workspace-lineage-stable-across-aliases
  const canonicalTaskId =
    existingRecord?.task_id ?? (await resolveProjectCanonicalId(projectDir, taskRef));
  const shortId = canonicalTaskId ? shortTaskId(canonicalTaskId) : shortTaskId(taskRef);

  if (foreignOpenRecord) {
    throw new DispatchWorkspaceError(
      `Task ${taskRef} already has an open dispatch workspace in foreign worktree root "${foreignOpenRecord.worktree_root}" (${foreignOpenRecord.worktrees.worker.path}).`,
      `Resume work from that checkout, or close/reset workspace "${foreignOpenRecord.workspace_id}" before provisioning under "${resolvedConfig.worktreeRoot}".`,
    );
  }

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
    const branchExistsLocally = await refExists(projectDir, `refs/heads/${linkageBranch}`);

    if (branchExistsLocally) {
      // AC: @adopt-existing-task-branch-lineage ac-1 — adopt the local branch directly
      adoptedBranch = linkageBranch;
    } else {
      // AC: @adopt-existing-task-branch-lineage ac-2 — rehydrate from remote
      const rehydrated = await rehydrateAdoptedBranch(
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

  // AC: @adopt-existing-task-branch-lineage ac-reject-main-checkout-branch
  // Reject adoption when the branch is currently checked out in the main
  // repository working tree. This prevents adopting the base branch (or any
  // branch occupying the main checkout) as a task's canonical branch, which
  // would trigger the foreign worktree guard and block the task.
  if (adoptedBranch) {
    const worktreeEntries = await parseWorktreeList(projectDir);
    const mainEntry = worktreeEntries.find(
      (entry) => path.resolve(entry.path) === path.resolve(projectDir),
    );
    const mainBranchRef = mainEntry?.branch ?? null;
    const adoptedBranchRef = `refs/heads/${adoptedBranch}`;
    if (mainBranchRef === adoptedBranchRef) {
      throw new DispatchWorkspaceError(
        `Cannot adopt branch "${adoptedBranch}" for task ${taskRef}: it is currently checked out in the main repository working tree (${projectDir}).` +
          ` This usually means submission linkage was captured from the wrong checkout.`,
        `Repair the task's submission linkage to reference the correct task branch: kspec task set ${taskRef} --submission-linkage`,
      );
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

  const canonicalBranch =
    existingRecord?.canonical_branch ?? (adoptedBranch || `dispatch/task/${taskSlug}/${shortId}`);
  const branchProvenance: DispatchWorkspaceBranchProvenance =
    existingRecord?.branch_provenance ??
    (adoptedBranch
      ? adoptedBranchProvenance(
          adoptedBranch,
          adoptionRemoteRef,
          new Date().toISOString(),
          adoptionRehydrated,
        )
      : defaultBranchProvenance());
  const workspaceId = existingRecord?.workspace_id ?? workspaceIdFor(canonicalTaskId ?? taskRef);
  const workerWorktreeDir =
    existingRecord?.worktrees.worker.path ??
    (await findExistingWorktreeForBranchUnderRoot(
      projectDir,
      canonicalBranch,
      resolvedConfig.worktreeRoot,
    )) ??
    path.join(resolvedConfig.worktreeRoot, `${taskSlug}-${shortId}`);
  const reviewerWorktreeDir =
    existingRecord?.worktrees.reviewer?.path ??
    path.join(resolvedConfig.worktreeRoot, `${taskSlug}-${shortId}-review`);
  // AC: @dispatch-workspace-configuration ac-6 — detect stale integration target
  // when dispatch.base_branch config has changed since the workspace was provisioned.
  const mergeTargetBranch = resolveStaleIntegrationTarget(
    existingRecord,
    resolvedConfig.baseBranch,
    resolvedConfig.baseBranchSource,
    resolvedConfig.baseBranch,
    resolvedConfig,
  );
  // When the integration target was updated to match config, also update resolved_base_branch.
  const baseBranch =
    mergeTargetBranch === resolvedConfig.baseBranch
      ? resolvedConfig.baseBranch
      : (existingRecord?.resolved_base_branch ?? resolvedConfig.baseBranch);
  const baseBranchPoint = await resolveBaseBranchPoint(
    projectDir,
    canonicalBranch,
    baseBranch,
    resolvedConfig.baseBranchStartPoint,
    existingRecord,
  );
  // When the integration target changed, resolve the commit from the new base branch
  // rather than reusing the stale base_branch_point from the existing record.
  const integrationTargetUpdated =
    existingRecord && existingRecord.integration.target_branch !== mergeTargetBranch;
  const integrationTargetCommit = integrationTargetUpdated
    ? await resolveCommit(projectDir, resolvedConfig.baseBranchStartPoint)
    : (existingRecord?.integration.target_commit ?? baseBranchPoint);
  const publicationMode = await resolveWorkspacePublicationMode(
    projectDir,
    existingRecord,
    resolvedConfig.publicationMode,
  );
  const now = new Date().toISOString();
  const provisioningRecord: DispatchWorkspaceRecord = {
    workspace_id: workspaceId,
    task_id: existingRecord?.task_id ?? canonicalTaskId ?? undefined,
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
  await assertPathSafeForWorktree(workerWorktreeDir, projectDir, canonicalBranch);
  const existingWorkerWorktree = await findExistingWorktreeForBranchUnderRoot(
    projectDir,
    canonicalBranch,
    resolvedConfig.worktreeRoot,
  );
  const foreignWorkerWorktree = await findForeignWorktreeForBranch(
    projectDir,
    canonicalBranch,
    resolvedConfig.worktreeRoot,
  );
  if (!existingWorkerWorktree && foreignWorkerWorktree) {
    throw new DispatchWorkspaceError(
      `Dispatch canonical branch "${canonicalBranch}" is already attached to foreign worktree "${foreignWorkerWorktree}" outside this checkout's worktree root "${resolvedConfig.worktreeRoot}".`,
      `Remove or relocate the foreign worktree in the other checkout, then retry dispatch from "${resolvedConfig.worktreeRoot}".`,
    );
  }
  if (!existingWorkerWorktree) {
    const branchExists = await refExists(projectDir, `refs/heads/${canonicalBranch}`);
    if (branchExists) {
      await runGitOrThrow(
        projectDir,
        ["worktree", "add", workerWorktreeDir, canonicalBranch],
        `Failed to attach existing dispatch branch "${canonicalBranch}"`,
        "Inspect git worktree state and remove stale registrations before retrying.",
      );
    } else {
      await runGitOrThrow(
        projectDir,
        [
          "worktree",
          "add",
          "-b",
          canonicalBranch,
          workerWorktreeDir,
          resolvedConfig.baseBranchStartPoint,
        ],
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
      await resolveCommit(reviewerWorktreeDir, "HEAD"),
      now,
    );
  }

  const canonicalBranchHead = await resolveCommit(projectDir, canonicalBranch);
  const health = await reconcileWorkspaceHealth(
    projectDir,
    {
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
    },
    now,
  );
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
  const resolvedConfig = await resolveDispatchWorkspaceConfig(options.projectDir);
  const existingRecord = await loadWorkspaceRecordForWorktreeRoot(
    options.projectDir,
    options.taskRef,
    resolvedConfig.worktreeRoot,
  );
  if (!existingRecord) return null;

  const now = new Date().toISOString();
  const health = await reconcileWorkspaceHealth(options.projectDir, existingRecord, now);
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
  const canonicalBranchHead = (await refExists(
    options.projectDir,
    `refs/heads/${existingRecord.canonical_branch}`,
  ))
    ? await resolveCommit(options.projectDir, existingRecord.canonical_branch)
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
    cwd:
      options.role === "reviewer" && record.worktrees.reviewer
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
  const resolvedConfig = await resolveDispatchWorkspaceConfig(options.projectDir);
  const existingRecord = await loadWorkspaceRecordForWorktreeRoot(
    options.projectDir,
    options.taskRef,
    resolvedConfig.worktreeRoot,
  );
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
  const health = await reconcileWorkspaceHealth(options.projectDir, existingRecord, now);
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
      closed_at: lifecycleState === "closed" ? (existingRecord.timestamps.closed_at ?? now) : null,
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
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
  const existingRecord = await loadWorkspaceRecordForWorktreeRoot(
    projectDir,
    taskRef,
    resolvedConfig.worktreeRoot,
  );
  if (!existingRecord) {
    return {
      exists: false,
      healthy: true,
      reason: null,
      metadata: null,
    };
  }

  const now = new Date().toISOString();
  const health = await reconcileWorkspaceHealth(projectDir, existingRecord, now);
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
  const reviewerMissingRecordedWorktree =
    role === "reviewer" && reviewerWorktree != null && !(await pathExists(reviewerWorktree.path));
  const healthy =
    health.status === "healthy" &&
    !cleanup.eligible &&
    metadata.bootstrap.roleStates[role].status !== "failed" &&
    !reviewerMissingRecordedWorktree;
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

export async function validateDispatchWorkspaceForInvocation(
  options: ValidateDispatchWorkspaceForInvocationOptions,
): Promise<ValidateDispatchWorkspaceForInvocationResult> {
  const {
    projectDir,
    taskRef,
    workspace,
    role = "worker",
    task,
    submissionLinkage,
    taskStatus,
    allowRecovery = true,
  } = options;

  const probe = await probeWorkspaceExecutability(workspace.cwd);
  if (probe.ok) {
    return {
      workspace,
      repaired: false,
    };
  }

  const workspacePath = workspace.cwd;
  const failureType = probe.failureType ?? "unknown";
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir, { taskRef, task });
  const existingRecord = await loadWorkspaceRecordForWorktreeRoot(
    projectDir,
    taskRef,
    resolvedConfig.worktreeRoot,
  );
  const currentHealth = existingRecord
    ? await reconcileWorkspaceHealth(
        projectDir,
        existingRecord,
        new Date().toISOString(),
        taskStatus,
      )
    : null;

  if (!allowRecovery || !existingRecord || currentHealth?.status === "invalid") {
    const recoveryAttempt = !allowRecovery
      ? "none"
      : !existingRecord
        ? "none"
        : "skipped because no trustworthy canonical workspace record exists";
    const nextAction =
      currentHealth?.status === "invalid"
        ? "repair the canonical workspace record or branch lineage before retrying"
        : "inspect the workspace path and recorded dispatch workspace state before retrying";
    throw new DispatchWorkspaceError(
      `Pre-invocation workspace validation failed for ${taskRef} at "${workspacePath}" (failure: ${failureType}). ${probe.detail ?? "Workspace is not runnable."} Recovery attempt: ${recoveryAttempt}. Next action: ${nextAction}.`,
      currentHealth?.status === "invalid"
        ? "Repair the canonical workspace record or branch lineage, then retry dispatch."
        : "Inspect the dispatch workspace path, registry record, and git worktree state, then retry dispatch.",
    );
  }

  const recoveryTargetPath =
    role === "reviewer" && existingRecord.worktrees.reviewer
      ? existingRecord.worktrees.reviewer.path
      : existingRecord.worktrees.worker.path;
  const recoveryLabel =
    role === "reviewer"
      ? "recreate reviewer worktree from canonical workspace record"
      : "recreate worker worktree from canonical workspace record";

  try {
    if (failureType === "inaccessible" || failureType === "not-runnable") {
      await fs.chmod(recoveryTargetPath, 0o755).catch(() => undefined);
    }
    await safelyRemoveDispatchWorktree(
      projectDir,
      existingRecord.worktree_root,
      recoveryTargetPath,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DispatchWorkspaceError(
      `Pre-invocation workspace validation failed for ${taskRef} at "${workspacePath}" (failure: ${failureType}). ${probe.detail ?? "Workspace is not runnable."} Recovery attempt: ${recoveryLabel} failed before reprovisioning: ${message}. Next action: inspect the recorded worktree path and git worktree registrations before retrying.`,
      "Inspect the recorded worktree path and git worktree registrations, then repair or remove the broken workspace before retrying.",
    );
  }

  let repairedWorkspace: ProvisionedDispatchWorkspace;
  try {
    repairedWorkspace = await provisionDispatchWorkspace({
      projectDir,
      taskRef,
      role,
      task,
      submissionLinkage,
      taskStatus: taskStatus ?? undefined,
      cleanupState: {
        taskStatus: taskStatus ?? null,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DispatchWorkspaceError(
      `Pre-invocation workspace validation failed for ${taskRef} at "${workspacePath}" (failure: ${failureType}). ${probe.detail ?? "Workspace is not runnable."} Recovery attempt: ${recoveryLabel} failed during reprovisioning: ${message}. Next action: repair the canonical workspace record or branch lineage before retrying.`,
      "Repair the canonical workspace record or branch lineage, then retry dispatch.",
    );
  }

  const repairedProbe = await probeWorkspaceExecutability(repairedWorkspace.cwd);
  if (!repairedProbe.ok) {
    throw new DispatchWorkspaceError(
      `Pre-invocation workspace validation failed for ${taskRef} at "${workspacePath}" (failure: ${failureType}). ${probe.detail ?? "Workspace is not runnable."} Recovery attempt: ${recoveryLabel}. Revalidation failed for "${repairedWorkspace.cwd}" with ${repairedProbe.failureType ?? "unknown"}: ${repairedProbe.detail ?? "Workspace is still not runnable."} Next action: inspect the regenerated workspace and canonical branch state before retrying.`,
      "Inspect the regenerated workspace, canonical branch, and filesystem permissions before retrying dispatch.",
    );
  }

  return {
    workspace: repairedWorkspace,
    repaired: true,
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
 * Attempt workspace discovery and recovery for a resumable dispatch entry
 * (`in_progress`, `pending_review`, or `needs_work`) that has no healthy
 * local workspace candidate.
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
  const resolvedConfig = await resolveDispatchWorkspaceConfig(projectDir);
  // Canonical task identity for any adopted/recreated record so submission
  // linkage adoption keeps stable lineage across display aliases.
  // AC: @dispatch-canonical-task-identity ac-workspace-lineage-stable-across-aliases
  const canonicalTaskId = await resolveProjectCanonicalId(projectDir, taskRef);
  const discoveryShortId = canonicalTaskId ? shortTaskId(canonicalTaskId) : shortTaskId(taskRef);
  const discoveryWorkspaceId = workspaceIdFor(canonicalTaskId ?? taskRef);

  // Phase 1: Registry state — the highest precedence source.
  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1, ac-4
  const existingRecord = await loadWorkspaceRecordForWorktreeRoot(
    projectDir,
    taskRef,
    resolvedConfig.worktreeRoot,
  );
  if (existingRecord) {
    branchSignals.push({
      source: "registry-state",
      branch: existingRecord.canonical_branch,
    });
    // Registry record exists but workspace may be unhealthy.
    // Attempt to reconcile: restore branch from remote if missing.
    // reconcileWorkspaceHealth internally calls tryRestoreBranchFromRemote.
    const now = new Date().toISOString();
    const health = await reconcileWorkspaceHealth(projectDir, existingRecord, now);
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
    const worktreeEntries = await parseWorktreeList(projectDir);
    const entriesUnderRoot = worktreeEntries.filter((entry) =>
      isPathInside(resolvedConfig.worktreeRoot, entry.path),
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
        const postRecoveryHealth = await reconcileWorkspaceHealth(
          projectDir,
          recovered,
          new Date().toISOString(),
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
    let branchAvailable = await refExists(projectDir, branchRef);
    let branchRehydrated = false;
    if (!branchAvailable) {
      branchAvailable = await tryRestoreBranchFromRemote(projectDir, submissionLinkage.branch);
      branchRehydrated = branchAvailable;
    }

    if (branchAvailable && !existingRecord) {
      // Adopt the submission branch as the canonical branch for this task.
      try {
        const now = new Date().toISOString();
        const taskSlug = normalizeTaskSlug(taskRef, task);
        const shortId = discoveryShortId;
        const workspaceId = discoveryWorkspaceId;
        const workerWorktreeDir =
          (await findExistingWorktreeForBranchUnderRoot(
            projectDir,
            submissionLinkage.branch,
            resolvedConfig.worktreeRoot,
          )) ?? path.join(resolvedConfig.worktreeRoot, `${taskSlug}-${shortId}`);
        const baseBranch = resolvedConfig.baseBranch;
        const baseBranchPoint = resolvedConfig.baseBranchStartPoint;
        const publicationMode = await resolvePublicationMode(
          projectDir,
          resolvedConfig.publicationMode,
        );

        const adoptedRecord: DispatchWorkspaceRecord = {
          workspace_id: workspaceId,
          task_id: canonicalTaskId ?? undefined,
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
    const shortId = discoveryShortId;
    const syntheticBranch = `dispatch/task/${taskSlug}/${shortId}`;
    const restoredFromRemote = await tryRestoreBranchFromRemote(projectDir, syntheticBranch);
    if (restoredFromRemote) {
      branchSignals.push({
        source: "remote-or-review-locator",
        branch: syntheticBranch,
      });
      try {
        const now = new Date().toISOString();
        const workspaceId = discoveryWorkspaceId;
        const workerWorktreeDir =
          (await findExistingWorktreeForBranchUnderRoot(
            projectDir,
            syntheticBranch,
            resolvedConfig.worktreeRoot,
          )) ?? path.join(resolvedConfig.worktreeRoot, `${taskSlug}-${shortId}`);
        const baseBranch = resolvedConfig.baseBranch;
        const baseBranchPoint = resolvedConfig.baseBranchStartPoint;
        const publicationMode = await resolvePublicationMode(
          projectDir,
          resolvedConfig.publicationMode,
        );

        const remoteRecord: DispatchWorkspaceRecord = {
          workspace_id: workspaceId,
          task_id: canonicalTaskId ?? undefined,
          task_ref: taskRef,
          task_slug: taskSlug,
          worktree_root: resolvedConfig.worktreeRoot,
          resolved_base_branch: baseBranch,
          base_branch_point: baseBranchPoint,
          canonical_branch: syntheticBranch,
          canonical_branch_head: await resolveCommit(projectDir, syntheticBranch),
          branch_provenance: defaultBranchProvenance(),
          lifecycle_state: "ready",
          active_role: null,
          worktrees: {
            worker: buildWorktreeRecord(
              workerWorktreeDir,
              "branch",
              syntheticBranch,
              await resolveCommit(projectDir, syntheticBranch),
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
