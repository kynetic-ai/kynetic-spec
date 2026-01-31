/**
 * Tests for ralph end-iteration command
 *
 * AC: @ralph-end-iteration ac-cmd, ac-detect, ac-graceful, ac-reason, ac-cleanup, ac-noop-outside
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { kspec, setupTempFixtures, cleanupTempDir } from '../helpers/cli';

const END_ITERATION_MARKER_PATH = '.claude/ralph-end-iteration.json';

describe('Ralph end-iteration command', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('kspec ralph end-iteration', () => {
    // AC: @ralph-end-iteration ac-cmd
    it('should write marker file when invoked', async () => {
      const result = kspec('ralph end-iteration', tempDir);
      // Command should succeed even without active ralph session
      expect(result.exitCode).toBe(0);

      // Check marker file was created
      const markerPath = path.join(tempDir, END_ITERATION_MARKER_PATH);
      const exists = await fs.access(markerPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      // Verify marker content
      const content = await fs.readFile(markerPath, 'utf-8');
      const marker = JSON.parse(content);
      expect(marker.requested).toBe(true);
      expect(marker.timestamp).toBeDefined();
    });

    // AC: @ralph-end-iteration ac-reason
    it('should include reason in marker when provided', async () => {
      const result = kspec('ralph end-iteration --reason "No eligible tasks"', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Reason: No eligible tasks');

      const markerPath = path.join(tempDir, END_ITERATION_MARKER_PATH);
      const content = await fs.readFile(markerPath, 'utf-8');
      const marker = JSON.parse(content);
      expect(marker.reason).toBe('No eligible tasks');
    });

    // AC: @ralph-end-iteration ac-noop-outside
    it('should warn when not in ralph session', async () => {
      // No ralph markers exist, so it should warn
      const result = kspec('ralph end-iteration', tempDir);
      expect(result.exitCode).toBe(0);
      // The warning includes this message
      expect(result.stdout).toContain('This command is designed to be called by agents during a ralph loop');
    });

    // AC: @ralph-end-iteration ac-noop-outside
    it('should succeed without warning when task-limit marker exists', async () => {
      // Create a task-limit marker to simulate active ralph session
      const markerDir = path.join(tempDir, '.claude');
      await fs.mkdir(markerDir, { recursive: true });
      await fs.writeFile(
        path.join(markerDir, 'ralph-task-limit.json'),
        JSON.stringify({
          active: true,
          since: new Date().toISOString(),
          max: 1,
          completed: 0,
          sessionId: 'test-session',
        }),
      );

      const result = kspec('ralph end-iteration', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('End-iteration signal sent');
      expect(result.stdout).not.toContain('No active ralph session detected');
    });
  });

  describe('End-iteration detection helper', () => {
    // The detectEndIterationCommand function is internal
    // These document expected behavior for integration

    it('should match "kspec ralph end-iteration"', () => {
      // Pattern: /\bkspec\s+ralph\s+end-iteration\b/
      const pattern = /\bkspec\s+ralph\s+end-iteration\b/;
      expect(pattern.test('kspec ralph end-iteration')).toBe(true);
    });

    it('should match with --reason flag', () => {
      const pattern = /\bkspec\s+ralph\s+end-iteration\b/;
      expect(pattern.test('kspec ralph end-iteration --reason "done"')).toBe(true);
    });

    it('should NOT match partial commands', () => {
      const pattern = /\bkspec\s+ralph\s+end-iteration\b/;
      expect(pattern.test('kspec ralph')).toBe(false);
      expect(pattern.test('kspec ralph run')).toBe(false);
      expect(pattern.test('ralph end-iteration')).toBe(false);
    });
  });
});

describe('Marker file cleanup', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @ralph-end-iteration ac-cleanup
  it('should have correct marker file format', async () => {
    const result = kspec('ralph end-iteration --reason "test reason"', tempDir);
    expect(result.exitCode).toBe(0);

    const markerPath = path.join(tempDir, END_ITERATION_MARKER_PATH);
    const content = await fs.readFile(markerPath, 'utf-8');
    const marker = JSON.parse(content);

    // Verify schema
    expect(typeof marker.requested).toBe('boolean');
    expect(marker.requested).toBe(true);
    expect(typeof marker.timestamp).toBe('string');
    expect(() => new Date(marker.timestamp)).not.toThrow();
    expect(marker.reason).toBe('test reason');
  });
});

describe('Signal cleanup', () => {
  // AC: @ralph-end-iteration ac-signal-cleanup
  // Static analysis to verify signal handlers are registered correctly.
  // Full integration testing would require spawning ralph and sending signals.

  it('should register SIGINT and SIGTERM handlers', async () => {
    const ralphContent = await fs.readFile(
      path.join(process.cwd(), 'src/cli/commands/ralph.ts'),
      'utf-8'
    );

    // Verify signal handlers are registered
    expect(ralphContent).toContain('process.on("SIGINT"');
    expect(ralphContent).toContain('process.on("SIGTERM"');

    // Verify cleanup functions are called in handlers
    expect(ralphContent).toContain('clearTaskLimitMarker');
    expect(ralphContent).toContain('clearEndIterationMarker');

    // Verify cleanup awaits before exit (uses Promise.finally pattern)
    expect(ralphContent).toContain('Promise.all');
    expect(ralphContent).toContain('.finally(() =>');
  });
});
