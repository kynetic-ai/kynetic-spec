# Migrate from Biome to oxlint + oxfmt

## Specs

```yaml
[]
```

## Tasks

derive_from_specs: false

```yaml
- title: Install oxlint and oxfmt, remove Biome
  slug: task-install-oxlint-oxfmt
  description: |
    Replace @biomejs/biome with oxlint and oxfmt in package.json devDependencies.
    Remove biome.json. Create .oxlintrc.json with equivalent rule coverage and
    oxfmt config matching current Biome formatter settings (2-space indent, double
    quotes, import organization).

    Current Biome config uses recommended rules with no overrides. Map to oxlint's
    correctness + suspicious categories with eslint, typescript, unicorn, oxc, and
    import plugins enabled.
  priority: 1
  tags:
    - infra
    - tooling

- title: Configure oxlint vitest plugin for test files
  slug: task-oxlint-vitest-plugin
  description: |
    Add an overrides entry in .oxlintrc.json scoping the vitest plugin to test
    file globs (tests/**/*.ts, packages/*/tests/**/*.ts). Enable key rules:
    no-focused-tests (error), no-disabled-tests (warn), expect-expect (error),
    no-conditional-tests (warn), valid-expect (error).

    Evaluate the full vitest + jest rule sets against the existing test suite and
    enable additional rules that catch real issues without false positives.
  priority: 1
  tags:
    - infra
    - testing
  depends_on:
    - "@task-install-oxlint-oxfmt"

- title: Write custom no-source-scanning lint rule
  slug: task-custom-no-source-scanning-rule
  description: |
    Write an ESLint-compatible rule (runnable via oxlint JS Plugins Alpha) that
    errors when test files read source code and assert on string contents. The rule
    should detect:

    1. fs.readFileSync / fs.readFile calls where the path resolves to src/,
       templates/, packages/*/src/, or .svelte/.ts source files
    2. Variable indirection — tracking path variables through assignments and
       path.join/resolve calls (the evasion gap in the old lint test)
    3. String assertions on file contents — expect(content).toContain(),
       content.includes(), content.match() where content came from a file read

    The rule replaces tests/lint/no-static-analysis.test.ts which was itself a
    static analysis test with known evasion gaps. AST-level analysis is more
    robust than the regex approach.

    Register via jsPlugins in the test file overrides section of .oxlintrc.json.
  priority: 2
  tags:
    - infra
    - testing
  depends_on:
    - "@task-oxlint-vitest-plugin"

- title: Update npm scripts and CI workflow
  slug: task-update-scripts-ci
  description: |
    Update package.json scripts:
    - lint: oxlint src/ tests/ packages/
    - format: oxfmt .
    - format:check: oxfmt --check .

    Add lint and format check steps to .github/workflows/test.yml. Currently
    there is NO lint enforcement in CI — this is an opportunity to add it.
    Run lint on shard 1 alongside typecheck.
  priority: 2
  tags:
    - infra
    - ci
  depends_on:
    - "@task-install-oxlint-oxfmt"

- title: Run oxfmt on codebase and fix lint violations
  slug: task-format-and-fix-violations
  description: |
    Run oxfmt on the full codebase to reformat to the new formatter's output.
    Run oxlint and fix or suppress any new violations surfaced by the broader
    rule set. Commit the formatting change separately from any lint fixes for
    clean git history.
  priority: 3
  tags:
    - infra
    - cleanup
  depends_on:
    - "@task-install-oxlint-oxfmt"
    - "@task-update-scripts-ci"

- title: Delete no-static-analysis.test.ts
  slug: task-delete-static-analysis-lint-test
  description: |
    Delete tests/lint/no-static-analysis.test.ts. Its function is replaced by the
    custom no-source-scanning oxlint rule which provides AST-level detection
    without evasion gaps. The lint test was itself a static analysis test (reads
    test source files, asserts on string patterns).
  priority: 3
  tags:
    - testing
    - cleanup
  depends_on:
    - "@task-custom-no-source-scanning-rule"
```

## Implementation Notes

Migrating from Biome 2.3.11 to oxlint (stable, v1.56.0) + oxfmt (beta, v0.41.0).
Biome is a single tool for lint + format; this replaces it with two tools from the
same oxc project. Key motivations:

- oxlint ships 44 jest + 15 vitest rules for test quality linting
- JS Plugins Alpha enables a custom rule to catch source-scanning test anti-pattern
- Broader rule coverage (699 rules, 15 plugin namespaces vs Biome's curated set)
- Opportunity to add lint enforcement to CI (currently missing)
- oxfmt has built-in import sorting and 100% Prettier JS/TS conformance

No Biome-to-oxlint migration tool exists — rule mapping is manual but straightforward
since the project uses Biome's recommended rules with no custom overrides. Both tools
derive their rule sets from ESLint origins.

oxfmt beta is production-viable for JS/TS projects (used by Vue.js core, Turborepo,
Sentry). Known gaps in Vue SFC and YAML formatting don't affect this codebase.
