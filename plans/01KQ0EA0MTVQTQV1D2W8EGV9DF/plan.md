# Spec Catalog Health and Validation Trust

## Specs

```yaml
- title: Validation Task Data Source
  slug: validation-task-data-source
  type: requirement
  parent: "@validation"
  description: |
    Validation uses the same task data model that normal kspec consumers
    use, so reference, schema, and completeness findings cover every
    persisted task record regardless of the task storage layout.
  acceptance_criteria:
    - id: ac-all-persisted-tasks-included
      given: |
        A project contains persisted task records in the supported task
        storage layout
      when: |
        validation runs task-aware checks
      then: |
        Every persisted task record is included in the validation task set
    - id: ac-task-references-checked
      given: |
        A persisted task contains a field that validation treats as a
        reference
      when: |
        reference validation runs
      then: |
        The reference contributes to validation findings with the task as
        the source
    - id: ac-task-load-errors-reported
      given: |
        A persisted task record cannot be parsed as a valid task
      when: |
        validation runs
      then: |
        A validation finding identifies the affected task record instead
        of silently omitting it

- title: AC Annotation Integrity Reporting
  slug: ac-annotation-integrity-reporting
  type: requirement
  parent: "@spec-completeness"
  description: |
    AC coverage annotations are only valid when they point at a spec item
    or trait acceptance criterion that exists. Invalid annotations are
    reported as repairable completeness findings and do not provide
    coverage credit.
  acceptance_criteria:
    - id: ac-unresolved-target-reported
      given: |
        A configured coverage scan path contains an AC annotation whose
        target reference cannot be resolved
      when: |
        completeness validation runs
      then: |
        An invalid-annotation finding identifies the target reference and
        the source location
    - id: ac-non-spec-target-reported
      given: |
        A configured coverage scan path contains an AC annotation whose
        target resolves to something other than a spec item or trait
      when: |
        completeness validation runs
      then: |
        An invalid-annotation finding identifies the target as an invalid
        coverage target and reports the source location
    - id: ac-missing-ac-id-reported
      given: |
        A configured coverage scan path contains an AC annotation whose
        target spec or trait exists but whose AC id does not exist on that
        target
      when: |
        completeness validation runs
      then: |
        An invalid-annotation finding identifies the target reference, the
        missing AC id, and the source location
    - id: ac-blanket-ref-does-not-cover
      given: |
        A configured coverage scan path contains an AC annotation that
        names a spec item or trait with acceptance criteria but does not
        name specific AC ids
      when: |
        completeness validation computes coverage
      then: |
        The annotation does not count as coverage for that target
    - id: ac-valid-annotation-covers-target
      given: |
        A configured coverage scan path contains an AC annotation that
        names an existing spec or trait AC
      when: |
        completeness validation computes coverage
      then: |
        The named AC is treated as covered by that annotation

- title: Coverage Annotation Scope Boundaries
  slug: coverage-annotation-scope-boundaries
  type: requirement
  parent: "@coverage-scan-config"
  description: |
    AC coverage scanning is limited to the configured coverage surface.
    Annotations outside configured scan paths or inside excluded paths do
    not create coverage credit and do not create invalid-annotation debt.
  acceptance_criteria:
    - id: ac-only-configured-paths-scanned
      given: |
        A project has one or more coverage scan paths configured
      when: |
        completeness validation scans for AC annotations
      then: |
        Only files under the configured scan paths are considered
    - id: ac-excluded-paths-skipped
      given: |
        A configured coverage scan path contains files that match a
        configured exclude pattern
      when: |
        completeness validation scans for AC annotations
      then: |
        Matching files are skipped
    - id: ac-skipped-annotations-no-credit
      given: |
        A skipped file contains text that looks like an AC annotation
      when: |
        completeness validation runs
      then: |
        The skipped text produces no coverage credit
    - id: ac-skipped-annotations-no-invalid-debt
      given: |
        A skipped file contains text that looks like an AC annotation
      when: |
        completeness validation runs
      then: |
        The skipped text produces no invalid annotation findings
```

