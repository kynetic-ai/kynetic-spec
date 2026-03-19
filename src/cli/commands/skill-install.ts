/**
 * Skill core installation and update commands.
 *
 * AC: @core-skill-install ac-1 - meta entries created with origin core
 * AC: @core-skill-install ac-2 - content files copied from templates to .kspec/skills/<id>/
 * AC: @core-skill-install ac-3 - custom skills skipped with message
 * AC: @core-skill-install ac-4 - --force overwrites custom forks
 * AC: @core-skill-install ac-5 - version matches kspec package version
 * AC: @core-skill-install ac-6 - marketplace registration in known_marketplaces.json
 * AC: @core-skill-install ac-7 - plugin enabled in project settings
 * AC: @core-skill-install ac-8 - idempotent marketplace registration
 *
 * AC: @core-skill-update ac-1 - skill content and version updated when version differs
 * AC: @core-skill-update ac-2 - skill skipped when already at current version
 * AC: @core-skill-update ac-3 - skills with origin custom/project not touched
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { ulid } from "ulid";
import yaml from "yaml";
import { detectAgentFromEnv } from "../../parser/agent-detection.js";
import { markMutating } from "../command-annotations.js";
import {
  getActiveBatchBuffer,
  mkdirBufferAware,
  readdirBufferAware,
  writeFileBufferAware,
} from "../batch-write-buffer.js";
import {
  getSkillContentPath,
  initContext,
  loadMetaContext,
  readFileBufferAware,
  type LoadedSkill,
  saveMetaItem,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { SkillSchema } from "../../schema/index.js";
import { errors } from "../../strings/errors.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output, success } from "../output.js";
import { ensureCodexProjectDocFallback } from "../../lib/codex-config.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of updating a single core skill
 * AC: @core-skill-update
 */
interface CoreSkillUpdateResult {
  id: string;
  action: "updated" | "skipped";
  previousVersion?: string;
  newVersion?: string;
  currentVersion?: string;
  reason?: string;
  guidance?: string;
}

/**
 * Result of installing a single core skill
 */
interface CoreSkillInstallResult {
  id: string;
  action: "created" | "updated" | "skipped" | "failed";
  version?: string;
  reason?: string;
}

/**
 * Core skill definition from manifest
 */
interface CoreSkillDefinition {
  id: string;
  name: string;
  description?: string;
  platforms?: string[];
}

type CoreInstallPlatform = "claude-code" | "codex" | "droid";

interface CoreSkillRenderSummary {
  platform: CoreInstallPlatform;
  source: "auto-detect" | "override";
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  pluginProvided: number;
  failed: number;
}

// ============================================================================
// Template Management Helpers
// ============================================================================

/**
 * Get the kspec package version from package.json
 * AC: @core-skill-install ac-5
 */
export async function getKspecPackageVersion(): Promise<string | null> {
  try {
    // Try to find package.json relative to this module
    const packagePath = path.resolve(
      import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
      "../../../package.json"
    );
    const packageJson = JSON.parse(await fs.readFile(packagePath, "utf-8"));
    return packageJson.version || null;
  } catch {
    return null;
  }
}

/**
 * Get the templates directory path
 */
function getTemplatesDir(): string {
  // Templates are at <package-root>/templates/skills/
  return path.resolve(
    import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
    "../../../templates/skills"
  );
}

/**
 * Load core skills manifest from templates/skills/manifest.yaml
 * AC: @core-skill-install ac-1, ac-2
 */
export async function loadCoreSkillsManifest(): Promise<CoreSkillDefinition[]> {
  try {
    const templatesDir = getTemplatesDir();
    const manifestPath = path.join(templatesDir, "manifest.yaml");
    const content = await fs.readFile(manifestPath, "utf-8");
    const parsed = yaml.parse(content);

    if (!parsed || !Array.isArray(parsed.skills)) {
      return [];
    }

    return parsed.skills.map((s: Record<string, unknown>) => ({
      id: String(s.id || ""),
      name: String(s.name || s.id || ""),
      description: s.description ? String(s.description) : undefined,
      platforms: Array.isArray(s.platforms) ? s.platforms.map(String) : undefined,
    })).filter((s: CoreSkillDefinition) => s.id);
  } catch {
    return [];
  }
}

