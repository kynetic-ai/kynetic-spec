# AC Coverage Verification Schema and Storage

> **Approval gate:** Do not approve or derive this plan until
> @plan-ui-redesign-global-decisions (P0a) is approved and derived.
> The binding depends_on refs in this plan
> (@annotation-freshness-provenance, @actor-identity-model,
> @ac-coverage-applicability) resolve only after P0a materializes.
> See Implementation Notes → Approval gate and ordering.

## Specs

```yaml
# ─── Verification Record Storage ───

- title: AC Verification Record Store
  slug: ac-verification-record-store
  type: feature
  depends_on:
    - "@annotation-freshness-provenance"
    - "@actor-identity-model"
  description: |
    Durable storage for per-acceptance-criterion verification stamps. A
    stamp records that a criterion's test mapping was confirmed,
    capturing when the verification happened, which actor performed it,
    and which provenance class produced it — a validation pass, an
    ingested test run, or an explicit re-verification. Stamps live in an
    operational sidecar within the project's shadow-branch metadata,
    keyed by the owning item's canonical identifier and the criterion
    id; spec source files never carry verification state. The store
    holds one current stamp per criterion, and superseded stamps remain
    recoverable through the metadata's version history. Stamp writes
    commit to the shadow-branch history like other metadata mutations,
    so a fresh checkout of the metadata reproduces the store.
  acceptance_criteria:
    - id: ac-keyed-by-canonical-identity
      given: |
        a verification stamp stored for an acceptance criterion
      when: |
        the owning spec item is later renamed or moved to a different
        spec source file
      then: |
        the stamp still resolves to the same acceptance criterion
    - id: ac-stamp-read-back
      given: |
        a verification stamp written with a verification time, an
        actor, and a provenance class drawn from the recorded classes
        — validation pass, ingested run, or explicit re-verification
      when: |
        the stamp is accepted and read back
      then: |
        it carries the same verification time, actor, and provenance
        class
    - id: ac-incomplete-stamp-rejected
      given: |
        a verification stamp write missing its verification time, its
        actor, or its provenance class
      when: |
        the write is attempted
      then: |
        the write is rejected and the stored verification state is
        unchanged
    - id: ac-spec-source-untouched
      given: |
        a project's spec source files
      when: |
        any verification stamp is written or replaced
      then: |
        the content of every spec source file is byte-identical to its
        content before the write
    - id: ac-current-stamp-replacement
      given: |
        an acceptance criterion that already has a stored verification
        stamp
      when: |
        a new stamp is written for that criterion
      then: |
        reads return only the new stamp as the current verification,
        and the prior stamp is recoverable from the metadata's version
        history rather than from the live store
    - id: ac-versioned-persistence
      given: |
        a verification stamp write that completes
      when: |
        the project's shadow-branch metadata is checked out fresh
        elsewhere
      then: |
        the same current stamps are reproduced in the fresh checkout
    - id: ac-unresolvable-keys-tolerated
      given: |
        a stored stamp whose item identifier or criterion id no longer
        resolves to an existing acceptance criterion
      when: |
        the store is loaded
      then: |
        loading succeeds, the unresolvable stamp is excluded from
        resolved verification reads, and validation reports it as an
        orphaned verification record rather than silently dropping it
        or failing

- title: AC Freshness Resolution
  slug: ac-freshness-resolution
  type: requirement
  parent: "@ac-verification-record-store"
  depends_on:
    - "@annotation-freshness-provenance"
    - "@coverage-scan-config"
  description: |
    The read contract resolving an acceptance criterion's annotation
    freshness from two provenance sources — bootstrap-derived and
    recorded. When no recorded verification stamp exists, freshness
    derives from version-control history of the annotation's location
    — a bootstrap value that requires no prior bookkeeping, so every
    annotation whose location has version-control history has
    freshness from day one. When a criterion has annotations at
    several locations and no recorded stamp, the bootstrap value is
    the most recent of the history values of the locations that have
    version-control history; locations without history contribute no
    value. A location with
    no version-control history — an uncommitted file, or a line that
    exists only in the working tree — yields no bootstrap value;
    until such a location gains history or a recorded stamp is
    written, the criterion's freshness is absent, and absent
    freshness is a distinct, observable outcome — not a present-time
    value, not an error. Once a recorded stamp exists for a
    criterion, resolution returns the stamp verbatim as the resolved
    freshness; resolution never compares a recorded stamp against
    annotation history, and the bootstrap-derived value remains
    separately retrievable alongside it, so a consumer assessing
    whether a stamp predates later annotation edits performs that
    comparison itself. Resolved freshness always names its provenance
    source, recorded values also carry the stamp's provenance class,
    and a freshness value is expressed as a timestamp, a commit
    reference, or both.
  acceptance_criteria:
    - id: ac-bootstrap-when-unstamped
      given: |
        an acceptance criterion with at least one annotation in a
        configured scan path whose location has version-control
        history, and no recorded verification stamp
      when: |
        its freshness is resolved
      then: |
        the result is a bootstrap value derived from the
        version-control history of the annotation's location, labeled
        with the bootstrap provenance source
    - id: ac-recorded-supersedes-bootstrap
      given: |
        an acceptance criterion with a recorded verification stamp
      when: |
        its freshness is resolved
      then: |
        the recorded stamp is returned verbatim — carrying its
        provenance class — as the resolved freshness, and the
        bootstrap value is not used as the resolved freshness,
        including when the version-control history at the
        annotation's location is more recent than the stamp
    - id: ac-both-provenances-retrievable
      given: |
        an acceptance criterion with a recorded verification stamp and
        at least one annotation in a configured scan path whose
        location has version-control history
      when: |
        a consumer requests the bootstrap-derived value alongside the
        resolved freshness
      then: |
        both the recorded stamp and the bootstrap-derived value are
        returned, each labeled with its provenance source, and the
        resolution neither alters nor compares them
    - id: ac-multi-annotation-most-recent
      given: |
        an acceptance criterion with annotations at several locations
        in configured scan paths, at least one location having
        version-control history, and no recorded verification stamp
      when: |
        its freshness is resolved
      then: |
        the bootstrap value is the most recent of the history values
        of the locations that have version-control history, locations
        without history contribute no value, and the result is
        labeled with the bootstrap provenance source
    - id: ac-no-history-absence
      given: |
        an acceptance criterion with no recorded verification stamp
        whose annotations are all at locations with no version-control
        history
      when: |
        its freshness is resolved
      then: |
        no freshness value is produced for that criterion, the absence
        is reported as a distinct observable outcome, and no
        present-time or fabricated value is substituted and no error
        is raised
    - id: ac-timestamp-or-commit
      given: |
        a resolved freshness value
      when: |
        it is delivered to a consumer
      then: |
        it carries a timestamp, a commit reference, or both, and it
        names its provenance source
    - id: ac-absence-reported
      given: |
        an acceptance criterion with no annotation in any configured
        scan path and no recorded verification stamp
      when: |
        freshness resolution runs
      then: |
        no freshness value is produced for that criterion — absence is
        reported as absence, not as a default or fabricated value

- title: Session Verification Evidence
  slug: verification-session-evidence
  type: requirement
  parent: "@ac-verification-record-store"
  description: |
    Verification stamps can attribute a verification to the work
    session that produced it. The session linkage is part of the stored
    record: reading a stamp yields the producing session's identity
    from the record alone, so a consumer can answer "when was this
    criterion last verified, and by which session" without correlating
    other data sources. Session linkage is optional — verifications
    produced outside any session omit it. When a session reference is
    supplied, it must be a well-formed session identifier; a malformed
    reference rejects the write rather than storing an unusable
    linkage.
  acceptance_criteria:
    - id: ac-session-reference-stored
      given: |
        a verification stamp written with the identity of the session
        that produced the verification
      when: |
        the stamp is stored
      then: |
        the record carries the session reference alongside the
        verification time, actor, and provenance class
    - id: ac-sessionless-stamps-valid
      given: |
        a verification stamp produced outside any recorded session
      when: |
        it is written without a session reference
      then: |
        the stamp is accepted, and reads return it with no session
        linkage
    - id: ac-malformed-session-ref-rejected
      given: |
        a verification stamp write carrying a session reference that
        is not a well-formed session identifier
      when: |
        the write is attempted
      then: |
        the write is rejected and the stored verification state is
        unchanged
    - id: ac-evidence-readable-from-record
      given: |
        a stored stamp carrying a session reference
      when: |
        the stamp is read
      then: |
        the producing session's identity is returned with the stamp,
        from the stored record alone, without consulting session logs
        or any other records
    - id: ac-pruned-session-tolerated
      given: |
        a stored stamp whose session reference names a session that no
        longer exists
      when: |
        the stamp is read
      then: |
        the read succeeds, the stamp remains a valid verification, and
        the session linkage is reported as unresolvable rather than
        being dropped or failing the read

- title: Coverage Record Compatibility
  slug: coverage-record-compatibility
  type: requirement
  parent: "@ac-verification-record-store"
  depends_on:
    - "@data-format-forward-compatibility"
  description: |
    The verification record store is additive and optional. A project
    containing no verification records is fully valid, behaves exactly
    as it did before the store existed, and is never rewritten by tool
    upgrade. The store materializes only when the first stamp is
    written. Because the store is purely additive, a project that
    contains one remains fully operable by tool versions predating the
    store — such tools neither read nor modify it. That older-tool
    guarantee is the purpose served by two verifiable properties:
    metadata readers leave sidecar directories they do not recognize
    unread and unmodified, and creating the store modifies no
    pre-existing metadata file an older reader depends on. Stored records
    declare a record-format version: data declaring a newer record
    format than the running tool supports is refused rather than
    misread, and records carrying unrecognized fields survive
    read-modify-write cycles intact.
  acceptance_criteria:
    - id: ac-absent-store-no-behavior-change
      given: |
        a project containing no verification record store
      when: |
        any command or daemon request reads coverage or freshness data
      then: |
        the operation succeeds, freshness resolves through the
        bootstrap provenance source alone, and no store is created as
        a side effect of the read
    - id: ac-upgrade-without-rewrite
      given: |
        an existing project created before the verification record
        store existed
      when: |
        the tool is upgraded and ordinary commands run
      then: |
        no project data is rewritten, no migration step is required,
        and the project manifest's declared format version is
        unchanged
    - id: ac-first-write-materializes
      given: |
        a project with no verification record store
      when: |
        the first verification stamp is written
      then: |
        the store is created as part of that write and the write
        succeeds without any prior setup or migration step
    - id: ac-newer-record-format-refused
      given: |
        a verification record store declaring a record-format version
        greater than the running tool's maximum supported record
        format
      when: |
        the store is read or written
      then: |
        the operation on the store refuses with an error naming both
        the declared version and the maximum supported version, the
        store is not modified, and operations not involving the store
        remain unaffected
    - id: ac-unknown-fields-roundtrip
      given: |
        stored verification records containing fields the running tool
        does not recognize, within a supported record-format version
      when: |
        the tool reads the store and writes a stamp for a different
        criterion
      then: |
        the unrecognized fields persist unchanged in the stored
        records
    - id: ac-unrecognized-sidecar-untouched
      given: |
        a project's shadow-branch metadata containing a sidecar
        directory the running tool does not recognize
      when: |
        the metadata is loaded, validated, and written elsewhere
      then: |
        the operations succeed and the unrecognized directory's files
        are neither read nor modified
    - id: ac-store-creation-additive
      given: |
        a project's shadow-branch metadata without a verification
        record store
      when: |
        the store is created by the first stamp write
      then: |
        no metadata file that existed before the write is modified by
        the store's creation
```

