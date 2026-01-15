import { Command } from 'commander';
import chalk from 'chalk';

/**
 * Extended help content for commands and concepts.
 * Each topic has a title, description, and examples.
 */
interface HelpTopic {
  title: string;
  description: string;
  examples?: string[];
  seeAlso?: string[];
}

const helpTopics: Record<string, HelpTopic> = {
  // Command topics
  task: {
    title: 'Task Operations',
    description: `
Individual task operations for managing task lifecycle.

Commands:
  task get <ref>       Show task details including spec context
  task add             Create a new task (auto-generates ULID)
  task start <ref>     Move task from pending to in_progress
  task complete <ref>  Move task from in_progress to completed
  task block <ref>     Manually block a task with a reason
  task unblock <ref>   Clear manual blockers (not dependencies)
  task cancel <ref>    Cancel a task with a reason
  task note <ref>      Add a work log note to a task
  task notes <ref>     Show all notes for a task

Task References:
  Tasks can be referenced by slug (@task-slug) or ULID prefix (@01KEZ).
  The @ prefix is optional in commands.

Blocking vs Dependencies:
  - blocked_by: Manual blockers (strings like "waiting on design review")
  - depends_on: Task references that auto-resolve when completed

  Use 'task block' for manual blockers. Dependencies are set in YAML.
`,
    examples: [
      'kspec task get @task-cli-help',
      'kspec task add --title "Fix login bug" --priority 1 --tag bug',
      'kspec task start @my-task',
      'kspec task note @my-task "Investigated root cause, found issue in auth module"',
      'kspec task complete @my-task --reason "Fixed by updating token validation"',
      'kspec task block @my-task --reason "Waiting on API spec from backend team"',
      'kspec task unblock @my-task',
    ],
    seeAlso: ['tasks', 'refs', 'statuses'],
  },

  tasks: {
    title: 'Task Queries',
    description: `
Query and list tasks with various filters.

Commands:
  tasks ready      Show tasks that can be worked on (unblocked, pending)
  tasks active     Show tasks currently in progress
  tasks blocked    Show blocked tasks
  tasks completed  Show completed tasks
  tasks all        Show all tasks

Filters (apply to any query):
  --priority <n>   Filter by priority (1-5, 1 is highest)
  --tag <tag>      Filter by tag (can use multiple times)
  --limit <n>      Limit number of results

Output shows: ULID (short), slug, status, priority, and title.
`,
    examples: [
      'kspec tasks ready',
      'kspec tasks ready --priority 1',
      'kspec tasks active',
      'kspec tasks all --tag mvp',
      'kspec tasks completed --limit 5',
    ],
    seeAlso: ['task', 'statuses'],
  },

  validate: {
    title: 'Spec Validation',
    description: `
Validate spec files for schema conformance and reference integrity.

Options:
  --schema    Check schema conformance only
  --refs      Check reference resolution only
  --orphans   Find unreferenced spec items only
  --strict    Treat orphans as errors (exit 1)
  -v          Verbose output (show all orphans)
  --json      Output structured JSON

Default runs all checks. Exit code 1 if errors found.

What it checks:
  - Schema: All items conform to Zod schemas
  - References: All @refs resolve to existing items
  - Orphans: Items not referenced by any task (warning)

Alias: 'kspec lint' does the same thing.
`,
    examples: [
      'kspec validate',
      'kspec validate --refs',
      'kspec validate --strict',
      'kspec validate --json',
    ],
    seeAlso: ['refs'],
  },

  session: {
    title: 'Session Management',
    description: `
Get context for a work session - what's active, ready, and recent.

Commands:
  session start    Show session context (active work, ready tasks, git status)

Options:
  --full           Show more detail
  --since <time>   Filter by time (e.g., "1d", "2h", "30m")
  --json           Output structured JSON

The session start command is designed for agents to quickly understand:
  - What work is currently in progress
  - What was recently completed
  - What tasks are ready to pick up
  - Recent git activity
  - Uncommitted changes

Alias: 'kspec context' does the same thing.
`,
    examples: [
      'kspec session start',
      'kspec session start --full',
      'kspec session start --since 1d',
      'kspec context',
    ],
    seeAlso: ['tasks'],
  },

  init: {
    title: 'Project Initialization',
    description: `
Initialize a new kspec project with scaffolding.

Creates:
  - kynetic.yaml (manifest)
  - kynetic.tasks.yaml (task file)
  - spec/ directory with module files

Options:
  --name <name>    Project name
  --yes            Skip prompts, use defaults

Run in an existing directory or specify a path.
`,
    examples: [
      'kspec init',
      'kspec init --name my-project',
      'kspec init ./new-project --yes',
    ],
  },

  setup: {
    title: 'Agent Environment Setup',
    description: `
Configure agent environment for kspec integration.

Auto-detects:
  - Claude Code (CLAUDE.md)
  - Cursor (.cursor/rules)
  - Other agent environments

Creates or updates agent configuration files with kspec instructions,
including quick-start commands and workflow guidance.

Options:
  --agent <type>   Specify agent type (claude-code, cursor, etc.)
  --dry-run        Show what would be created without writing

Run this after 'kspec init' to set up agent integration.
`,
    examples: [
      'kspec setup',
      'kspec setup --agent claude-code',
      'kspec setup --dry-run',
    ],
    seeAlso: ['init', 'workflow'],
  },

  item: {
    title: 'Spec Item Commands',
    description: `
Query and inspect spec items (features, requirements, constraints).

Commands:
  item get <ref>    Show item details
  item list         List all spec items

Spec items define WHAT to build. Tasks track the WORK of building.
Tasks reference spec items via the spec_ref field.
`,
    examples: [
      'kspec item get @ref-validation',
      'kspec item list',
      'kspec item list --type feature',
    ],
    seeAlso: ['refs', 'task'],
  },

  // Concept topics
  refs: {
    title: 'References (@refs)',
    description: `
References link items together using @ prefix.

Formats:
  @slug           Human-friendly name (e.g., @task-cli-help)
  @ULID           Full 26-char ULID (e.g., @01KEZJNSGPTVRCMT9NHNPJ93D8)
  @prefix         ULID prefix, must be unique (e.g., @01KEZ)

Where refs are used:
  - spec_ref: Links task to spec item it implements
  - depends_on: Task dependencies (auto-resolve when target completes)
  - implements: Spec item implements another
  - context: Related items for reference

Resolution order:
  1. Exact slug match
  2. Full ULID match
  3. ULID prefix match (must be unambiguous)

Validate refs with: kspec validate --refs
`,
    examples: [
      'kspec task get @task-cli-help',
      'kspec task get @01KEZJNS',
      'kspec item get @ref-validation',
    ],
    seeAlso: ['validate', 'task'],
  },

  statuses: {
    title: 'Task Statuses',
    description: `
Task lifecycle states and transitions.

States:
  pending      → Ready to start (or waiting on dependencies)
  in_progress  → Currently being worked on
  completed    → Done
  blocked      → Manually blocked (has blocked_by entries)
  cancelled    → Cancelled, won't be done

Transitions:
  pending → in_progress     kspec task start
  in_progress → completed   kspec task complete
  in_progress → blocked     kspec task block
  blocked → pending         kspec task unblock
  any → cancelled           kspec task cancel

Auto-blocking:
  Tasks with unfinished depends_on entries are effectively blocked
  but show as 'pending'. They become 'ready' when deps complete.

The 'tasks ready' command shows pending tasks with no blockers
and no incomplete dependencies.
`,
    seeAlso: ['task', 'tasks'],
  },

  workflow: {
    title: 'Typical Workflow',
    description: `
Common workflow for working on tasks.

Starting a session:
  1. kspec session start     # See what's active and ready
  2. Pick a task from ready list

Working on a task:
  1. kspec task start @task  # Mark as in_progress
  2. kspec task note @task "Starting work on X..."
  3. Do the work
  4. kspec task note @task "Completed X, approach was Y..."
  5. kspec task complete @task --reason "Summary"

Creating new tasks:
  kspec task add --title "Task name" --spec-ref @item --priority 2

Blocking/unblocking:
  kspec task block @task --reason "Waiting on X"
  kspec task unblock @task

Validating changes:
  kspec validate
`,
    seeAlso: ['session', 'task', 'tasks'],
  },
};

