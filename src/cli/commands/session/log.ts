/**
 * Session log commands (list, show, stats, search).
 *
 * These commands have zero dependency on the session-start code.
 */

import chalk from "chalk";
import { initContext } from "../../../parser/index.js";
import {
  type SessionLogSummary,
  type SessionLogDetail,
  type SessionLogStats,
  type ToolUsageStats,
  type TimePeriodStats,
  type SessionSearchResult,
  getAllSessionLogSummaries,
  resolveSessionId,
  searchSessionEvents,
  computeToolUsageStats,
  getSessionLogDetail,
  readEvents,
  readSessionContext,
  computeSessionLogStats,
  computeTimePeriodStats,
  deduplicatePhasedToolCalls,
  resolveSessionBlobPointers,
} from "../../../sessions/store.js";
import { warnIfLegacySessions } from "../../../sessions/legacy.js";
import type { SessionEvent } from "../../../sessions/types.js";
import { SessionStatusSchema } from "../../../sessions/types.js";
import { formatRelativeTime, parseTimeSpec } from "../../../utils/index.js";
import { isObject } from "../../../acp/types.js";
import {
  unwrapSessionUpdate,
  extractToolName,
} from "../../../agent-runtime/session-event-fields.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { error, isStructuredMode, output, warn } from "../../output.js";

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
function sessionStatusColor(status: string): typeof chalk.green {
  switch (status) {
    case "completed":
      return chalk.green;
    case "active":
      return chalk.blue;
    case "abandoned":
      return chalk.yellow;
    case "stalled":
      return chalk.magenta;
    default:
      return chalk.gray;
  }
}

/**
 * Normalize a task ref/id into a comparable form for `--task` filtering.
 *
 * Drops a leading `@` and lowercases so every spelling of the same identity
 * compares equal: the canonical `@<ULID>` display ref, the bare `<ULID>` stored
 * in `task_id`, and slug display refs (`@slug` vs `slug`). Without this, a
 * `--task @<ULID>` filter misses canonicalized dispatch sessions whose
 * `task_id` is the bare ULID and whose `task_ref` is a different display ref.
 *
 * AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
 */
function normalizeTaskFilterForm(value: string): string {
  return (value.startsWith("@") ? value.slice(1) : value).toLowerCase();
}

// ─── Shared Session Filters ─────────────────────────────────────────────────

/**
 * Common filter options shared across session log commands.
 * Unifies CLI and daemon API filter vocabulary.
 *
 * AC: @session-cli-unified-filtering ac-combined
 */
export interface SessionFilterOptions {
  status?: string;
  /** Filter by agent_type (backward compat: --agent and --agent-type are synonyms) */
  agent?: string;
  agentType?: string;
  /** Filter by agent_id (e.g. worker, pr-reviewer) */
  agentId?: string;
  /** Filter by trigger (manual, dispatched, or specific task.* triggers) */
  trigger?: string;
  /** Filter by task reference */
  task?: string;
  since?: string;
}

/**
 * Apply shared session filters to a list of summaries.
 * All filters are AND'd together.
 *
 * AC: @session-cli-unified-filtering ac-agent-id-filter
 * AC: @session-cli-unified-filtering ac-trigger-filter
 * AC: @session-cli-unified-filtering ac-task-filter
 * AC: @session-cli-unified-filtering ac-backward-compat
 * AC: @session-cli-unified-filtering ac-combined
 */
