import chalk from "chalk";
import type { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  AlignmentIndex,
  addProjectLevelTraitItem,
  addChildItem,
  type BulkPatchResult,
  buildIndexes,
  checkSlugUniqueness,
  createNote,
  createSpecItem,
  deleteSpecItem,
  findChildItems,
  findDescendantItems,
  findTraitImplementors,
  initContext,
  type KspecContext,
  type LoadedSpecItem,
  type LoadedTask,
  loadAllItems,
  loadMetaContext,
  type PatchOperation,
  patchSpecItems,
  ReferenceIndex,
  resolveMetaRef,
  shortestUniqueUlid,
  updateSpecItem,
  validateSpecItemPatchData,
} from "../../parser/index.js";
import {
  resolveTaskDataManager,
  type ShadowCommitOptions,
} from "../../parser/task-data-manager.js";
import type { ItemFilter } from "../../parser/items.js";
import { commitIfShadow } from "../../parser/shadow.js";
import type {
  AcceptanceCriterion,
  ImplementationStatus,
  ItemType,
  Maturity,
  SpecItemInput,
} from "../../schema/index.js";
import { ItemTypeSchema } from "../../schema/index.js";
import { AcIdSchema, ImplementationStatusSchema, MaturitySchema } from "../../schema/common.js";
import { errors } from "../../strings/errors.js";
import { fieldLabels, sectionHeaders } from "../../strings/labels.js";
import { formatMatchedFields, grepItem } from "../../utils/grep.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, isJsonMode, output, showChangeDiff, success, warn } from "../output.js";
import { resolveCliActor } from "../actor.js";
import { parseTagsArray } from "../parse-utils.js";
import { validateEnumOption } from "../validators.js";

/**
 * Serialize a LoadedSpecItem for JSON output.
 * Strips internal fields (_sourceFile, _path), renames _ulid → ulid,
 * and adds a ref field with @ prefix for the primary slug.
 * AC: @trait-json-output ac-4
 */
function serializeSpecItemForJson(item: LoadedSpecItem): Record<string, unknown> {
  const { _sourceFile, _path, _ulid, ...rest } = item;
  return {
    ulid: _ulid,
    ref: item.slugs.length > 0 ? `@${item.slugs[0]}` : `@${_ulid}`,
    ...rest,
  };
}

/**
 * Format a spec item for display
 */
function formatItem(
  item: LoadedSpecItem,
  refIndex: ReferenceIndex,
  verbose = false,
  grepPattern?: string,
): string {
  const shortId = refIndex.shortUlid(item._ulid);
  const slugStr = item.slugs.length > 0 ? chalk.cyan(`@${item.slugs[0]}`) : "";
  const typeStr = chalk.gray(`[${item.type}]`);

  let status = "";
  if (item.status && typeof item.status === "object") {
    const s = item.status as { maturity?: string; implementation?: string };
    if (s.implementation) {
      const implColor =
        s.implementation === "verified"
          ? chalk.green
          : s.implementation === "implemented"
            ? chalk.cyan
            : s.implementation === "in_progress"
              ? chalk.yellow
              : chalk.gray;
      status = implColor(s.implementation);
    } else if (s.maturity) {
      status = chalk.gray(s.maturity);
    }
  }

  let line = `${chalk.gray(shortId)} ${typeStr} ${item.title}`;
  if (slugStr) line += ` ${slugStr}`;
  if (status) line += ` ${status}`;

  if (verbose) {
    const tags = "tags" in item && Array.isArray(item.tags) ? item.tags : [];
    if (tags.length > 0) {
      line += chalk.blue(` #${tags.join(" #")}`);
    }
  }

  // Show matched fields if grep pattern provided
  if (grepPattern) {
    const match = grepItem(item as unknown as Record<string, unknown>, grepPattern);
    if (match && match.matchedFields.length > 0) {
      line += `\n  ${chalk.gray(`matched: ${formatMatchedFields(match.matchedFields)}`)}`;
    }
  }

  return line;
}

/**
 * Format item list for display
 */
function formatItemList(
  items: LoadedSpecItem[],
  refIndex: ReferenceIndex,
  verbose = false,
  grepPattern?: string,
): void {
  if (items.length === 0) {
    console.log(chalk.gray("No items found"));
    return;
  }

  for (const item of items) {
    console.log(formatItem(item, refIndex, verbose, grepPattern));
  }

  console.log(chalk.gray(`\n${items.length} item(s)`));
}

/**
 * Format item list as a tree showing parent/child hierarchy
 */
function formatItemTree(
  items: LoadedSpecItem[],
  refIndex: ReferenceIndex,
  verbose = false,
  grepPattern?: string,
): void {
  if (items.length === 0) {
    console.log(chalk.gray("No items found"));
    return;
  }

  // Build parent-child map
  const childrenMap = new Map<string, LoadedSpecItem[]>();
  const rootItems: LoadedSpecItem[] = [];

  for (const item of items) {
    const path = item._path || "";

    // Determine parent path
    let parentPath = "";
    if (path) {
      // Extract parent path from current path
      // e.g., "features[0].requirements[1]" -> "features[0]"
      const lastDotIndex = path.lastIndexOf(".");
      if (lastDotIndex !== -1) {
        parentPath = path.substring(0, lastDotIndex);
      }
    }

    if (parentPath === "") {
      // Root level item
      rootItems.push(item);
    } else {
      // Find parent by path
      const parent = items.find((i) => i._path === parentPath);
      if (parent) {
        const parentUlid = parent._ulid;
        if (!childrenMap.has(parentUlid)) {
          childrenMap.set(parentUlid, []);
        }
        childrenMap.get(parentUlid)?.push(item);
      } else {
        // Parent not in filtered list, show at root
        rootItems.push(item);
      }
    }
  }

  // Recursive function to print tree
  function printTree(item: LoadedSpecItem, prefix = "", isLast = true): void {
    // Print current item with tree prefix
    const connector = isLast ? "└── " : "├── ";
    const itemLine = formatItem(item, refIndex, verbose, grepPattern);
    console.log(prefix + connector + itemLine);

    // Print children
    const children = childrenMap.get(item._ulid) || [];
    const childPrefix = prefix + (isLast ? "    " : "│   ");

    children.forEach((child, index) => {
      const isLastChild = index === children.length - 1;
      printTree(child, childPrefix, isLastChild);
    });
  }

  // Print all root items
  rootItems.forEach((item, index) => {
    const isLast = index === rootItems.length - 1;
    printTree(item, "", isLast);
  });

  console.log(chalk.gray(`\n${items.length} item(s)`));
}

/**
 * Handle cascading status updates to child items
 * Returns array of updated child items
 */
async function handleStatusCascade(
  ctx: Awaited<ReturnType<typeof initContext>>,
  parent: LoadedSpecItem,
  newStatus: string,
  allItems: LoadedSpecItem[],
  refIndex: ReferenceIndex,
): Promise<LoadedSpecItem[]> {
  // Find direct children
  const children = findChildItems(parent, allItems);

  if (children.length === 0) {
    return [];
  }

  // Skip prompt in JSON mode
  if (isJsonMode()) {
    return [];
  }

  // Prompt user for cascade
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(`Update ${children.length} child item(s) to ${newStatus}? [y/n] `, resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== "y") {
    return [];
  }

  // Update children
  const updatedChildren: LoadedSpecItem[] = [];
  for (const child of children) {
    const currentStatus =
      child.status && typeof child.status === "object"
        ? child.status
        : {
            maturity: "draft" as const,
            implementation: "not_started" as const,
          };

    const updates = {
      status: {
        maturity: currentStatus.maturity || ("draft" as const),
        implementation: newStatus as ImplementationStatus,
      },
    };

    const updated = await updateSpecItem(ctx, child, updates);
    updatedChildren.push(updated);

    // Log each child update (non-JSON mode only)
    const childRef = child.slugs[0] || refIndex.shortUlid(child._ulid);
    console.log(chalk.gray(`  ✓ Updated @${childRef}`));
  }

  return updatedChildren;
}

/**
 * Register item commands
 */
