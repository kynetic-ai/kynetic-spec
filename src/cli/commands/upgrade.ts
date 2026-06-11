/**
 * Upgrade command — brings a project from any previously-supported kspec version
 * to the currently installed version in a single invocation.
 *
 * AC: @single-command-version-upgrade (all ACs)
 */

import * as fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output } from "../output.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Confidence in the detected source version.
 *
 * AC: @single-command-version-upgrade ac-detects-skew, ac-source-version-fallback, ac-source-version-unknown
 */
export type VersionConfidence = "exact" | "approximate" | "unknown";

/**
 * Result of detecting the project's source version.
 */
export interface SourceVersionResult {
  version: string | null;
  confidence: VersionConfidence;
}

/**
 * Result of a single upgrade step.
 */
export interface UpgradeStepResult {
  name: string;
  /**
   * `rolled_back` is reported only by atomic step groups: when one step
   * in the group fails and the buffered writes from earlier steps are
   * discarded, those earlier steps are marked `rolled_back` so callers
   * and follow-up generators do not treat them as completed work.
   */
  status: "done" | "skipped" | "failed" | "rolled_back";
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Full result of the upgrade pipeline.
 */
export interface UpgradeResult {
  success: boolean;
  sourceVersion: string | null;
  targetVersion: string;
  confidence: VersionConfidence;
  isRefresh: boolean;
  noop: boolean;
  steps: UpgradeStepResult[];
  followUps: string[];
  /**
   * Release notes for every intervening version strictly after
   * sourceVersion and up to (and including) targetVersion.
   *
   * When the source version is unknown, release notes include every entry
   * up to targetVersion. When no RELEASE_NOTES.md file is found, this is
   * an empty array — the upgrade still succeeds.
   *
   * AC: @release-notes-accessible ac-upgrade-surfaces-notes
   */
  releaseNotes: Array<{ version: string; heading: string; markdown: string }>;
  /**
   * Short shadow-branch commit SHA captured BEFORE any mutation. Surfaced
   * so an operator can `git reset --hard <sha>` on the shadow worktree if
   * the upgrade needs to be rolled back. `null` when no shadow worktree
   * is configured for the project.
   *
   * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
   */
  previousShadowCommit: string | null;
}

// ─── Setup State ──────────────────────────────────────────────────────────────

/**
 * Extended setup state with lastKnownVersion field.
 * Reads/writes the same .setup-state.json used by setup-defaults.ts.
 */
interface SetupState {
  defaultsSeeded?: boolean;
  defaultsSeededAt?: string;
  scaffoldedItems?: Array<{
    type: "agent" | "convention";
    id: string;
    _ulid?: string;
  }>;
  lastKnownVersion?: string;
}

const SETUP_STATE_FILE = ".setup-state.json";

async function readSetupState(specDir: string): Promise<SetupState> {
  const statePath = path.join(specDir, SETUP_STATE_FILE);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw) as SetupState;
  } catch {
    return {};
  }
}

