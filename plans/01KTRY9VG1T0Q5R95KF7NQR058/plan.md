# Release Packaging and Onboarding Readiness

## Specs

```yaml
- title: Release and Distribution
  slug: release-and-distribution
  type: module
  parent: "@main"
  description: |
    Packaging, publication, and release verification for the
    kspec distribution: what the installable artifact contains,
    which runtimes it supports, and how publication is gated on
    verification evidence.

- title: Single Supported Runtime Version Range
  slug: supported-runtime-range
  type: requirement
  parent: "@release-and-distribution"
  description: |
    kspec declares exactly one supported Node.js runtime version
    range, and every user-facing installation or onboarding
    document that states a runtime requirement states that same
    range. The package manifest's engine declaration is the
    single source of truth; documentation follows it, never the
    other way around.
  acceptance_criteria:
    - id: ac-1
      given: |
        The published package's manifest is examined
      when: |
        The runtime engine constraint is read
      then: |
        Exactly one supported Node.js version range is declared,
        with an explicit minimum major version
    - id: ac-2
      given: |
        A user-facing installation or onboarding document states
        a Node.js version requirement
      when: |
        The stated requirement is compared with the declared
        engine constraint
      then: |
        The stated minimum version equals the declared minimum;
        no user-facing document states a lower or otherwise
        different minimum

- title: Published Artifact Completeness
  slug: published-artifact-completeness
  type: requirement
  parent: "@release-and-distribution"
  description: |
    The artifact a user installs contains everything needed to
    run kspec and the legal terms it is distributed under: a
    license text matching the declared license identifier, the
    complete built command-line interface, and the complete
    built web interface. Packaging from a clean source state
    produces a complete artifact; it never silently depends on
    previously built output being present.
  acceptance_criteria:
    - id: ac-1
      given: |
        The package is packed for publication
      when: |
        The packed contents are inspected
      then: |
        A license document is present at the package root and
        its terms match the license identifier declared in the
        package manifest
    - id: ac-2
      given: |
        The package is packed for publication
      when: |
        The packed contents are inspected
      then: |
        The declared command-line entry point resolves to a file
        that is present in the package
    - id: ac-3
      given: |
        The package is packed for publication
      when: |
        The packed contents are inspected
      then: |
        The built web interface assets are present, including
        the entry document required to serve the interface
    - id: ac-4
      given: |
        A source checkout with no pre-existing build output
      when: |
        The package is packed for publication
      then: |
        The packing step itself produces the built artifacts,
        and the resulting package satisfies the completeness
        criteria above

- title: Pre-Publish Verification Across Supported Runtimes
  slug: prepublish-runtime-verification
  type: requirement
  parent: "@release-and-distribution"
  description: |
    Automated verification exercises kspec across the supported
    Node.js runtime range rather than on a single version, so
    the declared engine constraint is backed by evidence. At
    minimum, the oldest supported major version and at least one
    newer major version are both exercised, and publication is
    gated on verification at the oldest supported major version.
  acceptance_criteria:
    - id: ac-1
      given: |
        The automated test pipeline runs for a proposed change
      when: |
        The pipeline's runtime coverage is examined
      then: |
        The test suite executes on the oldest supported Node.js
        major version and on at least one newer major version,
        as distinct runs that must each pass
    - id: ac-2
      given: |
        A release publish is initiated
      when: |
        The publish pipeline executes
      then: |
        Publication proceeds only after build and test
        verification has passed on the oldest supported Node.js
        major version
```

## Tasks

derive_from_specs: false