/**
 * Load SKILL.md content for a core skill from templates
 * AC: @core-skill-install ac-2
 */
export async function loadCoreSkillContent(skillId: string): Promise<string | null> {
  try {
    const templatesDir = getTemplatesDir();
    const skillMdPath = path.join(templatesDir, skillId, "SKILL.md");
    return await fs.readFile(skillMdPath, "utf-8");
  } catch {
    return null;
  }
}

/** Supporting directory names that may accompany a skill template. */
const SKILL_SUPPORTING_DIRS = ["docs", "references", "scripts", "assets"] as const;

/**
 * Recursively copy a directory tree.
 * Only copies files; creates directories as needed.
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  await mkdirBufferAware(dest);
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      const srcContent = await fs.readFile(srcPath);
      await writeFileBufferAware(destPath, srcContent);
    }
  }
}

function createNotFoundError(filePath: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${filePath}'`),
    { code: "ENOENT" },
  ) as NodeJS.ErrnoException;
}

async function readBinaryBufferAware(filePath: string): Promise<Buffer> {
  const buffer = getActiveBatchBuffer();
  if (buffer?.isInScope(filePath)) {
    if (buffer.isDeletedInOverlay(filePath)) {
      throw createNotFoundError(filePath);
    }

    const buffered = buffer.read(filePath);
    if (buffered !== undefined) {
      if (buffered === null) {
        throw createNotFoundError(filePath);
      }
      return typeof buffered === "string"
        ? Buffer.from(buffered, "utf-8")
        : Buffer.from(buffered);
    }
  }

  return fs.readFile(filePath);
}

/**
 * Check if all source entries exist in dest with identical content.
 * Uses subset comparison: extra files in dest are ignored since
 * copyDirRecursive is an overlay copy that doesn't delete extra files.
 */
