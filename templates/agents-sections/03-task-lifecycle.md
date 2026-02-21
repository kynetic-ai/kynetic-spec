## Task Lifecycle

### Key Concepts

Every item has a ULID (canonical) and slug (human-friendly). References use `@` prefix: `@task-slug` or `@01JHNKAB`.

**Spec items** (`.kspec/modules/*.yaml`): Define WHAT to build
**Tasks** (`.kspec/project.tasks.yaml`): Track the WORK of building

Tasks reference specs via `spec_ref`. They don't duplicate spec content.

### Task States

```
pending → in_progress → pending_review → completed
              ↓              ↓
          blocked ←──────────┘
              ↓          needs_work
          cancelled     (fix cycle: → in_progress → pending_review)
```

See `kspec help task` for transition commands and options.

### Spec-First Development

**Core principle**: If you're changing behavior and the spec doesn't cover it, update the spec first.

| Situation | Flow |
|-----------|------|
| Clear behavior change | Check spec → Update/create spec → Derive task |
| Vague idea, unclear scope | Capture in inbox → Triage later |
| Infra/internal (no user impact) | Create task directly, no spec needed |
| Bug revealing spec gap | Fix bug → Update spec to match reality |

### Creating Work

- **Clear scope?** → Create task directly
- **Unclear scope?** → `kspec inbox add "idea"` → triage later with `/triage`
- **Learning/friction?** → `kspec meta observe friction "..."` → review with `/reflect`

### Staying Aligned During Work

**Watch for scope expansion:**
- Modifying files outside your current task
- Adding functionality the spec doesn't mention
- "While I'm here, I should also..." thoughts

**When you notice something outside your task:** Capture it separately (inbox item, new task, or observation). Add a note to your current task documenting what you found. Don't fix it inline — even small detours compound into drift. Stay on your task.
