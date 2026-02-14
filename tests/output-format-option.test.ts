/**
 * Tests for output format option
 * AC: @output-format-option
 *
 * Note: --format is NOT a global option due to Commander.js conflicts with command-specific
 * --format options (like export). Instead, global output formatting uses shorthands:
 * --json, --yaml, --raw
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as yaml from 'yaml';
import { setupTempFixtures, cleanupTempDir, kspec } from './helpers/cli.js';

describe('Output Format Option', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await setupTempFixtures();
  });

  afterAll(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('--json shorthand (ac-format-json, ac-json-shorthand)', () => {
    // AC: @output-format-option ac-format-json, ac-json-shorthand
    it('produces valid JSON output', () => {
      const result = kspec('tasks list --json', tempDir);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });

    // AC: @output-format-option ac-format-json
    it('produces valid JSON on task get', () => {
      const result = kspec('task get @test-task-pending --json', tempDir);
      const parsed = JSON.parse(result.stdout);
      expect(parsed._ulid).toBe('01KF1645CA45ZT43W2T6HJMVA1');
    });
  });

  describe('--yaml shorthand (ac-format-yaml, ac-yaml-shorthand)', () => {
    // AC: @output-format-option ac-format-yaml
    it('produces valid YAML output', () => {
      const result = kspec('tasks list --yaml', tempDir);
      const parsed = yaml.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
    });

    // AC: @output-format-option ac-format-yaml
    it('contains the same data as --json but in YAML format', () => {
      const jsonResult = kspec('task get @test-task-pending --json', tempDir);
      const yamlResult = kspec('task get @test-task-pending --yaml', tempDir);

      const jsonParsed = JSON.parse(jsonResult.stdout);
      const yamlParsed = yaml.parse(yamlResult.stdout);

      expect(yamlParsed._ulid).toBe(jsonParsed._ulid);
      expect(yamlParsed.title).toBe(jsonParsed.title);
      expect(yamlParsed.status).toBe(jsonParsed.status);
    });

    // AC: @output-format-option ac-yaml-no-ansi
    it('contains no ANSI escape codes', () => {
      const result = kspec('tasks list --yaml', tempDir);
      // ANSI escape codes start with \x1b[ or \033[
      expect(result.stdout).not.toMatch(/\x1b\[/);
      expect(result.stdout).not.toMatch(/\033\[/);
    });

    // AC: @output-format-option ac-yaml-references
    it('includes @ prefix in reference fields', () => {
      // Use the blocked task which has a depends_on reference
      const result = kspec('task get @test-task-blocked --yaml', tempDir);
      const parsed = yaml.parse(result.stdout);
      // The blocked task has depends_on: ["@test-task-pending"]
      expect(parsed.depends_on).toBeDefined();
      expect(parsed.depends_on.length).toBeGreaterThan(0);
      expect(parsed.depends_on[0]).toMatch(/^@/);
    });
  });

  describe('--raw shorthand (ac-raw-shorthand)', () => {
    // AC: @output-format-option ac-raw-shorthand
    it('produces same output as --json', () => {
      const rawResult = kspec('tasks list --raw', tempDir);
      const jsonResult = kspec('tasks list --json', tempDir);

      expect(rawResult.stdout).toBe(jsonResult.stdout);
      expect(() => JSON.parse(rawResult.stdout)).not.toThrow();
    });
  });

  describe('conflict detection (ac-conflict-error)', () => {
    // AC: @output-format-option ac-conflict-error
    it('errors when --json and --yaml are both provided', () => {
      const result = kspec('tasks list --json --yaml', tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/Conflicting format options/);
      expect(result.stderr).toMatch(/--json/);
      expect(result.stderr).toMatch(/--yaml/);
    });

    // AC: @output-format-option ac-conflict-error
    it('errors when --raw and --yaml are both provided', () => {
      const result = kspec('tasks list --raw --yaml', tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/Conflicting format options/);
    });

    // AC: @output-format-option ac-conflict-error
    it('errors when --json and --raw are both provided', () => {
      const result = kspec('tasks list --json --raw', tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/Conflicting format options/);
    });
  });

  describe('global scope (ac-global-scope)', () => {
    // AC: @output-format-option ac-global-scope
    it('--yaml works on item list', () => {
      const result = kspec('item list --yaml', tempDir);
      expect(result.exitCode).toBe(0);
      expect(() => yaml.parse(result.stdout)).not.toThrow();
    });

    // AC: @output-format-option ac-global-scope
    it('--raw works on tasks ready', () => {
      const result = kspec('tasks ready --raw', tempDir);
      expect(result.exitCode).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });

    // AC: @output-format-option ac-global-scope
    it('--yaml works on session start', () => {
      const result = kspec('session start --yaml', tempDir);
      expect(result.exitCode).toBe(0);
      // Session start outputs YAML context
      expect(() => yaml.parse(result.stdout)).not.toThrow();
    });
  });
});
