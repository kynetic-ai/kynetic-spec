/**
 * Session log list tests.
 *
 * Tests for the `kspec session log list` command and supporting store functions.
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
  getSessionLogSummary,
  getAllSessionLogSummaries,
  type SessionLogSummary,
} from '../src/sessions/store.js';
import type { SessionMetadataInput, SessionEventInput } from '../src/sessions/types.js';
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec,
  kspecJson,
  testUlid,
} from './helpers/cli';

interface SessionLogListJson {
  items: SessionLogSummary[];
  total: number;
  offset: number;
  limit: number | null;
}

// ─── Store Unit Tests ───────────────────────────────────────────────────────

describe('getSessionLogSummary', () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-session-log-'));
    sessionsDir = path.join(testDir, 'sessions');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  it('should return null for nonexistent session', async () => {
    const summary = await getSessionLogSummary(sessionsDir, 'nonexistent');
    expect(summary).toBeNull();
  });

  // AC: @session-log-list ac-1
  it('should return summary with all expected fields', async () => {
    const sessionId = testUlid('SESS');
    const startedAt = '2026-01-20T10:00:00.000Z';
    const endedAt = '2026-01-20T11:30:00.000Z';

    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: 'claude-agent-acp',
      started_at: startedAt,
    });

    // Simulate completion by writing metadata directly
    const metaPath = path.join(sessionsDir, sessionId, 'session.yaml');
    await fs.writeFile(metaPath, YAML.stringify({
      id: sessionId,
      agent_type: 'claude-agent-acp',
      status: 'completed',
      started_at: startedAt,
      ended_at: endedAt,
    }));

    // Add some events
    for (let i = 0; i < 5; i++) {
      await appendEvent(sessionsDir, {
        type: i === 0 ? 'session.start' : 'prompt.sent',
        session_id: sessionId,
        data: null,
      });
    }

    // Add context snapshots
    await saveSessionContext(sessionsDir, sessionId, 1, { iteration: 1 });
    await saveSessionContext(sessionsDir, sessionId, 2, { iteration: 2 });

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.id).toBe(sessionId);
    expect(summary!.status).toBe('completed');
    expect(summary!.agent_type).toBe('claude-agent-acp');
    expect(summary!.started_at).toBe(startedAt);
    expect(summary!.ended_at).toBe(endedAt);
    expect(summary!.duration_ms).toBe(5400000); // 1.5 hours
    expect(summary!.event_count).toBe(5);
    expect(summary!.iteration_count).toBe(2);
    expect(summary!.tasks_completed).toBe(0);
  });

  // AC: @ui-session-history ac-1 — task_id included in summary
  it('should include task_id in summary when session has a task', async () => {
    const sessionId = testUlid('SESS', 5);
    const taskId = testUlid('TASK');
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: 'claude-agent-acp',
      task_id: taskId,
    });

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.task_id).toBe(taskId);
  });

  // AC: @ui-session-history ac-1 — task_id undefined when session has no task
  it('should have undefined task_id when session has no task', async () => {
    const sessionId = testUlid('SESS', 6);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: 'test-agent',
    });

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.task_id).toBeUndefined();
  });

  it('should compute duration from now for active sessions', async () => {
    const sessionId = testUlid('SESS', 1);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: 'test-agent',
      started_at: startedAt,
    });

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.status).toBe('active');
    expect(summary!.duration_ms).toBeGreaterThan(0);
    expect(summary!.ended_at).toBeUndefined();
  });

  it('should count task completions from realistic tool_call events', async () => {
    const sessionId = testUlid('SESS', 2);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: 'claude-agent-acp',
    });

    // Append events including realistic task complete tool calls
    await appendEvent(sessionsDir, {
      type: 'session.start',
      session_id: sessionId,
      data: null,
    });
    // Write realistic session.update events with tool_call shape
    const eventsPath = path.join(sessionsDir, sessionId, 'events.jsonl');
    const toolCallEvent1 = JSON.stringify({
      ts: Date.now(),
      seq: 1,
      type: 'session.update',
      session_id: sessionId,
      data: {
        iteration: 1,
        update: {
          _meta: { claudeCode: { toolName: 'Bash' } },
          sessionUpdate: 'tool_call',
          rawInput: { command: 'kspec task complete @my-task --reason "Done"' },
        },
      },
    });
    await fs.appendFile(eventsPath, toolCallEvent1 + '\n');
    const toolCallEvent2 = JSON.stringify({
      ts: Date.now(),
      seq: 2,
      type: 'session.update',
      session_id: sessionId,
      data: {
        iteration: 1,
        update: {
          _meta: { claudeCode: { toolName: 'Bash' } },
          sessionUpdate: 'tool_call',
          rawInput: { command: 'npm run dev -- task complete @another-task --reason "All done"' },
        },
      },
    });
    await fs.appendFile(eventsPath, toolCallEvent2 + '\n');

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary!.tasks_completed).toBe(2);
    expect(summary!.event_count).toBe(3); // session.start + 2 tool_call updates
  });

  // AC: @session-log-list ac-1 (claude-agent-acp: commands in tool_call_update events)
  it('should count task completions from tool_call_update events (claude-agent-acp format)', async () => {
    const sessionId = testUlid('SESS', 3);
    await createSession(sessionsDir, { id: sessionId, agent_type: 'claude-agent-acp' });

    const eventsPath = path.join(sessionsDir, sessionId, 'events.jsonl');
    // claude-agent-acp: initial tool_call has empty rawInput, command arrives in tool_call_update
    const emptyToolCall = JSON.stringify({
      ts: Date.now(), seq: 1, type: 'session.update', session_id: sessionId,
      data: { update: { sessionUpdate: 'tool_call', rawInput: {}, toolCallId: 'tc-1' } },
    });
    await fs.appendFile(eventsPath, emptyToolCall + '\n');
    const populatedUpdate = JSON.stringify({
      ts: Date.now(), seq: 2, type: 'session.update', session_id: sessionId,
      data: { update: { sessionUpdate: 'tool_call_update', rawInput: { command: 'kspec task complete @my-task --reason "Done"', description: 'Complete task' }, toolCallId: 'tc-1' } },
    });
    await fs.appendFile(eventsPath, populatedUpdate + '\n');

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary!.tasks_completed).toBe(1);
  });

  // AC: @session-log-list ac-1 (codex-acp: command is array in tool_call events)
  it('should count task completions from array commands (codex-acp format)', async () => {
    const sessionId = testUlid('SESS', 4);
    await createSession(sessionsDir, { id: sessionId, agent_type: 'codex-acp' });

    const eventsPath = path.join(sessionsDir, sessionId, 'events.jsonl');
    // codex-acp: command is ['/usr/bin/bash', '-lc', 'kspec task complete @ref']
    const arrayCommandEvent = JSON.stringify({
      ts: Date.now(), seq: 1, type: 'session.update', session_id: sessionId,
      data: { update: { sessionUpdate: 'tool_call', rawInput: { command: ['/usr/bin/bash', '-lc', 'kspec task complete @my-task'] } } },
    });
    await fs.appendFile(eventsPath, arrayCommandEvent + '\n');

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary!.tasks_completed).toBe(1);
  });
});

describe('getAllSessionLogSummaries', () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-session-log-all-'));
    sessionsDir = path.join(testDir, 'sessions');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  // AC: @session-log-list ac-6
  it('should return empty array when no sessions exist', async () => {
    const summaries = await getAllSessionLogSummaries(sessionsDir);
    expect(summaries).toEqual([]);
  });

  it('should return summaries for all sessions', async () => {
    const id1 = testUlid('SESS', 1);
    const id2 = testUlid('SESS', 2);

    await createSession(sessionsDir, { id: id1, agent_type: 'agent-a' });
    await createSession(sessionsDir, { id: id2, agent_type: 'agent-b' });

    const summaries = await getAllSessionLogSummaries(sessionsDir);
    expect(summaries).toHaveLength(2);
    expect(summaries.map(s => s.id).sort()).toEqual([id1, id2].sort());
  });
});

// ─── CLI Integration Tests ──────────────────────────────────────────────────

describe('kspec session log list (CLI)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    // Sessions live at projectRoot/.kspec-sessions/ (outside shadow branch)
    const sessionsDir = path.join(tempDir, '.kspec-sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    // Session 1: completed, old
    const s1 = testUlid('SESS', 1);
    const s1Dir = path.join(sessionsDir, s1);
    await fs.mkdir(s1Dir);
    await fs.writeFile(path.join(s1Dir, 'session.yaml'), YAML.stringify({
      id: s1,
      agent_type: 'claude-agent-acp',
      status: 'completed',
      started_at: '2026-01-15T10:00:00.000Z',
      ended_at: '2026-01-15T11:30:00.000Z',
    }));
    await fs.writeFile(path.join(s1Dir, 'events.jsonl'), [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: s1, data: null }),
      JSON.stringify({ ts: 2000, seq: 1, type: 'prompt.sent', session_id: s1, data: null }),
      JSON.stringify({ ts: 3000, seq: 2, type: 'session.end', session_id: s1, data: null }),
    ].join('\n') + '\n');
    await fs.writeFile(path.join(s1Dir, 'context-iter-1.json'), '{}');

    // Session 2: active, recent
    const s2 = testUlid('SESS', 2);
    const s2Dir = path.join(sessionsDir, s2);
    await fs.mkdir(s2Dir);
    await fs.writeFile(path.join(s2Dir, 'session.yaml'), YAML.stringify({
      id: s2,
      agent_type: 'custom-agent',
      status: 'active',
      started_at: '2026-02-05T08:00:00.000Z',
    }));
    await fs.writeFile(path.join(s2Dir, 'events.jsonl'), [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: s2, data: null }),
      JSON.stringify({ ts: 2000, seq: 1, type: 'prompt.sent', session_id: s2, data: null }),
      JSON.stringify({ ts: 3000, seq: 2, type: 'prompt.sent', session_id: s2, data: null }),
      JSON.stringify({ ts: 4000, seq: 3, type: 'prompt.sent', session_id: s2, data: null }),
      JSON.stringify({ ts: 5000, seq: 4, type: 'prompt.sent', session_id: s2, data: null }),
    ].join('\n') + '\n');
    await fs.writeFile(path.join(s2Dir, 'context-iter-1.json'), '{}');
    await fs.writeFile(path.join(s2Dir, 'context-iter-2.json'), '{}');
    await fs.writeFile(path.join(s2Dir, 'context-iter-3.json'), '{}');

    // Session 3: completed, recent
    const s3 = testUlid('SESS', 3);
    const s3Dir = path.join(sessionsDir, s3);
    await fs.mkdir(s3Dir);
    await fs.writeFile(path.join(s3Dir, 'session.yaml'), YAML.stringify({
      id: s3,
      agent_type: 'claude-agent-acp',
      status: 'completed',
      started_at: '2026-02-04T14:00:00.000Z',
      ended_at: '2026-02-04T15:00:00.000Z',
    }));
    await fs.writeFile(path.join(s3Dir, 'events.jsonl'), [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: s3, data: null }),
      JSON.stringify({
        ts: 2000, seq: 1, type: 'session.update', session_id: s3,
        data: {
          iteration: 1,
          update: {
            _meta: { claudeCode: { toolName: 'Bash' } },
            sessionUpdate: 'tool_call',
            rawInput: { command: 'kspec task complete @task-1 --reason "Done"' },
          },
        },
      }),
    ].join('\n') + '\n');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @session-log-list ac-1
  it('should display sessions in table format', () => {
    const result = kspec('session log list', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ID');
    expect(result.stdout).toContain('Status');
    expect(result.stdout).toContain('Agent');
    expect(result.stdout).toContain('Started');
    expect(result.stdout).toContain('Duration');
    expect(result.stdout).toContain('Events');
    expect(result.stdout).toContain('Iters');
    expect(result.stdout).toContain('Tasks');
    expect(result.stdout).toContain('3 session(s)');
  });

  // AC: @session-log-list ac-1 (JSON variant)
  it('should output valid JSON with all fields in --json mode', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list', tempDir);
    expect(sessions.items).toHaveLength(3);
    expect(sessions.total).toBe(3);
    expect(sessions.offset).toBe(0);
    expect(sessions.limit).toBeNull();

    for (const session of sessions.items) {
      expect(session).toHaveProperty('id');
      expect(session).toHaveProperty('status');
      expect(session).toHaveProperty('agent_type');
      expect(session).toHaveProperty('started_at');
      expect(session).toHaveProperty('duration_ms');
      expect(session).toHaveProperty('event_count');
      expect(session).toHaveProperty('iteration_count');
      expect(session).toHaveProperty('tasks_completed');
    }
  });

  // AC: @session-log-list ac-2
  it('should filter by --status', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list --status completed', tempDir);
    expect(sessions.items).toHaveLength(2);
    expect(sessions.total).toBe(2);
    for (const s of sessions.items) {
      expect(s.status).toBe('completed');
    }
  });

  // AC: @session-log-list ac-2
  it('should filter by --status active', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list --status active', tempDir);
    expect(sessions.items).toHaveLength(1);
    expect(sessions.total).toBe(1);
    expect(sessions.items[0].status).toBe('active');
    expect(sessions.items[0].agent_type).toBe('custom-agent');
  });

  // AC: @session-log-list ac-3
  it('should filter by --since', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list --since 2026-02-01', tempDir);
    // Only sessions 2 and 3 are after Feb 1
    expect(sessions.items).toHaveLength(2);
    expect(sessions.total).toBe(2);
    for (const s of sessions.items) {
      expect(new Date(s.started_at).getTime()).toBeGreaterThanOrEqual(new Date('2026-02-01').getTime());
    }
  });

  // AC: @session-log-list ac-4
  it('should filter by --agent', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list --agent custom-agent', tempDir);
    expect(sessions.items).toHaveLength(1);
    expect(sessions.total).toBe(1);
    expect(sessions.items[0].agent_type).toBe('custom-agent');
  });

  // AC: @session-log-list ac-4
  it('should filter by --agent for claude-agent-acp', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list --agent claude-agent-acp', tempDir);
    expect(sessions.items).toHaveLength(2);
    expect(sessions.total).toBe(2);
    for (const s of sessions.items) {
      expect(s.agent_type).toBe('claude-agent-acp');
    }
  });

  // AC: @session-log-list ac-5
  it('should sort by started_at descending by default', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list', tempDir);
    expect(sessions.items).toHaveLength(3);
    // Most recent first
    for (let i = 1; i < sessions.items.length; i++) {
      expect(new Date(sessions.items[i - 1].started_at).getTime())
        .toBeGreaterThanOrEqual(new Date(sessions.items[i].started_at).getTime());
    }
  });

  // AC: @session-log-list ac-5
  it('should sort by events when --sort events is provided', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list --sort events', tempDir);
    // Highest event count first
    for (let i = 1; i < sessions.items.length; i++) {
      expect(sessions.items[i - 1].event_count).toBeGreaterThanOrEqual(sessions.items[i].event_count);
    }
  });

  // AC: @session-log-list ac-5
  it('should sort by iterations when --sort iterations is provided', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list --sort iterations', tempDir);
    for (let i = 1; i < sessions.items.length; i++) {
      expect(sessions.items[i - 1].iteration_count).toBeGreaterThanOrEqual(sessions.items[i].iteration_count);
    }
  });

  // AC: @session-log-list ac-6
  it('should show "No sessions found" when no sessions exist', async () => {
    // Remove all sessions
    const sessionsDir = path.join(tempDir, '.kspec-sessions');
    await fs.rm(sessionsDir, { recursive: true });
    await fs.mkdir(sessionsDir);

    const result = kspec('session log list', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No sessions found');
  });

  // AC: @session-log-list ac-6 (JSON variant)
  it('should return empty array in JSON mode when no sessions exist', async () => {
    const sessionsDir = path.join(tempDir, '.kspec-sessions');
    await fs.rm(sessionsDir, { recursive: true });
    await fs.mkdir(sessionsDir);

    const sessions = kspecJson<SessionLogListJson>('session log list', tempDir);
    expect(sessions).toEqual({ items: [], total: 0, offset: 0, limit: null });
  });

  // AC: @session-log-list ac-7
  it('should limit output with --count flag (shows count only)', () => {
    const result = kspec('session log list --count', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('3');
  });

  // AC: @session-log-list ac-7 (JSON --count)
  it('should return count in JSON mode with --count', () => {
    const data = kspecJson<{ count: number }>('session log list --count', tempDir);
    expect(data.count).toBe(3);
  });

  // AC: @session-log-list ac-7 (--count with filters)
  it('should respect filters with --count', () => {
    const data = kspecJson<{ count: number }>('session log list --count --status completed', tempDir);
    expect(data.count).toBe(2);
  });

  // --limit flag
  it('should limit number of sessions with -n flag', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list -n 2', tempDir);
    expect(sessions.items).toHaveLength(2);
    expect(sessions.total).toBe(3);
    expect(sessions.limit).toBe(2);
  });

  // Combined filters
  it('should combine --status and --agent filters', () => {
    const sessions = kspecJson<SessionLogListJson>(
      'session log list --status active --agent custom-agent',
      tempDir,
    );
    expect(sessions.items).toHaveLength(1);
    expect(sessions.total).toBe(1);
    expect(sessions.items[0].status).toBe('active');
    expect(sessions.items[0].agent_type).toBe('custom-agent');
  });

  // Task completion counting
  it('should count task completions', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list --status completed', tempDir);
    const withTasks = sessions.items.find(s => s.tasks_completed > 0);
    expect(withTasks).toBeDefined();
    expect(withTasks!.tasks_completed).toBe(1);
  });

  // Iteration counting
  it('should count iterations correctly', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list --status active', tempDir);
    expect(sessions.items).toHaveLength(1);
    expect(sessions.items[0].iteration_count).toBe(3);
  });

  // Trait: JSON output has ISO 8601 timestamps
  // AC: @trait-json-output ac-5
  it('should use ISO 8601 timestamps in JSON output', () => {
    const sessions = kspecJson<SessionLogListJson>('session log list', tempDir);
    for (const s of sessions.items) {
      expect(s.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  // Trait: JSON output no ANSI codes
  // AC: @trait-json-output ac-1
  it('should have no ANSI codes in JSON output', () => {
    const result = kspec('session log list --json', tempDir);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[\d+m/);
  });

  // Trait: exit code 0 on success
  // AC: @trait-semantic-exit-codes ac-1
  it('should exit with code 0 on success', () => {
    const result = kspec('session log list', tempDir);
    expect(result.exitCode).toBe(0);
  });
});
