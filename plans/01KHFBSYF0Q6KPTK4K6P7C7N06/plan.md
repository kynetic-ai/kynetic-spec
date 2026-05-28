# Portable Agent Integration Infrastructure

## Specs

```yaml
# ── Phase 1: Skill Meta Type ──────────────────────────────────

- title: Skill Meta Type
  slug: skill-meta-type
  type: feature
  description: |
    Add Skill as the 5th meta item type in the kspec data model.
    Metadata stored in kynetic.meta.yaml, content in .kspec/skills/<id>/ files.
    Eliminates 90% skill drift across 4 projects by making skills first-class
    data managed by kspec.
  acceptance_criteria:
    - id: ac-1
      given: a kynetic.meta.yaml with a skills array containing valid skill entries
      when: the file is parsed via MetaManifestSchema
      then: each skill entry validates against SkillSchema
    - id: ac-2
      given: a skill with origin core and version 0.2.0
      when: validated by SkillSchema
      then: it passes validation with origin set to core
    - id: ac-3
      given: a skill meta entry exists and .kspec/skills/my-skill/SKILL.md exists
      when: loadSkillContent(ctx, skill) is called
      then: the full markdown content of SKILL.md is returned
    - id: ac-4
      given: loadMetaContext() is called on a manifest with 3 skills
      when: parsing completes
      then: MetaContext.skills contains 3 LoadedSkill objects with _sourceFile set
    - id: ac-5
      given: a skill with id task-work exists in meta
      when: findMetaItemByRef(meta, task-work) is called
      then: the skill is returned by semantic id lookup
    - id: ac-6
      given: a skill ULID prefix is provided to findMetaItemByRef
      when: the prefix matches exactly one skill
      then: the skill is returned by ULID prefix lookup
    - id: ac-7
      given: getMetaItemType is called with a skill object
      when: the discriminator evaluates the object
      then: it returns skill (discriminated by the origin field unique to skills)
  traits:
    - trait-json-output
    - trait-error-guidance

- title: Skill Schema Definition
  slug: skill-schema
  type: requirement
  parent: "@skill-meta-type"
  description: |
    Zod schema for skill metadata. Lean schema — content lives in files.
    Fields: _ulid, id (kebab-case regex), name, description, origin (core|custom),
    version (optional semver), platforms array, depends_on refs, tags.
  acceptance_criteria:
    - id: ac-1
      given: a skill object with id containing uppercase or special characters
      when: validated by SkillSchema
      then: validation fails with a message about kebab-case format
    - id: ac-2
      given: a skill object missing the id field
      when: validated by SkillSchema
      then: validation fails with required field error
    - id: ac-3
      given: a skill with no platforms specified
      when: validated by SkillSchema
      then: platforms defaults to an array containing claude-code

- title: Skill File-Based Content Model
  slug: skill-content-model
  type: requirement
  parent: "@skill-meta-type"
  description: |
    Skill content lives in .kspec/skills/<id>/SKILL.md on the shadow branch.
    Supporting docs in .kspec/skills/<id>/docs/. Meta YAML holds only metadata.
    This avoids YAML escaping issues with large markdown documents.
  acceptance_criteria:
    - id: ac-1
      given: a skill with id task-work and a file at .kspec/skills/task-work/SKILL.md
      when: loadSkillContent is called
      then: the markdown content is returned as a string
    - id: ac-2
      given: a skill with docs at .kspec/skills/task-work/docs/quickref.md
      when: loadSkillDocs is called
      then: an array of doc objects is returned with matching file names
    - id: ac-3
      given: a skill meta entry with no corresponding SKILL.md file
      when: kspec validate is run
      then: a validation error reports the missing content file

- title: Skill Parser Integration
  slug: skill-parser
  type: requirement
  parent: "@skill-meta-type"
  description: |
    Integrate skills into the meta parser: LoadedSkill type, MetaContext.skills array,
    CRUD via saveMetaItem/deleteMetaItem, reference resolution, stats.
    Delete also removes the .kspec/skills/<id>/ directory.
  acceptance_criteria:
    - id: ac-1
      given: a new skill object
      when: saveMetaItem(ctx, skill, skill) is called
      then: the skill is appended to manifest.skills and written to disk
    - id: ac-2
      given: saveMetaItem is called for a skill
      when: the save completes
      then: the .kspec/skills/<id>/ directory is created
    - id: ac-3
      given: an existing skill ULID
      when: deleteMetaItem(ctx, ulid, skill) is called
      then: the skill is removed from manifest.skills
    - id: ac-4
      given: deleteMetaItem completes for a skill
      when: the filesystem is checked
      then: the .kspec/skills/<id>/ directory is also deleted
    - id: ac-5
      given: a manifest with skills
      when: getMetaStats() is called
      then: the returned stats include a skills count
    - id: ac-6
      given: isMetaItemType is called with skill
      when: the type is evaluated
      then: it returns true

- title: Skill Validation
  slug: skill-validation
  type: requirement
  parent: "@skill-meta-type"
  description: |
    Add skill-aware validation to src/parser/validate.ts.
    Validate content file existence, depends_on ref integrity, orphan detection,
    and schema validation parity with existing agent/workflow/convention loops.
  acceptance_criteria:
    - id: ac-1
      given: a skill entry in meta with no .kspec/skills/<id>/SKILL.md file
      when: kspec validate is run
      then: an error is reported for the missing content file
    - id: ac-2
      given: a skill with depends_on referencing a non-existent skill
      when: kspec validate is run
      then: a warning is reported for the broken reference
    - id: ac-3
      given: a .kspec/skills/<id>/ directory with no corresponding meta entry
      when: kspec validate is run
      then: a warning is reported for the orphaned skill directory
    - id: ac-4
      given: a skill entry with invalid schema fields
      when: kspec validate is run
      then: schema validation errors are reported matching existing meta type validation patterns

# ── Phase 2: Skill CLI Commands ───────────────────────────────

- title: Skill CLI Commands
  slug: skill-cli
  type: feature
  description: |
    Dedicated kspec skill namespace for CRUD, import, and management.
    Consistent with kspec task and kspec item patterns.
    Includes import command critical for migrating existing 4 projects.
  acceptance_criteria:
    - id: ac-1
      given: skills exist in the meta manifest
      when: kspec skill list is run
      then: a table displays ID, Name, Origin, Version, and Platforms columns
    - id: ac-2
      given: kspec skill list --json is run
      when: skills exist
      then: a JSON array with full skill metadata is returned
    - id: ac-3
      given: kspec skill add --id my-skill --name My Skill --description A test skill is run
      when: the command completes
      then: a meta entry is created with origin custom
    - id: ac-4
      given: kspec skill add completes successfully
      when: the filesystem is checked
      then: .kspec/skills/my-skill/SKILL.md exists
    - id: ac-5
      given: kspec skill get @my-skill is run
      when: the skill exists
      then: metadata is displayed including id, name, origin, and platforms
    - id: ac-6
      given: kspec skill get @my-skill is run
      when: the skill has content in SKILL.md
      then: the full SKILL.md content is also displayed
    - id: ac-7
      given: kspec skill delete @my-skill --confirm is run
      when: the skill exists
      then: the meta entry is removed from the manifest
    - id: ac-8
      given: kspec skill delete completes for a skill
      when: the filesystem is checked
      then: .kspec/skills/my-skill/ directory is deleted
  traits:
    - trait-json-output
    - trait-confirmation-prompt
    - trait-error-guidance
    - trait-filterable-list
    - trait-shadow-commit

- title: Skill Add Command
  slug: skill-add
  type: requirement
  parent: "@skill-cli"
  description: |
    Create new skill with meta entry + content directory.
    Supports --content-file to initialize from existing file.
  acceptance_criteria:
    - id: ac-1
      given: kspec skill add --id X --name Y --description Z is run
      when: the command completes
      then: a meta entry is created in the manifest skills array
    - id: ac-2
      given: kspec skill add completes
      when: the shadow branch is checked
      then: the changes are auto-committed to the shadow branch
    - id: ac-3
      given: --content-file ./existing-skill.md is provided
      when: the command completes
      then: file contents are copied to .kspec/skills/X/SKILL.md
    - id: ac-4
      given: --origin core --version 0.2.0 is provided
      when: the command completes
      then: meta entry has origin core
    - id: ac-5
      given: --origin core --version 0.2.0 is provided
      when: the meta entry is inspected
      then: version is set to 0.2.0
    - id: ac-6
      given: a skill with the same id already exists
      when: kspec skill add is run with that id
      then: an error is returned indicating duplicate id
  traits:
    - trait-shadow-commit
    - trait-error-guidance

- title: Skill Set Command
  slug: skill-set
  type: requirement
  parent: "@skill-cli"
  description: |
    Update skill metadata fields. Content updates are done by editing files directly.
  acceptance_criteria:
    - id: ac-1
      given: kspec skill set @my-skill --description new description is run
      when: the skill exists
      then: the description field is updated in meta
    - id: ac-2
      given: --add-platform codex is provided
      when: the command completes
      then: codex is added to the platforms array
    - id: ac-3
      given: --add-tag automation is provided
      when: the command completes
      then: automation is added to the tags array
  traits:
    - trait-shadow-commit

- title: Skill Import Command
  slug: skill-import
  type: requirement
  parent: "@skill-cli"
  description: |
    Import existing .claude/skills/<name>/SKILL.md files into the kspec meta system.
    Critical for migrating the 4 existing kspec-using projects.
    Parses SKILL.md frontmatter for name/description, copies content and docs.
  acceptance_criteria:
    - id: ac-1
      given: an existing .claude/skills/task-work/SKILL.md with YAML frontmatter
      when: kspec skill import .claude/skills/task-work/SKILL.md is run
      then: a meta entry is created with name and description extracted from frontmatter
    - id: ac-2
      given: skill import completes
      when: the .kspec/skills/ directory is checked
      then: content is copied to .kspec/skills/task-work/SKILL.md
    - id: ac-3
      given: the skill directory contains a docs/ subdirectory with files
      when: import is run
      then: docs are copied to .kspec/skills/<id>/docs/
    - id: ac-4
      given: --origin core is specified
      when: import completes
      then: the meta entry has origin core
    - id: ac-5
      given: --id custom-name is specified
      when: import completes
      then: the meta entry uses custom-name as the id instead of deriving from directory name
    - id: ac-6
      given: a SKILL.md without YAML frontmatter
      when: import is run without --name and --description flags
      then: an error is shown indicating name and description are required
  traits:
    - trait-shadow-commit
    - trait-error-guidance

- title: Skill Meta Integration
  slug: skill-meta-integration
  type: requirement
  parent: "@skill-cli"
  description: |
    Update existing kspec meta commands to include skills in search and listing.
  acceptance_criteria:
    - id: ac-1
      given: kspec meta get @skill-id is run
      when: a skill with that id exists
      then: the skill metadata is returned
    - id: ac-2
      given: kspec meta list --type skill is run
      when: skills exist
      then: only skills are shown in the list
    - id: ac-3
      given: kspec meta show is run
      when: skills exist
      then: the summary includes skill count
    - id: ac-4
      given: resolveMetaRefToUlid is called with a skill id
      when: the skill exists
      then: the skill ULID is returned

# ── Phase 3: Skill Rendering Pipeline ─────────────────────────

- title: Skill Rendering Pipeline
  slug: skill-rendering
  type: feature
  description: |
    Render skill meta items from shadow branch (.kspec/skills/) to platform-specific
    files on the main branch (.claude/skills/). Includes drift detection and orphan cleanup.
    Designed for cross-platform extensibility but builds Claude Code renderer first.
  acceptance_criteria:
    - id: ac-1
      given: a skill with platforms including claude-code
      when: kspec skill render is run
      then: .claude/skills/<id>/SKILL.md is created with YAML frontmatter
    - id: ac-2
      given: a skill with docs in .kspec/skills/<id>/docs/
      when: rendering completes
      then: docs are copied to .claude/skills/<id>/docs/
    - id: ac-3
      given: kspec skill render is called twice with no content changes
      when: rendering completes the second time
      then: no files are modified (idempotent)
    - id: ac-4
      given: a previously rendered skill that no longer exists in meta
      when: kspec skill render --clean is run
      then: only skill directories that were rendered by kspec are considered for removal
    - id: ac-5
      given: kspec skill render --clean identifies an orphaned managed skill
      when: clean completes
      then: the orphaned .claude/skills/<id>/ directory is removed
  traits:
    - trait-dry-run
    - trait-error-guidance

- title: Skill Render CLI
  slug: skill-render-cli
  type: requirement
  parent: "@skill-rendering"
  description: |
    CLI commands for skill rendering, status checking, and diffing.
    Registered under kspec skill namespace.
  acceptance_criteria:
    - id: ac-1
      given: kspec skill render is run
      when: skills exist in meta
      then: all skills are rendered with a summary of created/updated/skipped files
    - id: ac-2
      given: kspec skill render @task-work is run
      when: the skill exists
      then: only that single skill is rendered
    - id: ac-3
      given: kspec skill status is run
      when: rendered skills exist
      then: a table shows each skill with its sync status (in-sync or drifted)
    - id: ac-4
      given: kspec skill diff @task-work is run
      when: the rendered file differs from meta content
      then: a unified diff is displayed

- title: Claude Code Skill Renderer
  slug: claude-code-renderer
  type: requirement
  parent: "@skill-rendering"
  description: |
    Platform-specific renderer for Claude Code. Reads from .kspec/skills/<id>/SKILL.md,
    writes to .claude/skills/<id>/SKILL.md with YAML frontmatter (name, description).
    Does NOT auto-commit to main branch — leaves files unstaged.
  acceptance_criteria:
    - id: ac-1
      given: a skill with id task-work and content in .kspec/skills/task-work/SKILL.md
      when: renderClaudeCodeSkill is called
      then: .claude/skills/task-work/SKILL.md is created with YAML frontmatter
    - id: ac-2
      given: rendered output
      when: the file is inspected
      then: it has YAML frontmatter delimiters with name and description fields
    - id: ac-3
      given: rendered output
      when: the file is inspected below the frontmatter
      then: the skill body content from .kspec/skills/<id>/SKILL.md appears verbatim
    - id: ac-4
      given: rendering completes
      when: git status is checked
      then: rendered files appear as unstaged changes on the main branch

- title: Skill Drift Detection
  slug: skill-drift-detection
  type: requirement
  parent: "@skill-rendering"
  description: |
    Detect when rendered skill files have been manually edited.
    Hash-based comparison stored in .kspec/skills/<id>/.render-hash.
    Warn before overwriting, require --force to overwrite drifted files.
  acceptance_criteria:
    - id: ac-1
      given: a rendered skill file that has not been manually edited
      when: kspec skill status is run
      then: the skill shows as in sync
    - id: ac-2
      given: a rendered skill file that has been manually edited
      when: kspec skill status is run
      then: the skill shows as drifted with the file path
    - id: ac-3
      given: a drifted skill
      when: kspec skill render is run without --force
      then: the drifted skill is skipped with a warning message
    - id: ac-4
      given: a drifted skill
      when: kspec skill render --force is run
      then: the rendered file is overwritten with meta content
    - id: ac-5
      given: a skill is rendered successfully
      when: the render hash is checked
      then: a hash of the rendered output is stored in .kspec/skills/<id>/.render-hash

# ── Phase 4: Agent Instruction Generation ─────────────────────

- title: Agent Instruction Generation
  slug: agent-instruction-gen
  type: feature
  description: |
    Generate kspec-agents.md from static templates plus auto-generated data sections.
    Templates ship with the npm package. Data sections derive from meta (skills table,
    conventions summary, workflow summary). Users AGENTS.md includes the generated file.
  acceptance_criteria:
    - id: ac-1
      given: meta with skills, conventions, and workflows plus templates directory
      when: kspec agents generate is run
      then: kspec-agents.md is created in the project root
    - id: ac-2
      given: 3 skills exist in meta
      when: kspec-agents.md is generated
      then: the output includes a Finding Information table with a row per skill
    - id: ac-3
      given: conventions exist in meta
      when: kspec-agents.md is generated
      then: the output includes a conventions section listing rules by domain
    - id: ac-4
      given: the generated file
      when: inspected
      then: it contains a freshness comment with kspec version and generation timestamp
    - id: ac-5
      given: kspec agents status is run after meta changes
      when: kspec-agents.md has not been regenerated
      then: it reports stale with a recommendation to regenerate
  traits:
    - trait-dry-run

- title: Agents CLI Commands
  slug: agents-cli
  type: requirement
  parent: "@agent-instruction-gen"
  description: |
    CLI commands registered under kspec agents namespace for generating
    and checking freshness of kspec-agents.md.
  acceptance_criteria:
    - id: ac-1
      given: kspec agents generate is run
      when: meta and templates are available
      then: kspec-agents.md is written to the project root
    - id: ac-2
      given: kspec agents generate --dry-run is run
      when: meta and templates are available
      then: generated content is printed to stdout without writing a file
    - id: ac-3
      given: kspec agents status is run
      when: kspec-agents.md exists and is current
      then: it reports the file is up to date
    - id: ac-4
      given: kspec agents status is run
      when: meta has changed since last generation
      then: it reports the file is stale

- title: Agent Template System
  slug: agent-templates
  type: requirement
  parent: "@agent-instruction-gen"
  description: |
    Static markdown templates that ship with kspec in templates/agents-sections/.
    Cover kspec boilerplate: shadow branch architecture, task lifecycle, PR workflow,
    commit conventions, ralph loop rules, etc. NOT derived from conventions.
  acceptance_criteria:
    - id: ac-1
      given: a templates/agents-sections/ directory with section markdown files
      when: generateAgentsMd is called
      then: all template sections are included in the output in their defined order
    - id: ac-2
      given: template files for quick-start, shadow-branch, task-lifecycle, pr-workflow, commit-convention, ralph-loop exist
      when: assembled into kspec-agents.md
      then: each template section appears in the generated output
    - id: ac-3
      given: the template directory is missing or empty
      when: kspec agents generate is run
      then: an error is returned with a message indicating templates were not found at the expected path
  traits:
    - trait-error-guidance

- title: Auto-Generated Data Sections
  slug: agent-data-sections
  type: requirement
  parent: "@agent-instruction-gen"
  description: |
    Sections generated dynamically from meta data: skills table, conventions summary,
    workflows summary. These update automatically when meta changes.
  acceptance_criteria:
    - id: ac-1
      given: skills in meta with varying names and descriptions
      when: generateSkillsTable is called
      then: a markdown table is returned with columns for skill name, description, and invocation
    - id: ac-2
      given: conventions in meta with rules arrays
      when: generateConventionsSummary is called
      then: a markdown section is returned listing each domain with its rules
    - id: ac-3
      given: workflows in meta with triggers and descriptions
      when: generateWorkflowsSummary is called
      then: a markdown section is returned listing each workflow with its trigger

# ── Phase 5: Enhanced Setup + Distribution ────────────────────

- title: Enhanced Setup Command
  slug: enhanced-setup
  type: feature
  description: |
    Orchestrate full onboarding pipeline in kspec setup: detect agent, install hooks
    (including all PreToolUse guards), render skills, generate agent instructions,
    scaffold AGENTS.md. Also ship templates in npm package.
  acceptance_criteria:
    - id: ac-1
      given: a project with kspec initialized and skills in meta
      when: kspec setup is run
      then: a summary is displayed listing each step performed
    - id: ac-2
      given: kspec setup completes
      when: .claude/settings.json is inspected
      then: all hook entries (UserPromptSubmit, Stop, PreToolUse) are present
    - id: ac-3
      given: kspec setup completes with skills in meta
      when: .claude/skills/ is inspected
      then: rendered skill files exist for each skill targeting claude-code
    - id: ac-4
      given: kspec setup completes
      when: the project root is inspected
      then: kspec-agents.md exists
    - id: ac-5
      given: --skip-skills flag is provided
      when: kspec setup is run
      then: skill rendering is skipped
    - id: ac-6
      given: --dry-run flag is provided
      when: kspec setup is run
      then: planned actions are displayed without making any changes
    - id: ac-7
      given: --status flag is provided
      when: kspec setup is run
      then: current state is reported including agent detected
    - id: ac-8
      given: --status flag is provided
      when: output is inspected
      then: hooks status, skills rendered count, and agents.md freshness are shown
  traits:
    - trait-dry-run
    - trait-error-guidance

- title: Full Hook Installation
  slug: full-hook-install
  type: requirement
  parent: "@enhanced-setup"
  description: |
    Install ALL hooks including PreToolUse guards currently missing from setup.
    Generate worktree guard with dynamic path detection (no hardcoded paths).
  acceptance_criteria:
    - id: ac-1
      given: kspec setup is run on a Claude Code project
      when: hook installation completes
      then: UserPromptSubmit hook entry is written to .claude/settings.json
    - id: ac-2
      given: kspec setup completes
      when: .claude/settings.json is inspected
      then: Stop hook entry is present
    - id: ac-3
      given: kspec setup completes
      when: .claude/settings.json is inspected
      then: PreToolUse Bash hook entries are present for worktree guard
    - id: ac-4
      given: the worktree guard hook is generated
      when: the script is inspected
      then: it uses dynamic path detection via environment variables, not hardcoded absolute paths
    - id: ac-5
      given: the ralph task-limit guard is generated
      when: kspec setup completes
      then: the guard script is installed and referenced in settings.json

- title: Core Skill Installation
  slug: core-skill-install
  type: requirement
  parent: "@enhanced-setup"
  description: |
    kspec skill install-core copies core skill definitions from the kspec npm package
    templates/ directory into the project. Creates meta entries with origin core
    and version matching kspec version.
  acceptance_criteria:
    - id: ac-1
      given: kspec skill install-core is run
      when: the kspec package has templates/skills/ with core skill files
      then: meta entries are created with origin core
    - id: ac-2
      given: install-core completes
      when: .kspec/skills/ is inspected
      then: content files are copied from templates to .kspec/skills/<id>/
    - id: ac-3
      given: a skill already exists with origin custom (forked)
      when: install-core is run
      then: the custom skill is skipped with a message (not overwritten)
    - id: ac-4
      given: --force flag is provided
      when: a custom fork exists
      then: the fork is overwritten with the core version
    - id: ac-5
      given: install-core completes
      when: the installed skills are checked
      then: each has version matching the installed kspec package version
  traits:
    - trait-shadow-commit

- title: Core Skill Update
  slug: core-skill-update
  type: requirement
  parent: "@enhanced-setup"
  description: |
    kspec skill update refreshes core skills from the installed kspec package version.
    Only updates skills with origin core whose version differs from the package version.
  acceptance_criteria:
    - id: ac-1
      given: a core skill with version 0.1.0 and kspec package at version 0.2.0
      when: kspec skill update is run
      then: the skill content and version are updated to match the package
    - id: ac-2
      given: a core skill already at the current kspec version
      when: kspec skill update is run
      then: the skill is skipped (no changes)
    - id: ac-3
      given: a skill with origin custom
      when: kspec skill update is run
      then: the skill is not touched

- title: Package Distribution
  slug: package-distribution
  type: requirement
  parent: "@enhanced-setup"
  description: |
    Ship templates/ directory with the npm package. Contains core skill content,
    agents-md template sections, and hook scripts.
  acceptance_criteria:
    - id: ac-1
      given: npm pack is run
      when: the package contents are inspected
      then: templates/ directory is included
    - id: ac-2
      given: the templates/ directory in the package
      when: its contents are listed
      then: it contains skills/, agents-sections/, and hooks/ subdirectories
    - id: ac-3
      given: a consumer installs @kynetic-ai/spec globally
      when: kspec skill install-core is run in their project
      then: core skills are found in the package templates directory and installed successfully

- title: Init Setup Integration
  slug: init-setup-integration
  type: requirement
  parent: "@enhanced-setup"
  description: |
    kspec init --setup chains into the full setup flow after initialization.
    One command to go from fresh project to fully configured.
  acceptance_criteria:
    - id: ac-1
      given: kspec init --setup is run in a fresh project
      when: initialization completes
      then: shadow branch is created and manifest exists
    - id: ac-2
      given: kspec init --setup continues after initialization
      when: setup phase completes
      then: core skills are installed in .kspec/skills/
    - id: ac-3
      given: kspec init --setup finishes
      when: the project is inspected
      then: rendered skill files, hooks, and kspec-agents.md are all present
    - id: ac-4
      given: kspec init is run without --setup
      when: initialization completes
      then: behavior is unchanged from current (shadow branch + manifest only)
```

