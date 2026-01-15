import { Command } from 'commander';
import chalk from 'chalk';
import {
  initContext,
  buildIndexes,
  type LoadedSpecItem,
} from '../../parser/index.js';
import type { ItemFilter } from '../../parser/items.js';
import type { ItemType, Maturity, ImplementationStatus } from '../../schema/index.js';
import { output, error, isJsonMode } from '../output.js';

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
}
