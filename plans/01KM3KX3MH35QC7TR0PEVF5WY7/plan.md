# Dispatch Shared-Checkout Safety and Git Context Hardening

This plan hardens how dispatch mutates the configured integration branch
when dispatch is running in a shared checkout. The immediate trigger is a
checkout-drift failure mode where dispatch advances the integration
branch but leaves the checkout looking locally dirty even though the
change came from dispatch itself.

This plan is intentionally narrow:

- shared-checkout dispatch is a supported product mode
- worker and reviewer task worktrees remain isolated under the existing
  dispatch worktree root

## Context

The current remote sync and integration push logic relies too heavily on
launch context to determine which repository state gets mutated. That is
not a strong enough invariant when dispatch is started from a linked
worktree, when inherited environment state can redirect git context, or
when different codepaths advance the integration branch through
different mechanisms.

The project already has the right high-level boundaries:

- worker/reviewer code execution happens in isolated task worktrees
- dispatch owns integration-branch sync and publish behavior
- the configured integration branch comes from `dispatch.base_branch`

What is missing is an explicit contract for how dispatch targets git
operations, how it detects checkout drift, and how it repairs or reports
unsafe state.

## Design Decisions

1. **Shared-checkout mode is a first-class product contract.** Dispatch
   must behave correctly when it mutates the configured integration
   branch from the checkout it is running in.
2. **Git targeting must be deterministic.** Integration-branch
   operations must apply to the intended checkout and branch state
   regardless of launch context or inherited environment state.
3. **Shared-checkout repair behavior must be observable.** Drift repair
   cannot be specified as an abstract "safe repair path"; the contract
   must state what dispatch proves about branch ref, index, working
   tree, and operator-visible status after repair.

## Specs

```yaml
- title: Dispatch Shared-Checkout Contract
  slug: dispatch-shared-checkout-contract
  type: decision
  parent: "@dispatch-remote-branch-sync"
  description: |
    Defines the product contract for dispatch integration-branch
    mutation when dispatch is running in a shared checkout.

    The product guarantee in scope is shared-checkout correctness.
  acceptance_criteria:
    - id: ac-1
      given: |
        Dispatch is running in a shared checkout that a user may also
        inspect or use for manual work
      when: |
        Dispatch performs integration-branch sync, publish, or health
        checks
      then: |
        Shared-checkout mode is treated as a supported product mode, not
        as undefined or best-effort behavior
    - id: ac-2
      given: |
        Worker and reviewer task worktrees already exist under the
        dispatch worktree root
      when: |
        Dispatch mutates the configured integration branch
      then: |
        Task worktrees remain execution surfaces for task work, not the
        mutation surface for the configured integration branch

- title: Dispatch Integration Mutation Scope Contract
  slug: dispatch-integration-mutation-scope
  type: requirement
  parent: "@dispatch-remote-branch-sync"
  description: |
    Integration-branch operations mutate only the shared checkout state
    that dispatch owns for the configured integration branch. They do
    not spill into unrelated repository state, and they fail safely when
    the intended mutation surface is ambiguous.
  acceptance_criteria:
    - id: ac-1
      given: |
        Dispatch performs integration-branch sync, publish, health, or
        repair work in a shared checkout
      when: |
        The operation completes
      then: |
        The resulting branch ref, index, and working tree changes are
        limited to the shared checkout running dispatch
    - id: ac-2
      given: |
        Worker and reviewer task worktrees exist for active task work
      when: |
        An integration-branch operation executes
      then: |
        Those task worktrees do not have their branch ref, index, or
        working tree mutated as a side effect of the integration-branch
        operation
    - id: ac-3
      given: |
        Dispatch performs the same integration-branch operation against
        the same repository state at different times during one daemon
        run
      when: |
        Each operation completes successfully
      then: |
        The operation applies to the same shared checkout mutation
        surface each time
    - id: ac-4
      given: |
        Dispatch cannot determine a safe mutation surface for the
        configured integration branch
      when: |
        A sync or push operation is attempted
      then: |
        Dispatch refuses the operation and reports actionable guidance
        instead of mutating an ambiguous checkout

- title: Dispatch Shared-Checkout Safety and Drift Repair
  slug: dispatch-shared-checkout-safety
  type: requirement
  parent: "@dispatch-remote-branch-sync"
  description: |
    If dispatch runs in a shared checkout, integration-branch mutation
    must leave the checkout in a coherent state. Dispatch detects when
    the branch ref, index, and working tree have drifted apart and
    repairs that state when it is safe to do so.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        Dispatch advances the configured integration branch through a
        sync or another dispatcher-owned branch mutation
      when: |
        The operation completes successfully in a shared checkout
      then: |
        The branch ref, index, and working tree all reflect the same
        commit, and dispatch does not introduce checkout status noise
        caused solely by its own branch mutation
    - id: ac-2
      given: |
        The integration branch ref points at a newer commit while the
        checkout index and working tree still reflect an older commit,
        and the checkout is otherwise clean
      when: |
        Dispatch evaluates checkout health during startup, sync, or an
        explicit repair path
      then: |
        Dispatch restores the checkout to a coherent state where the
        branch ref, index, and working tree all point at the current
        branch tip, and checkout status no longer shows drift caused
        solely by the stale branch transition
    - id: ac-3
      given: |
        The checkout has local modifications or staged changes that
        would be overwritten by an automatic repair
      when: |
        Dispatch detects branch drift
      then: |
        Dispatch refuses automatic destructive repair, marks the checkout
        unhealthy or degraded with a specific reason, and surfaces
        actionable guidance instead of silently hard-resetting
    - id: ac-4
      given: |
        The checkout is unhealthy because of unrepaired branch drift
      when: |
        Dispatch status or health is queried
      then: |
        The reported state includes the configured integration branch,
        the drift reason, and the recommended next action
```

