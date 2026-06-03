---
name: shared-guidance-neutrality
description: Reviewer checklist for changes to package-shipped guidance
  surfaces. Enforces semantic project-neutrality and project-local preservation
  of removed Kynetic context.
---
<!-- kspec-managed -->
# Shared-Guidance Neutrality

Reviewer checklist for changes to package-shipped or shared guidance surfaces in this self-hosting repository. Enforces semantic project-neutrality and ensures any Kynetic-only instruction removed from shared text has a project-local home.

## When This Skill Applies

Apply this checklist whenever a task or plan changes any of these **shared/package guidance surfaces**:

- `templates/skills/` — package core skill sources
- `templates/skills/manifest.yaml` — package skill manifest
- `templates/agents-sections/` — static agent-instruction sections shipped with the package
- `plugin/plugins/kspec/skills/` — package plugin skill copies shipped to consumers
- Rendered package/core skill outputs under `.agents/skills/` when their source is a package core skill (the `kspec-` prefixed entries), NOT a project-local `.kspec/skills/` skill
- Rendered package/core skill outputs under `.factory/skills/` when they are generated from package core skill sources
- Generated `kspec-agents.md` sections that come from package templates (the `templates/agents-sections/` outputs)

It does NOT apply to project-local skills (`.kspec/skills/`), project meta conventions, `AGENTS.md`, or other project-local context — those surfaces are expected to carry Kynetic self-hosting policy.

## Why This Exists

This repository is self-hosting: it both ships the kspec package and uses kspec to manage its own work. Shared guidance surfaces are consumed by every kspec project, not just Kynetic. When Kynetic self-hosting policy leaks into shared text, every consumer is taught Kynetic's branch names, source paths, toolchain, and review policy as if they were universal kspec mechanics.

This neutrality is a **semantic property of prose**. String scanners can be evaded by paraphrasing and produce false positives on legitimate uses (e.g., kspec docs naturally mention `kspec` commands). Reviewer judgment is the durable enforcement mechanism; this skill encodes the judgment criteria.

## The Semantic Review Rule

Package-shipped guidance describes **universal kspec mechanics only**.

The following classes of instruction belong in **project-local context** (`AGENTS.md`, project-local `.kspec/skills/`, or project meta conventions), not in shared/package guidance:

