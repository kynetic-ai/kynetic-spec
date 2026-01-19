/**
 * Session event storage tests.
 *
 * Tests for JSONL-based event storage for agent sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  const specDir = '/test/.kspec';
  const sessionId = '01KF123456789ABCDEFGHJKMNP';

  it('should construct sessions directory path', () => {
    expect(getSessionsDir(specDir)).toBe('/test/.kspec/sessions');
  });

  it('should construct session directory path', () => {
    expect(getSessionDir(specDir, sessionId)).toBe(`/test/.kspec/sessions/${sessionId}`);
  });

  it('should construct metadata file path', () => {
    expect(getSessionMetadataPath(specDir, sessionId)).toBe(
      `/test/.kspec/sessions/${sessionId}/session.yaml`
    );
  });

  it('should construct events file path', () => {
    expect(getSessionEventsPath(specDir, sessionId)).toBe(
      `/test/.kspec/sessions/${sessionId}/events.jsonl`
    );
  });
});

// ─── Storage Tests ───────────────────────────────────────────────────────────

describe('Session storage', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-session-test-'));
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

      const metadata = await createSession(testDir, input);

      // Check metadata returned
      expect(metadata.id).toBe(input.id);
      expect(metadata.agent_type).toBe(input.agent_type);
      expect(metadata.status).toBe('active');
      expect(metadata.started_at).toBeDefined();

      // Check directory was created
      const sessionDir = getSessionDir(testDir, input.id);
      const stat = await fs.stat(sessionDir);
      expect(stat.isDirectory()).toBe(true);

      // Check metadata file was created
      const metadataPath = getSessionMetadataPath(testDir, input.id);
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

      const metadata = await createSession(testDir, input);

      expect(metadata.task_id).toBe('@my-task');

      const metadataPath = getSessionMetadataPath(testDir, input.id);
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

      const metadata = await createSession(testDir, input);

      expect(metadata.started_at).toBe(startTime);
    });
  });

  describe('getSession', () => {
    it('should return session metadata if exists', async () => {
      const input: SessionMetadataInput = {
        id: '01KF123456789ABCDEFGHJKMNP',
        agent_type: 'claude-code',
      };

      await createSession(testDir, input);
      const metadata = await getSession(testDir, input.id);

      expect(metadata).not.toBeNull();
      expect(metadata?.id).toBe(input.id);
      expect(metadata?.agent_type).toBe(input.agent_type);
    });

    it('should return null if session does not exist', async () => {
      const metadata = await getSession(testDir, 'nonexistent');

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

      await createSession(testDir, input);
      const updated = await updateSessionStatus(testDir, input.id, 'completed');

      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('completed');
      expect(updated?.ended_at).toBeDefined();

      // Verify persisted
      const reloaded = await getSession(testDir, input.id);
      expect(reloaded?.status).toBe('completed');
      expect(reloaded?.ended_at).toBeDefined();
    });

    // AC: @session-events ac-6
    it('should set ended_at when abandoning', async () => {
      const input: SessionMetadataInput = {
        id: '01KF123456789ABCDEFGHJKMNP',
        agent_type: 'claude-code',
      };

      await createSession(testDir, input);
      const updated = await updateSessionStatus(testDir, input.id, 'abandoned');

      expect(updated?.status).toBe('abandoned');
      expect(updated?.ended_at).toBeDefined();
    });

    it('should return null if session does not exist', async () => {
      const updated = await updateSessionStatus(testDir, 'nonexistent', 'completed');

      expect(updated).toBeNull();
    });
  });

  describe('listSessions', () => {
    it('should list all session IDs', async () => {
      await createSession(testDir, { id: 'session-a', agent_type: 'claude-code' });
      await createSession(testDir, { id: 'session-b', agent_type: 'claude-code' });
      await createSession(testDir, { id: 'session-c', agent_type: 'test-agent' });

      const sessions = await listSessions(testDir);

      expect(sessions).toHaveLength(3);
      expect(sessions).toContain('session-a');
      expect(sessions).toContain('session-b');
      expect(sessions).toContain('session-c');
    });

    it('should return empty array if no sessions', async () => {
      const sessions = await listSessions(testDir);

      expect(sessions).toHaveLength(0);
    });
  });

  describe('sessionExists', () => {
    it('should return true if session exists', async () => {
      await createSession(testDir, { id: 'my-session', agent_type: 'claude-code' });

      const exists = await sessionExists(testDir, 'my-session');

      expect(exists).toBe(true);
    });

    it('should return false if session does not exist', async () => {
      const exists = await sessionExists(testDir, 'nonexistent');

      expect(exists).toBe(false);
    });
  });
});

// ─── Event Storage Tests ─────────────────────────────────────────────────────

describe('Event storage', () => {
  let testDir: string;
  const sessionId = '01KF123456789ABCDEFGHJKMNP';

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-event-test-'));
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

      const event = await appendEvent(testDir, input);

      expect(event.ts).toBeDefined();
      expect(event.ts).toBeGreaterThan(0);
      expect(event.seq).toBe(0);
      expect(event.type).toBe('session.start');
      expect(event.session_id).toBe(sessionId);
      expect(event.data).toEqual({ message: 'Starting session' });
    });

    // AC: @session-events ac-2
    it('should auto-increment seq for subsequent events', async () => {
      const event1 = await appendEvent(testDir, {
        type: 'session.start',
        session_id: sessionId,
        data: null,
      });

      const event2 = await appendEvent(testDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        data: { prompt: 'Hello' },
      });

      const event3 = await appendEvent(testDir, {
        type: 'tool.call',
        session_id: sessionId,
        data: { tool: 'Read' },
      });

      expect(event1.seq).toBe(0);
      expect(event2.seq).toBe(1);
      expect(event3.seq).toBe(2);
    });

    // AC: @session-events ac-3
    it('should create session directory if it does not exist (lazy creation)', async () => {
      const event = await appendEvent(testDir, {
        type: 'session.start',
        session_id: sessionId,
        data: null,
      });

      expect(event.seq).toBe(0);

      // Verify directory was created
      const sessionDir = getSessionDir(testDir, sessionId);
      const stat = await fs.stat(sessionDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should preserve optional trace_id', async () => {
      const event = await appendEvent(testDir, {
        type: 'session.start',
        session_id: sessionId,
        trace_id: 'trace-abc-123',
        data: null,
      });

      expect(event.trace_id).toBe('trace-abc-123');
    });

    // AC: @session-events ac-3
    it('should write event as JSON line to events.jsonl', async () => {
      await appendEvent(testDir, {
        type: 'session.start',
        session_id: sessionId,
        data: { key: 'value' },
      });

      await appendEvent(testDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        data: { prompt: 'test' },
      });

      const eventsPath = getSessionEventsPath(testDir, sessionId);
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
  });

  describe('readEvents', () => {
    // AC: @session-events ac-4
    it('should read all events in sequence order', async () => {
      await appendEvent(testDir, {
        type: 'session.start',
        session_id: sessionId,
        data: null,
      });

      await appendEvent(testDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        data: { prompt: 'Hello' },
      });

      await appendEvent(testDir, {
        type: 'session.end',
        session_id: sessionId,
        data: null,
      });

      const events = await readEvents(testDir, sessionId);

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('session.start');
      expect(events[0].seq).toBe(0);
      expect(events[1].type).toBe('prompt.sent');
      expect(events[1].seq).toBe(1);
      expect(events[2].type).toBe('session.end');
      expect(events[2].seq).toBe(2);
    });

    it('should return empty array if no events', async () => {
      const events = await readEvents(testDir, sessionId);

      expect(events).toHaveLength(0);
    });

    it('should return empty array for nonexistent session', async () => {
      const events = await readEvents(testDir, 'nonexistent');

      expect(events).toHaveLength(0);
    });

    it('should skip invalid JSON lines', async () => {
      // Create session dir and write some invalid JSON
      const sessionDir = getSessionDir(testDir, sessionId);
      await fs.mkdir(sessionDir, { recursive: true });

      const eventsPath = getSessionEventsPath(testDir, sessionId);
      const content = [
        JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: null }),
        'invalid json line',
        JSON.stringify({ ts: 2000, seq: 1, type: 'session.end', session_id: sessionId, data: null }),
      ].join('\n');
      await fs.writeFile(eventsPath, content + '\n', 'utf-8');

      const events = await readEvents(testDir, sessionId);

      expect(events).toHaveLength(2);
      expect(events[0].seq).toBe(0);
      expect(events[1].seq).toBe(1);
    });
  });

  describe('readEventsSince', () => {
    it('should filter events by timestamp', async () => {
      // Create events with specific timestamps
      await appendEvent(testDir, {
        type: 'session.start',
        session_id: sessionId,
        ts: 1000,
        data: null,
      });

      await appendEvent(testDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        ts: 2000,
        data: null,
      });

      await appendEvent(testDir, {
        type: 'session.end',
        session_id: sessionId,
        ts: 3000,
        data: null,
      });

      const events = await readEventsSince(testDir, sessionId, 1500);

      expect(events).toHaveLength(2);
      expect(events[0].ts).toBe(2000);
      expect(events[1].ts).toBe(3000);
    });

    it('should filter events by time range', async () => {
      await appendEvent(testDir, {
        type: 'session.start',
        session_id: sessionId,
        ts: 1000,
        data: null,
      });

      await appendEvent(testDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        ts: 2000,
        data: null,
      });

      await appendEvent(testDir, {
        type: 'session.end',
        session_id: sessionId,
        ts: 3000,
        data: null,
      });

      const events = await readEventsSince(testDir, sessionId, 1500, 2500);

      expect(events).toHaveLength(1);
      expect(events[0].ts).toBe(2000);
    });
  });

  describe('getLastEvent', () => {
    it('should return the last event', async () => {
      await appendEvent(testDir, {
        type: 'session.start',
        session_id: sessionId,
        data: null,
      });

      await appendEvent(testDir, {
        type: 'prompt.sent',
        session_id: sessionId,
        data: { prompt: 'Hello' },
      });

      await appendEvent(testDir, {
        type: 'session.end',
        session_id: sessionId,
        data: { reason: 'completed' },
      });

      const lastEvent = await getLastEvent(testDir, sessionId);

      expect(lastEvent).not.toBeNull();
      expect(lastEvent?.type).toBe('session.end');
      expect(lastEvent?.seq).toBe(2);
      expect(lastEvent?.data).toEqual({ reason: 'completed' });
    });

    it('should return null if no events', async () => {
      const lastEvent = await getLastEvent(testDir, sessionId);

      expect(lastEvent).toBeNull();
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

      await saveSessionContext(testDir, sessionId, 1, context);

      const contextPath = getSessionContextPath(testDir, sessionId, 1);
      const saved = await fs.readFile(contextPath, 'utf-8');
      const parsed = JSON.parse(saved);

      expect(parsed).toEqual(context);
    });

    it('should create session directory if it does not exist', async () => {
      const newSessionId = '01KF999999999999999999999';
      const context = { test: 'data' };

      await saveSessionContext(testDir, newSessionId, 1, context);

      const contextPath = getSessionContextPath(testDir, newSessionId, 1);
      const exists = await fs.access(contextPath).then(() => true).catch(() => false);

      expect(exists).toBe(true);
    });

    it('should save multiple iteration snapshots', async () => {
      const context1 = { iteration: 1, data: 'first' };
      const context2 = { iteration: 2, data: 'second' };

      await saveSessionContext(testDir, sessionId, 1, context1);
      await saveSessionContext(testDir, sessionId, 2, context2);

      const saved1 = await readSessionContext(testDir, sessionId, 1);
      const saved2 = await readSessionContext(testDir, sessionId, 2);

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

      await saveSessionContext(testDir, sessionId, 1, context);

      const read = await readSessionContext(testDir, sessionId, 1);

      expect(read).toEqual(context);
    });

    it('should return null if context does not exist', async () => {
      const read = await readSessionContext(testDir, sessionId, 999);

      expect(read).toBeNull();
    });

    it('should return null if context file is invalid JSON', async () => {
      const contextPath = getSessionContextPath(testDir, sessionId, 1);
      const sessionDir = getSessionDir(testDir, sessionId);

      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(contextPath, 'invalid json', 'utf-8');

      const read = await readSessionContext(testDir, sessionId, 1);

      expect(read).toBeNull();
    });
  });

  describe('getSessionContextPath', () => {
    it('should return correct path for context snapshot', () => {
      const contextPath = getSessionContextPath(testDir, sessionId, 3);

      expect(contextPath).toContain(sessionId);
      expect(contextPath).toContain('context-iter-3.json');
    });
  });
});
