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
  type MetaContext,
  type Agent,
  type Workflow,
  type Convention,
  type Observation,
} from '../../parser/index.js';
import { type ObservationType } from '../../schema/index.js';
import { output, error, success, isJsonMode } from '../output.js';

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

  // AC-conv-1, AC-conv-2, AC-conv-5: kspec meta conventions
  meta
    .command('conventions')
    .description('List conventions defined in meta-spec')
    .option('--domain <domain>', 'Filter by specific domain')
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error('No kspec project found');
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const conventions = metaCtx.manifest?.conventions || [];

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
        error('Failed to list conventions', err);
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
          error('No kspec project found');
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);

        // Normalize reference
        const normalizedRef = ref.startsWith('@') ? ref.substring(1) : ref;

        // Search in all meta item types
        const agents = metaCtx.manifest?.agents || [];
        const workflows = metaCtx.manifest?.workflows || [];
        const conventions = metaCtx.manifest?.conventions || [];
        const observations = metaCtx.manifest?.observations || [];

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
          error(`Meta item not found: ${ref}`);
          process.exit(1);
        }

        // Output the item
        output(found, () => {
          console.log(chalk.bold(`${itemType.charAt(0).toUpperCase() + itemType.slice(1)}: ${ref}`));
          console.log(chalk.gray('─'.repeat(60)));
          console.log(JSON.stringify(found, null, 2));
        });
      } catch (err) {
        error('Failed to get meta item', err);
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
          error('No kspec project found');
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
          for (const agent of metaCtx.manifest?.agents || []) {
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
          for (const workflow of metaCtx.manifest?.workflows || []) {
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
          for (const convention of metaCtx.manifest?.conventions || []) {
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
          for (const observation of metaCtx.manifest?.observations || []) {
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
        error('Failed to list meta items', err);
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
          error(`Invalid type: ${type}. Must be one of: ${validTypes.join(', ')}`);
          process.exit(1);
        }

        // Generate ULID
        const itemUlid = ulid();

        // Create the item based on type
        let item: Agent | Workflow | Convention;

        if (type === 'agent') {
          // Validate required fields
          if (!options.id) {
            error('Agent requires --id');
            process.exit(1);
          }
          if (!options.name) {
            error('Agent requires --name');
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
            error('Workflow requires --id');
            process.exit(1);
          }
          if (!options.trigger) {
            error('Workflow requires --trigger');
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
            error('Convention requires --domain');
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
        error(`Failed to create ${type}`, err);
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
          error(`Meta item not found: ${ref}`);
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
        error('Failed to update meta item', err);
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
          const observations = metaCtx.manifest?.observations || [];
          const observation = observations.find((o) => o._ulid.startsWith(normalizedRef));
          if (observation) {
            itemType = 'observation';
            itemUlid = observation._ulid;
            itemLabel = `observation ${observation._ulid.substring(0, 8)}`;
          }
        }

        if (!itemType || !itemUlid || !itemLabel) {
          error(`Meta item not found: ${ref}`);
          process.exit(1);
        }

        // Confirmation
        if (!options.confirm) {
          error(`Warning: This will delete ${itemLabel}. Use --confirm to skip this prompt`);
          process.exit(1);
        }

        // Delete the item
        const deleted = await deleteMetaItem(ctx, itemUlid, itemType);

        if (!deleted) {
          error(`Failed to delete ${itemLabel}`);
          process.exit(1);
        }

        success(`Deleted ${itemLabel}`);
      } catch (err) {
        error('Failed to delete meta item', err);
        process.exit(1);
      }
    });
}
