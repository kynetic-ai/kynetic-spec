import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadProjectConfig } from "../parser/config.js";
import type { Agent } from "../schema/meta.js";
import type {
  DispatchWorkspaceBootstrapRoleState,
  DispatchWorkspaceMetadata,
  DispatchWorkspaceRole,
} from "./workspace.js";
import {
  normalizeDispatchBootstrapState,
  persistDispatchWorkspaceMetadata,
} from "./workspace.js";

export interface DispatchBootstrapStep {
  source: "dispatch" | "agent";
  name: string;
  run: string;
  roles?: Array<DispatchWorkspaceRole>;
  idempotent: boolean;
  allowTrackedChanges: boolean;
  reviewerRerunAllowed: boolean;
}

export interface EnsureWorkspaceBootstrapOptions {
  projectDir: string;
  workspaceDir: string;
  metadataPath: string;
  metadata: DispatchWorkspaceMetadata;
  role: DispatchWorkspaceRole;
  agent: Agent;
  env: Record<string, string>;
}

export interface EnsureWorkspaceBootstrapResult {
  metadata: DispatchWorkspaceMetadata;
  reused: boolean;
  ranSteps: boolean;
}

export class DispatchBootstrapError extends Error {
  suggestion: string;

  constructor(message: string, suggestion: string) {
    super(message);
    this.name = "DispatchBootstrapError";
    this.suggestion = suggestion;
  }
}

interface DependencyHealth {
  ok: boolean;
  reason: string | null;
  missingPackages: string[];
}

function runShell(
  cwd: string,
  command: string,
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-lc", command], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf-8",
    stdio: "pipe",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function trackedStatus(cwd: string): string {
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    },
  );
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

function summarizeOutput(stdout: string, stderr: string): string | null {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (!combined) return null;
  return combined.slice(0, 4000);
}

function hashConfig(steps: DispatchBootstrapStep[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        steps.map((step) => ({
          source: step.source,
          name: step.name,
          run: step.run,
          roles: step.roles ?? null,
          idempotent: step.idempotent,
          allowTrackedChanges: step.allowTrackedChanges,
          reviewerRerunAllowed: step.reviewerRerunAllowed,
        })),
      ),
    )
    .digest("hex");
}

