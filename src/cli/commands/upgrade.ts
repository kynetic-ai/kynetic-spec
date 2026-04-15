/**
 * Upgrade command — brings a project from any previously-supported kspec version
 * to the currently installed version in a single invocation.
 *
 * AC: @single-command-version-upgrade (all ACs)
 */

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { EXIT_CODES } from "../exit-codes.js";
import { error, isStructuredMode, output, success, warn } from "../output.js";

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
  status: "done" | "skipped" | "failed";
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

async function writeSetupState(
  specDir: string,
  state: SetupState,
): Promise<void> {
  const statePath = path.join(specDir, SETUP_STATE_FILE);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(state, null, 2) + "\n",
    "utf-8",
  );
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
 * When no probes are conclusive, returns unknown.
 *
 * AC: @single-command-version-upgrade ac-source-version-fallback
 */
async function inferVersionFromProbes(
  specDir: string,
  projectDir: string,
): Promise<SourceVersionResult> {
  const { loadProjectConfig, CONFIG_FILENAME } = await import("../../parser/config.js");

  // Track the minimum version indicated by each probe
  let maxMinVersion = "0.1.0";
  let anyProbeMatched = false;

  // Probe 1: Does the .kspec/ directory exist at all?
  if (!existsSync(specDir)) {
    return { version: null, confidence: "unknown" };
  }
  anyProbeMatched = true;

  // Probe 2: Check manifest for task_storage.format and kynetic version
  const manifestPath = path.join(specDir, "kynetic.yaml");
  try {
    const yaml = await import("yaml");
    const raw = await fs.readFile(manifestPath, "utf-8");
    const manifest = yaml.parse(raw);
    if (manifest) {
      const kyneticVer = manifest.kynetic || manifest.kynetic_spec;
      if (kyneticVer === "1.1") {
        maxMinVersion = bumpIfHigher(maxMinVersion, "0.9.0");
      }
      if (manifest.task_storage?.format === "split") {
        maxMinVersion = bumpIfHigher(maxMinVersion, "0.9.0");
      }
    }
  } catch {
    // Manifest unreadable — counts as "old project" indicator
  }

  // Probe 3: Check for kspec.config.yaml
  const configPath = path.join(projectDir, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    maxMinVersion = bumpIfHigher(maxMinVersion, "0.11.0");
  }

  // Probe 4: Check for rendered skills directory
  const agentsSkillsDir = path.join(projectDir, ".agents", "skills");
  if (existsSync(agentsSkillsDir)) {
    maxMinVersion = bumpIfHigher(maxMinVersion, "0.8.0");
  }

  // Probe 5: Check for review-plan skill (added in 0.10)
  const reviewPlanSkill = path.join(agentsSkillsDir, "kspec-review-plan.md");
  if (existsSync(reviewPlanSkill)) {
    maxMinVersion = bumpIfHigher(maxMinVersion, "0.10.0");
  }

  if (!anyProbeMatched) {
    return { version: null, confidence: "unknown" };
  }

  return { version: maxMinVersion, confidence: "approximate" };
}

/**
 * Simple semver comparison — returns the higher of two version strings.
 */
