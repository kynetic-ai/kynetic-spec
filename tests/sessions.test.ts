/**
 * Session event storage tests.
 *
 * Tests for JSONL-based event storage for agent sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SessionMetadataSchema,
  SessionEventSchema,
  SessionStatusSchema,
  EventTypeSchema,
  type SessionMetadataInput,
  type SessionEventInput,
} from '../src/sessions/types.js';
import {
  createSession,
  getSession,
  updateSessionStatus,
  listSessions,
  sessionExists,
  appendEvent,
  readEvents,
  readEventsSince,
  getLastEvent,
  getSessionsDir,
  getSessionDir,
  getSessionMetadataPath,
  getSessionEventsPath,
  saveSessionContext,
  readSessionContext,
  getSessionContextPath,
  getCompletedSessionCountsByAgent,
} from '../src/sessions/store.js';

// ─── Schema Tests ────────────────────────────────────────────────────────────

describe('SessionStatusSchema', () => {
  it('should accept valid status values', () => {
    expect(SessionStatusSchema.safeParse('active').success).toBe(true);
    expect(SessionStatusSchema.safeParse('completed').success).toBe(true);
    expect(SessionStatusSchema.safeParse('abandoned').success).toBe(true);
  });

  it('should reject invalid status values', () => {
    expect(SessionStatusSchema.safeParse('invalid').success).toBe(false);
    expect(SessionStatusSchema.safeParse('pending').success).toBe(false);
    expect(SessionStatusSchema.safeParse('').success).toBe(false);
  });
});

describe('EventTypeSchema', () => {
  it('should accept valid event types', () => {
    expect(EventTypeSchema.safeParse('session.start').success).toBe(true);
    expect(EventTypeSchema.safeParse('session.update').success).toBe(true);
    expect(EventTypeSchema.safeParse('iteration.timeout').success).toBe(true);
    expect(EventTypeSchema.safeParse('session.end').success).toBe(true);
    expect(EventTypeSchema.safeParse('prompt.sent').success).toBe(true);
    expect(EventTypeSchema.safeParse('tool.call').success).toBe(true);
    expect(EventTypeSchema.safeParse('tool.result').success).toBe(true);
    expect(EventTypeSchema.safeParse('note').success).toBe(true);
  });

  it('should reject invalid event types', () => {
    expect(EventTypeSchema.safeParse('invalid').success).toBe(false);
    expect(EventTypeSchema.safeParse('session_start').success).toBe(false);
    expect(EventTypeSchema.safeParse('').success).toBe(false);
  });
});

describe('SessionMetadataSchema', () => {
  // AC: @session-events ac-5
  it('should accept valid session metadata with all fields', () => {
    const metadata = {
      id: '01KF123456789ABCDEFGHJKMNP',
      task_id: '@my-task',
      agent_type: 'claude-code',
      status: 'active',
      started_at: '2026-01-17T10:00:00.000Z',
    };

    const result = SessionMetadataSchema.safeParse(metadata);
    expect(result.success).toBe(true);
  });

  // AC: @session-events ac-5
  it('should accept metadata without optional task_id', () => {
    const metadata = {
      id: '01KF123456789ABCDEFGHJKMNP',
      agent_type: 'claude-code',
      status: 'active',
      started_at: '2026-01-17T10:00:00.000Z',
    };

    const result = SessionMetadataSchema.safeParse(metadata);
    expect(result.success).toBe(true);
  });

  it('should accept completed status with ended_at', () => {
    const metadata = {
      id: '01KF123456789ABCDEFGHJKMNP',
      agent_type: 'claude-code',
      status: 'completed',
      started_at: '2026-01-17T10:00:00.000Z',
      ended_at: '2026-01-17T11:00:00.000Z',
    };

    const result = SessionMetadataSchema.safeParse(metadata);
    expect(result.success).toBe(true);
  });

  it('should reject metadata without required fields', () => {
    const metadata = {
      id: '01KF123456789ABCDEFGHJKMNP',
      status: 'active',
    };

    const result = SessionMetadataSchema.safeParse(metadata);
    expect(result.success).toBe(false);
  });
});

describe('SessionEventSchema', () => {
  // AC: @session-events ac-2
  it('should accept valid event with all fields', () => {
    const event = {
      ts: Date.now(),
      seq: 0,
      type: 'session.start',
      session_id: '01KF123456789ABCDEFGHJKMNP',
      trace_id: 'trace-123',
      data: { message: 'Session started' },
    };

    const result = SessionEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it('should accept event without optional trace_id', () => {
    const event = {
      ts: Date.now(),
      seq: 0,
      type: 'session.start',
      session_id: '01KF123456789ABCDEFGHJKMNP',
      data: null,
    };

    const result = SessionEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it('should reject event without required fields', () => {
    const event = {
      ts: Date.now(),
      type: 'session.start',
    };

    const result = SessionEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('should reject negative sequence number', () => {
    const event = {
      ts: Date.now(),
      seq: -1,
      type: 'session.start',
      session_id: '01KF123456789ABCDEFGHJKMNP',
      data: null,
    };

    const result = SessionEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});

// ─── Path Helper Tests ───────────────────────────────────────────────────────

describe('Path helpers', () => {
  const sessionsDir = '/test/.kspec-sessions';
  const sessionId = '01KF123456789ABCDEFGHJKMNP';

  it('should construct sessions directory path', () => {
    expect(getSessionsDir(sessionsDir)).toBe('/test/.kspec-sessions');
  });

  it('should construct session directory path', () => {
    expect(getSessionDir(sessionsDir, sessionId)).toBe(`/test/.kspec-sessions/${sessionId}`);
  });

  it('should construct metadata file path', () => {
    expect(getSessionMetadataPath(sessionsDir, sessionId)).toBe(
      `/test/.kspec-sessions/${sessionId}/session.yaml`
    );
  });

  it('should construct events file path', () => {
    expect(getSessionEventsPath(sessionsDir, sessionId)).toBe(
      `/test/.kspec-sessions/${sessionId}/events.jsonl`
    );
  });
});

// ─── Storage Tests ───────────────────────────────────────────────────────────

describe('Session storage', () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-session-test-'));
    sessionsDir = path.join(testDir, 'sessions');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  describe('createSession', () => {
    // AC: @session-events ac-1
    it('should create session directory and metadata file', async () => {
      const input: SessionMetadataInput = {
        id: '01KF123456789ABCDEFGHJKMNP',
        agent_type: 'claude-code',
      };

      const metadata = await createSession(sessionsDir, input);

      // Check metadata returned
      expect(metadata.id).toBe(input.id);
      expect(metadata.agent_type).toBe(input.agent_type);
      expect(metadata.status).toBe('active');
      expect(metadata.started_at).toBeDefined();

      // Check directory was created
      const sessionDir = getSessionDir(sessionsDir, input.id);
      const stat = await fs.stat(sessionDir);
      expect(stat.isDirectory()).toBe(true);

      // Check metadata file was created
      const metadataPath = getSessionMetadataPath(sessionsDir, input.id);
      const content = await fs.readFile(metadataPath, 'utf-8');
      expect(content).toContain('id: ' + input.id);
      expect(content).toContain('agent_type: claude-code');
      expect(content).toContain('status: active');
    });

    // AC: @session-events ac-5
    it('should include optional task_id in metadata', async () => {
      const input: SessionMetadataInput = {
        id: '01KF123456789ABCDEFGHJKMNP',
        agent_type: 'claude-code',
        task_id: '@my-task',
      };

      const metadata = await createSession(sessionsDir, input);

      expect(metadata.task_id).toBe('@my-task');

      const metadataPath = getSessionMetadataPath(sessionsDir, input.id);
      const content = await fs.readFile(metadataPath, 'utf-8');
      // Accept both single and double quotes (yaml library uses double quotes)
      expect(content).toMatch(/task_id: ["']@my-task["']/);
    });

    it('should use provided started_at if given', async () => {
      const startTime = '2026-01-17T10:00:00.000Z';
      const input: SessionMetadataInput = {
        id: '01KF123456789ABCDEFGHJKMNP',
        agent_type: 'claude-code',
        started_at: startTime,
      };

      const metadata = await createSession(sessionsDir, input);

      expect(metadata.started_at).toBe(startTime);
    });
  });

  describe('getSession', () => {
    it('should return session metadata if exists', async () => {
      const input: SessionMetadataInput = {
        id: '01KF123456789ABCDEFGHJKMNP',
        agent_type: 'claude-code',
      };

      await createSession(sessionsDir, input);
      const metadata = await getSession(sessionsDir, input.id);

      expect(metadata).not.toBeNull();
      expect(metadata?.id).toBe(input.id);
      expect(metadata?.agent_type).toBe(input.agent_type);
    });

    it('should return null if session does not exist', async () => {
      const metadata = await getSession(sessionsDir, 'nonexistent');

      expect(metadata).toBeNull();
    });
  });

  describe('updateSessionStatus', () => {
    // AC: @session-events ac-6
    it('should update status and set ended_at when completing', async () => {
      const input: SessionMetadataInput = {
        id: '01KF123456789ABCDEFGHJKMNP',
        agent_type: 'claude-code',
      };

      await createSession(sessionsDir, input);
      const updated = await updateSessionStatus(sessionsDir, input.id, 'completed');

      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('completed');
      expect(updated?.ended_at).toBeDefined();

      // Verify persisted
      const reloaded = await getSession(sessionsDir, input.id);
      expect(reloaded?.status).toBe('completed');
      expect(reloaded?.ended_at).toBeDefined();
    });

    // AC: @session-events ac-6
    it('should set ended_at when abandoning', async () => {
      const input: SessionMetadataInput = {
        id: '01KF123456789ABCDEFGHJKMNP',
        agent_type: 'claude-code',
      };

      await createSession(sessionsDir, input);
      const updated = await updateSessionStatus(sessionsDir, input.id, 'abandoned');

      expect(updated?.status).toBe('abandoned');
      expect(updated?.ended_at).toBeDefined();
    });

    it('should return null if session does not exist', async () => {
      const updated = await updateSessionStatus(sessionsDir, 'nonexistent', 'completed');

      expect(updated).toBeNull();
    });
  });

  describe('listSessions', () => {
    it('should list all session IDs', async () => {
      await createSession(sessionsDir, { id: 'session-a', agent_type: 'claude-code' });
      await createSession(sessionsDir, { id: 'session-b', agent_type: 'claude-code' });
      await createSession(sessionsDir, { id: 'session-c', agent_type: 'test-agent' });

      const sessions = await listSessions(sessionsDir);

      expect(sessions).toHaveLength(3);
      expect(sessions).toContain('session-a');
      expect(sessions).toContain('session-b');
      expect(sessions).toContain('session-c');
    });

    it('should return empty array if no sessions', async () => {
      const sessions = await listSessions(sessionsDir);

      expect(sessions).toHaveLength(0);
    });
  });

  describe('sessionExists', () => {
    it('should return true if session exists', async () => {
      await createSession(sessionsDir, { id: 'my-session', agent_type: 'claude-code' });

      const exists = await sessionExists(sessionsDir, 'my-session');

      expect(exists).toBe(true);
    });

    it('should return false if session does not exist', async () => {
      const exists = await sessionExists(sessionsDir, 'nonexistent');

      expect(exists).toBe(false);
    });
  });
});

// ─── Event Storage Tests ─────────────────────────────────────────────────────

describe('Event storage', () => {
  let testDir: string;
  let sessionsDir: string;
  const sessionId = '01KF123456789ABCDEFGHJKMNP';

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-event-test-'));
    sessionsDir = path.join(testDir, 'sessions');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  describe('appendEvent', () => {
    // AC: @session-events ac-2
    it('should append event with auto-assigned ts and seq', async () => {
      const input: SessionEventInput = {
        type: 'session.start',
        session_id: sessionId,
        data: { message: 'Starting session' },
      };

      const event = await appendEvent(sessionsDir, input);

      expect(event.ts).toBeDefined();
      expect(event.ts).toBeGreaterThan(0);
      expect(event.seq).toBe(0);
      expect(event.type).toBe('session.start');
      expect(event.session_id).toBe(sessionId);
      expect(event.data).toEqual({ message: 'Starting session' });
    });

    // AC: @session-events ac-2
    it('should auto-increment seq for subsequent events', async () => {
      const event1 = await appendEvent(sessionsDir, {
        type: 'session.start',
        session_id: sessionId,
        data: null,
      });

      const event2 = await appendEvent(sessionsDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        data: { prompt: 'Hello' },
      });

      const event3 = await appendEvent(sessionsDir, {
        type: 'tool.call',
        session_id: sessionId,
        data: { tool: 'Read' },
      });

      expect(event1.seq).toBe(0);
      expect(event2.seq).toBe(1);
      expect(event3.seq).toBe(2);
    });

    // AC: @session-events ac-2
    it('should derive next seq from the last stored event seq', async () => {
      const sessionDir = getSessionDir(sessionsDir, sessionId);
      const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
      await fs.mkdir(sessionDir, { recursive: true });

      const existing = [
        {
          ts: 1000,
          seq: 5,
          type: 'session.start',
          session_id: sessionId,
          data: null,
        },
        {
          ts: 2000,
          seq: 9,
          type: 'session.update',
          session_id: sessionId,
          data: { message: 'existing tail event' },
        },
      ];
      await fs.writeFile(
        eventsPath,
        `${existing.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf-8',
      );

      const next = await appendEvent(sessionsDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        data: { prompt: 'new event' },
      });

      expect(next.seq).toBe(10);
    });

    // AC: @session-events ac-3
    it('should create session directory if it does not exist (lazy creation)', async () => {
      const event = await appendEvent(sessionsDir, {
        type: 'session.start',
        session_id: sessionId,
        data: null,
      });

      expect(event.seq).toBe(0);

      // Verify directory was created
      const sessionDir = getSessionDir(sessionsDir, sessionId);
      const stat = await fs.stat(sessionDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should preserve optional trace_id', async () => {
      const event = await appendEvent(sessionsDir, {
        type: 'session.start',
        session_id: sessionId,
        trace_id: 'trace-abc-123',
        data: null,
      });

      expect(event.trace_id).toBe('trace-abc-123');
    });

    // AC: @session-events ac-3
    it('should write event as JSON line to events.jsonl', async () => {
      await appendEvent(sessionsDir, {
        type: 'session.start',
        session_id: sessionId,
        data: { key: 'value' },
      });

      await appendEvent(sessionsDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        data: { prompt: 'test' },
      });

      const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
      const content = await fs.readFile(eventsPath, 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines).toHaveLength(2);

      const event1 = JSON.parse(lines[0]);
      expect(event1.type).toBe('session.start');
      expect(event1.seq).toBe(0);

      const event2 = JSON.parse(lines[1]);
      expect(event2.type).toBe('prompt.sent');
      expect(event2.seq).toBe(1);
    });

    // AC: @session-events ac-8
    // AC: @session-events ac-9
    it('should externalize oversized rawOutput and store pointer metadata', async () => {
      const rawOutput = 'X'.repeat(20_000);

      await appendEvent(sessionsDir, {
        type: 'session.update',
        session_id: sessionId,
        data: {
          iteration: 1,
          update: {
            sessionUpdate: 'tool_call_update',
            rawOutput,
          },
        },
      });

      const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
      const lines = (await fs.readFile(eventsPath, 'utf-8')).trim().split('\n');
      expect(lines).toHaveLength(1);

      const stored = JSON.parse(lines[0]);
      const pointer = stored.data.update.rawOutput as {
        path: string;
        bytes: number;
        sha256: string;
        truncated: boolean;
        preview: string;
      };
      expect(pointer.path).toMatch(/^blobs\//);
      expect(pointer.bytes).toBe(rawOutput.length);
      expect(pointer.sha256).toBe(
        createHash('sha256').update(rawOutput).digest('hex'),
      );
      expect(pointer.truncated).toBe(true);
      expect(pointer.preview.length).toBeGreaterThan(0);
      expect(pointer.preview.length).toBeLessThan(rawOutput.length);

      const blobPath = path.join(getSessionDir(sessionsDir, sessionId), pointer.path);
      const blobContent = await fs.readFile(blobPath, 'utf-8');
      expect(blobContent).toBe(rawOutput);
    });

    it('should generate UTF-8 safe previews for externalized payloads', async () => {
      const rawOutput = '\u6F22'.repeat(7_000);

      await appendEvent(sessionsDir, {
        type: 'session.update',
        session_id: sessionId,
        data: {
          iteration: 1,
          update: {
            sessionUpdate: 'tool_call_update',
            rawOutput,
          },
        },
      });

      const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
      const stored = JSON.parse((await fs.readFile(eventsPath, 'utf-8')).trim());
      const pointer = stored.data.update.rawOutput as { preview: string };

      expect(pointer.preview).toContain('...');
      expect(pointer.preview).not.toContain('\uFFFD');
    });

    it('should cap oversized event lines by externalizing whole payload', async () => {
      const giantPayload = 'Y'.repeat(320_000);

      await appendEvent(sessionsDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        data: {
          prompt: giantPayload,
        },
      });

      const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
      const rawLine = (await fs.readFile(eventsPath, 'utf-8')).trim();
      expect(Buffer.byteLength(rawLine, 'utf-8')).toBeLessThan(256 * 1024);

      const parsed = JSON.parse(rawLine);
      const pointer = parsed.data as {
        path: string;
        bytes: number;
      };
      expect(pointer.path).toMatch(/^blobs\//);

      const blobPath = path.join(getSessionDir(sessionsDir, sessionId), pointer.path);
      const blobContent = await fs.readFile(blobPath, 'utf-8');
      expect(Buffer.byteLength(blobContent, 'utf-8')).toBe(pointer.bytes);
      expect(JSON.parse(blobContent)).toEqual({ prompt: giantPayload });
    });
  });

  describe('readEvents', () => {
    // AC: @session-events ac-4
    it('should read all events in sequence order', async () => {
      await appendEvent(sessionsDir, {
        type: 'session.start',
        session_id: sessionId,
        data: null,
      });

      await appendEvent(sessionsDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        data: { prompt: 'Hello' },
      });

      await appendEvent(sessionsDir, {
        type: 'session.end',
        session_id: sessionId,
        data: null,
      });

      const events = await readEvents(sessionsDir, sessionId);

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('session.start');
      expect(events[0].seq).toBe(0);
      expect(events[1].type).toBe('prompt.sent');
      expect(events[1].seq).toBe(1);
      expect(events[2].type).toBe('session.end');
      expect(events[2].seq).toBe(2);
    });

    it('should return empty array if no events', async () => {
      const events = await readEvents(sessionsDir, sessionId);

      expect(events).toHaveLength(0);
    });

    it('should return empty array for nonexistent session', async () => {
      const events = await readEvents(sessionsDir, 'nonexistent');

      expect(events).toHaveLength(0);
    });

    it('should skip invalid JSON lines', async () => {
      // Create session dir and write some invalid JSON
      const sessionDir = getSessionDir(sessionsDir, sessionId);
      await fs.mkdir(sessionDir, { recursive: true });

      const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
      const content = [
        JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: null }),
        'invalid json line',
        JSON.stringify({ ts: 2000, seq: 1, type: 'session.end', session_id: sessionId, data: null }),
      ].join('\n');
      await fs.writeFile(eventsPath, content + '\n', 'utf-8');

      const events = await readEvents(sessionsDir, sessionId);

      expect(events).toHaveLength(2);
      expect(events[0].seq).toBe(0);
      expect(events[1].seq).toBe(1);
    });
  });

  describe('readEventsSince', () => {
    it('should filter events by timestamp', async () => {
      // Create events with specific timestamps
      await appendEvent(sessionsDir, {
        type: 'session.start',
        session_id: sessionId,
        ts: 1000,
        data: null,
      });

      await appendEvent(sessionsDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        ts: 2000,
        data: null,
      });

      await appendEvent(sessionsDir, {
        type: 'session.end',
        session_id: sessionId,
        ts: 3000,
        data: null,
      });

      const events = await readEventsSince(sessionsDir, sessionId, 1500);

      expect(events).toHaveLength(2);
      expect(events[0].ts).toBe(2000);
      expect(events[1].ts).toBe(3000);
    });

    it('should filter events by time range', async () => {
      await appendEvent(sessionsDir, {
        type: 'session.start',
        session_id: sessionId,
        ts: 1000,
        data: null,
      });

      await appendEvent(sessionsDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        ts: 2000,
        data: null,
      });

      await appendEvent(sessionsDir, {
        type: 'session.end',
        session_id: sessionId,
        ts: 3000,
        data: null,
      });

      const events = await readEventsSince(sessionsDir, sessionId, 1500, 2500);

      expect(events).toHaveLength(1);
      expect(events[0].ts).toBe(2000);
    });
  });

  describe('getLastEvent', () => {
    it('should return the last event', async () => {
      await appendEvent(sessionsDir, {
        type: 'session.start',
        session_id: sessionId,
        data: null,
      });

      await appendEvent(sessionsDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        data: { prompt: 'Hello' },
      });

      await appendEvent(sessionsDir, {
        type: 'session.end',
        session_id: sessionId,
        data: { reason: 'completed' },
      });

      const lastEvent = await getLastEvent(sessionsDir, sessionId);

      expect(lastEvent).not.toBeNull();
      expect(lastEvent?.type).toBe('session.end');
      expect(lastEvent?.seq).toBe(2);
      expect(lastEvent?.data).toEqual({ reason: 'completed' });
    });

    it('should return null if no events', async () => {
      const lastEvent = await getLastEvent(sessionsDir, sessionId);

      expect(lastEvent).toBeNull();
    });
  });

  describe('commit boundary inclusion', () => {
    // AC: @session-events ac-7
    it('should include accumulated events in the next git commit', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-session-commit-test-'));
      const repoSessionsDir = path.join(repoDir, 'sessions');
      const boundarySessionId = '01KF123456789ABCDEFGHJKMNQ';

      const runGit = (...args: string[]) => {
        const result = spawnSync('git', args, {
          cwd: repoDir,
          encoding: 'utf-8',
        });
        if (result.status !== 0) {
          throw new Error(result.stderr || `git ${args.join(' ')} failed`);
        }
        return result.stdout.trim();
      };

      try {
        runGit('init', '-b', 'main');
        runGit('config', 'user.email', 'test@example.com');
        runGit('config', 'user.name', 'Test User');

        await fs.writeFile(path.join(repoDir, 'README.md'), '# test\n', 'utf-8');
        runGit('add', 'README.md');
        runGit('commit', '-m', 'test: initial commit');

        await appendEvent(repoSessionsDir, {
          type: 'session.update',
          session_id: boundarySessionId,
          data: {
            update: {
              rawInput: {
                command: 'kspec task complete @task-ref --reason "Done"',
              },
            },
          },
        });

        runGit('add', '.');
        runGit('commit', '-m', 'test: commit boundary includes session events');

        const committedFiles = runGit('show', '--name-only', '--pretty=format:', 'HEAD');
        expect(committedFiles).toContain(`sessions/${boundarySessionId}/events.jsonl`);
      } finally {
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('saveSessionContext', () => {
    it('should save context snapshot for a given iteration', async () => {
      const context = {
        generated_at: '2026-01-19T00:00:00.000Z',
        branch: 'main',
        active_tasks: [],
        ready_tasks: [{ ref: '@task-1', title: 'Test task' }],
        stats: { total_tasks: 1 },
      };

      await saveSessionContext(sessionsDir, sessionId, 1, context);

      const contextPath = getSessionContextPath(sessionsDir, sessionId, 1);
      const saved = await fs.readFile(contextPath, 'utf-8');
      const parsed = JSON.parse(saved);

      expect(parsed).toEqual(context);
    });

    it('should create session directory if it does not exist', async () => {
      const newSessionId = '01KF999999999999999999999';
      const context = { test: 'data' };

      await saveSessionContext(sessionsDir, newSessionId, 1, context);

      const contextPath = getSessionContextPath(sessionsDir, newSessionId, 1);
      const exists = await fs.access(contextPath).then(() => true).catch(() => false);

      expect(exists).toBe(true);
    });

    it('should save multiple iteration snapshots', async () => {
      const context1 = { iteration: 1, data: 'first' };
      const context2 = { iteration: 2, data: 'second' };

      await saveSessionContext(sessionsDir, sessionId, 1, context1);
      await saveSessionContext(sessionsDir, sessionId, 2, context2);

      const saved1 = await readSessionContext(sessionsDir, sessionId, 1);
      const saved2 = await readSessionContext(sessionsDir, sessionId, 2);

      expect(saved1).toEqual(context1);
      expect(saved2).toEqual(context2);
    });
  });

  describe('readSessionContext', () => {
    it('should read saved context snapshot', async () => {
      const context = {
        generated_at: '2026-01-19T00:00:00.000Z',
        active_tasks: [],
        ready_tasks: [],
      };

      await saveSessionContext(sessionsDir, sessionId, 1, context);

      const read = await readSessionContext(sessionsDir, sessionId, 1);

      expect(read).toEqual(context);
    });

    it('should return null if context does not exist', async () => {
      const read = await readSessionContext(sessionsDir, sessionId, 999);

      expect(read).toBeNull();
    });

    it('should return null if context file is invalid JSON', async () => {
      const contextPath = getSessionContextPath(sessionsDir, sessionId, 1);
      const sessionDir = getSessionDir(sessionsDir, sessionId);

      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(contextPath, 'invalid json', 'utf-8');

      const read = await readSessionContext(sessionsDir, sessionId, 1);

      expect(read).toBeNull();
    });
  });

  describe('getSessionContextPath', () => {
    it('should return correct path for context snapshot', () => {
      const contextPath = getSessionContextPath(sessionsDir, sessionId, 3);

      expect(contextPath).toContain(sessionId);
      expect(contextPath).toContain('context-iter-3.json');
    });
  });
});

// ─── Completed Session Counts ─────────────────────────────────────────────────

// AC: @ui-agent-dispatch ac-1
describe('getCompletedSessionCountsByAgent', () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-completed-count-'));
    sessionsDir = path.join(testDir, 'sessions');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  it('should return empty object when no sessions exist', async () => {
    const counts = await getCompletedSessionCountsByAgent(sessionsDir);
    expect(counts).toEqual({});
  });

  it('should count completed sessions per agent_id', async () => {
    // Create sessions with different agents and statuses
    await createSession(sessionsDir, {
      id: '01KF123456789ABCDEFGHJKM01',
      agent_type: 'claude-code',
      agent_id: 'task-worker',
    });
    await updateSessionStatus(sessionsDir, '01KF123456789ABCDEFGHJKM01', 'completed');

    await createSession(sessionsDir, {
      id: '01KF123456789ABCDEFGHJKM02',
      agent_type: 'claude-code',
      agent_id: 'task-worker',
    });
    await updateSessionStatus(sessionsDir, '01KF123456789ABCDEFGHJKM02', 'completed');

    await createSession(sessionsDir, {
      id: '01KF123456789ABCDEFGHJKM03',
      agent_type: 'claude-code',
      agent_id: 'pr-reviewer',
    });
    await updateSessionStatus(sessionsDir, '01KF123456789ABCDEFGHJKM03', 'completed');

    // Active session should not be counted
    await createSession(sessionsDir, {
      id: '01KF123456789ABCDEFGHJKM04',
      agent_type: 'claude-code',
      agent_id: 'task-worker',
    });

    const counts = await getCompletedSessionCountsByAgent(sessionsDir);
    expect(counts).toEqual({
      'task-worker': 2,
      'pr-reviewer': 1,
    });
  });

  it('should not count abandoned or failed sessions', async () => {
    await createSession(sessionsDir, {
      id: '01KF123456789ABCDEFGHJKM05',
      agent_type: 'claude-code',
      agent_id: 'task-worker',
    });
    await updateSessionStatus(sessionsDir, '01KF123456789ABCDEFGHJKM05', 'abandoned');

    await createSession(sessionsDir, {
      id: '01KF123456789ABCDEFGHJKM06',
      agent_type: 'claude-code',
      agent_id: 'task-worker',
    });
    await updateSessionStatus(sessionsDir, '01KF123456789ABCDEFGHJKM06', 'failed');

    const counts = await getCompletedSessionCountsByAgent(sessionsDir);
    expect(counts).toEqual({});
  });

  it('should fall back to agent_type when agent_id is not set', async () => {
    await createSession(sessionsDir, {
      id: '01KF123456789ABCDEFGHJKM07',
      agent_type: 'claude-code',
    });
    await updateSessionStatus(sessionsDir, '01KF123456789ABCDEFGHJKM07', 'completed');

    const counts = await getCompletedSessionCountsByAgent(sessionsDir);
    // getSession() materializes agent_id from agent_type for legacy sessions
    expect(counts).toEqual({
      'claude-code': 1,
    });
  });
});
