# Folder-Backed Index Consistency Hardening

## Specs

```yaml
[]
```

## Tasks

derive_from_specs: false

```yaml
- title: Promote folder-backed index consistency into the shared trait contract
  slug: task-promote-folder-backed-index-consistency-trait
  priority: 1
  tags: [specs, storage, folder-backed, tasks, plans, reviews]
  spec_ref: "@trait-folder-backed-entity-1"
  description: |
    What:
    - Update the existing shared trait `@trait-folder-backed-entity-1`, not a
      new duplicate trait, so the task, plan, review, and future folder-backed
      storage contracts inherit one common index-consistency rule.
    - Add these acceptance criteria to `@trait-folder-backed-entity-1` with the
      exact ids and wording below:

      `ac-index-entry-created-with-folder`
      Given: A folder-backed entity is created
      When: The creation is persisted
      Then: The entity directory, authoritative sidecar files, and bounded index
      entry are written in the same logical atomic mutation

      `ac-indexed-mutation-updates-index`
      Given: A persisted folder-backed entity changes any field, count, derived
      summary, relationship, lifecycle value, or resource metadata that belongs
      in that entity type's bounded index projection
      When: The mutation is persisted
      Then: The authoritative sidecar update and the corresponding index entry
      update are committed as one logical atomic mutation

      `ac-index-repair-converges`
      Given: A folder-backed entity index has drifted from authoritative entity
      folders
      When: an index repair successfully rewrites the index and no later entity
      mutation occurs
      Then: A subsequent dry-run rebuild reports no index changes

      `ac-semantic-defaults-do-not-drift`
      Given: An indexed optional field has equivalent persisted forms such as an
      omitted value and an empty default collection
      When: Index drift is computed or an index repair is verified
      Then: The semantically equivalent forms are treated as equal and do not
      produce repeated update drift

    - Add `@trait-folder-backed-entity-1` directly to the traits list for:
      `@task-directory-storage`, `@task-index-file`,
      `@folder-backed-plan-storage-1`, and `@folder-backed-review-storage-1`.
      Preserve any existing traits on those specs.
    - Keep the current task-specific task storage ACs intact, especially
      `@task-index-file ac-2`, `@task-index-file ac-5`,
      `@task-atomic-writes ac-1`, `@task-atomic-writes ac-3`, and
      `@task-atomic-writes ac-4`; those are the concrete task behavior that the
      shared trait is generalizing.
    - Set implementation status to `in_progress` with `--no-cascade` for
      `@trait-folder-backed-entity-1`, `@task-directory-storage`,
      `@task-index-file`, `@folder-backed-plan-storage-1`, and
      `@folder-backed-review-storage-1` because this task adds stricter
      requirements that are not yet proven by implementation evidence.
    - Use one atomic `kspec batch` payload for the spec/trait/status changes.

    Why:
    Task storage already specifies that indexed task changes update
    `project.tasks.yaml` in the same atomic action as the per-task directory
    update. Plans and reviews now use the same folder/index pattern, so their
    contracts should inherit the same invariant instead of relying on
    rebuild-index as normal maintenance.

    How:
    - Inspect the current specs first with:
      `KSPEC_NO_DAEMON=1 kspec item get @trait-folder-backed-entity-1`
      `KSPEC_NO_DAEMON=1 kspec item get @task-index-file`
      `KSPEC_NO_DAEMON=1 kspec item get @task-atomic-writes`
      `KSPEC_NO_DAEMON=1 kspec item get @folder-backed-plan-storage-1`
      `KSPEC_NO_DAEMON=1 kspec item get @folder-backed-review-storage-1`
    - Create `/tmp/folder-backed-index-consistency-spec-updates.json` containing
      the `item ac add` and `item set --add-trait` / `item set --status`
      operations, then run:
      `KSPEC_NO_DAEMON=1 kspec batch --dry-run --file /tmp/folder-backed-index-consistency-spec-updates.json`
      `KSPEC_NO_DAEMON=1 kspec batch --file /tmp/folder-backed-index-consistency-spec-updates.json`
    - If any of the AC ids already exist, use `kspec item ac set` in the same
      batch payload to make the final text exactly match this task instead of
      creating duplicate ACs.

    Testing:
    - Verify every added AC appears under `@trait-folder-backed-entity-1` with
      the exact id and final text.
    - Verify each target spec includes `@trait-folder-backed-entity-1` exactly
      once in its trait list.
    - Run `KSPEC_NO_DAEMON=1 kspec validate --warnings-ok` and treat a zero exit
      code as success even if unrelated warnings are printed.

    Covers: @trait-folder-backed-entity-1 ac-index-entry-created-with-folder,
    ac-indexed-mutation-updates-index, ac-index-repair-converges,
    ac-semantic-defaults-do-not-drift; @task-index-file ac-2, ac-5;
    @task-atomic-writes ac-1, ac-3, ac-4

- title: Add red tests for plan and review index consistency after every folder mutation
  slug: task-add-folder-index-consistency-regressions
  priority: 1
  tags: [testing, storage, folder-backed, plans, reviews]
  spec_ref: "@trait-folder-backed-entity-1"
  depends_on:
    - "@task-promote-folder-backed-index-consistency-trait"
  description: |
    What:
    - Add failing-before-fix regression coverage for plan and review folder
      mutations that currently can leave `project.plans.yaml` or
      `project.reviews.yaml` out of sync until a rebuild is run.
    - Extend the existing focused suites instead of creating a hidden one-off
      harness:
      - `tests/plan-rebuild-index.test.ts`
      - `tests/review-rebuild-index.test.ts`
      - `tests/parser-plans-folder.test.ts`
      - `tests/parser-reviews-folder.test.ts`
      - CLI suites only where a behavior is exposed only through CLI commands,
        such as `tests/cli-plan-resource.test.ts` and
        `tests/review-resource-cli.test.ts`.
    - Cover these plan operations in a temp project configured for folder-backed
      storage:
      - create/import a plan and immediately dry-run rebuild the plan index;
      - import a plan document with sibling `resources.yaml` metadata plus
        `resources/` files, then immediately run
        `kspec plan rebuild-index --dry-run` and assert `resource_summary` has
        no drift before any repair;
      - mutate indexed metadata such as status, derived refs, branch, or module;
      - add and clear notes so `notes_count` is reflected or removed;
      - add, replace, and delete a plan local resource so `resource_summary`
        stays current.
    - Cover these review operations in a temp project configured for
      folder-backed storage:
      - create a review and immediately dry-run rebuild the review index;
      - add a thread/comment, add a check, add a verdict, close or reopen when
        the command/API supports it, and verify the index counts/disposition;
      - add, replace, and delete a review local resource so `resource_summary`
        stays current;
      - include a review whose detail file has `external_links: []` while the
        index omits `external_links`, then prove repair converges.
    - Add a small task baseline assertion showing the existing task data manager
      already satisfies the same trait after `task add`, `task set`, task note,
      and task delete flows. Put it in `tests/task-data-manager.test.ts` unless
      an existing task CLI regression suite is a narrower fit.
    - Each new assertion must run `rebuild-index --dry-run` after the mutating
      operation and assert zero drift without first running repair.

    Why:
    These tests pin the user-facing invariant before implementation work: every
    normal mutator must keep the bounded index current in the same action that
    updates the folder sidecar. Rebuild-index remains a recovery tool, not the
    expected follow-up after normal commands.

    How:
    - Reuse existing temp-project helpers and fixture ULID helpers from the
      listed test files.
    - Prefer public CLI commands for command-surface guarantees and direct
      storage-manager calls for low-level mutation invariants.
    - Mark new test snippets with `// AC:` comments for the exact trait ACs and
      the concrete plan/review storage ACs they prove.
    - Do not run these tests against `~/Projects/kynetic-spec` or
      `~/Projects/kynetic-spec-dispatch` as live migration targets. Use temp
      directories or disposable fixture projects only.

    Testing:
    - First run the new focused tests and confirm at least one plan/review case
      fails against the current implementation.
    - After the implementation task, run:
      `npm test -- --fresh tests/plan-rebuild-index.test.ts tests/review-rebuild-index.test.ts tests/parser-plans-folder.test.ts tests/parser-reviews-folder.test.ts tests/task-data-manager.test.ts`
    - If CLI resource coverage was added, also run:
      `npm test -- --fresh tests/cli-plan-resource.test.ts tests/review-resource-cli.test.ts`

    Covers: @trait-folder-backed-entity-1 ac-index-entry-created-with-folder,
    ac-indexed-mutation-updates-index, ac-index-repair-converges,
    ac-semantic-defaults-do-not-drift; @folder-backed-plan-storage-1
    ac-plan-index-has-bounded-projection; @folder-backed-review-storage-1
    ac-review-index-has-bounded-projection; @task-index-file ac-2, ac-5

