import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { setupTempFixtures, kspec, kspecJson, cleanupTempDir } from './helpers/cli.js';

// AC: @status-lifecycle

describe('Item Set Enum Validation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    // Create a test item to operate on
    kspec('item add --under @test-core --title "Enum Test Item" --type requirement --slug enum-test', tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('--status validation', () => {
    // AC: @implementation-states ac-reject-invalid
    it('should reject invalid implementation status with error listing valid values', () => {
      const result = kspec('item set @enum-test --status specified', tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Invalid implementation status');
      expect(result.stderr).toContain('specified');
      expect(result.stderr).toContain('not_started');
      expect(result.stderr).toContain('in_progress');
      expect(result.stderr).toContain('implemented');
      expect(result.stderr).toContain('verified');
    });

    // AC: @implementation-states ac-reject-invalid
    it('should not write changes when status is invalid', () => {
      // First set a known valid status
      kspec('item set @enum-test --status in_progress', tempDir);

      // Try to set an invalid status
      kspec('item set @enum-test --status bogus', tempDir, { expectFail: true });

      // Verify the original status is preserved
      const item = kspecJson<{ status: { implementation?: string } }>('item get @enum-test', tempDir);
      expect(item.status.implementation).toBe('in_progress');
    });

    it('should accept all valid implementation statuses', () => {
      for (const status of ['not_started', 'in_progress', 'implemented', 'verified']) {
        const result = kspec(`item set @enum-test --status ${status}`, tempDir);
        expect(result.exitCode).toBe(0);

        const item = kspecJson<{ status: { implementation?: string } }>('item get @enum-test', tempDir);
        expect(item.status.implementation).toBe(status);
      }
    });

    // AC: @implementation-states ac-reject-invalid
    it('should reject case-insensitive variants of valid statuses', () => {
      const casedVariants = ['In_Progress', 'IN_PROGRESS', 'Not_Started', 'IMPLEMENTED', 'Verified'];
      for (const status of casedVariants) {
        const result = kspec(`item set @enum-test --status ${status}`, tempDir, { expectFail: true });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('Invalid implementation status');
        expect(result.stderr).toContain(status);
      }
    });

    // AC: @implementation-states ac-reject-invalid
    it('should reject partial matches of valid statuses', () => {
      const partials = ['in_prog', 'not_start', 'impl', 'verif'];
      for (const status of partials) {
        const result = kspec(`item set @enum-test --status ${status}`, tempDir, { expectFail: true });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('Invalid implementation status');
      }
    });

    // AC: @implementation-states ac-reject-invalid
    it('should treat empty string status as no-op (no changes written)', () => {
      // Set a known status first
      kspec('item set @enum-test --status in_progress', tempDir);

      // Empty string is falsy — Commander may not pass it through,
      // but if it does, the validation guard `if (options.status)` skips it
      const result = kspec('item set @enum-test --status ""', tempDir);

      // Verify original status is preserved regardless
      const item = kspecJson<{ status: { implementation?: string } }>('item get @enum-test', tempDir);
      expect(item.status.implementation).toBe('in_progress');
    });
  });

  describe('--maturity validation', () => {
    // AC: @maturity-states ac-reject-invalid
    it('should reject invalid maturity with error listing valid values', () => {
      const result = kspec('item set @enum-test --maturity finalized', tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Invalid maturity');
      expect(result.stderr).toContain('finalized');
      expect(result.stderr).toContain('draft');
      expect(result.stderr).toContain('proposed');
      expect(result.stderr).toContain('stable');
      expect(result.stderr).toContain('deferred');
      expect(result.stderr).toContain('deprecated');
    });

    // AC: @maturity-states ac-reject-invalid
    it('should not write changes when maturity is invalid', () => {
      // Set a known valid maturity
      kspec('item set @enum-test --maturity proposed', tempDir);

      // Try to set an invalid maturity
      kspec('item set @enum-test --maturity finalized', tempDir, { expectFail: true });

      // Verify the original maturity is preserved
      const item = kspecJson<{ status: { maturity?: string } }>('item get @enum-test', tempDir);
      expect(item.status.maturity).toBe('proposed');
    });

    it('should accept all valid maturity values', () => {
      for (const maturity of ['draft', 'proposed', 'stable', 'deferred', 'deprecated']) {
        const result = kspec(`item set @enum-test --maturity ${maturity}`, tempDir);
        expect(result.exitCode).toBe(0);

        const item = kspecJson<{ status: { maturity?: string } }>('item get @enum-test', tempDir);
        expect(item.status.maturity).toBe(maturity);
      }
    });

    // AC: @maturity-states ac-reject-invalid
    it('should reject case-insensitive variants of valid maturity values', () => {
      const casedVariants = ['Draft', 'PROPOSED', 'Stable', 'DEFERRED', 'Deprecated'];
      for (const maturity of casedVariants) {
        const result = kspec(`item set @enum-test --maturity ${maturity}`, tempDir, { expectFail: true });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('Invalid maturity');
        expect(result.stderr).toContain(maturity);
      }
    });

    // AC: @maturity-states ac-reject-invalid
    it('should reject partial matches of valid maturity values', () => {
      const partials = ['dra', 'prop', 'stab', 'defer', 'deprec'];
      for (const maturity of partials) {
        const result = kspec(`item set @enum-test --maturity ${maturity}`, tempDir, { expectFail: true });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('Invalid maturity');
      }
    });

    // AC: @maturity-states ac-reject-invalid
    it('should treat empty string maturity as no-op (no changes written)', () => {
      // Set a known maturity first
      kspec('item set @enum-test --maturity proposed', tempDir);

      // Empty string should not alter the maturity
      const result = kspec('item set @enum-test --maturity ""', tempDir);

      // Verify original maturity is preserved
      const item = kspecJson<{ status: { maturity?: string } }>('item get @enum-test', tempDir);
      expect(item.status.maturity).toBe('proposed');
    });
  });
});
