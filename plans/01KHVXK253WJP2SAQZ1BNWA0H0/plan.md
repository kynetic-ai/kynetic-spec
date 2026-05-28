# Project-Level Configuration System

## Context

kspec has no project-level config file. All runtime settings are resolved via env vars (`KSPEC_AUTHOR`), hardcoded constants (`SHADOW_BRANCH_NAME = "kspec-meta"`, `SHADOW_WORKTREE_DIR = ".kspec"`), or CLI flags that don't persist. Three consumer projects (kynetic-bot, imgen, comfy-ecaj-nodes) all rely on global env vars with no per-project configuration.

A `config:` block is written into every new manifest by `kspec init` but is completely dead code — not in the Zod schema, never consumed by any command.

The config file **must live in the project root on the main branch** (not in the manifest on the shadow branch) because it needs to control where the shadow branch lives — branch name, worktree directory, remote target, or even a completely separate git repository.

### Key architectural constraint

Config is loaded between `getGitRoot()` and `detectShadow()` in `initContext()`. The shadow branch detection currently uses hardcoded constants — after this change, it consults the resolved config. Precedence: `env var > CLI flag > kspec.config.yaml > defaults`.

### Critical files

- `src/parser/shadow.ts` — `SHADOW_BRANCH_NAME`, `SHADOW_WORKTREE_DIR`, `detectShadow()`, `initializeShadow()`, `hasRemoteTracking()`, `pushShadowBranch()`, `getShadowStatus()`, `repairShadow()`, `resolveShadowPath()`, `ensureGitignore()`, `detectRunningFromShadowWorktree()`
- `src/parser/yaml.ts` — `KspecContext`, `initContext()`, `getAuthor()`
- `src/schema/spec.ts` — `ManifestSchema` (has dead `config:` and unused `daemon:` fields)
- `src/cli/commands/init.ts` — creates shadow branch, writes manifest template with dead `config:` block
- `src/cli/commands/serve.ts` — hardcodes port `3456`, ignores `manifest.daemon.port`
- `src/cli/index.ts` — `maybeAutoStartDaemon()` reads `ctx.manifest?.daemon` (chicken-and-egg)
- `src/parser/validate.ts` — accepts options from CLI only, never reads manifest config

### Follow-up work (out of scope for this plan)

- `kspec config get/set` CLI subcommand for programmatic config editing
- `kspec init` generating a template `kspec.config.yaml` with commented-out options
- Config display in `kspec setup --status`
- Config inheritance (user-level `~/.kspec/config.yaml` defaults)

## Specs

