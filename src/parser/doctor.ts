/**
 * Doctor command - unified health check for kspec
 *
 * Library layer that aggregates shadow branch, setup, and daemon status
 * into a unified DoctorReport. CLI command is in src/cli/commands/doctor.ts.
 *
 * AC: @doctor-command
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getGitRoot, getShadowStatus, isGitRepo, type ShadowStatus } from "./shadow.js";
import { getSetupStatus, hasAnyRenderedSkills, type SetupStatus } from "./setup-status.js";
import { getDaemonStatus, type DaemonStatus } from "./daemon-status.js";
import { findManifestInDir, readYamlFile } from "./yaml.js";
import { CONFIG_FILENAME } from "./config.js";
import type { Manifest } from "../schema/spec.js";

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
/**
 * Task storage section of doctor report
 */
export interface TaskStorageSection {
  checks: CheckResult[];
  format?: string;
  kyneticVersion?: string;
}

/**
 * Entity storage section of doctor report. Covers folder-backed plan, review,
 * and entity-scoped local resource storage (kynetic 1.2+).
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 */
export interface EntityStorageSection {
  checks: CheckResult[];
  kyneticVersion?: string;
  planFormat?: string;
  reviewFormat?: string;
  resourceFormat?: string;
}

export interface DoctorReport {
  /** Timestamp of report generation (ISO 8601) */
  generatedAt: string;
  /** Shadow branch status */
  shadow: ShadowSection;
  /** Setup status (hooks, skills, agents.md) */
  setup: SetupSection;
  /** Task storage status */
  taskStorage: TaskStorageSection;
  /** Entity (plan/review/resource) storage status */
  entityStorage: EntityStorageSection;
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
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const generatedAt = new Date().toISOString();

  // Initialize empty report
  const report: DoctorReport = {
    generatedAt,
    shadow: { initialized: false, checks: [] },
    setup: { checks: [] },
    taskStorage: { checks: [] },
    entityStorage: { checks: [] },
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
    getSetupStatus(projectRoot).catch(
      (err): SetupStatus => ({
        agent: { detected: "unknown", confidence: "low" },
        hooks: {
          supported: false,
          promptCheck: false,
          stop: false,
          preToolUse: false,
          guardsPresent: [],
        },
        skills: { total: 0, rendered: 0, drifted: 0 },
        plugin: { marketplaceRegistered: false, marketplaceHealthy: false, pluginEnabled: false },
        agentsMd: { exists: false, status: "missing" },
        seeding: { permissionsSeeded: false, memorySeeded: false },
        error: err instanceof Error ? err.message : String(err),
      }),
    ),
    getDaemonStatus().catch(
      (err): DaemonStatus => ({
        running: false,
        pid: null,
        port: null,
        uptime: null,
        healthReachable: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    ),
  ]);

  // Build setup section
  // AC: @doctor-command ac-setup-agent-hooks, ac-setup-skills-agents-md, ac-partial-init, ac-staleness-unknown
  // AC: @doctor-reports-actionable-state ac-skills-check-accurate, ac-skills-check-missing
  //     — gate the health verdict on hasAnyRenderedSkills, which scans every
  //     supported rendered-skill location (including plugin-provided core
  //     skills under .claude/plugins/kspec/skills). status.skills.rendered
  //     already reflects the same set, but hasAnyRenderedSkills gives a
  //     stable boolean signal for the warning path independent of the count.
  const anyRenderedSkills = await hasAnyRenderedSkills(projectRoot);
  buildSetupSection(report.setup, setupStatus, { anyRenderedSkills });

  // AC: @doctor-reports-actionable-state ac-config-scaffold-detected
  await buildProjectConfigCheck(report.setup, projectRoot);

  // AC: @doctor-reports-actionable-state ac-version-skew-detected
  await buildVersionSkewCheck(report.setup, projectRoot);

  // AC: @data-format-forward-compatibility ac-diagnostics-report-read-only
  await buildFormatVersionCheck(report.setup, projectRoot);

  // Build task storage section — check if project needs migration
  await buildTaskStorageSection(report.taskStorage, projectRoot);

  // Build entity (plan/review/resource) storage section
  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  await buildEntityStorageSection(report.entityStorage, projectRoot);

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
    message: status.branchExists ? "Shadow branch exists" : "Shadow branch does not exist",
    guidance: status.branchExists ? undefined : "Run `kspec init` to create shadow branch",
  });

  // Only check worktree if branch exists
  if (status.branchExists) {
    // Worktree exists check
    section.checks.push({
      name: "worktree-exists",
      severity: status.worktreeExists ? "ok" : "error",
      message: status.worktreeExists ? "Worktree directory exists" : "Worktree directory missing",
      guidance: status.worktreeExists
        ? undefined
        : "Run `kspec shadow repair` to recreate worktree",
    });

    // Worktree linked check
    if (status.worktreeExists) {
      section.checks.push({
        name: "worktree-linked",
        severity: status.worktreeLinked ? "ok" : "error",
        message: status.worktreeLinked
          ? "Worktree properly linked"
          : "Worktree not properly linked",
        guidance: status.worktreeLinked
          ? undefined
          : "Run `kspec shadow repair` to fix worktree link",
      });

      // AC: @artifacts-directory ac-doctor-checks
      // AC: @doctor-reports-actionable-state ac-all-actionable —
      //     name a specific setup subcommand/flag rather than generic
      //     `kspec setup`. `--force` re-runs the full setup pipeline
      //     including the artifacts-directory creation step, which is
      //     what a user needs when the directory was removed after
      //     initial setup completed.
      section.checks.push({
        name: "artifacts-dir",
        severity: status.artifactsDirExists ? "ok" : "warning",
        message: status.artifactsDirExists
          ? "Artifacts directory exists"
          : "Artifacts directory missing",
        guidance: status.artifactsDirExists
          ? undefined
          : "Run `kspec setup --force` to re-create .kspec/artifacts/ (or `mkdir -p .kspec/artifacts` to create it directly)",
      });
    }
  }
}

