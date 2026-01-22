/**
 * Commit message formatting utilities
 */

import chalk from "chalk";
import type { Task } from "../schema/index.js";

export interface CommitGuidance {
  /** Suggested commit message subject line */
  message: string;
  /** Trailers to append (e.g., Task: @slug, Spec: @ref) */
  trailers: string[];
  /** Whether spec gap warning should be shown */
  hasSpecGap: boolean;
}

/**
 * Generate commit guidance for a task
 */
export function formatCommitGuidance(
  task: Task,
  options: { wip?: boolean } = {},
): CommitGuidance {
  const prefix = options.wip ? "wip" : inferCommitType(task);
  // Remove "Implement: " prefix if present (from derive command)
  const subject = task.title.replace(/^Implement:\s*/i, "");

  const trailers: string[] = [];
  const taskRef = task.slugs[0]
    ? `@${task.slugs[0]}`
    : `@${task._ulid.slice(0, 8)}`;
  trailers.push(`Task: ${taskRef}`);

  if (task.spec_ref) {
    trailers.push(`Spec: ${task.spec_ref}`);
  }

  const message = `${prefix}: ${subject}`;

  return {
    message,
    trailers,
    hasSpecGap: !task.spec_ref,
  };
}

/**
 * Infer conventional commit type from task metadata
 */
function inferCommitType(task: Task): string {
  // Check task type first
  if (task.type === "bug") return "fix";
  if (task.type === "infra") return "chore";

  // Check tags
  const tags = task.tags.map((t) => t.toLowerCase());
  if (tags.includes("docs") || tags.includes("documentation")) return "docs";
  if (tags.includes("test") || tags.includes("testing")) return "test";
  if (tags.includes("refactor")) return "refactor";
  if (tags.includes("perf") || tags.includes("performance")) return "perf";
  if (tags.includes("chore")) return "chore";

  // Default to feat for features and other tasks
  return "feat";
}

/**
 * Output commit guidance to console
 */
export function printCommitGuidance(guidance: CommitGuidance): void {
  console.log("");
  console.log(chalk.gray("--- Suggested Commit ---"));
  console.log(chalk.cyan(guidance.message));
  console.log("");
  for (const trailer of guidance.trailers) {
    console.log(chalk.gray(trailer));
  }

  if (guidance.hasSpecGap) {
    console.log("");
    console.log(chalk.yellow("This task has no spec_ref."));
    console.log(
      chalk.gray(
        "Is this a spec gap? Consider: kspec item add --under @parent ...",
      ),
    );
    console.log(chalk.gray("Or is this intentional (infra/cleanup)?"));
  }
}
