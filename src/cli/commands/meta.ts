/**
 * Meta CLI commands for interacting with meta-spec.
 *
 * AC-meta-manifest-1: kspec meta show outputs summary
 * AC-meta-manifest-2: kspec validate includes meta line
 * AC-meta-manifest-3: kspec validate shows meta errors with prefix
 * AC-agent-1: kspec meta agents outputs table
 * AC-agent-2: kspec meta agents --json outputs JSON
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import {
  initContext,
  loadMetaContext,
  getMetaStats,
  createObservation,
  saveObservation,
  createTask,
  saveTask,
  type MetaContext,
  type Agent,
  type Workflow,
  type Observation,
} from '../../parser/index.js';
import { type ObservationType } from '../../schema/index.js';
import { output, error, success } from '../output.js';

/**
 * Format meta show output
 */
function formatMetaShow(meta: MetaContext): void {
  const stats = getMetaStats(meta);

  if (!meta.manifest) {
    console.log(chalk.yellow('No meta manifest found (kynetic.meta.yaml)'));
    console.log(chalk.gray('Create one to define agents, workflows, conventions, and observations'));
    return;
  }

  console.log(chalk.bold('Meta-Spec Summary'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`Agents:       ${stats.agents}`);
  console.log(`Workflows:    ${stats.workflows}`);
  console.log(`Conventions:  ${stats.conventions}`);
  console.log(`Observations: ${stats.observations} (${stats.unresolvedObservations} unresolved)`);
}

/**
 * Format agents table output
 * AC-agent-1: outputs table with columns: ID, Name, Capabilities
 */
function formatAgents(agents: Agent[]): void {
  if (agents.length === 0) {
    console.log(chalk.yellow('No agents defined'));
    return;
  }

  const table = new Table({
    head: [chalk.bold('ID'), chalk.bold('Name'), chalk.bold('Capabilities')],
    style: {
      head: [],
      border: [],
    },
  });

  for (const agent of agents) {
    table.push([
      agent.id,
      agent.name,
      agent.capabilities.join(', '),
    ]);
  }

  console.log(table.toString());
}

/**
 * Format workflows table output
 * AC-workflow-1: outputs table with columns: ID, Trigger, Steps (count)
 */
function formatWorkflows(workflows: Workflow[]): void {
  if (workflows.length === 0) {
    console.log(chalk.yellow('No workflows defined'));
    return;
  }

  const table = new Table({
    head: [chalk.bold('ID'), chalk.bold('Trigger'), chalk.bold('Steps')],
    style: {
      head: [],
      border: [],
    },
  });

  for (const workflow of workflows) {
    table.push([
      workflow.id,
      workflow.trigger,
      workflow.steps.length.toString(),
    ]);
  }

  console.log(table.toString());
}

/**
 * Format workflows verbose output
 * AC-workflow-2: outputs each workflow with full step list
 */
function formatWorkflowsVerbose(workflows: Workflow[]): void {
  if (workflows.length === 0) {
    console.log(chalk.yellow('No workflows defined'));
    return;
  }

  for (const workflow of workflows) {
    console.log(chalk.bold(`${workflow.id} - ${workflow.trigger}`));
    if (workflow.description) {
      console.log(chalk.gray(workflow.description));
    }
    console.log(chalk.gray('─'.repeat(60)));

    for (const step of workflow.steps) {
      const prefix = {
        check: chalk.yellow('[check]'),
        action: chalk.blue('[action]'),
        decision: chalk.magenta('[decision]'),
      }[step.type];

      console.log(`${prefix} ${step.content}`);

      if (step.on_fail) {
        console.log(chalk.gray(`  → on fail: ${step.on_fail}`));
      }

      if (step.options && step.options.length > 0) {
        for (const option of step.options) {
          console.log(chalk.gray(`  • ${option}`));
        }
      }
    }

    console.log('');
  }
}

/**
 * Format observations table output
 * AC-obs-2: outputs table with columns: ID, Type, Workflow, Created, Content (truncated)
 */
function formatObservations(observations: Observation[], showResolved: boolean): void {
  const filtered = showResolved ? observations : observations.filter(o => !o.resolved);

  if (filtered.length === 0) {
    console.log(chalk.yellow(showResolved ? 'No observations found' : 'No unresolved observations'));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold('ID'),
      chalk.bold('Type'),
      chalk.bold('Workflow'),
      chalk.bold('Created'),
      chalk.bold('Content'),
    ],
    style: {
      head: [],
      border: [],
    },
    colWidths: [10, 10, 20, 12, 50],
    wordWrap: true,
  });

  for (const obs of filtered) {
    const id = obs._ulid.substring(0, 8);
    const workflow = obs.workflow_ref || '-';
    const created = new Date(obs.created_at).toISOString().split('T')[0];
    const content = obs.content.length > 47 ? obs.content.substring(0, 47) + '...' : obs.content;

    table.push([id, obs.type, workflow, created, content]);
  }

  console.log(table.toString());
}

