# Iterative Plan Editing

Plans currently support creation and import but lack round-trip editing. Once a plan is in kspec, the only way to modify it is through individual CLI commands (`plan set`, `plan note`). For iterative design work, users need to export a plan to a file, edit it freely, and import changes back — with diffs tracked via shadow branch history.

This fundamentally decouples import from derivation: import stores the plan document (content only — no specs, no tasks). Derivation (creating specs and tasks) is a separate step after the plan is approved. Plans can iterate freely in draft without creating churn in the spec tree.

**Supersedes:** Most of `@plan-import` ac-11 through ac-37 (spec/task creation) moves to derive. A few ACs stay on import in modified form (ac-15, ac-28, ac-32). Import becomes content-only storage. See the AC Migration tables in Implementation Notes for the precise mapping.

## Specs

```yaml
- title: Plan Export Command
  slug: plan-export
  type: requirement
  parent: "@plan-support"
  traits:
    - "@trait-json-output"
    - "@trait-semantic-exit-codes"
  description: |
    Export a plan's stored content to a file or stdout for editing.
    Used during the draft→edit→re-import cycle before derivation.
    Outputs the plan content as-is (the full markdown document
    stored during import).
  acceptance_criteria:
    - id: ac-stdout
      given: |
        A plan exists with content
      when: |
        kspec plan export @plan-ref is run
      then: |
        Plan content is written to stdout in markdown format
    - id: ac-output-file
      given: |
        A plan exists with content
      when: |
        kspec plan export @plan-ref --output /tmp/plan.md is run
      then: |
        Plan content is written to the specified file path
    - id: ac-empty
      given: |
        A plan has empty content (empty string)
      when: |
        kspec plan export @plan-ref is run
      then: |
        Exits with error and message "Plan has no content to export"
    - id: ac-not-found
      given: |
        The plan reference does not resolve to any plan
      when: |
        kspec plan export @nonexistent is run
      then: |
        Command fails with EXIT_CODES.USAGE_ERROR and message
        indicating the plan was not found
    - id: ac-json
      given: |
        A plan exists
      when: |
        kspec plan export @plan-ref --json is run
      then: |
        Output is JSON object with keys: title, content, status,
        derived_specs, derived_tasks

- title: Plan Import Into Existing Plan
  slug: plan-import-into
  type: requirement
  parent: "@plan-support"
  traits:
    - "@trait-shadow-commit"
    - "@trait-error-guidance"
    - "@trait-dry-run"
    - "@trait-semantic-exit-codes"
  description: |
    Re-import a plan document into an existing plan record, updating
    the plan content. This closes the round-trip editing loop:
    export → edit → re-import.

    Only the plan record's content and title are updated. No specs or
    tasks are created or modified — that happens at derive time.

    Only allowed for draft or approved plans. Active and terminal
    plans cannot be updated.
  depends_on:
    - "@plan-import"
  acceptance_criteria:
    - id: ac-into-draft
      given: |
        A plan exists in draft status and an edited plan document
        file exists with an H1 title and body content
      when: |
        kspec plan import ./edited-plan.md --into @plan-ref is run
      then: |
        The existing plan record's title is updated from the H1
        heading (if present) and content is replaced with the file
        content. A note is auto-appended: "Content updated from file"
    - id: ac-into-no-title
      given: |
        A plan exists and the edited document has no H1 heading
      when: |
        kspec plan import ./edited.md --into @plan-ref is run
      then: |
        Plan content is replaced with the file content.
        Plan title is preserved unchanged (not cleared).
    - id: ac-into-no-module
      given: |
        A plan exists and --into is specified
      when: |
        kspec plan import ./edited.md --into @plan-ref is run
        (no --module flag)
      then: |
        Command succeeds. --module is not required for --into since
        no specs are created during re-import.
    - id: ac-into-approved
      given: |
        A plan exists in approved status and an edited file exists
      when: |
        kspec plan import ./edited.md --into @plan-ref is run
      then: |
        Plan title and content are updated.
        Plan status remains approved.
    - id: ac-into-active
      given: |
        A plan is in active status (specs/tasks already derived)
      when: |
        kspec plan import ./edited.md --into @plan-ref is run
      then: |
        Command fails with EXIT_CODES.CONFLICT and message
        "Cannot update active plan. Derive is a one-shot operation."
    - id: ac-into-terminal
      given: |
        A plan exists in completed or rejected status
      when: |
        kspec plan import ./edited.md --into @plan-ref is run
      then: |
        Command fails with EXIT_CODES.CONFLICT and message
        "Cannot update plan in terminal status"
    - id: ac-into-content-only
      given: |
        An edited plan document has ## Specs and ## Tasks sections
      when: |
        kspec plan import ./edited.md --into @plan-ref is run
      then: |
        Only the plan record's title and content fields are updated.
        No specs are created or modified. No tasks are derived.
        The document is stored as-is for later derivation.
    - id: ac-into-dry-run
      given: |
        A plan exists and an edited file exists
      when: |
        kspec plan import ./edited.md --into @plan-ref --dry-run is run
      then: |
        Shows what would change (title update, content update)
        without making changes. Exits with code 0.
    - id: ac-into-file-not-found
      given: |
        The specified file path does not exist
      when: |
        kspec plan import ./nonexistent.md --into @plan-ref is run
      then: |
        Command fails with EXIT_CODES.USAGE_ERROR and message
        "Failed to read plan file: ./nonexistent.md"
    - id: ac-into-commit
      given: |
        A plan is successfully updated via --into
      when: |
        The update completes
      then: |
        Changes are auto-committed to shadow branch with message
        referencing the plan slug
    - id: ac-into-reason
      given: |
        A plan is being updated via --into
      when: |
        kspec plan import ./edited.md --into @plan --reason "Removed
        --full mode per review feedback" is run
      then: |
        The auto-appended note includes the user-supplied reason
        text instead of the generic "Content updated from file"
    - id: ac-into-reason-optional
      given: |
        A plan is being updated via --into without --reason
      when: |
        kspec plan import ./edited.md --into @plan is run
      then: |
        The auto-appended note uses the default message
        "Content updated from file"
    - id: ac-into-ignores-module
      given: |
        --into and --module are both specified
      when: |
        kspec plan import ./file.md --into @plan --module @mod is run
      then: |
        --module is ignored with a warning. --into only updates
        plan content, not module assignment.
    - id: ac-into-ignores-update
      given: |
        --into and --update are both specified
      when: |
        kspec plan import ./file.md --into @plan --update is run
      then: |
        --update is ignored with a warning. --into only updates plan
        content, not specs.
    - id: ac-into-ignores-status
      given: |
        --into and --status are both specified
      when: |
        kspec plan import ./file.md --into @plan --status approved is run
      then: |
        --status is ignored with a warning. --into does not change
        plan status.

- title: Plan Import Content-Only Storage
  slug: plan-import-content-only
  type: requirement
  parent: "@plan-support"
  traits:
    - "@trait-shadow-commit"
    - "@trait-dry-run"
    - "@trait-json-output"
    - "@trait-semantic-exit-codes"
  description: |
    Change plan import to store content only and default to draft status.

    Import creates the plan record with the full document as content
    but does NOT create specs or tasks. All materialization (spec
    creation, task derivation) happens via kspec plan derive.

    This respects the draft→approved→derive lifecycle and prevents
    import-time churn during iterative plan editing.

    Supersedes most of @plan-import ac-11 through ac-37.
    See AC Migration tables in Implementation Notes for the
    precise mapping of each existing AC.
  acceptance_criteria:
    - id: ac-draft-default
      given: |
        A valid plan document exists
      when: |
        kspec plan import ./plan.md is run
      then: |
        The created plan has status "draft" (not "active")
    - id: ac-module-optional
      given: |
        A valid plan document exists
      when: |
        kspec plan import ./plan.md is run (no --module flag)
      then: |
        Command succeeds. --module is no longer required since
        specs are not created at import time. If --module is
        provided, it is stored on the plan record for later use
        by derive.
    - id: ac-status-override
      given: |
        A user wants to import with a specific status
      when: |
        kspec plan import ./plan.md --status approved is run
      then: |
        Plan is created with the specified status
    - id: ac-content-only
      given: |
        A plan document has ## Specs and ## Tasks sections
      when: |
        kspec plan import ./plan.md is run
      then: |
        The full document is stored as plan content. No specs are
        created, no tasks are derived. The ## Specs YAML is
        preserved in the content for later derivation.
    - id: ac-update-ignored
      given: |
        --update flag is passed to import (without --into)
      when: |
        kspec plan import ./plan.md --update is run
      then: |
        --update is ignored with a warning since import no longer
        creates or modifies specs
    - id: ac-module-stored
      given: |
        A valid plan document exists
      when: |
        kspec plan import ./plan.md --module @mod is run
      then: |
        Plan is created with the module ref stored on the plan
        record. The stored module is used by kspec plan derive
        when --module is not explicitly provided.

- title: Enhanced Plan Derivation
  slug: plan-derive-enhanced
  type: requirement
  parent: "@plan-support"
  traits:
    - "@trait-shadow-commit"
    - "@trait-dry-run"
    - "@trait-json-output"
    - "@trait-error-guidance"
    - "@trait-semantic-exit-codes"
  description: |
    Enhanced plan derive command that parses plan content and creates
    specs and tasks. This is the materialization step — it takes a
    plan document stored as content and creates the corresponding
    spec items and (optionally) tasks.

    Absorbs all spec/task creation logic previously in plan import
    (topological ordering, slug dedup, parent resolution, trait
    mapping, dependency mapping, implementation notes, etc.).

    Derive is a one-shot operation — once a plan is derived, it
    transitions to active and its specs/tasks are managed directly.

    Replaces the current simple single-task derive behavior.
    Supersedes @plan-derive (ac-5, ac-6). Bidirectional link
    display is preserved via ac-bidirectional-links.
  depends_on:
    - "@plan-import-content-only"
  acceptance_criteria:
    - id: ac-parse-content
      given: |
        A plan exists in approved status with ## Specs YAML in its
        content field
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        The plan content is parsed using parsePlanDocument().
        Specs from the ## Specs YAML block are created as spec items
        under the specified module.
    - id: ac-module-required
      given: |
        A plan exists in approved status
      when: |
        kspec plan derive @plan-ref is run (no --module)
      then: |
        If the plan has no stored module ref, command fails with
        EXIT_CODES.USAGE_ERROR and message requiring --module
    - id: ac-module-from-import
      given: |
        A plan was imported with --module @mod (stored on plan record)
      when: |
        kspec plan derive @plan-ref is run (no --module)
      then: |
        Uses the module ref stored on the plan record from import
    - id: ac-module-override
      given: |
        A plan was imported with --module @mod-a (stored on plan record)
      when: |
        kspec plan derive @plan-ref --module @mod-b is run
      then: |
        Specs are created under @mod-b, not @mod-a.
        The explicit --module flag overrides the stored value.
    - id: ac-topo-sort
      given: |
        Plan specs have parent references to other specs in the
        same plan
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        Specs are created in topological order so parent specs
        exist before their children
    - id: ac-circular-dep
      given: |
        Plan specs have circular parent references
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        Command fails with EXIT_CODES.USAGE_ERROR and message
        identifying the circular dependency
    - id: ac-slug-dedup
      given: |
        A plan spec has a slug that collides with an existing item
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        A unique slug is generated by appending a numeric suffix
    - id: ac-traits
      given: |
        A plan spec has a traits array
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        Trait refs are normalized (@ prefix added if missing)
        and stored on the created spec
    - id: ac-depends-on
      given: |
        A plan spec has depends_on referencing other specs
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        Dependency refs are normalized and stored on created specs.
        When deriving tasks, spec depends_on maps to task depends_on.
    - id: ac-tasks-flag
      given: |
        A plan has specs in its content
      when: |
        kspec plan derive @plan-ref --module @mod --tasks is run
      then: |
        After creating specs, a task is derived from each spec
        with title "Implement <spec title>"
    - id: ac-task-refs
      given: |
        Tasks are derived from plan specs via --tasks
      when: |
        Derivation completes
      then: |
        Each derived task has spec_ref pointing to the source spec
        and plan_ref pointing to the plan
    - id: ac-no-tasks-default
      given: |
        A plan has specs in its content
      when: |
        kspec plan derive @plan-ref --module @mod is run
        (no --tasks flag)
      then: |
        Only specs are created. Tasks are not derived.
        This is the default behavior.
    - id: ac-additional-tasks
      given: |
        A plan document has additional_tasks in ## Tasks section
      when: |
        kspec plan derive @plan-ref --module @mod --tasks is run
      then: |
        Additional tasks are created with plan_ref, spec_ref
        (if specified), and depends_on mappings
    - id: ac-impl-notes-global
      given: |
        A plan document has ## Implementation Notes section
      when: |
        kspec plan derive @plan-ref --module @mod --tasks is run
      then: |
        Global implementation notes are stored as a note on the
        plan record
    - id: ac-impl-notes-per-spec
      given: |
        A plan spec has an implementation_notes field
      when: |
        kspec plan derive @plan-ref --module @mod --tasks is run
      then: |
        Per-spec implementation notes are stored as a note on
        the derived task for that spec
    - id: ac-status-transition
      given: |
        A plan in approved status is successfully derived
      when: |
        Derivation completes
      then: |
        Plan status transitions to active. derived_specs and
        derived_tasks arrays are updated with created refs.
    - id: ac-status-guard
      given: |
        A plan is in draft status
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        Command fails with EXIT_CODES.CONFLICT and message
        "Plan must be in approved status to derive"
    - id: ac-already-derived
      given: |
        A plan is already in active status (previously derived)
      when: |
        kspec plan derive @plan-ref is run
      then: |
        Command fails with EXIT_CODES.CONFLICT and message
        "Plan already derived. Manage specs directly via kspec item set."
    - id: ac-dry-run
      given: |
        A plan exists in approved status
      when: |
        kspec plan derive @plan-ref --module @mod --dry-run is run
      then: |
        Shows what specs and tasks would be created
        without making changes
    - id: ac-json-output
      given: |
        A plan is derived
      when: |
        kspec plan derive @plan-ref --module @mod --json is run
      then: |
        Output is JSON object with keys: plan_ref, created_specs,
        created_tasks, skipped, errors
    - id: ac-validation-errors
      given: |
        A plan spec is missing required fields (e.g., title)
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        Invalid specs are skipped with a warning. Valid specs
        are still created. Summary includes error count.
    - id: ac-root-trait
      given: |
        A plan spec has type "trait" with no parent
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        Trait is created as a root-level item (no parent) in the
        project's spec tree, accessible via @trait-slug references
    - id: ac-parent-unresolved
      given: |
        A plan spec references a parent that does not exist in the
        plan or in the project
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        The spec with the unresolved parent is skipped with a
        warning including the missing parent ref and a recovery
        hint. Other valid specs are still created.
    - id: ac-depends-on-unresolved
      given: |
        A plan spec has depends_on referencing a slug that does not
        exist in the plan or in the project
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        The spec is created with a warning about the unresolved
        dependency. The depends_on ref is stored as-is for later
        resolution.
    - id: ac-no-specs-content
      given: |
        A plan has content but no ## Specs section or no fenced
        YAML code block in the ## Specs section
      when: |
        kspec plan derive @plan-ref --module @mod is run
      then: |
        Command fails with EXIT_CODES.USAGE_ERROR and message
        "No specs found in plan content. Ensure ## Specs section
        contains a fenced YAML code block."
    - id: ac-bidirectional-links
      given: |
        A plan has been derived with specs and/or tasks
      when: |
        kspec task get @derived-task or kspec plan get @plan is run
      then: |
        Task displays plan_ref linking to the plan. Plan displays
        derived_specs and derived_tasks arrays listing created refs.
    - id: ac-priority-inheritance
      given: |
        A plan spec has a priority field (1-5) and --tasks is used
      when: |
        kspec plan derive @plan-ref --module @mod --tasks is run
      then: |
        Derived tasks inherit priority from their source spec.
        Specs without a priority field default to priority 3.
    - id: ac-commit
      given: |
        A plan is successfully derived
      when: |
        Derivation completes
      then: |
        All changes are auto-committed to shadow branch in a
        single commit
```