- title: Make plan and review folder mutators update indexes atomically
  slug: task-implement-folder-index-consistency-mutators
  priority: 1
  tags: [storage, folder-backed, plans, reviews, atomicity]
  spec_ref: "@trait-folder-backed-entity-1"
  depends_on:
    - "@task-add-folder-index-consistency-regressions"
  description: |
    What:
    - Update plan and review storage so every operation that writes an
      authoritative folder sidecar also updates the bounded index entry within
      the same logical buffered mutation when indexed data changes.
    - Audit and fix every public mutating path that can write plan/review folder
      data, including:
      - plan import/create, plan set/status changes, plan note changes, plan
        derive output, plan branch metadata, plan delete;
      - plan resource add/replace/delete, import-time sibling resource
        persistence through `persistPlanResourcesFromSibling(...)`, and any
        API/static helper that mutates `resources.yaml`;
      - review add/create, review comment/thread changes, review check changes,
        review verdict changes, review lifecycle changes, review delete;
      - review resource add/replace/delete and any API/static helper that
        mutates `resources.yaml`.
    - Normalize index equality for semantically equivalent optional/default
      values. At minimum, `external_links` omitted from an index entry and
      `external_links: []` in a review detail file must compare equal so
      `review rebuild-index --repair` converges.
    - Ensure resource-summary updates are not missed. If a resource manager
      writes `resources.yaml` directly, route that write through the owning
      plan/review storage manager or add an owner-specific index refresh inside
      the same write buffer.
    - Keep rebuild-index as a recovery/repair path. Do not make normal CLI/API
      mutators call rebuild-index after the fact as their consistency strategy.
    - Preserve existing wrapper keys and unknown sibling data in
      `project.plans.yaml`, `project.reviews.yaml`, and entity detail sidecars.

    Why:
    The folder sidecar and bounded index are one logical storage record. If a
    mutator updates only the folder, list/dashboard/API consumers can see stale
    state until a manual rebuild runs; if repair repeatedly reports the same
    drift, operators cannot distinguish real damage from false drift.

    How:
    - Use `src/parser/task-data-manager.ts` and the split backend as the model:
      callers submit mutations; the storage layer coordinates all affected
      files and the shadow commit.
    - Update `src/parser/folder-backed-entity.ts` only for reusable equality,
      projection, or write-buffer helpers that are genuinely shared by plan and
      review storage. Keep plan/review-specific projection field lists in their
      existing managers.
    - Update `src/parser/plan-storage-manager.ts` and
      `src/parser/review-storage-manager.ts` so `save*`, `mutate*`, delete, and
      resource-summary refresh paths cannot bypass index updates.
    - If plan/review resource managers currently bypass these storage managers,
      change those managers to accept an owner index-refresh callback or call a
      small exported `refreshPlanIndexEntry` / `refreshReviewIndexEntry` helper
      that runs inside the same active write buffer.
    - Keep locks scoped so concurrent mutations for the same index cannot
      interleave partial writes.

    Testing:
    - Run the tests added by `@task-add-folder-index-consistency-regressions`
      and confirm the red cases now pass.
    - Run existing related suites:
      `npm test -- --fresh tests/plan-rebuild-index.test.ts tests/review-rebuild-index.test.ts tests/parser-plans-folder.test.ts tests/parser-reviews-folder.test.ts tests/plan-folder-migration.test.ts tests/review-folder-migration.test.ts tests/upgrade-folder-storage.test.ts`
    - Run `npm run typecheck`.

    Covers: @trait-folder-backed-entity-1 ac-index-entry-created-with-folder,
    ac-indexed-mutation-updates-index, ac-semantic-defaults-do-not-drift;
    @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection,
    ac-plan-delete-removes-owned-folder; @folder-backed-review-storage-1
    ac-review-index-has-bounded-projection, ac-review-delete-removes-owned-folder;
    @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields

