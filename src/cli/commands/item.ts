import { Command } from 'commander';
import chalk from 'chalk';
import {
  initContext,
  buildIndexes,
  createSpecItem,
  deleteSpecItem,
  updateSpecItem,
  addChildItem,
  loadAllItems,
  loadAllTasks,
  ReferenceIndex,
  AlignmentIndex,
  checkSlugUniqueness,
  type LoadedSpecItem,
} from '../../parser/index.js';
import { commitIfShadow } from '../../parser/shadow.js';
import type { ItemFilter } from '../../parser/items.js';
import type { ItemType, Maturity, ImplementationStatus, SpecItemInput, AcceptanceCriterion } from '../../schema/index.js';
import { output, error, success, warn, isJsonMode } from '../output.js';

/**
 * Format a spec item for display
 */
function formatItem(item: LoadedSpecItem, verbose = false): string {
  const shortId = item._ulid.slice(0, 8);
  const slugStr = item.slugs.length > 0 ? chalk.cyan(`@${item.slugs[0]}`) : '';
  const typeStr = chalk.gray(`[${item.type}]`);

  let status = '';
  if (item.status && typeof item.status === 'object') {
    const s = item.status as { maturity?: string; implementation?: string };
    if (s.implementation) {
      const implColor = s.implementation === 'verified' ? chalk.green
        : s.implementation === 'implemented' ? chalk.cyan
          : s.implementation === 'in_progress' ? chalk.yellow
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
    const tags = 'tags' in item && Array.isArray(item.tags) ? item.tags : [];
    if (tags.length > 0) {
      line += chalk.blue(` #${tags.join(' #')}`);
    }
  }

  return line;
}

/**
 * Format item list for display
 */
function formatItemList(items: LoadedSpecItem[], verbose = false): void {
  if (items.length === 0) {
    console.log(chalk.gray('No items found'));
    return;
  }

  for (const item of items) {
    console.log(formatItem(item, verbose));
  }

  console.log(chalk.gray(`\n${items.length} item(s)`));
}

/**
 * Register item commands
 */
export function registerItemCommands(program: Command): void {
  const item = program
    .command('item')
    .description('Spec item commands');

  // kspec item list
  item
    .command('list')
    .description('List spec items with optional filters')
    .option('-t, --type <type>', 'Filter by item type (module, feature, requirement, constraint, decision)')
    .option('-s, --status <status>', 'Filter by implementation status (not_started, in_progress, implemented, verified)')
    .option('-m, --maturity <maturity>', 'Filter by maturity (draft, proposed, stable, deprecated)')
    .option('--tag <tag>', 'Filter by tag (can specify multiple)', (val, prev: string[]) => [...prev, val], [])
    .option('--has <field>', 'Filter items that have field present', (val, prev: string[]) => [...prev, val], [])
    .option('-q, --search <text>', 'Search in title')
    .option('-v, --verbose', 'Show more details')
    .option('--limit <n>', 'Limit results', '50')
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const { itemIndex, items } = await buildIndexes(ctx);

        // Build filter from options
        const filter: ItemFilter = {
          specItemsOnly: true, // Only spec items, not tasks
        };

        if (options.type) {
          filter.type = options.type as ItemType;
        }

        if (options.status) {
          filter.implementation = options.status as ImplementationStatus;
        }

        if (options.maturity) {
          filter.maturity = options.maturity as Maturity;
        }

        if (options.tag && options.tag.length > 0) {
          filter.tags = options.tag;
        }

        if (options.has && options.has.length > 0) {
          filter.hasFields = options.has;
        }

        if (options.search) {
          filter.titleContains = options.search;
        }

        const limit = parseInt(options.limit, 10) || 50;
        const result = itemIndex.queryPaginated(filter, 0, limit);

        // Filter to only LoadedSpecItem (not tasks)
        const specItems = result.items.filter((item): item is LoadedSpecItem =>
          !('status' in item && typeof item.status === 'string')
        );

        output(
          {
            items: specItems,
            total: result.total,
            showing: specItems.length,
          },
          () => formatItemList(specItems, options.verbose)
        );
      } catch (err) {
        error('Failed to list items', err);
        process.exit(1);
      }
    });

  // kspec item get <ref>
  item
    .command('get <ref>')
    .description('Get details for a specific item')
    .action(async (ref) => {
      try {
        const ctx = await initContext();
        const { refIndex, items } = await buildIndexes(ctx);

        const result = refIndex.resolve(ref);

        if (!result.ok) {
          error(`Item not found: ${ref}`);
          process.exit(1);
        }

        const item = result.item as LoadedSpecItem;

        output(item, () => {
          console.log(chalk.bold(item.title));
          console.log(chalk.gray('─'.repeat(40)));
          console.log(`ULID:      ${item._ulid}`);
          if (item.slugs.length > 0) {
            console.log(`Slugs:     ${item.slugs.join(', ')}`);
          }
          console.log(`Type:      ${item.type}`);

          if (item.status && typeof item.status === 'object') {
            const s = item.status as { maturity?: string; implementation?: string };
            if (s.maturity) console.log(`Maturity:  ${s.maturity}`);
            if (s.implementation) console.log(`Implementation: ${s.implementation}`);
          }

          if ('tags' in item && Array.isArray(item.tags) && item.tags.length > 0) {
            console.log(`Tags:      ${item.tags.join(', ')}`);
          }

          if (item.description) {
            console.log(chalk.gray('\n─── Description ───'));
            console.log(item.description);
          }

          if ('acceptance_criteria' in item && Array.isArray(item.acceptance_criteria) && item.acceptance_criteria.length > 0) {
            console.log(chalk.gray('\n─── Acceptance Criteria ───'));
            for (const ac of item.acceptance_criteria) {
              if (ac && typeof ac === 'object' && 'id' in ac) {
                const acObj = ac as AcceptanceCriterion;
                console.log(chalk.cyan(`  [${acObj.id}]`));
                if (acObj.given) console.log(`    Given: ${acObj.given}`);
                if (acObj.when) console.log(`    When: ${acObj.when}`);
                if (acObj.then) console.log(`    Then: ${acObj.then}`);
              }
            }
          }
        });
      } catch (err) {
        error('Failed to get item', err);
        process.exit(1);
      }
    });

  // kspec item types - show available types and counts
  item
    .command('types')
    .description('Show item types and counts')
    .action(async () => {
      try {
        const ctx = await initContext();
        const { itemIndex } = await buildIndexes(ctx);

        const typeCounts = itemIndex.getTypeCounts();

        output(
          Object.fromEntries(typeCounts),
          () => {
            console.log(chalk.bold('Item Types'));
            console.log(chalk.gray('─'.repeat(30)));
            for (const [type, count] of typeCounts) {
              console.log(`  ${type}: ${count}`);
            }
            console.log(chalk.gray(`\nTotal: ${itemIndex.size} items`));
          }
        );
      } catch (err) {
        error('Failed to get types', err);
        process.exit(1);
      }
    });

  // kspec item tags - show available tags and counts
  item
    .command('tags')
    .description('Show tags and counts')
    .action(async () => {
      try {
        const ctx = await initContext();
        const { itemIndex } = await buildIndexes(ctx);

        const tagCounts = itemIndex.getTagCounts();

        output(
          Object.fromEntries(tagCounts),
          () => {
            console.log(chalk.bold('Tags'));
            console.log(chalk.gray('─'.repeat(30)));
            for (const [tag, count] of tagCounts) {
              console.log(`  #${tag}: ${count}`);
            }
          }
        );
      } catch (err) {
        error('Failed to get tags', err);
        process.exit(1);
      }
    });

  // kspec item add - create a new spec item under a parent
  item
    .command('add')
    .description('Create a new spec item under a parent')
    .requiredOption('--under <ref>', 'Parent item reference (e.g., @core-primitives)')
    .requiredOption('--title <title>', 'Item title')
    .option('--type <type>', 'Item type (feature, requirement, constraint, decision)', 'feature')
    .option('--slug <slug>', 'Human-friendly slug')
    .option('--priority <priority>', 'Priority (high, medium, low)')
    .option('--tag <tag...>', 'Tags')
    .option('--description <desc>', 'Description')
    .option('--as <field>', 'Child field override (e.g., requirements, constraints)')
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const { refIndex, items } = await buildIndexes(ctx);

        // Find the parent item
        const parentResult = refIndex.resolve(options.under);
        if (!parentResult.ok) {
          error(`Parent item not found: ${options.under}`);
          process.exit(1);
        }

        const parent = parentResult.item as LoadedSpecItem;

        // Check it's not a task
        if ('status' in parent && typeof parent.status === 'string') {
          error(`"${options.under}" is a task. Items can only be added under spec items.`);
          process.exit(1);
        }

        // Check slug uniqueness if provided
        if (options.slug) {
          const slugCheck = checkSlugUniqueness(refIndex, [options.slug]);
          if (!slugCheck.ok) {
            error(`Slug '${slugCheck.slug}' already exists (used by ${slugCheck.existingUlid})`);
            process.exit(1);
          }
        }

        const input: SpecItemInput = {
          title: options.title,
          type: options.type as ItemType,
          slugs: options.slug ? [options.slug] : [],
          priority: options.priority,
          tags: options.tag || [],
          description: options.description,
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
        };

        const newItem = createSpecItem(input);
        const result = await addChildItem(ctx, parent, newItem, options.as);

        // Build index including the new item for accurate short ULID
        const index = new ReferenceIndex([], [...items, result.item as LoadedSpecItem]);
        const itemSlug = (result.item as LoadedSpecItem).slugs?.[0] || index.shortUlid(result.item._ulid);
        await commitIfShadow(ctx.shadow, 'item-add', itemSlug);
        success(`Created item: ${index.shortUlid(result.item._ulid)} under @${parent.slugs[0] || parent._ulid.slice(0, 8)}`, {
          item: result.item,
          path: result.path,
        });
      } catch (err) {
        error('Failed to create item', err);
        process.exit(1);
      }
    });

  // kspec item set - update a spec item field
  item
    .command('set <ref>')
    .description('Update a spec item field')
    .option('--title <title>', 'Set title')
    .option('--type <type>', 'Set type')
    .option('--slug <slug>', 'Add a slug')
    .option('--priority <priority>', 'Set priority')
    .option('--tag <tag...>', 'Set tags (replaces existing)')
    .option('--description <desc>', 'Set description')
    .option('--status <status>', 'Set implementation status (not_started, in_progress, implemented, verified)')
    .option('--maturity <maturity>', 'Set maturity (draft, proposed, stable, deprecated)')
    .action(async (ref, options) => {
      try {
        const ctx = await initContext();
        const { refIndex, items } = await buildIndexes(ctx);

        const result = refIndex.resolve(ref);
        if (!result.ok) {
          error(`Item not found: ${ref}`);
          process.exit(1);
        }

        const foundItem = result.item as LoadedSpecItem;

        // Check if it's a task (tasks should use task commands)
        if ('status' in foundItem && typeof foundItem.status === 'string') {
          error(`"${ref}" is a task. Use 'kspec task' commands instead.`);
          process.exit(1);
        }

        // Check slug uniqueness if adding a new slug
        if (options.slug) {
          const slugCheck = checkSlugUniqueness(refIndex, [options.slug], foundItem._ulid);
          if (!slugCheck.ok) {
            error(`Slug '${slugCheck.slug}' already exists (used by ${slugCheck.existingUlid})`);
            process.exit(1);
          }
        }

        // Build updates object
        const updates: Partial<SpecItemInput> = {};

        if (options.title) updates.title = options.title;
        if (options.type) updates.type = options.type as ItemType;
        if (options.slug) {
          updates.slugs = [...(foundItem.slugs || []), options.slug];
        }
        if (options.priority) updates.priority = options.priority;
        if (options.tag) updates.tags = options.tag;
        if (options.description) updates.description = options.description;

        // Handle status updates
        if (options.status || options.maturity) {
          const currentStatus = foundItem.status && typeof foundItem.status === 'object'
            ? foundItem.status
            : {};
          updates.status = {
            ...currentStatus,
            ...(options.status && { implementation: options.status }),
            ...(options.maturity && { maturity: options.maturity }),
          };
        }

        if (Object.keys(updates).length === 0) {
          warn('No updates specified');
          return;
        }

        const updated = await updateSpecItem(ctx, foundItem, updates);
        const itemSlug = foundItem.slugs[0] || refIndex.shortUlid(foundItem._ulid);
        await commitIfShadow(ctx.shadow, 'item-set', itemSlug);
        success(`Updated item: ${refIndex.shortUlid(updated._ulid)}`, { item: updated });
      } catch (err) {
        error('Failed to update item', err);
        process.exit(1);
      }
    });

  // kspec item delete - delete a spec item
  item
    .command('delete <ref>')
    .description('Delete a spec item (including nested items)')
    .option('--force', 'Skip confirmation')
    .action(async (ref, options) => {
      try {
        const ctx = await initContext();
        const { refIndex, items } = await buildIndexes(ctx);

        const result = refIndex.resolve(ref);
        if (!result.ok) {
          error(`Item not found: ${ref}`);
          process.exit(1);
        }

        const foundItem = result.item as LoadedSpecItem;

        // Check if it's a task
        if ('status' in foundItem && typeof foundItem.status === 'string') {
          error(`"${ref}" is a task. Use 'kspec task cancel' instead.`);
          process.exit(1);
        }

        if (!foundItem._sourceFile) {
          error('Cannot delete item: no source file tracked');
          process.exit(1);
        }

        // Warn about nested children being deleted too
        // TODO: could add a check here for child items

        const deleted = await deleteSpecItem(ctx, foundItem);
        if (deleted) {
          const itemSlug = foundItem.slugs[0] || refIndex.shortUlid(foundItem._ulid);
          await commitIfShadow(ctx.shadow, 'item-delete', itemSlug);
          success(`Deleted item: ${foundItem.title}`, { deleted: true, ulid: foundItem._ulid });
        } else {
          error('Failed to delete item');
          console.log(chalk.gray('Edit the source file directly: ' + foundItem._sourceFile));
          process.exit(1);
        }
      } catch (err) {
        error('Failed to delete item', err);
        process.exit(1);
      }
    });

  // kspec item status - show implementation status with linked tasks
  item
    .command('status <ref>')
    .description('Show implementation status and linked tasks for a spec item')
    .action(async (ref) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const refIndex = new ReferenceIndex(tasks, items);

        const result = refIndex.resolve(ref);
        if (!result.ok) {
          error(`Item not found: ${ref}`);
          process.exit(1);
        }

        const foundItem = result.item as LoadedSpecItem;

        // Check if it's a task
        if ('status' in foundItem && typeof foundItem.status === 'string') {
          error(`"${ref}" is a task, not a spec item. Use 'kspec task get' instead.`);
          process.exit(1);
        }

        // Build alignment index
        const alignmentIndex = new AlignmentIndex(tasks, items);
        alignmentIndex.buildLinks(refIndex);

        const summary = alignmentIndex.getImplementationSummary(foundItem._ulid);

        if (!summary) {
          error('Could not get implementation summary');
          process.exit(1);
        }

        output(summary, () => {
          console.log(chalk.bold(foundItem.title));
          console.log(chalk.gray('─'.repeat(40)));

          // Status
          const currentColor = summary.currentStatus === 'implemented' ? chalk.green
            : summary.currentStatus === 'in_progress' ? chalk.yellow
              : chalk.gray;
          const expectedColor = summary.expectedStatus === 'implemented' ? chalk.green
            : summary.expectedStatus === 'in_progress' ? chalk.yellow
              : chalk.gray;

          console.log(`Current status:  ${currentColor(summary.currentStatus)}`);
          console.log(`Expected status: ${expectedColor(summary.expectedStatus)}`);

          if (!summary.isAligned) {
            console.log(chalk.yellow('\n⚠ Status mismatch - run task complete to sync'));
          } else {
            console.log(chalk.green('\n✓ Aligned'));
          }

          // Linked tasks
          console.log(chalk.bold('\nLinked Tasks:'));
          if (summary.linkedTasks.length === 0) {
            console.log(chalk.gray('  No tasks reference this spec item'));
          } else {
            for (const task of summary.linkedTasks) {
              const statusColor = task.taskStatus === 'completed' ? chalk.green
                : task.taskStatus === 'in_progress' ? chalk.blue
                  : chalk.gray;
              const shortId = task.taskUlid.slice(0, 8);
              const notes = task.hasNotes ? chalk.gray(' (has notes)') : '';
              console.log(`  ${statusColor(`[${task.taskStatus}]`)} ${shortId} ${task.taskTitle}${notes}`);
            }
          }
        });
      } catch (err) {
        error('Failed to get item status', err);
        process.exit(1);
      }
    });

  // Create subcommand group for acceptance criteria operations
  const acCmd = item
    .command('ac')
    .description('Manage acceptance criteria on spec items');

  // Helper: Generate next AC ID based on existing AC
  function generateNextAcId(existingAc: AcceptanceCriterion[] | undefined): string {
    if (!existingAc || existingAc.length === 0) return 'ac-1';

    const numericIds = existingAc
      .map(ac => ac.id.match(/^ac-(\d+)$/)?.[1])
      .filter((id): id is string => id !== null && id !== undefined)
      .map(Number);

    const maxId = numericIds.length > 0 ? Math.max(...numericIds) : 0;
    return `ac-${maxId + 1}`;
  }

  // Helper: Resolve ref to spec item (not task)
  async function resolveSpecItem(ref: string): Promise<{ ctx: Awaited<ReturnType<typeof initContext>>; item: LoadedSpecItem; refIndex: ReferenceIndex }> {
    const ctx = await initContext();
    const { refIndex, items } = await buildIndexes(ctx);

    const result = refIndex.resolve(ref);
    if (!result.ok) {
      error(`Item not found: ${ref}`);
      process.exit(3);
    }

    const foundItem = result.item as LoadedSpecItem;

    // Check if it's a task
    if ('status' in foundItem && typeof foundItem.status === 'string') {
      error(`Tasks don't have acceptance criteria; "${ref}" is a task`);
      process.exit(3);
    }

    return { ctx, item: foundItem, refIndex };
  }

  // kspec item ac list <ref>
  acCmd
    .command('list <ref>')
    .description('List acceptance criteria for a spec item')
    .action(async (ref: string) => {
      try {
        const { item, refIndex } = await resolveSpecItem(ref);
        const ac = item.acceptance_criteria || [];

        output(ac, () => {
          console.log(chalk.bold(`Acceptance Criteria for: ${item.title} (@${item.slugs[0] || refIndex.shortUlid(item._ulid)})`));
          console.log();

          if (ac.length === 0) {
            console.log(chalk.gray('No acceptance criteria'));
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
        error('Failed to list acceptance criteria', err);
        process.exit(1);
      }
    });

  // kspec item ac add <ref>
  acCmd
    .command('add <ref>')
    .description('Add an acceptance criterion to a spec item')
    .option('--id <id>', 'AC identifier (auto-generated if not provided)')
    .requiredOption('--given <text>', 'The precondition (Given...)')
    .requiredOption('--when <text>', 'The action/trigger (When...)')
    .requiredOption('--then <text>', 'The expected outcome (Then...)')
    .action(async (ref: string, options) => {
      try {
        const { ctx, item, refIndex } = await resolveSpecItem(ref);
        const existingAc = item.acceptance_criteria || [];

        // Determine ID
        const acId = options.id || generateNextAcId(existingAc);

        // Check for duplicate ID
        if (existingAc.some(ac => ac.id === acId)) {
          error(`Acceptance criterion "${acId}" already exists on @${item.slugs[0] || refIndex.shortUlid(item._ulid)}`);
          process.exit(3);
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
        await commitIfShadow(ctx.shadow, 'item-ac-add', itemSlug);
        success(`Added acceptance criterion: ${acId} to @${itemSlug}`, { ac: newAc });
      } catch (err) {
        error('Failed to add acceptance criterion', err);
        process.exit(1);
      }
    });

  // kspec item ac set <ref> <ac-id>
  acCmd
    .command('set <ref> <acId>')
    .description('Update an acceptance criterion')
    .option('--id <newId>', 'Rename the AC ID')
    .option('--given <text>', 'Update the precondition')
    .option('--when <text>', 'Update the action/trigger')
    .option('--then <text>', 'Update the expected outcome')
    .action(async (ref: string, acId: string, options) => {
      try {
        const { ctx, item, refIndex } = await resolveSpecItem(ref);
        const existingAc = item.acceptance_criteria || [];

        // Find the AC
        const acIndex = existingAc.findIndex(ac => ac.id === acId);
        if (acIndex === -1) {
          error(`Acceptance criterion "${acId}" not found on @${item.slugs[0] || refIndex.shortUlid(item._ulid)}`);
          process.exit(3);
        }

        // Check for no updates
        if (!options.id && !options.given && !options.when && !options.then) {
          warn('No updates specified');
          return;
        }

        // Check for duplicate ID if renaming
        if (options.id && options.id !== acId && existingAc.some(ac => ac.id === options.id)) {
          error(`Acceptance criterion "${options.id}" already exists`);
          process.exit(3);
        }

        // Build updated AC
        const updatedAc = [...existingAc];
        const updatedFields: string[] = [];

        updatedAc[acIndex] = {
          ...updatedAc[acIndex],
          ...(options.id && { id: options.id }),
          ...(options.given && { given: options.given }),
          ...(options.when && { when: options.when }),
          ...(options.then && { then: options.then }),
        };

        if (options.id) updatedFields.push('id');
        if (options.given) updatedFields.push('given');
        if (options.when) updatedFields.push('when');
        if (options.then) updatedFields.push('then');

        // Update item
        await updateSpecItem(ctx, item, { acceptance_criteria: updatedAc });

        const itemSlug = item.slugs[0] || refIndex.shortUlid(item._ulid);
        await commitIfShadow(ctx.shadow, 'item-ac-set', itemSlug);
        success(`Updated acceptance criterion: ${acId} on @${itemSlug} (${updatedFields.join(', ')})`, { ac: updatedAc[acIndex] });
      } catch (err) {
        error('Failed to update acceptance criterion', err);
        process.exit(1);
      }
    });

  // kspec item ac remove <ref> <ac-id>
  acCmd
    .command('remove <ref> <acId>')
    .description('Remove an acceptance criterion')
    .option('--force', 'Skip confirmation')
    .action(async (ref: string, acId: string, options) => {
      try {
        const { ctx, item, refIndex } = await resolveSpecItem(ref);
        const existingAc = item.acceptance_criteria || [];

        // Find the AC
        const acIndex = existingAc.findIndex(ac => ac.id === acId);
        if (acIndex === -1) {
          error(`Acceptance criterion "${acId}" not found on @${item.slugs[0] || refIndex.shortUlid(item._ulid)}`);
          process.exit(3);
        }

        // TODO: Add confirmation prompt when !options.force
        // For now, proceed with deletion

        // Remove the AC
        const updatedAc = existingAc.filter(ac => ac.id !== acId);
        await updateSpecItem(ctx, item, { acceptance_criteria: updatedAc });

        const itemSlug = item.slugs[0] || refIndex.shortUlid(item._ulid);
        await commitIfShadow(ctx.shadow, 'item-ac-remove', itemSlug);
        success(`Removed acceptance criterion: ${acId} from @${itemSlug}`, { removed: acId });
      } catch (err) {
        error('Failed to remove acceptance criterion', err);
        process.exit(1);
      }
    });
}
