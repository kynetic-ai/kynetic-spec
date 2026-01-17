import { Command } from 'commander';
import chalk from 'chalk';
import {
  initContext,
  buildIndexes,
} from '../../parser/index.js';
import type { LoadedSpecItem, LoadedTask } from '../../parser/yaml.js';
import { output, error, formatTaskList } from '../output.js';
import { grepItem, formatMatchedFields } from '../../utils/grep.js';

/**
 * Format a spec item for search results
 */
function formatSearchItem(item: LoadedSpecItem, matchedFields: string[]): void {
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
    }
  }

  let line = `${chalk.gray(shortId)} ${typeStr} ${item.title}`;
  if (slugStr) line += ` ${slugStr}`;
  if (status) line += ` ${status}`;

  console.log(line);
  console.log(chalk.gray(`  matched: ${formatMatchedFields(matchedFields)}`));
}

/**
 * Format a task for search results
 */
function formatSearchTask(task: LoadedTask, matchedFields: string[]): void {
  const shortId = task._ulid.slice(0, 8);
  const slugStr = task.slugs.length > 0 ? chalk.cyan(`@${task.slugs[0]}`) : '';

  const statusColor = task.status === 'completed' ? chalk.green
    : task.status === 'in_progress' ? chalk.blue
      : task.status === 'blocked' ? chalk.red
        : chalk.gray;

  const priority = task.priority <= 2 ? chalk.red(`P${task.priority}`) : chalk.gray(`P${task.priority}`);

  let line = `${chalk.gray(shortId)} ${statusColor(`[${task.status}]`)} ${priority} ${task.title}`;
  if (slugStr) line += ` ${slugStr}`;

  console.log(line);
  console.log(chalk.gray(`  matched: ${formatMatchedFields(matchedFields)}`));
}

interface SearchResult {
  type: 'item' | 'task';
  item: LoadedSpecItem | LoadedTask;
  matchedFields: string[];
}

/**
 * Register the search command
 */
export function registerSearchCommand(program: Command): void {
  program
    .command('search <pattern>')
    .description('Search across all items and tasks with regex pattern')
    .option('-t, --type <type>', 'Filter by item type')
    .option('-s, --status <status>', 'Filter by task status')
    .option('--items-only', 'Search only spec items')
    .option('--tasks-only', 'Search only tasks')
    .option('--limit <n>', 'Limit results', '50')
    .action(async (pattern, options) => {
      try {
        const ctx = await initContext();
        const { itemIndex, tasks, items, refIndex } = await buildIndexes(ctx);

        const results: SearchResult[] = [];
        const limit = parseInt(options.limit, 10) || 50;

        // Search spec items
        if (!options.tasksOnly) {
          for (const item of items) {
            // Apply type filter
            if (options.type && item.type !== options.type) continue;

            const match = grepItem(item as Record<string, unknown>, pattern);
            if (match) {
              results.push({
                type: 'item',
                item,
                matchedFields: match.matchedFields,
              });
            }
          }
        }

        // Search tasks
        if (!options.itemsOnly) {
          for (const task of tasks) {
            // Apply status filter
            if (options.status && task.status !== options.status) continue;

            const match = grepItem(task as unknown as Record<string, unknown>, pattern);
            if (match) {
              results.push({
                type: 'task',
                item: task,
                matchedFields: match.matchedFields,
              });
            }
          }
        }

        // Limit results
        const limitedResults = results.slice(0, limit);

        output(
          {
            pattern,
            results: limitedResults.map(r => ({
              type: r.type,
              ulid: r.item._ulid,
              title: r.item.title,
              matchedFields: r.matchedFields,
            })),
            total: results.length,
            showing: limitedResults.length,
          },
          () => {
            if (limitedResults.length === 0) {
              console.log(chalk.gray(`No matches found for "${pattern}"`));
              return;
            }

            for (const result of limitedResults) {
              if (result.type === 'item') {
                formatSearchItem(result.item as LoadedSpecItem, result.matchedFields);
              } else {
                formatSearchTask(result.item as LoadedTask, result.matchedFields);
              }
            }

            console.log(chalk.gray(`\n${limitedResults.length} result(s)${results.length > limit ? ` (showing first ${limit})` : ''}`));
          }
        );
      } catch (err) {
        error('Failed to search', err);
        process.exit(1);
      }
    });
}
