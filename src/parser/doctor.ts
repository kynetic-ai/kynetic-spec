/**
 * Doctor command - unified health check for kspec
 *
 * Library layer that aggregates shadow branch, setup, and daemon status
 * into a unified DoctorReport. CLI command is in src/cli/commands/doctor.ts.
 *
 * AC: @doctor-command
 */

import { getGitRoot, getShadowStatus, isGitRepo, type ShadowStatus } from "./shadow.js";
import { getSetupStatus, type SetupStatus } from "./setup-status.js";
import { getDaemonStatus, type DaemonStatus } from "./daemon-status.js";

/**
 * Severity levels for health checks
 */
export type Severity = "ok" | "warning" | "error";

/**
 * Individual check result with severity
 */
export interface CheckResult {
  name: string;
  severity: Severity;
  message: string;
  /** Optional guidance for fixing issues */
  guidance?: string;
}

/**
 * Shadow branch section of doctor report
 * AC: @doctor-command ac-shadow-healthy
 */
export interface ShadowSection {
  initialized: boolean;
  checks: CheckResult[];
}

/**
 * Setup section of doctor report
 * AC: @doctor-command ac-setup-agent-hooks, ac-setup-skills-agents-md
 */
export interface SetupSection {
  checks: CheckResult[];
  agentType?: string;
  hooksInstalled?: boolean;
  skillsRendered?: number;
  skillsDrifted?: number;
  agentsMdStatus?: "current" | "stale" | "missing" | "unknown";
  agentsMdGeneratedAt?: string;
}

/**
 * Daemon section of doctor report
 * AC: @doctor-command ac-daemon-running, ac-daemon-not-running, ac-daemon-unreachable
 */
export interface DaemonSection {
  checks: CheckResult[];
  running?: boolean;
  pid?: number | null;
  port?: number | null;
  uptime?: number | null;
  healthReachable?: boolean;
}

/**
 * Overall verdict
 * AC: @doctor-command ac-overall-verdict
 */
export interface OverallVerdict {
  healthy: boolean;
  errorCount: number;
  warningCount: number;
}

/**
 * Complete doctor report
 * AC: @doctor-command ac-json-output
 */
export interface DoctorReport {
  /** Timestamp of report generation (ISO 8601) */
  generatedAt: string;
  /** Shadow branch status */
  shadow: ShadowSection;
  /** Setup status (hooks, skills, agents.md) */
  setup: SetupSection;
  /** Daemon status */
  daemon: DaemonSection;
  /** Overall health verdict */
  overall: OverallVerdict;
}

/**
 * Options for doctor report
 */
export interface DoctorOptions {
  /** Project root directory (defaults to detecting from cwd) */
  projectRoot?: string;
}

/**
 * Get a unified health check report for the kspec installation.
 *
 * AC: @doctor-command ac-no-git-repo — returns error if not in git repo
 * AC: @doctor-command ac-not-initialized — returns error if kspec not initialized
 * AC: @doctor-command ac-shadow-healthy — checks shadow branch health
 * AC: @doctor-command ac-setup-agent-hooks — checks hooks status
 * AC: @doctor-command ac-setup-skills-agents-md — checks skills and agents.md
 * AC: @doctor-command ac-daemon-running — checks daemon status
 * AC: @doctor-command ac-daemon-unreachable — detects unreachable health endpoint
 * AC: @doctor-command ac-daemon-not-running — daemon not running is warning
 * AC: @doctor-command ac-overall-verdict — computes healthy/issues verdict
 * AC: @doctor-command ac-partial-init — handles shadow ok but setup missing
 * AC: @doctor-command ac-staleness-unknown — handles unknown staleness
 *
 * @param cwd Current working directory
 * @param options Optional configuration
 */
