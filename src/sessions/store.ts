/**
 * Session event storage.
 *
 * JSONL-based event storage for agent sessions with:
 * - Atomic appends for crash safety (AC-3)
 * - Auto-assigned timestamps and sequence numbers (AC-2)
 * - Session metadata management
 *
 * Storage structure:
 *   .kspec-sessions/{session-id}/
 *     session.yaml      # Metadata
 *     events.jsonl      # Append-only event log
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";
import * as YAML from "yaml";
import {
  type SessionEvent,
  type SessionEventInput,
  SessionEventSchema,
  type SessionMetadata,
  type SessionMetadataInput,
  SessionMetadataSchema,
  type SessionStatus,
  type TaskBudget,
  TaskBudgetSchema,
} from "./types.js";
import { sessionBranchAutoCommit } from "../parser/session-branch.js";
import {
  unwrapSessionUpdate,
  extractToolCallFields,
  extractToolName,
  isPopulatedInput,
} from "../agent-runtime/session-event-fields.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const METADATA_FILE = "session.yaml";
const EVENTS_FILE = "events.jsonl";
const BUDGET_FILE = "budget.json";
const BLOBS_DIR = "blobs";

// Event persistence guardrails: keep single-line events bounded in size while
// preserving full payloads via externalized blob files.
const EVENT_LINE_MAX_BYTES = 256 * 1024;
const EVENT_FIELD_EXTERNALIZE_BYTES = 16 * 1024;
const EVENT_PREVIEW_MAX_BYTES = 512;
const EVENT_SEQ_TAIL_READ_BYTES = EVENT_LINE_MAX_BYTES + 1024;

// ─── Session Branch Auto-Commit ──────────────────────────────────────────────
// AC: @session-branch-worktree ac-commit-boundaries
// When sessionsDir is a git worktree (sessions.storage=branch), auto-commit at
// lifecycle boundaries (create, close, stale cleanup, compact).
// Event appends are NOT committed individually.

/**
 * Check if sessionsDir is a git worktree (has a .git file, not directory).
 * Cached per path to avoid repeated filesystem checks.
 */
const worktreeCache = new Map<string, boolean>();

async function isSessionWorktree(sessionsDir: string): Promise<boolean> {
  const cached = worktreeCache.get(sessionsDir);
  if (cached !== undefined) return cached;

  try {
    const gitPath = path.join(sessionsDir, ".git");
    const stat = await fsPromises.stat(gitPath);
    // Worktrees have a .git FILE pointing to the main repo
    const isWorktree = stat.isFile();
    worktreeCache.set(sessionsDir, isWorktree);
    return isWorktree;
  } catch {
    worktreeCache.set(sessionsDir, false);
    return false;
  }
}

/**
 * Auto-commit to session branch at lifecycle boundaries.
 * No-op if sessionsDir is not a git worktree.
 */
async function commitAtLifecycleBoundary(sessionsDir: string, message: string): Promise<void> {
  if (await isSessionWorktree(sessionsDir)) {
    await sessionBranchAutoCommit(sessionsDir, message);
  }
}

// ─── Path Helpers ────────────────────────────────────────────────────────────
// AC: @session-storage-path-resolution ac-resolver ac-path-helpers
// All path helpers accept sessionsDir (.kspec-sessions/ at project root),
// not sessionsDir (.kspec/). This decouples session storage from the shadow branch.

/**
 * Get the sessions root directory.
 * @deprecated Use ctx.sessionsDir directly. Kept for backward compatibility.
 */
export function getSessionsDir(sessionsDir: string): string {
  return sessionsDir;
}

/**
 * Get the path to a specific session's directory.
 */
export function getSessionDir(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, sessionId);
}

/**
 * Get the path to a session's metadata file.
 */
export function getSessionMetadataPath(sessionsDir: string, sessionId: string): string {
  return path.join(getSessionDir(sessionsDir, sessionId), METADATA_FILE);
}

/**
 * Get the path to a session's events file.
 */
export function getSessionEventsPath(sessionsDir: string, sessionId: string): string {
  return path.join(getSessionDir(sessionsDir, sessionId), EVENTS_FILE);
}

/**
 * Get the path to a session's context snapshot file for a given iteration.
 */
export function getSessionContextPath(
  sessionsDir: string,
  sessionId: string,
  iteration: number,
): string {
  return path.join(getSessionDir(sessionsDir, sessionId), `context-iter-${iteration}.json`);
}

/**
 * Get the path to a session's budget file.
 * AC: @session-creation-and-env-injection ac-budget-local
 */
export function getSessionBudgetPath(sessionsDir: string, sessionId: string): string {
  return path.join(getSessionDir(sessionsDir, sessionId), BUDGET_FILE);
}

/**
 * Get the path to a session's blob directory.
 */
export function getSessionBlobDir(sessionsDir: string, sessionId: string): string {
  return path.join(getSessionDir(sessionsDir, sessionId), BLOBS_DIR);
}

// ─── Session CRUD ────────────────────────────────────────────────────────────

/**
 * Create a new session with metadata.
 *
 * AC-1: Creates .kspec-sessions/{id}/ directory with session.yaml metadata file.
 * AC-5: Metadata includes task_id (optional), agent_type, status, started_at, ended_at.
 *
 * @param sessionsDir - The .kspec directory path
 * @param input - Session metadata input
 * @returns The created session metadata
 */
