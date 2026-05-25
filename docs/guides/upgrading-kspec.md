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
