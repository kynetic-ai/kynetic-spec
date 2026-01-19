# Kynetic Spec (kspec)

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
# See what tasks are ready to work on
kspec tasks ready

# Get task details
kspec task get @task-slug

# Task lifecycle
kspec task start @task-slug
kspec task note @task-slug "What you're doing..."
kspec task complete @task-slug --reason "Summary"

# Create a new task
kspec task add --title "My task" --priority 2 --slug my-task
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

## Task Management

### Task States

```
pending → in_progress → completed
                ↓
            blocked → (unblock) → in_progress
                ↓
            cancelled
```

### Commands

```bash
# List tasks
kspec tasks list                    # All tasks
kspec tasks list --status pending   # Filter by status
kspec tasks ready                   # Tasks ready to work on
kspec tasks next                    # Highest priority ready task
kspec tasks blocked                 # Blocked tasks
kspec tasks in-progress             # Active tasks

# Task operations
kspec task get <ref>                # View details
kspec task start <ref>              # Begin work
kspec task complete <ref>           # Mark done
kspec task block <ref> --reason "..." # Block with reason
kspec task unblock <ref>            # Remove block
kspec task cancel <ref>             # Cancel task

# Notes (work log)
kspec task note <ref> "message"     # Add note
kspec task notes <ref>              # View notes
```

### References

Tasks can be referenced by:
- **Full ULID**: `01KEYQSD2QJCNGRKSR38V0E3BM`
- **Short ULID**: `01KEYQSD` (unique prefix)
- **Slug**: `@my-task-slug`

## Task File Format

Tasks are stored in YAML files (`*.tasks.yaml`):

```yaml
- _ulid: 01KEYQSD2QJCNGRKSR38V0E3BM
  slugs: [my-task]
  title: My task title
  type: task          # task, epic, bug, spike, infra
  status: pending
  priority: 2         # 1 (highest) to 5 (lowest)
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
