# Kynetic Spec (kspec)

> **Warning: Experimental Software**
>
> This project is a work-in-progress and is not ready for production use. APIs, file formats, and CLI commands may change without notice. Use at your own risk.
>
> If you're interested in the project, feel free to explore the code and design docs, but please don't depend on it for real work yet.

A structured specification and task management system designed for AI-assisted development. kspec provides a YAML-based format for defining project specifications that can be programmatically manipulated, with a task system to track implementation progress.

**Key feature**: kspec is self-hosting - it tracks its own development using itself.

## Installation

### Quick Start (Development)

```bash
# Clone and install
git clone <repo-url>
cd kynetic-spec
npm install

# Run with npm (recommended - works from any project directory)
npm run dev -- <command>
```

### Build and Link Globally

```bash
npm run build
npm link

# Now available as 'kspec' globally
kspec tasks ready
```

## Basic Usage

```bash
# Initialize a new project
kspec init

# See what tasks are ready to work on
kspec tasks ready

# Task lifecycle
kspec task start @task-slug
kspec task note @task-slug "What you're doing..."
kspec task submit @task-slug          # Code done, PR created
kspec task complete @task-slug --reason "Summary"

# Capture ideas
kspec inbox add "idea or random thought"

# Validate spec files
kspec validate

# Search across everything
kspec search "pattern"
```

## Agent Integration

kspec is agent-agnostic but designed to work well with AI coding assistants. The key integration point is **author attribution** for notes.

### Quick Setup

Run the setup command to auto-configure your agent environment:

```bash
kspec setup           # Auto-detect and configure
kspec setup --dry-run # Preview what would be done
```

The setup command detects which agent you're running in and installs the appropriate configuration.

**Supported agents:**
- Claude Code (`CLAUDE_PROJECT_DIR`)
- Cline (`CLINE_ACTIVE`)
- Gemini CLI (`GEMINI_CLI`)
- Codex CLI (`CODEX_SANDBOX`)
- Aider (`AIDER_MODEL`)
- OpenCode (`OPENCODE_CONFIG_DIR`)
- Amp (`AMP_API_KEY`)
- GitHub Copilot CLI

### How Author Detection Works

When adding notes, kspec auto-detects the author using this fallback chain:

1. `KSPEC_AUTHOR` environment variable (explicit config)
2. `git config user.name` (developer identity)
3. `USER`/`USERNAME` env var (system user)

### Manual Setup

If auto-setup doesn't work, configure manually:

**Claude Code** - Add to `~/.claude/settings.json`:
```json
{
  "env": {
    "KSPEC_AUTHOR": "@claude"
  }
}
```

**Aider** - Add to `~/.aider.conf.yml`:
```yaml
env:
  KSPEC_AUTHOR: "@aider"
```

**Other agents** - Set in shell profile:
```bash
export KSPEC_AUTHOR="@agent-name"
```

Convention: Use `@` prefix for agent authors (e.g., `@claude`, `@copilot`) to distinguish from human authors.

## References

All items (tasks, spec items, inbox, plans) can be referenced by:
- **Full ULID**: `01KEYQSD2QJCNGRKSR38V0E3BM`
- **Short ULID**: `01KEYQSD` (unique prefix)
- **Slug**: `@my-task-slug`

## Task Management

### Task States

```
pending → in_progress → pending_review → completed
              ↓              ↓
          blocked ←──────────┘
              ↓
          cancelled
```

**State transitions:**
- `kspec task start` → `in_progress`
- `kspec task submit` → `pending_review` (code done, awaiting merge)
- `kspec task complete` → `completed` (from in_progress, pending, or pending_review)
- `kspec task complete --force` → `completed` (force from any state)
- `kspec task block` → `blocked`
- `kspec task unblock` → `pending`
- `kspec task cancel` → `cancelled`

### Commands

```bash
# List tasks
kspec tasks list                    # All tasks
kspec tasks list --status pending   # Filter by status
kspec tasks list --tag mvp          # Filter by tag
kspec tasks list --count            # Count only
kspec tasks ready                   # Tasks ready to work on
kspec tasks next                    # Highest priority ready task
kspec tasks blocked                 # Blocked tasks
kspec tasks in-progress             # Active tasks

# Task operations
kspec task get <ref>                # View details
kspec task start <ref>              # Begin work
kspec task submit <ref>             # Submit for review
kspec task complete <ref>           # Mark done
kspec task complete --force <ref>   # Force complete from any state
kspec task block <ref> --reason "..." # Block with reason
kspec task unblock <ref>            # Remove block
kspec task cancel <ref>             # Cancel task
kspec task reset <ref>              # Reset to pending
kspec task delete <ref>             # Delete permanently

# Notes and todos
kspec task note <ref> "message"     # Add note
kspec task notes <ref>              # View notes
kspec task todo add <ref> "text"    # Add a todo item
kspec task todos <ref>              # View todos

# Create tasks
kspec task add --title "My task" --priority 2 --slug my-task
kspec task add --title "Bug fix" --type bug --spec-ref @feature --tag urgent

# Update tasks
kspec task set <ref> --priority 1 --tag critical
kspec task set <ref> --depends-on @other-task
```

