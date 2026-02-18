/**
 * Skill CLI commands for managing skills.
 *
 * AC: @skill-cli ac-1 - kspec skill list outputs table with ID, Name, Origin, Version, Platforms
 * AC: @skill-cli ac-2 - kspec skill list --json outputs JSON array with full skill metadata
 * AC: @skill-cli ac-3 - kspec skill add creates meta entry with origin custom
 * AC: @skill-cli ac-4 - kspec skill add creates .kspec/skills/<id>/SKILL.md
 * AC: @skill-cli ac-5 - kspec skill get outputs metadata including id, name, origin, platforms
 * AC: @skill-cli ac-6 - kspec skill get outputs SKILL.md content
 * AC: @skill-cli ac-7 - kspec skill delete --confirm removes meta entry
 * AC: @skill-cli ac-8 - kspec skill delete removes .kspec/skills/<id>/ directory
 *
 * AC: @core-skill-install ac-1 - meta entries created with origin core
 * AC: @core-skill-install ac-2 - content files copied from templates to .kspec/skills/<id>/
 * AC: @core-skill-install ac-3 - custom skills skipped with message
 * AC: @core-skill-install ac-4 - --force overwrites custom forks
 * AC: @core-skill-install ac-5 - version matches kspec package version
 *
 * AC: @core-skill-update ac-1 - skill content and version updated when version differs
 * AC: @core-skill-update ac-2 - skill skipped when already at current version
 * AC: @core-skill-update ac-3 - skills with origin custom/project not touched
 */

import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import Table from "cli-table3";
import type { Command } from "commander";
import { ulid } from "ulid";
import yaml from "yaml";
import { markMutating } from "../command-annotations.js";
import {
  deleteMetaItem,
  findMetaItemByRef,
  getSkillContentPath,
  initContext,
  type KspecContext,
  loadMetaContext,
  loadSkillContent,
  loadSkillDocs,
  type LoadedSkill,
  saveMetaItem,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import {
  checkPlatformSkillDrift,
  computeContentHash,
  generateFrontmatter,
  isKspecManagedSkill as isKspecManaged,
  KSPEC_MANAGED_MARKER,
  readRenderHash,
  renderClaudeCodeSkill,
  getRenderer,
  getAllRenderers,
  contentsEqual,
  copyDirectory,
  directoriesEqual,
  type ClaudeCodeRenderResult,
  type PlatformRenderer,
  type PlatformRenderResult,
  type DriftStatus,
} from "../../parser/skill-render.js";
import {
  SkillSchema,
  ClaudeCodeConfigSchema,
  CodexConfigSchema,
  type SkillOrigin,
  type PlatformConfig,
} from "../../schema/index.js";
import { errors } from "../../strings/errors.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output, success } from "../output.js";
import { parseTagsArray } from "../parse-utils.js";

/**
 * Format skills as a table
 * AC: @skill-cli ac-1 - table displays ID, Name, Origin, Version, Platforms
 */
function formatSkillsTable(skills: LoadedSkill[]): void {
  if (skills.length === 0) {
    console.log(chalk.yellow("No skills defined"));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold("ID"),
      chalk.bold("Name"),
      chalk.bold("Origin"),
      chalk.bold("Version"),
      chalk.bold("Platforms"),
    ],
    style: {
      head: [],
      border: [],
    },
  });

  for (const skill of skills) {
    table.push([
      skill.id,
      skill.name,
      skill.origin,
      skill.version || "-",
      skill.platforms.join(", "),
    ]);
  }

  console.log(table.toString());
  console.log(chalk.gray(`\n${skills.length} skill(s)`));
}

/**
 * Format skill details
 * AC: @skill-cli ac-5 - outputs metadata including id, name, origin, platforms
 */
function formatSkillDetails(skill: LoadedSkill, content: string | null): void {
  console.log(chalk.bold(skill.name));
  console.log(chalk.gray("─".repeat(40)));
  console.log(`ID:          ${skill.id}`);
  console.log(`ULID:        ${skill._ulid}`);
  console.log(`Origin:      ${skill.origin}`);
  console.log(`Platforms:   ${skill.platforms.join(", ")}`);

  if (skill.version) {
    console.log(`Version:     ${skill.version}`);
  }

  if (skill.description) {
    console.log(`\n─── Description ───`);
    console.log(skill.description);
  }

  if (skill.depends_on && skill.depends_on.length > 0) {
    console.log(`\n─── Dependencies ───`);
    for (const dep of skill.depends_on) {
      console.log(`  • ${dep}`);
    }
  }

  if (skill.tags && skill.tags.length > 0) {
    console.log(`\nTags:        ${skill.tags.join(", ")}`);
  }

  // AC: @skill-cli ac-6 - display SKILL.md content
  if (content) {
    console.log(`\n─── SKILL.md Content ───`);
    console.log(content);
  } else {
    console.log(chalk.gray("\n(No SKILL.md content found)"));
  }
}

/**
 * Register skill commands
 */
