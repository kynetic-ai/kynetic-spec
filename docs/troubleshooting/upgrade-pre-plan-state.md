# Upgrade Reports a Pre-Plan State or Partial Scaffold

You run `kspec init` or `kspec setup` after upgrading kspec and see a message about pre-plan state, a partial scaffold, or missing configuration that should have been created during initialization.

## What This Means

kspec evolves across versions. Newer versions may expect configuration files, metadata fields, or directory structures that didn't exist in the version you originally initialized with. When kspec detects that your project's [shadow branch](../concepts/the-shadow-branch.md) state predates certain features, it reports the gap.

A "pre-plan state" message means your project was initialized before the plans feature was added. A "partial scaffold" message means some expected configuration files are present but others are missing — typically because an earlier initialization was interrupted or an upgrade introduced new required files.

This does not mean your existing data is corrupted. Your specs, tasks, and other state are intact. The system just needs the newer scaffolding to be applied.

## How to Fix It

Run the upgrade command, which brings your project from any previously-supported version up to the currently installed version:

```bash
kspec upgrade
```

This command runs a multi-step pipeline that migrates legacy task storage, backfills missing configuration files, re-renders skills and agent instructions, and records the new version. It is idempotent — running it again when already current is a no-op.

Preview what will change before applying:

```bash
kspec upgrade --dry-run
```

If `kspec upgrade` reports that the shadow branch itself needs initialization (for instance, when a project predates shadow branch support):

```bash
kspec init
kspec upgrade
```

Running `kspec init` on an already-initialized project detects the existing shadow branch and preserves it. It only creates what's missing. The subsequent `kspec upgrade` then applies any remaining version-specific migrations.

For cases where only specific scaffolding files are missing and you want to skip the full migration pipeline, `kspec setup --force` is a lower-level fallback that re-scaffolds project configuration, skills, and agent instructions without running task-storage migrations or recording a version baseline.

## Verification

After running the upgrade, confirm everything is in order:

```bash
kspec shadow status
kspec session start
```

A healthy outcome shows the shadow branch connected and healthy, and the session start command displays your project context without warnings about missing scaffolding. If the upgrade introduced new features (like plans or agent definitions), you should see them listed in the session output.