## Tasks

derive_from_specs: true

## Implementation Notes

### Plan Export

Add `plan export <ref>` subcommand to `src/cli/commands/plan.ts`.
- Output plan `content` field as-is (markdown) to stdout or `--output <path>`
- `--json` outputs structured plan data
- Error if content is empty

### Plan Import --into

Add `--into <ref>` option to the existing `plan import` command in `src/cli/commands/plan-import.ts`. When `--into` is provided:
1. Resolve the existing plan record
2. Check status guard (draft/approved allowed; active and terminal rejected)
3. Read the file content
4. Parse H1 heading as title update (if present)
5. Replace the plan's `content` field with the full document
6. Ignore `--update`, `--status`, `--module` flags with warning
7. Add auto-note: use `--reason` text if provided, otherwise default "Content updated from file"
8. Commit to shadow branch

`--module` is NOT required for `--into` since no specs are created.
`--dry-run` is supported to preview changes.
`--reason` follows the same pattern as `kspec task block --reason` — `plan set` should also support `--reason` using the same note structure, but that's outside this plan's scope.

### Plan Import → Content-Only Storage

In `src/cli/commands/plan-import.ts`:
1. Change `status: "active"` to `status: options.status || "draft"`
2. Add `--status <status>` option to the command definition
3. Remove all spec creation logic from import — import only creates the plan record with content
4. Remove all task derivation logic from import
5. `--module` becomes optional — if provided, stored on plan record for later derive
6. `--update` flag becomes a no-op with warning
7. Update affected @plan-import ACs to reference @plan-derive-enhanced

