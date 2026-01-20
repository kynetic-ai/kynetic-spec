/**
 * Tests for kspec tasks assess automation command
 * AC: @tasks-assess-automation
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

describe('kspec tasks assess automation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('Filtering & Display (AC-1, AC-2, AC-26, AC-27, AC-28)', () => {
    // AC: @tasks-assess-automation ac-1
    it('should list pending unassessed tasks by default', () => {
      // Create unassessed task
      kspec('task add --title "Unassessed task"', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('Unassessed task');
      expect(output).toContain('needs_review');
    });

    // AC: @tasks-assess-automation ac-2
    it('should include already-assessed tasks with --all flag', () => {
      // Create task and set automation
      kspec('task add --title "Already assessed"', tempDir);
      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const task = tasks.find(t => t.title === 'Already assessed');
      kspec(`task set @${task._ulid.slice(0, 8)} --automation eligible`, tempDir);

      // Without --all, should not appear
      const output1 = kspec('tasks assess automation', tempDir);
      expect(output1).not.toContain('Already assessed');

      // With --all, should appear
      const output2 = kspec('tasks assess automation --all', tempDir);
      expect(output2).toContain('Already assessed');
    });

    // AC: @tasks-assess-automation ac-26
    it('should show message when no unassessed pending tasks', () => {
      // Mark all pending tasks as assessed (test-task-pending and test-task-blocked)
      kspec('task set @test-task-pending --automation eligible', tempDir);
      kspec('task set @test-task-blocked --automation eligible', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('No unassessed pending tasks');
    });

    // AC: @tasks-assess-automation ac-27
    it('should skip already-assessed tasks without --all', () => {
      kspec('task set @test-task-pending --automation eligible', tempDir);
      kspec('task add --title "New unassessed"', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).not.toContain('Test pending task');
      expect(output).toContain('New unassessed');
    });

    // AC: @tasks-assess-automation ac-28
    it('should exclude non-pending tasks', () => {
      // completed task should not appear
      const output = kspec('tasks assess automation --all', tempDir);
      expect(output).not.toContain('Test completed task');
    });
  });

  describe('Single Task Assessment (AC-6, AC-7)', () => {
    // AC: @tasks-assess-automation ac-6
    it('should assess only specified task with ref argument', () => {
      kspec('task add --title "Task A" --slug task-a-test', tempDir);
      kspec('task add --title "Task B" --slug task-b-test', tempDir);

      // Assess only Task A by slug
      const output = kspec('tasks assess automation @task-a-test', tempDir);
      expect(output).toContain('Task A');
      expect(output).not.toContain('Task B');
      expect(output).toContain('total: 1');
    });

    // AC: @tasks-assess-automation ac-7
    it('should return non-zero exit code for non-existent task', () => {
      const result = kspecRun('tasks assess automation @nonexistent-task', tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Task not found');
    });
  });

  describe('Criteria Checks (AC-8, AC-9, AC-10, AC-11, AC-12, AC-13)', () => {
    // AC: @tasks-assess-automation ac-8
    it('should pass has_spec_ref when task has resolvable spec_ref', () => {
      kspec('task add --title "With spec" --spec-ref @test-feature', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('spec_ref:     ✓');
      expect(output).toContain('@test-feature');
    });

    // AC: @tasks-assess-automation ac-9
    it('should fail has_spec_ref when spec_ref is missing', () => {
      kspec('task add --title "No spec"', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('spec_ref:     ✗');
      expect(output).toContain('missing');
    });

    // AC: @tasks-assess-automation ac-10, ac-11
    it('should check spec_has_acs only when spec_ref exists', async () => {
      // Add acceptance criteria to test-feature
      const coreYamlPath = path.join(tempDir, 'modules', 'core.yaml');
      const coreYaml = await fs.readFile(coreYamlPath, 'utf-8');
      const updatedYaml = coreYaml.replace(
        'implements:\n          - "@test-feature"',
        `implements:
          - "@test-feature"
    acceptance_criteria:
      - id: ac-1
        given: test
        when: test
        then: test`
      );
      await fs.writeFile(coreYamlPath, updatedYaml);

      // Task with spec_ref pointing to spec with ACs
      kspec('task add --title "Has ACs" --spec-ref @test-requirement', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      // Should show AC check result
      expect(output).toContain('has_acs:');
    });

    // AC: @tasks-assess-automation ac-11
    it('should skip spec_has_acs when no spec_ref', () => {
      kspec('task add --title "No spec"', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('has_acs:      -');
      expect(output).toContain('no spec to check');
    });

    // AC: @tasks-assess-automation ac-12
    it('should pass not_spike for non-spike tasks', () => {
      kspec('task add --title "Regular task" --type task', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('not_spike:    ✓');
    });

    // AC: @tasks-assess-automation ac-13
    it('should fail not_spike for spike tasks', () => {
      kspec('task add --title "Spike task" --type spike', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('not_spike:    ✗');
      expect(output).toContain('type: spike');
    });
  });

  describe('Recommendations (AC-14, AC-15, AC-16)', () => {
    // AC: @tasks-assess-automation ac-14
    it('should recommend manual_only for spike tasks', () => {
      kspec('task add --title "Spike" --type spike', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('manual_only');
      expect(output).toContain('Spikes output knowledge');
    });

    // AC: @tasks-assess-automation ac-15
    it('should recommend needs_review for missing spec_ref', () => {
      kspec('task add --title "No spec"', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('needs_review');
      expect(output).toContain('missing spec_ref');
    });

    // AC: @tasks-assess-automation ac-16
    it('should recommend review_for_eligible when all criteria pass', async () => {
      // Add acceptance criteria to test-feature
      const coreYamlPath = path.join(tempDir, 'modules', 'core.yaml');
      const coreYaml = await fs.readFile(coreYamlPath, 'utf-8');
      const updatedYaml = coreYaml.replace(
        'description: A test feature for integration testing',
        `description: A test feature for integration testing
    acceptance_criteria:
      - id: ac-1
        given: test
        when: test
        then: test`
      );
      await fs.writeFile(coreYamlPath, updatedYaml);

      kspec('task add --title "Ready task" --spec-ref @test-feature', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('review_for_eligible');
      expect(output).toContain('verify spec is appropriate');
    });
  });

  describe('Auto Mode (AC-17, AC-18, AC-19, AC-20, AC-21)', () => {
    // AC: @tasks-assess-automation ac-17
    it('should apply obvious cases: spike -> manual_only', () => {
      kspec('task add --title "Spike task" --type spike', tempDir);

      kspec('tasks assess automation --auto', tempDir);

      // Verify task was updated
      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const spike = tasks.find(t => t.title === 'Spike task');
      expect(spike.automation).toBe('manual_only');
    });

    // AC: @tasks-assess-automation ac-17
    it('should apply obvious cases: missing criteria -> needs_review', () => {
      kspec('task add --title "Missing spec"', tempDir);

      kspec('tasks assess automation --auto', tempDir);

      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const task = tasks.find(t => t.title === 'Missing spec');
      expect(task.automation).toBe('needs_review');
    });

    // AC: @tasks-assess-automation ac-18, ac-21
    it('should NOT auto-mark eligible when all criteria pass', async () => {
      // Add acceptance criteria to test-feature
      const coreYamlPath = path.join(tempDir, 'modules', 'core.yaml');
      const coreYaml = await fs.readFile(coreYamlPath, 'utf-8');
      const updatedYaml = coreYaml.replace(
        'description: A test feature for integration testing',
        `description: A test feature for integration testing
    acceptance_criteria:
      - id: ac-1
        given: test
        when: test
        then: test`
      );
      await fs.writeFile(coreYamlPath, updatedYaml);

      kspec('task add --title "Ready task" --spec-ref @test-feature', tempDir);

      kspec('tasks assess automation --auto', tempDir);

      // Should NOT be marked eligible
      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const task = tasks.find(t => t.title === 'Ready task');
      expect(task.automation).toBeUndefined(); // Still unassessed
    });

    // AC: @tasks-assess-automation ac-19
    it('should add note explaining assessment in auto mode', () => {
      kspec('task add --title "Note test"', tempDir);

      kspec('tasks assess automation --auto', tempDir);

      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const task = tasks.find(t => t.title === 'Note test');
      expect(task.notes.length).toBeGreaterThan(0);
      expect(task.notes.some((n: any) => n.content.includes('Automation assessment'))).toBe(true);
    });

    // AC: @tasks-assess-automation ac-20
    it('should include reason in note for needs_review', () => {
      kspec('task add --title "Reason test"', tempDir);

      kspec('tasks assess automation --auto', tempDir);

      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const task = tasks.find(t => t.title === 'Reason test');
      expect(task.notes.some((n: any) => n.content.includes('missing spec_ref'))).toBe(true);
    });
  });

  describe('Dry Run (AC-22, AC-23)', () => {
    // AC: @tasks-assess-automation ac-22
    it('should show changes without modifying tasks in dry-run', () => {
      kspec('task add --title "Dry run test"', tempDir);

      const output = kspec('tasks assess automation --dry-run', tempDir);
      expect(output).toContain('Dry run test');

      // Task should not be modified
      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const task = tasks.find(t => t.title === 'Dry run test');
      expect(task.automation).toBeUndefined();
    });

    // AC: @tasks-assess-automation ac-23
    it('should combine --dry-run with --auto', () => {
      kspec('task add --title "Dry auto test"', tempDir);

      const output = kspec('tasks assess automation --auto --dry-run', tempDir);
      expect(output).toContain('Dry run');
      expect(output).toContain('would make these changes');
      expect(output).toContain('set automation=needs_review');

      // Task should not be modified
      const tasks = kspecJson<any[]>('tasks list', tempDir);
      const task = tasks.find(t => t.title === 'Dry auto test');
      expect(task.automation).toBeUndefined();
    });
  });

  describe('Output Formats (AC-3, AC-4, AC-5, AC-24, AC-25)', () => {
    // AC: @tasks-assess-automation ac-3
    it('should display criteria check results for each task', () => {
      kspec('task add --title "Criteria test"', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('spec_ref:');
      expect(output).toContain('has_acs:');
      expect(output).toContain('not_spike:');
    });

    // AC: @tasks-assess-automation ac-4
    it('should show recommendation for each task', () => {
      kspec('task add --title "Rec test"', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toMatch(/→.*needs_review/);
    });

    // AC: @tasks-assess-automation ac-5
    it('should show summary counts at end', () => {
      kspec('task add --title "Summary test"', tempDir);

      const output = kspec('tasks assess automation', tempDir);
      expect(output).toContain('Summary:');
      expect(output).toContain('review_for_eligible:');
      expect(output).toContain('needs_review:');
      expect(output).toContain('manual_only:');
      expect(output).toContain('total:');
    });

    // AC: @tasks-assess-automation ac-24
    it('should output structured JSON with --json', () => {
      kspec('task add --title "JSON test"', tempDir);

      const result = kspecJson<any>('tasks assess automation', tempDir);
      expect(result.assessments).toBeDefined();
      expect(result.assessments.length).toBeGreaterThan(0);
      expect(result.assessments[0].criteria).toBeDefined();
      expect(result.assessments[0].criteria.has_spec_ref).toBeDefined();
      expect(result.assessments[0].recommendation).toBeDefined();
    });

    // AC: @tasks-assess-automation ac-25
    it('should include summary counts in JSON', () => {
      kspec('task add --title "JSON summary test"', tempDir);

      const result = kspecJson<any>('tasks assess automation', tempDir);
      expect(result.summary).toBeDefined();
      expect(result.summary.review_for_eligible).toBeDefined();
      expect(result.summary.needs_review).toBeDefined();
      expect(result.summary.manual_only).toBeDefined();
      expect(result.summary.total).toBeDefined();
    });
  });
});