```yaml
- title: Add MIT LICENSE file to repository root
  slug: task-add-license-file
  priority: 1
  tags: [release, infra, docs]
  spec_ref: "@published-artifact-completeness"
  description: |
    Why: package.json declares "license": "MIT" but no LICENSE
    file exists at the repository root, so the published npm
    package ships with no license text. This is a legal gap for
    a publicly published package.

    What: Create /LICENSE at the repository root containing the
    standard MIT license text with copyright holder "Kynetic AI"
    (matching the package.json "author" field) and an
    appropriate year range. No package.json "files" change is
    needed: npm always includes LICENSE* files in the packed
    tarball regardless of the files array. This task also
    CREATES tests/release-packaging.test.ts — it owns that file;
    later tasks extend it and depend on this task.

    How: Use the canonical MIT text (https://opensource.org/license/mit).
    Verify inclusion with `npm pack --dry-run` and confirm
    LICENSE appears in the tarball file listing.

    Testing: Create tests/release-packaging.test.ts with
    behavioral assertions that stay clean under the
    no-source-scanning lint rule (error severity in tests):
    (a) spawn `npm pack --dry-run --json` (pass the repo root as
    an explicit cwd) and assert the parsed JSON file listing
    contains LICENSE — subprocess output parsing, no file read;
    (b) import package.json as a JSON module (import attributes)
    and assert license === "MIT" — module import, no fs read;
    (c) for the terms-match-identifier check, read the first
    lines of LICENSE and assert they identify the MIT license —
    this is a project-file read, so use the rule's sanctioned
    escape hatch: an inline eslint-disable comment for
    no-source-scanning/no-source-file-reads with a written
    reason (the LICENSE text is the release artifact under
    test). Do not claim the rule does not apply. Annotate with
    `// AC: @published-artifact-completeness ac-1`.
    Run gates: npm run format, npm run lint, npm run typecheck,
    npm test.

    Covers: @published-artifact-completeness ac-1.

- title: Upgrade vulnerable production dependencies via npm audit fix
  slug: task-audit-fix-production-deps
  priority: 1
  tags: [security, deps, infra]
  description: |
    Why: `npm audit --omit=dev` reports 8 production
    vulnerabilities (2 high, 6 moderate): devalue 5.6.3-5.8.0
    (high, DoS via sparse array deserialization), undici
    7.0.0-7.23.0 (high, WebSocket parser crash, request
    smuggling, memory consumption), dompurify <=3.3.3 (XSS
    chain), file-type 13-21.3.1 (DoS), smol-toml <1.6.1 (DoS),
    svelte <=5.55.6 (SSR XSS chain), ws 8.0.0-8.20.0
    (uninitialized memory disclosure), yaml 2.0.0-2.8.2 (stack
    overflow on deeply nested collections). `npm audit` claims
    all are fixable via `npm audit fix` (no --force needed).

    What: Run `npm audit fix` (NEVER `npm audit fix --force`).
    Scope, precisely: the acceptance bar is production
    advisories only — `npm audit --omit=dev` must report 0
    vulnerabilities afterward. Note that `npm audit fix`
    operates on the whole install tree, so it may also bump
    dev-only/workspace tooling advisories (e.g. @sveltejs/kit,
    cookie); those side-effect bumps are accepted as part of
    this task PROVIDED they are semver-compatible lock-only
    changes. Review the entire package-lock.json diff (dev bumps
    included) and confirm every bump is semver-compatible
    (patch/minor within declared ranges). Dev-only advisories
    that `npm audit fix` does not resolve are explicitly out of
    scope: leave them and capture a follow-up inbox item. Direct
    root deps affected: yaml, ws, smol-toml (package.json
    dependencies). Transitive/web-ui tree: devalue, dompurify,
    file-type, svelte, undici.

    How: Pay special attention to yaml — it is kspec's core
    parsing library (used throughout src/parser/). Read the yaml
    changelog between the locked version and the fixed version
    for behavior changes (the fix lands in the 2.8.x line, so a
    lock-only bump is expected; package.json already allows
    ^2.8.2). If any advisory's fix requires a semver-major bump,
    exclude it from this task, leave a task note, and capture a
    follow-up inbox item instead of forcing it.

    Testing: Full gates are the acceptance bar: npm run
    typecheck, npm run lint, npm run format:check, npm test
    (full suite, not shards), and npm run test:e2e (svelte/
    devalue/dompurify affect the web UI SSR/render paths; yaml
    affects every parser test). Confirm `npm audit --omit=dev`
    exits clean afterward.

