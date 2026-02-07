/**
 * Session log show tests.
 *
 * Tests for the `kspec session log show` command and supporting store functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as YAML from 'yaml';
import {
  createSession,
  appendEvent,
  saveSessionContext,
  resolveSessionId,
  getSessionLogDetail,
  type SessionLogDetail,
} from '../src/sessions/store.js';
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec,
  kspecJson,
  testUlid,
} from './helpers/cli';

// ─── Store Unit Tests ───────────────────────────────────────────────────────

describe('resolveSessionId', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-session-show-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  // AC: @session-log-show ac-9
  it('should return not_found for nonexistent session', async () => {
    const result = await resolveSessionId(testDir, 'nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_found');
    }
  });

  // AC: @session-log-show ac-7
  it('should resolve exact session ID', async () => {
    const sessionId = testUlid('SESS');
    await createSession(testDir, { id: sessionId, agent_type: 'test-agent' });

    const result = await resolveSessionId(testDir, sessionId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe(sessionId);
    }
  });

  // AC: @session-log-show ac-7
  it('should resolve unique prefix to full session ID', async () => {
    const sessionId = testUlid('SESS');
    await createSession(testDir, { id: sessionId, agent_type: 'test-agent' });

    // Use first 8 chars as prefix
    const prefix = sessionId.slice(0, 8);
    const result = await resolveSessionId(testDir, prefix);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe(sessionId);
    }
  });

  // AC: @session-log-show ac-8
  it('should return ambiguous error for multiple matches', async () => {
    // Create two sessions with similar prefixes
    const id1 = '01SESS00000000000000000001';
    const id2 = '01SESS00000000000000000002';
    await createSession(testDir, { id: id1, agent_type: 'test-agent' });
    await createSession(testDir, { id: id2, agent_type: 'test-agent' });

    const result = await resolveSessionId(testDir, '01SESS');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('ambiguous');
      expect(result.matches).toContain(id1);
      expect(result.matches).toContain(id2);
    }
  });
});

describe('getSessionLogDetail', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-session-detail-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  it('should return null for nonexistent session', async () => {
    const detail = await getSessionLogDetail(testDir, 'nonexistent');
    expect(detail).toBeNull();
  });

  // AC: @session-log-show ac-1
  it('should return detail with all metadata fields', async () => {
    const sessionId = testUlid('SESS');
    const startedAt = '2026-01-20T10:00:00.000Z';
    const endedAt = '2026-01-20T11:30:00.000Z';

    await createSession(testDir, {
      id: sessionId,
      agent_type: 'claude-code-acp',
      task_id: '@my-task',
      started_at: startedAt,
    });

    // Simulate completion by writing metadata directly
    const metaPath = path.join(testDir, 'sessions', sessionId, 'session.yaml');
    await fs.writeFile(metaPath, YAML.stringify({
      id: sessionId,
      agent_type: 'claude-code-acp',
      task_id: '@my-task',
      status: 'completed',
      started_at: startedAt,
      ended_at: endedAt,
    }));

    const detail = await getSessionLogDetail(testDir, sessionId);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(sessionId);
    expect(detail!.status).toBe('completed');
    expect(detail!.agent_type).toBe('claude-code-acp');
    expect(detail!.task_id).toBe('@my-task');
    expect(detail!.started_at).toBe(startedAt);
    expect(detail!.ended_at).toBe(endedAt);
    expect(detail!.duration_ms).toBe(5400000); // 1.5 hours
  });

  // AC: @session-log-show ac-2
  it('should compute per-iteration summaries', async () => {
    const sessionId = testUlid('SESS', 1);
    await createSession(testDir, {
      id: sessionId,
      agent_type: 'test-agent',
    });

    // Add context snapshots
    await saveSessionContext(testDir, sessionId, 1, { iteration: 1 });
    await saveSessionContext(testDir, sessionId, 2, { iteration: 2 });

    // Add events with iteration info
    const eventsPath = path.join(testDir, 'sessions', sessionId, 'events.jsonl');
    const events = [
      { ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: { iteration: 1 } },
      {
        ts: 2000, seq: 1, type: 'session.update', session_id: sessionId,
        data: {
          iteration: 1,
          update: {
            sessionUpdate: 'tool_call',
            rawInput: { command: 'kspec task start @task-1' },
          },
        },
      },
      { ts: 3000, seq: 2, type: 'prompt.sent', session_id: sessionId, data: { iteration: 2 } },
      {
        ts: 4000, seq: 3, type: 'session.update', session_id: sessionId,
        data: {
          iteration: 2,
          update: {
            sessionUpdate: 'tool_call',
            rawInput: { command: 'kspec task complete @task-1 --reason "Done"' },
          },
        },
      },
    ];
    await fs.writeFile(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

    const detail = await getSessionLogDetail(testDir, sessionId);
    expect(detail).not.toBeNull();
    expect(detail!.iteration_count).toBe(2);
    expect(detail!.iterations).toHaveLength(2);

    const iter1 = detail!.iterations.find(i => i.iteration === 1);
    const iter2 = detail!.iterations.find(i => i.iteration === 2);
    expect(iter1).toBeDefined();
    expect(iter2).toBeDefined();
    expect(iter1!.tasks_started).toContain('@task-1');
    expect(iter2!.tasks_completed).toContain('@task-1');
  });

  // Regression: events may exist for iterations before context snapshots are created
  it('should handle events for iterations without context snapshots', async () => {
    const sessionId = testUlid('SESS', 2);
    await createSession(testDir, {
      id: sessionId,
      agent_type: 'test-agent',
    });

    // Only create context snapshot for iteration 1
    await saveSessionContext(testDir, sessionId, 1, { iteration: 1 });

    // But include events for iterations 1, 2, and 3
    const eventsPath = path.join(testDir, 'sessions', sessionId, 'events.jsonl');
    const events = [
      { ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: null }, // No iteration
      { ts: 2000, seq: 1, type: 'prompt.sent', session_id: sessionId, data: { iteration: 1 } },
      { ts: 3000, seq: 2, type: 'prompt.sent', session_id: sessionId, data: { iteration: 2 } },
      { ts: 4000, seq: 3, type: 'prompt.sent', session_id: sessionId, data: { iteration: 3 } },
    ];
    await fs.writeFile(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

    const detail = await getSessionLogDetail(testDir, sessionId);
    expect(detail).not.toBeNull();
    // Should have 3 iterations (from events), not just 1 (from context)
    expect(detail!.iterations).toHaveLength(3);

    const iter1 = detail!.iterations.find(i => i.iteration === 1);
    const iter2 = detail!.iterations.find(i => i.iteration === 2);
    const iter3 = detail!.iterations.find(i => i.iteration === 3);
    expect(iter1).toBeDefined();
    expect(iter2).toBeDefined();
    expect(iter3).toBeDefined();

    // Events should be correctly bucketed - iter 1 gets 2 events (session.start + prompt.sent)
    // Lifecycle events without iteration go to first known iteration
    expect(iter1!.event_count).toBe(2);
    expect(iter2!.event_count).toBe(1);
    expect(iter3!.event_count).toBe(1);
  });
});

// ─── CLI Integration Tests ──────────────────────────────────────────────────

describe('kspec session log show (CLI)', () => {
  let tempDir: string;
  const sessionId1 = testUlid('SESS', 1);
  const sessionId2 = testUlid('SESS', 2);

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    // In traditional mode (no shadow branch), specDir = tempDir
    const sessionsDir = path.join(tempDir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    // Session 1: completed with events and context
    const s1Dir = path.join(sessionsDir, sessionId1);
    await fs.mkdir(s1Dir);
    await fs.writeFile(path.join(s1Dir, 'session.yaml'), YAML.stringify({
      id: sessionId1,
      agent_type: 'claude-code-acp',
      task_id: '@my-task',
      status: 'completed',
      started_at: '2026-01-15T10:00:00.000Z',
      ended_at: '2026-01-15T11:30:00.000Z',
    }));
    await fs.writeFile(path.join(s1Dir, 'events.jsonl'), [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId1, data: { iteration: 1 } }),
      JSON.stringify({
        ts: 2000, seq: 1, type: 'session.update', session_id: sessionId1,
        data: {
          iteration: 1,
          update: {
            _meta: { claudeCode: { toolName: 'Bash' } },
            sessionUpdate: 'tool_call',
            rawInput: { command: 'kspec task start @my-task' },
          },
        },
      }),
      JSON.stringify({ ts: 3000, seq: 2, type: 'prompt.sent', session_id: sessionId1, data: { iteration: 1, prompt: 'Continue the task' } }),
      JSON.stringify({ ts: 4000, seq: 3, type: 'tool.call', session_id: sessionId1, data: { iteration: 1, tool: 'Read' } }),
      JSON.stringify({ ts: 5000, seq: 4, type: 'session.end', session_id: sessionId1, data: { reason: 'completed' } }),
    ].join('\n') + '\n');
    await fs.writeFile(path.join(s1Dir, 'context-iter-1.json'), JSON.stringify({ focus: 'test focus', ready_tasks: [] }));

    // Session 2: active, different prefix
    const s2Dir = path.join(sessionsDir, sessionId2);
    await fs.mkdir(s2Dir);
    await fs.writeFile(path.join(s2Dir, 'session.yaml'), YAML.stringify({
      id: sessionId2,
      agent_type: 'custom-agent',
      status: 'active',
      started_at: '2026-02-05T08:00:00.000Z',
    }));
    await fs.writeFile(path.join(s2Dir, 'events.jsonl'), [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId2, data: null }),
    ].join('\n') + '\n');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @session-log-show ac-1
  it('should display session metadata', () => {
    const result = kspec(`session log show ${sessionId1}`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Session');
    expect(result.stdout).toContain('Status');
    expect(result.stdout).toContain('Agent');
    expect(result.stdout).toContain('Started');
    expect(result.stdout).toContain('Ended');
    expect(result.stdout).toContain('Duration');
    expect(result.stdout).toContain('claude-code-acp');
  });

  // AC: @session-log-show ac-1 - JSON output
  it('should output valid JSON with metadata in --json mode', () => {
    const detail = kspecJson<SessionLogDetail>(`session log show ${sessionId1}`, tempDir);
    expect(detail.id).toBe(sessionId1);
    expect(detail.status).toBe('completed');
    expect(detail.agent_type).toBe('claude-code-acp');
    expect(detail.task_id).toBe('@my-task');
    expect(detail.started_at).toBe('2026-01-15T10:00:00.000Z');
    expect(detail.ended_at).toBe('2026-01-15T11:30:00.000Z');
    expect(detail.duration_ms).toBe(5400000);
  });

  // AC: @session-log-show ac-2
  it('should display per-iteration summary', () => {
    const result = kspec(`session log show ${sessionId1}`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Iterations');
    expect(result.stdout).toContain('[1]');
  });

  // AC: @session-log-show ac-2 - JSON output
  it('should include iterations array in JSON output', () => {
    const detail = kspecJson<SessionLogDetail>(`session log show ${sessionId1}`, tempDir);
    expect(detail.iterations).toBeDefined();
    expect(detail.iterations.length).toBeGreaterThan(0);
    const iter1 = detail.iterations[0];
    expect(iter1.iteration).toBe(1);
    expect(iter1.event_count).toBeGreaterThan(0);
    expect(iter1.tasks_started).toContain('@my-task');
  });

  // AC: @session-log-show ac-3
  it('should display event timeline with --events flag', () => {
    const result = kspec(`session log show ${sessionId1} --events`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Events');
    expect(result.stdout).toContain('session.start');
    expect(result.stdout).toContain('session.update');
    expect(result.stdout).toContain('session.end');
  });

  // AC: @session-log-show ac-3 - JSON output with events
  it('should include events array in JSON output with --events', () => {
    const detail = kspecJson<SessionLogDetail & { events?: unknown[] }>(
      `session log show ${sessionId1} --events`,
      tempDir,
    );
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(5);
  });

  // AC: @session-log-show ac-4
  it('should filter events by --type', () => {
    const detail = kspecJson<SessionLogDetail & { events?: Array<{ type: string }> }>(
      `session log show ${sessionId1} --events --type session.update`,
      tempDir,
    );
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(1);
    expect(detail.events![0].type).toBe('session.update');
  });

  // AC: @session-log-show ac-4 - filter by tool.call
  it('should filter events by --type tool.call', () => {
    const detail = kspecJson<SessionLogDetail & { events?: Array<{ type: string }> }>(
      `session log show ${sessionId1} --events --type tool.call`,
      tempDir,
    );
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(1);
    expect(detail.events![0].type).toBe('tool.call');
  });

  // AC: @session-log-show ac-5
  it('should limit to last N events with --limit', () => {
    const detail = kspecJson<SessionLogDetail & { events?: Array<{ type: string }> }>(
      `session log show ${sessionId1} --events --limit 2`,
      tempDir,
    );
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(2);
    // Should be the last 2 events (tool.call and session.end)
    expect(detail.events![0].type).toBe('tool.call');
    expect(detail.events![1].type).toBe('session.end');
  });

  // AC: @session-log-show ac-6
  it('should display context snapshot with --context N', () => {
    const result = kspec(`session log show ${sessionId1} --context 1`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Context Snapshot');
    expect(result.stdout).toContain('focus');
    expect(result.stdout).toContain('test focus');
  });

  // AC: @session-log-show ac-6 - JSON output with context
  it('should include context in JSON output with --context N', () => {
    const detail = kspecJson<SessionLogDetail & { context?: { focus: string } }>(
      `session log show ${sessionId1} --context 1`,
      tempDir,
    );
    expect(detail.context).toBeDefined();
    expect(detail.context!.focus).toBe('test focus');
  });

  // AC: @session-log-show ac-6 - error for nonexistent iteration
  it('should error when --context N references nonexistent iteration', () => {
    const result = kspec(`session log show ${sessionId1} --context 99`, tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('No context snapshot found for iteration 99');
  });

  // AC: @session-log-show ac-7
  it('should resolve session by unique prefix', () => {
    // Use a more specific prefix that uniquely identifies session1
    // sessionId1 = 01SESS00000001... and sessionId2 = 01SESS00000002...
    // They differ at position 14, so we need at least 15 chars
    const prefix = sessionId1.slice(0, 15);
    const detail = kspecJson<SessionLogDetail>(`session log show ${prefix}`, tempDir);
    expect(detail.id).toBe(sessionId1);
  });

  // AC: @session-log-show ac-8
  it('should error on ambiguous prefix with guidance', async () => {
    // Create two more sessions with same prefix
    const ambig1 = '01AMBG00000000000000000001';
    const ambig2 = '01AMBG00000000000000000002';
    const sessionsDir = path.join(tempDir, 'sessions');

    const a1Dir = path.join(sessionsDir, ambig1);
    await fs.mkdir(a1Dir);
    await fs.writeFile(path.join(a1Dir, 'session.yaml'), YAML.stringify({
      id: ambig1,
      agent_type: 'test-agent',
      status: 'active',
      started_at: '2026-01-01T00:00:00.000Z',
    }));

    const a2Dir = path.join(sessionsDir, ambig2);
    await fs.mkdir(a2Dir);
    await fs.writeFile(path.join(a2Dir, 'session.yaml'), YAML.stringify({
      id: ambig2,
      agent_type: 'test-agent',
      status: 'active',
      started_at: '2026-01-01T00:00:00.000Z',
    }));

    const result = kspec('session log show 01AMBG', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Ambiguous');
    expect(result.stderr).toContain(ambig1);
    expect(result.stderr).toContain(ambig2);
    expect(result.stderr).toContain('more specific');
  });

  // AC: @session-log-show ac-9
  it('should error with "Session not found" for nonexistent ID', () => {
    const result = kspec('session log show NONEXISTENT', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Session not found');
  });

  // AC: @trait-json-output ac-1
  it('should have no ANSI codes in JSON output', () => {
    const result = kspec(`session log show ${sessionId1} --json`, tempDir);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[\d+m/);
  });

  // AC: @trait-json-output ac-5
  it('should use ISO 8601 timestamps in JSON output', () => {
    const detail = kspecJson<SessionLogDetail>(`session log show ${sessionId1}`, tempDir);
    expect(detail.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    if (detail.ended_at) {
      expect(detail.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  // AC: @trait-semantic-exit-codes ac-1
  it('should exit with code 0 on success', () => {
    const result = kspec(`session log show ${sessionId1}`, tempDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-2 (not_found is ac-5 in some traits)
  it('should exit with error code for not found', () => {
    const result = kspec('session log show NONEXISTENT', tempDir, { expectFail: true });
    // Should be NOT_FOUND (3)
    expect(result.exitCode).toBe(3);
  });

  // Combined flags: events + limit + type
  it('should support combined --events --type --limit flags', () => {
    const detail = kspecJson<SessionLogDetail & { events?: unknown[] }>(
      `session log show ${sessionId1} --events --type prompt.sent --limit 1`,
      tempDir,
    );
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(1);
  });

  // Show active session
  it('should show active session without ended_at', () => {
    const detail = kspecJson<SessionLogDetail>(`session log show ${sessionId2}`, tempDir);
    expect(detail.status).toBe('active');
    expect(detail.ended_at).toBeUndefined();
    expect(detail.duration_ms).toBeGreaterThan(0);
  });
});
