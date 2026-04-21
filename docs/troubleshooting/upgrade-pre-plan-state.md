# Upgrade Reports a Pre-Plan State or Partial Scaffold

You run `kspec init` or `kspec setup` after upgrading kspec and see a message about pre-plan state, a partial scaffold, or missing configuration that should have been created during initialization.

## What This Means

kspec evolves across versions. Newer versions may expect configuration files, metadata fields, or directory structures that didn't exist in the version you originally initialized with. When kspec detects that your project's [shadow branch](../concepts/the-shadow-branch.md) state predates certain features, it reports the gap.

A "pre-plan state" message means your project was initialized before the plans feature was added. A "partial scaffold" message means some expected configuration files are present but others are missing — typically because an earlier initialization was interrupted or an upgrade introduced new required files.

This does not mean your existing data is corrupted. Your specs, tasks, and other state are intact. The system just needs the newer scaffolding to be applied.

## How to Fix It

Run the setup command, which brings your project configuration up to date with the installed version:

```bash
kspec setup
```

This command is idempotent — it creates missing configuration without overwriting your existing data. It ensures all expected metadata files, agent definitions, and directory structures are in place.

If `kspec setup` reports that it cannot complete because the shadow branch needs initialization:

```bash
kspec init
kspec setup
```

Running `kspec init` on an already-initialized project detects the existing shadow branch and preserves it. It only creates what's missing.

## Verification

After running setup, confirm everything is in order:

```bash
kspec shadow status
kspec session start
```

A healthy outcome shows the shadow branch connected and healthy, and the session start command displays your project context without warnings about missing scaffolding. If the upgrade introduced new features (like plans or agent definitions), you should see them listed in the session output.
