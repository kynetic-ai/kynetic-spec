/**
 * Meta CLI commands for interacting with meta-spec.
 *
 * AC-meta-manifest-1: kspec meta show outputs summary
 * AC-meta-manifest-2: kspec validate includes meta line
 * AC-meta-manifest-3: kspec validate shows meta errors with prefix
 * AC-agent-1: kspec meta agents outputs table
 * AC-agent-2: kspec meta agents --json outputs JSON
 */

import chalk from "chalk";
import Table from "cli-table3";
import type { Command } from "commander";
import { ulid } from "ulid";
import { markMutating } from "../command-annotations.js";
import {
  type Agent,
  type Convention,
  createObservation,
  createTask,
  deleteInboxItem,
  deleteMetaItem,
  findInboxItemByRef,
  getMetaStats,
  initContext,
  type LoadedTask,
  loadAllItems,
  loadAllTasks,
  loadInboxItems,
  loadMetaContext,
  loadSessionContext,
  type MetaContext,
  type Observation,
  ReferenceIndex,
  resolveMetaRef,
  saveMetaItem,
  saveObservation,
  saveSessionContext,
  saveTask,
  type Workflow,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { normalizeRefInput } from "../../schema/index.js";
import { z } from "zod";
import {
  type ObservationType,
  type WorkflowStep,
  WorkflowStepSchema,
} from "../../schema/index.js";
import { errors } from "../../strings/errors.js";
import { executeBatchOperation, formatBatchOutput } from "../batch.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, isJsonMode, output, success } from "../output.js";
import { parseTagsArray } from "../parse-utils.js";
import { parseIntOption } from "../validators.js";

/**
 * Resolve a meta reference to its ULID and type.
 * Wrapper around resolveMetaRef for backward compatibility with existing call sites.
 * AC: @skill-meta-integration ac-4 - skills included in resolution
 */
function resolveMetaRefToUlid(
  ref: string,
  metaCtx: MetaContext,
): {
  ulid: string;
  type: "agent" | "workflow" | "convention" | "observation" | "skill";
} | null {
  const result = resolveMetaRef(metaCtx, ref);
  if (!result) return null;
  return { ulid: result.ulid, type: result.type };
}

/**
 * Batch-compatible resolver for observations.
 * Returns null instead of calling process.exit() to allow partial failure handling.
 * AC: @trait-multi-ref-batch ac-2, ac-8 - Partial failure handling and ref resolution
 */
function resolveObservationRefForBatch(
  ref: string,
  observations: Observation[],
): { item: Observation | null; error?: string } {
  const normalizedRef = ref.startsWith("@") ? ref.substring(1) : ref;
  const observation = observations.find((o) =>
    o._ulid.startsWith(normalizedRef),
  );

  if (!observation) {
    return { item: null, error: `Observation not found: ${ref}` };
  }

  return { item: observation };
}

/**
 * Format meta show output
 * AC: @skill-meta-integration ac-3 - skill count included in summary
 */
function formatMetaShow(meta: MetaContext): void {
  const stats = getMetaStats(meta);

  if (!meta.manifest) {
    console.log(chalk.yellow("No meta manifest found (kynetic.meta.yaml)"));
    console.log(
      chalk.gray(
        "Create one to define agents, workflows, conventions, observations, and skills",
      ),
    );
    return;
  }

  console.log(chalk.bold("Meta-Spec Summary"));
  console.log(chalk.gray("─".repeat(40)));
  console.log(`Agents:       ${stats.agents}`);
  console.log(`Workflows:    ${stats.workflows}`);
  console.log(`Conventions:  ${stats.conventions}`);
  console.log(
    `Observations: ${stats.observations} (${stats.unresolvedObservations} unresolved)`,
  );
  // AC: @skill-meta-integration ac-3 - include skill count
  console.log(`Skills:       ${stats.skills}`);
}

/**
 * Format agents table output
 * AC-agent-1: outputs table with columns: ID, Name, Capabilities
 */
function formatAgents(agents: Agent[]): void {
  if (agents.length === 0) {
    console.log(chalk.yellow("No agents defined"));
    return;
  }

  const table = new Table({
    head: [chalk.bold("ID"), chalk.bold("Name"), chalk.bold("Capabilities")],
    style: {
      head: [],
      border: [],
    },
  });

  for (const agent of agents) {
    table.push([agent.id, agent.name, agent.capabilities.join(", ")]);
  }

  console.log(table.toString());
}

/**
 * Format workflows table output
 * AC-workflow-1: outputs table with columns: ID, Trigger, Steps (count), Mode
 */
function formatWorkflows(workflows: Workflow[]): void {
  if (workflows.length === 0) {
    console.log(chalk.yellow("No workflows defined"));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold("ID"),
      chalk.bold("Trigger"),
      chalk.bold("Steps"),
      chalk.bold("Mode"),
    ],
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
      workflow.mode || "interactive",
    ]);
  }

  console.log(table.toString());
}

/**
 * Format workflows verbose output
 * AC-workflow-2: outputs each workflow with full step list
 * AC: @loop-mode-workflows ac-3 (shows based_on field)
 */
