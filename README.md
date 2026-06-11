# kspec

`kspec` is spec-first task management for AI-assisted development.

It gives you a durable spec tree, linked implementation tasks, and a shadow-branch workflow that keeps project planning state out of your main git history. The result is a tighter loop between "what should exist", "what is being worked on", and "what shipped".

> Early-stage software: expect rough edges and command/API changes while the workflow stabilizes.

## Install

```bash
npm install -g @kynetic-ai/spec
```

See [Installation](docs/getting-started/installation.md) for prerequisites and verification steps.

## First steps

```bash
kspec init            # create project manifest + shadow worktree
kspec setup           # configure agent environment
kspec session start   # view active work and project context
```

The [Getting Started](docs/getting-started/index.md) walkthrough covers the full path from install to your first completed task.

## Documentation

- [Getting Started](docs/getting-started/index.md) — install, initialize, and complete the spec-first loop
- [Concepts](docs/concepts/index.md) — mental models for how kspec works
- [Guides](docs/guides/index.md) — step-by-step procedures for common workflows
- [Troubleshooting](docs/troubleshooting/index.md) — solutions for common issues
- [INSTALL.md](INSTALL.md) — detailed installation and setup modes
- [CONTRIBUTING.md](CONTRIBUTING.md) — developer setup, build, tests, and contribution conventions