- title: Standardize documented Node.js minimum on the engines value
  slug: task-standardize-node-version-docs
  priority: 2
  tags: [docs, release]
  spec_ref: "@supported-runtime-range"
  depends_on:
    - "@task-add-license-file"
  description: |
    Why: package.json "engines" requires node >=20.0.0, but
    INSTALL.md line 7 says "Node.js v18 or later" and
    docs/getting-started/tutorial.md line 17 says "Node.js 18+".
    Other user-facing docs already say 20+
    (docs/getting-started/installation.md line 7,
    docs/guides/upgrading-kspec.md line 8,
    docs/guides/starting-a-new-project.md line 8) and must not
    regress. Users on Node 18 following INSTALL.md will hit
    engine warnings or runtime failures.

    What: Update INSTALL.md:7 to "**Node.js** v20 or later" and
    docs/getting-started/tutorial.md:17 to "Node.js 20+". Then
    sweep ALL user-facing docs — README.md, INSTALL.md, and
    every markdown file under docs/ (including
    docs/guides/starting-a-new-project.md and
    docs/guides/upgrading-kspec.md) — with:
    `grep -rn "18" README.md INSTALL.md docs/ | grep -i node`
    and fix any further stale minimums.

    How: The engines value (>=20.0.0) is the source of truth —
    change docs to match it, do not change engines.

    Testing: Extend tests/release-packaging.test.ts (created by
    @task-add-license-file) with a consistency test that:
    (a) obtains the minimum major version by importing
    package.json as a JSON module (import attributes) — no fs
    read; (b) derives the checked document set DYNAMICALLY —
    README.md, INSTALL.md, and a recursive glob of markdown
    files under docs/ — instead of enumerating fixed filenames,
    so every current user-facing doc (installation, tutorial,
    starting-a-new-project, upgrading-kspec, and any future doc)
    is covered and a new doc stating a stale minimum fails the
    test; (c) scans each document for Node.js version
    statements and asserts every stated minimum equals the
    engines minimum. Reading the markdown files is a
    project-file read that the no-source-scanning lint rule
    (error severity in tests) flags: isolate the reads in a
    small helper and use the rule's sanctioned escape hatch —
    an inline eslint-disable comment for
    no-source-scanning/no-source-file-reads with a written
    reason (the docs are the artifacts whose published content
    is the AC contract). Do not claim the rule does not apply.
    Annotate with `// AC: @supported-runtime-range ac-1` and
    `// AC: @supported-runtime-range ac-2`.
    Run gates: npm run lint, npm test.

    Covers: @supported-runtime-range ac-1, ac-2.

- title: Fix broken documentation links in INSTALL.md
  slug: task-fix-install-doc-links
  priority: 2
  tags: [docs]
  description: |
    Why: INSTALL.md links to docs/getting-started.md at lines
    102, 141, and 166, but that file does not exist — the actual
    landing page is docs/getting-started/index.md. INSTALL.md
    line 102 also links to README.md#how-it-works, but README.md
    has no "How it works" heading (its headings are: kspec,
    Install, First steps, Documentation), so the anchor is dead.

    What: Update the three docs/getting-started.md references to
    docs/getting-started/index.md (verify each link's display
    text still reads naturally). Replace the
    README.md#how-it-works anchor with a valid target — either
    plain README.md or README.md#documentation, whichever fits
    the sentence at line 102.

    How: After editing, verify every relative link in INSTALL.md
    resolves: extract targets with
    `grep -oP '\]\((?!http)[^)#]+' INSTALL.md` and check each
    path exists; check any remaining #anchors against actual
    headings in the target file.

    Testing: Manual link verification as above is sufficient; if
    a markdown link-check test already exists, extend it to
    cover INSTALL.md. Run gates: npm run format:check (oxfmt
    formats markdown), npm test.

