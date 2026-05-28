# Multi-Platform Skill Rendering with Agent Skills Compatibility

Kspec has a complete skill management pipeline (import, render, drift detection, CLI) but it's currently single-platform (Claude Code only), emits minimal frontmatter (name + description), and doesn't manage the 17 existing hand-authored skills. The Agent Skills spec (agentskills.io) is an emerging open standard adopted by Claude Code, OpenAI Codex, and OpenCode. This plan extends kspec to render skills for multiple platforms through a single management pipeline.

## Architecture Decisions

| Decision | Choice |
|----------|--------|
| Schema model | **Dual-layer**: SKILL.md = content only. Meta.yaml = all metadata. Renderers merge both. |
| Source SKILL.md | **Body-only** (no frontmatter). Frontmatter is render-time output. |
| Field ownership | **Meta.yaml canonical**, mirrored to rendered frontmatter. |
| Platform fields | **Nested `platform_config`** object: `platform_config.claude_code: {...}`, `platform_config.codex: {...}` |
| Platform coupling | **Decoupled**: `platforms` array declares render targets. `platform_config` optional. |
| Output directories | **Configurable with defaults**: Claude Code `.claude/skills/`, Codex `.agents/skills/` |
| Renderer contract | **Kspec trait** (`@platform-renderer`) + TypeScript interface |
| Supporting files | **Agent Skills convention**: `references/`, `scripts/`, `assets/` (with `docs/` backward compat) |
| Initial platforms | **Claude Code + Codex** |

### Field Split

**Portable (meta.yaml → rendered frontmatter):** name, description, license, compatibility, allowed_tools, metadata

**Kspec-only (meta.yaml, NOT rendered):** _ulid, origin, version, platforms, depends_on, tags

**Platform-specific (meta.yaml `platform_config.<platform>` → rendered per-platform):**
- Claude Code: disable_model_invocation, user_invocable, context, agent, model, argument_hint
- Codex: allow_implicit_invocation, display_name, short_description (rendered to `agents/openai.yaml` sidecar, NOT frontmatter)

**Import command:** `kspec plan import ./plan.md --module @meta`

**Note:** All `parent:` refs point to specs under `@meta` module (modules/meta.yaml). The trait goes at root level.

## Specs

