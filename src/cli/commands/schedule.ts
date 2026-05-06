/**
 * Schedule CLI commands: list, add, set, enable, disable, remove, trigger
 *
 * AC: @dispatch-event-cli ac-2 — schedule list shows name, cron, next tick, enabled status
 * AC: @dispatch-event-cli ac-3 — schedule trigger executes immediately with overlap policy
 */

import chalk from "chalk";
import Table from "cli-table3";
import type { Command } from "commander";
import { ulid } from "ulid";
import {
  initContext,
  loadMetaContext,
  saveSchedule,
  deleteSchedule,
  resolveScheduleRef,
  type LoadedSchedule,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { ScheduleSchema } from "../../schema/schedules.js";
import { ACTION_TYPES } from "../../schema/action.js";
import { markMutating } from "../command-annotations.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, isStructuredMode, output, success } from "../output.js";
import { PidFileManager, resolveDaemonClientEndpoint } from "../pid-utils.js";
import { errors } from "../../strings/errors.js";
import { validateEnumOption } from "../validators.js";

const SCHEDULE_STATUS_OPTIONS = ["enabled", "disabled"] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get the daemon URL from the resolved client endpoint.
 * Returns null if the daemon is not running.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 */
function getDaemonUrl(): { url: string; port: number } | null {
  const pidManager = new PidFileManager();
  if (!pidManager.isDaemonRunning()) return null;
  const endpoint = resolveDaemonClientEndpoint();
  if (!endpoint) return null;
  return { url: endpoint.apiUrl, port: endpoint.port };
}

/**
 * Build an action object from CLI options.
 */
function buildActionFromOptions(options: {
  actionType: string;
  command?: string;
  args?: string[];
  timeoutMs?: string;
  agentId?: string;
  prompt?: string;
  message?: string;
  topic?: string;
}): Record<string, unknown> | null {
  switch (options.actionType) {
    case "command":
      if (!options.command) return null;
      return {
        type: "command",
        command: options.command,
        ...(options.args && options.args.length > 0 && { args: options.args }),
        ...(options.timeoutMs && { timeout_ms: Number(options.timeoutMs) }),
      };
    case "kspec":
      if (!options.command) return null;
      return {
        type: "kspec",
        command: options.command,
        ...(options.timeoutMs && { timeout_ms: Number(options.timeoutMs) }),
      };
    case "agent":
      if (!options.agentId) return null;
      return {
        type: "agent",
        agent_id: options.agentId,
        ...(options.prompt && { prompt: options.prompt }),
      };
    case "notify":
      if (!options.message) return null;
      return {
        type: "notify",
        message: options.message,
        ...(options.topic && { topic: options.topic }),
      };
    default:
      return null;
  }
}

// ─── Formatters ──────────────────────────────────────────────────────────────

interface ScheduleListItem {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  overlap_policy: string;
  next_tick: string | null;
  last_tick: string | null;
  run_count: number;
  active_run_count: number;
}

/**
 * Format schedules as a table
 * AC: @dispatch-event-cli ac-2 — name, cron, next tick, enabled status
 */
function formatSchedulesTable(schedules: ScheduleListItem[]): void {
  if (schedules.length === 0) {
    console.log(chalk.yellow("No schedules defined"));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold("ID"),
      chalk.bold("Name"),
      chalk.bold("Cron"),
      chalk.bold("Next Tick"),
      chalk.bold("Enabled"),
      chalk.bold("Overlap"),
    ],
    style: { head: [], border: [] },
  });

  for (const s of schedules) {
    table.push([
      s.id,
      s.name,
      s.cron,
      s.next_tick ?? chalk.gray("(unknown)"),
      s.enabled ? chalk.green("yes") : chalk.red("no"),
      s.overlap_policy,
    ]);
  }

  console.log(table.toString());
}

/**
 * Format a single schedule's details.
 */
function formatScheduleDetails(schedule: LoadedSchedule): void {
  console.log(chalk.bold(schedule.name));
  console.log(chalk.gray("─".repeat(40)));
  console.log(`ID:             ${schedule.id}`);
  console.log(`ULID:           ${schedule._ulid}`);
  console.log(`Cron:           ${schedule.cron}`);
  console.log(`Timezone:       ${schedule.timezone}`);
  console.log(`Overlap policy: ${schedule.overlap_policy}`);
  console.log(`Backfill:       ${schedule.backfill}`);
  console.log(`Enabled:        ${schedule.enabled ? chalk.green("yes") : chalk.red("no")}`);
  console.log(`Action type:    ${schedule.action.type}`);
}

// ─── Command Registration ────────────────────────────────────────────────────

