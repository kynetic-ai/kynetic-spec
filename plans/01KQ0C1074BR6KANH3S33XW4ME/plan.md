# Seed Plan 4: CLI and Schema Spec Rewrite

Status: seed planning record / non-derivable  
Program charter: `cruft-cleanup-program-charter`  
Depends on: `spec-catalog-health-validation-trust`, `trait-normalization`  
Future derive-ready plan candidate slug: `cli-schema-spec-rewrite`

## Purpose

This seed covers specs that read like command help, implementation catalogs, or internal library choices instead of behavioral contracts.

The future plan should rewrite these specs so they describe observable CLI/schema/parser behavior and architectural invariants without over-prescribing implementation details.

## Known Problem Categories

### Command-help-shaped specs

Representative candidates:

- `@item-add`
- `@task-add`
- `@cmd-validate`
- `@cmd-init`
- `@cmd-setup`
- `@cmd-log`

Problem: descriptions and ACs often enumerate command syntax/options rather than behavior. CLI help/docs are the right home for syntax catalogs unless the option itself is a stable behavior contract.

### Implementation-heavy schema/parser specs

Representative candidates:

- `@alignment-index`
- `@trait-index`
- `@zod-schema`
- `@manifest-discovery`
- `@batch-write-buffer`

Problem: these specs name internal functions/classes/libraries or implementation mechanisms. Some may be legitimate architectural decisions, but they should be typed as decisions/constraints and framed as why/what, not how-to task steps.

### Query/status drift

Candidate specs from alignment audit:

- `@query-ready`
- `@query-next`
- `@query-filters`
- `@spec-task-set-batch`
- `@daemon-concurrent-reads`
- `@task-storage-separate`
- `@task-notes-file`
- `@session-prompt-action-schema`
- `@dispatch-hook-filter`

These may overlap with Plan 1/2 status work, but this plan should handle broader wording/ownership if needed.

## Future Plan Boundaries

Include:

- rewrite selected CLI specs from syntax catalogs to behavior contracts,
- rewrite selected schema/parser specs from implementation mechanisms to observable behavior or architectural decisions,
- update task/Covers references for renamed/split ACs,
- mark stale specs deprecated/superseded where replacement specs own behavior,
- ensure command docs/help remain accurate if spec text no longer carries option lists.

Exclude:

- broad trait design except use of already-normalized traits,
- API/daemon/web contract split,
- code refactors not necessary to match the rewritten specs,
- backfill/process spec retirement already covered by Plan 2.

## Candidate Specs for Future Plan

The future plan may create or update specs for:

- CLI command behavior categories: creation, mutation, deletion, validation, query, output formatting, error guidance.
- Schema validation behavior: accepted structure, invalid input rejection, error location/detail, defaults.
- Manifest discovery behavior: how projects are recognized from user-visible file placement and command location, not internal function names.
- Alignment behavior: how specs/tasks/ACs are mapped and reported, not internal index names.

## Candidate Tasks for Future Plan

- Identify a bounded batch of command specs to rewrite first.
- For each command spec, separate stable behavior from help text.
- Update or create docs/help tests if help text is the real source for option catalogs.
- Rewrite schema/parser specs with behavior-focused ACs.
- Retarget AC annotations and Covers lines after AC renames/splits.
- Run focused CLI/parser tests plus validation.

## Review Risks

- Reviewer may block if rewritten specs still name implementation mechanisms without being decision/constraint specs.
- Reviewer may block if tasks rely on “rewrite command specs” without enumerating exact refs and expected transformations.
- Reviewer may block if option syntax is removed from specs but not preserved in docs/help where needed.
- Reviewer may block if existing AC coverage is lost without replacement.

## Conversion Checklist

Before converting this seed:

1. Complete or account for trait normalization so inherited ACs are stable.
2. Choose a bounded batch; do not rewrite every CLI/schema spec in one plan if the list is too large.
3. Inspect current command help, tests, and spec text for each selected command.
4. Decide whether each implementation-heavy spec should become behavior, constraint, decision, task-only, or docs-only.
5. Build a precise Covers migration map for renamed/split ACs.