## Tasks

derive_from_specs: false

```yaml
- title: Capture validation trust baseline
  slug: task-catalog-health-baseline
  priority: 1
  tags: [validation, spec-hygiene, audit]
  description: |
    Capture the current validation and overlap baseline before changing
    the spec catalog or validation code.

    Why: This plan exists to restore trust in validation output. Workers
    need a concrete before/after baseline so improvements are measured
    against current project state rather than the earlier audit snapshot.

    What:
    - Run and save current output for:
      - kspec validate --refs --warnings-ok -v
      - kspec validate --alignment -v
      - kspec validate --completeness -v
    - Record counts for hard reference failures, alignment warnings,
      missing acceptance criteria warnings, missing own-AC coverage
      warnings, and invalid AC annotations.
    - Identify exact tasks that contain the unresolved spec refs
      @cmd-derive, @session-remove-shadow-commits, and
      @session-branch-worktree.
    - Check overlap with @plan-completeness-warning-debt-reduction,
      @task-plan-completeness-warning-debt-reduction, and
      @task-triage-automation-eligible-missing-spec-ref.

    How:
    Use kspec CLI lookups and validation commands. Do not manually edit
    .kspec YAML. Write the baseline report to this root checkout's ignored
    plan workspace at:

    plans/cruft-baselines/spec-catalog-health-validation-trust-baseline.md

    This file is intentionally not committed and may not be present in
    derived task workspaces. It is an ephemeral coordination artifact for
    this plan's task sequence. After writing it, add a task note to this
    task with the artifact path, timestamp, git revision, commands run,
    and a short summary of the major finding categories.

    Testing:
    This task is discovery only. Verification is that the ignored baseline
    artifact exists in the root checkout and the task note records command
    output summaries, exact refs for follow-up tasks, and the artifact
    path that downstream tasks are allowed to read.

    Covers: planning/discovery for @validation-task-data-source,
    @ac-annotation-integrity-reporting, and
    @coverage-annotation-scope-boundaries.

- title: Repair broken task spec references
  slug: task-repair-broken-spec-refs
  priority: 1
  tags: [validation, refs, spec-hygiene]
  depends_on:
    - "@task-catalog-health-baseline"
  description: |
    Resolve the current hard reference validation failures caused by
    task spec_ref values that point at missing specs.

    Why: Downstream cleanup cannot trust reference validation while the
    project has known unresolved task spec refs.

    Baseline input:
    This task depends on @task-catalog-health-baseline. Before changing
    refs, read the ephemeral baseline artifact written by that task at
    plans/cruft-baselines/spec-catalog-health-validation-trust-baseline.md.
    That ignored root-checkout file is allowed input for this task even
    though it is not committed or synced into task workspaces. Use it only
    as starting-state evidence and before/after comparison data. If the
    artifact is missing, stale, or inaccessible, rerun the baseline
    commands listed in @task-catalog-health-baseline and add a task note
    with the regenerated results before proceeding.

    What:
    - Inspect each task identified by the baseline for:
      - @cmd-derive
      - @session-remove-shadow-commits
      - @session-branch-worktree
    - For each broken ref, decide whether the task should be retargeted
      to a current owning spec, left with no spec_ref because the work is
      historical/process-only, or paired with a recreated behavioral spec.
    - Apply the chosen repair through kspec task commands.
    - Add a task note explaining every retarget/clear/recreate decision.

    How:
    Prefer retargeting to existing current behavior specs when the old
    spec was renamed or merged. Only recreate a spec when the behavior is
    still current and has no adequate owner. Do not create placeholder
    specs solely to silence validation.

    Testing:
    Run kspec validate --refs --warnings-ok after repairs and verify the
    three named missing refs no longer appear as hard failures.

    Covers: @validation ac-valid-2, @ref-validation ac-1.

- title: Remove live test-only trait from production catalog
  slug: task-remove-live-test-trait
  priority: 1
  tags: [validation, traits, spec-hygiene]
  depends_on:
    - "@task-catalog-health-baseline"
  description: |
    Remove or relocate the live @01KJN1WT Test Trait item so fixture-only
    data no longer appears in production completeness validation.

    Why: The live project catalog currently contains a trait described as
    test-only fixture data. It lacks ACs and creates completeness debt
    that does not represent product behavior.

    Baseline input:
    This task depends on @task-catalog-health-baseline. Before changing
    trait/catalog records, read the ephemeral baseline artifact written by
    that task at
    plans/cruft-baselines/spec-catalog-health-validation-trust-baseline.md.
    That ignored root-checkout file is allowed input for this task even
    though it is not committed or synced into task workspaces. Use it only
    as starting-state evidence and before/after comparison data. If the
    artifact is missing, stale, or inaccessible, rerun the baseline
    commands listed in @task-catalog-health-baseline and add a task note
    with the regenerated results before proceeding.

    What:
    - Inspect @01KJN1WT / Test Trait and any references to it.
    - Confirm whether it is only fixture/test machinery.
    - If it is fixture-only, remove it from the live catalog using kspec
      commands and keep any necessary equivalent fixture data in tests.
    - If it is real behavior, rename/rewrite it as a proper trait with
      behavioral ACs instead of deleting it.
    - Add a note documenting the decision.

    How:
    Use kspec item/trait commands, not manual .kspec YAML edits. Search
    tasks, specs, and tests for references before deletion or rewrite.

    Testing:
    Run kspec validate --completeness and verify the missing-AC warning
    for @01KJN1WT / Test Trait is gone or replaced by intentional trait
    behavior with ACs.

    Covers: @spec-completeness-policy ac-feature-required,
    @spec-completeness ac-1.

- title: Use canonical task data source during validation
  slug: task-validation-task-data-manager-read-path
  priority: 1
  tags: [validation, tasks, parser]
  spec_ref: "@validation-task-data-source"
  depends_on:
    - "@task-catalog-health-baseline"
  description: |
    Update validation so task-aware checks use the canonical task data
    model instead of a separate task-file scan that can drift from normal
    consumers.

    Why: The validation trust baseline depends on validation seeing the
    same tasks and task fields that CLI, API, dispatch, and other
    consumers see.

    Baseline input:
    This task depends on @task-catalog-health-baseline. Before changing
    validation behavior, read the ephemeral baseline artifact written by
    that task at
    plans/cruft-baselines/spec-catalog-health-validation-trust-baseline.md.
    That ignored root-checkout file is allowed input for this task even
    though it is not committed or synced into task workspaces. Use it only
    as starting-state evidence and before/after comparison data. If the
    artifact is missing, stale, or inaccessible, rerun the baseline
    commands listed in @task-catalog-health-baseline and add a task note
    with the regenerated results before proceeding.

    What:
    - Inspect src/parser/validate.ts around the current task loading path.
    - Replace or wrap direct task-file discovery/parsing with the
      canonical task data manager read path where appropriate.
    - Preserve schema-error reporting for malformed task records.
    - Ensure validation stats still report task counts and file/source
      information useful for repair.
    - Add regression tests covering split task storage, malformed task
      records, and task reference fields.

    How:
    Use existing TaskDataManager helpers rather than duplicating task
    storage rules in validate.ts. If schema validation still needs raw
    file-level parsing, keep that path narrowly scoped and ensure task
    reference/completeness checks consume canonical task data.

    Testing:
    Run focused tests covering validation, task data manager, and task
    plan/spec refs. Use npm test -- --run <files>; do not invoke vitest
    directly.

    Covers: @validation-task-data-source ac-all-persisted-tasks-included,
    @validation-task-data-source ac-task-references-checked,
    @validation-task-data-source ac-task-load-errors-reported.

- title: Tighten AC annotation integrity reporting
  slug: task-ac-annotation-integrity-reporting
  priority: 2
  tags: [validation, coverage, ac-annotations]
  spec_ref: "@ac-annotation-integrity-reporting"
  depends_on:
    - "@task-catalog-health-baseline"
  description: |
    Ensure invalid AC annotations produce precise repairable findings and
    valid annotations provide coverage only for existing spec or trait ACs.

    Why: Current invalid-annotation volume makes completeness validation
    noisy. Workers need findings that identify exactly what to repair and
    must not receive coverage credit for bad targets.

    Baseline input:
    This task depends on @task-catalog-health-baseline. Before changing AC
    annotation reporting, read the ephemeral baseline artifact written by
    that task at
    plans/cruft-baselines/spec-catalog-health-validation-trust-baseline.md.
    That ignored root-checkout file is allowed input for this task even
    though it is not committed or synced into task workspaces. Use it only
    as starting-state evidence and before/after comparison data. If the
    artifact is missing, stale, or inaccessible, rerun the baseline
    commands listed in @task-catalog-health-baseline and add a task note
    with the regenerated results before proceeding.

    What:
    - Audit validateACAnnotations and related coverage-scan behavior.
    - Ensure unresolved targets, non-spec/trait targets, missing AC ids,
      and blanket refs against AC-bearing items are reported distinctly
      enough to repair.
    - Ensure valid annotations still count for the intended AC.
    - Add focused tests for each reporting case.

    How:
    Keep parser examples and scan-scope behavior separate from integrity
    reporting. This task should not mass-edit existing test annotations;
    that is handled by the repair-wave task.

    Testing:
    Run focused validation/coverage tests via npm test -- --run. Also run
    kspec validate --completeness and confirm invalid annotation findings
    remain visible with file/line/target detail.

    Covers: @ac-annotation-integrity-reporting ac-unresolved-target-reported,
    @ac-annotation-integrity-reporting ac-non-spec-target-reported,
    @ac-annotation-integrity-reporting ac-missing-ac-id-reported,
    @ac-annotation-integrity-reporting ac-blanket-ref-does-not-cover,
    @ac-annotation-integrity-reporting ac-valid-annotation-covers-target.

- title: Enforce coverage annotation scan boundaries
  slug: task-coverage-annotation-scope-boundaries
  priority: 2
  tags: [validation, coverage, config]
  spec_ref: "@coverage-annotation-scope-boundaries"
  depends_on:
    - "@task-ac-annotation-integrity-reporting"
  description: |
    Verify and harden the boundary between real coverage annotations and
    annotation-like examples outside the configured coverage surface.

    Why: This project contains parser examples and test fixtures that may
    look like AC annotations. Completeness validation should only treat
    annotations in configured, non-excluded coverage paths as coverage or
    invalid-annotation debt.

    Baseline input:
    This task depends on @task-ac-annotation-integrity-reporting, which in
    turn depends on @task-catalog-health-baseline. Before changing scan
    boundaries, read the ephemeral baseline artifact at
    plans/cruft-baselines/spec-catalog-health-validation-trust-baseline.md
    if it exists. That ignored root-checkout file is allowed input for
    this task even though it is not committed or synced into task
    workspaces. Use it only as starting-state evidence and before/after
    comparison data. If the artifact is missing, stale, or inaccessible,
    rerun the baseline commands listed in @task-catalog-health-baseline
    and add a task note with the regenerated results before proceeding.

    What:
    - Inspect kspec.config.yaml coverage.scan_paths and
      coverage.exclude_patterns.
    - Add or update tests proving scan paths are the only included
      surface and excluded files are skipped.
    - Confirm annotation-like text in excluded files does not create
      coverage credit or invalid annotation findings.
    - Adjust scanner behavior only if current behavior does not satisfy
      the spec.

    How:
    Prefer configuration-driven tests over hardcoded project paths. Keep
    examples in parser tests excluded if they are documentation for the
    parser rather than real coverage claims.

    Testing:
    Run focused coverage-scan tests via npm test -- --run. Then run kspec
    validate --completeness and confirm invalid annotation counts reflect
    only configured, non-excluded coverage files.

    Covers: @coverage-annotation-scope-boundaries ac-only-configured-paths-scanned,
    @coverage-annotation-scope-boundaries ac-excluded-paths-skipped,
    @coverage-annotation-scope-boundaries ac-skipped-annotations-no-credit,
    @coverage-annotation-scope-boundaries ac-skipped-annotations-no-invalid-debt.

- title: Repair first wave of invalid AC annotations
  slug: task-ac-annotation-repair-wave-one
  priority: 2
  tags: [validation, coverage, spec-hygiene]
  depends_on:
    - "@task-ac-annotation-integrity-reporting"
    - "@task-coverage-annotation-scope-boundaries"
    - "@task-repair-broken-spec-refs"
    - "@task-remove-live-test-trait"
  description: |
    Classify and repair the first high-confidence wave of invalid AC
    annotations after validation reporting and scan boundaries are clear.

    Why: The plan should reduce immediate annotation noise without trying
    to solve the entire long-tail completeness backlog that later cleanup
    plans will handle.

    Baseline input:
    This task has indirect baseline dependency through its prerequisite
    tasks. Before selecting repair candidates, read the ephemeral baseline
    artifact at
    plans/cruft-baselines/spec-catalog-health-validation-trust-baseline.md
    if it exists. That ignored root-checkout file is allowed input for
    this task even though it is not committed or synced into task
    workspaces. Use the original baseline only as starting-state evidence;
    select repairs from the current validation output after the reporting
    and scan-boundary tasks have run. If the artifact is missing, stale,
    or inaccessible, rerun the baseline commands listed in
    @task-catalog-health-baseline and add a task note with the regenerated
    results before proceeding.

    What:
    - Export current invalid_ac_annotation findings from
      kspec validate --completeness -v.
    - Classify each selected finding as unresolved target, non-spec/trait
      target, missing AC id, blanket ref, shorthand/range form, or
      intentionally excluded example.
    - Repair high-confidence stale annotations in configured coverage
      files by retargeting to the correct current spec/AC, splitting
      blanket refs into explicit AC ids, or removing annotations that are
      not real coverage claims.
    - Leave low-confidence cases documented for later plans instead of
      guessing.

    How:
    Work in small batches and preserve behavior of tests. Do not add new
    specs solely to make stale annotations valid. If a finding reveals a
    real missing spec, capture it as a follow-up unless it is required for
    this validation-trust plan.

    Testing:
    Run affected tests and kspec validate --completeness. Verify invalid
    annotation counts decrease and no repaired tests lose intended
    coverage signal.

    Supports: uses @ac-annotation-integrity-reporting
    ac-unresolved-target-reported, ac-non-spec-target-reported,
    ac-missing-ac-id-reported, and ac-blanket-ref-does-not-cover as the
    classification taxonomy for repairing current catalog annotations.

- title: Final validation trust gate
  slug: task-validation-trust-final-gate
  priority: 2
  tags: [validation, review, spec-hygiene]
  depends_on:
    - "@task-validation-task-data-manager-read-path"
    - "@task-ac-annotation-repair-wave-one"
  description: |
    Run the final validation gate for this implementation plan and record
    the remaining validation-trust state.

    Why: The plan is only successful if the project has a clearer
    validation baseline and future cleanup work can trust the remaining
    findings.

    Baseline input:
    Before final comparison, read the ephemeral baseline artifact at
    plans/cruft-baselines/spec-catalog-health-validation-trust-baseline.md.
    That ignored root-checkout file is allowed input for this task even
    though it is not committed or synced into task workspaces. Use it as
    the before-state for this plan's final before/after summary. If the
    artifact is missing, stale, or inaccessible, rerun the baseline
    commands listed in @task-catalog-health-baseline and explain in the
    final task note that the before-state was regenerated.

    What:
    - Run:
      - kspec validate --refs --warnings-ok
      - kspec validate --alignment
      - kspec validate --completeness
      - focused npm test -- --run commands from prior tasks
    - Record before/after counts for reference failures, alignment
      warnings, missing AC warnings, missing own-AC coverage warnings,
      and invalid annotation warnings.
    - Document intentional remaining warning categories and the cleanup
      area that owns each remaining category.
    - Add notes to the tasks completed under this plan summarizing final
      command results and any intentional deferrals.

    How:
    Treat this as the implementation closeout for this validation-trust
    slice. Do not derive or implement later cleanup slices from here.

    Testing:
    Validation commands and focused test commands must be recorded in the
    task notes. Any non-zero validation exit caused by remaining warnings
    must be explained and assigned to a later cleanup slice.

    Covers: final verification for @validation-task-data-source,
    @ac-annotation-integrity-reporting, and
    @coverage-annotation-scope-boundaries.
```

