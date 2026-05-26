# Release Notes

The Release Notes section shows what changed in each version of kspec so you can see what is new in the version you have installed and review the history of prior releases.

The authoritative release notes live in `RELEASE_NOTES.md` at the repository root. You can read them in three ways:

- Run `kspec release-notes` to print notes for the installed version, or `kspec release-notes --from <version> --to <version>` for an inclusive range.
- Run `kspec upgrade` (or `kspec upgrade --dry-run`); the output appends release notes for every intervening version.
- Read [`RELEASE_NOTES.md`](https://github.com/lepahc/kynetic-spec/blob/main/RELEASE_NOTES.md) directly on GitHub.

## What's coming in the next release

The next release introduces folder-backed plan and review storage and entity-scoped local resources. Key changes:

- **`kynetic: "1.2"` manifest format** with `plan_storage.format: folder`, `review_storage.format: folder`, and `resource_storage.format: entity_scoped`. Existing projects must run `kspec upgrade` to migrate.
- **New CLI surfaces** — `kspec plan resource add/list/get/remove`, `kspec review resource add/list/get/remove`, `kspec plan rebuild-index`, `kspec review rebuild-index`, and `kspec plan derive --materialize-resources`.
- **New daemon API routes** for plan and review resources under `/api/plans/:ref/resources/...` and `/api/reviews/:ref/resources/...`.
- **`entity_storage_incompatible` error envelope** for HTTP 409 responses when the project is not on folder-backed storage.

See:

- [Local Resources for Plans and Reviews](../concepts/local-resources.md) — the folder layout and resource model
- [Working With Local Resources](../guides/working-with-local-resources.md) — the commands, API routes, and static export layout
- [Upgrading kspec to a New Version](../guides/upgrading-kspec.md) — the migration procedure and rollback reference
- [`entity_storage_incompatible` troubleshooting](../troubleshooting/entity-storage-incompatible.md) — recovery for unmigrated or partially-migrated projects
- [Plan or Review Index Has Drifted](../troubleshooting/plan-or-review-index-drift.md) — recovery when the lean index disagrees with the on-disk folders
