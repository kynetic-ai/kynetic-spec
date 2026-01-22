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
  findActiveRuns,
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

  // Try by ID first
  let workflow = workflows.find((w) => w.id === cleanRef);
  if (workflow) return workflow;

  // Try by ULID or ULID prefix
  workflow = workflows.find((w) => w._ulid === cleanRef || w._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()));
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
 * Command: kspec workflow next [run-ref] [--skip] [--notes text] [--confirm] [--force] [--json]
 * AC: @workflow-step-navigation ac-1 through ac-6
 * AC: @workflow-enforcement-modes ac-1 through ac-4
 */
async function workflowNext(
  runRef: string | undefined,
  options: { skip?: boolean; notes?: string; confirm?: boolean; force?: boolean; json?: boolean }
) {
  const ctx = await initContext();
  const metaCtx = await loadMetaContext(ctx);

  let run: WorkflowRun | undefined;

  // AC: @workflow-step-navigation ac-3, ac-4, ac-5
  if (!runRef) {
    const activeRuns = await findActiveRuns(ctx);

    if (activeRuns.length === 0) {
      // AC: @workflow-step-navigation ac-5
      error(errors.workflowRun.noActiveRuns);
      process.exit(EXIT_CODES.NOT_FOUND);
    }

    if (activeRuns.length > 1) {
      // AC: @workflow-step-navigation ac-4
      const runIds = activeRuns.map((r) => shortUlid(r._ulid));
      error(errors.workflowRun.multipleActiveRuns(runIds));
      process.exit(EXIT_CODES.VALIDATION_FAILED);
    }

    // AC: @workflow-step-navigation ac-3 - exactly one active run
    run = activeRuns[0];
  } else {
    run = await findWorkflowRunByRef(ctx, runRef);
    if (!run) {
      error(errors.workflowRun.runNotFound(runRef));
      process.exit(EXIT_CODES.NOT_FOUND);
    }

    if (run.status !== 'active') {
      error(errors.workflowRun.runNotActive(runRef, run.status));
      process.exit(EXIT_CODES.VALIDATION_FAILED);
    }
  }

  // Get workflow definition to access steps
  const workflow = metaCtx.workflows.find((w) => `@${w._ulid}` === run.workflow_ref);
  if (!workflow) {
    error(errors.workflowRun.workflowNotFound(run.workflow_ref));
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  // Get current step and next step
  const currentStepIndex = run.current_step;
  const currentStep = workflow.steps[currentStepIndex];
  const isStrictMode = workflow.enforcement === 'strict';
  const isLastStep = currentStepIndex === run.total_steps - 1;

  // AC: @workflow-enforcement-modes ac-3 - Strict mode: --skip requires --force
  if (options.skip && isStrictMode && !options.force) {
    error(errors.workflowRun.skipRequiresForce);
    process.exit(EXIT_CODES.VALIDATION_FAILED);
  }

  // AC: @workflow-enforcement-modes ac-2, ac-3 - Check exit criteria for CURRENT step
  if (currentStep.exit_criteria && currentStep.exit_criteria.length > 0 && !options.skip) {
    // AC: @workflow-enforcement-modes ac-3 - Strict mode requires --confirm
    if (isStrictMode && !options.confirm) {
      if (!isJsonMode()) {
        console.log(`Completing step ${currentStepIndex + 1}/${run.total_steps}: [${currentStep.type}] ${currentStep.content}`);
        console.log(chalk.yellow('  Exit criteria:'));
        for (const criterion of currentStep.exit_criteria) {
          console.log(chalk.yellow(`    - ${criterion}`));
        }
        console.log();
      }
      error(errors.workflowRun.exitCriteriaNotConfirmed);
      process.exit(EXIT_CODES.VALIDATION_FAILED);
    }

    // AC: @workflow-enforcement-modes ac-4 - Advisory mode shows criteria as guidance
    if (!isStrictMode && !isJsonMode()) {
      console.log(chalk.gray('  Exit criteria:'));
      for (const criterion of currentStep.exit_criteria) {
        console.log(chalk.gray(`    - ${criterion}`));
      }
    }
  }

  // AC: @workflow-enforcement-modes ac-1, ac-3 - Check entry criteria for NEXT step
  // (Only applies when advancing from current step normally, not when skipping or completing the workflow)
  // When skipping, we don't check entry criteria because we're not actually starting the next step yet
  if (!isLastStep && !options.skip) {
    const nextStep = workflow.steps[currentStepIndex + 1];
    if (nextStep.entry_criteria && nextStep.entry_criteria.length > 0) {
      // AC: @workflow-enforcement-modes ac-3 - Strict mode requires --confirm
      if (isStrictMode && !options.confirm) {
        if (!isJsonMode()) {
          console.log(`Step ${currentStepIndex + 2}/${run.total_steps}: [${nextStep.type}] ${nextStep.content}`);
          console.log(chalk.yellow('  Entry criteria:'));
          for (const criterion of nextStep.entry_criteria) {
            console.log(chalk.yellow(`    - ${criterion}`));
          }
          console.log();
        }
        error(errors.workflowRun.entryCriteriaNotConfirmed);
        process.exit(EXIT_CODES.VALIDATION_FAILED);
      }

      // AC: @workflow-enforcement-modes ac-4 - Advisory mode shows criteria as guidance
      if (!isStrictMode && !isJsonMode()) {
        console.log(`Step ${currentStepIndex + 2}/${run.total_steps}: [${nextStep.type}] ${nextStep.content}`);
        console.log(chalk.gray('  Entry criteria:'));
        for (const criterion of nextStep.entry_criteria) {
          console.log(chalk.gray(`    - ${criterion}`));
        }
        console.log();
      }
    }
  }

  // AC: @workflow-step-navigation ac-1, ac-6 - Complete current step
  const previousResult = run.step_results[run.step_results.length - 1];
  const startedAt = previousResult ? previousResult.completed_at : run.started_at;

  // AC: @workflow-enforcement-modes ac-3 - Record confirmations in StepResult
  // Check if a stub result already exists for this step (created when we advanced to it)
  const existingResultIndex = run.step_results.findIndex((r) => r.step_index === currentStepIndex);

  if (existingResultIndex >= 0) {
    // Update existing stub result with completion data
    const existingResult = run.step_results[existingResultIndex];
    run.step_results[existingResultIndex] = {
      ...existingResult,
      status: options.skip ? ('skipped' as const) : ('completed' as const),
      completed_at: new Date().toISOString(),
      notes: options.notes,
      exit_confirmed: currentStep.exit_criteria && currentStep.exit_criteria.length > 0 && options.confirm ? true : undefined,
    };
  } else {
    // No stub exists (first step or old data), create complete result
    const stepResult = {
      step_index: currentStepIndex,
      status: options.skip ? ('skipped' as const) : ('completed' as const),
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      notes: options.notes,
      exit_confirmed: currentStep.exit_criteria && currentStep.exit_criteria.length > 0 && options.confirm ? true : undefined,
      entry_confirmed: undefined,
    };
    run.step_results.push(stepResult);
  }

  // AC: @workflow-step-navigation ac-1 - Advance to next step or complete run
  if (isLastStep) {
    // AC: @workflow-step-navigation ac-2 - Complete the run
    run.status = 'completed';
    run.completed_at = new Date().toISOString();

    await updateWorkflowRun(ctx, run);
    await commitIfShadow(ctx.shadow, 'workflow-next');

    // Calculate summary stats
    const totalDuration = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
    const completedSteps = run.step_results.filter((r) => r.status === 'completed').length;
    const skippedSteps = run.step_results.filter((r) => r.status === 'skipped').length;

    if (isJsonMode()) {
      output({
        run_id: run._ulid,
        status: run.status,
        completed_at: run.completed_at,
        total_duration_ms: totalDuration,
        steps_completed: completedSteps,
        steps_skipped: skippedSteps,
      });
    } else {
      const currentStep = workflow.steps[currentStepIndex];
      success(`Completed step ${currentStepIndex + 1}/${run.total_steps}: [${currentStep.type}] ${currentStep.content}`);
      console.log();
      console.log(chalk.bold('Workflow completed!'));
      console.log(`  Duration: ${Math.round(totalDuration / 1000)}s`);
      console.log(`  Steps completed: ${completedSteps}`);
      console.log(`  Steps skipped: ${skippedSteps}`);
    }
  } else {
    // Advance to next step
    run.current_step += 1;

    // AC: @workflow-enforcement-modes ac-3 - Record entry confirmation for the next step
    // Create a stub step result for the next step to capture entry_confirmed and started_at
    // This will be updated with completion data when the step is completed
    const nextStep = workflow.steps[run.current_step];
    const nextStepStartedAt = run.step_results[run.step_results.length - 1]?.completed_at || new Date().toISOString();
    const nextStepStub = {
      step_index: run.current_step,
      status: 'completed' as const, // Placeholder, will be updated
      started_at: nextStepStartedAt,
      completed_at: nextStepStartedAt, // Placeholder, will be updated
      entry_confirmed: nextStep.entry_criteria && nextStep.entry_criteria.length > 0 && options.confirm ? true : undefined,
    };
    run.step_results.push(nextStepStub);

    await updateWorkflowRun(ctx, run);
    await commitIfShadow(ctx.shadow, 'workflow-next');

    if (isJsonMode()) {
      output({
        run_id: run._ulid,
        current_step: run.current_step,
        total_steps: run.total_steps,
        next_step: {
          type: nextStep.type,
          content: nextStep.content,
        },
      });
    } else {
      const previousStep = workflow.steps[currentStepIndex];
      success(
        `Completed step ${currentStepIndex + 1}/${run.total_steps}: [${previousStep.type}] ${previousStep.content}`
      );
      console.log();
      console.log(`Step ${run.current_step + 1}/${run.total_steps}: [${nextStep.type}] ${nextStep.content}`);
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

  workflow
    .command('next')
    .description('Advance workflow run to next step')
    .argument('[run-ref]', 'Run reference (optional if only one active run)')
    .option('--skip', 'Mark current step as skipped')
    .option('--notes <text>', 'Notes for the completed step')
    .option('--confirm', 'Acknowledge entry/exit criteria (required in strict mode)')
    .option('--force', 'Allow --skip in strict mode')
    .option('--json', 'Output JSON')
    .action(workflowNext);
}