export function filterSessions(
  sessions: SessionLogSummary[],
  options: SessionFilterOptions,
): SessionLogSummary[] {
  let result = sessions;

  // AC: @session-cli-unified-filtering ac-backward-compat — --agent and --agent-type are synonyms for agent_type
  const agentTypeFilter = options.agent ?? options.agentType;
  if (options.status) {
    const parsed = SessionStatusSchema.safeParse(options.status);
    if (!parsed.success) {
      const valid = SessionStatusSchema.options.join(", ");
      error(`Invalid status: '${options.status}'. Valid values: ${valid}`);
      process.exit(EXIT_CODES.USAGE_ERROR);
    }
    result = result.filter((s) => s.status === parsed.data);
  }

  if (agentTypeFilter) {
    result = result.filter((s) => s.agent_type === agentTypeFilter);
  }

  // AC: @session-cli-unified-filtering ac-agent-id-filter
  if (options.agentId) {
    const id = options.agentId;
    result = result.filter((s) => s.agent_id === id);
  }

  // AC: @session-cli-unified-filtering ac-trigger-filter
  // --trigger dispatched matches all task.* triggers
  if (options.trigger) {
    const triggerFilter = options.trigger;
    if (triggerFilter === "dispatched") {
      result = result.filter((s) => s.trigger?.startsWith("task."));
    } else {
      result = result.filter((s) => s.trigger === triggerFilter);
    }
  }

  // AC: @session-cli-unified-filtering ac-task-filter
  // Match the canonical task_id or the human-readable display task_ref. Compare
  // through normalized forms (leading `@` dropped, case-insensitive) so the
  // canonical `@<ULID>` spelling still finds dispatch sessions whose task_id is
  // the bare canonical ULID and whose task_ref is a different display ref.
  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  if (options.task) {
    const want = normalizeTaskFilterForm(options.task);
    result = result.filter(
      (s) =>
        (s.task_id !== undefined && normalizeTaskFilterForm(s.task_id) === want) ||
        (s.task_ref !== undefined && normalizeTaskFilterForm(s.task_ref) === want),
    );
  }

  if (options.since) {
    const sinceDate = parseTimeSpec(options.since);
    if (sinceDate) {
      result = result.filter((s) => new Date(s.started_at) >= sinceDate);
    }
  }

  return result;
}

// ─── Session Log List ───────────────────────────────────────────────────────

interface SessionLogListOptions extends SessionFilterOptions {
  sort?: string;
  count?: boolean;
  limit?: string;
  offset?: string;
}

type SortField = "started_at" | "duration" | "events" | "iterations" | "tasks_completed";

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
function sortSessions(sessions: SessionLogSummary[], sortField: SortField): SessionLogSummary[] {
  return [...sessions].toSorted((a, b) => {
    switch (sortField) {
      case "started_at":
        return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
      case "duration":
        return b.duration_ms - a.duration_ms;
      case "events":
        return b.event_count - a.event_count;
      case "iterations":
        return b.iteration_count - a.iteration_count;
      case "tasks_completed":
        return b.tasks_completed - a.tasks_completed;
      default:
        return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
    }
  });
}

function getActiveSessionFilterDescriptions(options: SessionFilterOptions): string[] {
  const agentType = options.agent ?? options.agentType;
  const descriptions: string[] = [];

  if (options.status) descriptions.push(`status=${options.status}`);
  if (agentType) descriptions.push(`agent_type=${agentType}`);
  if (options.agentId) descriptions.push(`agent_id=${options.agentId}`);
  if (options.trigger) descriptions.push(`trigger=${options.trigger}`);
  if (options.task) descriptions.push(`task_id=${options.task}`);
  if (options.since) descriptions.push(`since=${options.since}`);

  return descriptions;
}

/**
 * Format the session log list as a table.
 *
 * AC: @session-log-list ac-1
 * AC: @session-model-evolution ac-6
 */
