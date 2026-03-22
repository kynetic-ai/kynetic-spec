/**
 * Agent Prompt Building
 *
 * Resolves skills from the skill registry and builds structured prompts
 * for agent invocations. Extracted from the legacy dispatch command path to be
 * reusable by both
 * the dispatch engine and CLI one-shot mode.
 *
 * AC: @agent-invocation-lifecycle ac-7
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { resolveSkillReferenceTokensForPlatform } from "../parser/skill-render.js";
import { loadMetaContext, type LoadedSkill } from "../parser/meta.js";
import { initContext } from "../parser/yaml.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A resolved skill with its content loaded.
 */
export interface ResolvedSkill {
  /** Skill ID */
  id: string;
  /** Full markdown content of the skill */
  content: string;
}

/**
 * Options for building an agent prompt.
 */
export interface BuildPromptOptions {
  /** Base prompt text */
  basePrompt: string;
  /** Skill IDs to resolve and include */
  skillIds: string[];
  /** The .kspec directory for resolving skill content */
  specDir: string;
  /** Adapter identifier used to format cross-skill references */
  adapterId?: string;
}

function getSkillReferencePlatform(adapterId?: string): "claude-code" | "codex" | "droid" | null {
  switch (adapterId) {
    case "claude-agent-acp":
    case "claude-code-acp":
      return "claude-code";
    case "codex-acp":
      return "codex";
    case "droid-acp":
      return "droid";
    default:
      return null;
  }
}

function getProjectRootFromSpecDir(specDir: string): string {
  // .agents/skills is tracked at the project root, so resolving upward from
  // .kspec/ stays correct in both the primary checkout and linked worktrees.
  return path.basename(specDir) === ".kspec" ? path.dirname(specDir) : specDir;
}

async function loadKspecSkillIds(specDir: string): Promise<Set<string>> {
  const projectRoot = getProjectRootFromSpecDir(specDir);
  const skillsDir = path.join(projectRoot, ".agents", "skills");

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (!entry.name.startsWith("kspec-")) {
        continue;
      }
      ids.add(entry.name.slice("kspec-".length));
    }
    return ids;
  } catch {
    return new Set<string>();
  }
}

async function loadSkillOrigins(specDir: string): Promise<Map<string, LoadedSkill["origin"]>> {
  try {
    const ctx = await initContext(specDir);
    const meta = await loadMetaContext(ctx);
    if (meta.skills.length > 0) {
      const origins = new Map<string, LoadedSkill["origin"]>();
      for (const skill of meta.skills) {
        origins.set(skill.id, skill.origin);
      }
      return origins;
    }
  } catch {
    // Fall back to rendered skill directory inference below.
  }

  const kspecSkillIds = await loadKspecSkillIds(specDir);
  const origins = new Map<string, LoadedSkill["origin"]>();
  for (const skillId of kspecSkillIds) {
    origins.set(skillId, "core");
  }
  return origins;
}

export async function rewriteSkillReferencesForAdapter(
  text: string,
  specDir: string,
  adapterId?: string,
): Promise<string> {
  const platform = getSkillReferencePlatform(adapterId);
  if (!platform) {
    return text;
  }

  const skillOrigins = await loadSkillOrigins(specDir);

  return resolveSkillReferenceTokensForPlatform(text, platform, skillOrigins);
}

// ─── Template Interpolation ──────────────────────────────────────────────────

/**
 * Interpolate {{variable}} placeholders in a template string.
 *
 * Used by both dispatch mode and CLI one-shot mode to resolve
 * agent prompt_template variables (e.g. {{task_ref}}, {{task_title}}).
 * Unrecognized placeholders are left as-is.
 */
export function interpolateTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (match, key: string) => vars[key] ?? match,
  );
}

// ─── Skill Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve skill content from the skill registry.
 *
 * Skills are stored in .kspec/skills/<id>/SKILL.md.
 * Missing skills are silently skipped.
 *
 * AC: @agent-invocation-lifecycle ac-7
 */
export async function resolveSkills(
  skillIds: string[],
  specDir: string,
): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = [];

  for (const skillId of skillIds) {
    const contentPath = path.join(specDir, "skills", skillId, "SKILL.md");
    try {
      const content = await fs.readFile(contentPath, "utf-8");
      resolved.push({ id: skillId, content });
    } catch {
      // Skill not found — skip silently
    }
  }

  return resolved;
}

/**
 * Build a prompt with resolved skill content appended.
 *
 * When the agent definition specifies skills, their content is resolved
 * from the skill registry and included in the prompt.
 *
 * AC: @agent-invocation-lifecycle ac-7
 */
export async function buildPromptWithSkills(options: BuildPromptOptions): Promise<string> {
  const {
    basePrompt,
    skillIds,
    specDir,
    adapterId,
  } = options;

  if (skillIds.length === 0) {
    return basePrompt;
  }

  const resolvedSkills = await resolveSkills(skillIds, specDir);

  if (resolvedSkills.length === 0) {
    return basePrompt;
  }

  const skillSections = resolvedSkills
    .map((skill) => `<!-- Skill: ${skill.id} -->\n${skill.content}`)
    .join("\n\n");

  const promptWithSkills = `${basePrompt}\n\n## Skills\n\n${skillSections}`;

  // AC: @agent-invocation-lifecycle ac-10
  // Rewrite portable {skill:<id>} references to adapter-specific invocation syntax.
  return rewriteSkillReferencesForAdapter(promptWithSkills, specDir, adapterId);
}
