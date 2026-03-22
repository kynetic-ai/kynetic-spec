/**
 * Auto-generated data sections for agent instructions.
 *
 * Library functions that generate markdown sections from kspec meta data:
 * conventions summary and workflows summary.
 *
 * AC: @agent-data-sections ac-2 - generateConventionsSummary returns markdown section
 * AC: @agent-data-sections ac-3 - generateWorkflowsSummary returns markdown section
 */

import type { LoadedConvention, LoadedWorkflow } from "./meta.js";

/**
 * Intro paragraph for the conventions section.
 * Extracted as a constant for future configurability.
 */
export const CONVENTIONS_INTRO =
  "These are the project's agreed-upon conventions. Follow them in all contributions to maintain consistency.";

/**
 * Generate a markdown section summarizing conventions by domain.
 *
 * AC: @agent-data-sections ac-2
 * Given: conventions in meta with rules arrays
 * When: generateConventionsSummary is called
 * Then: a markdown section is returned listing each domain with its rules
 *
 * @param conventions - Array of loaded conventions from meta
 * @returns Markdown section string with domain headers, rules as list items, and examples
 */
export function generateConventionsSummary(
  conventions: LoadedConvention[],
): string {
  if (conventions.length === 0) {
    return "";
  }

  const lines: string[] = ["## Conventions", "", CONVENTIONS_INTRO, ""];

  for (const convention of conventions) {
    lines.push(`### ${convention.domain}`);
    lines.push("");

    for (const rule of convention.rules) {
      lines.push(`- ${rule}`);
    }

    // Render examples when present
    if (convention.examples && convention.examples.length > 0) {
      lines.push("");
      lines.push("**Examples:**");
      for (const example of convention.examples) {
        const combinedLength = example.good.length + example.bad.length;
        if (combinedLength > 80) {
          // Long format: quoted, separate lines
          lines.push(`- Good: "${example.good}"`);
          lines.push(`- Bad: "${example.bad}"`);
        } else {
          // Short format: inline code with em-dash
          lines.push(
            `- Good: \`${example.good}\` — Bad: \`${example.bad}\``,
          );
        }
      }
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
