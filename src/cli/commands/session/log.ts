/**
 * Session log commands (list, show, stats, search).
 *
 * These commands have zero dependency on the session-start code.
 */

import chalk from "chalk";
import {
  initContext,
} from "../../../parser/index.js";
import {
  type SessionLogSummary,
  type SessionLogDetail,
  type SessionLogStats,
  type ToolUsageStats,
  type TimePeriodStats,
  type SessionSearchResult,
  getAllSessionLogSummaries,
  getSessionLogDetail,
  resolveSessionId,
  readEvents,
  readSessionContext,
  computeSessionLogStats,
  computeToolUsageStats,
  computeTimePeriodStats,
  searchSessionEvents,
  deduplicatePhasedToolCalls,
  resolveSessionBlobPointers,
} from "../../../sessions/store.js";
import type { SessionEvent } from "../../../sessions/types.js";
import { SessionStatusSchema } from "../../../sessions/types.js";
import {
  formatRelativeTime,
  parseTimeSpec,
} from "../../../utils/index.js";
import { isObject } from "../../../acp/types.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { error, output, warn } from "../../output.js";

// ─── Shared Helpers ─────────────────────────────────────────────────────────

/**
 * Format a duration in milliseconds to a compact human-readable string.
 * Omits seconds when minutes are present (e.g., "5m" not "5m 30s").
 */
