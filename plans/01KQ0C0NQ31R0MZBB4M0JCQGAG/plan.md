# Seed Plan 2: Backfill and Process Spec Retirement

Status: seed planning record / non-derivable  
Program charter: `cruft-cleanup-program-charter`  
Depends on: `spec-catalog-health-validation-trust`  
Future derive-ready plan candidate slug: `backfill-process-spec-retirement`

## Purpose

This seed describes cleanup of spec items that encode one-time cleanup history, process goals, or task completion criteria instead of timeless system behavior.

The audit identified several specs whose purpose appears to be “add acceptance criteria” or “reduce completeness warnings.” Those are not behavioral contracts and should not remain active system specs unless rewritten around actual validation behavior.

## Primary Candidate Specs

High-confidence retirement/demotion candidates:

- `@core-ac-backfill`
- `@schema-ac-backfill`
- `@tasks-ac-backfill`
- `@cli-ac-backfill`
- `@meta-shadow-ac-backfill`
- `@shadow-ac-backfill`
- `@description-backfill`

Representative problem:

- `@core-ac-backfill` describes adding acceptance criteria to foundational spec items and reaching zero missing-AC warnings. That is completion history or validation debt tracking, not product behavior.

## Future Plan Goal

The real plan should make the spec catalog more timeless by retiring, demoting, or rewriting process-history specs while preserving any useful historical context in notes or documentation.

## Future Plan Boundaries

Include:

- inventory all `*-ac-backfill` and similar process/history specs,
- classify each as retire, demote to task/history, rewrite as validation behavior, or keep with justification,
- scrub references from tasks/depends_on/Covers/notes where needed,
- preserve important historical rationale in notes if deletion would lose useful context,
- validate that deletion/demotion does not create broken refs.

Exclude:

- broad trait normalization,
- general command spec rewrite,
- API/daemon/web mega-spec split,
- code-quality refactors except reference scrubbing required by retirement.

## Candidate Specs for Future Plan

Most work here may be metadata cleanup and direct tasks, not new specs.

Only add/rewrite specs if the plan changes ongoing behavior, such as:

- completeness validation reports process/history specs differently,
- deprecated/superseded spec lifecycle behavior becomes explicit,
- spec deletion/reference cleanup behavior is strengthened.

## Candidate Tasks for Future Plan

- Inventory all process/backfill specs and their references.
- For each candidate, decide keep/rewrite/deprecate/delete.
- Retire/demote selected specs using kspec CLI, not manual YAML edits.
- Scrub references from active tasks, dependency lists, and coverage lines.
- Add notes documenting why each retired spec was non-behavioral.
- Re-run reference/alignment/completeness validation.

## Review Risks

- Reviewer may block if deletion removes still-needed behavioral coverage.
- Reviewer may block if references are scrubbed mechanically but Implementation Notes/prose still mention deleted specs.
- Reviewer may block if the plan creates a replacement “cleanup behavior” spec that is really task done-criteria.

## Conversion Checklist

Before converting this seed:

1. Complete or intentionally defer Plan 1 so validation output is trustworthy.
2. Use `kspec search ac-backfill` and `kspec item list --grep backfill` to find all candidates.
3. For each candidate, run `kspec item status` and `kspec tasks list --grep <slug>`.
4. Decide whether the item is behavioral, historical, or a validation rule.
5. Check existing completed plan `Spec Reconciliation — Close Validate Completeness Gaps` for provenance.
