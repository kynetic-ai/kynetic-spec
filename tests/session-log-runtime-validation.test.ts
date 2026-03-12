/**
 * Session log runtime validation tests.
 *
 * Tests for runtime validation of unsafe type casts in session log commands:
 * 1. --status option validation against SessionStatusSchema
 * 2. summarizeEventData type guards for malformed event data
 * 3. `unknown | null` → `unknown` cosmetic fix (compile-time only)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as YAML from 'yaml';
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec,
  kspecJson,
  testUlid,
} from './helpers/cli';

// ─── Status Validation Tests ────────────────────────────────────────────────

describe('session log list --status validation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    // Create a single session so we can verify valid statuses work
    const sessionsDir = path.join(tempDir, '.kspec-sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    const s1 = testUlid('SESS');
    const s1Dir = path.join(sessionsDir, s1);
    await fs.mkdir(s1Dir);
    await fs.writeFile(path.join(s1Dir, 'session.yaml'), YAML.stringify({
      id: s1,
      agent_type: 'test-agent',
      status: 'completed',
      started_at: '2026-01-20T10:00:00.000Z',
      ended_at: '2026-01-20T11:00:00.000Z',
    }));
    await fs.writeFile(path.join(s1Dir, 'events.jsonl'),
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: s1, data: null }) + '\n');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should reject invalid --status with error message and exit code 2', () => {
    const result = kspec('session log list --status invalid_status', tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid status: 'invalid_status'");
    expect(result.stderr).toContain('active');
    expect(result.stderr).toContain('completed');
    expect(result.stderr).toContain('abandoned');
  });

  it('should reject partial status match (e.g. "comp")', () => {
    const result = kspec('session log list --status comp', tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid status: 'comp'");
  });

  it('should reject case-mismatched status (e.g. "Active")', () => {
    const result = kspec('session log list --status Active', tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid status: 'Active'");
  });

  it('should accept valid status "completed"', () => {
    const result = kspec('session log list --status completed', tempDir);
    expect(result.exitCode).toBe(0);
  });

  it('should accept valid status "active"', () => {
    const result = kspec('session log list --status active', tempDir);
    expect(result.exitCode).toBe(0);
  });

  it('should accept valid status "abandoned"', () => {
    const result = kspec('session log list --status abandoned', tempDir);
    expect(result.exitCode).toBe(0);
  });
});

// ─── Event Data Type Guard Tests ────────────────────────────────────────────

describe('session log show --events with malformed event data', () => {
  let tempDir: string;
  let sessionId: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    const sessionsDir = path.join(tempDir, '.kspec-sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    sessionId = testUlid('SESS');
    const sDir = path.join(sessionsDir, sessionId);
    await fs.mkdir(sDir);
    await fs.writeFile(path.join(sDir, 'session.yaml'), YAML.stringify({
      id: sessionId,
      agent_type: 'test-agent',
      status: 'completed',
      started_at: '2026-01-20T10:00:00.000Z',
      ended_at: '2026-01-20T11:00:00.000Z',
    }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should handle null event data without crashing', async () => {
    const eventsPath = path.join(tempDir, '.kspec-sessions', sessionId, 'events.jsonl');
    const events = [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: null }),
      JSON.stringify({ ts: 2000, seq: 1, type: 'session.update', session_id: sessionId, data: null }),
      JSON.stringify({ ts: 3000, seq: 2, type: 'session.end', session_id: sessionId, data: null }),
    ];
    await fs.writeFile(eventsPath, events.join('\n') + '\n');

    const result = kspec(`session log show ${sessionId} --events`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Events');
  });

  it('should handle string event data (not an object) without crashing', async () => {
    const eventsPath = path.join(tempDir, '.kspec-sessions', sessionId, 'events.jsonl');
    const events = [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: "just a string" }),
      JSON.stringify({ ts: 2000, seq: 1, type: 'session.update', session_id: sessionId, data: "unexpected" }),
      JSON.stringify({ ts: 3000, seq: 2, type: 'prompt.sent', session_id: sessionId, data: 42 }),
    ];
    await fs.writeFile(eventsPath, events.join('\n') + '\n');

    const result = kspec(`session log show ${sessionId} --events`, tempDir);
    expect(result.exitCode).toBe(0);
  });

  it('should handle array event data without crashing', async () => {
    const eventsPath = path.join(tempDir, '.kspec-sessions', sessionId, 'events.jsonl');
    const events = [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: [1, 2, 3] }),
      JSON.stringify({ ts: 2000, seq: 1, type: 'session.end', session_id: sessionId, data: { reason: 123 } }),
    ];
    await fs.writeFile(eventsPath, events.join('\n') + '\n');

    const result = kspec(`session log show ${sessionId} --events`, tempDir);
    expect(result.exitCode).toBe(0);
  });

  it('should handle session.update with non-object update field', async () => {
    const eventsPath = path.join(tempDir, '.kspec-sessions', sessionId, 'events.jsonl');
    const events = [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: null }),
      JSON.stringify({
        ts: 2000, seq: 1, type: 'session.update', session_id: sessionId,
        data: { update: "not an object" },
      }),
      JSON.stringify({
        ts: 3000, seq: 2, type: 'session.update', session_id: sessionId,
        data: { update: null },
      }),
      JSON.stringify({
        ts: 4000, seq: 3, type: 'session.update', session_id: sessionId,
        data: { update: [1, 2] },
      }),
    ];
    await fs.writeFile(eventsPath, events.join('\n') + '\n');

    const result = kspec(`session log show ${sessionId} --events`, tempDir);
    expect(result.exitCode).toBe(0);
  });

  it('should handle session.update with tool_call but missing nested fields', async () => {
    const eventsPath = path.join(tempDir, '.kspec-sessions', sessionId, 'events.jsonl');
    const events = [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: null }),
      // tool_call but _meta is a string, not an object
      JSON.stringify({
        ts: 2000, seq: 1, type: 'session.update', session_id: sessionId,
        data: {
          update: {
            sessionUpdate: 'tool_call',
            _meta: "not an object",
            rawInput: { command: 'echo test' },
          },
        },
      }),
      // tool_call but rawInput is missing
      JSON.stringify({
        ts: 3000, seq: 2, type: 'session.update', session_id: sessionId,
        data: {
          update: {
            sessionUpdate: 'tool_call',
            _meta: { claudeCode: { toolName: 'Bash' } },
          },
        },
      }),
      // tool_call but command is a number
      JSON.stringify({
        ts: 4000, seq: 3, type: 'session.update', session_id: sessionId,
        data: {
          update: {
            sessionUpdate: 'tool_call',
            rawInput: { command: 123 },
          },
        },
      }),
    ];
    await fs.writeFile(eventsPath, events.join('\n') + '\n');

    const result = kspec(`session log show ${sessionId} --events`, tempDir);
    expect(result.exitCode).toBe(0);
  });

  it('should handle prompt.sent with non-string prompt field', async () => {
    const eventsPath = path.join(tempDir, '.kspec-sessions', sessionId, 'events.jsonl');
    const events = [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: null }),
      JSON.stringify({ ts: 2000, seq: 1, type: 'prompt.sent', session_id: sessionId, data: { prompt: 42 } }),
      JSON.stringify({ ts: 3000, seq: 2, type: 'prompt.sent', session_id: sessionId, data: { prompt: null } }),
      JSON.stringify({ ts: 4000, seq: 3, type: 'prompt.sent', session_id: sessionId, data: {} }),
    ];
    await fs.writeFile(eventsPath, events.join('\n') + '\n');

    const result = kspec(`session log show ${sessionId} --events`, tempDir);
    expect(result.exitCode).toBe(0);
  });

  it('should handle session.end with non-string reason field', async () => {
    const eventsPath = path.join(tempDir, '.kspec-sessions', sessionId, 'events.jsonl');
    const events = [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: null }),
      JSON.stringify({ ts: 2000, seq: 1, type: 'session.end', session_id: sessionId, data: { reason: 123 } }),
    ];
    await fs.writeFile(eventsPath, events.join('\n') + '\n');

    const result = kspec(`session log show ${sessionId} --events`, tempDir);
    expect(result.exitCode).toBe(0);
    // Should show "Session ended" without the numeric reason
    expect(result.stdout).toContain('Session ended');
  });

  it('should correctly summarize well-formed tool_call events', async () => {
    const eventsPath = path.join(tempDir, '.kspec-sessions', sessionId, 'events.jsonl');
    const events = [
      JSON.stringify({ ts: 1000, seq: 0, type: 'session.start', session_id: sessionId, data: null }),
      JSON.stringify({
        ts: 2000, seq: 1, type: 'session.update', session_id: sessionId,
        data: {
          update: {
            sessionUpdate: 'tool_call',
            _meta: { claudeCode: { toolName: 'Bash' } },
            rawInput: { command: 'npm test' },
          },
        },
      }),
      JSON.stringify({
        ts: 3000, seq: 2, type: 'prompt.sent', session_id: sessionId,
        data: { prompt: 'Hello there' },
      }),
      JSON.stringify({
        ts: 4000, seq: 3, type: 'session.end', session_id: sessionId,
        data: { reason: 'completed normally' },
      }),
    ];
    await fs.writeFile(eventsPath, events.join('\n') + '\n');

    const result = kspec(`session log show ${sessionId} --events`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Bash');
    expect(result.stdout).toContain('npm test');
    expect(result.stdout).toContain('Hello there');
    expect(result.stdout).toContain('completed normally');
  });
});