function formatDurationCompact(ms: number): string {
  if (ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${totalSec}s`;
}

/**
 * Format a duration in milliseconds to a verbose human-readable string.
 * Shows seconds when minutes are present (e.g., "5m 30s" not "5m").
 */
function formatDurationVerbose(ms: number): string {
  if (ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Map session status to chalk color function.
 * Unlike statusColor() in format.ts (which handles task statuses),
 * this handles session lifecycle statuses: completed, active, abandoned.
 */
function sessionStatusColor(
  status: string,
): typeof chalk.green {
  switch (status) {
    case "completed":
      return chalk.green;
    case "active":
      return chalk.blue;
    case "abandoned":
      return chalk.yellow;
    default:
      return chalk.gray;
  }
}

// ─── Session Log List ───────────────────────────────────────────────────────

interface SessionLogListOptions {
  status?: string;
  agent?: string;
  since?: string;
  sort?: string;
  count?: boolean;
  limit?: string;
}

type SortField =
  | "started_at"
  | "duration"
  | "events"
  | "iterations"
  | "tasks_completed";

const VALID_SORT_FIELDS: SortField[] = [
  "started_at",
  "duration",
  "events",
  "iterations",
  "tasks_completed",
];

/**
 * Sort session summaries by the specified field.
 * Default: started_at descending.
 *
 * AC: @session-log-list ac-5
 */
function sortSessions(
  sessions: SessionLogSummary[],
  sortField: SortField,
): SessionLogSummary[] {
  return [...sessions].sort((a, b) => {
    switch (sortField) {
      case "started_at":
        return (
          new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
        );
      case "duration":
        return b.duration_ms - a.duration_ms;
      case "events":
        return b.event_count - a.event_count;
      case "iterations":
        return b.iteration_count - a.iteration_count;
      case "tasks_completed":
        return b.tasks_completed - a.tasks_completed;
      default:
        return (
          new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
        );
    }
  });
}

/**
 * Format the session log list as a table.
 *
 * AC: @session-log-list ac-1
 */
function formatSessionLogList(sessions: SessionLogSummary[]): void {
  if (sessions.length === 0) {
    // AC: @session-log-list ac-6
    console.log("No sessions found.");
    return;
  }

  // Table header
  console.log(
    chalk.gray(
      `${"ID".padEnd(10)} ${"Status".padEnd(11)} ${"Agent".padEnd(20)} ${"Started".padEnd(16)} ${"Duration".padEnd(10)} ${"Events".padEnd(8)} ${"Iters".padEnd(7)} Tasks`,
    ),
  );
  console.log(chalk.gray("─".repeat(95)));

  for (const s of sessions) {
    const id = s.id.slice(0, 8);
    const colorFn = sessionStatusColor(s.status);
    const status = colorFn(s.status.padEnd(11));
    const agent = s.agent_type.slice(0, 20).padEnd(20);
    const started = formatRelativeTime(new Date(s.started_at)).padEnd(16);
    const duration = formatDurationCompact(s.duration_ms).padEnd(10);
    const events = String(s.event_count).padEnd(8);
    const iters = String(s.iteration_count).padEnd(7);
    const tasks = String(s.tasks_completed);

    console.log(
      `${chalk.yellow(id)} ${status} ${chalk.gray(agent)} ${chalk.gray(started)} ${duration} ${events} ${iters} ${tasks}`,
    );
  }

  console.log(chalk.gray(`\n${sessions.length} session(s)`));
}

/**
 * Session log list action handler.
 */
export async function sessionLogListAction(
  options: SessionLogListOptions,
): Promise<void> {
  try {
    const ctx = await initContext();
    let sessions = await getAllSessionLogSummaries(ctx.specDir);

    // AC: @session-log-list ac-2 - Filter by status
    if (options.status) {
      const parsed = SessionStatusSchema.safeParse(options.status);
      if (!parsed.success) {
        const valid = SessionStatusSchema.options.join(", ");
        error(`Invalid status: '${options.status}'. Valid values: ${valid}`);
        process.exit(EXIT_CODES.USAGE_ERROR);
      }
      const statusFilter = parsed.data;
      sessions = sessions.filter((s) => s.status === statusFilter);
    }

    // AC: @session-log-list ac-4 - Filter by agent type
    if (options.agent) {
      const agentFilter = options.agent;
      sessions = sessions.filter((s) => s.agent_type === agentFilter);
    }

    // AC: @session-log-list ac-3 - Filter by since date
    if (options.since) {
      const sinceDate = parseTimeSpec(options.since);
      if (sinceDate) {
        sessions = sessions.filter(
          (s) => new Date(s.started_at) >= sinceDate,
        );
      }
    }

    // AC: @session-log-list ac-5 - Sort
    const sortField: SortField =
      options.sort && VALID_SORT_FIELDS.includes(options.sort as SortField)
        ? (options.sort as SortField)
        : "started_at";
    sessions = sortSessions(sessions, sortField);

    // AC: @session-log-list ac-7 - Limit output count
    if (options.count) {
      // AC: @trait-filterable-list ac-8
      output({ count: sessions.length }, () => {
        console.log(sessions.length);
      });
      return;
    }

    // Apply --limit (after filtering/sorting, before display)
    if (options.limit) {
      const limit = parseInt(options.limit, 10);
      if (!Number.isNaN(limit) && limit > 0) {
        sessions = sessions.slice(0, limit);
      }
    }

    output(sessions, () => formatSessionLogList(sessions));
  } catch (err) {
    error("Failed to list session logs", err);
    process.exit(EXIT_CODES.ERROR);
  }
}

// ─── Session Log Show ───────────────────────────────────────────────────────

interface SessionLogShowOptions {
  events?: boolean;
  type?: string;
  limit?: string;
  context?: string;
  resolveBlobs?: boolean;
}

/**
 * Format an event timestamp as relative time from session start.
 */
function formatEventTimestamp(
  eventTs: number,
  sessionStartTs: number,
): string {
  const relativeMs = eventTs - sessionStartTs;
  const totalSec = Math.floor(relativeMs / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) {
    return `+${minutes}m${seconds}s`;
  }
  return `+${seconds}s`;
}

/**
 * Summarize event data for display.
 * Returns a short string describing the event payload.
 */
function summarizeEventData(event: SessionEvent): string {
  const data = event.data;
  if (!isObject(data)) return "";

  // Handle tool_call events
  if (event.type === "session.update") {
    const update = data.update;
    if (isObject(update) && update.sessionUpdate === "tool_call") {
      const meta = update._meta;
      let toolName = "unknown";
      if (isObject(meta)) {
        const claudeCode = meta.claudeCode;
        if (isObject(claudeCode) && typeof claudeCode.toolName === "string") {
          toolName = claudeCode.toolName;
        }
      }
      const rawInput = update.rawInput;
      if (isObject(rawInput) && typeof rawInput.command === "string") {
        const command = rawInput.command;
        const truncated =
          command.length > 60 ? command.slice(0, 57) + "..." : command;
        return `${toolName}: ${truncated}`;
      }
      return toolName;
    }
  }

  // Handle prompt.sent events
  if (event.type === "prompt.sent") {
    const prompt = data.prompt;
    if (typeof prompt === "string" && prompt.length > 0) {
      const truncated =
        prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
      return truncated;
    }
  }

  // Handle session.start/end
  if (event.type === "session.start") {
    return "Session started";
  }
  if (event.type === "session.end") {
    const reason = data.reason;
    return typeof reason === "string" ? `Session ended: ${reason}` : "Session ended";
  }

  // Default: show first key
  const keys = Object.keys(data);
  if (keys.length > 0) {
    return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", ..." : ""}}`;
  }
  return "";
}

