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
  type KspecContext,
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

  // AC: @skill-rendering ac-1 through ac-5 - kspec skill render
  // AC: @skill-render-cli ac-1, ac-2 - kspec skill render / kspec skill render @skill-id
  // AC: @trait-dry-run - supports --dry-run
  // AC: @trait-error-guidance - provides error guidance
  skill
    .command("render [ref]")
    .description(
      "Render skills from shadow branch to platform-specific files on main branch"
    )
    .option("--clean", "Remove orphaned managed skill directories")
    .option("--dry-run", "Show what would be changed without applying")
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
        const results: SkillRenderResult[] = [];
        const cleanResults: CleanResult[] = [];

        // Filter skills by platform (only claude-code for now)
        let skillsToRender = metaCtx.skills.filter((s) =>
          s.platforms.includes("claude-code")
        );

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
          if (skillsToRender.length === 0) {
            error(`Skill '${skill.id}' does not have claude-code platform`);
            process.exit(EXIT_CODES.ERROR);
          }
        }

        // Ensure .claude/skills directory exists
        const targetSkillsDir = path.join(projectRoot, ".claude", "skills");
        if (!dryRun) {
          await fs.mkdir(targetSkillsDir, { recursive: true });
        }

        // Render each skill
        for (const skill of skillsToRender) {
          const result = await renderSkill(ctx, projectRoot, skill, dryRun);
          results.push(result);
        }

        // Handle --clean: remove orphaned managed skills
        // AC: @skill-rendering ac-4, ac-5
        if (options.clean) {
          const activeSkillIds = new Set(metaCtx.skills.map((s) => s.id));

          try {
            const entries = await fs.readdir(targetSkillsDir, {
              withFileTypes: true,
            });

            for (const entry of entries) {
              if (!entry.isDirectory()) continue;

              const skillId = entry.name;
              const skillDir = path.join(targetSkillsDir, skillId);
              const skillMdPath = path.join(skillDir, "SKILL.md");

              // Skip if skill still exists in meta
              if (activeSkillIds.has(skillId)) continue;

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
                });
              } else {
                cleanResults.push({
                  id: skillId,
                  path: skillDir,
                  action: "skipped",
                  reason: "Not managed by kspec",
                });
              }
            }
          } catch {
            // No .claude/skills directory, nothing to clean
          }
        }

        // Output results
        // AC: @trait-dry-run ac-6 - JSON output includes dry_run field
        output(
          {
            dry_run: dryRun,
            rendered: results,
            cleaned: cleanResults,
          },
          () => {
            // AC: @trait-dry-run ac-3 - Clear indication this is a preview
            if (dryRun) {
              console.log(chalk.yellow("DRY RUN - No changes made"));
              console.log();
            }

            // Render results
            const created = results.filter((r) => r.action === "created");
            const updated = results.filter((r) => r.action === "updated");
            const unchanged = results.filter((r) => r.action === "unchanged");

            if (created.length > 0) {
              console.log(chalk.green(`Created: ${created.length} skill(s)`));
              for (const r of created) {
                console.log(`  ${chalk.green("+")} ${r.id}`);
              }
            }

            if (updated.length > 0) {
              console.log(chalk.blue(`Updated: ${updated.length} skill(s)`));
              for (const r of updated) {
                console.log(`  ${chalk.blue("~")} ${r.id}`);
              }
            }

            if (unchanged.length > 0 && results.length <= 10) {
              console.log(chalk.gray(`Unchanged: ${unchanged.length} skill(s)`));
            }

            // Clean results
            if (cleanResults.length > 0) {
              const removed = cleanResults.filter((r) => r.action === "removed");
              const skipped = cleanResults.filter((r) => r.action === "skipped");

              if (removed.length > 0) {
                console.log();
                console.log(chalk.red(`Removed: ${removed.length} orphaned skill(s)`));
                for (const r of removed) {
                  console.log(`  ${chalk.red("-")} ${r.id}`);
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

        // Filter skills by platform (only claude-code for now)
        const skillsToCheck = metaCtx.skills.filter((s) =>
          s.platforms.includes("claude-code")
        );

        if (skillsToCheck.length === 0) {
          console.log(chalk.yellow("No skills found"));
          return;
        }

        const statusResults: SkillStatusResult[] = [];

        for (const skill of skillsToCheck) {
          const status = await getSkillSyncStatus(ctx, projectRoot, skill);
          statusResults.push(status);
        }

        // Output results
        output(
          statusResults,
          () => {
            const table = new Table({
              head: [
                chalk.bold("ID"),
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
                statusColor(result.status),
                docsStatusColor(result.docsStatus || "-"),
              ]);
            }

            console.log(table.toString());

            // Summary
            const inSync = statusResults.filter((r) => r.status === "in-sync").length;
            const drifted = statusResults.filter((r) => r.status === "drifted").length;
            const notRendered = statusResults.filter((r) => r.status === "not-rendered").length;

            console.log();
            if (drifted > 0) {
              console.log(chalk.yellow(`${drifted} skill(s) drifted - run 'kspec skill render' to sync`));
            }
            if (notRendered > 0) {
              console.log(chalk.gray(`${notRendered} skill(s) not rendered`));
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

/**
 * Marker comment that identifies skill directories managed by kspec
 * AC: @skill-rendering ac-4 - Only skill directories that were rendered by kspec are considered
 */
const KSPEC_MANAGED_MARKER = "<!-- kspec-managed -->";

/**
 * Result of rendering a single skill
 */
interface SkillRenderResult {
  id: string;
  action: "created" | "updated" | "unchanged";
  path: string;
  docsAction?: "created" | "updated" | "unchanged" | "skipped";
}

/**
 * Result of a clean operation
 */
interface CleanResult {
  id: string;
  path: string;
  action: "removed" | "skipped";
  reason?: string;
}

/**
 * Generate YAML frontmatter for a skill
 * AC: @skill-rendering ac-1 - .claude/skills/<id>/SKILL.md is created with YAML frontmatter
 */
function generateFrontmatter(skill: LoadedSkill): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.id,
    description: skill.description || skill.name,
  };
  return `---\n${yaml.stringify(frontmatter).trim()}\n---`;
}

/**
 * Check if two contents are equal (for idempotency check)
 */
function contentsEqual(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Check if a directory is managed by kspec
 * AC: @skill-rendering ac-4 - Only skill directories rendered by kspec are considered
 */
async function isKspecManaged(skillMdPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(skillMdPath, "utf-8");
    return content.includes(KSPEC_MANAGED_MARKER);
  } catch {
    return false;
  }
}

/**
 * Recursively check if two directories have the same contents
 */
async function directoriesEqual(src: string, dest: string): Promise<boolean> {
  try {
    const srcEntries = await fs.readdir(src, { withFileTypes: true });
    const destEntries = await fs.readdir(dest, { withFileTypes: true });

    // Different number of entries = not equal
    if (srcEntries.length !== destEntries.length) {
      return false;
    }

    // Create a map of dest entries for quick lookup
    const destMap = new Map(destEntries.map((e) => [e.name, e]));

    for (const srcEntry of srcEntries) {
      const destEntry = destMap.get(srcEntry.name);
      if (!destEntry) {
        return false;
      }

      const srcPath = path.join(src, srcEntry.name);
      const destPath = path.join(dest, srcEntry.name);

      if (srcEntry.isDirectory() && destEntry.isDirectory()) {
        if (!(await directoriesEqual(srcPath, destPath))) {
          return false;
        }
      } else if (srcEntry.isFile() && destEntry.isFile()) {
        const srcContent = await fs.readFile(srcPath, "utf-8");
        const destContent = await fs.readFile(destPath, "utf-8");
        if (!contentsEqual(srcContent, destContent)) {
          return false;
        }
      } else {
        // Type mismatch
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Get the target path for rendered skills (main branch .claude/skills/)
 */
function getRenderedSkillPath(projectRoot: string, skillId: string): string {
  return path.join(projectRoot, ".claude", "skills", skillId);
}

/**
 * Render a single skill from shadow branch to main branch.
 * AC: @skill-rendering ac-1 - Creates .claude/skills/<id>/SKILL.md with YAML frontmatter
 * AC: @skill-rendering ac-2 - Copies docs to .claude/skills/<id>/docs/
 * AC: @skill-rendering ac-3 - Idempotent (no changes if content unchanged)
 */
async function renderSkill(
  ctx: KspecContext,
  projectRoot: string,
  skill: LoadedSkill,
  dryRun: boolean
): Promise<SkillRenderResult> {
  const targetDir = getRenderedSkillPath(projectRoot, skill.id);
  const targetSkillMd = path.join(targetDir, "SKILL.md");

  // Load source content
  const sourceContent = await loadSkillContent(ctx, skill);
  if (!sourceContent) {
    // No source content, but skill exists in meta - create placeholder
    const frontmatter = generateFrontmatter(skill);
    const renderedContent = `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n\n# ${skill.name}\n\n${skill.description || ""}\n`;

    if (!dryRun) {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(targetSkillMd, renderedContent, "utf-8");
    }

    return {
      id: skill.id,
      action: "created",
      path: targetSkillMd,
    };
  }

  // Generate rendered content with frontmatter and marker
  const frontmatter = generateFrontmatter(skill);

  // Check if source already has frontmatter - if so, strip it
  const frontmatterMatch = sourceContent.match(/^---\n[\s\S]*?\n---\n?/);
  const contentWithoutFrontmatter = frontmatterMatch
    ? sourceContent.slice(frontmatterMatch[0].length)
    : sourceContent;

  // Build the rendered content
  const renderedContent = `${frontmatter}\n${KSPEC_MANAGED_MARKER}\n${contentWithoutFrontmatter}`;

  // Check if target exists and compare for idempotency
  // AC: @skill-rendering ac-3 - No changes if content unchanged
  let targetExists = false;
  let targetContent = "";
  try {
    targetContent = await fs.readFile(targetSkillMd, "utf-8");
    targetExists = true;
  } catch {
    // Target doesn't exist
  }

  // Determine action based on comparison
  let action: "created" | "updated" | "unchanged";

  if (!targetExists) {
    action = "created";
  } else if (contentsEqual(renderedContent, targetContent)) {
    action = "unchanged";
  } else {
    action = "updated";
  }

  // Apply changes if not dry run and there are changes
  if (!dryRun && action !== "unchanged") {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetSkillMd, renderedContent, "utf-8");
  }

  // Handle docs directory
  // AC: @skill-rendering ac-2 - Copy docs to target
  const sourceDocsDir = path.join(ctx.specDir, "skills", skill.id, "docs");
  const targetDocsDir = path.join(targetDir, "docs");
  let docsAction: "created" | "updated" | "unchanged" | "skipped" = "skipped";

  try {
    const stats = await fs.stat(sourceDocsDir);
    if (stats.isDirectory()) {
      // Check if target docs exist and compare
      let targetDocsExist = false;
      try {
        await fs.stat(targetDocsDir);
        targetDocsExist = true;
      } catch {
        // Target docs don't exist
      }

      if (!targetDocsExist) {
        docsAction = "created";
      } else {
        // Compare directories
        const equal = await directoriesEqual(sourceDocsDir, targetDocsDir);
        docsAction = equal ? "unchanged" : "updated";
      }

      // Apply changes
      if (!dryRun && docsAction !== "unchanged") {
        // Remove existing docs and copy fresh
        if (targetDocsExist) {
          await fs.rm(targetDocsDir, { recursive: true, force: true });
        }
        await fs.mkdir(targetDocsDir, { recursive: true });
        await copyDirectory(sourceDocsDir, targetDocsDir);
      }
    }
  } catch {
    // No source docs directory
  }

  return {
    id: skill.id,
    action,
    path: targetSkillMd,
    docsAction,
  };
}

/**
 * Result of checking a skill's sync status
 * AC: @skill-render-cli ac-3
 */
interface SkillStatusResult {
  id: string;
  status: "in-sync" | "drifted" | "not-rendered";
  docsStatus?: "in-sync" | "drifted" | "not-rendered" | "no-docs";
}

/**
 * Get the sync status of a skill
 * AC: @skill-render-cli ac-3
 */
async function getSkillSyncStatus(
  ctx: KspecContext,
  projectRoot: string,
  skill: LoadedSkill
): Promise<SkillStatusResult> {
  const expectedContent = await getExpectedRenderedContent(ctx, skill);
  const renderedPath = path.join(
    projectRoot,
    ".claude",
    "skills",
    skill.id,
    "SKILL.md"
  );

  let actualContent = "";
  let status: "in-sync" | "drifted" | "not-rendered" = "not-rendered";

  try {
    actualContent = await fs.readFile(renderedPath, "utf-8");
    status = contentsEqual(expectedContent, actualContent) ? "in-sync" : "drifted";
  } catch {
    // File doesn't exist
    status = "not-rendered";
  }

  // Check docs status
  const sourceDocsDir = path.join(ctx.specDir, "skills", skill.id, "docs");
  const targetDocsDir = path.join(projectRoot, ".claude", "skills", skill.id, "docs");
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
export {
  renderSkill,
  isKspecManaged,
  KSPEC_MANAGED_MARKER,
  getSkillSyncStatus,
  getExpectedRenderedContent,
  generateUnifiedDiff,
};
