# AC ID Surface Hardening

## Existing Spec Updates

This proposal extends the existing owning specs instead of creating parallel
requirements. The cleanup is a hardening follow-up for two already-existing
contracts:

- `@acceptance-criterion-id-format` owns the uniform `ac-` prefixed
  kebab-case identifier format for stored and edited acceptance criteria.
- `@item-patch` owns single-item patch, bulk patch, dry-run, fail-fast, and
  `--allow-unknown` behavior for spec item mutation.
- `@ac-annotation-identifier-format` owns the token grammar used by coverage
  annotations when they name acceptance criteria.
- `@ac-annotation-integrity-reporting` owns completeness findings for invalid
  AC annotations and the rule that invalid annotations do not provide coverage.

Proposed changes:

```yaml
- spec_ref: "@acceptance-criterion-id-format"
  add_acceptance_criteria:
    - id: ac-patch-rejects-invalid-id
      given: |
        A user supplies patch data that would store an acceptance criterion
        identifier that does not conform to the required token format
      when: |
        kspec validates the patch for a single item patch or bulk item patch
      then: |
        The update is rejected before the catalog item is mutated

- spec_ref: "@item-patch"
  add_acceptance_criteria:
    - id: ac-allow-unknown-rejects-invalid-ac-id
      given: |
        A user patches an item with --allow-unknown and the patch would store an
        acceptance criterion identifier that does not conform to the required
        token format
      when: |
        kspec item patch runs
      then: |
        The command fails without writing the patch
    - id: ac-bulk-dry-run-rejects-invalid-ac-id
      given: |
        A bulk patch dry-run includes an operation that would store an
        acceptance criterion identifier that does not conform to the required
        token format
      when: |
        kspec item patch --bulk --dry-run runs
      then: |
        The operation is reported as an error instead of a successful preview
    - id: ac-bulk-invalid-operation-not-written
      given: |
        A bulk patch contains an operation with invalid patch data
      when: |
        kspec item patch --bulk runs without --fail-fast
      then: |
        The invalid operation is not written
    - id: ac-bulk-valid-operations-continue
      given: |
        A bulk patch contains an invalid operation followed by a valid operation
      when: |
        kspec item patch --bulk runs without --fail-fast
      then: |
        The valid operation after the invalid operation is applied
    - id: ac-bulk-invalid-operation-fails-command
      given: |
        A bulk patch contains at least one operation with invalid patch data
      when: |
        kspec item patch --bulk finishes processing the requested operations
      then: |
        The command exits with a failure status

- spec_ref: "@ac-annotation-identifier-format"
  add_acceptance_criteria:
    - id: ac-malformed-token-not-truncated
      given: |
        A coverage annotation contains an ac-prefixed token with unsupported
        characters or embedded punctuation, such as ac-valid.extra,
        ac-valid/path, ac-valid#anchor, or ac-valid?query
      when: |
        completeness validation parses the annotation
      then: |
        The malformed token is not truncated to a valid prefix and does not
        provide coverage credit to any acceptance criterion
    - id: ac-valid-delimiters-preserved
      given: |
        A coverage annotation separates valid acceptance criterion tokens with
        whitespace, a comma, or a comma followed by whitespace
      when: |
        completeness validation parses the annotation
      then: |
        Each delimiter-separated token is recognized as its own acceptance
        criterion token

- spec_ref: "@ac-annotation-integrity-reporting"
  add_acceptance_criteria:
    - id: ac-malformed-ac-token-reported
      given: |
        A configured coverage scan path contains an AC annotation with a
        malformed ac-prefixed acceptance criterion token
      when: |
        completeness validation runs
      then: |
        An invalid-annotation finding identifies the malformed token and the
        source location
```

## Tasks

derive_from_specs: false

