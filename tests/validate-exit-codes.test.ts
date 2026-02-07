/**
 * Tests for validate command exit codes
 *
 * AC: @cli-exit-codes
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
      expect(result.stderr + result.stdout).toContain('Completeness warnings');
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
  });

  describe('lint command exit codes', () => {
    it('should use same exit codes as validate', () => {
      // lint is an alias with the same behavior
      const validateResult = kspec('validate', tempDir);
      const lintResult = kspec('lint', tempDir);
      expect(lintResult.exitCode).toBe(validateResult.exitCode);
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