export async function createSession(
  sessionsDir: string,
  input: SessionMetadataInput,
): Promise<SessionMetadata> {
  const sessionDir = getSessionDir(sessionsDir, input.id);
  const metadataPath = getSessionMetadataPath(sessionsDir, input.id);

  // Create session directory
  await fsPromises.mkdir(sessionDir, { recursive: true });

  // Build full metadata
  // AC: @session-model-evolution ac-1 — include trigger and agent_id when provided
  const metadata: SessionMetadata = {
    id: input.id,
    task_id: input.task_id,
    // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
    // — display ref persisted separately from canonical task_id.
    task_ref: input.task_ref,
    agent_type: input.agent_type,
    agent_id: input.agent_id,
    trigger: input.trigger,
    // AC: @runner-resolution-and-preflight ac-session-metadata-records-runner
    runner: input.runner,
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

  // AC: @session-branch-worktree ac-commit-boundaries — commit on session create
  await commitAtLifecycleBoundary(sessionsDir, `session: create (${input.id})`);

  return validated;
}

/**
 * Read session metadata.
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns Session metadata or null if not found
 */
export async function getSession(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionMetadata | null> {
  const metadataPath = getSessionMetadataPath(sessionsDir, sessionId);

  try {
    const content = await fsPromises.readFile(metadataPath, "utf-8");
    const raw = YAML.parse(content);
    const parsed = SessionMetadataSchema.parse(raw);
    // AC: @session-model-evolution ac-2 — materialize defaults for legacy sessions
    return {
      ...parsed,
      trigger: parsed.trigger ?? "legacy",
      agent_id: parsed.agent_id ?? parsed.agent_type,
    };
  } catch {
    return null;
  }
}

/**
 * Update session status.
 *
 * AC-6: Updates metadata with status and ended_at timestamp when session ends.
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @param status - New status
 * @returns Updated metadata or null if session not found
 */
export async function updateSessionStatus(
  sessionsDir: string,
  sessionId: string,
  status: SessionStatus,
): Promise<SessionMetadata | null> {
  const metadata = await getSession(sessionsDir, sessionId);
  if (!metadata) {
    return null;
  }

  // Update status and ended_at if transitioning away from active
  const updated: SessionMetadata = {
    ...metadata,
    status,
    ended_at: status !== "active" ? new Date().toISOString() : metadata.ended_at,
  };

  const metadataPath = getSessionMetadataPath(sessionsDir, sessionId);
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
 * @param sessionsDir - The .kspec directory path
 * @returns Array of session IDs
 */
export async function listSessions(sessionsDir: string): Promise<string[]> {
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
 * Count completed sessions grouped by agent_id.
 *
 * Reads only session metadata (not events.jsonl) for performance.
 * A session counts as "completed" if its status is "completed".
 *
 * @param sessionsDir - The .kspec directory path
 * @returns Map of agent_id to completed session count
 */
export async function getCompletedSessionCountsByAgent(
  sessionsDir: string,
): Promise<Record<string, number>> {
  const sessionIds = await listSessions(sessionsDir);
  const counts: Record<string, number> = {};

  // Read metadata in parallel for performance
  const metadataResults = await Promise.all(sessionIds.map((id) => getSession(sessionsDir, id)));

  for (const metadata of metadataResults) {
    if (!metadata) continue;
    if (metadata.status !== "completed") continue;
    const agentId = metadata.agent_id ?? metadata.agent_type;
    counts[agentId] = (counts[agentId] || 0) + 1;
  }

  return counts;
}

/**
 * Check if a session exists.
 */
export async function sessionExists(sessionsDir: string, sessionId: string): Promise<boolean> {
  const metadataPath = getSessionMetadataPath(sessionsDir, sessionId);
  try {
    await fsPromises.access(metadataPath);
    return true;
  } catch {
    return false;
  }
}

// ─── End-Loop Signal ────────────────────────────────────────────────────────

/**
 * Request end-loop for a session.
 *
 * Writes end_requested=true and optional end_reason to the session metadata.
 * This is the session-scoped replacement for the marker file approach.
 *
 * AC: @session-end-loop-signal ac-signal
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @param reason - Optional reason for ending the loop
 * @returns Updated metadata or null if session not found
 */
export async function requestEndLoop(
  sessionsDir: string,
  sessionId: string,
  reason?: string,
): Promise<SessionMetadata | null> {
  const metadata = await getSession(sessionsDir, sessionId);
  if (!metadata) {
    return null;
  }

  const updated: SessionMetadata = {
    ...metadata,
    end_requested: true,
    end_reason: reason,
  };

  const metadataPath = getSessionMetadataPath(sessionsDir, sessionId);
  const content = YAML.stringify(updated, {
    indent: 2,
    lineWidth: 100,
    sortMapEntries: false,
  });
  await fsPromises.writeFile(metadataPath, content, "utf-8");

  return updated;
}

/**
 * Check if end-loop has been requested for a session.
 *
 * Only returns requested=true for active sessions. If the session is
 * completed or abandoned, the end-loop signal is no longer relevant
 * (prevents stale KSPEC_SESSION_ID from blocking task starts).
 *
 * AC: @session-end-loop-signal ac-detect
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns Object with requested flag and optional reason, or null if session not found
 */
export async function isEndLoopRequested(
  sessionsDir: string,
  sessionId: string,
): Promise<{ requested: boolean; reason?: string } | null> {
  const metadata = await getSession(sessionsDir, sessionId);
  if (!metadata) {
    return null;
  }

  return {
    requested: metadata.end_requested === true && metadata.status === "active",
    reason: metadata.end_reason,
  };
}

/**
 * Close a session with a specific status and reason.
 *
 * Used for all session close paths: normal exit, signal, error.
 *
 * AC: @session-end-loop-signal ac-session-close-normal
 * AC: @session-end-loop-signal ac-session-close-signal
 * AC: @session-end-loop-signal ac-session-close-error
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @param status - New status (completed or abandoned)
 * @param reason - Reason for closing
 * @returns Updated metadata or null if session not found
 */
export async function closeSession(
  sessionsDir: string,
  sessionId: string,
  status: SessionStatus,
  reason: string,
): Promise<SessionMetadata | null> {
  const metadata = await getSession(sessionsDir, sessionId);
  if (!metadata) {
    return null;
  }

  // AC: @daemon-entity-cache ac-session-stats-persist — compute stats from events.jsonl
  // and persist in session metadata so list endpoints never need to scan event data.
  const [eventCount, iterationCount, tasksCompleted] = await Promise.all([
    countEventLines(sessionsDir, sessionId),
    countIterations(sessionsDir, sessionId),
    countTaskCompletions(sessionsDir, sessionId),
  ]);

  const updated: SessionMetadata = {
    ...metadata,
    status,
    ended_at: new Date().toISOString(),
    close_reason: reason,
    event_count: eventCount,
    iteration_count: iterationCount,
    tasks_completed: tasksCompleted,
  };

  const metadataPath = getSessionMetadataPath(sessionsDir, sessionId);
  const content = YAML.stringify(updated, {
    indent: 2,
    lineWidth: 100,
    sortMapEntries: false,
  });
  await fsPromises.writeFile(metadataPath, content, "utf-8");

  // AC: @session-branch-worktree ac-commit-boundaries — commit on session close
  await commitAtLifecycleBoundary(sessionsDir, `session: close ${status} (${sessionId})`);

  return updated;
}

// ─── Event Storage ───────────────────────────────────────────────────────────

/**
 * Pointer stored in events.jsonl when payload content is externalized.
 *
 * AC: @session-events ac-9
 */
export interface SessionBlobPointer {
  /** Relative path from session dir (for example blobs/<file>) */
  path: string;
  /** UTF-8 byte length of the externalized payload */
  bytes: number;
  /** SHA-256 hash of externalized content */
  sha256: string;
  /** Always true for externalized content */
  truncated: true;
  /** Bounded preview stored inline for fast inspection/search */
  preview: string;
}

/**
 * Blob pointer with resolved full payload content.
 */
interface ResolvedSessionBlobPointer extends SessionBlobPointer {
  content: string;
}

interface BlobWriteContext {
  blobDir: string;
  ensuredDir: boolean;
  dryRun?: boolean;
  createdBlobs?: number;
  dryRunCounter?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSessionBlobPointer(value: unknown): value is SessionBlobPointer {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    typeof value.bytes === "number" &&
    typeof value.sha256 === "string" &&
    value.truncated === true &&
    typeof value.preview === "string"
  );
}

function stringifyPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function payloadBytes(value: unknown): number {
  return Buffer.byteLength(stringifyPayload(value), "utf-8");
}

function toPreview(content: string): string {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  if (totalBytes <= EVENT_PREVIEW_MAX_BYTES) {
    return content;
  }

  let preview = "";
  let usedBytes = 0;
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (usedBytes + charBytes > EVENT_PREVIEW_MAX_BYTES) break;
    preview += char;
    usedBytes += charBytes;
  }

  return `${preview}...`;
}

function normalizeFieldLabel(pathSegments: string[]): string {
  const joined = pathSegments.length > 0 ? pathSegments.join("-") : "event-data";
  const cleaned = joined
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return cleaned || "event-data";
}

function shouldExternalizeField(pathSegments: string[], value: unknown): boolean {
  if (value === null || value === undefined) return false;

  const keyPath = pathSegments.join(".");
  if (keyPath === "update.rawOutput") {
    return payloadBytes(value) > EVENT_FIELD_EXTERNALIZE_BYTES;
  }
  if (
    keyPath === "update._meta.claudeCode.toolResponse.stdout" ||
    keyPath === "update._meta.claudeCode.toolResponse.stderr"
  ) {
    return payloadBytes(value) > EVENT_FIELD_EXTERNALIZE_BYTES;
  }
  if (pathSegments[pathSegments.length - 1] === "text") {
    const hasChunkContext =
      pathSegments.includes("content") ||
      pathSegments.includes("chunk") ||
      pathSegments.includes("delta");
    if (hasChunkContext) {
      return payloadBytes(value) > EVENT_FIELD_EXTERNALIZE_BYTES;
    }
  }
  return false;
}

async function createBlobPointer(
  sessionsDir: string,
  sessionId: string,
  seq: number,
  pathSegments: string[],
  value: unknown,
  context: BlobWriteContext,
): Promise<SessionBlobPointer> {
  const content = stringifyPayload(value);
  const bytes = Buffer.byteLength(content, "utf-8");
  const sha256 = createHash("sha256").update(content).digest("hex");

  const fieldLabel = normalizeFieldLabel(pathSegments);
  const dryRunCounter = context.dryRunCounter ?? 0;
  const fileName = context.dryRun
    ? `${String(seq).padStart(6, "0")}-${fieldLabel}-dry-run-${String(dryRunCounter).padStart(4, "0")}.blob`
    : `${String(seq).padStart(6, "0")}-${fieldLabel}-${randomUUID()}.blob`;
  const relativePath = path.posix.join(BLOBS_DIR, fileName);
  if (!context.dryRun) {
    if (!context.ensuredDir) {
      await fsPromises.mkdir(context.blobDir, { recursive: true });
      context.ensuredDir = true;
    }
    const absolutePath = path.join(getSessionDir(sessionsDir, sessionId), relativePath);
    await fsPromises.writeFile(absolutePath, content, "utf-8");
  }
  context.createdBlobs = (context.createdBlobs ?? 0) + 1;
  context.dryRunCounter = dryRunCounter + 1;

  return {
    path: relativePath,
    bytes,
    sha256,
    truncated: true,
    preview: toPreview(content),
  };
}

async function externalizeOversizedPayloads(
  sessionsDir: string,
  sessionId: string,
  seq: number,
  value: unknown,
  pathSegments: string[],
  context: BlobWriteContext,
): Promise<unknown> {
  if (isSessionBlobPointer(value)) {
    return value;
  }

  if (shouldExternalizeField(pathSegments, value)) {
    return createBlobPointer(sessionsDir, sessionId, seq, pathSegments, value, context);
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((entry, idx) =>
        externalizeOversizedPayloads(
          sessionsDir,
          sessionId,
          seq,
          entry,
          [...pathSegments, String(idx)],
          context,
        ),
      ),
    );
  }

  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = await externalizeOversizedPayloads(
        sessionsDir,
        sessionId,
        seq,
        child,
        [...pathSegments, key],
        context,
      );
    }
    return next;
  }

  return value;
}

function resolveBlobAbsolutePath(
  sessionsDir: string,
  sessionId: string,
  relativePath: string,
): string | null {
  const sessionDir = path.resolve(getSessionDir(sessionsDir, sessionId));
  const absolutePath = path.resolve(sessionDir, relativePath);
  if (absolutePath === sessionDir || absolutePath.startsWith(`${sessionDir}${path.sep}`)) {
    return absolutePath;
  }
  return null;
}

async function resolveBlobPointer(
  sessionsDir: string,
  sessionId: string,
  pointer: SessionBlobPointer,
): Promise<ResolvedSessionBlobPointer> {
  const absolutePath = resolveBlobAbsolutePath(sessionsDir, sessionId, pointer.path);
  if (!absolutePath) {
    return { ...pointer, content: pointer.preview };
  }

  try {
    const content = await fsPromises.readFile(absolutePath, "utf-8");
    return { ...pointer, content };
  } catch {
    return { ...pointer, content: pointer.preview };
  }
}

/**
 * Resolve all blob pointers in a value tree to include full payload content.
 *
 * Default flows keep compact pointer objects (preview-only). This helper powers
 * explicit on-demand blob resolution in session log commands.
 */
export async function resolveSessionBlobPointers(
  sessionsDir: string,
  sessionId: string,
  value: unknown,
): Promise<unknown> {
  if (isSessionBlobPointer(value)) {
    return resolveBlobPointer(sessionsDir, sessionId, value);
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((entry) => resolveSessionBlobPointers(sessionsDir, sessionId, entry)),
    );
  }

  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = await resolveSessionBlobPointers(sessionsDir, sessionId, child);
    }
    return next;
  }

  return value;
}

function extractLastEventSeq(content: string): number | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (
        isRecord(parsed) &&
        typeof parsed.seq === "number" &&
        Number.isInteger(parsed.seq) &&
        parsed.seq >= 0
      ) {
        return parsed.seq;
      }
    } catch {
      // Ignore malformed lines and continue scanning backward.
    }
  }

  return null;
}

/**
 * Get next sequence number from the last stored event.
 *
 * Reads a bounded tail slice for O(1) seq lookup; falls back to full scan only
 * if the tail slice cannot be parsed (for example, partial line boundary).
 */
