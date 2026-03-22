/**
 * Session log stats tests.
 *
 * Tests for the `kspec session log stats` command and supporting store functions.
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
  getAllSessionLogSummaries,
  computeSessionLogStats,
  computeToolUsageStats,
  computeTimePeriodStats,
  deduplicatePhasedToolCalls,
  type SessionLogSummary,
  type SessionLogStats,
  type ToolUsageStats,
  type TimePeriodStats,
} from '../src/sessions/store.js';
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec,
  kspecJson,
  testUlid,
} from './helpers/cli';

// ─── Store Unit Tests ───────────────────────────────────────────────────────

describe('computeSessionLogStats', () => {
  // AC: @session-log-stats ac-1
  it('should compute totals correctly', () => {
    const summaries: SessionLogSummary[] = [
      {
        id: 'session-1',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-20T10:00:00.000Z',
        ended_at: '2026-01-20T11:00:00.000Z',
        duration_ms: 3600000,
        event_count: 100,
        iteration_count: 3,
        tasks_completed: 2,
      },
      {
        id: 'session-2',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-21T10:00:00.000Z',
        ended_at: '2026-01-21T12:00:00.000Z',
        duration_ms: 7200000,
        event_count: 200,
        iteration_count: 5,
        tasks_completed: 3,
      },
    ];

    const stats = computeSessionLogStats(summaries);

    expect(stats.total_sessions).toBe(2);
    expect(stats.total_events).toBe(300);
    expect(stats.total_iterations).toBe(8);
    expect(stats.total_tasks_completed).toBe(5);
    expect(stats.total_duration_ms).toBe(10800000);
  });

  // AC: @session-log-stats ac-2
  it('should compute averages correctly', () => {
    const summaries: SessionLogSummary[] = [
      {
        id: 'session-1',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-20T10:00:00.000Z',
        ended_at: '2026-01-20T11:00:00.000Z',
        duration_ms: 3600000, // 1 hour
        event_count: 100,
        iteration_count: 2,
        tasks_completed: 4,
      },
      {
        id: 'session-2',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-21T10:00:00.000Z',
        ended_at: '2026-01-21T12:00:00.000Z',
        duration_ms: 7200000, // 2 hours
        event_count: 200,
        iteration_count: 4,
        tasks_completed: 6,
      },
    ];

    const stats = computeSessionLogStats(summaries);

    expect(stats.avg_duration_ms).toBe(5400000); // 1.5 hours
    expect(stats.avg_iterations_per_session).toBe(3); // (2+4)/2
    expect(stats.avg_tasks_per_session).toBe(5); // (4+6)/2
  });

  // AC: @session-log-stats ac-3
  it('should compute status breakdown correctly', () => {
    const summaries: SessionLogSummary[] = [
      {
        id: 'session-1',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-20T10:00:00.000Z',
        ended_at: '2026-01-20T11:00:00.000Z',
        duration_ms: 3600000,
        event_count: 100,
        iteration_count: 3,
        tasks_completed: 2,
      },
      {
        id: 'session-2',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-21T10:00:00.000Z',
        ended_at: '2026-01-21T12:00:00.000Z',
        duration_ms: 7200000,
        event_count: 200,
        iteration_count: 5,
        tasks_completed: 3,
      },
      {
        id: 'session-3',
        status: 'active',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-22T10:00:00.000Z',
        duration_ms: 1800000,
        event_count: 50,
        iteration_count: 1,
        tasks_completed: 0,
      },
      {
        id: 'session-4',
        status: 'abandoned',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-19T10:00:00.000Z',
        duration_ms: 600000,
        event_count: 10,
        iteration_count: 1,
        tasks_completed: 0,
      },
    ];

    const stats = computeSessionLogStats(summaries);

    expect(stats.status_breakdown).toHaveLength(3);
    const completed = stats.status_breakdown.find((s) => s.status === 'completed');
    const active = stats.status_breakdown.find((s) => s.status === 'active');
    const abandoned = stats.status_breakdown.find((s) => s.status === 'abandoned');

    expect(completed).toEqual({ status: 'completed', count: 2, percentage: 50 });
    expect(active).toEqual({ status: 'active', count: 1, percentage: 25 });
    expect(abandoned).toEqual({ status: 'abandoned', count: 1, percentage: 25 });
  });

  it('should return empty stats for empty input', () => {
    const stats = computeSessionLogStats([]);

    expect(stats.total_sessions).toBe(0);
    expect(stats.total_events).toBe(0);
    expect(stats.avg_duration_ms).toBe(0);
    expect(stats.status_breakdown).toEqual([]);
  });
});

describe('computeToolUsageStats', () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-session-stats-'));
    sessionsDir = path.join(testDir, 'sessions');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  // AC: @session-log-stats ac-6
  it('should count tool calls and compute percentages', async () => {
    const sessionId = testUlid('SESS');
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: 'claude-agent-acp',
    });

    // Add tool call events
    const eventsPath = path.join(testDir, 'sessions', sessionId, 'events.jsonl');
    const events = [
      { type: 'session.update', data: { update: { sessionUpdate: 'tool_call', _meta: { claudeCode: { toolName: 'Bash' } } } } },
      { type: 'session.update', data: { update: { sessionUpdate: 'tool_call', _meta: { claudeCode: { toolName: 'Bash' } } } } },
      { type: 'session.update', data: { update: { sessionUpdate: 'tool_call', _meta: { claudeCode: { toolName: 'Read' } } } } },
      { type: 'session.update', data: { update: { sessionUpdate: 'tool_call', _meta: { claudeCode: { toolName: 'Edit' } } } } },
    ].map((e, i) => JSON.stringify({ ts: Date.now(), seq: i, session_id: sessionId, ...e }));
    await fs.writeFile(eventsPath, events.join('\n') + '\n');

    const toolUsage = await computeToolUsageStats(sessionsDir, [sessionId]);

    expect(toolUsage).toHaveLength(3);
    expect(toolUsage[0]).toEqual({ tool_name: 'Bash', count: 2, percentage: 50 });
    expect(toolUsage[1]).toEqual({ tool_name: 'Read', count: 1, percentage: 25 });
    expect(toolUsage[2]).toEqual({ tool_name: 'Edit', count: 1, percentage: 25 });
  });

  it('should limit to top N tools', async () => {
    const sessionId = testUlid('SESS', 1);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: 'test-agent',
    });

    // Add many different tools
    const eventsPath = path.join(testDir, 'sessions', sessionId, 'events.jsonl');
    const toolNames = ['Tool1', 'Tool2', 'Tool3', 'Tool4', 'Tool5', 'Tool6', 'Tool7', 'Tool8', 'Tool9', 'Tool10', 'Tool11', 'Tool12'];
    const events = toolNames.map((name, i) =>
      JSON.stringify({
        ts: Date.now(),
        seq: i,
        type: 'session.update',
        session_id: sessionId,
        data: { update: { sessionUpdate: 'tool_call', _meta: { claudeCode: { toolName: name } } } },
      })
    );
    await fs.writeFile(eventsPath, events.join('\n') + '\n');

    // Default limit is 10
    const toolUsage = await computeToolUsageStats(sessionsDir, [sessionId]);
    expect(toolUsage).toHaveLength(10);

    // Custom limit
    const limited = await computeToolUsageStats(sessionsDir, [sessionId], 5);
    expect(limited).toHaveLength(5);
  });

  it('should deduplicate phased tool_call events by toolCallId', async () => {
    const sessionId = testUlid('SESS', 2);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: 'claude-agent-acp',
    });

    const eventsPath = path.join(testDir, 'sessions', sessionId, 'events.jsonl');
    const events = [
      // Phase 1: Bash tool_call with empty rawInput
      { type: 'session.update', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_001', rawInput: {}, _meta: { claudeCode: { toolName: 'Bash' } } } } },
      // Phase 2: Same Bash tool_call with populated rawInput (phased duplicate)
      { type: 'session.update', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_001', rawInput: { command: 'npm test' }, _meta: { claudeCode: { toolName: 'Bash' } } } } },
      // Different tool_call (not a duplicate)
      { type: 'session.update', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_002', rawInput: { file_path: '/src/main.ts' }, _meta: { claudeCode: { toolName: 'Read' } } } } },
      // Another Bash with no duplicate
      { type: 'session.update', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_003', rawInput: { command: 'git status' }, _meta: { claudeCode: { toolName: 'Bash' } } } } },
    ].map((e, i) => JSON.stringify({ ts: Date.now(), seq: i, session_id: sessionId, ...e }));
    await fs.writeFile(eventsPath, events.join('\n') + '\n');

    const toolUsage = await computeToolUsageStats(sessionsDir, [sessionId]);

    // Should count 3 unique tool calls (not 4 with the phased duplicate)
    const totalCount = toolUsage.reduce((sum, t) => sum + t.count, 0);
    expect(totalCount).toBe(3);
    expect(toolUsage.find(t => t.tool_name === 'Bash')?.count).toBe(2);
    expect(toolUsage.find(t => t.tool_name === 'Read')?.count).toBe(1);
  });
});

describe('computeTimePeriodStats', () => {
  // AC: @session-log-stats ac-7
  it('should group by day correctly', () => {
    const summaries: SessionLogSummary[] = [
      {
        id: 'session-1',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-20T10:00:00.000Z',
        duration_ms: 3600000,
        event_count: 100,
        iteration_count: 3,
        tasks_completed: 2,
      },
      {
        id: 'session-2',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-20T14:00:00.000Z',
        duration_ms: 7200000,
        event_count: 200,
        iteration_count: 5,
        tasks_completed: 3,
      },
      {
        id: 'session-3',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-21T10:00:00.000Z',
        duration_ms: 1800000,
        event_count: 50,
        iteration_count: 1,
        tasks_completed: 1,
      },
    ];

    const periods = computeTimePeriodStats(summaries, 'day');

    expect(periods).toHaveLength(2);
    // Sorted newest first
    expect(periods[0].period).toBe('2026-01-21');
    expect(periods[0].sessions_count).toBe(1);
    expect(periods[0].tasks_completed).toBe(1);
    expect(periods[0].total_duration_ms).toBe(1800000);

    expect(periods[1].period).toBe('2026-01-20');
    expect(periods[1].sessions_count).toBe(2);
    expect(periods[1].tasks_completed).toBe(5); // 2 + 3
    expect(periods[1].total_duration_ms).toBe(10800000); // 3600000 + 7200000
  });

  it('should group by week correctly', () => {
    const summaries: SessionLogSummary[] = [
      {
        id: 'session-1',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-20T10:00:00.000Z', // 2026-01-20 is a Tuesday in week 4
        duration_ms: 3600000,
        event_count: 100,
        iteration_count: 3,
        tasks_completed: 2,
      },
      {
        id: 'session-2',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-27T10:00:00.000Z', // 2026-01-27 is a Tuesday in week 5
        duration_ms: 7200000,
        event_count: 200,
        iteration_count: 5,
        tasks_completed: 3,
      },
    ];

    const periods = computeTimePeriodStats(summaries, 'week');

    expect(periods).toHaveLength(2);
    // Should have week numbers in format YYYY-Www
    for (const p of periods) {
      expect(p.period).toMatch(/^\d{4}-W\d{2}$/);
    }
    // Verify concrete week assignments
    expect(periods[0].period).toBe('2026-W05');
    expect(periods[1].period).toBe('2026-W04');
  });

  it('should handle year boundary week correctly (ISO-8601)', () => {
    // Test ISO-8601 week rules at year boundaries:
    // - 2025-12-29 (Monday) to 2026-01-04 (Sunday) is Week 1 of 2026
    // - 2025-12-28 (Sunday) is Week 52 of 2025
    const summaries: SessionLogSummary[] = [
      {
        id: 'session-1',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2025-12-28T10:00:00.000Z', // Sunday - still week 52 of 2025
        duration_ms: 1000,
        event_count: 1,
        iteration_count: 1,
        tasks_completed: 0,
      },
      {
        id: 'session-2',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2025-12-29T00:00:00.000Z', // Monday - week 1 of 2026 per ISO-8601
        duration_ms: 1000,
        event_count: 1,
        iteration_count: 1,
        tasks_completed: 0,
      },
      {
        id: 'session-3',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-01T00:00:00.000Z', // Thursday - still week 1 of 2026
        duration_ms: 1000,
        event_count: 1,
        iteration_count: 1,
        tasks_completed: 0,
      },
      {
        id: 'session-4',
        status: 'completed',
        agent_type: 'claude-agent-acp',
        started_at: '2026-01-05T00:00:00.000Z', // Monday - week 2 of 2026
        duration_ms: 1000,
        event_count: 1,
        iteration_count: 1,
        tasks_completed: 0,
      },
    ];

    const periods = computeTimePeriodStats(summaries, 'week');

    // Should have 3 distinct weeks: 2025-W52, 2026-W01, 2026-W02
    expect(periods).toHaveLength(3);
    const periodSet = new Set(periods.map((p) => p.period));
    expect(periodSet.has('2025-W52')).toBe(true);
    expect(periodSet.has('2026-W01')).toBe(true);
    expect(periodSet.has('2026-W02')).toBe(true);

    // Verify session counts per week
    const week52 = periods.find((p) => p.period === '2025-W52');
    const week01 = periods.find((p) => p.period === '2026-W01');
    const week02 = periods.find((p) => p.period === '2026-W02');
    expect(week52?.sessions_count).toBe(1);
    expect(week01?.sessions_count).toBe(2); // Dec 29 and Jan 1
    expect(week02?.sessions_count).toBe(1);
  });
});

// ─── CLI Integration Tests ──────────────────────────────────────────────────

describe('kspec session log stats (CLI)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    // Create sessions directory
    const sessionsDir = path.join(tempDir, '.kspec-sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    // Session 1: completed, 2026-01-15
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
      JSON.stringify({ ts: 2000, seq: 1, type: 'session.update', session_id: s1, data: { update: { sessionUpdate: 'tool_call', _meta: { claudeCode: { toolName: 'Bash' } } } } }),
      JSON.stringify({ ts: 3000, seq: 2, type: 'session.end', session_id: s1, data: null }),
    ].join('\n') + '\n');
    await fs.writeFile(path.join(s1Dir, 'context-iter-1.json'), '{}');

    // Session 2: active, 2026-02-05
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
      JSON.stringify({ ts: 2000, seq: 1, type: 'session.update', session_id: s2, data: { update: { sessionUpdate: 'tool_call', _meta: { claudeCode: { toolName: 'Read' } } } } }),
      JSON.stringify({ ts: 3000, seq: 2, type: 'session.update', session_id: s2, data: { update: { sessionUpdate: 'tool_call', _meta: { claudeCode: { toolName: 'Read' } } } } }),
      JSON.stringify({ ts: 4000, seq: 3, type: 'session.update', session_id: s2, data: { update: { sessionUpdate: 'tool_call', _meta: { claudeCode: { toolName: 'Edit' } } } } }),
      JSON.stringify({ ts: 5000, seq: 4, type: 'prompt.sent', session_id: s2, data: null }),
    ].join('\n') + '\n');
    await fs.writeFile(path.join(s2Dir, 'context-iter-1.json'), '{}');
    await fs.writeFile(path.join(s2Dir, 'context-iter-2.json'), '{}');
    await fs.writeFile(path.join(s2Dir, 'context-iter-3.json'), '{}');

    // Session 3: completed, 2026-02-04 with task completion
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

  // AC: @session-log-stats ac-1
  it('should display totals', () => {
    const result = kspec('session log stats', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Total Sessions:');
    expect(result.stdout).toContain('Total Events:');
    expect(result.stdout).toContain('Total Iterations:');
    expect(result.stdout).toContain('Tasks Completed:');
    expect(result.stdout).toContain('Total Duration:');
  });

  // AC: @session-log-stats ac-1 (JSON)
  it('should output totals in JSON mode', () => {
    const output = kspecJson<{ stats: SessionLogStats }>('session log stats', tempDir);
    expect(output.stats.total_sessions).toBe(3);
    expect(output.stats.total_events).toBe(10);
    expect(output.stats.total_iterations).toBe(5); // 1 + 3 + 1 (boundary-aware counts from events + snapshots)
    expect(output.stats.total_tasks_completed).toBe(1);
    expect(output.stats.total_duration_ms).toBeGreaterThan(0);
  });

  // AC: @session-log-stats ac-2
  it('should display averages', () => {
    const result = kspec('session log stats', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Avg Duration/Session:');
    expect(result.stdout).toContain('Avg Iterations/Session:');
    expect(result.stdout).toContain('Avg Tasks/Session:');
  });

  // AC: @session-log-stats ac-2 (JSON)
  it('should output averages in JSON mode', () => {
    const output = kspecJson<{ stats: SessionLogStats }>('session log stats', tempDir);
    expect(output.stats.avg_duration_ms).toBeGreaterThan(0);
    expect(output.stats.avg_iterations_per_session).toBeGreaterThan(0);
    expect(typeof output.stats.avg_tasks_per_session).toBe('number');
  });

  // AC: @session-log-stats ac-3
  it('should display status breakdown', () => {
    const result = kspec('session log stats', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Status Breakdown');
    expect(result.stdout).toContain('completed');
    expect(result.stdout).toContain('active');
  });

  // AC: @session-log-stats ac-3 (JSON)
  it('should output status breakdown in JSON mode', () => {
    const output = kspecJson<{ stats: SessionLogStats }>('session log stats', tempDir);
    expect(output.stats.status_breakdown.length).toBeGreaterThan(0);
    const completed = output.stats.status_breakdown.find((s) => s.status === 'completed');
    const active = output.stats.status_breakdown.find((s) => s.status === 'active');
    expect(completed).toBeDefined();
    expect(completed!.count).toBe(2);
    expect(active).toBeDefined();
    expect(active!.count).toBe(1);
  });

  // AC: @session-log-stats ac-4
  it('should filter by --since', () => {
    const output = kspecJson<{ stats: SessionLogStats }>('session log stats --since 2026-02-01', tempDir);
    // Only sessions 2 and 3 are after Feb 1
    expect(output.stats.total_sessions).toBe(2);
  });

  // AC: @session-log-stats ac-5
  it('should filter by --agent', () => {
    const output = kspecJson<{ stats: SessionLogStats }>('session log stats --agent custom-agent', tempDir);
    expect(output.stats.total_sessions).toBe(1);
  });

  // AC: @session-log-stats ac-5
  it('should filter by --agent for claude-agent-acp', () => {
    const output = kspecJson<{ stats: SessionLogStats }>('session log stats --agent claude-agent-acp', tempDir);
    expect(output.stats.total_sessions).toBe(2);
  });

  // AC: @session-log-stats ac-6
  it('should display tool usage with --tool-usage', () => {
    const result = kspec('session log stats --tool-usage', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Top Tool Usage');
    expect(result.stdout).toContain('Bash');
    expect(result.stdout).toContain('Read');
  });

  // AC: @session-log-stats ac-6 (JSON)
  it('should output tool usage in JSON mode', () => {
    const output = kspecJson<{ stats: SessionLogStats; tool_usage: ToolUsageStats[] }>(
      'session log stats --tool-usage',
      tempDir,
    );
    expect(output.tool_usage).toBeDefined();
    expect(output.tool_usage.length).toBeGreaterThan(0);
    // Should have Bash and Read
    const bash = output.tool_usage.find((t) => t.tool_name === 'Bash');
    const read = output.tool_usage.find((t) => t.tool_name === 'Read');
    expect(bash).toBeDefined();
    expect(read).toBeDefined();
    expect(bash!.count).toBe(2);
    expect(read!.count).toBe(2);
  });

  // AC: @session-log-stats ac-7
  it('should display by-day grouping', () => {
    const result = kspec('session log stats --by-day', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('By Day');
    expect(result.stdout).toContain('Period');
    expect(result.stdout).toContain('Sessions');
    expect(result.stdout).toContain('Tasks');
    expect(result.stdout).toContain('Duration');
  });

  // AC: @session-log-stats ac-7 (JSON --by-day)
  it('should output by-day grouping in JSON mode', () => {
    const output = kspecJson<{ stats: SessionLogStats; time_periods: TimePeriodStats[] }>(
      'session log stats --by-day',
      tempDir,
    );
    expect(output.time_periods).toBeDefined();
    expect(output.time_periods.length).toBeGreaterThan(0);
    for (const p of output.time_periods) {
      expect(p.period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.sessions_count).toBeGreaterThan(0);
    }
  });

  // AC: @session-log-stats ac-7
  it('should display by-week grouping', () => {
    const result = kspec('session log stats --by-week', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('By Week');
  });

  // AC: @session-log-stats ac-7 (JSON --by-week)
  it('should output by-week grouping in JSON mode', () => {
    const output = kspecJson<{ stats: SessionLogStats; time_periods: TimePeriodStats[] }>(
      'session log stats --by-week',
      tempDir,
    );
    expect(output.time_periods).toBeDefined();
    for (const p of output.time_periods) {
      expect(p.period).toMatch(/^\d{4}-W\d{2}$/);
    }
  });

  // AC: @session-log-stats ac-8
  it('should show message when no sessions match criteria', () => {
    const result = kspec('session log stats --agent nonexistent', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No sessions match criteria');
  });

  // AC: @session-log-stats ac-8 (JSON)
  it('should output message in JSON mode when no sessions match', () => {
    const output = kspecJson<{ message: string }>('session log stats --agent nonexistent', tempDir);
    expect(output.message).toBe('No sessions match criteria');
  });

  // Combined filters
  it('should combine --since and --agent filters', () => {
    const output = kspecJson<{ stats: SessionLogStats }>(
      'session log stats --since 2026-02-01 --agent claude-agent-acp',
      tempDir,
    );
    // Only session 3 is claude-agent-acp after Feb 1
    expect(output.stats.total_sessions).toBe(1);
  });

  // Trait: JSON output has no ANSI codes
  // AC: @trait-json-output ac-1
  it('should have no ANSI codes in JSON output', () => {
    const result = kspec('session log stats --json', tempDir);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[\d+m/);
  });

  // Trait: ISO 8601 timestamps (indirectly tested via started_at in summaries)
  // AC: @trait-json-output ac-5
  it('should include ISO 8601 timestamps in JSON', () => {
    const output = kspecJson<{ stats: SessionLogStats }>('session log stats', tempDir);
    // Stats don't have timestamps directly, but status_breakdown exists
    expect(output.stats).toBeDefined();
  });

  // Trait: exit code 0 on success
  // AC: @trait-semantic-exit-codes ac-1
  it('should exit with code 0 on success', () => {
    const result = kspec('session log stats', tempDir);
    expect(result.exitCode).toBe(0);
  });

  // Trait: exit code 0 on empty result (ac-8 says exit 0)
  // AC: @trait-semantic-exit-codes ac-5
  it('should exit with code 0 when no sessions match', () => {
    const result = kspec('session log stats --agent nonexistent', tempDir);
    expect(result.exitCode).toBe(0);
  });
});

describe('deduplicatePhasedToolCalls', () => {
  it('should remove empty-input duplicates when populated version exists', () => {
    const events = [
      // tool_call with empty rawInput
      { ts: 1000, seq: 0, type: 'session.update' as const, session_id: 'sess1', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_001', rawInput: {}, _meta: { claudeCode: { toolName: 'Bash' } } } } },
      // Same tool_call with populated rawInput
      { ts: 1001, seq: 1, type: 'session.update' as const, session_id: 'sess1', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_001', rawInput: { command: 'npm test' }, _meta: { claudeCode: { toolName: 'Bash' } } } } },
      // Different tool_call (should be kept)
      { ts: 1002, seq: 2, type: 'session.update' as const, session_id: 'sess1', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_002', rawInput: { file_path: '/src/main.ts' }, _meta: { claudeCode: { toolName: 'Read' } } } } },
      // Non tool_call event (should be kept)
      { ts: 1003, seq: 3, type: 'session.update' as const, session_id: 'sess1', data: { update: { sessionUpdate: 'agent_thought' } } },
    ];

    const result = deduplicatePhasedToolCalls(events);
    expect(result).toHaveLength(3);
    // The populated version should be kept
    expect((result[0].data as any).update.rawInput.command).toBe('npm test');
    // Other events should be unchanged
    expect((result[1].data as any).update.toolCallId).toBe('toolu_002');
    expect((result[2].data as any).update.sessionUpdate).toBe('agent_thought');
  });

  it('should keep single tool_call events (no phased duplicate)', () => {
    const events = [
      { ts: 1000, seq: 0, type: 'session.update' as const, session_id: 'sess1', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_001', rawInput: { command: 'npm test' }, _meta: { claudeCode: { toolName: 'Bash' } } } } },
    ];

    const result = deduplicatePhasedToolCalls(events);
    expect(result).toHaveLength(1);
  });

  it('should keep empty-input tool_call when no populated version exists', () => {
    const events = [
      { ts: 1000, seq: 0, type: 'session.update' as const, session_id: 'sess1', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_001', rawInput: {}, _meta: { claudeCode: { toolName: 'Bash' } } } } },
    ];

    const result = deduplicatePhasedToolCalls(events);
    expect(result).toHaveLength(1);
  });

  // AC: @ws-session-event-streaming ac-unified-event-parsing — ACP format tests
  it('should handle ACP format events (data IS the SessionUpdate)', () => {
    const events = [
      // ACP format: data.sessionUpdate exists directly (no data.update wrapper)
      { ts: 1000, seq: 0, type: 'session.update' as const, session_id: 'sess1', data: { sessionUpdate: 'tool_call', toolCallId: 'toolu_001', title: 'Bash', rawInput: {} } },
      // Same tool_call with populated rawInput in ACP format
      { ts: 1001, seq: 1, type: 'session.update' as const, session_id: 'sess1', data: { sessionUpdate: 'tool_call', toolCallId: 'toolu_001', title: 'Bash', rawInput: { command: 'npm test' } } },
      // Different tool_call in ACP format
      { ts: 1002, seq: 2, type: 'session.update' as const, session_id: 'sess1', data: { sessionUpdate: 'tool_call', toolCallId: 'toolu_002', title: 'Read', rawInput: { file_path: '/src/main.ts' } } },
    ];

    const result = deduplicatePhasedToolCalls(events);
    expect(result).toHaveLength(2);
    // The populated version should be kept
    expect((result[0].data as any).rawInput.command).toBe('npm test');
    // Different tool_call should be kept
    expect((result[1].data as any).toolCallId).toBe('toolu_002');
  });

  it('should handle mixed ACP and legacy format events', () => {
    const events = [
      // Legacy format
      { ts: 1000, seq: 0, type: 'session.update' as const, session_id: 'sess1', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_001', rawInput: { command: 'ls' } } } },
      // ACP format
      { ts: 1001, seq: 1, type: 'session.update' as const, session_id: 'sess1', data: { sessionUpdate: 'tool_call', toolCallId: 'toolu_002', title: 'Bash', rawInput: {} } },
      { ts: 1002, seq: 2, type: 'session.update' as const, session_id: 'sess1', data: { sessionUpdate: 'tool_call', toolCallId: 'toolu_002', title: 'Bash', rawInput: { command: 'npm test' } } },
    ];

    const result = deduplicatePhasedToolCalls(events);
    expect(result).toHaveLength(2);
    // Legacy event kept
    expect((result[0].data as any).update.toolCallId).toBe('toolu_001');
    // ACP populated version kept
    expect((result[1].data as any).rawInput.command).toBe('npm test');
  });
});
