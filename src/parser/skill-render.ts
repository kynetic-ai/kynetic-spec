/**
 * Platform Skill Renderers
 *
 * Defines the contract for platform-specific skill renderers and provides
 * the Claude Code implementation. Each renderer writes platform-specific output
 * (SKILL.md with frontmatter, sidecar config files, supporting directories)
 * to a configurable output directory.
 *
 * AC: @claude-code-renderer ac-1 - renderClaudeCodeSkill creates .claude/skills/<id>/SKILL.md with YAML frontmatter
 * AC: @claude-code-renderer ac-2 - rendered output has YAML frontmatter delimiters with name and description fields
 * AC: @claude-code-renderer ac-3 - skill body content appears verbatim below frontmatter
 * AC: @claude-code-renderer ac-4 - rendered files appear as unstaged changes on main branch
 *
 * AC: @skill-drift-detection ac-1 - Skill shows as in-sync when not manually edited
 * AC: @skill-drift-detection ac-2 - Skill shows as drifted when manually edited
 * AC: @skill-drift-detection ac-5 - Render hash stored in .kspec/skills/<id>/.render-hash
 *
 * AC: @consolidate-skill-render ac-3 - hash/drift functions exported from this module
 *
 * AC: @platform-renderer-trait ac-1 - platform-specific output files written to configured output directory
 * AC: @platform-renderer-trait ac-2 - PlatformRenderResult returned with id, platform, action, paths
 * AC: @platform-renderer-trait ac-3 - supporting directories (references/, scripts/, assets/) copied
 * AC: @platform-renderer-trait ac-4 - dryRun mode: no files written, result reflects what would happen
 * AC: @platform-renderer-trait ac-5 - custom outputDir goes to custom path instead of platform default
 * AC: @platform-renderer-trait ac-6 - per-platform render hash written to .render-hash-<platform>
 *
 * AC: @codex-renderer ac-1 - .agents/skills/<id>/SKILL.md with only name and description in frontmatter
 * AC: @codex-renderer ac-2 - .agents/skills/<id>/agents/openai.yaml sidecar with platform_config.codex fields
 * AC: @codex-renderer ac-3 - no sidecar created when no platform_config.codex
 * AC: @codex-renderer ac-4 - rendered file contains <!-- kspec-managed --> marker
 * AC: @codex-renderer ac-5 - supporting directories (references/, scripts/, assets/) copied
 * AC: @codex-renderer ac-6 - hash written to .render-hash-codex
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import yaml from "yaml";
import type { KspecContext } from "./yaml.js";
import { loadSkillContent, type LoadedSkill } from "./meta.js";

// ============================================================================
// Platform Renderer Contract (AC: @platform-renderer-trait)
// ============================================================================

/**
 * Status of drift detection for a rendered skill
 * AC: @platform-renderer-trait ac-2
 */
export type DriftStatus = "not-rendered" | "in-sync" | "drifted" | "no-hash";

/**
 * Result of rendering a skill to a specific platform
 * AC: @platform-renderer-trait ac-2
 */
export interface PlatformRenderResult {
  /** Skill ID */
  id: string;
  /** Platform this result is for */
  platform: string;
  /** Action taken: created, updated, unchanged, or skipped */
  action: "created" | "updated" | "unchanged" | "skipped";
  /** Paths to all output files */
  paths: string[];
  /** Actions taken on supporting directories (references/, scripts/, assets/, docs/) */
  supportingDirsAction?: Record<string, "created" | "updated" | "unchanged" | "skipped">;
  /** Reason if action is skipped */
  skipReason?: string;
}

/**
 * Options for rendering a skill to a platform
 * AC: @platform-renderer-trait ac-4, ac-5
 */
export interface PlatformRenderOptions {
  /** If true, don't write files, just return what would be done */
  dryRun?: boolean;
  /** If true, store a hash of the rendered content for drift detection */
  storeHash?: boolean;
  /** Custom output directory (overrides platform default) */
  outputDir?: string;
}

/**
 * Contract for platform-specific skill renderers
 * AC: @platform-renderer-trait ac-1, ac-2
 */
export interface PlatformRenderer {
  /** Platform identifier (e.g., "claude-code", "codex") */
  platform: string;
  /** Default output directory relative to project root (e.g., ".claude/skills") */
  defaultOutputDir: string;
  /**
   * Render a skill to platform-specific output
   * AC: @platform-renderer-trait ac-1, ac-2, ac-3, ac-4, ac-5
   */
  render(
    ctx: KspecContext,
    projectRoot: string,
    skill: LoadedSkill,
    options?: PlatformRenderOptions
  ): Promise<PlatformRenderResult>;
  /**
   * Check if a rendered skill has drifted from its source
   * AC: @platform-renderer-trait ac-6
   */
  checkDrift(
    specDir: string,
    projectRoot: string,
    skillId: string,
    options?: { outputDir?: string; origin?: string }
  ): Promise<DriftStatus>;
}