### Enhanced Plan Derive

In `src/cli/commands/plan.ts`, replace the current simple `derive` command:
1. Parse plan's `content` field using `parsePlanDocument()` (move from import)
2. Move all spec creation logic from `importPlan()` to derive:
   - Topological ordering (`topologicalSort`)
   - Parent resolution (local + existing refs)
   - Slug deduplication
   - Trait normalization
   - Dependency mapping
   - Validation error handling
3. Add `--module <ref>` option (required unless stored on plan record from import)
4. `--module` on derive overrides the stored value from import
5. Add `--tasks` flag to control task derivation (default: specs only)
6. Guard against re-derivation (active plan → error)
7. Add `--dry-run` and `--json` support
8. Remove old single-task derive behavior

The key refactoring is extracting `importPlan()`'s spec/task creation into a shared `materializePlanContent()` function that both the legacy code path and the new derive command can use during the transition.

### AC Migration — @plan-import

The `plan-import-content-only` spec supersedes most of `@plan-import`'s ACs, but several stay on import (possibly modified) and others move to `plan-derive-enhanced`. This table is the authoritative mapping.

| AC | Summary | Fate | New location / notes |
|----|---------|------|---------------------|
| ac-11 | Parse specs from YAML | **Moves to derive** | `plan-derive-enhanced` ac-parse-content |
| ac-12 | Auto-derive tasks from specs | **Moves to derive** | `plan-derive-enhanced` ac-tasks-flag |
| ac-13 | Implementation notes (per-spec + global) | **Moves to derive** | `plan-derive-enhanced` ac-impl-notes-global, ac-impl-notes-per-spec |
| ac-14 | Skip existing slug with warning | **Moves to derive** | `plan-derive-enhanced` ac-slug-dedup (enhanced: appends suffix instead of skipping) |
| ac-15 | `--dry-run` shows what would be created | **Stays on import (modified)** | Dry-run shows plan record that would be created (no spec/task preview) |
| ac-16 | Topological sort for parent refs | **Moves to derive** | `plan-derive-enhanced` ac-topo-sort |
| ac-17 | Missing parent error + skip | **Moves to derive** | `plan-derive-enhanced` ac-parent-unresolved |
| ac-18 | Circular parent reference error | **Moves to derive** | `plan-derive-enhanced` ac-circular-dep |
| ac-19 | Derived tasks have spec_ref + plan_ref | **Moves to derive** | `plan-derive-enhanced` ac-task-refs |
| ac-20 | Derived task title "Implement \<spec title\>" | **Moves to derive** | `plan-derive-enhanced` ac-tasks-flag |
| ac-21 | Malformed YAML error with line number | **Moves to derive** | `plan-derive-enhanced` ac-validation-errors |
| ac-22 | Missing title field error | **Moves to derive** | `plan-derive-enhanced` ac-validation-errors |
| ac-23 | Partial success (3 created, 2 errors) | **Moves to derive** | `plan-derive-enhanced` ac-validation-errors |
| ac-24 | Plan created with `status: active` | **Modified** | `plan-import-content-only` ac-draft-default (now `draft`) |
| ac-25 | Re-import skips existing specs | **Obsolete** | Content-only import doesn't create specs; duplicate plan slug detection is separate (plan-crud ac-1) |
| ac-26 | `--update` modifies existing specs | **Obsolete** | `--update` becomes no-op with warning per `plan-import-content-only` ac-update-ignored |
| ac-27 | Additional tasks in Tasks section | **Moves to derive** | `plan-derive-enhanced` ac-additional-tasks |
| ac-28 | Plan reference resolution | **Stays on import** | Unrelated to spec creation — plan record still resolves via ReferenceIndex |
| ac-29 | Partial error handling (5 specs, 2 errors) | **Moves to derive** | `plan-derive-enhanced` ac-validation-errors |
| ac-32 | `--json` output | **Stays on import (modified)** | JSON output shape changes — no `specs`/`tasks` keys, just plan record fields |
| ac-33 | Missing parent error guidance | **Moves to derive** | `plan-derive-enhanced` ac-parent-unresolved (includes recovery hint; trait @trait-error-guidance) |
| ac-34 | Missing YAML block warning | **Moves to derive (behavior change)** | `plan-derive-enhanced` ac-no-specs-content (was warning + 0 results, now USAGE_ERROR) |
| ac-35 | `depends_on` mapping | **Moves to derive** | `plan-derive-enhanced` ac-depends-on |
| ac-36 | Priority inheritance to tasks | **Moves to derive** | `plan-derive-enhanced` ac-priority-inheritance |
| ac-37 | YAML quoting diagnostics | **Moves to derive** | `plan-derive-enhanced` ac-validation-errors |