## Tasks

derive_from_specs: false

```yaml
- title: Implement the per-AC verification record store
  slug: task-ac-verification-record-store
  priority: 1
  tags: [coverage, schema, storage]
  spec_ref: "@ac-verification-record-store"
  description: |
    Build the shadow-branch sidecar store for per-AC verification
    stamps: record schema, canonical keying, replace-on-write
    semantics, versioned persistence, and tolerant loading.

    Why: Coverage freshness needs durable per-AC verification state,
    but the AC schema is bare {id, given, when, then} and spec source
    must not carry operational stamps. A sidecar in shadow-branch
    metadata keyed by item ULID + AC id gives stamps a versioned home
    that travels with project metadata, keeps spec source byte-stable,
    and gets history and sync for free.

    What:
    - Define the record schema (Zod): one record per spec item keyed by
      item ULID, holding a map of AC id → current stamp. Stamp fields:
      verified_at (timestamp), actor (string; canonical identity per
      @actor-identity-model), provenance (enum: validation | ingestion
      | re_verification), optional commit reference, optional session
      reference (semantics wired in @task-session-verification-evidence
      — include the field shape here so the schema lands once).
    - Reject stamps missing verified_at, actor, or provenance at write
      time via schema validation.
    - Storage layout: a new sidecar directory under the shadow-branch
      state, one file per item ULID (suggested layout in Implementation
      Notes). Writes go through the standard save + shadow auto-commit
      machinery so every stamp write is a shadow commit.
    - Replace-on-write: writing a stamp for an AC replaces the current
      stamp for that AC; supersession history is the shadow commit
      history, not live records.
    - Tolerant loads: a record whose item ULID or AC id no longer
      resolves loads without error, is excluded from resolved
      verification reads, and surfaces as an orphaned-verification
      completeness finding in validation.
    - Tests: stamp write/read round-trip; rejection of incomplete
      stamps; slug rename and item file move keep stamps resolvable
      (ULID keying); spec module files byte-identical across stamp
      writes; fresh shadow checkout reproduces stamps; orphan record
      load tolerance and validation finding.

    How: Schema in src/schema/ alongside the other record schemas;
    a storage manager in src/parser/ following the existing
    folder-storage manager precedent (reviews, sessions); writes commit
    through the same commitIfShadow path as other metadata mutations.
    The store exposes a programmatic read/write API — no CLI or daemon
    endpoint changes in this task beyond the validation orphan finding.

    Covers: @ac-verification-record-store ac-keyed-by-canonical-identity,
    ac-stamp-read-back, ac-incomplete-stamp-rejected,
    ac-spec-source-untouched, ac-current-stamp-replacement,
    ac-versioned-persistence, ac-unresolvable-keys-tolerated.

- title: Implement freshness resolution with bootstrap and recorded provenance
  slug: task-freshness-resolution-read-path
  priority: 1
  tags: [coverage, parser, storage]
  spec_ref: "@ac-freshness-resolution"
  depends_on:
    - "@task-ac-verification-record-store"
  description: |
    Build the freshness resolver: per-AC freshness values resolved from
    recorded verification stamps when present, otherwise bootstrapped
    from version-control history of the annotation's location.

    Why: The coverage-state engine (a later plan) consumes per-AC
    freshness; the resolution rule — recorded supersedes bootstrap —
    is the storage layer's read contract per
    @annotation-freshness-provenance, and the bootstrap source is what
    makes the system useful on day one for ~20 existing projects with
    thousands of annotations and an empty store.

    What:
    - A resolver that takes an acceptance criterion plus its annotation
      locations (from the existing structured scan, which already
      yields file and line per annotation) and returns a freshness
      value: { timestamp?, commit?, provenance }.
    - Bootstrap derivation: query the code repository's history for the
      annotation's location (last commit touching the annotation line —
      blame-style lookup, batched per file for performance) and label
      the result with bootstrap provenance. Nothing is written to the
      store; bootstrap is always derived on read.
    - Multi-annotation rule: when an AC has several annotation
      locations and no recorded stamp, the bootstrap value is the most
      recent of the history values of the locations that have
      version-control history; locations without history contribute no
      value, so the mixed case (some locations with history, some
      without) resolves to the most recent of the values that exist,
      per ac-multi-annotation-most-recent (see Implementation Notes).
    - No-history locations: an annotation location without
      version-control history (uncommitted file, or a line that exists
      only in the working tree) yields no bootstrap value; an AC whose
      only annotations sit at such locations and which has no recorded
      stamp resolves to absent freshness — a distinct observable
      outcome, not a present-time value and not an error.
    - Recorded lookup: when the store holds a stamp for the AC, return
      it verbatim — with its provenance class — as the resolved
      freshness and do not use the bootstrap value as the resolved
      freshness, even if the annotation location's history is newer
      than the stamp. The bootstrap-derived value stays separately
      retrievable alongside the stamp on request; the resolver
      performs no staleness comparison between them (that is the
      coverage-state engine's job, in a later plan).
    - Absence: an AC with neither an annotation in configured scan
      paths nor a recorded stamp yields no freshness value.
    - Tests: bootstrap-only resolution in a fixture repo with committed
      annotations; recorded-wins including the bootstrap-newer case;
      both-provenances read returning the stamp and the bootstrap
      value side by side, unaltered; most-recent-wins across multiple
      annotated locations; the mixed case — some annotated locations
      with version-control history, some without — resolving to the
      most recent of the existing history values; absent freshness
      for an annotated-but-uncommitted location;
      timestamp/commit/provenance shape on every resolved value;
      absence for unannotated, unstamped ACs.

    How: New module alongside the existing coverage cache in
    src/parser/; reuse the structured annotation scan for locations and
    the existing git utilities for code-repo history queries. The
    resolver is a pure read API — the engine plan, not this one, turns
    freshness into coverage states.

    Covers: @ac-freshness-resolution ac-bootstrap-when-unstamped,
    ac-recorded-supersedes-bootstrap, ac-both-provenances-retrievable,
    ac-multi-annotation-most-recent, ac-no-history-absence,
    ac-timestamp-or-commit, ac-absence-reported.

- title: Add session evidence linkage to verification stamps
  slug: task-session-verification-evidence
  priority: 2
  tags: [coverage, schema, sessions]
  spec_ref: "@verification-session-evidence"
  depends_on:
    - "@task-ac-verification-record-store"
  description: |
    Wire the optional session reference on verification stamps:
    write-side acceptance, read-side exposure, and tolerant resolution
    when the referenced session is gone.

    Why: "Last verified by session X" is a named provenance surface for
    the redesign's spec workspace and validate views. The UI and the
    write flows arrive in later plans, but the record shape must exist
    now so stamps written by any future flow carry session evidence
    from the start instead of needing a second migration.

    What:
    - Accept an optional session reference on stamp writes; validate
      its shape (a session identifier as recorded by the session
      store); accept stamps without one unchanged.
    - Reads return the session reference with the stamp, from the
      stored record alone — no lookup against session logs or other
      records is needed to answer which session produced the
      verification.
    - Tolerant resolution: a stamp whose session reference names a
      session that no longer exists (sessions can be pruned) reads
      successfully, remains a valid verification, and reports the
      linkage as unresolvable rather than dropping it or failing.
    - Tests: write/read round-trip with and without session reference;
      malformed session identifier rejected at write; pruned-session
      read tolerance.

    How: Extends the stamp schema and storage manager from
    @task-ac-verification-record-store (the field shape lands there;
    this task implements its validation, read exposure, and tolerance
    semantics plus their tests).

    Covers: @verification-session-evidence ac-session-reference-stored,
    ac-sessionless-stamps-valid, ac-malformed-session-ref-rejected,
    ac-evidence-readable-from-record, ac-pruned-session-tolerated.

- title: Respec test-annotation-sweep so not-applicable annotations are not coverage signals
  slug: task-respec-test-annotation-sweep-na
  priority: 2
  tags: [specs, maintenance, coverage]
  spec_ref: "@test-annotation-sweep"
  description: |
    Update @test-annotation-sweep (AC Annotation Coverage Semantics) so
    not-applicable-marked annotations no longer count as coverage, per
    @ac-coverage-applicability.

    Why: @test-annotation-sweep currently defines annotation coverage
    semantics through ac-explicit-mapping, ac-annotation-format, and
    ac-no-blanket-credit — under which an annotation that names AC ids
    earns coverage credit. Because the parser strips the N/A suffix
    before tokenizing, an in-code N/A annotation is indistinguishable
    from a coverage claim and silently counts as covered, with its
    reason discarded. @ac-coverage-applicability supersedes that
    behavior: in-code not-applicable annotations are not coverage
    signals — they neither cover a criterion nor exempt it.
    @ac-coverage-applicability's description draws a transition
    boundary — the pre-existing completeness path that honors N/A for
    trait criteria stays in force "until the coverage state engine
    work reconciles the two semantics." Per the decision register,
    this respec (with @task-na-annotation-coverage-exclusion) IS that
    reconciliation: the N/A-stop is assigned to this plan, not to the
    later engine plan, so this task also amends the boundary sentence
    so the live decision text and the implemented behavior agree.

    What:
    - Update the item description to state that coverage credit
      accrues only to annotations that claim coverage; an annotation
      carrying a not-applicable marker claims none.
    - Add three ACs to @test-annotation-sweep, with these stable ids:
      ac-na-no-coverage-credit — a well-formed annotation carrying a
      not-applicable marker grants no coverage credit for the AC ids
      it names;
      ac-na-no-invalid-finding — such an annotation produces no
      invalid-annotation finding — it remains a valid task-scoped
      marker while the in-code convention exists (integrity checks on
      its target reference and AC ids still apply);
      ac-na-marker-preserved — structured scan output preserves the
      not-applicable marker and its reason text rather than discarding
      them.
    - Add depends_on @ac-coverage-applicability to the item so the
      decision linkage is durable.
    - Reconcile @ac-annotation-integrity-reporting
      ac-valid-annotation-covers-target: narrow its given clause to
      coverage-claiming annotations (those without a not-applicable
      marker) so the two items do not contradict once N/A annotations
      stop covering.
    - Reconcile @ac-annotation-identifier-format
      ac-valid-token-covers-ac the same way: its given ("A coverage
      annotation names an existing acceptance criterion using the
      required token format") currently grants coverage credit to any
      valid token, which an N/A-marked annotation still carries.
      Narrow the given to coverage-claiming annotations (those without
      a not-applicable marker) so no live AC grants coverage credit to
      an N/A-marked annotation.
    - Reconcile @trait-validation ac-2 the same way: its when clause
      ("trait AC has test annotation '// AC: @trait-ref ac-N'") is
      satisfied today by an N/A-marked annotation because the parser
      strips the marker before matching, so the AC currently promises
      warning suppression that this respec removes. Narrow it to
      coverage-claiming annotations (those without a not-applicable
      marker) so a trait AC whose only annotations carry N/A markers
      may warn without contradicting a live AC.
    - Amend @ac-coverage-applicability's transition boundary (the item
      is live by the time this task runs — this plan derives only
      after P0a): replace the deferral to "the coverage state engine
      work" with this plan's respec, stating that the pre-existing
      completeness path honors in-code not-applicable annotations for
      trait criteria only until the respecced @test-annotation-sweep
      semantics are implemented (@task-na-annotation-coverage-exclusion),
      which completes the reconciliation. Leave its ac-1/ac-2
      untouched — they remain engine-scoped and are claimed by the
      engine plan per P0a's AC coverage handoff table.

    How: kspec item set / item ac add / item ac set via a single kspec
    batch; verify the result with kspec item get on all five mutated
    items (@test-annotation-sweep, @ac-annotation-integrity-reporting,
    @ac-annotation-identifier-format, @trait-validation,
    @ac-coverage-applicability). Spec mutation only — the parser
    behavior change is @task-na-annotation-coverage-exclusion, which
    depends on this task.

    Covers: @test-annotation-sweep ac-na-no-coverage-credit,
    ac-na-no-invalid-finding, ac-na-marker-preserved (the new ACs this
    task adds, plus the description update);
    @ac-annotation-integrity-reporting ac-valid-annotation-covers-target,
    @ac-annotation-identifier-format ac-valid-token-covers-ac, and
    @trait-validation ac-2 (given/when-clause reconciliation only).

- title: Stop counting not-applicable annotations as coverage in the scanner
  slug: task-na-annotation-coverage-exclusion
  priority: 2
  tags: [coverage, parser]
  spec_ref: "@test-annotation-sweep"
  depends_on:
    - "@task-respec-test-annotation-sweep-na"
  description: |
    Implement the respecced annotation semantics: the scanner parses
    the not-applicable marker into structured annotation records
    instead of stripping it, and N/A-marked annotations contribute
    nothing to the coverage set.

    Why: Today parseACAnnotationLine strips the N/A suffix and discards
    the reason before tokenizing, so the AC ids land in the coverage
    set and the annotation counts as covered everywhere downstream.
    That behavior is explicitly superseded by
    @ac-coverage-applicability and the respecced
    @test-annotation-sweep: corpus coverage must not treat
    not-applicable markers as coverage signals.

    What:
    - Parse the not-applicable marker and its reason into the
      structured annotation record (extend the parsed-group and
      structured-annotation shapes with a not-applicable flag and
      reason text) instead of stripping them from the line.
    - Exclude AC ids named by not-applicable-marked annotations from
      the flat coverage set, so they earn no coverage credit in
      completeness validation, item APIs, task review context, or
      static export.
    - Keep integrity validation applying to N/A-marked annotations
      (unresolved targets, missing AC ids, and malformed tokens still
      produce findings) while a well-formed N/A annotation itself
      produces no invalid-annotation finding.
    - Accept the intended consequence: an AC whose only annotations are
      not-applicable becomes uncovered in completeness warnings. Do not
      add compensating behavior; surfacing those as spec-composition
      work is the decision's intent. Update this repo's affected tests
      and AC annotations where they assert the old semantics — but
      fixing newly-uncovered ACs across the corpus is follow-up
      spec-composition work, not part of this task.
    - Tests: N/A-marked line parses with flag and reason preserved;
      coverage set excludes its AC ids; mixed lines (coverage claim for
      one spec ref, N/A for another) credit only the claim; well-formed
      N/A annotation yields no integrity finding; N/A annotation with a
      bad target still yields the existing integrity findings.

    How: Changes concentrate in the annotation parsing and scanning
    layer of src/parser/validate.ts and its consumers
    (computeACCoverage call sites, structured scan consumers). Keep the
    structured shapes backward-compatible extensions so existing
    consumers compile unchanged.

    Covers: @test-annotation-sweep ac-na-no-coverage-credit,
    ac-na-no-invalid-finding, ac-na-marker-preserved (added by
    @task-respec-test-annotation-sweep-na).

- title: Implement coverage record compatibility and format gating
  slug: task-coverage-record-compatibility
  priority: 2
  tags: [coverage, schema, migration]
  spec_ref: "@coverage-record-compatibility"
  depends_on:
    - "@task-ac-verification-record-store"
    - "@task-freshness-resolution-read-path"
  description: |
    Make the verification record store provably additive: optional
    everywhere, materialized only on first write, gated by a declared
    record-format version, and tolerant of unknown fields.

    Why: kspec is deployed across ~20 real projects that must upgrade
    without rewrite or migration. The store must be invisible until
    used, and its future evolution needs the same forward-compatibility
    discipline @data-format-forward-compatibility established for the
    project manifest — refuse newer-than-supported data rather than
    misreading it.

    What:
    - Optionality: a project with no verification record store loads,
      validates, and serves coverage/freshness reads exactly as before
      the store existed; freshness resolves through the bootstrap
      provenance source alone (via the resolver from
      @task-freshness-resolution-read-path — hence the dependency),
      and reads never create the store as a side effect.
    - First-write materialization: the first stamp write creates the
      sidecar (directory and record file) as part of that write, with
      no prior setup or migration step.
    - Record-format gating: every record file declares a record-format
      version; reading or writing a store declaring a newer version
      than the running tool supports refuses with an error naming both
      versions, leaves the store unmodified, and does not affect
      operations that do not involve the store. The project manifest's
      declared format version is not bumped by this feature.
    - Unknown-field tolerance: record fields the running tool does not
      recognize survive read-modify-write cycles unchanged (write a
      stamp for a different criterion; assert the unknown fields
      persist).
    - Upgrade verification: fixture project created without the store
      (temp-project E2E) — run upgrade and ordinary commands; assert no
      project file is rewritten, no migration prompt appears, and the
      manifest format version is unchanged.
    - Older-tool tolerance (ac-unrecognized-sidecar-untouched,
      ac-store-creation-additive): the spec keeps the older-tool
      guarantee in its description as the purpose; the ACs bind the
      two properties the current system can verify directly.
      Shadow-state loading enumerates only the paths it knows, so
      assert that an unrecognized sidecar directory in shadow state is
      ignored by readers — loads, validation, and writes elsewhere
      succeed, and its files are neither read nor rewritten
      (ac-unrecognized-sidecar-untouched) — and that creating the
      verification sidecar on first stamp write modifies no
      pre-existing metadata file (ac-store-creation-additive).
    - Tests annotate the relevant @data-format-forward-compatibility
      precedent only where this store's gating intersects it; the
      manifest-level contract keeps its own coverage.

    How: Gating and tolerance live in the store's load/save layer from
    @task-ac-verification-record-store; upgrade verification uses the
    existing temp-project fixture helpers. Follow the
    storage-compatibility gate precedent for older-format leniency.

    Covers: @coverage-record-compatibility
    ac-absent-store-no-behavior-change, ac-upgrade-without-rewrite,
    ac-first-write-materializes, ac-newer-record-format-refused,
    ac-unknown-fields-roundtrip, ac-unrecognized-sidecar-untouched,
    ac-store-creation-additive.
```