function formatSessionLogList(
  sessions: SessionLogSummary[],
  total?: number,
  filterDescriptions: string[] = [],
): void {
  const hasFilters = filterDescriptions.length > 0;
  const filterInfo = hasFilters ? ` (filtered: ${filterDescriptions.join(", ")})` : "";

  // AC: @trait-filterable-list ac-6 — empty list with informative message
  if (sessions.length === 0) {
    if (hasFilters) {
      console.log("No sessions match the specified filters.");
    } else {
      console.log("No sessions found.");
    }
    return;
  }

  // Table header
  console.log(
    chalk.gray(
      `${"ID".padEnd(10)} ${"Status".padEnd(11)} ${"Type".padEnd(12)} ${"Agent".padEnd(20)} ${"Started".padEnd(16)} ${"Duration".padEnd(10)} ${"Events".padEnd(8)} ${"Iters".padEnd(7)} Tasks`,
    ),
  );
  console.log(chalk.gray("─".repeat(107)));

  for (const s of sessions) {
    const id = s.id.slice(0, 8);
    const colorFn = sessionStatusColor(s.status);
    const status = colorFn(s.status.padEnd(11));
    const sessionType =
      s.session_type === "invocation"
        ? chalk.cyan(s.session_type.padEnd(12))
        : chalk.gray(s.session_type.padEnd(12));
    const agent = s.agent_type.slice(0, 20).padEnd(20);
    const started = formatRelativeTime(new Date(s.started_at)).padEnd(16);
    const duration = formatDurationCompact(s.duration_ms).padEnd(10);
    const events = String(s.event_count).padEnd(8);
    const iters = String(s.iteration_count).padEnd(7);
    const tasks = String(s.tasks_completed);

    console.log(
      `${chalk.yellow(id)} ${status} ${sessionType} ${chalk.gray(agent)} ${chalk.gray(started)} ${duration} ${events} ${iters} ${tasks}`,
    );
  }

  // AC: @trait-filterable-list ac-7 — summary shows total matching items and filter state
  const totalCount = total ?? sessions.length;
  if (totalCount !== sessions.length) {
    console.log(chalk.gray(`\n${sessions.length} of ${totalCount} session(s)${filterInfo}`));
  } else {
    console.log(chalk.gray(`\n${totalCount} session(s)${filterInfo}`));
  }
}

/**
 * Session log list action handler.
 */
export async function sessionLogListAction(options: SessionLogListOptions): Promise<void> {
  try {
    const ctx = await initContext();
    // AC: @session-legacy-migration ac-read-fallback ac-list-merge — read only from primary, warn if legacy exists
    const allSessions = await getAllSessionLogSummaries(ctx.sessionsDir);
    await warnIfLegacySessions(ctx.specDir);

    // AC: @session-cli-unified-filtering ac-combined — apply shared filters (all AND'd)
    let sessions = filterSessions(allSessions, options);
    const totalFiltered = sessions.length;

    // AC: @session-log-list ac-5 - Sort
    const sortField: SortField =
      options.sort && VALID_SORT_FIELDS.includes(options.sort as SortField)
        ? (options.sort as SortField)
        : "started_at";
    sessions = sortSessions(sessions, sortField);

    // AC: @trait-filterable-list ac-8 — --count returns only the count
    if (options.count) {
      output({ count: totalFiltered }, () => {
        console.log(totalFiltered);
      });
      return;
    }

    // AC: @trait-filterable-list ac-4 — --offset skips first N items
    let offset = 0;
    if (options.offset) {
      offset = parseInt(options.offset, 10);
      if (!Number.isNaN(offset) && offset > 0) {
        sessions = sessions.slice(offset);
      }
    }

    // AC: @trait-filterable-list ac-3 — --limit shows at most N items
    if (options.limit) {
      const limit = parseInt(options.limit, 10);
      if (!Number.isNaN(limit) && limit > 0) {
        sessions = sessions.slice(0, limit);
      }
    }

    // AC: @session-cli-unified-filtering ac-json-output — structured JSON with filter criteria
    const activeFilters = getActiveSessionFilterDescriptions(options);
    const hasFilters = activeFilters.length > 0;
    const jsonOutput = {
      items: sessions,
      total: totalFiltered,
      offset,
      limit: options.limit ? parseInt(options.limit, 10) : null,
      ...(hasFilters
        ? {
            filters: {
              ...(options.status ? { status: options.status } : {}),
              ...((options.agent ?? options.agentType)
                ? { agent_type: options.agent ?? options.agentType }
                : {}),
              ...(options.agentId ? { agent_id: options.agentId } : {}),
              ...(options.trigger ? { trigger: options.trigger } : {}),
              ...(options.task ? { task_id: options.task } : {}),
              ...(options.since ? { since: options.since } : {}),
            },
          }
        : {}),
    };

    // AC: @trait-filterable-list ac-7 — summary shows total matching items and filter state
    output(jsonOutput, () => formatSessionLogList(sessions, totalFiltered, activeFilters));
  } catch (err) {
    error("Failed to list session logs", err);
    process.exit(EXIT_CODES.ERROR);
  }
}