function formatWorkflowsVerbose(workflows: Workflow[]): void {
  if (workflows.length === 0) {
    console.log(chalk.yellow("No workflows defined"));
    return;
  }

  for (const workflow of workflows) {
    console.log(chalk.bold(`${workflow.id} - ${workflow.trigger}`));
    // Show mode if it's loop (skip for interactive as it's default)
    if (workflow.mode === "loop") {
      console.log(chalk.cyan(`Mode: ${workflow.mode}`));
    }
    // AC: @loop-mode-workflows ac-3 - Show based_on reference
    if (workflow.based_on) {
      console.log(chalk.cyan(`Based on: ${workflow.based_on}`));
    }
    if (workflow.description) {
      console.log(chalk.gray(workflow.description));
    }
    console.log(chalk.gray("─".repeat(60)));

    for (const step of workflow.steps) {
      const prefix = {
        check: chalk.yellow("[check]"),
        action: chalk.blue("[action]"),
        decision: chalk.magenta("[decision]"),
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

    console.log("");
  }
}

/**
 * Format conventions table output
 * AC-conv-1: outputs table with columns: Domain, Rules (count), Validation (yes/no)
 */
function formatConventions(conventions: Convention[]): void {
  if (conventions.length === 0) {
    console.log(chalk.yellow("No conventions defined"));
    return;
  }

  const table = new Table({
    head: [chalk.bold("Domain"), chalk.bold("Rules"), chalk.bold("Validation")],
    style: {
      head: [],
      border: [],
    },
  });

  for (const convention of conventions) {
    table.push([
      convention.domain,
      convention.rules.length.toString(),
      convention.validation ? "yes" : "no",
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
  console.log(chalk.gray("─".repeat(60)));

  console.log(chalk.bold("\nRules:"));
  for (const rule of convention.rules) {
    console.log(`  • ${rule}`);
  }

  if (convention.examples && convention.examples.length > 0) {
    console.log(chalk.bold("\nExamples:"));
    for (const example of convention.examples) {
      console.log(chalk.green(`  ✓ ${example.good}`));
      console.log(chalk.red(`  ✗ ${example.bad}`));
    }
  }

  if (convention.validation) {
    console.log(chalk.bold("\nValidation:"));
    console.log(`  Type: ${convention.validation.type}`);
    if (convention.validation.pattern) {
      console.log(`  Pattern: ${convention.validation.pattern}`);
    }
    if (convention.validation.message) {
      console.log(`  Message: ${convention.validation.message}`);
    }
  }

  console.log("");
}

/**
 * Format observations table output
 * AC-obs-2: outputs table with columns: ID, Type, Workflow, Created, Content (truncated)
 * AC: @obs-list-display ac-1 - When --all flag used, show Resolved column with ✓/✗
 */
function formatObservations(
  observations: Observation[],
  showResolved: boolean,
): void {
  const filtered = showResolved
    ? observations
    : observations.filter((o) => !o.resolved);

  if (filtered.length === 0) {
    console.log(
      chalk.yellow(
        showResolved ? "No observations found" : "No unresolved observations",
      ),
    );
    return;
  }

  // AC: @obs-list-display ac-1 - Include Resolved column when showing all observations
  const headers = showResolved
    ? [
        chalk.bold("ID"),
        chalk.bold("Type"),
        chalk.bold("Resolved"),
        chalk.bold("Workflow"),
        chalk.bold("Created"),
        chalk.bold("Content"),
      ]
    : [
        chalk.bold("ID"),
        chalk.bold("Type"),
        chalk.bold("Workflow"),
        chalk.bold("Created"),
        chalk.bold("Content"),
      ];

  const colWidths = showResolved
    ? [10, 10, 10, 20, 12, 40]
    : [10, 10, 20, 12, 50];

  const table = new Table({
    head: headers,
    style: {
      head: [],
      border: [],
    },
    colWidths,
    wordWrap: true,
  });

  for (const obs of filtered) {
    const id = obs._ulid.substring(0, 8);
    const workflow = obs.workflow_ref || "-";
    const created = new Date(obs.created_at).toISOString().split("T")[0];
    // Adjust content truncation based on available column width
    const maxContentLen = showResolved ? 37 : 47;
    const content =
      obs.content.length > maxContentLen
        ? `${obs.content.substring(0, maxContentLen)}...`
        : obs.content;

    // AC: @obs-list-display ac-1 - Show ✓ for resolved, ✗ for unresolved
    if (showResolved) {
      const resolvedIndicator = obs.resolved
        ? chalk.green("✓")
        : chalk.red("✗");
      table.push([id, obs.type, resolvedIndicator, workflow, created, content]);
    } else {
      table.push([id, obs.type, workflow, created, content]);
    }
  }

  console.log(table.toString());
}

/**
 * Register meta commands
 */
export function registerMetaCommands(program: Command): void {
  const meta = program
    .command("meta")
    .description(
      "Meta-spec commands (agents, workflows, conventions, observations)",
    );

  // AC-meta-manifest-1: kspec meta show outputs summary with counts
  meta
    .command("show")
    .description("Display meta-spec summary")
    .action(async () => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const stats = getMetaStats(metaCtx);

        output(
          {
            manifest: metaCtx.manifestPath,
            stats,
          },
          () => formatMetaShow(metaCtx),
        );
      } catch (err) {
        error(errors.failures.showMeta, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC-agent-1, AC-agent-2: kspec meta agents
  meta
    .command("agents")
    .description("List agents defined in meta-spec")
    .action(async () => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
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
          () => formatAgents(agents),
        );
      } catch (err) {
        error(errors.failures.listAgents, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC-workflow-1, AC-workflow-2, AC-workflow-4: kspec meta workflows
  // AC: @loop-mode-workflows ac-1 (--tag loop filtering)
  meta
    .command("workflows")
    .description("List workflows defined in meta-spec")
    .option("--verbose", "Show full workflow details with all steps")
    .option("--tag <tag>", "Filter workflows by tag (e.g., --tag loop)")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        let workflows = metaCtx.workflows || [];

        // AC: @loop-mode-workflows ac-1 - Filter by tag
        if (options.tag) {
          workflows = workflows.filter((w) => {
            // Match by explicit tags array or by mode field (for "loop" tag)
            const tags = w.tags || [];
            if (tags.includes(options.tag)) return true;
            // Special case: --tag loop also matches mode: loop
            if (options.tag === "loop" && w.mode === "loop") return true;
            return false;
          });
        }

        // AC-workflow-4: JSON output includes full workflow details
        output(
          workflows.map((workflow) => ({
            id: workflow.id,
            trigger: workflow.trigger,
            description: workflow.description,
            steps: workflow.steps,
            mode: workflow.mode || "interactive",
            based_on: workflow.based_on,
            tags: workflow.tags || [],
          })),
          // AC-workflow-1 (table) or AC-workflow-2 (verbose)
          () => {
            if (options.verbose) {
              formatWorkflowsVerbose(workflows);
            } else {
              formatWorkflows(workflows);
            }
          },
        );
      } catch (err) {
        error(errors.failures.listWorkflows, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC-conv-1, AC-conv-2, AC-conv-5: kspec meta conventions
  meta
    .command("conventions")
    .description("List conventions defined in meta-spec")
    .option("--domain <domain>", "Filter by specific domain")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
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
          },
        );
      } catch (err) {
        error(errors.failures.listConventions, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // meta-get-cmd: kspec meta get <ref>
  // AC: @skill-meta-integration ac-1 - skills can be retrieved by id
  meta
    .command("get <ref>")
    .description(
      "Get a meta item by reference (agent, workflow, convention, observation, or skill)",
    )
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);

        // AC: @skill-meta-integration ac-1 - Use unified resolver
        const resolved = resolveMetaRef(metaCtx, ref);

        if (!resolved) {
          error(errors.reference.metaNotFound(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        const { item: found, type: itemType } = resolved;

        // Output the item
        output(found, () => {
          console.log(
            chalk.bold(
              `${itemType.charAt(0).toUpperCase() + itemType.slice(1)}: ${ref}`,
            ),
          );
          console.log(chalk.gray("─".repeat(60)));
          console.log(JSON.stringify(found, null, 2));
        });
      } catch (err) {
        error(errors.failures.getMetaItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // meta-list-cmd: kspec meta list
  // AC: @skill-meta-integration ac-2 - skills can be filtered with --type skill
  meta
    .command("list")
    .description("List all meta items")
    .option(
      "--type <type>",
      "Filter by type (agent, workflow, convention, observation, skill)",
    )
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
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
        if (!options.type || options.type === "agent") {
          for (const agent of metaCtx.agents || []) {
            items.push({
              id: agent.id,
              type: "agent",
              context: agent.name,
              ulid: agent._ulid,
            });
          }
        }

        // Add workflows
        if (!options.type || options.type === "workflow") {
          for (const workflow of metaCtx.workflows || []) {
            items.push({
              id: workflow.id,
              type: "workflow",
              context: workflow.trigger,
              ulid: workflow._ulid,
            });
          }
        }

        // Add conventions
        if (!options.type || options.type === "convention") {
          for (const convention of metaCtx.conventions || []) {
            items.push({
              id: convention.domain,
              type: "convention",
              context: `${convention.rules.length} rules`,
              ulid: convention._ulid,
            });
          }
        }

        // Add observations
        if (!options.type || options.type === "observation") {
          for (const observation of metaCtx.observations || []) {
            const ulidPrefix = observation._ulid.substring(0, 8);
            items.push({
              id: ulidPrefix,
              type: "observation",
              context: `${observation.type} ${observation.resolved ? "(resolved)" : ""}`,
              ulid: observation._ulid,
            });
          }
        }

        // AC: @skill-meta-integration ac-2 - Add skills
        if (!options.type || options.type === "skill") {
          for (const skill of metaCtx.skills || []) {
            items.push({
              id: skill.id,
              type: "skill",
              context: skill.name || skill.description || skill.origin,
              ulid: skill._ulid,
            });
          }
        }

        // Output
        output(items, () => {
          if (items.length === 0) {
            console.log(chalk.yellow("No meta items found"));
            return;
          }

          const table = new Table({
            head: [chalk.bold("ID"), chalk.bold("Type"), chalk.bold("Context")],
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
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC-obs-1: kspec meta observe <type> <content>
  // AC: @meta-observe-cmd from-inbox-conversion
  markMutating(meta.command("observe [type] [content]"))
    .description("Create an observation (friction, success, question, idea)")
    .option(
      "--workflow <ref>",
      "Reference to workflow this observation relates to",
    )
    .option("--author <author>", "Author of the observation")
    .option("--from-inbox <ref>", "Convert inbox item to observation")
    .option(
      "--type <type>",
      "Override type when using --from-inbox (defaults to idea)",
    )
    .action(
      async (
        type: string | undefined,
        content: string | undefined,
        options,
      ) => {
        try {
          const ctx = await initContext();

          if (!ctx.manifestPath) {
            error(errors.project.noKspecProject);
            process.exit(EXIT_CODES.ERROR);
          }

          // AC: @meta-observe-cmd from-inbox-conversion
          // Handle --from-inbox flag
          if (options.fromInbox) {
            // Load inbox items
            const inboxItems = await loadInboxItems(ctx);
            const item = findInboxItemByRef(inboxItems, options.fromInbox);

            if (!item) {
              error(errors.reference.inboxNotFound(options.fromInbox));
              process.exit(EXIT_CODES.NOT_FOUND);
            }

            // Use inbox item content
            const observationContent = item.text;

            // Type defaults to 'idea' but can be overridden with --type flag
            const observationType = (options.type || "idea") as ObservationType;

            // Validate observation type
            const validTypes: ObservationType[] = [
              "friction",
              "success",
              "question",
              "idea",
            ];
            if (!validTypes.includes(observationType)) {
              error(errors.validation.invalidObservationType(observationType));
              console.log(`Valid types: ${validTypes.join(", ")}`);
              process.exit(EXIT_CODES.ERROR);
            }

            // Create observation
            const observation = createObservation(
              observationType,
              observationContent,
              {
                workflow_ref: options.workflow,
                author: options.author,
                configAuthor: ctx.config?.identity?.author,
              },
            );

            // Save observation
            await saveObservation(ctx, observation);

            // Delete inbox item
            const deleted = await deleteInboxItem(ctx, item._ulid);
            if (!deleted) {
              error("Failed to delete inbox item after creating observation");
              process.exit(EXIT_CODES.ERROR);
            }

            await commitIfShadow(
              ctx.shadow,
              "meta-observe-from-inbox",
              observation._ulid.substring(0, 8),
              `Convert inbox item to ${observationType} observation`,
            );

            // Return observation ref
            output(observation, () =>
              success(
                `Created observation: ${observation._ulid.substring(0, 8)}`,
              ),
            );
            return;
          }

          // Standard observe flow (without --from-inbox)
          if (!type || !content) {
            error("Type and content are required when not using --from-inbox");
            process.exit(EXIT_CODES.ERROR);
          }

          // Validate observation type
          const validTypes: ObservationType[] = [
            "friction",
            "success",
            "question",
            "idea",
          ];
          if (!validTypes.includes(type as ObservationType)) {
            error(errors.validation.invalidObservationType(type));
            console.log(`Valid types: ${validTypes.join(", ")}`);
            process.exit(EXIT_CODES.ERROR);
          }

          // Create observation
          const observation = createObservation(
            type as ObservationType,
            content,
            {
              workflow_ref: options.workflow,
              author: options.author,
              configAuthor: ctx.config?.identity?.author,
            },
          );

          // Save to manifest
          await saveObservation(ctx, observation);

          // AC: @trait-shadow-commit ac-1
          await commitIfShadow(
            ctx.shadow,
            "meta-observe",
            observation._ulid.substring(0, 8),
            type as string,
          );

          // AC-obs-1: outputs "OK Created observation: <ULID-prefix>"
          // In JSON mode, return the created observation object
          output(observation, () =>
            success(
              `Created observation: ${observation._ulid.substring(0, 8)}`,
            ),
          );
        } catch (err) {
          error(errors.failures.createObservation, err);
          process.exit(EXIT_CODES.ERROR);
        }
      },
    );

  // AC-obs-2, AC-obs-5: kspec meta observations
  // AC: @observation-content-search ac-search-flag, ac-regex-support, ac-combined-filters
  meta
    .command("observations")
    .description("List observations (shows unresolved by default)")
    .option(
      "--type <type>",
      "Filter by observation type (friction/success/question/idea)",
    )
    .option("--workflow <ref>", "Filter by workflow reference")
    .option("--all", "Include resolved observations")
    .option("--promoted", "Show only observations promoted to tasks")
    .option(
      "--pending-resolution",
      "Show observations with completed tasks awaiting resolution",
    )
    .option(
      "--search <pattern>",
      "Search observations by regex pattern (matches content)",
    )
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        let observations = metaCtx.observations || [];

        // Apply filters
        if (options.type) {
          observations = observations.filter(
            (obs) => obs.type === options.type,
          );
        }

        if (options.workflow) {
          observations = observations.filter(
            (obs) => obs.workflow_ref === options.workflow,
          );
        }

        if (options.promoted) {
          observations = observations.filter(
            (obs) => obs.promoted_to !== undefined,
          );
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
            return (
              "status" in item &&
              "depends_on" in item &&
              item.status === "completed"
            );
          });
        }

        // AC: @observation-content-search ac-search-flag, ac-regex-support, ac-combined-filters, ac-search-all-fields
        // Apply --search filter using regex pattern (consistent with kspec search behavior)
        if (options.search) {
          const { grepItem } = await import("../../utils/grep.js");
          observations = observations.filter((obs) => {
            const match = grepItem(
              obs as unknown as Record<string, unknown>,
              options.search,
            );
            return match !== null;
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
          () => formatObservations(observations, options.all),
        );
      } catch (err) {
        error(errors.failures.listObservations, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC-obs-3, AC-obs-6, AC-obs-8: kspec meta promote
  markMutating(meta.command("promote <ref>"))
    .description("Promote observation to a task")
    .requiredOption("--title <title>", "Task title")
    .option("--priority <priority>", "Task priority (1-5)", "2")
    .option("--force", "Force promotion even if observation is resolved")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);

        // Use unified resolver - promotes only observations
        const resolved = resolveMetaRef(metaCtx, ref);

        if (!resolved) {
          error(errors.reference.observationNotFound(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        if (resolved.type !== "observation") {
          error(`Cannot promote ${resolved.type}. Only observations can be promoted to tasks.`);
          process.exit(EXIT_CODES.ERROR);
        }

        const observation = resolved.item as Observation;

        // AC-obs-6: Check if already promoted
        if (observation.promoted_to) {
          error(
            errors.conflict.observationAlreadyPromoted(observation.promoted_to),
          );
          process.exit(EXIT_CODES.CONFLICT);
        }

        // AC-obs-8: Check if resolved
        if (observation.resolved && !options.force) {
          error(errors.operation.cannotPromoteResolved);
          process.exit(EXIT_CODES.ERROR);
        }

        // Validate priority
        const priorityResult = parseIntOption(options.priority, {
          min: 1,
          max: 5,
          name: "Priority",
        });
        if (!priorityResult.ok) {
          error(priorityResult.error);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC-obs-3: Create task with title, description from observation, meta_ref, and origin
        const task = createTask({
          title: options.title,
          description: observation.content,
          priority: priorityResult.value,
          meta_ref: observation.workflow_ref,
          origin: "observation_promotion",
        });

        // Save task
        await saveTask(ctx, task);
        await commitIfShadow(
          ctx.shadow,
          "task-add",
          task.slugs[0] || task._ulid.slice(0, 8),
          task.title,
        );
        const taskRef = `@${task._ulid.substring(0, 8)}`;

        // Update observation with promoted_to field
        observation.promoted_to = taskRef;
        await saveObservation(ctx, observation);

        // AC: @trait-shadow-commit ac-1
        await commitIfShadow(
          ctx.shadow,
          "observation-promote",
          observation._ulid.substring(0, 8),
        );

        // AC-obs-3: outputs "OK Created task: <ULID-prefix>"
        // In JSON mode, return the created task object
        output(task, () => success(`Created task: ${taskRef.substring(0, 9)}`));
      } catch (err) {
        error(errors.failures.promoteObservation, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC-obs-4, AC-obs-7, AC-obs-9: kspec meta resolve
  // AC: @trait-multi-ref-batch - Batch support with --refs flag
  markMutating(meta.command("resolve [ref] [resolution]"))
    .description("Resolve an observation (or multiple with --refs)")
    .option("--refs <refs...>", "Resolve multiple observations by ref")
    .option(
      "--resolution <text>",
      "Resolution text (required for batch mode unless observations have promoted tasks)",
    )
    .addHelpText(
      "after",
      `
Examples:
  $ kspec meta resolve @obs-ref "Fixed in PR #123"
  $ kspec meta resolve --refs @obs1 @obs2 --resolution "Resolved in batch"`,
    )
    .action(
      async (
        ref: string | undefined,
        resolutionArg: string | undefined,
        options,
      ) => {
        try {
          const ctx = await initContext();

          if (!ctx.manifestPath) {
            error(errors.project.noKspecProject);
            process.exit(EXIT_CODES.ERROR);
          }

          const metaCtx = await loadMetaContext(ctx);
          const observations = metaCtx.observations || [];

          // Load tasks/items for auto-resolution from promoted tasks
          const tasks = await loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const index = new ReferenceIndex(tasks, items);

          // Resolution can come from positional arg or --resolution flag
          const resolution = resolutionArg || options.resolution;

          // AC: @trait-multi-ref-batch ac-8 - Deduplicate refs
          const refsFlag = options.refs
            ? [...new Set(options.refs as string[])]
            : undefined;

          // AC: @trait-multi-ref-batch ac-1, ac-2, ac-3, ac-4, ac-5
          const result = await executeBatchOperation({
            positionalRef: ref,
            refsFlag,
            context: { ctx, observations, tasks, items, index, resolution },
            items: observations,
            index: index,
            resolveRef: (refStr, obsList) => {
              return resolveObservationRefForBatch(
                refStr,
                obsList as Observation[],
              );
            },
            executeOperation: async (
              observation: Observation,
              { ctx, tasks, items, index, resolution },
            ) => {
              // AC-obs-7: Check if already resolved
              if (observation.resolved) {
                const resolvedDate = new Date(observation.resolved_at!)
                  .toISOString()
                  .split("T")[0];
                const resolutionText = observation.resolution || "";
                const truncated =
                  resolutionText.length > 50
                    ? `${resolutionText.substring(0, 50)}...`
                    : resolutionText;
                return {
                  success: false,
                  error: `Already resolved on ${resolvedDate}: ${truncated}`,
                };
              }

              // AC-obs-9: Auto-populate resolution from task completion if promoted
              let finalResolution = resolution;
              if (!finalResolution && observation.promoted_to) {
                const taskResult = index.resolve(observation.promoted_to);

                if (taskResult.ok) {
                  const item = taskResult.item;
                  // Type guard: ensure this is a task
                  if ("status" in item && "depends_on" in item) {
                    const task = item as LoadedTask;
                    if (task.status === "completed" && task.closed_reason) {
                      finalResolution = `Resolved via task ${observation.promoted_to}: ${task.closed_reason}`;
                    } else if (task.status === "completed") {
                      finalResolution = `Resolved via task ${observation.promoted_to}`;
                    } else {
                      return {
                        success: false,
                        error: `Task ${observation.promoted_to} is not completed yet`,
                      };
                    }
                  } else {
                    return {
                      success: false,
                      error: `Reference ${observation.promoted_to} is not a task`,
                    };
                  }
                } else {
                  return {
                    success: false,
                    error: `Task ${observation.promoted_to} not found`,
                  };
                }
              }

              if (!finalResolution) {
                return {
                  success: false,
                  error: "Resolution text required",
                };
              }

              // AC-obs-4: Update observation
              observation.resolved = true;
              observation.resolution = finalResolution;
              observation.resolved_at = new Date().toISOString();
              observation.resolved_by = observation.author;

              await saveObservation(ctx, observation);

              // AC: @trait-shadow-commit ac-1
              await commitIfShadow(
                ctx.shadow,
                "observation-resolve",
                observation._ulid.substring(0, 8),
              );

              return {
                success: true,
                message: `Resolved: ${observation._ulid.substring(0, 8)}`,
              };
            },
            getUlid: (obs: Observation) => obs._ulid,
          });

          // AC: @trait-multi-ref-batch ac-5, ac-7 - Output formatting
          formatBatchOutput(result, "Resolve");
        } catch (err) {
          error(errors.failures.resolveObservation, err);
          process.exit(EXIT_CODES.ERROR);
        }
      },
    );

  // Meta add command - create new meta items
  markMutating(meta.command("add <type>"))
    .description("Create a new meta item (agent, workflow, or convention)")
    .option("--id <id>", "Semantic ID (required for agents and workflows)")
    .option("--domain <domain>", "Domain (required for conventions)")
    .option("--name <name>", "Name (for agents)")
    .option("--trigger <trigger>", "Trigger (for workflows)")
    .option("--description <desc>", "Description")
    .option("--capability <cap...>", "Capabilities (for agents)")
    .option("--tool <tool...>", "Tools (for agents)")
    .option("--convention <conv...>", "Convention references (for agents)")
    .option("--rule <rule...>", "Rules (for conventions)")
    .option("--steps <json>", "Workflow steps as JSON array (for workflows)")
    .option(
      "--mode <mode>",
      "Workflow mode: interactive (default) or loop (for workflows)",
    )
    .option("--based-on <ref>", "Base workflow reference (for loop workflows)")
    .option("--tag <tag...>", "Tags for the workflow (for workflows)")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec meta add agent --id my-agent --name "My Agent" --capability search code
  $ kspec meta add convention --domain testing --rule "Always test" --rule "Use mocks"
  $ kspec meta add workflow --id my-flow --trigger manual --tag automation ci`,
    )
    .action(async (type: string, options) => {
      try {
        const ctx = await initContext();

        // Validate type
        const validTypes = ["agent", "workflow", "convention"];
        if (!validTypes.includes(type)) {
          error(errors.validation.invalidType(type, validTypes));
          process.exit(EXIT_CODES.ERROR);
        }

        // Generate ULID
        const itemUlid = ulid();

        // Create the item based on type
        let item: Agent | Workflow | Convention;

        if (type === "agent") {
          // Validate required fields
          if (!options.id) {
            error(errors.validation.agentRequiresId);
            process.exit(EXIT_CODES.ERROR);
          }
          if (!options.name) {
            error(errors.validation.agentRequiresName);
            process.exit(EXIT_CODES.ERROR);
          }

          item = {
            _ulid: itemUlid,
            id: options.id,
            name: options.name,
            description: options.description || "",
            capabilities: options.capability || [],
            tools: options.tool || [],
            conventions: options.convention || [],
          };
        } else if (type === "workflow") {
          // Validate required fields
          if (!options.id) {
            error(errors.validation.workflowRequiresId);
            process.exit(EXIT_CODES.ERROR);
          }
          if (!options.trigger) {
            error(errors.validation.workflowRequiresTrigger);
            process.exit(EXIT_CODES.ERROR);
          }

          // Parse and validate --steps if provided
          let steps: WorkflowStep[] = [];
          if (options.steps) {
            // AC: @meta-add-cmd ac-2 - Parse JSON
            let parsedSteps: unknown;
            try {
              parsedSteps = JSON.parse(options.steps);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              error(errors.validation.invalidStepsJson(message));
              process.exit(EXIT_CODES.ERROR);
            }

            // AC: @meta-add-cmd ac-3 - Verify it's an array
            if (!Array.isArray(parsedSteps)) {
              error(errors.validation.stepsNotArray);
              process.exit(EXIT_CODES.ERROR);
            }

            // AC: @meta-add-cmd ac-4 - Validate with schema
            const result = z.array(WorkflowStepSchema).safeParse(parsedSteps);
            if (!result.success) {
              const issues = result.error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ");
              error(errors.validation.invalidStepsSchema(issues));
              process.exit(EXIT_CODES.ERROR);
            }
            steps = result.data;
          }

          // Validate mode if provided
          const validModes = ["interactive", "loop"];
          if (options.mode && !validModes.includes(options.mode)) {
            error(
              `Invalid mode: ${options.mode}. Valid modes: ${validModes.join(", ")}`,
            );
            process.exit(EXIT_CODES.ERROR);
          }

          item = {
            _ulid: itemUlid,
            id: options.id,
            trigger: options.trigger,
            description: options.description || "",
            steps,
            ...(options.mode && { mode: options.mode }),
            ...(options.basedOn && { based_on: options.basedOn }),
            ...(options.tag && options.tag.length > 0 && { tags: parseTagsArray(options.tag) }),
          };
        } else {
          // convention
          if (!options.domain) {
            error(errors.validation.conventionRequiresDomain);
            process.exit(EXIT_CODES.ERROR);
          }

          item = {
            _ulid: itemUlid,
            domain: options.domain,
            rules: options.rule || [],
            examples: [],
          };
        }

        // Save the item
        await saveMetaItem(
          ctx,
          item,
          type as "agent" | "workflow" | "convention",
        );

        // AC: @trait-shadow-commit ac-1
        await commitIfShadow(
          ctx.shadow,
          `meta-add-${type}`,
          itemUlid.substring(0, 8),
          "id" in item ? item.id : "domain" in item ? item.domain : undefined,
        );

        if (isJsonMode()) {
          // In JSON mode, output the item data directly
          console.log(JSON.stringify(item, null, 2));
        } else {
          const idOrDomain =
            "id" in item ? item.id : "domain" in item ? item.domain : itemUlid;
          success(
            `Created ${type}: ${idOrDomain} (@${itemUlid.substring(0, 8)})`,
          );
        }
      } catch (err) {
        error(errors.failures.createMeta(type), err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // Meta set command - update existing meta items
  markMutating(meta.command("set <ref>"))
    .description("Update an existing meta item")
    .option("--name <name>", "Update name (for agents)")
    .option("--description <desc>", "Update description")
    .option("--trigger <trigger>", "Update trigger (for workflows)")
    .option("--add-capability <cap>", "Add capability (for agents)")
    .option("--add-tool <tool>", "Add tool (for agents)")
    .option("--add-convention <conv>", "Add convention reference (for agents)")
    .option("--add-rule <rule>", "Add rule (for conventions)")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const metaCtx = await loadMetaContext(ctx);

        // Use unified resolver
        const resolved = resolveMetaRef(metaCtx, ref);

        if (!resolved) {
          error(errors.reference.metaNotFound(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        // meta set only supports agent, workflow, convention
        // Skills have their own `kspec skill set` command
        const { item, type: itemType } = resolved;
        if (itemType !== "agent" && itemType !== "workflow" && itemType !== "convention") {
          error(`Cannot use 'meta set' with ${itemType}. Use 'kspec ${itemType === "skill" ? "skill" : "meta"} ${itemType === "observation" ? "resolve" : "set"} ${ref}' instead.`);
          process.exit(EXIT_CODES.ERROR);
        }

        const found = item as Agent | Workflow | Convention;

        // Update fields based on type
        if (itemType === "agent") {
          const item = found as Agent;
          if (options.name) item.name = options.name;
          if (options.description !== undefined)
            item.description = options.description;
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
        } else if (itemType === "workflow") {
          const item = found as Workflow;
          if (options.trigger) item.trigger = options.trigger;
          if (options.description !== undefined)
            item.description = options.description;
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

        // AC: @trait-shadow-commit ac-1
        await commitIfShadow(
          ctx.shadow,
          `meta-set-${itemType}`,
          found._ulid.substring(0, 8),
        );

        if (isJsonMode()) {
          // In JSON mode, output the item data directly
          console.log(JSON.stringify(found, null, 2));
        } else {
          const idOrDomain =
            itemType === "agent"
              ? (found as Agent).id
              : itemType === "workflow"
                ? (found as Workflow).id
                : (found as Convention).domain;
          success(`Updated ${itemType}: ${idOrDomain}`);
        }
      } catch (err) {
        error(errors.failures.updateMetaItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // Meta delete command - delete meta items
  markMutating(meta.command("delete <ref>"))
    .description("Delete a meta item")
    .option("--confirm", "Skip confirmation prompt")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const metaCtx = await loadMetaContext(ctx);

        // Use unified resolver
        const resolved = resolveMetaRef(metaCtx, ref);

        if (!resolved) {
          error(errors.reference.metaNotFound(ref));
          process.exit(EXIT_CODES.ERROR);
        }

        // meta delete does not support skills - they use `kspec skill delete`
        if (resolved.type === "skill") {
          error(`Cannot use 'meta delete' with skills. Use 'kspec skill delete ${ref}' instead.`);
          process.exit(EXIT_CODES.ERROR);
        }

        const itemType = resolved.type as "agent" | "workflow" | "convention" | "observation";
        const itemUlid = resolved.ulid;

        // Build human-readable label for the item
        let itemLabel: string;
        const item = resolved.item;
        if (itemType === "agent" && "id" in item) {
          itemLabel = `agent ${item.id}`;
        } else if (itemType === "workflow" && "id" in item) {
          itemLabel = `workflow ${item.id}`;
        } else if (itemType === "convention" && "domain" in item) {
          itemLabel = `convention ${item.domain}`;
        } else {
          itemLabel = `observation ${itemUlid.substring(0, 8)}`;
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
              .join(", ");
            error(
              errors.operation.cannotDeleteReferencedByTasks(
                itemLabel,
                referencingTasks.length,
                taskRefs,
              ),
            );
            process.exit(EXIT_CODES.ERROR);
          }

          // Check observations with workflow_ref (only for workflows)
          if (itemType === "workflow") {
            const observations = metaCtx.observations || [];
            const referencingObservations = observations.filter((o) => {
              if (!o.workflow_ref) return false;
              // Resolve the observation's workflow_ref to a ULID
              const obsWorkflowRef = resolveMetaRefToUlid(
                o.workflow_ref,
                metaCtx,
              );
              // Compare ULIDs to handle both semantic IDs and ULID prefixes
              return obsWorkflowRef && obsWorkflowRef.ulid === itemUlid;
            });

            if (referencingObservations.length > 0) {
              const obsRefs = referencingObservations
                .map((o) => `@${o._ulid.substring(0, 8)}`)
                .join(", ");
              error(
                errors.operation.cannotDeleteReferencedByObservations(
                  itemLabel,
                  referencingObservations.length,
                  obsRefs,
                ),
              );
              process.exit(EXIT_CODES.ERROR);
            }
          }

          // Show confirmation prompt even if no references found
          error(errors.operation.confirmRequired(itemLabel));
          process.exit(EXIT_CODES.ERROR);
        }

        // Delete the item
        const deleted = await deleteMetaItem(ctx, itemUlid, itemType);

        if (!deleted) {
          error(errors.operation.deleteItemFailed(itemLabel));
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @trait-shadow-commit ac-1
        await commitIfShadow(
          ctx.shadow,
          `meta-delete-${itemType}`,
          itemUlid.substring(0, 8),
        );

        success(`Deleted ${itemLabel}`);
      } catch (err) {
        error(errors.failures.deleteMetaItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // meta-focus-cmd: kspec meta focus [ref]
  markMutating(meta.command("focus [ref]"))
    .description("Get or set session focus")
    .option("--clear", "Clear current focus")
    .action(async (ref: string | undefined, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const sessionCtx = await loadSessionContext(ctx);

        // Clear focus
        if (options.clear) {
          sessionCtx.focus = null;
          await saveSessionContext(ctx, sessionCtx);

          output({ focus: null }, () => success("Cleared session focus"));
          return;
        }

        // Show current focus
        if (!ref) {
          output({ focus: sessionCtx.focus }, () => {
            if (sessionCtx.focus) {
              console.log(`Current focus: ${sessionCtx.focus}`);
            } else {
              console.log(chalk.yellow("No focus set"));
            }
          });
          return;
        }

        // Set focus to ref
        sessionCtx.focus = normalizeRefInput(ref);
        await saveSessionContext(ctx, sessionCtx);

        output({ focus: sessionCtx.focus }, () =>
          success(`Set focus to: ${sessionCtx.focus}`),
        );
      } catch (err) {
        error(errors.failures.updateSessionContext, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // meta-thread-cmd: kspec meta thread <action> [text]
  markMutating(meta.command("thread <action> [text]"))
    .description("Manage active threads")
    .action(async (action: string, text: string | undefined) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const sessionCtx = await loadSessionContext(ctx);

        // List threads
        if (action === "list") {
          output({ threads: sessionCtx.threads }, () => {
            if (sessionCtx.threads.length === 0) {
              console.log(chalk.yellow("No active threads"));
            } else {
              console.log("Active threads:");
              sessionCtx.threads.forEach((thread, idx) => {
                console.log(`  ${idx + 1}. ${thread}`);
              });
            }
          });
          return;
        }

        // Clear all threads
        if (action === "clear") {
          sessionCtx.threads = [];
          await saveSessionContext(ctx, sessionCtx);

          output({ threads: [] }, () => success("Cleared all threads"));
          return;
        }

        // Add thread
        if (action === "add") {
          if (!text) {
            error("Thread text is required for add action");
            process.exit(EXIT_CODES.ERROR);
          }

          sessionCtx.threads.push(text);
          await saveSessionContext(ctx, sessionCtx);

          output({ threads: sessionCtx.threads, added: text }, () =>
            success(`Added thread: ${text}`),
          );
          return;
        }

        // Remove thread by index (1-based)
        if (action === "remove") {
          if (!text) {
            error("Index is required for remove action");
            process.exit(EXIT_CODES.ERROR);
          }

          const index = parseInt(text, 10);
          if (
            Number.isNaN(index) ||
            index < 1 ||
            index > sessionCtx.threads.length
          ) {
            error(
              `Invalid index: ${text}. Must be between 1 and ${sessionCtx.threads.length}`,
            );
            process.exit(EXIT_CODES.ERROR);
          }

          const removed = sessionCtx.threads.splice(index - 1, 1)[0];
          await saveSessionContext(ctx, sessionCtx);

          output({ threads: sessionCtx.threads, removed }, () =>
            success(`Removed thread: ${removed}`),
          );
          return;
        }

        // Unknown action
        error(`Unknown action: ${action}. Use add, remove, list, or clear`);
        process.exit(EXIT_CODES.ERROR);
      } catch (err) {
        error(errors.failures.updateSessionContext, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // meta-question-cmd: kspec meta question <action> [text]
  markMutating(meta.command("question <action> [text]"))
    .description("Manage open questions")
    .action(async (action: string, text: string | undefined) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const sessionCtx = await loadSessionContext(ctx);

        // List questions
        if (action === "list") {
          output({ questions: sessionCtx.open_questions }, () => {
            if (sessionCtx.open_questions.length === 0) {
              console.log(chalk.yellow("No open questions"));
            } else {
              console.log("Open questions:");
              sessionCtx.open_questions.forEach((question, idx) => {
                console.log(`  ${idx + 1}. ${question}`);
              });
            }
          });
          return;
        }

        // Clear all questions
        if (action === "clear") {
          sessionCtx.open_questions = [];
          await saveSessionContext(ctx, sessionCtx);

          output({ questions: [] }, () => success("Cleared all questions"));
          return;
        }

        // Add question
        if (action === "add") {
          if (!text) {
            error("Question text is required for add action");
            process.exit(EXIT_CODES.ERROR);
          }

          sessionCtx.open_questions.push(text);
          await saveSessionContext(ctx, sessionCtx);

          output({ questions: sessionCtx.open_questions, added: text }, () =>
            success(`Added question: ${text}`),
          );
          return;
        }

        // Remove question by index (1-based)
        if (action === "remove") {
          if (!text) {
            error("Index is required for remove action");
            process.exit(EXIT_CODES.ERROR);
          }

          const index = parseInt(text, 10);
          if (
            Number.isNaN(index) ||
            index < 1 ||
            index > sessionCtx.open_questions.length
          ) {
            error(
              `Invalid index: ${text}. Must be between 1 and ${sessionCtx.open_questions.length}`,
            );
            process.exit(EXIT_CODES.ERROR);
          }

          const removed = sessionCtx.open_questions.splice(index - 1, 1)[0];
          await saveSessionContext(ctx, sessionCtx);

          output({ questions: sessionCtx.open_questions, removed }, () =>
            success(`Removed question: ${removed}`),
          );
          return;
        }

        // Unknown action
        error(`Unknown action: ${action}. Use add, remove, list, or clear`);
        process.exit(EXIT_CODES.ERROR);
      } catch (err) {
        error(errors.failures.updateSessionContext, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // meta-context-cmd: kspec meta context
  meta
    .command("context")
    .description("Show full session context")
    .option("--clear", "Clear all session context")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const sessionCtx = await loadSessionContext(ctx);

        // Clear all context
        if (options.clear) {
          sessionCtx.focus = null;
          sessionCtx.threads = [];
          sessionCtx.open_questions = [];
          await saveSessionContext(ctx, sessionCtx);

          output(
            {
              focus: null,
              threads: [],
              open_questions: [],
              updated_at: sessionCtx.updated_at,
            },
            () => success("Cleared all session context"),
          );
          return;
        }

        // Show full session context
        output(
          {
            focus: sessionCtx.focus,
            threads: sessionCtx.threads,
            open_questions: sessionCtx.open_questions,
            updated_at: sessionCtx.updated_at,
          },
          () => {
            console.log(chalk.bold("Session Context"));
            console.log(chalk.gray("─".repeat(60)));

            // Focus
            console.log(chalk.bold("\nFocus:"));
            if (sessionCtx.focus) {
              console.log(`  ${sessionCtx.focus}`);
            } else {
              console.log(chalk.gray("  (none)"));
            }

            // Active threads
            console.log(chalk.bold("\nActive Threads:"));
            if (sessionCtx.threads.length > 0) {
              sessionCtx.threads.forEach((thread, idx) => {
                console.log(`  ${idx + 1}. ${thread}`);
              });
            } else {
              console.log(chalk.gray("  (none)"));
            }

            // Open questions
            console.log(chalk.bold("\nOpen Questions:"));
            if (sessionCtx.open_questions.length > 0) {
              sessionCtx.open_questions.forEach((question, idx) => {
                console.log(`  ${idx + 1}. ${question}`);
              });
            } else {
              console.log(chalk.gray("  (none)"));
            }

            // Last updated
            console.log(chalk.bold("\nLast Updated:"));
            const updatedDate = new Date(sessionCtx.updated_at);
            console.log(`  ${updatedDate.toISOString()}`);
            console.log(chalk.gray(`  (${updatedDate.toLocaleString()})`));
          },
        );
      } catch (err) {
        error(errors.failures.updateSessionContext, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
