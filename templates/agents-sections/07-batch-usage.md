## Batch Usage

Use `kspec batch` for 2+ sequential write operations — one atomic shadow branch commit instead of N.

### JSON Format

Pipe a JSON array of command objects:

```json
[
  { "command": "task set", "args": { "ref": "@task-slug", "automation": "eligible" } },
  {
    "command": "task note",
    "args": { "ref": "@task-slug", "message": "Assessed and marked eligible" }
  },
  { "command": "inbox add", "args": { "text": "New idea to triage", "tag": ["mvp", "cli"] } }
]
```

Each object has:

- `command` — command path without `kspec` (e.g. `"task add"`, `"item ac add"`)
- `args` — object mapping parameter names to values
- `id` — optional correlation label for error messages

### Argument Rules

| Type                     | Key format                    | Example                                       |
| ------------------------ | ----------------------------- | --------------------------------------------- |
| Positional (`<ref>`)     | Parameter name from signature | `"ref": "@task-slug"`                         |
| Option (`--spec-ref`)    | camelCase or kebab, no `--`   | `"specRef": "@spec"` or `"spec-ref": "@spec"` |
| Boolean flag (`--force`) | Flag name, no `--`            | `"force": true`                               |
| Repeatable (`--tag`)     | Same key with array value     | `"tag": ["cli", "bug"]`                       |

Boolean `true` emits the flag; `false` omits it. Arrays repeat the flag: `--tag cli --tag bug`.

### Invocation

```bash
echo '[...]' | kspec batch              # stdin (default)
kspec batch --file commands.json        # from file
kspec batch --commands '[...]'          # inline JSON
kspec batch --dry-run                   # validate without executing
kspec batch --continue                  # don't stop on first error
```

### Discovering Commands

```bash
kspec batch commands                    # list all allowed commands
kspec batch commands "task set"         # single command schema
kspec batch commands "task set" --json  # structured output for programmatic use
```

Quote multi-word command paths: `"task set"`, `"item ac add"`, `"meta observe"`.