// ============================================================================
// Backward Compatibility Types
// ============================================================================

/**
 * Result of rendering a skill to Claude Code format
 * @deprecated Use PlatformRenderResult instead
 */
export interface ClaudeCodeRenderResult {
  /** Skill ID */
  id: string;
  /** Action taken: created, updated, or unchanged */
  action: "created" | "updated" | "unchanged";
  /** Path to the rendered SKILL.md file */
  path: string;
  /** Action taken on docs directory */
  docsAction?: "created" | "updated" | "unchanged" | "skipped";
}

/**
 * Options for rendering a skill
 * @deprecated Use PlatformRenderOptions instead
 */
export interface RenderSkillOptions {
  /** If true, don't write files, just return what would be done */
  dryRun?: boolean;
  /** If true, store a hash of the rendered content for drift detection */
  storeHash?: boolean;
  /** Custom output directory (overrides platform default) */
  outputDir?: string;
}

/**
 * Marker comment that identifies skill directories managed by kspec
 */
export const KSPEC_MANAGED_MARKER = "<!-- kspec-managed -->";

/**
 * Generate YAML frontmatter for a skill.
 * AC: @claude-code-renderer ac-2 - YAML frontmatter with name and description fields
 * AC: @claude-code-renderer-extended ac-1 - portable fields (license, allowed-tools)
 * AC: @claude-code-renderer-extended ac-2 - user-invocable from platform_config
 * AC: @claude-code-renderer-extended ac-3 - context and agent from platform_config
 * AC: @claude-code-renderer-extended ac-4 - disable-model-invocation from platform_config
 * AC: @claude-code-renderer-extended ac-5 - only portable fields when no platform_config
 * AC: @claude-code-renderer-extended ac-8 - snake_case to kebab-case conversion
 */
export function generateFrontmatter(skill: LoadedSkill): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.id,
    description: skill.description || skill.name,
  };

  // AC: @claude-code-renderer-extended ac-1 - Add portable fields
  if (skill.license) {
    frontmatter.license = skill.license;
  }
  if (skill.allowed_tools && skill.allowed_tools.length > 0) {
    frontmatter["allowed-tools"] = skill.allowed_tools;
  }
  if (skill.compatibility) {
    frontmatter.compatibility = skill.compatibility;
  }

  // AC: @claude-code-renderer-extended ac-2, ac-3, ac-4 - Add Claude Code platform fields
  const claudeCodeConfig = skill.platform_config?.claude_code;
  if (claudeCodeConfig) {
    // AC: @claude-code-renderer-extended ac-2 - user_invocable
    if (claudeCodeConfig.user_invocable !== undefined) {
      frontmatter["user-invocable"] = claudeCodeConfig.user_invocable;
    }
    // AC: @claude-code-renderer-extended ac-4 - disable_model_invocation
    if (claudeCodeConfig.disable_model_invocation !== undefined) {
      frontmatter["disable-model-invocation"] = claudeCodeConfig.disable_model_invocation;
    }
    // AC: @claude-code-renderer-extended ac-3 - context and agent
    if (claudeCodeConfig.context) {
      frontmatter.context = claudeCodeConfig.context;
    }
    if (claudeCodeConfig.agent) {
      frontmatter.agent = claudeCodeConfig.agent;
    }
    // Other Claude Code fields
    if (claudeCodeConfig.model) {
      frontmatter.model = claudeCodeConfig.model;
    }
    if (claudeCodeConfig.argument_hint) {
      frontmatter["argument-hint"] = claudeCodeConfig.argument_hint;
    }
  }

  return `---\n${yaml.stringify(frontmatter).trim()}\n---`;
}

/**
 * Get the rendered skill subdirectory segment for a given platform.
 * Core skills on claude-code are namespaced under kspec/ so Claude Code
 * discovers them as /kspec:<id> commands. All other combinations use the
 * skill id directly.
 */
export function getSkillSubdir(skillId: string, origin?: string, platform?: string): string {
  if (origin === "core" && (!platform || platform === "claude-code")) {
    return path.join("kspec", skillId);
  }
  return skillId;
}

/**
 * Convenience wrapper for LoadedSkill objects (Claude Code platform).
 */
export function getClaudeCodeSkillSubdir(skill: LoadedSkill): string {
  return getSkillSubdir(skill.id, skill.origin, "claude-code");
}

/**
 * Get the target directory for rendered skills on main branch.
 * Returns .claude/skills/<subdir>/ path where subdir accounts for namespacing.
 */
function getRenderedSkillPath(projectRoot: string, skillId: string, origin?: string): string {
  return path.join(projectRoot, ".claude", "skills", getSkillSubdir(skillId, origin, "claude-code"));
}

