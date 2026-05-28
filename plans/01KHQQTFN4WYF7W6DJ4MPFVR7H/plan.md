# Skill System Portability

Consolidate, fix, and clean up the skill rendering, setup pipeline, and
cross-platform support so kspec can be installed portably on new projects.
Derived from triage of 25+ skills-related inbox items.

## Priority

P2

## Implementation Notes

Work these in order: Bundle 2 (dead code) first since it reduces noise for
everything else. Bundle 1 (setup unification) is the highest impact.
Bundle 3 (cross-platform) makes things reliable. Bundle 6 (bootstrapping)
improves the new-project experience. Bundle 4 (module split) is
maintainability. Bundle 5 (polish) is nice-to-have.

Inbox items consolidated into these bundles:
01KHJ4RV (dead code x3, legacy render, agent gen reimpl, silent errors, toKebabCase),
01KHG6EP (setup.ts duplicated step logic), 01KHG6EX (renderSkill dup - ALREADY FIXED),
01KHKTNJ (monolith, renderer dedup, CRLF, version, setup status, normalizeBaseDir,
guard scripts, diff, readFileSync, mutation safety, EXPECTED_TEMPLATES, naming,
redundant defaults, warning types), 01KHKTNH (type guard), 01KHKTNT (lookup dedup,
weak test), 01KHFCDS (permission bootstrap, memory seeding, version pinning),
01KGQY6N (skill staleness).

## Specs