- title: Harden upgrade and rebuild-index idempotence coverage across tasks plans and reviews
  slug: task-harden-folder-index-upgrade-idempotence-coverage
  priority: 2
  tags: [testing, upgrade, migration, storage, clean-room]
  spec_ref: "@trait-folder-backed-entity-1"
  depends_on:
    - "@task-implement-folder-index-consistency-mutators"
  description: |
    What:
    - Extend `tests/upgrade-folder-storage.test.ts` and the plan/review
      rebuild-index suites so migration and repair paths prove convergence for
      tasks, plans, and reviews together.
    - Add or strengthen tests for these cases:
      - legacy monolithic plan and review records migrate to folder storage;
      - immediate `plan rebuild-index --dry-run` and
        `review rebuild-index --dry-run` after migration report no drift;
      - `plan rebuild-index --repair` followed by dry-run is clean;
      - `review rebuild-index --repair` followed by dry-run is clean;
      - a fresh `kspec init --setup` project using `kynetic: "1.2"` and folder
        storage remains clean after representative task, plan, review, and
        resource mutations;
      - absent optional fields and empty default collections do not cause
        repeated drift reports.
    - Add one CLI-level temp-project smoke test that mirrors the real operator
      workflow without touching live repos:
      `kspec upgrade --force --dry-run`, `kspec upgrade --force`,
      `kspec plan rebuild-index --dry-run`,
      `kspec review rebuild-index --dry-run`,
      representative plan/review mutations, and final dry-run rebuilds.
    - Ensure every migration/rebuild test uses temp directories, fixtures, or
      disposable clones. The tests must never mutate active self-hosting repos
      such as `~/Projects/kynetic-spec` or `~/Projects/kynetic-spec-dispatch`.

    Why:
    The earlier migration slice proved that folder indexes can be rebuilt, but
    did not prove repair convergence or post-mutation cleanliness across all
    entity types. This task turns the clean-room failure mode into durable
    regression evidence.

    How:
    - Reuse existing upgrade helpers rather than shelling out when a direct CLI
      helper already exists in `tests/upgrade-folder-storage.test.ts`.
    - For command-level smoke, set `KSPEC_NO_DAEMON=1` in the spawned process
      environment so daemon state cannot mask filesystem results.
    - Assert exit codes, not just stdout text. A clean dry-run rebuild must exit
      zero and report no pending changes.
    - Keep protected-project tripwire assertions from the existing migration
      tests intact.

    Testing:
    - Run:
      `npm test -- --fresh tests/upgrade-folder-storage.test.ts tests/plan-rebuild-index.test.ts tests/review-rebuild-index.test.ts tests/task-data-manager.test.ts`
    - Run `npm run build` if CLI smoke tests execute built `dist/cli/index.js`.

    Covers: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders,
    ac-index-repair-converges, ac-semantic-defaults-do-not-drift;
    @single-command-version-upgrade ac-runs-task-storage-migration,
    ac-idempotent-when-current, ac-dry-run-no-writes

