# Init, Setup, and Upgrade Rough Edges

## Specs

```yaml
- title: Idempotent File Scaffolding Trait
  slug: trait-idempotent-file-scaffold
  type: trait
  parent: "@agent-integration"
  description: |
    A scaffolding step that creates a file or writes to a
    managed block inside a file on disk follows a uniform set
    of rules so users can predict its behavior without reading
    its implementation: the target file is never modified
    unless the force flag is set; when force is set, the
    existing file is backed up to a sibling path before being
    replaced and the backup path is reported in the step's
    output; the step is safe to re-run and produces the same
    visible result on the second run as the first when no
    inputs changed; the step always reports its action
    (created, skipped, force-recreated) in a stable format
    consumable by the setup summary; and the step never
    destroys user content outside the file it owns.

    Scope: this trait applies only to scaffolding that writes
    files on disk. Scaffolds that create meta-spec items
    (agents, conventions, hooks, modules) have different force
    semantics — they use first-run-only creation with
    "reseed missing items only" on force — and must not
    inherit this trait.
  acceptance_criteria:
    - id: ac-existing-file-preserved-without-force
      given: |
        A file scaffold step's target file already exists
      when: |
        The step runs without the force flag
      then: |
        The existing file is preserved byte-for-byte and
        the step reports "skipped"
    - id: ac-force-backs-up-before-overwrite
      given: |
        A file scaffold step's target file already exists and
        the step is invoked with the force flag
      when: |
        The step runs
      then: |
        The previous content is preserved as a sibling backup
        with a timestamped name, the backup path is reported
        before the overwrite, and only then is the file
        replaced with a freshly scaffolded template
    - id: ac-fresh-file-creation
      given: |
        A file scaffold step's target file does not exist
      when: |
        The step runs with or without the force flag
      then: |
        The file is created and the step reports "created"
    - id: ac-step-reports-action
      given: |
        Any file scaffold step completes
      when: |
        The setup summary is produced
      then: |
        The step's action (created, skipped, force-recreated)
        and any backup path are included in the summary in a
        stable format

- title: Scaffolded Project Config File
  slug: scaffolded-project-config
  type: requirement
  parent: "@agent-integration"
  traits:
    - "@trait-idempotent-file-scaffold"
    - "@trait-error-guidance"
  description: |
    When a project is initialized with full setup, a project config
    file is scaffolded at the project root with placeholder values
    for the knobs that real projects are expected to customize.
    The scaffolded file uses only documented config keys, is valid
    on first load, and marks itself visibly as a template that the
    user should review.
  acceptance_criteria:
    - id: ac-file-scaffolded
      given: |
        A project has no project config file at its root
      when: |
        The project is initialized with full setup
      then: |
        A project config file is created at the project root
    - id: ac-file-valid-on-load
      given: |
        A scaffolded project config file has just been written
      when: |
        The config is loaded by any kspec command
      then: |
        The file parses successfully and produces the same resolved
        configuration as an empty config would, so scaffolding does
        not change runtime behavior
    - id: ac-placeholder-publication-mode
      given: |
        A scaffolded project config file is written
      when: |
        The file contents are inspected
      then: |
        The dispatch publication mode key is present with a
        default value and an adjacent comment naming the other
        accepted values
    - id: ac-placeholder-base-branch
      given: |
        A scaffolded project config file is written
      when: |
        The file contents are inspected
      then: |
        The dispatch base branch key is present with a resolved
        value taken from the current repository's default branch
    - id: ac-placeholder-coverage
      given: |
        A scaffolded project config file is written
      when: |
        The file contents are inspected
      then: |
        The coverage scan paths key is present as a commented-out
        example with sample paths, so users know the knob exists
        without forcing a choice at init time
    - id: ac-file-exists-preserved
      given: |
        A project already has a project config file at its root
      when: |
        The project is re-initialized or setup is re-run without
        the force flag
      then: |
        The existing file is preserved byte-for-byte
    - id: ac-file-force-overwrites
      given: |
        A project already has a project config file and setup is
        invoked with the force flag
      when: |
        Setup runs
      then: |
        The existing file is replaced with a freshly scaffolded
        template
    - id: ac-file-force-backup
      given: |
        A project already has a project config file and setup is
        invoked with the force flag
      when: |
        Setup overwrites the existing file
      then: |
        The previous content is preserved as a sibling backup
        file whose path is reported in the setup output

- title: Complete Auto-Generated Gitignore Entries
  slug: complete-auto-gitignore
  type: requirement
  parent: "@init-commands"
  traits:
    - "@trait-idempotent-file-scaffold"
  description: |
    When a project is initialized, the gitignore file at the
    project root contains entries for every transient directory
    that kspec commands can create under the project root,
    including any that are created lazily by later commands.
    No kspec-created directory should ever appear as untracked
    content after an init on a clean repository.
  acceptance_criteria:
    - id: ac-all-transient-paths-present
      given: |
        A fresh project is initialized
      when: |
        The gitignore file at the project root is inspected
      then: |
        Every directory that kspec commands are able to create
        under the project root for transient state (shadow
        worktrees, worktree pools, session storage, inbox
        scratch, plan drafts) is listed
    - id: ac-no-untracked-after-common-commands
      given: |
        A fresh project is initialized
      when: |
        A representative set of commands that create transient
        state has been run and git status is inspected
      then: |
        No kspec-created directory appears as untracked content
    - id: ac-existing-entries-preserved
      given: |
        A project has an existing gitignore file with entries
        unrelated to kspec
      when: |
        Init adds kspec entries
      then: |
        Existing non-kspec entries are preserved unchanged
    - id: ac-kspec-entries-idempotent
      given: |
        A project has an existing gitignore file that already
        contains some kspec-managed entries
      when: |
        Init runs on the project
      then: |
        Adding kspec entries is idempotent and produces no
        duplicate lines

- title: Default Project Agents and Conventions
  slug: default-project-agents-and-conventions
  type: requirement
  parent: "@agent-integration"
  description: |
    When a project is initialized with full setup for the first
    time, the meta spec is seeded with a complete set of default
    agents covering task work, code review, general development,
    and plan review, plus baseline conventions for commits,
    architecture, and testing. Every default agent has write
    authorization enabled unconditionally so agents can operate
    without per-action approval. These defaults establish the
    minimum context every project needs for normal task work,
    code review, and plan review to function out of the box.
    After the initial seed, the scaffold never recreates items
    the user has deliberately removed or renamed — the scaffold
    is first-time-only state, not a recurring reset.

    This spec is the single source of truth for the default
    agent roster. Older specs that describe individual scaffold
    agents by name are superseded by this one, and their tests
    are re-annotated against the acceptance criteria below.
  acceptance_criteria:
    - id: ac-task-worker-agent
      given: |
        A fresh project completes full setup
      when: |
        The meta spec agents are listed
      then: |
        A task worker agent is present with dispatch rules that
        respond to task ready and task needs-work events, uses
        the automation eligibility filter by default, and has
        write authorization enabled
    - id: ac-pr-reviewer-agent
      given: |
        A fresh project completes full setup
      when: |
        The meta spec agents are listed
      then: |
        A code review agent is present with a dispatch rule that
        responds to task pending-review events and has write
        authorization enabled
    - id: ac-primary-dev-agent
      given: |
        A fresh project completes full setup
      when: |
        The meta spec agents are listed
      then: |
        A primary development agent is present with capabilities
        covering code, test, refactor, and review, and has
        write authorization enabled
    - id: ac-plan-reviewer-agent
      given: |
        A fresh project completes full setup
      when: |
        The meta spec agents are listed
      then: |
        A plan reviewer agent is present with the review
        capability and has write authorization enabled
    - id: ac-plan-reviewer-agent-skills
      given: |
        A scaffolded plan reviewer agent exists
      when: |
        The agent's skills are listed
      then: |
        The plan review skill and the writing specs skill are
        both attached to the agent
    - id: ac-plan-reviewer-adapter-guidance
      given: |
        A plan reviewer agent is scaffolded
      when: |
        The agent definition is inspected
      then: |
        The agent definition includes enough inline guidance for
        a new user to switch adapters without reading external
        documentation
    - id: ac-all-defaults-write-authorized
      given: |
        A fresh project completes full setup
      when: |
        Each scaffolded default agent's write authorization
        setting is inspected
      then: |
        Every default agent has write authorization enabled
        unconditionally, with no per-action approval gating
    - id: ac-commits-convention
      given: |
        A fresh project completes full setup
      when: |
        The meta spec conventions are listed
      then: |
        A commits convention exists with rules covering commit
        message format and task reference style
    - id: ac-architecture-convention
      given: |
        A fresh project completes full setup
      when: |
        The meta spec conventions are listed
      then: |
        An architecture convention exists with a placeholder rule
        that instructs the user to replace it with real project
        constraints
    - id: ac-testing-convention
      given: |
        A fresh project completes full setup
      when: |
        The meta spec conventions are listed
      then: |
        A testing convention exists with a placeholder rule that
        instructs the user to replace it with real project
        testing expectations
    - id: ac-agents-md-reflects-defaults
      given: |
        A fresh project completes full setup
      when: |
        The auto-generated agent instructions file is inspected
      then: |
        The file reflects the scaffolded default agents and
        conventions without requiring a separate regenerate step
    - id: ac-first-run-marker-written
      given: |
        A fresh project completes full setup
      when: |
        The setup seeding state is inspected
      then: |
        A first-run marker is recorded indicating that the
        default agents and conventions scaffold has completed
    - id: ac-removed-defaults-not-recreated
      given: |
        A project has previously completed first-run seeding
        and the user has removed one or more of the scaffolded
        default agents or conventions
      when: |
        Setup runs again without the force flag
      then: |
        The removed items are not recreated and the step
        reports them as intentionally removed
    - id: ac-renamed-defaults-preserved
      given: |
        A project has previously completed first-run seeding
        and the user has changed the identifier of a scaffolded
        default agent or convention
      when: |
        Setup runs again without the force flag
      then: |
        The renamed item is preserved unchanged and no new
        item is created under the original scaffold identifier
    - id: ac-force-reseed
      given: |
        A project has previously completed first-run seeding
      when: |
        Setup runs with the force flag
      then: |
        The scaffold re-seeds any missing default items and
        reports each one as force-recreated, leaving existing
        items (including renamed ones) untouched

- title: Default Session Reflection Hook
  slug: default-session-reflection-hook
  type: requirement
  parent: "@agent-integration"
  description: |
    When a project is initialized with full setup, a single
    reflection hook is scaffolded that fires on any idle agent
    session regardless of which agent owns it, and prompts the
    session to run the reflect skill. Reflection applies to
    every session uniformly so setup does not need to enumerate
    individual agents. Users may disable or remove the hook
    without breaking any other setup invariant.
  acceptance_criteria:
    - id: ac-reflection-hook-present
      given: |
        A fresh project completes full setup
      when: |
        The hook list is inspected
      then: |
        A single reflection hook is present that fires on the
        session idle event for every agent session, with no
        per-agent filter, and prompts the session to run the
        reflect skill
    - id: ac-hook-idempotent
      given: |
        A project already has the default reflection hook
      when: |
        Setup is re-run
      then: |
        The existing hook is preserved and no duplicate hook
        is created
    - id: ac-hook-removable
      given: |
        A user removes the default reflection hook
      when: |
        Setup is re-run without the force flag
      then: |
        The removed hook is not silently recreated

- title: Derivable Default Module
  slug: derivable-default-module
  type: requirement
  parent: "@init-commands"
  description: |
    When a project is initialized, the default module that init
    creates is a referenceable module item that plan derivation
    can target without requiring the user to create a separate
    module first. A user can import and derive a plan on a fresh
    project without any intermediate meta commands.
  acceptance_criteria:
    - id: ac-default-module-resolvable
      given: |
        A fresh project has just been initialized
      when: |
        The default module is queried by its reference
      then: |
        The module resolves to a real module item with a title,
        slug, and description
    - id: ac-plan-derive-accepts-default
      given: |
        A fresh project has a plan imported and approved
      when: |
        The plan is derived and targets the default module
      then: |
        Derivation succeeds without the user having to create a
        module first
    - id: ac-default-module-editable
      given: |
        The default module exists
      when: |
        The user sets its title, slug, or description
      then: |
        The changes persist and subsequent derivations continue
        to target the same module

- title: Plan Document Format Error Guidance
  slug: plan-import-format-guidance
  type: requirement
  parent: "@plan-support"
  traits:
    - "@trait-error-guidance"
    - "@trait-semantic-exit-codes"
    - "@trait-json-output"
  description: |
    Plan import is tolerant of documents that have no specs or
    tasks yet (planning content is allowed to land before the
    structured work has been written), but is strict about
    structural invariants that downstream commands rely on:
    the title must be extractable, and any specs or acceptance
    criteria that are present must match the expected shape.
    An imported plan with no specs or tasks surfaces a visible
    warning so the user knows content is still missing, and
    plan derive refuses to run against a plan that has no
    derivable work. Errors and warnings are self-contained —
    users can correct the input without reading source or
    external documentation.
  acceptance_criteria:
    - id: ac-missing-title-fails-import
      given: |
        A plan document whose first significant element is not a
        top-level heading
      when: |
        The document is imported
      then: |
        The import fails with an error that identifies the
        expected title location and the structural form the
        parser recognizes
    - id: ac-empty-plan-import-warns
      given: |
        A plan document with a valid title but neither a specs
        section nor a tasks section containing any derivable
        work
      when: |
        The document is imported
      then: |
        The import succeeds, the plan is stored as content,
        and a warning is reported that names both expected
        sections and explains that derive will not run until
        at least one is populated
    - id: ac-empty-plan-derive-fails
      given: |
        A plan was imported with no specs and no tasks
      when: |
        Plan derive is invoked for that plan
      then: |
        Derive fails with a non-zero exit code and an error
        that names the expected sections, explains that the
        plan has no derivable work, and points the user at
        the import command to update the plan's content
    - id: ac-ac-shape-mismatch-fails-import
      given: |
        A plan document where an acceptance criterion is not
        expressed in the expected shape
      when: |
        The document is imported
      then: |
        The import fails with an error that locates the
        malformed criterion by its containing spec and its
        position within that spec
    - id: ac-ac-shape-mismatch-describes-shape
      given: |
        A plan document's acceptance criterion fails shape
        validation
      when: |
        The import error is displayed
      then: |
        The error message enumerates every required field of
        an acceptance criterion with a one-line description
        of each field's purpose
    - id: ac-help-describes-format
      given: |
        A user queries help for the plan import command
      when: |
        The help output is displayed
      then: |
        The output includes a minimal runnable example of a plan
        document and names every required structural element
    - id: ac-error-no-external-references
      given: |
        Any import error, derive error, or empty-plan warning
        from this spec is surfaced
      when: |
        The message is displayed
      then: |
        The message is self-contained and does not require the
        user to consult skills, README files, or source code to
        correct the input

- title: Single-Command Version Upgrade
  slug: single-command-version-upgrade
  type: requirement
  parent: "@agent-integration"
  traits:
    - "@trait-error-guidance"
    - "@trait-semantic-exit-codes"
    - "@trait-dry-run"
    - "@trait-json-output"
  description: |
    A dedicated upgrade command brings a project from any
    previously-supported kspec version to the currently
    installed version in a single invocation. The command
    detects version skew, runs all required migrations,
    re-renders skills, regenerates agent instructions, and
    reports the net result. The upgrade is idempotent and safe
    to run when the project is already current.
  acceptance_criteria:
    - id: ac-detects-skew
      given: |
        A project was initialized with an older kspec version
        and its last-known version is recorded in project state
      when: |
        The upgrade command runs
      then: |
        The command reads the recorded last-known version and
        identifies it as the source version for the upgrade
    - id: ac-source-version-fallback
      given: |
        A project has no recorded last-known version
      when: |
        The upgrade command runs
      then: |
        The command infers a source version from the shape of
        project state and records it with approximate confidence
    - id: ac-source-version-unknown
      given: |
        A project's source version cannot be identified or
        inferred
      when: |
        The upgrade command runs
      then: |
        The command reports the source version as unknown,
        names the target version, and proceeds with the full
        upgrade pipeline as if the project were on the oldest
        supported version
    - id: ac-reports-skew
      given: |
        The upgrade command has determined source and target
        versions
      when: |
        The command begins its upgrade pipeline
      then: |
        The command reports the source version and the target
        version before any changes are applied, and marks the
        source as approximate or unknown when it was inferred
        rather than read directly
    - id: ac-runs-task-storage-migration
      given: |
        A project uses a task storage format that is no longer
        current
      when: |
        The upgrade command runs
      then: |
        The task storage migration is run as part of the upgrade
        and reports whether any tasks were migrated
    - id: ac-rerenders-skills
      given: |
        A project has skill files rendered from a previous
        version of the skill templates
      when: |
        The upgrade command runs
      then: |
        Core skills are re-rendered so the rendered files match
        the currently installed version and obsolete rendered
        skills that no longer exist in the current version are
        removed
    - id: ac-regenerates-agents-file
      given: |
        A project has an auto-generated agent instructions file
        from a previous version
      when: |
        The upgrade command runs
      then: |
        The auto-generated agent instructions file is
        regenerated against the current templates
    - id: ac-restores-gitignore-entries
      given: |
        A project is missing one or more kspec gitignore entries
        that are now required
      when: |
        The upgrade command runs
      then: |
        Missing entries are appended to the gitignore and the
        change is reported
    - id: ac-idempotent-when-current
      given: |
        A project is already at the current version with no
        drift
      when: |
        The upgrade command runs
      then: |
        The command completes successfully, reports that no
        changes were necessary, and makes no modifications to
        the project
    - id: ac-reports-manual-follow-ups
      given: |
        The upgrade applies changes that a user should review
        (such as a scaffolded or updated config file, new
        default agents, or new gitignore entries)
      when: |
        The upgrade completes
      then: |
        The command reports each applied change with enough
        context for the user to decide whether additional
        manual follow-up is needed
    - id: ac-dry-run-reports
      given: |
        A user wants to preview an upgrade without making
        changes
      when: |
        The upgrade command runs with the dry-run flag
      then: |
        Every change the pipeline would apply is reported in
        the same format as a real upgrade run
    - id: ac-dry-run-no-writes
      given: |
        The upgrade command is running with the dry-run flag
      when: |
        The command completes
      then: |
        No filesystem modifications have been made at the
        project root and no shadow branch commits have been
        created

- title: Release Notes Accessible via CLI
  slug: release-notes-accessible
  type: requirement
  parent: "@agent-integration"
  traits:
    - "@trait-error-guidance"
    - "@trait-semantic-exit-codes"
  description: |
    Users can view the release notes for the currently installed
    version and any intervening versions without leaving the
    command line. Release notes live in a single project file
    that is the source of truth for human readers and the CLI
    alike, and the upgrade command surfaces the relevant slice
    of that file as part of its output. The file format is
    chosen and documented in the release skill so authoring
    and CLI consumption stay in sync.
  acceptance_criteria:
    - id: ac-current-version-notes
      given: |
        A user wants to know what changed in the currently
        installed version
      when: |
        The user runs the release notes command without
        arguments
      then: |
        The release notes for the currently installed version
        are displayed
    - id: ac-version-range-notes
      given: |
        A user wants to know what changed between two versions
      when: |
        The user runs the release notes command with a from and
        to version
      then: |
        The release notes for each version in the inclusive
        range are displayed in chronological order
    - id: ac-upgrade-surfaces-notes
      given: |
        The upgrade command upgrades a project from one version
        to another
      when: |
        The upgrade reports its result
      then: |
        The release notes for every intervening version are
        included in the output
    - id: ac-notes-mention-new-config
      given: |
        A version introduced new configuration keys
      when: |
        The release notes for that version are displayed
      then: |
        The notes name every new configuration key and describe
        what it controls

- title: Doctor Reports Actionable State
  slug: doctor-reports-actionable-state
  type: requirement
  parent: "@enhanced-setup"
  traits:
    - "@trait-error-guidance"
    - "@trait-semantic-exit-codes"
  description: |
    The doctor command reports the real state of the project
    without false positives and without warnings that the user
    has no way to act on. Every warning and error is paired with
    a concrete command or action that resolves it, and every
    check looks at the location where the checked artifact
    actually lives. Doctor is the single source of truth for
    whether a project is ready for normal work.
  acceptance_criteria:
    - id: ac-skills-check-accurate
      given: |
        A project has rendered skill files in the locations
        currently used by the setup command
      when: |
        Doctor runs
      then: |
        The skills check reports the rendered skills as present
        and does not emit a warning about missing rendered
        skills
    - id: ac-skills-check-missing
      given: |
        A project has no rendered skill files in any supported
        location
      when: |
        Doctor runs
      then: |
        The skills check reports the rendered skills as missing
        and names the command that re-renders them
    - id: ac-config-scaffold-detected
      given: |
        A project is missing the scaffolded project config file
      when: |
        Doctor runs
      then: |
        A warning identifies the missing file and names the
        command that scaffolds it
    - id: ac-version-skew-detected
      given: |
        A project was initialized with an older kspec version
        and has not been upgraded
      when: |
        Doctor runs
      then: |
        A warning identifies the version skew and names the
        upgrade command
    - id: ac-all-actionable
      given: |
        Any doctor output is produced
      when: |
        A warning or error is displayed
      then: |
        The message includes a concrete command or action the
        user can run to resolve the condition

- title: Meta Set Multi-Value Option Parity
  slug: meta-set-multi-value-parity
  type: requirement
  parent: "@meta"
  traits:
    - "@trait-error-guidance"
    - "@trait-shadow-commit"
  description: |
    Multi-value options on meta item update commands accept
    repeated flags and preserve every value supplied. The set
    and add-item flows behave identically for repeated flags so
    users can update a meta item with the same mental model they
    used to create it.
  acceptance_criteria:
    - id: ac-repeated-add-rule-all-kept
      given: |
        A meta convention exists
      when: |
        The set command is invoked with multiple add-rule flags
        in a single call
      then: |
        Every supplied rule is appended to the convention's
        rules and none are dropped
    - id: ac-repeated-add-skill-all-kept
      given: |
        A meta agent exists
      when: |
        The set command is invoked with multiple add-skill flags
        in a single call
      then: |
        Every supplied skill is added to the agent's skills and
        none are dropped
    - id: ac-repeated-add-capability-all-kept
      given: |
        A meta agent exists
      when: |
        The set command is invoked with multiple add-capability
        flags in a single call
      then: |
        Every supplied capability is added to the agent and
        none are dropped
    - id: ac-remove-flags-unchanged
      given: |
        A meta item has multiple values for a repeatable field
      when: |
        The set command is invoked with repeated remove-value
        flags
      then: |
        Every named value is removed and values not named are
        preserved
    - id: ac-mixed-add-and-remove
      given: |
        A meta item is updated in a single call with a mix of
        repeated add and remove flags
      when: |
        The set command completes
      then: |
        The resulting item reflects all adds and removes applied
        in a consistent order
```

