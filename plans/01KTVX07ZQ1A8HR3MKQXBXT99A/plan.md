# Review Anchors and Plan Revisions Schema

## Specs

```yaml
# ─── Review Anchor Union Extensions ───

- title: Typed Spec-Criterion Anchors
  slug: review-spec-ac-anchors
  type: requirement
  parent: "@review-record-core-model"
  depends_on:
    - "@review-comment-threads-and-anchors"
  description: |
    Review threads can target a single acceptance criterion of a spec item
    through a typed anchor that carries the spec reference and the
    criterion identifier as distinct validated fields. The typed form is
    the canonical way to write criterion-targeted feedback, replacing the
    loose structured-anchor convention for new writes. Records written
    under the loose convention remain fully readable: readers accept both
    shapes, and legacy records load and validate without modification.
  acceptance_criteria:
    - id: ac-typed-anchor-stored
      given: |
        a reviewer targets a specific acceptance criterion of a spec item
      when: |
        the thread is created through a supported write interface with a
        spec-criterion anchor
      then: |
        the anchor stores the spec reference and the acceptance-criterion
        identifier as distinct typed fields, and the stored record
        round-trips through load and save unchanged
    - id: ac-anchor-field-validation
      given: |
        a spec-criterion anchor whose spec reference is not a valid
        reference or whose criterion identifier does not match the
        established acceptance-criterion identifier format
      when: |
        the anchor is validated during thread creation
      then: |
        the mutation is rejected, no thread is stored, and the feedback
        names the offending field
    - id: ac-legacy-anchors-load
      given: |
        a review record written before the typed variant existed,
        containing loose structured anchors — including the convention
        that gestures at an acceptance criterion through section and
        field values
      when: |
        the record is loaded and validated
      then: |
        the record loads and validates without error and the anchor
        content is preserved exactly as written, with no migration or
        rewrite required
    - id: ac-anchor-variant-guidance
      given: |
        review data containing an anchor whose type is not an accepted
        variant
      when: |
        validation feedback is produced
      then: |
        the feedback enumerates the complete set of accepted anchor
        variants, including the spec-criterion and plan-text variants

- title: Plan-Text Anchors
  slug: review-plan-text-anchors
  type: requirement
  parent: "@review-record-core-model"
  depends_on:
    - "@review-comment-threads-and-anchors"
    - "@plan-revisions"
  description: |
    Review threads can target a span of a plan document through a typed
    plan-text anchor. The plan document divides into sections derived
    from its headings on the server side, and the anchor addresses a span
    with four fields: the identifier of the containing section, the
    offset of the span within that section, the quoted text of the span,
    and the ordinal of the plan revision the anchor was created against.
    Offsets are counted in Unicode code points from the start of the
    section's content — never bytes and never UTF-16 code units — so
    every write surface measures the same span identically regardless of
    text encoding. Together these fields fully describe the anchored span:
    given the anchor and the content of its creation revision, the exact
    span is recoverable without consulting any other state. Plan-text
    anchors are valid only on reviews whose subject is a plan; the
    anchored plan is the review's subject.
  acceptance_criteria:
    - id: ac-plan-text-anchor-stored
      given: |
        a reviewer targets a span of text in a plan document under review
      when: |
        the thread is created through a supported write interface with a
        plan-text anchor
      then: |
        the anchor stores the section identifier, the offset of the span
        within that section counted in Unicode code points, the quoted
        span text, and the ordinal of the plan revision it was created
        against, and the stored record round-trips through load and save
        unchanged
    - id: ac-deterministic-sectioning
      given: |
        the content of a plan revision
      when: |
        the document is divided into sections
      then: |
        each heading begins a section whose identifier derives
        deterministically from the heading text, duplicate heading texts
        disambiguate deterministically by document order, content before
        the first heading forms a single leading section with a fixed
        identifier, and identical content always yields identical section
        identifiers
    - id: ac-plan-text-anchor-validation
      given: |
        a plan-text anchor with a negative offset, an empty quoted text,
        or a creation revision that is not a positive integer
      when: |
        the anchor is validated
      then: |
        the mutation is rejected, no thread is stored, and the feedback
        names the offending field
    - id: ac-nonexistent-revision-rejected
      given: |
        a plan-text anchor whose creation revision ordinal is a positive
        integer that does not exist in the subject plan's revision
        history
      when: |
        the anchor is validated at creation time
      then: |
        the mutation is rejected with feedback naming the revision field
        and the ordinal that failed to resolve
    - id: ac-plan-subject-only
      given: |
        a thread creation that supplies a plan-text anchor on a review
        whose subject is not a plan
      when: |
        the anchor is validated
      then: |
        the mutation is rejected with feedback stating that plan-text
        anchors apply only to plan-subject reviews
    - id: ac-span-integrity
      given: |
        a plan-text anchor whose quoted text does not occur at the stored
        offset within the stored section of the creation revision's
        content
      when: |
        the anchor is validated at creation time
      then: |
        the mutation is rejected with actionable feedback, so every
        stored plan-text anchor resolves to its quoted text within the
        revision it was created against

# ─── Thread Kinds ───

- title: Advisory Idea Threads
  slug: review-idea-threads
  type: requirement
  parent: "@review-record-core-model"
  depends_on:
    - "@review-comment-threads-and-anchors"
  description: |
    Review threads support the kind idea alongside blocker, question, and
    nit. An idea thread carries a forward-looking suggestion that is
    advisory only: whatever its resolution state, it never participates
    in approval gating. In all other respects idea threads behave like
    every other kind — they hold entries and replies, resolve and reopen,
    and appear in the review's event history.
  acceptance_criteria:
    - id: ac-idea-kind-accepted
      given: |
        a reviewer opens a thread with kind idea
      when: |
        the thread is created through a supported write interface
      then: |
        the thread stores kind idea, and reply, resolve, and reopen
        operate on it exactly as they do for the existing kinds
    - id: ac-idea-never-blocks
      given: |
        a review whose only unresolved threads have kind idea, with all
        required checks passing against the current subject version and a
        current approval verdict
      when: |
        the disposition is computed
      then: |
        the disposition is approved — unresolved idea threads never
        prevent approval
    - id: ac-kind-validation
      given: |
        a thread whose kind is not one of blocker, question, nit, or idea
      when: |
        the thread is validated
      then: |
        the mutation is rejected with feedback enumerating the accepted
        kinds

# ─── Plan Revisions ───

- title: Plan Revisions
  slug: plan-revisions
  type: feature
  parent: "@plan-support"
  description: |
    Plans carry a first-class revision history. A revision marks an
    intentional publish of the plan document: an explicit publish action
    mints one, and completing a document re-import into an existing plan
    mints one. Draft edits that replace content without publishing do
    not. A revision record stores its ordinal, author, summary note,
    timestamp, and a pointer to the shadow-branch commit containing the
    published content; the document body is never duplicated into the
    revision record. Revision authors use the same actor attribution
    vocabulary as other authored records; no revision-specific author
    format exists. Once the revision data upgrade has run, every plan
    has at least revision 1; a plan persisted before revision support
    and not yet upgraded loads with an empty revision history until the
    upgrade or its first publish records one. A review of a plan
    resolves to the revision it examined through the review's pinned
    subject version, with no new field on the review record.
  acceptance_criteria:
    - id: ac-publish-mints-revision
      given: |
        an existing plan with N recorded revisions
      when: |
        an explicit publish action is performed with a summary note
      then: |
        a revision record is created with ordinal N+1, the acting author,
        the supplied summary note, a creation timestamp, and a pointer to
        the shadow-branch commit containing the published content
    - id: ac-import-mints-revision
      given: |
        a plan document is re-imported into an existing plan
      when: |
        the import completes successfully
      then: |
        a new revision record is minted for the updated content carrying
        the same fields as an explicit publish, with the summary note
        supplied by the caller or recorded as a stated default
    - id: ac-draft-edits-do-not-mint
      given: |
        a plan whose content is replaced through a non-publish update
        path, or whose metadata or notes are mutated
      when: |
        the mutation completes
      then: |
        the plan's revision list is unchanged
    - id: ac-no-body-duplication
      given: |
        a revision record is stored
      when: |
        its persisted form is inspected
      then: |
        it contains only bounded metadata and the commit pointer — no
        copy of the document body — and resolving the pointer returns
        content byte-identical to the document as published
    - id: ac-revision-ordering
      given: |
        a plan with one or more revisions
      when: |
        the plan's revisions are read
      then: |
        ordinals form a strictly increasing sequence starting at 1 in
        publish order, and each revision exposes its ordinal, author,
        summary note, and timestamp
    - id: ac-backfill-revision-one
      given: |
        a project whose plans were created before revision support
      when: |
        the data upgrade completes
      then: |
        every existing plan has exactly one revision with ordinal 1 whose
        pointer designates the plan's content as of the upgrade
    - id: ac-legacy-plans-load
      given: |
        a plan record persisted before revision support and not yet
        upgraded
      when: |
        the plan is loaded and validated
      then: |
        it loads without error and reports an empty revision history
    - id: ac-review-revision-binding
      given: |
        a plan review whose pinned subject version matches the content
        published as revision N
      when: |
        the revision the review examined is resolved
      then: |
        revision N is identified using the existing subject content-hash
        and shadow-commit pinning, with no new stored field on the review
        record

# ─── Subject Revision Vocabulary ───

- title: Subject Revision Vocabulary
  slug: subject-revision-vocabulary
  type: decision
  depends_on:
    - "@plan-revisions"
    - "@review-subject-bindings"
  description: |
    A review subject's revision number means exactly one thing per
    subject type. For plan subjects, it is the ordinal of the first-class
    plan revision the review examined. For task, spec, and code subjects,
    it derives from the review's recorded subject-refresh sequence: the
    version captured at review creation is revision 1, and each recorded
    subject refresh increments the ordinal — no dedicated field stores
    it. A grouping of sibling reviews against the same subject is a
    sequence of review passes ordered by creation; review passes are
    never labeled with the revision vocabulary, and revision numbers are
    never derived from sibling-review order.
  acceptance_criteria:
    - id: ac-non-plan-derivation
      given: |
        a review on a task, spec, or code subject whose subject has been
        refreshed N times since the review was created
      when: |
        the subject revision ordinal is reported
      then: |
        the ordinal is N+1, derived from the review's recorded
        subject-refresh events with no dedicated stored field
    - id: ac-plan-subject-ordinal
      given: |
        a review on a plan subject bound to plan revision N, whatever the
        count of recorded subject refreshes on the review
      when: |
        the subject revision is reported
      then: |
        the reported value is the bound plan revision ordinal N
    - id: ac-review-pass-labeling
      given: |
        a surface or interface presents the set of sibling reviews
        against one subject
      when: |
        the grouping is labeled and ordered
      then: |
        the grouping is identified as review passes ordered by creation
        date and is not labeled with the revision vocabulary
```