async function getNextEventSeq(sessionsDir: string, sessionId: string): Promise<number> {
  const eventsPath = getSessionEventsPath(sessionsDir, sessionId);

  let fileHandle: fsPromises.FileHandle | null = null;
  try {
    fileHandle = await fsPromises.open(eventsPath, "r");
    const stats = await fileHandle.stat();
    if (stats.size === 0) {
      return 0;
    }

    const readBytes = Math.min(stats.size, EVENT_SEQ_TAIL_READ_BYTES);
    const startOffset = stats.size - readBytes;
    const buffer = Buffer.alloc(readBytes);
    await fileHandle.read(buffer, 0, readBytes, startOffset);

    let tailContent = buffer.toString("utf-8");
    if (startOffset > 0) {
      // Drop potential partial first line from tail slice.
      const firstNewline = tailContent.indexOf("\n");
      tailContent = firstNewline === -1 ? "" : tailContent.slice(firstNewline + 1);
    }

    const tailSeq = extractLastEventSeq(tailContent);
    if (tailSeq !== null) {
      return tailSeq + 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }

  try {
    const fullContent = await fsPromises.readFile(eventsPath, "utf-8");
    const fullSeq = extractLastEventSeq(fullContent);
    return fullSeq === null ? 0 : fullSeq + 1;
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
 * @param sessionsDir - The .kspec directory path
 * @param input - Event input (ts and seq are auto-assigned if not provided)
 * @returns The appended event with auto-assigned fields
 */
export async function appendEvent(
  sessionsDir: string,
  input: SessionEventInput,
): Promise<SessionEvent> {
  const sessionDir = getSessionDir(sessionsDir, input.session_id);
  const eventsPath = getSessionEventsPath(sessionsDir, input.session_id);

  // Ensure session directory exists (lazy creation)
  await fsPromises.mkdir(sessionDir, { recursive: true });

  // Derive next sequence number from the last stored event.
  const seq = input.seq ?? (await getNextEventSeq(sessionsDir, input.session_id));

  // Build full event
  const event: SessionEvent = {
    ts: input.ts ?? Date.now(),
    seq,
    type: input.type,
    session_id: input.session_id,
    trace_id: input.trace_id,
    data: input.data,
  };

  // AC: @session-events ac-8, ac-9 - Externalize oversized payload fields
  // before writing to events.jsonl.
  const externalizedData = await externalizeOversizedPayloads(
    sessionsDir,
    input.session_id,
    seq,
    event.data,
    [],
    {
      blobDir: getSessionBlobDir(sessionsDir, input.session_id),
      ensuredDir: false,
    },
  );

  const eventWithGuardrails: SessionEvent = {
    ...event,
    data: externalizedData,
  };

  // Validate event
  let validated = SessionEventSchema.parse(eventWithGuardrails);

  // Event-line safety cap: if a single JSONL line is still too large after
  // targeted field externalization, externalize the entire data payload.
  let line = JSON.stringify(validated);
  if (Buffer.byteLength(line, "utf-8") > EVENT_LINE_MAX_BYTES) {
    const blobContext: BlobWriteContext = {
      blobDir: getSessionBlobDir(sessionsDir, input.session_id),
      ensuredDir: false,
    };
    const fullDataPointer = await createBlobPointer(
      sessionsDir,
      input.session_id,
      seq,
      [],
      validated.data,
      blobContext,
    );
    validated = SessionEventSchema.parse({
      ...validated,
      data: fullDataPointer,
    });
    line = JSON.stringify(validated);
  }

  // AC: @session-events ac-3 - Use synchronous append for crash safety
  // This ensures the line is fully written before returning
  fs.appendFileSync(eventsPath, `${line}\n`, "utf-8");

  return validated;
}

export interface CompactSessionEventsOptions {
  dryRun?: boolean;
  renameFn?: (oldPath: string, newPath: string) => Promise<void>;
}

export type CompactSessionReason =
  | "missing_events_file"
  | "empty_events_file"
  | "already_compacted"
  | "compacted"
  | "would_compact";

export interface CompactSessionEventsResult {
  events_processed: number;
  blobs_created: number;
  bytes_before: number;
  bytes_after: number;
  bytes_reclaimed: number;
  changed: boolean;
  reason: CompactSessionReason;
  dry_run: boolean;
}

/**
 * Retroactively compact a session event log by externalizing oversized payloads.
 *
 * Reuses the same two-stage externalization pipeline as appendEvent():
 * 1) Field-level externalization for known large payload fields
 * 2) Full-data externalization if a line still exceeds EVENT_LINE_MAX_BYTES
 *
 * Writes are atomic (temp-file then rename). When dryRun is enabled, no files
 * are modified and no blob files are written.
 */
export async function compactSessionEvents(
  sessionsDir: string,
  sessionId: string,
  options: CompactSessionEventsOptions = {},
): Promise<CompactSessionEventsResult> {
  const dryRun = options.dryRun === true;
  const renameFn = options.renameFn ?? fsPromises.rename;
  const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
  let content: string;

  try {
    content = await fsPromises.readFile(eventsPath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {
        events_processed: 0,
        blobs_created: 0,
        bytes_before: 0,
        bytes_after: 0,
        bytes_reclaimed: 0,
        changed: false,
        reason: "missing_events_file",
        dry_run: dryRun,
      };
    }
    throw err;
  }

  const bytesBefore = Buffer.byteLength(content, "utf-8");
  const sourceLines = content.split("\n").filter((line) => line.trim().length > 0);

  if (sourceLines.length === 0) {
    return {
      events_processed: 0,
      blobs_created: 0,
      bytes_before: bytesBefore,
      bytes_after: bytesBefore,
      bytes_reclaimed: 0,
      changed: false,
      reason: "empty_events_file",
      dry_run: dryRun,
    };
  }

  const blobContext: BlobWriteContext = {
    blobDir: getSessionBlobDir(sessionsDir, sessionId),
    ensuredDir: false,
    dryRun,
    createdBlobs: 0,
    dryRunCounter: 0,
  };

  const compactedLines: string[] = [];
  for (let i = 0; i < sourceLines.length; i += 1) {
    const line = sourceLines[i];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err: unknown) {
      throw new Error(
        `Invalid JSON in events log at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const event = SessionEventSchema.parse(parsed);
    const externalizedData = await externalizeOversizedPayloads(
      sessionsDir,
      sessionId,
      event.seq,
      event.data,
      [],
      blobContext,
    );

    let validated = SessionEventSchema.parse({
      ...event,
      data: externalizedData,
    });

    let compactedLine = JSON.stringify(validated);
    if (Buffer.byteLength(compactedLine, "utf-8") > EVENT_LINE_MAX_BYTES) {
      const fullDataPointer = await createBlobPointer(
        sessionsDir,
        sessionId,
        event.seq,
        [],
        validated.data,
        blobContext,
      );
      validated = SessionEventSchema.parse({
        ...validated,
        data: fullDataPointer,
      });
      compactedLine = JSON.stringify(validated);
    }

    compactedLines.push(compactedLine);
  }

  const compactedContent = `${compactedLines.join("\n")}\n`;
  const changed = compactedContent !== content;
  const bytesAfter = changed ? Buffer.byteLength(compactedContent, "utf-8") : bytesBefore;

  if (!changed) {
    return {
      events_processed: sourceLines.length,
      blobs_created: 0,
      bytes_before: bytesBefore,
      bytes_after: bytesBefore,
      bytes_reclaimed: 0,
      changed: false,
      reason: "already_compacted",
      dry_run: dryRun,
    };
  }

  if (!dryRun) {
    const sessionDir = getSessionDir(sessionsDir, sessionId);
    const tmpPath = path.join(sessionDir, `.${EVENTS_FILE}.${process.pid}.${Date.now()}.tmp`);
    try {
      await fsPromises.writeFile(tmpPath, compactedContent, "utf-8");
      await renameFn(tmpPath, eventsPath);
    } catch (err) {
      await fsPromises.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  // AC: @session-branch-worktree ac-commit-boundaries — commit on compact
  if (!dryRun) {
    await commitAtLifecycleBoundary(sessionsDir, `session: compact (${sessionId})`);
  }

  return {
    events_processed: sourceLines.length,
    blobs_created: blobContext.createdBlobs ?? 0,
    bytes_before: bytesBefore,
    bytes_after: bytesAfter,
    bytes_reclaimed: Math.max(0, bytesBefore - bytesAfter),
    changed: true,
    reason: dryRun ? "would_compact" : "compacted",
    dry_run: dryRun,
  };
}

/**
 * Read all events from a session.
 *
 * AC-4: Returns all events in sequence order.
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns Array of events sorted by sequence number
 */
export async function readEvents(sessionsDir: string, sessionId: string): Promise<SessionEvent[]> {
  const eventsPath = getSessionEventsPath(sessionsDir, sessionId);

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
    return events.toSorted((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

/**
 * Read a single event by sequence number from a session's event log.
 *
 * Scans events.jsonl line-by-line and stops as soon as the matching seq is
 * found, avoiding full parsing of all events for large sessions.
 *
 * AC: @session-event-detail-endpoint ac-single-event-fetch
 *
 * @param sessionsDir - The sessions directory path
 * @param sessionId - Session ID
 * @param seq - Sequence number to find
 * @returns The matching event, or null if not found
 */
export async function readEventBySeq(
  sessionsDir: string,
  sessionId: string,
  seq: number,
): Promise<SessionEvent | null> {
  const eventsPath = getSessionEventsPath(sessionsDir, sessionId);

  let content: string;
  try {
    content = await fsPromises.readFile(eventsPath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    try {
      const raw = JSON.parse(trimmed);
      if (isRecord(raw) && raw.seq === seq) {
        return SessionEventSchema.parse(raw);
      }
    } catch {
      // Skip invalid lines
    }
  }

  return null;
}

/**
 * Deduplicate phased tool_call events.
 *
 * ACP SDK 0.14+ sends tool calls in two phases: first with empty rawInput,
 * then with populated rawInput. This merges them by keeping only the version
 * with populated rawInput per toolCallId.
 */
export function deduplicatePhasedToolCalls(events: SessionEvent[]): SessionEvent[] {
  // First pass: find toolCallIds that have a populated rawInput version
  const populatedToolCalls = new Map<string, number>(); // toolCallId → index
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type !== "session.update") continue;
    const update = unwrapSessionUpdate(event.data as Record<string, unknown> | null);
    if (!update || update.sessionUpdate !== "tool_call") continue;
    const { toolCallId, rawInput } = extractToolCallFields(update);
    if (!toolCallId) continue;
    if (isPopulatedInput(rawInput)) {
      populatedToolCalls.set(toolCallId, i);
    } else if (!populatedToolCalls.has(toolCallId)) {
      // First (empty) version - track it in case no populated version exists
      populatedToolCalls.set(toolCallId, i);
    }
  }

  // Second pass: keep only the best version per toolCallId
  return events.filter((event, i) => {
    if (event.type !== "session.update") return true;
    const update = unwrapSessionUpdate(event.data as Record<string, unknown> | null);
    if (!update || update.sessionUpdate !== "tool_call") return true;
    const { toolCallId } = extractToolCallFields(update);
    if (!toolCallId) return true;
    // Keep this event only if it's the best version (populated or only version)
    return populatedToolCalls.get(toolCallId) === i;
  });
}

/**
 * Read events within a time range.
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @param since - Start timestamp (inclusive)
 * @param until - End timestamp (inclusive)
 * @returns Array of events within the time range
 */
export async function readEventsSince(
  sessionsDir: string,
  sessionId: string,
  since: number,
  until?: number,
): Promise<SessionEvent[]> {
  const events = await readEvents(sessionsDir, sessionId);
  return events.filter((e) => {
    if (e.ts < since) return false;
    if (until !== undefined && e.ts > until) return false;
    return true;
  });
}

/**
 * Get the last event in a session.
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns The last event or null if no events
 */
export async function getLastEvent(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionEvent | null> {
  const events = await readEvents(sessionsDir, sessionId);
  if (events.length === 0) {
    return null;
  }
  return events[events.length - 1];
}

// ─── Stale Session Candidate Selection ──────────────────────────────────────

const RELATIVE_DURATION_PATTERN = /^(\d+)([hdwm])$/i;

const STALE_DEFAULTS = {
  olderThan: "24h",
  inactiveFor: "6h",
  livenessGuard: "5m",
} as const;

export interface StaleSessionCriteriaInput {
  olderThan?: string;
  inactiveFor?: string;
  livenessGuard?: string;
}

export interface StaleSessionCriteria {
  olderThan: string;
  olderThanMs: number;
  inactiveFor: string;
  inactiveForMs: number;
  livenessGuard: string;
  livenessGuardMs: number;
}

export type StaleSessionCriteriaValidation =
  | {
      ok: true;
      criteria: StaleSessionCriteria;
    }
  | {
      ok: false;
      field: "older-than" | "inactive-for" | "liveness-guard";
      value: string;
      message: string;
      guidance: string;
    };

function durationGuidance(flag: "older-than" | "inactive-for" | "liveness-guard"): string {
  return `--${flag} accepts relative durations only (h, d, w, m), for example 6h, 7d, 2w, 1m`;
}

function parseRelativeDurationMs(rawValue: string): number | null {
  const match = rawValue.match(RELATIVE_DURATION_PATTERN);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (Number.isNaN(amount)) return null;

  switch (unit) {
    case "h":
      return amount * 60 * 60 * 1000;
    case "d":
      return amount * 24 * 60 * 60 * 1000;
    case "w":
      return amount * 7 * 24 * 60 * 60 * 1000;
    case "m":
      return amount * 60 * 1000;
    default:
      return null;
  }
}

function parseCriteriaDuration(
  field: "older-than" | "inactive-for" | "liveness-guard",
  value: string,
):
  | {
      ok: true;
      ms: number;
    }
  | {
      ok: false;
      field: "older-than" | "inactive-for" | "liveness-guard";
      value: string;
      message: string;
      guidance: string;
    } {
  const parsed = parseRelativeDurationMs(value);
  if (parsed !== null) {
    return { ok: true, ms: parsed };
  }

  const parsedDate = new Date(value);
  const appearsAbsolute = !Number.isNaN(parsedDate.getTime());
  return {
    ok: false,
    field,
    value,
    message: appearsAbsolute
      ? `Invalid value for --${field}: "${value}" (absolute timestamps are not supported)`
      : `Invalid value for --${field}: "${value}"`,
    guidance: durationGuidance(field),
  };
}

export function resolveStaleSessionCriteria(
  input: StaleSessionCriteriaInput,
): StaleSessionCriteriaValidation {
  const olderThan = input.olderThan ?? STALE_DEFAULTS.olderThan;
  const inactiveFor = input.inactiveFor ?? STALE_DEFAULTS.inactiveFor;
  const livenessGuard = input.livenessGuard ?? STALE_DEFAULTS.livenessGuard;

  const olderThanParsed = parseCriteriaDuration("older-than", olderThan);
  if (!olderThanParsed.ok) return olderThanParsed;
  const olderThanMs = olderThanParsed.ms;

  const inactiveForParsed = parseCriteriaDuration("inactive-for", inactiveFor);
  if (!inactiveForParsed.ok) return inactiveForParsed;
  const inactiveForMs = inactiveForParsed.ms;

  const livenessGuardParsed = parseCriteriaDuration("liveness-guard", livenessGuard);
  if (!livenessGuardParsed.ok) return livenessGuardParsed;
  const livenessGuardMs = livenessGuardParsed.ms;

  return {
    ok: true,
    criteria: {
      olderThan,
      olderThanMs,
      inactiveFor,
      inactiveForMs,
      livenessGuard,
      livenessGuardMs,
    },
  };
}

export interface StaleSessionActivity {
  lastActivityAt: string;
  lastActivityTs: number;
  source: "event" | "started_at";
}

export type StaleSessionActivityResult =
  | {
      ok: true;
      activity: StaleSessionActivity;
    }
  | {
      ok: false;
      reason: "events_unreadable" | "events_corrupt" | "invalid_started_at";
      detail: string;
    };

/**
 * Resolve most recent activity timestamp for stale-session candidate checks.
 *
 * Unlike readEvents(), this is strict: corrupt events are surfaced as failures
 * so stale auto-close can skip unsafe sessions.
 */
export async function getSessionActivityForStaleCheck(
  sessionsDir: string,
  sessionId: string,
): Promise<StaleSessionActivityResult> {
  const metadata = await getSession(sessionsDir, sessionId);
  if (!metadata) {
    return {
      ok: false,
      reason: "invalid_started_at",
      detail: `Session metadata missing or unreadable for ${sessionId}`,
    };
  }

  const startedAtTs = new Date(metadata.started_at).getTime();
  if (Number.isNaN(startedAtTs)) {
    return {
      ok: false,
      reason: "invalid_started_at",
      detail: `Session ${sessionId} has invalid started_at timestamp`,
    };
  }

  const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
  let content: string;
  try {
    content = await fsPromises.readFile(eventsPath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {
        ok: true,
        activity: {
          lastActivityAt: metadata.started_at,
          lastActivityTs: startedAtTs,
          source: "started_at",
        },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "events_unreadable",
      detail: `Unable to read events.jsonl for ${sessionId}: ${message}`,
    };
  }

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return {
      ok: true,
      activity: {
        lastActivityAt: metadata.started_at,
        lastActivityTs: startedAtTs,
        source: "started_at",
      },
    };
  }

  let latestTs: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      const parsed = JSON.parse(line);
      const event = SessionEventSchema.parse(parsed);
      if (latestTs === null || event.ts > latestTs) {
        latestTs = event.ts;
      }
    } catch {
      return {
        ok: false,
        reason: "events_corrupt",
        detail: `Corrupt events.jsonl for ${sessionId}: invalid line ${i + 1}`,
      };
    }
  }

  if (latestTs === null) {
    return {
      ok: true,
      activity: {
        lastActivityAt: metadata.started_at,
        lastActivityTs: startedAtTs,
        source: "started_at",
      },
    };
  }

  return {
    ok: true,
    activity: {
      lastActivityAt: new Date(latestTs).toISOString(),
      lastActivityTs: latestTs,
      source: "event",
    },
  };
}

export interface StaleSessionEvaluation {
  sessionId: string;
  startedAt: string;
  lastActivityAt: string;
  lastActivitySource: "event" | "started_at";
  ageMs: number;
  inactivityMs: number;
  meetsAgeThreshold: boolean;
  meetsInactivityThreshold: boolean;
  blockedByLivenessGuard: boolean;
  eligible: boolean;
}

export interface StaleSessionSkipped {
  sessionId: string;
  reason: "events_unreadable" | "events_corrupt" | "invalid_started_at";
  detail: string;
}

export interface StaleSessionCandidateSelection {
  criteria: StaleSessionCriteria;
  totalActiveSessions: number;
  evaluations: StaleSessionEvaluation[];
  candidates: StaleSessionEvaluation[];
  skipped: StaleSessionSkipped[];
  skippedCount: number;
  failureCount: number;
}

export function evaluateStaleSession(
  startedAt: string,
  activity: StaleSessionActivity,
  criteria: StaleSessionCriteria,
  nowMs: number = Date.now(),
): Omit<StaleSessionEvaluation, "sessionId"> {
  const startedAtMs = new Date(startedAt).getTime();
  const ageMs = nowMs - startedAtMs;
  const inactivityMs = nowMs - activity.lastActivityTs;
  const meetsAgeThreshold = ageMs >= criteria.olderThanMs;
  const meetsInactivityThreshold = inactivityMs >= criteria.inactiveForMs;
  const blockedByLivenessGuard = inactivityMs < criteria.livenessGuardMs;
  const eligible = meetsAgeThreshold && meetsInactivityThreshold && !blockedByLivenessGuard;

  return {
    startedAt,
    lastActivityAt: activity.lastActivityAt,
    lastActivitySource: activity.source,
    ageMs,
    inactivityMs,
    meetsAgeThreshold,
    meetsInactivityThreshold,
    blockedByLivenessGuard,
    eligible,
  };
}

export async function selectStaleActiveSessions(
  sessionsDir: string,
  criteriaInput: StaleSessionCriteriaInput = {},
  nowMs: number = Date.now(),
): Promise<StaleSessionCandidateSelection> {
  const criteriaResolved = resolveStaleSessionCriteria(criteriaInput);
  if (!criteriaResolved.ok) {
    throw new Error(`${criteriaResolved.message}. ${criteriaResolved.guidance}`);
  }
  const criteria = criteriaResolved.criteria;

  const sessionIds = await listSessions(sessionsDir);
  const evaluations: StaleSessionEvaluation[] = [];
  const candidates: StaleSessionEvaluation[] = [];
  const skipped: StaleSessionSkipped[] = [];

  for (const sessionId of sessionIds) {
    const metadata = await getSession(sessionsDir, sessionId);
    if (!metadata || metadata.status !== "active") continue;

    const activityResult = await getSessionActivityForStaleCheck(sessionsDir, sessionId);
    if (!activityResult.ok) {
      skipped.push({
        sessionId,
        reason: activityResult.reason,
        detail: activityResult.detail,
      });
      continue;
    }

    const evaluation = evaluateStaleSession(
      metadata.started_at,
      activityResult.activity,
      criteria,
      nowMs,
    );
    const withSessionId: StaleSessionEvaluation = {
      sessionId,
      ...evaluation,
    };
    evaluations.push(withSessionId);
    if (withSessionId.eligible) {
      candidates.push(withSessionId);
    }
  }

  return {
    criteria,
    totalActiveSessions: evaluations.length + skipped.length,
    evaluations,
    candidates,
    skipped,
    skippedCount: skipped.length,
    failureCount: skipped.length,
  };
}

export interface AutoAbandonMetadataPreview {
  sessionId: string;
  status: "abandoned";
  endedAt: string;
  closeReason: string;
}

export interface AutoAbandonMetadataResult {
  dryRun: boolean;
  updatedCount: number;
  updates: AutoAbandonMetadataPreview[];
}

/**
 * Build canonical close_reason for stale auto-abandon updates.
 *
 * Canonical format:
 * auto-abandoned:older-than=<duration>,inactive-for=<duration>,liveness-guard=<duration>,last-activity=<iso>
 */
export function buildAutoAbandonedCloseReason(
  criteria: StaleSessionCriteria,
  evaluation: Pick<StaleSessionEvaluation, "lastActivityAt">,
): string {
  const segments = [
    `older-than=${criteria.olderThan}`,
    `inactive-for=${criteria.inactiveFor}`,
    `liveness-guard=${criteria.livenessGuard}`,
    `last-activity=${evaluation.lastActivityAt}`,
  ];
  return `auto-abandoned:${segments.join(",")}`;
}

/**
 * Apply abandoned metadata to stale session candidates.
 *
 * All updates in a single invocation share one ended_at timestamp, which lets
 * the caller persist and commit the batch atomically.
 */
export async function applyAutoAbandonMetadata(
  sessionsDir: string,
  selection: Pick<StaleSessionCandidateSelection, "criteria" | "candidates">,
  options?: { dryRun?: boolean; nowMs?: number },
): Promise<AutoAbandonMetadataResult> {
  const dryRun = options?.dryRun === true;
  const endedAt = new Date(options?.nowMs ?? Date.now()).toISOString();
  const updates: AutoAbandonMetadataPreview[] = [];

  for (const candidate of selection.candidates) {
    const closeReason = buildAutoAbandonedCloseReason(selection.criteria, candidate);
    updates.push({
      sessionId: candidate.sessionId,
      status: "abandoned",
      endedAt,
      closeReason,
    });

    if (dryRun) continue;

    const metadata = await getSession(sessionsDir, candidate.sessionId);
    if (!metadata) continue;

    const updated: SessionMetadata = {
      ...metadata,
      status: "abandoned",
      ended_at: endedAt,
      close_reason: closeReason,
    };

    const metadataPath = getSessionMetadataPath(sessionsDir, candidate.sessionId);
    const content = YAML.stringify(updated, {
      indent: 2,
      lineWidth: 100,
      sortMapEntries: false,
    });
    await fsPromises.writeFile(metadataPath, content, "utf-8");
  }

  // AC: @session-branch-worktree ac-commit-boundaries — commit on stale cleanup
  if (!dryRun && updates.length > 0) {
    await commitAtLifecycleBoundary(
      sessionsDir,
      `session: stale cleanup (${updates.length} abandoned)`,
    );
  }

  return {
    dryRun,
    updatedCount: updates.length,
    updates,
  };
}

// ─── Session Log Summaries ───────────────────────────────────────────────────

/**
 * Determine session type from metadata for display.
 * - "invocation": New agent runtime session (has trigger != "legacy" or agent_id)
 * - "loop": Legacy dispatch loop session (no trigger, or trigger === "legacy")
 *
 * AC: @session-model-evolution ac-6
 */
function resolveSessionType(metadata: SessionMetadata): "loop" | "invocation" {
  if (metadata.trigger && metadata.trigger !== "legacy") {
    return "invocation";
  }
  return "loop";
}

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
  /** Agent definition ID (e.g. worker, pr-reviewer). AC: @session-list-pagination-api ac-filter-agent-id */
  agent_id?: string;
  /**
   * Session type: "loop" for legacy agent sessions, "invocation" for the
   * current runtime.
   * AC: @session-model-evolution ac-6
   */
  session_type: "loop" | "invocation";
  /** Dispatch trigger (manual, task.ready, etc.) for distinguishing session origin. */
  trigger?: string;
  /** Canonical task ULID being worked on (if any). AC: @ui-session-history ac-1 */
  task_id?: string;
  /**
   * Display task ref (slug or `@ULID`) for human-readable filtering/display.
   * Never an identity key.
   * AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
   */
  task_ref?: string;
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
async function countEventLines(sessionsDir: string, sessionId: string): Promise<number> {
  const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
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
async function countIterations(sessionsDir: string, sessionId: string): Promise<number> {
  const sessionDir = getSessionDir(sessionsDir, sessionId);
  try {
    const entries = await fsPromises.readdir(sessionDir);
    return entries.filter((e) => e.startsWith("context-iter-") && e.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/**
 * Count task completions by scanning events for tool calls that invoke
 * `kspec task complete` or `npm run dev -- task complete`.
 *
 * Handles multiple adapter formats:
 * - claude-code-acp: rawInput.command is a string in tool_call_update events
 * - claude-agent-acp: rawInput.command is a string in tool_call_update events
 *   (initial tool_call event has empty rawInput {})
 * - codex-acp: rawInput.command is an array ['/usr/bin/bash', '-lc', 'kspec task complete @ref']
 *   in tool_call events; actual command is at index 2
 *
 * We use a fast substring check before JSON parsing for performance.
 */
async function countTaskCompletions(sessionsDir: string, sessionId: string): Promise<number> {
  const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
  try {
    const content = await fsPromises.readFile(eventsPath, "utf-8");
    if (!content.trim()) return 0;
    const lines = content.trim().split("\n");
    let count = 0;
    for (const line of lines) {
      // Quick substring pre-filter: only parse lines that might contain task complete commands
      if (!line.includes("task complete")) continue;
      try {
        const event = JSON.parse(line);
        const update = unwrapSessionUpdate(event?.data);
        const rawCommand = (update?.rawInput as Record<string, unknown> | undefined)?.command;
        // Normalize: string (claude-*-acp) or array like [bash, -lc, cmd] (codex-acp)
        const command =
          typeof rawCommand === "string"
            ? rawCommand
            : Array.isArray(rawCommand) && rawCommand.length > 0
              ? rawCommand[rawCommand.length - 1]
              : undefined;
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
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns Session summary or null if session doesn't exist
 */
export async function getSessionLogSummary(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionLogSummary | null> {
  const metadata = await getSession(sessionsDir, sessionId);
  if (!metadata) return null;

  const [eventCount, iterationCount, tasksCompleted] = await Promise.all([
    countEventLines(sessionsDir, sessionId),
    countIterationsBoundaryAware(sessionsDir, sessionId),
    countTaskCompletions(sessionsDir, sessionId),
  ]);

  const startMs = new Date(metadata.started_at).getTime();
  const endMs = metadata.ended_at ? new Date(metadata.ended_at).getTime() : Date.now();
  const durationMs = endMs - startMs;

  return {
    id: metadata.id,
    status: metadata.status,
    agent_type: metadata.agent_type,
    agent_id: metadata.agent_id,
    session_type: resolveSessionType(metadata),
    trigger: metadata.trigger,
    task_id: metadata.task_id,
    task_ref: metadata.task_ref,
    started_at: metadata.started_at,
    ended_at: metadata.ended_at,
    duration_ms: durationMs,
    event_count: eventCount,
    iteration_count: iterationCount,
    tasks_completed: tasksCompleted,
  };
}

/**
 * Get session metadata only — reads session.yaml without touching events.jsonl.
 *
 * AC: @session-list-pagination-api ac-metadata-only — List endpoint reads only
 * session.yaml metadata.
 * AC: @daemon-entity-cache ac-session-stats-persist — Closed sessions have stats
 * persisted in metadata; read them instead of hardcoding 0.
 */
export async function getSessionMetadataOnly(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionLogSummary | null> {
  const metadata = await getSession(sessionsDir, sessionId);
  if (!metadata) return null;

  const startMs = new Date(metadata.started_at).getTime();
  const endMs = metadata.ended_at ? new Date(metadata.ended_at).getTime() : Date.now();
  const durationMs = endMs - startMs;

  return {
    id: metadata.id,
    status: metadata.status,
    agent_type: metadata.agent_type,
    agent_id: metadata.agent_id,
    session_type: resolveSessionType(metadata),
    trigger: metadata.trigger,
    task_id: metadata.task_id,
    task_ref: metadata.task_ref,
    started_at: metadata.started_at,
    ended_at: metadata.ended_at,
    duration_ms: durationMs,
    event_count: metadata.event_count ?? 0,
    iteration_count: metadata.iteration_count ?? 0,
    tasks_completed: metadata.tasks_completed ?? 0,
  };
}

/**
 * Get summaries for all sessions.
 *
 * @param sessionsDir - The .kspec directory path
 * @returns Array of session summaries
 */
export async function getAllSessionLogSummaries(sessionsDir: string): Promise<SessionLogSummary[]> {
  const sessionIds = await listSessions(sessionsDir);
  const summaries = await Promise.all(
    sessionIds.map((id) => getSessionLogSummary(sessionsDir, id)),
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
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @param iteration - Iteration number
 * @param context - The session context data
 */
export async function saveSessionContext(
  sessionsDir: string,
  sessionId: string,
  iteration: number,
  context: unknown,
): Promise<void> {
  const sessionDir = getSessionDir(sessionsDir, sessionId);
  const contextPath = getSessionContextPath(sessionsDir, sessionId, iteration);

  // Ensure session directory exists
  await fsPromises.mkdir(sessionDir, { recursive: true });

  // Write context snapshot as pretty JSON
  const content = JSON.stringify(context, null, 2);
  await fsPromises.writeFile(contextPath, content, "utf-8");
}

/**
 * Read session context snapshot for a given iteration.
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @param iteration - Iteration number
 * @returns The context snapshot or null if not found
 */
export async function readSessionContext(
  sessionsDir: string,
  sessionId: string,
  iteration: number,
): Promise<unknown | null> {
  const contextPath = getSessionContextPath(sessionsDir, sessionId, iteration);

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
 * @param sessionsDir - The .kspec directory path
 * @param idOrPrefix - Full session ID or prefix (e.g., first 8 chars)
 * @returns Resolution result
 */
export async function resolveSessionId(
  sessionsDir: string,
  idOrPrefix: string,
): Promise<SessionIdResolution> {
  const sessionIds = await listSessions(sessionsDir);

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
  /**
   * Session type: "loop" for legacy agent sessions, "invocation" for the
   * current runtime.
   * AC: @session-model-evolution ac-6
   */
  session_type: "loop" | "invocation";
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
async function getIterationNumbers(sessionsDir: string, sessionId: string): Promise<number[]> {
  const sessionDir = getSessionDir(sessionsDir, sessionId);
  try {
    const entries = await fsPromises.readdir(sessionDir);
    const iterations: number[] = [];
    for (const entry of entries) {
      const match = entry.match(/^context-iter-(\d+)\.json$/);
      if (match) {
        iterations.push(parseInt(match[1], 10));
      }
    }
    return iterations.toSorted((a, b) => a - b);
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
 * Iteration boundary: a prompt.sent event with phase "task-work" that marks
 * the start of a new iteration in a legacy loop session.
 */
interface IterationBoundary {
  /** Array index in the events list */
  index: number;
  /** Iteration number from the event data */
  iteration: number;
}

/**
 * Find iteration boundaries from prompt.sent events with phase "task-work".
 *
 * The dispatch runtime emits these synchronously at the start of each
 * iteration, so their
 * array positions are reliable even when concurrent fire-and-forget events
 * produce duplicate seq numbers.
 *
 * Returns validated, monotonically increasing boundaries.
 */
function findIterationBoundaries(events: SessionEvent[]): IterationBoundary[] {
  const raw: IterationBoundary[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type !== "prompt.sent") continue;

    const data = event.data as {
      phase?: string;
      iteration?: number;
    } | null;

    if (data?.phase !== "task-work" || typeof data?.iteration !== "number") {
      continue;
    }

    raw.push({ index: i, iteration: data.iteration });
  }

  // Validate: filter to monotonically increasing iteration numbers, deduplicate
  const validated: IterationBoundary[] = [];
  let lastIter = -Infinity;

  for (const b of raw) {
    if (b.iteration > lastIter) {
      validated.push(b);
      lastIter = b.iteration;
    }
  }

  return validated;
}

/**
 * Extract task start/complete refs from a slice of events.
 */
function extractTaskTransitions(events: SessionEvent[]): {
  tasksStarted: string[];
  tasksCompleted: string[];
} {
  const tasksStarted: string[] = [];
  const tasksCompleted: string[] = [];

  for (const event of events) {
    if (event.type === "session.update") {
      const update = unwrapSessionUpdate(event.data as Record<string, unknown> | null);
      const rawCommand = (update?.rawInput as Record<string, unknown> | undefined)?.command as
        | string
        | string[]
        | undefined;
      // Normalize: string (claude-*-acp) or array like [bash, -lc, cmd] (codex-acp)
      const command =
        typeof rawCommand === "string"
          ? rawCommand
          : Array.isArray(rawCommand) && rawCommand.length > 0
            ? rawCommand[rawCommand.length - 1]
            : undefined;
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

  return { tasksStarted, tasksCompleted };
}

/**
 * Legacy iteration grouping: groups events by their data.iteration field.
 *
 * Used as fallback for sessions that don't have prompt.sent boundary events
 * with phase "task-work" (pre-boundary sessions or non-loop sessions).
 *
 * AC: @session-log-show ac-2
 */
function legacyIterationGrouping(
  events: SessionEvent[],
  snapshotIterations: number[],
): IterationSummary[] {
  // Collect all iteration numbers from both snapshots and events
  const allIterations = new Set<number>(snapshotIterations);
  for (const event of events) {
    const data = event.data as { iteration?: number } | null;
    if (typeof data?.iteration === "number") {
      allIterations.add(data.iteration);
    }
  }

  // If no iterations found anywhere, synthesize iteration-0 only if events exist
  if (allIterations.size === 0) {
    if (events.length === 0) {
      return [];
    }
    const { tasksStarted, tasksCompleted } = extractTaskTransitions(events);
    return [
      {
        iteration: 0,
        event_count: events.length,
        tasks_started: tasksStarted,
        tasks_completed: tasksCompleted,
      },
    ];
  }

  // Create buckets for all known iterations
  const iterations = Array.from(allIterations).toSorted((a, b) => a - b);
  const iterationMap = new Map<number, SessionEvent[]>();
  for (const n of iterations) {
    iterationMap.set(n, []);
  }

  for (const event of events) {
    const data = event.data as { iteration?: number } | null;
    const iter = data?.iteration;
    if (typeof iter === "number" && iterationMap.has(iter)) {
      iterationMap.get(iter)!.push(event);
    } else {
      const fallbackIter = iterationMap.has(0) ? 0 : iterations[0];
      iterationMap.get(fallbackIter)!.push(event);
    }
  }

  const summaries: IterationSummary[] = [];
  for (const [iterNum, iterEvents] of iterationMap) {
    const { tasksStarted, tasksCompleted } = extractTaskTransitions(iterEvents);
    summaries.push({
      iteration: iterNum,
      event_count: iterEvents.length,
      tasks_started: tasksStarted,
      tasks_completed: tasksCompleted,
    });
  }

  return summaries.toSorted((a, b) => a.iteration - b.iteration);
}

/**
 * Boundary-based iteration grouping: splits events by prompt.sent boundary
 * positions (array indices) instead of trusting data.iteration fields.
 *
 * This is resilient to producer-side bugs where concurrent fire-and-forget
 * event logging captures the wrong iteration number.
 *
 * AC: @session-log-show ac-10
 */
function boundaryIterationGrouping(
  events: SessionEvent[],
  boundaries: IterationBoundary[],
): IterationSummary[] {
  const summaries: IterationSummary[] = [];

  for (let b = 0; b < boundaries.length; b++) {
    const startIdx = boundaries[b].index;
    const endIdx = b + 1 < boundaries.length ? boundaries[b + 1].index : events.length;
    const iterEvents = events.slice(startIdx, endIdx);
    const { tasksStarted, tasksCompleted } = extractTaskTransitions(iterEvents);

    summaries.push({
      iteration: boundaries[b].iteration,
      event_count: iterEvents.length,
      tasks_started: tasksStarted,
      tasks_completed: tasksCompleted,
    });
  }

  // Pre-boundary events (before the first prompt.sent) merge into first iteration
  if (boundaries.length > 0 && boundaries[0].index > 0) {
    const preBoundaryEvents = events.slice(0, boundaries[0].index);
    const { tasksStarted, tasksCompleted } = extractTaskTransitions(preBoundaryEvents);
    summaries[0].event_count += preBoundaryEvents.length;
    summaries[0].tasks_started = [...tasksStarted, ...summaries[0].tasks_started];
    summaries[0].tasks_completed = [...tasksCompleted, ...summaries[0].tasks_completed];
  }

  return summaries;
}

/**
 * Compute per-iteration summaries from events.
 *
 * Uses prompt.sent boundary events (phase: "task-work") when available for
 * accurate index-based grouping. Falls back to legacy data.iteration grouping
 * for sessions without boundaries.
 *
 * AC: @session-log-show ac-2, ac-10
 */
async function computeIterationSummaries(
  sessionsDir: string,
  sessionId: string,
): Promise<IterationSummary[]> {
  const events = await readEvents(sessionsDir, sessionId);
  const boundaries = findIterationBoundaries(events);

  if (boundaries.length > 0) {
    return boundaryIterationGrouping(events, boundaries);
  }

  // Legacy fallback: no prompt.sent boundaries with phase "task-work"
  const snapshotIterations = await getIterationNumbers(sessionsDir, sessionId);
  return legacyIterationGrouping(events, snapshotIterations);
}

/**
 * Count iterations using boundary-aware logic, without computing full summaries.
 *
 * For use in getSessionLogSummary() (session log list, session log stats) to
 * ensure iteration_count agrees with session log show.
 *
 * Falls back to counting context-iter-*.json files when no boundaries exist.
 */
async function countIterationsBoundaryAware(
  sessionsDir: string,
  sessionId: string,
): Promise<number> {
  const events = await readEvents(sessionsDir, sessionId);
  const boundaries = findIterationBoundaries(events);

  if (boundaries.length > 0) {
    return boundaries.length;
  }

  // Legacy fallback: count from context snapshots and event data
  const snapshotIterations = await getIterationNumbers(sessionsDir, sessionId);
  const allIterations = new Set<number>(snapshotIterations);
  for (const event of events) {
    const data = event.data as { iteration?: number } | null;
    if (typeof data?.iteration === "number") {
      allIterations.add(data.iteration);
    }
  }

  return allIterations.size || (events.length > 0 ? 1 : 0);
}

/**
 * Get full session detail for session log show.
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID (must be resolved first)
 * @returns Session detail or null if not found
 */
export async function getSessionLogDetail(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionLogDetail | null> {
  const metadata = await getSession(sessionsDir, sessionId);
  if (!metadata) return null;

  const [eventCount, iterations] = await Promise.all([
    countEventLines(sessionsDir, sessionId),
    computeIterationSummaries(sessionsDir, sessionId),
  ]);

  const startMs = new Date(metadata.started_at).getTime();
  const endMs = metadata.ended_at ? new Date(metadata.ended_at).getTime() : Date.now();
  const durationMs = endMs - startMs;

  return {
    id: metadata.id,
    status: metadata.status,
    agent_type: metadata.agent_type,
    session_type: resolveSessionType(metadata),
    task_id: metadata.task_id,
    started_at: metadata.started_at,
    ended_at: metadata.ended_at,
    duration_ms: durationMs,
    event_count: eventCount,
    iteration_count: iterations.length,
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
export function computeSessionLogStats(summaries: SessionLogSummary[]): SessionLogStats {
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
    timed_out: 0,
    failed: 0,
    stalled: 0,
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
  for (const status of [
    "completed",
    "active",
    "abandoned",
    "timed_out",
    "failed",
    "stalled",
  ] as SessionStatus[]) {
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
  sessionsDir: string,
  sessionIds: string[],
  limit: number = 10,
): Promise<ToolUsageStats[]> {
  const toolCounts: Record<string, number> = {};
  let totalToolCalls = 0;

  for (const sessionId of sessionIds) {
    const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
    try {
      const content = await fsPromises.readFile(eventsPath, "utf-8");
      if (!content.trim()) continue;
      const lines = content.trim().split("\n");
      // Track seen toolCallIds to deduplicate phased events
      const seenToolCallIds = new Set<string>();
      for (const line of lines) {
        // Quick pre-filter: only parse lines that might be tool_call events
        if (!line.includes('"tool_call"')) continue;
        try {
          const event = JSON.parse(line);
          if (event?.type === "session.update") {
            const update = unwrapSessionUpdate(event?.data);
            if (update?.sessionUpdate === "tool_call") {
              // Deduplicate phased tool_call events by toolCallId
              const { toolCallId } = extractToolCallFields(update);
              if (toolCallId && seenToolCallIds.has(toolCallId)) continue;
              if (toolCallId) seenToolCallIds.add(toolCallId);
              const toolName = extractToolName(update);
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
      percentage: totalToolCalls > 0 ? Math.round((count / totalToolCalls) * 100 * 10) / 10 : 0,
    }))
    .toSorted((a, b) => b.count - a.count)
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
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

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
    .toSorted((a, b) => b.period.localeCompare(a.period));

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
  /** Event sequence number within the session log */
  event_seq: number;
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
  /** Pre-filtered session IDs to search (bypasses internal metadata filtering) */
  sessionIds?: string[];
  /** Pre-filtered session summaries to search (avoids reloading metadata) */
  sessionSummaries?: SessionLogSummary[];
  /** Maximum total matches to return (default: 50) */
  limit?: number;
  /** Resolve blob pointers and search full payload content */
  resolveBlobs?: boolean;
}

/**
 * Extract a content excerpt around a match, limited to maxLength chars.
 *
 * AC: @session-log-search ac-4
 */
function extractContentExcerpt(data: unknown, pattern: string, maxLength: number = 200): string {
  // Stringify the data for searching
  const str = JSON.stringify(data);
  const lowerStr = str.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  const matchIndex = lowerStr.indexOf(lowerPattern);
  if (matchIndex === -1) {
    // Shouldn't happen since we pre-filtered, but return start of content
    return str.length > maxLength ? `${str.slice(0, maxLength - 3)}...` : str;
  }

  // Calculate excerpt window centered on match
  const matchLen = pattern.length;
  const contextBefore = Math.floor((maxLength - matchLen) / 2);
  const start = Math.max(0, matchIndex - contextBefore);
  const end = Math.min(str.length, start + maxLength);

  let excerpt = str.slice(start, end);

  // Add ellipsis indicators
  if (start > 0) {
    excerpt = `...${excerpt.slice(3)}`;
  }
  if (end < str.length) {
    excerpt = `${excerpt.slice(0, -3)}...`;
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
 * @param sessionsDir - The .kspec directory path
 * @param pattern - Case-insensitive substring to search for
 * @param options - Search filtering options
 * @returns Array of search results grouped by session
 */
export async function searchSessionEvents(
  sessionsDir: string,
  pattern: string,
  options: SearchOptions = {},
): Promise<SessionSearchResult[]> {
  // Defense-in-depth: normalize limit to a valid positive integer
  const rawLimit = options.limit ?? 50;
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 50 : rawLimit;
  const lowerPattern = pattern.toLowerCase();
  const resolveBlobs = options.resolveBlobs ?? false;

  // Use pre-filtered session IDs if provided, otherwise load and filter
  let filteredSummaries: SessionLogSummary[];
  if (options.sessionSummaries) {
    filteredSummaries = [...options.sessionSummaries];
  } else if (options.sessionIds) {
    const idSet = new Set(options.sessionIds);
    const allSummaries = await getAllSessionLogSummaries(sessionsDir);
    filteredSummaries = allSummaries.filter((s) => idSet.has(s.id));
  } else {
    const allSummaries = await getAllSessionLogSummaries(sessionsDir);

    // AC: @session-log-search ac-3 - Pre-filter by --since
    filteredSummaries = allSummaries;
    if (options.sinceDate) {
      filteredSummaries = filteredSummaries.filter(
        (s) => new Date(s.started_at) >= options.sinceDate!,
      );
    }

    // AC: @session-log-search ac-7 - Pre-filter by --agent
    if (options.agentType) {
      filteredSummaries = filteredSummaries.filter((s) => s.agent_type === options.agentType);
    }
  }

  const results: SessionSearchResult[] = [];
  let totalMatches = 0;

  for (const summary of filteredSummaries) {
    if (totalMatches >= limit) break;

    const eventsPath = getSessionEventsPath(sessionsDir, summary.id);
    let content: string;
    try {
      content = await fsPromises.readFile(eventsPath, "utf-8");
    } catch {
      continue; // Skip sessions without events
    }

    if (!content.trim()) continue;

    const matches: SearchMatch[] = [];
    const lines = content.trim().split("\n");
    // Track seen tool_call IDs to skip phased duplicates
    const seenToolCallIds = new Set<string>();

    for (const line of lines) {
      if (totalMatches >= limit) break;

      // Quick substring pre-filter before parsing JSON.
      // Disabled when resolving blobs because full content lives outside line.
      if (!resolveBlobs && !line.toLowerCase().includes(lowerPattern)) continue;

      try {
        const event = JSON.parse(line);

        // AC: @session-log-search ac-2 - Filter by event type
        if (options.eventType && event.type !== options.eventType) continue;

        // Deduplicate phased tool_call events
        if (event?.type === "session.update") {
          const update = unwrapSessionUpdate(event?.data);
          if (update?.sessionUpdate === "tool_call") {
            const { toolCallId } = extractToolCallFields(update);
            if (toolCallId) {
              if (seenToolCallIds.has(toolCallId)) continue;
              seenToolCallIds.add(toolCallId);
            }
          }
        }

        const searchableData = resolveBlobs
          ? await resolveSessionBlobPointers(sessionsDir, summary.id, event.data)
          : event.data;

        // Verify match in stringified data (not just line, in case pattern
        // appears in metadata)
        const dataStr = JSON.stringify(searchableData);
        if (!dataStr.toLowerCase().includes(lowerPattern)) continue;

        // AC: @session-log-search ac-4 - Create match with excerpt
        matches.push({
          session_id: summary.id,
          event_seq: typeof event.seq === "number" ? event.seq : -1,
          timestamp: event.ts,
          event_type: event.type,
          content_excerpt: extractContentExcerpt(searchableData, pattern, 200),
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

// ─── Session Creation with Budget ─────────────────────────────────────────────

/**
 * Create a session with an optional task budget in one call.
 *
 * This is the library-level entry point for session creation. It creates
 * the session directory, writes session.yaml, and optionally writes budget.json.
 * Returns metadata without any console output.
 *
 * AC: @session-creation-and-env-injection ac-create
 * AC: @session-creation-and-env-injection ac-budget
 * AC: @session-creation-and-env-injection ac-budget-local
 * AC: @session-creation-and-env-injection ac-library
 *
 * @param sessionsDir - The .kspec directory path
 * @param input - Session creation parameters
 * @returns Session metadata and optional budget (no console output)
 */
export async function createSessionWithBudget(
  sessionsDir: string,
  input: {
    id: string;
    agent_type: string;
    task_id?: string;
    budget?: number;
  },
): Promise<{
  session_id: string;
  session: SessionMetadata;
  budget: TaskBudget | null;
}> {
  // Create session
  const session = await createSession(sessionsDir, {
    id: input.id,
    agent_type: input.agent_type,
    task_id: input.task_id,
  });

  // Optionally create budget
  let budget: TaskBudget | null = null;
  if (input.budget !== undefined && input.budget > 0) {
    budget = await createBudget(sessionsDir, input.id, input.budget);
  }

  return {
    session_id: input.id,
    session,
    budget,
  };
}

// ─── Environment Injection ────────────────────────────────────────────────────

/**
 * Result of environment injection attempt.
 */
export interface EnvInjectionResult {
  /** Whether injection was performed */
  injected: boolean;
  /** Method used for injection */
  method:
    | "claude_env_file"
    | "claude_settings"
    | "codex_config"
    | "gemini_dotenv"
    | "opencode_dotenv"
    | "fallback";
  /** Human-readable description of what was done */
  description: string;
  /** Path to file modified (if applicable) */
  path?: string;
  /** Previous KSPEC_SESSION_ID value before injection (for restore on cleanup) */
  previousValue?: string | null;
}

/**
 * Write or update KSPEC_SESSION_ID in a dotenv-style file.
 * Replaces an existing KSPEC_SESSION_ID line or appends a new one.
 */
async function upsertDotenvSessionId(filePath: string, sessionId: string): Promise<void> {
  let content = "";
  try {
    content = await fsPromises.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      // File doesn't exist yet, start fresh
    } else {
      throw err;
    }
  }

  const lines = content.split("\n");
  const existingIdx = lines.findIndex((l) => l.startsWith("KSPEC_SESSION_ID="));
  if (existingIdx >= 0) {
    lines[existingIdx] = `KSPEC_SESSION_ID=${sessionId}`;
  } else {
    // Append before final empty line if present
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.splice(lines.length - 1, 0, `KSPEC_SESSION_ID=${sessionId}`);
    } else {
      lines.push(`KSPEC_SESSION_ID=${sessionId}`);
    }
  }

  await fsPromises.writeFile(filePath, lines.join("\n"), "utf-8");
}

/**
 * Inject KSPEC_SESSION_ID into Claude Code environment.
 *
 * Strategy:
 * 1. If CLAUDE_ENV_FILE is set, write to that file
 * 2. Otherwise, append to project .claude/settings.local.json env section
 *
 * AC: @session-creation-and-env-injection ac-inject-claude
 */
export async function injectClaudeCodeEnv(sessionId: string): Promise<EnvInjectionResult> {
  const envFile = process.env.CLAUDE_ENV_FILE;

  if (envFile) {
    const previousValue = await readDotenvSessionId(envFile);
    await upsertDotenvSessionId(envFile, sessionId);
    return {
      injected: true,
      method: "claude_env_file",
      description: `Wrote KSPEC_SESSION_ID=${sessionId} to CLAUDE_ENV_FILE`,
      path: envFile,
      previousValue,
    };
  }

  // Fallback: write to project .claude/settings.local.json (gitignored, user-local)
  // Using settings.local.json avoids dirtying the working tree — settings.json
  // is checked into the repo. Claude Code merges both, with local taking precedence.
  const settingsDir = path.join(process.cwd(), ".claude");
  const settingsPath = path.join(settingsDir, "settings.local.json");

  await fsPromises.mkdir(settingsDir, { recursive: true });

  let settings: Record<string, unknown> = {};
  try {
    const content = await fsPromises.readFile(settingsPath, "utf-8");
    settings = JSON.parse(content);
  } catch (err: unknown) {
    // Only start fresh for ENOENT; throw on parse errors to avoid overwriting
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      // File doesn't exist, start fresh
    } else {
      throw new Error(
        `Cannot inject env: .claude/settings.local.json exists but is not valid JSON. ` +
          `Fix the file manually or remove it, then retry.`,
        { cause: err },
      );
    }
  }

  // Capture previous value before overwriting
  const previousValue =
    settings.env && typeof settings.env === "object"
      ? ((settings.env as Record<string, string>).KSPEC_SESSION_ID ?? null)
      : null;

  // Ensure env section exists
  if (!settings.env || typeof settings.env !== "object") {
    settings.env = {};
  }
  (settings.env as Record<string, string>).KSPEC_SESSION_ID = sessionId;

  await fsPromises.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");

  return {
    injected: true,
    method: "claude_settings",
    description: `Added KSPEC_SESSION_ID to .claude/settings.local.json env section`,
    path: settingsPath,
    previousValue,
  };
}

/**
 * Remove or restore KSPEC_SESSION_ID in Claude Code environment.
 *
 * Reverses the injection performed by injectClaudeCodeEnv().
 * If previousValue is provided, restores it instead of deleting.
 * Best-effort: silently ignores missing files or missing keys.
 *
 * @param previousValue - Value to restore, or null/undefined to delete
 */
export async function removeClaudeCodeEnv(previousValue?: string | null): Promise<void> {
  const envFile = process.env.CLAUDE_ENV_FILE;

  if (envFile) {
    if (previousValue) {
      await upsertDotenvSessionId(envFile, previousValue);
    } else {
      await removeDotenvSessionId(envFile);
    }
    return;
  }

  // Remove/restore in project .claude/settings.local.json
  const settingsPath = path.join(process.cwd(), ".claude", "settings.local.json");

  try {
    const content = await fsPromises.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content);

    if (settings.env && typeof settings.env === "object") {
      if (previousValue) {
        (settings.env as Record<string, string>).KSPEC_SESSION_ID = previousValue;
      } else {
        delete (settings.env as Record<string, unknown>).KSPEC_SESSION_ID;

        // Remove env section entirely if empty
        if (Object.keys(settings.env as Record<string, unknown>).length === 0) {
          delete settings.env;
        }
      }

      await fsPromises.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
    }
  } catch {
    // Best-effort cleanup — file may not exist or may not be valid JSON
  }
}

/**
 * Read existing KSPEC_SESSION_ID from a dotenv-style file.
 * Returns the value or null if not found.
 */
async function readDotenvSessionId(filePath: string): Promise<string | null> {
  try {
    const content = await fsPromises.readFile(filePath, "utf-8");
    const match = content.match(/^KSPEC_SESSION_ID=(.+)$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Remove KSPEC_SESSION_ID line from a dotenv-style file.
 */
async function removeDotenvSessionId(filePath: string): Promise<void> {
  try {
    const content = await fsPromises.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const filtered = lines.filter((l) => !l.startsWith("KSPEC_SESSION_ID="));
    if (filtered.length !== lines.length) {
      await fsPromises.writeFile(filePath, filtered.join("\n"), "utf-8");
    }
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Inject KSPEC_SESSION_ID into Codex CLI environment.
 *
 * Adds to shell_environment_policy.set in codex config.
 *
 * AC: @session-creation-and-env-injection ac-inject-codex
 */
export async function injectCodexEnv(sessionId: string): Promise<EnvInjectionResult> {
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || "", ".codex");
  const configPath = path.join(configDir, "config.toml");

  await fsPromises.mkdir(configDir, { recursive: true });

  let config: Record<string, unknown> = {};
  try {
    const content = await fsPromises.readFile(configPath, "utf-8");
    config = parseTOML(content) as Record<string, unknown>;
  } catch (err: unknown) {
    // Only start fresh for ENOENT; throw on parse errors to avoid overwriting
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      // File doesn't exist, start fresh
    } else {
      throw new Error(
        `Cannot inject env: ~/.codex/config.toml exists but is not valid TOML. ` +
          `Fix the file manually or remove it, then retry.`,
        { cause: err },
      );
    }
  }

  // Capture previous value before overwriting
  const previousValue =
    config.shell_environment_policy &&
    typeof config.shell_environment_policy === "object" &&
    (config.shell_environment_policy as Record<string, unknown>).set &&
    typeof (config.shell_environment_policy as Record<string, unknown>).set === "object"
      ? ((config.shell_environment_policy as Record<string, Record<string, string>>).set
          .KSPEC_SESSION_ID ?? null)
      : null;

  // Ensure shell_environment_policy.set exists
  if (!config.shell_environment_policy || typeof config.shell_environment_policy !== "object") {
    config.shell_environment_policy = {};
  }
  const policy = config.shell_environment_policy as Record<string, unknown>;
  if (!policy.set || typeof policy.set !== "object") {
    policy.set = {};
  }
  (policy.set as Record<string, string>).KSPEC_SESSION_ID = sessionId;

  await fsPromises.writeFile(configPath, `${stringifyTOML(config)}\n`, "utf-8");

  return {
    injected: true,
    method: "codex_config",
    description: `Added KSPEC_SESSION_ID to Codex config shell_environment_policy.set`,
    path: configPath,
    previousValue,
  };
}

/**
 * Remove or restore KSPEC_SESSION_ID in Codex config.
 *
 * Reverses the injection performed by injectCodexEnv().
 * If previousValue is provided, restores it instead of deleting.
 * Best-effort: silently ignores missing files or missing keys.
 *
 * @param previousValue - Value to restore, or null/undefined to delete
 */
export async function removeCodexEnv(previousValue?: string | null): Promise<void> {
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || "", ".codex");
  const configPath = path.join(configDir, "config.toml");

  try {
    const content = await fsPromises.readFile(configPath, "utf-8");
    const config = parseTOML(content) as Record<string, unknown>;

    const rawPolicy = config.shell_environment_policy;
    if (rawPolicy && typeof rawPolicy === "object") {
      const policy = rawPolicy as Record<string, unknown>;
      if (policy.set && typeof policy.set === "object") {
        if (previousValue) {
          (policy.set as Record<string, string>).KSPEC_SESSION_ID = previousValue;
        } else {
          delete (policy.set as Record<string, unknown>).KSPEC_SESSION_ID;

          // Remove set section entirely if empty
          if (Object.keys(policy.set as Record<string, unknown>).length === 0) {
            delete policy.set;
          }

          // Remove shell_environment_policy if empty
          if (Object.keys(policy).length === 0) {
            delete config.shell_environment_policy;
          }
        }
      }

      await fsPromises.writeFile(configPath, `${stringifyTOML(config)}\n`, "utf-8");
    }
  } catch {
    // Best-effort cleanup — file may not exist or may not be valid TOML
  }
}

/**
 * Inject KSPEC_SESSION_ID into Gemini CLI environment.
 *
 * Writes to .gemini/.env in project root (auto-loaded by Gemini CLI).
 */
export async function injectGeminiEnv(sessionId: string): Promise<EnvInjectionResult> {
  const dotenvDir = path.join(process.cwd(), ".gemini");
  const dotenvPath = path.join(dotenvDir, ".env");

  await fsPromises.mkdir(dotenvDir, { recursive: true });
  await upsertDotenvSessionId(dotenvPath, sessionId);

  return {
    injected: true,
    method: "gemini_dotenv",
    description: `Wrote KSPEC_SESSION_ID=${sessionId} to .gemini/.env`,
    path: dotenvPath,
  };
}

/**
 * Inject KSPEC_SESSION_ID into OpenCode environment.
 *
 * Writes to project root .env file (auto-loaded by OpenCode via Bun runtime).
 * Uses the same dotenv append/replace pattern as other injectors.
 */
export async function injectOpenCodeEnv(sessionId: string): Promise<EnvInjectionResult> {
  const dotenvPath = path.join(process.cwd(), ".env");

  await upsertDotenvSessionId(dotenvPath, sessionId);

  return {
    injected: true,
    method: "opencode_dotenv",
    description: `Wrote KSPEC_SESSION_ID=${sessionId} to .env`,
    path: dotenvPath,
  };
}

/**
 * Get fallback injection instructions for unknown agent harnesses.
 *
 * AC: @session-creation-and-env-injection ac-inject-fallback
 */
export function getFallbackInjectionInstructions(sessionId: string): EnvInjectionResult {
  return {
    injected: false,
    method: "fallback",
    description: `export KSPEC_SESSION_ID=${sessionId}`,
  };
}

// ─── Adapter-based Env Injection ──────────────────────────────────────────────

/**
 * Inject KSPEC_SESSION_ID via the appropriate mechanism for the given adapter.
 *
 * The legacy runtime passed env vars to spawned agents via process
 * environment, but some
 * harnesses (Claude Code, Codex, etc.) sandbox child processes and don't
 * forward arbitrary parent env vars. This function writes the session ID to
 * the harness-specific config location so it reaches kspec subprocesses.
 *
 * @param adapterId - The adapter identifier (e.g., "claude-agent-acp")
 * @param sessionId - The session ID to inject
 * @returns Injection result, or null if no harness-specific injection is needed
 */
export async function injectEnvForAdapter(
  adapterId: string,
  sessionId: string,
): Promise<EnvInjectionResult | null> {
  switch (adapterId) {
    case "claude-agent-acp":
    case "claude-code-acp":
      return injectClaudeCodeEnv(sessionId);
    case "codex-acp":
      return injectCodexEnv(sessionId);
    // Future harnesses can be added here:
    // case "gemini-acp":
    //   return injectGeminiEnv(sessionId);
    default:
      return null; // Unknown adapter — rely on process env inheritance
  }
}

/**
 * Remove KSPEC_SESSION_ID from the harness config for the given adapter.
 *
 * Reverses the injection performed by injectEnvForAdapter().
 * If previousValue is provided, restores it instead of deleting.
 * Best-effort: silently ignores errors.
 *
 * @param adapterId - The adapter identifier
 * @param previousValue - Value to restore, or null/undefined to delete
 */
export async function removeEnvForAdapter(
  adapterId: string,
  previousValue?: string | null,
): Promise<void> {
  switch (adapterId) {
    case "claude-agent-acp":
    case "claude-code-acp":
      await removeClaudeCodeEnv(previousValue);
      break;
    case "codex-acp":
      await removeCodexEnv(previousValue);
      break;
  }
}

// ─── Session Validation ───────────────────────────────────────────────────────

/**
 * Validate that the current KSPEC_SESSION_ID points to a valid session.
 *
 * AC: @session-creation-and-env-injection ac-invalid-session
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - The session ID to validate
 * @returns Validation result with error details if invalid
 */
export async function validateSessionId(
  sessionsDir: string,
  sessionId: string,
): Promise<{
  valid: boolean;
  session?: SessionMetadata;
  error?: string;
  suggestion?: string;
}> {
  // Check if session directory exists
  const exists = await sessionExists(sessionsDir, sessionId);
  if (!exists) {
    return {
      valid: false,
      error: `Session not found: ${sessionId}`,
      suggestion: `Unset KSPEC_SESSION_ID or create a new session with: kspec session create --agent-type <type>`,
    };
  }

  // Try to read and validate session metadata
  const session = await getSession(sessionsDir, sessionId);
  if (!session) {
    return {
      valid: false,
      error: `Session metadata is corrupt or unreadable: ${sessionId}`,
      suggestion: `Unset KSPEC_SESSION_ID or create a new session with: kspec session create --agent-type <type>`,
    };
  }

  return { valid: true, session };
}

// ─── Task Budget ──────────────────────────────────────────────────────────────

/**
 * Atomic JSON write — write to temp file then rename in same directory.
 * Prevents corruption on crash.
 * AC: @task-budget-enforcement ac-atomic-write
 */
async function writeBudgetAtomic(filePath: string, budget: TaskBudget): Promise<void> {
  const dir = path.dirname(filePath);
  await fsPromises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const content = `${JSON.stringify(budget, null, 2)}\n`;
  await fsPromises.writeFile(tmpPath, content, "utf-8");
  await fsPromises.rename(tmpPath, filePath);
}

/**
 * Create a budget for a session.
 *
 * Writes budget.json to .kspec-sessions/{id}/ on the local filesystem
 * (NOT committed to shadow branch).
 *
 * AC: @session-creation-and-env-injection ac-budget
 * AC: @session-creation-and-env-injection ac-budget-local
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @param maxPerCycle - Maximum tasks allowed per cycle
 * @returns The created budget
 */
export async function createBudget(
  sessionsDir: string,
  sessionId: string,
  maxPerCycle: number,
): Promise<TaskBudget> {
  const budget: TaskBudget = {
    max_per_cycle: maxPerCycle,
    started_this_cycle: 0,
  };
  const validated = TaskBudgetSchema.parse(budget);
  const budgetPath = getSessionBudgetPath(sessionsDir, sessionId);
  await writeBudgetAtomic(budgetPath, validated);
  return validated;
}

/**
 * Read budget for a session.
 *
 * AC: @task-budget-enforcement ac-no-budget
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns Budget or null if no budget configured (opt-in)
 */
export async function getBudget(
  sessionsDir: string,
  sessionId: string,
): Promise<TaskBudget | null> {
  const budgetPath = getSessionBudgetPath(sessionsDir, sessionId);
  let content: string;
  try {
    content = await fsPromises.readFile(budgetPath, "utf-8");
  } catch (err: unknown) {
    // File doesn't exist = no budget configured (opt-in)
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  // File exists — parse errors are real failures, not "no budget"
  const raw = JSON.parse(content);
  return TaskBudgetSchema.parse(raw);
}

/**
 * Check whether the budget allows starting a new task.
 *
 * Returns an object with `allowed` boolean and context about the budget.
 * When no budget is configured, always allows (opt-in behavior).
 *
 * AC: @task-budget-enforcement ac-block-start
 * AC: @task-budget-enforcement ac-no-budget
 * AC: @task-budget-enforcement ac-no-session
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID, or undefined if KSPEC_SESSION_ID not set
 * @returns Budget check result
 */
export async function checkBudget(
  sessionsDir: string,
  sessionId: string | undefined,
): Promise<{
  allowed: boolean;
  reason?: string;
  budget?: TaskBudget;
}> {
  // AC: @task-budget-enforcement ac-no-session — no session means no check
  if (!sessionId) {
    return { allowed: true };
  }

  // Skip budget enforcement when session exists but is not active (stale KSPEC_SESSION_ID).
  // A completed, abandoned, timed_out, failed, or stalled session should not block task starts.
  // If session metadata is missing, proceed with normal budget checks — the budget file
  // itself is the authority on whether enforcement applies.
  const session = await getSession(sessionsDir, sessionId);
  if (session && session.status !== "active") {
    return { allowed: true };
  }

  const budget = await getBudget(sessionsDir, sessionId);

  // AC: @task-budget-enforcement ac-no-budget — no budget means no check
  if (!budget) {
    return { allowed: true };
  }

  if (budget.started_this_cycle >= budget.max_per_cycle) {
    return {
      allowed: false,
      reason: `Task budget exhausted: ${budget.started_this_cycle}/${budget.max_per_cycle} tasks started this cycle. Wrap up current work and let the iteration end naturally without starting new tasks.`,
      budget,
    };
  }

  return { allowed: true, budget };
}

/**
 * Increment the budget counter after a task is successfully started.
 *
 * IMPORTANT: Callers must NOT call this for resume cases (task already
 * in_progress). The budget should only be incremented when a new task
 * transitions to in_progress, not when resuming an existing one.
 * See AC: @task-budget-enforcement ac-resume-no-increment
 *
 * AC: @task-budget-enforcement ac-increment
 * AC: @task-budget-enforcement ac-atomic-write
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns Updated budget, or null if no budget configured
 */
export async function incrementBudget(
  sessionsDir: string,
  sessionId: string,
): Promise<TaskBudget | null> {
  const budget = await getBudget(sessionsDir, sessionId);
  if (!budget) {
    return null;
  }

  const updated: TaskBudget = {
    ...budget,
    started_this_cycle: budget.started_this_cycle + 1,
  };
  const validated = TaskBudgetSchema.parse(updated);
  const budgetPath = getSessionBudgetPath(sessionsDir, sessionId);
  await writeBudgetAtomic(budgetPath, validated);
  return validated;
}

/**
 * Reset the budget counter to 0 for a new cycle/iteration.
 *
 * Called by the dispatch loop at iteration boundaries. Single-writer guarantee:
 * the loop only resets between iterations when the agent is not running.
 *
 * AC: @task-budget-enforcement ac-reset
 * AC: @task-budget-enforcement ac-atomic-write
 *
 * @param sessionsDir - The .kspec directory path
 * @param sessionId - Session ID
 * @returns Updated budget, or null if no budget configured
 */
export async function resetBudget(
  sessionsDir: string,
  sessionId: string,
): Promise<TaskBudget | null> {
  const budget = await getBudget(sessionsDir, sessionId);
  if (!budget) {
    return null;
  }

  const updated: TaskBudget = {
    ...budget,
    started_this_cycle: 0,
  };
  const validated = TaskBudgetSchema.parse(updated);
  const budgetPath = getSessionBudgetPath(sessionsDir, sessionId);
  await writeBudgetAtomic(budgetPath, validated);
  return validated;
}
