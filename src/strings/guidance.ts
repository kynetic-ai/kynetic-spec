/**
 * Guidance and instructional text shown to users and agents
 */

import chalk from "chalk";

/**
 * Alignment check guidance (shown when adding task notes)
 */
export const alignmentCheck = {
  header: chalk.gray("--- Alignment Check ---"),
  beyondSpec: chalk.gray(
    "Did your implementation add anything beyond the original spec?",
  ),
  updateSpec: (specRef: string) =>
    chalk.gray(
      `If so, consider updating the spec:\n  kspec item set ${specRef} --description "Updated description"`,
    ),
  addAC: chalk.gray("Or add acceptance criteria for new features."),
  testCoverage: (count: number) =>
    chalk.gray(
      `Linked spec has ${count} acceptance criteria - consider test coverage.`,
    ),
} as const;

/**
 * Commit guidance (shown after task completion)
 */
export const commitGuidance = {
  header: chalk.gray("--- Suggested Commit ---"),
  message: (msg: string) => chalk.cyan(msg),
  trailers: (trailers: string) => chalk.gray(trailers),
  noSpecRef: {
    warning: chalk.yellow("This task has no spec_ref."),
    consider: chalk.gray(
      "Is this a spec gap? Consider: kspec item add --under @parent ...",
    ),
    intentional: chalk.gray("Or is this intentional (infra/cleanup)?"),
  },
} as const;

/**
 * Session checkpoint instructions
 */
export const checkpoint = {
  intro: chalk.yellow("Before ending this session, please:"),

  inProgressTasks: {
    header: chalk.yellow("\n1. In-Progress Tasks:"),
    action: chalk.gray(
      "   Complete them or add a note explaining current state:",
    ),
    noteCommand: (ref: string) =>
      chalk.gray(`   kspec task note ${ref} "WIP: what's done, what remains"`),
  },

  incompleteTodos: {
    header: chalk.yellow("\n2. Incomplete Todos:"),
    action: chalk.gray("   Complete them or convert to tasks:"),
    command: chalk.gray('   kspec task add --title "..." --spec-ref "@..."'),
  },

  uncommittedChanges: {
    header: chalk.yellow("\n3. Uncommitted Changes:"),
    action: chalk.gray("   Commit your work or create a WIP commit:"),
    wipCommit: chalk.gray(
      `   git add -A && git commit -m "WIP: describe state\n\n   Task: @task-ref"`,
    ),
    wipGuidance: chalk.gray(
      "   WIP commits are fine - they show progress and can be squashed later.",
    ),
  },

  hints: {
    header: chalk.gray("\nHelpful commands:"),
    taskNote: chalk.gray(
      'Use: kspec task note @task "Progress notes..." to document state',
    ),
    taskComplete: chalk.gray(
      'Use: kspec task complete @task --reason "Summary" if task is done',
    ),
  },

  messages: {
    retry: (count: number) =>
      chalk.yellow(
        `[kspec] Session checkpoint: ${count} issue(s) acknowledged - allowing stop`,
      ),
    success: chalk.green(
      "[kspec] Session checkpoint passed - ready to end session",
    ),
    issues: (count: number) =>
      chalk.yellow(
        `[kspec] Session checkpoint: ${count} issue(s) need attention`,
      ),
  },
} as const;

/**
 * Session prompt check (hook message)
 */
export const sessionPrompt = {
  specCheck:
    "[kspec] Before implementing behavior changes, check spec coverage. Update spec first if needed.",
} as const;
