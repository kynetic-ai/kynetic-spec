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
  type MetaContext,
  type Agent,
  type Workflow,
} from '../../parser/index.js';
import { output, error } from '../output.js';

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
}