## Implementation Notes

This plan was created from the non-derivable seed plan
`@cruft-01-spec-catalog-health-seed` under the program charter
`@cruft-cleanup-program-charter`. Those records are context only; this
plan must stand on its own for workers and reviewers.

Ephemeral baseline coordination:

- `@task-catalog-health-baseline` writes this plan's before-state report
  to the root checkout's ignored plan workspace at
  `plans/cruft-baselines/spec-catalog-health-validation-trust-baseline.md`.
- The baseline report is not a repo deliverable and should not be
  committed. It exists only while this plan's tasks are being executed.
- Downstream tasks are explicitly allowed to read that root-checkout file
  even when their derived task workspace does not contain the gitignored
  `plans/` directory. If the file is unavailable, the task should rerun
  the baseline commands recorded in `@task-catalog-health-baseline` and
  note the regenerated before-state before making scope decisions.

Current baseline at plan drafting time:

- `kspec validate --refs --warnings-ok -v` exited 4 with four hard
  reference failures:
  - `@cmd-derive` in `.kspec/kynetic.tasks.yaml`
  - `@session-remove-shadow-commits` in `.kspec/project.tasks.yaml`
  - `@session-branch-worktree` in `.kspec/project.tasks.yaml` twice
- `kspec validate --alignment -v` exited 6 with warning output.
- `kspec validate --completeness -v` exited 6 with 491 warnings:
  - 1 missing-AC item: `@01KJN1WT` / `Test Trait`
  - 235 missing own-AC coverage warnings
  - 255 invalid AC annotations

