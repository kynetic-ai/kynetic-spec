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

The `kspec upgrade` command performs all project migration work in one step — task storage migration, skill re-rendering, agent instruction regeneration, gitignore repair, and release-note surfacing:

```bash
kspec upgrade
```

Review the output carefully. It lists each migration step, what changed, and any manual follow-ups. Preview what would happen without applying changes:

```bash
kspec upgrade --dry-run
```

For all upgrade options, run `kspec upgrade --help`.

### 5. Check project health

Run the health check to verify nothing broke:

```bash
kspec doctor
```

All checks should pass. If any fail, follow the suggested fixes in the output.

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
