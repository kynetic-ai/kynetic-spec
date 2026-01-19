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

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import yaml from 'js-yaml';
import {
  SessionMetadataSchema,
  SessionEventSchema,
  type SessionMetadata,
  type SessionMetadataInput,
  type SessionEvent,
  type SessionEventInput,
  type SessionStatus,
} from './types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const SESSIONS_DIR = 'sessions';
const METADATA_FILE = 'session.yaml';
const EVENTS_FILE = 'events.jsonl';

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
export function getSessionMetadataPath(specDir: string, sessionId: string): string {
  return path.join(getSessionDir(specDir, sessionId), METADATA_FILE);
}

/**
 * Get the path to a session's events file.
 */
export function getSessionEventsPath(specDir: string, sessionId: string): string {
  return path.join(getSessionDir(specDir, sessionId), EVENTS_FILE);
}

/**
 * Get the path to a session's context snapshot file for a given iteration.
 */
export function getSessionContextPath(specDir: string, sessionId: string, iteration: number): string {
  return path.join(getSessionDir(specDir, sessionId), `context-iter-${iteration}.json`);
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
  input: SessionMetadataInput
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
    status: input.status ?? 'active',
    started_at: input.started_at ?? new Date().toISOString(),
    ended_at: undefined,
  };

  // Validate and write metadata
  const validated = SessionMetadataSchema.parse(metadata);
  const content = yaml.dump(validated, { indent: 2, lineWidth: 100, noRefs: true });
  await fsPromises.writeFile(metadataPath, content, 'utf-8');

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
  sessionId: string
): Promise<SessionMetadata | null> {
  const metadataPath = getSessionMetadataPath(specDir, sessionId);

  try {
    const content = await fsPromises.readFile(metadataPath, 'utf-8');
    const raw = yaml.load(content);
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
  status: SessionStatus
): Promise<SessionMetadata | null> {
  const metadata = await getSession(specDir, sessionId);
  if (!metadata) {
    return null;
  }

  // Update status and ended_at if transitioning away from active
  const updated: SessionMetadata = {
    ...metadata,
    status,
    ended_at: status !== 'active' ? new Date().toISOString() : metadata.ended_at,
  };

  const metadataPath = getSessionMetadataPath(specDir, sessionId);
  const content = yaml.dump(updated, { indent: 2, lineWidth: 100, noRefs: true });
  await fsPromises.writeFile(metadataPath, content, 'utf-8');

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
    const entries = await fsPromises.readdir(sessionsDir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * Check if a session exists.
 */
export async function sessionExists(specDir: string, sessionId: string): Promise<boolean> {
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
async function getEventCount(specDir: string, sessionId: string): Promise<number> {
  const eventsPath = getSessionEventsPath(specDir, sessionId);

  try {
    const content = await fsPromises.readFile(eventsPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
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
  input: SessionEventInput
): Promise<SessionEvent> {
  const sessionDir = getSessionDir(specDir, input.session_id);
  const eventsPath = getSessionEventsPath(specDir, input.session_id);

  // Ensure session directory exists (lazy creation)
  await fsPromises.mkdir(sessionDir, { recursive: true });

  // Get current event count for seq assignment
  const seq = input.seq ?? await getEventCount(specDir, input.session_id);

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

  // AC-3: Use synchronous append for crash safety
  // This ensures the line is fully written before returning
  const line = JSON.stringify(validated) + '\n';
  fs.appendFileSync(eventsPath, line, 'utf-8');

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
  sessionId: string
): Promise<SessionEvent[]> {
  const eventsPath = getSessionEventsPath(specDir, sessionId);

  try {
    const content = await fsPromises.readFile(eventsPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);

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

    // AC-4: Sort by sequence number
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
  until?: number
): Promise<SessionEvent[]> {
  const events = await readEvents(specDir, sessionId);
  return events.filter(e => {
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
  sessionId: string
): Promise<SessionEvent | null> {
  const events = await readEvents(specDir, sessionId);
  if (events.length === 0) {
    return null;
  }
  return events[events.length - 1];
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
  context: unknown
): Promise<void> {
  const sessionDir = getSessionDir(specDir, sessionId);
  const contextPath = getSessionContextPath(specDir, sessionId, iteration);

  // Ensure session directory exists
  await fsPromises.mkdir(sessionDir, { recursive: true });

  // Write context snapshot as pretty JSON
  const content = JSON.stringify(context, null, 2);
  await fsPromises.writeFile(contextPath, content, 'utf-8');
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
  iteration: number
): Promise<unknown | null> {
  const contextPath = getSessionContextPath(specDir, sessionId, iteration);

  try {
    const content = await fsPromises.readFile(contextPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