// ─── Session Log Show ───────────────────────────────────────────────────────

interface SessionLogShowOptions {
  events?: boolean;
  text?: boolean;
  type?: string;
  limit?: string;
  context?: string;
  resolveBlobs?: boolean;
}

/**
 * Extract replayable assistant text from a top-level content block.
 * Text payloads may be plain strings or resolved blob pointers.
 */
function extractContentBlockText(block: unknown): string {
  if (!isObject(block) || block.type !== "text") {
    return "";
  }
  const textValue = block.text;
  if (typeof textValue === "string") {
    return textValue;
  }
  if (isObject(textValue) && typeof textValue.content === "string") {
    return textValue.content;
  }
  return "";
}

/**
 * Extract assistant text from a session.update payload.
 *
 * `session.update` payloads can carry content as:
 * - `data.content: ContentBlock[]` (full message events)
 * - `data.content: ContentBlock`   (chunk events)
 */
function extractReplayTextFromSessionUpdate(data: unknown): string {
  if (!isObject(data)) {
    return "";
  }
  const content = data.content;
  if (Array.isArray(content)) {
    return content.map((block) => extractContentBlockText(block)).join("");
  }
  return extractContentBlockText(content);
}

/**
 * Format an event timestamp as relative time from session start.
 */
function formatEventTimestamp(eventTs: number, sessionStartTs: number): string {
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
 *
 * AC: @session-model-evolution ac-7
 */
function summarizeEventData(event: SessionEvent): string {
  const data = event.data;
  if (!isObject(data)) return "";

  // Handle tool_call events
  if (event.type === "session.update") {
    const update = unwrapSessionUpdate(data as Record<string, unknown>);
    if (update && update.sessionUpdate === "tool_call") {
      const toolName = extractToolName(update);
      const rawInput = update.rawInput;
      if (isObject(rawInput) && typeof rawInput.command === "string") {
        const command = rawInput.command;
        const truncated = command.length > 60 ? `${command.slice(0, 57)}...` : command;
        return `${toolName}: ${truncated}`;
      }
      return toolName;
    }
  }

  // Handle prompt.sent events
  if (event.type === "prompt.sent") {
    const prompt = data.prompt;
    if (typeof prompt === "string" && prompt.length > 0) {
      const truncated = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
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

  // Handle agent.* events with human-readable summaries
  // AC: @session-model-evolution ac-7
  if (event.type === "agent.dispatched") {
    const taskId = data.task_id;
    return typeof taskId === "string" ? `Dispatched for ${taskId}` : "Agent dispatched";
  }
  if (event.type === "agent.started") {
    const taskId = data.task_id;
    return typeof taskId === "string" ? `Started work on ${taskId}` : "Agent started";
  }
  if (event.type === "agent.completed") {
    const taskId = data.task_id;
    const outcome = data.outcome;
    const durationMs = data.duration_ms;
    const parts: string[] = [];
    if (typeof taskId === "string") parts.push(taskId);
    if (typeof outcome === "string") parts.push(`outcome: ${outcome}`);
    if (typeof durationMs === "number") parts.push(`${formatDurationCompact(durationMs)}`);
    return parts.length > 0 ? parts.join(", ") : "Agent completed";
  }
  if (event.type === "agent.failed") {
    const taskId = data.task_id;
    const reason = data.reason;
    if (typeof taskId === "string" && typeof reason === "string") {
      return `${taskId}: ${reason}`;
    }
    return typeof reason === "string" ? reason : "Agent failed";
  }
  if (event.type === "agent.timeout") {
    const taskId = data.task_id;
    return typeof taskId === "string" ? `Timeout on ${taskId}` : "Agent timed out";
  }
  if (event.type === "agent.stalled") {
    const taskId = data.task_id;
    const stallTimeout = data.stall_timeout_seconds;
    if (typeof taskId === "string" && typeof stallTimeout === "number") {
      return `Stalled on ${taskId} (no response within ${stallTimeout}s)`;
    }
    return "Agent stalled (no initial response)";
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
 * AC: @session-model-evolution ac-6, ac-7
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
  // AC: @session-model-evolution ac-6 — show session type
  const sessionTypeDisplay =
    detail.session_type === "invocation"
      ? chalk.cyan(detail.session_type)
      : chalk.gray(detail.session_type);
  console.log(`  Type:      ${sessionTypeDisplay}`);
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
    console.log(`\n${chalk.bold("Iterations")}`);
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
      console.log(`  ${chalk.cyan(`[${iter.iteration}]`)} ${iter.event_count} events${taskStr}`);
    }
  }

  // AC: @session-log-show ac-3 - Event timeline
  if (events !== null) {
    console.log(`\n${chalk.bold("Events")}`);
    console.log(chalk.gray("─".repeat(60)));
    if (events.length === 0) {
      console.log(chalk.gray("  No events to display."));
    } else {
      for (const event of events) {
        const timestamp = formatEventTimestamp(event.ts, sessionStartTs);
        const summary = summarizeEventData(event);
        // AC: @session-model-evolution ac-7 — agent.* events use magenta for visibility
        const typeColor =
          event.type === "session.start" || event.type === "session.end"
            ? chalk.green
            : event.type === "session.update"
              ? chalk.blue
              : event.type.startsWith("agent.")
                ? chalk.magenta
                : chalk.gray;
        console.log(
          `  ${chalk.yellow(timestamp.padEnd(10))} ${typeColor(event.type.padEnd(20))} ${chalk.gray(summary)}`,
        );
      }
    }
  }

  // AC: @session-log-show ac-6 - Context snapshot
  if (contextSnapshot !== null) {
    console.log(`\n${chalk.bold("Context Snapshot")}`);
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

    // AC: @session-legacy-migration ac-read-fallback — read only from primary, warn if legacy exists
    await warnIfLegacySessions(ctx.specDir);

    // AC: @session-log-show ac-7, ac-8, ac-9 - Resolve session ID
    const resolution = await resolveSessionId(ctx.sessionsDir, sessionRef);

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
    const effectiveDir = ctx.sessionsDir;

    // Get session detail
    const detail = await getSessionLogDetail(effectiveDir, sessionId);
    if (!detail) {
      error(`Session not found: ${sessionId}`);
      process.exit(EXIT_CODES.NOT_FOUND);
    }

    if (options.resolveBlobs && !options.events && !options.text) {
      warn("--resolve-blobs has no effect without --events; showing metadata only.");
    }

    // AC: @session-log-show ac-3, ac-4, ac-5 - Event timeline
    let events: SessionEvent[] | null = null;
    if (options.events) {
      let allEvents = deduplicatePhasedToolCalls(await readEvents(effectiveDir, sessionId));

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
            data: await resolveSessionBlobPointers(effectiveDir, sessionId, event.data),
          })),
        );
      }

      events = allEvents;
    }

    // AC: @session-log-show ac-11 - Replay assistant text from session.update content blocks
    let replayText: string | null = null;
    if (options.text) {
      const allEvents = await readEvents(effectiveDir, sessionId);
      const chunks: string[] = [];
      for (const event of allEvents) {
        if (event.type !== "session.update") {
          continue;
        }
        const resolvedData = await resolveSessionBlobPointers(effectiveDir, sessionId, event.data);
        const textChunk = extractReplayTextFromSessionUpdate(resolvedData);
        if (textChunk.length > 0) {
          chunks.push(textChunk);
        }
      }
      replayText = chunks.join("");
    }

    // AC: @session-log-show ac-6 - Context snapshot
    let contextSnapshot: unknown = null;
    if (options.context) {
      const iterNum = parseInt(options.context, 10);
      if (!Number.isNaN(iterNum) && iterNum > 0) {
        contextSnapshot = await readSessionContext(effectiveDir, sessionId, iterNum);
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
      ...(replayText !== null ? { text: replayText } : {}),
      ...(contextSnapshot !== null ? { context: contextSnapshot } : {}),
    };

    output(jsonOutput, () => {
      // In text mode, `--text` alone behaves like a raw replay stream.
      if (options.text && !options.events && !options.context && !isStructuredMode()) {
        process.stdout.write(replayText ?? "");
        return;
      }

      formatSessionLogShow(detail, events, contextSnapshot, sessionStartTs);

      // Keep --events/--context independent from --text in text mode.
      if (
        options.text &&
        !isStructuredMode() &&
        (options.events || options.context) &&
        (replayText?.length ?? 0) > 0
      ) {
        process.stdout.write(`\n${replayText}`);
      }
    });
  } catch (err) {
    error("Failed to show session log", err);
    process.exit(EXIT_CODES.ERROR);
  }
}