## Tasks

derive_from_specs: false

```yaml
- title: Design shared-checkout integration branch contract
  slug: task-design-dispatch-shared-checkout-contract
  priority: 1
  tags: [dispatch, design, git]
  spec_ref: "@dispatch-shared-checkout-contract"
  description: |
    What: Define the behavioral contract for dispatch integration-branch
    mutation in a shared checkout.

    Why: Shared-checkout correctness is the product behavior in scope.
    The implementation needs an explicit contract for what dispatch may
    mutate, what task worktrees are not allowed to own, and what health
    guarantees users can rely on.

    How: Align the plan with existing dispatch remote sync and worktree
    isolation specs, keep deployment guidance out of the behavioral
    contract, and define crisp operator-visible outcomes for unhealthy
    checkout states.

- title: Constrain integration-branch mutation scope
  slug: task-isolate-dispatch-git-targeting
  priority: 1
  tags: [dispatch, git, runtime]
  spec_ref: "@dispatch-integration-mutation-scope"
  depends_on:
    - "@task-design-dispatch-shared-checkout-contract"
  description: |
    What: Make integration-branch operations resolve and mutate the
    intended shared-checkout state deterministically.

    Why: Dispatch needs one consistent mutation scope so sync, publish,
    health, and repair operations always act on the same checkout and
    never spill into task worktrees or ambiguous repository state.

    How: Consolidate integration-branch operations behind one shared
    dispatch-owned execution boundary and enforce the mutation-scope
    contract there.

- title: Route target sync and integration push through the isolated targeting path
  slug: task-route-dispatch-sync-through-targeting-path
  priority: 1
  tags: [dispatch, sync, git]
  spec_ref: "@dispatch-remote-branch-sync"
  depends_on:
    - "@task-isolate-dispatch-git-targeting"
  description: |
    What: Update target sync and integration-target push flows so they
    all operate through the isolated targeting path while
    preserving the existing fast-forward-only and non-fatal push
    semantics.

    Why: Targeting isolation alone does not change behavior unless the
    real sync and publish paths stop using ad hoc git invocations.

    How: Audit remote sync start-up, before-provision sync, periodic
    sync, and post-merge push paths. Make them read and mutate the
    configured integration branch only through the shared targeting
    path.

- title: Implement shared-checkout drift detection and safe repair
  slug: task-implement-dispatch-shared-checkout-safety
  priority: 1
  tags: [dispatch, repair, health]
  spec_ref: "@dispatch-shared-checkout-safety"
  depends_on:
    - "@task-isolate-dispatch-git-targeting"
    - "@task-route-dispatch-sync-through-targeting-path"
  description: |
    What: Detect checkout drift caused by stale integration-branch
    transitions, restore coherent state when the checkout is otherwise
    clean, and surface degraded or unhealthy state when repair would
    overwrite local changes.

    Why: This is the user-visible failure mode that triggered the plan.
    Shared-checkout mode is only credible if dispatch handles this state
    explicitly and safely.

    How: Define operator-visible coherence checks, repair clean drifted
    checkouts, and route unsafe cases into existing degraded or
    health-reporting surfaces with precise operator guidance.

- title: Test shared-checkout safety and git context hardening
  slug: task-test-dispatch-shared-checkout-safety
  priority: 1
  tags: [dispatch, test, git]
  depends_on:
    - "@task-isolate-dispatch-git-targeting"
    - "@task-route-dispatch-sync-through-targeting-path"
    - "@task-implement-dispatch-shared-checkout-safety"
  description: |
    What: Add end-to-end and unit coverage for worktree-launched
    dispatch processes, sanitized git execution context, clean drift
    auto-repair, and unsafe drift refusal.

    Why: These behaviors are easy to regress because they depend on git
    environment, worktree context, and branch/index/tree state changes.
    The plan should not rely on manual operator observation to know it
    still works.

    How: Extend the existing dispatch target sync and degraded-state
    fixtures to model shared-checkout mode, leaked git env, out-of-band
    branch ref movement, and repair refusal when local changes would be
    overwritten.
```

## Implementation Notes

### Product boundary

This plan treats shared-checkout correctness as the product contract:

- shared checkout is supported and must be robust
- linked task worktrees remain part of the dispatch execution model, but
  they do not define the integration-branch mutation contract

### Why this plan does not require a separate checkout

Requiring a dedicated checkout would overfit one operator workflow into
the product contract and would interact awkwardly with the existing
`.kspec` identity model, project-root resolution, and task worktree
behavior. The right product-level requirement is correctness, not one
mandatory topology.

### Key runtime boundary

Task worktrees are for task code execution. Integration-branch mutation
is a dispatcher concern. The runtime must keep those responsibilities
separate even when dispatch is running from a shared checkout.

### Out of scope

- prescribing a required repository topology for dispatch deployment
- replacing shared-checkout robustness with operational workarounds