export function registerItemCommands(program: Command): void {
  const item = program.command("item").description("Spec item commands");

  // kspec item list
  item
    .command("list")
    .description("List spec items with optional filters")
    .option(
      "-t, --type <type>",
      "Filter by item type (module, feature, requirement, constraint, decision)",
    )
    .option(
      "-s, --status <status>",
      "Filter by implementation status (not_started, in_progress, implemented, verified)",
    )
    .option(
      "-m, --maturity <maturity>",
      "Filter by maturity (draft, proposed, stable, deferred, deprecated)",
    )
    .option(
      "--tag <tag>",
      "Filter by tag (can specify multiple)",
      (val, prev: string[]) => [...prev, val],
      [],
    )
    .option(
      "--has <field>",
      "Filter items that have field present",
      (val, prev: string[]) => [...prev, val],
      [],
    )
    .option("-q, --search <text>", "Search in title")
    .option("-g, --grep <pattern>", "Search content with regex pattern")
    .option("-v, --verbose", "Show more details")
    .option("--tree", "Show parent/child hierarchy")
    .option("--under <ref>", "Scope to descendants of a module or parent item")
    .option("--limit <n>", "Limit results", "50")
    .option("--count", "Show only the count of matching items")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const { itemIndex, items, refIndex } = await buildIndexes(ctx);

        // Build filter from options
        const filter: ItemFilter = {
          specItemsOnly: true, // Only spec items, not tasks
        };

        if (options.type) {
          const typeResult = validateEnumOption(options.type, ItemTypeSchema.options, "item type");
          if (!typeResult.ok) {
            error(typeResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          filter.type = typeResult.value as ItemType;
        }

        // AC: @multi-value-status-filter ac-item-list-parity, ac-invalid-item-status
        if (options.status) {
          const { parseMultiStatus } = await import("./tasks.js");
          const statuses = parseMultiStatus(
            options.status,
            ImplementationStatusSchema.options,
            "implementation status",
          );
          if (statuses) {
            filter.implementation = statuses.length === 1 ? statuses[0] : statuses;
          }
        }

        if (options.maturity) {
          filter.maturity = options.maturity as Maturity;
        }

        if (options.tag && options.tag.length > 0) {
          filter.tags = parseTagsArray(options.tag);
        }

        if (options.has && options.has.length > 0) {
          filter.hasFields = options.has;
        }

        if (options.search) {
          filter.titleContains = options.search;
        }

        if (options.grep) {
          filter.grepSearch = options.grep;
        }

        // AC: @module-scoped-item-listing ac-under-filter, ac-under-invalid-ref
        // Handle --under: scope to descendants of a module or parent item
        let underRoot: LoadedSpecItem | undefined;
        let underDescendantUlids: Set<string> | undefined;
        if (options.under) {
          const underResult = refIndex.resolve(options.under);
          if (!underResult.ok) {
            // AC: @module-scoped-item-listing ac-under-invalid-ref
            error(
              `Reference not found: ${options.under}. Check with: kspec item get ${options.under}`,
            );
            process.exit(EXIT_CODES.NOT_FOUND);
          }
          underRoot = underResult.item as LoadedSpecItem;
          // Check it's not a task
          if ("status" in underRoot && typeof underRoot.status === "string") {
            error(`Reference ${options.under} is a task, not a spec item`);
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
          // AC: @module-scoped-item-listing ac-nested-descendants
          // Find all descendants based on _path and _sourceFile
          const descendants = findDescendantItems(underRoot, items);
          underDescendantUlids = new Set([underRoot._ulid, ...descendants.map((d) => d._ulid)]);
        }

        const limit = parseInt(options.limit, 10) || 50;

        // When --under is used, we need to get all items first, then filter by scope,
        // because pagination before scoping could miss items
        let specItems: LoadedSpecItem[];
        let effectiveTotal: number;

        if (underDescendantUlids) {
          // AC: @module-scoped-item-listing ac-under-filter, ac-under-with-other-filters
          // Get all items matching filters, then scope to descendants
          const allResults = itemIndex.query(filter);
          const allSpecItems = allResults.filter(
            (item): item is LoadedSpecItem =>
              !("status" in item && typeof item.status === "string"),
          );
          // Apply --under filtering (AND logic with other filters)
          const scopedItems = allSpecItems.filter((item) => underDescendantUlids!.has(item._ulid));
          effectiveTotal = scopedItems.length;
          specItems = scopedItems.slice(0, limit);
        } else {
          const result = itemIndex.queryPaginated(filter, 0, limit);
          // Filter to only LoadedSpecItem (not tasks)
          specItems = result.items.filter(
            (item): item is LoadedSpecItem =>
              !("status" in item && typeof item.status === "string"),
          );
          effectiveTotal = result.total;
        }

        // AC: @module-scoped-item-listing ac-count-with-under
        // AC: @trait-filterable-list ac-8
        if (options.count) {
          output({ count: effectiveTotal }, () => {
            console.log(effectiveTotal);
          });
          return;
        }

        output(
          {
            items: specItems.map(serializeSpecItemForJson),
            total: effectiveTotal,
            showing: specItems.length,
          },
          () => {
            if (options.tree) {
              // AC: @module-scoped-item-listing ac-under-with-tree
              formatItemTree(specItems, refIndex, options.verbose, options.grep);
            } else {
              formatItemList(specItems, refIndex, options.verbose, options.grep);
            }
          },
        );
      } catch (err) {
        error(errors.failures.listItems, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item get <ref>
  item
    .command("get <ref>")
    .description("Get details for a specific item")
    .action(async (ref) => {
      try {
        const ctx = await initContext();
        const { refIndex, traitIndex } = await buildIndexes(ctx);

        const result = refIndex.resolve(ref);

        if (!result.ok) {
          let notFoundMessage = errors.reference.itemNotFound(ref);
          try {
            const metaCtx = await loadMetaContext(ctx);
            const resolvedMetaRef = resolveMetaRef(metaCtx, ref);
            if (resolvedMetaRef?.type === "observation") {
              notFoundMessage = `Item not found: ${ref}\nHint: ${ref} is an observation. Use: kspec meta observe get ${ref}`;
            }
          } catch {
            // Fall back to the standard item-not-found error when meta context is unavailable.
          }

          error(notFoundMessage);
          process.exit(EXIT_CODES.ERROR);
        }

        const item = result.item as LoadedSpecItem;

        // AC: @trait-display ac-2 - JSON mode includes inherited_traits array
        const inheritedTraits = traitIndex.getInheritedAC(item._ulid);
        const traitsByTrait = new Map<
          string,
          {
            trait: (typeof inheritedTraits)[0]["trait"];
            acs: AcceptanceCriterion[];
          }
        >();
        for (const { trait, ac } of inheritedTraits) {
          if (!traitsByTrait.has(trait.ulid)) {
            traitsByTrait.set(trait.ulid, { trait, acs: [] });
          }
          traitsByTrait.get(trait.ulid)?.acs.push(ac);
        }

        // Build JSON output with inherited traits
        const jsonOutput = {
          ...serializeSpecItemForJson(item),
          inherited_traits: Array.from(traitsByTrait.values()).map(({ trait, acs }) => ({
            ref: `@${trait.slug}`,
            title: trait.title,
            acceptance_criteria: acs,
          })),
        };

        output(jsonOutput, () => {
          console.log(chalk.bold(item.title));
          console.log(chalk.gray("─".repeat(40)));
          console.log(`${fieldLabels.ulid}      ${item._ulid}`);
          if (item.slugs.length > 0) {
            console.log(`${fieldLabels.slugs}     ${item.slugs.join(", ")}`);
          }
          console.log(`${fieldLabels.type}      ${item.type}`);

          if (item.status && typeof item.status === "object") {
            const s = item.status as {
              maturity?: string;
              implementation?: string;
            };
            if (s.maturity) console.log(`${fieldLabels.maturity}  ${s.maturity}`);
            if (s.implementation) {
              // AC: @trait-retrospective ac-4
              // Show retrospective verification source
              const isRetrospective = item.traits?.includes("@trait-retrospective");
              const statusLabel = isRetrospective
                ? `${s.implementation} (retrospective)`
                : s.implementation;
              console.log(`${fieldLabels.implementation}${statusLabel}`);
            }
          }

          // AC: @trait-retrospective ac-4
          // Show verification metadata for retrospective specs
          const isRetrospective = item.traits?.includes("@trait-retrospective");
          if (isRetrospective && (item.verified_at || item.verified_by)) {
            const verifiedDate = item.verified_at
              ? new Date(item.verified_at).toISOString().split("T")[0]
              : "unknown";
            const verifiedBy = item.verified_by || "unknown";
            console.log(`Verified:   ${verifiedDate} by ${verifiedBy}`);
          }

          if ("tags" in item && Array.isArray(item.tags) && item.tags.length > 0) {
            console.log(`${fieldLabels.tags}      ${item.tags.join(", ")}`);
          }

          // AC: @item-get ac-4
          if (Array.isArray(item.depends_on) && item.depends_on.length > 0) {
            console.log(`${fieldLabels.dependsOn} ${item.depends_on.join(", ")}`);
          }
          if (Array.isArray(item.implements) && item.implements.length > 0) {
            console.log(`${fieldLabels.implements} ${item.implements.join(", ")}`);
          }
          if (Array.isArray(item.relates_to) && item.relates_to.length > 0) {
            console.log(`${fieldLabels.relatesTo} ${item.relates_to.join(", ")}`);
          }

          if (item.description) {
            console.log(`\n${sectionHeaders.description}`);
            console.log(item.description);
          }

          // AC: @trait-display ac-1 - Show own AC first
          if (
            "acceptance_criteria" in item &&
            Array.isArray(item.acceptance_criteria) &&
            item.acceptance_criteria.length > 0
          ) {
            console.log(`\n${sectionHeaders.acceptanceCriteria}`);
            for (const ac of item.acceptance_criteria) {
              if (ac && typeof ac === "object" && "id" in ac) {
                const acObj = ac as AcceptanceCriterion;
                console.log(chalk.cyan(`  [${acObj.id}]`));
                if (acObj.given) console.log(`    Given: ${acObj.given}`);
                if (acObj.when) console.log(`    When: ${acObj.when}`);
                if (acObj.then) console.log(`    Then: ${acObj.then}`);
              }
            }
          }

          // AC: @trait-display ac-1, ac-4, ac-5 - Show inherited AC per trait in labeled sections
          if (traitsByTrait.size > 0) {
            for (const { trait, acs } of traitsByTrait.values()) {
              console.log(chalk.gray(`\n─── Inherited from @${trait.slug} ───`));
              for (const ac of acs) {
                console.log(chalk.cyan(`  [${ac.id}]`) + chalk.gray(` (from @${trait.slug})`));
                if (ac.given) console.log(`    Given: ${ac.given}`);
                if (ac.when) console.log(`    When: ${ac.when}`);
                if (ac.then) console.log(`    Then: ${ac.then}`);
              }
            }
          }
        });
      } catch (err) {
        error(errors.failures.getItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item types - show available types and counts
  item
    .command("types")
    .description("Show item types and counts")
    .action(async () => {
      try {
        const ctx = await initContext();
        const { itemIndex } = await buildIndexes(ctx);

        const typeCounts = itemIndex.getTypeCounts();

        output(Object.fromEntries(typeCounts), () => {
          console.log(chalk.bold("Item Types"));
          console.log(chalk.gray("─".repeat(30)));
          for (const [type, count] of typeCounts) {
            console.log(`  ${type}: ${count}`);
          }
          console.log(chalk.gray(`\nTotal: ${itemIndex.size} items`));
        });
      } catch (err) {
        error(errors.failures.getTypes, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item tags - show available tags and counts
  item
    .command("tags")
    .description("Show tags and counts")
    .action(async () => {
      try {
        const ctx = await initContext();
        const { itemIndex } = await buildIndexes(ctx);

        const tagCounts = itemIndex.getTagCounts();

        output(Object.fromEntries(tagCounts), () => {
          console.log(chalk.bold("Tags"));
          console.log(chalk.gray("─".repeat(30)));
          for (const [tag, count] of tagCounts) {
            console.log(`  #${tag}: ${count}`);
          }
        });
      } catch (err) {
        error(errors.failures.getTags, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item add - create a new spec item under a parent
  markMutating(item.command("add"))
    .description("Create a new spec item under a parent or in project root")
    .option("--under <ref>", "Parent item reference (e.g., @core-primitives)")
    .option("--root", "Create at project root (trait items only)")
    .requiredOption("--title <title>", "Item title")
    .option("--type <type>", "Item type (feature, requirement, constraint, decision)", "feature")
    .option("--slug <slug>", "Human-friendly slug")
    .option("--priority <priority>", "Priority (high, medium, low)")
    .option("--tag <tag...>", "Tags")
    .option("--trait <trait...>", "Traits to apply (e.g., @trait-testable)")
    .option("--description <desc>", "Description")
    .option("--as <field>", "Child field override (e.g., requirements, constraints)")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec item add --under @parent --title "Feature name" --type feature
  $ kspec item add --under @parent --title "Multi-tag" --tag api public
  $ kspec item add --under @parent --title "API endpoint" --trait @trait-api-endpoint
  $ kspec item add --root --type trait --title "JSON Output" --slug trait-json-output`,
    )
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const { refIndex, items } = await buildIndexes(ctx);
        const isRootAdd = Boolean(options.root);
        const itemTypeResult = validateEnumOption(
          options.type || "feature",
          ItemTypeSchema.options,
          "item type",
        );
        if (!itemTypeResult.ok) {
          error(itemTypeResult.error);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }
        const itemType = itemTypeResult.value as ItemType;

        const exitWithUsageGuidance = (
          message: string,
          suggestion: string,
          details?: Record<string, unknown>,
        ): never => {
          error(message, { suggestion, ...details });
          process.exit(EXIT_CODES.USAGE_ERROR);
        };

        if (options.under && isRootAdd) {
          exitWithUsageGuidance(
            `Cannot use --under (${options.under}) and --root together`,
            "Use --root only for project-level traits in kynetic.yaml, or remove --root and keep --under for nested items.",
            {
              field: "under",
              value: options.under,
              conflicting_field: "root",
            },
          );
        }

        if (!options.under && !isRootAdd) {
          exitWithUsageGuidance(
            "item add requires either --under <ref> or --root",
            "Use --under @parent to create a nested item, or use --root --type trait to create a project-level trait in kynetic.yaml.",
          );
        }

        if (isRootAdd && itemType !== "trait") {
          exitWithUsageGuidance(
            `--root is only supported for --type trait (received: ${itemType || "undefined"})`,
            "Change --type to trait for project-level creation, or remove --root and create the item under a parent with --under.",
            {
              field: "type",
              value: itemType || null,
            },
          );
        }

        let parent: LoadedSpecItem | null = null;
        if (options.under) {
          const parentResult = refIndex.resolve(options.under);
          if (!parentResult.ok) {
            error(errors.reference.itemNotFound(options.under));
            process.exit(EXIT_CODES.ERROR);
          }

          parent = parentResult.item as LoadedSpecItem;

          // Check it's not a task
          if ("status" in parent && typeof parent.status === "string") {
            error(errors.reference.parentIsTask(options.under));
            process.exit(EXIT_CODES.ERROR);
          }
        }

        // Check slug uniqueness if provided
        if (options.slug) {
          const slugCheck = checkSlugUniqueness(refIndex, [options.slug]);
          if (!slugCheck.ok) {
            error(errors.slug.alreadyExists(slugCheck.slug, slugCheck.existingUlid));
            process.exit(EXIT_CODES.CONFLICT);
          }
        }

        // Validate and canonicalize traits
        const validatedTraits: string[] = [];
        const seenTraitUlids = new Set<string>();
        let hasTraitErrors = false;

        if (options.trait) {
          for (const traitRef of options.trait) {
            const traitResult = refIndex.resolve(traitRef);
            if (!traitResult.ok) {
              error(`Trait not found: ${traitRef}`);
              hasTraitErrors = true;
              continue;
            }

            const traitItem = traitResult.item as LoadedSpecItem;
            if (traitItem.type !== "trait") {
              error(`${traitRef} is not a trait (type: ${traitItem.type})`);
              hasTraitErrors = true;
              continue;
            }

            // Deduplicate by ULID
            if (seenTraitUlids.has(traitItem._ulid)) {
              continue;
            }
            seenTraitUlids.add(traitItem._ulid);

            // Store canonical ref (prefer slug over ULID)
            const canonicalRef = `@${traitItem.slugs[0] || traitItem._ulid}`;
            validatedTraits.push(canonicalRef);
          }
        }

        if (hasTraitErrors) {
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        const input: SpecItemInput = {
          title: options.title,
          type: itemType,
          slugs: options.slug ? [options.slug] : [],
          priority: options.priority,
          tags: parseTagsArray(options.tag),
          description: options.description,
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: validatedTraits,
          notes: [],
        };

        const newItem = createSpecItem(input);
        const addResult = isRootAdd
          ? await addProjectLevelTraitItem(ctx, newItem)
          : await addChildItem(ctx, parent!, newItem, options.as);
        const resultItem = {
          ...(addResult.item as LoadedSpecItem),
          ...(isRootAdd
            ? {
                _sourceFile: ctx.manifestPath!,
                _path: addResult.path,
              }
            : {}),
        } as LoadedSpecItem;

        // Build index including the new item for accurate short ULID
        const index = new ReferenceIndex([], [...items, resultItem]);
        const itemSlug = resultItem.slugs?.[0] || index.shortUlid(resultItem._ulid);
        const itemRef = `@${itemSlug}`;
        await commitIfShadow(ctx.shadow, "item-add", itemSlug);
        success(
          isRootAdd
            ? `Created item: ${itemRef} in project root traits`
            : `Created item: ${index.shortUlid(resultItem._ulid)} under @${parent!.slugs[0] || index.shortUlid(parent!._ulid)}`,
          {
            item: resultItem,
            path: addResult.path,
          },
        );

        // Derive hint
        if (!isJsonMode()) {
          const refSlug = resultItem.slugs?.[0] || index.shortUlid(resultItem._ulid);
          console.log(chalk.gray(`\nDerive implementation task? kspec derive @${refSlug}`));
        }
      } catch (err) {
        error(errors.failures.createItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item set - update a spec item field
  markMutating(item.command("set <ref>"))
    .description("Update a spec item field")
    .option("--title <title>", "Set title")
    .option("--type <type>", "Set type")
    .option("--slug <slug>", "Add a slug")
    .option("--remove-slug <slug>", "Remove a slug")
    .option("--priority <priority>", "Set priority")
    .option("--tag <tag...>", "Set tags (replaces existing)")
    .option("--description <desc>", "Set description")
    .option(
      "--status <status>",
      "Set implementation status (not_started, in_progress, implemented, verified)",
    )
    .option("--maturity <maturity>", "Set maturity (draft, proposed, stable, deferred, deprecated)")
    .option("--verified-by <agent-ref>", "Set verified_by (for retrospective specs)")
    .option(
      "--verified-at <iso-timestamp>",
      "Set verified_at (defaults to now if --verified-by provided)",
    )
    .option("--trait <trait...>", "Set traits (replaces existing)")
    .option("--add-trait <trait...>", "Add traits (appends to existing)")
    .option("--remove-trait <trait...>", "Remove specific traits")
    .option("--clear-traits", "Clear all traits")
    .option("--relates-to <ref>", "Add a relates_to reference")
    .option("--implements <ref>", "Add an implements reference")
    .option("--depends-on <ref>", "Add a depends_on reference")
    .option("--clear-relates-to", "Clear all relates_to references")
    .option("--clear-implements", "Clear all implements references")
    .option("--clear-depends-on", "Clear all depends_on references")
    .option("--no-cascade", "Skip child status cascade prompt (apply change only to target item)")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec item set @item-ref --title "New title"
  $ kspec item set @item-ref --tag api internal security
  $ kspec item set @item-ref --trait @reusable @testable  # replaces all traits
  $ kspec item set @item-ref --add-trait @json-output     # appends trait
  $ kspec item set @item-ref --remove-trait @old-trait     # removes trait
  $ kspec item set @item-ref --relates-to @other-item
  $ kspec item set @item-ref --implements @feature-spec
  $ kspec item set @item-ref --depends-on @prereq-spec
  $ kspec item set @item-ref --status implemented --no-cascade`,
    )
    .action(async (ref, options) => {
      try {
        const ctx = await initContext();
        const { refIndex, items, tasks } = await buildIndexes(ctx);

        const result = refIndex.resolve(ref);
        if (!result.ok) {
          error(errors.reference.itemNotFound(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        const foundItem = result.item as LoadedSpecItem;

        // Check if it's a task (tasks should use task commands)
        if ("status" in foundItem && typeof foundItem.status === "string") {
          error(errors.reference.taskUseTaskCommands(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        // Check slug uniqueness if adding a new slug
        if (options.slug) {
          const slugCheck = checkSlugUniqueness(refIndex, [options.slug], foundItem._ulid);
          if (!slugCheck.ok) {
            error(errors.slug.alreadyExists(slugCheck.slug, slugCheck.existingUlid));
            process.exit(EXIT_CODES.CONFLICT);
          }
        }

        // Validate --remove-slug
        if (options.removeSlug) {
          const currentSlugs = foundItem.slugs || [];
          if (!currentSlugs.includes(options.removeSlug)) {
            error(errors.slug.notFound(options.removeSlug));
            process.exit(EXIT_CODES.ERROR);
          }
          if (currentSlugs.length === 1) {
            error(errors.slug.cannotRemoveLast(options.removeSlug));
            process.exit(EXIT_CODES.ERROR);
          }
        }

        // Mutual exclusivity: cannot add and clear same field
        // Check this before ref resolution so usage errors take precedence
        if (options.relatesTo && options.clearRelatesTo) {
          error("Cannot use --relates-to and --clear-relates-to together");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }
        if (options.implements && options.clearImplements) {
          error("Cannot use --implements and --clear-implements together");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }
        if (options.dependsOn && options.clearDependsOn) {
          error("Cannot use --depends-on and --clear-depends-on together");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // Mutual exclusivity for trait flags
        const traitFlagCount = [
          options.trait,
          options.addTrait,
          options.removeTrait,
          options.clearTraits,
        ].filter(Boolean).length;
        if (traitFlagCount > 1) {
          error(
            "Cannot combine --trait, --add-trait, --remove-trait, and --clear-traits. Use only one at a time.",
          );
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // Helper to validate and canonicalize a list of trait refs
        const validateTraitRefs = (traitRefs: string[]): string[] => {
          const validated: string[] = [];
          const seenUlids = new Set<string>();
          let hasErrors = false;

          for (const traitRef of traitRefs) {
            const traitResult = refIndex.resolve(traitRef);
            if (!traitResult.ok) {
              error(`Trait not found: ${traitRef}`);
              hasErrors = true;
              continue;
            }

            const traitItem = traitResult.item as LoadedSpecItem;
            if (traitItem.type !== "trait") {
              error(`${traitRef} is not a trait (type: ${traitItem.type})`);
              hasErrors = true;
              continue;
            }

            if (seenUlids.has(traitItem._ulid)) continue;
            seenUlids.add(traitItem._ulid);

            const canonicalRef = `@${traitItem.slugs[0] || traitItem._ulid}`;
            validated.push(canonicalRef);
          }

          if (hasErrors) {
            process.exit(EXIT_CODES.NOT_FOUND);
          }
          return validated;
        };

        // Helper to validate relationship refs (must exist and be a spec item, not a task)
        // Returns { ulid, canonicalRef } for deduplication and user-friendly storage
        const validateRelationshipRef = (
          refStr: string,
          flagName: string,
        ): { ulid: string; canonicalRef: string } => {
          const refResult = refIndex.resolve(refStr);
          if (!refResult.ok) {
            error(errors.reference.itemNotFound(refStr));
            process.exit(EXIT_CODES.NOT_FOUND);
          }
          // Ensure it's a spec item, not a task
          const isTask = tasks.some((t) => t._ulid === refResult.ulid);
          if (isTask) {
            error(`${flagName} reference must be a spec item, not a task: ${refStr}`);
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
          // Use primary slug if available for user-friendly storage, otherwise ULID
          const item = refResult.item as LoadedSpecItem;
          const canonicalRef = item.slugs?.[0] ? `@${item.slugs[0]}` : `@${refResult.ulid}`;
          return { ulid: refResult.ulid, canonicalRef };
        };

        // Helper to resolve existing refs to ULIDs for deduplication
        const resolveRefsToUlids = (refs: string[]): Set<string> => {
          const ulids = new Set<string>();
          for (const ref of refs) {
            const result = refIndex.resolve(ref);
            if (result.ok) {
              ulids.add(result.ulid);
            }
          }
          return ulids;
        };

        // AC: @item-set ac-5 - --relates-to validation
        // Store resolved ULID for deduplication and canonical ref for storage
        let relatesToResolved: { ulid: string; canonicalRef: string } | undefined;
        if (options.relatesTo) {
          relatesToResolved = validateRelationshipRef(options.relatesTo, "--relates-to");
        }

        // AC: @item-set ac-6 - --implements validation
        let implementsResolved: { ulid: string; canonicalRef: string } | undefined;
        if (options.implements) {
          implementsResolved = validateRelationshipRef(options.implements, "--implements");
        }

        // AC: @item-set ac-7 - --depends-on validation
        let dependsOnResolved: { ulid: string; canonicalRef: string } | undefined;
        if (options.dependsOn) {
          dependsOnResolved = validateRelationshipRef(options.dependsOn, "--depends-on");
        }

        // Build updates object
        const updates: Partial<SpecItemInput> = {};

        if (options.title) updates.title = options.title;
        if (options.type) {
          const typeResult = validateEnumOption(options.type, ItemTypeSchema.options, "item type");
          if (!typeResult.ok) {
            error(typeResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          updates.type = typeResult.value as ItemType;
        }
        if (options.slug || options.removeSlug) {
          let slugs = [...(foundItem.slugs || [])];
          if (options.removeSlug) {
            slugs = slugs.filter((s) => s !== options.removeSlug);
          }
          if (options.slug) {
            slugs.push(options.slug);
          }
          updates.slugs = slugs;
        }
        if (options.priority) updates.priority = options.priority;
        if (options.tag) updates.tags = parseTagsArray(options.tag);

        // Handle trait mutations (--trait replaces, --add-trait appends, --remove-trait removes, --clear-traits clears)
        if (options.trait) {
          updates.traits = validateTraitRefs(options.trait);
        } else if (options.addTrait) {
          const validated = validateTraitRefs(options.addTrait);
          const current = foundItem.traits || [];
          // Resolve existing traits to ULIDs for deduplication
          const existingUlids = new Set<string>();
          for (const ref of current) {
            const result = refIndex.resolve(ref);
            if (result.ok) existingUlids.add(result.ulid);
          }
          const newTraits = validated.filter((ref) => {
            const result = refIndex.resolve(ref);
            return result.ok && !existingUlids.has(result.ulid);
          });
          if (newTraits.length > 0) {
            updates.traits = [...current, ...newTraits];
          }
        } else if (options.removeTrait) {
          const validated = validateTraitRefs(options.removeTrait);
          const current = foundItem.traits || [];
          // Resolve removal targets to ULIDs
          const removeUlids = new Set<string>();
          for (const ref of validated) {
            const result = refIndex.resolve(ref);
            if (result.ok) removeUlids.add(result.ulid);
          }
          updates.traits = current.filter((ref) => {
            const result = refIndex.resolve(ref);
            return !result.ok || !removeUlids.has(result.ulid);
          });
        } else if (options.clearTraits) {
          updates.traits = [];
        }

        if (options.description) updates.description = options.description;

        // AC: @implementation-states ac-reject-invalid
        // AC: @maturity-states ac-reject-invalid
        // Validate enum values before writing
        let statusValue: ImplementationStatus | undefined;
        if (options.status) {
          const statusResult = validateEnumOption(
            options.status,
            ImplementationStatusSchema.options,
            "implementation status",
          );
          if (!statusResult.ok) {
            error(statusResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          statusValue = statusResult.value as ImplementationStatus;
        }
        let maturityValue: Maturity | undefined;
        if (options.maturity) {
          const maturityResult = validateEnumOption(
            options.maturity,
            MaturitySchema.options,
            "maturity",
          );
          if (!maturityResult.ok) {
            error(maturityResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          maturityValue = maturityResult.value as Maturity;
        }

        // Handle status updates
        if (statusValue || maturityValue) {
          const currentStatus =
            foundItem.status && typeof foundItem.status === "object" ? foundItem.status : undefined;
          updates.status = {
            implementation: statusValue ?? currentStatus?.implementation ?? "not_started",
            maturity: maturityValue ?? currentStatus?.maturity ?? "draft",
          };
        }

        // Handle verification metadata (for retrospective specs)
        if (options.verifiedBy) {
          updates.verified_by = options.verifiedBy;
          // Default verified_at to now if not specified
          updates.verified_at = options.verifiedAt || new Date().toISOString();
        } else if (options.verifiedAt) {
          updates.verified_at = options.verifiedAt;
        }

        // AC: @item-set ac-5 - Handle relates_to (append semantics)
        // Uses resolved ULIDs for deduplication and stores canonical slug format
        if (relatesToResolved) {
          const current = foundItem.relates_to || [];
          const existingUlids = resolveRefsToUlids(current);
          if (!existingUlids.has(relatesToResolved.ulid)) {
            updates.relates_to = [...current, relatesToResolved.canonicalRef];
          }
        }
        if (options.clearRelatesTo) {
          updates.relates_to = [];
        }

        // AC: @item-set ac-6 - Handle implements (append semantics)
        // Uses resolved ULIDs for deduplication and stores canonical slug format
        if (implementsResolved) {
          const current = foundItem.implements || [];
          const existingUlids = resolveRefsToUlids(current);
          if (!existingUlids.has(implementsResolved.ulid)) {
            updates.implements = [...current, implementsResolved.canonicalRef];
          }
        }
        if (options.clearImplements) {
          updates.implements = [];
        }

        // AC: @item-set ac-7 - Handle depends_on (append semantics)
        // Uses resolved ULIDs for deduplication and stores canonical slug format
        if (dependsOnResolved) {
          const current = foundItem.depends_on || [];
          const existingUlids = resolveRefsToUlids(current);
          if (!existingUlids.has(dependsOnResolved.ulid)) {
            updates.depends_on = [...current, dependsOnResolved.canonicalRef];
          }
        }
        if (options.clearDependsOn) {
          updates.depends_on = [];
        }

        if (Object.keys(updates).length === 0) {
          warn("No updates specified");
          return;
        }

        // Build before→after changes for display
        const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
        for (const [key, value] of Object.entries(updates)) {
          const before = (foundItem as unknown as Record<string, unknown>)[key];
          // Only record if value actually changed
          if (JSON.stringify(before) !== JSON.stringify(value)) {
            changes.push({ field: key, before, after: value });
          }
        }

        if (changes.length === 0) {
          warn("No changes: values are already set to the specified values");
          return;
        }

        const updated = await updateSpecItem(ctx, foundItem, updates);
        const itemSlug = foundItem.slugs[0] || refIndex.shortUlid(foundItem._ulid);

        // Handle cascade for implementation status updates
        const updatedItems: LoadedSpecItem[] = [updated];
        if (options.status && options.cascade !== false) {
          const cascadeResult = await handleStatusCascade(
            ctx,
            updated,
            options.status,
            items,
            refIndex,
          );
          updatedItems.push(...cascadeResult);
        }

        await commitIfShadow(ctx.shadow, "item-set", itemSlug);
        const changedFields = changes.map((c) => c.field).join(", ");
        success(`Updated item: ${refIndex.shortUlid(updated._ulid)} (${changedFields})`, {
          item: updated,
          changes,
        });

        // Show before→after diff in text mode
        showChangeDiff(changes);

        // Derive hint
        if (!isJsonMode()) {
          const refSlug = updated.slugs?.[0] || refIndex.shortUlid(updated._ulid);
          console.log(chalk.gray(`\nDerive implementation task? kspec derive @${refSlug}`));
        }
      } catch (err) {
        error(errors.failures.updateItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @spec-item-delete-children ac-11 - Clean up dangling references on item deletion
  async function cleanupDanglingRefs(
    ctx: KspecContext,
    refIndex: ReferenceIndex,
    deletedUlids: Set<string>,
    deletedSlugs: Set<string>,
  ): Promise<{ totalRefsRemoved: number; itemsUpdated: number }> {
    // Check if a reference string points to any deleted item
    function isDeletedRef(ref: string): boolean {
      const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;
      if (deletedSlugs.has(cleanRef)) return true;
      // Try resolving via index - if it resolves to a deleted ULID, it's a match
      const resolved = refIndex.resolve(cleanRef);
      if (resolved.ok && deletedUlids.has(resolved.ulid)) return true;
      // Direct ULID match (full or prefix)
      if (deletedUlids.has(cleanRef)) return true;
      for (const ulid of deletedUlids) {
        if (ulid.startsWith(cleanRef) && cleanRef.length >= 4) return true;
      }
      return false;
    }

    const arrayRefFields = ["depends_on", "implements", "relates_to", "tests", "traits"] as const;
    let totalRefsRemoved = 0;
    let itemsUpdated = 0;

    // Reload items from disk after deletions
    const remainingItems = await loadAllItems(ctx);

    for (const item of remainingItems) {
      if (deletedUlids.has(item._ulid)) continue;

      let refsRemovedFromItem = 0;
      const updates: Record<string, unknown> = {};

      // Check array reference fields
      for (const field of arrayRefFields) {
        const arr = (item as unknown as Record<string, string[]>)[field];
        if (!Array.isArray(arr) || arr.length === 0) continue;

        const filtered = arr.filter((ref) => !isDeletedRef(ref));
        const removed = arr.length - filtered.length;
        if (removed > 0) {
          updates[field] = filtered;
          refsRemovedFromItem += removed;
        }
      }

      // Check supersedes (single nullable ref)
      if (item.supersedes && isDeletedRef(item.supersedes)) {
        updates.supersedes = null;
        refsRemovedFromItem += 1;
      }

      if (refsRemovedFromItem > 0) {
        await updateSpecItem(ctx, item, updates as Partial<SpecItemInput>);
        totalRefsRemoved += refsRemovedFromItem;
        itemsUpdated++;
      }
    }

    // Also clean task references (depends_on, context, spec_ref, blocked_by)
    const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
    const tasksToClean: LoadedTask[] = [];

    for (const task of tasks) {
      let hasDeletedRef = false;

      for (const ref of task.depends_on) {
        if (isDeletedRef(ref)) {
          hasDeletedRef = true;
          break;
        }
      }
      if (!hasDeletedRef && task.context) {
        for (const ref of task.context) {
          if (isDeletedRef(ref)) {
            hasDeletedRef = true;
            break;
          }
        }
      }
      if (!hasDeletedRef && task.spec_ref && isDeletedRef(task.spec_ref)) {
        hasDeletedRef = true;
      }
      if (!hasDeletedRef && task.blocked_by) {
        for (const ref of task.blocked_by) {
          if (isDeletedRef(ref)) {
            hasDeletedRef = true;
            break;
          }
        }
      }

      if (hasDeletedRef) {
        tasksToClean.push(task);
      }
    }

    if (tasksToClean.length > 0) {
      const cleanupCommitOpts: ShadowCommitOptions = {
        operation: "item-delete-ref-cleanup",
        detail: `${tasksToClean.length} task(s)`,
      };
      await resolveTaskDataManager(ctx).mutateTasks(
        ctx,
        tasksToClean.map((t) => t._ulid),
        (latestTasks) => {
          return latestTasks.map((task) => {
            let refsRemovedFromTask = 0;
            const origDepsLen = task.depends_on.length;
            const filteredDeps = task.depends_on.filter((ref) => !isDeletedRef(ref));
            refsRemovedFromTask += origDepsLen - filteredDeps.length;

            const origCtxLen = (task.context || []).length;
            const filteredCtx = (task.context || []).filter((ref) => !isDeletedRef(ref));
            refsRemovedFromTask += origCtxLen - filteredCtx.length;

            const origBlockedLen = (task.blocked_by || []).length;
            const filteredBlocked = (task.blocked_by || []).filter((ref) => !isDeletedRef(ref));
            refsRemovedFromTask += origBlockedLen - filteredBlocked.length;

            let specRef = task.spec_ref;
            if (specRef && isDeletedRef(specRef)) {
              specRef = null;
              refsRemovedFromTask += 1;
            }

            if (refsRemovedFromTask === 0) return task;

            totalRefsRemoved += refsRemovedFromTask;
            itemsUpdated++;

            return {
              ...task,
              depends_on: filteredDeps,
              context: filteredCtx,
              blocked_by: filteredBlocked,
              spec_ref: specRef,
            };
          });
        },
        cleanupCommitOpts,
      );
    }

    return { totalRefsRemoved, itemsUpdated };
  }

  // kspec item delete - delete a spec item
  markMutating(item.command("delete <ref>"))
    .description("Delete a spec item (including nested items)")
    .option("--force", "Skip confirmation")
    .option("--cascade", "Delete item and all descendants")
    .action(async (ref, options) => {
      try {
        const ctx = await initContext();
        const { refIndex, items } = await buildIndexes(ctx);

        const result = refIndex.resolve(ref);
        if (!result.ok) {
          error(errors.reference.itemNotFound(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        const foundItem = result.item as LoadedSpecItem;

        // Check if it's a task
        if ("status" in foundItem && typeof foundItem.status === "string") {
          error(errors.reference.itemUseTaskCancel(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        if (!foundItem._sourceFile) {
          error(errors.operation.cannotDeleteNoSource);
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @spec-item-delete-children ac-7 - Check if this is a trait with implementors
        const implementors = findTraitImplementors(foundItem, items);
        if (implementors.length > 0) {
          const implementorRefs = implementors
            .map((i) => `@${i.slugs[0] || refIndex.shortUlid(i._ulid)}`)
            .join(", ");
          const errorMsg = `Cannot delete: trait is used by ${implementors.length} specs. Remove trait from specs first: ${implementorRefs}`;

          if (isJsonMode()) {
            error(errorMsg, {
              error: "trait_in_use",
              implementors: implementors.map((i) => ({
                ulid: i._ulid,
                slug: i.slugs[0],
                title: i.title,
              })),
            });
          } else {
            error(errorMsg);
          }
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @spec-item-delete-children ac-1 ac-8 - Check for child items (nested YAML items, not relates_to refs)
        const children = findChildItems(foundItem, items);

        if (children.length > 0 && !options.cascade) {
          // AC: @spec-item-delete-children ac-1 - Block deletion if children exist without --cascade
          const errorMsg = `Cannot delete: item has ${children.length} children. Use --cascade to delete recursively`;

          if (isJsonMode()) {
            // AC: @spec-item-delete-children ac-10 - JSON error includes children array
            error(errorMsg, {
              error: "has_children",
              children: children.map((c) => ({
                ulid: c._ulid,
                slug: c.slugs[0],
                title: c.title,
                ref: `@${c.slugs[0] || refIndex.shortUlid(c._ulid)}`,
              })),
            });
          } else {
            error(errorMsg);
          }
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @spec-item-delete-children ac-9 - Custom confirmation prompt for cascade
        if (children.length > 0 && options.cascade && !options.force) {
          const itemRef = `@${foundItem.slugs[0] || refIndex.shortUlid(foundItem._ulid)}`;

          // Check for JSON mode - requires --force
          if (isJsonMode()) {
            error("Confirmation required. Use --force with --json");
            process.exit(EXIT_CODES.ERROR);
          }

          // Check for non-interactive environment
          const isTTY = process.env.KSPEC_TEST_TTY === "true" || process.stdin.isTTY;
          if (!isTTY) {
            error("Non-interactive environment. Use --force to proceed");
            process.exit(EXIT_CODES.ERROR);
          }

          // Show confirmation prompt
          const readline = await import("node:readline");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const response = await new Promise<string>((resolve) => {
            rl.question(
              chalk.yellow(`Delete ${itemRef} and ${children.length} descendant items? [y/N] `),
              (answer) => {
                rl.close();
                resolve(answer);
              },
            );
          });

          if (response.toLowerCase() !== "y") {
            console.log(chalk.gray("Operation cancelled"));
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
        }

        // AC: @spec-item-delete-children ac-2 ac-3 - Delete item and all descendants with cascade
        const itemsToDelete = options.cascade ? [foundItem, ...children] : [foundItem];
        let deletedCount = 0;

        // Delete in reverse order (deepest first) to avoid path issues
        const sortedItems = [...itemsToDelete].toSorted((a, b) => {
          const aDepth = a._path ? a._path.split(".").length : 0;
          const bDepth = b._path ? b._path.split(".").length : 0;
          return bDepth - aDepth;
        });

        for (const itemToDelete of sortedItems) {
          const deleted = await deleteSpecItem(ctx, itemToDelete);
          if (deleted) {
            deletedCount++;
          }
        }

        if (deletedCount > 0) {
          // AC: @spec-item-delete-children ac-11 - Clean up dangling references
          const deletedUlids = new Set(itemsToDelete.map((i) => i._ulid));
          const deletedSlugs = new Set(itemsToDelete.flatMap((i) => i.slugs));

          const cleanupResult = await cleanupDanglingRefs(
            ctx,
            refIndex,
            deletedUlids,
            deletedSlugs,
          );

          // AC: @spec-item-delete-children ac-6 - Single shadow commit with all deletions
          const itemSlug = foundItem.slugs[0] || refIndex.shortUlid(foundItem._ulid);
          const commitMsg = deletedCount > 1 ? `${deletedCount} items` : itemSlug;
          await commitIfShadow(ctx.shadow, "item-delete", commitMsg);

          const cleanedMsg =
            cleanupResult.totalRefsRemoved > 0
              ? `. Cleaned ${cleanupResult.totalRefsRemoved} reference${cleanupResult.totalRefsRemoved === 1 ? "" : "s"} from ${cleanupResult.itemsUpdated} item${cleanupResult.itemsUpdated === 1 ? "" : "s"}`
              : "";

          if (deletedCount > 1) {
            success(`Deleted ${deletedCount} items${cleanedMsg}`, {
              deleted: deletedCount,
              root_ulid: foundItem._ulid,
              refs_cleaned: cleanupResult.totalRefsRemoved,
              items_cleaned: cleanupResult.itemsUpdated,
            });
          } else {
            success(`Deleted item: ${foundItem.title}${cleanedMsg}`, {
              deleted: true,
              ulid: foundItem._ulid,
              refs_cleaned: cleanupResult.totalRefsRemoved,
              items_cleaned: cleanupResult.itemsUpdated,
            });
          }
        } else {
          error(errors.failures.deleteItem);
          console.log(chalk.gray(`Edit the source file directly: ${foundItem._sourceFile}`));
          process.exit(EXIT_CODES.ERROR);
        }
      } catch (err) {
        error(errors.failures.deleteItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item patch - update item fields via JSON
  markMutating(item.command("patch [ref]"))
    .description("Update spec item fields via JSON patch")
    .option("--data <json>", "JSON data to patch")
    .option("--bulk", "Read patches from stdin (JSONL or JSON array)")
    .option("--allow-unknown", "Allow fields not in schema")
    .option("--dry-run", "Preview changes without applying")
    .option("--fail-fast", "Stop on first error (bulk mode)")
    .action(async (ref: string | undefined, options) => {
      try {
        const ctx = await initContext();

        if (options.bulk) {
          // Bulk mode: read from stdin
          const stdin = await readStdinFully();
          if (!stdin) {
            error(errors.validation.noInputProvided);
            process.exit(EXIT_CODES.ERROR);
          }

          let patches: PatchOperation[];
          try {
            patches = parseBulkInput(stdin);
          } catch (err) {
            error(
              errors.validation.failedToParseBulk(err instanceof Error ? err.message : String(err)),
            );
            process.exit(EXIT_CODES.ERROR);
          }

          if (patches.length === 0) {
            error(errors.validation.noPatchesProvided);
            process.exit(EXIT_CODES.ERROR);
          }

          const { refIndex, items } = await buildIndexes(ctx);
          const result = await patchSpecItems(ctx, refIndex, items, patches, {
            allowUnknown: options.allowUnknown,
            failFast: options.failFast,
            dryRun: options.dryRun,
          });

          // Shadow commit if any updates
          if (!options.dryRun && result.summary.updated > 0) {
            await commitIfShadow(ctx.shadow, "item-patch", `${result.summary.updated} items`);
          }

          output(result, () => formatBulkPatchResult(result, options.dryRun));

          if (result.summary.failed > 0) {
            process.exit(EXIT_CODES.ERROR);
          }
        } else {
          // Single item mode
          if (!ref) {
            error(errors.usage.patchNeedRef);
            process.exit(EXIT_CODES.ERROR);
          }

          let data: Record<string, unknown>;

          // Get data from --data option or stdin
          if (options.data) {
            try {
              data = JSON.parse(options.data);
            } catch (err) {
              error(errors.validation.invalidJsonInData(err instanceof Error ? err.message : ""));
              process.exit(EXIT_CODES.ERROR);
            }
          } else {
            const stdin = await readStdinIfAvailable();
            if (stdin) {
              try {
                data = JSON.parse(stdin.trim());
              } catch (err) {
                error(
                  errors.validation.invalidJsonFromStdin(err instanceof Error ? err.message : ""),
                );
                process.exit(EXIT_CODES.ERROR);
              }
            } else {
              error(errors.validation.noPatchData);
              process.exit(EXIT_CODES.ERROR);
            }
          }

          // Validate patch data (known fields always validated; unknown fields
          // rejected unless --allow-unknown)
          const validationIssues = validateSpecItemPatchData(data, {
            allowUnknown: options.allowUnknown,
          });
          if (validationIssues) {
            error(errors.validation.invalidPatchDataWithIssues(validationIssues));
            process.exit(EXIT_CODES.ERROR);
          }

          const { refIndex, items } = await buildIndexes(ctx);

          // Resolve ref
          const resolved = refIndex.resolve(ref);
          if (!resolved.ok) {
            error(errors.reference.itemNotFound(ref));
            process.exit(EXIT_CODES.ERROR);
          }

          // Find the item
          const foundItem = items.find((i) => i._ulid === resolved.ulid);
          if (!foundItem) {
            error(errors.reference.notItem(ref));
            process.exit(EXIT_CODES.ERROR);
          }

          if (options.dryRun) {
            output(
              {
                ref,
                data,
                wouldApplyTo: foundItem.title,
                ulid: foundItem._ulid,
              },
              () => {
                console.log(chalk.yellow("Would patch:"), foundItem.title);
                console.log(chalk.gray("ULID:"), refIndex.shortUlid(foundItem._ulid));
                console.log(chalk.gray("Changes:"));
                console.log(JSON.stringify(data, null, 2));
              },
            );
            return;
          }

          const updated = await updateSpecItem(ctx, foundItem, data);
          const itemSlug = foundItem.slugs[0] || refIndex.shortUlid(foundItem._ulid);
          await commitIfShadow(ctx.shadow, "item-patch", itemSlug);

          success(`Patched item: ${itemSlug}`, { item: updated });
        }
      } catch (err) {
        error(errors.failures.patchItems, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item status - show implementation status with linked tasks
  item
    .command("status <ref>")
    .description("Show implementation status and linked tasks for a spec item")
    .action(async (ref) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const refIndex = new ReferenceIndex(tasks, items);

        const result = refIndex.resolve(ref);
        if (!result.ok) {
          error(errors.reference.itemNotFound(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        const foundItem = result.item as LoadedSpecItem;

        // Check if it's a task
        if ("status" in foundItem && typeof foundItem.status === "string") {
          error(errors.reference.notItem(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        // Build alignment index
        const alignmentIndex = new AlignmentIndex(tasks, items);
        alignmentIndex.buildLinks(refIndex);

        const summary = alignmentIndex.getImplementationSummary(foundItem._ulid);

        if (!summary) {
          error(errors.project.couldNotGetImplSummary);
          process.exit(EXIT_CODES.ERROR);
        }

        output(summary, () => {
          console.log(chalk.bold(foundItem.title));
          console.log(chalk.gray("─".repeat(40)));

          // Status
          const currentColor =
            summary.currentStatus === "implemented"
              ? chalk.green
              : summary.currentStatus === "in_progress"
                ? chalk.yellow
                : chalk.gray;
          const expectedColor =
            summary.expectedStatus === "implemented"
              ? chalk.green
              : summary.expectedStatus === "in_progress"
                ? chalk.yellow
                : chalk.gray;

          console.log(`Current status:  ${currentColor(summary.currentStatus)}`);
          console.log(`Expected status: ${expectedColor(summary.expectedStatus)}`);

          if (!summary.isAligned) {
            console.log(chalk.yellow("\n⚠ Status mismatch - run task complete to sync"));
          } else {
            console.log(chalk.green("\n✓ Aligned"));
          }

          // Linked tasks
          console.log(chalk.bold("\nLinked Tasks:"));
          if (summary.linkedTasks.length === 0) {
            console.log(chalk.gray("  No tasks reference this spec item"));
          } else {
            for (const task of summary.linkedTasks) {
              const statusColor =
                task.taskStatus === "completed"
                  ? chalk.green
                  : task.taskStatus === "in_progress"
                    ? chalk.blue
                    : chalk.gray;
              const shortId = refIndex.shortUlid(task.taskUlid);
              const notes = task.hasNotes ? chalk.gray(" (has notes)") : "";
              console.log(
                `  ${statusColor(`[${task.taskStatus}]`)} ${shortId} ${task.taskTitle}${notes}`,
              );
            }
          }
        });
      } catch (err) {
        error(errors.failures.getItemStatus, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item note <ref> <message>
  markMutating(item.command("note <ref> <message>"))
    .description("Add a note to a spec item")
    .option("--author <author>", "Note author")
    .option("--supersedes <ulid>", "ULID of note this supersedes")
    .action(async (ref: string, message: string, options) => {
      try {
        const ctx = await initContext();
        const items = await loadAllItems(ctx);
        const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
        const refIndex = new ReferenceIndex(tasks, items);

        const result = refIndex.resolve(ref);
        if (!result.ok) {
          error(errors.reference.itemNotFound(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        const foundItem = items.find((i) => i._ulid === result.ulid);
        if (!foundItem) {
          error(errors.reference.itemNotFound(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @actor-identity-resolution ac-7 ac-8 — canonical author or rejection.
        const noteAuthor = await resolveCliActor(ctx, options.author, "author");
        const note = createNote(message, noteAuthor, options.supersedes);

        const updatedNotes = [...(foundItem.notes || []), note];
        await updateSpecItem(ctx, foundItem, { notes: updatedNotes });

        const itemSlug = foundItem.slugs[0] || refIndex.shortUlid(foundItem._ulid);
        await commitIfShadow(ctx.shadow, "item-note", itemSlug);
        success(`Added note to spec item: ${refIndex.shortUlid(foundItem._ulid)}`, { note });
      } catch (err) {
        error(errors.failures.addNote, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item notes <ref>
  item
    .command("notes <ref>")
    .description("Show notes for a spec item")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const items = await loadAllItems(ctx);
        const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
        const refIndex = new ReferenceIndex(tasks, items);

        const result = refIndex.resolve(ref);
        if (!result.ok) {
          error(errors.reference.itemNotFound(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        const foundItem = items.find((i) => i._ulid === result.ulid);
        if (!foundItem) {
          error(errors.reference.itemNotFound(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        const notes = foundItem.notes || [];
        output(notes, () => {
          if (notes.length === 0) {
            console.log("No notes");
          } else {
            for (const note of notes) {
              const author = note.author || "unknown";
              console.log(`[${note.created_at}] ${author}:`);
              console.log(note.content);
              console.log("");
            }
          }
        });
      } catch (err) {
        error(errors.failures.getNotes, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // Create subcommand group for acceptance criteria operations
  const acCmd = item.command("ac").description("Manage acceptance criteria on spec items");

  // Helper: Generate next AC ID based on existing AC
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  function generateNextAcId(existingAc: AcceptanceCriterion[] | undefined): string {
    if (!existingAc || existingAc.length === 0) return "ac-1";

    const numericIds = existingAc
      .map((ac) => ac.id.match(/^ac-(\d+)$/)?.[1])
      .filter((id): id is string => id !== null && id !== undefined)
      .map(Number);

    const maxId = numericIds.length > 0 ? Math.max(...numericIds) : 0;
    return `ac-${maxId + 1}`;
  }

  // Helper: Resolve ref to spec item (not task)
  async function resolveSpecItem(ref: string): Promise<{
    ctx: Awaited<ReturnType<typeof initContext>>;
    item: LoadedSpecItem;
    refIndex: ReferenceIndex;
  }> {
    const ctx = await initContext();
    const { refIndex } = await buildIndexes(ctx);

    const result = refIndex.resolve(ref);
    if (!result.ok) {
      error(errors.reference.itemNotFound(ref));
      process.exit(EXIT_CODES.NOT_FOUND);
    }

    const foundItem = result.item as LoadedSpecItem;

    // Check if it's a task
    if ("status" in foundItem && typeof foundItem.status === "string") {
      error(errors.operation.tasksNoAcceptanceCriteria(ref));
      process.exit(EXIT_CODES.NOT_FOUND);
    }

    return { ctx, item: foundItem, refIndex };
  }

  // kspec item ac list <ref>
  acCmd
    .command("list <ref>")
    .description("List acceptance criteria for a spec item")
    .action(async (ref: string) => {
      try {
        const { item, refIndex } = await resolveSpecItem(ref);
        const ac = item.acceptance_criteria || [];

        output(ac, () => {
          console.log(
            chalk.bold(
              `Acceptance Criteria for: ${item.title} (@${item.slugs[0] || refIndex.shortUlid(item._ulid)})`,
            ),
          );
          console.log();

          if (ac.length === 0) {
            console.log(chalk.gray("No acceptance criteria"));
          } else {
            for (const criterion of ac) {
              console.log(chalk.cyan(`  [${criterion.id}]`));
              console.log(chalk.gray(`    Given: ${criterion.given}`));
              console.log(chalk.gray(`    When:  ${criterion.when}`));
              console.log(chalk.gray(`    Then:  ${criterion.then}`));
              console.log();
            }
          }

          console.log(chalk.gray(`${ac.length} acceptance criteria`));
        });
      } catch (err) {
        error(errors.failures.listAc, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item ac add <ref>
  markMutating(acCmd.command("add <ref>"))
    .description("Add an acceptance criterion to a spec item")
    .option("--id <id>", "AC identifier (auto-generated if not provided)")
    .requiredOption("--given <text>", "The precondition (Given...)")
    .requiredOption("--when <text>", "The action/trigger (When...)")
    .requiredOption("--then <text>", "The expected outcome (Then...)")
    .action(async (ref: string, options) => {
      try {
        const { ctx, item, refIndex } = await resolveSpecItem(ref);
        const existingAc = item.acceptance_criteria || [];

        // Determine ID
        const acId = options.id || generateNextAcId(existingAc);

        // Validate AC ID format via shared schema
        const acIdResult = AcIdSchema.safeParse(acId);
        if (!acIdResult.success) {
          error(errors.validation.invalidAcIdFormat(acId));
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // Check for duplicate ID
        if (existingAc.some((ac) => ac.id === acId)) {
          const itemRef = item.slugs[0] || refIndex.shortUlid(item._ulid);
          error(errors.conflict.acAlreadyExists(acId, itemRef));
          process.exit(EXIT_CODES.CONFLICT);
        }

        // Create new AC
        const newAc: AcceptanceCriterion = {
          id: acId,
          given: options.given,
          when: options.when,
          then: options.then,
        };

        // Update item with new AC
        const updatedAc = [...existingAc, newAc];
        await updateSpecItem(ctx, item, { acceptance_criteria: updatedAc });

        const itemSlug = item.slugs[0] || refIndex.shortUlid(item._ulid);
        await commitIfShadow(ctx.shadow, "item-ac-add", itemSlug);
        success(`Added acceptance criterion: ${acId} to @${itemSlug}`, {
          ac: newAc,
        });
      } catch (err) {
        error(errors.failures.addAc, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item ac set <ref> <ac-id>
  markMutating(acCmd.command("set <ref> <acId>").alias("update"))
    .description("Update an acceptance criterion")
    .option("--id <newId>", "Rename the AC ID")
    .option("--given <text>", "Update the precondition")
    .option("--when <text>", "Update the action/trigger")
    .option("--then <text>", "Update the expected outcome")
    .action(async (ref: string, acId: string, options) => {
      try {
        const { ctx, item, refIndex } = await resolveSpecItem(ref);
        const existingAc = item.acceptance_criteria || [];

        // Find the AC
        const acIndex = existingAc.findIndex((ac) => ac.id === acId);
        if (acIndex === -1) {
          const itemRef = item.slugs[0] || refIndex.shortUlid(item._ulid);
          error(errors.reference.acNotFound(acId, itemRef));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        // Check for no updates
        if (!options.id && !options.given && !options.when && !options.then) {
          warn("No updates specified");
          return;
        }

        // Validate new AC ID format if renaming via shared schema
        if (options.id) {
          const acIdResult = AcIdSchema.safeParse(options.id);
          if (!acIdResult.success) {
            error(errors.validation.invalidAcIdFormat(options.id));
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        // Check for duplicate ID if renaming
        if (options.id && options.id !== acId && existingAc.some((ac) => ac.id === options.id)) {
          error(errors.conflict.acIdAlreadyExists(options.id));
          process.exit(EXIT_CODES.CONFLICT);
        }

        // Build updated AC and track before→after changes
        const updatedAc = [...existingAc];
        const originalAc = { ...updatedAc[acIndex] };
        const changes: Array<{ field: string; before: unknown; after: unknown }> = [];

        updatedAc[acIndex] = {
          ...updatedAc[acIndex],
          ...(options.id && { id: options.id }),
          ...(options.given && { given: options.given }),
          ...(options.when && { when: options.when }),
          ...(options.then && { then: options.then }),
        };

        if (options.id && options.id !== originalAc.id) {
          changes.push({ field: "id", before: originalAc.id, after: options.id });
        }
        if (options.given && options.given !== originalAc.given) {
          changes.push({ field: "given", before: originalAc.given, after: options.given });
        }
        if (options.when && options.when !== originalAc.when) {
          changes.push({ field: "when", before: originalAc.when, after: options.when });
        }
        if (options.then && options.then !== originalAc.then) {
          changes.push({ field: "then", before: originalAc.then, after: options.then });
        }

        if (changes.length === 0) {
          warn("No changes: values are already set to the specified values");
          return;
        }

        // Update item
        await updateSpecItem(ctx, item, { acceptance_criteria: updatedAc });

        const itemSlug = item.slugs[0] || refIndex.shortUlid(item._ulid);
        await commitIfShadow(ctx.shadow, "item-ac-set", itemSlug);
        const changedFields = changes.map((c) => c.field).join(", ");
        success(`Updated acceptance criterion: ${acId} on @${itemSlug} (${changedFields})`, {
          ac: updatedAc[acIndex],
          changes,
        });

        // Show before→after diff in text mode
        showChangeDiff(changes);
      } catch (err) {
        error(errors.failures.updateAc, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec item ac remove <ref> <id>
  markMutating(acCmd.command("remove <ref> <id>"))
    .description("Remove an acceptance criterion")
    .option("--force", "Skip confirmation")
    .action(async (ref: string, acId: string, options) => {
      try {
        const { ctx, item, refIndex } = await resolveSpecItem(ref);
        const existingAc = item.acceptance_criteria || [];

        // Find the AC
        const acIndex = existingAc.findIndex((ac) => ac.id === acId);
        if (acIndex === -1) {
          const itemRef = item.slugs[0] || refIndex.shortUlid(item._ulid);
          error(errors.reference.acNotFound(acId, itemRef));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        // Confirmation required unless --force
        if (!options.force) {
          // AC: @spec-item-delete-children ac-5 - JSON mode requires --force
          if (isJsonMode()) {
            error("Confirmation required. Use --force with --json");
            process.exit(EXIT_CODES.ERROR);
          }

          // AC: @spec-item-delete-children ac-6 - Non-interactive environment requires --force
          // Allow KSPEC_TEST_TTY for testing interactive prompts
          const isTTY = process.env.KSPEC_TEST_TTY === "1" || process.stdin.isTTY;
          if (!isTTY) {
            error("Non-interactive environment. Use --force to proceed");
            process.exit(EXIT_CODES.ERROR);
          }

          // AC: @spec-item-delete-children ac-1 - Prompt for confirmation
          const readline = await import("node:readline");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await new Promise<string>((resolve) => {
            rl.question(`Remove acceptance criterion ${acId}? [y/N] `, resolve);
          });
          rl.close();

          // AC: @spec-item-delete-children ac-3 - User declines (n, N, or empty)
          if (answer.toLowerCase() !== "y") {
            error("Operation cancelled");
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
        }

        // AC: @spec-item-delete-children ac-4 - With --force, proceed immediately without prompt
        // AC: @spec-item-delete-children ac-2 - User confirmed, proceed with removal
        const updatedAc = existingAc.filter((ac) => ac.id !== acId);
        await updateSpecItem(ctx, item, { acceptance_criteria: updatedAc });

        const itemSlug = item.slugs[0] || refIndex.shortUlid(item._ulid);
        await commitIfShadow(ctx.shadow, "item-ac-remove", itemSlug);
        success(`Removed acceptance criterion: ${acId} from @${itemSlug}`, {
          removed: acId,
        });
      } catch (err) {
        error(errors.failures.removeAc, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

// ─── Patch Helpers ───────────────────────────────────────────────────────────

/**
 * Read stdin fully with timeout (for bulk input).
 * Returns null if stdin is a TTY or empty.
 */
async function readStdinFully(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }

  return new Promise((resolve) => {
    let data = "";

    const onData = (chunk: string) => {
      data += chunk;
    };
    const onEnd = () => {
      clearTimeout(timeout);
      cleanup();
      resolve(data || null);
    };
    const onError = () => {
      clearTimeout(timeout);
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(data || null);
    }, 5000); // 5 second timeout for bulk input

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}

/**
 * Read stdin if available (non-blocking for single item mode).
 * Returns null quickly if no data available.
 */
async function readStdinIfAvailable(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }

  return new Promise((resolve) => {
    let data = "";

    const onData = (chunk: string) => {
      data += chunk;
    };
    const onEnd = () => {
      clearTimeout(timeout);
      cleanup();
      resolve(data || null);
    };
    const onError = () => {
      clearTimeout(timeout);
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(data || null);
    }, 100); // 100ms timeout for quick check

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}

/**
 * Parse bulk input (JSONL or JSON array)
 */
function parseBulkInput(input: string): PatchOperation[] {
  const trimmed = input.trim();

  // Try JSON array first
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(errors.validation.expectedJsonArray);
    }
    return parsed.map((item, i) => validatePatchOperation(item, i));
  }

  // Parse as JSONL (one JSON object per line)
  const lines = trimmed.split("\n").filter((line) => line.trim());
  return lines.map((line, i) => {
    try {
      return validatePatchOperation(JSON.parse(line), i);
    } catch (err) {
      throw new Error(
        errors.validation.jsonLineError(i + 1, err instanceof Error ? err.message : "Invalid JSON"),
        { cause: err },
      );
    }
  });
}

/**
 * Validate a patch operation object
 */
function validatePatchOperation(obj: unknown, index: number): PatchOperation {
  if (!obj || typeof obj !== "object") {
    throw new Error(errors.validation.patchMustBeObject(index));
  }
  const op = obj as Record<string, unknown>;
  if (typeof op.ref !== "string" || !op.ref) {
    throw new Error(errors.validation.patchMustHaveRef(index));
  }
  if (!op.data || typeof op.data !== "object") {
    throw new Error(errors.validation.patchMustHaveData(index));
  }
  return { ref: op.ref, data: op.data as Record<string, unknown> };
}

/**
 * Format bulk patch result for human output
 */
function formatBulkPatchResult(result: BulkPatchResult, isDryRun = false): void {
  const prefix = isDryRun ? "Would patch" : "Patched";
  const updatedUlids = result.results
    .map((entry) => entry.ulid)
    .filter((ulid): ulid is string => typeof ulid === "string");

  for (const r of result.results) {
    if (r.status === "updated") {
      const shortUlid = r.ulid ? shortestUniqueUlid(r.ulid, updatedUlids) : undefined;
      console.log(chalk.green("OK"), `${prefix}: ${r.ref} (${shortUlid})`);
    } else if (r.status === "error") {
      console.log(chalk.red("ERR"), `${r.ref}: ${r.error}`);
    } else {
      console.log(chalk.gray("SKIP"), r.ref);
    }
  }

  console.log("");
  console.log(chalk.bold("Summary:"));
  console.log(`  Total: ${result.summary.total}`);
  console.log(chalk.green(`  Updated: ${result.summary.updated}`));
  if (result.summary.failed > 0) {
    console.log(chalk.red(`  Failed: ${result.summary.failed}`));
  }
  if (result.summary.skipped > 0) {
    console.log(chalk.gray(`  Skipped: ${result.summary.skipped}`));
  }
}