```yaml
- title: Update specs for AC ID mutation and annotation hardening
  slug: task-ac-id-hardening-spec-updates
  priority: 1
  tags: [specs, validation, cli, coverage]
  spec_ref: "@acceptance-criterion-id-format"
  description: |
    Update the existing owning specs before implementation so later tasks can
    be reviewed against explicit behavioral contracts. Keep this task limited
    to kspec metadata/spec updates; do not change runtime, CLI, parser, or test
    code in this task.

    Why:
    - The existing acceptance criterion identifier format spec covers direct
      add and rename commands, but single-item and bulk patch paths also store
      acceptance criteria and must not become bypass surfaces.
    - The existing item patch spec documents strict validation, dry-run, bulk,
      fail-fast, and --allow-unknown behavior, but it does not say that known
      schema fields remain validated in bulk and allow-unknown modes.
    - The existing AC annotation specs say valid ac-prefixed tokens earn
      coverage and invalid annotations are repairable findings, but they do not
      explicitly prevent malformed tokens from being truncated into apparently
      valid prefixes.

    What:
    - Add @acceptance-criterion-id-format ac-patch-rejects-invalid-id with this
      exact behavioral shape:
        Given: A user supplies patch data that would store an acceptance
        criterion identifier that does not conform to the required token format.
        When: kspec validates the patch for a single item patch or bulk item
        patch.
        Then: The update is rejected before the catalog item is mutated.
    - Add @item-patch ac-allow-unknown-rejects-invalid-ac-id with this exact
      behavioral shape:
        Given: A user patches an item with --allow-unknown and the patch would
        store an acceptance criterion identifier that does not conform to the
        required token format.
        When: kspec item patch runs.
        Then: The command fails without writing the patch.
    - Add @item-patch ac-bulk-dry-run-rejects-invalid-ac-id with this exact
      behavioral shape:
        Given: A bulk patch dry-run includes an operation that would store an
        acceptance criterion identifier that does not conform to the required
        token format.
        When: kspec item patch --bulk --dry-run runs.
        Then: The operation is reported as an error instead of a successful
        preview.
    - Add @item-patch ac-bulk-invalid-operation-not-written with this exact
      behavioral shape:
        Given: A bulk patch contains an operation with invalid patch data.
        When: kspec item patch --bulk runs without --fail-fast.
        Then: The invalid operation is not written.
    - Add @item-patch ac-bulk-valid-operations-continue with this exact
      behavioral shape:
        Given: A bulk patch contains an invalid operation followed by a valid
        operation.
        When: kspec item patch --bulk runs without --fail-fast.
        Then: The valid operation after the invalid operation is applied.
    - Add @item-patch ac-bulk-invalid-operation-fails-command with this exact
      behavioral shape:
        Given: A bulk patch contains at least one operation with invalid patch
        data.
        When: kspec item patch --bulk finishes processing the requested
        operations.
        Then: The command exits with a failure status.
    - Add @ac-annotation-identifier-format ac-malformed-token-not-truncated with
      this exact behavioral shape:
        Given: A coverage annotation contains an ac-prefixed token with
        unsupported characters or embedded punctuation, such as ac-valid.extra,
        ac-valid/path, ac-valid#anchor, or ac-valid?query.
        When: completeness validation parses the annotation.
        Then: The malformed token is not truncated to a valid prefix and does
        not provide coverage credit to any acceptance criterion.
    - Add @ac-annotation-identifier-format ac-valid-delimiters-preserved with
      this exact behavioral shape:
        Given: A coverage annotation separates valid acceptance criterion tokens
        with whitespace, a comma, or a comma followed by whitespace.
        When: completeness validation parses the annotation.
        Then: Each delimiter-separated token is recognized as its own acceptance
        criterion token.
    - Add @ac-annotation-integrity-reporting ac-malformed-ac-token-reported with
      this exact behavioral shape:
        Given: A configured coverage scan path contains an AC annotation with a
        malformed ac-prefixed acceptance criterion token.
        When: completeness validation runs.
        Then: An invalid-annotation finding identifies the malformed token and
        the source location.
    - Set the implementation status of the four updated specs to in_progress so
      the new ACs are not claimed as implemented before the follow-up work
      lands.

    How:
    - Use `kspec item ac add` for each new acceptance criterion and `kspec item
      set` or the accepted metadata workflow to set implementation status.
    - Verify each target spec shows the new AC exactly once with `kspec item
      get`.
    - Do not create duplicate specs for these behaviors; the listed specs
      already own the relevant contracts.

    Testing:
    - Run targeted kspec inspection commands proving the new AC ids exist on the
      intended specs.
    - Run `kspec validate --refs --warnings-ok` and classify any pre-existing
      warnings separately from this task.

    Establishes:
    - @acceptance-criterion-id-format ac-patch-rejects-invalid-id
    - @item-patch ac-allow-unknown-rejects-invalid-ac-id
    - @item-patch ac-bulk-dry-run-rejects-invalid-ac-id
    - @item-patch ac-bulk-invalid-operation-not-written
    - @item-patch ac-bulk-valid-operations-continue
    - @item-patch ac-bulk-invalid-operation-fails-command
    - @ac-annotation-identifier-format ac-malformed-token-not-truncated
    - @ac-annotation-identifier-format ac-valid-delimiters-preserved
    - @ac-annotation-integrity-reporting ac-malformed-ac-token-reported

- title: Centralize AC ID validation across item patch surfaces
  slug: task-centralize-ac-id-patch-validation
  priority: 2
  tags: [cli, validation, schema, parser]
  spec_ref: "@acceptance-criterion-id-format"
  depends_on:
    - "@task-ac-id-hardening-spec-updates"
  description: |
    Make every item mutation path that can store acceptance criteria apply the
    same known-field validation before writing or reporting a successful dry-run
    preview.

    Why:
    - `kspec item ac add` and `kspec item ac set` already reject invalid
      acceptance criterion identifiers, but patch-style mutation paths can
      replace the full acceptance_criteria array.
    - Single `kspec item patch` currently validates patch data before dry-run,
      while bulk patch validates only operation shape before reporting dry-run
      success.
    - `--allow-unknown` should allow extension fields, not disable validation of
      known schema fields such as acceptance_criteria.
    - Parser-layer callers such as `updateSpecItem` should not be able to write
      invalid known fields when they bypass the CLI wrapper.

    What:
    - Add a shared validation helper for spec item patch/update data that:
      - validates known fields through the spec item schemas used by normal item
        creation/loading;
      - allows unknown fields only when the caller explicitly opts in;
      - still validates known fields when unknown fields are allowed;
      - formats validation errors consistently with existing item patch errors;
      - can be called by CLI single patch, CLI bulk patch, and parser-layer item
        update paths.
    - Update single `kspec item patch` to use the shared helper instead of
      having a separate CLI-only schema validation branch.
    - Update `patchSpecItems` so every bulk operation validates patch data before
      dry-run success and before real writes. Invalid operations must be counted
      as failed; later valid operations should continue unless `--fail-fast` is
      set.
    - Update `updateSpecItem` so direct parser-layer updates that include known
      schema fields are validated before YAML is written. The helper must not
      reject existing supported nested catalog structures only because they are
      stored in nested YAML files.
    - Replace direct AC ID regex validation in `kspec item ac add` and `kspec
      item ac set` with the shared AC ID schema/helper so user-facing AC ID
      validation messages do not drift from schema validation.
    - Preserve existing successful behavior for valid patches, unknown fields
      under `--allow-unknown`, and AC removal.

    How:
    - Inspect `src/schema/common.ts`, `src/schema/spec.ts`,
      `src/cli/commands/item.ts`, and `src/parser/yaml.ts` before editing.
    - Keep `acIdPattern` as the single token-pattern source and route
      user-facing mutation validation through `AcIdSchema` or a small helper
      built from it.
    - In bulk mode, validate after refs resolve and before the dry-run branch
      reports `updated`.
    - For parser-layer validation, validate the fields being patched and, where
      necessary, the merged item state before `writeYamlFilePreserveFormat`.
    - Maintain current bulk result semantics: invalid operations produce
      per-operation errors, `summary.failed` increments, and the command exits
      nonzero when any operation failed.

    Testing:
    - Add focused tests proving invalid `acceptance_criteria[].id` is rejected
      by single `kspec item patch` in dry-run and real modes.
    - Add focused tests proving `kspec item patch --bulk --dry-run` reports an
      invalid AC ID operation as failed rather than `updated`.
    - Add focused tests proving `kspec item patch --bulk` does not persist an
      invalid AC ID operation, still applies a later valid operation without
      `--fail-fast`, and skips later operations with `--fail-fast`.
    - Add a test proving `--allow-unknown` preserves unknown-field writes but
      rejects invalid known fields.
    - Add a parser-layer test proving direct `updateSpecItem` calls reject
      invalid acceptance_criteria before writing.
    - Run the focused item patch and AC ID tests plus `npm run typecheck`.

    Covers:
    - @acceptance-criterion-id-format ac-patch-rejects-invalid-id
    - @item-patch ac-allow-unknown-rejects-invalid-ac-id
    - @item-patch ac-bulk-dry-run-rejects-invalid-ac-id
    - @item-patch ac-bulk-invalid-operation-not-written
    - @item-patch ac-bulk-valid-operations-continue
    - @item-patch ac-bulk-invalid-operation-fails-command

- title: Reject malformed AC annotation tokens instead of truncating them
  slug: task-strict-ac-annotation-token-parsing
  priority: 2
  tags: [coverage, validation, parser]
  spec_ref: "@ac-annotation-identifier-format"
  depends_on:
    - "@task-ac-id-hardening-spec-updates"
  description: |
    Tighten coverage annotation parsing so malformed ac-prefixed tokens are
    detected as invalid annotations and never converted into coverage for a
    valid-looking prefix.

    Why:
    - Completeness validation uses AC annotations as direct evidence that code
      covers specific acceptance criteria.
    - A token such as `ac-valid.extra` or `ac-valid/path` is not the same
      identifier as `ac-valid`; granting coverage to the prefix can hide missing
      or mistyped evidence.
    - Valid comments still need ergonomic delimiters, so comma-separated and
      whitespace-separated AC tokens should continue to work.

    What:
    - Change the AC annotation tokenizer in `src/parser/validate.ts` so it
      preserves raw ac-prefixed token text long enough to distinguish valid
      tokens, supported delimiters, and malformed tokens.
    - Reject or ignore-with-finding malformed ac-prefixed tokens that contain
      unsupported punctuation or characters, including dotted, path-like,
      fragment-like, and query-like suffixes.
    - Ensure malformed tokens do not grant coverage to any valid prefix.
    - Preserve supported delimiters for valid tokens, including whitespace and
      comma separation.
    - Extend structured annotation data or validation plumbing as needed so
      malformed tokens can be reported with the token text, target reference,
      file, and line.
    - Report malformed ac-prefixed tokens as invalid-annotation findings during
      completeness validation.

    How:
    - Inspect `parseACAnnotationLine`, `scanDirForACAnnotations`,
      `scanDirForACAnnotationsStructured`, and `validateACAnnotations` in
      `src/parser/validate.ts` before editing.
    - Avoid extracting candidates with a regex that can match a valid prefix
      inside a longer malformed token.
    - Prefer tokenization that treats only whitespace, comma, end-of-line, and
      documented suffix boundaries such as the existing N/A and parenthetical
      stripping as non-token delimiters.
    - Keep valid examples such as `// AC: @spec ac-good, ac-ok` working.
    - Update user-facing warning text so a maintainer can repair the malformed
      token without guessing what was parsed.

    Testing:
    - Add parser tests for malformed tokens such as `ac-good.extra`,
      `ac-good/path`, `ac-good#anchor`, `ac-good?query`, and `ac-good:` proving
      they do not parse as `ac-good`.
    - Add coverage tests proving a spec with `ac-good` remains uncovered when
      the only annotation is `@spec ac-good.extra`.
    - Add completeness validation tests proving malformed tokens produce
      invalid-annotation findings with source location.
    - Add regression tests proving comma-separated and whitespace-separated
      valid tokens still provide coverage.
    - Run focused AC annotation tests plus `npm run typecheck`.

    Covers:
    - @ac-annotation-identifier-format ac-malformed-token-not-truncated
    - @ac-annotation-identifier-format ac-valid-delimiters-preserved
    - @ac-annotation-integrity-reporting ac-malformed-ac-token-reported