// ─── Session Log Stats ──────────────────────────────────────────────────────

interface SessionLogStatsOptions extends SessionFilterOptions {
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
  console.log(`\n${chalk.bold("Averages")}`);
  console.log(chalk.gray("─".repeat(50)));
  console.log(`  Avg Duration/Session:     ${formatDurationVerbose(stats.avg_duration_ms)}`);
  console.log(`  Avg Iterations/Session:   ${stats.avg_iterations_per_session}`);
  console.log(`  Avg Tasks/Session:        ${stats.avg_tasks_per_session}`);

  // AC: @session-log-stats ac-3 - Status breakdown
  if (stats.status_breakdown.length > 0) {
    console.log(`\n${chalk.bold("Status Breakdown")}`);
    console.log(chalk.gray("─".repeat(50)));
    for (const item of stats.status_breakdown) {
      console.log(
        `  ${sessionStatusColor(item.status)(item.status.padEnd(12))} ${String(item.count).padEnd(6)} ${item.percentage}%`,
      );
    }
  }

  // AC: @session-log-stats ac-6 - Tool usage
  if (toolUsage !== null && toolUsage.length > 0) {
    console.log(`\n${chalk.bold("Top Tool Usage")}`);
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
    console.log(`\n${chalk.bold(label)}`);
    console.log(chalk.gray("─".repeat(50)));
    console.log(
      chalk.gray(`  ${"Period".padEnd(14)} ${"Sessions".padEnd(10)} ${"Tasks".padEnd(8)} Duration`),
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
export async function sessionLogStatsAction(options: SessionLogStatsOptions): Promise<void> {
  try {
    const ctx = await initContext();
    // AC: @session-legacy-migration ac-read-fallback ac-list-merge — read only from primary, warn if legacy exists
    const allSessions = await getAllSessionLogSummaries(ctx.sessionsDir);
    await warnIfLegacySessions(ctx.specDir);

    // Use shared filter logic
    const sessions = filterSessions(allSessions, options);

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
      toolUsage = await computeToolUsageStats(ctx.sessionsDir, sessionIds);
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

    output(jsonOutput, () => formatSessionLogStats(stats, toolUsage, timePeriods, groupBy));
  } catch (err) {
    error("Failed to compute session log stats", err);
    process.exit(EXIT_CODES.ERROR);
  }
}

// ─── Session Log Search ─────────────────────────────────────────────────────

interface SessionLogSearchOptions extends SessionFilterOptions {
  type?: string;
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
        `${chalk.gray(`(${session.agent_type}, started ${formatRelativeTime(new Date(session.started_at))})`)}`,
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
      console.log(`  ${chalk.yellow(ts)} ${typeColor(match.event_type.padEnd(16))}`);
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

    // AC: @session-legacy-migration ac-read-fallback — read only from primary, warn if legacy exists
    await warnIfLegacySessions(ctx.specDir);

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

    // AC: @session-text-search ac-scope-narrowing — apply metadata filters before scanning events
    const allSummaries = await getAllSessionLogSummaries(ctx.sessionsDir);
    const filteredSummaries = filterSessions(allSummaries, options);

    // AC: @session-log-search ac-1, ac-2, ac-3, ac-5, ac-7
    const results = await searchSessionEvents(ctx.sessionsDir, pattern, {
      eventType: options.type,
      sessionSummaries: filteredSummaries,
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