export async function getDoctorReport(
  cwd: string,
  options: DoctorOptions = {}
): Promise<DoctorReport> {
  const generatedAt = new Date().toISOString();

  // Initialize empty report
  const report: DoctorReport = {
    generatedAt,
    shadow: { initialized: false, checks: [] },
    setup: { checks: [] },
    daemon: { checks: [] },
    overall: { healthy: false, errorCount: 0, warningCount: 0 },
  };

  // Step 1: Check for git repo
  // AC: @doctor-command ac-no-git-repo
  const projectRoot = options.projectRoot ?? getGitRoot(cwd);
  if (!projectRoot) {
    report.shadow.checks.push({
      name: "git-repo",
      severity: "error",
      message: "No git repository found",
      guidance: "Run `git init` to initialize a git repository",
    });
    report.overall.errorCount = 1;
    return report;
  }

  // Verify it's actually a git repo
  if (!(await isGitRepo(projectRoot))) {
    report.shadow.checks.push({
      name: "git-repo",
      severity: "error",
      message: "Not a git repository",
      guidance: "Run `git init` to initialize a git repository",
    });
    report.overall.errorCount = 1;
    return report;
  }

  // Step 2: Check shadow branch status
  // AC: @doctor-command ac-not-initialized, ac-shadow-healthy
  const shadowStatus = await getShadowStatus(projectRoot);
  buildShadowSection(report.shadow, shadowStatus);

  // If not initialized, return early with guidance
  // AC: @doctor-command ac-not-initialized
  if (!shadowStatus.exists) {
    report.shadow.checks.push({
      name: "initialized",
      severity: "error",
      message: "kspec is not initialized",
      guidance: "Run `kspec init` to initialize kspec in this project",
    });
    report.overall.errorCount = countErrors(report);
    report.overall.warningCount = countWarnings(report);
    return report;
  }

  // Shadow exists, run remaining checks in parallel
  // AC: @doctor-command ac-setup-agent-hooks, ac-setup-skills-agents-md, ac-daemon-running
  const [setupStatus, daemonStatus] = await Promise.all([
    getSetupStatus(projectRoot).catch((err): SetupStatus => ({
      agent: { detected: "unknown", confidence: "low" },
      hooks: { promptCheck: false, stop: false, preToolUse: false, guardsPresent: [] },
      skills: { total: 0, rendered: 0, drifted: 0 },
      agentsMd: { exists: false, status: "missing" },
      seeding: { permissionsSeeded: false, memorySeeded: false },
      error: err instanceof Error ? err.message : String(err),
    })),
    getDaemonStatus().catch((err): DaemonStatus => ({
      running: false,
      pid: null,
      port: null,
      uptime: null,
      healthReachable: false,
      error: err instanceof Error ? err.message : String(err),
    })),
  ]);

  // Build setup section
  // AC: @doctor-command ac-setup-agent-hooks, ac-setup-skills-agents-md, ac-partial-init, ac-staleness-unknown
  buildSetupSection(report.setup, setupStatus);

  // Build daemon section
  // AC: @doctor-command ac-daemon-running, ac-daemon-not-running, ac-daemon-unreachable
  buildDaemonSection(report.daemon, daemonStatus);

  // Compute overall verdict
  // AC: @doctor-command ac-overall-verdict
  report.overall.errorCount = countErrors(report);
  report.overall.warningCount = countWarnings(report);
  report.overall.healthy = report.overall.errorCount === 0;

  return report;
}

/**
 * Build shadow section from ShadowStatus
 * AC: @doctor-command ac-shadow-healthy
 */
function buildShadowSection(section: ShadowSection, status: ShadowStatus): void {
  section.initialized = status.exists;

  // Branch exists check
  section.checks.push({
    name: "branch-exists",
    severity: status.branchExists ? "ok" : "error",
    message: status.branchExists
      ? "Shadow branch exists"
      : "Shadow branch does not exist",
    guidance: status.branchExists ? undefined : "Run `kspec init` to create shadow branch",
  });

  // Only check worktree if branch exists
  if (status.branchExists) {
    // Worktree exists check
    section.checks.push({
      name: "worktree-exists",
      severity: status.worktreeExists ? "ok" : "error",
      message: status.worktreeExists
        ? "Worktree directory exists"
        : "Worktree directory missing",
      guidance: status.worktreeExists ? undefined : "Run `kspec shadow repair` to recreate worktree",
    });

    // Worktree linked check
    if (status.worktreeExists) {
      section.checks.push({
        name: "worktree-linked",
        severity: status.worktreeLinked ? "ok" : "error",
        message: status.worktreeLinked
          ? "Worktree properly linked"
          : "Worktree not properly linked",
        guidance: status.worktreeLinked ? undefined : "Run `kspec shadow repair` to fix worktree link",
      });
    }
  }
}

/**
 * Build setup section from SetupStatus
 * AC: @doctor-command ac-setup-agent-hooks, ac-setup-skills-agents-md, ac-partial-init, ac-staleness-unknown
 */
