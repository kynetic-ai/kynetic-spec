/**
 * Agent Dispatch Engine
 *
 * Core dispatch runtime for the daemon. Watches for task state changes via
 * file watcher events and direct API event emission from CLI commands. Matches
 * state changes against agent dispatch rules, queues invocations, manages
 * concurrency, and handles deduplication of events from dual sources.
 * Serializes shadow branch mutations when multiple agents run concurrently.
 *
 * AC: @agent-dispatch-engine ac-1 through ac-12
 */

import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { ulid } from "ulid";
import {
  initContext,
  resolveTaskDataManager,
  loadMetaContext,
  areDependenciesMet,
  loadReviewRecords,
  type LoadedTask,
  type LoadedAgent,
} from "../parser/index.js";
import { loadDispatchWorkspaceRegistry } from "../parser/dispatch-workspaces.js";
import { findPlanByRef } from "../parser/plans.js";
import { DEFAULT_IDLE_GRACE_MS, DEFAULT_KSPEC_CLI_PATH, runInvocation } from "./invocation.js";
import { SessionRegistry } from "./session-registry.js";
import type { SessionIdleContext } from "./invocation.js";
import { loadProjectConfig, resolveDispatchRemoteSync } from "../parser/config.js";
import type { InvocationOptions, InvocationResult } from "./invocation.js";
import { SessionEventAccumulator } from "./session-event-accumulator.js";
import type { SessionEventData } from "./session-event-types.js";
import { EventBus, type EventBusOptions } from "./event-bus.js";
import { interpolateTemplate, rewriteSkillReferencesForAdapter } from "./prompts.js";
import { getAdapter } from "../agents/adapters.js";
import {
  preflightRunnerInvocation,
  resolveRunnerInvocation,
  RunnerResolutionError,
  type RunnerInvocation,
} from "../agents/runners.js";
import { resolveEffectiveRunners, type EffectiveRunnerRegistry } from "../agents/runner-config.js";
import { diagnoseRegistryLoad, type RegistryLoadFailure } from "../agents/registry-load-failure.js";
import {
  buildDispatchGitEnv,
  provisionDispatchWorkspace,
  DispatchWorkspaceError,
  getDispatchShadowMutationLockPath,
  markDispatchWorkspaceActive,
  markDispatchWorkspaceIdle,
  reconcileDispatchWorkspaceRegistry,
  getDispatchWorkspaceHealth,
  reconcileDispatchWorkspaceLifecycle,
  type DispatchWorkspaceMetadata,
  type DispatchWorkspaceRole,
  type ProvisionedDispatchWorkspace,
  cleanupReviewerDispatchWorkspace,
  reconcileDispatchWorkspaceArtifacts,
  discoverWorkspaceForReviewOrFixCycle,
  fastForwardDispatchIntegrationBranch,
  integrationTargetNeedsPush,
  pushDispatchBranch,
  pushIntegrationTarget,
  runDispatchIntegrationTargetGit,
  runGitInMutationSurface,
  resolveDispatchIntegrationMutationScope,
  resolveDispatchRemote,
  resolveDispatchWorkspaceConfig,
  purgeDispatchWorkspaceRecord,
  validateDispatchWorkspaceForInvocation,
} from "./workspace.js";
import { ensureWorkspaceBootstrap, DispatchBootstrapError } from "./bootstrap.js";
import type { AgentDispatchRule, AgentDispatchFilter } from "../schema/meta.js";
import { matchesAutomationFilter } from "../schema/task.js";
import type { SessionTrigger } from "../sessions/types.js";
import { getEntityCache } from "../daemon/entity-cache.js";

// ─── Simple Mutex ─────────────────────────────────────────────────────────────

/**
 * A minimal promise-based mutex for serializing async operations.
 * AC: @agent-dispatch-engine ac-12
 */
class Mutex {
  private _queue: Array<() => void> = [];
  private _locked = false;

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this._acquire();
    try {
      return await fn();
    } finally {
      this._release();
    }
  }

  private _acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  private _release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Task state as used for dispatch tracking.
 */
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "pending_review"
  | "needs_work"
  | "blocked"
  | "completed"
  | "cancelled";

/**
 * Mapping from dispatch event names to task statuses.
 * AC: @agent-dispatch-engine ac-1
 */
const _EVENT_TO_STATUS: Record<string, TaskStatus> = {
  "task.in_progress": "in_progress",
  "task.ready": "pending",
  "task.needs_work": "needs_work",
  "task.pending_review": "pending_review",
};

const STATUS_TO_EVENT: Record<TaskStatus, string | undefined> = {
  in_progress: "task.in_progress",
  pending: "task.ready",
  needs_work: "task.needs_work",
  pending_review: "task.pending_review",
  blocked: undefined,
  completed: undefined,
  cancelled: undefined,
};

/**
 * Dispatch precedence for runnable task statuses.
 * Lower number = higher scheduling priority.
 *
 * AC: @dispatch-in-progress-priority ac-1
 */
const STATUS_PRECEDENCE: Record<TaskStatus, number> = {
  in_progress: 0,
  needs_work: 1,
  pending_review: 2,
  pending: 3,
  blocked: 4,
  completed: 5,
  cancelled: 6,
};

const CONTINUITY_STARVATION_THRESHOLD = 2;

// ─── Prompt Helpers ──────────────────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-16 — re-exported from prompts.ts for backwards compat
export { interpolateTemplate };

/**
 * Human-readable trigger description for orientation context.
 */
function triggerDescription(trigger: string): string {
  switch (trigger) {
    case "task.ready":
      return "New task assignment.";
    case "task.in_progress":
      return "Continuing in-progress work.";
    case "task.needs_work":
      return "Fix cycle \u2014 this task was kicked back from review. Address the feedback below.";
    case "task.pending_review":
      return "Task submitted for review.";
    default:
      return `Trigger: ${trigger}`;
  }
}

function focusDescription(trigger: string, role: "worker" | "reviewer"): string {
  if (role === "reviewer") {
    return "Review the submitted changes in this snapshot and decide whether the task should advance or return for fixes.";
  }
  if (trigger === "task.needs_work") {
    return "Resume the canonical worker branch, address review findings, and move the task back toward review.";
  }
  if (trigger === "task.in_progress") {
    return "Resume the existing canonical worker branch and continue the in-flight implementation.";
  }
  return "Work the assigned task in this mutable workspace and move it to the next appropriate state.";
}

function shortSha(commit: string | undefined): string {
  return commit ? commit.slice(0, 12) : "(unavailable)";
}

/**
 * Format recent notes for inclusion in dispatch prompts.
 * Takes last N notes, truncates each to maxLen characters, strips newlines.
 */
function formatRecentNotes(
  notes: Array<{ created_at: string; author?: string; content: string }>,
  count = 3,
  maxLen = 200,
): string {
  if (!notes || notes.length === 0) return "";
  const recent = notes.slice(-count);
  const lines = recent.map((n) => {
    const date = n.created_at.slice(0, 10);
    const author = n.author ? `@${n.author}` : "unknown";
    const content = n.content.replace(/\n/g, " ").slice(0, maxLen);
    return `- [${date}] ${author}: ${content}`;
  });
  return lines.join("\n");
}

class DispatchPromptError extends Error {
  suggestion: string;

  constructor(message: string, suggestion: string) {
    super(message);
    this.name = "DispatchPromptError";
    this.suggestion = suggestion;
  }
}

function resolveDispatchRole(trigger: SessionTrigger): "worker" | "reviewer" {
  return trigger === "task.pending_review" ? "reviewer" : "worker";
}

async function renderEntrypointForAdapter(
  entrypoint: string,
  adapterId: string,
  projectDir: string,
): Promise<string> {
  const trimmed = entrypoint.trim();
  if (!trimmed) {
    return trimmed;
  }

  const portableResolved = await rewriteSkillReferencesForAdapter(trimmed, projectDir, adapterId);
  if (portableResolved !== trimmed) {
    return portableResolved.trim();
  }

  switch (adapterId) {
    case "codex-acp":
      return trimmed
        .replace(/^\/kspec:([a-z0-9][a-z0-9-]*)$/i, "$kspec-$1")
        .replace(/^\/([a-z0-9][a-z0-9-]*)$/i, "$$$1");
    case "claude-agent-acp":
    case "claude-code-acp":
      return trimmed
        .replace(/^\$kspec-([a-z0-9][a-z0-9-]*)$/i, "/kspec:$1")
        .replace(/^\$([a-z0-9][a-z0-9-]*)$/i, "/$1");
    default:
      return trimmed;
  }
}

async function resolveRoleEntrypoint(
  role: "worker" | "reviewer",
  adapterId: string,
  projectDir: string,
  config: Awaited<ReturnType<typeof loadProjectConfig>>["config"],
): Promise<string> {
  const rawEntrypoint =
    role === "reviewer" ? config.agent.skills.pr_review : config.agent.skills.task_work;
  const rendered = await renderEntrypointForAdapter(rawEntrypoint, adapterId, projectDir);
  if (!rendered) {
    throw new DispatchPromptError(
      `No valid ${role} entrypoint is configured for adapter "${adapterId}".`,
      `Set agent.skills.${role === "reviewer" ? "pr_review" : "task_work"} in kspec.config.yaml to a non-empty workflow or skill entrypoint.`,
    );
  }
  return rendered;
}

function buildPublicationInstructions(
  role: "worker" | "reviewer",
  metadata: DispatchWorkspaceMetadata,
): string[] {
  const lines = [
    `Publication mode: \`${metadata.publicationMode}\``,
    `Publish target: \`${metadata.mergeTargetBranch}\``,
    `Canonical branch: \`${metadata.canonicalBranch}\``,
  ];

  if (metadata.publicationMode === "pull_request") {
    if (role === "reviewer") {
      lines.push(
        `Review and merge the PR that targets \`${metadata.mergeTargetBranch}\`; do not retarget it to a different base branch.`,
        "If you push fixes during review, re-run the required verification on the new HEAD before merging.",
      );
    } else {
      lines.push(
        `After submitting the task, create or update a PR from \`${metadata.canonicalBranch}\` into \`${metadata.mergeTargetBranch}\` using the recorded base branch as the PR target.`,
      );
    }
    return lines;
  }

  if (metadata.publicationMode === "manual_merge") {
    if (role === "reviewer") {
      lines.push(
        `You are reviewing from a detached snapshot — you are NOT on the integration branch.`,
        `If review is clean, run the supported merge helper to integrate: \`bash {supporting:scripts/detached-reviewer-merge.sh}\``,
        `Do NOT check out \`${metadata.mergeTargetBranch}\` anywhere or run manual git merge commands inside this snapshot. The helper performs all target-branch checkouts in its own temporary worktree.`,
        `The helper handles no-op detection, dirty-target refusal, conflict abort, and temporary-worktree cleanup automatically; it never creates a persistent worktree on the integration target.`,
        `If the helper reports a conflict, move the task to \`needs_work\` with a note describing the conflict. Do not attempt manual conflict resolution in the detached snapshot.`,
      );
    } else {
      lines.push(
        `Manual merge-back is recorded for this workspace. Submit the task for review; do not open a PR against \`${metadata.mergeTargetBranch}\`.`,
        `If you must prepare the merge path, keep the work on \`${metadata.canonicalBranch}\` and hand review a clean branch lineage back to \`${metadata.mergeTargetBranch}\`.`,
      );
    }
    return lines;
  }

  throw new DispatchPromptError(
    `Workspace publication mode "${metadata.publicationMode}" is invalid.`,
    "Re-provision the dispatch workspace or repair its metadata so publicationMode is pull_request or manual_merge.",
  );
}

async function buildRoleEntryContext(
  projectDir: string,
  adapterId: string,
  trigger: SessionTrigger,
  metadata: DispatchWorkspaceMetadata,
): Promise<string> {
  const role = resolveDispatchRole(trigger);
  const { config } = await loadProjectConfig(projectDir, projectDir);
  const entrypoint = await resolveRoleEntrypoint(role, adapterId, projectDir, config);
  const publication = buildPublicationInstructions(role, metadata);

  return [
    "## Role Entry",
    `Role: ${role}`,
    `Workflow entrypoint: \`${entrypoint}\``,
    `Start by executing the ${role === "reviewer" ? "review" : "work"} flow defined by \`${entrypoint}\`.`,
    ...publication,
  ].join("\n");
}

/**
 * Find the examined commit from the most recent closed review for a task.
 * Returns null when no prior examined commit exists.
 *
 * AC: @review-fix-cycle-diff ac-2 — find prior review's examined commit
 */
export function findPriorExaminedCommit(
  reviews: Array<{
    lifecycle_state: string;
    examined_commit: string | null;
    subject: { type: string; ref?: string };
    related_refs: string[];
    created_at: string | null;
  }>,
  taskRef: string,
): string | null {
  const cleanRef = taskRef.startsWith("@") ? taskRef.slice(1) : taskRef;
  const taskReviews = reviews.filter(
    (r) =>
      r.related_refs.includes(cleanRef) ||
      (r.subject.type === "task" && "ref" in r.subject && r.subject.ref === cleanRef),
  );

  const closedWithCommit = taskReviews
    .filter((r) => r.lifecycle_state === "closed" && r.examined_commit)
    .toSorted((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

  if (closedWithCommit.length === 0) return null;
  return closedWithCommit[0].examined_commit;
}

/**
 * Compute a git diff --stat between two commits. Returns null on any error.
 *
 * AC: @review-fix-cycle-diff ac-3 — graceful omission on unreachable commits
 */
export async function computeDiffStat(
  fromCommit: string,
  toCommit: string,
  cwd: string,
): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["diff", "--stat", fromCommit, toCommit], {
      cwd,
      env: buildDispatchGitEnv(),
      encoding: "utf-8",
      timeout: 10_000,
    });

    const stat = result.stdout?.trim();
    if (!stat) return null;

    return [
      `Changes since prior review (${shortSha(fromCommit)}..${shortSha(toCommit)}):`,
      stat,
    ].join("\n");
  } catch {
    return null;
  }
}

/**
 * Compute a diff summary between the prior review's examined commit and the
 * current canonical branch head. Returns null when no prior examined commit
 * exists or when the diff cannot be computed (unreachable commits, etc.).
 *
 * AC: @review-fix-cycle-diff ac-2 — diff summary for reviewer orientation
 * AC: @review-fix-cycle-diff ac-3 — graceful omission on unreachable commits
 */
export async function getFixCycleDiffSummary(
  projectDir: string,
  taskRef: string,
  canonicalBranchHead: string | undefined,
  workspaceCwd?: string,
): Promise<string | null> {
  if (!canonicalBranchHead) return null;

  try {
    const ctx = await initContext(projectDir);
    const reviews = await loadReviewRecords(ctx);

    const priorCommit = findPriorExaminedCommit(reviews, taskRef);
    if (!priorCommit) return null;

    return computeDiffStat(priorCommit, canonicalBranchHead, workspaceCwd ?? projectDir);
  } catch {
    // AC: @review-fix-cycle-diff ac-3 — graceful omission on any error
    return null;
  }
}

/**
 * Build orientation context block for a dispatch prompt.
 * Provides the agent with task title, trigger meaning, and relevant context.
 *
 * AC: @agent-dispatch-engine ac-13, ac-14, ac-15
 */
