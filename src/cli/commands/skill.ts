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
  type Skill,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { SkillSchema, type SkillOrigin } from "../../schema/index.js";
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

        // Build skill object
        const skillData: Skill = {
          _ulid: ulid(),
          id: options.id,
          name: options.name,
          description: options.description,
          origin: options.origin as SkillOrigin,
          version: options.skillVersion,
          platforms:
            options.platform && options.platform.length > 0
              ? options.platform
              : ["claude-code"],
          depends_on:
            options.dependsOn && options.dependsOn.length > 0
              ? options.dependsOn
              : [],
          tags:
            options.tag && options.tag.length > 0
              ? parseTagsArray(options.tag)
              : [],
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

        // Validate updated skill
        const parsed = SkillSchema.safeParse(skill);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          error(`Invalid skill data: ${issues}`);
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
        const frontmatter = parseFrontmatter(content);

        // Determine name and description from frontmatter or options
        const skillName = options.name || frontmatter?.name;
        const skillDescription = options.description || frontmatter?.description;

        // AC: @skill-import ac-6 - Error if no name/description and no frontmatter
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

        // Build skill object
        const skillData: Skill = {
          _ulid: ulid(),
          id: skillId,
          name: skillName,
          description: skillDescription,
          origin: options.origin as SkillOrigin,
          version: options.skillVersion,
          platforms: ["claude-code"],
          depends_on: [],
          tags: [],
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
        const normalizedContent = normalizeBaseDirectory(content);

        // AC: @skill-import ac-2 - Copy content to .kspec/skills/<id>/SKILL.md
        const skillMdPath = getSkillContentPath(ctx, skill.id);
        await fs.writeFile(skillMdPath, normalizedContent, "utf-8");

        // AC: @skill-import ac-3 - Copy docs/ subdirectory if present
        const sourceDocsDir = path.join(sourceDir, "docs");
        try {
          const docsStats = await fs.stat(sourceDocsDir);
          if (docsStats.isDirectory()) {
            const targetDocsDir = path.join(ctx.specDir, "skills", skill.id, "docs");
            await fs.mkdir(targetDocsDir, { recursive: true });
            await copyDirectory(sourceDocsDir, targetDocsDir);
          }
        } catch {
          // No docs directory, that's fine
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

/**
 * Parse YAML frontmatter from markdown content.
 * Returns null if no valid frontmatter found.
 */
function parseFrontmatter(content: string): { name?: string; description?: string } | null {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return null;
  }

  try {
    const parsed = yaml.parse(match[1]);

    if (typeof parsed === "object" && parsed !== null) {
      return {
        name: typeof parsed.name === "string" ? parsed.name : undefined,
        description: typeof parsed.description === "string" ? parsed.description : undefined,
      };
    }
  } catch {
    // Invalid YAML in frontmatter
  }

  return null;
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
  // Remove or normalize "Base directory for this skill:" lines with absolute paths
  // Common pattern in Claude-generated skill files
  const baseDirLineRegex = /^Base directory for this skill:.*$/gm;

  return content.replace(baseDirLineRegex, "");
}

/**
 * Recursively copy a directory
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