- title: Run final quality gates and reconcile spec implementation evidence
  slug: task-validate-folder-index-consistency-hardening
  priority: 3
  tags: [validation, lint, format, build, storage]
  spec_ref: "@trait-folder-backed-entity-1"
  depends_on:
    - "@task-harden-folder-index-upgrade-idempotence-coverage"
  description: |
    What:
    - Run the complete quality and formatting gates for the folder-backed index
      consistency hardening work.
    - Verify the updated specs, code comments, and tests carry accurate `// AC:`
      annotations for the trait and concrete plan/review/task ACs.
    - Re-run focused CLI temp-project smoke after the full build to ensure the
      built CLI has the same clean index behavior as the TypeScript test path.
    - Once all tests and smoke checks pass, set implementation status back to
      `implemented` with `--no-cascade` for these specs:
      `@trait-folder-backed-entity-1`, `@task-directory-storage`,
      `@task-index-file`, `@folder-backed-plan-storage-1`, and
      `@folder-backed-review-storage-1`.
    - Add concise spec notes to the same refs summarizing the evidence commands
      and the fact that normal mutators keep indexes clean without repair.

    Why:
    The plan tightens an already-implemented storage contract. Status should
    not return to implemented until the code, tests, and built CLI all prove the
    stronger trait applies consistently across tasks, plans, and reviews.

    How:
    - Run formatting before format check:
      `npm run format`
      `npm run format:check`
    - Run quality gates:
      `npm run lint`
      `npm run typecheck`
      `npm run build`
    - Run focused storage tests:
      `npm test -- --fresh tests/task-data-manager.test.ts tests/plan-rebuild-index.test.ts tests/review-rebuild-index.test.ts tests/parser-plans-folder.test.ts tests/parser-reviews-folder.test.ts tests/plan-folder-migration.test.ts tests/review-folder-migration.test.ts tests/upgrade-folder-storage.test.ts`
    - Run any CLI resource suites touched by the implementation:
      `npm test -- --fresh tests/cli-plan-resource.test.ts tests/review-resource-cli.test.ts`
    - Use an atomic `kspec batch` for final spec status/note updates after all
      evidence is green.

    Testing:
    - The listed commands are the required evidence for this task.
    - If any command fails, leave the relevant specs `in_progress`, document the
      failing command and first failing assertion in a task note, and do not
      claim the strengthened trait is implemented.

    Covers: @trait-folder-backed-entity-1 ac-index-entry-created-with-folder,
    ac-indexed-mutation-updates-index, ac-index-repair-converges,
    ac-semantic-defaults-do-not-drift; @task-data-manager ac-4;
    @task-index-file ac-2, ac-5, ac-7; @folder-backed-plan-storage-1
    ac-plan-index-has-bounded-projection; @folder-backed-review-storage-1
    ac-review-index-has-bounded-projection