```yaml
- title: Project Config File
  slug: project-config
  type: feature
  description: |
    A kspec.config.yaml file in the project root (main branch) that provides
    project-level configuration for shadow branch setup, identity, validation,
    and daemon settings. Loaded before shadow branch detection. All fields
    optional with backward-compatible defaults.
  acceptance_criteria:
    - id: ac-1
      given: a project with no kspec.config.yaml
      when: kspec commands are run
      then: all settings resolve to current defaults with no behavior change
    - id: ac-2
      given: a kspec.config.yaml exists in the project root
      when: initContext() is called
      then: config is parsed, validated, and available on KspecContext.config before shadow detection
    - id: ac-3
      given: a kspec.config.yaml with invalid YAML syntax
      when: config is loaded
      then: parsing falls back to defaults and emits a warning to stderr with the parse error
    - id: ac-4
      given: a kspec.config.yaml with unknown fields
      when: config is loaded
      then: unknown fields are ignored and valid fields are applied normally
    - id: ac-5
      given: an env var override exists (e.g. KSPEC_AUTHOR)
      when: config is resolved
      then: env var takes precedence over the config file value
    - id: ac-6
      given: kspec is invoked from a subdirectory of the project
      when: initContext() resolves config
      then: config is loaded from the git root, not the current working directory
    - id: ac-7
      given: KSPEC_SPEC_DIR env var is set (batch atomic mode)
      when: initContext() runs
      then: config is still loaded from the real project root, not the temp spec dir
  traits:
    - trait-error-guidance
  implementation_notes: |
    New file src/parser/config.ts with KspecConfigSchema (Zod), ResolvedKspecConfig type,
    and loadProjectConfig(gitRoot) function. Config.ts is a leaf module with no imports
    from yaml.ts or shadow.ts (circular dependency avoidance). Use fs.readFile + yaml
    library directly, or extract readYamlFile into src/parser/yaml-utils.ts.

    Central resolver function resolveConfig(fileConfig, envOverrides, cliOverrides) with
    typed ResolvedKspecConfig output. All commands call this once via ctx.config rather
    than doing ad-hoc resolution.

    For ac-7 (batch mode), loadProjectConfig must resolve gitRoot independently of
    KSPEC_SPEC_DIR. The batch executor in batch-exec.ts should pass the real project
    root to config loading before redirecting spec dir.

- title: Configurable Shadow Branch
  slug: config-shadow
  type: feature
  parent: "@project-config"
  description: |
    Shadow branch name, worktree directory, and remote target are configurable
    via kspec.config.yaml instead of hardcoded constants. The remote can be any
    eligible git target — the current repo's remote name, a different remote name,
    a local directory path to a bare repo, or a remote git server URL. This enables
    multi-project machines with distinct branch names, and spec storage in separate
    repositories.
  acceptance_criteria:
    - id: ac-1
      given: |
        kspec.config.yaml sets shadow.branch to a custom name
      when: kspec init is run
      then: the orphan branch is created with the configured name instead of kspec-meta
    - id: ac-2
      given: |
        kspec.config.yaml sets shadow.directory to a custom path
      when: kspec init is run
      then: the worktree is created at the configured directory and .gitignore is updated accordingly
    - id: ac-3
      given: |
        shadow.remote is set to a named remote (e.g. specs-origin)
      when: remote tracking is configured
      then: push/pull operations use the named remote instead of origin
    - id: ac-4
      given: |
        shadow.remote is set to a local filesystem path (starts with / or ./ or ~)
      when: remote tracking is configured
      then: a git remote is added using the local path as target
    - id: ac-5
      given: |
        shadow.remote is set to a git URL (contains :// or starts with git@)
      when: remote tracking is configured
      then: a git remote is added using the URL as target
    - id: ac-6
      given: |
        shadow.remote references a named remote that does not exist
      when: push or pull is attempted
      then: an error is reported with guidance to add the remote or fix the config
    - id: ac-7
      given: existing shadow branch functions (detectShadow, hasRemoteTracking, pushShadowBranch, etc.)
      when: called without config parameter
      then: they fall back to current constants (backward compat for direct callers)
    - id: ac-8
      given: |
        shadow.directory is set to a custom name (not .kspec)
      when: detectRunningFromShadowWorktree() is called
      then: it correctly detects the custom worktree directory using git worktree metadata
    - id: ac-9
      given: |
        a shadow branch already exists with default settings (kspec-meta, .kspec)
      when: config is changed to different shadow.branch or shadow.directory
      then: kspec reports the mismatch and guides the user to migrate or repair
  traits:
    - trait-error-guidance
  implementation_notes: |
    Thread config through shadow.ts functions via optional parameters that default to
    SHADOW_BRANCH_NAME / SHADOW_WORKTREE_DIR constants. ShadowConfig already carries
    branchName — extend it.

    Key functions needing config threading: detectShadow(), initializeShadow(),
    hasRemoteTracking(), ensureRemoteTracking(), pushShadowBranch(), shadowPull(),
    shadowSync(), ensureGitignore(), getShadowStatus(), repairShadow(),
    resolveShadowPath().

    Remote type detection algorithm for shadow.remote:
    - Starts with /, ./, or ~ -> local filesystem path
    - Contains :// or starts with git@ -> git URL
    - Otherwise -> git remote name
    For path/URL types, git remote add with configured value. For remote name,
    verify it exists before push/pull. Authentication for URLs delegated to git
    credential helpers — do not store tokens in config. Add guidance in error
    messages recommending remote names over inline URLs with credentials.

    For ac-8, detectRunningFromShadowWorktree() currently checks cwdBase === ".kspec".
    Two options: (1) read config first with a lightweight non-throwing load, or
    (2) make detection generic by checking if cwd is ANY git worktree via the .git
    file being a worktree pointer, regardless of directory name. Option 2 preferred.

    For ac-9, kspec shadow status should compare detected branch/directory against
    config and warn on mismatch rather than silently using stale settings.

- title: Configurable Author Identity
  slug: config-author
  type: feature
  parent: "@project-config"
  description: |
    Project-level default author via kspec.config.yaml author field. Sits between
    env var (highest priority) and git/OS user fallbacks (lowest).
  acceptance_criteria:
    - id: ac-1
      given: |
        kspec.config.yaml sets author to a value like @bot-agent
      when: a note or inbox item is created without KSPEC_AUTHOR env var set
      then: the author is recorded as the configured value
    - id: ac-2
      given: both KSPEC_AUTHOR env var and config author are set
      when: a note is created
      then: the env var value wins
    - id: ac-3
      given: no config author and no KSPEC_AUTHOR env var
      when: a note is created
      then: author falls back to git user.name then OS user (current behavior)
  implementation_notes: |
    Modify getAuthor() in src/parser/yaml.ts to accept optional config parameter.
    Insert config.author check between env var and git fallback. Command handlers
    that have ctx available pass ctx.config to getAuthor(). Consider a central
    getResolvedAuthor(ctx) helper that wraps getAuthor(ctx.config) to avoid
    inconsistent call sites.

- title: Configurable Validation Defaults
  slug: config-validation
  type: feature
  parent: "@project-config"
  description: |
    Validation strictness settings (strict_refs, require_acceptance) configurable
    in kspec.config.yaml. CLI flags override config values. Replaces the dead
    config block that init currently writes into manifests.
  acceptance_criteria:
    - id: ac-1
      given: |
        kspec.config.yaml sets validation.require_acceptance to true
      when: kspec validate is run without CLI flags
      then: specs missing acceptance criteria are reported as errors not warnings
    - id: ac-2
      given: |
        kspec.config.yaml sets validation.strict_refs to true
      when: kspec validate is run without --strict flag
      then: dangling references are treated as errors
    - id: ac-3
      given: |
        kspec.config.yaml sets validation.strict_refs to false
      when: kspec validate is run without --strict flag
      then: dangling references are reported as warnings not errors
    - id: ac-4
      given: CLI flag --strict is passed
      when: |
        config has validation.strict_refs set to false
      then: CLI flag wins and dangling refs are treated as errors
  traits:
    - trait-error-guidance
  implementation_notes: |
    Wire ctx.config.validation into ValidateOptions in src/parser/validate.ts.
    The validate command handler in src/cli/commands/validate.ts merges CLI flags
    over config values before calling validate(). Current ValidateOptions has boolean
    toggles — map strict_refs to the existing strictness behavior and add
    require_acceptance as a new check that promotes completeness warnings to errors.

- title: Configurable Daemon Settings
  slug: config-daemon
  type: feature
  parent: "@project-config"
  description: |
    Daemon port and auto-start configurable in kspec.config.yaml. Replaces the
    manifest daemon block (which exists in the schema but is never read by
    serve start). Resolves the chicken-and-egg problem where daemon config was
    inside the shadow branch.
  acceptance_criteria:
    - id: ac-1
      given: |
        kspec.config.yaml sets daemon.port to 4000
      when: kspec serve start is run without --port flag
      then: daemon starts on port 4000
    - id: ac-2
      given: --port 5000 CLI flag is passed
      when: |
        config sets daemon.port to 4000
      then: daemon starts on port 5000 (CLI flag wins)
    - id: ac-3
      given: |
        kspec.config.yaml sets daemon.auto_start to false
      when: a kspec command triggers maybeAutoStartDaemon()
      then: the daemon is not auto-started
    - id: ac-4
      given: an existing manifest has a daemon block with port set
      when: kspec commands are run
      then: |
        the manifest daemon block is ignored and a deprecation warning is emitted
        recommending migration to kspec.config.yaml
  traits:
    - trait-error-guidance
  implementation_notes: |
    Update maybeAutoStartDaemon() in src/cli/index.ts to read ctx.config.daemon
    instead of ctx.manifest?.daemon. Update serve.ts to remove hardcoded '3456'
    default — use ctx.config.daemon.port with CLI flag override. Add deprecation
    comment to ManifestSchema daemon field. New manifests should no longer include
    daemon block. E2E test infrastructure (port 3456 in packages/web-ui/tests/e2e/)
    manages its own daemon and must NOT be changed.

- title: Clean Up Dead Manifest Config
  slug: config-manifest-cleanup
  type: requirement
  parent: "@project-config"
  description: |
    Remove the dead config block from generated manifests and handle the existing
    daemon field in ManifestSchema now that config lives in kspec.config.yaml.
  acceptance_criteria:
    - id: ac-1
      given: kspec init is run on a new project
      when: the manifest is generated
      then: no config block is written to the manifest YAML
    - id: ac-2
      given: an existing manifest contains a config block
      when: the manifest is parsed
      then: parsing succeeds without errors via explicit optional field in schema
    - id: ac-3
      given: kspec init is run on a new project
      when: the manifest is generated
      then: no daemon block is written to the manifest
    - id: ac-4
      given: an existing manifest contains a daemon block
      when: the manifest is parsed
      then: parsing succeeds and a debug-level deprecation note is logged
  implementation_notes: |
    Update generateManifest() in init.ts and generateShadowManifest() in shadow.ts
    to remove the config template. Keep daemon in ManifestSchema as explicit optional
    field with deprecation comment (do NOT use .passthrough() as it weakens validation).
    Add config as z.any().optional() to ManifestSchema for backward compat with
    existing manifests that have it. Neither field should be consumed at runtime —
    all config reads go through ctx.config (from kspec.config.yaml).
```

## Tasks

derive_from_specs: true

## Implementation Notes

The config system is loaded in `initContext()` between `getGitRoot()` and `detectShadow()`. The `KspecContext` interface gains a `config: ResolvedKspecConfig` field that all commands can access via `ctx.config`.

Circular dependency avoidance is critical: `config.ts` is a leaf module — it must not import from `yaml.ts` (which imports `shadow.ts`) or `shadow.ts`. Enforce this boundary with an import graph test or lint rule.

Shadow functions gain optional config parameters that default to current constants — this preserves backward compat for any direct callers while enabling config-driven behavior through the standard `initContext()` path. There are 10+ functions in shadow.ts that hardcode the constants — all must be threaded.

The shadow remote configuration is the most architecturally significant piece. `shadow.remote` can be a remote name ("origin", "specs-origin"), a local filesystem path ("/path/to/bare/repo"), or a full git URL ("git@github.com:org/specs.git"). Detection algorithm: starts with `/`, `./`, or `~` = path; contains `://` or starts with `git@` = URL; otherwise = remote name. Authentication for URLs is delegated to git credential helpers — config should not contain tokens. Error messages should recommend remote names over inline URLs.