- title: Validate AC ID hardening end to end
  slug: task-ac-id-hardening-final-gate
  priority: 3
  tags: [validation, tests, qa]
  spec_ref: "@acceptance-criterion-id-format"
  depends_on:
    - "@task-centralize-ac-id-patch-validation"
    - "@task-strict-ac-annotation-token-parsing"
  description: |
    Run an end-to-end validation gate for the AC ID hardening work and record
    evidence that both patch validation and annotation parsing now enforce the
    finalized specs.

    Why:
    - The work touches CLI mutation, parser-layer writes, bulk result handling,
      dry-run previews, and coverage validation.
    - A final focused gate prevents one surface from being fixed while another
      still grants false success or false coverage.

    What:
    - Run the focused item patch, AC ID format, AC annotation identifier, AC
      annotation validation, and AC ID gate tests that cover the new behavior.
    - Run `npm run typecheck`.
    - Run `kspec validate --refs --warnings-ok`, `kspec validate --alignment
      --warnings-ok`, and `kspec validate --completeness --warnings-ok`.
    - Re-run the catalog AC ID scan or equivalent validation proving stored
      acceptance criterion identifiers still conform to the required format.
    - Inspect the new bulk patch and malformed annotation behavior manually if a
      focused test failure would otherwise be ambiguous.
    - Update the implementation status of the four hardened specs to
      implemented only after the focused tests and validation evidence pass.

    How:
    - Use the project test runner (`npm test -- --fresh ...`) rather than
      invoking the underlying test framework directly.
    - If validation emits pre-existing warnings unrelated to this plan, record
      them separately and do not count them as plan-specific failures.
    - Include exact command output snippets or file paths to logs in the task
      completion note so the reviewer can verify the evidence.

    Testing:
    - Focused AC ID and item patch tests pass.
    - Focused AC annotation parser/validation tests pass.
    - Typecheck passes.
    - kspec refs, alignment, and completeness validation complete with only
      classified pre-existing warnings.

    Covers:
    - @acceptance-criterion-id-format ac-patch-rejects-invalid-id
    - @item-patch ac-allow-unknown-rejects-invalid-ac-id
    - @item-patch ac-bulk-dry-run-rejects-invalid-ac-id
    - @item-patch ac-bulk-invalid-operation-not-written
    - @item-patch ac-bulk-valid-operations-continue
    - @item-patch ac-bulk-invalid-operation-fails-command
    - @ac-annotation-identifier-format ac-malformed-token-not-truncated
    - @ac-annotation-identifier-format ac-valid-delimiters-preserved
    - @ac-annotation-integrity-reporting ac-malformed-ac-token-reported
```

## Implementation Notes

The current implementation has two relevant validation asymmetries:

- Single `kspec item patch` validates patch data before dry-run and before
  writing, but `kspec item patch --bulk --dry-run` currently validates only the
  operation shape before reporting success.
- `parseACAnnotationLine` extracts `ac-*` substrings before validating the
  shared AC ID pattern, so punctuation-adjacent malformed tokens can be
  shortened into valid-looking prefixes.

This plan keeps the original AC ID normalization plan closed and treats these
as follow-up hardening. Spec updates are separated from implementation so agents
work from explicit ACs rather than chat history. The implementation tasks are
parallel after the spec-update task because patch validation and annotation
parsing touch different codepaths. The final gate depends on both behavior
changes so status updates and validation evidence happen after both surfaces are
covered.
