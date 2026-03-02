/**
 * Agent Prompt Building
 *
 * Resolves skills from the skill registry and builds structured prompts
 * for agent invocations. Extracted from ralph.ts to be reusable by both
 * the dispatch engine and CLI one-shot mode.
 *
 * AC: @agent-invocation-lifecycle ac-7
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";

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
  const { basePrompt, skillIds, specDir } = options;

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

  return `${basePrompt}\n\n## Skills\n\n${skillSections}`;
}
