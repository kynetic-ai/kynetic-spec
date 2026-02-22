/**
 * Skill render, status, diff, and verify commands.
 *
 * AC: @skill-rendering ac-1 through ac-5 - kspec skill render
 * AC: @skill-render-cli ac-1 through ac-4 - render/status/diff CLI
 * AC: @skill-drift-detection ac-3, ac-4 - drift handling with --force
 * AC: @multi-platform-render-cli ac-1 through ac-7 - multi-platform rendering
 * AC: @skill-drift-detection-improvements ac-2 - kspec skill verify
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "chalk";
import Table from "cli-table3";
import { createTwoFilesPatch } from "diff";
import type { Command } from "commander";
import {
  findMetaItemByRef,
  initContext,
  isSkill,
  loadMetaContext,
  loadSkillContent,
  type LoadedSkill,
  type KspecContext,
} from "../../parser/index.js";
import {
  isKspecManagedSkill as isKspecManaged,
  KSPEC_MANAGED_MARKER,
  generateFrontmatter,
  getRenderer,
  getAllRenderers,
  getClaudeCodeSkillSubdir,
  getSkillSubdir,
  contentsEqual,
  directoriesEqual,
  migrateOldPluginPaths,
  type PlatformRenderer,
  type DriftStatus,
} from "../../parser/skill-render.js";
import { errors } from "../../strings/errors.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output, success } from "../output.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of rendering a single skill to a platform
 * AC: @multi-platform-render-cli ac-6 - Includes platform field
 */
interface MultiPlatformRenderResult {
  id: string;
  platform: string;
  action: "created" | "updated" | "unchanged" | "skipped";
  path: string;
  /** Reason why skill was skipped */
  skipReason?: string;
}

/**
 * Result of a clean operation
 * AC: @multi-platform-render-cli ac-5 - Includes platform field
 */
interface CleanResult {
  id: string;
  path: string;
  action: "removed" | "skipped";
  reason?: string;
  /** Platform this clean result is for */
  platform?: string;
}

/**
 * Result of checking a skill's sync status for a specific platform
 * AC: @multi-platform-render-cli ac-3
 */
