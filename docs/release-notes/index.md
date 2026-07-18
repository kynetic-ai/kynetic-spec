# Release Notes

The Release Notes section shows what changed in each version of kspec so you can see what is new in the version you have installed and review the history of prior releases.

The authoritative release notes live in `RELEASE_NOTES.md` at the repository root. You can read them in four ways:

- [Changelog](./changelog.md) — the docs build renders the repository's `RELEASE_NOTES.md` directly and creates an anchor for each version heading.
- Run `kspec release-notes` to print notes for the installed version, or `kspec release-notes --from <version> --to <version>` for an inclusive range.
- Run `kspec upgrade` (or `kspec upgrade --dry-run`); the output appends release notes for every intervening version.
- Read [`RELEASE_NOTES.md`](https://github.com/lepahc/kynetic-spec/blob/main/RELEASE_NOTES.md) directly on GitHub.