## Tasks

derive_from_specs: true

## Implementation Notes

This plan builds portable agent integration infrastructure for kspec. The 5 phases
are independently deliverable:

Phase 1 (skill-meta-type): Schema + parser + validation. Foundation everything else builds on.
Phase 2 (skill-cli): CLI commands including import for migration.
Phase 3 (skill-rendering): Shadow branch to main branch rendering pipeline.
Phase 4 (agent-instruction-gen): Template + data assembly for kspec-agents.md.
Phase 5 (enhanced-setup): Orchestration + npm distribution.

Task dependencies to set post-import (derive does not infer from spec hierarchy):
- All Phase 2 tasks depend on Phase 1 tasks
- Phase 3 tasks depend on Phase 1 and Phase 2
- Phase 4 tasks depend on Phase 1
- Phase 5 tasks depend on Phase 3 and Phase 4

Key architecture decisions:
- Skill metadata in meta YAML, content in .kspec/skills/<id>/ files (avoids YAML escaping)
- Dedicated kspec skill namespace (not under kspec meta)
- Template-based AGENTS.md generation (not convention-to-prose derivation)
- Cross-branch rendering: reads shadow branch, writes main branch, no auto-commit
- Drift detection via SHA-256 hash stored in .kspec/skills/<id>/.render-hash
- Discriminator uses origin field (unique to skills among meta types)
- Clean flag only removes kspec-managed dirs (tracked via render-hash presence)

New files to create:
- src/cli/commands/skill.ts (dedicated skill commands)
- src/cli/commands/agents.ts (agents generate/status)
- src/renderer/skills.ts (rendering pipeline)
- src/renderer/agents-md.ts (agent instruction generator)
- src/renderer/index.ts (re-exports)
- templates/ directory tree (skills, agents-sections, hooks)

Existing files to modify:
- src/schema/meta.ts (SkillSchema, MetaManifestSchema, discriminator)
- src/parser/meta.ts (LoadedSkill, MetaContext, CRUD, refs)
- src/parser/validate.ts (skill validation loops)
- src/cli/commands/meta.ts (ref resolution, list, show, get)
- src/cli/commands/setup.ts (orchestration)
- src/cli/commands/init.ts (--setup flag)
- src/cli/index.ts (register skill and agents commands)
- package.json (add templates to files array)

Out of scope (future work): Claude Code plugin, MCP server, cross-platform renderers,
permission bootstrapping, version pinning.
