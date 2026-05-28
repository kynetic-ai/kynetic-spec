# Droid Platform Support

Add Factory Droid as a first-class platform in kspec alongside claude-code and codex. Droid uses ACP natively and discovers skills from `.factory/skills/` with the same frontmatter format as Claude Code (name, description, user-invocable, disable-model-invocation). Droid invokes skills via `/skill-name` — the same syntax as Claude Code, not `$skill` like Codex.

## Specs

```yaml
- title: Droid Platform Config Schema
  slug: droid-platform-config
  type: requirement
  parent: "@agent-integration"
  description: |
    Add DroidConfigSchema to the platform config. Droid's frontmatter fields
    match Claude Code (user-invocable, disable-model-invocation, context, model,
    argument-hint) so the schema reuses the same shape minus the 'agent' field.
    Add 'droid' key to PlatformConfigSchema. Export DroidConfig type.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        A skill has platform_config.droid defined
      when: |
        The skill schema is validated
      then: |
        Validation passes with recognized droid-specific fields
    - id: ac-2
      given: |
        A skill has platform_config.droid with unknown fields
      when: |
        The skill schema is validated
      then: |
        Validation rejects the unknown fields (strict mode)
    - id: ac-3
      given: |
        PlatformConfigSchema is inspected
      when: |
        The schema object is examined
      then: |
        It contains optional 'droid' key alongside claude_code and codex
    - id: ac-4
      given: |
        The DroidConfig type is imported
      when: |
        TypeScript type checking runs
      then: |
        DroidConfig is exported from the schema module with correct field types

- title: Droid Agent Detection
  slug: droid-agent-detection
  type: requirement
  parent: "@agent-integration"
  description: |
    Detect when kspec is running inside a Factory Droid environment.
    Add "droid" to AgentType union in agent-detection.ts and setup.ts.
    Detection strategy: check for FACTORY_PROJECT_DIR (set by Droid during
    execution) as high confidence, fall back to ~/.factory directory existence
    as medium confidence (similar to Claude Code's ~/.claude fallback).
    FACTORY_API_KEY alone is insufficient since it may be set for other
    Factory services. Detection must be ordered after Claude Code and Codex
    checks but before generic fallbacks to avoid false positives.
  acceptance_criteria:
    - id: ac-1
      given: |
        FACTORY_PROJECT_DIR environment variable is set
      when: |
        detectAgentFromEnv() is called
      then: |
        Returns { type: "droid", confidence: "high" }
    - id: ac-2
      given: |
        No Droid-specific env vars are set
      when: |
        detectAgentFromEnv() is called
      then: |
        Droid is not falsely detected
    - id: ac-3
      given: |
        Droid is detected
      when: |
        Setup status is checked
      then: |
        Agent type shows as "droid" with configPath pointing to ~/.factory/settings.json
    - id: ac-4
      given: |
        Both CLAUDECODE=1 and FACTORY_PROJECT_DIR are set
      when: |
        detectAgentFromEnv() is called
      then: |
        Claude Code is detected (takes precedence due to check ordering)
    - id: ac-5
      given: |
        No env vars are set but ~/.factory directory exists
      when: |
        detectAgent() fallback runs in setup.ts
      then: |
        Returns { type: "droid", confidence: "low" } as filesystem fallback
    - id: ac-6
      given: |
        "droid" is passed as --agent override to setup
      when: |
        parseSetupAgentOverride() is called
      then: |
        "droid" is accepted as a valid SETUP_AGENT_OVERRIDES value

- title: Droid ACP Adapter
  slug: droid-acp-adapter
  type: requirement
  parent: "@agent-integration"
  description: |
    Register a "droid-acp" adapter in the adapter registry. Droid supports
    ACP natively via `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`.
    The adapter spawns droid exec with the appropriate flags for multi-turn
    ACP communication.
  acceptance_criteria:
    - id: ac-1
      given: |
        resolveAdapter("droid-acp") is called
      when: |
        The adapter is looked up
      then: |
        Returns an adapter with command "droid" and args including "exec",
        "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"
    - id: ac-2
      given: |
        listAdapters() is called
      when: |
        The registry is queried
      then: |
        "droid-acp" appears in the list alongside claude-agent-acp and codex-acp
    - id: ac-3
      given: |
        The droid-acp adapter is resolved
      when: |
        autoApproveArgs is inspected
      then: |
        Contains "--skip-permissions-unsafe" for full automation mode

- title: Droid Skill Renderer
  slug: droid-renderer
  type: requirement
  parent: "@agent-integration"
  description: |
    Implement a droidRenderer: PlatformRenderer that outputs skills to
    .factory/skills/<id>/SKILL.md. Droid uses the same frontmatter fields
    as Claude Code (name, description, user-invocable, disable-model-invocation)
    and the same /skill-name invocation syntax. The renderer resolves portable
    {skill:<id>} reference tokens to /skill-name format. Core skills are
    prefixed with kspec- in the output directory for namespace clarity.

    Implementation must also update the shared utility functions:
    - getPlatformDefaultOutputDir() to return ".factory/skills" for "droid"
    - getSkillSubdir() to return "kspec-<id>" for core skills on droid
    - Register droidRenderer in the rendererRegistry map

    Frontmatter generation should create a generateDroidFrontmatter() that
    reads from platform_config.droid (not platform_config.claude_code), while
    producing the same output fields that Droid expects.
  traits:
    - platform-renderer-trait
  acceptance_criteria:
    - id: ac-1
      given: |
        A skill with platforms: ["droid"] exists
      when: |
        droidRenderer.render() is called
      then: |
        .factory/skills/<id>/SKILL.md is created with YAML frontmatter
        containing name and description
    - id: ac-2
      given: |
        A skill has platform_config.droid with user_invocable: false
      when: |
        droidRenderer.render() is called
      then: |
        Frontmatter includes "user-invocable: false" read from
        platform_config.droid (not platform_config.claude_code)
    - id: ac-3
      given: |
        A core skill is rendered for droid platform
      when: |
        getSkillSubdir(skillId, "core", "droid") is called
      then: |
        Returns "kspec-<id>" (namespaced)
    - id: ac-4
      given: |
        droidRenderer.render() completes
      when: |
        The rendered file is inspected
      then: |
        Contains <!-- kspec-managed --> marker
    - id: ac-5
      given: |
        A skill body contains {skill:task-work} reference tokens
      when: |
        droidRenderer.render() is called
      then: |
        Tokens are resolved to /kspec-task-work for core skills or
        /skill-id for project skills
    - id: ac-6
      given: |
        storeHash option is true
      when: |
        droidRenderer.render() completes
      then: |
        Per-platform hash is written to .render-hash-droid
    - id: ac-7
      given: |
        getPlatformDefaultOutputDir("droid") is called
      when: |
        The output directory is resolved
      then: |
        Returns ".factory/skills" (not ".droid/skills")
    - id: ac-8
      given: |
        A skill has platform_config.droid with disable_model_invocation: true
      when: |
        generateDroidFrontmatter() is called
      then: |
        Frontmatter includes "disable-model-invocation: true"

- title: Droid Setup Integration
  slug: droid-setup-integration
  type: requirement
  parent: "@agent-integration"
  description: |
    Integrate Droid into the kspec setup command pipeline. When Droid is
    detected (or --agent droid is specified), setup should render skills to
    .factory/skills/, generate kspec-agents.md, and provide Droid-specific
    guidance for KSPEC_AUTHOR configuration. Hooks installation is deferred
    to a future iteration — Droid has its own hook system in .factory/settings.json
    with compatible event types but different config paths.

    Must update:
    - SETUP_AGENT_OVERRIDES to include "droid"
    - getDefaultAuthor() to return "@droid" for droid agent type
    - Author config instructions to reference Droid's env approach
  acceptance_criteria:
    - id: ac-1
      given: |
        kspec setup is run with --agent droid
      when: |
        Setup completes
      then: |
        Skills targeting the droid platform are rendered to .factory/skills/
    - id: ac-2
      given: |
        kspec setup --status is run in a Droid environment
      when: |
        Status is displayed
      then: |
        Shows agent detected as "droid" with skill render counts
    - id: ac-3
      given: |
        Setup detects Droid and prompts for KSPEC_AUTHOR
      when: |
        Author configuration instructions are shown
      then: |
        Instructions reference Droid's environment variable configuration
        (KSPEC_AUTHOR in .factory/settings.json env section)
    - id: ac-4
      given: |
        "droid" is specified as --agent flag
      when: |
        SETUP_AGENT_OVERRIDES is validated
      then: |
        "droid" is accepted without error
    - id: ac-5
      given: |
        kspec setup runs for droid agent
      when: |
        Hook installation phase executes
      then: |
        Hooks are skipped with a message indicating droid hooks
        are not yet supported (no error)

- title: Core Skills Droid Platform Registration
  slug: core-skills-droid-platform
  type: requirement
  parent: "@agent-integration"
  description: |
    Add "droid" to the platforms array for all core skills in
    templates/skills/manifest.yaml so they are rendered for Droid
    environments during kspec setup.
  acceptance_criteria:
    - id: ac-1
      given: |
        templates/skills/manifest.yaml is inspected
      when: |
        Each core skill's platforms list is examined
      then: |
        All skills include "droid" alongside "claude-code" and "codex"

- title: Portable Skill Reference Resolution
  slug: portable-skill-references
  type: requirement
  parent: "@agent-integration"
  description: |
    Extend formatSkillInvocation, resolveSkillReferenceTokensForPlatform,
    and getSkillReferencePlatform to handle the "droid" platform. Droid uses
    /skill-name invocation like Claude Code, with core skills namespaced as
    /kspec-<id>.

    Critical: getSkillReferencePlatform() in prompts.ts must map
    "droid-acp" adapter ID to "droid" platform so dispatched agents using
    the droid adapter get properly resolved skill reference tokens in their
    prompts at runtime.
  acceptance_criteria:
    - id: ac-1
      given: |
        formatSkillInvocation is called with platform "droid" and origin "core"
      when: |
        The invocation string is generated
      then: |
        Returns "/kspec-<id>" format
    - id: ac-2
      given: |
        formatSkillInvocation is called with platform "droid" and origin "project"
      when: |
        The invocation string is generated
      then: |
        Returns "/<id>" format
    - id: ac-3
      given: |
        A skill body contains {skill:reflect} token
      when: |
        resolveSkillReferenceTokensForPlatform is called for "droid"
      then: |
        Token resolves to "/kspec-reflect" (core skill with namespace)
    - id: ac-4
      given: |
        getSkillReferencePlatform("droid-acp") is called in prompts.ts
      when: |
        The adapter-to-platform mapping is resolved
      then: |
        Returns "droid" so runtime prompt skill references resolve correctly

- title: Droid Core Skill Install Support
  slug: droid-core-skill-install
  type: requirement
  parent: "@agent-integration"
  description: |
    Extend the CoreInstallPlatform type and validation in skill-install.ts
    to accept "droid" as a valid --platform value. Without this,
    `kspec skill install-core --platform droid` fails with a validation error.
    The install logic should use the droid renderer from the registry.
  acceptance_criteria:
    - id: ac-1
      given: |
        kspec skill install-core --platform droid is run
      when: |
        The platform argument is validated
      then: |
        "droid" is accepted as a valid CoreInstallPlatform value
    - id: ac-2
      given: |
        kspec skill install-core --platform droid is run
      when: |
        Core skills are installed
      then: |
        Skills are rendered to .factory/skills/kspec-<id>/SKILL.md
    - id: ac-3
      given: |
        kspec skill install-core is run without --platform
      when: |
        The default platform is used
      then: |
        Existing default behavior is unchanged (claude-code)

- title: Droid Setup Status Reporting
  slug: droid-setup-status
  type: requirement
  parent: "@agent-integration"
  description: |
    Extend setup-status.ts to report droid-specific status. The current
    implementation only scans .claude/skills/ for rendered skills and checks
    for ~/.claude as filesystem fallback. Must add:
    - Scanning .factory/skills/ for droid rendered skills in status
    - Filesystem fallback detection using ~/.factory directory
    - Session commands accepting "droid" as --agent-type
  acceptance_criteria:
    - id: ac-1
      given: |
        kspec setup --status is run with droid skills rendered
      when: |
        Skills status is computed
      then: |
        Skill count includes skills found in .factory/skills/
    - id: ac-2
      given: |
        detectAgent() fallback runs with no env vars
      when: |
        ~/.factory directory exists on disk
      then: |
        Returns { type: "droid", confidence: "medium" } as filesystem
        fallback (after checking ~/.claude first)
    - id: ac-3
      given: |
        kspec session create --agent-type droid is run
      when: |
        The agent-type argument is validated
      then: |
        "droid" is accepted as a valid agent type

- title: Droid Skill Import Support
  slug: droid-skill-import
  type: requirement
  parent: "@agent-integration"
  description: |
    Extend skill-crud.ts import logic to recognize and parse droid-format
    skills from .factory/skills/. When importing a skill that has
    droid-specific frontmatter fields, populate platform_config.droid
    appropriately (not platform_config.claude_code). The frontmatter fields
    are identical in shape but must be mapped to the correct platform key.
  acceptance_criteria:
    - id: ac-1
      given: |
        kspec skill import is run on a SKILL.md from .factory/skills/
      when: |
        The skill is imported
      then: |
        platform_config.droid is populated with the frontmatter fields
    - id: ac-2
      given: |
        A skill with user-invocable: false in frontmatter is imported
        from .factory/skills/
      when: |
        The imported skill metadata is inspected
      then: |
        platform_config.droid.user_invocable is false
    - id: ac-3
      given: |
        A skill from .claude/skills/ is imported (existing behavior)
      when: |
        The import completes
      then: |
        Existing Claude Code import behavior is unchanged
```

