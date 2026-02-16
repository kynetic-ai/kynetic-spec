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
    options?: { outputDir?: string }
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
 * Convert snake_case to kebab-case for Claude Code frontmatter keys
 * AC: @claude-code-renderer-extended ac-8 - snake_case to kebab-case conversion
 */
function toKebabCase(str: string): string {
  return str.replace(/_/g, "-");
}

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
 * Get the target directory for rendered skills on main branch.
 * Returns .claude/skills/<id>/ path.
 */
function getRenderedSkillPath(projectRoot: string, skillId: string): string {
  return path.join(projectRoot, ".claude", "skills", skillId);
}

/**
 * Check if two contents are equal (for idempotency check)
 */
function contentsEqual(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Recursively copy a directory
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
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
  skillId: string
): Promise<"not-rendered" | "in-sync" | "drifted" | "no-hash"> {
  const renderedPath = path.join(projectRoot, ".claude", "skills", skillId, "SKILL.md");

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
async function directoriesEqual(src: string, dest: string): Promise<boolean> {
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
  const targetDir = getRenderedSkillPath(projectRoot, skill.id);
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
  outputDir?: string
): Promise<DriftStatus> {
  // Determine the output directory - use custom or platform default
  const platformOutputDir = outputDir || getPlatformDefaultOutputDir(platform);
  const renderedPath = path.join(projectRoot, platformOutputDir, skillId, "SKILL.md");

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
    const storeHash = options.storeHash ?? false;
    // AC: @platform-renderer-trait ac-5 - Custom outputDir support
    const outputDir = options.outputDir || this.defaultOutputDir;

    const targetDir = path.join(projectRoot, outputDir, skill.id);
    const targetSkillMd = path.join(targetDir, "SKILL.md");
    const paths: string[] = [];

    // Load source content
    const sourceContent = await loadSkillContent(ctx, skill);

    let renderedContent: string;
    if (!sourceContent) {
      // No source content - create placeholder
      const frontmatter = generateFrontmatter(skill);
      renderedContent = `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n\n# ${skill.name}\n\n${skill.description || ""}\n`;
    } else {
      // Generate frontmatter and combine with content
      const frontmatter = generateFrontmatter(skill);
      const frontmatterMatch = sourceContent.match(/^---\n[\s\S]*?\n---\n?/);
      const contentWithoutFrontmatter = frontmatterMatch
        ? sourceContent.slice(frontmatterMatch[0].length)
        : sourceContent;
      renderedContent = `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n${contentWithoutFrontmatter}`;
    }

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
    let action: "created" | "updated" | "unchanged" | "skipped";
    if (!targetExists) {
      action = "created";
    } else if (contentsEqual(renderedContent, targetContent)) {
      action = "unchanged";
    } else {
      action = "updated";
    }

    // AC: @platform-renderer-trait ac-4 - dryRun: no files written
    // AC: @platform-renderer-trait ac-1 - Write platform-specific output
    if (!dryRun && action !== "unchanged") {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(targetSkillMd, renderedContent, "utf-8");
    }

    paths.push(targetSkillMd);

    // AC: @platform-renderer-trait ac-6 - Store per-platform hash
    if (!dryRun && storeHash && action !== "unchanged") {
      const hash = computeContentHash(renderedContent);
      await writePlatformRenderHash(ctx.specDir, skill.id, this.platform, hash);
      // Also write legacy hash for backward compatibility
      await writeRenderHash(ctx.specDir, skill.id, hash);
    }

    // AC: @platform-renderer-trait ac-3 - Copy supporting directories
    const sourceSkillDir = path.join(ctx.specDir, "skills", skill.id);
    const supportingDirsAction = await copySupportingDirectories(
      sourceSkillDir,
      targetDir,
      dryRun
    );

    // Add supporting directory paths to output
    for (const [dirName, dirAction] of Object.entries(supportingDirsAction)) {
      if (dirAction !== "skipped") {
        paths.push(path.join(targetDir, dirName));
      }
    }

    return {
      id: skill.id,
      platform: this.platform,
      action,
      paths,
      supportingDirsAction,
    };
  },

  async checkDrift(
    specDir: string,
    projectRoot: string,
    skillId: string,
    options?: { outputDir?: string }
  ): Promise<DriftStatus> {
    return checkPlatformSkillDrift(
      specDir,
      projectRoot,
      skillId,
      this.platform,
      options?.outputDir
    );
  },
};

// ============================================================================
// Renderer Registry
// ============================================================================

/** Map of platform name to renderer implementation */
const rendererRegistry: Map<string, PlatformRenderer> = new Map([
  ["claude-code", claudeCodeRenderer],
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