## Tasks

derive_from_specs: false

```yaml
- title: Scaffold project config file during init setup
  slug: task-scaffold-project-config
  priority: 1
  tags: [init, setup, config]
  spec_ref: "@scaffolded-project-config"
  description: |
    Write a project config file at the project root as part of
    the setup step that runs during init, using resolved defaults
    and commented placeholders for knobs that real projects are
    expected to customize.

    Why: New projects consistently need the same config file with
    the same shape, but currently every project author writes it
    by hand. Scaffolding it once during setup removes an entire
    class of first-day friction and eliminates silent dispatch
    breakage from a missing file.

    What:
    - Add a setup step that runs after the existing skill
      rendering step and before the existing agents file
      generation step.
    - The step writes a project config file at the project root
      with the following content:
      * A dispatch section containing publication_mode set to
        manual_merge, with an adjacent comment listing the other
        accepted values from the dispatch publication mode schema.
      * A dispatch section containing base_branch resolved from
        the current repository's default branch (detect via the
        same helper the dispatcher uses to resolve a default
        base; if detection fails, use the literal string "main"
        and comment that the value was a fallback).
      * A commented-out coverage section showing scan_paths as a
        list example with one or two sample paths, with a
        comment explaining that uncommenting enables AC coverage
        scanning.
      * A top-of-file comment identifying the file as a
        scaffolded template and instructing the user to review it.
    - The step must be idempotent: if the file already exists
      and the force flag is not set, the step is reported as
      skipped with a reason.
    - When the force flag is set and the file exists, back up
      the existing content to a sibling file with a timestamped
      extension and report the backup path before writing the
      fresh template.
    - Validate the scaffolded file by running it through the
      existing config loader in the same invocation; if loading
      fails the setup step must fail loudly rather than leaving
      a broken file.
    - The step must appear in the setup summary output with the
      same format as existing steps.

    How: The existing setup pipeline lives in the setup command
    under src/cli/commands/setup.ts. Add a new step function
    next to the existing skill rendering and agents file
    generation steps, register it in the pipeline ordering, and
    reuse the existing step result reporting helper so output
    formatting matches. The config schema and loader live under
    src/parser/config.ts; reuse its loader for the validation
    check. Default branch resolution is already used by the
    dispatch workspace resolver under src/agent-runtime; reuse
    its helper rather than reimplementing it.

    Testing: Unit tests for the step function covering the
    fresh-project path, the existing-file skip path, and the
    force-overwrite-with-backup path. Integration test that
    runs init with setup on a fresh temp directory and asserts
    the scaffolded file exists, is valid on load, and contains
    the documented keys. Fixture test that an empty project
    with only the scaffolded file behaves identically to a
    project with no config file at all.

    Covers: @scaffolded-project-config ac-file-scaffolded,
    ac-file-valid-on-load, ac-placeholder-publication-mode,
    ac-placeholder-base-branch, ac-placeholder-coverage,
    ac-file-exists-preserved, ac-file-force-overwrites,
    ac-file-force-backup.

- title: Expand and repair auto-generated gitignore entries
  slug: task-complete-gitignore
  priority: 1
  tags: [init, setup, git]
  spec_ref: "@complete-auto-gitignore"
  description: |
    Make the init gitignore writer enumerate every transient
    directory kspec can create under the project root, and
    ensure a repair path runs during setup to add any missing
    entries on existing projects.

    Why: The current gitignore writer misses at least one
    transient directory that is created lazily by later commands,
    which causes untracked content to appear after normal task
    work. Also, existing projects need a non-destructive way to
    get the missing entries added on upgrade.

    What:
    - Build a single canonical list of transient directories
      that kspec may create at the project root, sourced from
      the constants used by the commands that create them (for
      example: shadow worktree path, worktree pool root, session
      storage path, plan drafts path). The list must be a
      shared constant, not duplicated inline in init.
    - Update the init gitignore writer to append every entry in
      the canonical list idempotently, preserving any existing
      user-authored content above or below the managed block.
    - Use a managed-block marker pair (start and end sentinel
      lines) so the setup step can detect and update the
      managed block without touching user content outside it.
    - Add a setup step that runs on every invocation (not just
      init) and appends any missing entries from the canonical
      list, reporting which entries were added.
    - Never remove entries a user added manually, even if they
      fall inside the managed block.
    - When the managed block is absent on an existing project,
      create it at the end of the file with all canonical
      entries and report that the block was created.

    How: The existing gitignore writing logic lives in
    src/cli/commands/init.ts. Extract the entry list to a shared
    constant alongside the existing path constants used by the
    commands that create transient directories. Add the managed
    block marker handling (a small helper that parses, updates,
    and serializes the block). Register the setup step in the
    pipeline so it runs during init with setup and during
    standalone setup invocations.

    Testing: Unit tests for the managed block parser covering:
    no existing block, existing block with same entries,
    existing block with fewer entries, user content interleaved
    above and below the block. Integration test that runs init
    on a fresh project, then runs commands that create each
    transient directory, and asserts git status reports no
    untracked content. Test that user entries outside the
    managed block are never touched.

    Covers: @complete-auto-gitignore ac-all-transient-paths-present,
    ac-no-untracked-after-common-commands,
    ac-existing-entries-preserved, ac-kspec-entries-idempotent.

- title: Scaffold default project agents and conventions
  slug: task-default-agents-and-conventions
  priority: 1
  tags: [init, setup, meta]
  spec_ref: "@default-project-agents-and-conventions"
  description: |
    During init setup, scaffold the full default agent roster
    (task worker, code reviewer, primary development agent, plan
    reviewer) and baseline conventions for commits, architecture,
    and testing into the meta spec. Every scaffolded agent has
    write authorization enabled unconditionally. The scaffold
    runs once per project and persists a first-run marker so
    subsequent setup runs do not resurrect items the user has
    removed or renamed.

    Why: Every real project manually adds these same defaults
    immediately after init, and restricted-mode authorization is
    not a supported execution path today — agents that cannot
    write cannot do useful work. Scaffolding the full roster
    with write authorization enabled removes repetitive
    boilerplate, ensures task dispatch, code review, and plan
    review work out of the box, and gives the auto-generated
    agent instructions file something to render from the first
    time it runs. The first-run marker is what prevents the
    scaffold from becoming a recurring reset that fights the
    user. This task supersedes the older ralph-replacement
    acceptance criteria for worker and reviewer scaffolding;
    tests that covered those criteria must be re-annotated to
    the acceptance criteria on this spec rather than deleted.

    What:
    - Add a setup step that runs after the hook installation
      step and before the agents file generation step.
    - Read a first-run marker from the setup seeding state
      file (the same state file used by permission and memory
      seeding). The marker is a named flag indicating whether
      the default agents and conventions scaffold has ever
      completed for this project.
    - When the marker is absent (first run) the step creates
      the following meta items:
      * A task worker agent with a stable identifier, a
        descriptive name, write authorization enabled
        unconditionally, and dispatch rules that respond to
        task ready and task needs-work events with the
        automation eligibility filter set by default.
      * A code reviewer agent with a stable identifier, a
        descriptive name, write authorization enabled
        unconditionally, and a dispatch rule that responds to
        task pending-review events.
      * A primary development agent with a stable identifier,
        a descriptive name, capabilities for code, test,
        refactor, and review, and write authorization enabled
        unconditionally.
      * A plan reviewer agent with a stable identifier, a
        descriptive name, review capability, write
        authorization enabled unconditionally, and the plan
        review, writing specs, and plan skills attached.
      * A commits convention with two rules: one for commit
        message format and one for task reference style.
      * An architecture convention containing a single
        placeholder rule that explicitly instructs the user
        to replace it with project-specific rules.
      * A testing convention containing a single placeholder
        rule that explicitly instructs the user to replace it.
      After creation, the step writes the first-run marker
      and reports each created item in the setup summary.
    - Write authorization on every default agent must be set
      to the unconditional "always allow" setting. Restricted
      or per-action approval modes are not valid defaults for
      any scaffolded agent.
    - The plan reviewer agent's description must include
      inline guidance explaining how to switch adapters if
      the default adapter's authentication fails, using only
      commands and flags that exist in the CLI.
    - Any existing built-in agent scaffolding (for example,
      the ralph-replacement task worker and pr reviewer
      creation paths already present in the setup command)
      must be folded into this step rather than continuing
      to exist as a parallel code path. There must be exactly
      one scaffold site for default agents.
    - When the marker is present (subsequent run) the step
      does nothing and reports "defaults already seeded" with
      an itemized status that distinguishes between items
      that still exist, items that appear to have been
      removed by the user, and items that appear to have been
      renamed. Removed and renamed items are NEVER recreated
      in this mode; the step is a report-only no-op.
    - When setup is invoked with the force flag, the step
      treats force as "reseed missing items only": for each
      scaffold item whose original identifier no longer
      resolves and whose scaffold marker has not been
      explicitly cleared, recreate the item and report it as
      force-recreated. Items that resolve (including renamed
      ones) are never overwritten.
    - Items carry a scaffold-origin tag on creation so the
      subsequent-run detection can distinguish "user removed
      the scaffold default" from "user renamed the scaffold
      default to something else". The tag is a stable field
      on the meta item; use the existing meta item tag/trait
      field rather than inventing a new one.
    - After the step runs, invoke the existing agents file
      regeneration so the auto-generated instructions reflect
      the scaffolded defaults without requiring a separate
      command.

    How: The meta item creation pathway is exposed as library
    functions under src/parser/meta.ts; call those directly
    from the setup step rather than shelling out to the CLI.
    The setup seeding state file pattern is already used by
    permission seeding and memory seeding — add a new field
    to the same state file rather than creating a new file.
    The existing "ensure built-in agents" step in
    src/cli/commands/setup.ts currently creates the
    ralph-replacement task worker and pr reviewer; consolidate
    that logic into this step so there is one scaffold path,
    and re-annotate any tests previously asserting the
    ralph-replacement AC behavior to the new acceptance
    criteria on this spec. Scaffold-origin tagging uses the
    existing tag field on meta items; pick a reserved tag
    string (for example "scaffold-default") and document it.
    Rename detection walks the meta item list looking for
    items carrying the scaffold-origin tag whose identifier
    differs from any known scaffold default identifier.

    Testing: Unit tests for:
    - First-run path creates every default agent and
      convention, writes marker, verifies every agent has
      write authorization set to the unconditional value.
    - Second-run path with all items present: no-op.
    - Second-run path with one item removed: not recreated,
      reported as intentionally removed.
    - Second-run path with one item renamed: original id not
      recreated, renamed item preserved unchanged.
    - Force-reseed path with missing items: recreated and
      reported; existing items untouched.
    Integration test running init with setup on a fresh temp
    directory asserting the four expected agents and three
    expected conventions exist with the right shape, every
    agent has write authorization enabled, and the first-run
    marker is present. Follow-up integration test removing
    one default, running setup again, asserting the removed
    item stays removed. Re-annotate the existing
    ralph-replacement worker/reviewer scaffold tests onto the
    new ac-task-worker-agent and ac-pr-reviewer-agent
    acceptance criteria.

    Covers: @default-project-agents-and-conventions
    ac-task-worker-agent, ac-pr-reviewer-agent,
    ac-primary-dev-agent, ac-plan-reviewer-agent,
    ac-plan-reviewer-agent-skills,
    ac-plan-reviewer-adapter-guidance,
    ac-all-defaults-write-authorized, ac-commits-convention,
    ac-architecture-convention, ac-testing-convention,
    ac-agents-md-reflects-defaults, ac-first-run-marker-written,
    ac-removed-defaults-not-recreated,
    ac-renamed-defaults-preserved, ac-force-reseed.

- title: Scaffold default session reflection hook
  slug: task-default-reflection-hook
  priority: 2
  tags: [init, setup, hooks]
  spec_ref: "@default-session-reflection-hook"
  description: |
    During init setup, scaffold a single reflection hook that
    fires on any idle agent session (no per-agent filter) and
    prompts the session to run the reflect skill, so reflection
    runs out of the box for every agent.

    Why: Session reflection is valuable from the first session,
    but requires a hook that every project currently adds by
    hand. Treating reflection as a universal concern rather
    than a per-agent one removes the need to look up individual
    agent identifiers at scaffold time and simplifies the setup
    graph — the reflection hook no longer depends on the
    default agent scaffold running first.

    What:
    - Add a setup step that runs after the scaffold default
      agents and conventions step and before the agents file
      generation step.
    - Create one hook by identifier if it does not already
      exist: a reflection hook that fires on the session idle
      event, applies to every agent session (no agent filter),
      and prompts the session to run the reflect skill.
    - Do not create the hook if its identifier already exists
      in the hook list. Skip silently in that case and report
      it as an idempotency skip.
    - If the hook was previously created by this step and has
      since been removed by the user, the step must not
      recreate it. Detect this by checking for a marker field
      on the hook (a known tag or a deterministic identifier
      component) that only the scaffold writes, and by
      remembering that the scaffold previously completed. Use
      the existing setup seeding state file to persist the
      "scaffolded reflection hook" marker across invocations.

    How: Hook CRUD is exposed via library functions under
    src/parser/hooks.ts (or the equivalent module). Reuse the
    setup seeding state file pattern already used for permission
    seeding and memory seeding to record that the hook scaffold
    has run. The filter and action payloads are documented in
    the hook schema in src/schema/hook.ts; follow that schema
    exactly rather than shelling out to the CLI. The hook's
    agent filter must be empty or a wildcard so every session
    matches, not a list of named agents.

    Testing: Unit tests for create, idempotent skip, and
    removed-by-user non-recreation. Integration test running
    init with setup and asserting exactly one reflection hook
    exists with no agent filter. Test that removing the hook
    and re-running setup without force does not recreate it.

    Covers: @default-session-reflection-hook
    ac-reflection-hook-present, ac-hook-idempotent,
    ac-hook-removable.

- title: Make default module a referenceable item
  slug: task-derivable-default-module
  priority: 2
  tags: [init, modules, plans]
  spec_ref: "@derivable-default-module"
  description: |
    Turn the default module that init creates into a real
    referenceable module item so plan derivation can target it
    without requiring the user to create a module first.

    Why: On a fresh project, plan derive currently fails with
    "requires --module" because the file init creates is a
    placeholder list container, not a module item. This forces
    users to run an extra command before their first plan
    derive will work, which is exactly the kind of guesswork
    the release is trying to remove.

    What:
    - When init creates the default module placeholder, also
      create a real module meta item with a deterministic slug
      (for example, derived from the project name or a fixed
      "default" slug — pick one and document it), a title, and
      a description that explains it is the default module.
    - Preserve the existing placeholder file shape so that
      library code which expected it continues to work, but
      ensure the new module item is discoverable by the normal
      item lookup and is accepted by plan derive.
    - When the user edits the title, slug, or description of
      the default module, persist the edits through normal
      item set flows. Subsequent plan derive invocations that
      target the default module must follow the current slug.
    - When a project already has one or more user-created
      modules, init still creates the default module; a later
      setup invocation must not remove it unless the user
      explicitly removes it.
    - Document the default module's existence in the setup
      summary and in the init output.

    How: The default module file is created in
    src/cli/commands/init.ts; find the code that writes
    modules/main.yaml and augment it to also create a module
    item via the same library function that kspec module add
    uses (under src/parser/modules.ts or the equivalent). The
    plan derive module check lives in src/cli/commands/plan.ts
    under the derive handler — verify that the newly created
    item resolves through the same lookup path that kspec
    module add items do.

    Testing: Integration test that runs init on a fresh temp
    directory and asserts the default module item is
    resolvable by reference. End-to-end test that imports a
    plan, approves it, and runs derive targeting the default
    module without any intermediate module creation. Test
    that editing the default module's slug via item set
    persists and is visible to plan derive.

    Covers: @derivable-default-module ac-default-module-resolvable,
    ac-plan-derive-accepts-default, ac-default-module-editable.

- title: Actionable plan import format errors and empty-plan derive guard
  slug: task-plan-import-format-guidance
  priority: 2
  tags: [cli, plans]
  spec_ref: "@plan-import-format-guidance"
  description: |
    Make plan import strict about structural invariants
    (title, acceptance criterion shape), tolerant of plans
    that have no specs or tasks yet (warn instead of fail),
    and move the "no derivable work" failure to plan derive
    so empty-but-intentional plan content can land before
    the structured work is written.

    Why: Plan import currently silently accepts documents
    whose title cannot be extracted (importing them as
    "Untitled Plan") and fails later at derive time with
    cryptic schema errors. At the same time, users
    legitimately want to land a planning document that
    contains prose and links before any specs or tasks have
    been authored. The right split is: import stores content
    (and warns if the plan is empty); derive refuses to
    materialize anything when there is nothing to materialize.
    Users discover both conditions with self-contained
    messages.

    What:
    - Change plan import so that when the parser cannot
      extract a title from the document, the command fails
      with a non-zero exit code rather than importing as
      "Untitled Plan". The error message must name the
      expected structural form of the title (a top-level
      heading as the first significant element) and show a
      one-line example.
    - Change plan import so that a document with a valid
      title but neither a specs section nor a tasks section
      containing derivable work imports successfully with a
      warning. The warning must name both expected sections,
      explain that derive will fail until at least one is
      populated, and appear in normal and JSON output modes.
    - When an acceptance criterion fails schema validation,
      fail the import with an error that names the spec slug
      (or index if unslugged), names the failing criterion's
      identifier (or index), and lists every required field
      of an acceptance criterion with a brief description.
      Do not leak raw schema validator output.
    - Change plan derive so that a plan with no specs and no
      tasks fails with a non-zero exit code and a message
      that names both expected sections, explains the plan
      has no derivable work, and points the user at plan
      import to update the plan's content.
    - Extend the import command's help output to include a
      minimal runnable example of a plan document that uses
      all required structural elements (title, specs section
      with one spec, tasks section with derive directive).
      The example must be copy-pasteable.
    - Error and warning messages must never reference files
      outside the project (skills, README, docs) — everything
      needed to correct the input must be in the message
      itself.
    - The dry-run flow for import must produce the same
      errors and warnings as a real import so users can
      preflight their document.

    How: The parser entry point is parsePlanDocument in
    src/parser/plan-document.ts. Today the title extraction
    is best-effort; change it to required and propagate a
    typed error. Introduce a typed "empty plan" signal
    (not an error) that the import command translates into
    a warning. The import command handler lives in
    src/cli/commands/plan-import.ts and already consumes
    parser errors — route the new error types and warning
    signal to human messages there. The derive command
    handler lives in src/cli/commands/plan.ts under the
    derive subcommand; add the empty-plan guard check at
    the top of the handler so it fails before any shadow
    branch work begins. Help output is registered when the
    command is built; add the runnable example as a help
    text block.

    Testing: Unit tests for parser behavior covering: missing
    title, empty plan body, malformed acceptance criterion.
    CLI tests for import covering the title error (non-zero
    exit), empty plan warning (zero exit, warning captured),
    AC shape error (non-zero exit). CLI tests for derive
    covering the empty-plan failure (non-zero exit, actionable
    message). Snapshot test for import help output containing
    the runnable example. Test that dry-run import produces
    the same errors and warnings as a real import.

    Covers: @plan-import-format-guidance ac-missing-title-fails-import,
    ac-empty-plan-import-warns, ac-empty-plan-derive-fails,
    ac-ac-shape-mismatch-fails-import,
    ac-ac-shape-mismatch-describes-shape,
    ac-help-describes-format, ac-error-no-external-references.

- title: Implement single-command version upgrade
  slug: task-upgrade-command
  priority: 1
  tags: [cli, upgrade, setup]
  spec_ref: "@single-command-version-upgrade"
  depends_on:
    - "@task-scaffold-project-config"
    - "@task-complete-gitignore"
    - "@task-default-agents-and-conventions"
    - "@task-default-reflection-hook"
    - "@task-derivable-default-module"
  description: |
    Add an upgrade command that detects version skew between a
    project and the installed kspec version, runs all required
    migrations, re-renders skills, regenerates the auto-generated
    agent instructions file, repairs gitignore entries, and
    reports the net result.

    Why: Projects today go through silent breakage on upgrade
    because required migrations are run manually, rendered
    skills go stale without warning, and new defaults are not
    backfilled. A single upgrade command eliminates version
    skew as a failure mode.

    What:
    - Add a new top-level command named upgrade. It accepts no
      required arguments. It accepts a dry-run flag and a
      force flag.
    - Version detection pipeline:
      * Target version: read from the package manifest the CLI
        ships with. This is always authoritative.
      * Source version — preferred path: read the last-known
        version from a dedicated field in the existing setup
        seeding state file (the same file that already stores
        permission and memory seeding state). A new field name
        is added there; no new file.
      * Source version — fallback path: if no recorded version
        exists, infer it from the observable shape of project
        state. Build a small set of probes for distinguishing
        known major-version states: for example, the presence
        of a legacy monolithic task storage file versus the
        per-task split directories, the presence or absence of
        the scaffolded project config file, the presence or
        absence of the review-plan rendered skill, the content
        of the task storage format marker field in the
        manifest. Each probe maps to a bounded version range.
        The inferred version is the newest version consistent
        with every probe result.
      * Source version — unknown: when no set of probes is
        conclusive (for example, a project with hand-edited
        state that does not match any known shape), report
        the source as unknown and treat the project as if it
        were on the oldest supported version. Every step in
        the upgrade pipeline must be safe to run in this mode
        because the fallback is "run everything".
      * The source version result carries a confidence
        marker: exact (read from state file), approximate
        (inferred from probes), or unknown. The upgrade
        reports the marker alongside the version.
      * When source and target match with exact confidence,
        report the project as current and exit successfully
        without making changes. When source and target match
        with approximate confidence, still run the pipeline
        (as a safety net) but label it as a refresh rather
        than an upgrade.
    - Upgrade pipeline (each step reports its result):
      1. Run the existing task storage migration. Report the
         number of tasks migrated (or zero).
      2. Re-render skills using the existing setup force-render
         behavior. Report how many skills were added, updated,
         and removed since the previous state.
      3. Regenerate the auto-generated agent instructions file
         using the existing generation command. Report whether
         the file changed.
      4. Run the gitignore repair step from the gitignore
         completion work. Report which entries were appended.
      5. Scaffold any missing files that the init setup scaffold
         steps would create on a fresh project (config file,
         default module, default agents and conventions, default
         reflection hook) — but only create what is missing;
         never overwrite. Each skipped item is reported as a skip.
      6. Write the new current version to the last-known version
         state file.
    - When the dry-run flag is set, every step reports what it
      would do without making changes, and no state file is
      written.
    - When any step fails, the command exits with a non-zero
      status and reports which step failed and what state the
      upgrade left the project in.
    - The command output ends with a manual follow-up section
      that lists any scaffolded or updated files the user
      should review.

    How: The existing setup force pathway under
    src/cli/commands/setup.ts already covers most of the
    mechanics (skill re-render, agents regeneration). Build the
    upgrade command as a composition of existing step functions
    plus the new task storage migration invocation (library
    function under src/cli/commands/task-migrate.ts or the
    equivalent). Store the last-known version in the same
    state file pattern used by setup seeding; add a new field
    rather than a new file. The command handler registration
    goes in src/cli/index.ts alongside the other top-level
    commands.

    Testing: Integration tests covering each upgrade scenario:
    pre-versioning project (no state file), current project
    (no-op), project with legacy task storage, project with
    stale skill renders, project with missing gitignore
    entries, project with missing scaffolded files. Test
    dry-run for each scenario. Test failure propagation when a
    step fails.

    Covers: @single-command-version-upgrade ac-detects-skew,
    ac-source-version-fallback, ac-source-version-unknown,
    ac-reports-skew, ac-runs-task-storage-migration,
    ac-rerenders-skills, ac-regenerates-agents-file,
    ac-restores-gitignore-entries, ac-idempotent-when-current,
    ac-reports-manual-follow-ups, ac-dry-run-reports,
    ac-dry-run-no-writes.

- title: Author release notes and expose via CLI
  slug: task-release-notes
  priority: 2
  tags: [cli, docs]
  spec_ref: "@release-notes-accessible"
  depends_on:
    - "@task-upgrade-command"
  description: |
    Create a standardized release notes file in the repository,
    add a CLI command to display its entries, wire them into
    the upgrade command's output, and update the release skill
    to be the single source of truth for how release notes are
    authored and maintained.

    Why: Without release notes, users upgrade blind and have
    no way to discover new configuration knobs or behavioral
    changes. A single canonical source that the CLI reads
    directly prevents drift between documentation and reality.
    The notes are intended for humans first — keeping the file
    format simple and human-authored (rather than a strict
    machine-readable schema) keeps friction low and lets the
    release skill document the conventions the CLI relies on.

    What:
    - Create a single canonical release notes file in the
      repository root in standardized markdown with one
      per-version section per release. The file is human-
      authored, reviewed by humans, and shipped in the
      published package. No new machine-readable schema.
    - Define the section conventions (version heading,
      summary paragraph, "New or changed configuration"
      subsection, "Breaking changes" subsection) in the
      release skill rather than in this plan so authoring
      and CLI consumption share one source of truth.
    - Populate the file with an entry for every released
      version since versioning began, plus an "unreleased"
      entry for changes staged for the next release.
    - Add a top-level CLI command that reads and displays
      release notes. The command accepts no arguments to
      show the current version's notes, and accepts from and
      to version flags to show a range. Invalid version
      ranges produce actionable errors. Output is the
      markdown section as authored; no reformatting, no
      alternate structured output mode.
    - Extend the upgrade command from the prior task so that
      it reads the release notes file, filters to every
      intervening version between the previous and current
      versions, and appends those sections to its output.
    - Update the existing release skill with a "Maintaining
      release notes" section that covers: where the file
      lives, how to add an entry, the section conventions
      above, when to promote the unreleased entry to a
      versioned one, and the exact pre-release check that
      ensures the notes for the version being released are
      non-empty. Enforcement of the update step lives in the
      release skill, not in a separate specification.

    How: The file lives at the repository root and is added
    to the published files list in the package manifest. A
    new parser module under src/parser/release-notes.ts
    exposes load, get-version, and get-range functions using
    a small heading-based markdown walker. The CLI command
    handler lives in src/cli/commands/release-notes.ts. The
    upgrade command imports the range helper and prints the
    relevant slice. The release skill lives under the shared
    release skill file (see skills list); patch it with the
    new section.

    Testing: Unit tests for the parser covering well-formed
    input, missing version, and range queries. CLI tests for
    the display command covering current and range modes.
    Integration test that the upgrade command's output
    includes the relevant notes for a simulated version skew.
    Skill change is verified by a test that loads the skill
    and asserts the new section headings exist.

    Covers: @release-notes-accessible ac-current-version-notes,
    ac-version-range-notes, ac-upgrade-surfaces-notes,
    ac-notes-mention-new-config.

- title: Remove doctor false positive and add scaffold checks
  slug: task-doctor-accuracy
  priority: 2
  tags: [cli, doctor]
  spec_ref: "@doctor-reports-actionable-state"
  depends_on:
    - "@task-scaffold-project-config"
    - "@task-upgrade-command"
  description: |
    Fix doctor's skill rendering check to look at the real
    rendered skill locations, add a check for the scaffolded
    config file, add a version skew check that points at the
    upgrade command, and ensure every warning and error
    includes a concrete resolution command.

    Why: Doctor currently emits a persistent false-positive
    warning about missing rendered skills even when skills are
    clearly rendered, and misses several conditions that the
    other tasks in this plan make detectable. Users ignore
    doctor output because they have learned it is unreliable.
    Doctor should be the single reliable signal that a project
    is ready for work.

    What:
    - Replace the existing rendered skills check with one that
      inspects the real rendered skill locations (the same
      locations the setup command writes to). The check must:
      * Report healthy when any supported rendered skill
        location contains the expected skill files.
      * Report a warning when no supported rendered skill
        location contains any rendered skills, and name the
        command that re-renders.
      * Never report a warning when the setup command would
        consider the project up to date.
    - Add a scaffold check that reports a warning if the
      project is missing the scaffolded config file, and
      names the scaffold command (upgrade or setup with
      force, depending on which is user-facing).
    - Add a version skew check: read the last-known version
      from the state file (added by the upgrade command
      task); if it differs from the currently installed
      version, emit a warning and name the upgrade command.
    - Audit every other check's warning and error messages.
      Every message must include a concrete command or action
      the user can run. Messages that say "run setup" must
      now name the specific setup subcommand or flag.
    - The task storage legacy error must name the upgrade
      command as the preferred resolution, with the
      task-migrate command as the lower-level fallback.
    - Doctor output format stays the same: sections with
      check results, a summary line, and a non-zero exit code
      when errors are present.

    How: The doctor command handler lives in
    src/cli/commands/doctor.ts. Find the rendered skills
    check and inspect the real rendered-skill directory
    constants from the setup command (they are the same
    constants the skill rendering step writes to). Add new
    check functions for the scaffold presence and version
    skew. The existing check output formatting helper already
    takes a resolution message — ensure every call site
    provides one.

    Testing: Unit tests for each new check covering healthy
    and unhealthy paths. Integration test that runs init with
    setup on a fresh temp directory and then runs doctor,
    asserting no warnings are emitted. Snapshot test for the
    doctor output format showing resolution commands on every
    warning and error. Test that after a simulated version
    downgrade, doctor surfaces the version skew warning.

    Covers: @doctor-reports-actionable-state ac-skills-check-accurate,
    ac-skills-check-missing, ac-config-scaffold-detected,
    ac-version-skew-detected, ac-all-actionable.

- title: Fix meta set multi-value option parity
  slug: task-meta-set-multi-value
  priority: 2
  tags: [cli, meta, bugfix]
  spec_ref: "@meta-set-multi-value-parity"
  description: |
    Make repeated multi-value options on meta set accept and
    preserve every value the user supplies, matching the
    behavior of the meta add flow.

    Why: Repeated add-rule, add-skill, and add-capability flags
    on meta set currently drop all values except the last,
    silently. This diverges from meta add (which preserves all
    repeated values) and forces users to run multiple commands
    to do what should be one atomic update. It is a real logic
    bug, not a documentation gap.

    What:
    - Audit the meta set command handler for every flag that
      accepts repeated values (at minimum: add-rule, add-skill,
      add-capability, remove-rule, remove-skill,
      remove-capability). Confirm which are currently
      last-write-wins.
    - Change each affected flag to be a variadic option (or the
      equivalent in the CLI library the project uses) so the
      handler receives an array of every supplied value.
    - Update the handler logic to append every supplied value
      for add flags and remove every supplied value for remove
      flags, in a single atomic write to the meta item.
    - When a single invocation contains both add and remove
      flags for the same field, apply removes before adds so
      the user's intent is unambiguous (an explicit "replace
      these with those" reads correctly).
    - The fix must not change the behavior of meta add; that
      flow already works correctly and the regression tests
      must protect it.

    How: The handler lives in src/cli/commands/meta.ts under
    the set subcommand. The CLI library is commander; the
    correct pattern is to declare the option as variadic
    (option with three dots in the declaration) and consume
    it as an array. Compare the implementation of meta add
    for the exact pattern.

    Testing: Unit tests for the handler covering: repeated
    add-rule preserves all rules, repeated add-skill preserves
    all skills, repeated add-capability preserves all
    capabilities, repeated remove flags remove all named
    values, mixed add and remove flags apply in the expected
    order. Regression test for meta add behavior to ensure the
    fix does not break it.

    Covers: @meta-set-multi-value-parity ac-repeated-add-rule-all-kept,
    ac-repeated-add-skill-all-kept, ac-repeated-add-capability-all-kept,
    ac-remove-flags-unchanged, ac-mixed-add-and-remove.
```