export function registerScheduleCommands(program: Command): void {
  const schedule = program.command("schedule").description("Manage scheduled actions");

  // ── schedule list ──────────────────────────────────────────────────────────

  // AC: @dispatch-event-cli ac-2
  // AC: @trait-filterable-list ac-1 through ac-8
  // AC: @trait-json-output ac-1, ac-2
  // AC: @trait-semantic-exit-codes ac-1, ac-5
  schedule
    .command("list")
    .description("List all schedules")
    .option("--status <status>", "Filter by enabled status (enabled, disabled)")
    .option("--tag <tag>", "Filter by tag (reserved for future use)")
    .option("--limit <n>", "Limit number of results")
    .option("--offset <n>", "Skip first N results")
    .option("--count", "Output only the total count")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        let schedules: ScheduleListItem[] = metaCtx.schedules.map((s) => ({
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          cron: s.cron,
          timezone: s.timezone,
          overlap_policy: s.overlap_policy,
          next_tick: null,
          last_tick: null,
          run_count: 0,
          active_run_count: 0,
        }));

        // Try to enrich with runtime data from daemon
        const daemonConn = getDaemonUrl();
        if (daemonConn) {
          try {
            const headers: Record<string, string> = {};
            if (ctx.projectRoot) {
              headers["X-Kspec-Dir"] = ctx.projectRoot;
            }
            const response = await fetch(`${daemonConn.url}/api/schedules`, { headers });
            if (response.ok) {
              const data = (await response.json()) as {
                items: ScheduleListItem[];
              };
              // Replace with daemon data which includes runtime state
              schedules = data.items;
            }
          } catch {
            // Daemon unreachable; fall back to config-only
          }
        }

        // AC: @trait-filterable-list ac-1 — filter by status (enabled/disabled)
        if (options.status) {
          const statusResult = validateEnumOption(
            options.status,
            SCHEDULE_STATUS_OPTIONS,
            "schedule status",
          );
          if (!statusResult.ok) {
            error(statusResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          const isEnabled = statusResult.value === "enabled";
          schedules = schedules.filter((s) => s.enabled === isEnabled);
        }

        const total = schedules.length;

        // AC: @trait-filterable-list ac-8 — count mode
        if (options.count) {
          output({ count: total }, () => console.log(String(total)));
          return;
        }

        // AC: @trait-filterable-list ac-3, ac-4 — pagination
        const offset = options.offset ? Number(options.offset) : 0;
        const limit = options.limit ? Number(options.limit) : schedules.length;

        if (options.limit && (Number.isNaN(limit) || limit < 0)) {
          error(`Invalid --limit value: ${options.limit}`, {
            hint: "--limit must be a non-negative integer",
          });
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }
        if (options.offset && (Number.isNaN(offset) || offset < 0)) {
          error(`Invalid --offset value: ${options.offset}`, {
            hint: "--offset must be a non-negative integer",
          });
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const paginated = schedules.slice(offset, offset + limit);

        // AC: @trait-json-output ac-1, ac-2 — JSON includes all data
        output({ items: paginated, total, offset, limit }, () => {
          formatSchedulesTable(paginated);
          // AC: @trait-filterable-list ac-7 — summary with total and filter state
          const filterParts: string[] = [];
          if (options.status) filterParts.push(`status=${options.status}`);
          const filterDesc = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";
          console.log(chalk.gray(`\n${paginated.length} of ${total} schedule(s)${filterDesc}`));
        });
      } catch (err) {
        error("Failed to list schedules", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ── schedule get ───────────────────────────────────────────────────────────

  schedule
    .command("get <ref>")
    .description("Show schedule details")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const found = resolveScheduleRef(metaCtx, ref);

        if (!found) {
          // AC: @trait-error-guidance ac-1, ac-2, ac-3
          error(`Schedule not found: ${ref}`, {
            hint: "Check available schedules with: kspec schedule list",
          });
          if (!isStructuredMode()) console.log(chalk.gray("Try: kspec schedule list"));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        output(
          {
            _ulid: found._ulid,
            id: found.id,
            name: found.name,
            cron: found.cron,
            timezone: found.timezone,
            overlap_policy: found.overlap_policy,
            backfill: found.backfill,
            enabled: found.enabled,
            action: found.action,
          },
          () => formatScheduleDetails(found),
        );
      } catch (err) {
        error("Failed to get schedule", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ── schedule add ───────────────────────────────────────────────────────────

  // AC: @trait-shadow-commit ac-1
  markMutating(schedule.command("add"))
    .description("Create a new schedule")
    .requiredOption("--id <id>", "Schedule ID (machine-readable)")
    .requiredOption("--name <name>", "Schedule name (human-readable)")
    .requiredOption("--cron <expr>", "Cron expression (5-field)")
    .requiredOption("--action-type <type>", `Action type (${ACTION_TYPES.join(", ")})`)
    .option("--timezone <tz>", "IANA timezone (default: UTC)")
    .option("--overlap-policy <policy>", "Overlap policy (skip, buffer_one, allow)")
    .option("--backfill", "Enable backfill for missed ticks")
    .option("--no-enabled", "Create in disabled state")
    .option("--command <cmd>", "Command to run (for command/kspec actions)")
    .option("--args <args...>", "Command arguments (for command action)")
    .option("--timeout-ms <ms>", "Action timeout in milliseconds")
    .option("--agent-id <id>", "Agent ID (for agent action)")
    .option("--prompt <prompt>", "Prompt (for agent action)")
    .option("--message <msg>", "Message (for notify action)")
    .option("--topic <topic>", "Topic (for notify action)")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        // Build action
        const action = buildActionFromOptions(options);
        if (!action) {
          // AC: @trait-error-guidance ac-1, ac-2, ac-5
          const required: Record<string, string> = {
            command: "--command",
            kspec: "--command",
            agent: "--agent-id",
            notify: "--message",
          };
          const requiredOpt = required[options.actionType] || "(unknown)";
          error(`Missing required option for action type '${options.actionType}': ${requiredOpt}`, {
            hint: `Action type '${options.actionType}' requires ${requiredOpt}`,
          });
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // Check for duplicate ID
        const metaCtx = await loadMetaContext(ctx);
        const existing = metaCtx.schedules.find((s) => s.id === options.id);
        if (existing) {
          error(`Schedule with ID '${options.id}' already exists`);
          process.exit(EXIT_CODES.CONFLICT);
        }

        // Build schedule data
        const scheduleData = {
          _ulid: ulid(),
          id: options.id,
          name: options.name,
          cron: options.cron,
          action,
          ...(options.timezone && { timezone: options.timezone }),
          ...(options.overlapPolicy && {
            overlap_policy: options.overlapPolicy,
          }),
          ...(options.backfill && { backfill: true }),
          ...(options.enabled === false && { enabled: false }),
        };

        // Validate with schema
        const parsed = ScheduleSchema.safeParse(scheduleData);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          // AC: @trait-error-guidance ac-5
          error(`Invalid schedule data: ${issues}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const newSchedule: LoadedSchedule = { ...parsed.data };

        await saveSchedule(ctx, newSchedule);
        await commitIfShadow(ctx.shadow, "schedule-add", newSchedule.id, newSchedule.name);

        output(
          { success: true, message: `Created schedule: ${newSchedule.id}`, schedule: newSchedule },
          () => success(`Created schedule: ${newSchedule.id}`),
        );
      } catch (err) {
        error("Failed to create schedule", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ── schedule set ───────────────────────────────────────────────────────────

  markMutating(schedule.command("set <ref>"))
    .description("Update schedule fields")
    .option("--name <name>", "Update name")
    .option("--cron <expr>", "Update cron expression")
    .option("--timezone <tz>", "Update timezone")
    .option("--overlap-policy <policy>", "Update overlap policy (skip, buffer_one, allow)")
    .option("--backfill <value>", "Enable/disable backfill (true/false)")
    .option("--enabled <value>", "Enable/disable schedule (true/false)")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const found = resolveScheduleRef(metaCtx, ref);

        if (!found) {
          error(`Schedule not found: ${ref}`, {
            hint: "Check available schedules with: kspec schedule list",
          });
          if (!isStructuredMode()) console.log(chalk.gray("Try: kspec schedule list"));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        const updated = structuredClone(found);

        if (options.name !== undefined) updated.name = options.name;
        if (options.cron !== undefined) updated.cron = options.cron;
        if (options.timezone !== undefined) updated.timezone = options.timezone;
        if (options.overlapPolicy !== undefined) updated.overlap_policy = options.overlapPolicy;
        if (options.backfill !== undefined) updated.backfill = options.backfill === "true";
        if (options.enabled !== undefined) updated.enabled = options.enabled === "true";

        // Re-validate
        const parsed = ScheduleSchema.safeParse(updated);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          error(`Invalid schedule data: ${issues}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        await saveSchedule(ctx, { ...parsed.data, _sourceFile: found._sourceFile });
        await commitIfShadow(ctx.shadow, "schedule-set", updated.id, updated.name);

        output(parsed.data, () => success(`Updated schedule: ${updated.id}`));
      } catch (err) {
        error("Failed to update schedule", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ── schedule enable ────────────────────────────────────────────────────────

  markMutating(schedule.command("enable <ref>"))
    .description("Enable a schedule")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const found = resolveScheduleRef(metaCtx, ref);

        if (!found) {
          error(`Schedule not found: ${ref}`, {
            hint: "Check available schedules with: kspec schedule list",
          });
          if (!isStructuredMode()) console.log(chalk.gray("Try: kspec schedule list"));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        if (found.enabled) {
          info(`Schedule '${found.id}' is already enabled`);
          return;
        }

        const updated: LoadedSchedule = { ...found, enabled: true };
        await saveSchedule(ctx, updated);
        await commitIfShadow(ctx.shadow, "schedule-enable", updated.id);

        output({ success: true, message: `Enabled schedule: ${updated.id}` }, () =>
          success(`Enabled schedule: ${updated.id}`),
        );
      } catch (err) {
        error("Failed to enable schedule", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ── schedule disable ───────────────────────────────────────────────────────

  markMutating(schedule.command("disable <ref>"))
    .description("Disable a schedule")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const found = resolveScheduleRef(metaCtx, ref);

        if (!found) {
          error(`Schedule not found: ${ref}`, {
            hint: "Check available schedules with: kspec schedule list",
          });
          if (!isStructuredMode()) console.log(chalk.gray("Try: kspec schedule list"));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        if (!found.enabled) {
          info(`Schedule '${found.id}' is already disabled`);
          return;
        }

        const updated: LoadedSchedule = { ...found, enabled: false };
        await saveSchedule(ctx, updated);
        await commitIfShadow(ctx.shadow, "schedule-disable", updated.id);

        output({ success: true, message: `Disabled schedule: ${updated.id}` }, () =>
          success(`Disabled schedule: ${updated.id}`),
        );
      } catch (err) {
        error("Failed to disable schedule", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ── schedule remove ────────────────────────────────────────────────────────

  markMutating(schedule.command("remove <ref>"))
    .description("Remove a schedule")
    .option("--confirm", "Confirm deletion")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        const metaCtx = await loadMetaContext(ctx);
        const found = resolveScheduleRef(metaCtx, ref);

        if (!found) {
          error(`Schedule not found: ${ref}`, {
            hint: "Check available schedules with: kspec schedule list",
          });
          if (!isStructuredMode()) console.log(chalk.gray("Try: kspec schedule list"));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        if (!options.confirm) {
          error(`Confirm deletion of schedule '${found.id}' with --confirm flag`);
          process.exit(EXIT_CODES.ERROR);
        }

        const deleted = await deleteSchedule(ctx, found._ulid);

        if (!deleted) {
          error(`Failed to delete schedule: ${found.id}`);
          process.exit(EXIT_CODES.ERROR);
        }

        await commitIfShadow(ctx.shadow, "schedule-remove", found.id);

        output({ success: true, message: `Removed schedule: ${found.id}` }, () =>
          success(`Removed schedule: ${found.id}`),
        );
      } catch (err) {
        error("Failed to remove schedule", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ── schedule trigger ───────────────────────────────────────────────────────

  // AC: @dispatch-event-cli ac-3 — trigger executes immediately with overlap policy
  schedule
    .command("trigger <ref>")
    .description("Manually trigger a schedule (requires running daemon)")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.ERROR);
        }

        // Resolve the schedule ref to get the id
        const metaCtx = await loadMetaContext(ctx);
        const found = resolveScheduleRef(metaCtx, ref);

        if (!found) {
          error(`Schedule not found: ${ref}`, {
            hint: "Check available schedules with: kspec schedule list",
          });
          if (!isStructuredMode()) console.log(chalk.gray("Try: kspec schedule list"));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        const daemonConn = getDaemonUrl();
        if (!daemonConn) {
          // AC: @trait-error-guidance ac-1, ac-2
          error("Daemon is not running. The trigger command requires the daemon.", {
            suggestion: "Start the daemon with: kspec serve",
          });
          if (!isStructuredMode())
            console.log(chalk.gray("Suggestion: Start the daemon with: kspec serve"));
          process.exit(EXIT_CODES.ERROR);
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (ctx.projectRoot) {
          headers["X-Kspec-Dir"] = ctx.projectRoot;
        }

        const response = await fetch(
          `${daemonConn.url}/api/schedules/${encodeURIComponent(found.id)}/trigger`,
          { method: "POST", headers },
        );

        if (!response.ok) {
          const body = await response.text();
          error(
            `Trigger failed: ${response.status} ${response.statusText}`,
            body ? { details: body } : undefined,
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const result = (await response.json()) as {
          outcome: string;
          accepted: boolean;
          reason: string | null;
        };

        output(result, () => {
          if (result.accepted) {
            success(`Triggered schedule '${found.id}': ${result.outcome}`);
          } else {
            info(
              `Schedule '${found.id}' not executed: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""}`,
            );
          }
        });
      } catch (err) {
        error("Failed to trigger schedule", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