export function buildOrientationContext(
  taskRef: string,
  trigger: string,
  workspaceOrTask:
    | ProvisionedDispatchWorkspace
    | {
        title: string;
        notes?: Array<{ created_at: string; author?: string; content: string }>;
        review_url?: string;
      },
  taskOrMetadata?:
    | {
        title: string;
        notes?: Array<{ created_at: string; author?: string; content: string }>;
        review_url?: string;
      }
    | DispatchWorkspaceMetadata,
  metadataOrRole?: DispatchWorkspaceMetadata | DispatchWorkspaceRole,
  explicitRole?: DispatchWorkspaceRole,
  options?: {
    fixCycleDiffSummary?: string | null;
    /**
     * Resolved task resource references — pre-computed by the caller so the
     * orientation block surfaces drift status to the agent. Pass `undefined`
     * (or omit) when the task has no resource_refs.
     *
     * AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
     */
    resolvedResources?: Array<{
      owner_type: "plan" | "task";
      owner_ref: string;
      id: string;
      path: string;
      status: "present" | "drift" | "missing" | "unresolved";
      message: string;
    }>;
  },
): string {
  const usingProvisionedWorkspace =
    typeof workspaceOrTask === "object" &&
    workspaceOrTask !== null &&
    "cwd" in workspaceOrTask &&
    "metadata" in workspaceOrTask;
  const role: DispatchWorkspaceRole =
    explicitRole ??
    (usingProvisionedWorkspace
      ? trigger === "task.pending_review"
        ? "reviewer"
        : "worker"
      : ((metadataOrRole as DispatchWorkspaceRole | undefined) ??
        (trigger === "task.pending_review" ? "reviewer" : "worker")));
  const workspace = usingProvisionedWorkspace ? workspaceOrTask : null;
  const task = usingProvisionedWorkspace
    ? (taskOrMetadata as
        | {
            title: string;
            notes?: Array<{ created_at: string; author?: string; content: string }>;
            review_url?: string;
          }
        | undefined)
    : (workspaceOrTask as
        | {
            title: string;
            notes?: Array<{ created_at: string; author?: string; content: string }>;
            review_url?: string;
          }
        | undefined);
  const metadata =
    (usingProvisionedWorkspace
      ? workspaceOrTask.metadata
      : (taskOrMetadata as DispatchWorkspaceMetadata | undefined)) ?? null;
  const title = task?.title ?? "(unavailable)";
  const bootstrapRoleState = metadata?.bootstrap?.roleStates?.[role];
  const workspacePath =
    workspace?.cwd ??
    (role === "reviewer" ? metadata?.reviewerWorktreeDir : metadata?.workerWorktreeDir) ??
    "(unavailable)";
  const workspaceMode = role === "reviewer" ? "detached review snapshot" : "mutable worker branch";
  const bootstrapSummary = !bootstrapRoleState
    ? "not available"
    : bootstrapRoleState.status === "succeeded"
      ? role === "reviewer" && bootstrapRoleState.steps.length === 0
        ? "reused worker bootstrap"
        : "prepared"
      : bootstrapRoleState.status === "failed"
        ? `failed${bootstrapRoleState.failureMessage ? ` (${bootstrapRoleState.failureMessage})` : ""}`
        : "not run";
  const dependencyStatus =
    bootstrapRoleState && bootstrapRoleState.invalidationReasons.length > 0
      ? bootstrapRoleState.invalidationReasons.join("; ")
      : "satisfied";
  const healthSummary =
    metadata?.healthStatus === "healthy"
      ? "ready"
      : metadata?.healthReason
        ? `${metadata.healthStatus} (${metadata.healthReason})`
        : (metadata?.healthStatus ?? "unknown");
  const canonicalHeadContext =
    role === "reviewer"
      ? `${shortSha(metadata?.canonicalBranchHead)} (snapshot under review)`
      : `${shortSha(metadata?.canonicalBranchHead)} (canonical branch head to resume)`;
  const lines = [
    "## Task Context",
    `Task: ${taskRef} \u2014 "${title}"`,
    `Selection reason: ${triggerDescription(trigger)}`,
    `Role: ${role}`,
    `Focus: ${focusDescription(trigger, role)}`,
    `Workspace (your working directory): ${workspacePath}`,
    `Workspace mode: ${workspaceMode}`,
    `Canonical branch: ${metadata?.canonicalBranch ?? "(unavailable)"}`,
    `Integration target: ${metadata?.integrationTargetBranch ?? metadata?.mergeTargetBranch ?? "(unavailable)"}`,
    `Canonical head: ${canonicalHeadContext}`,
    `Bootstrap state: ${bootstrapSummary}`,
    `Workspace health: ${healthSummary}`,
    `Dependency status: ${dependencyStatus}`,
  ];

  if (role === "reviewer") {
    lines.push(
      `Prepared state: Detached reviewer snapshot at ${shortSha(metadata?.canonicalBranchHead)}. The mutable worker branch remains ${metadata?.canonicalBranch ?? "(unavailable)"}.`,
    );
  } else {
    lines.push(
      `Prepared state: Mutable worker worktree attached to ${metadata?.canonicalBranch ?? "(unavailable)"} under ${metadata?.worktreeRoot ?? "(unavailable)"}.`,
    );
  }

  // AC: @agent-dispatch-engine ac-14 - Include recent notes for fix cycles
  if (trigger === "task.needs_work" && task?.notes && task.notes.length > 0) {
    const noteText = formatRecentNotes(task.notes);
    if (noteText) {
      lines.push("", "Recent notes:", noteText);
    }
  }

  // AC: @agent-dispatch-engine ac-15 - Include review URL for reviewer
  if (trigger === "task.pending_review") {
    const url = task?.review_url ?? "Not provided \u2014 find PR via task notes or git log.";
    lines.push(`Review URL: ${url}`);
    lines.push(
      `Cycle context: Review cycle on a detached snapshot. If changes are kicked back, the follow-up worker resumes ${metadata?.canonicalBranch ?? "(unavailable)"} and still publishes against ${metadata?.integrationTargetBranch ?? metadata?.mergeTargetBranch ?? "(unavailable)"}.`,
    );

    // AC: @review-fix-cycle-diff ac-2 — Include fix-cycle diff summary for reviewer
    if (options?.fixCycleDiffSummary) {
      lines.push("", "## Fix-Cycle Diff", options.fixCycleDiffSummary);
    }
  }

  if (trigger === "task.needs_work") {
    lines.push(
      `Cycle context: Fix cycle after review. You are resuming ${metadata?.canonicalBranch ?? "(unavailable)"}; publication still targets ${metadata?.integrationTargetBranch ?? metadata?.mergeTargetBranch ?? "(unavailable)"}.`,
    );
  }

  // Plan/task resource references with drift status. Surfaced so workers
  // see immediately when a referenced resource has changed since derivation.
  // AC: @plan-resource-derivation-semantics-1 ac-derived-task-keeps-plan-resource-reference
  // AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
  if (options?.resolvedResources && options.resolvedResources.length > 0) {
    lines.push("", "Resources:");
    for (const entry of options.resolvedResources) {
      const tag =
        entry.status === "drift"
          ? "[DRIFT]"
          : entry.status === "missing"
            ? "[MISSING]"
            : entry.status === "unresolved"
              ? "[UNRESOLVED]"
              : "[OK]";
      lines.push(`- ${tag} ${entry.id} (${entry.owner_type} ${entry.owner_ref}, ${entry.path})`);
      if (entry.status !== "present") {
        lines.push(`    ${entry.message}`);
      }
    }
  }

  const publicationGuidance =
    metadata?.publicationMode === "pull_request"
      ? `- Publish via PR: create or update a pull request from ${metadata.canonicalBranch} into ${metadata.integrationTargetBranch}.`
      : `- Publish via manual merge: merge ${metadata?.canonicalBranch ?? "(unavailable)"} back into ${metadata?.integrationTargetBranch ?? metadata?.mergeTargetBranch ?? "(unavailable)"}; if conflicts occur, stop and escalate with the conflict details instead of improvising.`;
  lines.push(
    "",
    "Dispatch Branch Context:",
    `- Canonical branch: ${metadata?.canonicalBranch ?? "(unavailable)"}`,
    `- Integration target: ${metadata?.integrationTargetBranch ?? metadata?.mergeTargetBranch ?? "(unavailable)"} @ ${metadata?.integrationTargetCommit ?? metadata?.baseBranchPoint ?? "(unavailable)"}`,
    `- Publication mode: ${metadata?.publicationMode ?? "manual_merge"}`,
    role === "reviewer"
      ? `- Snapshot under review: ${metadata?.canonicalBranchHead ?? "(unavailable)"}`
      : `- Canonical head: ${metadata?.canonicalBranchHead ?? "(unavailable)"}`,
    publicationGuidance,
  );

  return lines.join("\n");
}

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A state change event for a single task.
 */
export interface TaskStateChange {
  taskId: string;
  taskRef: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  timestamp: number;
  /** Optional task data used for filter evaluation (AC-6) */
  task?: LoadedTask;
}

function resolveCleanupStateForTaskChange(change: TaskStateChange): {
  integrationState?: "merged" | "abandoned" | "reset";
  taskStatus: TaskStatus;
} | null {
  if (change.toStatus === "completed") {
    return { integrationState: "merged", taskStatus: "completed" };
  }
  if (change.toStatus === "cancelled") {
    return { integrationState: "abandoned", taskStatus: "cancelled" };
  }
  if (change.fromStatus === "completed" || change.fromStatus === "cancelled") {
    return { integrationState: "reset", taskStatus: change.toStatus };
  }
  return null;
}

/**
 * An entry in the dispatch queue.
 */
interface QueueEntry {
  agent: LoadedAgent;
  change: TaskStateChange;
  retryCount: number;
  nextRetryAt: number;
  /** When this entry was first enqueued (for wait-time display) */
  enqueuedAtMs: number;
  /** Monotonic sequence for deterministic tie-breaking */
  sequence: number;
  /** Count of times affinity skipped this entry despite equal band+priority. */
  starvationDeferrals: number;
}

interface SchedulerCandidate {
  agent: LoadedAgent;
  queue: QueueEntry[];
  queueIndex: number;
  entry: QueueEntry;
}

interface KspecCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Tracking record for an active invocation.
 * AC: @cli-agent-commands ac-6
 * AC: @runner-operator-surfaces ac-daemon-dispatch-active-api-includes-runner
 */
interface ActiveInvocationRecord {
  invocationId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  taskRef: string | undefined;
  role: "worker" | "reviewer";
  startedAtMs: number;
  /** Resolved adapter identity captured at dispatch preflight. */
  resolvedAdapter: string;
  /** Named runner that resolved this invocation, when one was configured. */
  runner: string | undefined;
}

/**
 * Deduplication key for recent state changes.
 * AC: @agent-dispatch-engine ac-7
 */
type DedupKey = `${string}:${string}:${string}`;

/**
 * Result of a target branch sync operation.
 * AC: @dispatch-remote-branch-sync ac-pull-target-on-start through ac-no-remote
 */
export type TargetSyncResult =
  | "synced"
  | "up_to_date"
  | "skipped"
  | "transient_failure"
  | "diverged"
  | "unsafe_target";

/**
 * Classification of why an integration target is degraded.
 * - `occupied-checkout`: Another worktree has the target branch checked out, blocking
 *   the dispatch root from safely mutating the target. Recovers automatically once
 *   the blocking worktree is removed and a subsequent sync or push succeeds (or no-ops).
 * - `divergence`: Local and remote histories diverged; requires operator intervention.
 *   Only a successful fast-forward sync proves recovery.
 * - `other`: Other unsafe mutation states (missing ref, dirty checkout, ambiguous
 *   surface). Recovery requires the next sync to fully succeed.
 *
 * AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
 */
export type DegradedTargetKind = "occupied-checkout" | "divergence" | "other";

export interface DegradedTargetState {
  branch: string;
  reason: string;
  enteredAt: Date;
  kind: DegradedTargetKind;
}

/**
 * Degraded state descriptor for the dispatch engine.
 * AC: @dispatch-remote-branch-sync ac-degraded-status-api
 */
export type DegradedState = DegradedTargetState[];

interface DegradedSnapshot {
  active: boolean;
  reason: string;
  enteredAt: Date | null;
}

/**
 * Sync state event emitted when the engine enters or exits degraded state.
 * AC: @dispatch-remote-branch-sync ac-degraded-status-broadcast
 */
export interface SyncStateEvent {
  type: "sync_state";
  branch: string;
  degraded: boolean;
  reason: string;
  enteredAt: string | null;
  recoveredAfterMs?: number;
}

/**
 * Invocation lifecycle event payload.
 * AC: @daemon-agent-dispatch ac-3, ac-4
 * AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
 */
export interface InvocationEvent {
  type: "started" | "completed" | "failed";
  session_id: string;
  agent_id: string;
  task_id: string | undefined;
  task_title: string | null;
  status: "started" | "completed" | "failed";
  timestamp: number;
  /** Resolved adapter identity for this invocation. */
  resolved_adapter?: string;
  /** Named runner that resolved this invocation, when one was configured. */
  runner?: string;
}

/**
 * Options for creating a DispatchEngine.
 */
export interface DispatchEngineOptions {
  /** Project root directory */
  projectDir: string;
  /**
   * Spec directory (.kspec/ for shadow mode, or same as projectDir for traditional mode).
   * Defaults to projectDir/.kspec if not specified.
   */
  specDir?: string;
  /** Working directory for spawned agents */
  cwd?: string;
  /** Deduplication window in milliseconds (default 2000) */
  dedupWindowMs?: number;
  /**
   * Periodic reconciliation interval in milliseconds (default 60000).
   * Re-evaluates all task states against dispatch rules, enqueuing any that
   * match but have no active or queued invocation. Set to 0 or null to disable.
   * AC: @agent-dispatch-engine ac-20
   */
  reconcileIntervalMs?: number | null;
  /**
   * Per-task coalescing window in milliseconds (default 5000).
   * When a state change event triggers a drain, the drain is deferred by this
   * window. If another event arrives for the same task within the window, the
   * timer resets. Set to 0 to disable coalescing (immediate drain behavior).
   * AC: @per-task-dispatch-drain-coalescing ac-4
   */
  coalesceWindowMs?: number;
  /** Path to kspec CLI binary (for task notes) */
  kspecCliPath?: string;
  /**
   * Optional callback invoked on invocation lifecycle events (start, complete, fail).
   * AC: @daemon-agent-dispatch ac-3, ac-4
   */
  onInvocationEvent?: (event: InvocationEvent) => void;
  /**
   * Optional callback invoked for typed session lifecycle events.
   * Replaces the old onTextChunk callback with structured event emission.
   * AC: @session-event-broadcast ac-replaces-text-chunks
   * AC: @cli-agent-commands ac-13 (broadcast to watch subscribers)
   * AC: @daemon-agent-dispatch ac-8
   */
  onSessionEvent?: (event: SessionEventData) => void;
  /**
   * Optional callback invoked when the engine enters or exits degraded state.
   * AC: @dispatch-remote-branch-sync ac-degraded-status-broadcast
   */
  onSyncStateEvent?: (event: SyncStateEvent) => void;
  /**
   * Configuration for the event bus (chain depth, ring buffer, dedup).
   * AC: @dispatch-event-envelope ac-5, ac-6
   */
  eventBusOptions?: EventBusOptions;
}

// ─── DispatchEngine ───────────────────────────────────────────────────────────

/**
 * The core dispatch runtime.
 *
 * Lifecycle:
 *   1. Create with new DispatchEngine(options)
 *   2. Call start() to bootstrap and begin processing
 *   3. Feed state changes via handleStateChange()
 *   4. Call stop() for graceful shutdown
 *
 * AC: @agent-dispatch-engine ac-1 through ac-12
 */
export class DispatchEngine {
  private projectDir: string;
  private specDir: string;
  private cwd: string;
  private dedupWindowMs: number;
  private reconcileIntervalMs: number;
  /** AC: @per-task-dispatch-drain-coalescing ac-4 */
  private coalesceWindowMs: number;
  private kspecCliPath?: string;
  /**
   * Active session registry for multi-turn prompt delivery.
   * Shared with the action executor so hooks can deliver prompts to live sessions.
   * AC: @active-session-registry ac-1, @multi-turn-session-lifecycle ac-2, ac-4
   */
  private _sessionRegistry = new SessionRegistry();
  /**
   * Whether any hook targets session.idle. Updated on each meta context load.
   * When false, invocations use idleGracePeriodMs=0 for backward-compat (ac-11).
   * AC: @multi-turn-session-lifecycle ac-11
   */
  private _hasSessionIdleHooks = false;
  private onInvocationEvent?: (event: InvocationEvent) => void;
  private onSessionEvent?: (event: SessionEventData) => void;
  private onSyncStateEvent?: (event: SyncStateEvent) => void;
  /** Per-session text accumulator for newline-boundary streaming. */
  private accumulator = new SessionEventAccumulator();

  /** Queue of pending dispatch entries, per agent id */
  private queues: Map<string, QueueEntry[]> = new Map();
  /** Count of active (running) invocations per agent id */
  private activeCount: Map<string, number> = new Map();
  /** Recent dedup keys with their expiry timestamps */
  private recentEvents: Map<DedupKey, number> = new Map();
  /** Previous task states (for file watcher diffing) */
  private prevTaskStates: Map<string, TaskStatus> = new Map();
  /** Mutex serializing shadow branch mutations */
  private shadowMutex = new Mutex();
  /** Whether the engine is currently running */
  private running = false;
  /** Set of running invocation promises (for graceful shutdown) */
  private runningInvocations: Set<Promise<void>> = new Set();
  /** AbortControllers for active invocations (for graceful cancel on stop) */
  private invocationAbortControllers: Set<AbortController> = new Set();
  /** Per-invocation tracking records for status display */
  private activeInvocationDetails: Map<string, ActiveInvocationRecord> = new Map();
  /** Task refs currently between queue removal and active tracking registration */
  private inFlightTaskKeys = new Set<string>();
  /** Monotonic enqueue sequence for deterministic queue ordering */
  private nextQueueSequence = 0;
  /** Last task selected/completed, used as continuity affinity signal. */
  private recentTaskAffinityRef: string | null = null;
  /** Timer handle for periodic reconciliation. AC: @agent-dispatch-engine ac-20 */
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  /** All in-flight reconciliation promises so stop() can await every one. */
  private inFlightReconciles = new Set<Promise<void>>();
  /** Per-task coalescing timers. AC: @per-task-dispatch-drain-coalescing ac-1 */
  private coalesceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Whether a drain is currently in progress. AC: @per-task-dispatch-drain-coalescing ac-8 */
  private drainInProgress = false;
  /** Whether another drain was requested while one is already running. AC: @per-task-dispatch-drain-coalescing ac-8 */
  private drainPending = false;
  /** Central event bus for structured event emission and subscription. AC: @dispatch-event-envelope ac-1 through ac-6 */
  private _eventBus: EventBus;
  /**
   * Integration target branches currently being pushed to remote.
   * AC: @dispatch-remote-branch-sync ac-target-push-serialization
   * AC: @dispatch-remote-branch-sync ac-target-push-cross-branch-concurrency
   */
  private _targetPushesInProgress = new Set<string>();
  /** Resolved effective remote_sync value (set once at start time). */
  private remoteSyncEnabled = false;
  /** Resolved remote name for push operations (null = no remote). */
  private dispatchRemote: string | null = null;
  /** Project-configured base branch. Always included in the active target set. */
  private _configuredBaseBranch: string | null = null;
  /** Shared source of truth for active integration targets across push and pull paths. */
  private _activeTargets = new Set<string>();

  // ─── Target Branch Sync State ───────────────────────────────────────────────
  // AC: @dispatch-remote-branch-sync ac-pull-target-on-start through ac-no-remote

  /** Target branches currently being synced from remote. */
  private _targetSyncRunning = new Set<string>();
  /** Timestamp of last successful sync per target branch (ms since epoch). */
  private _targetSyncTimestamps = new Map<string, number>();
  /** Counter of consecutive transient sync failures per target branch. Reset on success. */
  private _consecutiveSyncFailures = new Map<string, number>();
  /** Resolved remote sync config (cached at start). */
  private _remoteSyncEnabled: boolean | null = null;
  /** Resolved remote name for sync operations (cached at start). */
  private _syncRemote: string | null = null;
  /** Configured sync interval in milliseconds. */
  private _syncIntervalMs = 0;
  /** Timestamp of first consecutive transient failure per target branch (ms since epoch). */
  private _firstSyncFailureTimestamps = new Map<string, number>();

  // ─── Degraded State ──────────────────────────────────────────────────────
  // AC: @dispatch-remote-branch-sync ac-divergence-enters-degraded through ac-degraded-auto-recover

  /** Branch-scoped degraded targets. */
  private _degradedTargets = new Map<
    string,
    { reason: string; enteredAt: Date; kind: DegradedTargetKind }
  >();

