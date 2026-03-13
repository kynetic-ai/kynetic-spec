/**
 * Tests for validate command exit codes
 *
 * Exit code behavior:
 * - 0 (SUCCESS): No errors, no warnings
 * - 4 (VALIDATION_FAILED): Errors present (schema, refs, trait cycles, etc.)
 * - 6 (VALIDATION_WARNINGS): Warnings only (orphans, completeness, alignment, staleness)
 *
 * Note: --strict flag only escalates orphan and staleness warnings to errors,
 * not completeness warnings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { kspec, setupTempFixtures, cleanupTempDir, testUlid, createTempDir } from './helpers/cli';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

describe('validate exit codes', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cli-exit-codes (exit 4 for validation errors)
  describe('exit code 4 (VALIDATION_FAILED)', () => {
    it('should exit 4 when schema errors are present', async () => {
      // Create an invalid spec file with bad ULID
      const specDir = path.join(tempDir, 'modules');
      await fs.writeFile(
        path.join(specDir, 'invalid.yaml'),
        `
items:
  - _ulid: "not-a-valid-ulid"
    title: "Bad Item"
    type: feature
`
      );

      // Update manifest to include the invalid file
      const manifestPath = path.join(tempDir, 'kynetic.yaml');
      const manifest = await fs.readFile(manifestPath, 'utf-8');
      const updatedManifest = manifest.replace(
        'includes:',
        'includes:\n  - modules/invalid.yaml'
      );
      await fs.writeFile(manifestPath, updatedManifest);

      const result = kspec('validate --schema', tempDir);
      expect(result.exitCode).toBe(4);
      expect(result.stderr + result.stdout).toContain('Schema errors');
    });

    it('should exit 4 when reference errors are present', async () => {
      // Add a task with an invalid spec_ref
      const tasksFile = path.join(tempDir, 'project.tasks.yaml');
      const content = await fs.readFile(tasksFile, 'utf-8');
      const newContent = content.replace(
        'tasks:',
        `tasks:
  - _ulid: ${testUlid('BADREF')}
    title: "Task with bad ref"
    status: pending
    spec_ref: "@nonexistent-spec"
    priority: 3
`
      );
      await fs.writeFile(tasksFile, newContent);

      const result = kspec('validate --refs', tempDir);
      expect(result.exitCode).toBe(4);
      expect(result.stderr + result.stdout).toContain('Reference errors');
    });

  });

  // Note: --strict flag behavior is tested in staleness.test.ts
  // It escalates orphan and staleness warnings to errors
  // The "orphan" detection (result.orphans) is distinct from alignment's "orphaned specs (no tasks)"

  // AC: @cli-exit-codes (exit 6 for warnings only)
  describe('exit code 6 (VALIDATION_WARNINGS)', () => {
    it('should exit 6 when only warnings are present (no errors)', () => {
      // The base fixtures have completeness warnings (missing ACs)
      // These should cause exit 6 (warnings) not 4 (errors)
      const result = kspec('validate', tempDir);
      expect(result.exitCode).toBe(6);
      // AC: @validation-output ac-1
      expect(result.stderr + result.stdout).toContain('Completeness warnings');
      expect(result.stderr + result.stdout).toContain(
        'Validation produced warnings; exiting 6'
      );
    });

    it('should exit 6 when orphan warnings are added', async () => {
      // Create an orphan spec item (not referenced by any task)
      const specDir = path.join(tempDir, 'modules');
      await fs.writeFile(
        path.join(specDir, 'orphan.yaml'),
        `
items:
  - _ulid: ${testUlid('0RPHN')}
    title: "Orphan Feature"
    type: feature
    description: "This feature is not referenced by any task"
    status:
      implementation: not_started
`
      );

      // Update manifest to include the orphan file
      const manifestPath = path.join(tempDir, 'kynetic.yaml');
      const manifest = await fs.readFile(manifestPath, 'utf-8');
      const updatedManifest = manifest.replace(
        'includes:',
        'includes:\n  - modules/orphan.yaml'
      );
      await fs.writeFile(manifestPath, updatedManifest);

      // Full validation should show orphans and completeness warnings
      const result = kspec('validate', tempDir);
      expect(result.exitCode).toBe(6);
      expect(result.stderr + result.stdout).toContain('Orphan');
    });

    it('should exit 0 with --warnings-ok when only warnings are present', () => {
      const result = kspec('validate --warnings-ok', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr + result.stdout).toContain('Completeness warnings');
      expect(result.stderr + result.stdout).toContain(
        'exiting 0 due to --warnings-ok'
      );
    });
  });

  describe('lint command exit codes', () => {
    it('should use same exit codes as validate', () => {
      // lint is an alias with the same behavior
      const validateResult = kspec('validate', tempDir);
      const lintResult = kspec('lint', tempDir);
      expect(lintResult.exitCode).toBe(validateResult.exitCode);
    });

    it('should support --warnings-ok and exit 0 on warnings-only', () => {
      const lintResult = kspec('lint --warnings-ok', tempDir);
      expect(lintResult.exitCode).toBe(0);
      expect(lintResult.stderr + lintResult.stdout).toContain(
        'exiting 0 due to --warnings-ok'
      );
    });
  });

  // AC: @trait-json-output ac-1, ac-2
  describe('JSON output purity', () => {
    it('should emit parseable JSON only for validate --json', () => {
      const result = kspec('validate --json', tempDir);

      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(result.stdout).not.toContain('Alignment warnings:');
      expect(result.stdout).not.toContain('Completeness warnings:');
    });

    // AC: @trait-json-output ac-1 — no ANSI color codes in JSON output
    it('should not contain ANSI escape codes in JSON output', () => {
      const result = kspec('validate --json', tempDir);
      // eslint-disable-next-line no-control-regex
      expect(result.stdout).not.toMatch(/\u001b\[/);
    });

    // AC: @trait-json-output ac-2 — JSON includes all data from human-readable mode
    // AC: @validation-output ac-2
    it('should include completeness warnings in JSON output', () => {
      const result = kspec('validate --json', tempDir);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty('completenessWarnings');
      expect(parsed).toHaveProperty('valid');
      expect(parsed).toHaveProperty('schemaErrors');
      expect(parsed).toHaveProperty('refErrors');
      expect(parsed).toHaveProperty('stats');
    });

    // AC: @trait-json-output ac-2 — JSON includes alignment data when alignment runs
    it('should include alignment data in JSON output when running all checks', () => {
      const result = kspec('validate --json', tempDir);
      const parsed = JSON.parse(result.stdout);
      // When running all checks (no filter flags), alignment data is included
      expect(parsed).toHaveProperty('alignmentWarnings');
      expect(parsed).toHaveProperty('alignmentStats');
    });

    // AC: @trait-json-output ac-2 — JSON includes skill validation data
    it('should include skill validation in JSON output', () => {
      const result = kspec('validate --json', tempDir);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty('skillValidation');
      expect(parsed.skillValidation).toHaveProperty('valid');
      expect(parsed.skillValidation).toHaveProperty('filesChecked');
    });

    it('should emit parseable JSON for lint --json', () => {
      const result = kspec('lint --json', tempDir);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty('valid');
      expect(parsed).toHaveProperty('stats');
    });
  });

  // AC: @cli-exit-codes (exit 0 for clean validation)
  describe('exit code 0 (SUCCESS)', () => {
    let cleanDir: string;

    beforeEach(async () => {
      // Create a minimal clean project with no warnings
      cleanDir = await createTempDir('kspec-clean-');

      // Create minimal kspec structure
      await fs.writeFile(
        path.join(cleanDir, 'kynetic.yaml'),
        `kynetic: "1.0"
project:
  name: "Clean Project"
`
      );

      await fs.writeFile(
        path.join(cleanDir, 'project.tasks.yaml'),
        `tasks: []
`
      );
    });

    afterEach(async () => {
      await cleanupTempDir(cleanDir);
    });

    it('should exit 0 when project has no errors or warnings', () => {
      // A minimal project with no items, no tasks = no warnings
      const result = kspec('validate', cleanDir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr + result.stdout).toContain('Validation passed');
    });

    it('should exit 0 for schema-only check on clean project', () => {
      const result = kspec('validate --schema', cleanDir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr + result.stdout).toContain('Schema: OK');
    });
  });
});
