# AC ID Format Normalization

## Specs

```yaml
- title: Acceptance Criterion Identifier Format
  slug: acceptance-criterion-id-format
  type: requirement
  parent: "@spec-item"
  description: |
    Acceptance criterion identifiers use a uniform ac-prefixed kebab-case
    token format everywhere they are stored, edited, validated, and
    referenced by coverage annotations.
  acceptance_criteria:
    - id: ac-stored-id-format
      given: |
        A spec item or trait has acceptance criteria
      when: |
        the item is stored in the project catalog
      then: |
        Each acceptance criterion identifier conforms to the ac-prefixed
        kebab-case token format
    - id: ac-invalid-stored-id-reported
      given: |
        A project catalog contains an acceptance criterion identifier that
        does not conform to the required token format
      when: |
        schema validation runs
      then: |
        Validation reports the offending acceptance criterion identifier
        as invalid
    - id: ac-create-rejects-invalid-id
      given: |
        A user supplies a new acceptance criterion identifier that does not
        conform to the required token format
      when: |
        the user asks kspec to add the acceptance criterion to an item
      then: |
        The command rejects the identifier before mutating the item
    - id: ac-rename-rejects-invalid-id
      given: |
        A user supplies a replacement acceptance criterion identifier that
        does not conform to the required token format
      when: |
        the user asks kspec to rename an existing acceptance criterion
      then: |
        The command rejects the identifier before mutating the item
    - id: ac-generated-ids-conform
      given: |
        A user asks kspec to add an acceptance criterion without supplying
        an identifier
      when: |
        kspec generates the acceptance criterion identifier
      then: |
        The generated identifier conforms to the required token format

- title: AC Annotation Identifier Format
  slug: ac-annotation-identifier-format
  type: requirement
  parent: "@test-annotation-sweep"
  description: |
    Coverage annotations name acceptance criteria using the same
    ac-prefixed token format that catalog acceptance criteria use, so
    annotation parsing and catalog validation agree on what counts as an
    explicit acceptance-criterion reference.
  acceptance_criteria:
    - id: ac-explicit-token-format
      given: |
        A coverage annotation names a spec item or trait acceptance
        criterion
      when: |
        completeness validation parses the annotation
      then: |
        The acceptance criterion token is interpreted only when it uses
        the required ac-prefixed format
    - id: ac-valid-token-covers-ac
      given: |
        A coverage annotation names an existing acceptance criterion using
        the required token format
      when: |
        completeness validation computes acceptance-criterion coverage
      then: |
        The named acceptance criterion receives coverage credit from the
        annotation
    - id: ac-bare-ref-no-token-credit
      given: |
        A coverage annotation names a spec item or trait without a valid
        acceptance criterion token
      when: |
        completeness validation computes acceptance-criterion coverage
      then: |
        The annotation provides no acceptance-criterion coverage credit
```

## Tasks

derive_from_specs: false

