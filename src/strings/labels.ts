/**
 * Field labels and section headers used throughout the CLI output
 */

import chalk from 'chalk';

/**
 * Session context section headers
 */
export const sessionHeaders = {
  title: chalk.blue.bold('=== Session Context ==='),
  activeWork: chalk.cyan.bold('--- Active Work ---'),
  noActiveWork: chalk.gray('--- No Active Work ---'),
  recentlyCompleted: chalk.green.bold('--- Recently Completed ---'),
  recentNotes: chalk.cyan.bold('--- Recent Notes ---'),
  incompleteTodos: chalk.yellow.bold('--- Incomplete Todos ---'),
  readyTasks: chalk.cyan.bold('--- Ready to Pick Up ---'),
  blocked: chalk.red.bold('--- Blocked ---'),
  recentCommits: chalk.cyan.bold('--- Recent Commits ---'),
  inbox: chalk.magenta.bold('--- Inbox (oldest first) ---'),
  workingTree: chalk.yellow.bold('--- Working Tree ---'),
  workingTreeClean: chalk.gray('--- Working Tree: Clean ---'),
  quickCommands: chalk.gray.bold('--- Quick Commands ---'),
} as const;

/**
 * Task/Item detail field labels
 */
export const fieldLabels = {
  ulid: 'ULID:',
  slugs: 'Slugs:',
  type: 'Type:',
  status: 'Status:',
  priority: 'Priority:',
  specRef: 'Spec ref:',
  metaRef: 'Meta ref:',
  depends: 'Depends:',
  blocked: 'Blocked:',
  tags: 'Tags:',
  created: 'Created:',
  started: 'Started:',
  completed: 'Completed:',
  implementation: 'Implementation: ',
  description: 'Description:',
  acceptanceCriteria: 'Acceptance Criteria:',
  traceability: 'Traceability:',
} as const;

/**
 * Output section separators
 */
export const sectionHeaders = {
  specContext: chalk.gray('─── Spec Context ───'),
  notes: chalk.gray('─── Notes ───'),
  todos: chalk.gray('─── Todos ───'),
} as const;

/**
 * Common CLI hints/suggestions
 */
export const hints = {
  inboxPromote: chalk.gray('Use: kspec inbox promote <ref> to convert to task'),
  taskNote: (ref: string) =>
    chalk.gray(`Use: kspec task note ${ref} "<note>" to add context`),
  taskComplete: (ref: string) =>
    chalk.gray(`Use: kspec task complete ${ref} --reason "<summary>" when done`),
  taskStart: (ref: string) =>
    chalk.gray(`Use: kspec task start ${ref} to begin work`),
  gitCommit: chalk.gray('Use: git add -A && git commit -m "..." to commit changes'),
} as const;

/**
 * Summary/count messages
 */
export const summaries = {
  noTasks: chalk.gray('No tasks found'),
  taskCount: (count: number) => chalk.gray(`${count} task(s)`),
} as const;