/**
 * Format the session log show output.
 *
 * AC: @session-log-show ac-1
 */
function formatSessionLogShow(
  detail: SessionLogDetail,
  events: SessionEvent[] | null,
  contextSnapshot: unknown,
  sessionStartTs: number,
): void {
  // AC: @session-log-show ac-1 - Session metadata
  console.log(chalk.bold(`Session ${detail.id.slice(0, 8)}`));
  console.log(chalk.gray("─".repeat(60)));
  console.log(`  ID:        ${detail.id}`);

  console.log(`  Status:    ${sessionStatusColor(detail.status)(detail.status)}`);
  console.log(`  Agent:     ${detail.agent_type}`);
  if (detail.task_id) {
    console.log(`  Task:      ${detail.task_id}`);
  }
  console.log(`  Started:   ${detail.started_at}`);
  if (detail.ended_at) {
    console.log(`  Ended:     ${detail.ended_at}`);
  }
  console.log(`  Duration:  ${formatDurationCompact(detail.duration_ms)}`);
  console.log(`  Events:    ${detail.event_count}`);
  console.log(`  Iterations: ${detail.iteration_count}`);

  // AC: @session-log-show ac-2 - Per-iteration summary
  if (detail.iterations.length > 0) {
    console.log("\n" + chalk.bold("Iterations"));
    console.log(chalk.gray("─".repeat(60)));
    for (const iter of detail.iterations) {
      const taskInfo: string[] = [];
      if (iter.tasks_started.length > 0) {
        taskInfo.push(`started: ${iter.tasks_started.join(", ")}`);
      }
      if (iter.tasks_completed.length > 0) {
        taskInfo.push(`completed: ${iter.tasks_completed.join(", ")}`);
      }
      const taskStr = taskInfo.length > 0 ? ` | ${taskInfo.join(" | ")}` : "";
      console.log(
        `  ${chalk.cyan(`[${iter.iteration}]`)} ${iter.event_count} events${taskStr}`,
      );
    }
  }

  // AC: @session-log-show ac-3 - Event timeline
  if (events !== null) {
    console.log("\n" + chalk.bold("Events"));
    console.log(chalk.gray("─".repeat(60)));
    if (events.length === 0) {
      console.log(chalk.gray("  No events to display."));
    } else {
      for (const event of events) {
        const timestamp = formatEventTimestamp(event.ts, sessionStartTs);
        const summary = summarizeEventData(event);
        const typeColor =
          event.type === "session.start" || event.type === "session.end"
            ? chalk.green
            : event.type === "session.update"
              ? chalk.blue
              : chalk.gray;
        console.log(
          `  ${chalk.yellow(timestamp.padEnd(10))} ${typeColor(event.type.padEnd(16))} ${chalk.gray(summary)}`,
        );
      }
    }
  }

  // AC: @session-log-show ac-6 - Context snapshot
  if (contextSnapshot !== null) {
    console.log("\n" + chalk.bold("Context Snapshot"));
    console.log(chalk.gray("─".repeat(60)));
    console.log(JSON.stringify(contextSnapshot, null, 2));
  }
}

/**
 * Session log show action handler.
 */
