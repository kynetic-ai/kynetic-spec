# Default Session Reflection Reliability

## Existing Spec Updates

This proposal intentionally extends the existing owning specs instead of
introducing parallel requirements. The behavior spans four established
areas:

- `@multi-turn-session-lifecycle` owns session idle/grace/auto-close
  behavior.
- `@default-project-agents-and-conventions` owns the behavior of agents
  created by kspec setup defaults.
- `@default-session-reflection-hook` owns first-idle reflection behavior.
- `@single-command-version-upgrade` owns setup/upgrade parity for existing
  projects.

Proposed changes:

```yaml
- spec_ref: "@multi-turn-session-lifecycle"
  add_acceptance_criteria:
    - id: ac-idle-hook-prompt-window
      given: |
        An auto-closing agent session has emitted a session.idle event
      when: |
        A matching session.idle hook queues a prompt during the idle
        grace window
      then: |
        The session accepts the prompt instead of rejecting it as inactive

- spec_ref: "@default-project-agents-and-conventions"
  add_acceptance_criteria:
    - id: ac-default-agents-reflection-promptable
      given: |
        A project uses kspec-created default dispatch agents and the
        default session reflection hook
      when: |
        A default agent emits its first session.idle event
      then: |
        The default reflection prompt is accepted before automatic close

- spec_ref: "@single-command-version-upgrade"
  add_acceptance_criteria:
    - id: ac-default-reflection-hook-first-idle-on-upgrade
      given: |
        An existing project does not have the scaffolded default session
        reflection hook
      when: |
        kspec upgrade creates the hook
      then: |
        Later idle events from the same invocation are not eligible for
        the scaffolded reflection action
```

No new acceptance criterion is required on
`@default-session-reflection-hook`: it already promises first-idle-only
behavior via `ac-fires-once-per-invocation`. The implementation task fixes
the upgrade path so that existing spec promise is honored when the hook is
created by `kspec upgrade`, not only by fresh setup.

## Tasks

derive_from_specs: false