### AC Migration — @plan-derive

`plan-derive-enhanced` replaces the existing `@plan-derive` spec entirely.

| AC | Summary | Fate | Notes |
|----|---------|------|-------|
| ac-5 | Single-task derivation + status transition | **Superseded** | `plan-derive-enhanced` ac-parse-content, ac-status-transition (now creates specs, optionally tasks) |
| ac-6 | Bidirectional link display | **Moves to derive-enhanced** | `plan-derive-enhanced` ac-bidirectional-links |

### Migration

Existing plans imported under the old behavior (status: active, specs/tasks already created) are unaffected — they already went through the full lifecycle. The new behavior only applies to future imports.

For the transition period:
- `plan import` stops creating specs/tasks (breaking change)
- `plan derive` defaults to specs-only (no `--tasks`) — this reverses the current import behavior where `derive_from_specs: true` auto-created tasks. Users must explicitly pass `--tasks` to derive tasks.
- Users who relied on the old import-and-materialize flow should use `plan import` then `plan derive --module @mod --tasks`
- Consider logging a deprecation notice for one release cycle
- Update AGENTS.md workflow documentation and the /kspec:plan skill

**Supersession details:** Spec/task creation ACs move from @plan-import to @plan-derive-enhanced. ACs that stay on import (modified): ac-15 (dry-run), ac-28 (reference resolution), ac-32 (JSON output). ACs made obsolete: ac-25, ac-26. See AC Migration tables above for the complete mapping.

### Shadow Branch History

Since all plan mutations auto-commit to shadow branch, `git log` and `git diff` on `.kspec/project.plans.yaml` provide version history. A future `kspec plan history @ref` or `kspec plan diff @ref` could surface this but is not needed for initial iteration.
