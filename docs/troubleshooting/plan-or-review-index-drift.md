# Plan or Review Index Has Drifted From Folder Contents

You read a plan or review through the CLI, web UI, or daemon API and notice that the listing disagrees with what is on disk: a plan you remember creating is missing from `kspec plan list`, a review you deleted still shows up in `kspec review list`, or an attached resource is not appearing in `kspec plan resource list`. A `kspec plan rebuild-index` or `kspec review rebuild-index` command reports drift, missing folders, or stale entries.

## What This Means

After the upgrade to `kynetic: "1.2"`, the project-wide files `.kspec/project.plans.yaml` and `.kspec/project.reviews.yaml` are **lean indexes** — they store identity, lifecycle, summary fields, and bounded resource summaries, but they no longer hold the full plan markdown, review record, or resource bytes. The authoritative source for each plan is `.kspec/plans/<plan-ulid>/plan.md` and `plan.yaml`; for each review it is `.kspec/reviews/<review-ulid>/review.yaml`. The index is a derived projection of those folders.

Drift happens when the index disagrees with the folders. Common causes:

- A manual edit to `.kspec/project.plans.yaml` or `.kspec/project.reviews.yaml` outside the CLI
- A partial restore from backup that brought back an index without the matching folders, or vice versa
- A merge conflict on the shadow branch that was resolved by choosing one side without re-deriving the index
- An interrupted upgrade or an interrupted folder-storage migration

Drift is not data loss. The entity directories are authoritative. The index can always be rebuilt from them.

## How to Fix It

### 1. Check for drift

From the project root, run the rebuild-index command for whichever domain is drifting. Without flags, it validates and exits non-zero if drift exists, without writing anything:

```bash
kspec plan rebuild-index
kspec review rebuild-index
```

A clean project exits 0 with a "clean" summary. A drifted project exits 1 and reports what is different (folders without index entries, index entries without folders, or entries whose summary fields disagree with the folder contents).

For a richer preview without exit-code drama, pass `--dry-run`:

```bash
kspec plan rebuild-index --dry-run
kspec review rebuild-index --dry-run
```

### 2. Repair additive drift

When the drift is additive — folders exist but the index does not list them, or summary fields are stale — apply the rebuild:

```bash
kspec plan rebuild-index --repair
kspec review rebuild-index --repair
```

`--repair` rewrites `.kspec/project.plans.yaml` or `.kspec/project.reviews.yaml` from the on-disk folders. This is the safe direction because folders are authoritative.

### 3. Drop stale index entries

If the index lists entries whose folders are missing (for example, a folder was manually deleted), `--repair` alone treats those as conflicts and refuses to drop them. Pass `--force` once you have confirmed the folder deletion was intentional:

```bash
kspec plan rebuild-index --repair --force
kspec review rebuild-index --repair --force
```

`--force` is only valid with `--repair`. It permits dropping index entries whose entity folders are missing. Without `--force`, missing folders are treated as conflicts and no files are written.

### Exit Code Summary

| Exit code | Meaning                                                        |
| --------- | -------------------------------------------------------------- |
| 0         | Clean, or successful repair                                    |
| 1         | Drift detected and not repaired                                |
| 2         | Blocked by conflicts (e.g. missing folder without `--force`)   |

## When Resources Look Wrong

If `kspec plan resource list` (or the review equivalent) returns an empty list for an entity you know has resources, or returns a resource whose bytes do not match what you expect:

1. Confirm the resource file actually exists on disk: `ls .kspec/plans/<plan-ulid>/resources/` (or the review equivalent).
2. Inspect the manifest: `cat .kspec/plans/<plan-ulid>/resources.yaml`.
3. Run rebuild-index for that domain — the resource summary in the project index is derived from each plan's `resources.yaml`.

If a resource file exists but is not declared in `resources.yaml`, kspec treats it as an unknown file (preserved across writes, but not surfaced as a resource). Re-attach it via the CLI to register it:

```bash
kspec plan resource add @plan ./local-copy.png \
  --id login-shot \
  --path screenshots/login.png \
  --replace
```

`--replace` is required when the path is already present in the manifest (even if you are restoring it after an out-of-band edit).

## When Resource Hashes Drift

If a derived task's `TaskResourceRef` reports drift — the task's `sha256` no longer matches the plan resource's current `sha256` — this is intentional behavior, not a bug. Drift surfaces in task detail, agent context, and the API resource resolver so consumers know the underlying file changed after derivation.

Options for resolving drift:

- **The change is intentional.** Re-derive the task with the updated reference. From a plan with one or more affected tasks, `kspec plan derive @plan` records a fresh `TaskResourceRef` against the current hash.
- **The change is intentional but the task needs the old bytes.** Re-run derivation with `--materialize-resources` for the affected plan; the materialized copy lives under the task's own `resources/` tree and is no longer subject to plan-side drift.
- **The change was accidental.** Restore the plan resource from git history. The plan's `resources/` files are tracked on the shadow branch like every other piece of project state.

## Verification

After repairing, re-run the validation:

```bash
kspec plan rebuild-index
kspec review rebuild-index
```

Both should exit 0 with "clean" summaries. Then confirm the affected entities surface correctly:

```bash
kspec plan list
kspec review list
```

The lists should match what you expect on disk.

## Related

- [`entity_storage_incompatible`: project storage format mismatch](./entity-storage-incompatible.md) — when the project is not on folder-backed storage at all
- [Local Resources for Plans and Reviews](../concepts/local-resources.md) — the folder layout and resource model
- [Shadow Branch Worktree Is Broken or Missing](./shadow-branch-worktree-broken.md) — fix the worktree first if rebuild-index commands cannot read `.kspec/` at all
