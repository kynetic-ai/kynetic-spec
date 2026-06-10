# Data Integrity and Upgrade Safety

## Specs

```yaml
# ─── Format version forward compatibility ───

- title: Data Format Forward Compatibility
  slug: data-format-forward-compatibility
  type: decision
  parent: "@schema"
  description: |
    Defines the forward-compatibility contract for project data. The
    project manifest's declared format version is the single format
    version of record for the project's data layout, and each released
    version of kspec declares a maximum supported format version it can
    read and write.

    Decision semantics:

    - Stamping: the format version is written to the project manifest at
      initialization and advanced only by the upgrade flow — never
      implicitly by ordinary commands.
    - Checking: the declared format version is compared against the
      maximum supported version when project context is initialized,
      before any command logic reads or mutates project data. The check
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
    - Older than supported: not refused by this contract. Existing
      per-domain storage-compatibility gates continue to govern older
      formats (lenient reads where safe, refusal with upgrade guidance
      where the operation requires a newer layout).
    - A manifest with no declared format version retains its existing
      legacy interpretation and is not affected by this contract.
  acceptance_criteria:
    - id: ac-newer-version-refused
      given: |
        A project manifest declares a format version greater than the
        running tool's maximum supported format version
      when: |
        Any command that reads or mutates project data initializes
        project context
      then: |
        The command refuses with a deterministic error code reserved for
        newer-than-supported format versions; the error names both the
        project's declared version and the tool's maximum supported
        version, includes guidance to upgrade the tool installation, and
        no project data is modified
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
    passed as discrete subprocess arguments and are never interpreted by
    a shell. Repository metadata is externally influenceable (a cloned
    repository controls its own branch and remote names), so queries
    over that metadata must treat every dynamic value as literal data.
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
    - id: ac-dynamic-values-discrete-args
      given: |
        A version-control query incorporates a dynamic value (branch
        name, remote name, revision identifier, or timestamp)
      when: |
        The subprocess is launched
      then: |
        The dynamic value is passed as a discrete argument element and
        is not concatenated into a string that a shell parses
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
- title: Make shadow repair restore failures loud with recovery guidance
  slug: task-shadow-restore-loud-failure
  priority: 1
  tags: [shadow, reliability, bug]
  spec_ref: "@broken-shadow-safety"
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
    directory.

    What:
    1. Add one acceptance criterion to the existing spec
       `@broken-shadow-safety` (delta to an implemented spec — do not
       create a new spec), with this exact id and wording:

       `ac-restore-failure-reports-state`
       Given: A failed shadow rebuild is restoring the preserved
       pre-repair shadow directory from its backup location
       When: The restore itself fails
       Then: The operation reports the restore failure alongside the
       original rebuild error, identifies the absolute path of the
       preserved backup directory and the resulting state of the shadow
       directory location, and provides concrete recovery steps; the
       backup directory is never deleted on this path

    2. Replace both silent `.catch(() => {})` restore calls
       (src/parser/shadow.ts:2923 and :3056) with handling that captures
       the restore error and surfaces a combined failure message: the
       original rebuild error, the restore error, the absolute backup
       directory path, what now exists at the worktree location, and
       recovery steps (move the backup directory back into place, then
       re-run `kspec shadow repair`).
    3. Audit restoreStashedWorktreeDir (src/parser/shadow.ts:84-94): it
       removes the worktree directory before renaming the backup into
       place — if the rename fails after the removal, the failure
       message must accurately describe that the worktree location is
       now empty and the backup is the only copy.
    4. When restore succeeds after a rebuild failure, the existing
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
    @broken-shadow-safety ac-restore-failure-reports-state (new).

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
    2. In initContext (src/parser/yaml.ts:701), after the manifest is
       parsed: if manifest.kynetic parses to a numeric version greater
       than the maximum supported, throw a structured error with a
       deterministic code (`format_version_newer_than_supported`)
       naming the declared version, the maximum supported version, and
       guidance to upgrade the kspec installation. If manifest.kynetic
       is present but not parseable as a numeric version, throw
       `unrecognized_format_version` naming the literal value. A missing
       kynetic field keeps its existing legacy handling.
    3. Daemon parity: ensure daemon routes surface this as a structured
       error with the same code (follow the existing
       EntityStorageCompatibilityError handling pattern for the 409-style
       structured responses).
    4. Doctor exemption: kspec doctor must not hard-fail — it already
       reads the manifest directly (src/parser/doctor.ts:719); add a
       version-mismatch check that reports the incompatibility with
       both versions and guidance, read-only.
    5. Upgrade refusal: in runUpgradePipeline / detectSourceVersion
       (src/cli/commands/upgrade.ts), refuse before any step executes
       when the manifest's declared version exceeds the maximum
       supported — report that the project format is newer than the
       running tool instead of classifying it as an older era or
       falling through to the run-everything safety net.

    How: Make the check cheap (manifest is already in memory at
    initContext) and keep error construction consistent with the
    deterministic-code pattern in entity-storage-compatibility.ts so
    CLI/daemon consumers can branch on the code. Do not change behavior
    for kynetic values <= 1.2 or for manifests without the field.

    Testing: Temp-project fixtures (setupTempFixtures / initGitRepo +
    setupShadowDetection) with manifests declaring kynetic "9.9" and a
    garbage value: assert representative read and write commands refuse
    with the deterministic code and non-zero exit, assert no file
    mtimes/content change, assert `kspec upgrade` refuses before steps,
    and assert `kspec doctor` completes read-only with the mismatch
    reported. Regression test that a "1.2" manifest is unaffected.
    Annotate with AC: @data-format-forward-compatibility ac-N for each.

    Covers: @data-format-forward-compatibility ac-newer-version-refused,
    ac-daemon-structured-error, ac-unrecognized-version-refused,
    ac-diagnostics-report-read-only, ac-upgrade-refuses-newer,
    ac-supported-versions-unaffected.

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
    piped stdio) and route all call sites through it. No behavior
    change other than literal handling of metacharacter values. Do not
    touch other files' subprocess usage in this task.

    Testing: Unit tests in a temp git repo (initGitRepo): create and
    check out a branch whose name contains shell metacharacters (e.g.
    `feat-$(canary);x`), configure a tracking remote entry, then assert
    getCurrentBranch and getBranchRemote return the literal name and
    that no canary side-effect occurred (e.g. no file created by the
    embedded command). Assert getRecentCommits/getDiffSince outputs are
    unchanged on a normal repo, and that helpers still return null/[]
    outside a repo. Annotate with
    AC: @subprocess-argument-literalness ac-metacharacter-branch-literal,
    ac-dynamic-values-discrete-args, ac-failure-results-preserved.

    Covers: @subprocess-argument-literalness
    ac-metacharacter-branch-literal, ac-dynamic-values-discrete-args,
    ac-failure-results-preserved.

- title: Document justification for intentionally swallowed errors
  slug: task-catch-justification-comments
  priority: 3
  tags: [infra, chore]
  depends_on:
    - "@task-shadow-restore-loud-failure"
    - "@task-format-version-ceiling"
    - "@task-git-utils-execfile"
  description: |
    Why: Several files swallow errors via empty catch blocks or
    `.catch(() => {})` without stating why ignoring the error is safe.
    Most are legitimately ignorable cleanup (best-effort rm of staging
    files, lock release races), but the absence of justification makes
    each one indistinguishable from a latent bug like the shadow restore
    swallow fixed by @task-shadow-restore-loud-failure. This task is
    comments-only hygiene; it runs last so it documents the
    post-behavioral-fix state of these files.

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
  `ac-restore-failure-reports-state`) rather than a new spec, since
  ac-preserve-on-failure already owns this contract.
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