export function registerSkillCommands(program: Command): void {
  const skill = program
    .command("skill")
    .description("Skill management commands");

  // AC: @skill-cli ac-1, ac-2 - kspec skill list
  skill
    .command("list")
    .description("List all skills")
    .option("--origin <origin>", "Filter by origin (core, project, local)")
    .option("--tag <tag>", "Filter by tag")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        let skills = metaCtx.skills || [];

        // Apply filters
        if (options.origin) {
          skills = skills.filter((s) => s.origin === options.origin);
        }

        if (options.tag) {
          skills = skills.filter((s) => s.tags?.includes(options.tag));
        }

        // AC: @skill-cli ac-2 - JSON output includes full skill metadata
        output(
          skills.map((s) => ({
            _ulid: s._ulid,
            id: s.id,
            name: s.name,
            description: s.description,
            origin: s.origin,
            version: s.version,
            platforms: s.platforms,
            depends_on: s.depends_on,
            tags: s.tags,
          })),
          // AC: @skill-cli ac-1 - Table output
          () => formatSkillsTable(skills),
        );
      } catch (err) {
        error("Failed to list skills", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-cli ac-3, ac-4 - kspec skill add
  // AC: @skill-add ac-3 - --content-file copies existing file to SKILL.md
  markMutating(skill.command("add"))
    .description("Create a new skill")
    .requiredOption("--id <id>", "Skill ID (kebab-case)")
    .requiredOption("--name <name>", "Skill name")
    .option("--description <desc>", "Skill description")
    .option(
      "--origin <origin>",
      "Skill origin (core, project, local)",
      "project",
    )
    .option("--skill-version <version>", "Skill version")
    .option("--platform <platform...>", "Target platforms")
    .option("--tag <tag...>", "Tags for the skill")
    .option("--depends-on <ref...>", "Skill dependencies")
    .option("--content-file <path>", "Path to existing file to use as SKILL.md content")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        // Validate origin
        const validOrigins: SkillOrigin[] = ["core", "project", "local"];
        if (!validOrigins.includes(options.origin as SkillOrigin)) {
          error(
            `Invalid origin: ${options.origin}. Valid origins: ${validOrigins.join(", ")}`,
          );
          process.exit(EXIT_CODES.ERROR);
        }

        // Check if skill with this ID already exists
        const metaCtx = await loadMetaContext(ctx);
        const existingSkill = metaCtx.skills.find((s) => s.id === options.id);
        if (existingSkill) {
          error(`Skill with ID '${options.id}' already exists`);
          process.exit(EXIT_CODES.CONFLICT);
        }

        // Build skill object (schema provides defaults for platforms, depends_on, tags)
        const skillData = {
          _ulid: ulid(),
          id: options.id,
          name: options.name,
          description: options.description,
          origin: options.origin as SkillOrigin,
          version: options.skillVersion,
          ...(options.platform && options.platform.length > 0 && { platforms: options.platform }),
          ...(options.dependsOn && options.dependsOn.length > 0 && { depends_on: options.dependsOn }),
          allowed_tools: [],
          ...(options.tag && options.tag.length > 0 && { tags: parseTagsArray(options.tag) }),
        };

        // Validate with schema
        const parsed = SkillSchema.safeParse(skillData);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          error(`Invalid skill data: ${issues}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const skill: LoadedSkill = { ...parsed.data };

        // AC: @skill-cli ac-3 - save meta entry (also creates directory per ac-4)
        await saveMetaItem(ctx, skill, "skill");

        // AC: @skill-cli ac-4 - create SKILL.md with placeholder content
        // AC: @skill-add ac-3 - if --content-file provided, copy its contents
        const skillMdPath = getSkillContentPath(ctx, skill.id);
        let initialContent: string;

        if (options.contentFile) {
          // Read content from the specified file
          const contentFilePath = path.isAbsolute(options.contentFile)
            ? options.contentFile
            : path.resolve(process.cwd(), options.contentFile);

          try {
            initialContent = await fs.readFile(contentFilePath, "utf-8");
          } catch (err) {
            // Clean up: remove the skill we just created
            await deleteMetaItem(ctx, skill._ulid, "skill");
            error(`Failed to read content file: ${contentFilePath}`);
            process.exit(EXIT_CODES.ERROR);
          }
        } else {
          initialContent = `# ${skill.name}\n\n${skill.description || "Add skill content here."}\n`;
        }

        await fs.writeFile(skillMdPath, initialContent, "utf-8");

        // Commit changes
        await commitIfShadow(ctx.shadow, "skill-add", skill.id, skill.name);

        output(skill, () =>
          success(`Created skill: ${skill.id}`, { skill }),
        );
      } catch (err) {
        error("Failed to create skill", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-cli ac-5, ac-6 - kspec skill get
  skill
    .command("get <ref>")
    .description("Show skill details")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const item = findMetaItemByRef(metaCtx, ref);

        if (!item) {
          error(`Skill not found: ${ref}`);
          console.log(chalk.gray("Try: kspec skill list"));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        // Check it's a skill
        if (!("origin" in item)) {
          error(`Item ${ref} is not a skill`);
          process.exit(EXIT_CODES.ERROR);
        }

        const skill = item as LoadedSkill;

        // AC: @skill-cli ac-6 - load SKILL.md content
        const content = await loadSkillContent(ctx, skill);
        const docs = await loadSkillDocs(ctx, skill);

        // AC: @skill-cli ac-5, ac-6 - output metadata and content
        // Include extended skill schema fields (license, compatibility, allowed_tools, metadata, platform_config)
        output(
          {
            _ulid: skill._ulid,
            id: skill.id,
            name: skill.name,
            description: skill.description,
            origin: skill.origin,
            version: skill.version,
            platforms: skill.platforms,
            depends_on: skill.depends_on,
            tags: skill.tags,
            // Extended fields from @extended-skill-schema
            license: skill.license,
            compatibility: skill.compatibility,
            allowed_tools: skill.allowed_tools,
            metadata: skill.metadata,
            platform_config: skill.platform_config,
            content,
            docs: docs.map((d) => ({ name: d.name, path: d.path })),
          },
          () => formatSkillDetails(skill, content),
        );
      } catch (err) {
        error("Failed to get skill", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-set ac-1, ac-2, ac-3 - kspec skill set
  markMutating(skill.command("set <ref>"))
    .description("Update skill metadata fields")
    .option("--name <name>", "Update skill name")
    .option("--description <desc>", "Update skill description")
    .option("--origin <origin>", "Update skill origin (core, project, local)")
    .option("--skill-version <version>", "Update skill version")
    .option("--add-platform <platform>", "Add a platform to the platforms array")
    .option("--remove-platform <platform>", "Remove a platform from the platforms array")
    .option("--add-tag <tag>", "Add a tag to the tags array")
    .option("--remove-tag <tag>", "Remove a tag from the tags array")
    .option("--add-depends-on <ref>", "Add a dependency reference")
    .option("--remove-depends-on <ref>", "Remove a dependency reference")
    .option(
      "--platform-config <config>",
      "Set platform config (format: platform.key=value, e.g., claude_code.user_invocable=false)",
      (value: string, previous: string[]) => {
        // Collect multiple --platform-config options
        return previous.concat([value]);
      },
      [] as string[],
    )
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const item = findMetaItemByRef(metaCtx, ref);

        if (!item) {
          error(`Skill not found: ${ref}`);
          console.log(chalk.gray("Try: kspec skill list"));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        // Check it's a skill
        if (!("origin" in item)) {
          error(`Item ${ref} is not a skill`);
          process.exit(EXIT_CODES.ERROR);
        }

        const skill = item as LoadedSkill;

        // AC: @skill-set ac-1 - update description field
        if (options.name !== undefined) {
          skill.name = options.name;
        }

        if (options.description !== undefined) {
          skill.description = options.description;
        }

        // Update origin
        if (options.origin !== undefined) {
          const validOrigins: SkillOrigin[] = ["core", "project", "local"];
          if (!validOrigins.includes(options.origin as SkillOrigin)) {
            error(
              `Invalid origin: ${options.origin}. Valid origins: ${validOrigins.join(", ")}`,
            );
            process.exit(EXIT_CODES.ERROR);
          }
          skill.origin = options.origin as SkillOrigin;
        }

        // Update version
        if (options.skillVersion !== undefined) {
          skill.version = options.skillVersion;
        }

        // AC: @skill-set ac-2 - add platform to array
        if (options.addPlatform) {
          if (!skill.platforms.includes(options.addPlatform)) {
            skill.platforms.push(options.addPlatform);
          }
        }

        // Remove platform
        if (options.removePlatform) {
          const idx = skill.platforms.indexOf(options.removePlatform);
          if (idx >= 0) {
            skill.platforms.splice(idx, 1);
          }
        }

        // AC: @skill-set ac-3 - add tag to array
        if (options.addTag) {
          if (!skill.tags) {
            skill.tags = [];
          }
          if (!skill.tags.includes(options.addTag)) {
            skill.tags.push(options.addTag);
          }
        }

        // Remove tag
        if (options.removeTag && skill.tags) {
          const idx = skill.tags.indexOf(options.removeTag);
          if (idx >= 0) {
            skill.tags.splice(idx, 1);
          }
        }

        // Add dependency
        if (options.addDependsOn) {
          if (!skill.depends_on) {
            skill.depends_on = [];
          }
          if (!skill.depends_on.includes(options.addDependsOn)) {
            skill.depends_on.push(options.addDependsOn);
          }
        }

        // Remove dependency
        if (options.removeDependsOn && skill.depends_on) {
          const idx = skill.depends_on.indexOf(options.removeDependsOn);
          if (idx >= 0) {
            skill.depends_on.splice(idx, 1);
          }
        }

        // AC: @skill-platform-config-cli ac-1, ac-2 - Handle platform config updates
        if (options.platformConfig && options.platformConfig.length > 0) {
          // Initialize platform_config if not present
          if (!skill.platform_config) {
            skill.platform_config = {};
          }

          for (const configStr of options.platformConfig as string[]) {
            // Parse "platform.key=value" format
            const match = configStr.match(/^([^.]+)\.([^=]+)=(.*)$/);
            if (!match) {
              error(
                `Invalid platform config format: ${configStr}\n` +
                  `Expected format: platform.key=value (e.g., claude_code.user_invocable=false)`,
              );
              process.exit(EXIT_CODES.VALIDATION_FAILED);
            }

            const [, platform, key, rawValue] = match;

            // Parse value type: "true"/"false" → boolean, otherwise string
            let value: boolean | string;
            if (rawValue === "true") {
              value = true;
            } else if (rawValue === "false") {
              value = false;
            } else {
              // Remove surrounding quotes if present
              value = rawValue.replace(/^["']|["']$/g, "");
            }

            // Deep merge: initialize platform object if needed
            if (!(platform in skill.platform_config)) {
              (skill.platform_config as Record<string, Record<string, unknown>>)[
                platform
              ] = {};
            }

            // Set the value
            (
              skill.platform_config as Record<string, Record<string, unknown>>
            )[platform][key] = value;
          }
        }

        // Validate updated skill
        // AC: @skill-platform-config-cli ac-4 - validation error with guidance on valid keys
        const parsed = SkillSchema.safeParse(skill);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");

          // Check if any errors are related to platform_config and provide guidance
          const hasPlatformConfigError = parsed.error.issues.some(
            (i) => i.path[0] === "platform_config",
          );

          let errorMsg = `Invalid skill data: ${issues}`;
          if (hasPlatformConfigError) {
            // Get valid keys from schemas
            const claudeCodeKeys = Object.keys(ClaudeCodeConfigSchema.shape).join(
              ", ",
            );
            const codexKeys = Object.keys(CodexConfigSchema.shape).join(", ");
            errorMsg +=
              `\n\nValid platform config keys:` +
              `\n  claude_code: ${claudeCodeKeys}` +
              `\n  codex: ${codexKeys}`;
          }

          error(errorMsg);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // Save the updated skill
        await saveMetaItem(ctx, skill, "skill");

        // Commit changes
        await commitIfShadow(ctx.shadow, "skill-set", skill.id, skill.name);

        output(skill, () => success(`Updated skill: ${skill.id}`));
      } catch (err) {
        error("Failed to update skill", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-cli ac-7, ac-8 - kspec skill delete
  markMutating(skill.command("delete <ref>"))
    .description("Delete a skill")
    .option("--confirm", "Skip confirmation prompt")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const item = findMetaItemByRef(metaCtx, ref);

        if (!item) {
          error(`Skill not found: ${ref}`);
          console.log(chalk.gray("Try: kspec skill list"));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        // Check it's a skill
        if (!("origin" in item)) {
          error(`Item ${ref} is not a skill`);
          process.exit(EXIT_CODES.ERROR);
        }

        const skill = item as LoadedSkill;

        // Check for confirmation
        if (!options.confirm) {
          error(`Confirm deletion of skill '${skill.id}' with --confirm flag`);
          process.exit(EXIT_CODES.ERROR);
        }

        // Check for dependencies from other skills
        const dependentSkills = metaCtx.skills.filter(
          (s) =>
            s._ulid !== skill._ulid &&
            s.depends_on?.some(
              (dep) =>
                dep === `@${skill.id}` ||
                dep === skill.id ||
                dep.startsWith(`@${skill._ulid.substring(0, 8)}`),
            ),
        );

        if (dependentSkills.length > 0) {
          const depRefs = dependentSkills.map((s) => `@${s.id}`).join(", ");
          error(
            `Cannot delete skill '${skill.id}': referenced by ${dependentSkills.length} skill(s): ${depRefs}`,
          );
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @skill-cli ac-7, ac-8 - delete meta entry and directory
        const deleted = await deleteMetaItem(ctx, skill._ulid, "skill");

        if (!deleted) {
          error(`Failed to delete skill: ${skill.id}`);
          process.exit(EXIT_CODES.ERROR);
        }

        // Commit changes
        await commitIfShadow(ctx.shadow, "skill-delete", skill.id);

        success(`Deleted skill: ${skill.id}`);
      } catch (err) {
        error("Failed to delete skill", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-import ac-1 through ac-7 - kspec skill import
  // AC: @import-frontmatter-strip ac-1 through ac-6 - Extended frontmatter parsing
  markMutating(skill.command("import <file>"))
    .description("Import an existing SKILL.md file into kspec")
    .option("--id <id>", "Custom skill ID (defaults to directory name)")
    .option("--name <name>", "Skill name (required if no frontmatter)")
    .option("--description <desc>", "Skill description (required if no frontmatter)")
    .option(
      "--origin <origin>",
      "Skill origin (core, project, local)",
      "project",
    )
    .option("--skill-version <version>", "Skill version")
    .action(async (file: string, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        // Resolve file path
        const filePath = path.isAbsolute(file)
          ? file
          : path.resolve(process.cwd(), file);

        // Check file exists
        try {
          await fs.access(filePath);
        } catch {
          error(`File not found: ${filePath}`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        // Read file content
        const content = await fs.readFile(filePath, "utf-8");

        // AC: @skill-import ac-1, ac-6 - Parse YAML frontmatter
        // AC: @import-frontmatter-strip ac-1, ac-3 - Parse all Agent Skills fields
        const frontmatter = parseFrontmatter(content);

        // Determine name and description from frontmatter or options
        // AC: @import-frontmatter-strip ac-6 - CLI flags work when no frontmatter
        const skillName = options.name || frontmatter?.name;
        const skillDescription = options.description || frontmatter?.description;

        // AC: @skill-import ac-6, @import-frontmatter-strip ac-6 - Error if no name/description and no frontmatter
        if (!skillName) {
          error("Name is required. Either add YAML frontmatter with 'name' field or use --name option.");
          console.log(chalk.gray("Example frontmatter:\n---\nname: my-skill\ndescription: My skill description\n---"));
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        if (!skillDescription) {
          error("Description is required. Either add YAML frontmatter with 'description' field or use --description option.");
          console.log(chalk.gray("Example frontmatter:\n---\nname: my-skill\ndescription: My skill description\n---"));
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @skill-import ac-5 - Derive ID from directory name or use custom
        const sourceDir = path.dirname(filePath);
        const derivedId = path.basename(sourceDir);
        const skillId = options.id || derivedId;

        // Validate origin
        const validOrigins: SkillOrigin[] = ["core", "project", "local"];
        if (!validOrigins.includes(options.origin as SkillOrigin)) {
          error(
            `Invalid origin: ${options.origin}. Valid origins: ${validOrigins.join(", ")}`,
          );
          process.exit(EXIT_CODES.ERROR);
        }

        // Check if skill with this ID already exists
        const metaCtx = await loadMetaContext(ctx);
        const existingSkill = metaCtx.skills.find((s) => s.id === skillId);
        if (existingSkill) {
          error(`Skill with ID '${skillId}' already exists. Use --id to specify a different ID.`);
          process.exit(EXIT_CODES.CONFLICT);
        }

        // AC: @import-frontmatter-strip ac-3 - Build platform_config.claude_code from frontmatter
        let platformConfig: import("../../schema/index.js").PlatformConfig | undefined;
        if (frontmatter) {
          const claudeCodeConfig: import("../../schema/index.js").ClaudeCodeConfig = {};
          if (frontmatter.user_invocable !== undefined) {
            claudeCodeConfig.user_invocable = frontmatter.user_invocable;
          }
          if (frontmatter.disable_model_invocation !== undefined) {
            claudeCodeConfig.disable_model_invocation = frontmatter.disable_model_invocation;
          }
          if (frontmatter.context !== undefined) {
            claudeCodeConfig.context = frontmatter.context;
          }
          if (frontmatter.agent !== undefined) {
            claudeCodeConfig.agent = frontmatter.agent;
          }
          if (frontmatter.model !== undefined) {
            claudeCodeConfig.model = frontmatter.model;
          }
          if (frontmatter.argument_hint !== undefined) {
            claudeCodeConfig.argument_hint = frontmatter.argument_hint;
          }

          // Only set platform_config if we have Claude Code config fields
          if (Object.keys(claudeCodeConfig).length > 0) {
            platformConfig = { claude_code: claudeCodeConfig };
          }
        }

        // Build skill object
        // AC: @import-frontmatter-strip ac-1 - All recognized fields populate meta.yaml
        // Schema provides defaults for platforms, depends_on, tags
        const skillData = {
          _ulid: ulid(),
          id: skillId,
          name: skillName,
          description: skillDescription,
          origin: options.origin as SkillOrigin,
          version: options.skillVersion,
          // AC: @import-frontmatter-strip ac-1 - license, compatibility, allowed_tools from frontmatter
          license: frontmatter?.license,
          compatibility: frontmatter?.compatibility,
          allowed_tools: frontmatter?.allowed_tools || [],
          // AC: @import-frontmatter-strip ac-3 - platform_config.claude_code from frontmatter
          platform_config: platformConfig,
        };

        // Validate with schema
        const parsed = SkillSchema.safeParse(skillData);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          error(`Invalid skill data: ${issues}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const skill: LoadedSkill = { ...parsed.data };

        // Save meta entry (also creates directory)
        await saveMetaItem(ctx, skill, "skill");

        // AC: @skill-import ac-7 - Strip/normalize base-directory paths
        // AC: @import-frontmatter-strip ac-2 - Store body-only content (strip frontmatter)
        const normalizedContent = normalizeBaseDirectory(content);
        const bodyOnlyContent = stripFrontmatter(normalizedContent);

        // AC: @skill-import ac-2 - Copy content to .kspec/skills/<id>/SKILL.md
        const skillMdPath = getSkillContentPath(ctx, skill.id);
        await fs.writeFile(skillMdPath, bodyOnlyContent, "utf-8");

        // AC: @import-frontmatter-strip ac-4, ac-5 - Copy all supporting directories
        const supportingDirs = ["references", "scripts", "assets", "docs"];
        for (const dirName of supportingDirs) {
          const sourceSubDir = path.join(sourceDir, dirName);
          try {
            const stats = await fs.stat(sourceSubDir);
            if (stats.isDirectory()) {
              const targetSubDir = path.join(ctx.specDir, "skills", skill.id, dirName);
              await fs.mkdir(targetSubDir, { recursive: true });
              await copyDirectory(sourceSubDir, targetSubDir);
            }
          } catch {
            // Directory doesn't exist, that's fine
          }
        }

        // Commit changes
        await commitIfShadow(ctx.shadow, "skill-import", skill.id, skill.name);

        output(skill, () =>
          success(`Imported skill: ${skill.id}`, { skill }),
        );
      } catch (err) {
        error("Failed to import skill", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-rendering ac-1 through ac-5 - kspec skill render
  // AC: @skill-render-cli ac-1, ac-2 - kspec skill render / kspec skill render @skill-id
  // AC: @skill-drift-detection ac-3, ac-4 - drift handling with --force
  // AC: @multi-platform-render-cli ac-1 through ac-7 - multi-platform rendering
  // AC: @trait-dry-run - supports --dry-run
  // AC: @trait-error-guidance - provides error guidance
  skill
    .command("render [ref]")
    .description(
      "Render skills from shadow branch to platform-specific files on main branch"
    )
    .option("--clean", "Remove orphaned managed skill directories")
    .option("--dry-run", "Show what would be changed without applying")
    .option("--force", "Overwrite drifted skill files (manually edited)")
    .option("--output-dir <path>", "Custom output directory (overrides platform default)")
    .option("--skill <id>", "Render only a specific skill (deprecated, use positional arg)")
    .action(async (ref: string | undefined, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          console.log(
            chalk.gray("Try: kspec init to initialize a kspec project")
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        // Use rootDir (project root), not specDir (which is .kspec/ in shadow mode)
        const projectRoot = ctx.rootDir;
        const dryRun = options.dryRun || false;
        const force = options.force || false;
        const customOutputDir = options.outputDir;
        const results: MultiPlatformRenderResult[] = [];
        const cleanResults: CleanResult[] = [];
        const warnings: string[] = [];

        // Get all skills (no platform filtering - we'll check per-platform)
        let skillsToRender = metaCtx.skills;

        // AC: @skill-render-cli ac-2 - Filter to specific skill if requested
        // Support both positional ref argument and --skill option
        const skillRef = ref || options.skill;
        if (skillRef) {
          // Resolve the ref to a skill
          const item = findMetaItemByRef(metaCtx, skillRef);
          if (!item || !("origin" in item)) {
            error(`Skill not found: ${skillRef}`);
            console.log(chalk.gray("Try: kspec skill list"));
            process.exit(EXIT_CODES.NOT_FOUND);
          }
          const skill = item as LoadedSkill;
          skillsToRender = skillsToRender.filter((s) => s.id === skill.id);
        }

        // Track which platforms we're using to create output directories and for clean
        const usedPlatforms = new Set<string>();

        // AC: @multi-platform-render-cli ac-1, ac-2 - Render each skill to each of its platforms
        for (const skill of skillsToRender) {
          for (const platform of skill.platforms) {
            // Get the renderer for this platform
            const renderer = getRenderer(platform);

            // AC: @multi-platform-render-cli ac-7 - Warn for unregistered platforms
            if (!renderer) {
              warnings.push(`${skill.id}: unregistered platform '${platform}' (skipped)`);
              results.push({
                id: skill.id,
                platform,
                action: "skipped",
                path: "",
                skipReason: `unregistered platform '${platform}'`,
              });
              continue;
            }

            usedPlatforms.add(platform);

            // Determine output directory
            const outputDir = customOutputDir || renderer.defaultOutputDir;

            // Ensure output directory exists
            const targetSkillsDir = path.join(projectRoot, outputDir);
            if (!dryRun) {
              await fs.mkdir(targetSkillsDir, { recursive: true });
            }

            // Check for drift before rendering
            // AC: @skill-drift-detection ac-3, ac-4 - Check drift and skip without --force
            const driftStatus = await renderer.checkDrift(
              ctx.specDir,
              projectRoot,
              skill.id,
              { outputDir: customOutputDir }
            );

            // AC: @skill-drift-detection ac-3 - Skip drifted skills without --force
            if (driftStatus === "drifted" && !force) {
              const renderedPath = path.join(
                projectRoot,
                outputDir,
                skill.id,
                "SKILL.md"
              );
              results.push({
                id: skill.id,
                platform,
                action: "skipped",
                path: renderedPath,
                skipReason: "drifted (use --force to overwrite)",
              });
              continue;
            }

            // AC: @skill-drift-detection ac-4 - Render (overwrite) when --force is used
            // AC: @multi-platform-render-cli ac-4 - Pass custom outputDir to renderer
            const result = await renderer.render(ctx, projectRoot, skill, {
              dryRun,
              storeHash: true,
              outputDir: customOutputDir,
            });

            results.push({
              id: result.id,
              platform: result.platform,
              action: result.action,
              path: result.paths[0] || "",
              skipReason: result.skipReason,
            });
          }
        }

        // Handle --clean: remove orphaned managed skills per platform
        // AC: @skill-rendering ac-4, ac-5
        // AC: @multi-platform-render-cli ac-5 - Per-platform cleanup
        if (options.clean) {
          // Build set of active skill IDs per platform
          const activeSkillIdsByPlatform = new Map<string, Set<string>>();
          for (const skill of metaCtx.skills) {
            for (const platform of skill.platforms) {
              if (!activeSkillIdsByPlatform.has(platform)) {
                activeSkillIdsByPlatform.set(platform, new Set());
              }
              activeSkillIdsByPlatform.get(platform)!.add(skill.id);
            }
          }

          // Clean each platform's output directory
          const renderers = getAllRenderers();
          for (const renderer of renderers) {
            const outputDir = customOutputDir || renderer.defaultOutputDir;
            const targetSkillsDir = path.join(projectRoot, outputDir);
            const activeIds = activeSkillIdsByPlatform.get(renderer.platform) || new Set();

            try {
              const entries = await fs.readdir(targetSkillsDir, {
                withFileTypes: true,
              });

              for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const skillId = entry.name;
                const skillDir = path.join(targetSkillsDir, skillId);
                const skillMdPath = path.join(skillDir, "SKILL.md");

                // Skip if skill still exists in meta for this platform
                if (activeIds.has(skillId)) continue;

                // AC: @skill-rendering ac-4 - Only consider kspec-managed skills
                const isManaged = await isKspecManaged(skillMdPath);

                if (isManaged) {
                  // AC: @skill-rendering ac-5 - Remove orphaned directory
                  if (!dryRun) {
                    await fs.rm(skillDir, { recursive: true, force: true });
                  }
                  cleanResults.push({
                    id: skillId,
                    path: skillDir,
                    action: "removed",
                    platform: renderer.platform,
                  });
                } else {
                  cleanResults.push({
                    id: skillId,
                    path: skillDir,
                    action: "skipped",
                    reason: "Not managed by kspec",
                    platform: renderer.platform,
                  });
                }
              }
            } catch {
              // Output directory doesn't exist, nothing to clean
            }
          }
        }

        // Output results
        // AC: @trait-dry-run ac-6 - JSON output includes dry_run field
        output(
          {
            dry_run: dryRun,
            rendered: results,
            cleaned: cleanResults,
            warnings,
          },
          () => {
            // AC: @trait-dry-run ac-3 - Clear indication this is a preview
            if (dryRun) {
              console.log(chalk.yellow("DRY RUN - No changes made"));
              console.log();
            }

            // AC: @multi-platform-render-cli ac-7 - Show warnings for unregistered platforms
            if (warnings.length > 0) {
              console.log(chalk.yellow("Warnings:"));
              for (const warning of warnings) {
                console.log(`  ${chalk.yellow("!")} ${warning}`);
              }
              console.log();
            }

            // Render results
            const created = results.filter((r) => r.action === "created");
            const updated = results.filter((r) => r.action === "updated");
            const unchanged = results.filter((r) => r.action === "unchanged");
            // AC: @skill-drift-detection ac-3 - Track skipped drifted skills
            const skippedDrifted = results.filter(
              (r) => r.action === "skipped" && r.skipReason?.includes("drifted")
            );
            const skippedUnregistered = results.filter(
              (r) => r.action === "skipped" && r.skipReason?.includes("unregistered")
            );

            // AC: @multi-platform-render-cli ac-6 - Include Platform column in output
            if (created.length > 0) {
              console.log(chalk.green(`Created: ${created.length} skill(s)`));
              for (const r of created) {
                console.log(`  ${chalk.green("+")} ${r.id} ${chalk.gray(`[${r.platform}]`)}`);
              }
            }

            if (updated.length > 0) {
              console.log(chalk.blue(`Updated: ${updated.length} skill(s)`));
              for (const r of updated) {
                console.log(`  ${chalk.blue("~")} ${r.id} ${chalk.gray(`[${r.platform}]`)}`);
              }
            }

            if (unchanged.length > 0 && results.length <= 10) {
              console.log(chalk.gray(`Unchanged: ${unchanged.length} skill(s)`));
            }

            // AC: @skill-drift-detection ac-3 - Show warning for skipped drifted skills
            if (skippedDrifted.length > 0) {
              console.log();
              console.log(chalk.yellow(`Skipped: ${skippedDrifted.length} drifted skill(s)`));
              for (const r of skippedDrifted) {
                console.log(`  ${chalk.yellow("!")} ${r.id} ${chalk.gray(`[${r.platform}]`)}: ${r.skipReason || "drifted"}`);
              }
              console.log();
              console.log(chalk.yellow("Use --force to overwrite drifted skills"));
            }

            // Clean results
            if (cleanResults.length > 0) {
              const removed = cleanResults.filter((r) => r.action === "removed");
              const skipped = cleanResults.filter((r) => r.action === "skipped");

              if (removed.length > 0) {
                console.log();
                console.log(chalk.red(`Removed: ${removed.length} orphaned skill(s)`));
                for (const r of removed) {
                  // AC: @multi-platform-render-cli ac-6 - Platform column in clean output
                  console.log(`  ${chalk.red("-")} ${r.id} ${chalk.gray(`[${r.platform}]`)}`);
                }
              }

              if (skipped.length > 0) {
                console.log(
                  chalk.gray(`Skipped: ${skipped.length} unmanaged skill(s)`)
                );
              }
            }

            // Summary
            console.log();
            if (dryRun) {
              console.log(
                chalk.yellow("No changes were made. Run without --dry-run to apply.")
              );
            } else {
              const changedCount = created.length + updated.length;
              const cleanedCount = cleanResults.filter(
                (r) => r.action === "removed"
              ).length;
              if (changedCount > 0 || cleanedCount > 0) {
                success(
                  `Rendered ${changedCount} skill(s)${cleanedCount > 0 ? `, cleaned ${cleanedCount}` : ""}`
                );
              } else {
                console.log(chalk.gray("No changes needed"));
              }
            }
          }
        );
      } catch (err) {
        error("Failed to render skills", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-render-cli ac-3 - kspec skill status
  // AC: @multi-platform-render-cli ac-3 - Per-platform status rows
  skill
    .command("status")
    .description("Show sync status of rendered skills")
    .action(async () => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          console.log(
            chalk.gray("Try: kspec init to initialize a kspec project")
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const projectRoot = ctx.rootDir;

        // Check all skills (not just claude-code)
        const skillsToCheck = metaCtx.skills;

        if (skillsToCheck.length === 0) {
          console.log(chalk.yellow("No skills found"));
          return;
        }

        // AC: @multi-platform-render-cli ac-3 - Build status per skill-platform pair
        const statusResults: MultiPlatformStatusResult[] = [];

        for (const skill of skillsToCheck) {
          for (const platform of skill.platforms) {
            const renderer = getRenderer(platform);
            if (!renderer) {
              // Unregistered platform - show as not-rendered
              statusResults.push({
                id: skill.id,
                platform,
                status: "not-rendered",
                docsStatus: "no-docs",
                warning: `unregistered platform '${platform}'`,
              });
              continue;
            }

            const status = await getMultiPlatformSyncStatus(ctx, projectRoot, skill, renderer);
            statusResults.push(status);
          }
        }

        // Output results
        output(
          statusResults,
          () => {
            // AC: @multi-platform-render-cli ac-3 - Table shows Platform column
            const table = new Table({
              head: [
                chalk.bold("ID"),
                chalk.bold("Platform"),
                chalk.bold("Status"),
                chalk.bold("Docs"),
              ],
              style: {
                head: [],
                border: [],
              },
            });

            for (const result of statusResults) {
              const statusColor =
                result.status === "in-sync"
                  ? chalk.green
                  : result.status === "drifted"
                    ? chalk.yellow
                    : chalk.gray;

              const docsStatusColor =
                result.docsStatus === "in-sync"
                  ? chalk.green
                  : result.docsStatus === "drifted"
                    ? chalk.yellow
                    : chalk.gray;

              table.push([
                result.id,
                result.platform,
                statusColor(result.status + (result.warning ? " (!)" : "")),
                docsStatusColor(result.docsStatus || "-"),
              ]);
            }

            console.log(table.toString());

            // Summary
            const inSync = statusResults.filter((r) => r.status === "in-sync").length;
            const drifted = statusResults.filter((r) => r.status === "drifted").length;
            const notRendered = statusResults.filter((r) => r.status === "not-rendered").length;
            const warnings = statusResults.filter((r) => r.warning).length;

            console.log();
            if (drifted > 0) {
              console.log(chalk.yellow(`${drifted} skill(s) drifted - run 'kspec skill render' to sync`));
            }
            if (notRendered > 0) {
              console.log(chalk.gray(`${notRendered} skill(s) not rendered`));
            }
            if (warnings > 0) {
              console.log(chalk.yellow(`${warnings} skill(s) with warnings`));
            }
            if (inSync === statusResults.length) {
              console.log(chalk.green("All skills in sync"));
            }
          }
        );
      } catch (err) {
        error("Failed to check skill status", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-render-cli ac-4 - kspec skill diff
  skill
    .command("diff <ref>")
    .description("Show diff between source and rendered skill")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          console.log(
            chalk.gray("Try: kspec init to initialize a kspec project")
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const item = findMetaItemByRef(metaCtx, ref);

        if (!item) {
          error(`Skill not found: ${ref}`);
          console.log(chalk.gray("Try: kspec skill list"));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        // Check it's a skill
        if (!("origin" in item)) {
          error(`Item ${ref} is not a skill`);
          process.exit(EXIT_CODES.ERROR);
        }

        const skill = item as LoadedSkill;
        const projectRoot = ctx.rootDir;

        // Get expected rendered content
        const expectedContent = await getExpectedRenderedContent(ctx, skill);

        // Get actual rendered content
        const renderedPath = path.join(
          projectRoot,
          ".claude",
          "skills",
          skill.id,
          "SKILL.md"
        );

        let actualContent = "";
        try {
          actualContent = await fs.readFile(renderedPath, "utf-8");
        } catch {
          // File doesn't exist
        }

        // Generate diff
        const diff = generateUnifiedDiff(
          actualContent,
          expectedContent,
          `a/${skill.id}/SKILL.md`,
          `b/${skill.id}/SKILL.md`
        );

        // Output
        output(
          {
            id: skill.id,
            hasDiff: diff.length > 0,
            diff,
          },
          () => {
            if (diff.length === 0) {
              console.log(chalk.green(`${skill.id}: in sync`));
            } else {
              console.log(chalk.yellow(`${skill.id}: drifted`));
              console.log();
              // Print colored diff
              for (const line of diff) {
                if (line.startsWith("+") && !line.startsWith("+++")) {
                  console.log(chalk.green(line));
                } else if (line.startsWith("-") && !line.startsWith("---")) {
                  console.log(chalk.red(line));
                } else if (line.startsWith("@@")) {
                  console.log(chalk.cyan(line));
                } else {
                  console.log(line);
                }
              }
            }
          }
        );
      } catch (err) {
        error("Failed to generate diff", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @core-skill-install - kspec skill install-core
  markMutating(skill.command("install-core"))
    .description(
      "Install core skills from kspec package templates"
    )
    .option("--force", "Overwrite custom forks with core versions")
    .option("--dry-run", "Show what would be installed without making changes")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          console.log(
            chalk.gray("Try: kspec init to initialize a kspec project")
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const dryRun = options.dryRun || false;
        const force = options.force || false;
        const results: CoreSkillInstallResult[] = [];

        // Load core skills manifest
        const coreSkills = loadCoreSkillsManifest();
        if (coreSkills.length === 0) {
          console.log(chalk.yellow("No core skills found in kspec package templates"));
          return;
        }

        // Get kspec package version
        // AC: @cross-platform-and-version-robustness ac-3
        const kspecVersion = getKspecPackageVersion();
        if (!kspecVersion) {
          console.log(chalk.yellow("Warning: Could not determine kspec version — skills installed without version tracking"));
        }

        // Process each core skill
        for (const coreSkill of coreSkills) {
          // AC: @core-skill-install ac-3 - Check if skill exists with custom origin
          const existingSkill = metaCtx.skills.find((s) => s.id === coreSkill.id);

          if (existingSkill) {
            // Check origin - if "custom" or "project" and not forcing, skip
            if (existingSkill.origin !== "core" && !force) {
              results.push({
                id: coreSkill.id,
                action: "skipped",
                reason: `existing ${existingSkill.origin} skill (use --force to overwrite)`,
              });
              continue;
            }
          }

          // AC: @core-skill-install ac-1 - Create/update meta entry with origin core
          // AC: @core-skill-install ac-5 - Version matches kspec package version
          // Schema provides defaults for platforms, depends_on
          const skillData = {
            _ulid: existingSkill?._ulid || ulid(),
            id: coreSkill.id,
            name: coreSkill.name,
            description: coreSkill.description,
            origin: "core",
            ...(kspecVersion && { version: kspecVersion }),
            ...(coreSkill.platforms && { platforms: coreSkill.platforms }),
            allowed_tools: [],
            tags: ["core"],
          };

          // Validate with schema
          const parsed = SkillSchema.safeParse(skillData);
          if (!parsed.success) {
            const issues = parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ");
            results.push({
              id: coreSkill.id,
              action: "failed",
              reason: `validation error: ${issues}`,
            });
            continue;
          }

          const skill: LoadedSkill = { ...parsed.data };

          // Save meta entry (if not dry run)
          if (!dryRun) {
            await saveMetaItem(ctx, skill, "skill");

            // AC: @core-skill-install ac-2 - Copy SKILL.md content
            const sourceContent = loadCoreSkillContent(coreSkill.id);
            if (sourceContent) {
              const targetPath = getSkillContentPath(ctx, skill.id);
              await fs.writeFile(targetPath, sourceContent, "utf-8");
            }
          }

          results.push({
            id: coreSkill.id,
            action: existingSkill ? "updated" : "created",
            version: kspecVersion ?? undefined,
          });
        }

        // Commit changes if not dry run
        if (!dryRun && results.some((r) => r.action === "created" || r.action === "updated")) {
          await commitIfShadow(
            ctx.shadow,
            "skill-install-core",
            `${results.filter((r) => r.action !== "skipped" && r.action !== "failed").length} core skills`
          );
        }

        // Output results
        output(
          {
            dry_run: dryRun,
            results,
          },
          () => {
            if (dryRun) {
              console.log(chalk.yellow("DRY RUN - No changes made"));
              console.log();
            }

            const created = results.filter((r) => r.action === "created");
            const updated = results.filter((r) => r.action === "updated");
            const skipped = results.filter((r) => r.action === "skipped");
            const failed = results.filter((r) => r.action === "failed");

            if (created.length > 0) {
              console.log(chalk.green(`Created: ${created.length} skill(s)`));
              for (const r of created) {
                console.log(`  ${chalk.green("+")} ${r.id}${r.version ? ` (v${r.version})` : ""}`);
              }
            }

            if (updated.length > 0) {
              console.log(chalk.blue(`Updated: ${updated.length} skill(s)`));
              for (const r of updated) {
                console.log(`  ${chalk.blue("~")} ${r.id}${r.version ? ` (v${r.version})` : ""}`);
              }
            }

            if (skipped.length > 0) {
              console.log(chalk.yellow(`Skipped: ${skipped.length} skill(s)`));
              for (const r of skipped) {
                console.log(`  ${chalk.yellow("!")} ${r.id}: ${r.reason}`);
              }
            }

            if (failed.length > 0) {
              console.log(chalk.red(`Failed: ${failed.length} skill(s)`));
              for (const r of failed) {
                console.log(`  ${chalk.red("x")} ${r.id}: ${r.reason}`);
              }
            }

            console.log();
            if (dryRun) {
              console.log(
                chalk.yellow("No changes were made. Run without --dry-run to apply.")
              );
            } else {
              const changedCount = created.length + updated.length;
              if (changedCount > 0) {
                success(`Installed ${changedCount} core skill(s)`);
              } else if (skipped.length > 0) {
                console.log(chalk.gray("No skills installed (all skipped or failed)"));
              }
            }
          }
        );
      } catch (err) {
        error("Failed to install core skills", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @core-skill-update - kspec skill update
  markMutating(skill.command("update"))
    .description(
      "Update core skills to match the installed kspec package version"
    )
    .option("--dry-run", "Show what would be updated without making changes")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          console.log(
            chalk.gray("Try: kspec init to initialize a kspec project")
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const dryRun = options.dryRun || false;
        const results: CoreSkillUpdateResult[] = [];

        // Get kspec package version
        // AC: @cross-platform-and-version-robustness ac-3
        const kspecVersion = getKspecPackageVersion();
        if (!kspecVersion) {
          console.log(chalk.yellow("Warning: Could not determine kspec version — updating based on content changes only"));
        }

        // Load core skills manifest to get current content
        const coreSkillsManifest = loadCoreSkillsManifest();
        const coreSkillsMap = new Map(
          coreSkillsManifest.map((s) => [s.id, s])
        );

        // AC: @core-skill-update ac-3 - Only process skills with origin core
        const coreSkills = metaCtx.skills.filter((s) => s.origin === "core");

        for (const skill of coreSkills) {
          // AC: @core-skill-update ac-2 - Skip if already at current version
          // If kspecVersion is null or skill has no version, always update
          if (kspecVersion && skill.version === kspecVersion) {
            results.push({
              id: skill.id,
              action: "skipped",
              reason: "already at current version",
              currentVersion: skill.version,
            });
            continue;
          }

          // Check if skill exists in core manifest
          const coreSkill = coreSkillsMap.get(skill.id);
          if (!coreSkill) {
            results.push({
              id: skill.id,
              action: "skipped",
              reason: "not found in core skills manifest",
              currentVersion: skill.version,
            });
            continue;
          }

          // AC: @core-skill-update ac-1 - Update content and version
          const oldVersion = skill.version;

          if (!dryRun) {
            // Update skill metadata with new version
            if (kspecVersion) {
              skill.version = kspecVersion;
            }
            skill.name = coreSkill.name;
            if (coreSkill.description) {
              skill.description = coreSkill.description;
            }
            if (coreSkill.platforms) {
              skill.platforms = coreSkill.platforms;
            }

            // Save updated metadata
            await saveMetaItem(ctx, skill, "skill");

            // Update SKILL.md content from templates
            const sourceContent = loadCoreSkillContent(skill.id);
            if (sourceContent) {
              const targetPath = getSkillContentPath(ctx, skill.id);
              await fs.writeFile(targetPath, sourceContent, "utf-8");
            }
          }

          results.push({
            id: skill.id,
            action: "updated",
            previousVersion: oldVersion,
            newVersion: kspecVersion ?? undefined,
          });
        }

        // Commit changes if not dry run and there are updates
        if (!dryRun && results.some((r) => r.action === "updated")) {
          await commitIfShadow(
            ctx.shadow,
            "skill-update",
            `${results.filter((r) => r.action === "updated").length} core skills`
          );
        }

        // Output results
        output(
          {
            dry_run: dryRun,
            kspec_version: kspecVersion,
            results,
          },
          () => {
            if (dryRun) {
              console.log(chalk.yellow("DRY RUN - No changes made"));
              console.log();
            }

            console.log(`kspec version: ${kspecVersion ?? "unavailable"}`);
            console.log();

            const updated = results.filter((r) => r.action === "updated");
            const skipped = results.filter((r) => r.action === "skipped");

            if (updated.length > 0) {
              console.log(chalk.green(`Updated: ${updated.length} skill(s)`));
              for (const r of updated) {
                console.log(
                  `  ${chalk.green("~")} ${r.id}: ${r.previousVersion || "unknown"} → ${r.newVersion || "unavailable"}`
                );
              }
            }

            if (skipped.length > 0) {
              console.log(chalk.gray(`Skipped: ${skipped.length} skill(s)`));
              for (const r of skipped) {
                console.log(
                  `  ${chalk.gray("-")} ${r.id}: ${r.reason}${r.currentVersion ? ` (v${r.currentVersion})` : ""}`
                );
              }
            }

            console.log();
            if (dryRun) {
              console.log(
                chalk.yellow("No changes were made. Run without --dry-run to apply.")
              );
            } else if (updated.length > 0) {
              success(`Updated ${updated.length} core skill(s)`);
            } else {
              console.log(chalk.gray("No skills needed updating"));
            }
          }
        );
      } catch (err) {
        error("Failed to update core skills", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @skill-drift-detection-improvements ac-2 - kspec skill verify
  skill
    .command("verify")
    .description("Verify rendered skills match their source (reports drift with guidance)")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          console.log(
            chalk.gray("Try: kspec init to initialize a kspec project")
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const projectRoot = ctx.rootDir;
        const skillsToCheck = metaCtx.skills;

        if (skillsToCheck.length === 0) {
          console.log(chalk.yellow("No skills found"));
          return;
        }

        // Build verification results for each skill-platform pair
        interface VerifyResult {
          id: string;
          platform: string;
          status: "ok" | "drifted" | "not-rendered" | "no-hash";
          guidance?: string;
        }

        const results: VerifyResult[] = [];

        for (const skill of skillsToCheck) {
          for (const platform of skill.platforms) {
            const renderer = getRenderer(platform);
            if (!renderer) {
              results.push({
                id: skill.id,
                platform,
                status: "not-rendered",
                guidance: `Unregistered platform '${platform}'. No renderer available.`,
              });
              continue;
            }

            const driftStatus = await renderer.checkDrift(
              ctx.specDir,
              projectRoot,
              skill.id
            );

            switch (driftStatus) {
              case "in-sync":
                results.push({ id: skill.id, platform, status: "ok" });
                break;
              case "drifted":
                results.push({
                  id: skill.id,
                  platform,
                  status: "drifted",
                  guidance: `Rendered file has been modified. Run 'kspec skill render ${skill.id} --force' to overwrite with source, or 'kspec skill diff ${skill.id}' to review changes.`,
                });
                break;
              case "not-rendered":
                results.push({
                  id: skill.id,
                  platform,
                  status: "not-rendered",
                  guidance: `Not yet rendered. Run 'kspec skill render ${skill.id}' to generate.`,
                });
                break;
              case "no-hash":
                results.push({
                  id: skill.id,
                  platform,
                  status: "no-hash",
                  guidance: `No render hash stored. Run 'kspec skill render ${skill.id}' to render and store hash.`,
                });
                break;
            }
          }
        }

        const driftedResults = results.filter((r) => r.status === "drifted");
        const okResults = results.filter((r) => r.status === "ok");
        const notRenderedResults = results.filter((r) => r.status === "not-rendered");
        const noHashResults = results.filter((r) => r.status === "no-hash");

        output(
          results,
          () => {
            if (driftedResults.length === 0 && notRenderedResults.length === 0 && noHashResults.length === 0) {
              console.log(chalk.green(`All ${okResults.length} rendered skill(s) verified — no drift detected.`));
              return;
            }

            // Show drifted skills with guidance
            if (driftedResults.length > 0) {
              console.log(chalk.yellow.bold(`\nDrifted (${driftedResults.length}):`));
              for (const r of driftedResults) {
                console.log(`  ${chalk.yellow("●")} ${r.id} [${r.platform}]`);
                console.log(`    ${chalk.gray(r.guidance!)}`);
              }
            }

            // Show not-rendered
            if (notRenderedResults.length > 0) {
              console.log(chalk.gray.bold(`\nNot rendered (${notRenderedResults.length}):`));
              for (const r of notRenderedResults) {
                console.log(`  ${chalk.gray("○")} ${r.id} [${r.platform}]`);
                console.log(`    ${chalk.gray(r.guidance!)}`);
              }
            }

            // Show no-hash
            if (noHashResults.length > 0) {
              console.log(chalk.gray.bold(`\nNo hash (${noHashResults.length}):`));
              for (const r of noHashResults) {
                console.log(`  ${chalk.gray("○")} ${r.id} [${r.platform}]`);
                console.log(`    ${chalk.gray(r.guidance!)}`);
              }
            }

            // Summary line
            if (okResults.length > 0) {
              console.log(chalk.green(`\n${okResults.length} skill(s) verified OK.`));
            }

            // Actionable summary
            if (driftedResults.length > 0) {
              console.log(
                chalk.yellow(`\nTo sync all drifted skills: kspec skill render --force`)
              );
            }
          }
        );

        // Exit with non-zero if any skills drifted
        if (driftedResults.length > 0) {
          process.exit(EXIT_CODES.ERROR);
        }
      } catch (err) {
        error("Failed to verify skills", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

/**
 * Result of updating a single core skill
 * AC: @core-skill-update
 */
interface CoreSkillUpdateResult {
  id: string;
  action: "updated" | "skipped";
  previousVersion?: string;
  newVersion?: string;
  currentVersion?: string;
  reason?: string;
}

/**
 * Result of installing a single core skill
 */
interface CoreSkillInstallResult {
  id: string;
  action: "created" | "updated" | "skipped" | "failed";
  version?: string;
  reason?: string;
}

/**
 * Core skill definition from manifest
 */
interface CoreSkillDefinition {
  id: string;
  name: string;
  description?: string;
  platforms?: string[];
}

/**
 * Get the kspec package version from package.json
 * AC: @core-skill-install ac-5
 */
function getKspecPackageVersion(): string | null {
  try {
    // Try to find package.json relative to this module
    const packagePath = path.resolve(
      import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
      "../../../package.json"
    );
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
    return packageJson.version || null;
  } catch {
    return null;
  }
}

/**
 * Get the templates directory path
 */
function getTemplatesDir(): string {
  // Templates are at <package-root>/templates/skills/
  return path.resolve(
    import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
    "../../../templates/skills"
  );
}

/**
 * Load core skills manifest from templates/skills/manifest.yaml
 * AC: @core-skill-install ac-1, ac-2
 */
function loadCoreSkillsManifest(): CoreSkillDefinition[] {
  try {
    const templatesDir = getTemplatesDir();
    const manifestPath = path.join(templatesDir, "manifest.yaml");
    const content = readFileSync(manifestPath, "utf-8");
    const parsed = yaml.parse(content);

    if (!parsed || !Array.isArray(parsed.skills)) {
      return [];
    }

    return parsed.skills.map((s: Record<string, unknown>) => ({
      id: String(s.id || ""),
      name: String(s.name || s.id || ""),
      description: s.description ? String(s.description) : undefined,
      platforms: Array.isArray(s.platforms) ? s.platforms.map(String) : undefined,
    })).filter((s: CoreSkillDefinition) => s.id);
  } catch {
    return [];
  }
}

/**
 * Load SKILL.md content for a core skill from templates
 * AC: @core-skill-install ac-2
 */
function loadCoreSkillContent(skillId: string): string | null {
  try {
    const templatesDir = getTemplatesDir();
    const skillMdPath = path.join(templatesDir, skillId, "SKILL.md");
    return readFileSync(skillMdPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Parsed frontmatter from Agent Skills SKILL.md
 * AC: @import-frontmatter-strip ac-1 - All recognized Agent Skills fields
 * AC: @import-frontmatter-strip ac-3 - Claude Code platform-specific fields
 */
interface ParsedFrontmatter {
  // Core metadata
  name?: string;
  description?: string;
  // Portable Agent Skills fields (AC: ac-1)
  license?: string;
  compatibility?: string;
  allowed_tools?: string[];
  // Claude Code platform fields (AC: ac-3)
  user_invocable?: boolean;
  disable_model_invocation?: boolean;
  context?: string;
  agent?: string;
  model?: string;
  argument_hint?: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns null if no valid frontmatter found.
 *
 * AC: @import-frontmatter-strip ac-1 - Parse all Agent Skills frontmatter fields
 * AC: @import-frontmatter-strip ac-3 - Parse Claude Code platform frontmatter
 */
function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return null;
  }

  try {
    const parsed = yaml.parse(match[1]);

    if (typeof parsed === "object" && parsed !== null) {
      const result: ParsedFrontmatter = {};

      // Core metadata
      if (typeof parsed.name === "string") result.name = parsed.name;
      if (typeof parsed.description === "string") result.description = parsed.description;

      // Portable Agent Skills fields (AC: ac-1)
      if (typeof parsed.license === "string") result.license = parsed.license;
      if (typeof parsed.compatibility === "string") result.compatibility = parsed.compatibility;
      if (Array.isArray(parsed.allowed_tools)) {
        result.allowed_tools = parsed.allowed_tools.filter((t: unknown) => typeof t === "string");
      }

      // Claude Code platform fields (AC: ac-3)
      // Support both underscore and hyphen naming for user-invocable
      if (typeof parsed.user_invocable === "boolean") result.user_invocable = parsed.user_invocable;
      if (typeof parsed["user-invocable"] === "boolean") result.user_invocable = parsed["user-invocable"];
      if (typeof parsed.disable_model_invocation === "boolean") result.disable_model_invocation = parsed.disable_model_invocation;
      if (typeof parsed["disable-model-invocation"] === "boolean") result.disable_model_invocation = parsed["disable-model-invocation"];
      if (typeof parsed.context === "string") result.context = parsed.context;
      if (typeof parsed.agent === "string") result.agent = parsed.agent;
      if (typeof parsed.model === "string") result.model = parsed.model;
      if (typeof parsed.argument_hint === "string") result.argument_hint = parsed.argument_hint;
      if (typeof parsed["argument-hint"] === "string") result.argument_hint = parsed["argument-hint"];

      return result;
    }
  } catch {
    // Invalid YAML in frontmatter
  }

  return null;
}

/**
 * Strip YAML frontmatter from markdown content.
 * AC: @import-frontmatter-strip ac-2 - Remove frontmatter for body-only storage
 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/**
 * Normalize base-directory paths in skill content.
 * AC: @skill-import ac-7 - Strip or convert absolute paths to relative.
 *
 * Matches patterns like:
 * - "Base directory for this skill: /absolute/path/to/skill"
 * - Lines starting with hardcoded paths
 */
function normalizeBaseDirectory(content: string): string {
  // Remove or normalize "Base directory for/of [this] skill:" lines with absolute paths
  // Common pattern in Claude-generated skill files
  // AC: @cross-platform-and-version-robustness ac-5 - case-insensitive with wording variations
  const baseDirLineRegex = /^base\s+directory\s+(?:for|of)\s+(?:this\s+)?skill:.*$/gim;

  return content.replace(baseDirLineRegex, "");
}

/**
 * Result of rendering a single skill to a platform
 * AC: @multi-platform-render-cli ac-6 - Includes platform field
 */
interface MultiPlatformRenderResult {
  id: string;
  platform: string;
  action: "created" | "updated" | "unchanged" | "skipped";
  path: string;
  /** Reason why skill was skipped */
  skipReason?: string;
}

/**
 * Result of a clean operation
 * AC: @multi-platform-render-cli ac-5 - Includes platform field
 */
interface CleanResult {
  id: string;
  path: string;
  action: "removed" | "skipped";
  reason?: string;
  /** Platform this clean result is for */
  platform?: string;
}

/**
 * Result of checking a skill's sync status for a specific platform
 * AC: @multi-platform-render-cli ac-3
 */
interface MultiPlatformStatusResult {
  id: string;
  platform: string;
  status: "in-sync" | "drifted" | "not-rendered";
  docsStatus?: "in-sync" | "drifted" | "not-rendered" | "no-docs";
  warning?: string;
}

/**
 * Get the sync status of a skill for a specific platform
 * AC: @multi-platform-render-cli ac-3 - Per-platform status checking
 */
async function getMultiPlatformSyncStatus(
  ctx: KspecContext,
  projectRoot: string,
  skill: LoadedSkill,
  renderer: PlatformRenderer
): Promise<MultiPlatformStatusResult> {
  // Use the renderer's drift check
  const driftStatus = await renderer.checkDrift(ctx.specDir, projectRoot, skill.id);

  // Map drift status to sync status
  let status: "in-sync" | "drifted" | "not-rendered";
  switch (driftStatus) {
    case "in-sync":
      status = "in-sync";
      break;
    case "drifted":
      status = "drifted";
      break;
    case "not-rendered":
      status = "not-rendered";
      break;
    case "no-hash":
      // No hash stored - need to check if content matches expected
      const renderedPath = path.join(
        projectRoot,
        renderer.defaultOutputDir,
        skill.id,
        "SKILL.md"
      );
      try {
        await fs.readFile(renderedPath, "utf-8");
        // File exists but no hash - treat as needing sync
        status = "drifted";
      } catch {
        status = "not-rendered";
      }
      break;
  }

  // Check docs status for this platform
  const sourceDocsDir = path.join(ctx.specDir, "skills", skill.id, "docs");
  const targetDocsDir = path.join(projectRoot, renderer.defaultOutputDir, skill.id, "docs");
  let docsStatus: "in-sync" | "drifted" | "not-rendered" | "no-docs" = "no-docs";

  try {
    await fs.stat(sourceDocsDir);
    // Source docs exist, check target
    try {
      await fs.stat(targetDocsDir);
      // Both exist, compare
      const equal = await directoriesEqual(sourceDocsDir, targetDocsDir);
      docsStatus = equal ? "in-sync" : "drifted";
    } catch {
      docsStatus = "not-rendered";
    }
  } catch {
    // No source docs
    docsStatus = "no-docs";
  }

  return {
    id: skill.id,
    platform: renderer.platform,
    status,
    docsStatus,
  };
}

/**
 * Get the expected rendered content for a skill
 */
async function getExpectedRenderedContent(
  ctx: KspecContext,
  skill: LoadedSkill
): Promise<string> {
  const sourceContent = await loadSkillContent(ctx, skill);

  if (!sourceContent) {
    // No source content, generate placeholder
    const frontmatter = generateFrontmatter(skill);
    return `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n\n# ${skill.name}\n\n${skill.description || ""}\n`;
  }

  // Generate rendered content with frontmatter and marker
  const frontmatter = generateFrontmatter(skill);

  // Check if source already has frontmatter - if so, strip it
  const frontmatterMatch = sourceContent.match(/^---\n[\s\S]*?\n---\n?/);
  const contentWithoutFrontmatter = frontmatterMatch
    ? sourceContent.slice(frontmatterMatch[0].length)
    : sourceContent;

  return `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n${contentWithoutFrontmatter}`;
}

/**
 * Generate unified diff between two strings
 * AC: @skill-render-cli ac-4
 */
function generateUnifiedDiff(
  actual: string,
  expected: string,
  actualPath: string,
  expectedPath: string
): string[] {
  if (contentsEqual(actual, expected)) {
    return [];
  }

  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const diffLines: string[] = [];

  // Simple line-by-line diff (unified format)
  diffLines.push(`--- ${actualPath}`);
  diffLines.push(`+++ ${expectedPath}`);

  // Find differing sections and create hunks
  let i = 0;
  let j = 0;

  while (i < actualLines.length || j < expectedLines.length) {
    // Find start of difference
    const contextStart = i;
    const contextStartExpected = j;

    // Skip matching lines
    while (
      i < actualLines.length &&
      j < expectedLines.length &&
      actualLines[i] === expectedLines[j]
    ) {
      i++;
      j++;
    }

    // If we've reached the end, we're done
    if (i >= actualLines.length && j >= expectedLines.length) {
      break;
    }

    // Find end of difference
    let diffEndActual = i;
    let diffEndExpected = j;

    // Collect differing lines
    while (
      diffEndActual < actualLines.length &&
      diffEndExpected < expectedLines.length &&
      actualLines[diffEndActual] !== expectedLines[diffEndExpected]
    ) {
      diffEndActual++;
      diffEndExpected++;
    }

    // Also handle case where one side has more lines
    while (diffEndActual < actualLines.length && diffEndExpected >= expectedLines.length) {
      diffEndActual++;
    }
    while (diffEndExpected < expectedLines.length && diffEndActual >= actualLines.length) {
      diffEndExpected++;
    }

    // Create hunk header (show 3 lines of context)
    const hunkStartActual = Math.max(0, contextStart - 3);
    const hunkStartExpected = Math.max(0, contextStartExpected - 3);

    // Include context after diff too
    const hunkEndActual = Math.min(actualLines.length, diffEndActual + 3);
    const hunkEndExpected = Math.min(expectedLines.length, diffEndExpected + 3);

    const actualCount = hunkEndActual - hunkStartActual;
    const expectedCount = hunkEndExpected - hunkStartExpected;

    diffLines.push(
      `@@ -${hunkStartActual + 1},${actualCount} +${hunkStartExpected + 1},${expectedCount} @@`
    );

    // Leading context
    for (let k = hunkStartActual; k < contextStart; k++) {
      diffLines.push(` ${actualLines[k]}`);
    }

    // Removed lines (from actual)
    for (let k = contextStart; k < diffEndActual; k++) {
      if (k < actualLines.length) {
        diffLines.push(`-${actualLines[k]}`);
      }
    }

    // Added lines (from expected)
    for (let k = contextStartExpected; k < diffEndExpected; k++) {
      if (k < expectedLines.length) {
        diffLines.push(`+${expectedLines[k]}`);
      }
    }

    // Trailing context
    for (let k = diffEndActual; k < hunkEndActual; k++) {
      if (k < actualLines.length) {
        diffLines.push(` ${actualLines[k]}`);
      }
    }

    i = hunkEndActual;
    j = hunkEndExpected;
  }

  return diffLines;
}

// Re-export for testing
// Re-export for testing
// AC: @consolidate-skill-render ac-1, ac-2, ac-3 - renderClaudeCodeSkill, isKspecManaged, KSPEC_MANAGED_MARKER
// are now imported from skill-render.ts and re-exported here for API compatibility
export {
  isKspecManaged,
  KSPEC_MANAGED_MARKER,
  renderClaudeCodeSkill,
  getExpectedRenderedContent,
  generateUnifiedDiff,
  loadCoreSkillsManifest,
  loadCoreSkillContent,
  getKspecPackageVersion,
};
