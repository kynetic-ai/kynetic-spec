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
import { ulid } from 'ulid';
import {
  initContext,
  loadMetaContext,
  getMetaStats,
  createObservation,
  saveObservation,
  saveMetaItem,
  deleteMetaItem,
  createTask,
  saveTask,
  loadAllTasks,
  loadAllItems,
  ReferenceIndex,
  loadSessionContext,
  saveSessionContext,
  type MetaContext,
  type Agent,
  type Workflow,
  type Convention,
  type Observation,
  type LoadedTask,
} from '../../parser/index.js';
import { type ObservationType } from '../../schema/index.js';
import { output, error, success, isJsonMode } from '../output.js';
import { errors } from '../../strings/errors.js';
import { commitIfShadow } from '../../parser/shadow.js';

/**
 * Resolve a meta reference to its ULID
 * Handles semantic IDs (agent.id, workflow.id, convention.domain) and ULID prefixes
 */
function resolveMetaRefToUlid(
  ref: string,
  metaCtx: MetaContext
): { ulid: string; type: 'agent' | 'workflow' | 'convention' | 'observation' } | null {
  const normalizedRef = ref.startsWith('@') ? ref.substring(1) : ref;

  // Check agents
  const agent = (metaCtx.agents || []).find(
    (a) => a.id === normalizedRef || a._ulid.startsWith(normalizedRef)
  );
  if (agent) return { ulid: agent._ulid, type: 'agent' };

  // Check workflows
  const workflow = (metaCtx.workflows || []).find(
    (w) => w.id === normalizedRef || w._ulid.startsWith(normalizedRef)
  );
  if (workflow) return { ulid: workflow._ulid, type: 'workflow' };

  // Check conventions
  const convention = (metaCtx.conventions || []).find(
    (c) => c.domain === normalizedRef || c._ulid.startsWith(normalizedRef)
  );
  if (convention) return { ulid: convention._ulid, type: 'convention' };

  // Check observations
  const observation = (metaCtx.observations || []).find((o) =>
    o._ulid.startsWith(normalizedRef)
  );
  if (observation) return { ulid: observation._ulid, type: 'observation' };

  return null;
}

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
 * Format conventions table output
 * AC-conv-1: outputs table with columns: Domain, Rules (count), Validation (yes/no)
 */
function formatConventions(conventions: Convention[]): void {
  if (conventions.length === 0) {
    console.log(chalk.yellow('No conventions defined'));
    return;
  }

  const table = new Table({
    head: [chalk.bold('Domain'), chalk.bold('Rules'), chalk.bold('Validation')],
    style: {
      head: [],
      border: [],
    },
  });

  for (const convention of conventions) {
    table.push([
      convention.domain,
      convention.rules.length.toString(),
      convention.validation ? 'yes' : 'no',
    ]);
  }

  console.log(table.toString());
}

/**
 * Format convention detail output
 * AC-conv-2: outputs full rules list and examples
 */