```yaml
- title: Consolidate Skill Render Implementations
  slug: consolidate-skill-render
  type: requirement
  parent: skill-rendering
  description: |
    There are currently TWO independent render implementations: renderClaudeCodeSkill()
    in src/parser/skill-render.ts (used by setup.ts) and a private renderSkill() in
    src/cli/commands/skill.ts (lines ~1835-1961, used by the CLI). Hash/drift logic also
    lives entirely in skill.ts. These must be consolidated into a single implementation
    in skill-render.ts before extending for multi-platform support. The CLI must import
    and delegate to skill-render.ts rather than maintaining its own copy.
  acceptance_criteria:
    - id: ac-1
      given: the kspec skill render CLI command
      when: it renders a skill
      then: it delegates to renderClaudeCodeSkill() from src/parser/skill-render.ts (not a private copy)
    - id: ac-2
      given: src/cli/commands/skill.ts
      when: inspected for render logic
      then: there is no private renderSkill() function duplicating skill-render.ts
    - id: ac-3
      given: hash/drift functions (getRenderHashPath, readRenderHash, writeRenderHash, checkSkillDrift)
      when: inspected
      then: they are exported from src/parser/skill-render.ts and imported by skill.ts
    - id: ac-4
      given: src/cli/commands/setup.ts
      when: it renders skills
      then: it still works correctly using the consolidated renderClaudeCodeSkill()
    - id: ac-5
      given: all existing skill rendering tests
      when: run after consolidation
      then: they pass without modification
  implementation_notes: |
    This is a PREREQUISITE for all other renderer work. Must be done first.

    File: src/cli/commands/skill.ts
    1. Find private renderSkill() (~lines 1835-1961) and remove it
    2. Find hash functions (~lines 1717-1779): getRenderHashPath, readRenderHash,
       writeRenderHash, checkSkillDrift — move to src/parser/skill-render.ts
    3. Update render command (~lines 716-952) to import and use renderClaudeCodeSkill
    4. Update all drift/hash callers to use imported functions

    File: src/parser/skill-render.ts
    1. Add exports for hash/drift functions
    2. Ensure renderClaudeCodeSkill handles all cases the CLI's private renderSkill did

    File: src/cli/commands/setup.ts
    1. Verify it still imports from skill-render.ts correctly (should be unchanged)

    Tests: npm test -- tests/skill-rendering.test.ts tests/skill-cli.test.ts --run

- title: Platform Renderer Contract
  slug: platform-renderer-trait
  type: trait
  description: |
    Defines the contract all platform-specific skill renderers must implement.
    Each renderer writes platform-specific output (SKILL.md with frontmatter,
    sidecar config files, supporting directories) to a configurable output directory.
    Renderers support dry-run mode, drift detection via per-platform hashes, and
    idempotent output (no file modification when content unchanged).
  acceptance_criteria:
    - id: ac-1
      given: a renderer implementation for platform X
      when: render is called with a skill and project context
      then: platform-specific output files are written to the configured output directory
    - id: ac-2
      given: a renderer
      when: render completes
      then: a PlatformRenderResult is returned with id, platform, action (created/updated/unchanged/skipped), and output paths
    - id: ac-3
      given: a skill with supporting directories (references/, scripts/, assets/)
      when: rendered for any platform
      then: supporting directories are copied to the platform output directory
    - id: ac-4
      given: dryRun option is true
      when: render is called
      then: no files are written to disk and result action reflects what would happen
    - id: ac-5
      given: a custom outputDir is provided
      when: render is called
      then: output goes to the custom path instead of the platform default
    - id: ac-6
      given: a render completes successfully
      when: the hash is stored
      then: a per-platform render hash is written to .kspec/skills/<id>/.render-hash-<platform>
  implementation_notes: |
    This trait defines the contract — it does NOT contain implementation code.
    The TypeScript interface lives in src/parser/skill-render.ts:

    interface PlatformRenderer {
      platform: string;              // e.g. "claude-code", "codex"
      defaultOutputDir: string;      // e.g. ".claude/skills", ".agents/skills"
      render(ctx, projectRoot, skill, options): Promise<PlatformRenderResult>;
      checkDrift(specDir, projectRoot, skillId, options): Promise<DriftStatus>;
    }

    interface PlatformRenderResult {
      id: string;
      platform: string;
      action: "created" | "updated" | "unchanged" | "skipped";
      paths: string[];
      supportingDirsAction?: Record<string, "created" | "updated" | "unchanged" | "skipped">;
      skipReason?: string;
    }

    type DriftStatus = "not-rendered" | "in-sync" | "drifted" | "no-hash";

    Renderer registry: Record<string, PlatformRenderer> with getRenderer(platform) and getAllRenderers().

    Depends on @consolidate-skill-render being done first so there's a single render module.

- title: Extended Skill Schema
  slug: extended-skill-schema
  type: requirement
  parent: skill-schema
  description: |
    Extends the SkillSchema in src/schema/meta.ts with portable Agent Skills fields
    (license, compatibility, allowed_tools, metadata) and a nested platform_config
    object for platform-specific settings. All new fields are optional for backward
    compatibility. Platform config uses strict validation per known platform but
    passthrough for unknown platforms to support future extensibility.
  acceptance_criteria:
    - id: ac-1
      given: a skill entry in meta.yaml with license, compatibility, or allowed_tools
      when: schema validation runs
      then: the fields are accepted as valid optional strings/arrays
    - id: ac-2
      given: a skill with platform_config.claude_code containing valid fields
      when: schema validation runs
      then: nested config validates against ClaudeCodeConfigSchema
    - id: ac-3
      given: a skill with platform_config.codex containing valid fields
      when: schema validation runs
      then: nested config validates against CodexConfigSchema
    - id: ac-4
      given: a skill with platform_config containing an unknown platform key
      when: schema validation runs
      then: validation passes (passthrough for future platforms)
    - id: ac-5
      given: a skill with invalid nested fields in a known platform config
      when: schema validation runs
      then: validation fails with a descriptive error (strict mode per known platform)
    - id: ac-6
      given: a skill entry with no new fields (existing format)
      when: schema validation runs
      then: validation passes (full backward compatibility)
    - id: ac-7
      given: a skill with metadata as a Record of key-value pairs
      when: schema validation runs
      then: the metadata field is accepted as a valid optional record
  implementation_notes: |
    File: src/schema/meta.ts

    Add after existing SkillSchema fields (line ~182):
    - license: z.string().optional()
    - compatibility: z.string().optional()
    - allowed_tools: z.array(z.string()).default([])
    - metadata: z.record(z.string(), z.unknown()).optional()
    - platform_config: PlatformConfigSchema.optional()

    Define new schemas:
    - ClaudeCodeConfigSchema: z.object({ disable_model_invocation, user_invocable, context, agent, model, argument_hint }).strict()
    - CodexConfigSchema: z.object({ allow_implicit_invocation, display_name, short_description, icon_small, icon_large, brand_color, default_prompt }).strict()
    - PlatformConfigSchema: z.object({ claude_code: ..., codex: ... }).passthrough()

    All fields optional booleans/strings. Export types.
    Tests: tests/skill-schema.test.ts

- title: Claude Code Renderer - Extended Frontmatter
  slug: claude-code-renderer-extended
  type: requirement
  parent: claude-code-renderer
  description: |
    Extends the Claude Code renderer to emit portable Agent Skills fields and
    platform-specific fields from platform_config.claude_code in the YAML frontmatter.
    Refactors renderClaudeCodeSkill to implement the PlatformRenderer interface.
    Hash files change from .render-hash to .render-hash-claude-code with fallback
    migration from the old format.
  traits:
    - platform-renderer-trait
  acceptance_criteria:
    - id: ac-1
      given: a skill with license and allowed_tools in meta.yaml
      when: rendered for Claude Code
      then: YAML frontmatter includes license and allowed-tools fields
    - id: ac-2
      given: a skill with platform_config.claude_code.user_invocable set to false
      when: rendered for Claude Code
      then: "frontmatter includes user-invocable: false"
    - id: ac-3
      given: a skill with platform_config.claude_code.context set to fork
      when: rendered for Claude Code
      then: "frontmatter includes context: fork and agent field if present"
    - id: ac-4
      given: a skill with platform_config.claude_code.disable_model_invocation set to true
      when: rendered for Claude Code
      then: "frontmatter includes disable-model-invocation: true"
    - id: ac-5
      given: a skill with no platform_config.claude_code
      when: rendered for Claude Code
      then: only portable fields (name, description, license, etc.) appear in frontmatter
    - id: ac-6
      given: a skill previously rendered with old .render-hash file
      when: drift check runs for claude-code platform
      then: the old .render-hash is read as fallback and migrated to .render-hash-claude-code
    - id: ac-7
      given: a skill with references/, scripts/, or assets/ directories
      when: rendered for Claude Code
      then: all supporting directories are copied to .claude/skills/<id>/
    - id: ac-8
      given: a skill with platform_config.claude_code fields using snake_case (e.g. disable_model_invocation)
      when: rendered for Claude Code
      then: frontmatter keys are converted to kebab-case (e.g. disable-model-invocation)
  implementation_notes: |
    File: src/parser/skill-render.ts

    CRITICAL: Before this work, complete @consolidate-skill-render first. The CLI
    currently has a DUPLICATE private renderSkill() in skill.ts that does NOT use
    skill-render.ts. After consolidation, all render logic lives here.

    1. Define PlatformRenderer interface (platform, defaultOutputDir, render, checkDrift methods)
    2. Define PlatformRenderResult type (extends current ClaudeCodeRenderResult with platform field)
    3. Refactor generateFrontmatter(skill) to:
       - Always include name, description
       - Include portable fields if present: license, compatibility, allowed-tools
       - Include Claude Code platform fields from skill.platform_config?.claude_code
       - Use kebab-case for Claude Code frontmatter keys (disable-model-invocation not disable_model_invocation)
    4. Refactor renderClaudeCodeSkill to implement PlatformRenderer
    5. Hash file: .render-hash-claude-code (check old .render-hash as fallback, rename on first use)
    6. Supporting dirs: references/, scripts/, assets/ in addition to docs/ (backward compat)

    Create renderer registry: Map<string, PlatformRenderer> with getRenderer() and getAllRenderers()

    Tests: tests/skill-rendering.test.ts
    Existing test patterns in that file show setupTempFixtures usage — follow same pattern.

- title: Codex Skill Renderer
  slug: codex-renderer
  type: requirement
  parent: skill-rendering
  description: |
    Platform-specific renderer for OpenAI Codex. Reads from .kspec/skills/<id>/SKILL.md
    (body-only source) and metadata from meta.yaml. Writes to .agents/skills/<id>/SKILL.md
    with minimal frontmatter (name + description only per Codex convention). Platform-specific
    config from platform_config.codex is rendered as a sidecar agents/openai.yaml file.
  traits:
    - platform-renderer-trait
  acceptance_criteria:
    - id: ac-1
      given: a skill with platforms including codex
      when: render is called
      then: .agents/skills/<id>/SKILL.md is created with YAML frontmatter containing only name and description
    - id: ac-2
      given: a skill with platform_config.codex fields (display_name, allow_implicit_invocation, etc.)
      when: rendered for Codex
      then: .agents/skills/<id>/agents/openai.yaml sidecar is created with those fields
    - id: ac-3
      given: a skill without platform_config.codex
      when: rendered for Codex
      then: only SKILL.md is created (no agents/openai.yaml sidecar)
    - id: ac-4
      given: a rendered Codex skill file
      when: inspected
      then: it contains the <!-- kspec-managed --> marker
    - id: ac-5
      given: a skill with supporting directories
      when: rendered for Codex
      then: references/, scripts/, and assets/ directories are copied to .agents/skills/<id>/
    - id: ac-6
      given: a Codex render completes
      when: hash is stored
      then: hash is written to .kspec/skills/<id>/.render-hash-codex
  implementation_notes: |
    File: src/parser/skill-render.ts (add to same file as Claude Code renderer)

    Implement PlatformRenderer interface for Codex:
    - platform: "codex"
    - defaultOutputDir: ".agents/skills"
    - Frontmatter: minimal — only name + description (Codex docs say "do not include any other fields")
    - Sidecar openai.yaml structure:
      ```yaml
      interface:
        display_name: "..."
        short_description: "..."
      policy:
        allow_implicit_invocation: true/false
      ```
    - Map platform_config.codex fields to the sidecar YAML structure
    - Register in renderer registry

    Reference the Codex skill docs: https://developers.openai.com/codex/skills
    Tests: tests/skill-rendering.test.ts (new describe block for Codex)

- title: Multi-Platform Render CLI
  slug: multi-platform-render-cli
  type: requirement
  parent: skill-render-cli
  description: |
    Updates the kspec skill render CLI command to dispatch to multiple platform renderers
    based on each skill's platforms array. Replaces the current hardcoded
    platforms.includes("claude-code") filter with a loop over registered renderers.
    Adds per-platform status, diff, and output directory configuration.
  acceptance_criteria:
    - id: ac-1
      given: a skill with platforms [claude-code, codex]
      when: kspec skill render is run
      then: both Claude Code and Codex renderers are invoked and results reported
    - id: ac-2
      given: a skill with platforms [codex] only
      when: kspec skill render is run
      then: only the Codex renderer is invoked
    - id: ac-3
      given: kspec skill status is run
      when: skills target multiple platforms
      then: status table shows a row per skill-platform combination
    - id: ac-4
      given: kspec skill render --output-dir <path> is run
      when: rendering
      then: output goes to the specified directory instead of the platform default
    - id: ac-5
      given: kspec skill render --clean is run
      when: multiple platform output directories exist
      then: orphan cleanup operates per-platform in each output directory
    - id: ac-6
      given: render table output
      when: displayed
      then: includes a Platform column showing which platform each result is for
    - id: ac-7
      given: a skill with platforms containing an unregistered platform name
      when: kspec skill render is run
      then: a warning is shown for the unregistered platform and the skill is skipped for that platform
  implementation_notes: |
    File: src/cli/commands/skill.ts

    CRITICAL: Depends on @consolidate-skill-render being done first.

    Render command (lines ~716-952):
    1. Replace `skills.filter(s => s.platforms.includes("claude-code"))` with:
       For each skill, iterate skill.platforms, look up renderer via getRenderer(platform)
    2. Collect results across all platforms, flatten into results array
    3. Table output: add Platform column
    4. --clean: iterate all registered renderers, clean each renderer's output directory
    5. --output-dir flag: pass to renderer options (overrides defaultOutputDir)

    Status command (lines ~955-1051):
    1. Per-platform drift checking using renderer.checkDrift()
    2. Table: add Platform column

    Diff command (lines ~1054-1146):
    1. Add --platform flag to scope diff to one platform
    2. Default: show diff for all platforms

    Consider extracting render logic to src/cli/commands/skill-render.ts if skill.ts
    exceeds ~2500 lines after changes.

- title: Import Frontmatter Stripping and Full Field Parsing
  slug: import-frontmatter-strip
  type: requirement
  parent: skill-import
  description: |
    Updates kspec skill import to parse all Agent Skills frontmatter fields (not just
    name/description), store body-only content in .kspec/skills/ (strip frontmatter from
    source), and map platform-specific fields to platform_config in meta.yaml. Also handles
    all supporting directory types (references/, scripts/, assets/ in addition to docs/).
  acceptance_criteria:
    - id: ac-1
      given: a SKILL.md with Agent Skills frontmatter (name, description, license, compatibility, allowed_tools)
      when: imported
      then: all recognized fields populate corresponding meta.yaml fields
    - id: ac-2
      given: a SKILL.md with frontmatter
      when: imported
      then: the source stored in .kspec/skills/<id>/SKILL.md has NO frontmatter (body-only)
    - id: ac-3
      given: a SKILL.md with Claude Code platform frontmatter (user-invocable, context, agent, etc.)
      when: imported
      then: those fields populate platform_config.claude_code in meta.yaml
    - id: ac-4
      given: a skill directory with references/ and scripts/ subdirectories
      when: imported
      then: both directories are copied to .kspec/skills/<id>/
    - id: ac-5
      given: a skill directory with docs/ subdirectory (legacy convention)
      when: imported
      then: docs/ is copied for backward compatibility
    - id: ac-6
      given: a SKILL.md with no frontmatter
      when: imported with --name and --description flags
      then: import succeeds using CLI flags for metadata
  implementation_notes: |
    File: src/cli/commands/skill.ts

    Import command (lines ~577-714):
    1. Expand parseFrontmatter() (lines ~1585-1607) to return all Agent Skills fields:
       { name?, description?, license?, compatibility?, allowed_tools?, metadata?,
         disable_model_invocation?, user_invocable?, context?, agent?, model?, argument_hint? }
    2. Map Claude Code fields → platform_config.claude_code object
    3. Strip frontmatter from content before writing to .kspec/skills/<id>/SKILL.md:
       content.replace(/^---\n[\s\S]*?\n---\n?/, '')
    4. Handle directories: check for references/, scripts/, assets/, docs/ in source
    5. Set platforms based on what platform fields were found (or default to ["claude-code"])

    Tests: tests/skill-cli.test.ts (import describe block)

- title: Supporting Files Convention
  slug: supporting-files-convention
  type: requirement
  parent: skill-rendering
  description: |
    Updates skill content loading and rendering to handle Agent Skills directory
    convention (references/, scripts/, assets/) in addition to the existing docs/
    directory for backward compatibility. Renderers copy all present supporting
    directories to their output.
  acceptance_criteria:
    - id: ac-1
      given: a skill with references/ directory in .kspec/skills/<id>/
      when: loaded via skill content functions
      then: references files are accessible
    - id: ac-2
      given: a skill with scripts/ and assets/ directories
      when: rendered for any platform
      then: both directories are copied to the platform output
    - id: ac-3
      given: a skill with docs/ directory (legacy)
      when: rendered
      then: docs/ is copied for backward compatibility
    - id: ac-4
      given: a skill with no supporting directories
      when: rendered
      then: render succeeds with no supporting directory actions
  implementation_notes: |
    File: src/parser/meta.ts

    1. Update loadSkillDocs() (lines ~581-611) or create loadSkillSupportingDirs():
       Check for references/, scripts/, assets/, docs/ in .kspec/skills/<id>/
       Return array of { name, path, type } for each found directory
    2. Both renderers use this to know which dirs to copy

    File: src/parser/skill-render.ts
    1. Update copyDirectory calls to handle all directory types
    2. directoriesEqual() already works recursively — reuse as-is

- title: Skill Platform Config CLI
  slug: skill-platform-config-cli
  type: requirement
  parent: skill-cli
  description: |
    Adds CLI options to kspec skill set for managing platform_config fields.
    Enables setting platform-specific values like disable_model_invocation,
    user_invocable, context, agent, etc. per platform.
  acceptance_criteria:
    - id: ac-1
      given: kspec skill set @ref --platform-config claude_code.user_invocable=false
      when: the command runs
      then: meta.yaml is updated with platform_config.claude_code.user_invocable set to false
    - id: ac-2
      given: kspec skill set @ref --platform-config codex.allow_implicit_invocation=true
      when: the command runs
      then: meta.yaml is updated with platform_config.codex.allow_implicit_invocation set to true
    - id: ac-3
      given: kspec skill get @ref --json
      when: the skill has platform_config
      then: platform_config is included in the JSON output
    - id: ac-4
      given: an invalid platform config key
      when: kspec skill set is run
      then: validation error is shown with guidance on valid keys
  implementation_notes: |
    File: src/cli/commands/skill.ts

    Skill set command (lines ~365-501):
    1. Add --platform-config option (repeatable): parses "platform.key=value" format
    2. Parse value types: "true"/"false" → boolean, quoted strings → string
    3. Deep merge into existing platform_config (don't replace entire object)
    4. Schema validation catches invalid keys per platform (strict schemas)

    Skill get command (lines ~308-362):
    1. Include platform_config in table and JSON output
```