Known exact task candidates containing the hard missing refs include:

- `@task-recursive-derive` and/or `@01KJWK89Y` history for `@cmd-derive`;
  current derivation specs include `@derive-command`, `@derive-commands`,
  and plan-derive specs, so workers must inspect before retargeting.
- `@remove-shadowautocommit-from-session-operations` for
  `@session-remove-shadow-commits`.
- `@implement-session-branch-worktree-mode` and the cancelled task
  `@01KKBBS7` for `@session-branch-worktree`.

Overlap to manage before derivation:

- Existing approved plan `@plan-completeness-warning-debt-reduction` and
  needs-work task `@task-plan-completeness-warning-debt-reduction` already
  cover broad completeness warning reduction. This plan is narrower: it
  only restores validation/reference/annotation trust and should not take
  over the entire completeness backlog.
- Existing task `@task-triage-automation-eligible-missing-spec-ref` owns
  automation-without-spec triage and is out of scope.

Dependency ordering:

1. Capture baseline first and write the ignored root-checkout baseline
   artifact for downstream comparison.
2. Repair broken refs and Test Trait independently after baseline.
3. Tighten validation read/reporting behavior before mass annotation
   repair.
4. Repair only high-confidence invalid annotations in this plan.
5. Run final validation gate and record the remaining validation-trust
   state.

Task automation status is intentionally not encoded in this plan because
current plan derivation does not preserve automation metadata from plan
YAML. Set automation status explicitly after derivation according to the
approved execution strategy.
