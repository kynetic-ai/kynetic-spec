import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { ulid } from "ulid";
import {
  buildIndexes,
  checkSlugUniqueness,
  initContext,
  writeYamlFilePreserveFormat,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import type { SpecItem } from "../../schema/index.js";
import { errors } from "../../strings/errors.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, success } from "../output.js";

/**
 * Register module commands
 */
export function registerModuleCommands(program: Command): void {
  const module = program
    .command("module")
    .description("Module management commands");

  // kspec module add - create a new module YAML file
  module
    .command("add")
    .description("Create a new module YAML file")
    .requiredOption("--title <title>", "Module title")
    .requiredOption("--slug <slug>", "Module slug (becomes filename)")
    .option("--description <desc>", "Module description")
    .option("--tag <tag...>", "Tags")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const { refIndex } = await buildIndexes(ctx);

        if (!ctx.manifest || !ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        // Check slug uniqueness
        if (options.slug) {
          const slugCheck = checkSlugUniqueness(refIndex, [options.slug]);
          if (!slugCheck.ok) {
            error(
              errors.slug.alreadyExists(slugCheck.slug, slugCheck.existingUlid),
            );
            process.exit(EXIT_CODES.CONFLICT);
          }
        }

        // Create module spec item
        const moduleItem: SpecItem = {
          _ulid: ulid(),
          slugs: [options.slug],
          title: options.title,
          type: "module",
          status: {
            maturity: "draft",
            implementation: "not_started",
          },
          description: options.description || "",
          tags: options.tag || [],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          notes: [],
        };

        // Determine module file path
        const manifestDir = path.dirname(ctx.manifestPath);
        const modulesDir = path.join(manifestDir, "modules");
        const moduleFilePath = path.join(modulesDir, `${options.slug}.yaml`);

        // Ensure modules directory exists
        await fs.mkdir(modulesDir, { recursive: true });

        // Check if module file already exists
        try {
          await fs.access(moduleFilePath);
          error(errors.conflict.moduleFileExists(moduleFilePath));
          process.exit(EXIT_CODES.CONFLICT);
        } catch {
          // File doesn't exist, which is what we want
        }

        // Write module file
        await writeYamlFilePreserveFormat(moduleFilePath, moduleItem);

        // Update manifest includes
        const manifest = ctx.manifest;
        const includeEntry = `modules/${options.slug}.yaml`;

        if (!manifest.includes) {
          manifest.includes = [];
        }

        // Check if already in includes (shouldn't happen, but be safe)
        if (!manifest.includes.includes(includeEntry)) {
          manifest.includes.push(includeEntry);
        }

        // Write updated manifest
        await writeYamlFilePreserveFormat(ctx.manifestPath, manifest);

        // Auto-commit to shadow if enabled
        await commitIfShadow(ctx.shadow, "module-add", options.slug);

        success(`Created module: @${options.slug}`, {
          module: moduleItem,
          path: moduleFilePath,
          includedInManifest: true,
        });
      } catch (err) {
        error("Failed to create module", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
