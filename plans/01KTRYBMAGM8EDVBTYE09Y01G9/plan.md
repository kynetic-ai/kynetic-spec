# Data Integrity and Upgrade Safety

## Specs

```yaml
# ─── Format version forward compatibility ───

- title: Data Format Forward Compatibility
  slug: data-format-forward-compatibility
  type: decision
  parent: "@versioning"
  depends_on:
    - "@format-version"
  description: |
    Defines the forward-compatibility contract layered on the project
    manifest's declared format version: each released version of the
    tool declares a maximum supported format version it can read and
    write, and project data declaring a newer format version is refused
    rather than operated on.

    Decision semantics:

    - Stamping: the format version is written to the project manifest at
      initialization and advanced only by the upgrade flow — never
      implicitly by ordinary commands.
    - Checking: the declared format version is compared against the
      maximum supported version at two points during context
      initialization. First, the locally declared version is checked
      before any project data is read, mutated, or synchronized —
      including any background synchronization performed as a side
      effect of context initialization. Second, when that
      synchronization imports project data, the declared version of the
      imported data is checked again before any project data is read or
      mutated, so data upgraded elsewhere to a newer format is refused
      by the same invocation that imported it. The imported
      synchronization itself is permitted — it transfers data already
      authored elsewhere; the guarantee defended at both points is that
      data declaring a newer format is never read or mutated. The check
      applies uniformly to CLI commands and daemon-served requests.
    - Newer than supported: the operation refuses with a deterministic
      error code reserved for this condition. The refusal names both the
      project's declared format version and the running tool's maximum
      supported format version, directs the user to upgrade their kspec
      installation (or use the newer version that wrote the data), and
      guarantees no project data was modified.
    - Unrecognized version values: a declared format version that cannot
      be interpreted as a known version is refused as incompatible with
      the literal value named in the error. It is never silently treated
      as the oldest format.
    - Diagnostic exemption: the project health diagnostic is the sole
      surface that does not refuse — it completes read-only and reports
      the version mismatch with upgrade guidance.
    - Older than supported: not refused by this contract. Existing
      per-domain storage-compatibility gates continue to govern older
      formats (lenient reads where safe, refusal with upgrade guidance
      where the operation requires a newer layout).
    - A manifest with no declared format version retains its existing
      legacy interpretation and is not affected by this contract.
  acceptance_criteria:
    - id: ac-newer-version-refused
      given: |
        A project manifest locally declares a format version greater
        than the running tool's maximum supported format version
      when: |
        Any command that reads or mutates project data, other than the
        project health diagnostic, initializes project context
      then: |
        The command refuses with a deterministic error code reserved for
        newer-than-supported format versions; the error names both the
        project's declared version and the tool's maximum supported
        version, includes guidance to upgrade the tool installation, and
        no project data is modified — including by any synchronization
        performed as part of context initialization
    - id: ac-post-sync-newer-version-refused
      given: |
        A project manifest locally declares a supported format version,
        and synchronization performed during context initialization
        imports project data whose manifest declares a format version
        greater than the running tool's maximum supported format
        version
      when: |
        Context initialization continues after that synchronization
      then: |
        The same invocation refuses with the deterministic
        newer-than-supported error code, naming both versions with
        upgrade guidance, before any project data is read or mutated;
        refusal is not deferred to a subsequent invocation
    - id: ac-daemon-structured-error
      given: |
        A project manifest declares a format version greater than the
        running tool's maximum supported format version
      when: |
        A daemon route serving that project's data handles a request
      then: |
        The route responds with a structured error carrying the same
        deterministic error code and both version values, and no project
        data is modified
    - id: ac-unrecognized-version-refused
      given: |
        A project manifest declares a format version value that cannot
        be interpreted as a known version
      when: |
        Project context is initialized
      then: |
        The operation refuses with an error naming the literal declared
        value and recovery guidance; the value is not silently treated
        as the oldest supported format
    - id: ac-diagnostics-report-read-only
      given: |
        A project manifest declares a format version greater than the
        running tool's maximum supported format version
      when: |
        The project health diagnostic command runs
      then: |
        The diagnostic completes in read-only mode, reports the version
        mismatch with both version values and upgrade guidance, and does
        not modify project data
    - id: ac-upgrade-refuses-newer
      given: |
        A project manifest declares a format version greater than the
        running tool's maximum supported format version
      when: |
        The upgrade flow runs against the project
      then: |
        The upgrade refuses before any step executes, reporting that the
        project's data format is newer than the running tool; it does
        not classify the project as an older-era project and no
        migration step reads or writes project data
    - id: ac-supported-versions-unaffected
      given: |
        A project manifest declares a format version less than or equal
        to the running tool's maximum supported format version
      when: |
        Commands initialize project context
      then: |
        No forward-compatibility refusal occurs, and handling of older
        formats remains governed by the existing storage-compatibility
        gates

# ─── Subprocess argument handling ───

- title: Subprocess Argument Literalness
  slug: subprocess-argument-literalness
  type: requirement
  parent: "@core"
  description: |
    Dynamic values that flow into version-control subprocess invocations
    — branch names, remote names, revision identifiers, timestamps — are
    treated as literal data and are never interpreted by a shell.
    Repository metadata is externally influenceable (a cloned repository
    controls its own branch and remote names), so queries over that
    metadata must treat every dynamic value as literal data.
  acceptance_criteria:
    - id: ac-metacharacter-branch-literal
      given: |
        A repository's checked-out branch has a name containing shell
        metacharacters (command substitution, semicolons, quotes,
        backticks)
      when: |
        The tool reads current-branch or upstream-tracking metadata for
        that repository
      then: |
        The metadata is returned containing the exact literal branch
        name, and no command embedded in the name is interpreted or
        executed
    - id: ac-dynamic-values-treated-literally
      given: |
        A version-control query incorporates a dynamic value (branch
        name, remote name, revision identifier, or timestamp) containing
        characters a shell would interpret (substitution, quoting,
        separators, expansion)
      when: |
        The query runs
      then: |
        The query operates on the exact literal value — it succeeds or
        fails based solely on whether the real value exists or is valid,
        no embedded command is executed, and no shell interpretation
        alters the query's meaning
    - id: ac-failure-results-preserved
      given: |
        A version-control query runs against a directory that is not a
        repository, or the underlying subprocess fails
      when: |
        The query helper is invoked
      then: |
        The helper reports failure through its documented null, empty,
        or default result rather than raising an error
```