## Spec Item Management

Spec items define WHAT to build — features, requirements, constraints.

```bash
# List and browse
kspec item list                        # All items
kspec item list --type feature         # Filter by type
kspec item list --tree                 # Hierarchical view
kspec item list --count                # Count only
kspec item types                       # Item types and counts
kspec item tags                        # Tags and counts

# View details
kspec item get <ref>                   # Item details
kspec item status <ref>                # Implementation status + linked tasks

# Create items
kspec item add --title "My Feature" --type feature --slug my-feature
kspec item add --under @parent --title "Sub-feature" --type requirement
kspec item add --title "Auditable" --type constraint --trait @trait-ref

# Update items
kspec item set <ref> --title "New Title" --priority 1
kspec item set <ref> --relates-to @other-item    # Add relationship
kspec item set <ref> --implements @parent-item    # Add implements link
kspec item set <ref> --depends-on @dependency     # Add dependency
kspec item set <ref> --clear-relates-to           # Clear relationships

# Notes
kspec item note <ref> "Design rationale..."
kspec item notes <ref>

# Acceptance criteria
kspec item ac list <ref>
kspec item ac add <ref> --given "user is logged in" --when "they click logout" --then "session ends"
kspec item ac set <ref> ac-1 --then "updated expectation"
kspec item ac remove <ref> ac-1

# Traits
kspec item trait add <ref> @trait-a @trait-b
kspec item trait remove <ref> @trait-a

# Derive implementation task from spec
kspec derive <ref>                     # Create task from spec item
kspec derive --all --dry-run           # Preview tasks for all unlinked specs
```

## Inbox

Low-friction capture for ideas that aren't yet tasks.

```bash
kspec inbox add "idea or random thought"         # Capture
kspec inbox add "tagged idea" --tag dx --tag cli  # With tags
kspec inbox list                                  # Show items (oldest first)
kspec inbox list --newest --limit 5               # Recent items
kspec inbox list --tag dx                         # Filter by tag
kspec inbox list --count                          # Count only
kspec inbox get <ref>                             # View details

# Edit items
kspec inbox set <ref> --content "updated text"    # Update content
kspec inbox set <ref> --tag new-tag               # Add tags
kspec inbox set <ref> --clear-tags                # Remove all tags
kspec inbox note <ref> "additional context"       # Append a note

# Convert to task
kspec inbox promote <ref> --title "Task title"
kspec inbox promote <ref> --title "Task" --priority 2 --note "Context from triage"

# Remove
kspec inbox delete <ref>
```

## Plans

Plans capture implementation context and rationale. They can auto-generate specs and tasks from structured markdown.

```bash
# Create plans
kspec plan add --title "Feature Name" --content "Description..."
kspec plan add --title "Feature Name" --content-file ./plan.md

# Import structured plan (auto-creates specs and tasks)
kspec plan import ./plan.md --module @target-module --dry-run   # Preview
kspec plan import ./plan.md --module @target-module             # Execute
kspec plan import ./plan.md --module @target-module --update    # Re-import

# Manage plans
kspec plan list                          # List all plans
kspec plan get <ref>                     # View details
kspec plan set <ref> --status active     # Update status
kspec plan note <ref> "Progress..."      # Add note
kspec plan derive <ref>                  # Create task from plan
```

## Validation

Validate spec files for schema conformance, reference integrity, and alignment.

```bash
kspec validate                    # Full validation
kspec validate --schema           # Schema conformance only
kspec validate --refs             # Reference resolution only
kspec validate --alignment        # Spec-task alignment
kspec validate --completeness     # Spec completeness
kspec validate --orphans          # Orphaned items
kspec validate --strict           # Treat warnings as errors
kspec validate --fix              # Auto-fix (invalid ULIDs, missing timestamps)
kspec validate -v                 # Verbose output
```

**Exit codes:** `0` = success, `4` = validation errors, `6` = warnings only.

## Session Log

View and search historical session data.

```bash
kspec session log list                     # List sessions with stats
kspec session log list --since 7d          # Recent sessions
kspec session log list --agent ralph       # Filter by agent type
kspec session log show <session-id>        # Detailed session view
kspec session log show <id> --events       # Include events
kspec session log stats                    # Aggregate analytics
kspec session log stats --by-day           # Daily breakdown
kspec session log stats --tool-usage       # Tool usage stats
kspec session log search "pattern"         # Search across events
```

## Search and Export

```bash
# Search across items, tasks, inbox, and meta
kspec search "pattern"
kspec search "auth" --tasks-only
kspec search "feature" --items-only --limit 10

# Git history by spec/task
kspec log @task-ref                  # Commits related to a ref
kspec log --spec @spec-ref           # Search by spec trailer
kspec log --since "2 weeks ago"      # Filter by date

# Export
kspec export                         # JSON export
kspec export --format html -o out.html
```

