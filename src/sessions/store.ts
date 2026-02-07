/**
 * Session event storage.
 *
 * JSONL-based event storage for agent sessions with:
 * - Atomic appends for crash safety (AC-3)
 * - Auto-assigned timestamps and sequence numbers (AC-2)
 * - Session metadata management
 *
 * Storage structure:
 *   .kspec/sessions/{session-id}/
 *     session.yaml      # Metadata
 *     events.jsonl      # Append-only event log
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  type SessionEvent,
  type SessionEventInput,
  SessionEventSchema,
  type SessionMetadata,
  type SessionMetadataInput,
  SessionMetadataSchema,
  type SessionStatus,
} from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const SESSIONS_DIR = "sessions";
const METADATA_FILE = "session.yaml";
const EVENTS_FILE = "events.jsonl";

// ─── Path Helpers ────────────────────────────────────────────────────────────

/**
 * Get the sessions directory path within a spec directory.
 */
export function getSessionsDir(specDir: string): string {
  return path.join(specDir, SESSIONS_DIR);
}

/**
 * Get the path to a specific session's directory.
 */
export function getSessionDir(specDir: string, sessionId: string): string {
  return path.join(getSessionsDir(specDir), sessionId);
}

/**
 * Get the path to a session's metadata file.
 */
export function getSessionMetadataPath(
  specDir: string,
  sessionId: string,
): string {
  return path.join(getSessionDir(specDir, sessionId), METADATA_FILE);
}

/**
 * Get the path to a session's events file.
 */
export function getSessionEventsPath(
  specDir: string,
  sessionId: string,
): string {
  return path.join(getSessionDir(specDir, sessionId), EVENTS_FILE);
}

/**
 * Get the path to a session's context snapshot file for a given iteration.
 */
export function getSessionContextPath(
  specDir: string,
  sessionId: string,
  iteration: number,
): string {
  return path.join(
    getSessionDir(specDir, sessionId),
    `context-iter-${iteration}.json`,
  );
}

// ─── Session CRUD ────────────────────────────────────────────────────────────

/**
 * Create a new session with metadata.
 *
 * AC-1: Creates .kspec/sessions/{id}/ directory with session.yaml metadata file.
 * AC-5: Metadata includes task_id (optional), agent_type, status, started_at, ended_at.
 *
 * @param specDir - The .kspec directory path
 * @param input - Session metadata input
 * @returns The created session metadata
 */
export async function createSession(
  specDir: string,
  input: SessionMetadataInput,
): Promise<SessionMetadata> {
  const sessionDir = getSessionDir(specDir, input.id);
  const metadataPath = getSessionMetadataPath(specDir, input.id);

  // Create session directory
  await fsPromises.mkdir(sessionDir, { recursive: true });

  // Build full metadata
  const metadata: SessionMetadata = {
    id: input.id,
    task_id: input.task_id,
    agent_type: input.agent_type,
    status: input.status ?? "active",
    started_at: input.started_at ?? new Date().toISOString(),
    ended_at: undefined,
  };

  // Validate and write metadata
  const validated = SessionMetadataSchema.parse(metadata);
  const content = YAML.stringify(validated, {
    indent: 2,
    lineWidth: 100,
    sortMapEntries: false,
  });
  await fsPromises.writeFile(metadataPath, content, "utf-8");

  return validated;
}

/**
 * Read session metadata.
 *
 * @param specDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns Session metadata or null if not found
 */
