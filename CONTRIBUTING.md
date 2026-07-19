# Contributing to kspec

Thanks for your interest in contributing. This guide covers the human developer workflow for working on kspec itself. If you're installing kspec into your own project, see [INSTALL.md](INSTALL.md) instead.

## Prerequisites

- **Node.js** 20 or later (the `engines` field in [package.json](package.json) is the source of truth)
- **npm**
- **Bun** (optional) — only needed to run the daemon on the Bun runtime or to build the standalone daemon binary (`build:compile` in `packages/daemon`). The default build uses esbuild and runs on Node.

## First-Time Setup

```bash
git clone https://github.com/lepahc/kynetic-spec.git
cd kynetic-spec
node scripts/bootstrap.cjs
```

The bootstrap script detects current state and runs install, build, link, and init only as needed.

## Build

```bash
npm run build
```

## Tests

```bash
npm test                  # Full suite (always run before submitting)
npm run test:shard1       # Faster local runs (also shard2, shard3)
npm run test:e2e          # Playwright end-to-end tests (run separately)
```

## Lint and Format

Linting uses [oxlint](https://oxc.rs/docs/guide/usage/linter) and formatting uses oxfmt:

```bash
npm run lint              # Lint src/, tests/, packages/
npm run format            # Format in place
npm run format:check      # Verify formatting (CI gate)
npm run typecheck         # TypeScript type check
```

## Branches and Commits

- Branch names use a type prefix and kebab-case: `feat/user-auth`, `fix/login-crash`, `refactor/parser-cleanup`, `docs/install-guide`.
- Commits follow the [Conventional Commits](https://www.conventionalcommits.org/) format: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Keep the subject line under 72 characters.
- Never commit directly to `main`.

## Workspace Versioning

Only the root package, `@kynetic-ai/spec`, is published to npm. The workspace packages under `packages/` — `web-ui`, `shared`, and `daemon` — are internal build inputs; their `0.1.0` versions are not release-managed and do not change with releases.

## AI Agent Workflows

This repository is self-hosted on kspec, and much of its process documentation is written for AI agents. Agent-specific policy (task lifecycle, shadow branch, dispatch, review records) lives in [AGENTS.md](AGENTS.md) — it is not duplicated here.

## Security Issues

Please do not open public issues for security vulnerabilities — see [SECURITY.md](SECURITY.md) for the private reporting process.