## Implementation Notes

### What this plan is

P1a of the web-UI redesign program: the storage foundation of the
coverage-state engine. It defines and implements the records — the
verification stamp store, the freshness read contract, session
evidence linkage, and the compatibility guarantees — plus the
N/A-annotation respec. The engine that computes coverage states,
test-result ingestion, per-AC revision diff APIs, rollups, caching
domains, and every UI surface are later plans and explicitly out of
scope here.

### Storage home decision

Spec source must not carry operational stamps, so four candidate homes
were weighed:

| Candidate | Verdict |
|---|---|
| Spec source (AC fields in module files) | Rejected — operational churn in reviewed spec content; every verification would dirty spec diffs and reviews, and stamps would be lost or mangled by spec-file editing flows |
| Local filesystem / daemon config dir | Rejected — verification evidence is project state: it must travel with the project across clones, machines, and agents, and benefits from history. The daemon config dir is for daemon-level state (per @client-preference-persistence), not project data |
| Code branch | Rejected — stamps describe spec-corpus state and would tangle with feature branches and merges |
| Shadow-branch sidecar (chosen) | Versioned by the existing auto-commit machinery, syncs through the shadow remote, keeps spec source byte-stable, and the shadow YAML merge driver already handles concurrent writes from parallel agents |

Suggested layout: a `coverage/verifications/` directory in the shadow
state, one file per spec item named by its ULID, following the
folder-storage precedent set by reviews and sessions. File-per-item
bounds write churn and the merge surface. Suggested record shape:

