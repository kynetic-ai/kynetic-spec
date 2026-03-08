# Completeness Warning Debt Reduction Plan

## Goal

Reduce `kspec validate --completeness` warning volume in a way that improves review signal, avoids low-value content churn, and leaves the validator stricter where the warnings are genuinely actionable.

This plan covers the four core debt classes called out in the spike:

1. Missing acceptance criteria
2. Missing descriptions
3. Missing own AC coverage
4. Missing trait AC coverage

`automation_eligible_no_spec` remains related but separate debt. It stays on its existing task track because it is primarily task/spec linkage policy, not spec-content authoring.

## Current Baseline

Snapshot captured on 2026-03-07 via `kspec validate --completeness --json --warnings-ok`.

| Warning family | Count | Notes |
| --- | ---: | --- |
| `missing_acceptance_criteria` | 149 | Concentrated in modules, structural schema items, state taxonomy items, and older foundational specs |
| `missing_description` | 7 | Small, direct cleanup wave |
| `missing_test_coverage` (`own_ac`) | 106 | Broad foundation/review debt; several items cluster around validation, references, schema, and status behavior |
| `missing_test_coverage` (`trait_ac`) | 6 | All six warnings come from `@trait-priority-parameter` applied to six command families |
| `automation_eligible_no_spec` | 144 | Parallel track owned by `@task-triage-automation-eligible-missing-spec-ref` |

Compared with the 2026-02-28 baseline captured in `@task-stabilize-kspec-validate-baseline`, the current state is:

| Warning family | 2026-02-28 | 2026-03-07 | Delta |
| --- | ---: | ---: | ---: |
| Missing acceptance criteria | 156 | 149 | -7 |
| Missing descriptions | 6 | 7 | +1 |
| Missing own AC coverage | 93 | 106 | +13 |
| Missing trait AC coverage | 7 | 6 | -1 |
| Automation without spec | 128 | 144 | +16 |

Implication: the backlog is not steadily burning down on its own. Without explicit wave gates, completeness debt will keep moving sideways.

## Plan Principles

1. Preserve validator signal over raw warning-count reduction.
2. Prefer fixing warning generators and policy mismatches before bulk-writing specs/tests.
3. Use families that can be batch-closed together as early waves.
4. Keep the output reviewable: each wave needs a hard entry/exit gate.
5. Treat structural containers differently from behavioral specs when the warning is not actually actionable.

## Rule Refinement Candidates

These are the places where the likely right answer is validator or taxonomy refinement, not mass content churn:

- Module items such as `@core`, `@schema`, and `@tasks` are organizational containers. Requiring standalone AC on every module likely adds noise more than signal.
- Taxonomy leaves such as state definitions (`@state-pending`, `@state-blocked`) and some structural schema leaves may be better represented by parent-spec AC rather than repeated leaf-level AC.
- The placeholder `@01KJN1WT` "Test Trait" should be removed, moved to isolated fixtures, or explicitly excluded from production completeness scans. It should not drive real backlog.
- `automation_eligible_no_spec` is a workflow-policy warning family, not spec-content debt. Keep it on the parallel task track instead of mixing it into these waves.
- The existing observation `@01KHYTNNFY` on behavioral-vs-testable ACs should be revisited before forcing the long tail of own-AC coverage to zero. Some workflow/agent-behavior ACs may need distinct treatment from code-testable ACs.

## Waves

### Wave 0: Classification and Baseline Freeze

Purpose: stop arguing about categories during execution.

Scope:

- Export the current completeness warning inventory and classify each warning family as:
  - content debt
  - rule-refinement candidate
  - fixture/test-data cleanup
  - parallel-track dependency
- Document which item classes are expected to carry their own AC and which are allowed to inherit meaning from parents.
- Confirm ownership boundaries with the existing automation-without-spec task.

Acceptance gate:

- Every current completeness warning family has an explicit disposition.
- No new completeness warning types are introduced during the wave.
- The project has a written decision on whether modules and state-taxonomy leaves should continue to require standalone AC.

Suggested deliverables:

- A classification note attached to this plan or a follow-up implementation task.
- A small validator-policy task if modules/state items are formally exempted.

### Wave 1: Close Low-Churn Hygiene Debt

Purpose: remove the smallest, clearest backlog first.

Scope:

- Resolve all 7 missing-description warnings.
- Remove or quarantine the `@01KJN1WT` placeholder test trait if it should not exist in production metadata.
- Opportunistically fix single-item missing-AC or missing-description warnings encountered in touched areas when the intended behavior is already obvious.

Acceptance gate:

- `missing_description` reaches 0.
- The placeholder test trait no longer appears in completeness output.
- No new missing-description warnings are introduced by the wave.

Why first:

- This is cheap, reviewable, and creates early momentum without making policy decisions irreversible.

