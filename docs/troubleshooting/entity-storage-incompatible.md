# `entity_storage_incompatible`: Project Storage Format Mismatch

You run a plan, review, or resource command — for example `kspec plan resource add`, `kspec review get`, or any daemon route under `/api/plans/:ref/resources` — and the operation fails with an `entity_storage_incompatible` error. The CLI prints a code like `legacy_plan_storage_removed` or `missing_review_folder_storage`; the daemon returns an HTTP 409 with a body containing `"error": "entity_storage_incompatible"`.

## What This Means

Starting with `kynetic: "1.2"`, plans and reviews are stored as folder-backed entities and supporting files live in entity-scoped local resources. Commands and daemon routes that need this format check the project manifest and on-disk layout before reading or writing. When the project is not on folder-backed storage, the operation stops with a deterministic, recoverable error instead of guessing how to interpret an ambiguous layout.

The top-level `entity_storage_incompatible` discriminator is shared across plan, review, and resource domains. The `code` field tells you exactly which boundary failed:

| Code                            | Meaning                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy_plan_storage_removed`   | Project manifest is below `kynetic: "1.2"` and stores plans in the legacy `.kspec/project.plans.yaml` monolithic file.                                     |
| `legacy_review_storage_removed` | Project manifest is below `kynetic: "1.2"` and stores reviews in the legacy `.kspec/project.reviews.yaml` monolithic file.                                 |
| `missing_plan_folder_storage`   | Manifest is `1.2`+ but `plan_storage.format` is not `folder`.                                                                                              |
| `missing_review_folder_storage` | Manifest is `1.2`+ but `review_storage.format` is not `folder`.                                                                                            |
| `partial_entity_storage_layout` | Manifest declares folder-backed storage but the on-disk layout is partial — for example, monolithic records still exist beside the declared folder layout. |

The daemon response body includes the same fields plus a `suggestion` ("Run `kspec upgrade` to migrate the project, or use a kspec version compatible with the current manifest if upgrade is not desired"), a `domain` (`plans`, `reviews`, or `resources`), and a `cache_domain` (the cache key that was attempted), so client code can surface targeted recovery guidance.

This does not mean your data is corrupted. The error is the gate that prevents kspec from silently reading or rewriting ambiguous storage. Your plans, reviews, and resources are intact in their existing format.

## How to Fix It

### Migrate the project to `kynetic: "1.2"`

If you are ready to move to folder-backed storage, run the upgrade:

```bash
kspec upgrade --dry-run
```

The dry run reports every step — including the manifest fields that will be set, the directories that will be created, and the previous shadow commit you can use as a rollback ref — without writing anything. Review the output, then apply:

```bash
kspec upgrade
```

After a successful upgrade, the failing command should work. See [Upgrading kspec to a New Version](../guides/upgrading-kspec.md) for the full upgrade flow, including rollback instructions.

### Stay on a compatible kspec version

If you are not ready to migrate — for example, you depend on another tool that reads the monolithic `.kspec/project.plans.yaml` file directly — pin to a kspec version that does not require folder-backed plan, review, or resource storage. Check your installed version with `kspec --version` and consult the [release notes](../release-notes/index.md) for the version that introduced the gate; install the prior major or minor as a stopgap until you can plan the migration.

### Fix a `partial_entity_storage_layout`

`partial_entity_storage_layout` means the manifest declares folder-backed storage but the on-disk layout disagrees. This usually happens when an upgrade was interrupted mid-migration, when a partial restore from a backup re-introduced monolithic files alongside the new folders, or when someone manually edited `.kspec/` state.

1. Run `kspec shadow status` to confirm the worktree itself is healthy. If it is broken, fix that first with [Shadow Branch Worktree Is Broken or Missing](./shadow-branch-worktree-broken.md).
2. From the project root, inspect the layout:

   ```bash
   ls .kspec/project.plans.yaml .kspec/project.reviews.yaml 2>/dev/null
   ls -d .kspec/plans .kspec/reviews 2>/dev/null
   ```

3. If both monolithic files and folder directories exist, the safe recovery is to roll back to the pre-upgrade commit, then re-run `kspec upgrade`. Find the previous shadow commit in your last upgrade output (or in the shadow branch git log), then:

   ```bash
   cd .kspec
   git reset --hard <previous-shadow-commit>
   cd ..
   kspec upgrade
   ```

4. If no clean rollback ref is available, contact your team's kspec owner before manually deleting files in `.kspec/`. The shadow branch's git history is the authoritative record — manual cleanup that bypasses it can lose data.

## Verification

After running `kspec upgrade`, confirm the manifest and folder layout match:

```bash
kspec --version
kspec doctor
```

Re-run the command that originally failed. The error should be gone.

If the error persists after a successful upgrade, run the original command with verbose output to capture the exact `code` and `domain` reported, and check that your project root really is the directory you expect — every kspec command must run from the project root, never from inside `.kspec/`.
