/**
 * Tests for ralph-task-limit-guard.sh hook
 *
 * AC: @ralph-task-limit ac-hook-block
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../helpers/cli';

const HOOK_PATH = path.join(__dirname, '..', '..', '.claude', 'hooks', 'ralph-task-limit-guard.sh');

/**
 * Run the hook with given input
 */
function runHook(input: object, cwd: string): { exitCode: number; stdout: string } {
  const result = spawnSync('bash', [HOOK_PATH], {
    cwd,
    encoding: 'utf-8',
    input: JSON.stringify(input),
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || '').trim(),
  };
}

describe('ralph-task-limit-guard hook', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    // Create .claude directory
    await fs.mkdir(path.join(tempDir, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('allows commands when no marker', () => {
    // AC: @ralph-task-limit ac-hook-block - allows when marker not present
    it('should allow kspec task start when no marker file exists', () => {
      const input = {
        tool_input: { command: 'kspec task start @my-task' },
        cwd: tempDir,
      };
      const result = runHook(input, tempDir);
      expect(result.exitCode).toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.decision).toBe('allow');
    });

    it('should allow other kspec commands regardless of marker', async () => {
      // Create marker file
      const markerPath = path.join(tempDir, '.claude', 'ralph-task-limit.json');
      await fs.writeFile(markerPath, JSON.stringify({
        active: true,
        since: new Date().toISOString(),
        max: 1,
        completed: 1,
        sessionId: 'test-session',
      }));

      // task complete should be allowed
      const input = {
        tool_input: { command: 'kspec task complete @my-task' },
        cwd: tempDir,
      };
      const result = runHook(input, tempDir);
      expect(result.exitCode).toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.decision).toBe('allow');
    });
  });

  describe('blocks task start when marker present', () => {
    // AC: @ralph-task-limit ac-hook-block
    it('should block kspec task start when marker file exists with active:true', async () => {
      const markerPath = path.join(tempDir, '.claude', 'ralph-task-limit.json');
      await fs.writeFile(markerPath, JSON.stringify({
        active: true,
        since: new Date().toISOString(),
        max: 2,
        completed: 2,
        sessionId: 'test-session',
      }));

      const input = {
        tool_input: { command: 'kspec task start @new-task' },
        cwd: tempDir,
      };
      const result = runHook(input, tempDir);
      expect(result.exitCode).toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.decision).toBe('block');
      expect(response.reason).toContain('Task limit reached');
      expect(response.reason).toContain('2/2');
    });

    it('should include helpful message in block reason', async () => {
      const markerPath = path.join(tempDir, '.claude', 'ralph-task-limit.json');
      await fs.writeFile(markerPath, JSON.stringify({
        active: true,
        since: new Date().toISOString(),
        max: 3,
        completed: 3,
        sessionId: 'test-session',
      }));

      const input = {
        tool_input: { command: 'kspec task start @another-task' },
        cwd: tempDir,
      };
      const result = runHook(input, tempDir);
      const response = JSON.parse(result.stdout);
      expect(response.decision).toBe('block');
      expect(response.reason).toContain('ralph-task-limit-guard');
      expect(response.reason).toContain('--max-tasks');
    });
  });

  describe('allows when marker is inactive', () => {
    it('should allow kspec task start when marker has active:false', async () => {
      const markerPath = path.join(tempDir, '.claude', 'ralph-task-limit.json');
      await fs.writeFile(markerPath, JSON.stringify({
        active: false, // Inactive
        since: new Date().toISOString(),
        max: 1,
        completed: 1,
        sessionId: 'test-session',
      }));

      const input = {
        tool_input: { command: 'kspec task start @my-task' },
        cwd: tempDir,
      };
      const result = runHook(input, tempDir);
      expect(result.exitCode).toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.decision).toBe('allow');
    });
  });

  describe('handles edge cases', () => {
    it('should allow when no command in input', () => {
      const input = {
        tool_input: {},
        cwd: tempDir,
      };
      const result = runHook(input, tempDir);
      expect(result.exitCode).toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.decision).toBe('allow');
    });

    it('should allow non-bash commands', () => {
      const input = {
        tool_input: { not_a_command: true },
        cwd: tempDir,
      };
      const result = runHook(input, tempDir);
      expect(result.exitCode).toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.decision).toBe('allow');
    });

    it('should handle malformed marker file gracefully', async () => {
      const markerPath = path.join(tempDir, '.claude', 'ralph-task-limit.json');
      await fs.writeFile(markerPath, 'not valid json');

      const input = {
        tool_input: { command: 'kspec task start @my-task' },
        cwd: tempDir,
      };
      const result = runHook(input, tempDir);
      expect(result.exitCode).toBe(0);
      // Should allow on parse error (fail open)
      const response = JSON.parse(result.stdout);
      expect(response.decision).toBe('allow');
    });

    it('should match various task start command formats', async () => {
      const markerPath = path.join(tempDir, '.claude', 'ralph-task-limit.json');
      await fs.writeFile(markerPath, JSON.stringify({
        active: true,
        since: new Date().toISOString(),
        max: 1,
        completed: 1,
        sessionId: 'test-session',
      }));

      const commands = [
        'kspec task start @my-task',
        'kspec  task  start @my-task', // extra spaces
        'kspec task start @my-task --verbose',
      ];

      for (const command of commands) {
        const input = {
          tool_input: { command },
          cwd: tempDir,
        };
        const result = runHook(input, tempDir);
        const response = JSON.parse(result.stdout);
        expect(response.decision).toBe('block');
      }
    });
  });
});
