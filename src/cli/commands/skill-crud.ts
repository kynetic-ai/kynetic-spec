/**
 * Skill CRUD commands: list, add, get, set, delete, import
 *
 * AC: @skill-cli ac-1 - kspec skill list outputs table with ID, Name, Origin, Version, Platforms
 * AC: @skill-cli ac-2 - kspec skill list --json outputs JSON array with full skill metadata
 * AC: @skill-cli ac-3 - kspec skill add creates meta entry with origin custom
 * AC: @skill-cli ac-4 - kspec skill add creates .kspec/skills/<id>/SKILL.md
 * AC: @skill-cli ac-5 - kspec skill get outputs metadata including id, name, origin, platforms
 * AC: @skill-cli ac-6 - kspec skill get outputs SKILL.md content
 * AC: @skill-cli ac-7 - kspec skill delete --confirm removes meta entry
 * AC: @skill-cli ac-8 - kspec skill delete removes .kspec/skills/<id>/ directory
 */

import * as fs from "node:fs/promises";
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
  loadMetaContext,
  loadSkillContent,
  loadSkillDocs,
  type LoadedSkill,
  saveMetaItem,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { copyDirectory } from "../../parser/skill-render.js";
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

// ============================================================================
// Frontmatter & Content Processing
// ============================================================================

/**
 * Parsed frontmatter from Agent Skills SKILL.md
 * AC: @import-frontmatter-strip ac-1 - All recognized Agent Skills fields
 * AC: @import-frontmatter-strip ac-3 - Claude Code platform-specific fields
 */
export interface ParsedFrontmatter {
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
export function parseFrontmatter(content: string): ParsedFrontmatter | null {
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
export function stripFrontmatter(content: string): string {
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
export function normalizeBaseDirectory(content: string): string {
  // Remove or normalize "Base directory for/of [this] skill:" lines with absolute paths
  // Common pattern in Claude-generated skill files
  // AC: @cross-platform-and-version-robustness ac-5 - case-insensitive with wording variations
  const baseDirLineRegex = /^base\s+directory\s+(?:for|of)\s+(?:this\s+)?skill:.*$/gim;

  return content.replace(baseDirLineRegex, "");
}

// ============================================================================
// Formatting Helpers
// ============================================================================

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

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Register CRUD skill commands (list, add, get, set, delete, import)
 */
export function registerSkillCrudCommands(skill: Command): void {
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
        let platformConfig: PlatformConfig | undefined;
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
}