| Class | Belongs in shared guidance? | Examples (must NOT appear as universal in shared text) |
|---|---|---|
| Branch policy | No | `main`, `dev`, "rebase onto `dev`", "PR against `main`" |
| External review policy | No | "open a GitHub PR", `gh pr create`, `PR #...` references |
| Repo/source paths | No (when describing consumer workflow) | `templates/skills/`, `src/parser/validate.ts`, `packages/web-ui/` presented as places the consumer must edit |
| Toolchain/quality gates | No | `npm test`, `npm run lint`, `npm run typecheck`, oxlint, Vitest specifics |
| Generated-artifact maintenance rules | No (consumer doesn't generate package artifacts) | "regenerate `kspec-agents.md` after editing `templates/skills/`", `.factory/skills/` refresh rules |
| Dispatch workflow choices | No (when policy not mechanism) | "do NOT create GitHub PRs for dispatched work" as universal |
| Fixed agent ids | No | hard-coded `task-worker`, `pr-reviewer`, `kynetic.meta.yaml` references presented as guaranteed |
| Runtime-specific tool names | No (when not universally available) | `AskUserQuestion` and other adapter-specific tool names |
| Concrete workflow/trait refs | No (unless universally seeded) | refs like `@trait-foo` presented as guaranteed when `kspec setup` doesn't seed them for every consumer |

Universal kspec **mechanics** (always allowed in shared text):

- Commands a consumer always has after `kspec init`: `kspec task submit`, `kspec review get`, `kspec validate`, `kspec agent dispatch status`, etc.
- The lifecycle and review-record model itself
- AC annotation syntax and trait coverage semantics
- Spec/task/plan/inbox concepts and CLI mechanics
- Shadow branch behavior as a kspec feature
- Generic project guidance that points to project config, project meta, or dynamic data sections instead of hard-coding values

## Reviewer Checklist

When a change touches any shared/package guidance surface, review **both directions** below. A change that passes one direction but fails the other is still a request_changes.

### Direction 1 — Shared text must not hard-code Kynetic-only policy as universal

For every edited line or new line in shared guidance:

- [ ] Branch names (`main`, `dev`, etc.) are not presented as required defaults. If a branch is named, it is framed as an example controlled by project configuration, or replaced with "the project's integration branch" / "the project-defined target branch".
- [ ] External review process (GitHub PRs, `gh` commands, `PR #...`) is not presented as universal kspec policy. Dispatched-work review is described via kspec review records and the supported merge helper; external PR policy is acknowledged as project/human policy when mentioned at all.
- [ ] Repository paths used as **package-maintainer** instructions (e.g., "edit `templates/skills/<id>/SKILL.md`") do not appear in **consumer-facing** workflow text. Consumer text should direct the reader to project-local sources (`.kspec/skills/`) or the matching `kspec` command.
- [ ] Quality gates are described as "the project-defined format/lint/type/test gates" or pointed at project context, not hard-coded to `npm`, oxlint, Vitest, or sharded test scripts.
- [ ] Generated-artifact maintenance instructions (regenerate plugin copies, refresh `.factory/skills/`, regenerate `kspec-agents.md` after template edits) appear only when the audience is the package maintainer, and are framed accordingly — not as universal kspec consumer workflow.
- [ ] Agent ids (`task-worker`, `pr-reviewer`, etc.) and meta filenames (`kynetic.meta.yaml`) are not presented as guaranteed. Use "configured worker/reviewer agents" or point readers to `kspec agent list`.
- [ ] Runtime-specific tool names (e.g., `AskUserQuestion`) are not presented as universal. If used, frame as one possible adapter or rewrite to generic kspec mechanics.
- [ ] Concrete workflow refs or trait refs in shared text are guaranteed by `kspec init` / `kspec setup` for every consumer. If not, the reference is replaced with "if this workflow exists in your project" or a discovery command (`kspec item list --type trait`).

### Direction 2 — Removed Kynetic-only instructions still have a project-local home

For every Kynetic-only instruction removed from or weakened in shared text:

- [ ] The instruction is preserved in `AGENTS.md`, a project-local `.kspec/skills/` skill attached to the relevant Kynetic agents, or a project meta convention — whichever is the right durable home.
- [ ] The local home is reachable by future Kynetic worker/reviewer agents without chat history (e.g., attached as a skill to the appropriate agent, or part of the always-rendered project context).
- [ ] If the instruction was a procedural checklist too large for `AGENTS.md`, a project-local skill exists and is registered through `kspec meta` / `kspec skill` commands.
- [ ] Generated artifacts are regenerated (`kspec skill render`, `kspec agents generate`) if local context or shared sources changed in the same task.

## Examples of Kynetic-Only Material

Use these as concrete anchors when judging neutrality. They are illustrative, not exhaustive — apply the rule semantically, not as a string match.

- Universal-sounding text that says "before committing, run `npm run format:check`, `npm run lint -- --quiet`, `npm run typecheck`" — Kynetic toolchain; describe as "the project-defined quality gates" in shared text and keep the concrete commands in `AGENTS.md` or `$work-gates`.
- Universal-sounding text that says "rebase onto `dev`" or "open a PR against `main`" — Kynetic branch/review policy; describe as "the project-defined integration branch" / "the project's review process" in shared text.
- Universal-sounding text that says "edit `templates/skills/<name>/SKILL.md` to change a skill" — Kynetic package-maintainer instruction; consumers should be directed to project-local skill sources and the supported `kspec skill` commands.
- Universal-sounding text that names `task-worker`, `pr-reviewer`, or `kynetic.meta.yaml` — Kynetic-specific identifiers; describe as "the configured worker/reviewer agents" and point at `kspec agent list`.
- Universal-sounding text that uses `AskUserQuestion`, `gh pr create`, or `PR #1234` — runtime-specific or external-system-specific; rewrite to neutral kspec mechanics.
- Universal-sounding text that references `@workflow-...` or `@trait-...` refs that are not seeded by every `kspec setup` — replace with discovery commands or "if this workflow/trait exists in your project".

## Why Prose-Neutrality Tests Are Insufficient

Do not accept "the markdown scanner passes" as evidence of neutrality, and do not request that the worker add such a scanner unless the work was specifically scoped to add one. Reasons:

- Wording changes frequently; string lists rot.
- Semantically equivalent leaks can evade a denylist (e.g., "the typical integration branch" still implies a Kynetic-shaped default).
- False positives on legitimate kspec mechanics produce churn and erode trust.
- Mechanical render/install/update tests cover **artifact consistency**, not prose neutrality. They are still required for that purpose; they are not a substitute for semantic review.

Apply this skill semantically. If a future hardening plan introduces a narrow lint for obvious forbidden tokens, that is supplementary, not a replacement for reviewer judgment.

## Verdict Guidance

Apply existing severity classes from `$review-gates`:

- **MUST-FIX** — shared text hard-codes Kynetic-only policy as universal, OR a Kynetic-only instruction was removed without a project-local home. Either failure breaks the contract this skill protects.
- **SHOULD-FIX** — wording is neutral but a discovery command, dynamic-data pointer, or local-home pointer would make the guidance noticeably clearer for consumers or future Kynetic agents.
- **SUGGESTION** — pure style/phrasing improvement with no neutrality implication.

When a change is mixed (some neutral edits, some leaks), submit `request_changes` and identify each direction-1 / direction-2 finding in its own thread so the worker can address them in one pass.

## Evidence Log Addition

For changes touching shared/package guidance surfaces, the review evidence log (required by `$review-gates`) must additionally record:

- Which shared/package surfaces were touched.
- Which direction-1 / direction-2 checks were applied.
- Where any preserved Kynetic-only instruction now lives (file or meta ref).
- Confirmation that generated artifacts (`kspec skill render`, `kspec agents generate`) were refreshed if local or shared sources changed.
