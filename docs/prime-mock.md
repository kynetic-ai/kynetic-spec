# kspec prime — Mock Output

# This is a design mockup of what `kspec prime` would output for an agent.

# Generated against real project state for kynetic-spec.

# ─── BEGIN PRIME OUTPUT ───

## Project: kynetic-spec

TypeScript monorepo — self-hosting specification and task management system.
573 spec items · 1300 tasks · Branch: `dev`

### Shadow Branch: ✓ Healthy

`.kspec/` is a git worktree on orphan branch `kspec-meta`. All kspec commands
auto-commit there. **Never edit `.kspec/` files manually.**

---

## Current Work

**Needs Work (2):**

- `@task-triage-automation-eligible-missing-spec-ref` [P2] — Triage automation-eligible tasks missing spec_ref
- `@task-plan-completeness-warning-debt-reduction` [P3] — Create phased plan for completeness warning debt reduction

**Ready Queue (2):**

- `@task-impl-push-path` [P1] [eligible] — Update dispatch push path for workspace-scoped integration targets
- `@task-impl-pull-path` [P1] [eligible] — Update dispatch pull/sync path for workspace-scoped integration targets

No tasks blocked · No tasks in review

---

## Operating Rules

1. **CLI only** — Use `kspec` commands for all spec/task operations. Never edit YAML in `.kspec/` directly.
2. **Spec before code** — If changing user-facing behavior, check spec coverage first. Update spec if missing.
3. **Leave notes** — `kspec task note @ref "what you did and why"`. Concise but informative.
4. **Stay on task** — If you notice something outside your current task, capture it (`kspec inbox add "..."`) and keep going.
5. **Don't block unnecessarily** — Block only for genuine external blockers (human decisions, missing APIs, formal dependencies). Complexity, failing tests, merge conflicts — those are your job.

### Commits

Use conventional format. Reference task in body.

```
feat: add retry logic for token refresh

Task: @task-impl-push-path
```

### Branching

For task work, use `kspec task branch @ref` to create the deterministic dispatch-compatible branch. Don't create branches under `dispatch/task/` manually.

### Testing

```bash
npm test                    # full suite (use this)
npm run test:shard1         # faster dev runs (~50s)
```

Never run `vitest` directly — always use `npm test`. Test runner caches by content hash.

**Pitfalls:**

- ULIDs use Crockford base32 (no I, L, O, U) — invalid ULIDs cause **silent** test failures. Use `testUlid()`.
- Never use `JSON.stringify()` for YAML output — use template strings or yaml library.
- `expect.anything()` does not match `undefined` in vitest.

---

## Discovering More

### Commands

```bash
kspec help                  # all commands
kspec help <command>        # detailed usage
kspec help task             # task lifecycle commands
kspec search <query>        # find specs/tasks by keyword
```

### Skills

Deep guidance for specific workflows. Load when you need them:

```bash
kspec skill get @<id>       # full skill content
kspec skill list            # all available skills
```

| Skill            | Use when...                                                  |
| ---------------- | ------------------------------------------------------------ |
| `@task-work`     | Working on tasks — start, implement, annotate ACs, submit    |
| `@review`        | Reviewing submitted work or responding to review feedback    |
| `@merge`         | Merging approved work to integration branch                  |
| `@writing-specs` | Creating or updating specs, modules, ACs, traits             |
| `@plan`          | Translating plans into specs and tasks                       |
| `@triage`        | Processing inbox items, observations, automation eligibility |
| `@observe`       | Capturing friction, patterns, ideas during work              |
| `@reflect`       | End-of-session reflection                                    |
| `@help`          | Unsure what command to use                                   |

### Project Skills

| Skill           | Use when...                   |
| --------------- | ----------------------------- |
| `@ui-design`    | Working on web UI components  |
| `@work-gates`   | Checking task readiness gates |
| `@review-gates` | Checking review/merge gates   |

---

## Dispatch Mode

If running as an automated dispatch agent (`KSPEC_SESSION_ID` is set):

- **Never** run `kspec serve stop/restart/start` — the daemon is your host process
- Use `kspec task branch @ref` before editing files
- Submit with `kspec task submit @ref` when done, then stop responding
- Priority: `needs_work` > `in_progress` > `pending` — always inherit existing work first
- Don't create GitHub PRs — dispatch uses kspec review records and local merge

# ─── END PRIME OUTPUT ───
