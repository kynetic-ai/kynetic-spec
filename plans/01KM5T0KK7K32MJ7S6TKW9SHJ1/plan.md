# Input Validation Hardening

## Specs

```yaml
# ─── Cross-cutting trait ───────────────────────────────────

- title: Type-Safe Input Boundaries
  slug: trait-type-safe-input
  type: trait
  description: |
    Cross-cutting contract for any surface that accepts external input —
    CLI options, HTTP request bodies, WebSocket messages, or programmatic
    function arguments. Every input field with a defined type constraint
    (enum, number range, string format, required/optional, array element
    type) must be validated at the boundary before the input reaches
    business logic or persistence.

    Validation must be schema-derived — the source of truth for what
    constitutes valid input is the canonical schema definition, not a
    separate hardcoded check. Error messages must be actionable,
    identifying what was wrong and what is expected.
  acceptance_criteria:
    - id: ac-1
      given: |
        Any input surface accepts a field with a defined type constraint
      when: |
        The provided value does not satisfy the constraint
      then: |
        The operation is rejected before any data is persisted or
        state is mutated
    - id: ac-2
      given: |
        An input validation error occurs for a constrained field
      when: |
        The error is reported to the caller
      then: |
        The message includes the set of valid alternatives for the
        field, not just the field name and invalid value (extends
        @trait-error-guidance ac-5 which requires identifying the
        field/value but not listing valid alternatives)
    - id: ac-3
      given: |
        A field's type constraint is defined in a canonical schema
      when: |
        Validation logic checks the field
      then: |
        The validation is derived from that schema definition rather
        than a separately maintained check

# ─── CLI input type safety ─────────────────────────────────

- title: CLI Input Type Safety
  slug: cli-input-type-safety
  type: feature
  parent: "@cli"
  traits:
    - trait-type-safe-input
    - trait-error-guidance
    - trait-semantic-exit-codes
  description: |
    All CLI commands must validate their inputs against the defined type
    constraints before executing. This applies to both mutation commands
    (which persist data) and query commands (which filter data). When a
    command accepts an option or argument with a constrained type — an
    enum, a number within a range, a reference format, or any value with
    a schema-defined shape — it must reject invalid values with a clear
    error rather than passing them through unchecked.

    Mutation commands that accept invalid input cause data corruption:
    values are written to YAML and silently dropped on next read. Query
    commands that accept invalid filters silently return empty results,
    wasting the user's time debugging "missing" data.
  acceptance_criteria:
    - id: ac-1
      given: |
        A CLI mutation command accepts a typed option
      when: |
        The provided value does not match the option's type constraint
      then: |
        The command exits with non-zero status and stderr describes the
        invalid value and lists what is valid, before any write occurs
    - id: ac-2
      given: |
        A CLI query command accepts a typed filter option
      when: |
        The provided value does not match the filter's type constraint
      then: |
        The command exits with non-zero status and stderr describes the
        invalid value, rather than silently returning empty results
    - id: ac-3
      given: |
        A CLI command accepts a typed option
      when: |
        The provided value satisfies the type constraint
      then: |
        The command executes normally
    - id: ac-4
      given: |
        A CLI command option has a default value
      when: |
        The default is applied
      then: |
        The default value itself satisfies the type constraint

# ─── API input type safety ─────────────────────────────────

- title: API Input Type Safety
  slug: api-input-type-safety
  type: feature
  parent: "@web-ui"
  traits:
    - trait-type-safe-input
    - trait-api-endpoint
  description: |
    All daemon API endpoints must enforce type constraints on input
    fields at the framework schema level, not through manual checks in
    handler code. This applies to both mutation endpoints (request body
    fields) and query endpoints (filter parameters). When an input
    contains a field with a constrained type — an enum, a bounded
    number, a structured object with required shape — the framework
    must reject invalid values before the handler executes. This
    applies to HTTP endpoints and WebSocket message handlers.

    Framework-level validation is preferred over handler-level
    validation because it is declarative, cannot be bypassed by handler
    code paths, and produces consistent error responses. Existing
    handler-level validation may remain as defense-in-depth.
  acceptance_criteria:
    - id: ac-1
      given: |
        An API mutation endpoint accepts a field with a type constraint
      when: |
        The request body contains a value that violates the constraint
      then: |
        The framework returns a validation error before the handler
        executes, and no data is persisted
    - id: ac-2
      given: |
        An API mutation endpoint accepts a field with a type constraint
      when: |
        The request body contains a valid value
      then: |
        The handler executes normally
    - id: ac-3
      given: |
        An API query endpoint accepts a typed filter parameter
      when: |
        The provided value does not match the filter's type constraint
      then: |
        The framework returns a validation error rather than silently
        returning empty results
    - id: ac-4
      given: |
        An API endpoint's type constraints are defined
      when: |
        The constraints are implemented
      then: |
        The API type constraints are derived from the canonical
        schema definition

# ─── Parser defense-in-depth ───────────────────────────────

- title: Parser Write-Path Type Safety
  slug: parser-write-type-safety
  type: requirement
  parent: "@cli"
  description: |
    Entity creation and import functions must validate their inputs
    against the canonical schema before constructing entities. This is
    a defense-in-depth layer that catches invalid data from programmatic
    callers that bypass CLI or API boundary validation — including batch
    execution, plan derivation, and internal code paths that construct
    entities directly.
  acceptance_criteria:
    - id: ac-1
      given: |
        An entity creation function receives input with an invalid
        field value
      when: |
        The function validates the input against the entity schema
      then: |
        It throws an error identifying the invalid field and what
        valid input looks like
    - id: ac-2
      given: |
        An entity creation function receives valid input
      when: |
        The function validates the input
      then: |
        The entity is created normally
    - id: ac-3
      given: |
        A structured document is imported (e.g., a plan document
        containing entity definitions)
      when: |
        The document contains a field value that violates a type
        constraint
      then: |
        Import fails with an error identifying the invalid field
        and listing valid values

# ─── Single source of truth ────────────────────────────────

- title: Schema-Derived Type Definitions
  slug: schema-derived-type-definitions
  type: requirement
  parent: "@schema"
  traits:
    - trait-type-safe-input
  description: |
    Every surface that references a constrained type — CLI option help
    text, API route schemas, runtime validation arrays, type assertions
    — must derive its definition from the canonical schema rather than
    maintaining a separate copy. When multiple representations of the
    same type exist, they drift independently and create silent
    inconsistencies.

    This includes hardcoded arrays used for validation, API framework
    type definitions, CLI help strings that list valid values, and
    type assertions that enumerate possible values. All of these must
    trace back to a single canonical schema definition.
  acceptance_criteria:
    - id: ac-1
      given: |
        A runtime validation check references a set of valid values
        for a type that has a canonical schema definition
      when: |
        The valid values are determined
      then: |
        They are derived from the canonical schema rather than
        maintained as a separate hardcoded array or set
    - id: ac-2
      given: |
        An API endpoint defines the allowed values for a field
      when: |
        The allowed values are specified
      then: |
        They are derived from the canonical schema definition,
        not hardcoded independently
    - id: ac-3
      given: |
        A CLI command's help text lists valid values for an option
      when: |
        The help text is generated
      then: |
        The listed values are derived from the canonical schema so
        they stay in sync when the schema changes
    - id: ac-4
      given: |
        Two or more schema definitions exist for the same semantic
        concept
      when: |
        The definitions are compared
      then: |
        They share a single source definition or one is explicitly
        derived from the other, with no independent incompatible
        copies

# ─── Read-side resilience ──────────────────────────────────

- title: Read-Side Validation Warnings
  slug: read-side-validation-warnings
  type: requirement
  parent: "@cli"
  traits:
    - trait-error-guidance
  description: |
    When persisted records fail schema validation during loading, the
    system must warn the user rather than silently dropping them. This
    is a safety net for data that was corrupted before write-time
    validation was in place, or that was edited manually. Valid records
    must still load normally — warnings are non-breaking and informational.
  acceptance_criteria:
    - id: ac-1
      given: |
        A data file contains a record with an invalid field value
      when: |
        The loader parses the file
      then: |
        A warning is emitted to stderr identifying the record and the
        validation error
    - id: ac-2
      given: |
        A data file contains both valid and invalid records
      when: |
        The loader parses the file
      then: |
        Valid records are returned normally and warnings are emitted
        only for the invalid records
    - id: ac-3
      given: |
        All records in a data file are valid
      when: |
        The loader parses the file
      then: |
        No warnings are emitted
```

