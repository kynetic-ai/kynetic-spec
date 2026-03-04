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
  /** Adapter identifier used to format cross-skill references */
  adapterId?: string;
}

const SKILL_REFERENCE_TOKEN_RE = /\{skill:([a-z0-9][a-z0-9-]*)\}/g;

function getSkillReferenceFormat(adapterId?: string): "claude" | "codex" | "none" {
  switch (adapterId) {
    case "claude-agent-acp":
    case "claude-code-acp":
      return "claude";
    case "codex-acp":
      return "codex";
    default:
      return "none";
  }
}

function getProjectRootFromSpecDir(specDir: string): string {
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

function formatSkillReference(
  refId: string,
  format: "claude" | "codex" | "none",
  kspecSkillIds: Set<string>,
): string {
  if (format === "none") {
    return `{skill:${refId}}`;
  }

  const isKspecSkill = kspecSkillIds.has(refId);
  if (format === "claude") {
    return isKspecSkill ? `/kspec:${refId}` : `/${refId}`;
  }

  return isKspecSkill ? `$kspec-${refId}` : `$${refId}`;
}

async function rewriteSkillReferences(
  text: string,
  specDir: string,
  adapterId?: string,
): Promise<string> {
  const format = getSkillReferenceFormat(adapterId);
  if (format === "none") {
    return text;
  }

  const kspecSkillIds = await loadKspecSkillIds(specDir);
  return text.replace(SKILL_REFERENCE_TOKEN_RE, (_match, refId: string) =>
    formatSkillReference(refId, format, kspecSkillIds),
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
  return rewriteSkillReferences(promptWithSkills, specDir, adapterId);
}
