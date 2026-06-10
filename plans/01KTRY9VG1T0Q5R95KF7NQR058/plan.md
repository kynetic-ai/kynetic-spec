# Release Packaging and Onboarding Readiness

## Specs

```yaml
- title: Single Supported Runtime Version Range
  slug: supported-runtime-range
  type: requirement
  parent: "@main"
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
  parent: "@main"
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
  parent: "@main"
  description: |
    Automated verification exercises kspec across the supported
    Node.js runtime range rather than on a single version, so
    the declared engine constraint is backed by evidence. At
    minimum, the oldest supported major version and the newest
    verified major version are both exercised, and publication
    is gated on verification at the oldest supported major
    version.
  acceptance_criteria:
    - id: ac-1
      given: |
        The automated test pipeline runs for a proposed change
      when: |
        The pipeline's runtime coverage is examined
      then: |
        The test suite executes on the oldest supported Node.js
        major version and on the newest verified major version,
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
    tarball regardless of the files array.

    How: Use the canonical MIT text (https://opensource.org/license/mit).
    Verify inclusion with `npm pack --dry-run` and confirm
    LICENSE appears in the tarball file listing.

    Testing: Add a packaging test (e.g. tests/release-packaging.test.ts)
    that asserts LICENSE exists at the repo root, its first
    lines identify the MIT license, and package.json "license"
    is "MIT". Annotate with
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

    What: Run `npm audit fix` (NEVER `npm audit fix --force`),
    then verify `npm audit --omit=dev` reports 0
    vulnerabilities. Review the package-lock.json diff and
    confirm every bump is semver-compatible (patch/minor within
    the declared ranges). Direct root deps affected: yaml, ws,
    smol-toml (package.json dependencies). Transitive/web-ui
    tree: devalue, dompurify, file-type, svelte, undici.

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
  description: |
    Why: package.json "engines" requires node >=20.0.0, but
    INSTALL.md line 7 says "Node.js v18 or later" and
    docs/getting-started/tutorial.md line 17 says "Node.js 18+".
    Other docs already say 20+ (docs/getting-started/installation.md
    line 7, docs/guides/upgrading-kspec.md line 8,
    docs/guides/starting-a-new-project.md line 8). Users on Node
    18 following INSTALL.md will hit engine warnings or runtime
    failures.

    What: Update INSTALL.md:7 to "**Node.js** v20 or later" and
    docs/getting-started/tutorial.md:17 to "Node.js 20+". Sweep
    for any other stale mentions with:
    `grep -rn "18" README.md INSTALL.md docs/ | grep -i node`
    and fix any further hits.

    How: The engines value (>=20.0.0) is the source of truth —
    change docs to match it, do not change engines.

    Testing: Add a consistency test (e.g. in
    tests/release-packaging.test.ts) that reads the minimum
    major from package.json engines.node and asserts that
    INSTALL.md, docs/getting-started/installation.md, and
    docs/getting-started/tutorial.md state that same minimum
    wherever they state a Node.js version (reading docs files in
    tests is legitimate artifact verification, not source
    scanning). Annotate with
    `// AC: @supported-runtime-range ac-1` and
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
    tarball actually contains the built CLI and web UI.

    What: (1) Change "prepack" in package.json from
    "npm run build:plugin" to "npm run build" (the full build
    already ends with build:plugin, so plugin output is still
    produced). (2) Add scripts/verify-package.cjs that runs
    `npm pack --dry-run --json`, parses the file list, and fails
    unless it contains: LICENSE, dist/cli/index.js,
    dist/index.js, dist/web-ui/index.html, templates/skills/manifest.yaml,
    and at least one plugin/ entry. (3) Add a
    "verify-package": "node scripts/verify-package.cjs" npm
    script. (4) In .github/workflows/publish.yml, add a
    `npm run verify-package` step between "Build" and "Run
    tests" so a publish with missing dist/web-ui/ fails loudly.

    How: Do not assume `npm pack --dry-run` runs prepack — it
    does not in all npm versions. verify-package.cjs should
    check dist/ on disk AND parse the `npm pack --dry-run
    --json` listing; in CI it runs after the explicit build
    step. Keep verify-package.cjs dependency-free
    (node builtins only) like the other scripts/*.cjs files.

    Testing: Add tests asserting (a) package.json prepack equals
    "npm run build" and (b) running scripts/verify-package.cjs
    after a build exits 0, and exits non-zero when pointed at a
    tree missing dist/web-ui (use a temp dir via createTempDir()).
    Annotate with `// AC: @published-artifact-completeness ac-2`,
    `// AC: @published-artifact-completeness ac-3`, and
    `// AC: @published-artifact-completeness ac-4`.
    Run gates: npm run lint, npm run typecheck, npm test, and a
    real `npm run build && npm run verify-package` locally.

    Covers: @published-artifact-completeness ac-2, ac-3, ac-4.

- title: Add Node.js version matrix to CI and gate publish on minimum version
  slug: task-ci-node-version-matrix
  priority: 2
  tags: [ci, release, infra]
  spec_ref: "@prepublish-runtime-verification"
  description: |
    Why: package.json engines allows node >=20.0.0, but every CI
    job pins node-version "24" (.github/workflows/test.yml lines
    37, 71, 112; publish.yml line 30). Nothing ever runs the
    suite on Node 20, so the declared support floor is untested
    — a Node-24-only API could slip in unnoticed.

    What: (1) In .github/workflows/test.yml, extend the `test`
    job's strategy matrix to cross shard [1, 2, 3] with
    node-version ["20", "24"], and use
    `node-version: ${{ matrix.node-version }}` in the setup-node
    step; update the job `name` to include the node version.
    Leave the `lint` and `e2e` jobs on "24" (lint/format results
    are version-independent and e2e doubles CI cost for little
    signal). (2) In .github/workflows/publish.yml, add a
    `verify-min-node` job (checkout, setup-node with
    node-version "20", setup-bun, npm ci, npm run build, npm
    test) and make the `publish` job declare
    `needs: verify-min-node`.

    How: Keep fail-fast: false so a Node-20-only failure reports
    alongside Node 24 results. The "Verify CLI functionality"
    step currently gated on `matrix.shard == 1` should run once
    per node version (condition stays shard == 1, which now
    matches one shard per node version — that is the desired
    behavior).

    Testing: CI workflow changes are verified by the workflows
    themselves — open the change as task-branch work and confirm
    the matrix runs appear and pass on the PR/branch run. Before
    pushing, validate YAML syntax locally (e.g.
    `npx yaml-lint .github/workflows/test.yml` or a node
    one-liner parsing it with the yaml package). Run `npm test`
    locally to confirm no test assumes Node 24.

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
  description: |
    Why: packages/web-ui/package.json, packages/shared/package.json,
    and packages/daemon/package.json have no "private": true and
    are versioned 0.1.0 while the root package is 0.14.0. They
    are never intentionally published (the publish workflow only
    publishes the root package), but nothing prevents an
    accidental `npm publish --workspaces` or a future tooling
    change from pushing stale 0.1.0 packages under the
    @kynetic-ai scope. packages/web-ui also lacks main/exports,
    making its publishability ambiguous.

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

    Testing: Add an assertion to the packaging test (e.g.
    tests/release-packaging.test.ts) that each
    packages/*/package.json has private === true. Run gates:
    npm run build (workspace resolution unchanged), npm test.

- title: Remove web-ui-only devDependencies duplicated at the root
  slug: task-dedupe-web-ui-devdeps
  priority: 3
  tags: [deps, infra]
  description: |
    Why: Root package.json devDependencies declares packages
    used only by the web UI, all of which packages/web-ui/package.json
    already declares itself: @lucide/svelte, @tailwindcss/postcss,
    autoprefixer, clsx, postcss, tailwind-merge,
    tailwind-variants, tailwindcss. Verified unused in src/,
    tests/, and scripts/ (no imports, no root tailwind/postcss
    config files). The duplication bloats root installs and
    invites version skew between the two declarations.

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
  the remaining CI gap (a build that silently produces no dist/web-ui/).
- Suggested execution order: task-add-license-file → task-prepack-full-build-and-verification,
  task-audit-fix-production-deps early (security), docs tasks any time, hygiene tasks last.