async function sourceMatchesDest(src: string, dest: string): Promise<boolean> {
  try {
    const srcEntries = await fs.readdir(src, { withFileTypes: true });
    const destEntries = new Set(await readdirBufferAware(dest) as string[]);

    for (const srcEntry of srcEntries) {
      if (!destEntries.has(srcEntry.name)) return false;

      const srcPath = path.join(src, srcEntry.name);
      const destPath = path.join(dest, srcEntry.name);

      if (srcEntry.isDirectory()) {
        if (!(await sourceMatchesDest(srcPath, destPath))) return false;
      } else if (srcEntry.isFile()) {
        // Use Buffer comparison for binary safety (assets/ may contain images)
        const srcBuf = await fs.readFile(srcPath);
        const destBuf = await readBinaryBufferAware(destPath);
        if (!srcBuf.equals(destBuf)) return false;
      } else {
        return false; // Type mismatch
      }
    }
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Copy all files for a core skill from templates to .kspec/skills/<id>/.
 * Copies SKILL.md and any supporting directories (docs/, references/, etc.).
 * Skips writing files when content is unchanged to avoid unnecessary git diffs.
 * AC: @core-skill-install ac-2
 */
export async function copyCoreSkillFiles(
  skillId: string,
  targetDir: string
): Promise<{ changed: boolean }> {
  const templatesDir = getTemplatesDir();
  const sourceDir = path.join(templatesDir, skillId);
  let changed = false;

  // Copy SKILL.md — skip if template doesn't exist, propagate real errors
  const skillMdPath = path.join(sourceDir, "SKILL.md");
  let content: string;
  try {
    content = await fs.readFile(skillMdPath, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { changed: false }; // No SKILL.md means nothing to copy
    }
    throw err;
  }

  // Compare before writing to avoid unnecessary git diffs
  const targetSkillMd = path.join(targetDir, "SKILL.md");
  let existingContent: string | null = null;
  try {
    existingContent = await readFileBufferAware(targetSkillMd);
  } catch {
    // Target doesn't exist yet
  }

  if (existingContent !== content) {
    await mkdirBufferAware(targetDir);
    await writeFileBufferAware(targetSkillMd, content);
    changed = true;
  }

  // Copy supporting directories recursively, skipping when unchanged
  for (const dirName of SKILL_SUPPORTING_DIRS) {
    const srcSubDir = path.join(sourceDir, dirName);
    try {
      await fs.access(srcSubDir);
    } catch (err) {
      // ENOENT: directory doesn't exist in template, skip
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err; // Propagate real I/O errors
    }

    const destSubDir = path.join(targetDir, dirName);
    if (await sourceMatchesDest(srcSubDir, destSubDir)) {
      continue; // Content unchanged, skip copy
    }

    await copyDirRecursive(srcSubDir, destSubDir);
    changed = true;
  }

  return { changed };
}

function resolveCoreInstallPlatform(
  override?: string
): { platform: CoreInstallPlatform; source: "auto-detect" | "override" } {
  if (override === "claude-code" || override === "codex" || override === "droid") {
    return { platform: override, source: "override" };
  }

  const detected = detectAgentFromEnv();
  if (detected.type === "codex-cli") {
    return { platform: "codex", source: "auto-detect" };
  }
  return { platform: "claude-code", source: "auto-detect" };
}

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Register skill install/update commands (install-core, update)
 */
export function registerSkillInstallCommands(skill: Command): void {
  // AC: @core-skill-install - kspec skill install-core
  markMutating(skill.command("install-core"))
    .description(
      "Install core skills from kspec package templates"
    )
    .option("--force", "Overwrite custom forks with core versions")
    .option("--dry-run", "Show what would be installed without making changes")
    .option(
      "--platform <platform>",
      "Render target platform override (claude-code|codex|droid)"
    )
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          console.log(
            chalk.gray("Try: kspec init to initialize a kspec project")
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const dryRun = options.dryRun || false;
        const force = options.force || false;
        const platformOverride = options.platform as string | undefined;
        if (
          platformOverride
          && platformOverride !== "claude-code"
          && platformOverride !== "codex"
          && platformOverride !== "droid"
        ) {
          error(
            `Invalid --platform value "${platformOverride}". Expected "claude-code", "codex", or "droid".`
          );
          process.exit(EXIT_CODES.ERROR);
        }
        const renderTarget = resolveCoreInstallPlatform(platformOverride);
        const results: CoreSkillInstallResult[] = [];
        const installedSkills: LoadedSkill[] = [];

        // Load core skills manifest
        const coreSkills = await loadCoreSkillsManifest();
        if (coreSkills.length === 0) {
          console.log(chalk.yellow("No core skills found in kspec package templates"));
          return;
        }

        // Get kspec package version
        // AC: @cross-platform-and-version-robustness ac-3
        const kspecVersion = await getKspecPackageVersion();
        if (!kspecVersion) {
          console.log(chalk.yellow("Warning: Could not determine kspec version — skills installed without version tracking"));
        }

        // Process each core skill
        for (const coreSkill of coreSkills) {
          // AC: @core-skill-install ac-3 - Check if skill exists with custom origin
          const existingSkill = metaCtx.skills.find((s) => s.id === coreSkill.id);

          if (existingSkill) {
            // Check origin - if "custom" or "project" and not forcing, skip
            if (existingSkill.origin !== "core" && !force) {
              results.push({
                id: coreSkill.id,
                action: "skipped",
                reason: `existing ${existingSkill.origin} skill (use --force to overwrite)`,
              });
              continue;
            }
          }

          // AC: @core-skill-install ac-1 - Create/update meta entry with origin core
          // AC: @core-skill-install ac-5 - Version matches kspec package version
          // Schema provides defaults for platforms, depends_on
          const skillData = {
            _ulid: existingSkill?._ulid || ulid(),
            id: coreSkill.id,
            name: coreSkill.name,
            description: coreSkill.description,
            origin: "core",
            ...(kspecVersion && { version: kspecVersion }),
            ...(coreSkill.platforms && { platforms: coreSkill.platforms }),
            allowed_tools: [],
            tags: ["core"],
          };

          // Validate with schema
          const parsed = SkillSchema.safeParse(skillData);
          if (!parsed.success) {
            const issues = parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ");
            results.push({
              id: coreSkill.id,
              action: "failed",
              reason: `validation error: ${issues}`,
            });
            continue;
          }

          const skill: LoadedSkill = { ...parsed.data };

          // Save meta entry (if not dry run)
          if (!dryRun) {
            await saveMetaItem(ctx, skill, "skill");

            // AC: @core-skill-install ac-2 - Copy skill files (SKILL.md + supporting dirs)
            const targetDir = path.dirname(getSkillContentPath(ctx, skill.id));
            await copyCoreSkillFiles(coreSkill.id, targetDir);
          }

          results.push({
            id: coreSkill.id,
            action: existingSkill ? "updated" : "created",
            version: kspecVersion ?? undefined,
          });
          installedSkills.push(skill);
        }

        const renderSummary: CoreSkillRenderSummary = {
          platform: renderTarget.platform,
          source: renderTarget.source,
          created: 0,
          updated: 0,
          unchanged: 0,
          skipped: 0,
          pluginProvided: 0,
          failed: 0,
        };
        if (installedSkills.length > 0) {
          const { getRenderer } = await import("../../parser/skill-render.js");
          const renderer = getRenderer(renderTarget.platform);
          if (!renderer) {
            renderSummary.failed = installedSkills.length;
          } else {
            for (const coreSkill of installedSkills) {
              try {
                const renderResult = await renderer.render(ctx, ctx.rootDir, coreSkill, {
                  dryRun,
                });
                switch (renderResult.action) {
                  case "created":
                    renderSummary.created++;
                    break;
                  case "updated":
                    renderSummary.updated++;
                    break;
                  case "unchanged":
                    renderSummary.unchanged++;
                    break;
                  case "skipped":
                    renderSummary.skipped++;
                    if (renderResult.skipCode === "plugin-provided") {
                      renderSummary.pluginProvided++;
                    }
                    break;
                }
              } catch {
                renderSummary.failed++;
              }
            }
          }
        }

        // Commit changes if not dry run
        if (!dryRun && results.some((r) => r.action === "created" || r.action === "updated")) {
          await commitIfShadow(
            ctx.shadow,
            "skill-install-core",
            undefined,
            `${results.filter((r) => r.action !== "skipped" && r.action !== "failed").length} core skills`,
          );
        }

        // AC: @core-skill-install ac-6, ac-7 - Register marketplace and enable plugin
        const { registerCorePluginMarketplace, enablePluginInProject } = await import(
          "../../lib/claude-plugin-registry.js"
        );
        const marketplaceResult = await registerCorePluginMarketplace({ dryRun });
        const enableResult = await enablePluginInProject(ctx.rootDir, { dryRun });
        // AC: @new-project-bootstrapping ac-3 - Codex fallback includes kspec-agents.md
        const codexProjectDocsResult = renderTarget.platform === "codex"
          ? await ensureCodexProjectDocFallback("kspec-agents.md", { dryRun })
          : null;

        // Output results
        output(
          {
            dry_run: dryRun,
            results,
            render: renderSummary,
            marketplace: marketplaceResult,
            pluginEnabled: enableResult,
            codexProjectDocs: codexProjectDocsResult,
          },
          () => {
            if (dryRun) {
              console.log(chalk.yellow("DRY RUN - No changes made"));
              console.log();
            }

            const created = results.filter((r) => r.action === "created");
            const updated = results.filter((r) => r.action === "updated");
            const skipped = results.filter((r) => r.action === "skipped");
            const failed = results.filter((r) => r.action === "failed");

            if (created.length > 0) {
              console.log(chalk.green(`Created: ${created.length} skill(s)`));
              for (const r of created) {
                console.log(`  ${chalk.green("+")} ${r.id}${r.version ? ` (v${r.version})` : ""}`);
              }
            }

            if (updated.length > 0) {
              console.log(chalk.blue(`Updated: ${updated.length} skill(s)`));
              for (const r of updated) {
                console.log(`  ${chalk.blue("~")} ${r.id}${r.version ? ` (v${r.version})` : ""}`);
              }
            }

            if (skipped.length > 0) {
              console.log(chalk.yellow(`Skipped: ${skipped.length} skill(s)`));
              for (const r of skipped) {
                console.log(`  ${chalk.yellow("!")} ${r.id}: ${r.reason}`);
              }
            }

            if (failed.length > 0) {
              console.log(chalk.red(`Failed: ${failed.length} skill(s)`));
              for (const r of failed) {
                console.log(`  ${chalk.red("x")} ${r.id}: ${r.reason}`);
              }
            }
            console.log();
            console.log(
              chalk.gray(
                `Render target: ${renderSummary.platform} (${renderSummary.source})`
              )
            );
            if (renderSummary.created > 0 || renderSummary.updated > 0) {
              console.log(
                chalk.green(
                  `Rendered: ${renderSummary.created + renderSummary.updated} skill(s)`
                )
              );
            }
            if (renderSummary.pluginProvided > 0) {
              console.log(
                chalk.gray(
                  `Plugin-provided: ${renderSummary.pluginProvided} skill(s) skipped local render`
                )
              );
            }
            if (renderSummary.unchanged > 0) {
              console.log(chalk.gray(`Unchanged render: ${renderSummary.unchanged} skill(s)`));
            }
            if (renderSummary.failed > 0) {
              console.log(chalk.red(`Render failed: ${renderSummary.failed} skill(s)`));
            }

            console.log();
            if (dryRun) {
              console.log(
                chalk.yellow("No changes were made. Run without --dry-run to apply.")
              );
            } else {
              const changedCount = created.length + updated.length;
              if (changedCount > 0) {
                success(`Installed ${changedCount} core skill(s)`);
              } else if (skipped.length > 0) {
                console.log(chalk.gray("No skills installed (all skipped or failed)"));
              }
            }

            // AC: @core-skill-install ac-6 - Report marketplace registration
            if (marketplaceResult.success && marketplaceResult.action !== "skipped") {
              console.log(chalk.green(`Plugin marketplace ${marketplaceResult.action}`));
            } else if (!marketplaceResult.success) {
              console.log(chalk.red(`Marketplace registration failed: ${marketplaceResult.message}`));
            }

            // AC: @core-skill-install ac-7 - Report plugin enablement
            if (enableResult.success && enableResult.action === "enabled") {
              console.log(chalk.green("Plugin enabled in project settings"));
            } else if (!enableResult.success) {
              console.log(chalk.red(`Plugin enablement failed: ${enableResult.message}`));
            }

            if (codexProjectDocsResult) {
              if (codexProjectDocsResult.success && codexProjectDocsResult.action === "added") {
                console.log(chalk.green(codexProjectDocsResult.message));
              } else if (codexProjectDocsResult.success) {
                console.log(chalk.gray(codexProjectDocsResult.message));
              } else {
                console.log(chalk.red(`Codex fallback update failed: ${codexProjectDocsResult.message}`));
              }
            }
          }
        );

        // Exit non-zero if plugin registration or enablement failed
        if (
          !marketplaceResult.success
          || !enableResult.success
          || renderSummary.failed > 0
          || (codexProjectDocsResult && !codexProjectDocsResult.success)
        ) {
          process.exit(EXIT_CODES.ERROR);
        }
      } catch (err) {
        error("Failed to install core skills", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @core-skill-update - kspec skill update
  markMutating(skill.command("update"))
    .description(
      "Update core skills to match the installed kspec package version"
    )
    .option("--dry-run", "Show what would be updated without making changes")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          console.log(
            chalk.gray("Try: kspec init to initialize a kspec project")
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const dryRun = options.dryRun || false;
        const results: CoreSkillUpdateResult[] = [];

        // Get kspec package version
        // AC: @cross-platform-and-version-robustness ac-3
        const kspecVersion = await getKspecPackageVersion();
        if (!kspecVersion) {
          console.log(chalk.yellow("Warning: Could not determine kspec version — updating based on content changes only"));
        }

        // Load core skills manifest to get current content
        const coreSkillsManifest = await loadCoreSkillsManifest();
        const coreSkillsMap = new Map(
          coreSkillsManifest.map((s) => [s.id, s])
        );

        // AC: @core-skill-update ac-3 - Only process skills with origin core
        const coreSkills = metaCtx.skills.filter((s) => s.origin === "core");

        for (const skill of coreSkills) {
          // AC: @core-skill-update ac-2 - Skip if already at current version
          // If kspecVersion is null or skill has no version, always update
          if (kspecVersion && skill.version === kspecVersion) {
            const targetDir = path.dirname(getSkillContentPath(ctx, skill.id));
            const sourceDir = path.join(getTemplatesDir(), skill.id);
            const isTemplateInSync = await sourceMatchesDest(sourceDir, targetDir);
            results.push({
              id: skill.id,
              action: "skipped",
              reason: isTemplateInSync
                ? "already at current version"
                : "already at current version; template content differs from local files",
              currentVersion: skill.version,
              guidance: isTemplateInSync
                ? undefined
                : "Run `kspec skill install-core` to sync core skill templates at the same version",
            });
            continue;
          }

          // Check if skill exists in core manifest
          const coreSkill = coreSkillsMap.get(skill.id);
          if (!coreSkill) {
            results.push({
              id: skill.id,
              action: "skipped",
              reason: "not found in core skills manifest",
              currentVersion: skill.version,
            });
            continue;
          }

          // AC: @core-skill-update ac-1 - Update content and version
          const oldVersion = skill.version;

          if (!dryRun) {
            // Clone before mutating to protect against partial save failure
            const updated = structuredClone(skill);
            if (kspecVersion) {
              updated.version = kspecVersion;
            }
            updated.name = coreSkill.name;
            if (coreSkill.description) {
              updated.description = coreSkill.description;
            }
            if (coreSkill.platforms) {
              updated.platforms = coreSkill.platforms;
            }

            // Save updated metadata
            await saveMetaItem(ctx, updated, "skill");

            // Update skill files from templates (SKILL.md + supporting dirs)
            const targetDir = path.dirname(getSkillContentPath(ctx, skill.id));
            await copyCoreSkillFiles(skill.id, targetDir);
          }

          results.push({
            id: skill.id,
            action: "updated",
            previousVersion: oldVersion,
            newVersion: kspecVersion ?? undefined,
          });
        }

        // Commit changes if not dry run and there are updates
        if (!dryRun && results.some((r) => r.action === "updated")) {
          await commitIfShadow(
            ctx.shadow,
            "skill-update",
            `${results.filter((r) => r.action === "updated").length} core skills`
          );
        }

        // Output results
        output(
          {
            dry_run: dryRun,
            kspec_version: kspecVersion,
            results,
          },
          () => {
            if (dryRun) {
              console.log(chalk.yellow("DRY RUN - No changes made"));
              console.log();
            }

            console.log(`kspec version: ${kspecVersion ?? "unavailable"}`);
            console.log();

            const updated = results.filter((r) => r.action === "updated");
            const skipped = results.filter((r) => r.action === "skipped");

            if (updated.length > 0) {
              console.log(chalk.green(`Updated: ${updated.length} skill(s)`));
              for (const r of updated) {
                console.log(
                  `  ${chalk.green("~")} ${r.id}: ${r.previousVersion || "unknown"} → ${r.newVersion || "unavailable"}`
                );
              }
            }

            if (skipped.length > 0) {
              console.log(chalk.gray(`Skipped: ${skipped.length} skill(s)`));
              for (const r of skipped) {
                console.log(
                  `  ${chalk.gray("-")} ${r.id}: ${r.reason}${r.currentVersion ? ` (v${r.currentVersion})` : ""}`
                );
                if (r.guidance) {
                  console.log(`    ${chalk.yellow("→")} ${r.guidance}`);
                }
              }
            }

            console.log();
            if (dryRun) {
              console.log(
                chalk.yellow("No changes were made. Run without --dry-run to apply.")
              );
            } else if (updated.length > 0) {
              success(`Updated ${updated.length} core skill(s)`);
            } else {
              console.log(chalk.gray("No skills needed updating"));
            }
          }
        );
      } catch (err) {
        error("Failed to update core skills", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
