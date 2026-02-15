/**
 * Auto-generated data sections for agent instructions.
 *
 * Library functions that generate markdown sections from kspec meta data:
 * skills table, conventions summary, and workflows summary.
 *
 * AC: @agent-data-sections ac-1 - generateSkillsTable returns markdown table
 * AC: @agent-data-sections ac-2 - generateConventionsSummary returns markdown section
 * AC: @agent-data-sections ac-3 - generateWorkflowsSummary returns markdown section
 */

import type { LoadedConvention, LoadedSkill, LoadedWorkflow } from "./meta.js";

/**
 * Generate a markdown table for skills.
 *
 * AC: @agent-data-sections ac-1
 * Given: skills in meta with varying names and descriptions
 * When: generateSkillsTable is called
 * Then: a markdown table is returned with columns for skill name, description, and invocation
 *
 * @param skills - Array of loaded skills from meta
 * @returns Markdown table string with columns: name (as description), description, invocation
 */
export function generateSkillsTable(skills: LoadedSkill[]): string {
  if (skills.length === 0) {
    return "";
  }

  const lines: string[] = [
    "## Finding Information",
    "",
    "Use skills and CLI help for detailed documentation:",
    "",
    "| Need | Where to look |",
    "|------|---------------|",
  ];

  for (const skill of skills) {
    const description = skill.description || skill.name;
    // Use the skill ID as the reference (prefixed with /)
    lines.push(`| ${description} | \`/${skill.id}\` skill |`);
  }

  lines.push("");
  lines.push(
    "Skills inject their full documentation when invoked — you don't need to memorize their contents.",
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate a markdown section summarizing conventions by domain.
 *
 * AC: @agent-data-sections ac-2
 * Given: conventions in meta with rules arrays
 * When: generateConventionsSummary is called
 * Then: a markdown section is returned listing each domain with its rules
 *
 * @param conventions - Array of loaded conventions from meta
 * @returns Markdown section string with domain headers and rules as list items
 */
export function generateConventionsSummary(
  conventions: LoadedConvention[],
): string {
  if (conventions.length === 0) {
    return "";
  }

  const lines: string[] = ["## Conventions", ""];

  for (const convention of conventions) {
    lines.push(`### ${convention.domain}`);
    lines.push("");

    for (const rule of convention.rules) {
      lines.push(`- ${rule}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate a markdown section summarizing workflows.
 *
 * AC: @agent-data-sections ac-3
 * Given: workflows in meta with triggers and descriptions
 * When: generateWorkflowsSummary is called
 * Then: a markdown section is returned listing each workflow with its trigger
 *
 * @param workflows - Array of loaded workflows from meta
 * @returns Markdown section string with workflow list including triggers
 */
export function generateWorkflowsSummary(workflows: LoadedWorkflow[]): string {
  if (workflows.length === 0) {
    return "";
  }

  const lines: string[] = ["## Workflows", "", "Available workflows:", ""];

  for (const workflow of workflows) {
    const description = workflow.description || workflow.trigger;
    lines.push(`- **${workflow.id}**: ${description}`);
  }

  lines.push("");
  lines.push("Use `kspec workflow start @workflow-id` to start a workflow.");
  lines.push("");

  return lines.join("\n");
}