```yaml
format: 1
acs:
  ac-some-criterion:
    verified_at: 2026-06-10T12:00:00Z
    actor: pr-reviewer
    provenance: ingestion        # validation | ingestion | re_verification
    commit: abc1234              # optional — code commit verified against
    session: 01KT...             # optional — producing session id
```

These paths and shapes are implementation suggestions; the specs bind
behavior (keying, replacement, tolerance, gating), not layout.

### Provenance vocabulary

Freshness has two provenance **sources**; recorded stamps additionally
carry a provenance **class**:

- **bootstrap** (source) — derived on read from version-control
  history of the annotation's location in the code repository. Never
  stored; the store starts empty in every project, so there is no
  backfill migration anywhere.
- **recorded** (source) — a stored verification stamp, carrying a
  provenance class: `validation` | `ingestion` | `re_verification`.
  The flows that write them — validation-pass wiring, result
  ingestion, explicit re-verify commands and UI — arrive in later
  plans. This plan ships the storage layer and its programmatic
  read/write contract only; no new CLI commands or daemon endpoints
  beyond validation's orphaned-record finding.

### Current-stamp-only design

The live store keeps one stamp per AC; supersession history is the
shadow commit history — free, append-only, and auditable — mirroring
how note supersession relies on append-only records. This keeps the
store bounded (no unbounded per-AC growth) while losing nothing: the
"last verified by" question reads the live record, and forensics read
shadow history.