## Tasks

derive_from_specs: false

```yaml
- title: Add CLI mutation input validation
  slug: task-cli-mutation-input-validation
  spec_ref: "@cli-input-type-safety"
  priority: 1
  tags:
    - cli
    - validation
  depends_on:
    - "@task-schema-derived-types"
  description: |
    **What:** Add validateEnumOption() checks to all CLI mutation commands
    that accept typed options without runtime validation. Audit identified
    9 unvalidated enum options across mutation commands: task add --type,
    item add --type, item set --type/--status/--maturity, inbox promote
    --type, plan add/set --status, review check add --status.

    **Why:** These commands persist invalid values to shadow branch YAML
    files. On next read, safeParse drops those records silently — the
    primary data corruption vector reported in GitHub #899. Fixing
    mutations is highest priority because it prevents new corruption.

    **How:** Each fix follows the existing validated pattern at
    src/cli/commands/task.ts line 1067 (task add --automation):
    1. Import the Zod schema (e.g. TaskTypeSchema from ../../schema/common.js)
    2. Call validateEnumOption(value, Schema.options, "field name") before
       the value is used
    3. On failure: call error() with the result message and process.exit()
    4. On success: use the validated value

    Specific locations:
    - src/cli/commands/task.ts ~line 1147: task add --type (TaskTypeSchema)
    - src/cli/commands/item.ts line 708: item add --type (ItemTypeSchema)
    - src/cli/commands/item.ts line 1089: item set --type (ItemTypeSchema)
    - src/cli/commands/item.ts: item set --status (ImplementationStatusSchema),
      --maturity (MaturitySchema)
    - src/cli/commands/inbox.ts: inbox promote --type (TaskTypeSchema)
    - src/cli/commands/plan.ts: plan add/set --status (PlanStatusSchema)
    - src/cli/commands/review.ts: review check add --status (ReviewCheckStatusSchema)

    Covers: @cli-input-type-safety ac-1, ac-3.

- title: Add CLI filter input validation
  slug: task-cli-filter-input-validation
  spec_ref: "@cli-input-type-safety"
  priority: 2
  tags:
    - cli
    - validation
    - dx
  depends_on:
    - "@task-cli-mutation-input-validation"
  description: |
    **What:** Add validateEnumOption() checks to all CLI list/search
    commands that accept typed filter options without validation. Audit
    identified 14 unvalidated filter options across 9 commands: task list
    --status/--type, tasks ready --status/--type, item list --type,
    plan list --status, review list --status/--disposition, triage list
    --status/--action, search --type/--status, schedule list --status,
    agent list --status.

    **Why:** Typos in filter values (e.g., --status "pending_revew")
    silently return empty results. Users think there are no matching items
    when really the filter value was invalid. Early validation with a clear
    error saves debugging time.

    **How:** Same validateEnumOption pattern as mutation validation.
    Validation happens early in each command's action handler, before
    loading data from the shadow branch. For schedule list --status
    (enabled/disabled) and agent list --status (eligible/ineligible),
    verify whether Zod schemas exist or create inline allowed-value arrays.

    Specific files and schemas:
    - src/cli/commands/task.ts: task list --status (TaskStatusSchema),
      --type (TaskTypeSchema); tasks ready --status, --type
    - src/cli/commands/item.ts: item list --type (ItemTypeSchema)
    - src/cli/commands/plan.ts: plan list --status (PlanStatusSchema)
    - src/cli/commands/review.ts: review list --status
      (ReviewLifecycleStateSchema), --disposition (ReviewDispositionSchema)
    - src/cli/commands/triage.ts: triage list --status (TriageStatusSchema),
      --action (TriageActionSchema)
    - src/cli/commands/search.ts: search --type (ItemTypeSchema),
      --status (TaskStatusSchema)
    - src/cli/commands/schedule.ts: schedule list --status
    - src/cli/commands/agent.ts: agent list --status

    Covers: @cli-input-type-safety ac-2, ac-3.

- title: Tighten daemon API input schemas
  slug: task-daemon-api-input-validation
  spec_ref: "@api-input-type-safety"
  priority: 2
  tags:
    - daemon
    - validation
    - web-ui
  depends_on:
    - "@task-schema-derived-types"
  description: |
    **What:** Replace loose t.String() with strict t.Union([t.Literal(...)])
    in Elysia schemas for all daemon API endpoints that accept typed fields.
    This covers both mutation endpoints (8 with loose enum body fields) and
    query endpoints (7+ routes with loose enum filter params).

    **Why:** The web UI uses these endpoints. Loose t.String() schemas mean
    arbitrary values are accepted. For mutations, this risks data corruption.
    For queries, this causes silent empty results on typos — the same problem
    as CLI filters. Framework-level Elysia validation rejects requests before
    the handler runs.

    **How:** For each endpoint, replace loose Elysia types with strict unions
    derived from Zod schemas. Reference pattern exists at
    packages/daemon/src/routes/meta.ts (PATCH /api/meta/agents/:id) which
    uses Schema.options.map(v => t.Literal(v)).

    Mutation endpoints:
    - packages/daemon/src/routes/reviews.ts:
      POST /comments: kind, anchor.type, anchor.side
      POST /verdicts: decision
      POST /checks: status
      PATCH /lifecycle: target
    - packages/daemon/src/routes/triage.ts:
      POST /: action
      POST /:ref/override: action
    - packages/daemon/src/routes/agent-dispatch.ts:
      POST /events: from_status, to_status

    Query/filter endpoints:
    - packages/daemon/src/routes/tasks.ts: GET /api/tasks — status, type,
      automation filter params
    - packages/daemon/src/routes/items.ts: GET /api/items — type, maturity,
      implementation filter params
    - packages/daemon/src/routes/reviews.ts: GET /api/reviews — status,
      disposition filter params
    - packages/daemon/src/routes/triage.ts: GET /api/triage — status, action
    - packages/daemon/src/routes/plans.ts: GET /api/plans — status
    - packages/daemon/src/routes/sessions routes — status, agent_type
    - packages/daemon/src/routes/validation.ts: search — type, status

    Keep existing manual handler validation as defense-in-depth.

    Covers: @api-input-type-safety ac-1 through ac-4.

- title: Add parser write-path schema validation
  slug: task-parser-write-validation
  spec_ref: "@parser-write-type-safety"
  priority: 2
  tags:
    - parser
    - validation
  depends_on:
    - "@task-schema-derived-types"
  description: |
    **What:** Add schema validation to createTask() and createSpecItem()
    in src/parser/yaml.ts, and tighten PlanSpecSchema.type from
    z.string().optional() to ItemTypeSchema.optional() in
    src/parser/plan-document.ts.

    **Why:** Defense-in-depth. Primary validation happens at CLI and API
    boundaries, but programmatic callers — batch execution, plan derive,
    and future code paths — can bypass boundary validation using TypeScript
    "as Type" casts. The parser layer is the last defense before invalid
    data reaches disk.

    **How:**
    1. In createTask() (~line 1300 of src/parser/yaml.ts):
       - Add TaskInputSchema.safeParse(input) at function entry
       - On failure: throw new Error with formatted Zod error issues
       - Import TaskInputSchema from ../schema/task.js

    2. In createSpecItem() (~line 1937 of src/parser/yaml.ts):
       - Add SpecItemInputSchema.safeParse(input) at function entry
       - On failure: throw new Error with formatted Zod error issues

    3. In src/parser/plan-document.ts line 22:
       - Change `type: z.string().optional()` to `type: ItemTypeSchema.optional()`
       - Import ItemTypeSchema from ../../schema/common.js

    Covers: @parser-write-type-safety ac-1, ac-2, ac-3.

- title: Consolidate type definitions to schema source of truth
  slug: task-schema-derived-types
  spec_ref: "@schema-derived-type-definitions"
  priority: 1
  tags:
    - schema
    - validation
    - maintenance
  description: |
    **What:** Replace all hardcoded enum arrays, Elysia literal unions,
    CLI help text values, and type assertions with derivations from the
    canonical Zod schemas. Also resolve the automation status divergence
    where three independent Zod schemas define incompatible value sets
    for the same semantic concept.

    **Why:** The audit found 5 hardcoded enum arrays in daemon routes,
    10+ CLI help strings with hardcoded values, and type assertions in
    aggregation routes — all duplicating what Zod schemas already define.
    Worse, there are 3 incompatible "automation" enums:
    - AutomationStatusSchema (task.ts): eligible, needs_review, manual_only
    - TaskEventPayload automation (event-payloads.ts): eligible, not_eligible, assisted
    - AgentDispatchFilterSchema (meta.ts): eligible, ineligible
    Only "eligible" overlaps across all three. These must be reconciled.

    **How:**
    1. Reconcile automation enums — determine the canonical set and
       derive the others from it, or document why they are intentionally
       different domains

    2. Replace hardcoded arrays in daemon routes with schema derivations:
       - packages/daemon/src/routes/agent-dispatch.ts: VALID_TASK_STATUSES
         → derive from TaskStatusSchema.options
       - packages/daemon/src/routes/reviews.ts: VALID_DECISIONS,
         VALID_CHECK_STATUSES, VALID_LIFECYCLE_TARGETS, validKinds,
         validSides → derive from corresponding Review*Schema.options
       - packages/daemon/src/routes/aggregation.ts: remove type assertions
         with hardcoded enum values

    3. Replace Elysia hardcoded literals:
       - packages/daemon/src/routes/meta.ts line 108: automation literal
         union → derive from schema like line 105 does for dispatch events

    4. Make CLI help text derive from schemas. Either:
       (a) Generate help strings: `"Task type (${TaskTypeSchema.options.join(', ')})"` or
       (b) Accept that help text is documentation and may list a subset,
           but validation must use the schema

    5. Follow existing correct patterns:
       - src/triage/constants.ts: `VALID_ACTIONS = TriageActionSchema.options`
       - meta.ts:105: `t.Union(Schema.options.map(v => t.Literal(v)))`

    Covers: @schema-derived-type-definitions ac-1 through ac-4.

- title: Add read-side validation warnings
  slug: task-read-side-validation-warnings
  spec_ref: "@read-side-validation-warnings"
  priority: 3
  tags:
    - parser
    - dx
    - validation
  description: |
    **What:** When safeParse fails during YAML file loading, emit a stderr
    warning identifying the dropped record and the validation error, instead
    of silently skipping it. Affects loader functions for tasks, spec items,
    inbox items, triage records, and plan records in src/parser/yaml.ts.

    **Why:** Silent data loss is the root symptom of GitHub #899. A record
    disappearing with no explanation forces users to manually inspect YAML.
    A warning on stderr immediately tells users what happened, which record
    was dropped, and which field failed — enough to fix it.

    **How:**
    1. Create a shared helper in src/parser/yaml.ts:
       ```
       function warnSkippedRecord(entityType: string, id: string,
         source: string, error: z.ZodError): void
       ```

    2. Add else branches to safeParse checks in each loader:
       - loadTasksFromFile() ~line 742
       - extractItemsFromRaw() ~line 1626
       - parseInboxItemsFromRaw() ~lines 2286/2299
       - Triage record loader ~line 2754
       - Plan record loader (verify location)

    Valid records continue to load normally — warnings are non-breaking.

    Covers: @read-side-validation-warnings ac-1, ac-2, ac-3.
```

## Implementation Notes

This plan addresses GitHub issue #899 and a systemic audit that found 25 of 27
CLI enum options and 8 daemon API endpoints lack proper input type validation.

Root cause: Zod schemas define valid types but are only enforced on READ
(via safeParse which silently drops invalid records). Write paths use
TypeScript "as Type" casts with zero runtime validation.

The fix is layered:
1. Boundary validation (CLI + daemon API) rejects invalid input before persistence
2. Defense-in-depth (parser) catches anything that slips through boundaries
3. Observability (read warnings) surfaces already-corrupted data

Priority ordering: P1 mutations (prevent corruption), P2 filters + daemon + parser
(UX and defense), P3 read warnings (safety net for existing data).

Scope note: The trait @trait-type-safe-input is intentionally broad (covering
enums, numbers, formats, etc.) but the tasks in this plan focus on enum validation
as the immediate priority — it is the source of GitHub #899 and the most common
unvalidated input type. Non-enum typed inputs (number ranges like priority 1-5,
ref format validation, date formats) are valid future work under the same trait
but are not tasked here.
