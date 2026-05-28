# Spec Reconciliation — Close Validate Completeness Gaps

## Specs

```yaml
- title: Spec Completeness Policy
  slug: spec-completeness-policy
  type: decision
  parent: "@meta"
  description: |
    Codifies which item types require acceptance criteria and descriptions,
    reducing false-positive validate warnings. Modules are organizational
    containers and should not require ACs. Traits, features, requirements,
    and constraints must have ACs. All non-module items should have descriptions.
  acceptance_criteria:
    - id: ac-module-exempt
      given: |
        A spec item has type module
      when: |
        kspec validate --completeness runs
      then: |
        No "missing acceptance criteria" warning is emitted for module items
    - id: ac-feature-required
      given: |
        A spec item has type feature, requirement, constraint, or trait
      when: |
        The item has no acceptance_criteria defined
      then: |
        A completeness warning is emitted
    - id: ac-description-required
      given: |
        A spec item has any type except module
      when: |
        The item has no description field
      then: |
        A completeness warning is emitted

- title: Core Primitives AC Backfill
  slug: core-ac-backfill
  type: requirement
  parent: "@core"
  description: |
    Add acceptance criteria to foundational spec items under @core that
    currently lack them: ULID system, slug system, reference system,
    item types, relationship types, and status lifecycle. These are the
    building blocks — their ACs define what correctness means for everything
    built on top.
  acceptance_criteria:
    - id: ac-coverage
      given: |
        All feature and requirement items under @core module
      when: |
        kspec validate --completeness runs
      then: |
        Zero "missing acceptance criteria" warnings for @core descendants
    - id: ac-testable
      given: |
        Each newly added AC
      when: |
        It is reviewed
      then: |
        It follows given/when/then format and is specific enough to write a test against

- title: Schema and Structure AC Backfill
  slug: schema-ac-backfill
  type: requirement
  parent: "@schema"
  description: |
    Add acceptance criteria to spec items under @schema that lack them:
    file structure, YAML conventions, versioning, format version,
    spec version, git baselines, Zod schema validation.
  acceptance_criteria:
    - id: ac-coverage
      given: |
        All feature and requirement items under @schema module
      when: |
        kspec validate --completeness runs
      then: |
        Zero "missing acceptance criteria" warnings for @schema descendants
    - id: ac-testable
      given: |
        Each newly added AC
      when: |
        It is reviewed
      then: |
        It follows given/when/then format and is specific enough to write a test against

- title: CLI AC Backfill
  slug: cli-ac-backfill
  type: requirement
  parent: "@cli"
  description: |
    Add acceptance criteria to spec items under @cli that lack them:
    CLI design, query commands, link commands, validate commands,
    derive commands, init commands, inbox commands, fuzzy matching.
  acceptance_criteria:
    - id: ac-coverage
      given: |
        All feature and requirement items under @cli module
      when: |
        kspec validate --completeness runs
      then: |
        Zero "missing acceptance criteria" warnings for @cli descendants
    - id: ac-testable
      given: |
        Each newly added AC
      when: |
        It is reviewed
      then: |
        It follows given/when/then format and is specific enough to write a test against

- title: Task System AC Backfill
  slug: tasks-ac-backfill
  type: requirement
  parent: "@tasks"
  description: |
    Add acceptance criteria to spec items under @tasks that lack them:
    task types, task schema, task storage, alignment system.
  acceptance_criteria:
    - id: ac-coverage
      given: |
        All feature and requirement items under @tasks module
      when: |
        kspec validate --completeness runs
      then: |
        Zero "missing acceptance criteria" warnings for @tasks descendants
    - id: ac-testable
      given: |
        Each newly added AC
      when: |
        It is reviewed
      then: |
        It follows given/when/then format and is specific enough to write a test against

- title: Meta and Shadow Branch AC Backfill
  slug: meta-shadow-ac-backfill
  type: requirement
  parent: "@meta"
  description: |
    Add acceptance criteria to spec items under @meta and @shadow-branch
    that lack them. These modules govern the meta-spec system
    (conventions, workflows, skills, observations) and shadow branch
    mechanics.
  acceptance_criteria:
    - id: ac-coverage
      given: |
        All feature and requirement items under @meta and @shadow-branch modules
      when: |
        kspec validate --completeness runs
      then: |
        Zero "missing acceptance criteria" warnings for their descendants
    - id: ac-testable
      given: |
        Each newly added AC
      when: |
        It is reviewed
      then: |
        It follows given/when/then format and is specific enough to write a test against

- title: Test Coverage Annotation Sweep
  slug: test-annotation-sweep
  type: requirement
  parent: "@meta"
  description: |
    Systematically add AC: @spec-ref ac-N annotations to existing tests
    that cover spec acceptance criteria but lack the machine-parseable
    annotation. This closes the gap between implemented behavior and
    validate's test coverage tracking. Prioritize traits with downstream
    impact (trait-priority-parameter, trait-markdown-rendering,
    ui-url-panel-state) then work through own-AC coverage gaps.
  acceptance_criteria:
    - id: ac-trait-coverage
      given: |
        All specs that inherit traits with acceptance criteria
      when: |
        kspec validate --completeness runs
      then: |
        Zero "missing trait AC coverage" warnings (currently 13)
    - id: ac-own-coverage-reduction
      given: |
        All specs with own acceptance criteria
      when: |
        kspec validate --completeness runs
      then: |
        Missing own AC coverage warnings reduced by at least 50% from current 118
    - id: ac-annotation-format
      given: |
        Each added test annotation
      when: |
        It is reviewed
      then: |
        It uses the format "// AC: @spec-ref ac-N" (or language-appropriate comment prefix) and is machine-parseable

- title: Missing Description Backfill
  slug: description-backfill
  type: requirement
  parent: "@meta"
  description: |
    Add descriptions to the 7 spec items that currently lack them:
    Test Trait, Batch Command Execution, Batch Command Schema,
    Task Add Depends On, Derive Title Override, Ralph End Loop,
    Workflow Prune.
  acceptance_criteria:
    - id: ac-coverage
      given: |
        kspec validate --completeness runs
      when: |
        Checking for missing descriptions
      then: |
        Zero "missing description" warnings
```

## Tasks

derive_from_specs: true

## Implementation Notes

This is a large reconciliation effort. The tasks should be worked in this order:

1. **Spec completeness policy** (code change) — Update validate to exempt modules from AC warnings. This immediately drops ~7 false positives and sets the right policy going forward.

2. **AC backfill tasks** (spec work, no code) — Each module's backfill is independent and can be parallelized. The work is: read the existing spec item, understand what it describes, write given/when/then ACs that capture the implemented behavior. Use `kspec item ac add` or `kspec batch`.

3. **Test annotation sweep** (code annotation, no behavior change) — After ACs exist, scan test files for tests that exercise each AC and add `// AC: @spec ac-N` comments. No code logic changes.

4. **Description backfill** — Quick task, can be done anytime.

Priority order for AC backfill: @core (foundational) → @schema → @tasks → @cli → @meta/@shadow-branch. Each is scoped to one module so agents can work them independently.