```yaml
- title: Dead Code and Deduplication Sweep
  type: feature
  description: >
    Remove dead code and deduplicate utilities across skill.ts, skill-render.ts,
    and agents.ts. Clears noise before larger refactors.
  priority: 2
  acceptance_criteria:
    - id: ac-1
      given: the codebase
      when: building the project
      then: SkillRenderResult, SkillStatusResult types, and getSkillSyncStatus function are removed from skill.ts
    - id: ac-2
      given: skill-render.ts
      when: reviewing dead code
      then: toKebabCase function is removed (zero callers)
    - id: ac-3
      given: agents.ts
      when: reviewing dead code
      then: EXPECTED_TEMPLATES constant is removed (never referenced)
    - id: ac-4
      given: skill.ts needs contentsEqual, directoriesEqual, or copyDirectory
      when: these functions are called
      then: they are imported from skill-render.ts, not duplicated locally
    - id: ac-5
      given: the skill CLI add/set commands
      when: constructing input before schema parse
      then: redundant manual defaults for platform, tags, and depends_on are removed (schema provides them)
  implementation_notes: >
    Low risk, mostly deletion. Run full test suite after each removal to catch
    any hidden callers. The isKspecManagedSkill vs isKspecManaged alias is fine
    as-is (single function, import alias) - no action needed.

- title: Setup Pipeline Unification
  type: feature
  description: >
    Unify the setup command to use the same code paths as the rest of the CLI
    instead of reimplementing agent instruction generation and skill rendering.
    Highest impact for portable install - new projects currently get output from
    divergent code paths.
  priority: 2
  acceptance_criteria:
    - id: ac-1
      given: setup.ts needs to generate agent instructions
      when: the setup pipeline runs
      then: it calls the exported generateAgentsContent() from agents.ts (not a local reimplementation)
    - id: ac-2
      given: setup.ts needs to render skills
      when: the setup pipeline renders skills for any platform
      then: it uses the platform renderer registry (getRenderer/getAllRenderers) not the legacy renderClaudeCodeSkill
    - id: ac-3
      given: the setup command is invoked
      when: the command handler executes
      then: it delegates to runSetupPipeline() - there is one code path, not two parallel implementations
    - id: ac-4
      given: any setup step throws an error
      when: a catch block handles it
      then: the error is logged at debug level (not silently swallowed with bare catch {})
    - id: ac-5
      given: a new project runs kspec init --setup
      when: setup completes
      then: the output is identical to running kspec setup separately (same code path)
  implementation_notes: >
    Step 1 - Export generateAgentsContent() from agents.ts.
    Step 2 - Replace generateAgentInstructions() in setup.ts with a call to it.
    Step 3 - Replace renderClaudeCodeSkill import with platform registry.
    Step 4 - Merge runSetupPipeline() into the command handler (or vice versa).
    Step 5 - Add debug logging to catch blocks (use existing debug util).
    Currently setup.ts is 1812 lines with 18 bare catch blocks.
    Depends on dead-code-dedup-sweep being done first.

- title: Cross-Platform and Version Robustness
  type: feature
  description: >
    Fix cross-platform parsing issues and version detection reliability
    so kspec works correctly on Windows and reliably detects when updates
    are needed.
  priority: 2
  acceptance_criteria:
    - id: ac-1
      given: a SKILL.md file with CRLF line endings
      when: parseFrontmatter is called (in validate-skills.ts or skill.ts)
      then: frontmatter is correctly parsed (handles both LF and CRLF)
    - id: ac-2
      given: a SKILL.md file with CRLF line endings
      when: stripFrontmatter is called
      then: frontmatter is correctly stripped
    - id: ac-3
      given: getKspecPackageVersion cannot resolve the package version
      when: skill install or update runs
      then: the version is reported as null or an error, not silently treated as a valid version string
    - id: ac-4
      given: kspec-agents.md exists with a hash file
      when: kspec setup --status is run after skills or templates changed
      then: agents.md status is reported as stale (content hash comparison, not just hash file existence)
    - id: ac-5
      given: a skill file with a base directory line
      when: normalizeBaseDirectory is called
      then: the line is matched case-insensitively and with common wording variations
  implementation_notes: >
    CRLF fix uses \r?\n in regexes and indexOf patterns.
    Version fix - return null instead of unknown, callers must handle.
    Staleness - compute hash of generated content, compare to stored hash.
    normalizeBaseDir - case-insensitive regex, flexible wording.
    Depends on dead-code-dedup-sweep being done first.

- title: New Project Bootstrapping
  type: feature
  description: >
    Improve the experience of installing kspec on a new project by seeding
    agent configuration with useful starting context and handling platform
    drift detection comprehensively.
  priority: 3
  acceptance_criteria:
    - id: ac-1
      given: kspec setup runs in a new project with Claude Code
      when: setup completes
      then: a permissions template or seed for common kspec operations is offered to the user
    - id: ac-2
      given: kspec setup runs in a new project
      when: setup completes
      then: MEMORY.md is seeded with project-relevant starting notes (project name, key paths, conventions)
    - id: ac-3
      given: a codex skill has platform_config.codex with custom settings
      when: checkPlatformSkillDrift runs for codex
      then: the sidecar YAML file (agents/openai.yaml) content is included in the drift hash
    - id: ac-4
      given: a rendered skill file has been manually edited
      when: kspec skill verify runs
      then: it reports which skills have drifted from their source with actionable guidance
  implementation_notes: >
    Permission bootstrapping - could be a template file in templates/ that
    kspec setup copies to .claude/settings.local.json if not present.
    Memory seeding - generate from project context (name, modules, active tasks).
    Codex sidecar drift - include sidecar in hash computation.
    Skill verify - new command, compare rendered output to expected.
    Depends on setup-pipeline-unification and cross-platform-version-robustness.

- title: Skill Module Split
  type: feature
  description: >
    Split the 2365-line skill.ts monolith into focused modules and extract
    shared renderer logic to reduce duplication between platform renderers.
  priority: 3
  acceptance_criteria:
    - id: ac-1
      given: the skill command implementation
      when: reviewing the file structure
      then: skill.ts is split into focused modules (skill-crud.ts, skill-install.ts, skill-diff.ts or similar)
    - id: ac-2
      given: the Claude Code and Codex renderers
      when: reviewing skill-render.ts
      then: shared render logic (content loading, hash check, idempotency, file write) is extracted into a base function
    - id: ac-3
      given: external code importing from skill.ts
      when: building the project
      then: re-exports maintain backward API compatibility
  implementation_notes: >
    Do this AFTER setup unification so there is only one consumer pattern to
    migrate. The renderer base extraction is the higher-value part - adding
    new platforms (Cursor, Gemini, etc.) currently requires copying 70% of
    an existing renderer. Depends on setup-pipeline-unification.

- title: Guard Script and Diff Quality
  type: feature
  description: >
    Improve guard script matching robustness and replace the hand-rolled
    unified diff with a proper implementation.
  priority: 3
  acceptance_criteria:
    - id: ac-1
      given: a command like echo "git reset" or grep "git stash" README.md
      when: the worktree guard script evaluates it
      then: it is NOT blocked (guard checks command position or word boundaries, not substring)
    - id: ac-2
      given: two files where one has a single line inserted
      when: generateUnifiedDiff compares them
      then: the diff shows only the insertion, not a cascade of all subsequent lines as changed
    - id: ac-3
      given: async skill operations
      when: loading package version, manifest, or skill content
      then: async fs.readFile is used instead of readFileSync
    - id: ac-4
      given: a skill update operation
      when: the update is about to save
      then: a copy of the skill object is mutated, not the loaded original (safe against partial save failure)
  implementation_notes: >
    Guard scripts - check that the dangerous command is at command position
    (start of line or after pipe/semicolon), not embedded in strings.
    Diff - add diff npm package, replace generateUnifiedDiff.
    readFileSync - convert 3 helpers to async, update callers.
    Mutation safety - structuredClone before modification.
    Depends on skill-module-split.
```
