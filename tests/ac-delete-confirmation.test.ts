/**
 * Tests for AC delete confirmation prompt
 *
 * Validates the confirmation prompt behavior when removing acceptance criteria.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  kspec,
  setupTempFixtures,
  cleanupTempDir,
} from './helpers/cli';

describe('AC Delete Confirmation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    // Add a test spec item with an AC under the existing test-core module
    kspec('item add --under @test-core --title "AC Test Feature" --type feature --slug ac-test-feature', tempDir);
    kspec('item ac add @ac-test-feature --id ac-1 --given "user exists" --when "action performed" --then "expected result"', tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @spec-ac-delete-confirmation ac-1
  it('should prompt for confirmation when removing AC without --force', () => {
    // When user confirms
    const result = kspec('item ac remove @ac-test-feature ac-1', tempDir, {
      stdin: 'y',
      env: { KSPEC_TEST_TTY: '1' } // Simulate TTY for testing
    });

    expect(result.stdout).toContain('Remove acceptance criterion ac-1? [y/N]');
    expect(result.stdout).toContain('Removed acceptance criterion');
    expect(result.exitCode).toBe(0);

    // Verify AC was removed
    const listResult = kspec('item ac list @ac-test-feature', tempDir);
    expect(listResult.stdout).toContain('0 acceptance criteria');
  });

  // AC: @spec-ac-delete-confirmation ac-2
  it('should remove AC when user confirms with y', () => {
    const result = kspec('item ac remove @ac-test-feature ac-1', tempDir, {
      stdin: 'y',
      env: { KSPEC_TEST_TTY: '1' }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed acceptance criterion');

    // Verify removal
    const listResult = kspec('item ac list @ac-test-feature', tempDir);
    expect(listResult.stdout).toContain('0 acceptance criteria');
  });

  // AC: @spec-ac-delete-confirmation ac-3
  it('should cancel operation when user declines with n', () => {
    const result = kspec('item ac remove @ac-test-feature ac-1', tempDir, {
      stdin: 'n',
      expectFail: true,
      env: { KSPEC_TEST_TTY: '1' }
    });

    expect(result.exitCode).toBe(2); // USAGE_ERROR (user cancelled)
    // Check both stdout and stderr for the message
    const output = result.stdout + result.stderr;
    expect(output).toContain('Operation cancelled');

    // Verify AC still exists
    const listResult = kspec('item ac list @ac-test-feature', tempDir);
    expect(listResult.stdout).toContain('[ac-1]');
  });

  // AC: @spec-ac-delete-confirmation ac-3
  it('should cancel operation when user enters empty response', () => {
    const result = kspec('item ac remove @ac-test-feature ac-1', tempDir, {
      stdin: '',
      expectFail: true,
      env: { KSPEC_TEST_TTY: '1' }
    });

    expect(result.exitCode).toBe(2); // USAGE_ERROR (user cancelled)
    // Check both stdout and stderr for the message
    const output = result.stdout + result.stderr;
    expect(output).toContain('Operation cancelled');

    // Verify AC still exists
    const listResult = kspec('item ac list @ac-test-feature', tempDir);
    expect(listResult.stdout).toContain('[ac-1]');
  });

  // AC: @spec-ac-delete-confirmation ac-4
  it('should remove AC immediately with --force flag', () => {
    const result = kspec('item ac remove @ac-test-feature ac-1 --force', tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed acceptance criterion');
    expect(result.stdout).not.toContain('Remove acceptance criterion ac-1? [y/N]');

    // Verify removal
    const listResult = kspec('item ac list @ac-test-feature', tempDir);
    expect(listResult.stdout).toContain('0 acceptance criteria');
  });

  // AC: @spec-ac-delete-confirmation ac-5
  it('should error in JSON mode without --force', () => {
    const result = kspec('item ac remove @ac-test-feature ac-1 --json', tempDir, {
      expectFail: true
    });

    expect(result.exitCode).toBe(1); // ERROR
    // Check both stdout and stderr for the message
    const output = result.stdout + result.stderr;
    expect(output).toContain('Confirmation required. Use --force with --json');

    // Verify AC still exists
    const listResult = kspec('item ac list @ac-test-feature', tempDir);
    expect(listResult.stdout).toContain('[ac-1]');
  });

  // AC: @spec-ac-delete-confirmation ac-6
  it('should error in non-interactive environment without --force', () => {
    // Don't provide KSPEC_TEST_TTY, stdin won't be a TTY
    const result = kspec('item ac remove @ac-test-feature ac-1', tempDir, {
      expectFail: true
    });

    expect(result.exitCode).toBe(1); // ERROR
    // Check both stdout and stderr for the message
    const output = result.stdout + result.stderr;
    expect(output).toContain('Non-interactive environment. Use --force to proceed');

    // Verify AC still exists
    const listResult = kspec('item ac list @ac-test-feature', tempDir);
    expect(listResult.stdout).toContain('[ac-1]');
  });

  // AC: @spec-ac-delete-confirmation ac-4
  it('should work in non-interactive environment with --force', () => {
    const result = kspec('item ac remove @ac-test-feature ac-1 --force', tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed acceptance criterion');

    // Verify removal
    const listResult = kspec('item ac list @ac-test-feature', tempDir);
    expect(listResult.stdout).toContain('0 acceptance criteria');
  });
});