## Tasks

derive_from_specs: true

## Implementation Notes

Key research findings that inform the design:

1. **Droid skill discovery**: `.factory/skills/<name>/SKILL.md` (workspace), `~/.factory/skills/<name>/SKILL.md` (personal), `.agent/skills/` (compatibility).
2. **Frontmatter format**: Identical to Claude Code — name, description, user-invocable, disable-model-invocation.
3. **Invocation syntax**: `/skill-name` — same as Claude Code, not `$skill` like Codex.
4. **ACP support**: Native via `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`.
5. **Env detection**: FACTORY_PROJECT_DIR is set during Droid execution (confirmed via hooks docs). No dedicated session ID env var found. Detection uses FACTORY_PROJECT_DIR (high confidence) with ~/.factory filesystem fallback (medium/low confidence). Must be ordered after Claude Code and Codex checks.
6. **The renderer registry pattern** means most of the setup pipeline will automatically pick up the droid renderer once registered — the setup command iterates `skill.platforms` and calls `getRenderer(platform)`.
7. **Cross-platform skill references**: The `{skill:<id>}` portable token system already exists. Droid needs: (a) formatSkillInvocation case, (b) getSkillReferencePlatform mapping in prompts.ts for "droid-acp" -> "droid".
8. **Hooks**: Droid has its own hook system via `.factory/settings.json` with compatible event types (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart, SessionEnd). Hook installation is deferred to a future iteration.
9. **`.factory/` directory ownership**: Droid manages `.factory/` broadly (settings, droids, skills, hooks). kspec renders into `.factory/skills/` which is the standard skill discovery path. This is safe — Droid does not auto-regenerate that directory.
10. **Files requiring changes** (comprehensive list):
    - `src/schema/meta.ts` — DroidConfigSchema, PlatformConfigSchema
    - `src/parser/agent-detection.ts` — AgentType, detectAgentFromEnv
    - `src/agents/adapters.ts` — droid-acp adapter
    - `src/parser/skill-render.ts` — droidRenderer, getPlatformDefaultOutputDir, getSkillSubdir, formatSkillInvocation, rendererRegistry
    - `src/cli/commands/setup.ts` — AgentType, SETUP_AGENT_OVERRIDES, detectAgent, author config
    - `src/cli/commands/skill-install.ts` — CoreInstallPlatform
    - `src/parser/setup-status.ts` — skill scanning, filesystem fallback
    - `src/agent-runtime/prompts.ts` — getSkillReferencePlatform
    - `src/cli/commands/skill-crud.ts` — import platform detection
    - `src/cli/commands/session/commands.ts` — agent-type option
    - `templates/skills/manifest.yaml` — platforms arrays