## Tasks

derive_from_specs: true

## Implementation Notes

This plan extends kspec's skill management to support multi-platform rendering aligned with the Agent Skills open standard (agentskills.io). The architecture uses a dual-layer model: source SKILL.md files are body-only content (no frontmatter), all metadata lives in meta.yaml, and platform-specific renderers produce the final output with appropriate frontmatter and sidecar files.

### Task Dependency Order (CRITICAL)

Tasks MUST be completed in this order due to dependencies:

1. **@consolidate-skill-render** — PREREQUISITE for everything. Merges duplicate render code.
2. **@extended-skill-schema** — Schema changes needed by all renderers.
3. **@supporting-files-convention** — Directory handling used by renderers.
4. **@platform-renderer-trait** — Trait defines contract (spec-only, no code, but specs reference it).
5. **@claude-code-renderer-extended** — Refactors existing renderer to PlatformRenderer interface.
6. **@codex-renderer** — New renderer using same interface.
7. **@multi-platform-render-cli** — CLI dispatch using renderer registry.
8. **@import-frontmatter-strip** — Import changes (can parallel with #7).
9. **@skill-platform-config-cli** — CLI for managing platform_config (can parallel with #7-8).

Set `depends_on` between derived tasks after import.

### Key Patterns

- PlatformRenderer TypeScript interface defines the contract; @platform-renderer-trait spec defines the ACs
- Renderer registry maps platform names to implementations
- Per-platform hash files enable independent drift detection
- Platform config is a nested object in meta.yaml with strict validation per known platform and passthrough for unknown platforms
- Claude Code frontmatter uses kebab-case keys (matching their convention); meta.yaml uses snake_case (matching kspec convention)
- Codex uses minimal frontmatter (name + description) with sidecar agents/openai.yaml for platform config

### Critical Files

| File | Changes |
|------|---------|
| `src/parser/skill-render.ts` | Consolidated render logic, PlatformRenderer interface, Claude Code + Codex renderers, registry, hash/drift functions |
| `src/schema/meta.ts` | SkillSchema extension with portable fields + platform config |
| `src/parser/meta.ts` | Supporting file loading (references/, scripts/, assets/) |
| `src/cli/commands/skill.ts` | Multi-platform dispatch, import changes, platform config CLI. NOTE: after consolidation, this file delegates to skill-render.ts for render logic |
| `src/cli/commands/setup.ts` | Must remain compatible — verify after consolidation |
| `tests/skill-schema.test.ts` | Schema tests for new fields |
| `tests/skill-rendering.test.ts` | Multi-platform render tests, Codex tests, hash migration tests |

### Verification

Run `npm test -- tests/ --run` after each task to verify no regressions.
Key end-to-end verification after all tasks:
1. Import a skill with full Agent Skills frontmatter → verify body-only source + correct meta.yaml
2. Set platform_config via CLI → verify in meta.yaml
3. Render for both platforms → verify .claude/skills/ and .agents/skills/ output
4. Modify rendered output → verify drift detected per-platform
5. Round-trip: import → render → compare original frontmatter with rendered output