interface MultiPlatformStatusResult {
  id: string;
  platform: string;
  status: "in-sync" | "drifted" | "not-rendered";
  docsStatus?: "in-sync" | "drifted" | "not-rendered" | "no-docs";
  warning?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the sync status of a skill for a specific platform
 * AC: @multi-platform-render-cli ac-3 - Per-platform status checking
 */
async function getMultiPlatformSyncStatus(
  ctx: KspecContext,
  projectRoot: string,
  skill: LoadedSkill,
  renderer: PlatformRenderer
): Promise<MultiPlatformStatusResult> {
  // Use the renderer's drift check
  const driftStatus = await renderer.checkDrift(ctx.specDir, projectRoot, skill.id, { origin: skill.origin });

  // Core skills on claude-code are plugin-provided, not locally rendered
  if (driftStatus === "plugin-provided") {
    return {
      id: skill.id,
      platform: renderer.platform,
      status: "plugin-provided" as "in-sync" | "drifted" | "not-rendered",
      docsStatus: "no-docs",
    };
  }

  // Compute the effective output dir for this skill-platform pair
  const effectiveOutputDir = renderer.defaultOutputDir;

  // Map drift status to sync status
  let status: "in-sync" | "drifted" | "not-rendered";
  switch (driftStatus) {
    case "in-sync":
      status = "in-sync";
      break;
    case "drifted":
      status = "drifted";
      break;
    case "not-rendered":
      status = "not-rendered";
      break;
    case "no-hash":
      // No hash stored - need to check if content matches expected
      const renderedPath = path.join(
        projectRoot,
        effectiveOutputDir,
        getSkillSubdir(skill.id, skill.origin, renderer.platform),
        "SKILL.md"
      );
      try {
        await fs.readFile(renderedPath, "utf-8");
        // File exists but no hash - treat as needing sync
        status = "drifted";
      } catch {
        status = "not-rendered";
      }
      break;
  }

  // Check docs status for this platform
  const sourceDocsDir = path.join(ctx.specDir, "skills", skill.id, "docs");
  const targetDocsDir = path.join(
    projectRoot, effectiveOutputDir,
    getSkillSubdir(skill.id, skill.origin, renderer.platform), "docs"
  );
  let docsStatus: "in-sync" | "drifted" | "not-rendered" | "no-docs" = "no-docs";

  try {
    await fs.stat(sourceDocsDir);
    // Source docs exist, check target
    try {
      await fs.stat(targetDocsDir);
      // Both exist, compare
      const equal = await directoriesEqual(sourceDocsDir, targetDocsDir);
      docsStatus = equal ? "in-sync" : "drifted";
    } catch {
      docsStatus = "not-rendered";
    }
  } catch {
    // No source docs
    docsStatus = "no-docs";
  }

  return {
    id: skill.id,
    platform: renderer.platform,
    status,
    docsStatus,
  };
}

/**
 * Get the expected rendered content for a skill
 */
export async function getExpectedRenderedContent(
  ctx: KspecContext,
  skill: LoadedSkill
): Promise<string> {
  const sourceContent = await loadSkillContent(ctx, skill);

  if (!sourceContent) {
    // No source content, generate placeholder
    const frontmatter = generateFrontmatter(skill);
    return `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n\n# ${skill.name}\n\n${skill.description || ""}\n`;
  }

  // Generate rendered content with frontmatter and marker
  const frontmatter = generateFrontmatter(skill);

  // Check if source already has frontmatter - if so, strip it
  const frontmatterMatch = sourceContent.match(/^---\n[\s\S]*?\n---\n?/);
  const contentWithoutFrontmatter = frontmatterMatch
    ? sourceContent.slice(frontmatterMatch[0].length)
    : sourceContent;

  return `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n${contentWithoutFrontmatter}`;
}

/**
 * Generate unified diff between two strings.
 * Uses the 'diff' library for correct LCS-based diffing.
 * AC: @skill-render-cli ac-4
 * AC: @guard-script-and-diff-quality ac-2
 */
export function generateUnifiedDiff(
  actual: string,
  expected: string,
  actualPath: string,
  expectedPath: string
): string[] {
  if (contentsEqual(actual, expected)) {
    return [];
  }

  const patch = createTwoFilesPatch(actualPath, expectedPath, actual, expected, "", "", {
    context: 3,
  });

  // Split into lines and remove the first line (Index: ...) which createTwoFilesPatch adds
  const lines = patch.split("\n");
  // createTwoFilesPatch outputs: "Index: ...\n===...\n--- ...\n+++ ...\n@@ ... @@\n..."
  // Skip the "Index:" and "===" header lines to match our expected format
  const startIdx = lines.findIndex((l) => l.startsWith("---"));
  if (startIdx === -1) return [];

  // Remove trailing empty line that createTwoFilesPatch adds
  const result = lines.slice(startIdx);
  if (result.length > 0 && result[result.length - 1] === "") {
    result.pop();
  }

  return result;
}

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Register render/status/diff/verify skill commands
 */
export function registerSkillDiffCommands(skill: Command): void {
  // AC: @skill-rendering ac-1 through ac-5 - kspec skill render
  // AC: @skill-render-cli ac-1, ac-2 - kspec skill render / kspec skill render @skill-id
  // AC: @skill-drift-detection ac-3, ac-4 - drift handling with --force
  // AC: @multi-platform-render-cli ac-1 through ac-7 - multi-platform rendering
  // AC: @trait-dry-run - supports --dry-run
  // AC: @trait-error-guidance - provides error guidance
  skill
    .command("render [ref]")
    .description(
      "Render skills from shadow branch to platform-specific files on main branch"
    )
    .option("--clean", "Remove orphaned managed skill directories")
    .option("--dry-run", "Show what would be changed without applying")
    .option("--force", "Overwrite drifted skill files (manually edited)")
    .option("--output-dir <path>", "Custom output directory (overrides platform default)")
    .option("--skill <id>", "Render only a specific skill (deprecated, use positional arg)")
    .action(async (ref: string | undefined, options) => {
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
        // Use rootDir (project root), not specDir (which is .kspec/ in shadow mode)
        const projectRoot = ctx.rootDir;
        const dryRun = options.dryRun || false;
        const force = options.force || false;
        const customOutputDir = options.outputDir;
        const results: MultiPlatformRenderResult[] = [];
        const cleanResults: CleanResult[] = [];
        const warnings: string[] = [];

        // Get all skills (no platform filtering - we'll check per-platform)
        let skillsToRender = metaCtx.skills;

        // AC: @skill-render-cli ac-2 - Filter to specific skill if requested
        // Support both positional ref argument and --skill option
        const skillRef = ref || options.skill;
        if (skillRef) {
          // Resolve the ref to a skill (uses _type discriminant)
          const item = findMetaItemByRef(metaCtx, skillRef);
          if (!item || !isSkill(item)) {
            error(`Skill not found: ${skillRef}`);
            console.log(chalk.gray("Try: kspec skill list"));
            process.exit(EXIT_CODES.NOT_FOUND);
          }
          const skill = item as LoadedSkill;
          skillsToRender = skillsToRender.filter((s) => s.id === skill.id);
        }

        // Track which platforms we're using to create output directories and for clean
        const usedPlatforms = new Set<string>();

        // AC: @multi-platform-render-cli ac-1, ac-2 - Render each skill to each of its platforms
        for (const skill of skillsToRender) {
          for (const platform of skill.platforms) {
            // Get the renderer for this platform
            const renderer = getRenderer(platform);

            // AC: @multi-platform-render-cli ac-7 - Warn for unregistered platforms
            if (!renderer) {
              warnings.push(`${skill.id}: unregistered platform '${platform}' (skipped)`);
              results.push({
                id: skill.id,
                platform,
                action: "skipped",
                path: "",
                skipReason: `unregistered platform '${platform}'`,
              });
              continue;
            }

            usedPlatforms.add(platform);

            // Core skills on claude-code are plugin-provided, skip local render
            // But still run migration cleanup for old render paths
            if (skill.origin === "core" && platform === "claude-code" && !customOutputDir) {
              if (!dryRun) {
                await migrateOldPluginPaths(projectRoot, skill.id);
              }
              results.push({
                id: skill.id,
                platform,
                action: "skipped",
                path: "",
                skipReason: "core skill provided by npm package plugin",
              });
              continue;
            }

            // Determine output directory
            const effectiveDir = customOutputDir || renderer.defaultOutputDir;

            // Ensure output directory exists
            const targetSkillsDir = path.join(projectRoot, effectiveDir);
            if (!dryRun) {
              await fs.mkdir(targetSkillsDir, { recursive: true });
            }

            // Check for drift before rendering
            // AC: @skill-drift-detection ac-3, ac-4 - Check drift and skip without --force
            const driftStatus = await renderer.checkDrift(
              ctx.specDir,
              projectRoot,
              skill.id,
              { outputDir: customOutputDir, origin: skill.origin }
            );

            // AC: @skill-drift-detection ac-3 - Skip drifted skills without --force
            if (driftStatus === "drifted" && !force) {
              const renderedPath = path.join(
                projectRoot,
                effectiveDir,
                getSkillSubdir(skill.id, skill.origin, platform),
                "SKILL.md"
              );
              results.push({
                id: skill.id,
                platform,
                action: "skipped",
                path: renderedPath,
                skipReason: "drifted (use --force to overwrite)",
              });
              continue;
            }

            // AC: @skill-drift-detection ac-4 - Render (overwrite) when --force is used
            // AC: @multi-platform-render-cli ac-4 - Pass custom outputDir to renderer
            const result = await renderer.render(ctx, projectRoot, skill, {
              dryRun,
              storeHash: true,
              outputDir: customOutputDir,
            });

            results.push({
              id: result.id,
              platform: result.platform,
              action: result.action,
              path: result.paths[0] || "",
              skipReason: result.skipReason,
            });
          }
        }

        // Handle --clean: remove orphaned managed skills per platform
        // AC: @skill-rendering ac-4, ac-5
        // AC: @multi-platform-render-cli ac-5 - Per-platform cleanup
        if (options.clean) {
          // Build set of active skill subdirs per platform (accounts for namespacing)
          const activeSubdirsByPlatform = new Map<string, Set<string>>();
          for (const skill of metaCtx.skills) {
            for (const platform of skill.platforms) {
              if (!activeSubdirsByPlatform.has(platform)) {
                activeSubdirsByPlatform.set(platform, new Set());
              }
              activeSubdirsByPlatform.get(platform)!.add(
                getSkillSubdir(skill.id, skill.origin, platform)
              );
            }
          }

          // Helper to check and clean a skill directory
          async function cleanSkillDir(
            skillId: string,
            skillDir: string,
            activeSubdirs: Set<string>,
            subdir: string,
            platform: string,
            hasNestedSkills?: boolean
          ): Promise<void> {
            const skillMdPath = path.join(skillDir, "SKILL.md");

            // Skip if skill still exists in meta for this platform
            if (activeSubdirs.has(subdir)) return;

            // AC: @skill-rendering ac-4 - Only consider kspec-managed skills
            const isManaged = await isKspecManaged(skillMdPath);

            if (isManaged) {
              // AC: @skill-rendering ac-5 - Remove orphaned directory
              // AC: @skill-rendering ac-6 - Preserve active nested skills in namespace dirs
              if (!dryRun) {
                if (hasNestedSkills) {
                  // Directory contains nested skills — only remove the SKILL.md,
                  // not the entire directory tree
                  await fs.rm(skillMdPath, { force: true });
                } else {
                  await fs.rm(skillDir, { recursive: true, force: true });
                }
              }
              cleanResults.push({
                id: skillId,
                path: hasNestedSkills ? skillMdPath : skillDir,
                action: "removed",
                platform,
              });
            } else {
              cleanResults.push({
                id: skillId,
                path: skillDir,
                action: "skipped",
                reason: "Not managed by kspec",
                platform,
              });
            }
          }

          // Helper to scan and clean orphaned skills in a directory
          async function scanAndClean(
            targetSkillsDir: string,
            activeSubdirs: Set<string>,
            platform: string
          ): Promise<void> {
            try {
              const entries = await fs.readdir(targetSkillsDir, {
                withFileTypes: true,
              });

              for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const skillDir = path.join(targetSkillsDir, entry.name);

                // Check for SKILL.md in this directory
                const hasSkillMd = await fs.access(path.join(skillDir, "SKILL.md")).then(() => true, () => false);
                if (hasSkillMd) {
                  await cleanSkillDir(entry.name, skillDir, activeSubdirs, entry.name, platform);
                }
              }
            } catch {
              // Output directory doesn't exist, nothing to clean
            }
          }

          // Build separate active sets for default dir vs plugin dir
          // Core skills on claude-code are active in plugin dir, NOT in .claude/skills/
          const nonCoreActiveByPlatform = new Map<string, Set<string>>();
          const coreActiveByPlatform = new Map<string, Set<string>>();
          for (const skill of metaCtx.skills) {
            for (const platform of skill.platforms) {
              if (skill.origin === "core" && platform === "claude-code") {
                if (!coreActiveByPlatform.has(platform)) {
                  coreActiveByPlatform.set(platform, new Set());
                }
                coreActiveByPlatform.get(platform)!.add(skill.id);
              } else {
                if (!nonCoreActiveByPlatform.has(platform)) {
                  nonCoreActiveByPlatform.set(platform, new Set());
                }
                nonCoreActiveByPlatform.get(platform)!.add(
                  getSkillSubdir(skill.id, skill.origin, platform)
                );
              }
            }
          }

          // Clean each platform's output directory
          const renderers = getAllRenderers();
          for (const renderer of renderers) {
            // Clean platform default directory (project/local skills only)
            const nonCoreActive = nonCoreActiveByPlatform.get(renderer.platform) || new Set();
            const outputDir = customOutputDir || renderer.defaultOutputDir;
            await scanAndClean(
              path.join(projectRoot, outputDir),
              nonCoreActive,
              renderer.platform
            );

            // Core skills on claude-code are now plugin-provided; skip plugin dir scan.
            // Only clean old namespaced dirs.
            if (renderer.platform === "claude-code" && !customOutputDir) {
              // Clean old namespaced dirs (.claude/skills/kspec/<id>/) that may remain from PR #440
              const oldNamespaceDir = path.join(projectRoot, renderer.defaultOutputDir, "kspec");
              try {
                const entries = await fs.readdir(oldNamespaceDir, { withFileTypes: true });
                for (const entry of entries) {
                  if (!entry.isDirectory()) {
                    // Handle orphaned SKILL.md at namespace root
                    if (entry.name === "SKILL.md") {
                      const skillMdPath = path.join(oldNamespaceDir, "SKILL.md");
                      const isManaged = await isKspecManaged(skillMdPath);
                      if (isManaged && !dryRun) {
                        await fs.rm(skillMdPath, { force: true });
                      }
                      if (isManaged) {
                        cleanResults.push({
                          id: "kspec",
                          path: skillMdPath,
                          action: "removed",
                          platform: renderer.platform,
                        });
                      }
                    }
                    continue;
                  }
                  const nestedDir = path.join(oldNamespaceDir, entry.name);
                  const nestedHasSkillMd = await fs.access(path.join(nestedDir, "SKILL.md")).then(() => true, () => false);
                  if (nestedHasSkillMd) {
                    const isManaged = await isKspecManaged(path.join(nestedDir, "SKILL.md"));
                    if (isManaged) {
                      if (!dryRun) {
                        await fs.rm(nestedDir, { recursive: true, force: true });
                      }
                      cleanResults.push({
                        id: entry.name,
                        path: nestedDir,
                        action: "removed",
                        platform: renderer.platform,
                      });
                    }
                  }
                }
                // Clean up empty kspec dir
                if (!dryRun) {
                  try {
                    const remaining = await fs.readdir(oldNamespaceDir);
                    if (remaining.length === 0) {
                      await fs.rm(oldNamespaceDir, { recursive: true, force: true });
                    }
                  } catch {
                    // Already removed or doesn't exist
                  }
                }
              } catch {
                // Old namespace dir doesn't exist
              }
            }
          }
        }

        // Output results
        // AC: @trait-dry-run ac-6 - JSON output includes dry_run field
        output(
          {
            dry_run: dryRun,
            rendered: results,
            cleaned: cleanResults,
            warnings,
          },
          () => {
            // AC: @trait-dry-run ac-3 - Clear indication this is a preview
            if (dryRun) {
              console.log(chalk.yellow("DRY RUN - No changes made"));
              console.log();
            }

            // AC: @multi-platform-render-cli ac-7 - Show warnings for unregistered platforms
            if (warnings.length > 0) {
              console.log(chalk.yellow("Warnings:"));
              for (const warning of warnings) {
                console.log(`  ${chalk.yellow("!")} ${warning}`);
              }
              console.log();
            }

            // Render results
            const created = results.filter((r) => r.action === "created");
            const updated = results.filter((r) => r.action === "updated");
            const unchanged = results.filter((r) => r.action === "unchanged");
            // AC: @skill-drift-detection ac-3 - Track skipped drifted skills
            const skippedDrifted = results.filter(
              (r) => r.action === "skipped" && r.skipReason?.includes("drifted")
            );
            const skippedUnregistered = results.filter(
              (r) => r.action === "skipped" && r.skipReason?.includes("unregistered")
            );

            // AC: @multi-platform-render-cli ac-6 - Include Platform column in output
            if (created.length > 0) {
              console.log(chalk.green(`Created: ${created.length} skill(s)`));
              for (const r of created) {
                console.log(`  ${chalk.green("+")} ${r.id} ${chalk.gray(`[${r.platform}]`)}`);
              }
            }

            if (updated.length > 0) {
              console.log(chalk.blue(`Updated: ${updated.length} skill(s)`));
              for (const r of updated) {
                console.log(`  ${chalk.blue("~")} ${r.id} ${chalk.gray(`[${r.platform}]`)}`);
              }
            }

            if (unchanged.length > 0 && results.length <= 10) {
              console.log(chalk.gray(`Unchanged: ${unchanged.length} skill(s)`));
            }

            // AC: @skill-drift-detection ac-3 - Show warning for skipped drifted skills
            if (skippedDrifted.length > 0) {
              console.log();
              console.log(chalk.yellow(`Skipped: ${skippedDrifted.length} drifted skill(s)`));
              for (const r of skippedDrifted) {
                console.log(`  ${chalk.yellow("!")} ${r.id} ${chalk.gray(`[${r.platform}]`)}: ${r.skipReason || "drifted"}`);
              }
              console.log();
              console.log(chalk.yellow("Use --force to overwrite drifted skills"));
            }

            // Clean results
            if (cleanResults.length > 0) {
              const removed = cleanResults.filter((r) => r.action === "removed");
              const skipped = cleanResults.filter((r) => r.action === "skipped");

              if (removed.length > 0) {
                console.log();
                console.log(chalk.red(`Removed: ${removed.length} orphaned skill(s)`));
                for (const r of removed) {
                  // AC: @multi-platform-render-cli ac-6 - Platform column in clean output
                  console.log(`  ${chalk.red("-")} ${r.id} ${chalk.gray(`[${r.platform}]`)}`);
                }
              }

              if (skipped.length > 0) {
                console.log(
                  chalk.gray(`Skipped: ${skipped.length} unmanaged skill(s)`)
                );
              }
            }

            // Summary
            console.log();
            if (dryRun) {
              console.log(
                chalk.yellow("No changes were made. Run without --dry-run to apply.")
              );
            } else {
              const changedCount = created.length + updated.length;
              const cleanedCount = cleanResults.filter(
                (r) => r.action === "removed"
              ).length;
              if (changedCount > 0 || cleanedCount > 0) {
                success(
                  `Rendered ${changedCount} skill(s)${cleanedCount > 0 ? `, cleaned ${cleanedCount}` : ""}`
                );
              } else {
                console.log(chalk.gray("No changes needed"));
              }
            }
          }
        );
      } catch (err) {
        error("Failed to render skills", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-render-cli ac-3 - kspec skill status
  // AC: @multi-platform-render-cli ac-3 - Per-platform status rows
  skill
    .command("status")
    .description("Show sync status of rendered skills")
    .action(async () => {
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
        const projectRoot = ctx.rootDir;

        // Check all skills (not just claude-code)
        const skillsToCheck = metaCtx.skills;

        if (skillsToCheck.length === 0) {
          console.log(chalk.yellow("No skills found"));
          return;
        }

        // AC: @multi-platform-render-cli ac-3 - Build status per skill-platform pair
        const statusResults: MultiPlatformStatusResult[] = [];

        for (const skill of skillsToCheck) {
          for (const platform of skill.platforms) {
            const renderer = getRenderer(platform);
            if (!renderer) {
              // Unregistered platform - show as not-rendered
              statusResults.push({
                id: skill.id,
                platform,
                status: "not-rendered",
                docsStatus: "no-docs",
                warning: `unregistered platform '${platform}'`,
              });
              continue;
            }

            const status = await getMultiPlatformSyncStatus(ctx, projectRoot, skill, renderer);
            statusResults.push(status);
          }
        }

        // Output results
        output(
          statusResults,
          () => {
            // AC: @multi-platform-render-cli ac-3 - Table shows Platform column
            const table = new Table({
              head: [
                chalk.bold("ID"),
                chalk.bold("Platform"),
                chalk.bold("Status"),
                chalk.bold("Docs"),
              ],
              style: {
                head: [],
                border: [],
              },
            });

            for (const result of statusResults) {
              const statusColor =
                result.status === "in-sync"
                  ? chalk.green
                  : result.status === "drifted"
                    ? chalk.yellow
                    : chalk.gray;

              const docsStatusColor =
                result.docsStatus === "in-sync"
                  ? chalk.green
                  : result.docsStatus === "drifted"
                    ? chalk.yellow
                    : chalk.gray;

              table.push([
                result.id,
                result.platform,
                statusColor(result.status + (result.warning ? " (!)" : "")),
                docsStatusColor(result.docsStatus || "-"),
              ]);
            }

            console.log(table.toString());

            // Summary
            const inSync = statusResults.filter((r) => r.status === "in-sync").length;
            const drifted = statusResults.filter((r) => r.status === "drifted").length;
            const notRendered = statusResults.filter((r) => r.status === "not-rendered").length;
            const warningCount = statusResults.filter((r) => r.warning).length;

            console.log();
            if (drifted > 0) {
              console.log(chalk.yellow(`${drifted} skill(s) drifted - run 'kspec skill render' to sync`));
            }
            if (notRendered > 0) {
              console.log(chalk.gray(`${notRendered} skill(s) not rendered`));
            }
            if (warningCount > 0) {
              console.log(chalk.yellow(`${warningCount} skill(s) with warnings`));
            }
            if (inSync === statusResults.length) {
              console.log(chalk.green("All skills in sync"));
            }
          }
        );
      } catch (err) {
        error("Failed to check skill status", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-render-cli ac-4 - kspec skill diff
  skill
    .command("diff <ref>")
    .description("Show diff between source and rendered skill")
    .action(async (ref: string) => {
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
        const item = findMetaItemByRef(metaCtx, ref);

        if (!item) {
          error(`Skill not found: ${ref}`);
          console.log(chalk.gray("Try: kspec skill list"));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        // Check it's a skill (uses _type discriminant)
        if (!isSkill(item)) {
          error(`Item ${ref} is not a skill`);
          process.exit(EXIT_CODES.ERROR);
        }

        const skill = item as LoadedSkill;
        const projectRoot = ctx.rootDir;

        // Core skills on claude-code are plugin-provided
        if (skill.origin === "core") {
          output(
            {
              id: skill.id,
              hasDiff: false,
              diff: [],
              pluginProvided: true,
            },
            () => {
              console.log(chalk.blue(`${skill.id}: plugin-provided (no local render to diff)`));
            }
          );
          return;
        }

        // Get expected rendered content
        const expectedContent = await getExpectedRenderedContent(ctx, skill);

        // Get actual rendered content
        const renderedPath = path.join(
          projectRoot,
          ".claude/skills",
          skill.id,
          "SKILL.md"
        );

        let actualContent = "";
        try {
          actualContent = await fs.readFile(renderedPath, "utf-8");
        } catch {
          // File doesn't exist
        }

        // Generate diff
        const diff = generateUnifiedDiff(
          actualContent,
          expectedContent,
          `a/${skill.id}/SKILL.md`,
          `b/${skill.id}/SKILL.md`
        );

        // Output
        output(
          {
            id: skill.id,
            hasDiff: diff.length > 0,
            diff,
          },
          () => {
            if (diff.length === 0) {
              console.log(chalk.green(`${skill.id}: in sync`));
            } else {
              console.log(chalk.yellow(`${skill.id}: drifted`));
              console.log();
              // Print colored diff
              for (const line of diff) {
                if (line.startsWith("+") && !line.startsWith("+++")) {
                  console.log(chalk.green(line));
                } else if (line.startsWith("-") && !line.startsWith("---")) {
                  console.log(chalk.red(line));
                } else if (line.startsWith("@@")) {
                  console.log(chalk.cyan(line));
                } else {
                  console.log(line);
                }
              }
            }
          }
        );
      } catch (err) {
        error("Failed to generate diff", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-drift-detection-improvements ac-2 - kspec skill verify
  skill
    .command("verify")
    .description("Verify rendered skills match their source (reports drift with guidance)")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
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
        const projectRoot = ctx.rootDir;
        const skillsToCheck = metaCtx.skills;

        if (skillsToCheck.length === 0) {
          output([], () => {
            console.log(chalk.yellow("No skills found"));
          });
          return;
        }

        // Build verification results for each skill-platform pair
        interface VerifyResult {
          id: string;
          platform: string;
          status: "ok" | "drifted" | "not-rendered" | "no-hash";
          guidance?: string;
        }

        const results: VerifyResult[] = [];

        for (const skill of skillsToCheck) {
          for (const platform of skill.platforms) {
            const renderer = getRenderer(platform);
            if (!renderer) {
              results.push({
                id: skill.id,
                platform,
                status: "not-rendered",
                guidance: `Unregistered platform '${platform}'. No renderer available.`,
              });
              continue;
            }

            const driftStatus = await renderer.checkDrift(
              ctx.specDir,
              projectRoot,
              skill.id,
              { origin: skill.origin }
            );

            switch (driftStatus) {
              case "in-sync":
                results.push({ id: skill.id, platform, status: "ok" });
                break;
              case "drifted":
                results.push({
                  id: skill.id,
                  platform,
                  status: "drifted",
                  guidance: `Rendered file has been modified. Run 'kspec skill render ${skill.id} --force' to overwrite with source, or 'kspec skill diff ${skill.id}' to review changes.`,
                });
                break;
              case "not-rendered":
                results.push({
                  id: skill.id,
                  platform,
                  status: "not-rendered",
                  guidance: `Not yet rendered. Run 'kspec skill render ${skill.id}' to generate.`,
                });
                break;
              case "no-hash":
                results.push({
                  id: skill.id,
                  platform,
                  status: "no-hash",
                  guidance: `No render hash stored. Run 'kspec skill render ${skill.id}' to render and store hash.`,
                });
                break;
            }
          }
        }

        const driftedResults = results.filter((r) => r.status === "drifted");
        const okResults = results.filter((r) => r.status === "ok");
        const notRenderedResults = results.filter((r) => r.status === "not-rendered");
        const noHashResults = results.filter((r) => r.status === "no-hash");

        output(
          results,
          () => {
            if (driftedResults.length === 0 && notRenderedResults.length === 0 && noHashResults.length === 0) {
              console.log(chalk.green(`All ${okResults.length} rendered skill(s) verified — no drift detected.`));
              return;
            }

            // Show drifted skills with guidance
            if (driftedResults.length > 0) {
              console.log(chalk.yellow.bold(`\nDrifted (${driftedResults.length}):`));
              for (const r of driftedResults) {
                console.log(`  ${chalk.yellow("●")} ${r.id} [${r.platform}]`);
                console.log(`    ${chalk.gray(r.guidance!)}`);
              }
            }

            // Show not-rendered
            if (notRenderedResults.length > 0) {
              console.log(chalk.gray.bold(`\nNot rendered (${notRenderedResults.length}):`));
              for (const r of notRenderedResults) {
                console.log(`  ${chalk.gray("○")} ${r.id} [${r.platform}]`);
                console.log(`    ${chalk.gray(r.guidance!)}`);
              }
            }

            // Show no-hash
            if (noHashResults.length > 0) {
              console.log(chalk.gray.bold(`\nNo hash (${noHashResults.length}):`));
              for (const r of noHashResults) {
                console.log(`  ${chalk.gray("○")} ${r.id} [${r.platform}]`);
                console.log(`    ${chalk.gray(r.guidance!)}`);
              }
            }

            // Summary line
            if (okResults.length > 0) {
              console.log(chalk.green(`\n${okResults.length} skill(s) verified OK.`));
            }

            // Actionable summary
            if (driftedResults.length > 0) {
              console.log(
                chalk.yellow(`\nTo sync all drifted skills: kspec skill render --force`)
              );
            }
          }
        );

        // Exit with non-zero if any skills drifted
        if (driftedResults.length > 0) {
          process.exit(EXIT_CODES.ERROR);
        }
      } catch (err) {
        error("Failed to verify skills", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
