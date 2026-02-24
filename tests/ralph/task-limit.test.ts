/**
 * Tests for ralph --max-tasks flag parsing and dry-run output.
 *
 * AC: @ralph-session-budget-integration ac-create-budget
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { kspec, setupTempFixtures, cleanupTempDir } from '../helpers/cli';

describe('Ralph task limit', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('--max-tasks flag parsing', () => {
    // AC: @ralph-session-budget-integration ac-create-budget
    it('should accept valid positive integer', () => {
      const result = kspec('ralph --max-tasks 5 --dry-run', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('max-tasks: 5');
    });

    // AC: @ralph-session-budget-integration ac-create-budget
    it('should accept 0 for unlimited', () => {
      const result = kspec('ralph --max-tasks 0 --dry-run', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('max-tasks: unlimited');
    });

    // AC: @ralph-session-budget-integration ac-create-budget
    it('should default to 1', () => {
      const result = kspec('ralph --dry-run', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('max-tasks: 1');
    });

    // AC: @ralph-session-budget-integration ac-create-budget
    it('should reject negative numbers', () => {
      const result = kspec('ralph --max-tasks -1 --dry-run', tempDir, { expectFail: true });
      expect(result.exitCode).toBe(2); // USAGE_ERROR
      expect(result.stderr).toContain('--max-tasks');
    });

    // AC: @ralph-session-budget-integration ac-create-budget
    it('should reject non-integer values', () => {
      const result = kspec('ralph --max-tasks abc --dry-run', tempDir, { expectFail: true });
      expect(result.exitCode).toBe(2); // USAGE_ERROR
      expect(result.stderr).toContain('--max-tasks');
    });

    // AC: @ralph-session-budget-integration ac-create-budget
    it('should reject values over 999', () => {
      const result = kspec('ralph --max-tasks 1000 --dry-run', tempDir, { expectFail: true });
      expect(result.exitCode).toBe(2); // USAGE_ERROR
      expect(result.stderr).toContain('--max-tasks');
    });
  });

  describe('--dry-run output', () => {
    it('should show max-tasks in configuration section', () => {
      const result = kspec('ralph --max-tasks 3 --dry-run', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('=== DRY RUN - Configuration ===');
      expect(result.stdout).toContain('max-tasks: 3');
    });

    it('should show unlimited when max-tasks is 0', () => {
      const result = kspec('ralph --max-tasks 0 --dry-run', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('max-tasks: unlimited');
    });
  });
});