export async function sessionLogShowAction(
  sessionRef: string,
  options: SessionLogShowOptions,
): Promise<void> {
  try {
    const ctx = await initContext();

    // AC: @session-log-show ac-7, ac-8, ac-9 - Resolve session ID
    const resolution = await resolveSessionId(ctx.specDir, sessionRef);

    if (!resolution.ok) {
      if (resolution.error === "not_found") {
        // AC: @session-log-show ac-9
        error(`Session not found: ${sessionRef}`);
        process.exit(EXIT_CODES.NOT_FOUND);
      } else {
        // AC: @session-log-show ac-8
        error(
          `Ambiguous session ID prefix. Matches:\n  ${resolution.matches.join("\n  ")}\nPlease provide a more specific prefix.`,
        );
        process.exit(EXIT_CODES.VALIDATION_FAILED);
      }
    }

    const sessionId = resolution.id;

    // Get session detail
    const detail = await getSessionLogDetail(ctx.specDir, sessionId);
    if (!detail) {
      error(`Session not found: ${sessionId}`);
      process.exit(EXIT_CODES.NOT_FOUND);
    }

    if (options.resolveBlobs && !options.events) {
      warn("--resolve-blobs has no effect without --events; showing metadata only.");
    }

    // AC: @session-log-show ac-3, ac-4, ac-5 - Event timeline
    let events: SessionEvent[] | null = null;
    if (options.events) {
      let allEvents = deduplicatePhasedToolCalls(
        await readEvents(ctx.specDir, sessionId),
      );

      // AC: @session-log-show ac-4 - Filter by type
      if (options.type) {
        const typeFilter = options.type;
        allEvents = allEvents.filter((e) => e.type === typeFilter);
      }

      // AC: @session-log-show ac-5 - Limit to last N events
      if (options.limit) {
        const limit = parseInt(options.limit, 10);
        if (!Number.isNaN(limit) && limit > 0) {
          allEvents = allEvents.slice(-limit);
        }
      }

      if (options.resolveBlobs) {
        allEvents = await Promise.all(
          allEvents.map(async (event) => ({
            ...event,
            data: await resolveSessionBlobPointers(
              ctx.specDir,
              sessionId,
              event.data,
            ),
          })),
        );
      }

      events = allEvents;
    }

    // AC: @session-log-show ac-6 - Context snapshot
    let contextSnapshot: unknown = null;
    if (options.context) {
      const iterNum = parseInt(options.context, 10);
      if (!Number.isNaN(iterNum) && iterNum > 0) {
        contextSnapshot = await readSessionContext(
          ctx.specDir,
          sessionId,
          iterNum,
        );
        if (contextSnapshot === null) {
          error(`No context snapshot found for iteration ${iterNum}`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }
      } else {
        error(`Invalid iteration number: ${options.context}`);
        process.exit(EXIT_CODES.USAGE_ERROR);
      }
    }

    const sessionStartTs = new Date(detail.started_at).getTime();

    // Build JSON output structure
    const jsonOutput = {
      ...detail,
      ...(events !== null ? { events } : {}),
      ...(contextSnapshot !== null ? { context: contextSnapshot } : {}),
    };

    output(jsonOutput, () =>
      formatSessionLogShow(detail, events, contextSnapshot, sessionStartTs),
    );
  } catch (err) {
    error("Failed to show session log", err);
    process.exit(EXIT_CODES.ERROR);
  }
}

// ─── Session Log Stats ──────────────────────────────────────────────────────

interface SessionLogStatsOptions {
  since?: string;
  agent?: string;
  toolUsage?: boolean;
  byDay?: boolean;
  byWeek?: boolean;
}

/**
 * Full stats output including optional tool usage and time period data.
 */
interface SessionLogStatsOutput {
  stats: SessionLogStats;
  tool_usage?: ToolUsageStats[];
  time_periods?: TimePeriodStats[];
}

/**
 * Format the session log stats output.
 *
 * AC: @session-log-stats ac-1, ac-2, ac-3
 */
function formatSessionLogStats(
  stats: SessionLogStats,
  toolUsage: ToolUsageStats[] | null,
  timePeriods: TimePeriodStats[] | null,
  groupBy: "day" | "week" | null,
): void {
  // AC: @session-log-stats ac-1 - Totals
  console.log(chalk.bold("Session Statistics"));
  console.log(chalk.gray("─".repeat(50)));
  console.log(`  Total Sessions:     ${stats.total_sessions}`);
  console.log(`  Total Events:       ${stats.total_events}`);
  console.log(`  Total Iterations:   ${stats.total_iterations}`);
  console.log(`  Tasks Completed:    ${stats.total_tasks_completed}`);
  console.log(`  Total Duration:     ${formatDurationVerbose(stats.total_duration_ms)}`);

  // AC: @session-log-stats ac-2 - Averages
  console.log("\n" + chalk.bold("Averages"));
  console.log(chalk.gray("─".repeat(50)));
  console.log(`  Avg Duration/Session:     ${formatDurationVerbose(stats.avg_duration_ms)}`);
  console.log(`  Avg Iterations/Session:   ${stats.avg_iterations_per_session}`);
  console.log(`  Avg Tasks/Session:        ${stats.avg_tasks_per_session}`);

  // AC: @session-log-stats ac-3 - Status breakdown
  if (stats.status_breakdown.length > 0) {
    console.log("\n" + chalk.bold("Status Breakdown"));
    console.log(chalk.gray("─".repeat(50)));
    for (const item of stats.status_breakdown) {
      console.log(
        `  ${sessionStatusColor(item.status)(item.status.padEnd(12))} ${String(item.count).padEnd(6)} ${item.percentage}%`,
      );
    }
  }

  // AC: @session-log-stats ac-6 - Tool usage
  if (toolUsage !== null && toolUsage.length > 0) {
    console.log("\n" + chalk.bold("Top Tool Usage"));
    console.log(chalk.gray("─".repeat(50)));
    for (const tool of toolUsage) {
      console.log(
        `  ${tool.tool_name.padEnd(20)} ${String(tool.count).padEnd(8)} ${tool.percentage}%`,
      );
    }
  }

  // AC: @session-log-stats ac-7 - Time periods
  if (timePeriods !== null && timePeriods.length > 0) {
    const label = groupBy === "week" ? "By Week" : "By Day";
    console.log("\n" + chalk.bold(label));
    console.log(chalk.gray("─".repeat(50)));
    console.log(
      chalk.gray(
        `  ${"Period".padEnd(14)} ${"Sessions".padEnd(10)} ${"Tasks".padEnd(8)} Duration`,
      ),
    );
    for (const period of timePeriods) {
      console.log(
        `  ${period.period.padEnd(14)} ${String(period.sessions_count).padEnd(10)} ${String(period.tasks_completed).padEnd(8)} ${formatDurationVerbose(period.total_duration_ms)}`,
      );
    }
  }
}

/**
 * Session log stats action handler.
 */
export async function sessionLogStatsAction(
  options: SessionLogStatsOptions,
): Promise<void> {
  try {
    const ctx = await initContext();
    let sessions = await getAllSessionLogSummaries(ctx.specDir);

    // AC: @session-log-stats ac-4 - Filter by since
    if (options.since) {
      const sinceDate = parseTimeSpec(options.since);
      if (sinceDate) {
        sessions = sessions.filter(
          (s) => new Date(s.started_at) >= sinceDate,
        );
      }
    }

    // AC: @session-log-stats ac-5 - Filter by agent type
    if (options.agent) {
      const agentFilter = options.agent;
      sessions = sessions.filter((s) => s.agent_type === agentFilter);
    }

    // AC: @session-log-stats ac-8 - No sessions match criteria
    if (sessions.length === 0) {
      output({ message: "No sessions match criteria" }, () => {
        console.log("No sessions match criteria.");
      });
      return;
    }

    // Compute base stats
    const stats = computeSessionLogStats(sessions);

    // AC: @session-log-stats ac-6 - Tool usage (optional)
    let toolUsage: ToolUsageStats[] | null = null;
    if (options.toolUsage) {
      const sessionIds = sessions.map((s) => s.id);
      toolUsage = await computeToolUsageStats(ctx.specDir, sessionIds);
    }

    // AC: @session-log-stats ac-7 - Time periods (optional)
    let timePeriods: TimePeriodStats[] | null = null;
    let groupBy: "day" | "week" | null = null;
    if (options.byDay) {
      groupBy = "day";
      timePeriods = computeTimePeriodStats(sessions, "day");
    } else if (options.byWeek) {
      groupBy = "week";
      timePeriods = computeTimePeriodStats(sessions, "week");
    }

    // Build output structure
    const jsonOutput: SessionLogStatsOutput = { stats };
    if (toolUsage !== null) {
      jsonOutput.tool_usage = toolUsage;
    }
    if (timePeriods !== null) {
      jsonOutput.time_periods = timePeriods;
    }

    output(jsonOutput, () =>
      formatSessionLogStats(stats, toolUsage, timePeriods, groupBy),
    );
  } catch (err) {
    error("Failed to compute session log stats", err);
    process.exit(EXIT_CODES.ERROR);
  }
}

// ─── Session Log Search ─────────────────────────────────────────────────────

interface SessionLogSearchOptions {
  type?: string;
  since?: string;
  agent?: string;
  limit?: string;
  resolveBlobs?: boolean;
}

/**
 * Format the session log search output.
 *
 * AC: @session-log-search ac-1, ac-4
 */
function formatSessionLogSearch(results: SessionSearchResult[]): void {
  if (results.length === 0) {
    // AC: @session-log-search ac-6
    console.log("No matches found.");
    return;
  }

  let totalMatches = 0;
  for (const session of results) {
    totalMatches += session.matches.length;
  }

  console.log(chalk.bold(`Found ${totalMatches} match(es) in ${results.length} session(s)`));
  console.log(chalk.gray("─".repeat(60)));

  for (const session of results) {
    // Session header
    console.log(
      `\n${chalk.cyan(`Session ${session.session_id.slice(0, 8)}`)} ` +
        `${chalk.gray(`(${session.agent_type}, started ${formatRelativeTime(new Date(session.started_at))})`)}`
    );

    // AC: @session-log-search ac-4 - Show matches with session ID, timestamp, type, excerpt
    for (const match of session.matches) {
      const ts = new Date(match.timestamp).toISOString();
      const typeColor =
        match.event_type === "session.start" || match.event_type === "session.end"
          ? chalk.green
          : match.event_type === "session.update"
            ? chalk.blue
            : chalk.gray;
      console.log(
        `  ${chalk.yellow(ts)} ${typeColor(match.event_type.padEnd(16))}`,
      );
      // Content excerpt on next line, indented
      console.log(`    ${chalk.gray(match.content_excerpt)}`);
    }
  }
}

/**
 * Session log search action handler.
 *
 * AC: @session-log-search ac-1 through ac-7
 */
export async function sessionLogSearchAction(
  pattern: string,
  options: SessionLogSearchOptions,
): Promise<void> {
  try {
    const ctx = await initContext();

    // Parse options - validate limit as positive integer
    let limit = 50;
    if (options.limit) {
      const parsed = parseInt(options.limit, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        error(`Invalid limit: ${options.limit}. Must be a positive integer.`);
        process.exit(EXIT_CODES.USAGE_ERROR);
      }
      limit = parsed;
    }
    const sinceDate = options.since ? parseTimeSpec(options.since) : undefined;

    // AC: @session-log-search ac-1, ac-2, ac-3, ac-5, ac-7
    const results = await searchSessionEvents(ctx.specDir, pattern, {
      eventType: options.type,
      sinceDate: sinceDate || undefined,
      agentType: options.agent,
      limit,
      resolveBlobs: options.resolveBlobs,
    });

    // AC: @session-log-search ac-6 - No matches found message
    // exit code 0 regardless (per @trait-semantic-exit-codes ac-5)

    output(results, () => formatSessionLogSearch(results));
  } catch (err) {
    error("Failed to search session logs", err);
    process.exit(EXIT_CODES.ERROR);
  }
}