```

## Implementation Notes

This is an existing-contract hardening plan: it creates no duplicate sibling
spec items. The first task updates the existing shared trait and attaches it
directly to the current task, plan, and review storage specs.

Source behavior already present on task storage:
- `@task-index-file ac-2` says filterable task field changes update both
  `project.tasks.yaml` and `tasks/<ulid>/task.yaml` in the same atomic operation.
- `@task-index-file ac-5` says new task creation adds the index entry in the
  same atomic operation as directory creation.
- `@task-atomic-writes ac-1`, `ac-3`, and `ac-4` specify single-buffer atomic
  writes for task index and per-task files.

The shared trait is the correct place for the generalized rule because
`@trait-folder-backed-entity-1` already describes the folder/index storage shape
shared by tasks, plans, reviews, and future folder-backed entities. The current
trait covers bounded projections, unknown-file preservation, and rebuildability;
this plan adds the missing same-mutation consistency and repair-convergence
requirements.

The implementation should not treat `rebuild-index` as a normal consistency
step after every mutating command. Rebuild remains an operator recovery tool for
repairing drift. Normal mutators must keep the index clean as part of their own
write.

Migration and CLI smoke tests must use temp projects, fixtures, or disposable
clones. Workers must not run non-dry-run migration tests against the active
self-hosting repos `~/Projects/kynetic-spec` or
`~/Projects/kynetic-spec-dispatch` unless Jacob explicitly scopes that live
migration in a future instruction.