```yaml
- title: Update specs for default session reflection reliability
  slug: task-default-session-reflection-spec-updates
  priority: 1
  tags: [specs, dispatch, sessions, setup, upgrade, hooks, reflection]
  spec_ref: "@multi-turn-session-lifecycle"
  description: |
    Update the existing owning specs before any implementation work so the
    implementation task can be reviewed against finalized behavioral
    contracts. Keep this task limited to kspec metadata/spec updates and
    do not change runtime, setup, or upgrade implementation code.

    Why:
    - The current product gap spans existing implemented specs rather than
      a new standalone feature.
    - A clean review path requires the implementation task to depend on an
      explicit spec-update task instead of asking the same task to both
      rewrite specs and implement behavior.
    - The spec updates must be precise so future reviewers can distinguish
      the new promises from the already-existing
      @default-session-reflection-hook ac-fires-once-per-invocation promise.

    What:
    - Update @multi-turn-session-lifecycle by adding acceptance criterion
      ac-idle-hook-prompt-window with this exact behavioral shape:
        Given: An auto-closing agent session has emitted a session.idle event.
        When: A matching session.idle hook queues a prompt during the idle
        grace window.
        Then: The session accepts the prompt instead of rejecting it as inactive.
    - Update @default-project-agents-and-conventions by adding acceptance
      criterion ac-default-agents-reflection-promptable with this exact
      behavioral shape:
        Given: A project uses kspec-created default dispatch agents and the
        default session reflection hook.
        When: A default agent emits its first session.idle event.
        Then: The default reflection prompt is accepted before automatic close.
    - Update @single-command-version-upgrade by adding acceptance criterion
      ac-default-reflection-hook-first-idle-on-upgrade with this exact
      behavioral shape:
        Given: An existing project does not have the scaffolded default
        session reflection hook.
        When: kspec upgrade creates the hook.
        Then: Later idle events from the same invocation are not eligible for
        the scaffolded reflection action.
    - Do not add a duplicate acceptance criterion to
      @default-session-reflection-hook; it already owns the first-idle
      promise through ac-fires-once-per-invocation. If its surrounding prose
      needs clarification, keep the clarification aligned with that existing
      AC instead of creating a new promise.
    - Do not add validation/doctor behavior to these specs; that follow-up
      remains tracked separately by inbox item @01KQ8PRY.

    How:
    - Use kspec spec/item update commands or the project’s accepted kspec
      metadata workflow to add the listed ACs to the named existing specs.
    - Keep the AC ids and wording stable enough that the dependent
      implementation task can reference them directly.
    - Verify each target spec shows the new AC exactly once and that
      @default-session-reflection-hook still has only the existing
      ac-fires-once-per-invocation coverage for first-idle behavior.

    Testing:
    - Run the narrow kspec inspection commands needed to prove each target
      spec contains the listed AC id and behavioral Given/When/Then text.
    - Run kspec validation if the local repo baseline allows it. If
      validation fails for unrelated existing repo-health issues, record the
      baseline failure and do not treat it as completion evidence for this
      task.

    Establishes:
    - @multi-turn-session-lifecycle ac-idle-hook-prompt-window
    - @default-project-agents-and-conventions ac-default-agents-reflection-promptable
    - @single-command-version-upgrade ac-default-reflection-hook-first-idle-on-upgrade

- title: Make default session reflection reliable after setup and upgrade
  slug: task-default-session-reflection-reliability
  priority: 2
  tags: [dispatch, sessions, setup, upgrade, hooks, reflection]
  spec_ref: "@multi-turn-session-lifecycle"
  depends_on:
    - "@task-default-session-reflection-spec-updates"
  description: |
    Fix the default session reflection race where a session.idle hook
    fires but its session_prompt action can lose to auto-close and fail
    because the session is already inactive. Keep this task
    self-contained: do not rely on chat history or a particular affected
    project.

    Why:
    - kspec currently has a runtime fallback idle grace that is too short
      for post-idle session_prompt hooks under realistic dispatch timing.
    - Default dispatch agents created by setup can appear correctly
      scaffolded while still depending on that too-short fallback for
      default reflection promptability.
    - setup-created default-session-reflect hooks include the first-idle
      turn_count filter, but upgrade-created hooks do not, even though
      @default-session-reflection-hook ac-fires-once-per-invocation
      already promises once-per-invocation reflection.
    - This task depends on @task-default-session-reflection-spec-updates so
      implementation and review happen against finalized spec ACs rather
      than mixing spec authoring and implementation in one task.

    What:
    - Raise the centralized default idle grace used for session.idle hook
      promptability from the current 100 ms to 5000 ms. The default must
      apply when an agent does not override idle_grace_period_ms and a
      same-session idle hook may queue a prompt.
    - Ensure kspec-created default dispatch agents get the same effective
      5000 ms idle grace behavior after fresh setup. Prefer a single
      source of truth so runtime fallback, setup defaults, and future
      scaffold code do not drift.
    - If explicit session blocks are used to make the scaffolded default
      behavior visible in metadata, update src/cli/commands/setup-defaults.ts
      so DefaultAgentDef and the saved agentData preserve session mode
      auto_close and idle_grace_period_ms 5000 for dispatch-capable
      default agents.
    - Update src/cli/commands/upgrade.ts where it creates a missing
      default-session-reflect hook so newly scaffolded hooks include the
      first-idle filter matching the setup-created hook and
      @default-session-reflection-hook ac-fires-once-per-invocation.
    - Preserve existing user intent: do not recreate default agents/hooks
      that kspec records as deliberately removed, and do not overwrite an
      existing default-session-reflect hook during this task. Any repair
      of already-existing customized or legacy hooks belongs in a
      separate migration proposal.
    - Keep validation/doctor warning behavior out of this task; that
      follow-up remains tracked separately by inbox item @01KQ8PRY.

    How:
    - Update src/agent-runtime/invocation.ts so DEFAULT_IDLE_GRACE_MS is
      the healthy default used when session.idle hooks exist and an agent
      does not override idle_grace_period_ms.
    - Update the default-agent scaffold path only as much as needed for
      fresh setup to satisfy @default-project-agents-and-conventions
      ac-default-agents-reflection-promptable. If explicit session blocks
      are emitted, ensure setup-defaults preserves them from definition
      through saved metadata.
    - Update the upgrade scaffold for default-session-reflect so a newly
      created hook has filter.turn_count equal to 1. Reuse the setup-side
      hook shape if practical so setup and upgrade cannot drift again.
    - Keep existing first-run/user-removal behavior intact: setup and
      upgrade must not recreate or overwrite default agents/hooks that a
      user deliberately removed or customized.

    Testing:
    - Add or update a dispatch/invocation regression test that drives an
      idle session with a session.idle -> session_prompt hook and proves
      a prompt queued within the default grace window is accepted for the
      same session rather than failing with an inactive-session error.
    - Add or update setup default-agent tests so a fresh setup followed by
      reading the generated meta data demonstrates that default dispatch
      agents satisfy the reflection promptability behavior. If the chosen
      implementation emits explicit session metadata, assert the generated
      metadata shows mode auto_close and idle_grace_period_ms 5000.
    - Add or update upgrade command tests so a project missing
      default-session-reflect receives a hook whose behavior is first-idle
      only. The observable metadata check should confirm the generated
      hook has filter.turn_count equal to 1.
    - Add or preserve upgrade tests proving user intent is respected: a
      previously removed default-session-reflect hook is not recreated,
      and an existing hook is not overwritten by this task.
    - Keep tests behavioral: exercise setup/upgrade/runtime outputs and
      hook execution behavior. Do not add tests that merely search source
      files for literal strings.

    Covers:
    - @multi-turn-session-lifecycle ac-idle-hook-prompt-window
    - @default-project-agents-and-conventions ac-default-agents-reflection-promptable
    - @default-session-reflection-hook ac-fires-once-per-invocation
    - @single-command-version-upgrade ac-default-reflection-hook-first-idle-on-upgrade
```

## Implementation Notes

- Existing coverage is partial. `@default-session-reflection-hook` already
  promises first-idle-only behavior, and a completed historical task
  restricted the setup-created hook to `turn_count: 1`. The gap is that
  the upgrade scaffold still creates the same named hook without that
  filter.
- The first task is a spec-update task. The implementation task depends on
  it so implementation review can use finalized spec ACs as the source of
  truth instead of reviewing code against plan prose.
- The multi-turn session lifecycle plan described a default 5 second
  grace period, but current runtime code still falls back to 100 ms when
  session.idle hooks exist and agents do not define
  `idle_grace_period_ms`.
- The validation/doctor improvement is intentionally not part of this
  implementation task. It is tracked separately in inbox item
  `@01KQ8PRY`: validate/doctor should warn about risky session.idle hooks
  whose session_prompt action depends on missing or too-short idle grace.
- This plan should be reviewed and approved before deriving tasks. Do not
  dispatch implementation from this proposal until the user explicitly
  approves the scope.