  constructor(options: DispatchEngineOptions) {
    this.projectDir = options.projectDir;
    this.specDir = options.specDir ?? path.join(options.projectDir, ".kspec");
    this.cwd = options.cwd ?? options.projectDir;
    this.dedupWindowMs = options.dedupWindowMs ?? 2000;
    this.reconcileIntervalMs =
      options.reconcileIntervalMs === null || options.reconcileIntervalMs === 0
        ? 0
        : (options.reconcileIntervalMs ?? 60_000);
    // AC: @per-task-dispatch-drain-coalescing ac-4
    this.coalesceWindowMs = options.coalesceWindowMs ?? 5000;
    this.kspecCliPath = options.kspecCliPath;
    this.onInvocationEvent = options.onInvocationEvent;
    this.onSessionEvent = options.onSessionEvent;
    this.onSyncStateEvent = options.onSyncStateEvent;
    // AC: @dispatch-event-envelope ac-1 through ac-6
    this._eventBus = new EventBus({
      dedupWindowMs: this.dedupWindowMs,
      ...options.eventBusOptions,
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Access the event bus for subscribing to events or querying recent events.
   * AC: @dispatch-event-envelope ac-6
   */
  get eventBus(): EventBus {
    return this._eventBus;
  }

  /**
   * Active session registry for multi-turn prompt delivery.
   * Exposes the registry so the action executor (and other components)
   * can deliver prompts to live sessions.
   *
   * AC: @active-session-registry ac-3
   */
  get sessionRegistry(): SessionRegistry {
    return this._sessionRegistry;
  }

  /**
   * Start the dispatch engine.
   *
   * Loads current task states and evaluates dispatch rules for bootstrap.
   * AC: @agent-dispatch-engine ac-8
   */
  async start(): Promise<void> {
    this.running = true;

    // AC: @dispatch-remote-branch-sync ac-pull-target-on-start — resolve sync config and sync before bootstrap
    await this._initTargetSync();

    try {
      const ctx = await initContext(this.projectDir);
      const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
      const taskStatusByRef = new Map(
        tasks.map((task) => [`@${task._ulid}`, task.status as TaskStatus]),
      );
      await this.shadowMutex.runExclusive(async () => {
        await reconcileDispatchWorkspaceRegistry(this.projectDir, taskStatusByRef);
      });
    } catch (err) {
      console.error("[dispatch] Workspace registry reconciliation error:", err);
    }
    await reconcileDispatchWorkspaceArtifacts(this.projectDir, {
      activeTaskRefs: this._activeTaskRefs(),
    });

    // AC: @dispatch-remote-branch-sync ac-no-remote — resolve remote sync at start time
    try {
      const resolvedConfig = await resolveDispatchWorkspaceConfig(this.projectDir);
      const { config } = await loadProjectConfig(this.projectDir);
      this.dispatchRemote = await resolveDispatchRemote(this.projectDir);
      this.remoteSyncEnabled = resolveDispatchRemoteSync(config, this.dispatchRemote !== null);
      this._configuredBaseBranch ??= resolvedConfig.baseBranch;
    } catch (err) {
      console.warn("[dispatch] Failed to resolve remote sync config, defaulting to disabled:", err);
      this.remoteSyncEnabled = false;
      this.dispatchRemote = null;
    }

    // AC: @agent-dispatch-engine ac-8 - Bootstrap: evaluate existing task states
    await this._bootstrap();

    // AC: @agent-dispatch-engine ac-19, ac-20 - Start periodic reconciliation
    if (this.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => {
        if (!this.running || this.inFlightReconciles.size > 0) {
          return;
        }
        const p = this._reconcile()
          .catch((err) => {
            console.error("[dispatch] Reconciliation error:", err);
          })
          .finally(() => {
            this.inFlightReconciles.delete(p);
          });
        this.inFlightReconciles.add(p);
      }, this.reconcileIntervalMs);
      this.reconcileTimer.unref();
    }
  }

  /**
   * Handle a task state change event from any source (file watcher or API).
   *
   * AC: @agent-dispatch-engine ac-1, ac-2, ac-4, ac-5, ac-6, ac-7
   */
  async handleStateChange(change: TaskStateChange): Promise<void> {
    if (!this.running) return;

    // AC: @agent-dispatch-engine ac-7 - Deduplication
    if (this._isDuplicate(change)) {
      return;
    }
    this._recordEvent(change);

    const cleanupState = resolveCleanupStateForTaskChange(change);
    if (cleanupState) {
      const cleanupTargetBranch = await this._loadWorkspaceTargetForTask(change.taskRef);
      try {
        await this.shadowMutex.runExclusive(async () => {
          await reconcileDispatchWorkspaceLifecycle({
            projectDir: this.projectDir,
            taskRef: change.taskRef,
            task: change.task
              ? {
                  title: change.task.title,
                  slugs: change.task.slugs,
                }
              : undefined,
            cleanupState,
          });
        });
        if (cleanupTargetBranch) {
          await this._removeActiveTargetIfOrphaned(cleanupTargetBranch);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[dispatch] Failed to reconcile workspace lifecycle for ${change.taskRef}: ${message}`,
        );
      }
    }

    // AC: @dispatch-event-envelope ac-1, ac-2 - Emit through event bus
    const eventType = STATUS_TO_EVENT[change.toStatus];
    if (!eventType) return;

    // AC: @dispatch-event-envelope ac-2 - Propagate correlation chain via env var
    const envCorrelationId = process.env.KSPEC_CORRELATION_ID ?? null;
    const busResult = this._eventBus.emit({
      event_type: eventType,
      source_type: change.task ? "task_watcher" : "api",
      source_id: change.taskRef,
      payload: {
        taskId: change.taskId,
        taskRef: change.taskRef,
        fromStatus: change.fromStatus,
        toStatus: change.toStatus,
      },
      correlation_id: envCorrelationId,
      causation_id: envCorrelationId,
      // Engine already performed dedup; skip bus-level dedup to avoid double-filtering
      skipDedup: true,
    });
    if (!busResult.accepted) {
      // Event rejected by bus (chain depth limit or bus-level dedup)
      return;
    }

    // AC: @agent-dispatch-engine ac-1 - Match against dispatch rules
    const agents = await this._loadAgents();

    // Load all tasks for filter evaluation (needed for dependency checks)
    let allTasks: LoadedTask[] | undefined;
    let taskData = change.task;
    if (!taskData && change.taskId) {
      try {
        const ctx = await initContext(this.projectDir);
        allTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
        taskData = allTasks.find((t) => t._ulid === change.taskId);
      } catch {
        // Can't load tasks, filter evaluation will be lenient
      }
    }
    // Load allTasks for dependency checking even when task data was provided
    if (!allTasks && taskData) {
      try {
        const ctx = await initContext(this.projectDir);
        allTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
      } catch {
        // Can't load tasks, dependency check will be skipped
      }
    }
    // Make loaded task available for prompt building (AC: @agent-dispatch-engine ac-13)
    if (taskData && !change.task) {
      change.task = taskData;
    }

    for (const agent of agents) {
      for (const rule of agent.dispatch ?? []) {
        if (rule.on !== eventType) continue;

        // AC: @agent-dispatch-engine ac-6 - Apply filters
        if (!this._matchesFilter(change, rule, taskData, allTasks)) continue;

        // AC: @agent-dispatch-engine ac-2 - Each matching agent queued independently
        this._enqueue(agent, change);
      }
    }

    // AC: @per-task-dispatch-drain-coalescing ac-1, ac-4, ac-6
    // Schedule a per-task coalescing timer instead of draining immediately.
    // If coalesceWindowMs is 0, drain immediately for backward compatibility.
    // AC: @agent-dispatch-engine ac-27 — all drains go through _serializedDrain()
    if (this.coalesceWindowMs <= 0) {
      await this._serializedDrain();
    } else {
      this._scheduleCoalescedDrain(change.taskId);
    }
  }

  /**
   * Handle file watcher notification: diff previous vs current task states.
   *
   * AC: @agent-dispatch-engine ac-5
   */
  async handleFileChange(_specDir: string): Promise<void> {
    if (!this.running) return;

    try {
      const ctx = await initContext(this.projectDir);
      const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);

      const changes: TaskStateChange[] = [];
      const now = Date.now();

      for (const task of tasks) {
        const taskId = task._ulid;
        const currentStatus = task.status as TaskStatus;
        const prevStatus = this.prevTaskStates.get(taskId);

        if (prevStatus !== undefined && prevStatus !== currentStatus) {
          changes.push({
            taskId,
            taskRef: `@${taskId}`,
            fromStatus: prevStatus,
            toStatus: currentStatus,
            timestamp: now,
            task,
          });
        }

        this.prevTaskStates.set(taskId, currentStatus);
      }

      // Emit change events for detected transitions
      for (const change of changes) {
        await this.handleStateChange(change);
      }
    } catch (err) {
      console.error("[dispatch] Error processing file change:", err);
    }
  }

  /**
   * Stop the dispatch engine gracefully.
   *
   * Sends cancel signals to all active invocations and waits for them to finish.
   * AC: @agent-dispatch-engine ac-11
   */
  async stop(): Promise<void> {
    this.running = false;

    // AC: @per-task-dispatch-drain-coalescing ac-5 - Cancel all pending coalescing timers
    for (const timer of this.coalesceTimers.values()) {
      clearTimeout(timer);
    }
    this.coalesceTimers.clear();

    // AC: @agent-dispatch-engine ac-20 - Stop periodic reconciliation
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    // Wait for ALL in-flight reconciliations to finish so none
    // write files after stop() returns (prevents ENOTEMPTY in test teardown).
    if (this.inFlightReconciles.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightReconciles));
      this.inFlightReconciles.clear();
    }

    // Clear queues BEFORE awaiting invocations so completion handlers
    // that call _drainQueues find nothing to spawn. This prevents
    // second-generation invocations from being added to runningInvocations
    // after our snapshot, eliminating the need for a while loop (which
    // risks hanging indefinitely if an invocation never resolves).
    this.queues.clear();

    // AC: @agent-dispatch-engine ac-11 - Send graceful cancel to all active invocations.
    // Abort controllers BEFORE closing sessions so that invocations waiting
    // in idle observe the abort signal (InvocationAbortedError) rather than
    // the prompt-queue close (which resolves null and falls through the
    // normal success path, misreporting interrupted sessions as completed).
    for (const controller of this.invocationAbortControllers) {
      controller.abort();
    }

    // AC: @active-session-registry ac-4 — close all active sessions after abort
    this._sessionRegistry.closeAll("dispatch engine stopping");

    // Wait for all running invocations to complete (or abort).
    // Safe as a single pass: queues are already cleared above, and
    // _spawnInvocation guards with !this.running, so no new promises
    // can be added to runningInvocations during this await.
    if (this.runningInvocations.size > 0) {
      await Promise.allSettled(Array.from(this.runningInvocations));
    }

    this.activeCount.clear();
    this.recentEvents.clear();
    this.invocationAbortControllers.clear();
    this.activeInvocationDetails.clear();
  }

  /**
   * Get the shadow mutex for external callers that need to serialize mutations.
   * AC: @agent-dispatch-engine ac-12
   */
  getShadowMutex(): Mutex {
    return this.shadowMutex;
  }

  getCwd(): string {
    return this.cwd;
  }

  /**
   * Returns current engine status info including per-invocation details.
   * AC: @cli-agent-commands ac-6
   * AC: @runner-operator-surfaces ac-daemon-dispatch-active-api-includes-runner
   * AC: @runner-operator-surfaces ac-daemon-dispatch-queued-api-includes-runner
   */
  getStatus(): {
    running: boolean;
    activeInvocations: number;
    queuedInvocations: number;
    invocations: Array<{
      invocationId: string;
      sessionId: string;
      agentId: string;
      agentName: string;
      taskRef: string | undefined;
      elapsedMs: number;
      /** Resolved adapter identity for this invocation. */
      resolvedAdapter: string;
      /** Named runner that resolved this invocation, when one was configured. */
      runner: string | undefined;
    }>;
    queued: Array<{
      agentId: string;
      agentName: string;
      taskRef: string | undefined;
      waitMs: number;
      /** Runner reference declared on the agent definition, when present. */
      runner: string | undefined;
      /** Adapter override declared on the agent definition, when present. */
      adapter: string | undefined;
    }>;
  } {
    let active = 0;
    let queued = 0;
    for (const count of this.activeCount.values()) active += count;
    for (const entries of this.queues.values()) queued += entries.length;
    const now = Date.now();
    const invocations = Array.from(this.activeInvocationDetails.values()).map((r) => ({
      invocationId: r.invocationId,
      sessionId: r.sessionId,
      agentId: r.agentId,
      agentName: r.agentName,
      taskRef: r.taskRef,
      elapsedMs: now - r.startedAtMs,
      resolvedAdapter: r.resolvedAdapter,
      runner: r.runner,
    }));
    const queuedItems = Array.from(this.queues.values()).flatMap((entries) =>
      entries.map((e) => ({
        agentId: e.agent.id,
        agentName: e.agent.name,
        taskRef: e.change.taskRef,
        waitMs: now - e.enqueuedAtMs,
        // Queued entries report the runner/adapter declared on the agent
        // definition. The dispatch preflight has not run yet, so the daemon
        // route is responsible for projecting these to a `resolved_adapter`
        // via the runner registry when serving the public status payload.
        runner: e.agent.runner,
        adapter: e.agent.adapter,
      })),
    );
    return {
      running: this.running,
      activeInvocations: active,
      queuedInvocations: queued,
      invocations,
      queued: queuedItems,
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Bootstrap: evaluate all current tasks against dispatch rules.
   * AC: @agent-dispatch-engine ac-8
   */
  private async _bootstrap(): Promise<void> {
    try {
      const enqueued = await this._evaluateAllTasks({ skipIfActive: false });
      if (enqueued > 0) {
        // AC: @agent-dispatch-engine ac-27 — all drains go through _serializedDrain()
        await this._serializedDrain();
      }
    } catch (err) {
      console.error("[dispatch] Bootstrap error:", err);
    }
  }

  /**
   * Periodic reconciliation: re-evaluate all task states against dispatch rules.
   * Enqueues tasks that match but have no active or queued invocation.
   * AC: @agent-dispatch-engine ac-19
   * AC: @dispatch-remote-branch-sync ac-pull-target-periodic, ac-pull-target-periodic-deferred
   */
  private async _reconcile(): Promise<void> {
    // AC: @dispatch-remote-branch-sync ac-pull-target-periodic — sync target when stale
    // AC: @dispatch-remote-branch-sync ac-pull-target-periodic-deferred — skip if reviewer active
    if (this._remoteSyncEnabled) {
      await this._syncAllActiveTargets({ staleOnly: true });
    }

    try {
      const ctx = await initContext(this.projectDir);
      const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
      const taskStatusByRef = new Map(
        tasks.map((task) => [`@${task._ulid}`, task.status as TaskStatus]),
      );
      await this.shadowMutex.runExclusive(async () => {
        await reconcileDispatchWorkspaceRegistry(
          this.projectDir,
          taskStatusByRef,
          this._activeRoleByTaskRef(),
        );
      });
      // AC: @multi-turn-session-lifecycle ac-11 — reload session.idle hook presence
      // so hooks added while dispatch is running take effect on subsequent invocations.
      const meta = await loadMetaContext(ctx);
      this._updateSessionIdleHookPresence(meta);
    } catch (err) {
      console.error("[dispatch] Workspace registry reconciliation error:", err);
    }
    await reconcileDispatchWorkspaceArtifacts(this.projectDir, {
      activeTaskRefs: this._activeTaskRefs(),
    });

    // AC: @dispatch-remote-branch-sync ac-push-target-periodic
    // Push the integration target if it has unpushed commits (retries failed post-merge pushes).
    if (this.remoteSyncEnabled && this.dispatchRemote) {
      await this._pushActiveTargetsAsync("periodic-sync");
    }

    const enqueued = await this._evaluateAllTasks({ skipIfActive: true });
    if (enqueued > 0) {
      console.log(`[dispatch] Reconciliation enqueued ${enqueued} task(s)`);
      // AC: @agent-dispatch-engine ac-27 — all drains go through _serializedDrain()
      await this._serializedDrain();
    }
  }

  // ─── Dispatch Branch Push Helpers ─────────────────────────────────────────

  /**
   * Fire-and-forget push of a dispatch branch to remote.
   * Logs warnings on failure but never throws or blocks the dispatch loop.
   *
   * AC: @dispatch-remote-branch-sync ac-first-push-sets-tracking
   * AC: @dispatch-remote-branch-sync ac-first-push-replaces-stale-ref
   * AC: @dispatch-remote-branch-sync ac-subsequent-push
   * AC: @dispatch-remote-branch-sync ac-push-non-fatal
   */
  private async _pushDispatchBranchAsync(canonicalBranch: string, taskRef: string): Promise<void> {
    try {
      const result = await pushDispatchBranch(
        this.projectDir,
        canonicalBranch,
        this.dispatchRemote!,
      );
      if (result.error) {
        // AC: @dispatch-remote-branch-sync ac-push-non-fatal
        console.warn(
          `[dispatch] Push failed for ${canonicalBranch} (task ${taskRef}): ${result.error}`,
        );
      } else if (result.pushed) {
        console.log(
          `[dispatch] Pushed ${canonicalBranch}${result.firstPush ? " (first push, tracking established)" : ""}`,
        );
      }
    } catch (err) {
      // AC: @dispatch-remote-branch-sync ac-push-non-fatal
      console.warn(
        `[dispatch] Unexpected error pushing ${canonicalBranch} (task ${taskRef}):`,
        err,
      );
    }
  }

  /**
   * Push the integration target branch to remote with serialization.
   * If a push is already in progress, the call is skipped (not queued).
   *
   * AC: @dispatch-remote-branch-sync ac-push-target-after-merge
   * AC: @dispatch-remote-branch-sync ac-push-target-periodic
   * AC: @dispatch-remote-branch-sync ac-target-push-serialization
   * AC: @dispatch-remote-branch-sync ac-push-non-fatal
   * AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
   */
  private async _pushIntegrationTargetAsync(
    branch: string | undefined,
    trigger: string,
  ): Promise<void> {
    const targetBranch = this._resolveBaseBranch(branch);
    if (!targetBranch) {
      return;
    }
    // Always re-evaluate occupied-checkout-degraded targets so the periodic sync
    // can clear stale degraded state once the blocking worktree is released, even
    // when no commits are waiting to push.
    // AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
    const existingDegraded = this._degradedTargets.get(targetBranch);
    const isOccupiedCheckoutDegraded = existingDegraded?.kind === "occupied-checkout";
    if (
      trigger === "periodic-sync" &&
      !isOccupiedCheckoutDegraded &&
      !(await integrationTargetNeedsPush(this.projectDir, targetBranch))
    ) {
      return;
    }
    // AC: @dispatch-remote-branch-sync ac-target-push-serialization
    if (this._targetPushesInProgress.has(targetBranch)) {
      return;
    }
    this._targetPushesInProgress.add(targetBranch);
    try {
      try {
        await resolveDispatchIntegrationMutationScope(this.projectDir, targetBranch);
      } catch (err) {
        const { reason, kind } = this._classifyMutationScopeError(err, targetBranch);
        this._enterDegradedState(targetBranch, reason, kind);
        console.warn(
          `[dispatch] Integration target push skipped for "${targetBranch}" (${trigger}): ${reason}`,
        );
        return;
      }
      const result = await pushIntegrationTarget(
        this.projectDir,
        targetBranch,
        this.dispatchRemote!,
      );
      if (result.error) {
        // AC: @dispatch-remote-branch-sync ac-push-non-fatal
        console.warn(
          `[dispatch] Integration target push failed for "${targetBranch}" (${trigger}): ${result.error}`,
        );
        return;
      }
      if (result.pushed) {
        console.log(`[dispatch] Pushed integration target "${targetBranch}" (${trigger})`);
      }
      // A successful push or a clean no-op (skipped=true) proves the occupied
      // checkout that previously degraded this target has been released. Other
      // degraded kinds (divergence, dirty checkout, missing ref) still require
      // a successful sync to clear so we don't mask genuine hard failures.
      // AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
      if (this._degradedTargets.get(targetBranch)?.kind === "occupied-checkout") {
        this._exitDegradedState(targetBranch);
      }
    } catch (err) {
      // AC: @dispatch-remote-branch-sync ac-push-non-fatal
      console.warn(
        `[dispatch] Unexpected error pushing integration target "${targetBranch}" (${trigger}):`,
        err,
      );
    } finally {
      this._targetPushesInProgress.delete(targetBranch);
    }
  }

  private async _pushActiveTargetsAsync(trigger: string): Promise<void> {
    const activeTargets = this._resolveActiveTargets();
    if (activeTargets.length === 0) {
      return;
    }
    await Promise.all(
      activeTargets.map((branch) => this._pushIntegrationTargetAsync(branch, trigger)),
    );
  }

  /**
   * Resolve a specific integration target branch, defaulting to the configured base branch.
   */
  private _resolveBaseBranch(branch?: string): string | null {
    return branch ?? this._configuredBaseBranch;
  }

  /**
   * Resolve the current active integration targets as a stable array snapshot.
   */
  private _resolveActiveTargets(): string[] {
    return Array.from(this._activeTargets).toSorted();
  }

  /**
   * Shared logic for bootstrap and reconciliation: load all tasks, seed
   * prevTaskStates, and enqueue tasks matching agent dispatch rules.
   *
   * When skipIfActive is true (reconciliation), tasks with an existing
   * active or queued invocation are skipped.
   *
   * AC: @agent-dispatch-engine ac-8, ac-19
   */
  private async _evaluateAllTasks(opts: { skipIfActive: boolean }): Promise<number> {
    const ctx = await initContext(this.projectDir);
    const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
    const agents = await this._loadAgents();
    const now = Date.now();
    let enqueued = 0;

    // Seed/update prevTaskStates so file watcher diffs work correctly
    for (const task of tasks) {
      this.prevTaskStates.set(task._ulid, task.status as TaskStatus);
    }

    for (const task of tasks) {
      const currentStatus = task.status as TaskStatus;
      const eventType = STATUS_TO_EVENT[currentStatus];
      if (!eventType) continue;

      for (const agent of agents) {
        for (const rule of agent.dispatch ?? []) {
          if (rule.on !== eventType) continue;

          const change: TaskStateChange = {
            taskId: task._ulid,
            taskRef: `@${task._ulid}`,
            fromStatus: currentStatus,
            toStatus: currentStatus,
            timestamp: now,
            task,
          };

          if (!this._matchesFilter(change, rule, task, tasks)) continue;
          if (opts.skipIfActive && this._hasActiveOrQueuedInvocation(agent.id, task._ulid))
            continue;

          this._enqueue(agent, change);
          enqueued++;
        }
      }
    }

    return enqueued;
  }

  /**
   * Check if an agent already has an active or queued invocation for a task.
   * AC: @agent-dispatch-engine ac-19
   */
  private _hasActiveOrQueuedInvocation(agentId: string, taskId: string): boolean {
    if (this.inFlightTaskKeys.has(`${agentId}:@${taskId}`)) {
      return true;
    }
    // Check active invocations
    for (const record of this.activeInvocationDetails.values()) {
      if (record.agentId === agentId && record.taskRef === `@${taskId}`) {
        return true;
      }
    }
    // Check queued entries
    const queue = this.queues.get(agentId) ?? [];
    return queue.some((entry) => entry.change.taskId === taskId);
  }

  private _activeRoleByTaskRef(): Map<string, "worker" | "reviewer"> {
    const roles = new Map<string, "worker" | "reviewer">();
    for (const record of this.activeInvocationDetails.values()) {
      if (record.taskRef) {
        roles.set(record.taskRef, record.role);
      }
    }
    return roles;
  }

  /**
   * Parse the task ref portion of an in-flight key.
   * In-flight keys are formatted as `${agentId}:${taskRef}`. Splitting on the
   * first `:` preserves any `:` characters that may appear within a task ref.
   * Returns null for malformed keys that lack a separator.
   */
  private _parseInFlightTaskRef(key: string): string | null {
    const colonIdx = key.indexOf(":");
    if (colonIdx < 0) return null;
    const taskRef = key.slice(colonIdx + 1);
    return taskRef.length > 0 ? taskRef : null;
  }

  /**
   * Task refs currently protected from workspace artifact cleanup.
   * Includes both registered active invocations (activeInvocationDetails) and
   * tasks that have been dequeued for spawn but not yet registered as active
   * (inFlightTaskKeys), so cleanup sees the same protection set the scheduler
   * uses for deduplication.
   *
   * AC: @agent-dispatch-engine ac-inflight-spawn-refs-protect-cleanup
   */
  private _activeTaskRefs(): Set<string> {
    const refs = new Set<string>();
    for (const record of this.activeInvocationDetails.values()) {
      if (record.taskRef) {
        refs.add(record.taskRef);
      }
    }
    for (const key of this.inFlightTaskKeys) {
      const taskRef = this._parseInFlightTaskRef(key);
      if (taskRef) {
        refs.add(taskRef);
      }
    }
    return refs;
  }

  /**
   * Check whether any agent has an active or in-flight invocation for a task.
   * Considers both registered active invocations (activeInvocationDetails) and
   * tasks that are between queue removal and active registration (inFlightTaskKeys).
   *
   * AC: @agent-dispatch-engine ac-26
   */
  private _hasActiveInvocationForTask(taskRef: string): boolean {
    // Check active invocations across all agents
    for (const record of this.activeInvocationDetails.values()) {
      if (record.taskRef === taskRef) {
        return true;
      }
    }
    // Check in-flight keys (format: "agentId:taskRef") across all agents
    for (const key of this.inFlightTaskKeys) {
      if (this._parseInFlightTaskRef(key) === taskRef) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reload _hasSessionIdleHooks from the current meta context.
   * Called from both _loadAgents() and _reconcile() so that hooks added
   * while dispatch is running are picked up without waiting for the next
   * _loadAgents() cycle.
   *
   * AC: @multi-turn-session-lifecycle ac-11
   */
  private _updateSessionIdleHookPresence(meta: { hooks: Array<{ on: string }> }): void {
    this._hasSessionIdleHooks = meta.hooks.some((h) => h.on === "session.idle");
  }

  /**
   * Load agent definitions from meta context.
   */
  private async _loadAgents(): Promise<LoadedAgent[]> {
    try {
      const ctx = await initContext(this.projectDir);
      const meta = await loadMetaContext(ctx);
      // AC: @multi-turn-session-lifecycle ac-11 — track whether any hook targets session.idle
      this._updateSessionIdleHookPresence(meta);
      return meta.agents;
    } catch {
      return [];
    }
  }

  /**
   * Check if a state change matches a dispatch rule's filters.
   * Base readiness (deps, blocked_by) is checked before consumer filters
   * per @trait-task-readiness ac-composable.
   *
   * AC: @agent-dispatch-engine ac-6
   * AC: @agent-dispatch-engine ac-21
   * AC: @trait-task-readiness ac-deps
   * AC: @trait-task-readiness ac-not-blocked
   * AC: @trait-task-readiness ac-composable
   */
  private _matchesFilter(
    change: TaskStateChange,
    rule: AgentDispatchRule,
    task?: LoadedTask,
    allTasks?: LoadedTask[],
  ): boolean {
    // AC: @agent-dispatch-engine ac-21 — default to automation: eligible for
    // task.ready and task.needs_work when no filter is specified
    const defaultsToEligible = rule.on === "task.ready" || rule.on === "task.needs_work";

    // We need the task to evaluate filters — if not provided, reject to avoid
    // enqueuing non-matching tasks (AC-6: all filters must match)
    if (!task) return !rule.filter && !defaultsToEligible;

    // Any unresolved blocker excludes the candidate from scheduling.
    if ((task.blocked_by ?? []).length > 0) {
      return false;
    }

    // Any unresolved dependency excludes the candidate from scheduling.
    if (allTasks && (task.depends_on ?? []).length > 0) {
      if (!areDependenciesMet(task, allTasks)) {
        return false;
      }
    }

    if (!rule.filter && !defaultsToEligible) return true;

    // AC: @trait-task-readiness ac-composable — consumer filters applied after base readiness
    const filter: AgentDispatchFilter = rule.filter ?? {};

    // Apply default automation filter for task.ready/task.needs_work
    const effectiveAutomation = filter.automation ?? (defaultsToEligible ? "eligible" : undefined);

    // Automation filter
    if (effectiveAutomation !== undefined) {
      if (!matchesAutomationFilter(task.automation, effectiveAutomation)) {
        return false;
      }
    }

    // Tags filter
    if (filter.tags && filter.tags.length > 0) {
      const taskTags: string[] = (task as LoadedTask & { tags?: string[] }).tags ?? [];
      if (!filter.tags.every((tag) => taskTags.includes(tag))) {
        return false;
      }
    }

    // Priority filter — threshold semantics: task priority at or above (numerically <=)
    // AC: @ui-agent-dispatch ac-8
    if (filter.priority !== undefined) {
      const taskPriority = (task as LoadedTask & { priority?: number }).priority;
      if (taskPriority === undefined || taskPriority > filter.priority) {
        return false;
      }
    }

    return true;
  }

  /**
   * Build a deduplication key for a state change.
   * AC: @agent-dispatch-engine ac-7
   */
  private _dedupKey(change: TaskStateChange): DedupKey {
    return `${change.taskId}:${change.fromStatus}:${change.toStatus}`;
  }

  /**
   * Check whether this event is a duplicate within the dedup window.
   * AC: @agent-dispatch-engine ac-7
   */
  private _isDuplicate(change: TaskStateChange): boolean {
    const key = this._dedupKey(change);
    const expiry = this.recentEvents.get(key);
    if (expiry === undefined) return false;
    return change.timestamp < expiry;
  }

  /**
   * Record a state change for deduplication.
   * AC: @agent-dispatch-engine ac-7
   */
  private _recordEvent(change: TaskStateChange): void {
    const key = this._dedupKey(change);
    this.recentEvents.set(key, change.timestamp + this.dedupWindowMs);

    // Prune expired entries periodically
    if (this.recentEvents.size > 1000) {
      const now = Date.now();
      for (const [k, expiry] of this.recentEvents) {
        if (expiry < now) this.recentEvents.delete(k);
      }
    }
  }

  /**
   * Enqueue a dispatch entry for an agent.
   * AC: @agent-dispatch-engine ac-3
   */
  private _enqueue(agent: LoadedAgent, change: TaskStateChange): void {
    const queue = this.queues.get(agent.id) ?? [];
    const entry: QueueEntry = {
      agent,
      change,
      retryCount: 0,
      nextRetryAt: 0,
      enqueuedAtMs: Date.now(),
      sequence: this.nextQueueSequence++,
      starvationDeferrals: 0,
    };
    this._insertQueueEntry(queue, entry);
    this.queues.set(agent.id, queue);
  }

  /**
   * Insert an entry into an agent queue using deterministic status precedence.
   * AC: @dispatch-in-progress-priority ac-1
   */
  private _insertQueueEntry(queue: QueueEntry[], entry: QueueEntry): void {
    const insertAt = queue.findIndex((queued) => this._compareQueueEntries(entry, queued) < 0);
    if (insertAt === -1) {
      queue.push(entry);
      return;
    }
    queue.splice(insertAt, 0, entry);
  }

  /**
   * Compare queue entries by dispatch precedence, numeric task priority, then FIFO.
   * AC: @dispatch-in-progress-priority ac-1
   */
  private _compareQueueEntries(a: QueueEntry, b: QueueEntry): number {
    const statusDelta = STATUS_PRECEDENCE[a.change.toStatus] - STATUS_PRECEDENCE[b.change.toStatus];
    if (statusDelta !== 0) return statusDelta;
    const priorityDelta = this._taskPriorityForEntry(a) - this._taskPriorityForEntry(b);
    if (priorityDelta !== 0) return priorityDelta;
    return a.sequence - b.sequence;
  }

  private _taskPriorityForEntry(entry: QueueEntry): number {
    return entry.change.task?.priority ?? 3;
  }

  private _hasContinuityAffinity(entry: QueueEntry): boolean {
    if (!this.recentTaskAffinityRef) return false;
    return entry.change.taskRef === this.recentTaskAffinityRef;
  }

  private _compareSchedulerCandidates(a: SchedulerCandidate, b: SchedulerCandidate): number {
    const statusDelta =
      STATUS_PRECEDENCE[a.entry.change.toStatus] - STATUS_PRECEDENCE[b.entry.change.toStatus];
    if (statusDelta !== 0) {
      return statusDelta;
    }

    const priorityDelta = this._taskPriorityForEntry(a.entry) - this._taskPriorityForEntry(b.entry);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const sameBand =
      STATUS_PRECEDENCE[a.entry.change.toStatus] === STATUS_PRECEDENCE[b.entry.change.toStatus];
    const samePriority =
      this._taskPriorityForEntry(a.entry) === this._taskPriorityForEntry(b.entry);

    if (sameBand && samePriority) {
      const aAffinity = this._hasContinuityAffinity(a.entry);
      const bAffinity = this._hasContinuityAffinity(b.entry);
      if (aAffinity !== bAffinity) {
        if (aAffinity && b.entry.starvationDeferrals < CONTINUITY_STARVATION_THRESHOLD) {
          return -1;
        }
        if (bAffinity && a.entry.starvationDeferrals < CONTINUITY_STARVATION_THRESHOLD) {
          return 1;
        }
      }
    }

    return a.entry.sequence - b.entry.sequence;
  }

  private _recordContinuityDeferrals(
    selected: SchedulerCandidate,
    candidates: SchedulerCandidate[],
  ): void {
    const selectedAffinity = this._hasContinuityAffinity(selected.entry);
    if (!selectedAffinity) {
      selected.entry.starvationDeferrals = 0;
      return;
    }

    const selectedBand = STATUS_PRECEDENCE[selected.entry.change.toStatus];
    const selectedPriority = this._taskPriorityForEntry(selected.entry);

    for (const candidate of candidates) {
      if (candidate.entry === selected.entry) continue;
      const sameBand = STATUS_PRECEDENCE[candidate.entry.change.toStatus] === selectedBand;
      const samePriority = this._taskPriorityForEntry(candidate.entry) === selectedPriority;
      if (!sameBand || !samePriority) continue;
      if (this._hasContinuityAffinity(candidate.entry)) continue;
      candidate.entry.starvationDeferrals += 1;
    }

    selected.entry.starvationDeferrals = 0;
  }

  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1, ac-2, ac-3, ac-4
  private async _workspaceCandidateHealth(entry: QueueEntry): Promise<{
    eligible: boolean;
    exists: boolean;
    reason: string | null;
  }> {
    const role = entry.change.toStatus === "pending_review" ? "reviewer" : "worker";
    const taskInfo = entry.change.task
      ? {
          title: entry.change.task.title,
          slugs: entry.change.task.slugs,
        }
      : undefined;
    const health = await getDispatchWorkspaceHealth({
      projectDir: this.projectDir,
      taskRef: entry.change.taskRef,
      task: taskInfo,
      role,
    });

    // AC: @adopt-existing-task-branch-lineage ac-1 — when workspace doesn't exist
    // but the task has submission linkage, allow provisioning to adopt the branch.
    const hasSubmissionLinkage = Boolean(entry.change.task?.submission_linkage?.branch);
    const eligible = !health.exists
      ? (entry.change.toStatus !== "in_progress" && entry.change.toStatus !== "pending_review") ||
        hasSubmissionLinkage
      : health.healthy;

    // AC: @dispatch-workspace-registry ac-14 — determine if the workspace record
    // is unrecoverable (missing canonical branch with no recovery path) for a
    // non-terminal task. These reasons correspond to health.status === "invalid"
    // in reconcileWorkspaceHealth.
    const isNonTerminal =
      entry.change.toStatus !== "completed" && entry.change.toStatus !== "cancelled";
    const isUnrecoverable =
      health.exists &&
      !health.healthy &&
      (health.reason === "missing-canonical-branch" || health.reason === "missing-adopted-branch");

    // For resumable tasks, attempt workspace discovery before discarding the
    // queue entry as missing or ineligible.
    if (
      !eligible &&
      (entry.change.toStatus === "in_progress" ||
        entry.change.toStatus === "pending_review" ||
        entry.change.toStatus === "needs_work")
    ) {
      const discoveryResult = await discoverWorkspaceForReviewOrFixCycle({
        projectDir: this.projectDir,
        taskRef: entry.change.taskRef,
        role,
        task: entry.change.task
          ? {
              title: entry.change.task.title,
              slugs: entry.change.task.slugs,
              submission_linkage: entry.change.task.submission_linkage ?? undefined,
              review_url: entry.change.task.review_url,
            }
          : undefined,
      });

      // Emit diagnostics for failed discovery (AC-3) or conflicting signals (AC-4).
      for (const diagnostic of discoveryResult.diagnostics) {
        console.log(
          `[dispatch] Workspace discovery diagnostic for ${diagnostic.taskRef}: [${diagnostic.code}] ${diagnostic.message}`,
        );
        console.log(`[dispatch]   Suggestion: ${diagnostic.suggestion}`);
      }

      if (discoveryResult.recovered) {
        // AC-2: Recovery succeeded — re-evaluate eligibility with recovered workspace.
        return {
          eligible: true,
          exists: discoveryResult.health.exists,
          reason: discoveryResult.health.reason,
        };
      }

      // AC: @dispatch-workspace-registry ac-14 — after discovery fails for a
      // resumable task with an unrecoverable workspace, purge the stale record
      // so the task can be freshly provisioned. The purge acquires the shadow
      // mutation lock and durably commits (ac-8) before returning eligible.
      if (isNonTerminal && isUnrecoverable && health.metadata) {
        await this._purgeUnrecoverableWorkspaceRecord(
          entry.change.taskRef,
          health.metadata.workspaceId,
          health.reason!,
        );
        return { eligible: true, exists: false, reason: null };
      }

      // Discovery failed — return ineligible with diagnostic-enriched reason.
      const diagnosticReason =
        discoveryResult.diagnostics[0]?.code ??
        (health.exists ? health.reason : "workspace-missing-no-recovery");
      return {
        eligible: false,
        exists: health.exists || discoveryResult.health.exists,
        reason: diagnosticReason,
      };
    }

    // AC: @dispatch-workspace-registry ac-14 — for non-resumable non-terminal tasks
    // (e.g., pending via task.ready) with an unrecoverable workspace record, purge
    // the stale record so the task becomes eligible for fresh provisioning. The
    // purge acquires the shadow mutation lock and durably commits (ac-8) before
    // returning eligible.
    if (!eligible && isNonTerminal && isUnrecoverable && health.metadata) {
      await this._purgeUnrecoverableWorkspaceRecord(
        entry.change.taskRef,
        health.metadata.workspaceId,
        health.reason!,
      );
      return { eligible: true, exists: false, reason: null };
    }

    return {
      eligible,
      exists: health.exists,
      reason: health.reason,
    };
  }

  /**
   * Purge an unrecoverable workspace record so the task can be freshly
   * provisioned on the next dispatch cycle.
   *
   * Acquires the dispatch shadow mutation lock and durably commits the
   * deletion to the shadow branch so daemon restart cannot resurrect the
   * stale record.
   *
   * AC: @dispatch-workspace-registry ac-8
   * AC: @dispatch-workspace-registry ac-14
   */
  private async _purgeUnrecoverableWorkspaceRecord(
    taskRef: string,
    workspaceId: string,
    reason: string,
  ): Promise<void> {
    console.log(
      `[dispatch] Purging unrecoverable workspace record ${workspaceId} for ${taskRef} (${reason}). ` +
        `Task will be eligible for fresh provisioning on the next dispatch cycle.`,
    );
    try {
      await purgeDispatchWorkspaceRecord(this.projectDir, taskRef, workspaceId);
    } catch (err) {
      console.log(
        `[dispatch] Failed to purge workspace record ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async _pruneIneligibleQueueEntries(
    agents: LoadedAgent[],
    currentTasks?: LoadedTask[],
    currentTaskStates?: Map<string, TaskStatus>,
  ): Promise<void> {
    const tasksById = new Map((currentTasks ?? []).map((task) => [task._ulid, task]));

    for (const agent of agents) {
      const queue = this.queues.get(agent.id) ?? [];
      const before = queue.length;
      const discardedDetails: string[] = [];

      for (let i = queue.length - 1; i >= 0; i--) {
        const entry = queue[i];
        const currentStatus = currentTaskStates?.get(entry.change.taskId);
        const expectedEvent = STATUS_TO_EVENT[entry.change.toStatus];

        if (expectedEvent) {
          if (currentStatus === undefined) {
            if (this.prevTaskStates.has(entry.change.taskId)) {
              discardedDetails.push(
                `${entry.change.taskRef} for agent "${agent.id}": task no longer exists on disk`,
              );
              queue.splice(i, 1);
              continue;
            }
          } else {
            const currentEvent = STATUS_TO_EVENT[currentStatus];
            if (currentEvent !== expectedEvent) {
              discardedDetails.push(
                `${entry.change.taskRef} for agent "${agent.id}": task state changed to ${currentStatus}`,
              );
              queue.splice(i, 1);
              continue;
            }
          }
        }

        const currentTask = tasksById.get(entry.change.taskId);
        if (currentTask) {
          entry.change.task = currentTask;
          if (currentTask.blocked_by.length > 0) {
            discardedDetails.push(
              `${entry.change.taskRef} for agent "${agent.id}": task is blocked by ${currentTask.blocked_by.join(", ")}`,
            );
            queue.splice(i, 1);
            continue;
          }
          if (
            currentTask.depends_on.length > 0 &&
            currentTasks &&
            !areDependenciesMet(currentTask, currentTasks)
          ) {
            discardedDetails.push(
              `${entry.change.taskRef} for agent "${agent.id}": dependencies are no longer satisfied`,
            );
            queue.splice(i, 1);
            continue;
          }
        }

        const workspaceHealth = await this._workspaceCandidateHealth(entry);
        if (!workspaceHealth.eligible) {
          discardedDetails.push(
            `${entry.change.taskRef} for agent "${agent.id}": workspace ${workspaceHealth.exists ? "is unhealthy" : "is missing"}${workspaceHealth.reason ? ` (${workspaceHealth.reason})` : ""}`,
          );
          queue.splice(i, 1);
        }
      }

      for (const detail of discardedDetails) {
        console.log(`[dispatch] Discarded queue entry ${detail}`);
      }
      if (before > queue.length) {
        console.log(
          `[dispatch] Discarded ${before - queue.length} ineligible queue entr${before - queue.length === 1 ? "y" : "ies"} for agent "${agent.id}"`,
        );
      }

      this.queues.set(agent.id, queue);
    }
  }

  private _selectNextCandidate(agents: LoadedAgent[]): SchedulerCandidate | null {
    const now = Date.now();
    const candidates: SchedulerCandidate[] = [];

    for (const agent of agents) {
      const maxConcurrent = agent.concurrency?.max_concurrent ?? 1;
      const active = this.activeCount.get(agent.id) ?? 0;
      if (active >= maxConcurrent) continue;

      const queue = this.queues.get(agent.id) ?? [];
      for (let index = 0; index < queue.length; index++) {
        const entry = queue[index];
        if (entry.nextRetryAt > now) continue;
        // AC: @agent-dispatch-engine ac-26 — cross-agent task exclusivity:
        // skip candidates whose task already has an active invocation by any
        // agent. The entry stays queued and will be picked up after the active
        // invocation completes (post-invocation drain via ac-24).
        if (this._hasActiveInvocationForTask(entry.change.taskRef)) continue;
        candidates.push({ agent, queue, queueIndex: index, entry });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => this._compareSchedulerCandidates(a, b));
    const selected = candidates[0];
    this._recordContinuityDeferrals(selected, candidates);
    return selected;
  }

  /**
   * Schedule a per-task coalesced drain. If a timer already exists for this
   * task, it is cleared and reset to the full coalescing window.
   *
   * AC: @per-task-dispatch-drain-coalescing ac-1, ac-3
   */
  private _scheduleCoalescedDrain(taskId: string): void {
    // Clear any existing timer for this task (reset window)
    const existing = this.coalesceTimers.get(taskId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.coalesceTimers.delete(taskId);
      if (!this.running) return;

      // AC: @per-task-dispatch-drain-coalescing ac-8 — serialize drain execution
      this._serializedDrain().catch((err) => {
        console.error("[dispatch] Coalesced drain error:", err);
      });
    }, this.coalesceWindowMs);

    // Unref so it doesn't keep the process alive
    if (timer && typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    this.coalesceTimers.set(taskId, timer);
  }

  /**
   * Serialize drain execution: if a drain is already running, mark that another
   * drain is pending and return. When the current drain finishes, it runs the
   * follow-up drain. This prevents concurrent _drainQueues() calls from
   * racing on queue state.
   *
   * AC: @per-task-dispatch-drain-coalescing ac-8
   */
  private async _serializedDrain(): Promise<void> {
    if (this.drainInProgress) {
      this.drainPending = true;
      return;
    }

    this.drainInProgress = true;
    try {
      const agents = await this._loadAgents();
      await this._drainQueues(agents);
    } finally {
      this.drainInProgress = false;
    }

    // If another drain was requested while we were running, do one follow-up.
    if (this.drainPending) {
      this.drainPending = false;
      await this._serializedDrain();
    }
  }

  /**
   * Drain queues, spawning invocations up to each agent's max_concurrent limit.
   * AC: @agent-dispatch-engine ac-3, ac-17
   */
  private async _drainQueues(agents: LoadedAgent[]): Promise<void> {
    // Prevent new invocation starts during/after shutdown.
    if (!this.running) return;

    // AC: @agent-dispatch-engine ac-17 - Load current tasks once for staleness + readiness checks
    let currentTasks: LoadedTask[] | undefined;
    let currentTaskStates: Map<string, TaskStatus> | undefined;
    try {
      const ctx = await initContext(this.projectDir);
      currentTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
      currentTaskStates = new Map(currentTasks.map((t) => [t._ulid, t.status as TaskStatus]));
    } catch {
      // If we can't load tasks, skip staleness checks (best effort)
    }

    await this._pruneIneligibleQueueEntries(agents, currentTasks, currentTaskStates);

    const taskLookup = new Map((currentTasks ?? []).map((task) => [task._ulid, task]));
    const deferredEntries = new Map<string, QueueEntry[]>();
    const targetCache = new Map<string, string>();

    while (this.running) {
      const candidate = this._selectNextCandidate(agents);
      if (!candidate) {
        break;
      }

      const [entry] = candidate.queue.splice(candidate.queueIndex, 1);
      this.queues.set(candidate.agent.id, candidate.queue);

      const targetBranch = await this._resolveQueueEntryTargetBranch(
        entry,
        taskLookup,
        targetCache,
      );
      if (this._degradedTargets.has(targetBranch)) {
        console.log(
          `[dispatch] Deferring ${entry.change.taskRef} because integration target "${targetBranch}" is degraded.`,
        );
        const deferredQueue = deferredEntries.get(candidate.agent.id) ?? [];
        deferredQueue.push(entry);
        deferredEntries.set(candidate.agent.id, deferredQueue);
        continue;
      }

      const spawned = await this._spawnInvocation(candidate.agent, entry);
      if (!spawned) {
        continue;
      }
    }

    for (const [agentId, entries] of deferredEntries) {
      const queue = this.queues.get(agentId) ?? [];
      for (const entry of entries) {
        this._insertQueueEntry(queue, entry);
      }
      this.queues.set(agentId, queue);
    }
  }

  /**
   * Build dispatch-mode prompt guardrails to keep autonomous agents from
   * stopping with handoff text instead of performing required actions.
   *
   * AC: @agent-dispatch-engine ac-13, ac-14, ac-15, ac-16
   */
  private async _buildDispatchPrompt(
    agent: LoadedAgent,
    change: TaskStateChange,
    workspace: ProvisionedDispatchWorkspace,
    resolvedAdapterId: string,
  ): Promise<string> {
    const trigger = (STATUS_TO_EVENT[change.toStatus] ?? "task.ready") as SessionTrigger;
    const taskRef = change.taskRef;

    // AC: @agent-dispatch-engine ac-16 - Interpolate prompt_template variables
    const templateVars: Record<string, string> = {
      task_ref: taskRef,
      task_title: change.task?.title ?? "(unavailable)",
      trigger,
      review_url: change.task?.review_url ?? "",
    };
    const rawTemplate = agent.prompt_template ?? `Work on task ${taskRef}`;
    const basePrompt = interpolateTemplate(rawTemplate, templateVars);

    // AC: @review-fix-cycle-diff ac-2 — Compute fix-cycle diff for reviewer orientation
    let fixCycleDiffSummary: string | null = null;
    if (trigger === "task.pending_review") {
      fixCycleDiffSummary = await getFixCycleDiffSummary(
        this.projectDir,
        taskRef,
        workspace.metadata.canonicalBranchHead,
        workspace.cwd,
      );
    }

    // Resolve task resource_refs against owning entities so the orientation
    // block surfaces drift to the agent. Best-effort — failures are caught
    // here so the dispatch can still spin up if the resolver hits an edge.
    // AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
    let resolvedResources: Awaited<
      ReturnType<typeof import("../parser/task-resource-resolver.js").projectResolvedTaskResources>
    > = [];
    if (change.task?.resource_refs && change.task.resource_refs.length > 0) {
      try {
        const { resolveTaskResources, projectResolvedTaskResources } =
          await import("../parser/task-resource-resolver.js");
        const ctx = await initContext(this.projectDir);
        const resolved = await resolveTaskResources(ctx, change.task);
        resolvedResources = projectResolvedTaskResources(resolved);
      } catch {
        // Drift visibility is advisory — never block dispatch on it.
      }
    }

    const orientation = buildOrientationContext(
      taskRef,
      trigger,
      workspace,
      change.task,
      undefined,
      undefined,
      { fixCycleDiffSummary, resolvedResources },
    );
    const roleEntry = await buildRoleEntryContext(
      this.projectDir,
      resolvedAdapterId,
      trigger,
      workspace.metadata,
    );
    const autonomousPreamble = [
      "AUTONOMOUS DISPATCH MODE (no interactive user is available).",
      "- Do not ask for confirmation, approval, or next-step handoff.",
      "- Execute required commands directly in this invocation.",
      "- Do not end your turn with a recommendations-only summary. Perform the next required action yourself.",
      '- Do not end your turn until the expected task transition is complete, or you have explicitly blocked the task with `kspec task block <task> --reason "..."`.',
      "- If you find an open PR/branch from a different task, create or switch to a dedicated branch for this task before committing to avoid PR conflation.",
      `- CRITICAL: Your working directory is your assigned workspace (${workspace.cwd}). Run ALL commands (tests, builds, git, kspec, etc.) from this directory. Do NOT cd to the project root or any other directory. The workspace is a full git worktree with the correct branch and project configuration.`,
    ];

    const triggerSpecific =
      trigger === "task.pending_review"
        ? [
            `Review flow completion criteria for ${taskRef}:`,
            "- Execute your configured review workflow directly (no handoff).",
            `- If blocking issues are found, transition ${taskRef} out of pending_review appropriately (for example needs_work).`,
            `- If review gates are clean, perform your workflow's completion actions directly in this invocation.`,
          ]
        : [
            `Work flow completion criteria for ${taskRef}:`,
            "- Execute your configured work workflow directly (no handoff).",
            `- Perform the required commands to move ${taskRef} to the next appropriate state in this same invocation.`,
            "- If your workflow includes git or PR steps, execute them directly instead of deferring to a human.",
          ];

    return `${basePrompt}\n\n${orientation}\n\n${roleEntry}\n\n${autonomousPreamble.join("\n")}\n\n${triggerSpecific.join("\n")}`;
  }

  private async _runKspecCommand(args: string[]): Promise<KspecCommandResult> {
    try {
      const result = await execFileAsync(
        process.execPath,
        [this.kspecCliPath ?? DEFAULT_KSPEC_CLI_PATH, ...args],
        {
          cwd: this.cwd,
          encoding: "utf-8",
        },
      );
      return {
        status: 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    } catch (err: unknown) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
      };
      return {
        status: typeof e.code === "number" ? e.code : e.killed ? null : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  }

  private _taskCommandError(args: string[], result: KspecCommandResult): Error {
    const exitDetail =
      result.status === null ? "terminated by signal" : `exited with status ${result.status}`;
    const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" ");
    return new Error(
      `Failed to run \`kspec ${args.join(" ")}\`: ${exitDetail}${details ? `. ${details}` : ""}`,
    );
  }

  private async _addTaskNote(taskRef: string, note: string): Promise<void> {
    const args = ["task", "note", taskRef, note];
    const result = await this._runKspecCommand(args);
    if (result.status !== 0) {
      console.warn(
        `[dispatch] Failed to add task note for ${taskRef}: ${this._taskCommandError(args, result).message}`,
      );
    }
  }

  private async _blockTask(taskRef: string, reason: string): Promise<void> {
    const args = ["task", "block", taskRef, "--reason", reason];
    const result = await this._runKspecCommand(args);
    if (result.status !== 0) {
      throw this._taskCommandError(args, result);
    }
  }

  private async _runRecoveryTaskCommand(
    taskRef: string,
    action: string,
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[dispatch] Failed to ${action} for ${taskRef} during recovery: ${message}`);
    }
  }

  /**
   * Spawn a single invocation for a queue entry.
   * Returns true if an invocation was actually started, false if skipped.
   * AC: @agent-dispatch-engine ac-9, ac-10, ac-11, ac-12
   */
  private async _spawnInvocation(agent: LoadedAgent, entry: QueueEntry): Promise<boolean> {
    // Bail out during shutdown — don't provision workspaces or add to
    // runningInvocations for invocations that will never complete.
    if (!this.running) return false;

    const agentId = agent.id;
    const inFlightKey = `${agentId}:${entry.change.taskRef}`;
    this.inFlightTaskKeys.add(inFlightKey);
    let invocationRegistered = false;
    let workspace: Awaited<ReturnType<typeof provisionDispatchWorkspace>>;
    const role: DispatchWorkspaceRole =
      entry.change.toStatus === "pending_review" ? "reviewer" : "worker";
    try {
      // AC: @dispatch-remote-branch-sync ac-pull-target-before-provision — sync if stale
      if (this._remoteSyncEnabled) {
        const resolvedConfig = await resolveDispatchWorkspaceConfig(this.projectDir, {
          taskRef: entry.change.taskRef,
          task: entry.change.task
            ? {
                title: entry.change.task.title,
                slugs: entry.change.task.slugs,
                plan_ref: entry.change.task.plan_ref,
              }
            : undefined,
        });
        if (this._isTargetSyncStale(resolvedConfig.baseBranch)) {
          await this._syncTarget(resolvedConfig.baseBranch);
        }
      }

      try {
        workspace = await provisionDispatchWorkspace({
          projectDir: this.projectDir,
          taskRef: entry.change.taskRef,
          role,
          cleanupState: {
            taskStatus: entry.change.task?.status ?? entry.change.toStatus,
          },
          task: entry.change.task
            ? {
                title: entry.change.task.title,
                slugs: entry.change.task.slugs,
              }
            : undefined,
          // AC: @adopt-existing-task-branch-lineage ac-1, ac-2, ac-4
          // Pass submission linkage so provisioning can adopt an existing branch
          // when no workspace record exists for review/fix-cycle tasks.
          submissionLinkage: entry.change.task?.submission_linkage ?? undefined,
          taskStatus: entry.change.task?.status ?? entry.change.toStatus,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const guidance =
          err instanceof DispatchWorkspaceError
            ? err.suggestion
            : "Inspect dispatch workspace configuration and git worktree state.";
        console.error(
          `[dispatch] Failed to provision workspace for ${entry.change.taskRef}: ${message}`,
        );
        await this._runRecoveryTaskCommand(entry.change.taskRef, "add task note", () =>
          this._addTaskNote(
            entry.change.taskRef,
            `[DISPATCH-WORKSPACE] ${message} Suggested action: ${guidance}`,
          ),
        );
        await this._runRecoveryTaskCommand(entry.change.taskRef, "block task", () =>
          this._blockTask(
            entry.change.taskRef,
            `Dispatch workspace provisioning failed: ${message}. Suggested action: ${guidance}`,
          ),
        );
        return false;
      }

      await this._addActiveTarget(workspace.metadata.integrationTargetBranch);

      let dispatchEnv = {
        KSPEC_DISPATCH_BASE_BRANCH: workspace.metadata.baseBranch,
        KSPEC_DISPATCH_MERGE_TARGET: workspace.metadata.mergeTargetBranch,
        KSPEC_DISPATCH_CANONICAL_BRANCH: workspace.metadata.canonicalBranch,
        KSPEC_DISPATCH_WORKTREE_ROOT: workspace.metadata.worktreeRoot,
        KSPEC_DISPATCH_WORKSPACE_FILE: workspace.metadataPath,
      };

      try {
        const bootstrap = await ensureWorkspaceBootstrap({
          projectDir: this.projectDir,
          workspaceDir: workspace.cwd,
          metadataPath: workspace.metadataPath,
          metadata: workspace.metadata,
          role,
          agent,
          env: dispatchEnv,
        });
        workspace = {
          ...workspace,
          metadata: bootstrap.metadata,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const guidance =
          err instanceof DispatchBootstrapError
            ? err.suggestion
            : "Inspect dispatch bootstrap configuration, dependency prerequisites, and workspace health.";
        console.error(
          `[dispatch] Failed to bootstrap workspace for ${entry.change.taskRef}: ${message}`,
        );
        if (this.kspecCliPath) {
          // AC: @agent-dispatch-engine ac-28 — fire-and-forget async error recovery
          await this._addTaskNote(
            entry.change.taskRef,
            `[DISPATCH-BOOTSTRAP] ${message} Suggested action: ${guidance}`,
          );
          try {
            await this._blockTask(entry.change.taskRef, `Dispatch bootstrap failed: ${message}`);
          } catch {
            // Best-effort — block may fail if task already blocked
          }
        }
        return false;
      }

      try {
        const validation = await validateDispatchWorkspaceForInvocation({
          projectDir: this.projectDir,
          taskRef: entry.change.taskRef,
          workspace,
          role,
          task: entry.change.task
            ? {
                title: entry.change.task.title,
                slugs: entry.change.task.slugs,
              }
            : undefined,
          submissionLinkage: entry.change.task?.submission_linkage ?? undefined,
          taskStatus: entry.change.task?.status ?? entry.change.toStatus,
        });
        workspace = validation.workspace;

        if (validation.repaired) {
          dispatchEnv = {
            KSPEC_DISPATCH_BASE_BRANCH: workspace.metadata.baseBranch,
            KSPEC_DISPATCH_MERGE_TARGET: workspace.metadata.mergeTargetBranch,
            KSPEC_DISPATCH_CANONICAL_BRANCH: workspace.metadata.canonicalBranch,
            KSPEC_DISPATCH_WORKTREE_ROOT: workspace.metadata.worktreeRoot,
            KSPEC_DISPATCH_WORKSPACE_FILE: workspace.metadataPath,
          };
          const rebootstrap = await ensureWorkspaceBootstrap({
            projectDir: this.projectDir,
            workspaceDir: workspace.cwd,
            metadataPath: workspace.metadataPath,
            metadata: workspace.metadata,
            role,
            agent,
            env: dispatchEnv,
          });
          workspace = {
            ...workspace,
            metadata: rebootstrap.metadata,
          };
          workspace = (
            await validateDispatchWorkspaceForInvocation({
              projectDir: this.projectDir,
              taskRef: entry.change.taskRef,
              workspace,
              role,
              task: entry.change.task
                ? {
                    title: entry.change.task.title,
                    slugs: entry.change.task.slugs,
                  }
                : undefined,
              submissionLinkage: entry.change.task?.submission_linkage ?? undefined,
              taskStatus: entry.change.task?.status ?? entry.change.toStatus,
              allowRecovery: false,
            })
          ).workspace;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const guidance =
          err instanceof DispatchWorkspaceError
            ? err.suggestion
            : "Inspect dispatch workspace validation diagnostics, git worktree state, and filesystem permissions.";
        console.error(
          `[dispatch] Failed pre-invocation workspace validation for ${entry.change.taskRef}: ${message}`,
        );
        await this._runRecoveryTaskCommand(entry.change.taskRef, "add task note", () =>
          this._addTaskNote(
            entry.change.taskRef,
            `[DISPATCH-WORKSPACE] ${message} Suggested action: ${guidance}`,
          ),
        );
        await this._runRecoveryTaskCommand(entry.change.taskRef, "block task", () =>
          this._blockTask(
            entry.change.taskRef,
            `Dispatch workspace validation failed: ${message}. Suggested action: ${guidance}`,
          ),
        );
        return false;
      }

      // AC: @agent-dispatch-engine ac-10 - Check adapter resolvability before spawn
      // AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
      // AC: @runner-resolution-and-preflight ac-unknown-runner-blocks-before-spawn
      // AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
      // AC: @runner-resolution-and-preflight ac-invalid-runner-blocks-before-prompt
      //
      // Resolve the runner contract before building the prompt so unknown
      // runners, unknown adapters, or invalid runner config block the spawn
      // (and the role-entry workflow render) with structured guidance.
      // Building the prompt before resolution would expand role-entry
      // adapter-specific tokens against the legacy agent.adapter field,
      // breaking runner precedence for dispatch.
      //
      // AC: @runner-invocation-semantics ac-dispatch-preflight-uses-canonical-session-id
      // AC: @cli-agent-commands ac-6 - Pre-assign session ID for status tracking
      // Allocate the canonical session id BEFORE the preflight resolver so
      // the preflight contract, every active-tracking field, lifecycle event
      // payload, session context, and the eventual `runInvocation` all
      // observe the same `KSPEC_SESSION_ID`. Without this, runner env/session
      // injection or diagnostic interpolation at preflight time would see a
      // throwaway id distinct from the tracked invocation id.
      const preSessionId = ulid();
      let preflightContract: RunnerInvocation;
      let preflightRegistry: EffectiveRunnerRegistry;
      let preflightRegistryLoadFailures: readonly RegistryLoadFailure[] = [];
      try {
        const resolved = await resolveEffectiveRunners({
          projectRoot: this.projectDir,
          shadowWorktreeDir: this.specDir,
        });
        preflightRegistry = resolved.registry;
        // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
        // AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
        // Capture layer-load failures so the resolver can surface them as
        // `runner_registry_unavailable` for runner-backed agents. Without
        // this, a malformed YAML/schema problem would look like a missing
        // runner name and the task note would point at the wrong file.
        preflightRegistryLoadFailures = diagnoseRegistryLoad(resolved);
      } catch {
        preflightRegistry = { runners: {} };
      }
      try {
        preflightContract = resolveRunnerInvocation({
          agent,
          registry: preflightRegistry,
          cwd: workspace.cwd,
          // AC: @runner-invocation-semantics ac-dispatch-preflight-uses-canonical-session-id
          sessionId: preSessionId,
          autoApprove: agent.auto_approve,
          env: {},
          // AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
          registryLoadFailures: preflightRegistryLoadFailures,
        });
      } catch (resolverErr) {
        const reason =
          resolverErr instanceof RunnerResolutionError ? resolverErr.reason : "preflight_failure";
        const message = resolverErr instanceof Error ? resolverErr.message : String(resolverErr);
        console.error(
          `[dispatch] Cannot resolve runner contract for agent "${agentId}" (${reason}). Skipping invocation. ${message}`,
        );
        if (this.kspecCliPath) {
          // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
          // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
          // For registry-unavailable failures, include the stable reason and
          // the failing config paths in the task note so reviewers can find
          // the broken file without rerunning the validator. Secret values
          // are never present in these diagnostics — `describeRegistryLoadFailures`
          // emits redacted issue messages only.
          let note = `[AGENT-SKIP] Runner resolution failed for agent "${agentId}" (${reason}). ${message}`;
          if (
            resolverErr instanceof RunnerResolutionError &&
            resolverErr.reason === "runner_registry_unavailable" &&
            preflightRegistryLoadFailures.length > 0
          ) {
            const paths = preflightRegistryLoadFailures
              .map((failure) => `${failure.layer}=${failure.config_path}`)
              .join(", ");
            note = `[AGENT-SKIP] Runner registry unavailable for agent "${agentId}" (${reason}). Failing layers: ${paths}. ${message}`;
          }
          await this._addTaskNote(entry.change.taskRef, note);
        }
        return false;
      }

      // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
      // Run the executable preflight at dispatch preflight time so an
      // unspawnable runner-configured command is treated as a deterministic
      // configuration error (skip + task note) instead of an invocation
      // failure that the retry path keeps re-attempting. Without this step,
      // the unspawnable_command exception would only fire inside
      // runInvocation, where the dispatch catch path retries it like any
      // transient error.
      try {
        await preflightRunnerInvocation(preflightContract);
      } catch (preflightErr) {
        const reason =
          preflightErr instanceof RunnerResolutionError ? preflightErr.reason : "preflight_failure";
        const message = preflightErr instanceof Error ? preflightErr.message : String(preflightErr);
        console.error(
          `[dispatch] Runner executable preflight failed for agent "${agentId}" (${reason}). Skipping invocation. ${message}`,
        );
        if (this.kspecCliPath) {
          await this._addTaskNote(
            entry.change.taskRef,
            `[AGENT-SKIP] Runner executable preflight failed for agent "${agentId}" (${reason}). ${message}`,
          );
        }
        return false;
      }

      const adapterId = preflightContract.adapterId;
      const adapter = preflightContract.adapter;
      const runnerId = preflightContract.runnerId;

      let prompt: string;
      try {
        // AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
        // Pass the resolved adapter id so adapter-specific role-entry tokens
        // (e.g., `/skill` vs `$skill`) match the runner that will actually
        // spawn — never the legacy agent.adapter field.
        prompt = await this._buildDispatchPrompt(agent, entry.change, workspace, adapterId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const guidance =
          err instanceof DispatchPromptError
            ? err.suggestion
            : "Inspect dispatch role-entry configuration and workspace metadata.";
        console.error(`[dispatch] Failed to build prompt for ${entry.change.taskRef}: ${message}`);
        if (this.kspecCliPath) {
          // AC: @agent-dispatch-engine ac-28 — fire-and-forget async error recovery
          await this._addTaskNote(
            entry.change.taskRef,
            `[DISPATCH-PROMPT] ${message} Suggested action: ${guidance}`,
          );
        }
        return false;
      }

      // Increment active count
      this.activeCount.set(agentId, (this.activeCount.get(agentId) ?? 0) + 1);
      // The resolver falls back to an ad-hoc npx adapter when the legacy
      // `agent.adapter` field is not a registered id. Dispatch is stricter
      // than one-shot `kspec agent run`: it requires a registered adapter so
      // unknown ids fail fast with guidance instead of attempting to npx the
      // typo. Runner-resolved adapters are always registered (the runner
      // schema validates them at load time).
      if (!getAdapter(adapterId)) {
        console.error(
          `[dispatch] Cannot resolve adapter "${adapterId}" for agent "${agentId}". Skipping invocation.`,
        );
        const currentActive = this.activeCount.get(agentId) ?? 1;
        this.activeCount.set(agentId, Math.max(0, currentActive - 1));
        if (this.kspecCliPath) {
          await this._addTaskNote(
            entry.change.taskRef,
            `[AGENT-SKIP] Cannot resolve adapter "${adapterId}" for agent "${agentId}". Invocation skipped.`,
          );
        }
        return false;
      }
      // Reference the adapter to keep its bound contract pinned for later
      // (currently the spawner re-resolves via the adapter object passed in
      // the invocation options).
      void adapter;

      // AC: @agent-dispatch-engine ac-11 - Create abort controller for graceful cancellation
      const abortController = new AbortController();
      this.invocationAbortControllers.add(abortController);

      const invocationId = ulid();
      const trackingRecord: ActiveInvocationRecord = {
        invocationId,
        sessionId: preSessionId,
        agentId,
        agentName: agent.name,
        taskRef: entry.change.taskRef,
        role,
        startedAtMs: Date.now(),
        // AC: @runner-operator-surfaces ac-daemon-dispatch-active-api-includes-runner
        resolvedAdapter: adapterId,
        runner: runnerId ?? undefined,
      };
      this.activeInvocationDetails.set(invocationId, trackingRecord);
      this.recentTaskAffinityRef = entry.change.taskRef;

      let startedEventEmitted = false;
      const emitStartedEvent = (): void => {
        if (startedEventEmitted) return;
        startedEventEmitted = true;
        const invEvent: InvocationEvent = {
          type: "started",
          session_id: preSessionId,
          agent_id: agentId,
          task_id: entry.change.taskRef,
          task_title: entry.change.task?.title ?? null,
          status: "started",
          timestamp: Date.now(),
          // AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
          resolved_adapter: adapterId,
          ...(runnerId ? { runner: runnerId } : {}),
        };
        this.onInvocationEvent?.(invEvent);
        // AC: @dispatch-event-envelope ac-1 - Route invocation lifecycle through bus
        // AC: @dispatch-event-payload ac-2 — adapter_id, resolved_adapter, runner
        // AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
        this._eventBus.emit({
          event_type: "invocation.started",
          source_type: "invocation_lifecycle",
          source_id: preSessionId,
          payload: {
            ...invEvent,
            trigger: STATUS_TO_EVENT[entry.change.toStatus] ?? "task.ready",
            task_ref: entry.change.taskRef ?? undefined,
            adapter_id: agent.adapter ?? adapterId,
            resolved_adapter: adapterId,
            ...(runnerId ? { runner: runnerId } : {}),
          },
        });
      };

      // AC: @session-event-broadcast ac-newline-streaming, ac-boundary-flush, ac-per-session-state
      // AC: @cli-agent-commands ac-13, @daemon-agent-dispatch ac-8 - stream session events to watchers
      const taskId = entry.change.taskRef ?? null;
      const taskTitle = entry.change.task?.title ?? null;
      const sessionCtx = {
        sessionId: preSessionId,
        agentId,
        taskId,
        taskTitle,
      };
      const onUpdate = this.onSessionEvent
        ? (update: import("../acp/index.js").SessionUpdate) => {
            emitStartedEvent();
            this.accumulator.handleUpdate(sessionCtx, update, this.onSessionEvent!);
          }
        : undefined;

      const options: InvocationOptions = {
        agent,
        specDir: this.specDir,
        sessionsDir: path.join(this.projectDir, ".kspec-sessions"),
        cwd: workspace.cwd,
        taskRef: entry.change.taskRef,
        prompt,
        trigger: (STATUS_TO_EVENT[entry.change.toStatus] ?? "task.ready") as SessionTrigger,
        kspecCliPath: this.kspecCliPath,
        abortSignal: abortController.signal,
        sessionId: preSessionId,
        mutationLockFile: getDispatchShadowMutationLockPath(this.projectDir),
        // AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
        // Reuse the registry loaded for preflight so the resolver inside
        // runInvocation produces the same contract.
        runnerRegistry: preflightRegistry,
        // AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
        runnerRegistryLoadFailures: preflightRegistryLoadFailures,
        env: {
          KSPEC_DISPATCH_BASE_BRANCH: workspace.metadata.baseBranch,
          KSPEC_DISPATCH_MERGE_TARGET: workspace.metadata.mergeTargetBranch,
          KSPEC_DISPATCH_CANONICAL_BRANCH: workspace.metadata.canonicalBranch,
          KSPEC_DISPATCH_CANONICAL_HEAD: workspace.metadata.canonicalBranchHead,
          KSPEC_DISPATCH_INTEGRATION_TARGET: workspace.metadata.integrationTargetBranch,
          KSPEC_DISPATCH_INTEGRATION_COMMIT: workspace.metadata.integrationTargetCommit,
          KSPEC_DISPATCH_PUBLICATION_MODE: workspace.metadata.publicationMode,
          KSPEC_DISPATCH_INTEGRATION_STATE: workspace.metadata.integrationState,
          KSPEC_DISPATCH_INTEGRATION_OUTCOME: workspace.metadata.integrationOutcome,
          KSPEC_DISPATCH_WORKTREE_ROOT: workspace.metadata.worktreeRoot,
          KSPEC_DISPATCH_WORKSPACE_FILE: workspace.metadataPath,
          KSPEC_DISPATCH_WORKSPACE_ID: workspace.metadata.workspaceId,
          KSPEC_DISPATCH_BOOTSTRAP_STATUS: workspace.metadata.bootstrap.status,
          KSPEC_DISPATCH_BOOTSTRAP_LAST_ROLE: workspace.metadata.bootstrap.lastRole ?? "",
        },
        onUpdate,
        // AC: @daemon-entity-cache ac-session-event-tracking — increment live counter on each event append
        onEventAppended: (sid: string) => {
          const cache = getEntityCache(this.projectDir);
          cache?.incrementSessionEventCount(sid);
        },
        // AC: @active-session-registry ac-1, @multi-turn-session-lifecycle ac-2, ac-4
        sessionRegistry: this._sessionRegistry,
        // AC: @multi-turn-session-lifecycle ac-2, ac-5, ac-11 — grace period for async prompt delivery;
        // Per-agent config overrides the global default. When no hooks exist and no agent config
        // is set, use 0 for backward compat (AC-11).
        idleGracePeriodMs:
          agent.session?.idle_grace_period_ms ??
          (this._hasSessionIdleHooks ? DEFAULT_IDLE_GRACE_MS : 0),
        // AC: @multi-turn-session-lifecycle ac-6 — session mode from agent config
        sessionMode: agent.session?.mode ?? "auto_close",
        // AC: @multi-turn-session-lifecycle ac-7 — idle timeout from agent config
        idleTimeoutMs: agent.session?.idle_timeout_ms,
        // AC: @multi-turn-session-lifecycle ac-3 — emit session.idle event on event bus
        onIdle: (ctx: SessionIdleContext) => {
          this._eventBus.emit({
            event_type: "session.idle",
            source_type: "invocation_lifecycle",
            source_id: ctx.sessionId,
            payload: {
              session_id: ctx.sessionId,
              agent_id: ctx.agentId,
              task_ref: ctx.taskRef ?? undefined,
              turn_count: ctx.turnCount,
              stop_reason: ctx.stopReason,
              turn_duration_ms: ctx.turnDurationMs,
            },
          });
        },
      };

      let resolveInvocationStarted!: () => void;
      const invocationStarted = new Promise<void>((resolve) => {
        resolveInvocationStarted = resolve;
      });
      let invocationStartedResolved = false;
      const markInvocationStarted = (): void => {
        if (invocationStartedResolved) return;
        invocationStartedResolved = true;
        resolveInvocationStarted();
      };

      let terminalEvent: InvocationEvent | null = null;
      /** AC: @dispatch-event-taxonomy ac-2 — captured invocation result for session event emission */
      let invocationResult: InvocationResult | null = null;
      let releasedInFlightKey = false;
      const markActivePromise = this.shadowMutex.runExclusive(async () => {
        try {
          const activeWorkspace = await markDispatchWorkspaceActive({
            projectDir: this.projectDir,
            taskRef: entry.change.taskRef,
            role: entry.change.toStatus === "pending_review" ? "reviewer" : "worker",
          });
          if (activeWorkspace) {
            workspace = activeWorkspace;
            options.env = {
              ...options.env,
              KSPEC_DISPATCH_WORKSPACE_FILE: activeWorkspace.metadataPath,
              KSPEC_DISPATCH_WORKSPACE_ID: activeWorkspace.metadata.workspaceId,
            };
          }
        } catch (err) {
          console.error(
            `[dispatch] Failed to mark workspace active for ${entry.change.taskRef}:`,
            err,
          );
        }
      });

      const invocationPromise = Promise.resolve()
        .then(async () => {
          // AC: @agent-dispatch-engine ac-9 - Retry on transient errors
          try {
            markInvocationStarted();
            emitStartedEvent();
            await markActivePromise;
            invocationResult = await runInvocation(options);
            // Reset retry count on success
            entry.retryCount = 0;
            entry.starvationDeferrals = 0;
            this.recentTaskAffinityRef = entry.change.taskRef;
            terminalEvent = {
              type: "completed",
              session_id: preSessionId,
              agent_id: agentId,
              task_id: entry.change.taskRef,
              task_title: entry.change.task?.title ?? null,
              status: "completed",
              timestamp: Date.now(),
              // AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
              resolved_adapter: adapterId,
              ...(runnerId ? { runner: runnerId } : {}),
            };
          } catch (err) {
            markInvocationStarted();
            const retryLimit = agent.budget?.max_retries ?? 3;
            if (entry.retryCount < retryLimit) {
              entry.retryCount++;
              const backoffMs = Math.min(1000 * Math.pow(2, entry.retryCount - 1), 30_000);
              entry.nextRetryAt = Date.now() + backoffMs;
              console.warn(
                `[dispatch] Invocation for agent "${agentId}" failed (attempt ${entry.retryCount}/${retryLimit}), retrying in ${backoffMs}ms`,
                err,
              );
              // Re-enqueue for retry while preserving status precedence ordering.
              const queue = this.queues.get(agentId) ?? [];
              this._insertQueueEntry(queue, entry);
              this.queues.set(agentId, queue);
              // AC: @agent-dispatch-engine ac-9, ac-27 - Schedule wake-up to drain retry
              // All drains go through _serializedDrain() to prevent concurrent races.
              setTimeout(() => {
                if (this.running) {
                  this._serializedDrain().catch(() => {
                    /* best effort */
                  });
                }
              }, backoffMs);
            } else {
              console.error(
                `[dispatch] Agent "${agentId}" exceeded retry limit. Dropping invocation.`,
                err,
              );
              terminalEvent = {
                type: "failed",
                session_id: preSessionId,
                agent_id: agentId,
                task_id: entry.change.taskRef,
                task_title: entry.change.task?.title ?? null,
                status: "failed",
                timestamp: Date.now(),
                // AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
                resolved_adapter: adapterId,
                ...(runnerId ? { runner: runnerId } : {}),
              };
            }
          }

          // AC: @daemon-entity-cache ac-session-stats-handoff — discard live
          // counter after session close so subsequent reads use persisted metadata.
          {
            const cache = getEntityCache(this.projectDir);
            cache?.discardSessionLiveCounter(preSessionId);
          }

          try {
            await this.shadowMutex.runExclusive(async () => {
              await markDispatchWorkspaceIdle({
                projectDir: this.projectDir,
                taskRef: entry.change.taskRef,
                taskStatus: entry.change.toStatus,
              });
            });
          } catch (err) {
            console.error(
              `[dispatch] Failed to mark workspace idle for ${entry.change.taskRef}:`,
              err,
            );
          }

          // Clean up active tracking before queue drain runs so completed
          // invocations do not linger in the active fleet snapshot.
          const currentActive = this.activeCount.get(agentId) ?? 1;
          this.activeCount.set(agentId, Math.max(0, currentActive - 1));
          this.activeInvocationDetails.delete(invocationId);

          if (entry.change.toStatus === "pending_review") {
            try {
              await this.shadowMutex.runExclusive(async () => {
                await cleanupReviewerDispatchWorkspace(
                  this.projectDir,
                  entry.change.taskRef,
                  entry.change.task
                    ? {
                        title: entry.change.task.title,
                        slugs: entry.change.task.slugs,
                      }
                    : undefined,
                );
              });
            } catch (cleanupErr) {
              const cleanupMessage =
                cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
              console.warn(
                `[dispatch] Failed to clean reviewer snapshot for ${entry.change.taskRef}: ${cleanupMessage}`,
              );
            }
          }
          // Flush any remaining buffered text before emitting terminal event
          if (this.onSessionEvent) {
            this.accumulator.endSession(sessionCtx, this.onSessionEvent);
          }
          if (terminalEvent) {
            this.onInvocationEvent?.(terminalEvent);
            // AC: @dispatch-event-envelope ac-1 - Route invocation lifecycle through bus
            // AC: @multi-turn-session-lifecycle ac-14 — include turn_count in terminal payload
            // AC: @dispatch-event-payload ac-2 — adapter_id, resolved_adapter, runner
            // AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
            const terminalPayload: Record<string, unknown> = {
              ...terminalEvent,
              trigger: STATUS_TO_EVENT[entry.change.toStatus] ?? "task.ready",
              task_ref: terminalEvent.task_id ?? undefined,
              duration_ms: invocationResult?.durationMs ?? Date.now() - trackingRecord.startedAtMs,
              turn_count: invocationResult?.turnCount ?? 1,
              adapter_id: agent.adapter ?? adapterId,
              resolved_adapter: adapterId,
              ...(runnerId ? { runner: runnerId } : {}),
            };
            this._eventBus.emit({
              event_type: `invocation.${terminalEvent.type}`,
              source_type: "invocation_lifecycle",
              source_id: terminalEvent.session_id,
              payload: terminalPayload,
            });

            // AC: @dispatch-event-taxonomy ac-2 — Emit corresponding session.* event
            // AC: @dispatch-event-payload ac-3 — Session payload includes session_id,
            // agent_id, task_ref, duration_ms, terminal_reason, and work_summary
            this._emitSessionLifecycleEvent(
              terminalEvent,
              invocationResult,
              trackingRecord.startedAtMs,
            );
          }

          // AC: @dispatch-remote-branch-sync ac-first-push-sets-tracking,
          //     ac-subsequent-push, ac-push-non-fatal, ac-no-remote
          // Fire-and-forget: push dispatch branch to remote after invocation completes.
          // Does not block re-evaluation or queue drain.
          if (
            this.remoteSyncEnabled &&
            this.dispatchRemote &&
            terminalEvent?.type === "completed"
          ) {
            this._pushDispatchBranchAsync(workspace.metadata.canonicalBranch, entry.change.taskRef);
            // AC: @dispatch-remote-branch-sync ac-push-target-after-merge
            // When a reviewer invocation completes, push the integration target
            // (the reviewer may have merged into it).
            if (role === "reviewer") {
              void this._pushIntegrationTargetAsync(
                workspace.metadata.integrationTargetBranch,
                "post-merge",
              );
            }
          }
        })
        .then(async () => {
          if (!this.running) return;

          // Release the in-flight marker before re-evaluating tasks from disk so
          // follow-up reviewer/fix-cycle work for the same task can be requeued
          // immediately after the prior invocation completes.
          this.inFlightTaskKeys.delete(inFlightKey);
          releasedInFlightKey = true;

          // AC: @agent-dispatch-engine ac-23, ac-24
          // Re-evaluate all tasks from disk so the drain loop sees tasks that
          // reached a dispatchable state during the prior invocation (e.g.
          // pending_review tasks submitted by a worker).
          try {
            await this._evaluateAllTasks({ skipIfActive: true });
          } catch (err) {
            // AC: @agent-dispatch-engine ac-25
            console.warn(
              "[dispatch] Post-invocation re-evaluation failed, proceeding with existing queue:",
              err,
            );
          }

          // AC: @agent-dispatch-engine ac-27 — all drains go through _serializedDrain()
          try {
            await this._serializedDrain();
          } catch {
            // Best effort drain
          }
        })
        .finally(() => {
          if (!releasedInFlightKey) {
            this.inFlightTaskKeys.delete(inFlightKey);
          }
          this.runningInvocations.delete(invocationPromise);
          this.invocationAbortControllers.delete(abortController);
        });

      invocationRegistered = true;
      this.runningInvocations.add(invocationPromise);
      await invocationStarted;
      return true;
    } finally {
      if (!invocationRegistered) {
        this.inFlightTaskKeys.delete(inFlightKey);
      }
    }
  }

  // ─── Session Lifecycle Events ──────────────────────────────────────────────

  /**
   * Map invocation outcomes to session event types and emit session lifecycle events.
   *
   * Mapping:
   *   invocation completed (success) → session.ended
   *   invocation completed (timed_out) → session.ended (with timeout reason)
   *   invocation completed (failed) → session.ended (with failure reason)
   *   invocation completed (stalled) → session.idle_timeout
   *   invocation aborted (shutdown) → session.cancelled
   *
   * Session identity: session_id == invocation_id (same value).
   *
   * AC: @dispatch-event-taxonomy ac-2
   * AC: @dispatch-event-payload ac-3
   */
  private _emitSessionLifecycleEvent(
    terminalEvent: InvocationEvent,
    invocationResult: InvocationResult | null,
    startedAtMs: number,
  ): void {
    const outcome =
      invocationResult?.outcome ?? (terminalEvent.type === "completed" ? "success" : "failed");
    const durationMs = invocationResult?.durationMs ?? Date.now() - startedAtMs;

    // Determine session event type from invocation outcome
    let sessionEventType: string;
    let terminalReason: string;
    switch (outcome) {
      case "success":
        sessionEventType = "session.ended";
        terminalReason = "completed";
        break;
      case "timed_out":
        sessionEventType = "session.ended";
        terminalReason = "timed_out";
        break;
      case "failed": {
        // Distinguish abort (cancellation) from other failures
        const isAborted = invocationResult?.error?.includes("aborted by shutdown") ?? false;
        if (isAborted) {
          sessionEventType = "session.cancelled";
          terminalReason = "shutdown";
        } else {
          sessionEventType = "session.ended";
          terminalReason = invocationResult?.error ?? "failed";
        }
        break;
      }
      case "stalled":
        sessionEventType = "session.idle_timeout";
        terminalReason = invocationResult?.error ?? "no initial response";
        break;
      default:
        sessionEventType = "session.ended";
        terminalReason = "unknown";
        break;
    }

    // Build work summary from session metadata if available
    // AC: @dispatch-event-payload ac-3 — work_summary includes task notes, tasks completed, etc.
    const workSummary: Record<string, unknown> = {};
    if (invocationResult?.session) {
      const session = invocationResult.session;
      if (session.event_count !== undefined) {
        workSummary.event_count = session.event_count;
      }
      if (session.iteration_count !== undefined) {
        workSummary.iteration_count = session.iteration_count;
      }
      if (session.tasks_completed !== undefined) {
        workSummary.tasks_completed = session.tasks_completed;
      }
    }

    // AC: @dispatch-event-payload ac-3 — session payload fields
    const payload: Record<string, unknown> = {
      session_id: terminalEvent.session_id,
      agent_id: terminalEvent.agent_id,
      task_ref: terminalEvent.task_id ?? undefined,
      duration_ms: durationMs,
      terminal_reason: terminalReason,
      work_summary: workSummary,
    };

    this._eventBus.emit({
      event_type: sessionEventType,
      source_type: "invocation_lifecycle",
      source_id: terminalEvent.session_id,
      payload,
    });
  }

  // ─── Target Branch Sync ───────────────────────────────────────────────────

  /**
   * Initialize target sync config at engine start time. Resolves effective
   * remote sync setting, remote name, and base branch once so they don't
   * change mid-run. Then performs the initial sync before bootstrap.
   *
   * AC: @dispatch-remote-branch-sync ac-pull-target-on-start
   * AC: @dispatch-remote-branch-sync ac-no-remote
   */
  private async _initTargetSync(): Promise<void> {
    try {
      const resolvedConfig = await resolveDispatchWorkspaceConfig(this.projectDir);
      const { config } = await loadProjectConfig(this.projectDir, this.projectDir);
      this._syncIntervalMs = config.dispatch.sync_interval * 1000;

      // Detect remote
      const remotes = await this._listGitRemotes();
      const hasRemote = remotes.length > 0;
      this._remoteSyncEnabled = resolveDispatchRemoteSync(config, hasRemote);

      if (!this._remoteSyncEnabled) {
        // AC: @dispatch-remote-branch-sync ac-no-remote — skip silently
        return;
      }

      this._syncRemote = remotes[0] ?? null;
      this._configuredBaseBranch = resolvedConfig.baseBranch;
      await this._rebuildActiveTargetSet();

      if (!this._configuredBaseBranch || !this._syncRemote) {
        // Can't sync without a base branch or remote
        this._remoteSyncEnabled = false;
        return;
      }

      console.log(
        `[dispatch] Target sync enabled for ${this._resolveActiveTargets().join(", ")} via ${this._syncRemote} (interval: ${config.dispatch.sync_interval}s)`,
      );

      // AC: @dispatch-remote-branch-sync ac-pull-target-on-start — sync before bootstrap
      await this._syncAllActiveTargets();
    } catch (err) {
      console.error("[dispatch] Failed to initialize target sync:", err);
      // Non-fatal: engine continues without sync
    }
  }

  /**
   * Sync the integration target branch from remote using fetch + fast-forward merge.
   * Uses a running guard so slow fetches don't stack.
   *
   * AC: @dispatch-remote-branch-sync ac-pull-ff-only
   * AC: @dispatch-remote-branch-sync ac-transient-no-degrade
   * AC: @dispatch-remote-branch-sync ac-no-remote
   */
  async _syncTarget(branch?: string): Promise<TargetSyncResult> {
    const baseBranch = this._resolveBaseBranch(branch);
    // AC: @dispatch-remote-branch-sync ac-no-remote — skip when no remote
    if (!this._remoteSyncEnabled || !this._syncRemote || !baseBranch) {
      return "skipped";
    }

    // Running guard — if a sync is already in progress, skip
    if (this._targetSyncRunning.has(baseBranch)) {
      return "skipped";
    }

    this._targetSyncRunning.add(baseBranch);
    try {
      let mutationScope;
      try {
        mutationScope = await resolveDispatchIntegrationMutationScope(this.projectDir, baseBranch);
      } catch (err) {
        const { reason, kind } = this._classifyMutationScopeError(err, baseBranch);
        this._enterDegradedState(baseBranch, reason, kind);
        return "unsafe_target";
      }

      // Step 1: Fetch the target branch from remote
      const fetchResult = await runDispatchIntegrationTargetGit(
        this.projectDir,
        baseBranch,
        ["fetch", this._syncRemote, baseBranch],
        { timeout: 30_000 },
      );

      if (fetchResult.status !== 0) {
        // AC: @dispatch-remote-branch-sync ac-transient-no-degrade — warn and continue
        const nextFailureCount = (this._consecutiveSyncFailures.get(baseBranch) ?? 0) + 1;
        this._consecutiveSyncFailures.set(baseBranch, nextFailureCount);
        if (!this._firstSyncFailureTimestamps.has(baseBranch)) {
          this._firstSyncFailureTimestamps.set(baseBranch, Date.now());
        }
        const stderr = fetchResult.stderr?.trim() ?? "";
        console.warn(
          `[dispatch] Target sync fetch failed for ${baseBranch} (attempt ${nextFailureCount}): ${stderr}`,
        );

        // AC: @dispatch-remote-branch-sync ac-repeated-transient-escalation
        if (nextFailureCount >= 5) {
          const firstFailureAt = this._firstSyncFailureTimestamps.get(baseBranch) ?? Date.now();
          const failureDurationMs = Date.now() - firstFailureAt;
          console.warn(
            `[dispatch] Persistent connectivity issues for ${baseBranch}: ${nextFailureCount} consecutive sync failures over ${Math.round(failureDurationMs / 1000)}s`,
          );
        }

        // AC: @dispatch-remote-branch-sync ac-repeated-transient-no-degrade
        // Transient failures never enter degraded state
        return "transient_failure";
      }

      // After fetch, re-resolve the mutation scope with the now-available
      // remote ref so the occupied checkout is also checked for untracked /
      // ignored files that the upcoming fast-forward would overwrite. Without
      // this pre-check, the merge below would fail with a generic Git error
      // and be misclassified as divergence — sending the operator toward
      // resetting the branch instead of cleaning the blocking checkout.
      // AC: @dispatch-integration-mutation-scope ac-dirty-occupied-target-refusal-identifies-blocker
      // AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
      if (mutationScope.mutationCwd) {
        try {
          mutationScope = await resolveDispatchIntegrationMutationScope(
            this.projectDir,
            baseBranch,
            { mergeRef: `${this._syncRemote}/${baseBranch}` },
          );
        } catch (err) {
          const { reason, kind } = this._classifyMutationScopeError(err, baseBranch);
          this._enterDegradedState(baseBranch, reason, kind);
          return "unsafe_target";
        }
      }

      // Step 2: Fast-forward merge the target branch
      // AC: @dispatch-remote-branch-sync ac-pull-ff-only — no merge commits
      // AC: @dispatch-integration-mutation-scope ac-clean-occupied-target-checkout-is-valid-mutation-surface
      const mergeResult = mutationScope.mutationCwd
        ? await runGitInMutationSurface(
            mutationScope,
            ["merge", "--ff-only", `${this._syncRemote}/${baseBranch}`],
            { timeout: 10_000 },
          )
        : await fastForwardDispatchIntegrationBranch(
            this.projectDir,
            baseBranch,
            `${this._syncRemote}/${baseBranch}`,
          );

      if (mergeResult.status !== 0) {
        const stderr = mergeResult.stderr?.trim() ?? "";
        const stdout = mergeResult.stdout?.trim() ?? "";

        // AC: @dispatch-remote-branch-sync ac-divergence-enters-degraded
        // AC: @dispatch-remote-branch-sync ac-divergence-log-classification
        const reason = await this._classifyDivergence(stderr || stdout, baseBranch);
        this._enterDegradedState(baseBranch, reason, "divergence");
        return "diverged";
      }

      // Success
      this._consecutiveSyncFailures.set(baseBranch, 0);
      this._firstSyncFailureTimestamps.delete(baseBranch);
      this._targetSyncTimestamps.set(baseBranch, Date.now());

      // AC: @dispatch-remote-branch-sync ac-degraded-auto-recover
      if (this._degradedTargets.has(baseBranch)) {
        this._exitDegradedState(baseBranch);
      }

      const stdout = mergeResult.stdout?.trim() ?? "";
      if (stdout.includes("Already up to date") || stdout.includes("Already up-to-date")) {
        return "up_to_date";
      }

      console.log(`[dispatch] Target branch synced: ${this._syncRemote}/${baseBranch}`);
      return "synced";
    } finally {
      this._targetSyncRunning.delete(baseBranch);
    }
  }

  private async _syncAllActiveTargets(options: { staleOnly?: boolean } = {}): Promise<void> {
    const reviewerTargets = await this._activeReviewerTargets();
    for (const branch of this._resolveActiveTargets()) {
      // Always re-evaluate occupied-checkout-degraded targets so the periodic
      // sync can clear stale degraded state once the blocking worktree is
      // released. The staleness gate would otherwise pin the engine in degraded
      // state until sync_interval elapsed.
      // AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
      const isOccupiedCheckoutDegraded =
        this._degradedTargets.get(branch)?.kind === "occupied-checkout";
      if (options.staleOnly && !isOccupiedCheckoutDegraded && !this._isTargetSyncStale(branch)) {
        continue;
      }
      if (reviewerTargets.has(branch)) {
        continue;
      }

      try {
        await this._syncTarget(branch);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[dispatch] Target sync failed for ${branch}; continuing: ${message}`);
      }
    }
  }

  private async _resolveQueueEntryTargetBranch(
    entry: QueueEntry,
    taskLookup: Map<string, LoadedTask>,
    targetCache: Map<string, string>,
  ): Promise<string> {
    const configuredBaseBranch = this._resolveBaseBranch();
    if (!configuredBaseBranch) {
      return "";
    }

    const inlinePlanRef =
      typeof entry.change.task?.plan_ref === "string" ? entry.change.task.plan_ref.trim() : "";
    const task = taskLookup.get(entry.change.taskId) ?? entry.change.task;
    const taskPlanRef = typeof task?.plan_ref === "string" ? task.plan_ref.trim() : "";
    const planRef = inlinePlanRef || taskPlanRef;
    if (!planRef) {
      return configuredBaseBranch;
    }

    const cached = targetCache.get(planRef);
    if (cached) {
      return cached;
    }

    try {
      const ctx = await initContext(this.projectDir);
      const plan = await findPlanByRef(ctx, planRef);
      const resolvedBranch = typeof plan?.branch === "string" ? plan.branch.trim() : "";
      const targetBranch = resolvedBranch || configuredBaseBranch;
      targetCache.set(planRef, targetBranch);
      return targetBranch;
    } catch {
      targetCache.set(planRef, configuredBaseBranch);
      return configuredBaseBranch;
    }
  }

  /**
   * Classify a divergence based on the git merge --ff-only error output.
   * Distinguishes "local has unpushed merges" from "remote history was rewritten".
   * AC: @dispatch-remote-branch-sync ac-divergence-log-classification
   * AC: @dispatch-remote-branch-sync ac-divergence-log-resolution
   */
  private async _classifyDivergence(_mergeOutput: string, branch: string): Promise<string> {
    const remote = this._syncRemote;
    if (!remote || !branch) {
      return "Integration target divergence detected, but remote or branch context is unavailable.";
    }

    // Count commits local has that remote doesn't, and vice versa
    let localAhead = 0;
    let remoteAhead = 0;
    try {
      const aheadResult = await runDispatchIntegrationTargetGit(this.projectDir, branch, [
        "rev-list",
        "--count",
        `${remote}/${branch}..${branch}`,
      ]);
      localAhead = parseInt(aheadResult.stdout?.trim() ?? "0", 10);

      const behindResult = await runDispatchIntegrationTargetGit(this.projectDir, branch, [
        "rev-list",
        "--count",
        `${branch}..${remote}/${branch}`,
      ]);
      remoteAhead = parseInt(behindResult.stdout?.trim() ?? "0", 10);
    } catch {
      // If we can't determine counts, fall through to generic divergence message
    }

    // Case 1: Local has commits not on remote (unpushed merges from dispatcher)
    // This is the common case — the reviewer merged work locally and the push
    // to remote failed or hasn't happened yet, then remote advanced independently.
    if (localAhead > 0 && remoteAhead === 0) {
      return `Integration target '${branch}' has ${localAhead} unpushed local commit(s) not on ${remote}/${branch} (unpushed merges). Resolution: push the integration target to remote with 'git push ${remote} ${branch}', or if the local commits should be discarded, reset with 'git checkout ${branch} && git reset --hard ${remote}/${branch}'.`;
    }

    // Case 2: Remote has different history (force push / rewrite)
    // Either remote-only divergence (localAhead=0, remoteAhead>0) or mutual
    // divergence where local has commits AND remote was rewritten.
    if (localAhead === 0 && remoteAhead > 0) {
      return `Integration target '${branch}' has diverged from ${remote}/${branch} — remote history appears rewritten (force push). Resolution: verify the remote state is correct, then reset the local branch with 'git checkout ${branch} && git reset --hard ${remote}/${branch}'.`;
    }

    // Case 3: Mutual divergence — both local and remote have unique commits
    if (localAhead > 0 && remoteAhead > 0) {
      return `Integration target '${branch}' has diverged: ${localAhead} local unpushed commit(s) and ${remoteAhead} remote commit(s) not in local (unpushed merges combined with remote changes). Resolution: push local merges first with 'git push ${remote} ${branch}', or if the remote state is authoritative, reset with 'git checkout ${branch} && git reset --hard ${remote}/${branch}'.`;
    }

    // Fallback
    return `Integration target '${branch}' has diverged from ${remote}/${branch}. Fast-forward merge failed. Resolution: inspect the branch state and resolve manually — either push local changes or reset to match remote.`;
  }

  /**
   * Enter degraded state with a descriptive reason and classification.
   * AC: @dispatch-remote-branch-sync ac-divergence-enters-degraded
   * AC: @dispatch-remote-branch-sync ac-divergence-log-target
   * AC: @dispatch-remote-branch-sync ac-divergence-log-classification
   * AC: @dispatch-remote-branch-sync ac-divergence-log-resolution
   * AC: @dispatch-remote-branch-sync ac-degraded-status-broadcast
   * AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
   */
  private _enterDegradedState(
    branch: string,
    reason: string,
    kind: DegradedTargetKind = "other",
  ): void {
    const existing = this._degradedTargets.get(branch);
    if (existing) {
      // An occupied-checkout entry has the weakest exit condition: it can be
      // cleared by a no-op push once the blocking worktree is released. If a
      // later retry reveals a stricter failure (divergence or other unsafe
      // state), upgrade the kind and reason so the no-op-push clear path can
      // no longer fire against a stale classification. Other kinds keep their
      // existing entry; we never downgrade strictness, and we preserve
      // enteredAt so recovery duration tracking stays accurate.
      // AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
      if (existing.kind === "occupied-checkout" && kind !== "occupied-checkout") {
        this._degradedTargets.set(branch, {
          reason,
          enteredAt: existing.enteredAt,
          kind,
        });
        console.warn(
          `[dispatch] DEGRADED ${branch} kind upgraded ${existing.kind} → ${kind}: ${reason}`,
        );
      }
      return;
    }

    const enteredAt = new Date();
    this._degradedTargets.set(branch, { reason, enteredAt, kind });

    console.warn(`[dispatch] DEGRADED ${branch}: ${reason}`);

    // AC: @dispatch-remote-branch-sync ac-degraded-status-broadcast
    const event: SyncStateEvent = {
      type: "sync_state",
      branch,
      degraded: true,
      reason,
      enteredAt: enteredAt.toISOString(),
    };
    this.onSyncStateEvent?.(event);
  }

  /**
   * Exit degraded state on successful sync (auto-recovery).
   * AC: @dispatch-remote-branch-sync ac-degraded-auto-recover
   * AC: @dispatch-remote-branch-sync ac-degraded-recovery-logged
   * AC: @dispatch-remote-branch-sync ac-degraded-recovery-logged-duration
   * AC: @dispatch-remote-branch-sync ac-degraded-status-broadcast
   */
  private _exitDegradedState(branch: string): void {
    const degradedTarget = this._degradedTargets.get(branch);
    if (!degradedTarget) {
      return;
    }
    const durationMs = Date.now() - degradedTarget.enteredAt.getTime();

    // AC: @dispatch-remote-branch-sync ac-degraded-recovery-logged
    console.log(
      `[dispatch] Recovered from degraded state for integration target "${branch}" after ${Math.round(durationMs / 1000)}s.`,
    );

    this._degradedTargets.delete(branch);

    // AC: @dispatch-remote-branch-sync ac-degraded-status-broadcast
    const event: SyncStateEvent = {
      type: "sync_state",
      branch,
      degraded: false,
      reason: "",
      enteredAt: null,
      recoveredAfterMs: durationMs,
    };
    this.onSyncStateEvent?.(event);

    // AC: @dispatch-remote-branch-sync ac-degraded-auto-recover
    // AC: @dispatch-remote-branch-sync ac-degraded-recovery-requeues
    this._serializedDrain().catch((err) => {
      console.error("[dispatch] Post-recovery drain error:", err);
    });
  }

  private _getDegradedSnapshot(): DegradedSnapshot {
    const firstDegraded = this.getDegradedState()[0];
    return {
      active: firstDegraded !== undefined,
      reason: firstDegraded?.reason ?? "",
      enteredAt: firstDegraded?.enteredAt ?? null,
    };
  }

  /**
   * Check whether the last target sync is stale relative to the sync interval.
   * AC: @dispatch-remote-branch-sync ac-pull-target-before-provision
   */
  private _isTargetSyncStale(branch: string): boolean {
    if (this._syncIntervalMs <= 0) return false;
    const lastSyncTimestamp = this._targetSyncTimestamps.get(branch) ?? 0;
    if (lastSyncTimestamp === 0) return true;
    return Date.now() - lastSyncTimestamp > this._syncIntervalMs;
  }

  /**
   * Resolve active reviewer targets from in-flight invocation/workspace metadata.
   * AC: @dispatch-remote-branch-sync ac-pull-target-periodic-deferred
   */
  private async _activeReviewerTargets(): Promise<Set<string>> {
    const reviewerTaskRefs = new Set<string>();
    for (const record of this.activeInvocationDetails.values()) {
      if (record.role === "reviewer" && record.taskRef) {
        reviewerTaskRefs.add(record.taskRef);
      }
    }
    if (reviewerTaskRefs.size === 0) {
      return new Set();
    }

    const ctx = await initContext(this.projectDir);
    const records = await loadDispatchWorkspaceRegistry(ctx);
    const targets = new Set<string>();
    for (const record of records) {
      if (
        reviewerTaskRefs.has(record.task_ref) &&
        record.lifecycle_state !== "closed" &&
        record.integration.target_branch.trim().length > 0
      ) {
        targets.add(record.integration.target_branch.trim());
      }
    }
    return targets;
  }

  /**
   * List git remotes from the project directory, origin first.
   */
  private async _listGitRemotes(): Promise<string[]> {
    try {
      const result = await execFileAsync("git", ["remote"], {
        cwd: this.projectDir,
        env: buildDispatchGitEnv(),
        encoding: "utf-8",
      });
      if (!result.stdout) {
        return [];
      }
      const remotes = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .toSorted();
      const originFirst = remotes.filter((r) => r === "origin");
      const rest = remotes.filter((r) => r !== "origin");
      return [...originFirst, ...rest];
    } catch {
      return [];
    }
  }

  /**
   * Classify a mutation-scope failure into a degraded reason and kind.
   * Occupied-checkout failures are auto-recoverable once the blocking worktree
   * is released; other unsafe states require a real sync/push to clear.
   *
   * AC: @dispatch-integration-mutation-scope ac-dirty-occupied-target-refusal-identifies-blocker
   * AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
   */
  private _classifyMutationScopeError(
    err: unknown,
    branch: string,
  ): { reason: string; kind: DegradedTargetKind } {
    if (err instanceof DispatchWorkspaceError) {
      const reason = `${err.message} Resolution: ${err.suggestion}`;
      const kind: DegradedTargetKind =
        err.code === "occupied-checkout" ? "occupied-checkout" : "other";
      return { reason, kind };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return {
      reason: `Dispatch cannot determine a safe mutation surface for integration target "${branch}". Resolution: ${detail}`,
      kind: "other",
    };
  }

  /**
   * Get the current target sync state for external status queries.
   * AC: @dispatch-remote-branch-sync ac-degraded-status-api
   */
  getTargetSyncStatus(): {
    enabled: boolean;
    remote: string | null;
    baseBranch: string | null;
    activeTargets: string[];
    lastSyncTimestamp: number;
    consecutiveFailures: number;
    syncRunning: boolean;
    targetSyncTimestamps: Record<string, number>;
    targetConsecutiveFailures: Record<string, number>;
    syncRunningTargets: string[];
    degraded: {
      active: boolean;
      reason: string;
      enteredAt: string | null;
    };
    degradedTargets: Array<{
      branch: string;
      reason: string;
      enteredAt: string;
      kind: DegradedTargetKind;
    }>;
  } {
    const degraded = this._getDegradedSnapshot();
    const targetSyncTimestamps = Object.fromEntries(this._targetSyncTimestamps);
    const targetConsecutiveFailures = Object.fromEntries(this._consecutiveSyncFailures);
    return {
      enabled: this._remoteSyncEnabled ?? false,
      remote: this._syncRemote,
      baseBranch: this._configuredBaseBranch,
      activeTargets: this._resolveActiveTargets(),
      lastSyncTimestamp: Math.max(0, ...Object.values(targetSyncTimestamps)),
      consecutiveFailures: Math.max(0, ...Object.values(targetConsecutiveFailures)),
      syncRunning: this._targetSyncRunning.size > 0,
      targetSyncTimestamps,
      targetConsecutiveFailures,
      syncRunningTargets: [...this._targetSyncRunning].toSorted(),
      degraded: {
        active: degraded.active,
        reason: degraded.reason,
        enteredAt: degraded.enteredAt?.toISOString() ?? null,
      },
      degradedTargets: [...this._degradedTargets.entries()].map(([branch, state]) => ({
        branch,
        reason: state.reason,
        enteredAt: state.enteredAt.toISOString(),
        kind: state.kind,
      })),
    };
  }

  /**
   * Get the current degraded state. Convenience accessor for external consumers.
   * AC: @dispatch-remote-branch-sync ac-degraded-status-api
   */
  getDegradedState(): DegradedState {
    return [...this._degradedTargets.entries()].map(([branch, state]) => ({
      branch,
      reason: state.reason,
      enteredAt: state.enteredAt,
      kind: state.kind,
    }));
  }

  private async _rebuildActiveTargetSet(): Promise<void> {
    const nextTargets = new Set<string>();
    const configuredBaseBranch = this._configuredBaseBranch;
    if (configuredBaseBranch) {
      nextTargets.add(configuredBaseBranch);
    }

    const ctx = await initContext(this.projectDir);
    const records = await loadDispatchWorkspaceRegistry(ctx);
    for (const record of records) {
      if (record.lifecycle_state === "closed") continue;
      const branch = record.integration.target_branch.trim();
      if (branch.length > 0) {
        nextTargets.add(branch);
      }
    }

    this._activeTargets = nextTargets;
  }

  private async _addActiveTarget(branch: string): Promise<void> {
    if (!branch.trim()) return;
    this._activeTargets.add(branch);
    const configuredBaseBranch = this._configuredBaseBranch;
    if (configuredBaseBranch) {
      this._activeTargets.add(configuredBaseBranch);
    }
  }

  private async _removeActiveTargetIfOrphaned(branch: string): Promise<void> {
    const trimmedBranch = branch.trim();
    if (!trimmedBranch) return;
    if (trimmedBranch === this._configuredBaseBranch) {
      this._activeTargets.add(trimmedBranch);
      return;
    }

    const ctx = await initContext(this.projectDir);
    const records = await loadDispatchWorkspaceRegistry(ctx);
    const hasOpenWorkspace = records.some(
      (record) =>
        record.lifecycle_state !== "closed" && record.integration.target_branch === trimmedBranch,
    );
    if (!hasOpenWorkspace) {
      this._activeTargets.delete(trimmedBranch);
    }
    const configuredBaseBranch = this._configuredBaseBranch;
    if (configuredBaseBranch) {
      this._activeTargets.add(configuredBaseBranch);
    }
  }

  private async _loadWorkspaceTargetForTask(taskRef: string): Promise<string | null> {
    const ctx = await initContext(this.projectDir);
    const records = await loadDispatchWorkspaceRegistry(ctx);
    const record = records
      .filter((entry) => entry.task_ref === taskRef && entry.lifecycle_state !== "closed")
      .toSorted((a, b) => (a.timestamps.updated_at < b.timestamps.updated_at ? 1 : -1))[0];
    return record?.integration.target_branch ?? null;
  }
}