```yaml
- title: Enforce AC identifier format at catalog write boundaries
  slug: task-enforce-ac-id-format
  priority: 1
  tags: [schema, validation, cli]
  spec_ref: "@acceptance-criterion-id-format"
  description: |
    Enforce the required ac-prefixed kebab-case acceptance criterion id
    format wherever kspec validates, creates, or renames acceptance
    criteria.

    Why:
    Coverage annotations and completeness validation can only be
    trustworthy when the catalog and annotation parser agree on the token
    shape used for acceptance criterion ids. The catalog schema currently
    accepts any string, while the annotation scanner only treats ac-*
    tokens as explicit AC ids.

    What:
    - Add a reusable acceptance criterion id validator/pattern for the
      required ac-prefixed kebab-case token format.
    - Apply that validator to the acceptance criterion schema so persisted
      spec and trait items with invalid AC ids fail schema validation.
    - Apply the same validation to `kspec item ac add --id ...` before
      the item is mutated.
    - Apply the same validation to `kspec item ac set <ref> <ac-id>
      --id ...` before the item is mutated.
    - Keep automatic id generation on `kspec item ac add` producing ids
      in the required format.
    - Make the user-facing error identify that the id must use the
      ac-prefixed kebab-case format.

    How:
    Prefer a single shared parser/schema helper for the id format so CLI
    command validation, item schema validation, tests, and future import
    paths do not drift. Do not introduce a broader parser that accepts
    legacy non-prefixed ids as valid explicit AC ids.

    Testing:
    - Add schema tests for valid and invalid acceptance criterion ids.
    - Add CLI tests proving `item ac add --id <invalid>` exits before
      mutating the item.
    - Add CLI tests proving `item ac set ... --id <invalid>` exits before
      mutating the item.
    - Add a CLI test proving generated ids still use the required format.
    - Run the focused schema and item AC command tests.

    Covers: @acceptance-criterion-id-format ac-stored-id-format,
    @acceptance-criterion-id-format ac-invalid-stored-id-reported,
    @acceptance-criterion-id-format ac-create-rejects-invalid-id,
    @acceptance-criterion-id-format ac-rename-rejects-invalid-id,
    @acceptance-criterion-id-format ac-generated-ids-conform.

- title: Normalize catalog AC ids and matching annotations
  slug: task-normalize-catalog-ac-ids-and-annotations
  priority: 1
  tags: [spec-hygiene, coverage, tests]
  depends_on:
    - "@task-enforce-ac-id-format"
  description: |
    Bring the live catalog and coverage annotations into the required AC
    id format, preserving behavior while eliminating mismatched legacy
    tokens.

    Why:
    Existing projects may contain acceptance criterion ids or annotations
    that predate the ac-prefixed convention. Once the format is enforced,
    the current project catalog and its coverage annotations must agree on
    the normalized ids so completeness findings represent real debt.

    What:
    - Inventory every spec and trait acceptance criterion id in the live
      catalog.
    - For each id that does not use the required format, choose a stable
      ac-prefixed replacement that preserves the original meaning.
    - Rename nonconforming catalog ids through kspec item AC commands or a
      safe batch mutation path; do not hand-edit shadow YAML files.
    - Update every coverage annotation, test fixture expectation, and
      documentation example that names a renamed AC id.
    - Add a task note listing every old id to new id mapping, grouped by
      spec or trait ref.
    - If the inventory finds that the catalog was already normalized by
      prior work, record that result and continue with annotation repair.

    How:
    Use kspec CLI lookups and repository searches to build a complete
    mapping before making changes. Treat annotations as claims that must
    match actual catalog ids after the rename. Avoid broad missing-AC
    coverage cleanup that is unrelated to renamed ids.

    Testing:
    - Run kspec validate --refs --warnings-ok.
    - Run kspec validate --completeness --warnings-ok and verify that
      blanket-ref findings caused by renamed non-prefixed ids are gone.
    - Run focused tests for every touched annotation surface.
    - Run the coverage annotation validation tests after annotation
      updates.

    Covers: @acceptance-criterion-id-format ac-stored-id-format,
    @ac-annotation-identifier-format ac-valid-token-covers-ac,
    @ac-annotation-identifier-format ac-bare-ref-no-token-credit,
    @ac-annotation-integrity-reporting ac-valid-annotation-covers-target,
    @ac-annotation-integrity-reporting ac-blanket-ref-does-not-cover.

- title: Align annotation parser tests and guidance with required AC id format
  slug: task-align-ac-annotation-format-tests
  priority: 2
  tags: [validation, coverage, tests]
  spec_ref: "@ac-annotation-identifier-format"
  depends_on:
    - "@task-enforce-ac-id-format"
  description: |
    Make the annotation parser's tests and guidance state that explicit AC
    references use ac-prefixed tokens.

    Why:
    The annotation scanner already treats ac-* tokens as explicit AC ids,
    but tests and examples should make that contract unmistakable now that
    the catalog enforces the same format.

    What:
    - Update parser comments and tests so examples use ac-prefixed
      numeric or named ids.
    - Add or adjust tests showing that an annotation with a non-prefixed
      token after a spec ref does not create explicit AC coverage.
    - Add or adjust tests showing that ac-prefixed named ids are parsed as
      explicit AC references.
    - Ensure test fixtures that intentionally contain invalid or blanket
      annotations remain clearly scoped as invalid/blanket fixtures.

    How:
    Keep the parser behavior aligned with the catalog format. Do not make
    the parser accept arbitrary identifier words as AC ids, because that
    would make bare prose after a spec ref ambiguous and would weaken the
    enforced format.

    Testing:
    - Run the AC annotation parser and completeness validation tests.
    - Run kspec validate --completeness --warnings-ok and confirm the
      remaining invalid annotation categories are expected.

    Covers: @ac-annotation-identifier-format ac-explicit-token-format,
    @ac-annotation-identifier-format ac-valid-token-covers-ac,
    @ac-annotation-identifier-format ac-bare-ref-no-token-credit,
    @test-annotation-sweep ac-annotation-format,
    @test-annotation-sweep ac-no-blanket-credit.

- title: Final AC id format validation gate
  slug: task-ac-id-format-final-gate
  priority: 2
  tags: [validation, review, spec-hygiene]
  depends_on:
    - "@task-normalize-catalog-ac-ids-and-annotations"
    - "@task-align-ac-annotation-format-tests"
  description: |
    Verify the AC id format enforcement work from both catalog and code
    perspectives, then record the remaining validation state.

    Why:
    The work is only complete when the project both enforces the required
    identifier format and no longer misclassifies renamed AC annotations as
    blanket coverage claims.

    What:
    - Verify that every live spec and trait acceptance criterion id uses
      the required format.
    - Verify that no remaining completeness blanket-ref findings are caused
      by annotations naming old non-prefixed AC ids.
    - Verify that invalid AC id creation and rename attempts fail before
      mutation.
    - Verify that schema validation reports invalid persisted AC ids.
    - Record remaining completeness warning categories and their owners in
      a task note.
    - If @ac-annotation-integrity-reporting satisfies its ACs after the
      normalization, update its implementation status appropriately.

    How:
    Use kspec validation output, focused tests, and a small catalog scan.
    Treat unrelated missing-own-AC coverage warnings as out of scope, but
    explicitly separate them from AC id format failures.

    Testing:
    - Run kspec validate --refs --warnings-ok.
    - Run kspec validate --alignment --warnings-ok.
    - Run kspec validate --completeness --warnings-ok.
    - Run the focused tests added or changed by this plan.
    - Run npm run typecheck.

    Covers: @acceptance-criterion-id-format ac-stored-id-format,
    @acceptance-criterion-id-format ac-invalid-stored-id-reported,
    @acceptance-criterion-id-format ac-create-rejects-invalid-id,
    @acceptance-criterion-id-format ac-rename-rejects-invalid-id,
    @acceptance-criterion-id-format ac-generated-ids-conform,
    @ac-annotation-identifier-format ac-explicit-token-format,
    @ac-annotation-identifier-format ac-valid-token-covers-ac,
    @ac-annotation-identifier-format ac-bare-ref-no-token-credit,
    @ac-annotation-integrity-reporting ac-valid-annotation-covers-target,
    @ac-annotation-integrity-reporting ac-blanket-ref-does-not-cover.
```

