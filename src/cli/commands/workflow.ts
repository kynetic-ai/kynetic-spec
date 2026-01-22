/**
 * Workflow run CLI commands
 *
 * Implements workflow run lifecycle management:
 * - kspec workflow start @ref [--task @ref] [--json]
 * - kspec workflow runs [--active] [--completed] [--workflow @ref] [--json]
 * - kspec workflow show @run [--json]
 * - kspec workflow abort @run [--reason text] [--json]
 */

import { Command } from 'commander';
import { ulid } from 'ulid';
import chalk from 'chalk';
import Table from 'cli-table3';
import {
  initContext,
  loadMetaContext,
  loadWorkflowRuns,
  saveWorkflowRun,
  updateWorkflowRun,
  findWorkflowRunByRef,
  getAuthor,
  ReferenceIndex,
  loadAllTasks,
  type Workflow,
} from '../../parser/index.js';
import type { WorkflowRun } from '../../schema/index.js';
import { commitIfShadow } from '../../parser/shadow.js';
import { output, success, error, isJsonMode } from '../output.js';
import { errors } from '../../strings/errors.js';
import { EXIT_CODES } from '../exit-codes.js';

/**
 * Find a workflow by reference
 */
function resolveWorkflowRef(ref: string, workflows: Workflow[]): Workflow | null {
  const cleanRef = ref.startsWith('@') ? ref.slice(1) : ref;
  console.error('DEBUG resolveWorkflowRef: cleanRef=', cleanRef);
  console.error('DEBUG resolveWorkflowRef: workflows=', workflows);

  // Try by ID first
  let workflow = workflows.find((w) => w.id === cleanRef);
  console.error('DEBUG: Found by ID?', !!workflow);
  if (workflow) return workflow;

  // Try by ULID or ULID prefix
  workflow = workflows.find((w) => w._ulid === cleanRef || w._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()));
  console.error('DEBUG: Found by ULID?', !!workflow);
  return workflow || null;
}

/**
 * Format a short ULID (first 8 chars)
 */
function shortUlid(ulid: string): string {
  return ulid.slice(0, 8).toUpperCase();
}

/**
 * Format run status with color
 */
function formatStatus(status: string): string {
  switch (status) {
    case 'active':
      return chalk.green(status);
    case 'paused':
      return chalk.yellow(status);
    case 'completed':
      return chalk.blue(status);
    case 'aborted':
      return chalk.red(status);
    default:
      return status;
  }
}

/**
 * Command: kspec workflow start @workflow-ref [--task @task-ref] [--json]
 * AC: @workflow-run-foundation ac-1, ac-6
 */