### Multi-annotation bootstrap rule

When an AC has several annotation locations and no recorded stamp, the
bootstrap value is the most recent of the history values of the
locations that have version-control history — bound by
@ac-freshness-resolution ac-multi-annotation-most-recent, since
consumers can observe the difference between most-recent-wins,
oldest-wins, and undefined. Locations without history contribute no
value, so the mixed case (some locations with history, some without)
resolves to the most recent of the values that exist; only when no
location has history does the criterion fall to ac-no-history-absence.
This is deterministic and optimistic (any fresh annotation refreshes
the AC). The engine plan may revisit this rule when it computes
stale/drifted; choosing it here keeps the resolver deterministic
without blocking on engine design.

### Storage reads do not assess staleness

The resolver returns recorded stamps verbatim and keeps the
bootstrap-derived value retrievable alongside them
(ac-both-provenances-retrievable); it deliberately performs no
recorded-vs-annotation-history comparison. A stale recorded stamp
masking a newer annotation edit is therefore visible to consumers —
both values are in hand — but classifying that situation into
coverage states is the coverage-state engine's responsibility in a
later plan, not the storage read contract's. The storage layer stays a
pure, deterministic read surface.

### N/A respec consequences

After @task-na-annotation-coverage-exclusion lands, ACs whose only
annotations carry not-applicable markers become uncovered in
completeness output — including in this repository, which uses the
convention heavily for trait ACs. That is the decided intent: trait-AC
misfits surface as spec-composition fixes, not as an N/A escape hatch.