- title: Make prepack run the full build and verify tarball contents
  slug: task-prepack-full-build-and-verification
  priority: 1
  tags: [release, ci, infra]
  spec_ref: "@published-artifact-completeness"
  depends_on:
    - "@task-add-license-file"
  description: |
    Why: package.json "prepack" only runs `npm run build:plugin`.
    The CI publish workflow (.github/workflows/publish.yml) runs
    a full `npm run build` before publishing, so the CI path is
    covered — but a local `npm pack` or `npm publish` would ship
    whatever stale dist/ happens to be on disk (or fail on a
    clean checkout). Nothing anywhere verifies the packed
    tarball actually contains the built CLI and web UI, and
    nothing proves the packing step itself produces complete
    artifacts from a clean source state.

    What: (1) Change "prepack" in package.json from
    "npm run build:plugin" to "npm run build" (the full build
    already ends with build:plugin, so plugin output is still
    produced). (2) Add scripts/verify-package.cjs that runs
    `npm pack --dry-run --json`, parses the file list, and fails
    unless it contains: LICENSE, dist/cli/index.js,
    dist/index.js, dist/web-ui/index.html, templates/skills/manifest.yaml,
    and at least one plugin/ entry. (3) Add a
    "verify-package": "node scripts/verify-package.cjs" npm
    script. (4) Add scripts/verify-clean-pack.cjs that proves
    ac-4 BEHAVIORALLY: stage a clean source copy with no build
    output into a temp directory (e.g. `git archive HEAD` or a
    copy excluding dist/, plugin/, and node_modules/), link the
    repository's installed node_modules into it, run a real
    `npm pack --json` there (NOT --dry-run, so the prepack
    lifecycle script itself must produce the build output), and
    fail unless the resulting tarball listing contains all the
    artifacts from (2). Expose it as a
    "verify-clean-pack" npm script. (5) In
    .github/workflows/publish.yml, add a `npm run verify-package`
    step between "Build" and "Run tests", and a
    `npm run verify-clean-pack` step before the publish step, so
    a publish with missing or stale-build-dependent artifacts
    fails loudly. verify-clean-pack performs a full build, so it
    runs in the publish workflow (publishes are rare), not in
    test.yml or the vitest suite.

    How: Do not assume `npm pack --dry-run` runs prepack — it
    does not in all npm versions; that is exactly why
    verify-clean-pack must use a real `npm pack`.
    verify-package.cjs should check dist/ on disk AND parse the
    `npm pack --dry-run --json` listing; in CI it runs after the
    explicit build step. Keep both scripts dependency-free
    (node builtins only) like the other scripts/*.cjs files.

    Testing: Extend tests/release-packaging.test.ts (created by
    @task-add-license-file) with behavioral tests for
    verify-package.cjs: running it after a build exits 0, and
    running it against a tree missing dist/web-ui exits non-zero
    (stage the broken tree with createTempDir() — temp-dir reads
    and subprocess exit codes are lint-clean under the
    no-source-scanning rule). Annotate with
    `// AC: @published-artifact-completeness ac-2` and
    `// AC: @published-artifact-completeness ac-3`. Do NOT
    assert on package.json script strings — the behavioral proof
    for ac-4 is scripts/verify-clean-pack.cjs itself: annotate
    that script with
    `// AC: @published-artifact-completeness ac-4`, run
    `npm run build && npm run verify-package` and
    `npm run verify-clean-pack` locally before submitting, and
    record the results in a task note.
    Run gates: npm run lint, npm run typecheck, npm test.

    Covers: @published-artifact-completeness ac-2, ac-3, ac-4.

- title: Add Node.js version matrix to CI and gate publish on minimum version
  slug: task-ci-node-version-matrix
  priority: 2
  tags: [ci, release, infra]
  spec_ref: "@prepublish-runtime-verification"
  depends_on:
    - "@task-prepack-full-build-and-verification"
  description: |
    Why: package.json engines allows node >=20.0.0, but every CI
    job pins node-version "24" (.github/workflows/test.yml lines
    37, 71, 112; publish.yml line 30). Nothing ever runs the
    suite on Node 20, so the declared support floor is untested
    — a Node-24-only API could slip in unnoticed. The test
    workflow also invokes `npx vitest run --shard=...` directly,
    which bypasses the project's required test runner script
    (scripts/test.cjs performs environment readiness checks; the
    testing convention forbids invoking vitest directly).
    Depends on @task-prepack-full-build-and-verification because
    both tasks edit .github/workflows/publish.yml and must not
    run in parallel.

    What: (1) In .github/workflows/test.yml, add a
    `workflow_dispatch:` trigger so the workflow can be run
    on-demand against any branch — this is what makes the change
    verifiable without opening a GitHub PR (this repo's policy
    reserves PRs for release-track merges). (2) Extend the
    `test` job's strategy matrix to cross shard [1, 2, 3] with
    node-version ["20", "24"], and use
    `node-version: ${{ matrix.node-version }}` in the setup-node
    step; update the job `name` to include the node version.
    Leave the `lint` and `e2e` jobs on "24" (lint/format results
    are version-independent and e2e doubles CI cost for little
    signal). (3) Replace the direct
    `npx vitest run --shard=${{ matrix.shard }}/3` step with
    `npm test -- --shard=${{ matrix.shard }}/3` so CI goes
    through scripts/test.cjs like all other test invocations
    (CI=true already selects full streaming output). (4) In
    .github/workflows/publish.yml, add a `verify-min-node` job
    (checkout, setup-node with node-version "20", setup-bun,
    npm ci, npm run build, npm test) and make the `publish` job
    declare `needs: verify-min-node`.

    How: Keep fail-fast: false so a Node-20-only failure reports
    alongside Node 24 results. The "Verify CLI functionality"
    step currently gated on `matrix.shard == 1` should run once
    per node version (condition stays shard == 1, which now
    matches one shard per node version — that is the desired
    behavior).

    Testing: Concrete verification path that works in the normal
    task flow without a PR: (a) before pushing, validate both
    workflow files parse (e.g. a node one-liner loading each
    with the yaml package); (b) run `npm test` locally to
    confirm the runner-script invocation form works and no test
    assumes Node 24; (c) after pushing the task branch, trigger
    the updated workflow on that branch via
    `gh workflow run test.yml --ref <task-branch>` (enabled by
    the new workflow_dispatch trigger — the dispatched run uses
    the branch's workflow file) and watch it with
    `gh run watch`, confirming distinct Node 20 and Node 24
    matrix runs appear and pass; record the run URL in a task
    note as the ac-1 evidence. ac-2 (publish gating) is
    structural: the `needs: verify-min-node` edge plus the
    Node-20 job definition; verify publish.yml parses and the
    job graph is correct with `gh workflow view` after push.
    Workflow YAML is not unit-testable in vitest, so AC evidence
    lives in the recorded workflow runs rather than annotated
    tests.

    Covers: @prepublish-runtime-verification ac-1, ac-2.

- title: Add CONTRIBUTING.md and SECURITY.md
  slug: task-add-contributing-security-docs
  priority: 2
  tags: [docs, release]
  description: |
    Why: The repository has no CONTRIBUTING.md and no
    SECURITY.md. The package ships a daemon exposing a local
    HTTP API (default port 3456), so a documented vulnerability
    reporting path matters; and external contributors currently
    have to reverse-engineer the dev workflow from AGENTS.md,
    which is written for agents, not humans.

    What: (1) Create CONTRIBUTING.md covering: prerequisites
    (Node.js 20+, npm; Bun optional — only needed for the Bun
    daemon runtime and the standalone daemon binary
    `build:compile`, the default build uses esbuild), first-time
    setup (`node scripts/bootstrap.cjs`), build (`npm run
    build`), tests (`npm test`, `npm run test:shard1/2/3`,
    `npm run test:e2e`), lint/format (oxlint/oxfmt via `npm run
    lint` / `npm run format`), branch naming (feat/, fix/,
    refactor/, docs/ prefixes, kebab-case), conventional
    commits, and the workspace versioning policy: only the root
    @kynetic-ai/spec package is published; packages/web-ui,
    packages/shared, and packages/daemon are internal workspace
    packages whose 0.1.0 versions are not release-managed. (2)
    Create SECURITY.md stating: supported version (latest
    published release), how to report (GitHub private
    vulnerability reporting / security advisories on
    lepahc/kynetic-spec), expected response window, and a note
    that the daemon binds a local HTTP API so reports about
    network-reachable surfaces are in scope.

    How: Keep both files short and factual. Link CONTRIBUTING.md
    from README.md's Documentation section. Do not duplicate
    agent-specific policy from AGENTS.md — link to it instead.

    Testing: Verify all relative links in both new files
    resolve. Run npm run format:check. No unit tests required
    for prose-only files.

- title: Mark workspace packages private
  slug: task-workspace-packages-private
  priority: 3
  tags: [infra, release]
  depends_on:
    - "@task-add-license-file"
  description: |
    Why: packages/web-ui/package.json, packages/shared/package.json,
    and packages/daemon/package.json have no "private": true and
    are versioned 0.1.0 while the root package is 0.14.0. They
    are never intentionally published (the publish workflow only
    publishes the root package), but nothing prevents an
    accidental `npm publish --workspaces` or a future tooling
    change from pushing stale 0.1.0 packages under the
    @kynetic-ai scope. packages/web-ui also lacks main/exports,
    making its publishability ambiguous. Depends on
    @task-add-license-file because it extends the packaging test
    file that task creates.

    What: Add "private": true to all three workspace package
    manifests: packages/web-ui/package.json,
    packages/shared/package.json, packages/daemon/package.json.
    Leave their versions at 0.1.0 (the versioning policy —
    internal, not release-managed — is documented by
    @task-add-contributing-security-docs).

    How: One-line addition near the top of each manifest. Then
    confirm `npm pack --dry-run` output for the root package is
    unchanged (workspace sources are not part of the tarball)
    and `npm publish --workspaces --dry-run` refuses all three.

    Testing: Extend tests/release-packaging.test.ts (created by
    @task-add-license-file) with an assertion that each of the
    three workspace manifests has private === true — import each
    packages/*/package.json as a JSON module (import attributes)
    rather than fs-reading it, which keeps the test clean under
    the no-source-scanning lint rule. Run gates: npm run build
    (workspace resolution unchanged), npm test.