function collectDirectDependencies(
  packageJson: Record<string, unknown>,
): string[] {
  const names = new Set<string>();
  for (const sectionName of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    const section = packageJson[sectionName];
    if (!section || typeof section !== "object") {
      continue;
    }
    for (const name of Object.keys(section as Record<string, unknown>)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function checkWorkspaceDependencies(workspaceDir: string): DependencyHealth {
  const packageJsonPath = path.join(workspaceDir, "package.json");
  const lockfilePath = path.join(workspaceDir, "package-lock.json");
  const nodeModulesDir = path.join(workspaceDir, "node_modules");

  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(lockfilePath)) {
    return { ok: true, reason: null, missingPackages: [] };
  }

  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return { ok: true, reason: null, missingPackages: [] };
  }

  if (!fs.existsSync(nodeModulesDir)) {
    return {
      ok: false,
      reason: "node_modules/ not found",
      missingPackages: collectDirectDependencies(packageJson),
    };
  }

  const missingPackages = collectDirectDependencies(packageJson).filter((packageName) => (
    !fs.existsSync(path.join(nodeModulesDir, ...packageName.split("/")))
  ));

  if (missingPackages.length > 0) {
    return {
      ok: false,
      reason: `node_modules missing direct dependencies: ${missingPackages.slice(0, 3).join(", ")}`,
      missingPackages,
    };
  }

  return { ok: true, reason: null, missingPackages: [] };
}

function implicitDependencyStep(workspaceDir: string): DispatchBootstrapStep | null {
  const dependencyHealth = checkWorkspaceDependencies(workspaceDir);
  if (dependencyHealth.ok) {
    return null;
  }

  return {
    source: "dispatch",
    name: "install-workspace-dependencies",
    run: "npm ci",
    idempotent: true,
    allowTrackedChanges: false,
    reviewerRerunAllowed: true,
  };
}

function resolveBootstrapSteps(
  agent: Agent,
  dispatchSteps: Array<{
    run: string;
    name?: string;
    roles?: Array<DispatchWorkspaceRole>;
    idempotent: boolean;
    allow_tracked_changes: boolean;
    reviewer_rerun_allowed: boolean;
  }>,
): DispatchBootstrapStep[] {
  const projectSteps = dispatchSteps.map((step, index) => ({
    source: "dispatch" as const,
    name: step.name ?? `dispatch-step-${index + 1}`,
    run: step.run,
    ...(step.roles ? { roles: step.roles } : {}),
    idempotent: step.idempotent,
    allowTrackedChanges: step.allow_tracked_changes,
    reviewerRerunAllowed: step.reviewer_rerun_allowed,
  }));
  const agentSteps = (agent.bootstrap?.steps ?? []).map((step, index) => ({
    source: "agent" as const,
    name: step.name ?? `agent-step-${index + 1}`,
    run: step.run,
    ...(step.roles ? { roles: step.roles } : {}),
    idempotent: step.idempotent ?? false,
    allowTrackedChanges: step.allow_tracked_changes ?? false,
    reviewerRerunAllowed: step.reviewer_rerun_allowed ?? false,
  }));
  return [...projectSteps, ...agentSteps];
}

function stepAppliesToRole(
  step: DispatchBootstrapStep,
  role: DispatchWorkspaceRole,
): boolean {
  return !step.roles || step.roles.includes(role);
}

function computeInvalidationReasons(
  state: DispatchWorkspaceBootstrapRoleState,
  canonicalBranchHead: string,
  configHash: string,
  dependencyStepRequired: boolean,
): string[] {
  const reasons: string[] = [];
  if (state.status === "failed") {
    reasons.push("prior-bootstrap-failed");
  }
  if (state.configHash && state.configHash !== configHash) {
    reasons.push("bootstrap-config-changed");
  }
  if (state.canonicalBranchHead && state.canonicalBranchHead !== canonicalBranchHead) {
    reasons.push("canonical-branch-head-changed");
  }
  if (dependencyStepRequired) {
    reasons.push("workspace-dependencies-missing");
  }
  return reasons;
}

async function persistMetadata(
  projectDir: string,
  metadataPath: string,
  metadata: DispatchWorkspaceMetadata,
): Promise<void> {
  await persistDispatchWorkspaceMetadata(projectDir, metadata);
}

function describeTrackedChangeFailure(step: DispatchBootstrapStep): string {
  return [
    `Bootstrap step "${step.name}" modified tracked files but allow_tracked_changes is false.`,
    "Mark the step with allow_tracked_changes: true only if tracked source mutations are intentional.",
  ].join(" ");
}

function updateBootstrapState(
  metadata: DispatchWorkspaceMetadata,
  role: DispatchWorkspaceRole,
  state: DispatchWorkspaceBootstrapRoleState,
): void {
  metadata.bootstrap = {
    ...state,
    lastRole: role,
    roleStates: {
      ...metadata.bootstrap.roleStates,
      [role]: state,
    },
  };
  metadata.bootstrapState = metadata.bootstrap;
}

export async function ensureWorkspaceBootstrap(
  options: EnsureWorkspaceBootstrapOptions,
): Promise<EnsureWorkspaceBootstrapResult> {
  const {
    projectDir,
    workspaceDir,
    metadataPath,
    role,
    agent,
    env,
  } = options;
  const { config } = await loadProjectConfig(projectDir, projectDir);
  const steps = resolveBootstrapSteps(agent, config.dispatch.bootstrap.steps);
  const dependencyStep = implicitDependencyStep(workspaceDir);
  const effectiveSteps = dependencyStep ? [dependencyStep, ...steps] : steps;
  const roleSteps = effectiveSteps.filter((step) => stepAppliesToRole(step, role));
  const configHash = hashConfig(effectiveSteps);
  const metadata: DispatchWorkspaceMetadata = structuredClone(options.metadata);
  metadata.bootstrap = normalizeDispatchBootstrapState(metadata.bootstrap);
  metadata.bootstrapState = metadata.bootstrap;
  const workerState = metadata.bootstrap.roleStates.worker;
  const reviewerState = metadata.bootstrap.roleStates.reviewer;
  const workerInvalidationReasons = computeInvalidationReasons(
    workerState,
    metadata.canonicalBranchHead,
    configHash,
    Boolean(dependencyStep),
  );
  const reviewerInvalidationReasons = computeInvalidationReasons(
    reviewerState,
    metadata.canonicalBranchHead,
    configHash,
    Boolean(dependencyStep),
  );
  const workerBootstrapSucceeded =
    workerState.status === "succeeded" &&
    workerInvalidationReasons.length === 0;
  const reviewerBootstrapSucceeded =
    reviewerState.status === "succeeded" &&
    reviewerInvalidationReasons.length === 0;
  const canReuseWorkerStateForReviewer =
    role === "reviewer" &&
    roleSteps.length === 0 &&
    workerBootstrapSucceeded;
  const invalidationReasons =
    role === "reviewer" && !reviewerBootstrapSucceeded && canReuseWorkerStateForReviewer
      ? workerInvalidationReasons
      : role === "reviewer"
        ? reviewerInvalidationReasons
        : workerInvalidationReasons;
  const bootstrapSucceeded =
    role === "worker" ? workerBootstrapSucceeded : reviewerBootstrapSucceeded;

  if (bootstrapSucceeded) {
    const state =
      role === "worker"
        ? {
            ...workerState,
            invalidationReasons: [],
            failureMessage: null,
          }
        : {
            ...reviewerState,
            invalidationReasons: [],
            failureMessage: null,
          };
    updateBootstrapState(metadata, role, state);
    metadata.healthStatus = "healthy";
    metadata.healthReason = null;
    metadata.updatedAt = new Date().toISOString();
    await persistMetadata(projectDir, metadataPath, metadata);
    return { metadata, reused: true, ranSteps: false };
  }

  if (canReuseWorkerStateForReviewer) {
    const reusedReviewerState: DispatchWorkspaceBootstrapRoleState = {
      status: "succeeded",
      configHash,
      canonicalBranchHead: metadata.canonicalBranchHead,
      lastRunAt: new Date().toISOString(),
      invalidationReasons: [],
      steps: [],
      failureMessage: null,
    };
    updateBootstrapState(metadata, role, reusedReviewerState);
    metadata.healthStatus = "healthy";
    metadata.healthReason = null;
    metadata.updatedAt = new Date().toISOString();
    await persistMetadata(projectDir, metadataPath, metadata);
    return { metadata, reused: true, ranSteps: false };
  }

  const rerunnableSteps =
    role === "reviewer"
      ? roleSteps.filter((step) => step.idempotent || step.reviewerRerunAllowed)
      : roleSteps;

  if (role === "reviewer" && !bootstrapSucceeded && rerunnableSteps.length !== roleSteps.length) {
    const blockedSteps = roleSteps
      .filter((step) => !rerunnableSteps.includes(step))
      .map((step) => step.name)
      .join(", ");
    updateBootstrapState(metadata, role, {
      status: "failed",
      configHash,
      canonicalBranchHead: metadata.canonicalBranchHead,
      lastRunAt: new Date().toISOString(),
      invalidationReasons,
      steps: [],
      failureMessage: `Reviewer bootstrap cannot safely rerun non-idempotent steps: ${blockedSteps}`,
    });
    metadata.healthStatus = "unhealthy";
    metadata.healthReason = metadata.bootstrap.failureMessage ?? null;
    metadata.updatedAt = new Date().toISOString();
    await persistMetadata(projectDir, metadataPath, metadata);
    const failureMessage = metadata.bootstrap.failureMessage ?? "Reviewer bootstrap rerun was rejected.";
    throw new DispatchBootstrapError(
      failureMessage,
      "Run or repair bootstrap from the worker workspace, or mark the affected reviewer-safe steps as idempotent/reviewer_rerun_allowed.",
    );
  }

  const executedSteps: DispatchWorkspaceMetadata["bootstrap"]["steps"] = [];
  for (const step of rerunnableSteps) {
    const beforeStatus = trackedStatus(workspaceDir);
    const result = runShell(workspaceDir, step.run, {
      ...env,
      KSPEC_DISPATCH_BOOTSTRAP_ROLE: role,
      KSPEC_DISPATCH_BOOTSTRAP_SOURCE: step.source,
      KSPEC_DISPATCH_BOOTSTRAP_STEP: step.name,
    });
    const afterStatus = trackedStatus(workspaceDir);
    const output = summarizeOutput(result.stdout, result.stderr);

    if (result.status !== 0) {
      const failureMessage = `Bootstrap step "${step.name}" failed with exit code ${result.status ?? "unknown"}.`;
      updateBootstrapState(metadata, role, {
        status: "failed",
        configHash,
        canonicalBranchHead: metadata.canonicalBranchHead,
        lastRunAt: new Date().toISOString(),
        invalidationReasons,
        steps: [
          ...executedSteps,
          {
            source: step.source,
            name: step.name,
            run: step.run,
            idempotent: step.idempotent,
            allowTrackedChanges: step.allowTrackedChanges,
            reviewerRerunAllowed: step.reviewerRerunAllowed,
            status: "failed",
            role,
            output,
          },
        ],
        failureMessage: `${failureMessage}${output ? ` Output: ${output}` : ""}`,
      });
      metadata.healthStatus = "unhealthy";
      metadata.healthReason = failureMessage;
      metadata.updatedAt = new Date().toISOString();
      await persistMetadata(projectDir, metadataPath, metadata);
      const failureMessageWithOutput =
        metadata.bootstrap.failureMessage ?? failureMessage;
      throw new DispatchBootstrapError(
        failureMessageWithOutput,
        "Inspect the failing bootstrap command, dependency prerequisites, and workspace health before retrying dispatch.",
      );
    }

    if (!step.allowTrackedChanges && beforeStatus !== afterStatus) {
      const failureMessage = describeTrackedChangeFailure(step);
      updateBootstrapState(metadata, role, {
        status: "failed",
        configHash,
        canonicalBranchHead: metadata.canonicalBranchHead,
        lastRunAt: new Date().toISOString(),
        invalidationReasons,
        steps: [
          ...executedSteps,
          {
            source: step.source,
            name: step.name,
            run: step.run,
            idempotent: step.idempotent,
            allowTrackedChanges: step.allowTrackedChanges,
            reviewerRerunAllowed: step.reviewerRerunAllowed,
            status: "failed",
            role,
            output: summarizeOutput(
              output ?? "",
              `Tracked status before:\n${beforeStatus}\nTracked status after:\n${afterStatus}`,
            ),
          },
        ],
        failureMessage,
      });
      metadata.healthStatus = "unhealthy";
      metadata.healthReason = failureMessage;
      metadata.updatedAt = new Date().toISOString();
      await persistMetadata(projectDir, metadataPath, metadata);
      throw new DispatchBootstrapError(
        failureMessage,
        "Update bootstrap configuration to opt in to tracked changes explicitly, or make the bootstrap step avoid tracked source mutations.",
      );
    }

    executedSteps.push({
      source: step.source,
      name: step.name,
      run: step.run,
      idempotent: step.idempotent,
      allowTrackedChanges: step.allowTrackedChanges,
      reviewerRerunAllowed: step.reviewerRerunAllowed,
      status: "succeeded",
      role,
      output,
    });
  }

  updateBootstrapState(metadata, role, {
    status: "succeeded",
    configHash,
    canonicalBranchHead: metadata.canonicalBranchHead,
    lastRunAt: new Date().toISOString(),
    invalidationReasons,
    steps: executedSteps,
    failureMessage: null,
  });
  metadata.healthStatus = "healthy";
  metadata.healthReason = null;
  metadata.updatedAt = new Date().toISOString();
  await persistMetadata(projectDir, metadataPath, metadata);
  return {
    metadata,
    reused: false,
    ranSteps: rerunnableSteps.length > 0,
  };
}