This plan is the transition boundary. @ac-coverage-applicability's
description defers reconciliation of the two semantics to "the
coverage state engine work"; per the decision register, the N/A-stop
is assigned to this plan (the storage foundation of that engine work),
so the respec here IS the reconciliation —
@task-respec-test-annotation-sweep-na amends the live decision's
boundary sentence accordingly, ending the pre-existing N/A-honoring
completeness path with this plan rather than leaving it in force until
the engine plan. The decision's engine-scoped ACs are untouched and
stay claimed by the engine plan.

The interim documentation window is an explicit, accepted decision:
shipped consumer guidance continues to document the in-code N/A
convention while its coverage-credit effect ends, so consumer projects
using the convention will see previously-suppressed completeness
warnings while the docs still teach it. This is accepted because (1)
the annotation remains a valid task-scoped marker
(ac-na-no-invalid-finding) — the documented convention stays
well-formed and produces no findings; (2) the new warnings are correct
under the decided semantics: they surface real trait-AC misfits the
N/A escape hatch was hiding; and (3) retiring the in-code N/A
convention itself (and the future task-level covers/covers_ac metadata
that would replace it) is out of program scope per the deferred
register — the consumer-facing documentation in shared package
guidance is untouched by this plan, and when it is later changed, that
touches shared guidance surfaces and takes the neutrality review
chain.