- title: Remove web-ui-only devDependencies duplicated at the root
  slug: task-dedupe-web-ui-devdeps
  priority: 3
  tags: [deps, infra]
  depends_on:
    - "@task-audit-fix-production-deps"
  description: |
    Why: Root package.json devDependencies declares packages
    used only by the web UI, all of which packages/web-ui/package.json
    already declares itself: @lucide/svelte, @tailwindcss/postcss,
    autoprefixer, clsx, postcss, tailwind-merge,
    tailwind-variants, tailwindcss. Verified unused in src/,
    tests/, and scripts/ (no imports, no root tailwind/postcss
    config files). The duplication bloats root installs and
    invites version skew between the two declarations. Depends
    on @task-audit-fix-production-deps because both tasks
    rewrite package.json/package-lock.json and must not race
    under parallel dispatch.

    What: Remove those eight entries from root package.json
    devDependencies. Do NOT remove pagefind — it is used by the
    root script scripts/build-docs-search.cjs (dynamic import at
    line 118). Do NOT touch packages/web-ui/package.json.

    How: Edit root package.json, then run `npm install` to
    regenerate package-lock.json. Because npm workspaces hoist,
    the packages remain installed at the root node_modules via
    the web-ui workspace declarations — but the hoisted layout
    can shift, so the full build is the safety gate.

    Testing: npm install, npm run build (must produce
    dist/web-ui/ — this exercises the tailwind/postcss pipeline),
    npm test, npm run test:e2e (renders the built UI). Confirm
    `git diff package-lock.json` shows only dedup/relocation,
    not version changes.