## Implementation Notes

This plan targets rough edges that show up the moment a real user
initializes a project, imports a plan, or upgrades kspec. The
guiding principle is that every step a user takes in the first
hour should either succeed or fail with an actionable error that
tells them exactly what to do next.

The plan groups work into four themes:

1. **Fresh-setup completeness** — the scaffold work (config file,
   gitignore completion, default agents and conventions, default
   reflection hook, derivable default module). A fresh project
   after init with setup should be ready for plan import and
   dispatch with no further hand-authoring.

2. **Plan import ergonomics** — the plan format guidance work.
   Import must never silently accept a broken document, and its
   help output must contain enough information to produce a
   valid document without external references.

3. **Upgrade as a first-class command** — the version upgrade
   command, release notes source, and doctor accuracy work. A
   user upgrading should run a single command that leaves the
   project in a known-good state, or fails loudly with a clear
   recovery path.

4. **Meta set parity bugfix** — the repeated-flag behavior on
   meta set is a latent bug that users currently work around
   by running multiple commands. The fix stands alone and can
   ship in any order.

Dependency ordering: the scaffold tasks (config file, gitignore,
default agents and conventions, default reflection hook, default
module) have no dependencies on each other and can run in
parallel. The reflection hook task used to depend on the default
agents task so it could look up primary agent identifiers, but
reflection is now a universal hook with no per-agent filter, so
that dependency no longer exists. The upgrade command task
depends on every scaffold task because it invokes them on
existing projects. The release notes task depends on the upgrade
command because the upgrade command consumes release notes.
The doctor accuracy task depends on the config scaffold task and
the upgrade command because it adds checks for both. The meta
set fix has no dependencies.