/**
 * Build setup section from SetupStatus
 * AC: @doctor-command ac-setup-agent-hooks, ac-setup-skills-agents-md, ac-partial-init, ac-staleness-unknown
 * AC: @doctor-reports-actionable-state ac-skills-check-accurate, ac-skills-check-missing
 */
function buildSetupSection(
  section: SetupSection,
  status: SetupStatus,
  options: { anyRenderedSkills: boolean },
): void {
  // Store metadata
  section.agentType = status.agent.detected;
  section.skillsRendered = status.skills.rendered;
  section.skillsDrifted = status.skills.drifted;
  section.agentsMdStatus = status.agentsMd.status;
  section.agentsMdGeneratedAt = status.agentsMd.generatedAt;

  // Agent type check
  // AC: @doctor-command ac-setup-agent-hooks
  // AC: @doctor-reports-actionable-state ac-all-actionable —
  //     name the specific `--agent` flag rather than generic setup, so
  //     the user knows exactly how to resolve an undetectable agent.
  section.checks.push({
    name: "agent-type",
    severity: status.agent.detected !== "unknown" ? "ok" : "warning",
    message:
      status.agent.detected !== "unknown"
        ? `Agent type: ${status.agent.detected} (${status.agent.confidence} confidence)`
        : "Agent type: unknown",
    guidance:
      status.agent.detected === "unknown"
        ? "Run `kspec setup --agent <claude-code|cline|droid|cursor|windsurf>` to set the agent type explicitly"
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

  // AC: @doctor-reports-actionable-state ac-all-actionable —
  //     name the specific `--agent` flag so setup re-runs the hook
  //     installation step for the detected agent, rather than leaving
  //     the user to guess which setup invocation repairs hooks.
  const hooksCheck: {
    severity: Severity;
    message: string;
    guidance?: string;
  } = status.hooks.supported
    ? {
        severity: hooksInstalled ? "ok" : "error",
        message: hooksInstalled
          ? `Hooks installed (prompt-check: ${status.hooks.promptCheck}, stop: ${status.hooks.stop}, guards: ${status.hooks.guardsPresent.length})`
          : "No hooks installed",
        guidance: hooksInstalled
          ? undefined
          : `Run \`kspec setup --agent ${status.agent.detected}\` to install hooks for ${status.agent.detected}`,
      }
    : {
        severity: "ok" as const,
        message:
          status.agent.detected === "droid"
            ? "Hooks not installed: droid hooks are not yet supported"
            : `Hooks not applicable for ${status.agent.detected}`,
        guidance: undefined,
      };

  section.checks.push({
    name: "hooks",
    severity: hooksCheck.severity,
    message: hooksCheck.message,
    guidance: hooksCheck.guidance,
  });

  // Skills check
  // AC: @doctor-command ac-setup-skills-agents-md
  // AC: @doctor-reports-actionable-state ac-skills-check-accurate —
  //     report healthy when ANY supported rendered-skill location contains
  //     kspec-managed skills (including plugin-provided core skills under
  //     .claude/plugins/kspec/skills). Relying only on status.skills.rendered
  //     caused a persistent false-positive warning on fully-set-up projects.
  // AC: @doctor-reports-actionable-state ac-skills-check-missing —
  //     warn only when none of the supported locations contain rendered
  //     skills, and name the re-render command.
  const anyRenderedSkills = options.anyRenderedSkills;
  if (!anyRenderedSkills) {
    section.checks.push({
      name: "skills",
      severity: "warning",
      message: "No rendered skills found in any supported location",
      guidance: "Run `kspec skill render` to re-render skills (or `kspec setup` for a full setup)",
    });
  } else if (status.skills.drifted > 0) {
    section.checks.push({
      name: "skills",
      severity: "warning",
      message: `${status.skills.rendered} skills rendered, ${status.skills.drifted} drifted`,
      guidance: "Run `kspec skill render --force` to re-render drifted skills",
    });
  } else {
    // AC: @doctor-reports-actionable-state ac-skills-check-accurate —
    //     the count reported here is the sum across every supported
    //     rendered-skill location (see getRenderedSkillLocations), which
    //     includes plugin-provided core skills under
    //     .claude/plugins/kspec/skills as well as agent-specific output
    //     directories. The message must not imply the count is
    //     agent-specific only — that was the original false claim.
    const renderedCount = status.skills.rendered;
    const suffix = renderedCount > 0 ? ` (${renderedCount} across supported locations)` : "";
    section.checks.push({
      name: "skills",
      severity: "ok",
      message: `Rendered skills present${suffix}`,
    });
  }

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
      // AC: @doctor-reports-actionable-state ac-all-actionable —
      //     every warning must name a concrete command the user can run.
      agentsMdSeverity = "warning";
      agentsMdMessage = "kspec-agents.md staleness could not be determined";
      agentsMdGuidance =
        "Run `kspec agents generate` to regenerate kspec-agents.md with a fresh hash";
      break;
    case "missing":
    default:
      // AC: @doctor-reports-actionable-state ac-all-actionable —
      //     name the specific `kspec agents generate` command, which
      //     creates kspec-agents.md directly, instead of the broader
      //     `kspec setup` pipeline.
      agentsMdSeverity = "error";
      agentsMdMessage = "kspec-agents.md does not exist";
      agentsMdGuidance = "Run `kspec agents generate` to create kspec-agents.md";
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
 * Build the scaffolded project config check.
 *
 * Checks whether `kspec.config.yaml` exists at the project root. This file is
 * scaffolded by `kspec setup` (first-time) and `kspec upgrade` (brings an
 * existing project up to date). The user-facing single-command resolution is
 * `kspec upgrade`; `kspec setup --force` is the lower-level fallback.
 *
 * AC: @doctor-reports-actionable-state ac-config-scaffold-detected — warns
 * when missing and names the scaffold command.
 */
async function buildProjectConfigCheck(section: SetupSection, projectRoot: string): Promise<void> {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  let exists = false;
  try {
    await fs.access(configPath);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    section.checks.push({
      name: "project-config",
      severity: "ok",
      message: `${CONFIG_FILENAME} present`,
    });
  } else {
    section.checks.push({
      name: "project-config",
      severity: "warning",
      message: `${CONFIG_FILENAME} is missing`,
      guidance: `Run \`kspec upgrade\` to scaffold ${CONFIG_FILENAME} (or \`kspec setup --force\` to re-scaffold)`,
    });
  }
}

/**
 * Build the version skew check.
 *
 * Compares the `lastKnownVersion` recorded in `.kspec/.setup-state.json`
 * (written by `kspec upgrade`) against the currently installed kspec package
 * version. A mismatch indicates the project has not been upgraded since the
 * kspec package was updated.
 *
 * When the state file is absent (pre-upgrade projects), no skew can be
 * detected — the check is reported as ok rather than warning, to avoid noise
 * on projects that have simply never run `kspec upgrade`.
 *
 * AC: @doctor-reports-actionable-state ac-version-skew-detected — warns when
 * skew is detected and names the upgrade command.
 */
async function buildVersionSkewCheck(section: SetupSection, projectRoot: string): Promise<void> {
  const statePath = path.join(projectRoot, ".kspec", ".setup-state.json");
  let lastKnownVersion: string | undefined;
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const state = JSON.parse(raw) as { lastKnownVersion?: unknown };
    if (typeof state.lastKnownVersion === "string" && state.lastKnownVersion.length > 0) {
      lastKnownVersion = state.lastKnownVersion;
    }
  } catch {
    // State file absent or unreadable; cannot detect skew.
  }

  let installedVersion: string | null = null;
  try {
    const { getKspecPackageVersion } = await import("../cli/commands/skill-install.js");
    installedVersion = await getKspecPackageVersion();
  } catch {
    installedVersion = null;
  }

  if (!lastKnownVersion) {
    // No baseline to compare against — report ok so this check never produces
    // a non-actionable warning on pre-upgrade projects. A missing scaffold
    // state is surfaced by the project-config check already.
    section.checks.push({
      name: "version-skew",
      severity: "ok",
      message: installedVersion
        ? `Installed kspec version: ${installedVersion} (no baseline recorded)`
        : "No version baseline recorded",
    });
    return;
  }

  if (installedVersion && lastKnownVersion !== installedVersion) {
    section.checks.push({
      name: "version-skew",
      severity: "warning",
      message: `Project initialized with kspec ${lastKnownVersion}, but ${installedVersion} is installed`,
      guidance: "Run `kspec upgrade` to bring this project up to the installed version",
    });
    return;
  }

  section.checks.push({
    name: "version-skew",
    severity: "ok",
    message: installedVersion
      ? `kspec version matches baseline (${installedVersion})`
      : `kspec version matches baseline (${lastKnownVersion})`,
  });
}

/**
 * Build the format-version ceiling check.
 *
 * The project health diagnostic is the sole surface exempt from the
 * format-version refusal in context initialization — doctor reads the
 * manifest directly (no initContext) and REPORTS a newer-than-supported or
 * unrecognized declared format version instead of refusing, naming both
 * versions with upgrade guidance. Read-only: nothing is modified.
 *
 * AC: @data-format-forward-compatibility ac-diagnostics-report-read-only
 */
async function buildFormatVersionCheck(section: SetupSection, projectRoot: string): Promise<void> {
  const specDir = path.join(projectRoot, ".kspec");
  const manifestPath = await findManifestInDir(specDir);
  if (!manifestPath) return;

  let rawManifest: unknown;
  try {
    rawManifest = await readYamlFile<unknown>(manifestPath);
  } catch {
    // Manifest unreadable — other checks surface that state.
    return;
  }

  const { describeFormatVersionIncompatibility, getRawDeclaredFormatVersion } =
    await import("./format-version.js");
  const incompatibility = describeFormatVersionIncompatibility(
    getRawDeclaredFormatVersion(rawManifest),
  );

  if (incompatibility) {
    section.checks.push({
      name: "format-version",
      severity: "error",
      message: `Project data format version "${incompatibility.declaredVersion}" is not supported by this kspec installation (maximum supported: "${incompatibility.maxSupportedVersion}")`,
      guidance: incompatibility.suggestion,
    });
    return;
  }

  const declared = getRawDeclaredFormatVersion(rawManifest);
  section.checks.push({
    name: "format-version",
    severity: "ok",
    message:
      declared === undefined
        ? "No declared format version (legacy manifest)"
        : `Format version ${JSON.stringify(declared)} is supported`,
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
      guidance: "Run `kspec serve start --detach` to start the daemon (optional)",
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
  // AC: @doctor-reports-actionable-state ac-all-actionable —
  //     every warning must name a concrete command the user can run.
  if (!status.healthReachable) {
    section.checks.push({
      name: "daemon-health",
      severity: "warning",
      message:
        "Health endpoint unreachable (daemon may be starting up or there may be a port conflict)",
      guidance:
        "Run `kspec serve restart` to restart the daemon, or `kspec serve status` to inspect",
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
 * Build task storage section by reading the manifest and checking the
 * storage format configuration.
 */
async function buildTaskStorageSection(
  section: TaskStorageSection,
  projectRoot: string,
): Promise<void> {
  const specDir = path.join(projectRoot, ".kspec");
  const manifestPath = await findManifestInDir(specDir);
  if (!manifestPath) return; // No manifest found — skip task storage checks

  let manifest: Manifest | null = null;
  try {
    manifest = await readYamlFile<Manifest>(manifestPath);
  } catch {
    // Manifest not readable — skip task storage checks
    return;
  }

  if (!manifest) return;

  const kyneticVersion = manifest.kynetic ?? "1.0";
  const format = manifest.task_storage?.format;
  section.kyneticVersion = kyneticVersion;
  section.format = format ?? undefined;

  if (format === "split") {
    section.checks.push({
      name: "task-storage-format",
      severity: "ok",
      message: "Task storage: split (per-task directories)",
    });
  } else {
    const majorMinor = parseFloat(kyneticVersion);
    if (majorMinor >= 1.1) {
      // Version >= 1.1 but no explicit split format — unusual but ok
      section.checks.push({
        name: "task-storage-format",
        severity: "warning",
        message: `Task storage format not explicitly set (kynetic: ${kyneticVersion})`,
        guidance: "Run `kspec task migrate` to set task_storage.format: split in your manifest",
      });
    } else {
      // Legacy project needs migration
      // AC: @doctor-reports-actionable-state ac-all-actionable —
      //     prefer the single-command upgrade path; task migrate is the
      //     lower-level fallback for users who only want to migrate storage.
      section.checks.push({
        name: "task-storage-format",
        severity: "error",
        message: `Legacy task storage detected (kynetic: ${kyneticVersion}, no split format)`,
        guidance:
          "Run `kspec upgrade` to bring this project up to the installed version (or `kspec task migrate` to only convert to per-task directory storage).",
      });
    }
  }
}

/**
 * Build entity (plan/review/resource) storage section by reading the
 * manifest and inspecting folder-storage declarations.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 */
async function buildEntityStorageSection(
  section: EntityStorageSection,
  projectRoot: string,
): Promise<void> {
  const specDir = path.join(projectRoot, ".kspec");
  const manifestPath = await findManifestInDir(specDir);
  if (!manifestPath) return;

  let manifest: Manifest | null = null;
  try {
    manifest = await readYamlFile<Manifest>(manifestPath);
  } catch {
    return;
  }
  if (!manifest) return;

  const { buildManifestStorageReport } = await import("./entity-storage-compatibility.js");
  const report = buildManifestStorageReport(manifest);

  section.kyneticVersion = report.kynetic;
  section.planFormat = report.planFormat;
  section.reviewFormat = report.reviewFormat;
  section.resourceFormat = report.resourceFormat;

  const recordDomain = (
    name: string,
    format: string | undefined,
    folderFormat: string,
    strictErr: ReturnType<typeof buildManifestStorageReport>["strictPlanIncompatibility"],
  ) => {
    if (format === folderFormat) {
      section.checks.push({
        name,
        severity: "ok",
        message: `${name}: ${folderFormat}`,
      });
    } else if (strictErr) {
      section.checks.push({
        name,
        severity: "warning",
        message: strictErr.message,
        guidance: strictErr.suggestion,
      });
    }
  };

  recordDomain(
    "plan-storage-format",
    report.planFormat,
    "folder",
    report.strictPlanIncompatibility,
  );
  recordDomain(
    "review-storage-format",
    report.reviewFormat,
    "folder",
    report.strictReviewIncompatibility,
  );
  recordDomain(
    "resource-storage-format",
    report.resourceFormat,
    "entity_scoped",
    report.strictResourceIncompatibility,
  );
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
  for (const check of report.taskStorage.checks) {
    if (check.severity === "error") count++;
  }
  for (const check of report.entityStorage.checks) {
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
  for (const check of report.taskStorage.checks) {
    if (check.severity === "warning") count++;
  }
  for (const check of report.entityStorage.checks) {
    if (check.severity === "warning") count++;
  }
  for (const check of report.daemon.checks) {
    if (check.severity === "warning") count++;
  }
  return count;
}