## Implementation Notes

### Investigation summary

Current implementation observations used to shape this plan:

- Acceptance criterion ids are stored on spec and trait items under
  `acceptance_criteria[].id`.
- The item schema currently accepts any string for the AC id field.
- `kspec item ac add` and `kspec item ac set --id` currently validate
  duplicates and presence but do not enforce an id token format.
- The coverage annotation parser treats ac-prefixed tokens as explicit AC
  ids. Non-prefixed words after a spec ref are not parsed as AC ids and
  therefore behave like a bare spec reference.
- The current repository has already started catalog id normalization, but
  coverage annotations and enforcement behavior still need a reviewed,
  self-contained implementation path.

### Boundary decisions

- The required format is ac-prefixed kebab-case. This matches the current
  normalized catalog direction and the existing annotation parser's
  explicit-token behavior.
- This plan does not broaden annotation parsing to accept arbitrary
  non-prefixed AC id tokens.
- This plan does not own the broad missing-own-AC coverage backlog.
- A direct provisional task for this work was retired before this plan
  became authoritative; plan-derived tasks should be treated as the source
  of truth for remaining implementation.

### Dependency ordering

1. Enforce the write/validation boundary first so future catalog mutations
   cannot introduce new nonconforming AC ids.
2. Normalize the live catalog and annotations after the validator exists,
   so the migration can prove it leaves the project in the enforced shape.
3. Align annotation tests and parser guidance in parallel with the live
   annotation cleanup.
4. Run the final validation gate after both enforcement and annotation
   cleanup have landed.