async function workflowStart(workflowRef: string, options: { task?: string; json?: boolean }) {
  const ctx = await initContext();
  const metaCtx = await loadMetaContext(ctx);

  // DEBUG: Log loaded workflows
  console.error('DEBUG: Loaded workflows:', metaCtx.workflows.map((w) => ({ id: w.id, ulid: w._ulid })));
  console.error('DEBUG: Looking for:', workflowRef);

  // Resolve workflow reference
  const workflow = resolveWorkflowRef(workflowRef, metaCtx.workflows);
  if (!workflow) {
    error(errors.workflowRun.workflowNotFound(workflowRef));
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  // Validate task reference if provided (AC: @workflow-run-foundation ac-6)
  let taskRef: string | undefined;
  if (options.task) {
    const tasks = await loadAllTasks(ctx);
    const index = new ReferenceIndex(tasks, []);
    const result = index.resolve(options.task);
    if (!result.ok) {
      error(errors.reference.taskNotFound(options.task));
      process.exit(EXIT_CODES.NOT_FOUND);
    }
    taskRef = `@${result.ulid}`;
  }

  // Create new workflow run
  const run: WorkflowRun = {
    _ulid: ulid(),
    workflow_ref: `@${workflow._ulid}`,
    status: 'active',
    current_step: 0,
    total_steps: workflow.steps.length,
    started_at: new Date().toISOString(),
    step_results: [],
    initiated_by: getAuthor(),
    task_ref: taskRef,
  };

  // Save the run
  await saveWorkflowRun(ctx, run);

  // Commit to shadow
  await commitIfShadow(ctx.shadow, 'workflow-start');

  // Output result
  if (isJsonMode()) {
    output({ run_id: run._ulid, workflow_ref: run.workflow_ref, status: run.status });
  } else {
    success(`Started workflow run: ${shortUlid(run._ulid)}`);
    console.log(`  Workflow: ${workflow.id}`);
    console.log(`  Steps: ${run.total_steps}`);
    if (taskRef) {
      console.log(`  Linked task: ${taskRef}`);
    }
  }
}

/**
 * Command: kspec workflow runs [--active] [--completed] [--workflow @ref] [--json]
 * AC: @workflow-run-foundation ac-2
 */
async function workflowRuns(options: {
  active?: boolean;
  completed?: boolean;
  workflow?: string;
  json?: boolean;
}) {
  const ctx = await initContext();
  const metaCtx = await loadMetaContext(ctx);
  let runs = await loadWorkflowRuns(ctx);

  // Apply filters
  if (options.active) {
    runs = runs.filter((r) => r.status === 'active');
  }
  if (options.completed) {
    runs = runs.filter((r) => r.status === 'completed');
  }
  if (options.workflow) {
    const workflow = resolveWorkflowRef(options.workflow, metaCtx.workflows);
    if (!workflow) {
      error(errors.workflowRun.workflowNotFound(options.workflow));
      process.exit(EXIT_CODES.NOT_FOUND);
    }
    runs = runs.filter((r) => r.workflow_ref === `@${workflow._ulid}`);
  }

  if (isJsonMode()) {
    output({ runs });
  } else {
    if (runs.length === 0) {
      console.log(chalk.gray('No workflow runs found'));
      return;
    }

    const table = new Table({
      head: ['ID', 'Workflow', 'Status', 'Step', 'Started'],
      colWidths: [12, 25, 12, 10, 20],
    });

    for (const run of runs) {
      const workflow = metaCtx.workflows.find((w) => `@${w._ulid}` === run.workflow_ref);
      const workflowName = workflow?.id || run.workflow_ref;
      const stepProgress = `${run.current_step}/${run.total_steps}`;
      const started = new Date(run.started_at).toLocaleString();

      table.push([
        shortUlid(run._ulid),
        workflowName,
        formatStatus(run.status),
        stepProgress,
        started,
      ]);
    }

    console.log(table.toString());
  }
}

/**
 * Command: kspec workflow show @run-id [--json]
 * AC: @workflow-run-foundation ac-4
 */
async function workflowShow(runRef: string, options: { json?: boolean }) {
  const ctx = await initContext();
  const metaCtx = await loadMetaContext(ctx);

  const run = await findWorkflowRunByRef(ctx, runRef);
  if (!run) {
    error(errors.workflowRun.runNotFound(runRef));
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  if (isJsonMode()) {
    output({ run });
  } else {
    const workflow = metaCtx.workflows.find((w) => `@${w._ulid}` === run.workflow_ref);
    const workflowName = workflow?.id || run.workflow_ref;

    console.log(chalk.bold('Workflow Run Details'));
    console.log(chalk.gray('─'.repeat(50)));
    console.log(`ID:           ${shortUlid(run._ulid)}`);
    console.log(`Workflow:     ${workflowName} (${run.workflow_ref})`);
    console.log(`Status:       ${formatStatus(run.status)}`);
    console.log(`Progress:     ${run.current_step}/${run.total_steps}`);
    console.log(`Started:      ${new Date(run.started_at).toLocaleString()}`);

    if (run.initiated_by) {
      console.log(`Initiated by: ${run.initiated_by}`);
    }
    if (run.task_ref) {
      console.log(`Task:         ${run.task_ref}`);
    }
    if (run.paused_at) {
      console.log(`Paused:       ${new Date(run.paused_at).toLocaleString()}`);
    }
    if (run.completed_at) {
      console.log(`Completed:    ${new Date(run.completed_at).toLocaleString()}`);
    }
    if (run.abort_reason) {
      console.log(`Abort reason: ${run.abort_reason}`);
    }

    if (run.step_results.length > 0) {
      console.log(chalk.gray('\nStep Results:'));
      const table = new Table({
        head: ['Step', 'Status', 'Started', 'Completed'],
        colWidths: [8, 12, 20, 20],
      });

      for (const result of run.step_results) {
        table.push([
          result.step_index.toString(),
          formatStatus(result.status),
          new Date(result.started_at).toLocaleString(),
          new Date(result.completed_at).toLocaleString(),
        ]);
      }

      console.log(table.toString());
    }
  }
}

/**
 * Command: kspec workflow abort @run-id [--reason text] [--json]
 * AC: @workflow-run-foundation ac-3, ac-5
 */
async function workflowAbort(runRef: string, options: { reason?: string; json?: boolean }) {
  const ctx = await initContext();

  const run = await findWorkflowRunByRef(ctx, runRef);
  if (!run) {
    error(errors.workflowRun.runNotFound(runRef));
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  // AC: @workflow-run-foundation ac-5 - Cannot abort completed or aborted runs
  if (run.status === 'completed') {
    error(errors.workflowRun.cannotAbortCompleted);
    process.exit(EXIT_CODES.VALIDATION_FAILED);
  }

  if (run.status === 'aborted') {
    error(errors.workflowRun.cannotAbortAborted);
    process.exit(EXIT_CODES.VALIDATION_FAILED);
  }

  // Update run status
  run.status = 'aborted';
  run.abort_reason = options.reason;
  run.completed_at = new Date().toISOString();

  await updateWorkflowRun(ctx, run);
  await commitIfShadow(ctx.shadow, 'workflow-abort');

  if (isJsonMode()) {
    output({ run_id: run._ulid, status: run.status });
  } else {
    success(`Aborted workflow run: ${shortUlid(run._ulid)}`);
    if (options.reason) {
      console.log(`  Reason: ${options.reason}`);
    }
  }
}

/**
 * Register workflow commands
 */
export function registerWorkflowCommand(program: Command): void {
  const workflow = program
    .command('workflow')
    .description('Manage workflow runs');

  workflow
    .command('start')
    .description('Start a new workflow run')
    .argument('<workflow-ref>', 'Workflow reference (@id or @ulid)')
    .option('--task <task-ref>', 'Link run to a task')
    .option('--json', 'Output JSON')
    .action(workflowStart);

  workflow
    .command('runs')
    .description('List workflow runs')
    .option('--active', 'Show only active runs')
    .option('--completed', 'Show only completed runs')
    .option('--workflow <ref>', 'Filter by workflow')
    .option('--json', 'Output JSON')
    .action(workflowRuns);

  workflow
    .command('show')
    .description('Show workflow run details')
    .argument('<run-ref>', 'Run reference (@ulid or ulid prefix)')
    .option('--json', 'Output JSON')
    .action(workflowShow);

  workflow
    .command('abort')
    .description('Abort an active workflow run')
    .argument('<run-ref>', 'Run reference (@ulid or ulid prefix)')
    .option('--reason <text>', 'Reason for aborting')
    .option('--json', 'Output JSON')
    .action(workflowAbort);
}
