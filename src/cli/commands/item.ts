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
  type LoadedSpecItem,
} from '../../parser/index.js';
import type { ItemFilter } from '../../parser/items.js';
import type { ItemType, Maturity, ImplementationStatus, SpecItemInput } from '../../schema/index.js';
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
}