## Tasks

derive_from_specs: false

```yaml
- title: Implement typed spec-criterion anchor variant with dual-read compatibility
  slug: task-spec-ac-anchor-variant
  priority: 1
  tags: [schema, reviews, cli]
  spec_ref: "@review-spec-ac-anchors"
  description: |
    Add the typed spec-criterion anchor variant to the review anchor
    union, with validation, CLI write support, and guaranteed dual-read
    of legacy loose structured anchors.

    Why: Criterion-targeted review feedback exists today only as a loose
    structured-anchor convention ({type: "structured", section:
    "acceptance_criteria", field: "<ac-id>"}) that nothing validates or
    types. The redesigned review and planning surfaces need an anchor
    they can trust. Review YAML across ~20 consumer projects contains
    legacy loose anchors, so readers must keep accepting both shapes.

    What:
    - Add a spec-AC variant to the anchor discriminated union in
      src/schema/review-records.ts: a new type literal (spec_ac) with
      required spec reference (RefSchema) and criterion identifier
      (AcIdSchema from src/schema/common.ts) fields. The existing
      structured variant stays untouched — the union gains a member;
      nothing is removed or tightened.
    - Extend kspec review comment with flags for the typed variant
      (following the existing anchor flag groups), and apply the same
      validation on the daemon thread-creation route.
    - Reject malformed spec references and criterion identifiers at
      creation with feedback naming the offending field; load-time
      validation of legacy records must not change behavior.
    - Extend the shared error map (formatActionableMessage in
      src/parser/review-validation.ts) so anchor discriminator failures
      enumerate the accepted variants.
    - Update the duplicated anchor type unions in shared/web-ui packages
      so typecheck stays green. No rendering changes — later plans own
      anchor rendering.

    How: Follow the discriminated-union pattern of
    ReviewCodeAnchorSchema/ReviewStructuredAnchorSchema. Tests: schema
    round-trip; creation-time rejection cases; a fixture file containing
    legacy loose structured anchors (copied shapes from real records,
    including the AC convention) loads and validates unchanged; error
    message enumeration. Test against both monolithic and folder review
    storage fixtures.

    Covers: @review-spec-ac-anchors ac-typed-anchor-stored,
    ac-anchor-field-validation, ac-legacy-anchors-load.

- title: Implement plan revision records with publish and import minting
  slug: task-plan-revision-records
  priority: 1
  tags: [schema, plans, cli]
  spec_ref: "@plan-revisions"
  description: |
    Add first-class revision records to plans, minted by an explicit
    publish command and by import --into completion, storing a
    shadow-commit pointer instead of a content copy.

    Why: Plans store a single content blob today; the only history is
    shadow-branch git log. The planning workspace, plan-text anchors, and
    review-revision binding all need a durable, intentional revision
    sequence (decision #16: publish-revs + commit pointers, not
    every-edit-is-a-rev).

    What:
    - Revision record schema: ordinal, author, summary note, created_at
      timestamp, shadow_commit pointer. Store revisions in the plan's
      folder-backed metadata (plan.yaml sidecar), defaulting to an empty
      list so pre-upgrade plans load cleanly.
    - kspec plan publish <ref> --note "<summary>": commit the current
      plan document content (if uncommitted), then append a revision
      whose pointer is the commit containing that content. Pointer
      mechanics need two commits: the content must be committed first so
      its hash is known, then the revision metadata commits separately.
    - Mint a revision when kspec plan import --into completes
      successfully, using --note when supplied or the existing
      "Content updated from file" auto-note text as the summary default.
    - Do NOT mint on plan set --content-file, plan note, plan set
      status/title/branch, or any other non-publish mutation.
    - Author resolution reuses the actor attribution already used for
      review records and notes (resolved agent or user identity),
      centralized in one helper; do not introduce a new free-form author
      path. The redesign's actor-identity decision (register #21) will
      be specd by the P0a global-decisions plan — keeping resolution in
      one helper lets revisions adopt the canonical identity model when
      that spec lands, with no revision schema change.
    - Read surfaces: kspec plan get lists revisions (ordinal, author,
      note, timestamp); a revision content resolver reads the plan
      document at the pointed commit from the shadow branch (first-party
      helper — this is the first shadow-history content read path; keep
      it read-only and lock-free).
    - Index boundedness: project.plans.yaml gains at most a current
      revision ordinal; the revision list and content stay out of the
      index (honor @folder-backed-plan-storage-1
      ac-plan-index-has-bounded-projection).

    How: Extend PlanSchema (src/schema/plan.ts) and the plan storage
    manager (src/parser/plan-storage-manager.ts). Content resolution via
    git show of the folder-backed plan document path at the pointed
    commit inside the shadow worktree. Tests: ordinal sequencing across
    publish and import minting; non-publish paths leave revisions
    unchanged; resolved content is byte-identical to what was published;
    legacy plan fixtures load with empty revision history.

    Covers: @plan-revisions ac-publish-mints-revision,
    ac-import-mints-revision, ac-draft-edits-do-not-mint,
    ac-no-body-duplication, ac-revision-ordering, ac-legacy-plans-load.

- title: Implement plan-text anchor variant with deterministic heading sectioning
  slug: task-plan-text-anchors
  priority: 1
  tags: [schema, reviews, plans]
  spec_ref: "@review-plan-text-anchors"
  depends_on:
    - "@task-spec-ac-anchor-variant"
    - "@task-plan-revision-records"
    - "@task-plan-revision-backfill"
  description: |
    Add the plan-text anchor variant (section, offset, quoted text,
    creation revision) with creation-time span-integrity validation, plus
    the server-side deterministic heading-sectioning utility the anchor
    addresses against. Depends on the revision backfill so that every
    pre-existing plan already has revision 1 by the time anchors ship —
    anchors validate against revision ordinals, so without backfill they
    would be unusable on all legacy plans.

    Why: Reviewers must be able to anchor threads to spans of plan text
    that survive small edits (decision #19: anchor = section + offset +
    quoted text + created-at revision, with server-side heading
    sectioning). This plan stores and validates the shape; re-matching
    against newer revisions and orphan rendering are later plans, and
    they are only possible if every stored anchor is internally
    consistent with the revision it was created against.

    What:
    - Add a plan-text variant to the anchor union: type literal
      (plan_text) with section identifier (non-empty string), offset
      (non-negative integer, counted in Unicode code points from the
      start of the section content — never bytes or UTF-16 code units),
      quoted_text (non-empty string), and created-at revision ordinal
      (positive integer). Document the code-point unit on the schema
      field so every writer measures spans identically.
    - Server-side sectioning utility: a pure function dividing markdown
      content into heading-delimited sections. Section identifier =
      slugified heading text, with a deterministic document-order suffix
      for duplicate headings; content before the first heading forms a
      single leading section with a fixed identifier. Identical content
      always yields identical identifiers. This utility is library code
      consumed later by the re-matching and planning-workspace plans.
    - Creation-time validation: review subject must be a plan; the
      revision ordinal must exist on the subject plan; the quoted text
      must occur at the stored offset within the stored section of the
      creation revision's content (resolve content via the revision
      pointer, sections via the utility). Failures reject with feedback
      naming the offending field. Load-time validation stays shape-level
      so imported or hand-edited records never fail loads on content
      checks.
    - CLI flags on kspec review comment for the plan-text variant, and
      the same validation on the daemon thread-creation route.
    - Finalize the shared anchor error map so discriminator failures
      enumerate all accepted variants including spec-criterion and
      plan-text.

    How: Same union-extension pattern as the spec-AC variant task. The
    sectioning utility lives next to the plan document parsing code
    (src/parser/). Tests: round-trip; each rejection case (negative
    offset, empty quote, non-positive revision ordinal, positive ordinal
    absent from the plan's revision history, non-plan subject, quote
    mismatch); a non-ASCII span case where multi-byte and surrogate-pair
    characters (e.g. CJK text and emoji) precede the span, proving
    offsets count Unicode code points rather than bytes or UTF-16 code
    units; sectioning determinism including duplicate headings and
    preamble-only documents.

    Covers: @review-plan-text-anchors ac-plan-text-anchor-stored,
    ac-deterministic-sectioning, ac-plan-text-anchor-validation,
    ac-nonexistent-revision-rejected, ac-plan-subject-only,
    ac-span-integrity.
    @review-spec-ac-anchors ac-anchor-variant-guidance.

- title: Implement advisory idea thread kind
  slug: task-idea-thread-kind
  priority: 1
  tags: [schema, reviews]
  spec_ref: "@review-idea-threads"
  description: |
    Add the idea thread kind alongside blocker/question/nit and pin its
    advisory-only gating behavior with a contract test.

    Why: Reviewers need a kind for forward-looking suggestions that
    should never gate approval (decision #44: advisory-only, consistent
    with decision #26 where disposition remains the enforced gate).
    Today's disposition computation filters threads on the blocker kind
    only (getUnresolvedBlockers in src/parser/review-threads.ts), so idea
    is structurally non-blocking — the contract test makes that
    permanent rather than incidental.

    What:
    - Add idea to ReviewThreadKindSchema in src/schema/review-records.ts;
      update kspec review comment --kind help text, daemon route
      validation, and the duplicated kind unions in shared/web-ui
      packages so typecheck stays green.
    - Verify reply, resolve, and reopen paths treat idea threads
      identically to existing kinds (no special-casing).
    - Contract test: a review whose only unresolved threads are idea
      threads, with passing required checks and a current approval
      verdict, computes an approved disposition.
    - Validation test: an unknown kind is rejected with feedback
      enumerating blocker, question, nit, idea.
    - Respec @review-comment-threads-and-anchors ac-6 wording so the
      non-blocking enumeration includes idea (currently it names only
      nit and question as non-blocking), via kspec item commands.
    - Respec @review-records-web-ui ac-2 and ac-3 so the kind-badge and
      kind-selection enumerations include idea, and make the matching
      enumeration-level change in the shipped review detail page (kind
      badge map entry plus kind option in the comment form). This keeps
      the shipped UI's specified treatment in step with the schema —
      once write surfaces accept idea, existing reviews will contain
      idea threads, and the UI must not encounter a kind it has no
      specified treatment for. Redesigned review surfaces remain with
      later plans; this is enumeration-level only.

    How: Enum addition plus tests; the gating behavior requires no
    disposition-code change, only the regression test. Use kspec batch
    for the spec wording updates.

    Covers: @review-idea-threads ac-idea-kind-accepted,
    ac-idea-never-blocks, ac-kind-validation.
    @review-comment-threads-and-anchors (ac-6 wording update to include
    idea among non-blocking kinds).
    @review-records-web-ui (ac-2/ac-3 kind enumeration respec plus the
    matching shipped badge/kind-option update).

- title: Implement revision-one backfill for existing plans
  slug: task-plan-revision-backfill
  priority: 1
  tags: [plans, migration]
  spec_ref: "@plan-revisions"
  depends_on:
    - "@task-plan-revision-records"
  description: |
    Backfill every pre-existing plan with revision 1 designating its
    current content, as an idempotent data-upgrade step.

    Why: Reviews bind to revisions and plan-text anchors pin revision
    ordinals; without backfill, every existing plan (93 in this project
    alone, plus consumer projects) would have no revision to bind or pin
    against. Decision #16 sets the policy: rev 1 = current content.
    This runs at priority 1, ahead of plan-text anchors, so anchors are
    usable on every pre-existing plan the moment they ship instead of
    only on plans published after the upgrade.

    What:
    - Upgrade step: every plan with an empty revision history gets one
      revision with ordinal 1, a fixed system/upgrade author recorded
      through the same author-resolution helper publish uses, a fixed
      backfill summary note, the upgrade timestamp, and a shadow-commit
      pointer that resolves to the plan's content as of the upgrade (the
      shadow HEAD at upgrade time satisfies this).
    - Idempotent: re-running the upgrade neither duplicates revision 1
      nor touches plans that already have revisions.
    - Runs through the established storage-upgrade path used by prior
      plan storage migrations, so consumer projects pick it up on
      upgrade without a manual command.

    How: Follow the existing plan storage migration pattern
    (src/parser/plan-folder-migration.ts and migration-safety helpers).
    Tests: fixture project with pre-revision plans upgrades to exactly
    one revision each; double-run produces no change; resolved revision-1
    content equals current plan content.

    Covers: @plan-revisions ac-backfill-revision-one.

- title: Implement review revision binding and derived subject revision ordinals
  slug: task-review-revision-binding
  priority: 2
  tags: [reviews, plans, schema]
  spec_ref: "@subject-revision-vocabulary"
  depends_on:
    - "@task-plan-revision-records"
  description: |
    Resolve which plan revision a review examined via the existing
    subject pinning, and derive subject revision ordinals for non-plan
    subjects from the subject-refresh sequence.

    Why: The redesigned review surfaces render "rev N" for every subject
    type. For plans that must be the first-class revision examined; for
    task/spec/code subjects there is no first-class revision, so the
    ordinal derives from the review's own subject_refreshed event
    sequence (decision #17) — no new storage on either side.

    What:
    - Plan binding resolver: given a plan review's subject
      (content_hash + shadow_commit), identify the revision whose
      published content matches — content-hash equality against the
      revision's resolved content first, shadow-commit comparison as the
      tiebreaker. Reviews pinned to unpublished draft content resolve to
      no revision rather than a wrong one.
    - Non-plan derivation: subject revision ordinal = 1 + the count of
      subject_refreshed events recorded on the review (the existing
      events vocabulary in src/schema/review-records.ts); no stored
      field.
    - Expose both through the review read path: kspec review get output
      and the review JSON payload report the subject revision, so
      downstream API/UI plans consume one definition.

    How: Library functions beside the existing subject-bindings code
    (src/review/subject-bindings.ts), surfaced through the review get
    formatting. Tests: a review refreshed N times reports N+1; a plan
    review bound to revision 2 reports 2 even after refreshes; a plan
    review pinned to never-published content reports no revision.

    Covers: @subject-revision-vocabulary ac-non-plan-derivation,
    ac-plan-subject-ordinal. @plan-revisions ac-review-revision-binding.

- title: Respec the review-detail revision dropdown as review passes
  slug: task-respec-review-pass-vocabulary
  priority: 2
  tags: [specs, reviews, maintenance]
  spec_ref: "@review-records-web-ui"
  depends_on:
    - "@task-review-revision-binding"
  description: |
    Re-ground the existing review-detail "Revision" dropdown semantics as
    review passes, in both the owning spec and the shipped label, so the
    sibling-review grouping never collides with the new subject-revision
    vocabulary.

    Why: @review-records-web-ui ac-11 currently specifies a "revision
    dropdown" listing all reviews for a subject — but those are sibling
    review passes, not revisions. With subject revisions now defined
    (plan revision ordinals and refresh-derived ordinals), the same word
    cannot name both concepts (decision #17: the dropdown is
    renamed/re-grounded as review passes).

    What:
    - Respec @review-records-web-ui ac-11 wording: a review-pass selector
      lists all reviews for the subject ordered by creation date, with
      the current review selected and selection navigating; subject
      matching stays as specified (subject-ref for plan/task/spec
      reviews, head-branch for code reviews). The word "revision" leaves
      the AC.
    - Update the @review-records-web-ui description sentence "Reviews on
      the same subject are treated as revisions with a dropdown selector"
      to review-pass vocabulary.
    - Rename the shipped selector label in the review detail page from
      "Revision" to "Review pass" — a text-level change only; the
      redesigned review surfaces belong to later plans.

    How: kspec item commands (batched) for the spec wording; a minimal
    label change in the existing review detail component with its test
    expectation updated.

    Covers: @subject-revision-vocabulary ac-review-pass-labeling.
    @review-records-web-ui (ac-11 respec + description update).
```

