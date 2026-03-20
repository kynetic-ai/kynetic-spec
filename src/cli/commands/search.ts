import chalk from "chalk";
import type { Command } from "commander";
import {
  buildIndexes,
  initContext,
  loadInboxItems,
  loadMetaContext,
  shortestUniqueUlid,
} from "../../parser/index.js";
import type {
  LoadedAgent,
  LoadedConvention,
  LoadedObservation,
  LoadedWorkflow,
} from "../../parser/meta.js";
import type {
  LoadedInboxItem,
  LoadedSpecItem,
  LoadedTask,
} from "../../parser/yaml.js";
import { ItemTypeSchema, TaskStatusSchema } from "../../schema/index.js";
import { errors } from "../../strings/index.js";
import { formatMatchedFields, grepItem } from "../../utils/grep.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output } from "../output.js";
import { validateEnumOption } from "../validators.js";

/**
 * Format a spec item for search results
 */
function formatSearchItem(
  item: LoadedSpecItem,
  matchedFields: string[],
  shortId: string,
): void {
  const slugStr = item.slugs.length > 0 ? chalk.cyan(`@${item.slugs[0]}`) : "";
  const typeStr = chalk.gray(`[${item.type}]`);

  let status = "";
  if (item.status && typeof item.status === "object") {
    const s = item.status as { maturity?: string; implementation?: string };
    if (s.implementation) {
      const implColor =
        s.implementation === "verified"
          ? chalk.green
          : s.implementation === "implemented"
            ? chalk.cyan
            : s.implementation === "in_progress"
              ? chalk.yellow
              : chalk.gray;
      status = implColor(s.implementation);
    }
  }

  let line = `${chalk.gray(shortId)} ${typeStr} ${item.title}`;
  if (slugStr) line += ` ${slugStr}`;
  if (status) line += ` ${status}`;

  console.log(line);
  console.log(chalk.gray(`  matched: ${formatMatchedFields(matchedFields)}`));
}

/**
 * Format a task for search results
 */
function formatSearchTask(
  task: LoadedTask,
  matchedFields: string[],
  shortId: string,
): void {
  const slugStr = task.slugs.length > 0 ? chalk.cyan(`@${task.slugs[0]}`) : "";

  const statusColor =
    task.status === "completed"
      ? chalk.green
      : task.status === "in_progress"
        ? chalk.blue
        : task.status === "blocked"
          ? chalk.red
          : chalk.gray;

  const priority =
    task.priority <= 2
      ? chalk.red(`P${task.priority}`)
      : chalk.gray(`P${task.priority}`);

  let line = `${chalk.gray(shortId)} ${statusColor(`[${task.status}]`)} ${priority} ${task.title}`;
  if (slugStr) line += ` ${slugStr}`;

  console.log(line);
  console.log(chalk.gray(`  matched: ${formatMatchedFields(matchedFields)}`));
}

/**
 * Format an inbox item for search results
 */
function formatSearchInbox(
  item: LoadedInboxItem,
  matchedFields: string[],
  shortId: string,
): void {
  const typeStr = chalk.gray("[inbox]");

  // Truncate text if too long
  const displayText =
    item.text.length > 60 ? `${item.text.substring(0, 57)}...` : item.text;

  const line = `${chalk.gray(shortId)} ${typeStr} ${displayText}`;

  console.log(line);
  console.log(chalk.gray(`  matched: ${formatMatchedFields(matchedFields)}`));
}

/**
 * Format a meta entity for search results
 */
function formatSearchMeta(
  entity: LoadedObservation | LoadedAgent | LoadedWorkflow | LoadedConvention,
  entityType: "observation" | "agent" | "workflow" | "convention",
  matchedFields: string[],
  shortId: string,
): void {
  const typeStr = chalk.gray(`[${entityType}]`);

  let displayText = "";
  if (entityType === "observation") {
    const obs = entity as LoadedObservation;
    displayText =
      obs.content.length > 60
        ? `${obs.content.substring(0, 57)}...`
        : obs.content;
  } else if (entityType === "agent") {
    const agent = entity as LoadedAgent;
    displayText = `${agent.id} - ${agent.name}`;
  } else if (entityType === "workflow") {
    const workflow = entity as LoadedWorkflow;
    displayText = `${workflow.id}${workflow.description ? ` - ${workflow.description}` : ""}`;
  } else if (entityType === "convention") {
    const convention = entity as LoadedConvention;
    const rulePreview = convention.rules.length > 0 ? ` - ${convention.rules[0]}` : "";
    displayText = `${convention.domain}${rulePreview}`;
  }

  const line = `${chalk.gray(shortId)} ${typeStr} ${displayText}`;

  console.log(line);
  console.log(chalk.gray(`  matched: ${formatMatchedFields(matchedFields)}`));
}

