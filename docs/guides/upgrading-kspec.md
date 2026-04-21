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

Upgrade via npm:

```bash
npm install -g @kynetic-ai/spec@latest
```

Verify the upgrade:

```bash
kspec --version
```

The version should match the latest release.

### 4. Regenerate agent instructions

New versions may include updated skills, conventions, or workflow templates. Regenerate your agent instructions:

```bash
kspec setup
```

This updates `kspec-agents.md`, `AGENTS.md`, and the rendered skill files in `.agents/skills/`. Your agent will read the updated instructions on its next session.

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

If `kspec setup` regenerated instruction files, commit them:

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