export async function getSession(
  specDir: string,
  sessionId: string,
): Promise<SessionMetadata | null> {
  const metadataPath = getSessionMetadataPath(specDir, sessionId);

  try {
    const content = await fsPromises.readFile(metadataPath, "utf-8");
    const raw = YAML.parse(content);
    return SessionMetadataSchema.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Update session status.
 *
 * AC-6: Updates metadata with status and ended_at timestamp when session ends.
 *
 * @param specDir - The .kspec directory path
 * @param sessionId - Session ID
 * @param status - New status
 * @returns Updated metadata or null if session not found
 */
export async function updateSessionStatus(
  specDir: string,
  sessionId: string,
  status: SessionStatus,
): Promise<SessionMetadata | null> {
  const metadata = await getSession(specDir, sessionId);
  if (!metadata) {
    return null;
  }

  // Update status and ended_at if transitioning away from active
  const updated: SessionMetadata = {
    ...metadata,
    status,
    ended_at:
      status !== "active" ? new Date().toISOString() : metadata.ended_at,
  };

  const metadataPath = getSessionMetadataPath(specDir, sessionId);
  const content = YAML.stringify(updated, {
    indent: 2,
    lineWidth: 100,
    sortMapEntries: false,
  });
  await fsPromises.writeFile(metadataPath, content, "utf-8");

  return updated;
}

/**
 * List all sessions.
 *
 * @param specDir - The .kspec directory path
 * @returns Array of session IDs
 */
export async function listSessions(specDir: string): Promise<string[]> {
  const sessionsDir = getSessionsDir(specDir);

  try {
    const entries = await fsPromises.readdir(sessionsDir, {
      withFileTypes: true,
    });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Check if a session exists.
 */
export async function sessionExists(
  specDir: string,
  sessionId: string,
): Promise<boolean> {
  const metadataPath = getSessionMetadataPath(specDir, sessionId);
  try {
    await fsPromises.access(metadataPath);
    return true;
  } catch {
    return false;
  }
}

// ─── Event Storage ───────────────────────────────────────────────────────────

/**
 * Get the current event count for a session (for seq assignment).
 *
 * @param specDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns Number of events in the session
 */
async function getEventCount(
  specDir: string,
  sessionId: string,
): Promise<number> {
  const eventsPath = getSessionEventsPath(specDir, sessionId);

  try {
    const content = await fsPromises.readFile(eventsPath, "utf-8");
    const lines = content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    return lines.length;
  } catch {
    return 0;
  }
}

/**
 * Append an event to a session's event log.
 *
 * AC-2: Appends JSON line to events.jsonl with auto-assigned ts and seq.
 * AC-3: Uses atomic append (appendFileSync) for crash safety.
 *
 * Creates the session directory if it doesn't exist (lazy creation).
 *
 * Note: This function is not safe for concurrent access to the same session.
 * The sequence number assignment has a race condition between reading the
 * event count and appending the event. This is acceptable for CLI use
 * (single-process, sequential event logging). If concurrent access is needed
 * in the future, consider file locking or an in-memory counter per session.
 *
 * @param specDir - The .kspec directory path
 * @param input - Event input (ts and seq are auto-assigned if not provided)
 * @returns The appended event with auto-assigned fields
 */
export async function appendEvent(
  specDir: string,
  input: SessionEventInput,
): Promise<SessionEvent> {
  const sessionDir = getSessionDir(specDir, input.session_id);
  const eventsPath = getSessionEventsPath(specDir, input.session_id);

  // Ensure session directory exists (lazy creation)
  await fsPromises.mkdir(sessionDir, { recursive: true });

  // Get current event count for seq assignment
  const seq = input.seq ?? (await getEventCount(specDir, input.session_id));

  // Build full event
  const event: SessionEvent = {
    ts: input.ts ?? Date.now(),
    seq,
    type: input.type,
    session_id: input.session_id,
    trace_id: input.trace_id,
    data: input.data,
  };

  // Validate event
  const validated = SessionEventSchema.parse(event);

  // AC: @session-events ac-3 - Use synchronous append for crash safety
  // This ensures the line is fully written before returning
  const line = `${JSON.stringify(validated)}\n`;
  fs.appendFileSync(eventsPath, line, "utf-8");

  return validated;
}

/**
 * Read all events from a session.
 *
 * AC-4: Returns all events in sequence order.
 *
 * @param specDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns Array of events sorted by sequence number
 */
export async function readEvents(
  specDir: string,
  sessionId: string,
): Promise<SessionEvent[]> {
  const eventsPath = getSessionEventsPath(specDir, sessionId);

  try {
    const content = await fsPromises.readFile(eventsPath, "utf-8");
    const lines = content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    const events: SessionEvent[] = [];
    for (const line of lines) {
      try {
        const raw = JSON.parse(line);
        const event = SessionEventSchema.parse(raw);
        events.push(event);
      } catch {
        // Skip invalid lines
      }
    }

    // AC: @session-events ac-4 - Sort by sequence number
    return events.sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

/**
 * Read events within a time range.
 *
 * @param specDir - The .kspec directory path
 * @param sessionId - Session ID
 * @param since - Start timestamp (inclusive)
 * @param until - End timestamp (inclusive)
 * @returns Array of events within the time range
 */
export async function readEventsSince(
  specDir: string,
  sessionId: string,
  since: number,
  until?: number,
): Promise<SessionEvent[]> {
  const events = await readEvents(specDir, sessionId);
  return events.filter((e) => {
    if (e.ts < since) return false;
    if (until !== undefined && e.ts > until) return false;
    return true;
  });
}

/**
 * Get the last event in a session.
 *
 * @param specDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns The last event or null if no events
 */
export async function getLastEvent(
  specDir: string,
  sessionId: string,
): Promise<SessionEvent | null> {
  const events = await readEvents(specDir, sessionId);
  if (events.length === 0) {
    return null;
  }
  return events[events.length - 1];
}

// ─── Session Log Summaries ───────────────────────────────────────────────────

/**
 * Summary data for a session, used by `session log list`.
 */
export interface SessionLogSummary {
  /** Session ID */
  id: string;
  /** Session status */
  status: SessionStatus;
  /** Agent type */
  agent_type: string;
  /** When session started (ISO 8601) */
  started_at: string;
  /** When session ended (ISO 8601), if completed */
  ended_at?: string;
  /** Duration in milliseconds (computed from started_at/ended_at or now) */
  duration_ms: number;
  /** Number of events in events.jsonl */
  event_count: number;
  /** Number of context-iter-*.json files (iteration count) */
  iteration_count: number;
  /** Number of tasks completed during the session */
  tasks_completed: number;
}

/**
 * Count lines in events.jsonl without parsing JSON.
 * Much faster than readEvents() for large files.
 */
async function countEventLines(
  specDir: string,
  sessionId: string,
): Promise<number> {
  const eventsPath = getSessionEventsPath(specDir, sessionId);
  try {
    const content = await fsPromises.readFile(eventsPath, "utf-8");
    if (!content.trim()) return 0;
    return content.trim().split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Count context-iter-*.json files for a session (iteration count).
 */
async function countIterations(
  specDir: string,
  sessionId: string,
): Promise<number> {
  const sessionDir = getSessionDir(specDir, sessionId);
  try {
    const entries = await fsPromises.readdir(sessionDir);
    return entries.filter(
      (e) => e.startsWith("context-iter-") && e.endsWith(".json"),
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Count task completions by scanning events for tool calls that invoke
 * `kspec task complete` or `npm run dev -- task complete`.
 *
 * Real sessions record task completions as session.update events with
 * sessionUpdate: "tool_call" and rawInput.command containing the complete command.
 * We use a fast substring check before JSON parsing for performance.
 */
async function countTaskCompletions(
  specDir: string,
  sessionId: string,
): Promise<number> {
  const eventsPath = getSessionEventsPath(specDir, sessionId);
  try {
    const content = await fsPromises.readFile(eventsPath, "utf-8");
    if (!content.trim()) return 0;
    const lines = content.trim().split("\n");
    let count = 0;
    for (const line of lines) {
      // Quick substring pre-filter: only parse lines that might contain task complete commands
      if (!line.includes("task complete")) continue;
      // Must be a tool_call event (session.update with sessionUpdate: "tool_call")
      if (!line.includes('"tool_call"')) continue;
      try {
        const event = JSON.parse(line);
        const command = event?.data?.update?.rawInput?.command;
        if (typeof command === "string" && /\btask complete\b/.test(command)) {
          count++;
        }
      } catch {
        // Skip unparseable lines
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Get a summary of a single session for list display.
 *
 * Gathers metadata and computes metrics lazily (only parses what's needed).
 *
 * @param specDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns Session summary or null if session doesn't exist
 */
export async function getSessionLogSummary(
  specDir: string,
  sessionId: string,
): Promise<SessionLogSummary | null> {
  const metadata = await getSession(specDir, sessionId);
  if (!metadata) return null;

  const [eventCount, iterationCount, tasksCompleted] = await Promise.all([
    countEventLines(specDir, sessionId),
    countIterations(specDir, sessionId),
    countTaskCompletions(specDir, sessionId),
  ]);

  const startMs = new Date(metadata.started_at).getTime();
  const endMs = metadata.ended_at
    ? new Date(metadata.ended_at).getTime()
    : Date.now();
  const durationMs = endMs - startMs;

  return {
    id: metadata.id,
    status: metadata.status,
    agent_type: metadata.agent_type,
    started_at: metadata.started_at,
    ended_at: metadata.ended_at,
    duration_ms: durationMs,
    event_count: eventCount,
    iteration_count: iterationCount,
    tasks_completed: tasksCompleted,
  };
}

/**
 * Get summaries for all sessions.
 *
 * @param specDir - The .kspec directory path
 * @returns Array of session summaries
 */
export async function getAllSessionLogSummaries(
  specDir: string,
): Promise<SessionLogSummary[]> {
  const sessionIds = await listSessions(specDir);
  const summaries = await Promise.all(
    sessionIds.map((id) => getSessionLogSummary(specDir, id)),
  );
  return summaries.filter((s): s is SessionLogSummary => s !== null);
}

// ─── Context Snapshots ───────────────────────────────────────────────────────

/**
 * Save session context snapshot for a given iteration.
 *
 * This creates an audit trail of what context the agent saw at each iteration,
 * useful for debugging and reviewing agent behavior.
 *
 * @param specDir - The .kspec directory path
 * @param sessionId - Session ID
 * @param iteration - Iteration number
 * @param context - The session context data
 */
export async function saveSessionContext(
  specDir: string,
  sessionId: string,
  iteration: number,
  context: unknown,
): Promise<void> {
  const sessionDir = getSessionDir(specDir, sessionId);
  const contextPath = getSessionContextPath(specDir, sessionId, iteration);

  // Ensure session directory exists
  await fsPromises.mkdir(sessionDir, { recursive: true });

  // Write context snapshot as pretty JSON
  const content = JSON.stringify(context, null, 2);
  await fsPromises.writeFile(contextPath, content, "utf-8");
}

/**
 * Read session context snapshot for a given iteration.
 *
 * @param specDir - The .kspec directory path
 * @param sessionId - Session ID
 * @param iteration - Iteration number
 * @returns The context snapshot or null if not found
 */
export async function readSessionContext(
  specDir: string,
  sessionId: string,
  iteration: number,
): Promise<unknown | null> {
  const contextPath = getSessionContextPath(specDir, sessionId, iteration);

  try {
    const content = await fsPromises.readFile(contextPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ─── Session ID Resolution ───────────────────────────────────────────────────

/**
 * Result of resolving a session ID prefix.
 */
export type SessionIdResolution =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "ambiguous"; matches: string[] };

/**
 * Resolve a session ID or prefix to a full session ID.
 *
 * AC: @session-log-show ac-7, ac-8, ac-9
 *
 * @param specDir - The .kspec directory path
 * @param idOrPrefix - Full session ID or prefix (e.g., first 8 chars)
 * @returns Resolution result
 */
export async function resolveSessionId(
  specDir: string,
  idOrPrefix: string,
): Promise<SessionIdResolution> {
  const sessionIds = await listSessions(specDir);

  // First, try exact match
  if (sessionIds.includes(idOrPrefix)) {
    return { ok: true, id: idOrPrefix };
  }

  // Try prefix match
  const matches = sessionIds.filter((id) => id.startsWith(idOrPrefix));

  if (matches.length === 0) {
    return { ok: false, error: "not_found" };
  }

  if (matches.length === 1) {
    return { ok: true, id: matches[0] };
  }

  // Ambiguous - multiple matches
  return { ok: false, error: "ambiguous", matches };
}

// ─── Session Detail Data ─────────────────────────────────────────────────────

/**
 * Per-iteration summary for session log show.
 */
export interface IterationSummary {
  /** Iteration number (1-indexed) */
  iteration: number;
  /** Number of events in this iteration */
  event_count: number;
  /** Tasks started in this iteration */
  tasks_started: string[];
  /** Tasks completed in this iteration */
  tasks_completed: string[];
}

/**
 * Full session detail data for session log show.
 */
export interface SessionLogDetail {
  /** Session metadata */
  id: string;
  status: SessionStatus;
  agent_type: string;
  task_id?: string;
  started_at: string;
  ended_at?: string;
  duration_ms: number;
  /** Total event count */
  event_count: number;
  /** Total iteration count */
  iteration_count: number;
  /** Per-iteration summaries */
  iterations: IterationSummary[];
}

/**
 * Get iteration number from a context snapshot file.
 */
async function getIterationNumbers(
  specDir: string,
  sessionId: string,
): Promise<number[]> {
  const sessionDir = getSessionDir(specDir, sessionId);
  try {
    const entries = await fsPromises.readdir(sessionDir);
    const iterations: number[] = [];
    for (const entry of entries) {
      const match = entry.match(/^context-iter-(\d+)\.json$/);
      if (match) {
        iterations.push(parseInt(match[1], 10));
      }
    }
    return iterations.sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Extract task refs from task commands in event data.
 */
function extractTaskRef(command: string): string | null {
  // Match patterns like: kspec task start @ref, kspec task complete @ref
  const match = command.match(/@[\w-]+/);
  return match ? match[0] : null;
}

/**
 * Compute per-iteration summaries from events.
 *
 * Dynamically creates iteration buckets based on both context snapshot files
 * AND event data to handle cases where events are logged before context
 * snapshots exist (e.g., active sessions).
 *
 * AC: @session-log-show ac-2
 */
async function computeIterationSummaries(
  specDir: string,
  sessionId: string,
): Promise<IterationSummary[]> {
  const events = await readEvents(specDir, sessionId);
  const snapshotIterations = await getIterationNumbers(specDir, sessionId);

  // Collect all iteration numbers from both snapshots and events
  const allIterations = new Set<number>(snapshotIterations);
  for (const event of events) {
    const data = event.data as { iteration?: number } | null;
    if (typeof data?.iteration === "number") {
      allIterations.add(data.iteration);
    }
  }

  // If no iterations found anywhere, create a single iteration-0 summary
  if (allIterations.size === 0) {
    return [
      {
        iteration: 0,
        event_count: events.length,
        tasks_started: [],
        tasks_completed: [],
      },
    ];
  }

  // Create buckets for all known iterations
  const iterations = Array.from(allIterations).sort((a, b) => a - b);
  const iterationMap = new Map<number, SessionEvent[]>();
  for (const n of iterations) {
    iterationMap.set(n, []);
  }

  for (const event of events) {
    // Try to get iteration from event data
    const data = event.data as { iteration?: number } | null;
    const iter = data?.iteration;
    if (typeof iter === "number" && iterationMap.has(iter)) {
      iterationMap.get(iter)!.push(event);
    } else {
      // Events without iteration info (lifecycle events) go to iteration 0
      // or the first known iteration if 0 doesn't exist
      const fallbackIter = iterationMap.has(0) ? 0 : iterations[0];
      iterationMap.get(fallbackIter)!.push(event);
    }
  }

  const summaries: IterationSummary[] = [];
  for (const [iterNum, iterEvents] of iterationMap) {
    const tasksStarted: string[] = [];
    const tasksCompleted: string[] = [];

    for (const event of iterEvents) {
      if (event.type === "session.update") {
        const data = event.data as {
          update?: {
            sessionUpdate?: string;
            rawInput?: { command?: string };
          };
        } | null;
        const command = data?.update?.rawInput?.command;
        if (typeof command === "string") {
          if (/\btask start\b/.test(command)) {
            const ref = extractTaskRef(command);
            if (ref) tasksStarted.push(ref);
          } else if (/\btask complete\b/.test(command)) {
            const ref = extractTaskRef(command);
            if (ref) tasksCompleted.push(ref);
          }
        }
      }
    }

    summaries.push({
      iteration: iterNum,
      event_count: iterEvents.length,
      tasks_started: tasksStarted,
      tasks_completed: tasksCompleted,
    });
  }

  return summaries.sort((a, b) => a.iteration - b.iteration);
}

/**
 * Get full session detail for session log show.
 *
 * @param specDir - The .kspec directory path
 * @param sessionId - Session ID (must be resolved first)
 * @returns Session detail or null if not found
 */
export async function getSessionLogDetail(
  specDir: string,
  sessionId: string,
): Promise<SessionLogDetail | null> {
  const metadata = await getSession(specDir, sessionId);
  if (!metadata) return null;

  const [eventCount, iterationCount, iterations] = await Promise.all([
    countEventLines(specDir, sessionId),
    countIterations(specDir, sessionId),
    computeIterationSummaries(specDir, sessionId),
  ]);

  const startMs = new Date(metadata.started_at).getTime();
  const endMs = metadata.ended_at
    ? new Date(metadata.ended_at).getTime()
    : Date.now();
  const durationMs = endMs - startMs;

  return {
    id: metadata.id,
    status: metadata.status,
    agent_type: metadata.agent_type,
    task_id: metadata.task_id,
    started_at: metadata.started_at,
    ended_at: metadata.ended_at,
    duration_ms: durationMs,
    event_count: eventCount,
    iteration_count: iterationCount,
    iterations,
  };
}

// ─── Session Log Stats ───────────────────────────────────────────────────────

/**
 * Aggregate session statistics.
 *
 * AC: @session-log-stats ac-1, ac-2, ac-3
 */
export interface SessionLogStats {
  /** Total number of sessions */
  total_sessions: number;
  /** Total events across all sessions */
  total_events: number;
  /** Total iterations across all sessions */
  total_iterations: number;
  /** Total tasks completed across all sessions */
  total_tasks_completed: number;
  /** Total duration in milliseconds */
  total_duration_ms: number;

  /** Average duration per session in milliseconds */
  avg_duration_ms: number;
  /** Average iterations per session */
  avg_iterations_per_session: number;
  /** Average tasks completed per session */
  avg_tasks_per_session: number;

  /** Status breakdown with counts and percentages */
  status_breakdown: {
    status: SessionStatus;
    count: number;
    percentage: number;
  }[];
}

/**
 * Tool usage statistics.
 *
 * AC: @session-log-stats ac-6
 */
export interface ToolUsageStats {
  tool_name: string;
  count: number;
  percentage: number;
}

/**
 * Time period stats for --by-day or --by-week.
 *
 * AC: @session-log-stats ac-7
 */
export interface TimePeriodStats {
  period: string;
  sessions_count: number;
  tasks_completed: number;
  total_duration_ms: number;
}

/**
 * Compute aggregate statistics from session summaries.
 *
 * @param summaries - Array of session log summaries
 * @returns Aggregate statistics
 */
export function computeSessionLogStats(
  summaries: SessionLogSummary[],
): SessionLogStats {
  if (summaries.length === 0) {
    return {
      total_sessions: 0,
      total_events: 0,
      total_iterations: 0,
      total_tasks_completed: 0,
      total_duration_ms: 0,
      avg_duration_ms: 0,
      avg_iterations_per_session: 0,
      avg_tasks_per_session: 0,
      status_breakdown: [],
    };
  }

  // Compute totals
  let totalEvents = 0;
  let totalIterations = 0;
  let totalTasksCompleted = 0;
  let totalDuration = 0;
  const statusCounts: Record<SessionStatus, number> = {
    active: 0,
    completed: 0,
    abandoned: 0,
  };

  for (const s of summaries) {
    totalEvents += s.event_count;
    totalIterations += s.iteration_count;
    totalTasksCompleted += s.tasks_completed;
    totalDuration += s.duration_ms;
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
  }

  const n = summaries.length;

  // Build status breakdown
  const statusBreakdown: { status: SessionStatus; count: number; percentage: number }[] = [];
  for (const status of ["completed", "active", "abandoned"] as SessionStatus[]) {
    const count = statusCounts[status] || 0;
    if (count > 0) {
      statusBreakdown.push({
        status,
        count,
        percentage: Math.round((count / n) * 100 * 10) / 10, // 1 decimal place
      });
    }
  }

  return {
    total_sessions: n,
    total_events: totalEvents,
    total_iterations: totalIterations,
    total_tasks_completed: totalTasksCompleted,
    total_duration_ms: totalDuration,
    avg_duration_ms: Math.round(totalDuration / n),
    avg_iterations_per_session: Math.round((totalIterations / n) * 10) / 10,
    avg_tasks_per_session: Math.round((totalTasksCompleted / n) * 10) / 10,
    status_breakdown: statusBreakdown,
  };
}

/**
 * Count tool calls by scanning events.jsonl for tool_call events.
 *
 * This is relatively expensive as it parses all events, so only call
 * when --tool-usage is requested.
 *
 * AC: @session-log-stats ac-6
 */
export async function computeToolUsageStats(
  specDir: string,
  sessionIds: string[],
  limit: number = 10,
): Promise<ToolUsageStats[]> {
  const toolCounts: Record<string, number> = {};
  let totalToolCalls = 0;

  for (const sessionId of sessionIds) {
    const eventsPath = getSessionEventsPath(specDir, sessionId);
    try {
      const content = await fsPromises.readFile(eventsPath, "utf-8");
      if (!content.trim()) continue;
      const lines = content.trim().split("\n");
      for (const line of lines) {
        // Quick pre-filter: only parse lines that might be tool_call events
        if (!line.includes('"tool_call"')) continue;
        try {
          const event = JSON.parse(line);
          if (event?.type === "session.update") {
            const update = event?.data?.update;
            if (update?.sessionUpdate === "tool_call") {
              const toolName = update?._meta?.claudeCode?.toolName || "unknown";
              toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
              totalToolCalls++;
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    } catch {
      // Skip sessions without events
    }
  }

  // Sort by count descending, take top N
  const sorted = Object.entries(toolCounts)
    .map(([tool_name, count]) => ({
      tool_name,
      count,
      percentage: totalToolCalls > 0
        ? Math.round((count / totalToolCalls) * 100 * 10) / 10
        : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return sorted;
}

/**
 * Compute ISO-8601 week number and week-year in UTC.
 *
 * ISO-8601 rules:
 * - Week 1 contains the first Thursday of the year
 * - Week starts on Monday
 * - Week-year may differ from calendar year at year boundaries
 *
 * Returns [weekYear, weekNumber] tuple.
 */
function getISOWeekUTC(date: Date): [number, number] {
  // Clone and normalize to UTC midnight
  const d = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));

  // Get day of week (ISO: Monday=1, Sunday=7)
  const dayOfWeek = d.getUTCDay() || 7;

  // Set to nearest Thursday (determines week-year)
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);

  // Week-year is the year of this Thursday
  const weekYear = d.getUTCFullYear();

  // January 4 is always in week 1 (as it's in the first week with a Thursday)
  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const jan4DayOfWeek = jan4.getUTCDay() || 7;

  // Start of week 1 (Monday before or on Jan 4)
  const week1Start = new Date(jan4);
  week1Start.setUTCDate(jan4.getUTCDate() - (jan4DayOfWeek - 1));

  // Week number = weeks between week 1 start and the Thursday we found
  const weekNum = Math.floor((d.getTime() - week1Start.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;

  return [weekYear, weekNum];
}

/**
 * Group sessions by time period (day or week).
 *
 * AC: @session-log-stats ac-7
 */
export function computeTimePeriodStats(
  summaries: SessionLogSummary[],
  groupBy: "day" | "week",
): TimePeriodStats[] {
  const buckets: Record<string, { sessions: number; tasks: number; duration: number }> = {};

  for (const s of summaries) {
    const date = new Date(s.started_at);
    let period: string;

    if (groupBy === "day") {
      period = date.toISOString().split("T")[0]; // YYYY-MM-DD in UTC
    } else {
      // Week: use ISO-8601 week format (YYYY-Www) in UTC
      const [weekYear, weekNum] = getISOWeekUTC(date);
      period = `${weekYear}-W${weekNum.toString().padStart(2, "0")}`;
    }

    if (!buckets[period]) {
      buckets[period] = { sessions: 0, tasks: 0, duration: 0 };
    }
    buckets[period].sessions += 1;
    buckets[period].tasks += s.tasks_completed;
    buckets[period].duration += s.duration_ms;
  }

  // Convert to array and sort by period (newest first for display)
  const result: TimePeriodStats[] = Object.entries(buckets)
    .map(([period, data]) => ({
      period,
      sessions_count: data.sessions,
      tasks_completed: data.tasks,
      total_duration_ms: data.duration,
    }))
    .sort((a, b) => b.period.localeCompare(a.period));

  return result;
}

// ─── Session Log Search ───────────────────────────────────────────────────────

/**
 * A single search match result.
 *
 * AC: @session-log-search ac-4
 */
export interface SearchMatch {
  /** Session ID */
  session_id: string;
  /** Event timestamp (Unix ms) */
  timestamp: number;
  /** Event type */
  event_type: string;
  /** Matching content excerpt (limited to 200 chars) */
  content_excerpt: string;
}

/**
 * Search results grouped by session.
 */
export interface SessionSearchResult {
  /** Session ID */
  session_id: string;
  /** Agent type for this session */
  agent_type: string;
  /** When the session started */
  started_at: string;
  /** Matches found in this session */
  matches: SearchMatch[];
}

/**
 * Search options for filtering sessions and events.
 */
export interface SearchOptions {
  /** Only search events of this type (e.g., 'session.update', 'prompt.sent') */
  eventType?: string;
  /** Only search sessions started after this date */
  sinceDate?: Date;
  /** Only search sessions with this agent type */
  agentType?: string;
  /** Maximum total matches to return (default: 50) */
  limit?: number;
}

/**
 * Extract a content excerpt around a match, limited to maxLength chars.
 *
 * AC: @session-log-search ac-4
 */
function extractContentExcerpt(
  data: unknown,
  pattern: string,
  maxLength: number = 200,
): string {
  // Stringify the data for searching
  const str = JSON.stringify(data);
  const lowerStr = str.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  const matchIndex = lowerStr.indexOf(lowerPattern);
  if (matchIndex === -1) {
    // Shouldn't happen since we pre-filtered, but return start of content
    return str.length > maxLength ? str.slice(0, maxLength - 3) + "..." : str;
  }

  // Calculate excerpt window centered on match
  const matchLen = pattern.length;
  const contextBefore = Math.floor((maxLength - matchLen) / 2);
  const start = Math.max(0, matchIndex - contextBefore);
  const end = Math.min(str.length, start + maxLength);

  let excerpt = str.slice(start, end);

  // Add ellipsis indicators
  if (start > 0) {
    excerpt = "..." + excerpt.slice(3);
  }
  if (end < str.length) {
    excerpt = excerpt.slice(0, -3) + "...";
  }

  return excerpt;
}

/**
 * Search across session events for a pattern.
 *
 * This streams through events.jsonl files, applying filters as early as possible
 * for performance. Sessions are pre-filtered by metadata (--since, --agent) before
 * scanning events to reduce I/O.
 *
 * AC: @session-log-search ac-1, ac-2, ac-3, ac-5, ac-7
 *
 * @param specDir - The .kspec directory path
 * @param pattern - Case-insensitive substring to search for
 * @param options - Search filtering options
 * @returns Array of search results grouped by session
 */
export async function searchSessionEvents(
  specDir: string,
  pattern: string,
  options: SearchOptions = {},
): Promise<SessionSearchResult[]> {
  // Defense-in-depth: normalize limit to a valid positive integer
  const rawLimit = options.limit ?? 50;
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 50 : rawLimit;
  const lowerPattern = pattern.toLowerCase();

  // Get all session summaries for metadata filtering
  const allSummaries = await getAllSessionLogSummaries(specDir);

  // AC: @session-log-search ac-3 - Pre-filter by --since
  let filteredSummaries = allSummaries;
  if (options.sinceDate) {
    filteredSummaries = filteredSummaries.filter(
      (s) => new Date(s.started_at) >= options.sinceDate!,
    );
  }

  // AC: @session-log-search ac-7 - Pre-filter by --agent
  if (options.agentType) {
    filteredSummaries = filteredSummaries.filter(
      (s) => s.agent_type === options.agentType,
    );
  }

  const results: SessionSearchResult[] = [];
  let totalMatches = 0;

  for (const summary of filteredSummaries) {
    if (totalMatches >= limit) break;

    const eventsPath = getSessionEventsPath(specDir, summary.id);
    let content: string;
    try {
      content = await fsPromises.readFile(eventsPath, "utf-8");
    } catch {
      continue; // Skip sessions without events
    }

    if (!content.trim()) continue;

    const matches: SearchMatch[] = [];
    const lines = content.trim().split("\n");

    for (const line of lines) {
      if (totalMatches >= limit) break;

      // Quick substring pre-filter before parsing JSON
      if (!line.toLowerCase().includes(lowerPattern)) continue;

      try {
        const event = JSON.parse(line);

        // AC: @session-log-search ac-2 - Filter by event type
        if (options.eventType && event.type !== options.eventType) continue;

        // Verify match in stringified data (not just line, in case pattern appears in metadata)
        const dataStr = JSON.stringify(event.data);
        if (!dataStr.toLowerCase().includes(lowerPattern)) continue;

        // AC: @session-log-search ac-4 - Create match with excerpt
        matches.push({
          session_id: summary.id,
          timestamp: event.ts,
          event_type: event.type,
          content_excerpt: extractContentExcerpt(event.data, pattern, 200),
        });
        totalMatches++;
      } catch {
        // Skip unparseable lines
      }
    }

    if (matches.length > 0) {
      results.push({
        session_id: summary.id,
        agent_type: summary.agent_type,
        started_at: summary.started_at,
        matches,
      });
    }
  }

  return results;
}
