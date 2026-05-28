# Dispatch Merge Helper Target Lock Hardening

## Summary

Dispatch became degraded because the manual-merge reviewer helper requires the integration target branch to already be checked out in some worktree. Reviewers/agents satisfy that recovery hint by checking out the plan integration branch in a `.kspec-worktrees/...` worktree. That leaves the same branch checked out outside the dispatch root, so `resolveDispatchIntegrationMutationScope()` correctly refuses periodic target push/sync from the root checkout.

The fix is to remove the helper's dependency on persistent integration-target checkouts, make auxiliary worktrees release any integration-target branch lock before returning, and ensure target degraded state re-evaluates after the lock is freed.

## Specs

```yaml
[]
```

## Tasks

derive_from_specs: false

```yaml
- title: Align merge-helper and integration-target specs around branch-lock ownership
  slug: task-align-merge-helper-branch-lock-specs
  priority: 1
  tags: [spec-update, dispatch, merge-helper, worktree]
  spec_ref: "@detached-reviewer-merge-helper"
  description: |
    What:
    - Update the existing @detached-reviewer-merge-helper description so it says the helper keeps the integration branch authoritative by using helper-owned temporary merge state, not by refreshing a persistent occupied target worktree.
    - Replace @detached-reviewer-merge-helper ac-occupied-target-clean-refresh with the following final behavior; do not keep the old refresh semantics under a different ID:

      AC id: ac-helper-uses-ephemeral-target-worktree
      Given: A reviewer runs the supported detached merge helper and the integration target branch is not checked out in any non-helper worktree.
      When: The reviewed canonical head needs to be merged into the integration target.
      Then: The helper creates an internal temporary target worktree, performs the merge there, advances the integration target ref on success, and removes the temporary worktree before exiting.

      AC id: ac-helper-leaves-no-target-branch-lock
      Given: The supported detached merge helper exits after a successful merge, no-op merge, or conflict/error path.
      When: Git worktrees are listed for the repository.
      Then: No helper-created or dispatch auxiliary worktree remains checked out on the integration target branch.

      AC id: ac-helper-occupied-target-refuses-with-free-branch-guidance
      Given: The integration target branch is already checked out in a non-helper worktree before the detached merge helper runs.
      When: The helper cannot safely take exclusive ownership of the target branch for its temporary merge worktree.
      Then: The helper refuses before moving refs, identifies the blocking worktree, and reports guidance to free or detach that existing checkout without instructing the reviewer to check out the integration target in another auxiliary worktree.

    - Rewrite @detached-reviewer-merge-helper ac-helper-refuses-dirty-target so it applies to dirty or staged drift in a pre-existing occupied target checkout and preserves the same refusal-before-ref-move behavior.
    - Rewrite @detached-reviewer-merge-helper ac-helper-safe-conflict-exit so conflict cleanup is defined in terms of aborting/removing the helper-owned temporary target worktree, not leaving an occupied integration worktree refreshed.
    - Keep @detached-reviewer-merge-helper ac-helper-no-op-merge semantics, explicitly noting that no persistent target worktree is created or dirtied on the no-op path.
    - Add these ACs to @dispatch-integration-mutation-scope:

      AC id: ac-occupied-target-refusal-identifies-blocker
      Given: Dispatch is running from a checkout that does not itself have the integration target branch checked out, and another worktree has that target branch checked out.
      When: Dispatch attempts an integration-target sync or push for that branch.
      Then: Dispatch refuses before moving refs and reports the blocking worktree path with guidance to free or detach that checkout.

      AC id: ac-auxiliary-worktrees-do-not-hold-target-locks
      Given: Dispatch uses worker, reviewer, helper, or plan-scoped auxiliary worktrees while the dispatch root is not checked out on a specific integration target branch.
      When: The auxiliary operation completes, fails, or is cleaned up.
      Then: Those auxiliary worktrees do not keep that integration target branch checked out in a way that prevents the dispatch root from syncing or pushing the target branch.

    - Add this AC to @dispatch-remote-branch-sync:

      AC id: ac-occupied-checkout-degraded-recovery
      Given: An integration target entered degraded state because the target branch was checked out in another worktree.
      When: A later sync or push evaluation finds that no other worktree has the target branch checked out and the target operation succeeds or is a no-op.
      Then: The degraded state for that target is cleared and queued work for that target becomes eligible without requiring a dispatch-engine restart.

    Why:
    The existing spec already says reviewer guidance must not tell reviewers to check out the integration branch manually, but the helper script itself emits recovery text that requires exactly that. The spec also assumes an occupied target worktree can be refreshed, which conflicts with the dispatch root's safety guard for plan integration targets. These AC updates make exclusive branch-lock ownership explicit.

    How:
    - Use `kspec item ac add` for the new ACs and `kspec item ac set`/equivalent item edit path for replacement wording on the existing helper ACs.
    - Ensure no final helper AC still promises to refresh a persistent occupied target worktree after the target ref moves.
    - Set the touched specs to implementation `in_progress` with `--no-cascade` unless the implementation and regression task lands in the same change.
    - Verify `kspec item get @detached-reviewer-merge-helper`, `kspec item get @dispatch-integration-mutation-scope`, and `kspec item get @dispatch-remote-branch-sync` show the intended ACs exactly once.

    Testing:
    - kspec item get @detached-reviewer-merge-helper
    - kspec item get @dispatch-integration-mutation-scope
    - kspec item get @dispatch-remote-branch-sync
    - kspec validate --refs --warnings-ok

    Covers: @detached-reviewer-merge-helper ac-helper-uses-ephemeral-target-worktree, ac-helper-leaves-no-target-branch-lock, ac-helper-occupied-target-refuses-with-free-branch-guidance, ac-helper-no-op-merge, ac-helper-refuses-dirty-target, ac-helper-safe-conflict-exit; @dispatch-integration-mutation-scope ac-occupied-target-refusal-identifies-blocker, ac-auxiliary-worktrees-do-not-hold-target-locks; @dispatch-remote-branch-sync ac-occupied-checkout-degraded-recovery

- title: Rework detached reviewer merge helper to use an ephemeral target worktree
  slug: task-rework-detached-reviewer-merge-helper-ephemeral-target
  priority: 1
  tags: [dispatch, merge-helper, git, worktree]
  spec_ref: "@detached-reviewer-merge-helper"
  depends_on:
    - "@task-align-merge-helper-branch-lock-specs"
  description: |
    What:
    - Update `templates/skills/merge/scripts/detached-reviewer-merge.sh` so it no longer requires `KSPEC_DISPATCH_MERGE_TARGET` to be checked out in any pre-existing worktree.
    - When the target branch is free, create a helper-owned temporary worktree for `KSPEC_DISPATCH_MERGE_TARGET`, run the merge there, capture the merge result, and remove the temporary worktree in an EXIT/finally trap on every path.
    - The helper must preserve the pinned-head behavior: merge `KSPEC_DISPATCH_CANONICAL_HEAD`, not an advanced task branch tip.
    - On no-op, report success without creating persistent worktree state or moving refs.
    - On conflict, abort the merge in the temporary worktree, remove the temporary worktree, leave the integration target ref unchanged, and keep the existing needs_work/conflict guidance.
    - If `git worktree add` fails because the target branch is already checked out elsewhere, fail before moving refs with guidance to detach/free the existing checkout; do not say to check out the target branch somewhere else.
    - Edit the source skill script in `templates/skills/merge/scripts/detached-reviewer-merge.sh`, then run `kspec skill render` so generated `.agents/skills/kspec-merge/scripts/detached-reviewer-merge.sh` receives the same behavior. Only run `kspec agents generate` if agent instruction text also changes.

    Why:
    Reviewers are running from detached snapshots. Requiring a separate persistent target checkout creates a branch lock that blocks dispatch's safe integration-target mutation guard and stalls queued plan tasks.

    How:
    - Use `mktemp -d` or a deterministic helper scratch path under the dispatch worktree root only for the helper-owned target worktree; always remove it with `git worktree remove --force` and directory cleanup in a trap.
    - Use `git worktree list --porcelain` before and after to detect target branch occupancy.
    - Keep all mutation in the helper-owned target worktree. Do not run `git checkout` in the detached reviewer snapshot.
    - Keep errors explicit and actionable, but avoid recovery text that tells agents to create a persistent integration-target checkout.

    Testing:
    - npm test -- --fresh tests/detached-reviewer-merge.test.ts
    - npm test -- --fresh tests/supporting-file-references.test.ts tests/setup-builtin-agents.test.ts
    - npm run typecheck
    - kspec validate --refs --warnings-ok

    Covers: @detached-reviewer-merge-helper ac-helper-uses-ephemeral-target-worktree, ac-helper-leaves-no-target-branch-lock, ac-helper-occupied-target-refuses-with-free-branch-guidance, ac-helper-no-op-merge, ac-helper-refuses-dirty-target, ac-helper-safe-conflict-exit

- title: Add regression coverage for helper branch-lock release
  slug: task-add-detached-merge-helper-branch-lock-regressions
  priority: 1
  tags: [tests, dispatch, merge-helper, worktree]
  spec_ref: "@detached-reviewer-merge-helper"
  depends_on:
    - "@task-rework-detached-reviewer-merge-helper-ephemeral-target"
  description: |
    What:
    - Update `tests/detached-reviewer-merge.test.ts` so the primary success path has no pre-existing integration-target worktree. The helper should create its own temporary target worktree, merge, remove the worktree, and leave `git worktree list --porcelain` with no `branch refs/heads/<target>` entry outside expected root state.
    - Add a conflict-path regression proving the temporary target worktree is removed and the target ref remains unchanged after a merge conflict.
    - Add an occupied-target regression where the target branch is already checked out in another worktree. Assert the helper exits non-zero before moving refs, names the blocking worktree, and does not instruct the reviewer to check out the target branch somewhere else.
    - Preserve tests for pinned canonical head, no-op already-integrated commits, missing environment variables, and dirty/staged occupied-target refusal if that case remains distinct from general occupied-target refusal.
    - Add or update prompt/skill rendering assertions so reviewer guidance points only to the supported helper and does not contain the helper's old recovery phrase `check out '$MERGE_TARGET' in a worktree` or equivalent manual checkout wording.

    Why:
    The previous tests encoded the bad invariant by always provisioning an occupied integration target worktree before invoking the helper. Regression coverage must model the desired dispatch-safe state: reviewer snapshots can merge without creating a persistent branch lock.

    How:
    - Split the test fixture into variants: one with no target worktree, one with a deliberately occupied target worktree, and one with a temporary conflict setup.
    - Assert both ref state and worktree occupancy, not just stdout.
    - Use deterministic temp repositories and always clean helper temp worktrees in `afterEach` to avoid test pollution.

    Testing:
    - npm test -- --fresh tests/detached-reviewer-merge.test.ts
    - npm test -- --fresh tests/agent-dispatch-engine.test.ts -t "manual merge"
    - npm run typecheck

    Covers: @detached-reviewer-merge-helper ac-helper-uses-ephemeral-target-worktree, ac-helper-leaves-no-target-branch-lock, ac-helper-occupied-target-refuses-with-free-branch-guidance, ac-helper-no-op-merge, ac-helper-refuses-dirty-target, ac-helper-safe-conflict-exit

- title: Clear occupied-checkout degraded state when target locks are released
  slug: task-clear-occupied-checkout-degraded-state-on-retry
  priority: 2
  tags: [dispatch, remote-sync, degraded-state, worktree]
  spec_ref: "@dispatch-remote-branch-sync"
  depends_on:
    - "@task-align-merge-helper-branch-lock-specs"
  description: |
    What:
    - Update dispatch remote-sync/degraded-target handling so an integration target degraded because `resolveDispatchIntegrationMutationScope()` found the branch checked out elsewhere is retried and cleared once that checkout is no longer present.
    - Preserve hard failures for genuinely unsafe states: dirty target checkout, divergent branch history, missing refs that cannot be fetched, or ambiguous mutation surfaces.
    - Add a focused test where a target first enters degraded state because another worktree has the target branch checked out, the test detaches/removes that worktree, the next sync/push evaluation succeeds or no-ops, and `kspec agent dispatch status`/the engine status object reports no degraded target without restarting the engine.

    Why:
    In the incident, detaching the blocking worktree freed the branch, but the dispatch engine still needed a restart to clear cached degraded state and spawn queued work. Operators should not have to restart dispatch after applying the recommended recovery.

    How:
    - Locate the degraded-target map/state in `src/agent-runtime/dispatch.ts` and the target sync path that calls `runDispatchIntegrationTargetGit()`/`resolveDispatchIntegrationMutationScope()`.
    - Ensure periodic sync and post-invocation target push paths re-evaluate degraded targets instead of skipping them forever solely because they are degraded.
    - Classify the occupied-checkout error separately enough to report the blocking worktree path while still allowing later retries.
    - Keep branch divergence behavior unchanged unless a successful fast-forward/push proves recovery.

    Testing:
    - npm test -- --fresh tests/agent-dispatch-engine.test.ts -t "degraded"
    - npm test -- --fresh tests/dispatch-target-sync.test.ts
    - npm test -- --fresh tests/dispatch-degraded-state.test.ts
    - npm run typecheck
    - kspec validate --refs --warnings-ok

    Covers: @dispatch-remote-branch-sync ac-occupied-checkout-degraded-recovery; @dispatch-integration-mutation-scope ac-occupied-target-refusal-identifies-blocker, ac-4

- title: Add end-to-end plan-target lock regression for manual_merge dispatch
  slug: task-add-plan-target-lock-e2e-regression
  priority: 2
  tags: [tests, dispatch, plan-branch, merge-helper]
  spec_ref: "@dispatch-integration-mutation-scope"
  depends_on:
    - "@task-rework-detached-reviewer-merge-helper-ephemeral-target"
    - "@task-clear-occupied-checkout-degraded-state-on-retry"
  description: |
    What:
    - Add an integration-style regression proving a plan-scoped manual_merge review can merge into a plan integration target without leaving that plan target branch checked out in `.kspec-worktrees` or any helper-created auxiliary worktree.
    - The test should provision a plan-scoped task whose integration target differs from the dispatch root branch, run the reviewer merge helper path, and then run/trigger target push or periodic sync from the dispatch root.
    - Assert the root dispatch checkout can push/sync the plan target branch, `git worktree list --porcelain` has no lingering `branch refs/heads/<plan-target>` in auxiliary worktrees, and the engine does not enter or remain in degraded state for that target.

    Why:
    Unit tests around the helper and degraded map are necessary but not sufficient. The incident was the cross-product of plan-scoped target branches, manual_merge reviewer flow, helper guidance, and dispatch remote sync.

    How:
    - Reuse existing dispatch engine test helpers for workspace provisioning and manual_merge mode where possible.
    - Keep the test in a temp repo; do not use the live self-hosting checkout or active `.kspec-worktrees`.
    - This task must preserve a true integration-style regression for the combined incident path: plan-scoped target branch + manual_merge reviewer helper + no lingering auxiliary target checkout + dispatch-root target sync/push. If full orchestration proves infeasible in the existing harness, stop and report the harness limitation for a product/test-scope decision instead of substituting narrower helper-only or sync-only tests while claiming E2E coverage.

    Testing:
    - npm test -- --fresh tests/agent-dispatch-engine.test.ts
    - npm test -- --fresh tests/detached-reviewer-merge.test.ts
    - npm run typecheck
    - kspec validate --alignment --warnings-ok
    - kspec validate --completeness --warnings-ok

    Covers: @dispatch-integration-mutation-scope ac-occupied-target-refusal-identifies-blocker, ac-auxiliary-worktrees-do-not-hold-target-locks; @dispatch-remote-branch-sync ac-push-target-periodic, ac-occupied-checkout-degraded-recovery; @detached-reviewer-merge-helper ac-helper-leaves-no-target-branch-lock
```

## Implementation Notes

- This is an existing-spec update plan. Do not materialize duplicate specs from the `## Specs` block.
- The immediate product decision is: reviewer/manual_merge helpers may use temporary implementation-owned worktrees, but they must not require or leave persistent integration-target checkouts that block the dispatch root.
- The root dispatch checkout remains the authoritative mutation surface for integration target sync/push unless it is itself on the integration target branch. Auxiliary worktrees are task/review/helper execution surfaces, not long-lived target locks.
- The helper should be conservative around pre-existing occupied target checkouts. A clean occupied checkout owned by a human or previous agent should not be silently detached or overwritten unless a later explicit product decision scopes that behavior. The safe first fix is to refuse, identify the blocking worktree, and say how to free the branch.
- No new @plan-branch-dispatch-target AC is needed for this plan: plan-branch target selection already exists; this plan hardens the shared integration-target mutation and remote-sync contracts that operate after a workspace has resolved its target branch.
- Do all merge-helper and dispatch-regression testing in temp repos/fixtures. Do not run migration or destructive cleanup tests against `~/Projects/kynetic-spec` or `~/Projects/kynetic-spec-dispatch`.
