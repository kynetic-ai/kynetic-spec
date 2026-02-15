/**
 * Claude Code Skill Renderer
 *
 * Platform-specific renderer for Claude Code. Reads from .kspec/skills/<id>/SKILL.md,
 * writes to .claude/skills/<id>/SKILL.md with YAML frontmatter (name, description).
 * Does NOT auto-commit to main branch — leaves files unstaged.
 *
 * AC: @claude-code-renderer ac-1 - renderClaudeCodeSkill creates .claude/skills/<id>/SKILL.md with YAML frontmatter
 * AC: @claude-code-renderer ac-2 - rendered output has YAML frontmatter delimiters with name and description fields
 * AC: @claude-code-renderer ac-3 - skill body content appears verbatim below frontmatter
 * AC: @claude-code-renderer ac-4 - rendered files appear as unstaged changes on main branch
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import yaml from "yaml";
import type { KspecContext } from "./yaml.js";
import { loadSkillContent, type LoadedSkill } from "./meta.js";

/**
 * Result of rendering a skill to Claude Code format
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
 */
export interface RenderSkillOptions {
  /** If true, don't write files, just return what would be done */
  dryRun?: boolean;
}

/**
 * Marker comment that identifies skill directories managed by kspec
 */
export const KSPEC_MANAGED_MARKER = "<!-- kspec-managed -->";

/**
 * Generate YAML frontmatter for a skill.
 * AC: @claude-code-renderer ac-2 - YAML frontmatter with name and description fields
 */
function generateFrontmatter(skill: LoadedSkill): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.id,
    description: skill.description || skill.name,
  };
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
  }

  // Handle docs directory
  const sourceDocsDir = path.join(ctx.specDir, "skills", skill.id, "docs");
  const targetDocsDir = path.join(targetDir, "docs");
  let docsAction: "created" | "updated" | "unchanged" | "skipped" = "skipped";

  try {
    const stats = await fs.stat(sourceDocsDir);
    if (stats.isDirectory()) {
      // Check if target docs exist and compare
      let targetDocsExist = false;
      try {
        await fs.stat(targetDocsDir);
        targetDocsExist = true;
      } catch {
        // Target docs don't exist
      }

      if (!targetDocsExist) {
        docsAction = "created";
      } else {
        // Compare directories
        const equal = await directoriesEqual(sourceDocsDir, targetDocsDir);
        docsAction = equal ? "unchanged" : "updated";
      }

      // Apply changes
      if (!dryRun && docsAction !== "unchanged") {
        // Remove existing docs and copy fresh
        if (targetDocsExist) {
          await fs.rm(targetDocsDir, { recursive: true, force: true });
        }
        await fs.mkdir(targetDocsDir, { recursive: true });
        await copyDirectory(sourceDocsDir, targetDocsDir);
      }
    }
  } catch {
    // No source docs directory
  }

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