/**
 * Check if two contents are equal (for idempotency check)
 */
export function contentsEqual(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Recursively copy a directory
 */
export async function copyDirectory(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Compute SHA256 hash of content
 * AC: @skill-drift-detection ac-5 - Hash computation for render tracking
 */
export function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Get the path to the render hash file for a skill
 * AC: @skill-drift-detection ac-5 - Hash stored in .kspec/skills/<id>/.render-hash
 * AC: @consolidate-skill-render ac-3 - exported from skill-render.ts
 */
export function getRenderHashPath(specDir: string, skillId: string): string {
  return path.join(specDir, "skills", skillId, ".render-hash");
}

/**
 * Read the stored render hash for a skill
 * AC: @skill-drift-detection ac-5 - Read hash from .kspec/skills/<id>/.render-hash
 * AC: @consolidate-skill-render ac-3 - exported from skill-render.ts
 */
export async function readRenderHash(specDir: string, skillId: string): Promise<string | null> {
  try {
    const hashPath = getRenderHashPath(specDir, skillId);
    const content = await fs.readFile(hashPath, "utf-8");
    return content.trim();
  } catch {
    return null;
  }
}

/**
 * Write the render hash for a skill
 * AC: @skill-drift-detection ac-5 - Store hash in .kspec/skills/<id>/.render-hash
 * AC: @consolidate-skill-render ac-3 - exported from skill-render.ts
 */
export async function writeRenderHash(specDir: string, skillId: string, hash: string): Promise<void> {
  const hashPath = getRenderHashPath(specDir, skillId);
  await fs.mkdir(path.dirname(hashPath), { recursive: true });
  await fs.writeFile(hashPath, hash + "\n", "utf-8");
}

/**
 * Check if a rendered skill has drifted from its last render
 * AC: @skill-drift-detection ac-1, ac-2 - Drift detection via hash comparison
 * AC: @consolidate-skill-render ac-3 - exported from skill-render.ts
 *
 * Returns:
 * - "not-rendered": Rendered file doesn't exist
 * - "in-sync": Rendered file matches stored hash
 * - "drifted": Rendered file differs from stored hash (manually edited)
 * - "no-hash": Rendered file exists but no stored hash (first render or hash deleted)
 */
export async function checkSkillDrift(
  specDir: string,
  projectRoot: string,
  skillId: string,
  origin?: string
): Promise<"not-rendered" | "in-sync" | "drifted" | "no-hash"> {
  const renderedPath = path.join(
    projectRoot, ".claude", "skills",
    getSkillSubdir(skillId, origin, "claude-code"), "SKILL.md"
  );

  // Check if rendered file exists
  let renderedContent: string;
  try {
    renderedContent = await fs.readFile(renderedPath, "utf-8");
  } catch {
    return "not-rendered";
  }

  // Get stored hash
  const storedHash = await readRenderHash(specDir, skillId);
  if (!storedHash) {
    return "no-hash";
  }

  // Compare hashes
  const currentHash = computeContentHash(renderedContent);
  return currentHash === storedHash ? "in-sync" : "drifted";
}

/**
 * Recursively check if two directories have the same contents
 */
export async function directoriesEqual(src: string, dest: string): Promise<boolean> {
  try {
    const srcEntries = await fs.readdir(src, { withFileTypes: true });
    const destEntries = await fs.readdir(dest, { withFileTypes: true });

    // Different number of entries = not equal
    if (srcEntries.length !== destEntries.length) {
      return false;
    }

    // Create a map of dest entries for quick lookup
    const destMap = new Map(destEntries.map((e) => [e.name, e]));

    for (const srcEntry of srcEntries) {
      const destEntry = destMap.get(srcEntry.name);
      if (!destEntry) {
        return false;
      }

      const srcPath = path.join(src, srcEntry.name);
      const destPath = path.join(dest, srcEntry.name);

      if (srcEntry.isDirectory() && destEntry.isDirectory()) {
        if (!(await directoriesEqual(srcPath, destPath))) {
          return false;
        }
      } else if (srcEntry.isFile() && destEntry.isFile()) {
        const srcContent = await fs.readFile(srcPath, "utf-8");
        const destContent = await fs.readFile(destPath, "utf-8");
        if (!contentsEqual(srcContent, destContent)) {
          return false;
        }
      } else {
        // Type mismatch
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Supporting Directories (AC: @platform-renderer-trait ac-3, @claude-code-renderer-extended ac-7)
// ============================================================================

/** Known supporting directory names */
const SUPPORTING_DIRS = ["references", "scripts", "assets", "docs"] as const;

/**
 * Copy supporting directories from source skill to rendered output
 * AC: @platform-renderer-trait ac-3 - Supporting directories copied to platform output
 * AC: @claude-code-renderer-extended ac-7 - references/, scripts/, assets/ copied
 */
async function copySupportingDirectories(
  sourceSkillDir: string,
  targetSkillDir: string,
  dryRun: boolean
): Promise<Record<string, "created" | "updated" | "unchanged" | "skipped">> {
  const results: Record<string, "created" | "updated" | "unchanged" | "skipped"> = {};

  for (const dirName of SUPPORTING_DIRS) {
    const sourceDir = path.join(sourceSkillDir, dirName);
    const targetDir = path.join(targetSkillDir, dirName);

    try {
      const stats = await fs.stat(sourceDir);
      if (!stats.isDirectory()) {
        results[dirName] = "skipped";
        continue;
      }

      // Check if target exists
      let targetExists = false;
      try {
        await fs.stat(targetDir);
        targetExists = true;
      } catch {
        // Target doesn't exist
      }

      if (!targetExists) {
        results[dirName] = "created";
      } else {
        // Compare directories
        const equal = await directoriesEqual(sourceDir, targetDir);
        results[dirName] = equal ? "unchanged" : "updated";
      }

      // Apply changes
      if (!dryRun && results[dirName] !== "unchanged") {
        if (targetExists) {
          await fs.rm(targetDir, { recursive: true, force: true });
        }
        await fs.mkdir(targetDir, { recursive: true });
        await copyDirectory(sourceDir, targetDir);
      }
    } catch {
      // Source directory doesn't exist
      results[dirName] = "skipped";
    }
  }

  return results;
}

/**
 * Render a skill to Claude Code format.
 *
 * Reads skill content from .kspec/skills/<id>/SKILL.md and writes to
 * .claude/skills/<id>/SKILL.md with YAML frontmatter containing name and description.
 *
 * AC: @claude-code-renderer ac-1 - Creates .claude/skills/<id>/SKILL.md with YAML frontmatter
 * AC: @claude-code-renderer ac-2 - YAML frontmatter has name and description fields
 * AC: @claude-code-renderer ac-3 - Skill body content appears verbatim below frontmatter
 * AC: @claude-code-renderer ac-4 - Files are written to disk as unstaged changes (no git commit)
 *
 * @param ctx - Kspec context with specDir pointing to .kspec/
 * @param projectRoot - Root directory of the project (where .claude/ will be created)
 * @param skill - The skill to render
 * @param options - Render options (dryRun, etc.)
 * @returns Result indicating what action was taken
 */
export async function renderClaudeCodeSkill(
  ctx: KspecContext,
  projectRoot: string,
  skill: LoadedSkill,
  options: RenderSkillOptions = {},
): Promise<ClaudeCodeRenderResult> {
  const dryRun = options.dryRun ?? false;
  const storeHash = options.storeHash ?? false;
  const targetDir = getRenderedSkillPath(projectRoot, skill.id, skill.origin);
  const targetSkillMd = path.join(targetDir, "SKILL.md");

  // AC: @claude-code-renderer ac-3 - Load source content verbatim
  const sourceContent = await loadSkillContent(ctx, skill);

  if (!sourceContent) {
    // No source content, but skill exists in meta - create placeholder
    const frontmatter = generateFrontmatter(skill);
    const renderedContent = `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n\n# ${skill.name}\n\n${skill.description || ""}\n`;

    // AC: @claude-code-renderer ac-4 - Write to disk (unstaged)
    if (!dryRun) {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(targetSkillMd, renderedContent, "utf-8");
      // AC: @skill-drift-detection ac-5 - Store hash of rendered output
      if (storeHash) {
        const hash = computeContentHash(renderedContent);
        await writeRenderHash(ctx.specDir, skill.id, hash);
      }
    }

    return {
      id: skill.id,
      action: "created",
      path: targetSkillMd,
    };
  }

  // AC: @claude-code-renderer ac-2 - Generate frontmatter with name and description
  const frontmatter = generateFrontmatter(skill);

  // Check if source already has frontmatter - if so, strip it
  const frontmatterMatch = sourceContent.match(/^---\n[\s\S]*?\n---\n?/);
  const contentWithoutFrontmatter = frontmatterMatch
    ? sourceContent.slice(frontmatterMatch[0].length)
    : sourceContent;

  // AC: @claude-code-renderer ac-1, ac-3 - Build rendered content with frontmatter + verbatim body
  const renderedContent = `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n${contentWithoutFrontmatter}`;

  // Check if target exists and compare for idempotency
  let targetExists = false;
  let targetContent = "";
  try {
    targetContent = await fs.readFile(targetSkillMd, "utf-8");
    targetExists = true;
  } catch {
    // Target doesn't exist
  }

  // Determine action based on comparison
  let action: "created" | "updated" | "unchanged";

  if (!targetExists) {
    action = "created";
  } else if (contentsEqual(renderedContent, targetContent)) {
    action = "unchanged";
  } else {
    action = "updated";
  }

  // AC: @claude-code-renderer ac-4 - Apply changes to disk (no git commit)
  if (!dryRun && action !== "unchanged") {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetSkillMd, renderedContent, "utf-8");
    // AC: @skill-drift-detection ac-5 - Store hash of rendered output
    if (storeHash) {
      const hash = computeContentHash(renderedContent);
      await writeRenderHash(ctx.specDir, skill.id, hash);
    }
  }

  // AC: @claude-code-renderer-extended ac-7 - Copy supporting directories (references/, scripts/, assets/, docs/)
  const sourceSkillDir = path.join(ctx.specDir, "skills", skill.id);
  const supportingDirsAction = await copySupportingDirectories(
    sourceSkillDir,
    targetDir,
    dryRun
  );

  // For backward compatibility, also expose docsAction
  const docsAction = supportingDirsAction.docs || "skipped";

  return {
    id: skill.id,
    action,
    path: targetSkillMd,
    docsAction,
  };
}

/**
 * Check if a skill directory is managed by kspec.
 * Looks for the KSPEC_MANAGED_MARKER in the SKILL.md file.
 */
export async function isKspecManagedSkill(skillMdPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(skillMdPath, "utf-8");
    return content.includes(KSPEC_MANAGED_MARKER);
  } catch {
    return false;
  }
}

// ============================================================================
// Per-Platform Hash Functions (AC: @platform-renderer-trait ac-6)
// ============================================================================

/**
 * Get the path to the per-platform render hash file for a skill
 * AC: @platform-renderer-trait ac-6 - Per-platform hash stored in .render-hash-<platform>
 */
export function getPlatformRenderHashPath(specDir: string, skillId: string, platform: string): string {
  return path.join(specDir, "skills", skillId, `.render-hash-${platform}`);
}

/**
 * Read the stored render hash for a skill on a specific platform
 * AC: @platform-renderer-trait ac-6 - Read per-platform hash
 * AC: @claude-code-renderer-extended ac-6 - fallback to legacy hash
 */
export async function readPlatformRenderHash(
  specDir: string,
  skillId: string,
  platform: string
): Promise<string | null> {
  try {
    const hashPath = getPlatformRenderHashPath(specDir, skillId, platform);
    const content = await fs.readFile(hashPath, "utf-8");
    return content.trim();
  } catch {
    // Fall back to legacy hash (non-platform-specific)
    return readRenderHash(specDir, skillId);
  }
}

/**
 * Migrate legacy .render-hash to platform-specific .render-hash-<platform>
 * AC: @claude-code-renderer-extended ac-6 - hash migration
 */
export async function migrateLegacyRenderHash(
  specDir: string,
  skillId: string,
  platform: string
): Promise<boolean> {
  const legacyHashPath = getRenderHashPath(specDir, skillId);
  const platformHashPath = getPlatformRenderHashPath(specDir, skillId, platform);

  try {
    // Check if platform-specific hash already exists
    await fs.access(platformHashPath);
    return false; // Already migrated
  } catch {
    // Platform-specific doesn't exist, check for legacy
  }

  try {
    const legacyHash = await fs.readFile(legacyHashPath, "utf-8");
    // Write to platform-specific location
    await writePlatformRenderHash(specDir, skillId, platform, legacyHash.trim());
    return true; // Migrated successfully
  } catch {
    return false; // No legacy hash to migrate
  }
}

/**
 * Write the render hash for a skill on a specific platform
 * AC: @platform-renderer-trait ac-6 - Store per-platform hash in .render-hash-<platform>
 */
export async function writePlatformRenderHash(
  specDir: string,
  skillId: string,
  platform: string,
  hash: string
): Promise<void> {
  const hashPath = getPlatformRenderHashPath(specDir, skillId, platform);
  await fs.mkdir(path.dirname(hashPath), { recursive: true });
  await fs.writeFile(hashPath, hash + "\n", "utf-8");
}

/**
 * Check if a rendered skill has drifted from its last render for a specific platform
 * AC: @platform-renderer-trait ac-6 - Platform-specific drift detection
 */
export async function checkPlatformSkillDrift(
  specDir: string,
  projectRoot: string,
  skillId: string,
  platform: string,
  outputDir?: string,
  origin?: string
): Promise<DriftStatus> {
  // Determine the output directory - use custom or platform default
  const platformOutputDir = outputDir || getPlatformDefaultOutputDir(platform);
  const subdir = getSkillSubdir(skillId, origin, platform);
  const renderedPath = path.join(projectRoot, platformOutputDir, subdir, "SKILL.md");

  // Check if rendered file exists
  let renderedContent: string;
  try {
    renderedContent = await fs.readFile(renderedPath, "utf-8");
  } catch {
    return "not-rendered";
  }

  // AC: @claude-code-renderer-extended ac-6 - Migrate legacy hash if needed
  await migrateLegacyRenderHash(specDir, skillId, platform);

  // Get stored hash (try platform-specific first, then fall back to legacy)
  const storedHash = await readPlatformRenderHash(specDir, skillId, platform);
  if (!storedHash) {
    return "no-hash";
  }

  // Compare hashes
  const currentHash = computeContentHash(renderedContent);
  return currentHash === storedHash ? "in-sync" : "drifted";
}

/**
 * Get the default output directory for a platform
 */
function getPlatformDefaultOutputDir(platform: string): string {
  switch (platform) {
    case "claude-code":
      return ".claude/skills";
    case "codex":
      return ".agents/skills";
    default:
      return `.${platform}/skills`;
  }
}

// ============================================================================
// Base Render Function
// AC: @skill-module-split ac-2 - Shared render logic extracted into base function
// ============================================================================

/**
 * Options for the base render function
 */
interface BaseRenderConfig {
  /** Platform name (e.g., "claude-code", "codex") */
  platform: string;
  /** Generate the YAML frontmatter for this skill */
  generateFrontmatter: (skill: LoadedSkill) => string;
  /** Optional: generate additional hash content (e.g., sidecar files) */
  getAdditionalHashContent?: (renderedContent: string) => string | null;
  /** Optional: write additional files after SKILL.md (e.g., sidecar) */
  writeAdditionalFiles?: (
    ctx: KspecContext,
    skill: LoadedSkill,
    targetDir: string,
    dryRun: boolean
  ) => Promise<{ paths: string[]; contentChanged: boolean }>;
  /** Optional: additional hash computation for drift check */
  getAdditionalDriftContent?: (skillDir: string) => Promise<string | null>;
  /** If true, also write legacy .render-hash for backward compatibility */
  writeLegacyHash?: boolean;
}

/**
 * Base render function that handles shared logic across all platform renderers:
 * content loading, frontmatter stripping, idempotency check, file write,
 * hash storage, and supporting directory copy.
 *
 * AC: @skill-module-split ac-2 - Shared render logic in base function
 * AC: @platform-renderer-trait ac-1 through ac-6
 */
export async function renderSkillBase(
  ctx: KspecContext,
  projectRoot: string,
  skill: LoadedSkill,
  options: PlatformRenderOptions,
  config: BaseRenderConfig,
  defaultOutputDir: string,
  skillSubdir?: string
): Promise<PlatformRenderResult> {
  const dryRun = options.dryRun ?? false;
  const storeHash = options.storeHash ?? false;
  const outputDir = options.outputDir || defaultOutputDir;

  const targetDir = path.join(projectRoot, outputDir, skillSubdir || skill.id);
  const targetSkillMd = path.join(targetDir, "SKILL.md");
  const paths: string[] = [];

  // Load source content
  const sourceContent = await loadSkillContent(ctx, skill);

  // Generate platform-specific frontmatter
  const frontmatter = config.generateFrontmatter(skill);

  // Build rendered content: frontmatter + marker + body
  let renderedContent: string;
  if (!sourceContent) {
    renderedContent = `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n\n# ${skill.name}\n\n${skill.description || ""}\n`;
  } else {
    const frontmatterMatch = sourceContent.match(/^---\n[\s\S]*?\n---\n?/);
    const contentWithoutFrontmatter = frontmatterMatch
      ? sourceContent.slice(frontmatterMatch[0].length)
      : sourceContent;
    renderedContent = `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n${contentWithoutFrontmatter}`;
  }

  // Idempotency check
  let targetExists = false;
  let targetContent = "";
  try {
    targetContent = await fs.readFile(targetSkillMd, "utf-8");
    targetExists = true;
  } catch {
    // Target doesn't exist
  }

  let action: "created" | "updated" | "unchanged" | "skipped";
  if (!targetExists) {
    action = "created";
  } else if (contentsEqual(renderedContent, targetContent)) {
    action = "unchanged";
  } else {
    action = "updated";
  }

  // Write SKILL.md
  if (!dryRun && action !== "unchanged") {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetSkillMd, renderedContent, "utf-8");
  }
  paths.push(targetSkillMd);

  // Write additional files (e.g., sidecar for codex)
  let additionalContentChanged = false;
  if (config.writeAdditionalFiles) {
    const additional = await config.writeAdditionalFiles(ctx, skill, targetDir, dryRun);
    paths.push(...additional.paths);
    additionalContentChanged = additional.contentChanged;
  }

  // Store per-platform hash
  const contentChanged = action !== "unchanged" || additionalContentChanged;
  if (!dryRun && storeHash && contentChanged) {
    // Get additional content for hash (e.g., sidecar content)
    const additionalHashContent = config.getAdditionalHashContent?.(renderedContent);
    const hashContent = additionalHashContent
      ? renderedContent + "\n" + additionalHashContent
      : renderedContent;
    const hash = computeContentHash(hashContent);
    await writePlatformRenderHash(ctx.specDir, skill.id, config.platform, hash);
    if (config.writeLegacyHash) {
      await writeRenderHash(ctx.specDir, skill.id, hash);
    }
  }

  // Copy supporting directories
  const sourceSkillDir = path.join(ctx.specDir, "skills", skill.id);
  const supportingDirsAction = await copySupportingDirectories(
    sourceSkillDir,
    targetDir,
    dryRun
  );

  for (const [dirName, dirAction] of Object.entries(supportingDirsAction)) {
    if (dirAction !== "skipped") {
      paths.push(path.join(targetDir, dirName));
    }
  }

  return {
    id: skill.id,
    platform: config.platform,
    action,
    paths,
    supportingDirsAction,
  };
}

// ============================================================================
// Claude Code Renderer (implements PlatformRenderer)
// ============================================================================

/**
 * Claude Code platform renderer implementation
 * AC: @platform-renderer-trait ac-1 through ac-6
 */
export const claudeCodeRenderer: PlatformRenderer = {
  platform: "claude-code",
  defaultOutputDir: ".claude/skills",

  async render(
    ctx: KspecContext,
    projectRoot: string,
    skill: LoadedSkill,
    options: PlatformRenderOptions = {}
  ): Promise<PlatformRenderResult> {
    const dryRun = options.dryRun ?? false;

    // Migrate: clean up old flat path when rendering core skills to namespaced path
    if (skill.origin === "core" && !dryRun) {
      const oldPath = path.join(projectRoot, this.defaultOutputDir, skill.id, "SKILL.md");
      try {
        const content = await fs.readFile(oldPath, "utf-8");
        if (content.includes(KSPEC_MANAGED_MARKER)) {
          await fs.rm(path.join(projectRoot, this.defaultOutputDir, skill.id), { recursive: true, force: true });
        }
      } catch {
        // Old path doesn't exist, nothing to clean
      }
    }

    return renderSkillBase(ctx, projectRoot, skill, options, {
      platform: this.platform,
      generateFrontmatter,
      writeLegacyHash: true,
    }, this.defaultOutputDir, getClaudeCodeSkillSubdir(skill));
  },

  async checkDrift(
    specDir: string,
    projectRoot: string,
    skillId: string,
    options?: { outputDir?: string; origin?: string }
  ): Promise<DriftStatus> {
    return checkPlatformSkillDrift(
      specDir,
      projectRoot,
      skillId,
      this.platform,
      options?.outputDir,
      options?.origin
    );
  },
};

// ============================================================================
// Codex Renderer (implements PlatformRenderer)
// AC: @codex-renderer ac-1 through ac-6
// ============================================================================

/**
 * Generate minimal YAML frontmatter for Codex (name + description only)
 * AC: @codex-renderer ac-1 - Codex frontmatter contains only name and description
 */
function generateCodexFrontmatter(skill: LoadedSkill): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.id,
    description: skill.description || skill.name,
  };
  return `---\n${yaml.stringify(frontmatter).trim()}\n---`;
}

/**
 * Generate Codex sidecar openai.yaml content from platform_config.codex
 * AC: @codex-renderer ac-2 - sidecar agents/openai.yaml with Codex config fields
 */
function generateCodexSidecarYaml(skill: LoadedSkill): string | null {
  const codexConfig = skill.platform_config?.codex;
  if (!codexConfig) {
    return null;
  }

  // Build the sidecar structure per Codex docs
  const sidecar: Record<string, unknown> = {};

  // Interface section (display_name, short_description, icons, colors)
  const interfaceSection: Record<string, unknown> = {};
  if (codexConfig.display_name) {
    interfaceSection.display_name = codexConfig.display_name;
  }
  if (codexConfig.short_description) {
    interfaceSection.short_description = codexConfig.short_description;
  }
  if (codexConfig.icon_small) {
    interfaceSection.icon_small = codexConfig.icon_small;
  }
  if (codexConfig.icon_large) {
    interfaceSection.icon_large = codexConfig.icon_large;
  }
  if (codexConfig.brand_color) {
    interfaceSection.brand_color = codexConfig.brand_color;
  }
  if (codexConfig.default_prompt) {
    interfaceSection.default_prompt = codexConfig.default_prompt;
  }
  if (Object.keys(interfaceSection).length > 0) {
    sidecar.interface = interfaceSection;
  }

  // Policy section (allow_implicit_invocation)
  if (codexConfig.allow_implicit_invocation !== undefined) {
    sidecar.policy = {
      allow_implicit_invocation: codexConfig.allow_implicit_invocation,
    };
  }

  // Only return content if there's something to write
  if (Object.keys(sidecar).length === 0) {
    return null;
  }

  return yaml.stringify(sidecar);
}

/**
 * Codex platform renderer implementation
 * AC: @codex-renderer ac-1 - Creates .agents/skills/<id>/SKILL.md with minimal frontmatter
 * AC: @codex-renderer ac-2 - Creates sidecar agents/openai.yaml when platform_config.codex exists
 * AC: @codex-renderer ac-3 - No sidecar created when no platform_config.codex
 * AC: @codex-renderer ac-4 - Rendered file contains <!-- kspec-managed --> marker
 * AC: @codex-renderer ac-5 - Supporting directories copied to output
 * AC: @codex-renderer ac-6 - Hash written to .render-hash-codex
 */
export const codexRenderer: PlatformRenderer = {
  platform: "codex",
  defaultOutputDir: ".agents/skills",

  async render(
    ctx: KspecContext,
    projectRoot: string,
    skill: LoadedSkill,
    options: PlatformRenderOptions = {}
  ): Promise<PlatformRenderResult> {
    // Pre-compute sidecar content so it's available for both hash and write
    const sidecarContent = generateCodexSidecarYaml(skill);

    return renderSkillBase(ctx, projectRoot, skill, options, {
      platform: this.platform,
      generateFrontmatter: generateCodexFrontmatter,

      // AC: @skill-drift-detection-improvements ac-1 - Include sidecar in hash
      getAdditionalHashContent: () => sidecarContent,

      // AC: @codex-renderer ac-2, ac-3 - Write sidecar agents/openai.yaml
      writeAdditionalFiles: async (_ctx, _skill, targetDir, dryRun) => {
        const paths: string[] = [];
        let contentChanged = false;

        if (sidecarContent) {
          const sidecarDir = path.join(targetDir, "agents");
          const sidecarPath = path.join(sidecarDir, "openai.yaml");

          // Check existing sidecar
          let sidecarExists = false;
          let existingSidecar = "";
          try {
            existingSidecar = await fs.readFile(sidecarPath, "utf-8");
            sidecarExists = true;
          } catch {
            // Doesn't exist
          }

          const sidecarAction = !sidecarExists
            ? "created"
            : contentsEqual(sidecarContent, existingSidecar)
              ? "unchanged"
              : "updated";

          if (!dryRun && sidecarAction !== "unchanged") {
            await fs.mkdir(sidecarDir, { recursive: true });
            await fs.writeFile(sidecarPath, sidecarContent, "utf-8");
          }

          paths.push(sidecarPath);
          contentChanged = sidecarAction !== "unchanged";
        }

        return { paths, contentChanged };
      },
    }, this.defaultOutputDir);
  },

  // AC: @skill-drift-detection-improvements ac-1 - Include sidecar content in drift hash
  async checkDrift(
    specDir: string,
    projectRoot: string,
    skillId: string,
    options?: { outputDir?: string; origin?: string }
  ): Promise<DriftStatus> {
    const platformOutputDir = options?.outputDir || this.defaultOutputDir;
    const skillDir = path.join(projectRoot, platformOutputDir, skillId);
    const renderedPath = path.join(skillDir, "SKILL.md");

    // Check if rendered file exists
    let renderedContent: string;
    try {
      renderedContent = await fs.readFile(renderedPath, "utf-8");
    } catch {
      return "not-rendered";
    }

    // Migrate legacy hash if needed
    await migrateLegacyRenderHash(specDir, skillId, this.platform);

    // Get stored hash
    const storedHash = await readPlatformRenderHash(specDir, skillId, this.platform);
    if (!storedHash) {
      return "no-hash";
    }

    // Read sidecar content if it exists
    const sidecarPath = path.join(skillDir, "agents", "openai.yaml");
    let sidecarContent: string | null = null;
    try {
      sidecarContent = await fs.readFile(sidecarPath, "utf-8");
    } catch {
      // No sidecar file
    }

    // Combine content for hash (must match render-time computation)
    const combinedContent = sidecarContent
      ? renderedContent + "\n" + sidecarContent
      : renderedContent;
    const currentHash = computeContentHash(combinedContent);
    return currentHash === storedHash ? "in-sync" : "drifted";
  },
};

// ============================================================================
// Renderer Registry
// ============================================================================

/** Map of platform name to renderer implementation */
const rendererRegistry: Map<string, PlatformRenderer> = new Map([
  ["claude-code", claudeCodeRenderer],
  ["codex", codexRenderer],
]);

/**
 * Get the renderer for a specific platform
 */
export function getRenderer(platform: string): PlatformRenderer | undefined {
  return rendererRegistry.get(platform);
}

/**
 * Get all registered renderers
 */
export function getAllRenderers(): PlatformRenderer[] {
  return Array.from(rendererRegistry.values());
}

/**
 * Register a new platform renderer
 */
export function registerRenderer(renderer: PlatformRenderer): void {
  rendererRegistry.set(renderer.platform, renderer);
}