async function writeSetupState(specDir: string, state: SetupState): Promise<void> {
  const statePath = path.join(specDir, SETUP_STATE_FILE);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ─── Version Detection ────────────────────────────────────────────────────────

/**
 * Get the currently installed kspec version from package.json.
 */
async function getTargetVersion(): Promise<string> {
  const { getKspecPackageVersion } = await import("./skill-install.js");
  const version = await getKspecPackageVersion();
  if (!version) {
    throw new Error("Could not determine installed kspec version from package.json");
  }
  return version;
}

/**
 * Detect the project's source version.
 *
 * Priority:
 * 1. Read lastKnownVersion from state file → exact confidence
 * 2. Infer from project state probes → approximate confidence
 * 3. Unknown → run full pipeline as safety net
 *
 * AC: @single-command-version-upgrade ac-detects-skew
 * AC: @single-command-version-upgrade ac-source-version-fallback
 * AC: @single-command-version-upgrade ac-source-version-unknown
 */
export async function detectSourceVersion(
  specDir: string,
  projectDir: string,
): Promise<SourceVersionResult> {
  // Preferred path: read from state file
  const state = await readSetupState(specDir);
  if (state.lastKnownVersion) {
    return { version: state.lastKnownVersion, confidence: "exact" };
  }

  // Fallback: infer from project state probes
  return inferVersionFromProbes(specDir, projectDir);
}

/**
 * Infer a source version from observable project state.
 *
 * Probes (each maps to a bounded version range):
 * - task_storage.format field in manifest → "split" means >= 0.9
 * - kynetic manifest version field → "1.1" means >= 0.9
 * - Presence of kspec.config.yaml → means >= 0.11
 * - Presence of rendered skills directory → means >= 0.8
 * - Presence of review-plan rendered skill → means >= 0.10
 *
 * The inferred version is the newest version consistent with all probe results.
 * When no probes are conclusive, or when probes are mutually contradictory,
 * returns unknown.
 *
 * AC: @single-command-version-upgrade ac-source-version-fallback
 */
async function inferVersionFromProbes(
  specDir: string,
  projectDir: string,
): Promise<SourceVersionResult> {
  const { CONFIG_FILENAME } = await import("../../parser/config.js");

  // Each probe records a version range [minVersion, maxVersion] indicating
  // what project version the observed state is consistent with.
  // If probes contradict (one requires >= X while another caps at < X),
  // the project state is unrecognizable → report unknown.
  interface ProbeResult {
    minVersion: string;
    maxVersion: string; // inclusive upper bound for this probe's era
  }
  const probeResults: ProbeResult[] = [];

  // Track whether any versioned probe matched (probes 2-5).
  // Merely having .kspec/ exist is not enough — the project state must
  // match at least one recognizable version range.
  let versionedProbeMatched = false;

  // Probe 1: Does the .kspec/ directory exist at all?
  if (!existsSync(specDir)) {
    return { version: null, confidence: "unknown" };
  }

  // Probe 2: Check manifest for task_storage.format and kynetic version
  const { findManifestInDir } = await import("../../parser/yaml.js");
  const manifestPath = await findManifestInDir(specDir);
  try {
    if (!manifestPath) throw new Error("no manifest");
    const yaml = await import("yaml");
    const raw = await fs.readFile(manifestPath, "utf-8");
    const manifest = yaml.parse(raw);
    if (manifest) {
      const kyneticVer = manifest.kynetic || manifest.kynetic_spec;
      // AC: @data-format-forward-compatibility ac-upgrade-refuses-newer
      // Defense in depth: a declared version above the maximum supported is a
      // newer-than-supported project, NOT an old-era one. Without this check
      // it would fall into the 0.1.0-0.8.99 bucket below (or the run-everything
      // "unknown" safety net) and the pipeline would execute migrations against
      // newer-format data. The user-visible CLI refusal is owned by the
      // context-initialization ceiling check (initContext throws before
      // detectSourceVersion on the runUpgradePipeline path); this throw covers
      // callers that reach probe inference without initContext.
      const { describeFormatVersionIncompatibility, FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE } =
        await import("../../parser/format-version.js");
      const ceilingErr = describeFormatVersionIncompatibility(kyneticVer);
      if (ceilingErr?.code === FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE) {
        throw ceilingErr;
      }
      if (kyneticVer === "1.2") {
        // kynetic 1.2 introduces folder-backed plan/review/resource storage
        probeResults.push({ minVersion: "0.14.0", maxVersion: "99.99.99" });
        versionedProbeMatched = true;
      } else if (kyneticVer === "1.1") {
        // kynetic 1.1 was introduced in 0.9
        probeResults.push({ minVersion: "0.9.0", maxVersion: "99.99.99" });
        versionedProbeMatched = true;
      } else if (kyneticVer && kyneticVer !== "1.0") {
        // Unknown manifest version — caps the project at < 0.9 for consistency
        // checking, but does NOT count as a positive versioned probe on its
        // own. A project with only an unknown manifest and no other probes is
        // unrecognizable. A project with an unknown manifest AND a newer probe
        // (like kspec.config.yaml) creates a contradiction → unknown.
        probeResults.push({ minVersion: "0.1.0", maxVersion: "0.8.99" });
      } else if (kyneticVer === "1.0") {
        // kynetic 1.0 caps at < 0.9
        probeResults.push({ minVersion: "0.1.0", maxVersion: "0.8.99" });
      }
      if (manifest.task_storage?.format === "split") {
        probeResults.push({ minVersion: "0.9.0", maxVersion: "99.99.99" });
        versionedProbeMatched = true;
      }
    }
  } catch (err) {
    // AC: @data-format-forward-compatibility ac-upgrade-refuses-newer
    // The newer-than-supported refusal must escape — only read/parse
    // failures count as an "old project" indicator.
    const { isDeterministicFormatVersionIncompatibility } =
      await import("../../parser/format-version.js");
    if (isDeterministicFormatVersionIncompatibility(err)) {
      throw err;
    }
    // Manifest unreadable — counts as "old project" indicator
  }

  // Probe 3: Check for kspec.config.yaml
  const configPath = path.join(projectDir, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    probeResults.push({ minVersion: "0.11.0", maxVersion: "99.99.99" });
    versionedProbeMatched = true;
  }

  // Probe 4: Check for rendered skills directory
  // Must be an actual directory — a regular file at this path is corrupted state,
  // not a recognizable skills layout. Only directories count as evidence.
  const agentsSkillsDir = path.join(projectDir, ".agents", "skills");
  let agentsSkillsDirIsDir = false;
  try {
    agentsSkillsDirIsDir = statSync(agentsSkillsDir).isDirectory();
  } catch {
    // Path doesn't exist — not a match
  }
  if (agentsSkillsDirIsDir) {
    probeResults.push({ minVersion: "0.8.0", maxVersion: "99.99.99" });
    versionedProbeMatched = true;
  }

  // Probe 5: Check for review-plan skill (added in 0.10)
  // Skills are rendered as directories with SKILL.md inside
  const reviewPlanSkill = path.join(agentsSkillsDir, "kspec-review-plan", "SKILL.md");
  if (existsSync(reviewPlanSkill)) {
    probeResults.push({ minVersion: "0.10.0", maxVersion: "99.99.99" });
    versionedProbeMatched = true;
  }

  // AC: @single-command-version-upgrade ac-source-version-unknown
  // When no versioned probe matched, the project state is unrecognizable.
  // Report unknown and let the pipeline run everything as a safety net.
  if (!versionedProbeMatched) {
    return { version: null, confidence: "unknown" };
  }

  // Check for mutual consistency: the global lower bound must not exceed
  // any probe's upper bound. If it does, the probes contradict each other
  // (e.g., manifest says old era but config file says new era).
  let globalMin = "0.1.0";
  let globalMax = "99.99.99";
  for (const probe of probeResults) {
    globalMin = bumpIfHigher(globalMin, probe.minVersion);
    globalMax = bumpIfLower(globalMax, probe.maxVersion);
  }

  // If the intersection is empty (min > max), probes are contradictory
  if (compareSemver(globalMin, globalMax) > 0) {
    return { version: null, confidence: "unknown" };
  }

  return { version: globalMin, confidence: "approximate" };
}

/**
 * Simple semver comparison — returns the higher of two version strings.
 */
function bumpIfHigher(current: string, candidate: string): string {
  return compareSemver(candidate, current) > 0 ? candidate : current;
}

/**
 * Simple semver comparison — returns the lower of two version strings.
 */
function bumpIfLower(current: string, candidate: string): string {
  return compareSemver(candidate, current) < 0 ? candidate : current;
}

/**
 * Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(a: string, b: string): number {
  const ap = a.split(".").map(Number);
  const bp = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (ap[i] || 0) - (bp[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ─── Upgrade Pipeline ─────────────────────────────────────────────────────────

/**
 * Run the full upgrade pipeline.
 *
 * AC: @single-command-version-upgrade ac-runs-task-storage-migration
 * AC: @single-command-version-upgrade ac-rerenders-skills
 * AC: @single-command-version-upgrade ac-regenerates-agents-file
 * AC: @single-command-version-upgrade ac-restores-gitignore-entries
 * AC: @single-command-version-upgrade ac-idempotent-when-current
 * AC: @single-command-version-upgrade ac-reports-skew, ac-reports-manual-follow-ups
 * AC: @single-command-version-upgrade ac-dry-run-reports, ac-dry-run-no-writes
 */
export async function runUpgradePipeline(
  projectDir: string,
  options: { dryRun?: boolean; force?: boolean },
): Promise<UpgradeResult> {
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const steps: UpgradeStepResult[] = [];
  const followUps: string[] = [];

  // Determine versions
  const targetVersion = await getTargetVersion();

  const { initContext } = await import("../../parser/index.js");
  const ctx = await initContext();

  if (!ctx.manifestPath || !ctx.specDir) {
    throw new Error("No kspec project found. Run 'kspec init' first to initialize a project.");
  }

  const source = await detectSourceVersion(ctx.specDir, projectDir);

  // Capture the shadow HEAD commit BEFORE any mutation so an operator can
  // roll back via `git reset --hard <sha>` if the upgrade leaves the project
  // in an unexpected state. Surfaced in the result regardless of whether
  // the upgrade applies changes.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  const previousShadowCommit = await readShadowHeadCommit(ctx.shadow);

  // AC: @single-command-version-upgrade ac-idempotent-when-current
  const isCurrent = source.version === targetVersion && source.confidence === "exact";
  const isRefresh = source.version === targetVersion && source.confidence === "approximate";

  if (isCurrent && !force) {
    return {
      success: true,
      sourceVersion: source.version,
      targetVersion,
      confidence: source.confidence,
      isRefresh: false,
      noop: true,
      steps: [],
      followUps: [],
      // Already current — no intervening release notes to surface.
      // AC: @release-notes-accessible ac-upgrade-surfaces-notes
      releaseNotes: [],
      previousShadowCommit,
    };
  }

  // ─── Pipeline-wide safety preflight ──────────────────────────────────
  // The protected-project tripwire (KSPEC_PROTECTED_PROJECT_PATHS) must
  // gate EVERY executing upgrade step, not just the plan/review/manifest
  // storage block. A failure inside `runAtomicStorageMigration` previously
  // returned a `failed` "Storage migration safety preflight" step but the
  // pipeline still fell through to `runBackfillCoreSkillsStep` and the
  // downstream skill / agents / gitignore / scaffold / version-record
  // steps. Those steps write to `.kspec/`, `.agents/`, the project
  // gitignore, and the shadow branch — exactly the mutations the tripwire
  // exists to refuse. Hoisting the check here closes that bypass: when an
  // operator points the env variable at a protected root, no executing
  // upgrade step touches disk.
  //
  // Dry-runs are intentionally exempt — the tripwire only refuses writes
  // so operators can still preview what a migration would do against a
  // protected target.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  if (!dryRun) {
    try {
      const { assertSafeMigrationTarget } = await import("../../parser/migration-safety.js");
      assertSafeMigrationTarget(projectDir, ctx.specDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const skipMessage = "skipped — protected project tripwire refused executing upgrade";
      // Synthesise step records for every named pipeline step so JSON
      // consumers and the rendered console output see the same shape they
      // would on a normal upgrade — just with every mutation explicitly
      // accounted for as `skipped`. The order matches the executing-run
      // pipeline order below.
      const skippedPipelineSteps: UpgradeStepResult[] = [
        { name: "Storage migration safety preflight", status: "failed", message },
        { name: "Task storage migration", status: "skipped", message: skipMessage },
        { name: "Plan storage folder migration", status: "skipped", message: skipMessage },
        { name: "Review storage folder migration", status: "skipped", message: skipMessage },
        { name: "Storage manifest (kynetic 1.2)", status: "skipped", message: skipMessage },
        { name: "Backfill core skills", status: "skipped", message: skipMessage },
        { name: "Re-render skills", status: "skipped", message: skipMessage },
        { name: "Regenerate agent instructions", status: "skipped", message: skipMessage },
        { name: "Restore gitignore entries", status: "skipped", message: skipMessage },
        { name: "Scaffold missing files", status: "skipped", message: skipMessage },
        { name: "Record version", status: "skipped", message: skipMessage },
      ];
      return {
        success: false,
        sourceVersion: source.version,
        targetVersion,
        confidence: source.confidence,
        isRefresh,
        noop: false,
        steps: skippedPipelineSteps,
        followUps: [],
        releaseNotes: [],
        previousShadowCommit,
      };
    }
  }

  // ─── Step 1: Task storage migration ─────────────────────────────────
  // AC: @single-command-version-upgrade ac-runs-task-storage-migration
  let taskMigrationOk = true;
  try {
    const migrationResult = await runTaskStorageMigrationStep(ctx, dryRun);
    steps.push(migrationResult);
    if (migrationResult.status === "failed") {
      taskMigrationOk = false;
    }
    if (migrationResult.status === "done") {
      const count = (migrationResult.details?.migrated as number) || 0;
      if (count > 0) {
        followUps.push(`Task storage: ${count} task(s) migrated to per-task directory format`);
      }
    }
  } catch (err) {
    taskMigrationOk = false;
    steps.push({
      name: "Task storage migration",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── Atomic storage migration block (plan + review + manifest) ──────
  // Plan-folder, review-folder, and manifest promotion are buffered into
  // a single logical mutation: the writes are isolated via `runWithBuffer`
  // (nested calls inside `applyPlanMigration` / `applyReviewMigration` /
  // the manifest writer reuse the outer buffer instead of flushing their
  // own), and the shadow commit happens once after the buffer flushes.
  //
  // If any step fails (partial-layout guard, validation, etc.), the
  // buffer discards everything that was written by earlier steps, so a
  // failed upgrade cannot leave behind a half-migrated project where the
  // plan folders exist but the manifest still says kynetic 1.1.
  //
  // `taskMigrationOk` gates the manifest promotion: a failed task
  // migration step must NOT allow `kynetic: "1.2"` /
  // `task_storage.format: split` to land on disk. The atomic block runs
  // the plan/review steps for diagnostic output, but the manifest step
  // skips with a clear message when the task migration above failed.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  // AC: @entity-folder-migration-and-compatibility-1 ac-migration-preserves-record-identity-and-unknown-fields
  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  // AC: @entity-folder-migration-and-compatibility-1 ac-new-projects-declare-folder-storage
  const storageSteps = await runAtomicStorageMigration(
    ctx,
    projectDir,
    dryRun,
    force,
    taskMigrationOk,
  );
  for (const storageStep of storageSteps) {
    steps.push(storageStep);
    if (storageStep.status === "done") {
      if (storageStep.name === "Plan storage folder migration") {
        const migrated = (storageStep.details?.migrated as number) || 0;
        if (migrated > 0) {
          followUps.push(`Plan storage: ${migrated} plan(s) migrated to folder-backed layout`);
        }
      } else if (storageStep.name === "Review storage folder migration") {
        const migrated = (storageStep.details?.migrated as number) || 0;
        if (migrated > 0) {
          followUps.push(`Review storage: ${migrated} review(s) migrated to folder-backed layout`);
        }
      }
    }
  }

  // ─── Step 2: Backfill missing core skills ────────────────────────────
  // AC: @single-command-version-upgrade ac-rerenders-skills
  // Core skills introduced in newer releases must be installed into
  // project meta before re-rendering, otherwise the render step only
  // operates on skills that already exist and silently skips new ones.
  try {
    const backfillResult = await runBackfillCoreSkillsStep(projectDir, dryRun);
    steps.push(backfillResult);
    if (backfillResult.status === "done") {
      const installed = (backfillResult.details?.installed as number) || 0;
      if (installed > 0) {
        followUps.push(
          `Core skills: ${installed} missing skill(s) restored — review .kspec/skills/ for changes`,
        );
      }
    }
  } catch (err) {
    steps.push({
      name: "Backfill core skills",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── Step 3: Re-render skills ───────────────────────────────────────
  // AC: @single-command-version-upgrade ac-rerenders-skills
  try {
    const skillResult = await runRerenderSkillsStep(projectDir, dryRun);
    steps.push(skillResult);
    if (skillResult.status === "done") {
      const renderedCount = (skillResult.details?.rendered as number) || 0;
      const removedCount = (skillResult.details?.removed as number) || 0;
      const parts: string[] = [];
      if (renderedCount > 0) parts.push(`${renderedCount} re-rendered`);
      if (removedCount > 0) parts.push(`${removedCount} obsolete removed`);
      if (parts.length > 0) {
        followUps.push(`Skills: ${parts.join(", ")} — review .agents/skills/ for changes`);
      }
    }
  } catch (err) {
    steps.push({
      name: "Re-render skills",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── Step 4: Regenerate agents file ─────────────────────────────────
  // AC: @single-command-version-upgrade ac-regenerates-agents-file
  try {
    const agentsResult = await runRegenerateAgentsStep(projectDir, dryRun);
    steps.push(agentsResult);
    if (agentsResult.status === "done" && !agentsResult.details?.skipped) {
      followUps.push("Agent instructions: kspec-agents.md regenerated — review for changes");
    }
  } catch (err) {
    steps.push({
      name: "Regenerate agent instructions",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── Step 5: Restore gitignore entries ──────────────────────────────
  // AC: @single-command-version-upgrade ac-restores-gitignore-entries
  try {
    const gitignoreResult = await runGitignoreRepairStep(projectDir, dryRun);
    steps.push(gitignoreResult);
    if (gitignoreResult.status === "done") {
      const entries = gitignoreResult.details?.entriesAdded as string[] | undefined;
      if (entries && entries.length > 0) {
        followUps.push(`Gitignore: added entries — ${entries.join(", ")}`);
      }
    }
  } catch (err) {
    steps.push({
      name: "Restore gitignore entries",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── Step 6: Scaffold missing files ─────────────────────────────────
  // AC: @single-command-version-upgrade ac-reports-manual-follow-ups
  try {
    const scaffoldResults = await runScaffoldMissingStep(projectDir, ctx, dryRun, force);
    for (const result of scaffoldResults) {
      steps.push(result);
      if (result.status === "done") {
        followUps.push(`Scaffold: ${result.message}`);
      }
    }
  } catch (err) {
    steps.push({
      name: "Scaffold missing files",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── Step 7: Write lastKnownVersion ─────────────────────────────────
  // Only record the version when ALL prior steps succeeded. Recording
  // after a partial failure would suppress future upgrade attempts even
  // though some steps never completed.
  const priorStepsAllSucceeded = steps.every((s) => s.status !== "failed");

  if (!dryRun) {
    if (priorStepsAllSucceeded) {
      try {
        const state = await readSetupState(ctx.specDir);
        state.lastKnownVersion = targetVersion;
        await writeSetupState(ctx.specDir, state);
        const { commitIfShadow } = await import("../../parser/shadow.js");
        await commitIfShadow(ctx.shadow, "upgrade", undefined, `v${targetVersion}`);
        steps.push({
          name: "Record version",
          status: "done",
          message: `recorded version ${targetVersion}`,
        });
      } catch (err) {
        steps.push({
          name: "Record version",
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      steps.push({
        name: "Record version",
        status: "skipped",
        message: "skipped — prior step(s) failed; version not recorded to allow re-run",
      });
    }
  } else {
    steps.push({
      name: "Record version",
      status: "done",
      message: `would record version ${targetVersion}`,
    });
  }

  const allSuccess = steps.every((s) => s.status !== "failed");

  // AC: @release-notes-accessible ac-upgrade-surfaces-notes
  // Surface every release notes section strictly after the source version
  // and up to the target version so users see behavioral changes inline.
  const releaseNotes = await collectReleaseNotesForUpgrade(source.version, targetVersion);

  return {
    success: allSuccess,
    sourceVersion: source.version,
    targetVersion,
    confidence: source.confidence,
    isRefresh,
    noop: false,
    steps,
    followUps,
    releaseNotes,
    previousShadowCommit,
  };
}

// ─── Shadow HEAD Capture ──────────────────────────────────────────────────────

/**
 * Read the current shadow worktree HEAD commit. Surfaced in upgrade output
 * so an operator can roll back the shadow branch via `git reset --hard
 * <sha>` after a problematic upgrade. Returns `null` when no shadow
 * worktree is configured for the project or the call fails (a missing
 * shadow worktree is not itself a failure — the upgrade still runs, the
 * rollback hint is just absent).
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
 */
async function readShadowHeadCommit(
  shadow: { enabled: boolean; worktreeDir: string } | null,
): Promise<string | null> {
  if (!shadow?.enabled || !shadow.worktreeDir) return null;
  try {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: shadow.worktreeDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) return null;
    const sha = (result.stdout || "").trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

// ─── Atomic storage migration orchestration ───────────────────────────────────

/**
 * Internal sentinel thrown to short-circuit the atomic storage migration
 * buffer when one of the three steps reports a failed status. The sentinel
 * is caught by the outer driver so the per-step UpgradeStepResult values
 * still surface, but the surrounding `runWithBuffer` discards every write
 * that was made before the failure.
 */
class StorageMigrationAbort extends Error {
  constructor() {
    super("storage_migration_abort");
    this.name = "StorageMigrationAbort";
  }
}

/**
 * Run plan-folder, review-folder, and manifest-promotion migration as a
 * single buffered mutation. The three step functions are buffer-aware:
 * their nested `runWithBuffer` calls reuse the outer buffer instead of
 * flushing on their own, and the manifest write goes through the same
 * buffer via the buffer-aware yaml writer.
 *
 * - On success: the buffer flushes once and the orchestrator issues a
 *   single shadow commit describing the whole mutation.
 * - On failure of ANY step (or any exception inside the buffer scope):
 *   the buffer discards, no files are written, and no commit is made.
 *   The earlier "plan migrated, manifest still 1.1, review missing"
 *   half-state is no longer reachable from a failed `kspec upgrade`.
 *
 * Dry-run skips the buffer/commit entirely — no writes happen and step
 * results are surfaced as-is.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
async function runAtomicStorageMigration(
  ctx: {
    manifestPath: string | null;
    specDir: string;
    manifest: Record<string, unknown> | null;
    shadow: import("../../parser/shadow.js").ShadowConfig | null;
  },
  projectDir: string,
  dryRun: boolean,
  force: boolean,
  taskMigrationOk: boolean,
): Promise<UpgradeStepResult[]> {
  const planStepName = "Plan storage folder migration";
  const reviewStepName = "Review storage folder migration";
  const manifestStepName = "Storage manifest (kynetic 1.2)";
  const safetyStepName = "Storage migration safety preflight";

  const tryRun = async (
    name: string,
    run: () => Promise<UpgradeStepResult>,
  ): Promise<UpgradeStepResult> => {
    try {
      return await run();
    } catch (err) {
      return {
        name,
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };

  if (dryRun) {
    const planResult = await tryRun(planStepName, () =>
      runPlanFolderMigrationStep(ctx, projectDir, true, force),
    );
    const reviewResult = await tryRun(reviewStepName, () =>
      runReviewFolderMigrationStep(ctx, projectDir, true, force),
    );
    // Manifest promotion previews 1.2 only when every storage migration —
    // tasks included — succeeded. A failed task migration must not
    // advertise that the manifest will move to kynetic 1.2, otherwise the
    // dry-run misleads an operator into believing a rerun is safe.
    const priorOk =
      taskMigrationOk && planResult.status !== "failed" && reviewResult.status !== "failed";
    const manifestResult = await tryRun(manifestStepName, () =>
      runStorageManifestPromotionStep(ctx, true, priorOk),
    );
    return [planResult, reviewResult, manifestResult];
  }

  // Executing run: if the task storage migration failed above, the atomic
  // block must skip every dependent step. Running plan/review migrations
  // and promoting the manifest while task storage is still broken would
  // promote `kynetic: "1.2"` / `task_storage.format: split` on top of a
  // failed task layout — the same misleading state the reviewer reproduced.
  if (!taskMigrationOk) {
    const message =
      "skipped — task storage migration failed; folder-storage migration and " +
      "manifest promotion left at current version";
    return [
      { name: planStepName, status: "skipped", message },
      { name: reviewStepName, status: "skipped", message },
      { name: manifestStepName, status: "skipped", message },
    ];
  }

  // Live-path tripwire: enforce ONCE before any executing storage mutation
  // so it fires for every path through the atomic block, not just the
  // plan/review apply calls. The per-step assertions inside
  // `runPlanFolderMigrationStep` / `runReviewFolderMigrationStep` run AFTER
  // the `report.alreadyMigrated` short-circuit and never get a chance to
  // refuse when both steps are no-ops — but the manifest promotion below
  // would still mutate a protected project. Hoisting the check here closes
  // that bypass: a no-op plan + no-op review + manifest promotion is still
  // "an executing folder-storage upgrade" and must respect the tripwire.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  try {
    const { assertSafeMigrationTarget } = await import("../../parser/migration-safety.js");
    assertSafeMigrationTarget(projectDir, ctx.specDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const skipMessage = "skipped — protected project tripwire refused executing migration";
    return [
      { name: safetyStepName, status: "failed", message },
      { name: planStepName, status: "skipped", message: skipMessage },
      { name: reviewStepName, status: "skipped", message: skipMessage },
      { name: manifestStepName, status: "skipped", message: skipMessage },
    ];
  }

  const { runWithBuffer } = await import("../batch-write-buffer.js");
  const { commitIfShadow } = await import("../../parser/shadow.js");

  const collected: UpgradeStepResult[] = [];

  try {
    await runWithBuffer(ctx.specDir, async () => {
      const planResult = await tryRun(planStepName, () =>
        runPlanFolderMigrationStep(ctx, projectDir, false, force),
      );
      collected.push(planResult);
      if (planResult.status === "failed") throw new StorageMigrationAbort();

      const reviewResult = await tryRun(reviewStepName, () =>
        runReviewFolderMigrationStep(ctx, projectDir, false, force),
      );
      collected.push(reviewResult);
      if (reviewResult.status === "failed") throw new StorageMigrationAbort();

      // At this point both prior steps either did real work or skipped
      // cleanly. The manifest step can safely promote to kynetic 1.2.
      const manifestResult = await tryRun(manifestStepName, () =>
        runStorageManifestPromotionStep(ctx, false, true),
      );
      collected.push(manifestResult);
      if (manifestResult.status === "failed") throw new StorageMigrationAbort();
    });
  } catch (err) {
    if (!(err instanceof StorageMigrationAbort)) {
      // Unexpected error path — the buffer has already discarded by the
      // time we land here. Surface as a synthetic failed step so the
      // user sees what broke without losing the partial step results.
      collected.push({
        name: "Atomic storage migration",
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    // The surrounding `runWithBuffer` discarded every write made before
    // the failure, so any step that came back from `tryRun` as `done`
    // never actually landed on disk. Re-label those entries as
    // `rolled_back` so the upgrade result reports the truth: the work
    // was rehearsed and then thrown away. Without this rewrite the
    // outer driver would still add follow-ups like "Plan storage: N
    // plan(s) migrated" for files that no longer exist.
    for (let i = 0; i < collected.length; i += 1) {
      const step = collected[i];
      if (step.status !== "done") continue;
      collected[i] = {
        ...step,
        status: "rolled_back",
        message:
          "rolled back — a later atomic storage migration step failed and " +
          "the buffered writes for this step were discarded",
      };
    }
    // Ensure the orchestrator returns step records for every named step
    // even if the buffer aborted before some steps ran. Without these,
    // a partial-layout failure on the plan step would leave the upgrade
    // result missing the review/manifest entries that downstream JSON
    // consumers (and the existing test suite) expect.
    if (!collected.some((s) => s.name === reviewStepName)) {
      collected.push({
        name: reviewStepName,
        status: "skipped",
        message: "skipped — earlier storage migration step failed; rolled back",
      });
    }
    if (!collected.some((s) => s.name === manifestStepName)) {
      collected.push({
        name: manifestStepName,
        status: "skipped",
        message: "skipped — earlier storage migration step failed; rolled back",
      });
    }
    return collected;
  }

  // Buffer flushed successfully. Issue exactly one shadow commit that
  // covers every file the three steps wrote.
  if (collected.some((s) => s.status === "done")) {
    await commitIfShadow(
      ctx.shadow,
      "upgrade",
      undefined,
      "migrate plan/review storage to folder-backed layout (kynetic 1.2)",
    );
  }
  return collected;
}

// ─── Plan storage folder migration step ───────────────────────────────────────

/**
 * Plan-folder migration step for `kspec upgrade`. Computes the migration
 * report, surfaces it (dry-run) or applies it (executing run). The step
 * writes through the active write buffer when one is active — the
 * surrounding `runAtomicStorageMigration` owns the shadow commit so the
 * plan / review / manifest steps land as one logical mutation.
 *
 * Live-path tripwire: when an operator sets `KSPEC_PROTECTED_PROJECT_PATHS`
 * the executing run refuses to mutate any project root listed there
 * (worker/test preflight). Unset is the default and disables the tripwire
 * entirely. Dry-runs always work against any directory.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
 */
async function runPlanFolderMigrationStep(
  ctx: {
    manifestPath: string | null;
    specDir: string;
    manifest: Record<string, unknown> | null;
    shadow: import("../../parser/shadow.js").ShadowConfig | null;
  },
  projectDir: string,
  dryRun: boolean,
  force: boolean,
): Promise<UpgradeStepResult> {
  const { computePlanMigrationReport, applyPlanMigration } =
    await import("../../parser/plan-folder-migration.js");
  const { PLAN_RESOURCES_MANIFEST_FILENAME } = await import("../../parser/plan-storage-manager.js");
  const { assertSafeMigrationTarget } = await import("../../parser/migration-safety.js");

  const report = await computePlanMigrationReport(
    ctx as Parameters<typeof computePlanMigrationReport>[0],
  );

  // Already-migrated short-circuit: no monolithic records left, the
  // manifest may or may not already declare folder storage. Either way
  // there is nothing for the migration to do here.
  if (report.alreadyMigrated) {
    return {
      name: "Plan storage folder migration",
      status: "skipped",
      message: "no monolithic plans to migrate",
      details: { migrated: 0, reconciled: report.reconciled },
    };
  }

  if (dryRun) {
    // Per-entry dry-run preview must surface every sidecar target the
    // executing migration would write (plan.md, plan.yaml, optional
    // notes.yaml, resources.yaml) plus the empty resources/ directory
    // the layout contract requires. Users see the full folder shape
    // before any write happens.
    //
    // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
    const entries = report.entries.map((e) => ({
      ulid: e.ulid,
      title: e.title,
      had_generated_ulid: e.hadGeneratedUlid,
      preexisting_folder: e.preexistingFolder,
      has_warning: !!e.validationWarning,
      plan_dir: e.planDir,
      sidecars: {
        plan_yaml: e.corePath,
        plan_md: e.documentPath,
        notes_yaml: e.notesPath,
        resources_yaml: e.resourceManifestPath,
        resources_dir: e.resourcesDir,
      },
    }));
    const newResourceManifests = report.entries.filter((e) => !e.preexistingFolder).length;
    const orphanCount = report.orphanedLeanEntries.length;
    let message: string;
    if (report.partialLayout && orphanCount > 0 && report.migrated === 0) {
      message =
        `partial layout: ${orphanCount} stale lean index entr` +
        `${orphanCount === 1 ? "y" : "ies"} reference missing plan folder` +
        `${orphanCount === 1 ? "" : "s"} — --force required for real run`;
    } else if (report.partialLayout && report.migrated > 0) {
      message = `would migrate ${report.migrated} plan(s) (partial layout — --force required for real run)`;
    } else {
      message = `would migrate ${report.migrated} plan(s) into ${report.folderRoot}`;
    }
    return {
      name: "Plan storage folder migration",
      status: "done",
      message,
      details: {
        migrated: report.migrated,
        partial_layout: report.partialLayout,
        warnings: report.warnings,
        entries,
        folder_root: report.folderRoot,
        index_path: report.indexPath,
        monolithic_path: report.monolithicPath,
        // Stale lean index entries that point at missing plan folders.
        // Surfaced so dry-run consumers can show the same partial-layout
        // diagnosis the executing run would refuse on.
        orphaned_lean_entries: report.orphanedLeanEntries.map((entry) => ({
          ulid: typeof entry._ulid === "string" ? entry._ulid : null,
          title: typeof entry.title === "string" ? entry.title : "",
        })),
        // Resource manifest changes the executing run would make — one
        // empty `{ resources: [] }` sidecar per newly-migrated plan.
        // Surfaced separately from `entries` so dashboards/test
        // harnesses can summarize the resource-manifest impact without
        // walking every entry.
        resource_manifest_changes: {
          new_empty_manifests: newResourceManifests,
          manifest_filename: PLAN_RESOURCES_MANIFEST_FILENAME,
          paths: report.entries
            .filter((e) => !e.preexistingFolder)
            .map((e) => e.resourceManifestPath),
        },
      },
    };
  }

  // Live-path tripwire — refuse to mutate protected repositories.
  assertSafeMigrationTarget(projectDir, ctx.specDir);

  // Partial-layout guard is honoured by the apply call: without the
  // upgrade `--force` flag, `applyPlanMigration` throws
  // `partial_entity_storage_layout` and the step surfaces as failed.
  // The previous implementation hardcoded `{ force: true }`, which let a
  // normal `kspec upgrade` silently rewrite a partial layout — that path
  // was the blocker that triggered this fix.
  //
  // The apply call writes through the active batch buffer — when nested
  // under `runAtomicStorageMigration` the writes are held in memory and
  // either flushed (on overall success) or discarded (if a later step
  // fails). No commit is issued here; the orchestrator owns it.
  const applied = await applyPlanMigration(
    ctx as Parameters<typeof applyPlanMigration>[0],
    report,
    { force },
  );

  return {
    name: "Plan storage folder migration",
    status: "done",
    message: `migrated ${applied.written} plan(s) to folder-backed storage`,
    details: {
      migrated: applied.written,
      index_entries: applied.indexEntries,
      warnings: report.warnings,
    },
  };
}

// ─── Review storage folder migration step ─────────────────────────────────────

/**
 * Review-folder migration step for `kspec upgrade`. Mirrors the plan
 * migration step — compute the report, surface it (dry-run) or apply it
 * (executing run), commit the result to the shadow branch.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
 */
async function runReviewFolderMigrationStep(
  ctx: {
    manifestPath: string | null;
    specDir: string;
    manifest: Record<string, unknown> | null;
    shadow: import("../../parser/shadow.js").ShadowConfig | null;
  },
  projectDir: string,
  dryRun: boolean,
  force: boolean,
): Promise<UpgradeStepResult> {
  const { computeReviewMigrationReport, applyReviewMigration } =
    await import("../../parser/review-folder-migration.js");
  const { REVIEW_RESOURCES_MANIFEST_FILENAME } =
    await import("../../parser/review-storage-manager.js");
  const { assertSafeMigrationTarget } = await import("../../parser/migration-safety.js");

  const report = await computeReviewMigrationReport(
    ctx as Parameters<typeof computeReviewMigrationReport>[0],
  );

  if (report.alreadyMigrated) {
    return {
      name: "Review storage folder migration",
      status: "skipped",
      message: "no monolithic reviews to migrate",
      details: { migrated: 0, reconciled: report.reconciled },
    };
  }

  if (dryRun) {
    // Per-entry dry-run preview must surface every sidecar target the
    // executing migration would write (review.yaml, resources.yaml)
    // plus the empty resources/ directory the layout contract requires.
    //
    // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
    const entries = report.entries.map((e) => ({
      ulid: e.ulid,
      title: e.title,
      had_generated_ulid: e.hadGeneratedUlid,
      preexisting_folder: e.preexistingFolder,
      has_warning: !!e.validationWarning,
      review_dir: e.reviewDir,
      sidecars: {
        review_yaml: e.detailPath,
        resources_yaml: e.resourceManifestPath,
        resources_dir: e.resourcesDir,
      },
    }));
    const newResourceManifests = report.entries.filter((e) => !e.preexistingFolder).length;
    const orphanCount = report.orphanedLeanEntries.length;
    let message: string;
    if (report.partialLayout && orphanCount > 0 && report.migrated === 0) {
      message =
        `partial layout: ${orphanCount} stale lean index entr` +
        `${orphanCount === 1 ? "y" : "ies"} reference missing review folder` +
        `${orphanCount === 1 ? "" : "s"} — --force required for real run`;
    } else if (report.partialLayout && report.migrated > 0) {
      message = `would migrate ${report.migrated} review(s) (partial layout — --force required for real run)`;
    } else {
      message = `would migrate ${report.migrated} review(s) into ${report.folderRoot}`;
    }
    return {
      name: "Review storage folder migration",
      status: "done",
      message,
      details: {
        migrated: report.migrated,
        partial_layout: report.partialLayout,
        warnings: report.warnings,
        entries,
        folder_root: report.folderRoot,
        index_path: report.indexPath,
        monolithic_path: report.monolithicPath,
        // Stale lean index entries that point at missing review folders.
        orphaned_lean_entries: report.orphanedLeanEntries.map((entry) => ({
          ulid: typeof entry._ulid === "string" ? entry._ulid : null,
          title: typeof entry.title === "string" ? entry.title : "",
        })),
        // Resource manifest changes the executing run would make — one
        // empty `{ resources: [] }` sidecar per newly-migrated review.
        resource_manifest_changes: {
          new_empty_manifests: newResourceManifests,
          manifest_filename: REVIEW_RESOURCES_MANIFEST_FILENAME,
          paths: report.entries
            .filter((e) => !e.preexistingFolder)
            .map((e) => e.resourceManifestPath),
        },
      },
    };
  }

  assertSafeMigrationTarget(projectDir, ctx.specDir);

  // Partial-layout guard is honoured by the apply call: without the
  // upgrade `--force` flag, `applyReviewMigration` throws
  // `partial_entity_storage_layout` and the step surfaces as failed.
  // The previous hardcoded `{ force: true }` bypassed this guard from
  // the CLI surface even on a normal `kspec upgrade`; that path was the
  // blocker that triggered this fix.
  // Writes through the active batch buffer; the orchestrator
  // `runAtomicStorageMigration` owns the surrounding shadow commit so
  // plan + review + manifest land as one logical mutation.
  const applied = await applyReviewMigration(
    ctx as Parameters<typeof applyReviewMigration>[0],
    report,
    { force },
  );

  return {
    name: "Review storage folder migration",
    status: "done",
    message: `migrated ${applied.written} review(s) to folder-backed storage`,
    details: {
      migrated: applied.written,
      index_entries: applied.indexEntries,
      warnings: report.warnings,
    },
  };
}

// ─── Storage manifest promotion step ─────────────────────────────────────────

/**
 * Promote the manifest to `kynetic: 1.2` with the folder-backed storage
 * declarations. Only fires when every prior migration step succeeded —
 * a failed plan or review migration leaves the manifest at 1.1 so the
 * project remains in a re-runnable state instead of declaring folder
 * storage it does not actually have.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-new-projects-declare-folder-storage
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
 */
async function runStorageManifestPromotionStep(
  ctx: {
    manifestPath: string | null;
    specDir: string;
    shadow: import("../../parser/shadow.js").ShadowConfig | null;
  },
  dryRun: boolean,
  priorMigrationsSucceeded: boolean,
): Promise<UpgradeStepResult> {
  if (!ctx.manifestPath) {
    return {
      name: "Storage manifest (kynetic 1.2)",
      status: "skipped",
      message: "no manifest found",
    };
  }
  if (!priorMigrationsSucceeded) {
    return {
      name: "Storage manifest (kynetic 1.2)",
      status: "skipped",
      message: "prior storage migration step(s) failed — manifest left at current version",
    };
  }

  const { readYamlFile, writeYamlFilePreserveFormat } = await import("../../parser/yaml.js");

  const manifest = await readYamlFile<Record<string, unknown>>(ctx.manifestPath);
  if (!manifest) {
    return {
      name: "Storage manifest (kynetic 1.2)",
      status: "failed",
      message: `manifest at ${ctx.manifestPath} could not be parsed`,
    };
  }

  const targetFields: Record<string, unknown> = {
    kynetic: "1.2",
    task_storage: { format: "split" },
    plan_storage: { format: "folder" },
    review_storage: { format: "folder" },
    resource_storage: { format: "entity_scoped" },
  };

  // Detect whether any field is already at the target value.
  const currentTaskFormat =
    typeof manifest.task_storage === "object" && manifest.task_storage !== null
      ? (manifest.task_storage as Record<string, unknown>).format
      : undefined;
  const currentPlanFormat =
    typeof manifest.plan_storage === "object" && manifest.plan_storage !== null
      ? (manifest.plan_storage as Record<string, unknown>).format
      : undefined;
  const currentReviewFormat =
    typeof manifest.review_storage === "object" && manifest.review_storage !== null
      ? (manifest.review_storage as Record<string, unknown>).format
      : undefined;
  const currentResourceFormat =
    typeof manifest.resource_storage === "object" && manifest.resource_storage !== null
      ? (manifest.resource_storage as Record<string, unknown>).format
      : undefined;

  const isUpToDate =
    manifest.kynetic === "1.2" &&
    currentTaskFormat === "split" &&
    currentPlanFormat === "folder" &&
    currentReviewFormat === "folder" &&
    currentResourceFormat === "entity_scoped";

  if (isUpToDate) {
    return {
      name: "Storage manifest (kynetic 1.2)",
      status: "skipped",
      message: "manifest already declares folder-backed storage at kynetic 1.2",
    };
  }

  if (dryRun) {
    return {
      name: "Storage manifest (kynetic 1.2)",
      status: "done",
      message:
        "would set kynetic=1.2 with plan_storage/review_storage/resource_storage declarations",
      details: { target: targetFields },
    };
  }

  manifest.kynetic = "1.2";
  manifest.task_storage = { ...(manifest.task_storage as object | undefined), format: "split" };
  manifest.plan_storage = { ...(manifest.plan_storage as object | undefined), format: "folder" };
  manifest.review_storage = {
    ...(manifest.review_storage as object | undefined),
    format: "folder",
  };
  manifest.resource_storage = {
    ...(manifest.resource_storage as object | undefined),
    format: "entity_scoped",
  };
  // Writes through the active batch buffer when one is active; the
  // orchestrator `runAtomicStorageMigration` owns the shadow commit.
  await writeYamlFilePreserveFormat(ctx.manifestPath, manifest);

  return {
    name: "Storage manifest (kynetic 1.2)",
    status: "done",
    message: "set kynetic=1.2 with folder-backed plan/review/resource storage",
  };
}

/**
 * Load release notes for every intervening version between source and target.
 * Swallows missing-file errors (a project without RELEASE_NOTES.md still
 * upgrades successfully) but surfaces parser errors so they are visible.
 *
 * AC: @release-notes-accessible ac-upgrade-surfaces-notes
 */
async function collectReleaseNotesForUpgrade(
  sourceVersion: string | null,
  targetVersion: string,
): Promise<Array<{ version: string; heading: string; markdown: string }>> {
  try {
    const { loadReleaseNotes, getInterveningNotes, renderEntry } =
      await import("../../parser/release-notes.js");
    // Resolve the package root where the shipped RELEASE_NOTES.md lives.
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const here = fileURLToPath(import.meta.url);
    const packageRoot = path.resolve(path.dirname(here), "..", "..", "..");

    const notes = await loadReleaseNotes(packageRoot);
    const entries = getInterveningNotes(notes, sourceVersion, targetVersion);
    return entries.map((entry) => ({
      version: entry.version,
      heading: entry.heading,
      markdown: renderEntry(entry),
    }));
  } catch {
    // File missing or unreadable — surface no release notes but let the
    // upgrade itself succeed. Authoring the file is documented in the
    // release skill; its absence is not a blocker for upgrade.
    return [];
  }
}

// ─── Pipeline Step Implementations ────────────────────────────────────────────

/**
 * Step 1: Run task storage migration.
 * Invokes `kspec task migrate --force` programmatically.
 *
 * AC: @single-command-version-upgrade ac-runs-task-storage-migration
 */
async function runTaskStorageMigrationStep(
  ctx: { manifestPath: string | null; specDir: string; manifest: Record<string, unknown> | null },
  dryRun: boolean,
): Promise<UpgradeStepResult> {
  // Always check the actual task file shape — never trust the manifest marker alone,
  // because partial upgrades or hand-edits can leave the marker out of sync with reality.
  const { extractRawTaskArray } = await import("../../parser/yaml.js");
  const { getIndexFilePath } = await import("../../parser/split-backend.js");
  const indexPath = getIndexFilePath(ctx as Parameters<typeof getIndexFilePath>[0]);

  let rawTaskCount = 0;
  try {
    const { rawTasks } = await extractRawTaskArray(indexPath);
    // Count monolithic entries (those without notes_count as a number)
    rawTaskCount = rawTasks.filter(
      (t) =>
        t &&
        typeof t === "object" &&
        typeof (t as Record<string, unknown>).notes_count !== "number",
    ).length;
  } catch {
    // No tasks file — nothing to migrate
  }

  if (rawTaskCount === 0) {
    // Still upgrade the manifest to mark format as split
    // Check whether the manifest already has the split format marker. Either
    // kynetic 1.1 (split task storage was introduced) or 1.2+ (split is the
    // continued baseline) is acceptable — we must not downgrade a 1.2
    // manifest back to 1.1 just because the task-storage check predates the
    // 1.2 era.
    let manifestAlreadySplit = false;
    if (ctx.manifestPath) {
      try {
        const yaml = await import("yaml");
        const raw = await fs.readFile(ctx.manifestPath, "utf-8");
        const manifestData = yaml.parse(raw);
        const formatIsSplit = manifestData?.task_storage?.format === "split";
        const kyneticAccepts = manifestData?.kynetic === "1.1" || manifestData?.kynetic === "1.2";
        manifestAlreadySplit = formatIsSplit && kyneticAccepts;
      } catch {
        // Can't read — assume not split
      }
    }

    if (manifestAlreadySplit) {
      return {
        name: "Task storage migration",
        status: "done",
        message: "no monolithic tasks to migrate; manifest already in split format",
        details: { migrated: 0 },
      };
    }

    if (!dryRun) {
      const { writeYamlFilePreserveFormat } = await import("../../parser/yaml.js");
      if (ctx.manifestPath) {
        const { readYamlFile } = await import("../../parser/yaml.js");
        const manifest = await readYamlFile<Record<string, unknown>>(ctx.manifestPath);
        if (manifest) {
          // Only set kynetic to 1.1 when it is currently older than 1.1 —
          // do not downgrade newer manifests (1.2+) just to record the split
          // marker.
          if (manifest.kynetic !== "1.2") {
            manifest.kynetic = "1.1";
          }
          if (!manifest.task_storage || typeof manifest.task_storage !== "object") {
            manifest.task_storage = { format: "split" };
          } else {
            (manifest.task_storage as Record<string, unknown>).format = "split";
          }
          await writeYamlFilePreserveFormat(ctx.manifestPath, manifest);
        }
      }
    }
    return {
      name: "Task storage migration",
      status: "done",
      message: dryRun
        ? "no monolithic tasks to migrate; would update manifest to split format"
        : "no monolithic tasks to migrate; manifest updated to split format",
      details: { migrated: 0 },
    };
  }

  // Run migration via CLI subprocess for isolation
  // (The migration code is deeply intertwined with CLI context)
  const { execSync } = await import("node:child_process");
  const args = dryRun ? "task migrate --dry-run --force" : "task migrate --force";

  try {
    const cliPath = path.resolve(
      import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
      "../../../dist/cli/index.js",
    );

    // Try using the built CLI; fall back to the current process if not available
    let result: string;
    try {
      result = execSync(`node ${cliPath} ${args}`, {
        cwd: path.dirname(ctx.specDir),
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, KSPEC_NO_DAEMON: "1" },
      });
    } catch (execErr) {
      const execError = execErr as { stdout?: string; stderr?: string; status?: number };
      // If the command ran but reported already-migrated, that's fine
      if (execError.stdout?.includes("Already migrated")) {
        return {
          name: "Task storage migration",
          status: "done",
          message: "already migrated",
          details: { migrated: 0 },
        };
      }
      throw new Error(
        `Task migration failed: ${execError.stderr || execError.stdout || String(execErr)}`,
      );
    }

    // Parse the result to extract migration count
    const migratedMatch = result.match(/(\d+) task\(s\)/);
    const migrated = migratedMatch ? parseInt(migratedMatch[1], 10) : 0;

    return {
      name: "Task storage migration",
      status: "done",
      message: migrated > 0 ? `${migrated} task(s) migrated` : "no tasks needed migration",
      details: { migrated },
    };
  } catch (err) {
    return {
      name: "Task storage migration",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Step 2: Backfill missing core skills.
 * Reuses installCoreSkillsForSetup from setup.ts to ensure all core
 * skills shipped with the current kspec version exist in project meta
 * and have their content files in .kspec/skills/. This must run BEFORE
 * the re-render step so newly backfilled skills get rendered.
 *
 * AC: @single-command-version-upgrade ac-rerenders-skills
 */
async function runBackfillCoreSkillsStep(
  projectDir: string,
  dryRun: boolean,
): Promise<UpgradeStepResult> {
  try {
    const { installCoreSkillsForSetup } = await import("./setup.js");
    const result = await installCoreSkillsForSetup(projectDir, dryRun);

    const total = result.installed + result.skipped;
    if (result.installed === 0) {
      return {
        name: "Backfill core skills",
        status: "skipped",
        message:
          total > 0 ? `all ${total} core skill(s) already present` : "no core skills in manifest",
        details: { installed: 0, skipped: result.skipped },
      };
    }

    return {
      name: "Backfill core skills",
      status: "done",
      message: `${result.installed} core skill(s) installed`,
      details: { installed: result.installed, skipped: result.skipped },
    };
  } catch (err) {
    return {
      name: "Backfill core skills",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Step 3: Re-render skills and remove obsolete rendered skills.
 * Reuses the renderSkillsForSetup pattern from setup.ts,
 * plus orphan cleanup logic from skill-diff.ts --clean.
 *
 * AC: @single-command-version-upgrade ac-rerenders-skills
 */
async function runRerenderSkillsStep(
  projectDir: string,
  dryRun: boolean,
): Promise<UpgradeStepResult> {
  const { initContext, loadMetaContext } = await import("../../parser/index.js");
  const { getRenderer, getSkillSubdir, getAllRenderers, isKspecManagedSkill } =
    await import("../../parser/skill-render.js");

  const ctx = await initContext();

  if (!ctx.manifestPath) {
    return {
      name: "Re-render skills",
      status: "skipped",
      message: "no manifest found",
    };
  }

  const metaCtx = await loadMetaContext(ctx);

  const skillsToRender: Array<{
    skill: (typeof metaCtx.skills)[0];
    platform: string;
  }> = [];
  for (const skill of metaCtx.skills) {
    for (const platform of skill.platforms) {
      const renderer = getRenderer(platform);
      if (renderer) {
        skillsToRender.push({ skill, platform });
      }
    }
  }

  let rendered = 0;
  let skipped = 0;
  const renderErrors: string[] = [];

  // AC: @trait-dry-run ac-4 — pre-flight check: verify output directories are
  // viable before rendering. If a directory path is blocked by a regular file,
  // report the same error dry-run or real-run would encounter.
  for (const renderer of getAllRenderers()) {
    const outputDir = path.join(projectDir, renderer.defaultOutputDir);
    try {
      const stat = await fs.stat(outputDir);
      if (!stat.isDirectory()) {
        renderErrors.push(
          `${renderer.platform}: ${renderer.defaultOutputDir} exists but is not a directory`,
        );
      }
    } catch {
      // Output directory doesn't exist — that's fine, mkdir will create it
    }
  }

  // If pre-flight found issues, skip rendering and report failure immediately
  if (renderErrors.length === 0) {
    for (const { skill, platform } of skillsToRender) {
      const renderer = getRenderer(platform)!;
      try {
        const result = await renderer.render(ctx, projectDir, skill, {
          dryRun,
        });
        if (result.action === "created" || result.action === "updated") {
          rendered++;
        } else {
          skipped++;
        }
      } catch (err) {
        renderErrors.push(
          `${skill.id}/${platform}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Orphan cleanup: remove managed skill directories that no longer
  // correspond to any defined skill in the current version.
  // AC: @single-command-version-upgrade ac-rerenders-skills
  let removed = 0;
  const removedIds: string[] = [];

  // Build active subdir sets per platform
  const activeSubdirsByPlatform = new Map<string, Set<string>>();
  for (const skill of metaCtx.skills) {
    for (const platform of skill.platforms) {
      if (!activeSubdirsByPlatform.has(platform)) {
        activeSubdirsByPlatform.set(platform, new Set());
      }
      activeSubdirsByPlatform.get(platform)!.add(getSkillSubdir(skill.id, skill.origin, platform));
    }
  }

  // Scan each platform's output directory for orphans
  const renderers = getAllRenderers();
  for (const renderer of renderers) {
    const activeSubdirs = activeSubdirsByPlatform.get(renderer.platform) || new Set<string>();
    const outputDir = path.join(projectDir, renderer.defaultOutputDir);

    try {
      const entries = await fs.readdir(outputDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(outputDir, entry.name);
        const skillMdPath = path.join(skillDir, "SKILL.md");

        // Check for SKILL.md in this directory
        let hasSkillMd = false;
        try {
          await fs.access(skillMdPath);
          hasSkillMd = true;
        } catch {
          // No SKILL.md
        }

        if (!hasSkillMd) continue;
        if (activeSubdirs.has(entry.name)) continue;

        // Orphan candidate — check if managed by kspec
        const isManaged = await isKspecManagedSkill(skillMdPath);
        if (!isManaged) continue;

        if (!dryRun) {
          await fs.rm(skillDir, { recursive: true, force: true });
        }
        removed++;
        removedIds.push(entry.name);
      }
    } catch {
      // Output directory doesn't exist, nothing to clean
    }
  }

  // If any renderer threw, the step failed — report the errors.
  if (renderErrors.length > 0) {
    return {
      name: "Re-render skills",
      status: "failed",
      message: `${renderErrors.length} skill(s) failed to render: ${renderErrors.join("; ")}`,
      details: { rendered, skipped, removed, renderErrors },
    };
  }

  const totalChanges = rendered + removed;

  if (totalChanges === 0) {
    if (skillsToRender.length === 0) {
      return {
        name: "Re-render skills",
        status: "skipped",
        message: "no skills to render",
      };
    }
    return {
      name: "Re-render skills",
      status: "skipped",
      message: `all ${skipped} skill(s) already up to date`,
      details: { rendered: 0, skipped, removed: 0 },
    };
  }

  const parts: string[] = [];
  if (rendered > 0) parts.push(`${rendered} re-rendered`);
  if (skipped > 0) parts.push(`${skipped} unchanged`);
  if (removed > 0) parts.push(`${removed} obsolete removed`);

  return {
    name: "Re-render skills",
    status: "done",
    message: parts.join(", "),
    details: { rendered, skipped, removed, removedIds },
  };
}

/**
 * Step 4: Regenerate agent instructions file.
 * Reuses the generateAgentInstructions pattern from setup.ts.
 *
 * AC: @single-command-version-upgrade ac-regenerates-agents-file
 */
async function runRegenerateAgentsStep(
  projectDir: string,
  dryRun: boolean,
): Promise<UpgradeStepResult> {
  const { initContext, loadMetaContext } = await import("../../parser/index.js");
  const { generateAgentsContent, loadTemplateSections, getPackageRoot, computeMetaHash } =
    await import("./agents.js");

  const ctx = await initContext();

  if (!ctx.manifestPath) {
    return {
      name: "Regenerate agent instructions",
      status: "skipped",
      message: "no manifest found",
    };
  }

  const metaCtx = await loadMetaContext(ctx);
  const timestamp = new Date().toISOString();

  let templateSections: string[];
  try {
    templateSections = await loadTemplateSections(getPackageRoot());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error loading templates";
    return {
      name: "Regenerate agent instructions",
      status: "failed",
      message,
    };
  }

  const content = await generateAgentsContent(
    metaCtx.conventions,
    metaCtx.workflows,
    timestamp,
    templateSections,
  );

  const outputPath = path.join(projectDir, "kspec-agents.md");
  const hashPath = path.join(projectDir, ".kspec", ".kspec-agents-hash");

  // AC: @trait-dry-run ac-4 — hash check runs for both dry-run and real-run
  // so dry-run accurately predicts what the real run would do.
  const metaHash = computeMetaHash(metaCtx.conventions, metaCtx.workflows, templateSections);

  let storedHash: string | undefined;
  try {
    const hashContent = await fs.readFile(hashPath, "utf-8");
    const hashData = JSON.parse(hashContent);
    storedHash = hashData.metaHash;
  } catch {
    // No hash — regenerate
  }

  let outputIsFile = false;
  let outputIsCorrupted = false;
  try {
    const stat = await fs.stat(outputPath);
    if (stat.isFile()) {
      outputIsFile = true;
    } else {
      outputIsCorrupted = true;
      if (!dryRun) {
        // Corrupted artifact (e.g., directory replacing the file) — remove it
        await fs.rm(outputPath, { recursive: true, force: true });
      }
    }
  } catch {
    // Missing
  }

  // Even when the meta hash matches, verify the file content on disk actually
  // matches what we would generate. A corrupted or manually overwritten file
  // must be regenerated regardless of meta hash state.
  // Compare content excluding the timestamp comment line (first line), which
  // changes on every invocation and is not meaningful for staleness detection.
  let contentMatchesGenerated = false;
  if (storedHash === metaHash && outputIsFile) {
    try {
      const existingContent = await fs.readFile(outputPath, "utf-8");
      const stripTimestamp = (s: string) => s.replace(/^<!--[^\n]*-->\n/, "");
      contentMatchesGenerated = stripTimestamp(existingContent) === stripTimestamp(content);
    } catch {
      // Can't read — treat as not matching
    }
  }

  if (storedHash === metaHash && outputIsFile && contentMatchesGenerated) {
    return {
      name: "Regenerate agent instructions",
      status: "skipped",
      message: "already up to date",
      details: { skipped: true },
    };
  }

  if (!dryRun) {
    await fs.writeFile(outputPath, content, "utf-8");

    // Update hash file
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const { version } = req("../../../package.json");
    await fs.mkdir(path.dirname(hashPath), { recursive: true });
    await fs.writeFile(
      hashPath,
      JSON.stringify({ metaHash, generatedAt: timestamp, version }, null, 2) + "\n",
      "utf-8",
    );
  }

  const reason = outputIsCorrupted
    ? "corrupted artifact detected"
    : !outputIsFile
      ? "file missing"
      : "meta hash changed";

  return {
    name: "Regenerate agent instructions",
    status: "done",
    message: dryRun
      ? `would regenerate kspec-agents.md (${reason})`
      : "regenerated kspec-agents.md",
    details: { skipped: false },
  };
}

/**
 * Step 5: Restore gitignore entries.
 * Reuses ensureKspecGitignore from parser/gitignore.ts.
 *
 * AC: @single-command-version-upgrade ac-restores-gitignore-entries
 */
async function runGitignoreRepairStep(
  projectDir: string,
  dryRun: boolean,
): Promise<UpgradeStepResult> {
  const { ensureKspecGitignore, updateManagedBlock, buildKspecGitignoreEntries } =
    await import("../../parser/gitignore.js");
  const { loadProjectConfig } = await import("../../parser/config.js");

  const { config: projectConfig } = await loadProjectConfig(projectDir, projectDir);
  const shadowDir = projectConfig.shadow.directory || undefined;
  const worktreeRoot = projectConfig.dispatch.worktree_root || undefined;

  if (dryRun) {
    // Preview what would change — upgrade always forces the managed block
    const gitignorePath = path.join(projectDir, ".gitignore");
    let gitignoreContent = "";
    try {
      gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
    } catch {
      // File doesn't exist
    }

    const entries = buildKspecGitignoreEntries(shadowDir, worktreeRoot);
    const dryResult = updateManagedBlock(gitignoreContent, entries);
    if (!dryResult.result.changed) {
      return {
        name: "Restore gitignore entries",
        status: "skipped",
        message: "all entries present",
      };
    }

    return {
      name: "Restore gitignore entries",
      status: "done",
      message: dryResult.result.blockCreated
        ? `would create managed block with: ${dryResult.result.entriesAdded.join(", ")}`
        : `would add: ${dryResult.result.entriesAdded.join(", ")}`,
      details: { entriesAdded: dryResult.result.entriesAdded },
    };
  }

  // Actually repair — upgrade always forces the managed block so that
  // existing .gitignore files without the kspec managed block still get
  // the required entries appended.
  const result = await ensureKspecGitignore(projectDir, {
    shadowDir,
    worktreeRoot,
    force: true,
  });

  if (!result.changed) {
    return {
      name: "Restore gitignore entries",
      status: "skipped",
      message: "all entries present",
    };
  }

  return {
    name: "Restore gitignore entries",
    status: "done",
    message: result.blockCreated
      ? `created .gitignore with: ${result.entriesAdded.join(", ")}`
      : `added: ${result.entriesAdded.join(", ")}`,
    details: { entriesAdded: result.entriesAdded },
  };
}

/**
 * Step 6: Scaffold any missing files.
 * Runs: scaffoldProjectConfig, scaffoldDefaults, ensureDefaultReflectionHook — but only creates what is missing.
 *
 * AC: @single-command-version-upgrade ac-reports-manual-follow-ups
 */
async function runScaffoldMissingStep(
  projectDir: string,
  ctx: { manifestPath: string | null; specDir: string },
  dryRun: boolean,
  _force: boolean,
): Promise<UpgradeStepResult[]> {
  const results: UpgradeStepResult[] = [];

  // 5a: Scaffold project config
  const { CONFIG_FILENAME } = await import("../../parser/config.js");
  const { resolveDefaultBranch } = await import("../../agent-runtime/workspace.js");
  const configPath = path.join(projectDir, CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    if (!dryRun) {
      // Generate and write config content
      const { branch, source } = await resolveDefaultBranch(projectDir);
      const baseBranchSourceComment =
        source === "remote-head"
          ? "Resolved from repository default branch."
          : source === "current-branch"
            ? "Resolved from current branch — no remote HEAD or current branch found."
            : "Detected value is a fallback.";

      const content = `# kspec project configuration
# This file was scaffolded by kspec upgrade. Review and customize for your project.
# Documentation: https://github.com/lepahc/kynetic-spec

dispatch:
  publication_mode: auto

  # ${baseBranchSourceComment}
  # base_branch: "${branch}"

# coverage:
#   scan_paths:
#     - "tests/"
#     - "src/"
`;
      await fs.writeFile(configPath, content, "utf-8");
    }
    results.push({
      name: "Scaffold project config",
      status: "done",
      message: dryRun ? `would create ${CONFIG_FILENAME}` : `created ${CONFIG_FILENAME}`,
    });
  } else {
    results.push({
      name: "Scaffold project config",
      status: "skipped",
      message: `${CONFIG_FILENAME} already exists`,
    });
  }

  // 5b: Scaffold default agents and conventions
  //
  // NOTE: We intentionally do NOT forward `force` to scaffoldDefaults here.
  // The upgrade spec requires step 5 to "only create what is missing; never
  // overwrite" — so a user who deliberately removed a default agent or
  // convention must not see it reintroduced by `upgrade --force`. `--force`
  // for upgrade relaxes the idempotent-when-current skip; it does not
  // override user-removal decisions for scaffolded defaults.
  //
  // This mirrors the cycle-15 fix for the reflection hook below, which
  // removed a `&& !force` guard that was silently re-seeding user-removed
  // items.
  try {
    const { scaffoldDefaults } = await import("./setup-defaults.js");
    const { initContext } = await import("../../parser/index.js");
    const freshCtx = await initContext();

    const scaffoldResult = await scaffoldDefaults(freshCtx, { dryRun });
    const createdItems = scaffoldResult.items.filter(
      (i) => i.status === "created" || i.status === "force-recreated",
    );

    if (createdItems.length > 0) {
      results.push({
        name: "Scaffold default agents and conventions",
        status: "done",
        message: scaffoldResult.message,
        details: {
          items: scaffoldResult.items,
        },
      });
    } else {
      results.push({
        name: "Scaffold default agents and conventions",
        status: "skipped",
        message: scaffoldResult.message,
      });
    }
  } catch (err) {
    results.push({
      name: "Scaffold default agents and conventions",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 5c: Scaffold default reflection hook
  try {
    const { initContext } = await import("../../parser/index.js");
    const { loadMetaContext, saveHook } = await import("../../parser/meta.js");
    const { ulid } = await import("ulid");

    const freshCtx = await initContext();
    if (freshCtx.manifestPath) {
      const meta = await loadMetaContext(freshCtx);
      const hookName = "default-session-reflect";
      const existingHook = meta.hooks.find((h) => h.name === hookName);

      if (existingHook) {
        results.push({
          name: "Scaffold reflection hook",
          status: "skipped",
          message: "already exists",
        });
      } else {
        // Check scaffold state for user-removal detection
        const scaffoldStatePath = path.join(projectDir, ".kspec", ".setup-scaffold-state.json");
        let previouslyScaffolded = false;
        try {
          const stateRaw = await fs.readFile(scaffoldStatePath, "utf-8");
          const state = JSON.parse(stateRaw);
          previouslyScaffolded = !!state.reflectionHookScaffolded;
        } catch {
          // No state file
        }

        if (previouslyScaffolded) {
          results.push({
            name: "Scaffold reflection hook",
            status: "skipped",
            message: "previously removed by user",
          });
        } else {
          if (!dryRun) {
            // AC: @default-session-reflection-hook ac-fires-once-per-invocation
            // AC: @single-command-version-upgrade ac-default-reflection-hook-first-idle-on-upgrade
            // Restrict to the first idle event of an invocation so reflection
            // fires once per invocation, not after every turn of a multi-turn
            // session. The filter value MUST be numeric; hook filter matching
            // uses strict equality against a z.number() payload field.
            // This matches the canonical hook shape in setup.ts.
            await saveHook(freshCtx, {
              _ulid: ulid(),
              name: hookName,
              on: "session.idle",
              filter: { turn_count: 1 },
              action: {
                type: "session_prompt",
                prompt: "Run session reflection using /kspec:reflect",
                skills: ["reflect"],
              },
              enabled: true,
            });

            // Update scaffold state
            let scaffoldState: Record<string, unknown> = {};
            try {
              const raw = await fs.readFile(scaffoldStatePath, "utf-8");
              scaffoldState = JSON.parse(raw);
            } catch {
              // Fresh state
            }
            scaffoldState.reflectionHookScaffolded = true;
            await fs.mkdir(path.dirname(scaffoldStatePath), { recursive: true });
            await fs.writeFile(
              scaffoldStatePath,
              JSON.stringify(scaffoldState, null, 2) + "\n",
              "utf-8",
            );
          }

          results.push({
            name: "Scaffold reflection hook",
            status: "done",
            message: dryRun
              ? "would create default reflection hook"
              : "created default reflection hook",
          });
        }
      }
    }
  } catch (err) {
    results.push({
      name: "Scaffold reflection hook",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 5d: Scaffold default module (ensure it exists)
  // Check whether the default module file (modules/main.yaml) specifically exists.
  // Having a *different* custom module is not sufficient — the spec requires
  // the default module scaffold to be backfilled if it's missing.
  try {
    const { initContext: initCtxForModule } = await import("../../parser/index.js");
    const freshCtx = await initCtxForModule();
    const defaultModulePath = path.join(freshCtx.specDir, "modules", "main.yaml");
    const hasDefaultModule = existsSync(defaultModulePath);

    if (hasDefaultModule) {
      results.push({
        name: "Scaffold default module",
        status: "skipped",
        message: "default module already exists",
      });
    } else if (dryRun) {
      results.push({
        name: "Scaffold default module",
        status: "done",
        message: "would create default module (modules/main.yaml)",
      });
    } else {
      // Create the default module and update manifest
      const { ulid: generateUlid } = await import("ulid");
      const { readYamlFile, writeYamlFilePreserveFormat } = await import("../../parser/yaml.js");
      const { shadowAutoCommit } = await import("../../parser/shadow.js");

      const moduleUlid = generateUlid();
      const modulesDir = path.join(freshCtx.specDir, "modules");
      const moduleFilePath = path.join(modulesDir, "main.yaml");
      await fs.mkdir(modulesDir, { recursive: true });

      // Get project name from manifest for the module title
      const manifest = freshCtx.manifest as Record<string, unknown> | null;
      const projectObj = manifest?.project as Record<string, unknown> | undefined;
      const projectName = (projectObj?.name as string) || "Project";

      const moduleContent = `_ulid: ${moduleUlid}
slugs:
  - main
title: "${projectName} - Main Module"
type: module
status:
  maturity: draft
  implementation: not_started
description: |
  Default module for ${projectName}. Add your spec items here.

items: []
`;
      await fs.writeFile(moduleFilePath, moduleContent, "utf-8");

      // Update manifest with default_module and includes
      if (freshCtx.manifestPath) {
        const manifestData = await readYamlFile<Record<string, unknown>>(freshCtx.manifestPath);
        if (manifestData) {
          if (!manifestData.default_module) {
            manifestData.default_module = moduleUlid;
          }
          const includes = manifestData.includes as string[] | undefined;
          if (!includes || !includes.includes("modules/main.yaml")) {
            manifestData.includes = [...(includes || []), "modules/main.yaml"];
          }
          await writeYamlFilePreserveFormat(freshCtx.manifestPath, manifestData);
        }
      }

      // Commit to shadow branch
      await shadowAutoCommit(freshCtx.specDir, "Scaffold default module via upgrade");

      results.push({
        name: "Scaffold default module",
        status: "done",
        message: "created default module (modules/main.yaml)",
      });
    }
  } catch (err) {
    results.push({
      name: "Scaffold default module",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return results;
}

// ─── Command Registration ─────────────────────────────────────────────────────

/**
 * Register the 'upgrade' command.
 *
 * AC: @single-command-version-upgrade (all ACs)
 * AC: @trait-dry-run ac-1 through ac-6
 * AC: @trait-json-output ac-1 through ac-6
 * AC: @trait-semantic-exit-codes ac-1, ac-4
 * AC: @trait-error-guidance ac-1, ac-2
 */
export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Upgrade project to the currently installed kspec version")
    .option("--dry-run", "Preview changes without applying them")
    .option("--force", "Re-run all upgrade steps even when project appears current")
    .action(async (options) => {
      try {
        const projectDir = process.cwd();

        // Check that we're in a kspec project
        const { initContext } = await import("../../parser/index.js");
        let ctx;
        try {
          ctx = await initContext();
        } catch (err) {
          // AC: @data-format-forward-compatibility ac-upgrade-refuses-newer
          // The context-initialization ceiling check owns the upgrade refusal
          // for newer-format projects: surface it with its deterministic code
          // instead of collapsing it into "no project found". The refusal
          // fires before detectSourceVersion or any pipeline step runs.
          const { isDeterministicFormatVersionIncompatibility } =
            await import("../../parser/format-version.js");
          if (isDeterministicFormatVersionIncompatibility(err)) {
            error(err.message, { code: err.code, suggestion: err.suggestion });
            process.exit(EXIT_CODES.ERROR);
            return;
          }
          // AC: @trait-error-guidance ac-1, ac-2
          // AC: @trait-json-output ac-3 — guidance included in structured error
          error("No kspec project found in the current directory.", {
            suggestion:
              "Run 'kspec init' to initialize a project, or change to a directory with a .kspec/ directory.",
          });
          process.exit(EXIT_CODES.ERROR);
          return;
        }

        if (!ctx.manifestPath) {
          // AC: @trait-error-guidance ac-1, ac-2
          // AC: @trait-json-output ac-3 — guidance included in structured error
          error("No kspec manifest found. Run 'kspec init' first.", {
            suggestion: "Run 'kspec init' to initialize a project.",
          });
          process.exit(EXIT_CODES.ERROR);
          return;
        }

        const dryRun = options.dryRun ?? false;
        const force = options.force ?? false;

        const result = await runUpgradePipeline(projectDir, {
          dryRun,
          force,
        });

        // AC: @trait-json-output ac-1, ac-2, ac-5, ac-6
        // AC: @trait-dry-run ac-6
        const outputData: Record<string, unknown> = {
          success: result.success,
          source_version: result.sourceVersion,
          target_version: result.targetVersion,
          confidence: result.confidence,
          is_refresh: result.isRefresh,
          noop: result.noop,
          steps: result.steps.map((s) => ({
            name: s.name,
            status: s.status,
            message: s.message,
            details: s.details,
          })),
          follow_ups: result.followUps,
          // AC: @release-notes-accessible ac-upgrade-surfaces-notes
          release_notes: result.releaseNotes,
          // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
          previous_shadow_commit: result.previousShadowCommit,
          ...(dryRun ? { dry_run: true } : {}),
        };

        // AC: @single-command-version-upgrade ac-reports-skew
        // AC: @single-command-version-upgrade ac-idempotent-when-current
        // AC: @single-command-version-upgrade ac-reports-manual-follow-ups
        // AC: @single-command-version-upgrade ac-dry-run-reports
        output(outputData, () => {
          // AC: @trait-dry-run ac-3 — clear indication this is a preview
          if (dryRun) {
            console.log(chalk.yellow("DRY RUN — no changes will be applied\n"));
          }

          // AC: @single-command-version-upgrade ac-reports-skew
          const sourceLabel = result.sourceVersion
            ? `${result.sourceVersion} (${result.confidence})`
            : `unknown`;
          console.log(`${chalk.gray("Source:")} ${sourceLabel}`);
          console.log(`${chalk.gray("Target:")} ${result.targetVersion}`);
          // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
          if (result.previousShadowCommit) {
            console.log(
              `${chalk.gray("Shadow HEAD (pre-upgrade rollback ref):")} ${result.previousShadowCommit}`,
            );
          }
          console.log();

          // AC: @single-command-version-upgrade ac-idempotent-when-current
          if (result.noop) {
            console.log(
              chalk.green("✓ Project is already at the current version. No changes necessary."),
            );
            return;
          }

          if (result.isRefresh) {
            console.log(
              chalk.yellow(
                "Version match with approximate confidence — running as safety refresh.\n",
              ),
            );
          }

          // Step results
          for (const step of result.steps) {
            let icon: string;
            if (step.status === "done") {
              icon = chalk.green("✓");
            } else if (step.status === "skipped") {
              icon = chalk.gray("○");
            } else if (step.status === "rolled_back") {
              icon = chalk.yellow("↶");
            } else {
              icon = chalk.red("✗");
            }
            let statusText = "";
            if (step.status === "failed") {
              statusText = chalk.red(" (failed)");
            } else if (step.status === "rolled_back") {
              statusText = chalk.yellow(" (rolled back)");
            }

            console.log(`${icon} ${step.name}${statusText}`);
            if (step.message) {
              console.log(chalk.gray(`  ${step.message}`));
            }
          }

          // AC: @single-command-version-upgrade ac-reports-manual-follow-ups
          if (result.followUps.length > 0) {
            console.log(chalk.bold("\nManual follow-ups:"));
            for (const followUp of result.followUps) {
              console.log(`  • ${followUp}`);
            }
          }

          // AC: @release-notes-accessible ac-upgrade-surfaces-notes
          if (result.releaseNotes.length > 0) {
            console.log(chalk.bold("\nRelease notes:"));
            console.log();
            for (const entry of result.releaseNotes) {
              process.stdout.write(entry.markdown);
              console.log();
            }
          }

          console.log();

          if (!result.success) {
            // AC: @trait-error-guidance ac-1, ac-2
            const failedSteps = result.steps.filter((s) => s.status === "failed");
            console.log(chalk.red(`Upgrade completed with ${failedSteps.length} failed step(s).`));
            console.log(
              chalk.gray(
                "Suggested action: review the failed steps above and re-run 'kspec upgrade'.",
              ),
            );
          } else if (dryRun) {
            console.log(chalk.yellow("Run 'kspec upgrade' without --dry-run to apply changes."));
          } else {
            console.log(chalk.green("Upgrade complete."));
          }
        });

        // AC: @trait-semantic-exit-codes ac-1, ac-4
        // Runtime step failures during upgrade execution use exit code 3
        // (NOT_FOUND in our enum, mapped to "runtime error" per trait convention)
        // so callers can distinguish operational failures from generic errors.
        if (!result.success) {
          process.exit(EXIT_CODES.NOT_FOUND);
        }
      } catch (err) {
        // AC: @trait-error-guidance ac-1, ac-2
        // AC: @trait-json-output ac-3 — guidance included in structured error
        const errMessage = err instanceof Error ? err.message : String(err);
        const suggestion = errMessage.includes("kspec init")
          ? "Run 'kspec init' to initialize a project."
          : "Check the error above and re-run 'kspec upgrade'.";
        error(`Upgrade failed: ${errMessage}`, { suggestion });
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