function bumpIfHigher(current: string, candidate: string): string {
  const a = current.split(".").map(Number);
  const b = candidate.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((b[i] || 0) > (a[i] || 0)) return candidate;
    if ((b[i] || 0) < (a[i] || 0)) return current;
  }
  return current;
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
    throw new Error(
      "No kspec project found. Run 'kspec init' first to initialize a project.",
    );
  }

  const source = await detectSourceVersion(ctx.specDir, projectDir);

  // AC: @single-command-version-upgrade ac-idempotent-when-current
  const isCurrent =
    source.version === targetVersion && source.confidence === "exact";
  const isRefresh =
    source.version === targetVersion && source.confidence === "approximate";

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
    };
  }

  // ─── Step 1: Task storage migration ─────────────────────────────────
  // AC: @single-command-version-upgrade ac-runs-task-storage-migration
  try {
    const migrationResult = await runTaskStorageMigrationStep(
      ctx,
      dryRun,
    );
    steps.push(migrationResult);
    if (migrationResult.status === "done") {
      const count = (migrationResult.details?.migrated as number) || 0;
      if (count > 0) {
        followUps.push(
          `Task storage: ${count} task(s) migrated to per-task directory format`,
        );
      }
    }
  } catch (err) {
    steps.push({
      name: "Task storage migration",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── Step 2: Re-render skills ───────────────────────────────────────
  // AC: @single-command-version-upgrade ac-rerenders-skills
  try {
    const skillResult = await runRerenderSkillsStep(
      projectDir,
      dryRun,
    );
    steps.push(skillResult);
    if (skillResult.status === "done") {
      const renderedCount = (skillResult.details?.rendered as number) || 0;
      const removedCount = (skillResult.details?.removed as number) || 0;
      const parts: string[] = [];
      if (renderedCount > 0) parts.push(`${renderedCount} re-rendered`);
      if (removedCount > 0) parts.push(`${removedCount} obsolete removed`);
      if (parts.length > 0) {
        followUps.push(
          `Skills: ${parts.join(", ")} — review .agents/skills/ for changes`,
        );
      }
    }
  } catch (err) {
    steps.push({
      name: "Re-render skills",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── Step 3: Regenerate agents file ─────────────────────────────────
  // AC: @single-command-version-upgrade ac-regenerates-agents-file
  try {
    const agentsResult = await runRegenerateAgentsStep(
      projectDir,
      dryRun,
    );
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

  // ─── Step 4: Restore gitignore entries ──────────────────────────────
  // AC: @single-command-version-upgrade ac-restores-gitignore-entries
  try {
    const gitignoreResult = await runGitignoreRepairStep(
      projectDir,
      dryRun,
    );
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

  // ─── Step 5: Scaffold missing files ─────────────────────────────────
  // AC: @single-command-version-upgrade ac-reports-manual-follow-ups
  try {
    const scaffoldResults = await runScaffoldMissingStep(
      projectDir,
      ctx,
      dryRun,
      force,
    );
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

  // ─── Step 6: Write lastKnownVersion ─────────────────────────────────
  if (!dryRun) {
    try {
      const state = await readSetupState(ctx.specDir);
      state.lastKnownVersion = targetVersion;
      await writeSetupState(ctx.specDir, state);
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
      status: "done",
      message: `would record version ${targetVersion}`,
    });
  }

  const allSuccess = steps.every((s) => s.status !== "failed");

  return {
    success: allSuccess,
    sourceVersion: source.version,
    targetVersion,
    confidence: source.confidence,
    isRefresh,
    noop: false,
    steps,
    followUps,
  };
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
  // Check if migration is needed: monolithic format or no format specified
  const taskStorage = (ctx.manifest as Record<string, unknown> | null)?.task_storage as
    | { format?: string }
    | undefined;
  const currentFormat = taskStorage?.format;

  if (currentFormat === "split") {
    return {
      name: "Task storage migration",
      status: "skipped",
      message: "already using split format",
      details: { migrated: 0 },
    };
  }

  // Check if there are actually tasks to migrate
  const { extractRawTaskArray } = await import("../../parser/yaml.js");
  const { getIndexFilePath } = await import("../../parser/split-backend.js");
  const indexPath = getIndexFilePath(ctx as Parameters<typeof getIndexFilePath>[0]);

  let rawTaskCount = 0;
  try {
    const { rawTasks } = await extractRawTaskArray(indexPath);
    // Count monolithic entries (those without notes_count as a number)
    rawTaskCount = rawTasks.filter(
      (t) => t && typeof t === "object" && typeof (t as Record<string, unknown>).notes_count !== "number",
    ).length;
  } catch {
    // No tasks file — nothing to migrate
  }

  if (rawTaskCount === 0) {
    // Still upgrade the manifest to mark format as split
    if (!dryRun) {
      const { writeYamlFilePreserveFormat } = await import("../../parser/yaml.js");
      if (ctx.manifestPath) {
        const { readYamlFile } = await import("../../parser/yaml.js");
        const manifest = await readYamlFile<Record<string, unknown>>(ctx.manifestPath);
        if (manifest) {
          manifest.kynetic = "1.1";
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
      message: "no monolithic tasks to migrate; manifest updated to split format",
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
      message:
        migrated > 0
          ? `${migrated} task(s) migrated`
          : "no tasks needed migration",
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
 * Step 2: Re-render skills and remove obsolete rendered skills.
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
  const {
    getRenderer,
    getSkillSubdir,
    getAllRenderers,
    isKspecManagedSkill,
  } = await import("../../parser/skill-render.js");

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
    } catch {
      skipped++;
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
      activeSubdirsByPlatform
        .get(platform)!
        .add(getSkillSubdir(skill.id, skill.origin, platform));
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
 * Step 3: Regenerate agent instructions file.
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

  let templateSections: string[] = [];
  try {
    templateSections = await loadTemplateSections(getPackageRoot());
  } catch {
    // No templates available
  }

  const content = await generateAgentsContent(
    metaCtx.conventions,
    metaCtx.workflows,
    timestamp,
    templateSections,
  );

  const outputPath = path.join(projectDir, "kspec-agents.md");
  const hashPath = path.join(projectDir, ".kspec", ".kspec-agents-hash");

  if (!dryRun) {
    // Check if regeneration is needed via hash comparison
    const metaHash = computeMetaHash(metaCtx.conventions, metaCtx.workflows, templateSections);

    let storedHash: string | undefined;
    try {
      const hashContent = await fs.readFile(hashPath, "utf-8");
      const hashData = JSON.parse(hashContent);
      storedHash = hashData.metaHash;
    } catch {
      // No hash — regenerate
    }

    let outputExists = false;
    try {
      await fs.access(outputPath);
      outputExists = true;
    } catch {
      // Missing
    }

    if (storedHash === metaHash && outputExists) {
      return {
        name: "Regenerate agent instructions",
        status: "skipped",
        message: "already up to date",
        details: { skipped: true },
      };
    }

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

  return {
    name: "Regenerate agent instructions",
    status: "done",
    message: dryRun ? "would regenerate kspec-agents.md" : "regenerated kspec-agents.md",
    details: { skipped: false },
  };
}

/**
 * Step 4: Restore gitignore entries.
 * Reuses ensureKspecGitignore from parser/gitignore.ts.
 *
 * AC: @single-command-version-upgrade ac-restores-gitignore-entries
 */
async function runGitignoreRepairStep(
  projectDir: string,
  dryRun: boolean,
): Promise<UpgradeStepResult> {
  const {
    ensureKspecGitignore,
    updateManagedBlock,
    buildKspecGitignoreEntries,
    parseManagedBlock,
  } = await import("../../parser/gitignore.js");
  const { loadProjectConfig } = await import("../../parser/config.js");

  const { config: projectConfig } = await loadProjectConfig(projectDir, projectDir);
  const shadowDir = projectConfig.shadow.directory || undefined;
  const worktreeRoot = projectConfig.dispatch.worktree_root || undefined;

  if (dryRun) {
    // Preview what would change
    const gitignorePath = path.join(projectDir, ".gitignore");
    let gitignoreContent = "";
    let fileExists = false;
    try {
      gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
      fileExists = true;
    } catch {
      // File doesn't exist
    }

    if (fileExists && parseManagedBlock(gitignoreContent).block === null) {
      return {
        name: "Restore gitignore entries",
        status: "skipped",
        message: "exists without managed block (use --force to add)",
      };
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
        ? `would create .gitignore with: ${dryResult.result.entriesAdded.join(", ")}`
        : `would add: ${dryResult.result.entriesAdded.join(", ")}`,
      details: { entriesAdded: dryResult.result.entriesAdded },
    };
  }

  // Actually repair
  const result = await ensureKspecGitignore(projectDir, {
    shadowDir,
    worktreeRoot,
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
 * Step 5: Scaffold any missing files.
 * Runs: scaffoldProjectConfig, scaffoldDefaults, ensureDefaultReflectionHook — but only creates what is missing.
 *
 * AC: @single-command-version-upgrade ac-reports-manual-follow-ups
 */
async function runScaffoldMissingStep(
  projectDir: string,
  ctx: { manifestPath: string | null; specDir: string },
  dryRun: boolean,
  force: boolean,
): Promise<UpgradeStepResult[]> {
  const results: UpgradeStepResult[] = [];

  // 5a: Scaffold project config
  const { loadProjectConfig, CONFIG_FILENAME } = await import("../../parser/config.js");
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
      message: dryRun
        ? `would create ${CONFIG_FILENAME}`
        : `created ${CONFIG_FILENAME}`,
    });
  } else {
    results.push({
      name: "Scaffold project config",
      status: "skipped",
      message: `${CONFIG_FILENAME} already exists`,
    });
  }

  // 5b: Scaffold default agents and conventions
  try {
    const { scaffoldDefaults } = await import("./setup-defaults.js");
    const { initContext } = await import("../../parser/index.js");
    const freshCtx = await initContext();

    const scaffoldResult = await scaffoldDefaults(freshCtx, { dryRun, force });
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

        if (previouslyScaffolded && !force) {
          results.push({
            name: "Scaffold reflection hook",
            status: "skipped",
            message: "previously removed by user",
          });
        } else {
          if (!dryRun) {
            await saveHook(freshCtx, {
              _ulid: ulid(),
              name: hookName,
              on: "session.idle",
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
  try {
    const { loadAllItems } = await import("../../parser/yaml.js");
    const { initContext: initCtxForModule } = await import("../../parser/index.js");
    const freshCtx = await initCtxForModule();
    const items = await loadAllItems(freshCtx);
    const hasModule = items.some((item) => item.type === "module");

    if (hasModule) {
      results.push({
        name: "Scaffold default module",
        status: "skipped",
        message: "module already exists",
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
      const {
        readYamlFile,
        writeYamlFilePreserveFormat,
      } = await import("../../parser/yaml.js");
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
        const manifestData = await readYamlFile<Record<string, unknown>>(
          freshCtx.manifestPath,
        );
        if (manifestData) {
          manifestData.default_module = moduleUlid;
          const includes = manifestData.includes as string[] | undefined;
          if (!includes || !includes.includes("modules/main.yaml")) {
            manifestData.includes = [
              ...(includes || []),
              "modules/main.yaml",
            ];
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
        } catch {
          // AC: @trait-error-guidance ac-1, ac-2
          error("No kspec project found in the current directory.");
          console.error(
            chalk.gray(
              "Suggested action: run 'kspec init' to initialize a project, or change to a directory with a .kspec/ directory.",
            ),
          );
          process.exit(EXIT_CODES.ERROR);
          return;
        }

        if (!ctx.manifestPath) {
          error("No kspec manifest found. Run 'kspec init' first.");
          console.error(
            chalk.gray(
              "Suggested action: run 'kspec init' to initialize a project.",
            ),
          );
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
          console.log(
            `${chalk.gray("Source:")} ${sourceLabel}`,
          );
          console.log(
            `${chalk.gray("Target:")} ${result.targetVersion}`,
          );
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
            const icon =
              step.status === "done"
                ? chalk.green("✓")
                : step.status === "skipped"
                  ? chalk.gray("○")
                  : chalk.red("✗");
            const statusText =
              step.status === "failed" ? chalk.red(" (failed)") : "";

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

          console.log();

          if (!result.success) {
            // AC: @trait-error-guidance ac-1, ac-2
            const failedSteps = result.steps.filter(
              (s) => s.status === "failed",
            );
            console.log(
              chalk.red(
                `Upgrade completed with ${failedSteps.length} failed step(s).`,
              ),
            );
            console.log(
              chalk.gray(
                "Suggested action: review the failed steps above and re-run 'kspec upgrade'.",
              ),
            );
          } else if (dryRun) {
            console.log(
              chalk.yellow("Run 'kspec upgrade' without --dry-run to apply changes."),
            );
          } else {
            console.log(chalk.green("Upgrade complete."));
          }
        });

        // AC: @trait-semantic-exit-codes ac-1, ac-4
        if (!result.success) {
          process.exit(EXIT_CODES.ERROR);
        }
      } catch (err) {
        // AC: @trait-error-guidance ac-1, ac-2
        // AC: @trait-json-output ac-3
        error(
          `Upgrade failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (err instanceof Error && err.message.includes("kspec init")) {
          console.error(
            chalk.gray("Suggested action: run 'kspec init' to initialize a project."),
          );
        } else {
          console.error(
            chalk.gray(
              "Suggested action: check the error above and re-run 'kspec upgrade'.",
            ),
          );
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
