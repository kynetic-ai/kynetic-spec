# Installation

This page covers installing kspec and verifying that it works.

## Prerequisites

- **Node.js 20 or later** — kspec requires Node.js 20+. Check your version with `node --version`.
- **Git** — kspec uses Git for its shadow branch. Any recent version works.
- A **Git repository** — you need an initialized repo to run `kspec init`. If you don't have one yet, `git init` in an empty directory is enough to get started.

## Install from npm

Install kspec globally so the `kspec` command is available everywhere:

```bash
npm install -g @kynetic-ai/spec
```

## Verify the installation

Run the version command to confirm kspec is installed:

```bash
kspec --version
```

You should see a semantic version number. If you see a "command not found" error, make sure npm's global executable directory is on your PATH. Start by checking the configured global prefix:

```bash
npm config get prefix
```

On Unix-like systems, global executables are normally in the `bin/` subdirectory of that prefix. npm's global executable location is platform-dependent, so use npm's installation guidance if your platform lays it out differently.

## Verify the help output

Run the top-level help to see all available commands:

```bash
kspec --help
```

You should see a list of commands including `init`, `setup`, `task`, `item`, and others. This confirms the CLI is correctly installed and runnable.

---

**Next:** [Initializing a Project](./initializing-a-project.md)
