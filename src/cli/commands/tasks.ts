import { Command } from 'commander';
import chalk from 'chalk';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  getReadyTasks,
  ReferenceIndex,
  saveTask,
  createNote,
  assessTask,
  filterTasksForAssessment,
  computeSummary,
  computeAutoModeChanges,
  type TaskAssessment,
  type AssessmentSummary,
  type AutoModeChange,
} from '../../parser/index.js';
import { commitIfShadow } from '../../parser/shadow.js';
import {
  output,
  formatTaskList,
  formatTaskListWithAutomation,
  error,
  info,
  success,
} from '../output.js';
import type { TaskStatus } from '../../schema/index.js';
import { grepItem } from '../../utils/grep.js';
import { errors } from '../../strings/index.js';
import { EXIT_CODES } from '../exit-codes.js';

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
            process.exit(EXIT_CODES.NOT_FOUND);
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
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec tasks ready
  // AC: @task-automation-eligibility ac-14, ac-19, ac-20, ac-24
  tasks
    .command('ready')
    .description('List tasks that are ready to work on')
    .option('-v, --verbose', 'Show more details')
    .option('--full', 'Show full details (notes, todos, timestamps)')
    .option('--eligible', 'Show only tasks with automation: eligible')
    .option('--unassessed', 'Show only tasks without automation status')
    .option('--needs-review', 'Show only tasks with automation: needs_review')
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const allTasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(allTasks, items);
        let readyTasks = getReadyTasks(allTasks);

        // AC: @task-automation-eligibility ac-19 - filter by --eligible
        if (options.eligible) {
          readyTasks = readyTasks.filter(t => t.automation === 'eligible');
        }

        // AC: @task-automation-eligibility ac-20 - filter by --unassessed
        if (options.unassessed) {
          readyTasks = readyTasks.filter(t => !t.automation);
        }

        // AC: @task-automation-eligibility ac-24 - filter by --needs-review
        if (options.needsReview) {
          readyTasks = readyTasks.filter(t => t.automation === 'needs_review');
        }

        output(readyTasks, () => {
          if (readyTasks.length === 0) {
            if (options.eligible) {
              info('No eligible tasks ready - no tasks with automation: eligible');
            } else if (options.unassessed) {
              info('No unassessed tasks ready');
            } else if (options.needsReview) {
              info('No tasks need review');
            } else {
              info('No tasks ready - all pending tasks are blocked or have unmet dependencies');
            }
          } else {
            // AC: @task-automation-eligibility ac-14 - formatTaskListWithAutomation shows automation status
            formatTaskListWithAutomation(readyTasks, options.verbose, index, undefined, options.full);
          }
        });
      } catch (err) {
        error(errors.failures.getReadyTasks, err);
        process.exit(EXIT_CODES.ERROR);
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
        process.exit(EXIT_CODES.ERROR);
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
        process.exit(EXIT_CODES.ERROR);
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
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec tasks assess - assess command group
  // AC: @tasks-assess-automation
  const assess = tasks
    .command('assess')
    .description('Assess tasks for various criteria');

  // kspec tasks assess automation [taskRef]
  // AC: @tasks-assess-automation ac-1 through ac-28
  assess
    .command('automation [taskRef]')
    .description('Assess task automation eligibility based on criteria')
    .option('--all', 'Include already-assessed tasks')
    .option('--auto', 'Auto-mark obvious cases (spikes -> manual_only, missing criteria -> needs_review)')
    .option('--dry-run', 'Show what would change without modifying tasks')
    .action(async (taskRef: string | undefined, options) => {
      try {
        const ctx = await initContext();
        const allTasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(allTasks, items);

        // AC: @tasks-assess-automation ac-6, ac-7 - Single task assessment
        if (taskRef) {
          const resolved = index.resolve(taskRef);
          if (!resolved.ok) {
            error(`Task not found: ${taskRef}`);
            process.exit(EXIT_CODES.NOT_FOUND);
          }
        }

        // AC: @tasks-assess-automation ac-1, ac-2, ac-27, ac-28 - Filter tasks
        const tasksToAssess = filterTasksForAssessment(allTasks, { all: options.all, taskRef }, index);

        // AC: @tasks-assess-automation ac-26 - No unassessed tasks
        if (tasksToAssess.length === 0) {
          output({ tasks: [], summary: { review_for_eligible: 0, needs_review: 0, manual_only: 0, total: 0 } }, () => {
            if (taskRef) {
              info(`Task ${taskRef} is not pending or already assessed (use --all to include)`);
            } else {
              info('No unassessed pending tasks');
            }
          });
          return;
        }

        // Assess each task
        // AC: @tasks-assess-automation ac-3, ac-4, ac-8-16
        const assessments: TaskAssessment[] = tasksToAssess.map(task =>
          assessTask(task, index, items)
        );

        // AC: @tasks-assess-automation ac-5, ac-25 - Compute summary
        const summary = computeSummary(assessments);

        // Handle auto mode
        // AC: @tasks-assess-automation ac-17-21
        if (options.auto) {
          const changes = computeAutoModeChanges(assessments);
          const actualChanges = changes.filter(c => c.action !== 'no_change');

          // AC: @tasks-assess-automation ac-22, ac-23 - Dry run
          if (options.dryRun) {
            output({ assessments, summary, changes, dryRun: true }, () => {
              formatAssessmentOutput(assessments, summary, index);
              console.log('');
              console.log(chalk.yellow('Dry run - would make these changes:'));
              for (const change of actualChanges) {
                console.log(`  ${change.taskRef}: set automation=${change.newStatus} (${change.reason})`);
              }
              if (actualChanges.length === 0) {
                console.log('  (no changes - all tasks need agent/human review)');
              }
            });
            return;
          }

          // Apply changes
          // AC: @tasks-assess-automation ac-17, ac-19, ac-20
          let changeCount = 0;
          for (const change of actualChanges) {
            const task = allTasks.find(t => t._ulid === change.taskUlid);
            if (!task) continue;

            // Set automation status
            task.automation = change.newStatus;

            // AC: @tasks-assess-automation ac-19, ac-20 - Add note explaining assessment
            const noteContent = `Automation assessment: set to ${change.newStatus}. ${change.reason}`;
            const note = createNote(noteContent, '@automation-assess');
            task.notes = [...task.notes, note];

            await saveTask(ctx, task);
            changeCount++;
          }

          if (changeCount > 0) {
            await commitIfShadow(ctx.shadow, 'tasks-assess', 'automation', `${changeCount} task(s)`);
          }

          output({ assessments, summary, changes, applied: true }, () => {
            formatAssessmentOutput(assessments, summary, index);
            console.log('');
            if (changeCount > 0) {
              success(`Applied ${changeCount} change(s)`);
            } else {
              info('No changes applied - all tasks need agent/human review to mark eligible');
            }
          });
          return;
        }

        // Default: just show assessment output
        // AC: @tasks-assess-automation ac-24, ac-25 - JSON output handled by output()
        output({ assessments, summary }, () => {
          formatAssessmentOutput(assessments, summary, index);
        });

      } catch (err) {
        error('Failed to assess tasks', err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

/**
 * Format assessment output for human-readable display
 * AC: @tasks-assess-automation ac-3, ac-4, ac-5
 */
function formatAssessmentOutput(
  assessments: TaskAssessment[],
  summary: AssessmentSummary,
  index: ReferenceIndex
): void {
  for (const assessment of assessments) {
    // Task header
    console.log(`${assessment.taskRef}  "${assessment.taskTitle}"`);

    // Criteria results
    // AC: @tasks-assess-automation ac-3
    const specRefResult = assessment.criteria.has_spec_ref;
    const specRefIcon = specRefResult.pass ? chalk.green('✓') : chalk.red('✗');
    const specRefDetail = specRefResult.pass
      ? specRefResult.spec_ref
      : specRefResult.detail || 'missing';
    console.log(`  spec_ref:     ${specRefIcon} ${specRefDetail}`);

    const acsResult = assessment.criteria.spec_has_acs;
    const acsIcon = acsResult.skipped ? chalk.gray('-') : (acsResult.pass ? chalk.green('✓') : chalk.red('✗'));
    const acsDetail = acsResult.skipped
      ? `(${acsResult.detail})`
      : (acsResult.pass ? `${acsResult.ac_count} acceptance criteria` : acsResult.detail || 'no ACs');
    console.log(`  has_acs:      ${acsIcon} ${acsDetail}`);

    const spikeResult = assessment.criteria.not_spike;
    const spikeIcon = spikeResult.pass ? chalk.green('✓') : chalk.red('✗');
    console.log(`  not_spike:    ${spikeIcon} ${spikeResult.detail}`);

    // Recommendation
    // AC: @tasks-assess-automation ac-4
    const recColor = assessment.recommendation === 'review_for_eligible'
      ? chalk.cyan
      : (assessment.recommendation === 'needs_review' ? chalk.yellow : chalk.red);
    console.log(`  → ${recColor(assessment.recommendation)} (${assessment.reason})`);
    console.log('');
  }

  // Summary
  // AC: @tasks-assess-automation ac-5
  console.log(chalk.bold('Summary:'));
  console.log(`  review_for_eligible: ${summary.review_for_eligible}`);
  console.log(`  needs_review: ${summary.needs_review}`);
  console.log(`  manual_only: ${summary.manual_only}`);
  console.log(`  total: ${summary.total}`);
}