## Tasks

derive_from_specs: false

```yaml
- title: Add restore-failure reporting AC to broken-shadow-safety spec
  slug: task-broken-shadow-safety-spec-delta
  priority: 1
  tags: [spec-update, shadow]
  spec_ref: "@broken-shadow-safety"
  description: |
    Why: The shadow restore double-failure fix
    (@task-shadow-restore-loud-failure) is a behavioral delta to the
    existing implemented spec @broken-shadow-safety, not a new spec —
    ac-preserve-on-failure already owns the preservation contract. Plan
    import creates new specs only; it has no mechanism for updating an
    existing spec from the Specs block. So the AC delta is applied by
    this explicit spec-update task (same pattern as prior
    existing-spec-delta plans, e.g. the daemon/dispatch hardening
    spec-alignment plan), guaranteeing the AC exists before the
    implementation task's tests and Covers annotations rely on it.

    What: Add exactly one acceptance criterion to the existing spec
    `@broken-shadow-safety` via `kspec item ac add`, with this exact id
    and wording:

    `ac-restore-failure-reports-state`
    Given: A failed shadow rebuild is restoring the preserved
    pre-repair shadow directory from its backup location
    When: The restore itself fails
    Then: The operation reports the restore failure alongside the
    original rebuild error, identifies the absolute path of the
    preserved backup directory and the resulting state of the shadow
    directory location, and provides concrete recovery steps; the
    backup directory is never deleted on this path

    If an AC with the same behavioral contract already exists under a
    different id, do not duplicate it — update the downstream task's
    Covers/annotation ids instead and note the substitution.

    How: One `kspec item ac add @broken-shadow-safety --id
    ac-restore-failure-reports-state --given ... --when ... --then ...`
    mutation (or a single `kspec batch`). Verify with
    `kspec item get @broken-shadow-safety`.

    Testing: `kspec validate --refs` passes and
    `kspec item get @broken-shadow-safety` shows the AC verbatim. No
    code or test changes in this task.

    Covers: adds @broken-shadow-safety ac-restore-failure-reports-state
    (spec mutation only — behavioral coverage of this AC is owned by
    @task-shadow-restore-loud-failure).

- title: Make shadow repair restore failures loud with recovery guidance
  slug: task-shadow-restore-loud-failure
  priority: 1
  tags: [shadow, reliability, bug]
  spec_ref: "@broken-shadow-safety"
  depends_on:
    - "@task-broken-shadow-safety-spec-delta"
  description: |
    Why: @broken-shadow-safety ac-preserve-on-failure requires that when
    a shadow rebuild fails, the pre-repair shadow directory is "preserved
    or restored and the failure reports recovery guidance". The current
    implementation stashes a broken worktree directory to
    `<worktreeDir>.repair-backup-<timestamp>` before rebuilding
    (stashBrokenWorktreeDir, src/parser/shadow.ts:73-82) and on rebuild
    failure attempts a restore that is wrapped in `.catch(() => {})` at
    src/parser/shadow.ts:2923 (initShadow catch block) and
    src/parser/shadow.ts:3056 (repairShadow catch block). When the
    rebuild fails AND the restore also fails, the backup directory still
    exists on disk but the user is never told it exists, where it is, or
    that the worktree location is now empty/partial. This silently
    violates ac-preserve-on-failure on the double-failure path — the
    worst failure class for a system whose source of truth lives in that
    directory. The new AC pinning this contract
    (ac-restore-failure-reports-state) is added to the spec by
    @task-broken-shadow-safety-spec-delta before this task runs.

    What:
    1. Replace both silent `.catch(() => {})` restore calls
       (src/parser/shadow.ts:2923 and :3056) with handling that captures
       the restore error and surfaces a combined failure message: the
       original rebuild error, the restore error, the absolute backup
       directory path, what now exists at the worktree location, and
       recovery steps (move the backup directory back into place, then
       re-run `kspec shadow repair`).
    2. Audit restoreStashedWorktreeDir (src/parser/shadow.ts:84-94): it
       removes the worktree directory before renaming the backup into
       place — if the rename fails after the removal, the failure
       message must accurately describe that the worktree location is
       now empty and the backup is the only copy.
    3. When restore succeeds after a rebuild failure, the existing
       result.error path already reports the rebuild failure; keep that
       behavior and additionally note that the prior shadow state was
       restored.

    How: Extend ShadowInitResult with optional fields (e.g.
    restore_failed, backup_dir) or fold the detail into the error string
    — choose whichever the shadow CLI handlers (kspec init / kspec
    shadow repair output paths) can surface without widening unrelated
    interfaces. Do not delete the backup directory on any failure path;
    discardStashedWorktreeDir must remain success-path-only.

    Testing: Unit tests in a temp git repo that force the rebuild to
    fail and the restore to fail (e.g. stub fs.rename to reject), then
    assert the result/error output names the backup path, the worktree
    state, and recovery steps, and that the backup directory still
    exists on disk. Also cover the restore-succeeds path (error reports
    rebuild failure + restored state). Annotate tests with
    AC: @broken-shadow-safety ac-preserve-on-failure and
    AC: @broken-shadow-safety ac-restore-failure-reports-state.

    Covers: @broken-shadow-safety ac-preserve-on-failure,
    @broken-shadow-safety ac-restore-failure-reports-state (added by
    @task-broken-shadow-safety-spec-delta).

- title: Enforce a format version ceiling at context initialization
  slug: task-format-version-ceiling
  priority: 1
  tags: [schema, parser, upgrade, reliability]
  spec_ref: "@data-format-forward-compatibility"
  description: |
    Why: kspec is used across ~20 real projects, and the manifest
    already carries a format version (`kynetic: "1.0"/"1.1"/"1.2"`).
    Backward incompatibility is well handled (entity-storage
    compatibility gates, task-data-manager legacy gate), but there is no
    forward check anywhere: every existing gate uses `parseFloat(v) >=
    floor` comparisons, so a project written by a future kspec with
    `kynetic: "1.3"` passes all gates and an older kspec will happily
    read and write data whose layout it does not understand. Worse,
    upgrade probe inference (src/cli/commands/upgrade.ts:208-228)
    buckets any unrecognized kynetic value into the 0.1.0-0.8.99 old
    era, so a newer project either gets misclassified as ancient or
    resolves to "unknown", which runs the FULL upgrade pipeline as a
    "safety net" — executing migrations against newer-format data.

    What:
    1. Define a single MAX_SUPPORTED_KYNETIC_VERSION constant (currently
       "1.2") in src/parser/entity-storage-compatibility.ts (next to
       ENTITY_FOLDER_STORAGE_MIN_KYNETIC_VERSION) or a small dedicated
       module, exported for reuse.
    2. In initContext (src/parser/yaml.ts:701), run the ceiling check
       BEFORE the pre-read shadow sync block. Ordering is the critical
       design constraint: today the shadow-mode path can call
       hasRemoteTracking/shadowNeedsSync/shadowPull
       (src/parser/yaml.ts:783-836) before the manifest is located and
       parsed (src/parser/yaml.ts:838-845), so a check placed after
       manifest parsing would let a sync pull mutate a newer-format
       project before the refusal triggers — violating the spec's
       no-modification guarantee. Concretely: once the spec directory is
       known (shadow worktree dir, KSPEC_SPEC_DIR override, or
       traditional spec dir), read the manifest's declared version RAW
       from disk (raw YAML field read, not the schema-parsed manifest —
       the schema defaults a missing field to "1.0", which would erase
       the missing-field case) and apply the check before any sync or
       other side effect. If the declared version parses to a numeric
       version greater than the maximum supported, throw a structured
       error with a deterministic code
       (`format_version_newer_than_supported`) naming the declared
       version, the maximum supported version, and guidance to upgrade
       the kspec installation. If the field is present but not
       parseable as a numeric version, throw
       `unrecognized_format_version` naming the literal value. A
       missing kynetic field keeps its existing legacy handling (the
       raw read makes "missing" unambiguous). Then RE-APPLY the same
       ceiling comparison to the manifest parsed after the sync block:
       the pre-sync read only sees the local manifest, so a sync pull
       can import a manifest upgraded remotely to a newer format even
       when the pre-sync check passed — the same invocation must refuse
       (same deterministic codes) after the pull and before any entity
       read or mutation, rather than deferring refusal to the next
       invocation. The post-sync re-check reads the freshly parsed
       manifest's raw declared version the same way.
    3. Daemon parity: ensure daemon routes surface this as a structured
       error with the same code (follow the existing
       EntityStorageCompatibilityError handling pattern for the 409-style
       structured responses).
    4. Doctor exemption: kspec doctor must not hard-fail — it already
       reads the manifest directly without initContext
       (src/parser/doctor.ts:719); add a version-mismatch check that
       reports the incompatibility with both versions and guidance,
       read-only.
    5. Upgrade refusal — layer ownership: the user-visible refusal for
       `kspec upgrade` is owned by the context-initialization check from
       step 2. runUpgradePipeline calls initContext
       (src/cli/commands/upgrade.ts:345-346) BEFORE detectSourceVersion
       (line 352), so the step-2 throw fires first on the CLI path and
       the CLI error handler presents the deterministic code and
       guidance; do not write a CLI-level test expecting a refusal
       message produced inside detectSourceVersion. Separately, as
       defense in depth (detectSourceVersion is exported and exercised
       outside runUpgradePipeline), correct probe inference
       (src/cli/commands/upgrade.ts:208-228) so a declared version above
       the maximum supported is classified as newer-than-supported
       rather than bucketed into the 0.1.0-0.8.99 era or falling
       through to the run-everything "unknown" safety net; callers that
       reach it without initContext must treat that classification as a
       refusal. This helper-level behavior is pinned by unit tests
       only.

    How: Make the check cheap (one raw manifest field read at a point
    where the manifest path is already being resolved) and keep error
    construction consistent with the deterministic-code pattern in
    entity-storage-compatibility.ts so CLI/daemon consumers can branch
    on the code. Decision on manifest representation: the check reads
    the raw manifest, where a missing field is genuinely absent; on
    schema-parsed paths the Zod default makes missing indistinguishable
    from an explicit "1.0", which is acceptable because both routes end
    in "no refusal" for 1.0 — do not add plumbing to distinguish them
    downstream. Do not change behavior for kynetic values <= 1.2 or for
    manifests without the field.

    Testing: Temp-project fixtures (setupTempFixtures / initGitRepo +
    setupShadowDetection) with manifests declaring kynetic "9.9" and a
    garbage value: assert representative read and write commands refuse
    with the deterministic code and non-zero exit, and assert no
    project data changed (file content/mtimes, including the shadow
    worktree — the refusal must fire before any pre-read sync). Add a
    sync-pull dual fixture: local shadow manifest declares a supported
    version while the remote kspec-meta branch holds a newer-format
    manifest (kynetic "9.9"); assert the same invocation that performs
    the sync pull refuses with the deterministic code after the pull
    and before reading or mutating entity data. Assert
    `kspec upgrade` refuses before any step executes (CLI-level, pinned
    to the context-initialization error code), with a separate unit
    test pinning detectSourceVersion's newer-than-supported
    classification. Assert `kspec doctor` completes read-only with the
    mismatch reported. Regression test that a "1.2" manifest is
    unaffected. Annotate tests with the spec's explicit AC ids — there
    is no ac-N numbering on this spec:
    AC: @data-format-forward-compatibility ac-newer-version-refused,
    AC: @data-format-forward-compatibility ac-post-sync-newer-version-refused,
    AC: @data-format-forward-compatibility ac-daemon-structured-error,
    AC: @data-format-forward-compatibility ac-unrecognized-version-refused,
    AC: @data-format-forward-compatibility ac-diagnostics-report-read-only,
    AC: @data-format-forward-compatibility ac-upgrade-refuses-newer,
    AC: @data-format-forward-compatibility ac-supported-versions-unaffected.

    Covers: @data-format-forward-compatibility ac-newer-version-refused,
    ac-post-sync-newer-version-refused, ac-daemon-structured-error,
    ac-unrecognized-version-refused, ac-diagnostics-report-read-only,
    ac-upgrade-refuses-newer, ac-supported-versions-unaffected.

- title: Migrate version-control utility subprocesses to args-array invocation
  slug: task-git-utils-execfile
  priority: 2
  tags: [infra, reliability, security]
  spec_ref: "@subprocess-argument-literalness"
  description: |
    Why: src/utils/git.ts builds git commands via execSync with
    template-literal interpolation. Most interpolated values are
    internally derived, but branch and remote names come from repository
    state, and git permits `$`, parentheses, semicolons, quotes, and
    backticks in ref names — so a cloned repository with a crafted
    branch name reaches a shell today via getBranchRemote, and every
    other site is one refactor away from the same hole. The codebase
    already has the safe pattern (runGitSync / runGitAsync in
    src/parser/shadow.ts use spawnSync/execFile with args arrays); this
    task migrates the remaining shell-string call sites.

    What: In src/utils/git.ts, replace every execSync invocation with a
    spawnSync("git", [...args]) (or execFileSync) call, preserving sync
    semantics, stdio behavior, and the documented failure results
    (null / [] / default object — never throw). Interpolating call
    sites to convert:
    - line 81-84: getRecentCommits — `-n ${limit}` and
      `--since="${since.toISOString()}"`
    - line 203: getDiffSince — `--before="${since.toISOString()}"`
    - line 223: getDiffSince — `git diff ${sinceCommit}..HEAD`
    - line 274: getBranchRemote — `branch.${branch}.remote`
    - line 281: getBranchRemote — `git remote get-url ${remote}`
    - line 291: getBranchRemote — `branch.${branch}.merge`
    Static call sites to convert for consistency (no interpolation):
    lines 35 (isGitRepo), 52 (getCurrentBranch), 139
    (getWorkingTreeStatus), 213 and 230 (getDiffSince), 250
    (getHeadCommit).

    How: Add one small private helper mirroring runGitSync from
    src/parser/shadow.ts (spawnSync with args array, encoding utf-8,
    piped stdio) and route all call sites through it. The args-array
    mechanism is the implementation requirement here in How — the spec
    ACs are expressed as observable literalness outcomes, not launch
    mechanics. No behavior change other than literal handling of
    metacharacter values. Do not touch other files' subprocess usage in
    this task.

    Testing: Unit tests in a temp git repo (initGitRepo): create and
    check out a branch whose name contains shell metacharacters (e.g.
    `feat-$(canary);x`), configure a tracking remote entry, then assert
    getCurrentBranch and getBranchRemote return the literal name and
    that no canary side-effect occurred (e.g. no file created by the
    embedded command). Assert getRecentCommits/getDiffSince outputs are
    unchanged on a normal repo, and that helpers still return null/[]
    outside a repo. Annotate with
    AC: @subprocess-argument-literalness ac-metacharacter-branch-literal,
    ac-dynamic-values-treated-literally, ac-failure-results-preserved.

    Covers: @subprocess-argument-literalness
    ac-metacharacter-branch-literal, ac-dynamic-values-treated-literally,
    ac-failure-results-preserved.

- title: Document justification for intentionally swallowed errors
  slug: task-catch-justification-comments
  priority: 3
  tags: [infra, chore]
  depends_on:
    - "@task-shadow-restore-loud-failure"
  description: |
    Why: Several files swallow errors via empty catch blocks or
    `.catch(() => {})` without stating why ignoring the error is safe.
    Most are legitimately ignorable cleanup (best-effort rm of staging
    files, lock release races), but the absence of justification makes
    each one indistinguishable from a latent bug like the shadow restore
    swallow fixed by @task-shadow-restore-loud-failure. This task is
    comments-only hygiene. It depends only on
    @task-shadow-restore-loud-failure because that is the one
    behavioral task that touches an audited file (src/parser/shadow.ts);
    the other behavioral tasks in this plan touch none of the five
    audited files, so they are intentionally not dependencies.

    What: In EXACTLY these five files — src/cli/batch-write-buffer.ts,
    src/parser/entity-local-resources.ts, src/parser/file-lock.ts,
    src/agents/spawner.ts, src/parser/shadow.ts — audit every empty
    catch block and every `.catch(() => {})` / `.catch(() => null)`
    expression. For each one that lacks an explanatory comment, add a
    one-line comment stating why swallowing the error is safe (what the
    error would be, why the operation is best-effort, what guarantees
    still hold). Catches that already carry a justification comment are
    left untouched.

    Bounds (hard):
    - Comments only. NO semantic changes, no control-flow changes, no
      new logging, no schema or API changes, no test-assertion changes.
    - If the audit finds a swallowed error that appears
      behavior-affecting rather than ignorable cleanup, do NOT change
      it in this task — capture it with `kspec inbox add` describing
      the site and the suspected impact, and note it in the task notes.
    - No files outside the five listed above.

    How: Grep each file for `catch` and `.catch(`, classify each site,
    write the justification at the site. Keep comments to one or two
    lines matching the file's existing comment style.

    Testing: No new tests (no behavior change). Gates: npm run lint,
    typecheck, and the full npm test suite must pass with zero
    modifications to test files — a test change is evidence the bounds
    were violated.
```

## Implementation Notes

### Audit finding verification

- **Finding 1 (silent shadow restore)** — confirmed, line numbers corrected:
  the silent `.catch(() => {})` restore swallows live at
  src/parser/shadow.ts:2923 (initShadow) and :3056 (repairShadow), not at
  the lines the audit cited (73-94 are the stash/restore helper
  definitions; 200/218-221 are unrelated, already-commented catches in
  createOrphanBranchFallback). Handled as a delta to the existing
  implemented spec @broken-shadow-safety (new AC
  `ac-restore-failure-reports-state`, applied by the dedicated
  spec-update task @task-broken-shadow-safety-spec-delta) rather than a
  new spec, since ac-preserve-on-failure already owns this contract.
- **Finding 2 (no schema versioning)** — corrected: versioning DOES exist
  (manifest `kynetic` field 1.0/1.1/1.2, per-domain storage format
  declarations, `lastKnownVersion` in setup state, probe-based inference
  in upgrade). What is genuinely missing is the FORWARD direction: every
  gate is a `>= floor` check with no ceiling, so newer-format data is
  silently operated on, and upgrade probe inference misclassifies
  unknown newer versions as the pre-0.9 era. The spec is scoped to that
  gap only; backward handling stays with the existing gates
  (@entity-folder-migration-and-compatibility-1, task-data-manager
  legacy gate).
- **Finding 3 (execSync interpolation)** — confirmed. Interpolating sites
  enumerated in the task (lines 81-84, 203, 223, 274, 281, 291 of
  src/utils/git.ts). Branch/remote names are repository-state-derived and
  may contain shell metacharacters, so this is a real (if low-severity)
  injection surface today, not merely future-proofing.
- **Finding 4 (undocumented swallowed errors)** — confirmed; many sites in
  the five named files, a number already carry justification comments
  (e.g. file-lock.ts:152, spawner.ts:196). Per the classification rule:
  the one behavior-affecting case found (shadow restore) became
  spec+task; the rest get the bounded comments-only hygiene task that
  runs last.
- **Finding 5 (folder migrations lack rollback)** — dropped as a false
  positive. The plan/review folder migrations are idempotent
  (already-migrated short-circuit), dry-run capable, refuse partial
  layouts without --force, run atomically through the staged write
  buffer (runWithBuffer staging+rename with discard-on-failure and
  rolled_back step reporting), interrupted/partial layouts are detected
  and blocked with recovery guidance (`partial_entity_storage_layout` in
  src/parser/entity-storage-compatibility.ts), and `kspec upgrade`
  surfaces the pre-mutation shadow HEAD (`previousShadowCommit`) as an
  explicit rollback point. This is the behavior the audit asked for,
  already specced by @entity-folder-migration-and-compatibility-1.

### Overlap with existing plans/specs

- **@versioning / @format-version (implemented specs)** — own the
  two-version model and the manifest's declared-format-version field
  semantics (@format-version ac-1: the declared version determines which
  schema compatibility rules are applied). The new decision spec is a
  true delta layered on that field: it adds the forward-direction rule
  (refusal above the supported ceiling), the diagnostic carve-out, and
  stamping ownership (only the upgrade flow advances the version) — it
  does not restate the field's existence or backward-compatibility
  semantics. The relationship is declared structurally: the spec is
  parented under @versioning and depends_on @format-version (the plan
  spec format supports parent/depends_on but not relates_to; depends_on
  is the accurate relation here since the refusal rule builds on the
  declared-version semantics).
- **Input Validation Hardening (completed plan)** — covers external input
  boundaries (CLI options, HTTP bodies); does not cover internally
  derived subprocess arguments, so @subprocess-argument-literalness is
  complementary, not overlapping.
- **Init, Setup, and Upgrade Rough Edges (completed plan)** — produced
  @single-command-version-upgrade (pipeline steps, source-version
  detection). The forward-compatibility refusal is new behavior layered
  on top; the task names the exact probe-inference code it corrects.
- **Folder-Backed Index Consistency Hardening / Folder-Backed Plans,
  Reviews, and Local Resources (completed plans)** — own migration
  atomicity and partial-layout semantics; finding 5 excluded because of
  this coverage.
- **@shadow-recovery / @shadow-errors / @broken-shadow-safety
  (implemented specs)** — own shadow repair behavior; finding 1 is
  expressed as an AC delta to @broken-shadow-safety instead of a new
  spec.

### Review fix cycle 2 decisions

- **Post-sync re-check (claude cycle-2 question)** — the pre-sync raw
  read only inspects the local manifest, leaving a dual gap: a remote
  shadow branch upgraded to a newer format passes the local check, the
  sync pull imports the newer-format data, and the invocation operates
  on it, deferring refusal to the next invocation. Decision: step 2
  re-applies the same ceiling comparison (same deterministic codes) to
  the manifest parsed after the sync block, so the pulling invocation
  itself refuses before any entity read or mutation. The pull itself is
  acceptable mutation (it is ordinary sync of data already authored
  remotely); the guarantee defended is "no operation on data newer than
  supported", enforced at both check points. A sync-pull dual fixture
  was added to Testing.
- **Spec/amendment coherence (codex cycle-3 blocker)** — the task
  amendment initially left ac-newer-version-refused's "no modification
  including synchronization" guarantee in tension with the permitted
  pull in the remote-newer dual. Resolution: the spec now expresses the
  two enforcement points explicitly — ac-newer-version-refused keeps
  the full no-modification-including-sync guarantee for the
  locally-declared-newer case, and a new
  ac-post-sync-newer-version-refused owns the remote-newer dual (the
  synchronized import is permitted; the same invocation refuses before
  any project data is read or mutated). The Checking decision bullet
  describes both points; task annotations and Covers include the new
  AC.

### Review fix cycle 1 decisions

- **Ceiling check placement (codex blocker)** — context initialization
  can run pre-read shadow sync (hasRemoteTracking/shadowNeedsSync/
  shadowPull at src/parser/yaml.ts:783-836) before it locates and parses
  the manifest (:838-845), so a post-parse check could let a sync pull
  mutate newer-format data first. Decision: the check reads the declared
  version RAW from disk as soon as the spec directory is known, before
  any sync step; the spec's Checking bullet and ac-newer-version-refused
  now state the no-modification guarantee explicitly includes
  context-initialization synchronization.
- **Upgrade refusal ownership (claude question)** — runUpgradePipeline
  calls initContext (upgrade.ts:345-346) before detectSourceVersion
  (:352), so the initContext throw owns the user-visible `kspec upgrade`
  refusal; the detectSourceVersion probe correction is retained as
  helper-level defense in depth pinned by unit tests only, so no test
  expects a refusal message the earlier throw preempts.
- **Existing-spec delta mechanism (codex blocker)** — plan import has no
  update-existing-spec support in the Specs block, so the
  @broken-shadow-safety AC delta is a dedicated spec-update task with
  verbatim AC text (precedent: daemon-dispatch-oom-hardening
  spec-alignment plan), ordered before the implementation task via
  depends_on; downstream Covers lines annotate the AC's origin.
- **Subprocess AC rewrite (codex question)** — ac-dynamic-values-
  discrete-args specified launch mechanics; replaced with
  ac-dynamic-values-treated-literally expressing observable outcomes
  (literal success/failure, no embedded command execution, no shell
  interpretation). The args-array requirement stays in the task How.
- **Diagnostic carve-out (claude question)** — moved into
  ac-newer-version-refused's own text ("other than the project health
  diagnostic") so the AC pair is consistent for spec-only readers
  rather than relying on the implementation detail that the diagnostic
  bypasses context initialization.
- **Raw vs schema-parsed manifest (claude nit)** — the manifest schema
  defaults a missing version field to "1.0", making missing
  indistinguishable from explicit "1.0" on parsed paths. Decision: the
  ceiling check reads the raw manifest where "missing" is unambiguous;
  the parsed-path ambiguity is accepted (both routes end in no refusal)
  and documented in the task How.
- **AC annotation ids (codex question + claude nit)** — testing guidance
  now lists the spec's explicit descriptive AC ids; this spec has no
  ac-N numbering.
- **Dependency trim (claude nit)** — the comments-only hygiene task now
  depends only on @task-shadow-restore-loud-failure, the single
  behavioral task touching one of its five audited files; the other two
  edges over-serialized a P3 task with no file overlap.