```

## Implementation Notes

- Findings intentionally excluded from this plan:
  - "INSTALL.md:3 references a README anchor that may not exist": false positive —
    INSTALL.md line 3 links plain README.md with no anchor. The actual dead anchor is
    README.md#how-it-works at line 102, which task-fix-install-doc-links covers.
  - Bun as an undocumented build requirement: false as stated. scripts/build-daemon.cjs
    bundles with esbuild; Bun is only needed for the optional standalone daemon binary
    (packages/daemon `build:compile`) and the Bun daemon runtime, which is already
    spec-covered (`@daemon-runtime-adapter`, `@web-ui` ac-2 error guidance). The optional
    nature is documented by the CONTRIBUTING.md task instead.
  - Workspace version drift (0.14.0 vs 0.1.0): not "fixed" by syncing versions — the
    policy (internal packages, not release-managed) is documented in CONTRIBUTING.md and
    enforced by `private: true`.
- The publish workflow already runs a full `npm run build` before publishing, so the
  prepack gap is primarily a local-publish hazard; the tarball verification step closes
  the remaining CI gap (a build that silently produces no dist/web-ui/), and the
  clean-pack verification proves the prepack path itself from a no-build-output state.
- Execution ordering is now encoded in depends_on rather than prose: license → {node-docs
  test, prepack/verification → CI matrix, workspace-private}, audit-fix → devdep-dedupe.
- Review fix-cycle 1 decisions (codex @01KTRYS2, claude @01KTRZ06):
  - Specs are parented under a new "Release and Distribution" module created in this
    plan instead of the @main placeholder. Derive requires every non-trait spec to have
    a parent, so the module itself nests under @main at derive time; if a top-level
    module is preferred it can be re-parented afterward via the CLI — accepted tradeoff.
  - The plan format does not carry relates_to; after derive, add
    @supported-runtime-range relates_to @docs-getting-started-section (its Installation
    page contract is one of the documents ac-2 quantifies over).
  - npm audit fix scope decision: the acceptance bar is production advisories only;
    semver-compatible dev-tree side-effect bumps from the same command are accepted,
    and unfixed dev-only advisories go to the inbox rather than expanding scope.
  - tests/release-packaging.test.ts has a single owner (task-add-license-file creates
    it); the two tasks extending it now depend on it. The two publish.yml edits are
    serialized via depends_on. package-lock.json writers are serialized via depends_on.
  - Testing sections route around the no-source-scanning lint rule explicitly:
    behavioral subprocess output (npm pack --dry-run --json, script exit codes) and
    JSON module imports where possible; where reading doc/license text is genuinely the
    contract (LICENSE text, markdown version statements), tasks direct the worker to
    the rule's sanctioned inline eslint-disable-with-reason escape hatch.
  - "Newest verified major version" was self-referential; the spec/AC now require the
    oldest supported major plus at least one newer major — deterministic and falsifiable
    (the task pins the concrete matrix to 20 and 24 at workflow-edit time).
  - CI workflow verification is now executable without a GitHub PR: the task adds a
    workflow_dispatch trigger and verifies via gh workflow run on the task branch.
  - CONTRIBUTING.md/SECURITY.md stay spec-less repo hygiene: they are contributor-facing
    repository meta-documents rather than product documentation surfaces; if a durable
    contract emerges (e.g. a committed response window), promote a requirement under
    @user-documentation then.
