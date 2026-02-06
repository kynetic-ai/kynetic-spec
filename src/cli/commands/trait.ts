import chalk from "chalk";
import type { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  buildIndexes,
  checkSlugUniqueness,
  createSpecItem,
  initContext,
  type LoadedSpecItem,
  ReferenceIndex,
  updateSpecItem,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import type { SpecItemInput } from "../../schema/index.js";
import { errors } from "../../strings/errors.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output, success, warn } from "../output.js";

/**
 * Register trait commands
 */
export function registerTraitCommands(program: Command): void {
  const trait = program
    .command("trait")
    .description("Trait management commands");

  // kspec trait add <title>
  // AC: @trait-cli ac-1, ac-2
  markMutating(trait.command("add <title>"))
    .description("Create a new trait")
    .option("--description <desc>", "Trait description")
    .option("--slug <slug>", "Human-friendly slug")
    .action(async (title: string, options) => {
      try {
        const ctx = await initContext();
        const { refIndex, items } = await buildIndexes(ctx);

        // Check slug uniqueness if provided
        if (options.slug) {
          const slugCheck = checkSlugUniqueness(refIndex, [options.slug]);
          if (!slugCheck.ok) {
            error(
              errors.slug.alreadyExists(slugCheck.slug, slugCheck.existingUlid),
            );
            process.exit(EXIT_CODES.CONFLICT);
          }
        }

        // AC: @trait-cli ac-1 - create trait-type item
        const input: SpecItemInput = {
          title,
          type: "trait",
          slugs: options.slug ? [options.slug] : [],
          description: options.description, // AC: @trait-cli ac-2
          priority: undefined,
          tags: [],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: [],
          notes: [],
        };

        const newItem = createSpecItem(input);

        // Traits should be added to kynetic.yaml as root-level traits array
        // This requires manually manipulating the manifest file since it's not loaded as an item

        if (!ctx.manifestPath) {
          error("Could not find kynetic.yaml");
          process.exit(EXIT_CODES.ERROR);
        }

        const { readYamlFile, writeYamlFilePreserveFormat } = await import(
          "../../parser/yaml.js"
        );
        const manifest = await readYamlFile<Record<string, unknown>>(
          ctx.manifestPath,
        );

        if (!manifest) {
          error("Could not load kynetic.yaml");
          process.exit(EXIT_CODES.ERROR);
        }

        // Ensure traits array exists at root
        if (!Array.isArray(manifest.traits)) {
          manifest.traits = [];
        }

        // Strip metadata from newItem (_sourceFile, _path)
        const { _sourceFile, _path, ...cleanItem } = newItem as LoadedSpecItem;

        // Add trait to manifest
        (manifest.traits as unknown[]).push(cleanItem);

        await writeYamlFilePreserveFormat(ctx.manifestPath, manifest);

        // For calculating path and ref
        const traitIndex = (manifest.traits as unknown[]).length - 1;
        const result = {
          item: {
            ...newItem,
            _sourceFile: ctx.manifestPath,
            _path: `traits[${traitIndex}]`,
          } as LoadedSpecItem,
          path: `traits[${traitIndex}]`,
        };

        // Build index with new item for short ULID
        const index = new ReferenceIndex([], [...items, result.item]);
        const itemSlug =
          result.item.slugs?.[0] || index.shortUlid(result.item._ulid);

        await commitIfShadow(ctx.shadow, "trait-add", itemSlug);
        success(`Created trait: ${itemSlug}`, { trait: result.item });
      } catch (err) {
        error("Failed to create trait", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec trait list
  // AC: @trait-cli ac-3
  trait
    .command("list")
    .description("List all traits")
    .action(async () => {
      try {
        const ctx = await initContext();
        const { traitIndex } = await buildIndexes(ctx);

        const traits = traitIndex.getAllTraits();

        // AC: @trait-edge-cases ac-4
        output({ traits }, () => {
          if (traits.length === 0) {
            console.log(chalk.gray("No traits defined"));
            return;
          }

          console.log(chalk.bold("Traits"));
          console.log(chalk.gray("─".repeat(60)));

          for (const trait of traits) {
            const shortId = trait.ulid.slice(0, 8);
            const acCount = trait.acceptanceCriteria.length;
            const acInfo =
              acCount > 0
                ? chalk.gray(` (${acCount} AC)`)
                : chalk.gray(" (no AC)");

            console.log(
              `${chalk.gray(shortId)} ${trait.title} ${chalk.cyan(`@${trait.slug}`)}${acInfo}`,
            );
          }

          console.log(chalk.gray(`\n${traits.length} trait(s)`));
        });
      } catch (err) {
        error("Failed to list traits", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec trait get <ref>
  // AC: @trait-cli ac-4
  trait
    .command("get <ref>")
    .description("Show trait details")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const { refIndex, traitIndex } = await buildIndexes(ctx);

        const result = refIndex.resolve(ref);
        if (!result.ok) {
          error(errors.reference.itemNotFound(ref));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        const item = result.item as LoadedSpecItem;

        // Verify it's a trait
        if (item.type !== "trait") {
          error(`Item ${ref} is not a trait (type: ${item.type})`);
          process.exit(EXIT_CODES.ERROR);
        }

        const trait = traitIndex.getTrait(item._ulid);
        if (!trait) {
          error(`Trait ${ref} not found in trait index`);
          process.exit(EXIT_CODES.ERROR);
        }

        const specsUsingTrait = traitIndex.getSpecsForTrait(item._ulid);

        output({ trait, specs_using_trait: specsUsingTrait }, () => {
          console.log(chalk.bold(trait.title));
          console.log(chalk.gray("─".repeat(40)));
          console.log(`ULID:      ${trait.ulid}`);
          console.log(`Slug:      @${trait.slug}`);
          console.log(`Type:      trait`);

          if (trait.description) {
            console.log("\n─── Description ───");
            console.log(trait.description);
          }

          // AC: @trait-cli ac-4 - show acceptance criteria
          if (trait.acceptanceCriteria.length > 0) {
            console.log("\n─── Acceptance Criteria ───");
            for (const ac of trait.acceptanceCriteria) {
              console.log(chalk.cyan(`  [${ac.id}]`));
              if (ac.given) console.log(`    Given: ${ac.given}`);
              if (ac.when) console.log(`    When: ${ac.when}`);
              if (ac.then) console.log(`    Then: ${ac.then}`);
            }
          }

          if (specsUsingTrait.length > 0) {
            console.log(
              chalk.gray(`\nUsed by ${specsUsingTrait.length} spec(s)`),
            );
          }
        });
      } catch (err) {
        error("Failed to get trait", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

/**
 * Register item trait subcommands (for adding/removing traits from specs)
 */
export function registerItemTraitCommands(itemCommand: Command): void {
  const traitCmd = itemCommand
    .command("trait")
    .description("Manage traits on spec items");

  // kspec item trait add <spec-ref> <trait-refs...>
  // AC: @trait-cli ac-5, ac-6, ac-7, ac-9, ac-10
  markMutating(traitCmd.command("add <specRef> <traitRefs...>"))
    .description("Add one or more traits to a spec item")
    .action(async (specRef: string, traitRefs: string[]) => {
      try {
        const ctx = await initContext();
        const { refIndex, items } = await buildIndexes(ctx);

        // Resolve spec
        const specResult = refIndex.resolve(specRef);
        if (!specResult.ok) {
          error(errors.reference.itemNotFound(specRef));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        const spec = specResult.item as LoadedSpecItem;

        // Check if it's a task
        if ("status" in spec && typeof spec.status === "string") {
          error(`Cannot add traits to tasks. ${specRef} is a task.`);
          process.exit(EXIT_CODES.ERROR);
        }

        let currentTraits = spec.traits || [];
        const results: Array<{ trait: string; added: boolean }> = [];

        for (const traitRef of traitRefs) {
          // AC: @trait-cli ac-7 - verify trait exists
          const traitResult = refIndex.resolve(traitRef);
          if (!traitResult.ok) {
            error(`Trait not found: ${traitRef}`);
            process.exit(EXIT_CODES.NOT_FOUND);
          }

          const traitItem = traitResult.item as LoadedSpecItem;
          if (traitItem.type !== "trait") {
            error(`${traitRef} is not a trait (type: ${traitItem.type})`);
            process.exit(EXIT_CODES.ERROR);
          }

          const traitRefString = `@${traitItem.slugs[0] || traitItem._ulid}`;

          // AC: @trait-cli ac-6, ac-10 - idempotent (skip existing)
          if (currentTraits.includes(traitRefString)) {
            warn(
              `Spec already has trait ${traitRefString} (skipped)`,
            );
            results.push({ trait: traitRefString, added: false });
            continue;
          }

          // AC: @trait-cli ac-5, ac-9 - add trait to traits array
          currentTraits = [...currentTraits, traitRefString];
          results.push({ trait: traitRefString, added: true });
        }

        const added = results.filter((r) => r.added);
        const specSlug = spec.slugs[0] || refIndex.shortUlid(spec._ulid);
        if (added.length > 0) {
          await updateSpecItem(ctx, spec, { traits: currentTraits });
          await commitIfShadow(ctx.shadow, "item-trait-add", specSlug);

          const traitNames = added.map((r) => r.trait).join(", ");
          success(`Added ${traitNames} to ${specSlug}`, {
            spec: specSlug,
            trait: results[0].trait,
            added: results[0].added,
            results,
          });
        } else {
          output(
            {
              spec: specSlug,
              trait: results[0].trait,
              added: false,
              results,
            },
            () => {
              warn("No new traits added (all already present)");
            },
          );
        }
      } catch (err) {
        error("Failed to add trait to spec", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item trait remove <spec-ref> <trait-refs...>
  // AC: @trait-cli ac-8, ac-11
  markMutating(traitCmd.command("remove <specRef> <traitRefs...>"))
    .description("Remove one or more traits from a spec item")
    .action(async (specRef: string, traitRefs: string[]) => {
      try {
        const ctx = await initContext();
        const { refIndex } = await buildIndexes(ctx);

        // Resolve spec
        const specResult = refIndex.resolve(specRef);
        if (!specResult.ok) {
          error(errors.reference.itemNotFound(specRef));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        const spec = specResult.item as LoadedSpecItem;

        // Check if it's a task
        if ("status" in spec && typeof spec.status === "string") {
          error(`Cannot remove traits from tasks. ${specRef} is a task.`);
          process.exit(EXIT_CODES.ERROR);
        }

        let currentTraits = spec.traits || [];
        const results: Array<{ trait: string; removed: boolean }> = [];

        for (const traitRef of traitRefs) {
          // Resolve trait to get its ref format
          const traitResult = refIndex.resolve(traitRef);
          if (!traitResult.ok) {
            error(`Trait not found: ${traitRef}`);
            process.exit(EXIT_CODES.NOT_FOUND);
          }

          const traitItem = traitResult.item as LoadedSpecItem;
          const traitRefString = `@${traitItem.slugs[0] || traitItem._ulid}`;

          // AC: @trait-cli ac-8, ac-11 - remove from traits array
          if (!currentTraits.includes(traitRefString)) {
            warn(`Spec does not have trait ${traitRefString} (skipped)`);
            results.push({ trait: traitRefString, removed: false });
            continue;
          }

          currentTraits = currentTraits.filter((t) => t !== traitRefString);
          results.push({ trait: traitRefString, removed: true });
        }

        const removed = results.filter((r) => r.removed);
        const specSlug = spec.slugs[0] || refIndex.shortUlid(spec._ulid);
        if (removed.length > 0) {
          await updateSpecItem(ctx, spec, { traits: currentTraits });
          await commitIfShadow(ctx.shadow, "item-trait-remove", specSlug);

          const traitNames = removed.map((r) => r.trait).join(", ");
          success(`Removed ${traitNames} from ${specSlug}`, {
            spec: specSlug,
            trait: results[0].trait,
            removed: results[0].removed,
            results,
          });
        } else {
          output(
            {
              spec: specSlug,
              trait: results[0].trait,
              removed: false,
              results,
            },
            () => {
              warn("No traits removed (none were present)");
            },
          );
        }
      } catch (err) {
        error("Failed to remove trait from spec", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