Design decisions:
- Scaffolding is additive and idempotent, with two different
  force contracts depending on what is being scaffolded. File
  scaffolds (config file, gitignore block) preserve existing
  files byte-for-byte without force, and back up then replace
  on force — this is the @trait-idempotent-file-scaffold
  contract. Meta-item scaffolds (default agents, conventions,
  reflection hook, default module) are first-run-only: after
  the first successful seed, subsequent runs never recreate
  items the user has removed or renamed, and force is scoped
  to "reseed missing items only" without overwriting anything
  the user currently has. No scaffold step ever destroys user
  content.
- The canonical list of transient directories lives in a shared
  constant, not inline in init, so future additions are
  automatically picked up by both init and the upgrade repair
  step.
- The upgrade command is a composition of existing setup steps
  plus version detection. It is not a new mechanism; it is a
  correct entry point into existing mechanisms.
- Release notes live in a single source file in the repository
  and are shipped in the published package. The CLI reads the
  same file users would read on the web. No duplication.
- Doctor becomes reliable by checking the locations that
  setup actually writes to. The test suite includes a
  "fresh init produces zero doctor warnings" assertion so
  regressions are caught immediately.
- The meta set fix uses variadic options to match the meta
  add pattern. The CLI library supports this natively; the
  bug is a declaration mistake, not a design choice.

Non-goals:
- No changes to the shape of the shadow branch or task storage
  beyond the existing task storage migration that the upgrade
  command invokes.
- No changes to how agents are dispatched or how tasks are
  provisioned beyond what the scaffolded defaults produce.
- No interactive upgrade prompts. The upgrade command is
  non-interactive so it can run in scripts and automation.
- No web UI changes. The scaffolded defaults surface through
  the existing dynamic agent instruction generation.
