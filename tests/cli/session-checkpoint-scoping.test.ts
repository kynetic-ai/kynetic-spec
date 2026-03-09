/**
 * Integration tests for session-scoped checkpoint filtering
 * AC: @cmd-session-checkpoint ac-session-scope
 * AC: @cmd-session-checkpoint ac-no-session-scope
 * AC: @cmd-session-checkpoint ac-session-failsafe
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
  git,
  testUlids,
} from '../helpers/cli';
import { createSession, updateSessionStatus } from '../../src/sessions/store';

describe('Integration: session-scoped checkpoint filtering', () => {
  let tempDir: string;
  let sessionsDir: string;
  // Pre-generate unique session IDs for all tests (sequence 0-9)
  const sessionIds = testUlids('SES', 10);

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    sessionsDir = path.join(tempDir, '.kspec-sessions');
    initGitRepo(tempDir);
    // Commit fixture files so working tree is clean (no uncommitted-changes noise)
    git('add -A', tempDir);
    git('commit -m "fixtures"', tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  /**
   * Helper: start a task with a specific session_id
   */
  function startTaskWithSession(taskRef: string, sessionId: string): void {
    kspec(`task start ${taskRef}`, tempDir, {
      env: { KSPEC_SESSION_ID: sessionId },
    });
  }

  /**
   * Helper: start a task without a session
   */
  function startTaskWithoutSession(taskRef: string): void {
    const originalEnv = process.env.KSPEC_SESSION_ID;
    delete process.env.KSPEC_SESSION_ID;
    try {
      kspec(`task start ${taskRef}`, tempDir);
    } finally {
      if (originalEnv !== undefined) {
        process.env.KSPEC_SESSION_ID = originalEnv;
      }
    }
  }

  /**
   * Helper: run checkpoint and parse result.
   * Returns null on clean pass (no output), or the parsed JSON block response.
   * Checks only task-related issues — ignores uncommitted changes.
   */
  function runCheckpoint(sessionId?: string): { decision: string; reason: string } | null {
    const env: Record<string, string> = {};
    if (sessionId) {
      env.KSPEC_SESSION_ID = sessionId;
    }
    const result = kspec('session checkpoint --json', tempDir, {
      env,
      expectFail: true,
    });
    // Clean pass: exit 0 with no output (AC3: silent on success)
    if (result.exitCode === 0 && result.stdout.trim() === '') {
      return null;
    }
    // Non-zero exit with no stdout is an unexpected error — fail loudly
    if (result.stdout.trim() === '') {
      throw new Error(`checkpoint exited ${result.exitCode} with no stdout. stderr: ${result.stderr}`);
    }
    return JSON.parse(result.stdout);
  }

  /**
   * Helper: check if checkpoint reports any in_progress_task issues.
   * Ignores uncommitted_changes issues (from session/task file mutations).
   */
  function hasTaskIssues(sessionId?: string): boolean {
    const result = runCheckpoint(sessionId);
    if (!result) return false;
    return result.reason.includes('is still in progress');
  }

  // AC: @cmd-session-checkpoint ac-session-scope
  describe('ac-session-scope: with KSPEC_SESSION_ID set', () => {
    it('should include tasks with matching session_id', async () => {
      const mySession = sessionIds[0];
      await createSession(sessionsDir, { id: mySession, agent_type: 'test' });
      startTaskWithSession('@test-task-pending', mySession);

      expect(hasTaskIssues(mySession)).toBe(true);
    });

    it('should include tasks with no session_id (unclaimed)', async () => {
      const mySession = sessionIds[0];
      await createSession(sessionsDir, { id: mySession, agent_type: 'test' });
      startTaskWithoutSession('@test-task-pending');

      expect(hasTaskIssues(mySession)).toBe(true);
    });

    it('should exclude tasks claimed by another active session', async () => {
      const mySession = sessionIds[0];
      const otherSession = sessionIds[1];
      await createSession(sessionsDir, { id: mySession, agent_type: 'test' });
      await createSession(sessionsDir, { id: otherSession, agent_type: 'test' });
      startTaskWithSession('@test-task-pending', otherSession);

      expect(hasTaskIssues(mySession)).toBe(false);
    });

    it('should include tasks from a completed session (orphaned)', async () => {
      const mySession = sessionIds[0];
      const closedSession = sessionIds[1];
      await createSession(sessionsDir, { id: mySession, agent_type: 'test' });
      await createSession(sessionsDir, { id: closedSession, agent_type: 'test' });
      startTaskWithSession('@test-task-pending', closedSession);
      await updateSessionStatus(sessionsDir, closedSession, 'completed');

      expect(hasTaskIssues(mySession)).toBe(true);
    });
  });

  // AC: @cmd-session-checkpoint ac-no-session-scope
  describe('ac-no-session-scope: without KSPEC_SESSION_ID', () => {
    it('should include tasks with no session_id (unclaimed)', () => {
      startTaskWithoutSession('@test-task-pending');

      expect(hasTaskIssues()).toBe(true);
    });

    it('should exclude tasks claimed by an active session', async () => {
      const otherSession = sessionIds[0];
      await createSession(sessionsDir, { id: otherSession, agent_type: 'test' });
      startTaskWithSession('@test-task-pending', otherSession);

      expect(hasTaskIssues()).toBe(false);
    });

    it('should include tasks from a closed session', async () => {
      const closedSession = sessionIds[0];
      await createSession(sessionsDir, { id: closedSession, agent_type: 'test' });
      startTaskWithSession('@test-task-pending', closedSession);
      await updateSessionStatus(sessionsDir, closedSession, 'abandoned');

      expect(hasTaskIssues()).toBe(true);
    });
  });

  // AC: @cmd-session-checkpoint ac-session-failsafe
  describe('ac-session-failsafe: unresolvable session_id', () => {
    it('should include task when owning session does not exist', () => {
      const nonexistentSession = sessionIds[0];
      // Start with a session ID that has no metadata on disk
      startTaskWithSession('@test-task-pending', nonexistentSession);

      expect(hasTaskIssues()).toBe(true);
    });

    it('should include task when owning session has corrupt metadata', async () => {
      const corruptSession = sessionIds[0];
      // Create session dir with invalid YAML
      const sessDir = path.join(sessionsDir, corruptSession);
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'session.yaml'), '{{invalid yaml:::');
      startTaskWithSession('@test-task-pending', corruptSession);

      expect(hasTaskIssues()).toBe(true);
    });

    it('should include task when owning session does not exist (with active session)', async () => {
      const mySession = sessionIds[0];
      const nonexistentSession = sessionIds[1];
      await createSession(sessionsDir, { id: mySession, agent_type: 'test' });
      // No createSession for nonexistentSession — metadata missing
      startTaskWithSession('@test-task-pending', nonexistentSession);

      expect(hasTaskIssues(mySession)).toBe(true);
    });
  });

  // AC: @cmd-session-checkpoint ac-session-scope — "scoping applies to associated incomplete todo warnings"
  describe('scoping applies to incomplete todos too', () => {
    it('should not report todos from tasks excluded by session scoping', async () => {
      const mySession = sessionIds[0];
      const otherSession = sessionIds[1];
      await createSession(sessionsDir, { id: mySession, agent_type: 'test' });
      await createSession(sessionsDir, { id: otherSession, agent_type: 'test' });
      startTaskWithSession('@test-task-pending', otherSession);
      kspec('task todo add @test-task-pending "Some todo item"', tempDir);

      const result = runCheckpoint(mySession);
      // Should not contain any task or todo issues
      if (result) {
        expect(result.reason).not.toContain('is still in progress');
        expect(result.reason).not.toContain('Incomplete todo');
      }
    });
  });
});
