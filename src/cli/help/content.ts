/**
 * Curated help content for kspec commands and concepts
 *
 * This module contains conceptual documentation, examples, and cross-references
 * that complement the auto-generated command syntax from Commander introspection.
 *
 * What goes here:
 * - Conceptual explanations
 * - Usage examples
 * - Cross-references (seeAlso)
 * - Workflow guidance
 *
 * What doesn't go here:
 * - Command names (auto-generated)
 * - Option lists (auto-generated)
 * - Subcommand lists (auto-generated)
 */

/**
 * Curated help content for a command or concept
 */
export interface HelpContent {
  /** Topic title (can be overridden, defaults to command description) */
  title?: string;
  /** Conceptual explanation (what, why, how) */
  concept: string;
  /** Usage examples */
  examples?: string[];
  /** Related topics */
  seeAlso?: string[];
}

/**
 * All curated help content keyed by command path or concept name
 */
export const helpContent: Record<string, HelpContent> = {
  // Command-specific content
  task: {
    concept: `
Individual task operations for managing task lifecycle.

Task References:
  Tasks can be referenced by slug (@task-slug) or ULID prefix (@01KEZ).
  The @ prefix is optional in commands.

Notes vs Todos:
  - Notes: Append-only work log entries for tracking progress and findings
  - Todos: Lightweight checklist items that emerge during work

Blocking vs Dependencies:
  - blocked_by: Manual blockers (strings like "waiting on design review")
  - depends_on: Task references that auto-resolve when completed

  Use 'task block' for manual blockers. Dependencies are set in YAML.
`,
    examples: [
      "kspec task get @task-cli-help",
      'kspec task add --title "Fix login bug" --priority 1 --tag bug',
      "kspec task start @my-task",
      'kspec task note @my-task "Investigated root cause, found issue in auth module"',
      'kspec task complete @my-task --reason "Fixed by updating token validation"',
      'kspec task todo add @my-task "Review error handling"',
      "kspec task todo done @my-task 1",
      "kspec task todos @my-task",
    ],
    seeAlso: ["tasks", "refs", "statuses"],
  },

  tasks: {
    concept: `
Query and list tasks with various filters.

Output shows: ULID (short), slug, status, priority, and title.
`,
    examples: [
      "kspec tasks ready",
      "kspec tasks ready --priority 1",
      "kspec tasks active",
      "kspec tasks all --tag mvp",
      "kspec tasks completed --limit 5",
    ],
    seeAlso: ["task", "statuses"],
  },

  validate: {
    concept: `
Validate spec files for schema conformance and reference integrity.

Default runs all checks. Exit code 1 if errors found.

What it checks:
  - Schema: All items conform to Zod schemas
  - References: All @refs resolve to existing items
  - Orphans: Items not referenced by any task (warning)

Alias: 'kspec lint' does the same thing.
`,
    examples: [
      "kspec validate",
      "kspec validate --refs",
      "kspec validate --strict",
      "kspec validate --json",
    ],
    seeAlso: ["refs"],
  },

  session: {
    concept: `
Get context for a work session - what's active, ready, and recent.

The session start command is designed for agents to quickly understand:
  - What work is currently in progress
  - What was recently completed
  - What tasks are ready to pick up
  - Recent git activity
  - Uncommitted changes

Alias: 'kspec context' does the same thing.
`,
    examples: [
      "kspec session start",
      "kspec session start --full",
      "kspec session start --since 1d",
      "kspec context",
    ],
    seeAlso: ["tasks"],
  },

  init: {
    concept: `
Initialize a new kspec project with scaffolding.

Creates:
  - kynetic.yaml (manifest)
  - kynetic.tasks.yaml (task file)
  - spec/ directory with module files

Run in an existing directory or specify a path.
`,
    examples: [
      "kspec init",
      "kspec init --name my-project",
      "kspec init ./new-project --yes",
    ],
  },

  setup: {
    concept: `
Configure agent environment for kspec integration.

Auto-detects:
  - Claude Code (CLAUDE.md)
  - Cursor (.cursor/rules)
  - Other agent environments

Creates or updates agent configuration files with kspec instructions,
including quick-start commands and workflow guidance.

Run this after 'kspec init' to set up agent integration.
`,
    examples: [
      "kspec setup",
      "kspec setup --agent claude-code",
      "kspec setup --dry-run",
    ],
    seeAlso: ["init", "workflow"],
  },

  item: {
    concept: `
CRUD operations on spec items (features, requirements, constraints).

Spec items define WHAT to build. Tasks track the WORK of building.
Items are nested: modules contain features, features contain requirements.
`,
    examples: [
      "kspec item list --type feature",
      "kspec item get @ref-validation",
      'kspec item add --under @core --title "New Feature" --type feature',
      'kspec item add --under @spec-item --title "New Req" --type requirement',
      "kspec item set @my-feature --status implemented",
      "kspec item delete @old-feature",
    ],
    seeAlso: ["refs", "task"],
  },

  // Concept topics
  refs: {
    title: "References (@refs)",
    concept: `
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
      "kspec task get @task-cli-help",
      "kspec task get @01KEZJNS",
      "kspec item get @ref-validation",
    ],
    seeAlso: ["validate", "task"],
  },

  statuses: {
    title: "Task Statuses",
    concept: `
Task lifecycle states and transitions.

States:
  pending        → Ready to start (or waiting on dependencies)
  in_progress    → Currently being worked on
  pending_review → Code done, awaiting review/merge
  completed      → Done (merged/shipped)
  blocked        → Manually blocked (has blocked_by entries)
  cancelled      → Cancelled, won't be done

Transitions:
  pending → in_progress          kspec task start
  in_progress → pending_review   kspec task submit
  pending_review → completed     kspec task complete
  in_progress → completed        kspec task complete (skip review)
  in_progress → blocked          kspec task block
  pending_review → blocked       kspec task block
  blocked → pending              kspec task unblock
  any → cancelled                kspec task cancel

Auto-blocking:
  Tasks with unfinished depends_on entries are effectively blocked
  but show as 'pending'. They become 'ready' when deps complete.

The 'tasks ready' command shows pending tasks with no blockers
and no incomplete dependencies.
`,
    seeAlso: ["task", "tasks"],
  },

  workflow: {
    title: "Typical Workflow",
    concept: `
Common workflow for working on tasks.

Starting a session:
  1. kspec session start     # See what's active and ready
  2. Pick a task from ready list

Working on a task:
  1. kspec task start @task  # Mark as in_progress
  2. kspec task note @task "Starting work on X..."
  3. Do the work (use todos for tracking sub-items)
  4. kspec task note @task "Completed X, approach was Y..."
  5. kspec task submit @task  # Code done, PR created (pending_review)
  6. kspec task complete @task --reason "Summary"  # After merge

Using todos during work:
  kspec task todo add @task "Review error handling"
  kspec task todo add @task "Add tests"
  kspec task todo done @task 1
  kspec task todos @task

Creating new tasks:
  kspec task add --title "Task name" --spec-ref @item --priority 2

Blocking/unblocking:
  kspec task block @task --reason "Waiting on X"
  kspec task unblock @task

Validating changes:
  kspec validate
`,
    seeAlso: ["session", "task", "tasks"],
  },

  "exit-codes": {
    title: "Exit Codes",
    concept: `
Kspec uses semantic exit codes for scripting and automation.

Exit Codes:
  0 - SUCCESS            Command completed successfully
  1 - ERROR              General error (unexpected error, file system error, etc.)
  2 - USAGE_ERROR        Usage error (invalid arguments, flags, or command syntax)
  3 - NOT_FOUND          Resource not found (task, spec item, inbox item, etc.)
  4 - VALIDATION_FAILED  Validation failed (invalid state, schema violation, business rule violation)
  5 - CONFLICT           Conflict (resource already exists, duplicate slug, etc.)

Commands Using Each Code:
  SUCCESS (0)             - All commands on success
  ERROR (1)               - All commands on unexpected errors
  USAGE_ERROR (2)         - All commands when given invalid arguments
  NOT_FOUND (3)           - task, item, inbox, derive, link, meta, tasks
  VALIDATION_FAILED (4)   - validate, task (state transitions), item (schema validation)
  CONFLICT (5)            - item, task, module (when creating duplicates)

Scripting Examples:
  # Check if task exists
  if kspec task get @my-task 2>/dev/null; then
    echo "Task exists"
  elif [ $? -eq 3 ]; then
    echo "Task not found"
  fi

  # Validate before proceeding
  if kspec validate; then
    echo "All valid"
  else
    code=$?
    [ $code -eq 4 ] && echo "Validation failed"
    [ $code -eq 1 ] && echo "General error"
  fi

  # Handle not found gracefully
  kspec task start @task || {
    code=$?
    [ $code -eq 3 ] && echo "Task not found"
    [ $code -eq 4 ] && echo "Invalid state transition"
    exit $code
  }
`,
    seeAlso: ["task", "validate", "item"],
  },
};
