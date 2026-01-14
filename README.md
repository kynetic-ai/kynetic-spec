# Kynetic Spec - Bootstrap Parser

A minimal TypeScript parser and CLI for the Kynetic Spec format. This is bootstrap code that will be used to track its own development.

## Installation

```bash
npm install
```

## Usage

Run with `npx tsx` (no build required):

```bash
# Using npm script
npm run dev -- <command>

# Direct
npx tsx src/cli/index.ts <command>
```

Or build and use globally:

```bash
npm run build
npm link
kspec <command>
```

## Commands

### List all tasks

```bash
kspec tasks list
kspec tasks list --status pending
kspec tasks list --type bug
kspec tasks list --verbose
```

### Show ready tasks

Shows tasks that are pending, have all dependencies met, and are not blocked:

```bash
kspec tasks ready
kspec tasks ready --verbose
```

### Get next task

Show highest priority ready task:

```bash
kspec tasks next
```

### Show blocked/active tasks

```bash
kspec tasks blocked
kspec tasks in-progress
```

### Get task details

```bash
kspec task get <ref>
kspec task get @my-task-slug
kspec task get 01KEYQSD
```

### Create a task

```bash
kspec task add --title "My new task"
kspec task add --title "Fix bug" --type bug --priority 1
kspec task add --title "Feature" --spec-ref "@feature-id" --slug my-feature
```

### Task lifecycle

```bash
# Start working on a task
kspec task start <ref>

# Complete a task
kspec task complete <ref>
kspec task complete <ref> --reason "Implemented in commit abc123"

# Block a task
kspec task block <ref> --reason "Waiting on API design"

# Unblock a task
kspec task unblock <ref>

# Cancel a task
kspec task cancel <ref> --reason "No longer needed"
```

### Notes (work log)

```bash
# Add a note
kspec task note <ref> "Found an issue with the middleware"
kspec task note <ref> "Correction" --supersedes 01NOTE123

# View notes
kspec task notes <ref>
```

## JSON Output

Add `--json` flag for machine-readable output:

```bash
kspec --json tasks ready
kspec --json task get @my-task
```

## Task File Format

Tasks are stored in YAML format. The CLI looks for:
- `tasks.yaml` in the project root
- `*.tasks.yaml` files in the project
- Files in `tasks/` directory

Example task:

```yaml
- _ulid: 01KEYQSD2QJCNGRKSR38V0E3BM
  slugs: [my-task]
  title: My task title
  type: task
  spec_ref: "@feature-id"
  status: pending
  blocked_by: []
  depends_on: ["@other-task"]
  context: []
  priority: 2
  tags: [mvp]
  vcs_refs:
    - ref: feature-branch
      type: branch
  created_at: "2025-01-14T09:00:00Z"
  notes: []
  todos: []
```

## Testing

```bash
npm test
npm run test:watch
```

## Project Structure

```
src/
  schema/           # Zod schemas
    common.ts       # Common types (ULID, slugs, refs)
    spec.ts         # Spec item schemas
    task.ts         # Task schemas
  parser/           # YAML parsing utilities
    yaml.ts         # Read/write YAML, task operations
  cli/              # CLI implementation
    index.ts        # Main entry point
    output.ts       # Output formatting
    commands/       # Command implementations
      tasks.ts      # kspec tasks <action>
      task.ts       # kspec task <action>
tests/              # Vitest tests
```

## Design Decisions

1. **Library-first**: Core parsing logic is separate from CLI for reuse
2. **Zod for schemas**: TypeScript-native validation with JSON Schema export
3. **YAML format**: Human-readable, git-friendly, supports comments
4. **ULID identifiers**: Time-sortable, globally unique, shortenable
5. **Slug aliases**: Human-friendly names that map to ULIDs
6. **Minimal MVP**: Focus on task management for self-hosting

## Dependencies

- `zod` - Schema validation
- `js-yaml` - YAML parsing
- `ulid` - ULID generation
- `commander` - CLI framework
- `chalk` - Terminal colors

## License

MIT