## Batch Execution

Execute multiple commands atomically or with per-command commits.

```bash
# Atomic (default) — single commit, rollback on failure
echo '[{"command":"task note","args":{"ref":"@task","message":"update"}}]' | kspec batch
kspec batch --file commands.json

# Immediate mode — per-command commits
kspec batch --no-atomic --file commands.json

# Continue on error, dry run
kspec batch --continue --file commands.json
kspec batch --dry-run --file commands.json

# Discover available batch commands
kspec batch commands
```

Each command: `{"command": "cli path", "args": {...}, "id": "optional"}`. Only mutating commands allowed. Typos in command names produce did-you-mean suggestions.

## Shadow Branch

kspec stores spec/task state on a separate orphan branch (`kspec-meta`) via a git worktree at `.kspec/`. This keeps spec changes out of your main branch history.

```bash
kspec init                    # Initialize project (creates shadow branch)
kspec shadow status           # Check shadow branch health
kspec shadow sync             # Sync with remote
kspec shadow repair           # Fix broken worktree
kspec shadow log              # Recent shadow commits
```

## Utility Commands

```bash
kspec util ulid               # Generate a valid ULID
kspec util ulid --count 5     # Generate multiple ULIDs
kspec help                    # Extended help
kspec help --all              # Full command reference
kspec help --exit-codes       # Exit code documentation
kspec help <cmd> --json-schema  # JSON Schema for a command
```

## Task File Format

Tasks are stored in YAML files (`*.tasks.yaml`):

```yaml
- _ulid: 01KEYQSD2QJCNGRKSR38V0E3BM
  slugs: [my-task]
  title: My task title
  type: task          # task, epic, bug, spike, infra
  status: pending     # pending, in_progress, pending_review, completed, blocked, cancelled
  priority: 2         # 1 (highest) to 5 (lowest)
  spec_ref: "@feature-slug"
  depends_on: ["@other-task"]
  tags: [mvp]
  notes:
    - _ulid: 01KEYRJ953HRYWJ0W4XEG6J9FB
      created_at: "2026-01-14T17:00:00Z"
      author: "@claude"
      content: |
        Started implementing feature X...
```

## JSON Output

Add `--json` flag for machine-readable output:

```bash
kspec --json tasks ready
kspec --json task get @my-task
```

## Project Structure

```
kynetic-spec/
├── .kspec/                    # kspec's own spec (shadow branch worktree)
│   ├── kynetic.yaml          # Root manifest
│   ├── project.tasks.yaml    # Active tasks
│   ├── project.inbox.yaml    # Inbox items
│   └── modules/              # Spec items by domain
├── src/                       # TypeScript implementation
│   ├── schema/               # Zod schemas
│   ├── parser/               # YAML loading
│   └── cli/                  # Command handlers
└── tests/                     # Vitest tests
```

## Development

```bash
# Run tests
npm test
npm run test:watch

# Type check
npm run build

# Run CLI in dev mode
npm run dev -- tasks ready
```

### Troubleshooting: ESM + npm link

When using `npm link` to develop kspec globally, ESM module detection can break without proper symlink resolution. This manifests as the CLI executing twice or commands not working correctly.

**Symptoms:**
- Commands execute twice
- CLI seems to hang or behave unexpectedly
- "Cannot find module" errors when using `npm link`

**Why it happens:**
- `npm link` creates symlinks for global CLI binaries
- Node.js ESM uses `import.meta.url` to detect if a module is the main entry point
- Without symlink resolution, `import.meta.url` doesn't match the symlinked path
- This causes the module to be imported but not executed, or executed multiple times

**The fix:**
kspec uses `fs.realpathSync()` to resolve symlinks before comparing paths:

```javascript
// src/cli/index.ts
const scriptPath = realpathSync(process.argv[1]);
if (import.meta.url === `file://${scriptPath}`) {
  program.parse();
}
```

This ensures the CLI works correctly whether run via:
- `npm run dev` (direct TypeScript execution)
- `npm link` (symlinked global binary)
- `node dist/cli/index.js` (built code)

**For contributors:** If you encounter similar issues in ESM CLIs, remember to resolve symlinks before path comparisons. The pattern is:
1. Import `realpathSync` from `fs`
2. Resolve `process.argv[1]` before comparing with `import.meta.url`
3. This makes the CLI work correctly in all installation modes

## Design Decisions

- **Library-first**: Core parsing logic is separate from CLI for reuse
- **Zod schemas**: TypeScript-native validation
- **YAML format**: Human-readable, git-friendly, supports comments
- **ULID identifiers**: Time-sortable, globally unique, shortenable
- **Slug aliases**: Human-friendly names that map to ULIDs

## License

MIT