interface SearchResult {
  type: "item" | "task" | "inbox" | "observation" | "agent" | "workflow" | "convention";
  item: LoadedSpecItem | LoadedTask | LoadedInboxItem | LoadedObservation | LoadedAgent | LoadedWorkflow | LoadedConvention;
  matchedFields: string[];
}

/**
 * Register the search command
 */
export function registerSearchCommand(program: Command): void {
  program
    .command("search <pattern>")
    .description("Search across items, tasks, inbox, and meta entities with regex pattern")
    .option("-t, --type <type>", "Filter by item type")
    .option("-s, --status <status>", "Filter by task status")
    .option("--items-only", "Search only spec items")
    .option("--tasks-only", "Search only tasks")
    .option("--observations-only", "Search only observations")
    .option("--limit <n>", "Limit results", "50")
    .action(async (pattern, options) => {
      try {
        // AC: @observation-content-search ac-only-flags-exclusive
        // Check mutual exclusivity of scope-only flags
        const scopeFlags = [
          options.itemsOnly && "--items-only",
          options.tasksOnly && "--tasks-only",
          options.observationsOnly && "--observations-only",
        ].filter(Boolean);

        if (scopeFlags.length > 1) {
          error(`Flags ${scopeFlags.join(", ")} are mutually exclusive. Use only one at a time.`);
          process.exit(EXIT_CODES.ERROR);
        }

        const ctx = await initContext();
        const { itemIndex, tasks, items, refIndex } = await buildIndexes(ctx);

        const results: SearchResult[] = [];
        const limit = parseInt(options.limit, 10) || 50;
        let inboxUlids: string[] = [];
        let metaUlids: string[] = [];

        if (options.type) {
          const typeResult = validateEnumOption(
            options.type,
            ItemTypeSchema.options,
            "item type",
          );
          if (!typeResult.ok) {
            error(typeResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        if (options.status) {
          const statusResult = validateEnumOption(
            options.status,
            TaskStatusSchema.options,
            "task status",
          );
          if (!statusResult.ok) {
            error(statusResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        // Search spec items
        // AC: @observation-content-search ac-global-search-filter - skip items when --observations-only
        if (!options.tasksOnly && !options.observationsOnly) {
          for (const item of items) {
            // Apply type filter
            if (options.type && item.type !== options.type) continue;

            const match = grepItem(
              item as unknown as Record<string, unknown>,
              pattern,
            );
            if (match) {
              results.push({
                type: "item",
                item,
                matchedFields: match.matchedFields,
              });
            }
          }
        }

        // Search tasks
        // AC: @observation-content-search ac-global-search-filter - skip tasks when --observations-only
        if (!options.itemsOnly && !options.observationsOnly) {
          for (const task of tasks) {
            // Apply status filter
            if (options.status && task.status !== options.status) continue;

            const match = grepItem(
              task as unknown as Record<string, unknown>,
              pattern,
            );
            if (match) {
              results.push({
                type: "task",
                item: task,
                matchedFields: match.matchedFields,
              });
            }
          }
        }

        // Search inbox items (AC-7)
        // AC: @observation-content-search ac-global-search-filter - skip inbox when --observations-only
        if (!options.itemsOnly && !options.tasksOnly && !options.observationsOnly) {
          const inboxItems = await loadInboxItems(ctx);
          inboxUlids = inboxItems.map((inboxItem) => inboxItem._ulid);
          for (const inboxItem of inboxItems) {
            const match = grepItem(
              inboxItem as unknown as Record<string, unknown>,
              pattern,
            );
            if (match) {
              results.push({
                type: "inbox",
                item: inboxItem,
                matchedFields: match.matchedFields,
              });
            }
          }
        }

        // Search meta entities (AC-7)
        // AC: @observation-content-search ac-global-search-filter - handle --observations-only
        if (!options.itemsOnly && !options.tasksOnly) {
          const metaCtx = await loadMetaContext(ctx);
          metaUlids = [
            ...metaCtx.observations.map((observation) => observation._ulid),
            ...metaCtx.agents.map((agent) => agent._ulid),
            ...metaCtx.workflows.map((workflow) => workflow._ulid),
            ...metaCtx.conventions.map((convention) => convention._ulid),
          ];

          // Search observations (always when not --items-only or --tasks-only)
          for (const observation of metaCtx.observations) {
            const match = grepItem(
              observation as unknown as Record<string, unknown>,
              pattern,
            );
            if (match) {
              results.push({
                type: "observation",
                item: observation,
                matchedFields: match.matchedFields,
              });
            }
          }

          // Skip other meta entities when --observations-only
          if (!options.observationsOnly) {
            // Search agents
            for (const agent of metaCtx.agents) {
              const match = grepItem(
                agent as unknown as Record<string, unknown>,
                pattern,
              );
              if (match) {
                results.push({
                  type: "agent",
                  item: agent,
                  matchedFields: match.matchedFields,
                });
              }
            }

            // Search workflows
            for (const workflow of metaCtx.workflows) {
              const match = grepItem(
                workflow as unknown as Record<string, unknown>,
                pattern,
              );
              if (match) {
                results.push({
                  type: "workflow",
                  item: workflow,
                  matchedFields: match.matchedFields,
                });
              }
            }

            // Search conventions
            for (const convention of metaCtx.conventions) {
              const match = grepItem(
                convention as unknown as Record<string, unknown>,
                pattern,
              );
              if (match) {
                results.push({
                  type: "convention",
                  item: convention,
                  matchedFields: match.matchedFields,
                });
              }
            }
          }
        }

        // Limit results
        const limitedResults = results.slice(0, limit);

        output(
          {
            pattern,
            results: limitedResults.map((r) => {
              // Get title/display text based on entity type
              let title = "";
              if (r.type === "item" || r.type === "task") {
                title = (r.item as LoadedSpecItem | LoadedTask).title;
              } else if (r.type === "inbox") {
                title = (r.item as LoadedInboxItem).text;
              } else if (r.type === "observation") {
                title = (r.item as LoadedObservation).content;
              } else if (r.type === "agent") {
                const agent = r.item as LoadedAgent;
                title = `${agent.id} - ${agent.name}`;
              } else if (r.type === "workflow") {
                const workflow = r.item as LoadedWorkflow;
                title = workflow.id;
              } else if (r.type === "convention") {
                title = (r.item as LoadedConvention).domain;
              }

              return {
                type: r.type,
                ulid: r.item._ulid,
                title,
                matchedFields: r.matchedFields,
              };
            }),
            total: results.length,
            showing: limitedResults.length,
          },
          () => {
            if (limitedResults.length === 0) {
              console.log(chalk.gray(`No matches found for "${pattern}"`));
              return;
            }

            for (const result of limitedResults) {
              if (result.type === "item") {
                formatSearchItem(
                  result.item as LoadedSpecItem,
                  result.matchedFields,
                  refIndex.shortUlid((result.item as LoadedSpecItem)._ulid),
                );
              } else if (result.type === "task") {
                formatSearchTask(
                  result.item as LoadedTask,
                  result.matchedFields,
                  refIndex.shortUlid((result.item as LoadedTask)._ulid),
                );
              } else if (result.type === "inbox") {
                formatSearchInbox(
                  result.item as LoadedInboxItem,
                  result.matchedFields,
                  shortestUniqueUlid(
                    (result.item as LoadedInboxItem)._ulid,
                    inboxUlids.length > 0
                      ? inboxUlids
                      : [(result.item as LoadedInboxItem)._ulid],
                  ),
                );
              } else if (result.type === "observation" || result.type === "agent" || result.type === "workflow" || result.type === "convention") {
                formatSearchMeta(
                  result.item as LoadedObservation | LoadedAgent | LoadedWorkflow | LoadedConvention,
                  result.type,
                  result.matchedFields,
                  shortestUniqueUlid(
                    (
                      result.item as LoadedObservation | LoadedAgent | LoadedWorkflow | LoadedConvention
                    )._ulid,
                    metaUlids.length > 0
                      ? metaUlids
                      : [(
                        result.item as LoadedObservation | LoadedAgent | LoadedWorkflow | LoadedConvention
                      )._ulid],
                  ),
                );
              }
            }

            console.log(
              chalk.gray(
                `\n${limitedResults.length} result(s)${results.length > limit ? ` (showing first ${limit})` : ""}`,
              ),
            );
          },
        );
      } catch (err) {
        error(errors.failures.search, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
