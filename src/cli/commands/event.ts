/**
 * Event CLI commands for inspecting events and testing hook matching.
 *
 * Commands: kspec event types, kspec event log, kspec event emit.
 * - event types: lists the event taxonomy from the static registry
 * - event log: queries daemon ring buffer for recent events
 * - event emit: emits a manual event on the daemon bus for testing
 *
 * Spec: @dispatch-event-cli
 * Task: @task-event-cli
 */

import chalk from "chalk";
import Table from "cli-table3";
import type { Command } from "commander";
import {
  EVENT_DOMAINS,
  EVENT_REGISTRY,
  EVENTS_BY_DOMAIN,
  type EventDomain,
  type EventRegistryEntry,
  validateEventType,
} from "../../schema/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, isJsonMode, output } from "../output.js";
import { getRunningDaemonClient } from "../daemon-client.js";

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format event types grouped by domain for human-readable output.
 * AC: @dispatch-event-cli ac-5 — grouped by domain with payload fields
 */
function formatEventTypesByDomain(
  entries: readonly EventRegistryEntry[],
  domainFilter?: string,
): void {
  // Group by domain
  const domains = domainFilter
    ? [domainFilter as EventDomain]
    : ([...EVENT_DOMAINS] as EventDomain[]);

  for (const domain of domains) {
    const domainEntries = entries.filter((e) => e.domain === domain);
    if (domainEntries.length === 0) continue;

    console.log(chalk.bold(`\n${domain}`));
    console.log(chalk.gray("─".repeat(60)));

    for (const entry of domainEntries) {
      console.log(`  ${chalk.cyan(entry.event_type)}`);
      console.log(`    ${chalk.gray(entry.description)}`);
      if (entry.payload_fields.length > 0) {
        console.log(`    ${chalk.gray("Fields:")} ${entry.payload_fields.join(", ")}`);
      }
    }
  }

  const total = entries.length;
  console.log(
    chalk.gray(
      `\n${total} event type${total === 1 ? "" : "s"} across ${domains.length} domain${domains.length === 1 ? "" : "s"}`,
    ),
  );
}

/**
 * Format event log entries as a table for human-readable output.
 */
function formatEventLog(events: EventLogEntry[]): void {
  if (events.length === 0) {
    console.log(chalk.yellow("No recent events"));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold("Event ID"),
      chalk.bold("Type"),
      chalk.bold("Time"),
      chalk.bold("Source"),
      chalk.bold("Source ID"),
    ],
    style: { head: [], border: [] },
  });

  for (const event of events) {
    const time = new Date(event.emitted_at).toLocaleTimeString();
    table.push([
      event.event_id.substring(0, 8),
      event.event_type,
      time,
      event.source_type,
      event.source_id.substring(0, 16),
    ]);
  }

  console.log(table.toString());
  console.log(chalk.gray(`${events.length} event${events.length === 1 ? "" : "s"}`));
}

/**
 * Format emit result for human-readable output.
 * AC: @dispatch-event-cli ac-6 — reports which hooks matched and outcomes
 */