/**
 * Format and display a help topic
 */
function showTopic(topic: string): void {
  const help = helpTopics[topic];
  if (!help) {
    console.log(chalk.red(`Unknown topic: ${topic}`));
    console.log(`\nAvailable topics: ${Object.keys(helpTopics).join(', ')}`);
    console.log(`\nRun 'kspec help' to see all topics.`);
    process.exit(1);
  }

  console.log(chalk.bold.cyan(help.title));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(help.description.trim());

  if (help.examples && help.examples.length > 0) {
    console.log(chalk.bold('\nExamples:'));
    for (const example of help.examples) {
      console.log(chalk.green(`  ${example}`));
    }
  }

  if (help.seeAlso && help.seeAlso.length > 0) {
    console.log(chalk.gray(`\nSee also: ${help.seeAlso.map(t => `kspec help ${t}`).join(', ')}`));
  }
}

/**
 * Show list of all topics
 */
function showTopicList(): void {
  console.log(chalk.bold.cyan('kspec help'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log('\nExtended help for kspec commands and concepts.\n');

  console.log(chalk.bold('Commands:'));
  const commandTopics = ['task', 'tasks', 'validate', 'session', 'init', 'setup', 'item'];
  for (const topic of commandTopics) {
    const help = helpTopics[topic];
    if (help) {
      console.log(`  ${chalk.green(topic.padEnd(12))} ${help.title}`);
    }
  }

  console.log(chalk.bold('\nConcepts:'));
  const conceptTopics = ['refs', 'statuses', 'workflow'];
  for (const topic of conceptTopics) {
    const help = helpTopics[topic];
    if (help) {
      console.log(`  ${chalk.green(topic.padEnd(12))} ${help.title}`);
    }
  }

  console.log(chalk.gray('\nUsage: kspec help <topic>'));
}

/**
 * Register the help command
 */
export function registerHelpCommand(program: Command): void {
  program
    .command('help [topic]')
    .description('Extended help for commands and concepts')
    .action((topic?: string) => {
      if (topic) {
        showTopic(topic);
      } else {
        showTopicList();
      }
    });
}