/**
 * Register meta commands
 */
export function registerMetaCommands(program: Command): void {
  const meta = program
    .command('meta')
    .description('Meta-spec commands (agents, workflows, conventions, observations)');

  // AC-meta-manifest-1: kspec meta show outputs summary with counts
  meta
    .command('show')
    .description('Display meta-spec summary')
    .action(async () => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error('No kspec project found');
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const stats = getMetaStats(metaCtx);

        output(
          {
            manifest: metaCtx.manifestPath,
            stats,
          },
          () => formatMetaShow(metaCtx)
        );
      } catch (err) {
        error('Failed to show meta', err);
        process.exit(1);
      }
    });

  // AC-agent-1, AC-agent-2: kspec meta agents
  meta
    .command('agents')
    .description('List agents defined in meta-spec')
    .action(async () => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error('No kspec project found');
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const agents = metaCtx.manifest?.agents || [];

        // AC-agent-2: JSON output includes full agent details
        output(
          agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description,
            capabilities: agent.capabilities,
            tools: agent.tools,
            session_protocol: agent.session_protocol,
            conventions: agent.conventions,
          })),
          // AC-agent-1: Table output with ID, Name, Capabilities
          () => formatAgents(agents)
        );
      } catch (err) {
        error('Failed to list agents', err);
        process.exit(1);
      }
    });

  // AC-workflow-1, AC-workflow-2, AC-workflow-4: kspec meta workflows
  meta
    .command('workflows')
    .description('List workflows defined in meta-spec')
    .option('--verbose', 'Show full workflow details with all steps')
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error('No kspec project found');
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const workflows = metaCtx.manifest?.workflows || [];

        // AC-workflow-4: JSON output includes full workflow details
        output(
          workflows.map((workflow) => ({
            id: workflow.id,
            trigger: workflow.trigger,
            description: workflow.description,
            steps: workflow.steps,
          })),
          // AC-workflow-1 (table) or AC-workflow-2 (verbose)
          () => {
            if (options.verbose) {
              formatWorkflowsVerbose(workflows);
            } else {
              formatWorkflows(workflows);
            }
          }
        );
      } catch (err) {
        error('Failed to list workflows', err);
        process.exit(1);
      }
    });

  // AC-obs-1: kspec meta observe <type> <content>
  meta
    .command('observe <type> <content>')
    .description('Create an observation (friction, success, question, idea)')
    .option('--workflow <ref>', 'Reference to workflow this observation relates to')
    .option('--author <author>', 'Author of the observation')
    .action(async (type: string, content: string, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error('No kspec project found');
          process.exit(1);
        }

        // Validate observation type
        const validTypes: ObservationType[] = ['friction', 'success', 'question', 'idea'];
        if (!validTypes.includes(type as ObservationType)) {
          error(`Invalid observation type: ${type}`);
          console.log(`Valid types: ${validTypes.join(', ')}`);
          process.exit(1);
        }

        // Create observation
        const observation = createObservation(type as ObservationType, content, {
          workflow_ref: options.workflow,
          author: options.author,
        });

        // Save to manifest
        await saveObservation(ctx, observation);

        // AC-obs-1: outputs "OK Created observation: <ULID-prefix>"
        success(`Created observation: ${observation._ulid.substring(0, 8)}`);
      } catch (err) {
        error('Failed to create observation', err);
        process.exit(1);
      }
    });

  // AC-obs-2, AC-obs-5: kspec meta observations
  meta
    .command('observations')
    .description('List observations (shows unresolved by default)')
    .option('--all', 'Include resolved observations')
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error('No kspec project found');
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const observations = metaCtx.observations || [];

        // AC-obs-5: JSON output includes full observation objects
        output(
          observations.map((obs) => ({
            _ulid: obs._ulid,
            type: obs.type,
            content: obs.content,
            workflow_ref: obs.workflow_ref ?? null,
            created_at: obs.created_at,
            author: obs.author ?? null,
            resolved: obs.resolved,
            resolution: obs.resolution ?? null,
            resolved_at: obs.resolved_at ?? null,
            resolved_by: obs.resolved_by ?? null,
            promoted_to: obs.promoted_to ?? null,
          })),
          // AC-obs-2: Table output with ID, Type, Workflow, Created, Content
          () => formatObservations(observations, options.all)
        );
      } catch (err) {
        error('Failed to list observations', err);
        process.exit(1);
      }
    });

  // AC-obs-3, AC-obs-6, AC-obs-8: kspec meta promote
  meta
    .command('promote <ref>')
    .description('Promote observation to a task')
    .requiredOption('--title <title>', 'Task title')
    .option('--priority <priority>', 'Task priority (1-3)', '2')
    .option('--force', 'Force promotion even if observation is resolved')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error('No kspec project found');
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const observations = metaCtx.manifest?.observations || [];

        // Find observation
        const normalizedRef = ref.startsWith('@') ? ref.substring(1) : ref;
        const observation = observations.find((o) => o._ulid.startsWith(normalizedRef));

        if (!observation) {
          error(`Observation not found: ${ref}`);
          process.exit(1);
        }

        // AC-obs-6: Check if already promoted
        if (observation.promoted_to) {
          error(`Observation already promoted to task ${observation.promoted_to}; resolve or delete the task first`);
          process.exit(1);
        }

        // AC-obs-8: Check if resolved
        if (observation.resolved && !options.force) {
          error(`Cannot promote resolved observation; use --force to override`);
          process.exit(1);
        }

        // Create task directly using the API
        const task = createTask({
          title: options.title,
          priority: Number.parseInt(options.priority, 10),
          meta_ref: observation.workflow_ref,
        });

        // Save task
        await saveTask(ctx, task);
        const taskRef = `@${task._ulid.substring(0, 8)}`;

        // Update observation with promoted_to field
        observation.promoted_to = taskRef;
        await saveObservation(ctx, observation);

        // AC-obs-3: outputs "OK Created task: <ULID-prefix>"
        success(`Created task: ${taskRef.substring(0, 9)}`);
      } catch (err) {
        error('Failed to promote observation', err);
        process.exit(1);
      }
    });

  // AC-obs-4, AC-obs-7, AC-obs-9: kspec meta resolve
  meta
    .command('resolve <ref> [resolution]')
    .description('Resolve an observation')
    .action(async (ref: string, resolution: string | undefined) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error('No kspec project found');
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const observations = metaCtx.manifest?.observations || [];

        // Find observation
        const normalizedRef = ref.startsWith('@') ? ref.substring(1) : ref;
        const observation = observations.find((o) => o._ulid.startsWith(normalizedRef));

        if (!observation) {
          error(`Observation not found: ${ref}`);
          process.exit(1);
        }

        // AC-obs-7: Check if already resolved
        if (observation.resolved) {
          const resolvedDate = new Date(observation.resolved_at!).toISOString().split('T')[0];
          const resolutionText = observation.resolution || '';
          const truncated = resolutionText.length > 50
            ? resolutionText.substring(0, 50) + '...'
            : resolutionText;
          error(`Observation already resolved on ${resolvedDate}: '${truncated}'`);
          process.exit(1);
        }

        // AC-obs-9: Auto-populate resolution from task completion if promoted
        let finalResolution = resolution;
        if (!finalResolution && observation.promoted_to) {
          // TODO: Fetch task completion reason from promoted task
          // For now, just use a placeholder
          finalResolution = `Promoted to task ${observation.promoted_to}`;
        }

        if (!finalResolution) {
          error('Resolution text is required');
          process.exit(1);
        }

        // AC-obs-4: Update observation
        observation.resolved = true;
        observation.resolution = finalResolution;
        observation.resolved_at = new Date().toISOString();
        observation.resolved_by = observation.author; // Use same author

        await saveObservation(ctx, observation);

        // AC-obs-4: outputs "OK Resolved: <ULID-prefix>"
        success(`Resolved: ${observation._ulid.substring(0, 8)}`);
      } catch (err) {
        error('Failed to resolve observation', err);
        process.exit(1);
      }
    });
}