## Implementation Notes

### Decision register mapping

This plan resolves four track-scoped items from the redesign decision
register as specd behavior (cited, not re-argued):

| Decision | Resolved by |
|---|---|
| #16 plan revisions — publish-revs + commit pointers, rev 1 backfill | @plan-revisions |
| #17 revision semantics — plans first-class; non-plan rev N derived from subject-refresh ordinals; dropdown re-grounded as review passes | @plan-revisions, @subject-revision-vocabulary |
| #19 anchors — server sections, rev-pinned `{section, offset, quoted_text, created_at_rev}` | @review-plan-text-anchors |
| #44 idea-kind gating — advisory-only | @review-idea-threads |

### Actor-identity sequencing

An earlier draft declared a structured `depends_on` from
`@plan-revisions` to the P0a actor-identity decision spec; that spec is
not yet materialized, and the unresolvable reference made this plan
underivable, so the structured dependency was removed. Revision-author
attribution instead reuses the actor attribution that already exists
for review records and notes, centralized in one resolution helper (see
task-plan-revision-records). When the P0a global-decisions plan
materializes the actor-identity decision (register #21), that spec
governs canonical identity values and the helper adopts it — no
revision schema change is expected. This plan carries no unresolved
cross-plan references.

### Anchor union mechanics

- Current union (`src/schema/review-records.ts:82-106`): exactly `code`
  and `structured`. New discriminator literals: `spec_ac` and
  `plan_text`. Additive only — the `structured` variant stays accepted
  for new writes, because legacy tooling and consumer projects produce
  it.
- The legacy AC convention being formalized:
  `{type: "structured", ref: "@spec-x", section: "acceptance_criteria",
  field: "ac-N"}` (documented in the shipped review skill). Dual-read is
  a hard requirement: review YAML across ~20 consumer projects contains
  these. No migration or rewrite of legacy anchors — they are preserved
  as written; only new writes prefer the typed forms.
- The shared parser error map is `formatActionableMessage` in
  `src/parser/review-validation.ts` (its anchor branch currently says
  "Anchor type must be one of: code, structured"). Behavior is governed
  by @review-record-validation ac-2 (actionable feedback); the
  enumeration update is covered by @review-spec-ac-anchors
  ac-anchor-variant-guidance.
- The anchor union is duplicated in client-side types
  (packages/web-ui and shared packages). Tasks update those unions for
  typecheck only; rendering the new variants is owned by the later
  review-hub and planning-workspace plans.

### Plan revision storage

- Revisions live in the folder-backed plan metadata (`plan.yaml`),
  consistent with @folder-backed-plan-storage-1
  ac-plan-metadata-sidecar-is-authoritative. The plan index gains at
  most a current-ordinal field — never the list or content
  (ac-plan-index-has-bounded-projection).
- Pointer mechanics: the published content must be committed before its
  commit hash can be recorded, so publish is two shadow commits (content,
  then revision metadata). The pointer references the content commit.
- Revision content resolution (`git show` of the plan document path at
  the pointed commit) is the codebase's first shadow-history content
  read. Keep it strictly read-only; it is also the foundation the later
  revision-diff and anchor re-matching plans build on.
- Backfill pointers use shadow HEAD at upgrade time — any commit at or
  after the plan's last content change correctly designates "current
  content".

### Review ↔ revision join

No schema change on reviews: `ReviewPlanSubjectSchema` already pins
`{shadow_commit, content_hash}` (@review-subject-bindings ac-4/ac-5).
The binding resolver matches the pinned content hash against revision
content. A review created against unpublished draft content legitimately
resolves to no revision — surfaces must treat that as "draft, no
revision", not as revision 1.

### Idea-kind gating context

Disposition computation enumerates blocking kinds by filtering
`kind === "blocker"` (`src/parser/review-threads.ts`,
`getUnresolvedBlockers`), per @review-comment-threads-and-anchors ac-6
and @review-checks-and-gate-evaluation ac-4. Adding `idea` is therefore
structurally non-blocking today; @review-idea-threads ac-idea-never-blocks
turns that from an implementation accident into a contract so future
gate changes cannot silently start gating on idea threads.

Shipped-UI treatment: once the schema accepts idea, existing reviews
will contain idea threads, so the existing review detail UI gets an
enumeration-level update in this plan (kind badge + kind option, under
the @review-records-web-ui ac-2/ac-3 respec carried by
task-idea-thread-kind). The redesigned review surfaces still belong to
later plans.

### Scope exclusions (later plans in this track)

- Anchor re-matching rev-N → current, and orphan/"anchor lost" rendering
  (decision #19 names them explicitly as later work).
- Plan revision diff computation/API and the revision compare UI.
- The planning workspace, review hub, and any review/planning UI; the
  anchor→DOM rendering engine.
- Review-creation/trigger-review APIs, WS event additions for revisions
  or threads, and review.* dispatch events.
- First-class spec revisions (deferred by decision #17; non-plan
  subjects use the derived ordinal only).

### Sectioning utility

Section identity must be stable across revisions for later re-matching:
identifiers derive from heading text (slugified), so an unchanged
heading keeps its identifier in the next revision; duplicates get a
deterministic document-order suffix; the pre-heading preamble has a
fixed identifier. The utility ships as pure library code in this plan
(plan-text anchors cannot be validated without it) and gains its UI and
re-matching consumers later. Note: plan review content is currently
served to the web client as a single markdown section
(`routes/diff.ts`); that serving path is untouched here — the later
planning-workspace plan adopts the sectioning utility for display.