### Migration / backcompat summary

- Every new record and field is optional; a project with none is fully
  valid and behaves exactly as today.
- No manifest format-version bump: the store is additive, created only
  on first write, and ignored by older tools. The store's own
  `format` field applies the @data-format-forward-compatibility
  precedent scoped to the store: newer-than-supported record data is
  refused with both versions named, without affecting unrelated
  operations.
- Bootstrap-only freshness (empty store) is the universal upgrade
  state, so existing projects get freshness with zero migration.

### Approval gate and ordering

**Gate: this plan must not be approved or derived until
@plan-ui-redesign-global-decisions (P0a) is approved and derived.**

@annotation-freshness-provenance, @ac-coverage-applicability, and
@actor-identity-model are authored in the P0a global-decisions plan
and are pending materialization — verified absent from the live corpus
at authoring time. The pending refs are intentional: the depends_on
links are the durable, machine-visible ordering once P0a derives, and
removing them would lose that linkage. Once P0a derives, every pending
ref above resolves against the live corpus.

Plan records carry no machine-readable dependency field (verified
against the plan schema), so this gate cannot be expressed as
plan-level metadata. It is enforced by: (1) this plan remaining in
draft status until P0a materializes — review and re-review happen
against the draft; (2) the gate banner at the head of this document
and this section; and (3) a machine-visible failure mode — deriving
this plan before P0a leaves every binding depends_on ref above
dangling, which kspec validate --refs reports against the derived
items. Approvers must confirm P0a is approved and derived before
approving this plan.

Other P0a decision slugs mentioned in these notes
(@client-preference-persistence, @test-result-acquisition,
@coverage-state-presentation) are likewise pending materialization but
appear only as prose context, not as binding references. All other
external references were mechanically verified against the live
corpus: @test-annotation-sweep (ac-explicit-mapping,
ac-annotation-format, ac-no-blanket-credit),
@ac-annotation-integrity-reporting (including
ac-valid-annotation-covers-target), @ac-annotation-identifier-format
(ac-valid-token-covers-ac), @trait-validation (ac-2),
@coverage-scan-config, and @data-format-forward-compatibility.

### Naming caution

The engine vocabulary "stale" and "drifted" collides with the existing
`kspec validate --staleness` / `--drift` flags, which mean different
things (status mismatches and AC-prose-vs-schema drift). This plan
deliberately introduces neither term in storage — stamps carry
provenance and time, not states. The engine plan owns the
disambiguation.