function formatEmitResult(result: EmitApiResponse): void {
  if (!result.accepted) {
    console.log(chalk.yellow(`Event not accepted: ${result.reason ?? "unknown reason"}`));
    return;
  }

  console.log(chalk.green("OK"), `Event emitted: ${result.event_id}`);

  if (result.matched_hooks.length === 0) {
    console.log(chalk.gray("  No hooks matched this event"));
  } else {
    console.log(
      chalk.bold(
        `  ${result.matched_hooks.length} hook${result.matched_hooks.length === 1 ? "" : "s"} matched:`,
      ),
    );
    for (const hook of result.matched_hooks) {
      console.log(`    ${chalk.cyan(hook.name)}`);
    }
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface EventLogEntry {
  event_id: string;
  event_type: string;
  emitted_at: string;
  source_type: string;
  source_id: string;
  causation_id: string | null;
  correlation_id: string | null;
  payload: Record<string, unknown>;
}

interface EventLogApiResponse {
  items: EventLogEntry[];
  total: number;
  offset: number;
  limit: number;
}

interface EmitApiResponse {
  accepted: boolean;
  event_id?: string;
  reason?: string;
  matched_hooks: Array<{
    name: string;
    action_run_id: string | null;
  }>;
}

// ─── JSON Serialization ─────────────────────────────────────────────────────

/**
 * Serialize event registry entries for JSON output.
 * AC: @trait-json-output ac-1, ac-2 — valid JSON with all data
 */
function eventTypesToJson(
  entries: readonly EventRegistryEntry[],
  domainFilter?: string,
): Record<string, unknown> {
  const domains = domainFilter
    ? [domainFilter as EventDomain]
    : ([...EVENT_DOMAINS] as EventDomain[]);

  const grouped: Record<
    string,
    Array<{
      event_type: string;
      description: string;
      payload_fields: readonly string[];
    }>
  > = {};

  for (const domain of domains) {
    const domainEntries = entries.filter((e) => e.domain === domain);
    if (domainEntries.length === 0) continue;
    grouped[domain] = domainEntries.map((e) => ({
      event_type: e.event_type,
      description: e.description,
      payload_fields: e.payload_fields,
    }));
  }

  return {
    domains: grouped,
    total: entries.length,
  };
}

// ─── Command Registration ───────────────────────────────────────────────────

/**
 * Register event CLI commands.
 * AC: @dispatch-event-cli ac-5, ac-6
 */
export function registerEventCommands(program: Command): void {
  const event = program.command("event").description("Event inspection and testing commands");

  // ── kspec event types ──────────────────────────────────────────────────
  // AC: @dispatch-event-cli ac-5 — list event taxonomy grouped by domain
  event
    .command("types")
    .description("List all registered event types grouped by domain")
    .option("--domain <domain>", "Filter by event domain (e.g., task, invocation)")
    .option("--count", "Show only total count of event types")
    .action(async (options) => {
      try {
        let entries: readonly EventRegistryEntry[] = EVENT_REGISTRY;

        // Filter by domain if specified
        if (options.domain) {
          if (!EVENT_DOMAINS.includes(options.domain as EventDomain)) {
            // AC: @trait-error-guidance ac-1, ac-2, ac-5 — describe error and suggest fix
            error(
              `Unknown event domain: '${options.domain}'. ` +
                `Valid domains: ${EVENT_DOMAINS.join(", ")}. ` +
                `Run 'kspec event types' to see all event types.`,
            );
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          entries = EVENTS_BY_DOMAIN[options.domain as EventDomain];
        }

        // AC: @trait-filterable-list ac-8 — count mode
        if (options.count) {
          output(isJsonMode() ? { count: entries.length } : entries.length, () =>
            console.log(entries.length),
          );
          return;
        }

        // AC: @trait-json-output ac-1, ac-2
        // AC: @dispatch-event-cli ac-5 — all identifiers grouped by domain with payload fields
        output(eventTypesToJson(entries, options.domain), () =>
          formatEventTypesByDomain(entries, options.domain),
        );
      } catch (err) {
        // AC: @trait-error-guidance ac-1 — description of what went wrong
        // AC: @trait-json-output ac-3 — error as JSON object
        error("Failed to list event types", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ── kspec event log ────────────────────────────────────────────────────
  // Queries daemon ring buffer for recent events
  event
    .command("log")
    .description("Show recent events from the daemon event bus")
    .option("--type <event-type>", "Filter by event type")
    .option("--limit <n>", "Maximum number of events to show")
    .option("--offset <n>", "Skip first N events")
    .option("--count", "Show only total count of events")
    .action(async (options) => {
      try {
        // Validate event type filter if provided
        if (options.type) {
          const validation = validateEventType(options.type);
          if (!validation.valid) {
            // AC: @trait-error-guidance ac-1, ac-2, ac-5
            error(`${validation.error!.message} ${validation.error!.suggestion}`);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        const daemon = getRunningDaemonClient();

        if (!daemon) {
          // AC: @trait-error-guidance ac-1, ac-2
          error(
            "Daemon is not running. " +
              "Start the daemon with 'kspec serve start' to view event log.",
          );
          process.exit(EXIT_CODES.ERROR);
        }

        // Build query parameters
        const params = new URLSearchParams();
        if (options.type) params.set("type", options.type);
        if (options.limit) params.set("limit", options.limit);
        if (options.offset) params.set("offset", options.offset);

        const queryString = params.toString();
        const url = `${daemon.apiUrl}/api/events/recent${queryString ? `?${queryString}` : ""}`;

        const response = await fetch(url);

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
          const msg = body?.message ?? body?.error ?? `HTTP ${response.status}`;
          error(`Failed to fetch event log: ${msg}`);
          process.exit(EXIT_CODES.ERROR);
        }

        const data = (await response.json()) as EventLogApiResponse;

        // AC: @trait-filterable-list ac-8 — count mode
        if (options.count) {
          output(isJsonMode() ? { count: data.total } : data.total, () => console.log(data.total));
          return;
        }

        // AC: @trait-filterable-list ac-6 — empty result message
        // AC: @trait-filterable-list ac-7 — summary with total and filter state
        // AC: @trait-json-output ac-1, ac-2
        output(data, () => {
          formatEventLog(data.items);
          if (data.total > data.items.length) {
            console.log(chalk.gray(`Showing ${data.items.length} of ${data.total} events`));
          }
        });
      } catch (err) {
        // AC: @trait-error-guidance ac-1
        // AC: @trait-json-output ac-3
        error("Failed to query event log", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ── kspec event emit ───────────────────────────────────────────────────
  // AC: @dispatch-event-cli ac-6 — emit manual event and report hook matches
  event
    .command("emit <event-type>")
    .description("Emit a manual event on the daemon bus for testing")
    .option("--payload <json>", "Event payload as JSON object")
    .option(
      "--field <key=value>",
      "Set a payload field (repeatable)",
      (val: string, arr: string[]) => [...arr, val],
      [] as string[],
    )
    .action(async (eventType: string, options) => {
      try {
        // Validate event type against registry
        // AC: @trait-error-guidance ac-5 — indicate which field/value failed
        const validation = validateEventType(eventType);
        if (!validation.valid) {
          error(`${validation.error!.message} ${validation.error!.suggestion}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // Build payload from --payload and/or --field options
        let payload: Record<string, unknown> = {};

        if (options.payload) {
          try {
            payload = JSON.parse(options.payload);
          } catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            // AC: @trait-error-guidance ac-5
            error(`Invalid JSON in --payload: ${msg}`);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }

          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            error("--payload must be a JSON object, not an array or primitive.");
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        // Apply --field key=value pairs (override --payload values)
        if (options.field && options.field.length > 0) {
          for (const fieldArg of options.field) {
            const eqIdx = fieldArg.indexOf("=");
            if (eqIdx < 1) {
              error(
                `Invalid --field format: '${fieldArg}'. ` +
                  `Expected key=value (e.g., --field task_id=abc123).`,
              );
              process.exit(EXIT_CODES.VALIDATION_FAILED);
            }
            const key = fieldArg.slice(0, eqIdx);
            const value = fieldArg.slice(eqIdx + 1);
            // Try to parse as JSON for numeric/boolean values
            try {
              payload[key] = JSON.parse(value);
            } catch {
              payload[key] = value;
            }
          }
        }

        const daemon = getRunningDaemonClient();

        if (!daemon) {
          // AC: @trait-error-guidance ac-1, ac-2
          error("Daemon is not running. Start the daemon with 'kspec serve start' to emit events.");
          process.exit(EXIT_CODES.ERROR);
        }

        const response = await fetch(`${daemon.apiUrl}/api/events/emit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: eventType,
            payload,
          }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
          if (body?.error) {
            // AC: @trait-error-guidance ac-1, ac-2
            const detailsArr = body.details as
              | Array<{ field: string; message: string }>
              | undefined;
            const details = detailsArr
              ? detailsArr.map((d) => `${d.field}: ${d.message}`).join("; ")
              : ((body.message as string) ?? (body.error as string));
            error(`Failed to emit event: ${details}`);
          } else {
            error(`Failed to emit event: HTTP ${response.status}`);
          }
          process.exit(EXIT_CODES.ERROR);
        }

        const result = (await response.json()) as EmitApiResponse;

        // AC: @dispatch-event-cli ac-6 — report matched hooks and outcomes
        // AC: @trait-json-output ac-1, ac-2
        output(result, () => formatEmitResult(result));
      } catch (err) {
        // AC: @trait-error-guidance ac-1
        // AC: @trait-json-output ac-3
        error("Failed to emit event", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
