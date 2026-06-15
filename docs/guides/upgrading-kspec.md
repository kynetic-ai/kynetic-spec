# Upgrading kspec to a New Version

This guide walks you through upgrading kspec to a new version safely. By the end, your project will be running the latest version with updated agent instructions and a verified shadow branch.

## Prerequisites

- An existing kspec project (initialized with `kspec init`)
- Node.js 20+ and npm installed

## Steps

### 1. Check your current version

Before upgrading, note your current version:

```bash
kspec --version
```

### 2. Read the release notes

Check what changed in the new version:

```bash
kspec release-notes
```

Or view the release notes in the docs if you have the web UI running. Look for breaking changes, new commands, or deprecations that might affect your project.

### 3. Install the new version

Install the new package version via npm:

```bash
npm install -g @kynetic-ai/spec@latest
```

Verify the package updated:

```bash
kspec --version
```

### 4. Run the upgrade

The `kspec upgrade` command performs all project migration work in one step — task storage migration, plan and review folder-backed storage migration (1.2+), skill re-rendering, agent instruction regeneration, gitignore repair, and release-note surfacing:

```bash
kspec upgrade
```

Review the output carefully. It lists each migration step, what changed, and any manual follow-ups. Preview what would happen without applying changes:

```bash
kspec upgrade --dry-run
```

`--dry-run` reports every step that would run, the previous shadow commit (so you have a rollback reference before any writes happen), and any warnings — without writing to the shadow branch. Run it first on any project where you want to know exactly what the upgrade will do before committing to it.

For all upgrade options, run `kspec upgrade --help`.

#### What `kynetic: "1.2"` Changes

Version 1.2 moves plans and reviews from monolithic project-wide files into folder-backed entities and introduces entity-scoped local resources. After a successful upgrade, your project's `kynetic.yaml` (or `project.kynetic.yaml`) declares:

```yaml
kynetic: "1.2"
task_storage:
  format: split
plan_storage:
  format: folder
review_storage:
  format: folder
resource_storage:
  format: entity_scoped
```

On disk, plans live in `.kspec/plans/<plan-ulid>/` with `plan.md`, `plan.yaml`, optional `notes.yaml`, `resources.yaml`, and `resources/`. Reviews live in `.kspec/reviews/<review-ulid>/` with a cohesive `review.yaml`, `resources.yaml`, and `resources/`. The project-wide `.kspec/project.plans.yaml` and `.kspec/project.reviews.yaml` files remain as lean indexes that no longer inline full markdown, notes, review threads, or resource file bytes.

See [Local Resources for Plans and Reviews](../concepts/local-resources.md) for the full layout, schema, and resource model.

#### Rolling Back If Something Goes Wrong

The upgrade output reports the previous shadow commit — the commit on the shadow branch immediately before the upgrade's first write. Look for a line like:

```
Shadow HEAD (pre-upgrade rollback ref): a1b2c3d
```

That short SHA is your rollback target. If you need to undo the upgrade, reset the shadow branch back to that commit from your project root:

```bash
cd .kspec
git reset --hard <previous-shadow-commit>
cd ..
kspec shadow status
```

`kspec shadow status` should report a healthy worktree on the pre-upgrade commit. Verify your plan and review data is intact, then either retry the upgrade (after addressing whatever motivated the rollback) or pin to the previous kspec version.

The pre-upgrade commit is the rollback ref by design — kspec does not create parallel backup files, because the shadow branch's git history is the backup.

#### Historical Actor Normalization

The upgrade also normalizes historical **actor fields** — the author, reviewer, resolver, and addition-source values recorded across your project's records (review authors and verdict reviewers, thread/reply authors, thread `resolved_by`, task note authors, task todo `added_by`, task `assignee`, inbox `added_by`, triage `decided_by`/`override_by`, meta observation `author`/`resolved_by`, workflow-run `initiated_by`, spec/module `created_by`, and spec/plan note authors).

Over a project's life the same person or agent often ends up recorded many different ways (`codex`, `codex@openai.com`, `@codex`, `codex-reviewer`, …). Identity-derived views — "mine", "awaiting you", ownership filtering — only work if those variants resolve to one canonical identity. This step rewrites recognizable variants once, using the same identity vocabulary as the `GET /api/identity` surface: your configured human author (and any aliases) plus the canonical agent roster.

The migration is driven by an **exhaustive actor-field inventory** and fails closed: if a future schema adds an actor-bearing field that is not classified in the inventory, the step refuses to run rather than silently skipping it.

**1. Preview with a dry run.** Always preview first:

```bash
kspec upgrade --dry-run
```

