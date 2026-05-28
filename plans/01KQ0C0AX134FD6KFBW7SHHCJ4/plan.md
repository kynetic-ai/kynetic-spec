# Spec Cruft Cleanup Program Charter

Status: planning artifact / non-derivable program charter  
Created: 2026-04-24  
Source audit: `plans/cruft-audit-2026-04-24.md`  
Intended kspec plan slug: `cruft-cleanup-program-charter`

## Critical Usage Note

This document is a **program charter**, not an implementation plan. It is intentionally not written in the normal `## Specs` / `## Tasks` import format and must not be derived. It exists to preserve the full cleanup context and to seed a sequence of real implementation plans.

Downstream plans must be converted into normal kspec plans only when they are ready to go through the standard review loop:

1. write behavioral specs and standalone tasks,
2. parse/validate the plan document,
3. import as draft,
4. run `kspec agent run plan-reviewer`,
5. iterate until approved,
6. approve and derive.

The charter itself should remain a durable coordination/index record.

## Why This Program Exists

A broad read-only audit of `kynetic-spec` found that the project has accumulated cruft across three layers:

1. **Spec quality:** some specs violate the behavioral-only / direct-and-verifiable requirement, encode process history instead of timeless behavior, or bake implementation mechanisms into acceptance criteria.
2. **Spec-code alignment:** specs, tasks, tests, and implementation have drifted. Some code implements behavior without clear spec ownership; some specs are stale, oversized, or misleadingly marked.
3. **Code quality:** several implementation areas make spec verification fragile, especially validation, daemon mutation/cache behavior, Web UI data freshness, API client shape, and test coverage integrity.

The cleanup is too large and too interdependent for one derive-ready plan. The right structure is a **stacked cleanup program**: first restore trust in validation/traceability, then retire non-behavioral cruft, then normalize traits, then rewrite groups of specs and code against a cleaner foundation.

## Audit Inputs and Current Evidence

Primary audit summary:

- `plans/cruft-audit-2026-04-24.md`

Raw audit artifacts produced by project-native agents and local scans:

- `/tmp/kspec-cruft-spec-quality.out`
- `/tmp/kspec-cruft-spec-code-alignment.out`
- `/tmp/kspec-cruft-code-quality.out`
- `/tmp/kspec-cruft-local-scan.md`
- `/tmp/kspec-cruft-ac-annotation-scan.md`
- `/tmp/kspec-cruft-size-scan.md`

Validation commands last run while creating this charter:

- `kspec validate --refs --warnings-ok` exited `4`.
- `kspec validate --alignment` exited `6`.
- `kspec validate --completeness` exited `6`.

Verified validation state from the audit:

- Reference validation fails with 4 unresolved task spec refs:
  - `@cmd-derive`
  - `@session-remove-shadow-commits`
  - `@session-branch-worktree` twice
- Alignment validation reports 36 warnings:
  - 34 orphaned specs
  - 2 status mismatches
- Completeness validation reports 491 warnings:
  - 1 spec missing acceptance criteria: `@01KJN1WT` / `Test Trait`
  - 235 missing own-AC coverage warnings
  - 255 invalid AC annotations

These numbers are program inputs, not acceptance criteria for this charter. Each downstream implementation plan must re-run current validation and update its own scope with the then-current facts before review.

## Program-Level Principles

Every downstream plan must follow these principles.

### Specs are behavioral and timeless

Specs describe what the system promises to users, operators, agents, or API consumers. They do not exist to record implementation tasks, backfill campaigns, file structure chores, or one-time cleanup history.

### Direct and verifiable means one observable claim per AC

Each acceptance criterion should be testable or reviewable as a specific behavior or architectural invariant. Avoid broad “and” chains, vague adjectives, or unbounded promises.

### Do not use plan prose as a substitute for specs

Implementation Notes can explain audit origin, dependencies, and rationale. They must not define behavior that the Specs section does not own.

### Do not create fake specs for planning work

Planning and coordination tasks are valid task records, but they usually should not have behavioral specs. If a downstream plan is only about planning another plan, prefer a direct task or a non-derivable plan record.

### Existing audit facts are context, not source of truth

Downstream plans must be self-contained. They may use this charter and the audit as input, but specs/tasks must not require future agents to have this Discord thread or the original audit in memory.

### Derive only review-approved implementation plans

Seed plan records are not implementation plans. Convert them into normal `## Specs` / `## Tasks` documents only when the scope is ready for plan-reviewer.

## Program Dependency Graph

The cleanup should proceed in this order unless a future audit shows a stronger dependency:

1. **Spec Catalog Health and Validation Trust**
2. **Backfill and Process Spec Retirement**
3. **Trait Normalization**
4. **CLI and Schema Spec Rewrite**
5. **API, Daemon, and Web UI Contract Split**
6. **Spec-Tied Code Quality Refactors**