### Wave 2: Eliminate Priority-Parameter Trait Coverage Debt

Purpose: close the one clearly batched trait-coverage family.

Current cluster:

- `@batch-exec`
- `@task-commands`
- `@derive-commands`
- `@inbox-commands`
- `@plan-support`
- `@meta-commands`

All six currently miss the same inherited AC set from `@trait-priority-parameter`.

Scope:

- Add or repair the test annotations needed for `@trait-priority-parameter` across the six command families.
- Add direct coverage for `@trait-priority-parameter` itself so the trait does not remain an own-AC warning after the inherited warnings are closed.
- If the annotation pattern or expected test location is unclear, settle that once and codify it in review guidance before backfilling all six families.

Acceptance gate:

- `missing_test_coverage` with subtype `trait_ac` reaches 0.
- `@trait-priority-parameter` no longer appears in own-AC coverage warnings.
- Local validation/review guidance reflects the annotation pattern used by the batch fix.

Why second:

- It is a bounded family with one root trait and six consumers, so the payoff-to-churn ratio is high.

### Wave 3: Burn Down Review-Critical Own-AC Coverage

Purpose: reduce the own-coverage backlog where it most directly improves review quality and validator trust.

Priority families:

- Validation and review specs such as `@validation`, `@validation-modes`, `@spec-completeness`
- Reference and identity specs such as `@reference-system`, `@ulid-system`, `@slug-system`, `@slug-uniqueness`, `@slug-resolution`
- Core schema/type behavior such as `@type-module`, `@type-feature`, `@type-requirement`, `@type-constraint`, `@type-decision`, `@type-task`
- Relationship/status behavior such as `@rel-depends-on`, `@rel-implements`, `@rel-relates-to`, `@rel-blocks`, `@status-cascade`

Scope:

- Add tests and `// AC:` annotations for the review-critical slice first.
- Use shared helpers and grouped tests where they already exist instead of creating one-off files per spec.
- Revisit the behavioral-vs-testable distinction before tackling any item whose AC is not naturally enforceable in code.

Acceptance gate:

- Review-critical specs in this slice have zero own-AC coverage gaps.
- Global own-AC warning count drops materially from 106, with the minimum target set at 50 or fewer before the wave is considered complete.
- Any remaining own-AC warnings are classified into either:
  - still-actionable backlog
  - pending rule refinement

Why third:

- This is the warning family that most directly affects `kspec-review`, local review quality, and confidence in validator-backed approval gates.

### Wave 4: Resolve Missing-AC Debt by Splitting Structural vs Behavioral Items

Purpose: handle the largest backlog without blindly generating AC on every item.

Observed pattern:

- Many of the 149 warnings are not random omissions; they cluster around modules, structural schema items, file-structure taxonomy, status/state taxonomy, and older high-level feature containers.

Scope:

- Decide which item categories must carry standalone AC.
- For approved behavioral categories, add real AC that describe observable behavior.
- For approved structural-container categories, refine the validator so it stops demanding low-value leaf/module AC.
- Remove or consolidate obsolete items when the better fix is cleanup rather than documentation.

Acceptance gate:

- Every remaining missing-AC warning belongs to an intentionally actionable category.
- Either:
  - `missing_acceptance_criteria` drops below 40, or
  - the remaining warnings are only for categories the project has explicitly decided to keep actionable.
- Any validator refinement is covered by regression tests so the count reduction is durable.

Why fourth:

- This is the highest-volume bucket, but a large part of it appears taxonomy-driven. Running it earlier would create the most content churn for the least clarity.

## Parallel Track

`automation_eligible_no_spec` should continue on `@task-triage-automation-eligible-missing-spec-ref`.

Coordination rule:

- Do not claim completeness debt reduction from that family inside these waves.
- Re-baseline counts after that task lands, because it currently contributes 144 warnings to the same report output and affects perceived validate noise.

## Recommended Execution Order

1. Wave 0 classification/policy decision
2. Wave 1 missing-description + fixture cleanup
3. Wave 2 `@trait-priority-parameter` closure
4. Wave 3 own-AC coverage for review-critical specs
5. Wave 4 missing-AC policy split and backfill

This order intentionally moves from low-churn/high-certainty work toward the policy-heavy structural backlog.

## Exit Condition for the Overall Initiative

The completeness warning backlog is considered under control when all of the following are true:

- Missing descriptions are at 0.
- Trait AC coverage warnings are at 0.
- Own AC coverage warnings are reduced to a small, classified remainder rather than a broad unknown backlog.
- Missing-AC warnings are limited to intentionally actionable categories, not modules/taxonomy containers the project has chosen not to model that way.
- Automation-without-spec warnings are tracked independently and no longer conflated with spec-content debt planning.

At that point, `kspec validate --completeness` becomes a tractable review signal again instead of a bulk debt dump.
