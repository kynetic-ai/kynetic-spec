import { Command } from 'commander';
import {
  initContext,
  loadInboxItems,
  createInboxItem,
  saveInboxItem,
  deleteInboxItem,
  findInboxItemByRef,
  loadAllTasks,
  loadAllItems,
  createTask,
  saveTask,
  ReferenceIndex,
  type LoadedInboxItem,
} from '../../parser/index.js';
import { commitIfShadow } from '../../parser/shadow.js';
import {
  output,
  success,
  error,
  warn,
  info,
} from '../output.js';
import type { InboxItemInput, TaskInput } from '../../schema/index.js';
import * as readline from 'node:readline';
import { errors } from '../../strings/index.js';

/**
 * Format relative time for display
 */
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString();
}

/**
 * Get short ULID for display (first 8 chars)
 */
function shortUlid(ulid: string): string {
  return ulid.slice(0, 8);
}

/**
 * Resolve inbox item ref with error handling
 */
function resolveInboxRef(ref: string, items: LoadedInboxItem[]): LoadedInboxItem {
  const item = findInboxItemByRef(items, ref);
  if (!item) {
    error(errors.reference.inboxNotFound(ref));
    process.exit(3);
  }
  return item;
}

/**
 * Simple prompt for user input
 */
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Register the 'inbox' command group
 */
export function registerInboxCommands(program: Command): void {
  const inbox = program
    .command('inbox')
    .description('Low-friction capture for ideas (not yet tasks)');

  // kspec inbox add <text>
  inbox
    .command('add <text>')
    .description('Capture an idea quickly')
    .option('--tag <tag...>', 'Add tags for categorization')
    .action(async (text: string, options) => {
      try {
        const ctx = await initContext();

        const input: InboxItemInput = {
          text,
          tags: options.tag || [],
        };

        const item = createInboxItem(input);
        await saveInboxItem(ctx, item);
        await commitIfShadow(ctx.shadow, 'inbox-add', undefined, text);

        success(`Captured: ${shortUlid(item._ulid)}`, { item });
      } catch (err) {
        error(errors.failures.addInboxItem, err);
        process.exit(1);
      }
    });

  // kspec inbox list
  inbox
    .command('list')
    .description('Show inbox items (oldest first for triage)')
    .option('--tag <tag>', 'Filter by tag')
    .option('--limit <n>', 'Limit results')
    .option('--newest', 'Sort newest first (default is oldest first)')
    .action(async (options) => {
      try {
        const ctx = await initContext();
        let items = await loadInboxItems(ctx);

        // Filter by tag
        if (options.tag) {
          items = items.filter(i => i.tags.includes(options.tag));
        }

        // Sort: oldest first by default (for triage), newest if requested
        items.sort((a, b) => {
          const dateA = new Date(a.created_at).getTime();
          const dateB = new Date(b.created_at).getTime();
          return options.newest ? dateB - dateA : dateA - dateB;
        });

        // Limit
        if (options.limit) {
          const limit = parseInt(options.limit, 10);
          items = items.slice(0, limit);
        }

        output(items, () => {
          if (items.length === 0) {
            console.log('Inbox is empty');
            return;
          }

          console.log(`Inbox (${items.length} item${items.length === 1 ? '' : 's'}):\n`);

          for (const item of items) {
            const tags = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : '';
            const age = formatRelativeTime(item.created_at);
            const author = item.added_by ? ` by ${item.added_by}` : '';
            console.log(`  ${shortUlid(item._ulid)} (${age}${author})${tags}`);
            console.log(`    ${item.text}`);
            console.log('');
          }
        });
      } catch (err) {
        error(errors.failures.listInboxItems, err);
        process.exit(1);
      }
    });

  // kspec inbox promote <ref>
  inbox
    .command('promote <ref>')
    .description('Convert inbox item to task')
    .option('--title <title>', 'Task title (prompts if not provided)')
    .option('--priority <n>', 'Priority (1-5)', '3')
    .option('--type <type>', 'Task type (task, bug, spike, etc.)', 'task')
    .option('--spec-ref <ref>', 'Link to spec item')
    .option('--tag <tag...>', 'Tags for the task')
    .option('--keep', 'Keep inbox item after promoting')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const inboxItems = await loadInboxItems(ctx);
        const item = resolveInboxRef(ref, inboxItems);

        // Determine task title
        let title = options.title;
        if (!title) {
          // Interactive prompt
          console.log(`Promoting: "${item.text}"`);
          console.log('');
          title = await prompt('Task title: ');
          if (!title) {
            error(errors.validation.titleRequired);
            process.exit(2);
          }
        }

        // Create the task
        const taskInput: TaskInput = {
          title,
          type: options.type,
          priority: parseInt(options.priority, 10),
          spec_ref: options.specRef || null,
          tags: options.tag || item.tags, // Inherit tags from inbox item if not specified
          description: item.text, // Original idea becomes description
        };

        const task = createTask(taskInput);
        await saveTask(ctx, task);

        // Load for index to get short ULID
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);

        // Delete inbox item unless --keep
        if (!options.keep) {
          await deleteInboxItem(ctx, item._ulid);
          info(`Removed from inbox: ${shortUlid(item._ulid)}`);
        }

        await commitIfShadow(ctx.shadow, 'inbox-promote', task.slugs[0] || index.shortUlid(task._ulid));
        success(`Created task: ${index.shortUlid(task._ulid)} - ${title}`, { task });
      } catch (err) {
        error(errors.failures.promoteInboxItem, err);
        process.exit(1);
      }
    });

  // kspec inbox delete <ref>
  inbox
    .command('delete <ref>')
    .description('Remove an inbox item')
    .option('--force', 'Skip confirmation')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const items = await loadInboxItems(ctx);
        const item = resolveInboxRef(ref, items);

        // Confirm unless --force
        if (!options.force) {
          console.log(`Delete: "${item.text}"`);
          const confirm = await prompt('Are you sure? (y/N): ');
          if (confirm.toLowerCase() !== 'y') {
            console.log('Cancelled');
            return;
          }
        }

        const deleted = await deleteInboxItem(ctx, item._ulid);
        if (deleted) {
          await commitIfShadow(ctx.shadow, 'inbox-delete', shortUlid(item._ulid));
          success(`Deleted inbox item: ${shortUlid(item._ulid)}`);
        } else {
          error(errors.failures.deleteInboxItem);
          process.exit(1);
        }
      } catch (err) {
        error(errors.failures.deleteInboxItem, err);
        process.exit(1);
      }
    });

  // kspec inbox get <ref>
  inbox
    .command('get <ref>')
    .description('Show details of an inbox item')
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const items = await loadInboxItems(ctx);
        const item = resolveInboxRef(ref, items);

        output(item, () => {
          console.log(`ULID:     ${item._ulid}`);
          console.log(`Created:  ${item.created_at} (${formatRelativeTime(item.created_at)})`);
          if (item.added_by) {
            console.log(`Added by: ${item.added_by}`);
          }
          if (item.tags.length > 0) {
            console.log(`Tags:     ${item.tags.join(', ')}`);
          }
          console.log('');
          console.log(item.text);
        });
      } catch (err) {
        error(errors.failures.getInboxItem, err);
        process.exit(1);
      }
    });
}