function formatConventionDetail(convention: Convention): void {
  console.log(chalk.bold(`${convention.domain} Convention`));
  console.log(chalk.gray('─'.repeat(60)));

  console.log(chalk.bold('\nRules:'));
  for (const rule of convention.rules) {
    console.log(`  • ${rule}`);
  }

  if (convention.examples && convention.examples.length > 0) {
    console.log(chalk.bold('\nExamples:'));
    for (const example of convention.examples) {
      console.log(chalk.green(`  ✓ ${example.good}`));
      console.log(chalk.red(`  ✗ ${example.bad}`));
    }
  }

  if (convention.validation) {
    console.log(chalk.bold('\nValidation:'));
    console.log(`  Type: ${convention.validation.type}`);
    if (convention.validation.pattern) {
      console.log(`  Pattern: ${convention.validation.pattern}`);
    }
    if (convention.validation.message) {
      console.log(`  Message: ${convention.validation.message}`);
    }
  }

  console.log('');
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
          error(errors.project.noKspecProject);
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
        error(errors.failures.showMeta, err);
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
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const agents = metaCtx.agents || [];

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
        error(errors.failures.listAgents, err);
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
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const workflows = metaCtx.workflows || [];

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
        error(errors.failures.listWorkflows, err);
        process.exit(1);
      }
    });

  // AC-conv-1, AC-conv-2, AC-conv-5: kspec meta conventions
  meta
    .command('conventions')
    .description('List conventions defined in meta-spec')
    .option('--domain <domain>', 'Filter by specific domain')
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const conventions = metaCtx.conventions || [];

        // AC-conv-2: Filter by domain if specified
        const filtered = options.domain
          ? conventions.filter((c) => c.domain === options.domain)
          : conventions;

        // AC-conv-5: JSON output includes full convention details
        output(
          filtered.map((convention) => ({
            domain: convention.domain,
            rules: convention.rules,
            examples: convention.examples,
            validation: convention.validation,
          })),
          // AC-conv-1 (table) or AC-conv-2 (detail for single domain)
          () => {
            if (options.domain && filtered.length === 1) {
              formatConventionDetail(filtered[0]);
            } else {
              formatConventions(filtered);
            }
          }
        );
      } catch (err) {
        error(errors.failures.listConventions, err);
        process.exit(1);
      }
    });

  // meta-get-cmd: kspec meta get <ref>
  meta
    .command('get <ref>')
    .description('Get a meta item by reference (agent, workflow, convention, or observation)')
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);

        // Normalize reference
        const normalizedRef = ref.startsWith('@') ? ref.substring(1) : ref;

        // Search in all meta item types
        const agents = metaCtx.agents || [];
        const workflows = metaCtx.workflows || [];
        const conventions = metaCtx.conventions || [];
        const observations = metaCtx.observations || [];

        // Try to find by ID or ULID prefix
        let found: any = null;
        let itemType: string = '';

        // Check agents (by id or ULID)
        const agent = agents.find((a) => a.id === normalizedRef || a._ulid.startsWith(normalizedRef));
        if (agent) {
          found = agent;
          itemType = 'agent';
        }

        // Check workflows (by id or ULID)
        if (!found) {
          const workflow = workflows.find((w) => w.id === normalizedRef || w._ulid.startsWith(normalizedRef));
          if (workflow) {
            found = workflow;
            itemType = 'workflow';
          }
        }

        // Check conventions (by domain or ULID)
        if (!found) {
          const convention = conventions.find((c) => c.domain === normalizedRef || c._ulid.startsWith(normalizedRef));
          if (convention) {
            found = convention;
            itemType = 'convention';
          }
        }

        // Check observations (by ULID)
        if (!found) {
          const observation = observations.find((o) => o._ulid.startsWith(normalizedRef));
          if (observation) {
            found = observation;
            itemType = 'observation';
          }
        }

        if (!found) {
          error(errors.reference.metaNotFound(ref));
          process.exit(1);
        }

        // Output the item
        output(found, () => {
          console.log(chalk.bold(`${itemType.charAt(0).toUpperCase() + itemType.slice(1)}: ${ref}`));
          console.log(chalk.gray('─'.repeat(60)));
          console.log(JSON.stringify(found, null, 2));
        });
      } catch (err) {
        error(errors.failures.getMetaItem, err);
        process.exit(1);
      }
    });

  // meta-list-cmd: kspec meta list
  meta
    .command('list')
    .description('List all meta items')
    .option('--type <type>', 'Filter by type (agent, workflow, convention, observation)')
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);

        // Collect all meta items with type information
        interface MetaListItem {
          id: string;
          type: string;
          context: string;
          ulid: string;
        }

        const items: MetaListItem[] = [];

        // Add agents
        if (!options.type || options.type === 'agent') {
          for (const agent of metaCtx.agents || []) {
            items.push({
              id: agent.id,
              type: 'agent',
              context: agent.name,
              ulid: agent._ulid,
            });
          }
        }

        // Add workflows
        if (!options.type || options.type === 'workflow') {
          for (const workflow of metaCtx.workflows || []) {
            items.push({
              id: workflow.id,
              type: 'workflow',
              context: workflow.trigger,
              ulid: workflow._ulid,
            });
          }
        }

        // Add conventions
        if (!options.type || options.type === 'convention') {
          for (const convention of metaCtx.conventions || []) {
            items.push({
              id: convention.domain,
              type: 'convention',
              context: `${convention.rules.length} rules`,
              ulid: convention._ulid,
            });
          }
        }

        // Add observations
        if (!options.type || options.type === 'observation') {
          for (const observation of metaCtx.observations || []) {
            const ulidPrefix = observation._ulid.substring(0, 8);
            items.push({
              id: ulidPrefix,
              type: 'observation',
              context: `${observation.type} ${observation.resolved ? '(resolved)' : ''}`,
              ulid: observation._ulid,
            });
          }
        }

        // Output
        output(items, () => {
          if (items.length === 0) {
            console.log(chalk.yellow('No meta items found'));
            return;
          }

          const table = new Table({
            head: [chalk.bold('ID'), chalk.bold('Type'), chalk.bold('Context')],
            style: {
              head: [],
              border: [],
            },
          });

          for (const item of items) {
            table.push([item.id, item.type, item.context]);
          }

          console.log(table.toString());
        });
      } catch (err) {
        error(errors.failures.listMetaItems, err);
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
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        // Validate observation type
        const validTypes: ObservationType[] = ['friction', 'success', 'question', 'idea'];
        if (!validTypes.includes(type as ObservationType)) {
          error(errors.validation.invalidObservationType(type));
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
        // In JSON mode, return the created observation object
        output(
          observation,
          () => success(`Created observation: ${observation._ulid.substring(0, 8)}`)
        );
      } catch (err) {
        error(errors.failures.createObservation, err);
        process.exit(1);
      }
    });

  // AC-obs-2, AC-obs-5: kspec meta observations
  meta
    .command('observations')
    .description('List observations (shows unresolved by default)')
    .option('--type <type>', 'Filter by observation type (friction/success/question/idea)')
    .option('--workflow <ref>', 'Filter by workflow reference')
    .option('--all', 'Include resolved observations')
    .option('--promoted', 'Show only observations promoted to tasks')
    .option('--pending-resolution', 'Show observations with completed tasks awaiting resolution')
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        let observations = metaCtx.observations || [];

        // Apply filters
        if (options.type) {
          observations = observations.filter((obs) => obs.type === options.type);
        }

        if (options.workflow) {
          observations = observations.filter((obs) => obs.workflow_ref === options.workflow);
        }

        if (options.promoted) {
          observations = observations.filter((obs) => obs.promoted_to !== undefined);
        }

        if (options.pendingResolution) {
          // Load tasks to check if promoted tasks are completed
          const tasks = await loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const index = new ReferenceIndex(tasks, items);

          observations = observations.filter((obs) => {
            if (!obs.promoted_to || obs.resolved) return false;
            const taskResult = index.resolve(obs.promoted_to);
            if (!taskResult.ok) return false;
            const item = taskResult.item;
            // Type guard: check if item is a task (has status and depends_on properties)
            return 'status' in item && 'depends_on' in item && item.status === 'completed';
          });
        }

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
        error(errors.failures.listObservations, err);
        process.exit(1);
      }
    });

  // AC-obs-3, AC-obs-6, AC-obs-8: kspec meta promote
  meta
    .command('promote <ref>')
    .description('Promote observation to a task')
    .requiredOption('--title <title>', 'Task title')
    .option('--priority <priority>', 'Task priority (1-5)', '2')
    .option('--force', 'Force promotion even if observation is resolved')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const observations = metaCtx.observations || [];

        // Find observation
        const normalizedRef = ref.startsWith('@') ? ref.substring(1) : ref;
        const observation = observations.find((o) => o._ulid.startsWith(normalizedRef));

        if (!observation) {
          error(errors.reference.observationNotFound(ref));
          process.exit(1);
        }

        // AC-obs-6: Check if already promoted
        if (observation.promoted_to) {
          error(errors.conflict.observationAlreadyPromoted(observation.promoted_to));
          process.exit(1);
        }

        // AC-obs-8: Check if resolved
        if (observation.resolved && !options.force) {
          error(errors.operation.cannotPromoteResolved);
          process.exit(1);
        }

        // AC-obs-3: Create task with title, description from observation, meta_ref, and origin
        const task = createTask({
          title: options.title,
          description: observation.content,
          priority: Number.parseInt(options.priority, 10),
          meta_ref: observation.workflow_ref,
          origin: 'observation_promotion',
        });

        // Save task
        await saveTask(ctx, task);
        await commitIfShadow(ctx.shadow, 'task-add', task.slugs[0] || task._ulid.slice(0, 8), task.title);
        const taskRef = `@${task._ulid.substring(0, 8)}`;

        // Update observation with promoted_to field
        observation.promoted_to = taskRef;
        await saveObservation(ctx, observation);

        // AC-obs-3: outputs "OK Created task: <ULID-prefix>"
        // In JSON mode, return the created task object
        output(
          task,
          () => success(`Created task: ${taskRef.substring(0, 9)}`)
        );
      } catch (err) {
        error(errors.failures.promoteObservation, err);
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
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const observations = metaCtx.observations || [];

        // Find observation
        const normalizedRef = ref.startsWith('@') ? ref.substring(1) : ref;
        const observation = observations.find((o) => o._ulid.startsWith(normalizedRef));

        if (!observation) {
          error(errors.reference.observationNotFound(ref));
          process.exit(1);
        }

        // AC-obs-7: Check if already resolved
        if (observation.resolved) {
          const resolvedDate = new Date(observation.resolved_at!).toISOString().split('T')[0];
          const resolutionText = observation.resolution || '';
          const truncated = resolutionText.length > 50
            ? resolutionText.substring(0, 50) + '...'
            : resolutionText;
          error(errors.conflict.observationAlreadyResolved(resolvedDate, truncated));
          process.exit(1);
        }

        // AC-obs-9: Auto-populate resolution from task completion if promoted
        let finalResolution = resolution;
        if (!finalResolution && observation.promoted_to) {
          // Fetch task to get completion reason
          const tasks = await loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const index = new ReferenceIndex(tasks, items);
          const taskResult = index.resolve(observation.promoted_to);

          if (taskResult.ok) {
            const item = taskResult.item;
            // Type guard: ensure this is a task (has status and depends_on properties)
            if ('status' in item && 'depends_on' in item) {
              const task = item as LoadedTask;
              if (task.status === 'completed' && task.closed_reason) {
                finalResolution = `Resolved via task ${observation.promoted_to}: ${task.closed_reason}`;
              } else if (task.status === 'completed') {
                finalResolution = `Resolved via task ${observation.promoted_to}`;
              } else {
                error(`Task ${observation.promoted_to} is not completed yet`);
                process.exit(1);
              }
            } else {
              error(`Reference ${observation.promoted_to} is not a task`);
              process.exit(1);
            }
          } else {
            error(`Task ${observation.promoted_to} not found`);
            process.exit(1);
          }
        }

        if (!finalResolution) {
          error(errors.validation.resolutionRequired);
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
        error(errors.failures.resolveObservation, err);
        process.exit(1);
      }
    });

  // Meta add command - create new meta items
  meta
    .command('add <type>')
    .description('Create a new meta item (agent, workflow, or convention)')
    .option('--id <id>', 'Semantic ID (required for agents and workflows)')
    .option('--domain <domain>', 'Domain (required for conventions)')
    .option('--name <name>', 'Name (for agents)')
    .option('--trigger <trigger>', 'Trigger (for workflows)')
    .option('--description <desc>', 'Description')
    .option('--capability <cap...>', 'Capabilities (for agents)')
    .option('--tool <tool...>', 'Tools (for agents)')
    .option('--convention <conv...>', 'Convention references (for agents)')
    .option('--rule <rule...>', 'Rules (for conventions)')
    .action(async (type: string, options) => {
      try {
        const ctx = await initContext();

        // Validate type
        const validTypes = ['agent', 'workflow', 'convention'];
        if (!validTypes.includes(type)) {
          error(errors.validation.invalidType(type, validTypes));
          process.exit(1);
        }

        // Generate ULID
        const itemUlid = ulid();

        // Create the item based on type
        let item: Agent | Workflow | Convention;

        if (type === 'agent') {
          // Validate required fields
          if (!options.id) {
            error(errors.validation.agentRequiresId);
            process.exit(1);
          }
          if (!options.name) {
            error(errors.validation.agentRequiresName);
            process.exit(1);
          }

          item = {
            _ulid: itemUlid,
            id: options.id,
            name: options.name,
            description: options.description || '',
            capabilities: options.capability || [],
            tools: options.tool || [],
            conventions: options.convention || [],
          };
        } else if (type === 'workflow') {
          // Validate required fields
          if (!options.id) {
            error(errors.validation.workflowRequiresId);
            process.exit(1);
          }
          if (!options.trigger) {
            error(errors.validation.workflowRequiresTrigger);
            process.exit(1);
          }

          item = {
            _ulid: itemUlid,
            id: options.id,
            trigger: options.trigger,
            description: options.description || '',
            steps: [],
          };
        } else {
          // convention
          if (!options.domain) {
            error(errors.validation.conventionRequiresDomain);
            process.exit(1);
          }

          item = {
            _ulid: itemUlid,
            domain: options.domain,
            rules: options.rule || [],
            examples: [],
          };
        }

        // Save the item
        await saveMetaItem(ctx, item, type as 'agent' | 'workflow' | 'convention');

        if (isJsonMode()) {
          // In JSON mode, output the item data directly
          console.log(JSON.stringify(item, null, 2));
        } else {
          const idOrDomain = 'id' in item ? item.id : 'domain' in item ? item.domain : itemUlid;
          success(`Created ${type}: ${idOrDomain} (@${itemUlid.substring(0, 8)})`);
        }
      } catch (err) {
        error(errors.failures.createMeta(type), err);
        process.exit(1);
      }
    });

  // Meta set command - update existing meta items
  meta
    .command('set <ref>')
    .description('Update an existing meta item')
    .option('--name <name>', 'Update name (for agents)')
    .option('--description <desc>', 'Update description')
    .option('--trigger <trigger>', 'Update trigger (for workflows)')
    .option('--add-capability <cap>', 'Add capability (for agents)')
    .option('--add-tool <tool>', 'Add tool (for agents)')
    .option('--add-convention <conv>', 'Add convention reference (for agents)')
    .option('--add-rule <rule>', 'Add rule (for conventions)')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const metaCtx = await loadMetaContext(ctx);

        // Find the item using unified lookup
        const normalizedRef = ref.startsWith('@') ? ref.substring(1) : ref;
        let found: Agent | Workflow | Convention | null = null;
        let itemType: 'agent' | 'workflow' | 'convention' | null = null;

        // Search in agents
        const agents = metaCtx.manifest?.agents || [];
        const agent = agents.find(
          (a) => a.id === normalizedRef || a._ulid.startsWith(normalizedRef)
        );
        if (agent) {
          found = agent;
          itemType = 'agent';
        }

        // Search in workflows
        if (!found) {
          const workflows = metaCtx.manifest?.workflows || [];
          const workflow = workflows.find(
            (w) => w.id === normalizedRef || w._ulid.startsWith(normalizedRef)
          );
          if (workflow) {
            found = workflow;
            itemType = 'workflow';
          }
        }

        // Search in conventions
        if (!found) {
          const conventions = metaCtx.manifest?.conventions || [];
          const convention = conventions.find(
            (c) => c.domain === normalizedRef || c._ulid.startsWith(normalizedRef)
          );
          if (convention) {
            found = convention;
            itemType = 'convention';
          }
        }

        if (!found || !itemType) {
          error(errors.reference.metaNotFound(ref));
          process.exit(1);
        }

        // Update fields based on type
        if (itemType === 'agent') {
          const item = found as Agent;
          if (options.name) item.name = options.name;
          if (options.description !== undefined) item.description = options.description;
          if (options.addCapability) {
            if (!item.capabilities.includes(options.addCapability)) {
              item.capabilities.push(options.addCapability);
            }
          }
          if (options.addTool) {
            if (!item.tools.includes(options.addTool)) {
              item.tools.push(options.addTool);
            }
          }
          if (options.addConvention) {
            if (!item.conventions.includes(options.addConvention)) {
              item.conventions.push(options.addConvention);
            }
          }
        } else if (itemType === 'workflow') {
          const item = found as Workflow;
          if (options.trigger) item.trigger = options.trigger;
          if (options.description !== undefined) item.description = options.description;
        } else {
          const item = found as Convention;
          // Convention doesn't have a description field
          if (options.addRule) {
            if (!item.rules.includes(options.addRule)) {
              item.rules.push(options.addRule);
            }
          }
        }

        // Save the updated item
        await saveMetaItem(ctx, found, itemType);

        if (isJsonMode()) {
          // In JSON mode, output the item data directly
          console.log(JSON.stringify(found, null, 2));
        } else {
          const idOrDomain =
            itemType === 'agent'
              ? (found as Agent).id
              : itemType === 'workflow'
                ? (found as Workflow).id
                : (found as Convention).domain;
          success(`Updated ${itemType}: ${idOrDomain}`);
        }
      } catch (err) {
        error(errors.failures.updateMetaItem, err);
        process.exit(1);
      }
    });

  // Meta delete command - delete meta items
  meta
    .command('delete <ref>')
    .description('Delete a meta item')
    .option('--confirm', 'Skip confirmation prompt')
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const metaCtx = await loadMetaContext(ctx);

        // Find the item to determine type
        const normalizedRef = ref.startsWith('@') ? ref.substring(1) : ref;
        let itemType: 'agent' | 'workflow' | 'convention' | 'observation' | null = null;
        let itemUlid: string | null = null;
        let itemLabel: string | null = null;

        // Search in agents
        const agents = metaCtx.manifest?.agents || [];
        const agent = agents.find(
          (a) => a.id === normalizedRef || a._ulid.startsWith(normalizedRef)
        );
        if (agent) {
          itemType = 'agent';
          itemUlid = agent._ulid;
          itemLabel = `agent ${agent.id}`;
        }

        // Search in workflows
        if (!itemType) {
          const workflows = metaCtx.manifest?.workflows || [];
          const workflow = workflows.find(
            (w) => w.id === normalizedRef || w._ulid.startsWith(normalizedRef)
          );
          if (workflow) {
            itemType = 'workflow';
            itemUlid = workflow._ulid;
            itemLabel = `workflow ${workflow.id}`;
          }
        }

        // Search in conventions
        if (!itemType) {
          const conventions = metaCtx.manifest?.conventions || [];
          const convention = conventions.find(
            (c) => c.domain === normalizedRef || c._ulid.startsWith(normalizedRef)
          );
          if (convention) {
            itemType = 'convention';
            itemUlid = convention._ulid;
            itemLabel = `convention ${convention.domain}`;
          }
        }

        // Search in observations
        if (!itemType) {
          const observations = metaCtx.observations || [];
          const observation = observations.find((o) => o._ulid.startsWith(normalizedRef));
          if (observation) {
            itemType = 'observation';
            itemUlid = observation._ulid;
            itemLabel = `observation ${observation._ulid.substring(0, 8)}`;
          }
        }

        if (!itemType || !itemUlid || !itemLabel) {
          error(errors.reference.metaNotFound(ref));
          process.exit(1);
        }

        // Check for dangling references (unless --confirm is used to override)
        if (!options.confirm) {
          // Check tasks with meta_ref
          const tasks = await loadAllTasks(ctx);
          const referencingTasks = tasks.filter((t) => {
            if (!t.meta_ref) return false;
            // Resolve the task's meta_ref to a ULID
            const taskMetaRef = resolveMetaRefToUlid(t.meta_ref, metaCtx);
            // Compare ULIDs to handle both semantic IDs and ULID prefixes
            return taskMetaRef && taskMetaRef.ulid === itemUlid;
          });

          if (referencingTasks.length > 0) {
            const taskRefs = referencingTasks
              .map((t) => `@${t.slugs?.[0] || t._ulid.substring(0, 8)}`)
              .join(', ');
            error(errors.operation.cannotDeleteReferencedByTasks(itemLabel, referencingTasks.length, taskRefs));
            process.exit(1);
          }

          // Check observations with workflow_ref (only for workflows)
          if (itemType === 'workflow') {
            const observations = metaCtx.observations || [];
            const referencingObservations = observations.filter((o) => {
              if (!o.workflow_ref) return false;
              // Resolve the observation's workflow_ref to a ULID
              const obsWorkflowRef = resolveMetaRefToUlid(o.workflow_ref, metaCtx);
              // Compare ULIDs to handle both semantic IDs and ULID prefixes
              return obsWorkflowRef && obsWorkflowRef.ulid === itemUlid;
            });

            if (referencingObservations.length > 0) {
              const obsRefs = referencingObservations
                .map((o) => `@${o._ulid.substring(0, 8)}`)
                .join(', ');
              error(errors.operation.cannotDeleteReferencedByObservations(itemLabel, referencingObservations.length, obsRefs));
              process.exit(1);
            }
          }

          // Show confirmation prompt even if no references found
          error(errors.operation.confirmRequired(itemLabel));
          process.exit(1);
        }

        // Delete the item
        const deleted = await deleteMetaItem(ctx, itemUlid, itemType);

        if (!deleted) {
          error(errors.operation.deleteItemFailed(itemLabel));
          process.exit(1);
        }

        success(`Deleted ${itemLabel}`);
      } catch (err) {
        error(errors.failures.deleteMetaItem, err);
        process.exit(1);
      }
    });

  // meta-focus-cmd: kspec meta focus [ref]
  meta
    .command('focus [ref]')
    .description('Get or set session focus')
    .option('--clear', 'Clear current focus')
    .action(async (ref: string | undefined, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        const sessionCtx = await loadSessionContext(ctx);

        // Clear focus
        if (options.clear) {
          sessionCtx.focus = null;
          await saveSessionContext(ctx, sessionCtx);

          output(
            { focus: null },
            () => success('Cleared session focus')
          );
          return;
        }

        // Show current focus
        if (!ref) {
          output(
            { focus: sessionCtx.focus },
            () => {
              if (sessionCtx.focus) {
                console.log(`Current focus: ${sessionCtx.focus}`);
              } else {
                console.log(chalk.yellow('No focus set'));
              }
            }
          );
          return;
        }

        // Set focus to ref
        sessionCtx.focus = ref.startsWith('@') ? ref : `@${ref}`;
        await saveSessionContext(ctx, sessionCtx);

        output(
          { focus: sessionCtx.focus },
          () => success(`Set focus to: ${sessionCtx.focus}`)
        );
      } catch (err) {
        error(errors.failures.updateSessionContext, err);
        process.exit(1);
      }
    });

  // meta-thread-cmd: kspec meta thread <action> [text]
  meta
    .command('thread <action> [text]')
    .description('Manage active threads')
    .action(async (action: string, text: string | undefined) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        const sessionCtx = await loadSessionContext(ctx);

        // List threads
        if (action === 'list') {
          output(
            { threads: sessionCtx.threads },
            () => {
              if (sessionCtx.threads.length === 0) {
                console.log(chalk.yellow('No active threads'));
              } else {
                console.log('Active threads:');
                sessionCtx.threads.forEach((thread, idx) => {
                  console.log(`  ${idx + 1}. ${thread}`);
                });
              }
            }
          );
          return;
        }

        // Clear all threads
        if (action === 'clear') {
          sessionCtx.threads = [];
          await saveSessionContext(ctx, sessionCtx);

          output(
            { threads: [] },
            () => success('Cleared all threads')
          );
          return;
        }

        // Add thread
        if (action === 'add') {
          if (!text) {
            error('Thread text is required for add action');
            process.exit(1);
          }

          sessionCtx.threads.push(text);
          await saveSessionContext(ctx, sessionCtx);

          output(
            { threads: sessionCtx.threads, added: text },
            () => success(`Added thread: ${text}`)
          );
          return;
        }

        // Remove thread by index (1-based)
        if (action === 'remove') {
          if (!text) {
            error('Index is required for remove action');
            process.exit(1);
          }

          const index = parseInt(text, 10);
          if (isNaN(index) || index < 1 || index > sessionCtx.threads.length) {
            error(`Invalid index: ${text}. Must be between 1 and ${sessionCtx.threads.length}`);
            process.exit(1);
          }

          const removed = sessionCtx.threads.splice(index - 1, 1)[0];
          await saveSessionContext(ctx, sessionCtx);

          output(
            { threads: sessionCtx.threads, removed },
            () => success(`Removed thread: ${removed}`)
          );
          return;
        }

        // Unknown action
        error(`Unknown action: ${action}. Use add, remove, list, or clear`);
        process.exit(1);
      } catch (err) {
        error(errors.failures.updateSessionContext, err);
        process.exit(1);
      }
    });

  // meta-question-cmd: kspec meta question <action> [text]
  meta
    .command('question <action> [text]')
    .description('Manage open questions')
    .action(async (action: string, text: string | undefined) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(1);
        }

        const sessionCtx = await loadSessionContext(ctx);

        // List questions
        if (action === 'list') {
          output(
            { questions: sessionCtx.open_questions },
            () => {
              if (sessionCtx.open_questions.length === 0) {
                console.log(chalk.yellow('No open questions'));
              } else {
                console.log('Open questions:');
                sessionCtx.open_questions.forEach((question, idx) => {
                  console.log(`  ${idx + 1}. ${question}`);
                });
              }
            }
          );
          return;
        }

        // Clear all questions
        if (action === 'clear') {
          sessionCtx.open_questions = [];
          await saveSessionContext(ctx, sessionCtx);

          output(
            { questions: [] },
            () => success('Cleared all questions')
          );
          return;
        }

        // Add question
        if (action === 'add') {
          if (!text) {
            error('Question text is required for add action');
            process.exit(1);
          }

          sessionCtx.open_questions.push(text);
          await saveSessionContext(ctx, sessionCtx);

          output(
            { questions: sessionCtx.open_questions, added: text },
            () => success(`Added question: ${text}`)
          );
          return;
        }

        // Remove question by index (1-based)
        if (action === 'remove') {
          if (!text) {
            error('Index is required for remove action');
            process.exit(1);
          }

          const index = parseInt(text, 10);
          if (isNaN(index) || index < 1 || index > sessionCtx.open_questions.length) {
            error(`Invalid index: ${text}. Must be between 1 and ${sessionCtx.open_questions.length}`);
            process.exit(1);
          }

          const removed = sessionCtx.open_questions.splice(index - 1, 1)[0];
          await saveSessionContext(ctx, sessionCtx);

          output(
            { questions: sessionCtx.open_questions, removed },
            () => success(`Removed question: ${removed}`)
          );
          return;
        }

        // Unknown action
        error(`Unknown action: ${action}. Use add, remove, list, or clear`);
        process.exit(1);
      } catch (err) {
        error(errors.failures.updateSessionContext, err);
        process.exit(1);
      }
    });
}
