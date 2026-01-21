import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTempFixtures, cleanupTempDir, kspecOutput as kspec, kspecJson } from './helpers/cli';

describe('Integration: task add --description', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @spec-task-add-description ac-1
  it('should create task with description when provided', () => {
    const output = kspec(
      'task add --title "Test Task" --description "Detailed description here" --slug desc-test-1',
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ description?: string }>(
      'task get @desc-test-1',
      tempDir
    );

    expect(task.description).toBe('Detailed description here');
  });

  // AC: @spec-task-add-description ac-2
  it('should create task without description when not provided', () => {
    const output = kspec(
      'task add --title "Test Task No Desc" --slug no-desc-test',
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ description?: string }>(
      'task get @no-desc-test',
      tempDir
    );

    // Description should be absent (not empty string)
    expect(task.description).toBeUndefined();
  });

  // AC: @spec-task-add-description ac-3
  it('should preserve multiline descriptions', () => {
    // Use printf to properly handle newlines in bash
    const output = kspec(
      `task add --title "Multiline Task" --description "$(printf 'Line 1\\nLine 2\\nLine 3')" --slug multiline-test`,
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ description?: string }>(
      'task get @multiline-test',
      tempDir
    );

    // The \n should be interpreted as actual newlines
    expect(task.description).toBe('Line 1\nLine 2\nLine 3');
  });

  // AC: @spec-task-add-description ac-4
  it('should handle special characters in description', () => {
    // Test various special characters that might cause YAML issues
    // Use single quotes to preserve double quotes, escape single quotes
    const specialDesc = 'Contains: colons, "quotes", and \'singles\'';
    const output = kspec(
      `task add --title "Special Chars Task" --description 'Contains: colons, "quotes", and '"'"'singles'"'"'' --slug special-test`,
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ description?: string }>(
      'task get @special-test',
      tempDir
    );

    expect(task.description).toBe(specialDesc);
  });

  // AC: @spec-task-add-description ac-5
  it('should include description in JSON output', () => {
    const desc = 'Test description for JSON';
    const output = kspecJson<{ task: { description?: string } }>(
      `task add --title "JSON Test" --description "${desc}" --slug json-desc-test --json`,
      tempDir
    );

    expect(output.task.description).toBe(desc);
  });

  // AC: @spec-task-add-description ac-6
  it('should treat empty description as omitted', () => {
    const output = kspec(
      'task add --title "Empty Desc Task" --description "" --slug empty-desc-test',
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ description?: string }>(
      'task get @empty-desc-test',
      tempDir
    );

    // Empty string should be treated as no description (field omitted)
    expect(task.description).toBeUndefined();
  });

  // AC: @spec-task-add-description ac-6 - whitespace-only also omitted
  it('should treat whitespace-only description as omitted', () => {
    const output = kspec(
      'task add --title "Whitespace Desc Task" --description "   " --slug whitespace-desc-test',
      tempDir
    );
    expect(output).toContain('Created task');

    const task = kspecJson<{ description?: string }>(
      'task get @whitespace-desc-test',
      tempDir
    );

    // Whitespace-only should be treated as no description
    expect(task.description).toBeUndefined();
  });

  // Inherited AC: @trait-json-output ac-1 - JSON output validation
  it('should output valid JSON with --json flag', () => {
    const output = kspecJson<{ task: { title: string; description?: string } }>(
      'task add --title "JSON Validation" --description "Test desc" --json',
      tempDir
    );

    // Should have valid structure
    expect(output.task).toBeDefined();
    expect(output.task.title).toBe('JSON Validation');
    expect(output.task.description).toBe('Test desc');
  });
});
