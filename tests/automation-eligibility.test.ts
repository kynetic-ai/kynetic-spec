/**
 * Tests for task automation eligibility system
 * AC: @task-automation-eligibility
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
} from './helpers/cli';

describe('Task Automation Eligibility', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('Schema (AC-1, AC-2)', () => {
    // AC: @task-automation-eligibility ac-1
    it('should allow optional automation field with enum values', () => {
      // Create a task with automation field
      const output = kspec('task add --title "Eligible task" --automation eligible', tempDir);
      expect(output).toContain('Created task');

      // Verify it was set
      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const newTask = tasks.find(t => t.title === 'Eligible task');
      expect(newTask.automation).toBe('eligible');
    });

    // AC: @task-automation-eligibility ac-2
    it('should have no automation field when not specified', () => {
      // Create a task without automation field
      const output = kspec('task add --title "Unassessed task"', tempDir);
      expect(output).toContain('Created task');

      // Verify it has no automation field
      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const newTask = tasks.find(t => t.title === 'Unassessed task');
      expect(newTask.automation).toBeUndefined();
    });
  });

  describe('CLI: task set (AC-5, AC-11, AC-12)', () => {
    // AC: @task-automation-eligibility ac-11
    it('should set automation status with --automation flag', () => {
      kspec('task set @test-task-pending --automation eligible', tempDir);

      const task = kspecJson<{ automation: string }>('task get @test-task-pending', tempDir);
      expect(task.automation).toBe('eligible');
    });

    // AC: @task-automation-eligibility ac-5
    it('should allow setting any valid automation value', () => {
      // Set to eligible
      kspec('task set @test-task-pending --automation eligible', tempDir);
      let task = kspecJson<{ automation: string }>('task get @test-task-pending', tempDir);
      expect(task.automation).toBe('eligible');

      // Set to manual_only
      kspec('task set @test-task-pending --automation manual_only', tempDir);
      task = kspecJson<{ automation: string }>('task get @test-task-pending', tempDir);
      expect(task.automation).toBe('manual_only');
    });

    // AC: @task-automation-eligibility ac-12
    it('should clear automation status with --no-automation flag', () => {
      // First set automation
      kspec('task set @test-task-pending --automation eligible', tempDir);

      // Then clear it
      kspec('task set @test-task-pending --no-automation', tempDir);

      const task = kspecJson<{ automation?: string }>('task get @test-task-pending', tempDir);
      expect(task.automation).toBeUndefined();
    });

    it('should reject invalid automation values', () => {
      const result = kspecRun('task set @test-task-pending --automation invalid', tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Invalid automation status');
    });
  });

  describe('CLI: task add (AC-13)', () => {
    // AC: @task-automation-eligibility ac-13
    it('should create task with automation flag', () => {
      kspec('task add --title "New eligible task" --automation eligible', tempDir);

      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const newTask = tasks.find(t => t.title === 'New eligible task');
      expect(newTask.automation).toBe('eligible');
    });

    it('should create task with needs_review automation', () => {
      kspec('task add --title "Needs review task" --automation needs_review', tempDir);

      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const newTask = tasks.find(t => t.title === 'Needs review task');
      expect(newTask.automation).toBe('needs_review');
    });

    it('should reject invalid automation value on create', () => {
      const result = kspecRun('task add --title "Invalid" --automation foo', tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Invalid automation status');
    });
  });

  describe('CLI: task get (AC-17)', () => {
    // AC: @task-automation-eligibility ac-17
    it('should display automation status in task details', () => {
      kspec('task set @test-task-pending --automation eligible', tempDir);

      const output = kspec('task get @test-task-pending', tempDir);
      expect(output).toContain('Automation:');
      expect(output).toContain('eligible');
    });

    it('should show unassessed for tasks without automation', () => {
      const output = kspec('task get @test-task-pending', tempDir);
      expect(output).toContain('Automation:');
      expect(output).toContain('unassessed');
    });
  });

  describe('CLI: tasks ready (AC-14, AC-19, AC-20, AC-24)', () => {
    beforeEach(() => {
      // Set up tasks with different automation statuses
      kspec('task add --title "Eligible 1" --automation eligible', tempDir);
      kspec('task add --title "Eligible 2" --automation eligible', tempDir);
      kspec('task add --title "Needs Review" --automation needs_review', tempDir);
      kspec('task add --title "Manual Only" --automation manual_only', tempDir);
      kspec('task add --title "Unassessed 1"', tempDir);
    });

    // AC: @task-automation-eligibility ac-14
    it('should display automation status in ready list', () => {
      const output = kspec('tasks ready', tempDir);
      expect(output).toContain('[eligible]');
      expect(output).toContain('[needs_review]');
      expect(output).toContain('[manual_only]');
      expect(output).toContain('[unassessed]');
    });

    // AC: @task-automation-eligibility ac-19
    it('should filter by --eligible flag', () => {
      const output = kspec('tasks ready --eligible', tempDir);
      expect(output).toContain('Eligible 1');
      expect(output).toContain('Eligible 2');
      expect(output).not.toContain('Needs Review');
      expect(output).not.toContain('Manual Only');
      expect(output).not.toContain('Unassessed 1');
    });

    // AC: @task-automation-eligibility ac-20
    it('should filter by --unassessed flag', () => {
      const output = kspec('tasks ready --unassessed', tempDir);
      expect(output).toContain('Unassessed 1');
      expect(output).not.toContain('Eligible 1');
      expect(output).not.toContain('Needs Review');
    });

    // AC: @task-automation-eligibility ac-24
    it('should filter by --needs-review flag', () => {
      const output = kspec('tasks ready --needs-review', tempDir);
      expect(output).toContain('Needs Review');
      expect(output).not.toContain('Eligible 1');
      expect(output).not.toContain('Manual Only');
    });

  });

  describe('Require reason for needs_review (AC-18)', () => {
    // AC: @task-automation-eligibility ac-18
    it('should require --reason when setting needs_review', () => {
      const result = kspecRun('task set @test-task-pending --automation needs_review', tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('requires --reason');
    });

    it('should accept needs_review with reason', () => {
      const output = kspec('task set @test-task-pending --automation needs_review --reason "Needs human decision"', tempDir);
      expect(output).toContain('Updated task');

      const task = kspecJson<{ automation: string; notes: any[] }>('task get @test-task-pending', tempDir);
      expect(task.automation).toBe('needs_review');
      // Should have added a note documenting the change
      expect(task.notes.length).toBeGreaterThan(0);
      expect(task.notes.some(n => n.content.includes('needs_review'))).toBe(true);
    });
  });

  describe('Validation warnings (AC-21, AC-23)', () => {
    // AC: @task-automation-eligibility ac-21
    it('should warn when eligible task has no spec_ref', () => {
      // Create a task with eligible but no spec_ref
      kspec('task add --title "Eligible no spec" --automation eligible', tempDir);

      const output = kspec('validate --completeness', tempDir);
      expect(output).toContain('Completeness warnings');
      expect(output).toContain('eligible but has no spec_ref');
    });

    it('should not warn when eligible task has spec_ref', () => {
      // Create task with both eligible and spec_ref
      kspec('task add --title "Eligible with spec" --automation eligible --spec-ref @test-feature', tempDir);

      const output = kspec('validate --completeness', tempDir);
      // Should not contain warning about this specific task
      expect(output).not.toContain('Eligible with spec');
    });

    // AC: @task-automation-eligibility ac-23
    it('should warn when eligible task has unresolvable spec_ref', async () => {
      // Create task with eligible status and a valid spec_ref
      kspec('task add --title "Bad spec ref" --automation eligible --spec-ref @test-feature', tempDir);

      // Get the task to find its ULID
      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const task = tasks.find(t => t.title === 'Bad spec ref');

      // Manually patch the task file to have an unresolvable spec_ref
      // This simulates a spec being deleted after the task was created
      const tasksFile = path.join(tempDir, 'project.tasks.yaml');
      const content = await fs.readFile(tasksFile, 'utf-8');
      // Replace the valid spec_ref with an invalid one
      const updatedContent = content.replace(
        /spec_ref: "@test-feature"/,
        'spec_ref: "@nonexistent-deleted-spec"'
      );
      await fs.writeFile(tasksFile, updatedContent);

      // Now validate should warn about the unresolvable spec_ref
      const output = kspec('validate --completeness', tempDir);
      expect(output).toContain('Completeness warnings');
      expect(output).toContain('cannot be resolved');
    });
  });

  describe('JSON output', () => {
    it('should include automation field in JSON output', () => {
      kspec('task set @test-task-pending --automation eligible', tempDir);

      const result = kspecJson<{ automation: string }>('task get @test-task-pending', tempDir);
      expect(result.automation).toBe('eligible');
    });

    it('should include automation in tasks list JSON', () => {
      kspec('task set @test-task-pending --automation eligible', tempDir);

      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const task = tasks.find(t => t.slugs?.includes('test-task-pending'));
      expect(task.automation).toBe('eligible');
    });

    it('should include automation in tasks ready JSON', () => {
      kspec('task set @test-task-pending --automation eligible', tempDir);

      const tasks = kspecJson<any[]>('tasks ready', tempDir);
      const task = tasks.find(t => t.slugs?.includes('test-task-pending'));
      expect(task.automation).toBe('eligible');
    });
  });
});