function buildSetupSection(section: SetupSection, status: SetupStatus): void {
  // Store metadata
  section.agentType = status.agent.detected;
  section.skillsRendered = status.skills.rendered;
  section.skillsDrifted = status.skills.drifted;
  section.agentsMdStatus = status.agentsMd.status;
  section.agentsMdGeneratedAt = status.agentsMd.generatedAt;

  // Agent type check
  // AC: @doctor-command ac-setup-agent-hooks
  section.checks.push({
    name: "agent-type",
    severity: status.agent.detected !== "unknown" ? "ok" : "warning",
    message: status.agent.detected !== "unknown"
      ? `Agent type: ${status.agent.detected} (${status.agent.confidence} confidence)`
      : "Agent type: unknown",
    guidance: status.agent.detected === "unknown"
      ? "Run `kspec setup` to configure agent integration"
      : undefined,
  });

  // Hooks check
  // AC: @doctor-command ac-setup-agent-hooks, ac-partial-init
  const hooksInstalled =
    status.hooks.promptCheck ||
    status.hooks.stop ||
    status.hooks.preToolUse ||
    status.hooks.guardsPresent.length > 0;
  section.hooksInstalled = hooksInstalled;

  section.checks.push({
    name: "hooks",
    severity: hooksInstalled ? "ok" : "error",
    message: hooksInstalled
      ? `Hooks installed (prompt-check: ${status.hooks.promptCheck}, stop: ${status.hooks.stop}, guards: ${status.hooks.guardsPresent.length})`
      : "No hooks installed",
    guidance: hooksInstalled
      ? undefined
      : "Run `kspec setup` to install hooks",
  });

  // Skills check
  // AC: @doctor-command ac-setup-skills-agents-md
  section.checks.push({
    name: "skills",
    severity: status.skills.rendered > 0
      ? (status.skills.drifted > 0 ? "warning" : "ok")
      : "warning",
    message: status.skills.rendered > 0
      ? `${status.skills.rendered} skills rendered${status.skills.drifted > 0 ? `, ${status.skills.drifted} drifted` : ""}`
      : "No skills rendered",
    guidance: status.skills.rendered === 0
      ? "Run `kspec setup` to render skills"
      : (status.skills.drifted > 0 ? "Run `kspec setup --force` to re-render drifted skills" : undefined),
  });

  // kspec-agents.md check
  // AC: @doctor-command ac-setup-skills-agents-md, ac-staleness-unknown
  let agentsMdSeverity: Severity;
  let agentsMdMessage: string;
  let agentsMdGuidance: string | undefined;

  switch (status.agentsMd.status) {
    case "current":
      agentsMdSeverity = "ok";
      agentsMdMessage = status.agentsMd.generatedAt
        ? `kspec-agents.md is current (generated: ${status.agentsMd.generatedAt})`
        : "kspec-agents.md is current";
      break;
    case "stale":
      agentsMdSeverity = "warning";
      agentsMdMessage = "kspec-agents.md is stale";
      agentsMdGuidance = "Run `kspec agents generate` to regenerate";
      break;
    case "unknown":
      // AC: @doctor-command ac-staleness-unknown
      agentsMdSeverity = "warning";
      agentsMdMessage = "kspec-agents.md staleness unknown";
      agentsMdGuidance = "Could not determine staleness (manifest or hash computation unavailable)";
      break;
    case "missing":
    default:
      agentsMdSeverity = "error";
      agentsMdMessage = "kspec-agents.md does not exist";
      agentsMdGuidance = "Run `kspec setup` to generate kspec-agents.md";
      break;
  }

  section.checks.push({
    name: "agents-md",
    severity: agentsMdSeverity,
    message: agentsMdMessage,
    guidance: agentsMdGuidance,
  });
}

/**
 * Build daemon section from DaemonStatus
 * AC: @doctor-command ac-daemon-running, ac-daemon-not-running, ac-daemon-unreachable
 */
function buildDaemonSection(section: DaemonSection, status: DaemonStatus): void {
  section.running = status.running;
  section.pid = status.pid;
  section.port = status.port;
  section.uptime = status.uptime;
  section.healthReachable = status.healthReachable;

  if (!status.running) {
    // AC: @doctor-command ac-daemon-not-running — warning, not error
    section.checks.push({
      name: "daemon-running",
      severity: "warning",
      message: "Daemon not running",
      guidance: "Run `kspec serve start --daemon` to start the daemon (optional)",
    });
    return;
  }

  // Daemon is running
  // AC: @doctor-command ac-daemon-running
  section.checks.push({
    name: "daemon-running",
    severity: "ok",
    message: `Daemon running (PID: ${status.pid})`,
  });

  // Port check
  if (status.port) {
    section.checks.push({
      name: "daemon-port",
      severity: "ok",
      message: `Port: ${status.port}`,
    });
  }

  // Uptime check
  if (status.uptime !== null) {
    const hours = Math.floor(status.uptime / 3600);
    const minutes = Math.floor((status.uptime % 3600) / 60);
    const seconds = Math.floor(status.uptime % 60);
    let uptimeStr: string;
    if (hours > 0) {
      uptimeStr = `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      uptimeStr = `${minutes}m ${seconds}s`;
    } else {
      uptimeStr = `${seconds}s`;
    }
    section.checks.push({
      name: "daemon-uptime",
      severity: "ok",
      message: `Uptime: ${uptimeStr}`,
    });
  }

  // Health endpoint check
  // AC: @doctor-command ac-daemon-unreachable
  if (!status.healthReachable) {
    section.checks.push({
      name: "daemon-health",
      severity: "warning",
      message: "Health endpoint unreachable",
      guidance: "Daemon may be starting up or there may be a port conflict",
    });
  } else {
    section.checks.push({
      name: "daemon-health",
      severity: "ok",
      message: "Health endpoint reachable",
    });
  }
}

/**
 * Count errors across all sections
 */
function countErrors(report: DoctorReport): number {
  let count = 0;
  for (const check of report.shadow.checks) {
    if (check.severity === "error") count++;
  }
  for (const check of report.setup.checks) {
    if (check.severity === "error") count++;
  }
  for (const check of report.daemon.checks) {
    if (check.severity === "error") count++;
  }
  return count;
}

/**
 * Count warnings across all sections
 */
function countWarnings(report: DoctorReport): number {
  let count = 0;
  for (const check of report.shadow.checks) {
    if (check.severity === "warning") count++;
  }
  for (const check of report.setup.checks) {
    if (check.severity === "warning") count++;
  }
  for (const check of report.daemon.checks) {
    if (check.severity === "warning") count++;
  }
  return count;
}