Rationale:

- Plans 2-6 rely on validation output and AC annotation data being meaningful.
- Trait normalization should happen before broad spec rewriting because inherited ACs can make otherwise good specs wrong.
- API/daemon/web contract splitting should happen after the general trait and CLI/schema cleanup so it can reuse narrower cross-cutting contracts.
- Code-quality refactors should be tied to cleaned specs where behavior changes are involved, rather than pursued as broad unanchored refactors.

## Seed Plan Records

This charter should be paired with these non-derivable seed records:

1. `cruft-01-spec-catalog-health-seed`
2. `cruft-02-backfill-process-retirement-seed`
3. `cruft-03-trait-normalization-seed`
4. `cruft-04-cli-schema-spec-rewrite-seed`
5. `cruft-05-api-daemon-web-contract-split-seed`
6. `cruft-06-code-quality-refactors-seed`

Each seed record should preserve enough findings, candidates, risks, and conversion guidance for a future agent to write the real derive-ready plan without relying on chat history.

## Downstream Plan Review Prompt Template

When a seeded plan is converted into a real draft implementation plan, review it with a prompt shaped like this:

```text
Review the draft plan @plan-slug following the review-plan and writing-specs skills.

BACKGROUND CONTEXT for your understanding only — the plan must stand on its own and MUST NOT be rewritten to reference this context as required reading:

- This plan is part of the Spec Cruft Cleanup Program Charter @cruft-cleanup-program-charter.
- Primary audit file: /home/chapel/Projects/kynetic-spec/plans/cruft-audit-2026-04-24.md
- Seed planning record: @seed-plan-ref

Review objectives:
1. Spec quality: behavioral, timeless, direct/verifiable, no compound thens, no infrastructure/process specs.
2. Task standalone executability: what/why/how/testing/covers, no assumptions from audit/chat context.
3. Coverage: every new or changed AC has explicit task coverage or a stated reason it is metadata-only cleanup.
4. Dependency ordering: acyclic and respects validation/trait/spec/code dependencies.
5. Data-model support: tasks can actually implement what specs promise.
6. Gap coverage: plan addresses the specific seed findings and does not silently drop blockers.
7. Non-goals: plan does not expand into later cleanup slices.
```

## Existing Plan/Task Collision Risks

Before deriving any downstream plan, check for overlap with existing active/draft/approved plans and pending tasks. Known potentially related plan records from `kspec plan list` include:

- `Completeness Warning Debt Reduction` (`01KK5RDB`, approved)
- `Dispatch Mutation Service` (`01KN53HW`, draft)
- `Reviewer Workflow and Workflow UX Hardening` (`01KN6K9B`, draft)
- `Dispatch Trivial-Drift Auto-Repair (Research)` (`01KNV518`, draft)
- `User Documentation Foundation` (`01KPF81M`, active)
- `Portable Skill File References and Detached Reviewer Merge Foundation` (`01KPT7BW`, active)

Known pending/needs-work tasks from the audit session that may overlap with downstream planning:

- `task-plan-completeness-warning-debt-reduction` / `Create phased plan for completeness warning debt reduction`
- `task-triage-automation-eligible-missing-spec-ref`
- tasks related to `@ralph-replacement`
- tasks related to test stabilization and CLI timeout failures

Do not create duplicate actionable work. If a downstream real plan supersedes an existing pending task, retire or retarget the task before derivation and document the reason.

## Common Pitfalls to Avoid

- Do not put “clean up the specs” as a spec. That is a task/program objective, not behavior.
- Do not weaken specs merely to match stale code; decide whether the code or spec is wrong.
- Do not strengthen tasks to satisfy vague specs without first making the spec direct and verifiable.
- Do not apply broad traits because the name sounds close. Read every inherited AC and compare it to the target spec.
- Do not leave old specs implemented when a replacement spec supersedes them.
- Do not treat skipped tests as satisfying AC coverage.
- Do not use AC annotations that point to missing specs, missing AC IDs, tasks, agents, or examples.
- Do not make one downstream plan own too many unrelated modules.

## Program Completion Definition

The cleanup program is complete when:

1. `kspec validate --refs --warnings-ok` has no hard reference failures.
2. `kspec validate --alignment` warnings are either resolved or intentionally documented.
3. `kspec validate --completeness` warnings are reduced to intentional exceptions, with invalid AC annotations eliminated or explicitly handled.
4. Backfill/process specs have been retired, demoted, or rewritten into real behavior specs.
5. Shared traits are narrow enough that inheriting a trait means every inherited AC applies.
6. CLI/schema specs no longer read like command help or implementation catalogs.
7. API/daemon/web UI contracts are split into reviewable behavior-level specs aligned with code/tests.
8. Code-quality refactors that affect behavior are tied to cleaned specs and verified with targeted tests.