The `Historical actor normalization` step reports every rewrite it _would_ perform as `original → canonical/default`, with the record reference, record kind, field path, and resolution source (`variant_map`, `operator_mapping`, or `default`). With `--json`, the full rewrite list is on `steps[].details.rewrites` and the originals that no rule resolved are on `steps[].details.unresolved_originals`. The preview runs even on a project whose storage layout the same upgrade still has to migrate, so you can review the rewrites before committing to any writes.

If a record kind's storage cannot be read until that migration runs (for example, legacy task storage that the current backend no longer reads), the preview **defers** that kind rather than skipping the whole step: deferred kinds are listed on `steps[].details.deferred_kinds` and called out in the step message. The real upgrade promotes their storage first and then normalizes them, so re-running `--dry-run` after a real upgrade — or inspecting the post-run report — shows the complete set.

**2. Review the unresolved originals.** Any value the built-in variant map cannot recognize is reported under `unresolved_originals` and, in a real run, is rewritten to the **declared default actor** for its record kind (`@unknown` unless your project declares otherwise). Inspect that list: anything in it that is actually a known person or agent should be mapped explicitly so it resolves to a canonical identity instead of the default.

**3. Prepare an operator mapping file (optional).** For ambiguous historical values the variant map cannot resolve, provide a mapping file (YAML or JSON). It is applied _after_ the built-in variant map and _before_ the default fallback:

```yaml
# actor-map.yaml
mappings:
  Hermes: codex # historical free-form value → canonical identity
  "old-handle": Jacob Chapel
# Optional: override the default actor for a specific record kind.
defaults:
  review: "@unknown"
```

Map each value to a **canonical** identity (a configured human author id or a canonical agent id from your roster). Recognizable aliases are accepted and normalized to their canonical id (e.g. `@codex` → `codex`). A target that is neither a recognizable canonical identity nor a declared default actor (e.g. `@unknown`) is **rejected before any record is modified** — the upgrade fails closed with the offending entries listed, so a typo cannot persist a non-canonical actor string or break idempotency. To deliberately route a value to the default, either omit it (it falls to the declared default) or map it explicitly to the default sentinel.

**4. Let an agent assist — without inventing identities.** When triaging a long `unresolved_originals` list, an agent can help by proposing mappings, but it must only map a value to an identity that **already exists** in your configured human author or agent roster (run `kspec agent list` and check your configured human author). If a value cannot be matched to an existing identity with confidence, leave it unmapped so it falls to the declared default — do **not** invent a new identity to "resolve" it. The default actor exists precisely so genuinely unknown history is preserved distinctly rather than mis-attributed.

**5. Run the real migration.** Once the dry-run preview looks right:

```bash
kspec upgrade --actor-map actor-map.yaml
```

(Omit `--actor-map` if you have no operator mappings.) Every rewrite goes through the standard mutation machinery, so the change set is recorded as a shadow-branch commit.

**6. Inspect the report.** A real run that changes anything writes a durable report artifact under `.kspec/upgrade-reports/actor-normalization-<timestamp>.json` (the path is printed in the step output and on `steps[].details.report_path`). The report lists every rewrite with its resolution source and every unresolved original, for audit.

**7. Re-run safely.** The step is **idempotent**: canonical identities and the declared default are fixed points, so running the upgrade again changes nothing and writes no new report. If validation fails after a run, you can safely re-run `kspec upgrade` (optionally with an updated `--actor-map`) — already-canonical values are left untouched and only newly resolvable values change. To undo entirely, use the pre-upgrade shadow rollback ref described above.

### 5. Check project health

Run the health check to verify nothing broke:

```bash
kspec doctor
```

All checks should pass. If any fail, follow the suggested fixes in the output. Common upgrade-time failures and their recovery procedures are documented in [Troubleshooting](../troubleshooting/index.md) — in particular [`entity_storage_incompatible`: project storage format mismatch](../troubleshooting/entity-storage-incompatible.md) when a plan, review, or resource command reports the project is not on folder-backed storage.

### 6. Verify shadow branch integrity

Confirm the shadow branch is healthy:

```bash
kspec shadow status
```

If the status shows issues, repair the worktree:

```bash
kspec shadow repair
```

For all shadow branch commands, run `kspec shadow --help`.

### 7. Commit updated files

If the upgrade regenerated instruction files, commit them:

```bash
git add AGENTS.md kspec-agents.md .agents/
git commit -m "chore: regenerate agent instructions for kspec $(kspec --version)"
```

## Verification

Run the following to confirm the upgrade is complete:

```bash
kspec --version
kspec doctor
```

The version should show the new release and all health checks should pass. Start a new session to confirm everything works:

```bash
kspec session start
```

The session output should show your project context without errors.
