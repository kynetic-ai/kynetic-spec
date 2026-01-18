import { Command } from 'commander';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  getReadyTasks,
  ReferenceIndex,
} from '../../parser/index.js';
import {
  output,
  formatTaskList,
  error,
  info,
} from '../output.js';
import type { TaskStatus } from '../../schema/index.js';
import { grepItem } from '../../utils/grep.js';
import { errors } from '../../strings/index.js';

/**
 * Register the 'tasks' command group
 */
export function registerTasksCommands(program: Command): void {
  const tasks = program
    .command('tasks')
    .description('Query and list tasks');

  // kspec tasks list
  tasks
    .command('list')
    .description('List all tasks')
    .option('-s, --status <status>', 'Filter by status')
    .option('-t, --type <type>', 'Filter by type')
    .option('--tag <tag>', 'Filter by tag')
    .option('--meta-ref <ref>', 'Filter by meta reference')
    .option('-g, --grep <pattern>', 'Search content with regex pattern')
    .option('-v, --verbose', 'Show more details')
    .option('--full', 'Show full details (notes, todos, timestamps)')
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);

        // Load meta items if filtering by meta-ref
        const { loadMetaContext } = await import('../../parser/meta.js');
        const metaContext = await loadMetaContext(ctx);
        const allMetaItems = [
          ...metaContext.agents,
          ...metaContext.workflows,
          ...metaContext.conventions,
          ...metaContext.observations,
        ];

        const index = new ReferenceIndex(tasks, items, allMetaItems);

        let taskList = tasks;

        // Apply filters
        if (options.status) {
          taskList = taskList.filter(t => t.status === options.status);
        }
        if (options.type) {
          taskList = taskList.filter(t => t.type === options.type);
        }
        if (options.tag) {
          taskList = taskList.filter(t => t.tags.includes(options.tag));
        }
        if (options.metaRef) {
          // AC-meta-ref-2: Filter tasks by meta_ref
          const metaRefResult = index.resolve(options.metaRef);
          if (!metaRefResult.ok) {
            error(errors.reference.metaRefNotFound(options.metaRef));
            process.exit(3);
          }
          const targetRef = options.metaRef.startsWith('@') ? options.metaRef : `@${options.metaRef}`;
          taskList = taskList.filter(t => t.meta_ref === targetRef || t.meta_ref === options.metaRef);
        }
        if (options.grep) {
          taskList = taskList.filter(t => {
            const match = grepItem(t as unknown as Record<string, unknown>, options.grep);
            return match !== null;
          });
        }

        output(taskList, () => formatTaskList(taskList, options.verbose, index, options.grep, options.full));
      } catch (err) {
        error(errors.failures.listTasks, err);
        process.exit(1);
      }
    });

  // kspec tasks ready
  tasks
    .command('ready')
    .description('List tasks that are ready to work on')
    .option('-v, --verbose', 'Show more details')
    .option('--full', 'Show full details (notes, todos, timestamps)')
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const allTasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(allTasks, items);
        const readyTasks = getReadyTasks(allTasks);

        output(readyTasks, () => {
          if (readyTasks.length === 0) {
            info('No tasks ready - all pending tasks are blocked or have unmet dependencies');
          } else {
            formatTaskList(readyTasks, options.verbose, index, undefined, options.full);
          }
        });
      } catch (err) {
        error(errors.failures.getReadyTasks, err);
        process.exit(1);
      }
    });

  // kspec tasks next
  tasks
    .command('next')
    .description('Show the highest-priority ready task')
    .action(async () => {
      try {
        const ctx = await initContext();
        const allTasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(allTasks, items);
        const readyTasks = getReadyTasks(allTasks);

        if (readyTasks.length === 0) {
          output(null, () => info('No tasks ready'));
        } else {
          const next = readyTasks[0];
          output(next, () => {
            console.log(`${index.shortUlid(next._ulid)} ${next.title}`);
          });
        }
      } catch (err) {
        error(errors.failures.getNextTask, err);
        process.exit(1);
      }
    });

  // kspec tasks blocked
  tasks
    .command('blocked')
    .description('Show blocked tasks')
    .option('-v, --verbose', 'Show more details')
    .option('--full', 'Show full details (notes, todos, timestamps)')
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const allTasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(allTasks, items);
        const blockedTasks = allTasks.filter(t => t.status === 'blocked');

        output(blockedTasks, () => formatTaskList(blockedTasks, options.verbose, index, undefined, options.full));
      } catch (err) {
        error(errors.failures.getBlockedTasks, err);
        process.exit(1);
      }
    });

  // kspec tasks in-progress
  tasks
    .command('in-progress')
    .alias('active')
    .description('Show tasks in progress')
    .option('-v, --verbose', 'Show more details')
    .option('--full', 'Show full details (notes, todos, timestamps)')
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const allTasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(allTasks, items);
        const activeTasks = allTasks.filter(t => t.status === 'in_progress');

        output(activeTasks, () => formatTaskList(activeTasks, options.verbose, index, undefined, options.full));
      } catch (err) {
        error(errors.failures.getActiveTasks, err);
        process.exit(1);
      }
    });
}
