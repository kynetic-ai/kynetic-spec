/**
 * Integration tests for kspec CLI commands.
 *
 * Uses fixture files to test end-to-end workflows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  FIXTURES_DIR,
  git,
  initGitRepo,
} from './helpers/cli';

describe('Integration: validate', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should validate fixture spec without errors', () => {
    const output = kspec('validate', tempDir);
    expect(output).toContain('Validation passed');
  });

  it('should check schema conformance', () => {
    const output = kspec('validate --schema', tempDir);
    expect(output).toContain('Schema: OK');
  });

  it('should check references', () => {
    const output = kspec('validate --refs', tempDir);
    expect(output).toContain('References: OK');
  });
});

describe('Integration: tasks', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should list all tasks', () => {
    const output = kspec('tasks list', tempDir);
    expect(output).toContain('test-task-pending');
    expect(output).toContain('test-task-blocked');
    expect(output).toContain('test-task-completed');
  });

  it('should list ready tasks (unblocked pending)', () => {
    const output = kspec('tasks ready', tempDir);
    expect(output).toContain('test-task-pending');
    expect(output).not.toContain('test-task-blocked'); // blocked by dependency
    expect(output).not.toContain('test-task-completed'); // already done
  });

  it('should get task details', () => {
    const output = kspec('task get @test-task-pending', tempDir);
    expect(output).toContain('Test pending task');
    expect(output).toContain('pending');
  });

  it('should get task details as JSON', () => {
    const result = kspecJson<{ _ulid: string; title: string; status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(result._ulid).toBe('01KF1645CA45ZT43W2T6HJMVA1');
    expect(result.title).toBe('Test pending task');
    expect(result.status).toBe('pending');
  });

  // AC: @task-list-verbose ac-1
  it('should show full details with --full flag', () => {
    const output = kspec('tasks ready --full', tempDir);

    // Should show timestamps (AC-1)
    expect(output).toContain('Created:');

    // Tags and dependencies should be shown if present
    expect(output).toContain('test-task-pending');
  });

  // AC: @task-list-verbose ac-2
  it('should preserve current -v behavior', () => {
    const output = kspec('tasks ready -v', tempDir);

    // Should show tags inline with -v
    expect(output).toContain('#test');

    // Should NOT show full mode details
    expect(output).not.toContain('Created:');
  });

  // AC: @task-list-verbose ac-3
  it('should handle tasks with no notes or todos in full mode', () => {
    const output = kspec('tasks ready --full', tempDir);

    // Should not error when tasks have no notes/todos
    expect(output).toContain('test-task-pending');
  });

  // AC: @task-list-verbose ac-4
  it('should include all fields in JSON output with --full', () => {
    const result = kspecJson<any[]>('tasks ready --full', tempDir);

    // Should include notes and todos arrays
    expect(result[0]).toHaveProperty('notes');
    expect(result[0]).toHaveProperty('todos');
    expect(result[0]).toHaveProperty('created_at');
    expect(Array.isArray(result[0].notes)).toBe(true);
    expect(Array.isArray(result[0].todos)).toBe(true);
  });
});

describe('Integration: task lifecycle', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should start a task', () => {
    const output = kspec('task start @test-task-pending', tempDir);
    expect(output).toContain('Started task');

    // Verify status changed
    const task = kspecJson<{ status: string }>('task get @test-task-pending', tempDir);
    expect(task.status).toBe('in_progress');
  });

  it('should add a note to a task', () => {
    const output = kspec('task note @test-task-pending "Test note content"', tempDir);
    expect(output).toContain('Added note');

    // Verify note was added
    const notesOutput = kspec('task notes @test-task-pending', tempDir);
    expect(notesOutput).toContain('Test note content');
  });

  it('should complete a task', () => {
    // First start it
    kspec('task start @test-task-pending', tempDir);
    kspec('task submit @test-task-pending', tempDir);

    // Then complete it
    const output = kspec('task complete @test-task-pending --reason "Done"', tempDir);
    expect(output).toContain('Completed task');

    // Verify status changed
    const task = kspecJson<{ status: string }>('task get @test-task-pending', tempDir);
    expect(task.status).toBe('completed');
  });

  it('should unblock dependent task when dependency completes', () => {
    // Initially blocked task should not be ready
    let readyOutput = kspec('tasks ready', tempDir);
    expect(readyOutput).not.toContain('test-task-blocked');

    // Complete the blocking task
    kspec('task start @test-task-pending', tempDir);
    kspec('task submit @test-task-pending', tempDir);
    kspec('task complete @test-task-pending --reason "Done"', tempDir);

    // Now blocked task should be ready
    readyOutput = kspec('tasks ready', tempDir);
    expect(readyOutput).toContain('test-task-blocked');
  });
});

// AC: @pending-review-state ac-1, ac-2, ac-9, ac-4, ac-6
describe('Integration: task submit (pending_review state)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @pending-review-state ac-9
  it('should submit a task from in_progress to pending_review', () => {
    // Start task first
    kspec('task start @test-task-pending', tempDir);

    // Submit for review
    const output = kspec('task submit @test-task-pending', tempDir);
    expect(output).toContain('Submitted task for review');

    // Verify status changed
    const task = kspecJson<{ status: string }>('task get @test-task-pending', tempDir);
    expect(task.status).toBe('pending_review');
  });

  // AC: @pending-review-state ac-9
  it('should reject submit from non-in_progress state', () => {
    // Task is pending (not in_progress)
    const result = kspecRun('task submit @test-task-pending', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Task must be in_progress');
  });

  // AC: @pending-review-state ac-2
  it('should complete a task from pending_review state', () => {
    // Start, then submit
    kspec('task start @test-task-pending', tempDir);
    kspec('task submit @test-task-pending', tempDir);

    // Complete from pending_review
    const output = kspec('task complete @test-task-pending --reason "Merged"', tempDir);
    expect(output).toContain('Completed task');

    // Verify status is completed
    const task = kspecJson<{ status: string }>('task get @test-task-pending', tempDir);
    expect(task.status).toBe('completed');
  });

  // AC: @pending-review-state ac-4
  it('should exclude pending_review tasks from ready list', () => {
    // Start and submit
    kspec('task start @test-task-pending', tempDir);
    kspec('task submit @test-task-pending', tempDir);

    // Should not be in ready list
    const readyOutput = kspec('tasks ready', tempDir);
    expect(readyOutput).not.toContain('test-task-pending');
  });

  // AC: @pending-review-state ac-6
  it('should filter tasks by pending_review status', () => {
    // Start and submit
    kspec('task start @test-task-pending', tempDir);
    kspec('task submit @test-task-pending', tempDir);

    // Should appear in filtered list
    const output = kspec('tasks list --status pending_review', tempDir);
    expect(output).toContain('test-task-pending');
  });

  // AC: @pending-review-state ac-1
  it('should accept pending_review as valid status in schema', () => {
    // Start, submit, then verify get works (schema validation)
    kspec('task start @test-task-pending', tempDir);
    kspec('task submit @test-task-pending', tempDir);

    // If schema was invalid, this would fail
    const task = kspecJson<{ status: string }>('task get @test-task-pending', tempDir);
    expect(task.status).toBe('pending_review');
  });
});

describe('Integration: task add', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should create a new task', () => {
    const output = kspec('task add --title "New test task" --priority 1', tempDir);
    expect(output).toContain('Created task');

    // Verify task exists
    const listOutput = kspec('tasks list', tempDir);
    expect(listOutput).toContain('New test task');
  });

  it('should create task with all options', () => {
    kspec(
      'task add --title "Full task" --type bug --priority 1 --tag urgent --tag fix --slug my-bug',
      tempDir
    );

    const task = kspecJson<{ type: string; priority: number; tags: string[]; slugs: string[] }>(
      'task get @my-bug',
      tempDir
    );

    expect(task.type).toBe('bug');
    expect(task.priority).toBe(1);
    expect(task.tags).toContain('urgent');
    expect(task.tags).toContain('fix');
    expect(task.slugs).toContain('my-bug');
  });
});

describe('Integration: task set', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should update task title', () => {
    const output = kspec('task set @test-task-pending --title "Updated Title"', tempDir);
    expect(output).toContain('Updated task');
    expect(output).toContain('(title)');

    // Verify title changed
    const task = kspecJson<{ title: string }>('task get @test-task-pending', tempDir);
    expect(task.title).toBe('Updated Title');
  });

  it('should set spec_ref on task', () => {
    const output = kspec('task set @test-task-pending --spec-ref @test-feature', tempDir);
    expect(output).toContain('Updated task');
    expect(output).toContain('(spec_ref)');

    // Verify spec_ref was set
    const task = kspecJson<{ spec_ref: string }>('task get @test-task-pending', tempDir);
    expect(task.spec_ref).toBe('@test-feature');
  });

  it('should reject nonexistent spec ref', () => {
    const result = kspecRun('task set @test-task-pending --spec-ref @nonexistent', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  it('should reject task as spec ref', () => {
    const result = kspecRun('task set @test-task-pending --spec-ref @test-task-blocked', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  it('should update priority', () => {
    kspec('task set @test-task-pending --priority 1', tempDir);

    const task = kspecJson<{ priority: number }>('task get @test-task-pending', tempDir);
    expect(task.priority).toBe(1);
  });

  it('should reject invalid priority', () => {
    const result = kspecRun('task set @test-task-pending --priority 6', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  it('should add slug to task', () => {
    kspec('task set @test-task-pending --slug my-new-slug', tempDir);

    const task = kspecJson<{ slugs: string[] }>('task get @test-task-pending', tempDir);
    expect(task.slugs).toContain('my-new-slug');
  });

  it('should add tags to task', () => {
    kspec('task set @test-task-pending --tag newtag1 --tag newtag2', tempDir);

    const task = kspecJson<{ tags: string[] }>('task get @test-task-pending', tempDir);
    expect(task.tags).toContain('newtag1');
    expect(task.tags).toContain('newtag2');
  });

  it('should not change task when no options specified', () => {
    // Get original task state
    const before = kspecJson<{ title: string; priority: number }>('task get @test-task-pending', tempDir);

    // Run set with no options (warns to stderr, no changes)
    kspec('task set @test-task-pending', tempDir);

    // Verify nothing changed
    const after = kspecJson<{ title: string; priority: number }>('task get @test-task-pending', tempDir);
    expect(after.title).toBe(before.title);
    expect(after.priority).toBe(before.priority);
  });

  it('should update multiple fields at once', () => {
    const output = kspec('task set @test-task-pending --title "Multi Update" --priority 2 --tag multi', tempDir);
    expect(output).toContain('title');
    expect(output).toContain('priority');
    expect(output).toContain('tags');

    const task = kspecJson<{ title: string; priority: number; tags: string[] }>('task get @test-task-pending', tempDir);
    expect(task.title).toBe('Multi Update');
    expect(task.priority).toBe(2);
    expect(task.tags).toContain('multi');
  });
});

describe('Integration: task patch', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @task-patch ac-1
  it('should update task priority with valid JSON', () => {
    kspec('task patch @test-task-pending --data \'{"priority":1}\'', tempDir);

    const task = kspecJson<{ priority: number }>('task get @test-task-pending', tempDir);
    expect(task.priority).toBe(1);
  });

  // AC: @task-patch ac-2
  it('should error on invalid JSON syntax', () => {
    const result = kspecRun("task patch @test-task-pending --data 'bad'", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @task-patch ac-3
  it('should error on unknown field by default', () => {
    const result = kspecRun('task patch @test-task-pending --data \'{"unknown":true}\'', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @task-patch ac-4
  it('should allow unknown field with --allow-unknown', () => {
    // This should not throw
    kspec('task patch @test-task-pending --data \'{"unknown":true}\' --allow-unknown', tempDir);
  });

  it('should update multiple fields with JSON', () => {
    kspec('task patch @test-task-pending --data \'{"priority":1,"tags":["patched","test"]}\'', tempDir);

    const task = kspecJson<{ priority: number; tags: string[] }>('task get @test-task-pending', tempDir);
    expect(task.priority).toBe(1);
    expect(task.tags).toContain('patched');
    expect(task.tags).toContain('test');
  });

  it('should show changes with --dry-run', () => {
    const output = kspec('task patch @test-task-pending --data \'{"priority":1}\' --dry-run', tempDir);
    expect(output).toContain('Dry run');
    expect(output).toContain('priority');

    // Verify no actual change
    const task = kspecJson<{ priority: number }>('task get @test-task-pending', tempDir);
    expect(task.priority).toBe(2); // Original value from fixture
  });
});

describe('Integration: items', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should list spec items', () => {
    const output = kspec('item list', tempDir);
    expect(output).toContain('test-core');
    expect(output).toContain('test-feature');
  });

  it('should get item details', () => {
    const output = kspec('item get @test-feature', tempDir);
    expect(output).toContain('Test Feature');
    expect(output).toContain('feature');
  });

  it('should resolve nested requirement', () => {
    const output = kspec('item get @test-requirement', tempDir);
    expect(output).toContain('Test Requirement');
    expect(output).toContain('requirement');
  });

  // AC: @item-get ac-1
  it('should display acceptance criteria in item get output', () => {
    // First add an AC to the item
    kspec(
      'item ac add @test-feature --given "user is logged in" --when "they click logout" --then "session is terminated"',
      tempDir
    );

    // Verify item get shows the AC
    const output = kspec('item get @test-feature', tempDir);
    expect(output).toContain('Acceptance Criteria');
    expect(output).toContain('[ac-1]');
    expect(output).toContain('Given: user is logged in');
    expect(output).toContain('When: they click logout');
    expect(output).toContain('Then: session is terminated');
  });
});

describe('Integration: item set', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @item-set ac-1
  it('should add slug to existing slugs', () => {
    // Create an item with one slug
    kspec('item add --under @test-core --title "Slug Test" --slug slug-one --type feature', tempDir);

    // Add another slug
    kspec('item set @slug-one --slug slug-two', tempDir);

    // Verify both slugs exist
    const output = kspec('item get @slug-one', tempDir);
    expect(output).toContain('slug-one');
    expect(output).toContain('slug-two');
  });

  // AC: @item-set ac-2
  it('should remove slug from item', () => {
    // Create an item with one slug, add a second
    kspec('item add --under @test-core --title "Remove Test" --slug keep-slug --type feature', tempDir);
    kspec('item set @keep-slug --slug remove-slug', tempDir);

    // Remove the second slug
    kspec('item set @keep-slug --remove-slug remove-slug', tempDir);

    // Verify only first slug remains
    const output = kspec('item get @keep-slug', tempDir);
    expect(output).toContain('keep-slug');
    expect(output).not.toContain('remove-slug');
  });

  // AC: @item-set ac-3
  it('should prevent removing last slug', () => {
    // Create an item with one slug
    kspec('item add --under @test-core --title "Last Slug Test" --slug only-slug --type feature', tempDir);

    // Try to remove the only slug
    const result = kspecRun('item set @only-slug --remove-slug only-slug', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });
});

describe('Integration: item patch', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @item-patch ac-1
  it('should update item with --data JSON', () => {
    // Create a test item
    kspec('item add --under @test-core --title "Patch Test" --slug patch-test --type feature', tempDir);

    // Patch with status
    kspec('item patch @patch-test --data \'{"status":{"implementation":"implemented"}}\'', tempDir);

    // Verify update
    const output = kspec('item get @patch-test', tempDir);
    expect(output).toContain('implemented');
  });

  // AC: @item-patch ac-2
  it('should show error for invalid JSON', () => {
    kspec('item add --under @test-core --title "JSON Test" --slug json-test --type feature', tempDir);

    const result = kspecRun("item patch @json-test --data 'not json'", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @item-patch ac-3
  it('should accept JSON from stdin', () => {
    kspec('item add --under @test-core --title "Stdin Test" --slug stdin-test --type feature', tempDir);

    kspecRun('item patch @stdin-test', tempDir, { stdin: '{"description":"From stdin"}' });

    const output = kspec('item get @stdin-test', tempDir);
    expect(output).toContain('From stdin');
  });

  // AC: @item-patch ac-4
  it('should preview changes with --dry-run', () => {
    kspec('item add --under @test-core --title "DryRun Test" --slug dryrun-test --type feature', tempDir);

    const output = kspec('item patch @dryrun-test --data \'{"title":"New Title"}\' --dry-run', tempDir);
    expect(output).toContain('Would patch');

    // Verify no actual change
    const item = kspec('item get @dryrun-test', tempDir);
    expect(item).toContain('DryRun Test');
    expect(item).not.toContain('New Title');
  });

  // AC: @item-patch ac-5
  it('should reject unknown fields by default', () => {
    kspec('item add --under @test-core --title "Unknown Test" --slug unknown-test --type feature', tempDir);

    const result = kspecRun('item patch @unknown-test --data \'{"foobar":"value"}\'', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @item-patch ac-6
  it('should allow unknown fields with --allow-unknown', () => {
    kspec('item add --under @test-core --title "AllowUnknown Test" --slug allow-unknown-test --type feature', tempDir);

    // This should not throw
    kspec('item patch @allow-unknown-test --data \'{"custom_field":"value"}\' --allow-unknown', tempDir);
  });

  // AC: @item-patch ac-7
  it('should patch multiple items from JSONL', () => {
    kspec('item add --under @test-core --title "Bulk Test 1" --slug bulk-test-1 --type feature', tempDir);
    kspec('item add --under @test-core --title "Bulk Test 2" --slug bulk-test-2 --type feature', tempDir);

    const jsonl = '{"ref":"@bulk-test-1","data":{"priority":"high"}}\n{"ref":"@bulk-test-2","data":{"priority":"low"}}';
    const result = kspecRun('item patch --bulk --json', tempDir, { stdin: jsonl });

    const parsed = JSON.parse(result.stdout);
    expect(parsed.summary.total).toBe(2);
    expect(parsed.summary.updated).toBe(2);
  });

  // AC: @item-patch ac-8
  it('should patch multiple items from JSON array', () => {
    kspec('item add --under @test-core --title "Array Test 1" --slug array-test-1 --type feature', tempDir);
    kspec('item add --under @test-core --title "Array Test 2" --slug array-test-2 --type feature', tempDir);

    const json = JSON.stringify([
      { ref: '@array-test-1', data: { priority: 'high' } },
      { ref: '@array-test-2', data: { priority: 'low' } }
    ]);
    const result = kspecRun('item patch --bulk --json', tempDir, { stdin: json });

    const parsed = JSON.parse(result.stdout);
    expect(parsed.summary.updated).toBe(2);
  });

  // AC: @item-patch ac-9
  it('should continue on error by default in bulk mode', () => {
    kspec('item add --under @test-core --title "Continue Test" --slug continue-test --type feature', tempDir);

    const jsonl = '{"ref":"@nonexistent","data":{"title":"X"}}\n{"ref":"@continue-test","data":{"priority":"high"}}';
    const result = kspecRun('item patch --bulk --json', tempDir, { stdin: jsonl, expectFail: true });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.summary.failed).toBe(1);
    expect(parsed.summary.updated).toBe(1);
  });

  // AC: @item-patch ac-10
  it('should stop on first error with --fail-fast', () => {
    kspec('item add --under @test-core --title "Failfast Test" --slug failfast-test --type feature', tempDir);

    const jsonl = '{"ref":"@nonexistent","data":{"title":"X"}}\n{"ref":"@failfast-test","data":{"priority":"high"}}';
    const result = kspecRun('item patch --bulk --fail-fast --json', tempDir, { stdin: jsonl, expectFail: true });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.summary.failed).toBe(1);
    expect(parsed.summary.skipped).toBe(1);
    expect(parsed.summary.updated).toBe(0);
  });

  // AC: @item-patch ac-11
  it('should reject task refs', () => {
    const result = kspecRun('item patch @test-task-pending --data \'{"title":"X"}\'', tempDir, { expectFail: true });
    expect(result.stderr).toMatch(/is a task, not a spec item/);
  });

  // AC: @item-patch ac-12
  it('should error on nonexistent ref', () => {
    const result = kspecRun('item patch @nonexistent --data \'{"title":"X"}\'', tempDir, { expectFail: true });
    expect(result.stderr).toMatch(/Item not found/);
  });
});

describe('Integration: derive', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should derive task from spec item', () => {
    const output = kspec('derive @test-feature', tempDir);
    expect(output).toContain('Created');

    // Verify task was created with spec_ref
    const listOutput = kspec('tasks list', tempDir);
    expect(listOutput).toContain('Test Feature');
  });

  it('should show dry-run without creating', () => {
    const output = kspec('derive @test-feature --dry-run', tempDir);
    expect(output).toContain('Would create');

    // Verify no task was actually created
    const listOutput = kspec('tasks list', tempDir);
    expect(listOutput).not.toContain('Implement: Test Feature');
  });

  // AC: @cmd-derive ac-2
  it('should recursively derive tasks for parent and children', () => {
    // test-feature has one child: test-requirement
    const output = kspec('derive @test-feature', tempDir);
    expect(output).toContain('Created 2 task(s)');

    // Verify both tasks were created
    const listOutput = kspec('tasks list', tempDir);
    expect(listOutput).toContain('Test Feature');
    expect(listOutput).toContain('Test Requirement');
  });

  // AC: @cmd-derive ac-3
  it('should only derive single item with --flat', () => {
    const output = kspec('derive @test-feature --flat', tempDir);
    expect(output).toContain('Created 1 task(s)');

    // Verify only parent task was created, not child
    const listOutput = kspec('tasks list', tempDir);
    expect(listOutput).toContain('Test Feature');
    expect(listOutput).not.toContain('Test Requirement');
  });

  // AC: @cmd-derive ac-4, ac-5
  it('should set depends_on for child tasks', () => {
    // Derive recursively to create both tasks
    kspec('derive @test-feature', tempDir);

    // Get the child task details
    const taskOutput = kspec('task get @task-test-requirement --json', tempDir);
    const task = JSON.parse(taskOutput);

    // Child task should depend on parent task
    expect(task.depends_on).toContain('@task-test-feature');
  });

  // AC: @cmd-derive ac-6
  it('should use existing parent task for depends_on', () => {
    // First derive just the parent
    kspec('derive @test-feature --flat', tempDir);

    // Then derive the child - should depend on existing parent task
    kspec('derive @test-requirement', tempDir);

    // Get the child task details
    const taskOutput = kspec('task get @task-test-requirement --json', tempDir);
    const task = JSON.parse(taskOutput);

    // Child task should depend on existing parent task
    expect(task.depends_on).toContain('@task-test-feature');
  });

  // AC: @cmd-derive ac-7
  it('should skip existing tasks without --force', () => {
    // First derive
    kspec('derive @test-feature --flat', tempDir);

    // Second derive should skip
    const output = kspec('derive @test-feature --flat', tempDir);
    expect(output).toContain('Skipped');
    expect(output).toContain('task exists');
  });

  // AC: @cmd-derive ac-8
  it('should handle partial derivation (some children have tasks)', () => {
    // Derive the parent flat first
    kspec('derive @test-feature --flat', tempDir);

    // Now recursive derive the whole tree
    const output = kspec('derive @test-feature', tempDir);

    // Should create only the child, skip the parent
    expect(output).toContain('Created 1 task(s)');
    expect(output).toContain('Skipped 1');
  });

  // AC: @cmd-derive ac-10
  it('should show dry-run for recursive derive', () => {
    const output = kspec('derive @test-feature --dry-run', tempDir);
    expect(output).toContain('Would create:');
    expect(output).toContain('Test Feature');
    expect(output).toContain('Test Requirement');
    expect(output).toContain('depends:');
  });

  // AC: @cmd-derive ac-11
  it('should output JSON with correct format', () => {
    const output = kspec('derive @test-feature --dry-run --json', tempDir);
    const results = JSON.parse(output);

    expect(results).toHaveLength(2);
    expect(results[0]).toHaveProperty('ulid');
    expect(results[0]).toHaveProperty('slug');
    expect(results[0]).toHaveProperty('spec_ref');
    expect(results[0]).toHaveProperty('depends_on');
    expect(results[0]).toHaveProperty('action');

    // First item (parent) should have no deps
    expect(results[0].depends_on).toEqual([]);

    // Second item (child) should depend on parent
    expect(results[1].depends_on).toContain('@task-test-feature');
  });

  // AC: @cmd-derive ac-13
  it('should error on invalid reference', () => {
    const result = kspecRun('derive @nonexistent', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  it('should add implementation notes from spec description', () => {
    // test-feature has a description in fixtures
    kspec('derive @test-feature --flat', tempDir);

    // Get the task details
    const taskOutput = kspec('task get @task-test-feature --json', tempDir);
    const task = JSON.parse(taskOutput);

    // Task should have a note with implementation context
    expect(task.notes).toHaveLength(1);
    expect(task.notes[0].content).toContain('Implementation notes (auto-generated from spec)');
    expect(task.notes[0].content).toContain('A test feature for integration testing'); // From description
    expect(task.notes[0].author).toBe('@kspec-derive');
  });

  it('should add implementation notes with acceptance criteria', () => {
    // First add ACs to test-feature
    kspec(
      'item ac add @test-feature --given "spec has ACs" --when "task is derived" --then "ACs are included in notes"',
      tempDir
    );

    // Now derive the task
    kspec('derive @test-feature --flat', tempDir);

    // Get the task details
    const taskOutput = kspec('task get @task-test-feature --json', tempDir);
    const task = JSON.parse(taskOutput);

    // Task note should include AC summary
    expect(task.notes).toHaveLength(1);
    expect(task.notes[0].content).toContain('Acceptance Criteria:');
    expect(task.notes[0].content).toContain('ac-1:');
    expect(task.notes[0].content).toContain('Given spec has ACs');
    expect(task.notes[0].content).toContain('when task is derived');
    expect(task.notes[0].content).toContain('then ACs are included in notes');
  });

  it('should not add empty notes when spec has no description or ACs', () => {
    // Create a minimal spec item with no description
    kspec(
      'item add --under @test-core --title "Minimal Item" --slug minimal-item --type feature',
      tempDir
    );

    // Derive task from it
    kspec('derive @minimal-item', tempDir);

    // Get the task details
    const taskOutput = kspec('task get @task-minimal-item --json', tempDir);
    const task = JSON.parse(taskOutput);

    // Task should have no notes (empty array)
    expect(task.notes).toHaveLength(0);
  });
});

describe('Integration: session', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should show session context', () => {
    const output = kspec('session start', tempDir);
    expect(output).toContain('Session Context');
    expect(output).toContain('Ready to Pick Up');
  });

  // AC: @session-start-hints ac-1
  it('should show Quick Commands with ready tasks', () => {
    const output = kspec('session start', tempDir);
    // Should show Quick Commands section when ready tasks exist
    expect(output).toContain('Quick Commands');
    expect(output).toContain('kspec task start');
  });

  // AC: @session-start-hints ac-2
  it('should show Quick Commands for active task', () => {
    // Start a task
    kspec('task start @test-task-pending', tempDir);

    const output = kspec('session start', tempDir);
    expect(output).toContain('Quick Commands');
    expect(output).toContain('kspec task note');
    expect(output).toContain('kspec task complete');
  });
});

describe('Integration: item ac', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should list acceptance criteria (empty)', () => {
    const output = kspec('item ac list @test-feature', tempDir);
    expect(output).toContain('No acceptance criteria');
    expect(output).toContain('0 acceptance criteria');
  });

  it('should add acceptance criterion with auto-generated ID', () => {
    const output = kspec(
      'item ac add @test-feature --given "a test precondition" --when "action is taken" --then "result is achieved"',
      tempDir
    );
    expect(output).toContain('Added acceptance criterion');
    expect(output).toContain('ac-1');

    // Verify it was added
    const listOutput = kspec('item ac list @test-feature', tempDir);
    expect(listOutput).toContain('[ac-1]');
    expect(listOutput).toContain('Given: a test precondition');
    expect(listOutput).toContain('When:  action is taken');
    expect(listOutput).toContain('Then:  result is achieved');
    expect(listOutput).toContain('1 acceptance criteria');
  });

  it('should add acceptance criterion with custom ID', () => {
    kspec(
      'item ac add @test-feature --id my-custom-ac --given "custom given" --when "custom when" --then "custom then"',
      tempDir
    );

    const listOutput = kspec('item ac list @test-feature', tempDir);
    expect(listOutput).toContain('[my-custom-ac]');
  });

  it('should reject duplicate AC ID', () => {
    kspec(
      'item ac add @test-feature --id unique-ac --given "g" --when "w" --then "t"',
      tempDir
    );

    const result = kspecRun('item ac add @test-feature --id unique-ac --given "g2" --when "w2" --then "t2"', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  it('should reject adding AC to a task', () => {
    const result = kspecRun('item ac add @test-task-pending --given "g" --when "w" --then "t"', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  it('should update acceptance criterion', () => {
    // First add an AC
    kspec(
      'item ac add @test-feature --id ac-to-update --given "original given" --when "original when" --then "original then"',
      tempDir
    );

    // Update it
    const output = kspec(
      'item ac set @test-feature ac-to-update --then "updated then"',
      tempDir
    );
    expect(output).toContain('Updated acceptance criterion');
    expect(output).toContain('ac-to-update');
    expect(output).toContain('(then)');

    // Verify the update
    const listOutput = kspec('item ac list @test-feature', tempDir);
    expect(listOutput).toContain('Then:  updated then');
  });

  it('should reject updating nonexistent AC', () => {
    const result = kspecRun('item ac set @test-feature nonexistent-ac --then "new value"', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  it('should remove acceptance criterion', () => {
    // First add an AC
    kspec(
      'item ac add @test-feature --id ac-to-remove --given "g" --when "w" --then "t"',
      tempDir
    );

    // Verify it exists
    let listOutput = kspec('item ac list @test-feature', tempDir);
    expect(listOutput).toContain('[ac-to-remove]');

    // Remove it
    const output = kspec('item ac remove @test-feature ac-to-remove --force', tempDir);
    expect(output).toContain('Removed acceptance criterion');
    expect(output).toContain('ac-to-remove');

    // Verify it's gone
    listOutput = kspec('item ac list @test-feature', tempDir);
    expect(listOutput).not.toContain('[ac-to-remove]');
    expect(listOutput).toContain('0 acceptance criteria');
  });

  it('should reject removing nonexistent AC', () => {
    const result = kspecRun('item ac remove @test-feature nonexistent-ac --force', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  it('should handle YAML special characters correctly', () => {
    // Test that colons and other special chars are properly escaped
    kspec(
      'item ac add @test-feature --given "user has: credentials" --when "they submit: form" --then "result: success message shown"',
      tempDir
    );

    // Should not cause YAML parsing errors
    const listOutput = kspec('item ac list @test-feature', tempDir);
    expect(listOutput).toContain('Given: user has: credentials');
    expect(listOutput).toContain('Then:  result: success message shown');

    // Validation should pass
    const validateOutput = kspec('validate --schema', tempDir);
    expect(validateOutput).toContain('Schema: OK');
  });

  it('should auto-increment AC IDs correctly', () => {
    // Add multiple ACs
    kspec('item ac add @test-feature --given "g1" --when "w1" --then "t1"', tempDir);
    kspec('item ac add @test-feature --given "g2" --when "w2" --then "t2"', tempDir);
    kspec('item ac add @test-feature --given "g3" --when "w3" --then "t3"', tempDir);

    const listOutput = kspec('item ac list @test-feature', tempDir);
    expect(listOutput).toContain('[ac-1]');
    expect(listOutput).toContain('[ac-2]');
    expect(listOutput).toContain('[ac-3]');
    expect(listOutput).toContain('3 acceptance criteria');
  });

  it('should return JSON output', () => {
    kspec('item ac add @test-feature --given "g" --when "w" --then "t"', tempDir);

    const acList = kspecJson<Array<{ id: string; given: string; when: string; then: string }>>(
      'item ac list @test-feature',
      tempDir
    );

    expect(Array.isArray(acList)).toBe(true);
    expect(acList.length).toBe(1);
    expect(acList[0].id).toBe('ac-1');
    expect(acList[0].given).toBe('g');
    expect(acList[0].when).toBe('w');
    expect(acList[0].then).toBe('t');
  });
});

describe('Integration: task delete', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cmd-task-delete ac-1
  it('should show dry-run output without deleting', () => {
    // First create a task to delete
    kspec('task add --title "Task to Delete" --slug delete-test', tempDir);

    // Verify task exists
    const before = kspec('tasks list', tempDir);
    expect(before).toContain('Task to Delete');

    // Run dry-run
    const output = kspec('task delete @delete-test --dry-run', tempDir);
    expect(output).toContain('Would delete');
    expect(output).toContain('Task to Delete');

    // Verify task still exists
    const after = kspec('tasks list', tempDir);
    expect(after).toContain('Task to Delete');
  });

  // AC: @cmd-task-delete ac-2
  it('should delete task with --force', () => {
    // First create a task to delete
    kspec('task add --title "Task to Force Delete" --slug force-delete-test', tempDir);

    // Verify task exists
    const before = kspec('tasks list', tempDir);
    expect(before).toContain('Task to Force Delete');

    // Delete with --force
    const output = kspec('task delete @force-delete-test --force', tempDir);
    expect(output).toContain('Deleted task');
    expect(output).toContain('Task to Force Delete');

    // Verify task is gone
    const after = kspec('tasks list', tempDir);
    expect(after).not.toContain('Task to Force Delete');
  });

  it('should reject deleting nonexistent task', () => {
    const result = kspecRun('task delete @nonexistent-task --force', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });
});

describe('Integration: derive hints', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @item-derive-hint ac-1
  it('should show derive hint after item add', () => {
    const output = kspec(
      'item add --under @test-core --title "Hint Test Item" --slug hint-test --type feature',
      tempDir
    );
    expect(output).toContain('Created item');
    expect(output).toContain('Derive implementation task? kspec derive @hint-test');
  });

  // AC: @item-derive-hint ac-2
  it('should show derive hint after item set', () => {
    // First create an item
    kspec('item add --under @test-core --title "Set Hint Test" --slug set-hint --type feature', tempDir);

    // Update it
    const output = kspec('item set @set-hint --description "Updated description"', tempDir);
    expect(output).toContain('Updated item');
    expect(output).toContain('Derive implementation task? kspec derive @set-hint');
  });

  it('should not show derive hint in JSON mode', () => {
    const output = kspec(
      'item add --under @test-core --title "JSON Hint Test" --slug json-hint --type feature --json',
      tempDir
    );
    expect(output).not.toContain('Derive implementation task?');
    // Should be valid JSON
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(true);
  });
});

describe('Integration: alignment guidance', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @alignment-guidance ac-1
  it('should show AC count in alignment guidance for task with spec_ref', () => {
    // Create a spec item with acceptance criteria
    kspec('item add --under @test-core --title "AC Test Spec" --slug ac-test-spec --type requirement', tempDir);
    kspec('item ac add @ac-test-spec --given "precondition" --when "action" --then "result"', tempDir);
    kspec('item ac add @ac-test-spec --given "another" --when "trigger" --then "outcome"', tempDir);

    // Create a task linked to the spec
    kspec('task add --title "Test AC Task" --spec-ref @ac-test-spec --slug ac-test-task', tempDir);
    kspec('task start @ac-test-task', tempDir);

    // Add a note (triggers alignment guidance)
    const output = kspec('task note @ac-test-task "Testing alignment guidance"', tempDir);
    expect(output).toContain('Alignment Check');
    expect(output).toContain('Linked spec has 2 acceptance criteria - consider test coverage');
  });

  it('should show spec context when starting task with spec_ref', () => {
    // Create a spec item with description and acceptance criteria
    kspec('item add --under @test-core --title "Start Context Test" --slug start-context-spec --type requirement', tempDir);
    kspec('item set @start-context-spec --description "Test description for context display"', tempDir);
    kspec('item ac add @start-context-spec --given "initial state" --when "action occurs" --then "expected result"', tempDir);

    // Create a task linked to the spec
    kspec('task add --title "Test Start Context" --spec-ref @start-context-spec --slug start-context-task', tempDir);

    // Start the task and check for spec context
    const output = kspec('task start @start-context-task', tempDir);
    expect(output).toContain('Spec Context');
    expect(output).toContain('Implementing: Start Context Test');
    expect(output).toContain('Test description for context display');
    expect(output).toContain('Acceptance Criteria (1)');
    expect(output).toContain('[ac-1]');
    expect(output).toContain('Given: initial state');
    expect(output).toContain('When: action occurs');
    expect(output).toContain('Then: expected result');
    expect(output).toContain('Add test coverage for each AC');
  });

  it('should not show spec context when starting task without spec_ref', () => {
    // Create a task without spec_ref
    kspec('task add --title "No Spec Task" --slug no-spec-task', tempDir);

    const output = kspec('task start @no-spec-task', tempDir);
    expect(output).not.toContain('Spec Context');
    expect(output).toContain('Started task');
  });

  it('should suppress spec context in JSON mode', () => {
    // Create a spec item with ACs
    kspec('item add --under @test-core --title "JSON Mode Spec" --slug json-mode-spec --type requirement', tempDir);
    kspec('item ac add @json-mode-spec --given "state" --when "action" --then "result"', tempDir);

    // Create a task linked to the spec
    kspec('task add --title "JSON Mode Task" --spec-ref @json-mode-spec --slug json-mode-task', tempDir);

    // Start in JSON mode
    const output = kspec('task start @json-mode-task --json', tempDir);
    expect(output).not.toContain('Spec Context');

    // Should be valid JSON
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(true);
    expect(parsed.task).toBeDefined();
  });
});

describe('Integration: commit guidance', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @commit-guidance ac-1
  it('should show commit guidance with spec_ref after task complete', () => {
    // Create a spec item
    kspec('item add --under @test-core --title "Commit Test Spec" --slug commit-test-spec --type requirement', tempDir);

    // Create a task linked to the spec
    kspec('task add --title "Test Commit Task" --spec-ref @commit-test-spec --slug commit-test-task', tempDir);
    kspec('task start @commit-test-task', tempDir);
    kspec('task submit @commit-test-task', tempDir);

    const output = kspec('task complete @commit-test-task --reason "Done"', tempDir);
    expect(output).toContain('Suggested Commit');
    expect(output).toContain('Task: @commit-test-task');
    expect(output).toContain('Spec: @commit-test-spec');
  });

  // AC: @commit-guidance ac-2
  it('should warn about spec gap when no spec_ref', () => {
    // Create a task without spec_ref
    kspec('task add --title "Orphan Task" --slug orphan-task', tempDir);
    kspec('task start @orphan-task', tempDir);
    kspec('task submit @orphan-task', tempDir);

    const output = kspec('task complete @orphan-task --reason "Done"', tempDir);
    expect(output).toContain('Suggested Commit');
    expect(output).toContain('Task: @orphan-task');
    expect(output).toContain('no spec_ref');
  });

  // AC: @commit-guidance ac-4
  it('should not show guidance in JSON mode', () => {
    kspec('task add --title "JSON Test Task" --slug json-test-task', tempDir);
    kspec('task start @json-test-task', tempDir);
    kspec('task submit @json-test-task', tempDir);

    const output = kspec('task complete @json-test-task --reason "Done" --json', tempDir);
    expect(output).not.toContain('Suggested Commit');
    // Should be valid JSON
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(true);
  });
});

describe('Integration: item notes', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should add a note to a spec item', () => {
    const output = kspec('item note @test-core "Test note for spec item"', tempDir);
    expect(output).toContain('Added note');

    // Verify note was added
    const notesOutput = kspec('item notes @test-core', tempDir);
    expect(notesOutput).toContain('Test note for spec item');
  });

  it('should add a note with author', () => {
    const output = kspec('item note @test-core "Note with author" --author "@claude"', tempDir);
    expect(output).toContain('Added note');

    // Verify note has author
    const notesOutput = kspec('item notes @test-core', tempDir);
    expect(notesOutput).toContain('@claude');
    expect(notesOutput).toContain('Note with author');
  });

  it('should list all notes for a spec item', () => {
    // Add multiple notes
    kspec('item note @test-core "First note"', tempDir);
    kspec('item note @test-core "Second note"', tempDir);

    const output = kspec('item notes @test-core', tempDir);
    expect(output).toContain('First note');
    expect(output).toContain('Second note');
  });

  it('should show "No notes" when spec item has no notes', () => {
    // Create a new item
    kspec('item add --under @test-core --title "Test Item" --type feature --slug test-new-item', tempDir);

    const output = kspec('item notes @test-new-item', tempDir);
    expect(output).toContain('No notes');
  });

  it('should output notes as JSON', () => {
    kspec('item note @test-core "JSON test note"', tempDir);

    const output = kspec('item notes @test-core --json', tempDir);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty('_ulid');
    expect(parsed[0]).toHaveProperty('content');
    expect(parsed[0]).toHaveProperty('created_at');
  });
});

describe('Integration: kspec log', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    // Initialize git repo for log tests
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'ignore' });
    // Create initial commit (required for git log to work)
    execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: 'ignore' });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cmd-log ac-5
  it('should error on invalid reference', () => {
    const result = kspecRun('log @nonexistent-ref', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @cmd-log ac-3
  it('should show no commits found message', () => {
    const output = kspec('log @test-task-pending', tempDir);
    expect(output).toContain('No commits found');
  });

  // AC: @cmd-log list-all-tracked
  it('should list all commits with Task: or Spec: trailers when no ref provided', () => {
    // Create commits with Task: and Spec: trailers
    execSync('touch test1.txt', { cwd: tempDir, stdio: 'ignore' });
    execSync('git add test1.txt', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "feat: test feature\n\nTask: @test-task-pending"', {
      cwd: tempDir,
      stdio: 'ignore',
    });
    execSync('touch test2.txt', { cwd: tempDir, stdio: 'ignore' });
    execSync('git add test2.txt', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "feat: another feature\n\nSpec: @test-feature"', {
      cwd: tempDir,
      stdio: 'ignore',
    });

    // Run kspec log without ref
    const output = kspec('log', tempDir);

    // Should show both commits
    expect(output).toContain('test feature');
    expect(output).toContain('another feature');
    expect(output).toContain('2 commit(s) found');
  });

  // AC: @cmd-log list-all-tracked
  it('should respect --limit flag when listing all tracked commits', () => {
    // Create 3 commits with trailers
    for (let i = 0; i < 3; i++) {
      execSync(`touch test-${i}.txt`, { cwd: tempDir, stdio: 'ignore' });
      execSync(`git add test-${i}.txt`, { cwd: tempDir, stdio: 'ignore' });
      execSync(`git commit -m "feat: commit ${i}\n\nTask: @test-task-pending"`, {
        cwd: tempDir,
        stdio: 'ignore',
      });
    }

    // Limit to 2 results
    const output = kspec('log --limit 2', tempDir);

    expect(output).toContain('2 commit(s) found');
  });

  // AC: @cmd-log passthrough-args
  it('should pass through git log arguments after --', () => {
    // Create a commit with Task: trailer
    execSync('touch passthrough-test.txt', { cwd: tempDir, stdio: 'ignore' });
    execSync('git add passthrough-test.txt', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "feat: test feature\n\nTask: @test-task-pending"', {
      cwd: tempDir,
      stdio: 'ignore',
    });

    // Use passthrough arg to show stat
    const output = kspec('log @test-task-pending -- --stat', tempDir);

    // Should contain stat output (file changes)
    expect(output).toContain('changed');
  });

  // AC: @cmd-log passthrough-invalid
  it('should show git error for invalid passthrough arguments', () => {
    // Create a commit with Task: trailer
    execSync('touch invalid-arg-test.txt', { cwd: tempDir, stdio: 'ignore' });
    execSync('git add invalid-arg-test.txt', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "feat: test feature\n\nTask: @test-task-pending"', {
      cwd: tempDir,
      stdio: 'ignore',
    });

    // Try to use invalid git flag
    const result = kspecRun('log @test-task-pending -- --invalid-git-flag', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  it('should show log command help', () => {
    const output = kspec('log --help', tempDir);
    expect(output).toContain('Search git history');
    expect(output).toContain('--spec');
    expect(output).toContain('--task');
    expect(output).toContain('--oneline');
  });

  // AC: @spec-log-empty-repo ac-1
  it('should show friendly message when repo has no commits', () => {
    // Create a fresh repo with no commits
    const emptyTempDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'kspec-test-empty-'));
    try {
      execSync('git init', { cwd: emptyTempDir, stdio: 'ignore' });

      const output = kspec('log', emptyTempDir);
      expect(output).toContain('No commits in repository yet');
      expect(output).not.toContain('fatal');
    } finally {
      fssync.rmSync(emptyTempDir, { recursive: true, force: true });
    }
  });

  // AC: @spec-log-empty-repo ac-2
  it('should show friendly message when repo has no commits and ref is provided', async () => {
    // Create a NEW temp dir with fixtures but NO git commits
    const emptyWithFixtures = await setupTempFixtures();
    try {
      // setupTempFixtures creates git repo and makes one commit, so we need fresh repo
      // Remove .git and reinit without commits
      fssync.rmSync(path.join(emptyWithFixtures, '.git'), { recursive: true, force: true });
      execSync('git init', { cwd: emptyWithFixtures, stdio: 'ignore' });

      const output = kspec('log @test-task-pending', emptyWithFixtures);
      expect(output).toContain('No commits in repository yet');
      expect(output).not.toContain('fatal');
    } finally {
      await cleanupTempDir(emptyWithFixtures);
    }
  });

  // AC: @spec-log-empty-repo ac-3
  it('should differentiate between no commits and no matching commits', () => {
    // This test uses the existing tempDir which has commits
    // When looking for a non-existent ref, should show "No commits found" not "No commits in repository yet"
    const output = kspec('log @test-task-pending', tempDir);
    // Should show "No commits found" because there ARE commits, just none matching
    expect(output).toContain('No commits found');
    expect(output).not.toContain('No commits in repository yet');
  });

  // AC: @spec-log-empty-repo ac-4
  it('should return proper JSON for empty repo', () => {
    const emptyTempDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'kspec-test-empty-'));
    try {
      execSync('git init', { cwd: emptyTempDir, stdio: 'ignore' });

      const output = kspec('log --json', emptyTempDir);
      const parsed = JSON.parse(output);

      expect(parsed).toHaveProperty('commits');
      expect(parsed.commits).toEqual([]);
      expect(parsed).toHaveProperty('message');
      expect(parsed.message).toBe('No commits in repository yet');
    } finally {
      fssync.rmSync(emptyTempDir, { recursive: true, force: true });
    }
  });

  // AC: @spec-log-empty-repo ac-5
  it('should show friendly message with passthrough args in empty repo', async () => {
    const emptyWithFixtures = await setupTempFixtures();
    try {
      // Remove .git and reinit without commits
      fssync.rmSync(path.join(emptyWithFixtures, '.git'), { recursive: true, force: true });
      execSync('git init', { cwd: emptyWithFixtures, stdio: 'ignore' });

      // Use a ref with passthrough args (ref comes before --)
      const output = kspec('log @test-task-pending -- --stat', emptyWithFixtures);
      expect(output).toContain('No commits in repository yet');
      expect(output).not.toContain('fatal');
    } finally {
      await cleanupTempDir(emptyWithFixtures);
    }
  });

  // AC: @spec-log-empty-repo ac-6
  it('should search shadow branch when main is empty but shadow has commits', () => {
    const emptyTempDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'kspec-test-shadow-'));
    try {
      // Create a repo with only shadow branch commits
      execSync('git init', { cwd: emptyTempDir, stdio: 'ignore' });
      execSync('git config user.email "test@test.com"', { cwd: emptyTempDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: emptyTempDir, stdio: 'ignore' });

      // Create an orphan shadow branch with a commit
      execSync('git checkout --orphan kspec-meta', { cwd: emptyTempDir, stdio: 'ignore' });
      fssync.writeFileSync(path.join(emptyTempDir, 'test.txt'), 'test');
      execSync('git add test.txt', { cwd: emptyTempDir, stdio: 'ignore' });
      execSync('git commit -m "test: shadow commit\n\nTask: @test-task"', {
        cwd: emptyTempDir,
        stdio: 'ignore',
      });

      // Switch back to main (which has no commits)
      execSync('git checkout -b main', { cwd: emptyTempDir, stdio: 'ignore' });

      // Should find commits from shadow branch
      const output = kspec('log', emptyTempDir);
      expect(output).toContain('test: shadow commit');
      expect(output).not.toContain('No commits in repository yet');
    } finally {
      fssync.rmSync(emptyTempDir, { recursive: true, force: true });
    }
  });
});

describe('Integration: link commands', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should create a relationship between items', () => {
    const output = kspec('link create @test-core @test-feature --type depends_on', tempDir);
    expect(output).toContain('OK');
    expect(output).toContain('Created relationship');
    expect(output).toContain('depends_on');
  });

  it('should list relationships from an item', () => {
    // Create a relationship first
    kspec('link create @test-feature @test-requirement --type implements', tempDir);

    // List it
    const output = kspec('link list --from @test-feature', tempDir);
    expect(output).toContain('Relationships from @test-feature');
    expect(output).toContain('implements');
    expect(output).toContain('@test-requirement');
  });

  it('should list relationships to an item (reverse lookup)', () => {
    // Create a relationship
    kspec('link create @test-feature @test-requirement --type implements', tempDir);

    // List reverse
    const output = kspec('link list --to @test-requirement', tempDir);
    expect(output).toContain('Relationships to @test-requirement');
    expect(output).toContain('implements');
    expect(output).toContain('@test-feature');
  });

  it('should filter relationships by type', () => {
    // Create different types of relationships
    kspec('link create @test-feature @test-requirement --type implements', tempDir);
    kspec('link create @test-feature @test-core --type depends_on', tempDir);

    // Filter by type
    const output = kspec('link list --from @test-feature --type implements', tempDir);
    expect(output).toContain('implements');
    expect(output).not.toContain('depends_on');
  });

  it('should delete a relationship', () => {
    // Create relationship
    kspec('link create @test-feature @test-requirement --type relates_to', tempDir);

    // Delete it
    const output = kspec('link delete @test-feature @test-requirement --type relates_to', tempDir);
    expect(output).toContain('OK');
    expect(output).toContain('Removed relationship');

    // Verify it's gone
    const listOutput = kspec('link list --from @test-feature', tempDir);
    expect(listOutput).toContain('No relationships found');
  });

  it('should not create duplicate relationships', () => {
    // Create relationship
    kspec('link create @test-feature @test-requirement --type depends_on', tempDir);

    // Try to create again
    const output = kspec('link create @test-feature @test-requirement --type depends_on', tempDir);
    expect(output).toContain('already exists');
  });

  it('should error on invalid relationship type', () => {
    const result = kspecRun('link create @test-feature @test-requirement --type invalid_type', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  it('should error when referencing non-existent item', () => {
    const result = kspecRun('link create @test-feature @nonexistent --type depends_on', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  it('should return JSON with --json flag', () => {
    const result = kspecJson<{ success: boolean; from: string; to: string; type: string }>(
      'link create @test-feature @test-requirement --type depends_on',
      tempDir
    );
    expect(result.success).toBe(true);
    expect(result.from).toBe('@test-feature');
    expect(result.to).toBe('@test-requirement');
    expect(result.type).toBe('depends_on');
  });
});

describe('Integration: status cascade', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @status-cascade ac-1
  it('should prompt to cascade status to children', () => {
    // test-feature has a child requirement
    // Pipe "n" to reject the cascade
    const result = kspecRun('item set @test-feature --status implemented', tempDir, { stdin: 'n' });

    expect(result.stdout).toContain('Update');
    expect(result.stdout).toContain('child item(s) to implemented? [y/n]');
    expect(result.stdout).toContain('Updated item');
  });

  it('should update children when cascade accepted', () => {
    // Get initial status of child
    const beforeChild = kspecJson<{ status?: { implementation?: string } }>(
      'item get @test-requirement',
      tempDir
    );
    const beforeImpl = beforeChild.status?.implementation || 'not_started';

    // Cascade update by piping "y"
    kspecRun('item set @test-feature --status verified', tempDir, { stdin: 'y' });

    // Check child status was updated
    const afterChild = kspecJson<{ status?: { implementation?: string } }>(
      'item get @test-requirement',
      tempDir
    );
    expect(afterChild.status?.implementation).toBe('verified');
    expect(beforeImpl).not.toBe('verified'); // Ensure it changed
  });

  it('should not update children when cascade rejected', () => {
    // Get initial status of child
    const beforeChild = kspecJson<{ status?: { implementation?: string } }>(
      'item get @test-requirement',
      tempDir
    );
    const beforeImpl = beforeChild.status?.implementation || 'not_started';

    // Reject cascade by piping "n"
    kspecRun('item set @test-feature --status implemented', tempDir, { stdin: 'n' });

    // Check child status was NOT updated
    const afterChild = kspecJson<{ status?: { implementation?: string } }>(
      'item get @test-requirement',
      tempDir
    );
    expect(afterChild.status?.implementation).toBe(beforeImpl);
  });

  it('should skip prompt in JSON mode', () => {
    const result = kspecRun('item set @test-feature --status in_progress --json', tempDir);

    // Should not prompt in JSON mode
    expect(result.stdout).not.toContain('child item(s) to');
    expect(result.stdout).not.toContain('[y/n]');

    // Should return valid JSON
    const parsed = JSON.parse(result.stdout);
    expect(parsed.item).toBeDefined();
  });

  it('should handle items with no children', () => {
    // test-requirement has no children
    const result = kspecRun('item set @test-requirement --status implemented', tempDir, { stdin: 'n' });

    // Should not show cascade prompt when no children
    expect(result.stdout).not.toContain('child item(s) to');
    expect(result.stdout).not.toContain('[y/n]');
    expect(result.stdout).toContain('Updated item');
  });
});

describe('Integration: inbox promote', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should use inbox text as description by default', () => {
    // Add an inbox item
    kspec('inbox add "Test idea for a new feature"', tempDir);

    // Get the inbox item
    const inboxItems = kspecJson<Array<{ _ulid: string; text: string }>>('inbox list', tempDir);
    const itemRef = `@${inboxItems[0]._ulid}`;

    // Promote without --description flag
    const promoteOutput = kspecJson<{ task: { _ulid: string; title: string; description?: string } }>(
      `inbox promote ${itemRef} --title "New Feature Task"`,
      tempDir
    );

    // Verify the task was created with inbox text as description
    expect(promoteOutput.task).toBeDefined();
    expect(promoteOutput.task.title).toBe('New Feature Task');
    expect(promoteOutput.task.description).toBe('Test idea for a new feature');
  });

  it('should use custom description when --description flag provided', () => {
    // Add an inbox item
    kspec('inbox add "Original inbox text"', tempDir);

    // Get the inbox item
    const inboxItems = kspecJson<Array<{ _ulid: string }>>('inbox list', tempDir);
    const itemRef = `@${inboxItems[0]._ulid}`;

    // Promote with custom --description
    const promoteOutput = kspecJson<{ task: { _ulid: string; title: string; description?: string } }>(
      `inbox promote ${itemRef} --title "Task Title" --description "Custom description for the task"`,
      tempDir
    );

    // Verify the task was created with custom description
    expect(promoteOutput.task).toBeDefined();
    expect(promoteOutput.task.title).toBe('Task Title');
    expect(promoteOutput.task.description).toBe('Custom description for the task');
    expect(promoteOutput.task.description).not.toBe('Original inbox text');
  });

  it('should handle empty description flag', () => {
    // Add an inbox item
    kspec('inbox add "Inbox item text"', tempDir);

    // Get the inbox item
    const inboxItems = kspecJson<Array<{ _ulid: string }>>('inbox list', tempDir);
    const itemRef = `@${inboxItems[0]._ulid}`;

    // Promote with empty --description (should use empty string, not inbox text)
    const promoteOutput = kspecJson<{ task: { _ulid: string; title: string; description?: string } }>(
      `inbox promote ${itemRef} --title "Empty Desc Task" --description ""`,
      tempDir
    );

    // Verify the task was created with empty description
    expect(promoteOutput.task).toBeDefined();
    expect(promoteOutput.task.title).toBe('Empty Desc Task');
    expect(promoteOutput.task.description).toBe('');
  });
});

// AC: @meta-observe-cmd from-inbox-conversion
describe('Integration: meta observe --from-inbox', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should convert inbox item to observation with default type', () => {
    // Add inbox item
    kspec('inbox add "This should have been an observation"', tempDir);

    // Get inbox item ref
    const inboxItems = kspecJson<Array<{ _ulid: string; text: string }>>('inbox list', tempDir);
    expect(inboxItems.length).toBe(1);
    const itemRef = `@${inboxItems[0]._ulid.substring(0, 8)}`;

    // Convert to observation using --from-inbox
    const result = kspecJson<{ _ulid: string; type: string; content: string }>('meta observe --from-inbox ' + itemRef, tempDir);

    expect(result._ulid).toBeDefined();
    expect(result.type).toBe('idea'); // Default type
    expect(result.content).toBe('This should have been an observation');

    // Verify inbox item was deleted
    const remainingItems = kspecJson<Array<{ _ulid: string }>>('inbox list', tempDir);
    expect(remainingItems.length).toBe(0);
  });

  it('should convert inbox item with explicit type override', () => {
    // Add inbox item
    kspec('inbox add "Found a performance bottleneck"', tempDir);

    // Get inbox item ref
    const inboxItems = kspecJson<Array<{ _ulid: string; text: string }>>('inbox list', tempDir);
    const itemRef = `@${inboxItems[0]._ulid.substring(0, 8)}`;

    // Convert to friction observation with --type override
    const result = kspecJson<{ _ulid: string; type: string; content: string }>('meta observe --from-inbox ' + itemRef + ' --type friction', tempDir);

    expect(result.type).toBe('friction');
    expect(result.content).toBe('Found a performance bottleneck');

    // Verify inbox item was deleted
    const remainingItems = kspecJson<Array<{ _ulid: string }>>('inbox list', tempDir);
    expect(remainingItems.length).toBe(0);
  });

  it('should preserve workflow reference when converting from inbox', () => {
    // Add inbox item
    kspec('inbox add "Workflow specific observation"', tempDir);

    // Get inbox item ref
    const inboxItems = kspecJson<Array<{ _ulid: string }>>('inbox list', tempDir);
    const itemRef = `@${inboxItems[0]._ulid.substring(0, 8)}`;

    // Convert with workflow reference
    const result = kspecJson<{ _ulid: string; type: string; workflow_ref: string | null }>('meta observe --from-inbox ' + itemRef + ' --type success --workflow @some-workflow', tempDir);

    expect(result.type).toBe('success');
    expect(result.workflow_ref).toBe('@some-workflow');
  });

  it('should fail with invalid inbox reference', () => {
    try {
      kspec('meta observe --from-inbox @nonexistent', tempDir);
      expect.fail('Should have thrown error for invalid inbox reference');
    } catch (error) {
      expect(String(error)).toContain('not found');
    }
  });

  it('should fail with invalid type when using --from-inbox', () => {
    // Add inbox item
    kspec('inbox add "Test item"', tempDir);

    // Get inbox item ref
    const inboxItems = kspecJson<Array<{ _ulid: string }>>('inbox list', tempDir);
    const itemRef = `@${inboxItems[0]._ulid.substring(0, 8)}`;

    // Try to convert with invalid type
    try {
      kspec('meta observe --from-inbox ' + itemRef + ' --type invalid', tempDir);
      expect.fail('Should have thrown error for invalid type');
    } catch (error) {
      expect(String(error)).toContain('invalid');
    }
  });
});

describe('Integration: Batch operations', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @multi-ref-batch ac-1 - Basic multi-ref syntax
  it('should support --refs flag with multiple references', () => {
    // Create three tasks and start them
    const task1 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Task 1" --priority 3',
      tempDir
    );
    const task2 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Task 2" --priority 3',
      tempDir
    );
    const task3 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Task 3" --priority 3',
      tempDir
    );

    // Start and submit each task individually
    kspec(`task start @${task1.task._ulid}`, tempDir);
    kspec(`task start @${task2.task._ulid}`, tempDir);
    kspec(`task start @${task3.task._ulid}`, tempDir);
    kspec(`task submit @${task1.task._ulid}`, tempDir);
    kspec(`task submit @${task2.task._ulid}`, tempDir);
    kspec(`task submit @${task3.task._ulid}`, tempDir);

    // Complete all three with --refs
    const result = kspecJson<{
      success: boolean;
      summary: { total: number; succeeded: number; failed: number };
      results: Array<{ ref: string; ulid: string; status: string }>;
    }>(`task complete --refs @${task1.task._ulid} @${task2.task._ulid} @${task3.task._ulid} --reason "Test"`, tempDir);

    // AC: @multi-ref-batch ac-6 - JSON output format
    expect(result.success).toBe(true);
    expect(result.summary.total).toBe(3);
    expect(result.summary.succeeded).toBe(3);
    expect(result.summary.failed).toBe(0);
    expect(result.results).toHaveLength(3);
    expect(result.results[0].status).toBe('success');
    expect(result.results[1].status).toBe('success');
    expect(result.results[2].status).toBe('success');
  });

  // AC: @multi-ref-batch ac-2 - Backward compatibility
  it('should maintain backward compatibility with positional ref', () => {
    // Create and start a task
    const task = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Backward Compat Task" --priority 3',
      tempDir
    );
    kspec(`task start @${task.task._ulid}`, tempDir);

    // Cancel it with positional ref (original syntax)
    const result = kspecJson<{
      success: boolean;
      summary: { total: number; succeeded: number };
    }>(`task cancel @${task.task._ulid}`, tempDir);

    expect(result.success).toBe(true);
    expect(result.summary.total).toBe(1);
    expect(result.summary.succeeded).toBe(1);
  });

  // AC: @multi-ref-batch ac-3 - Mutual exclusion error
  it('should error when both positional ref and --refs are provided', () => {
    const task = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Test Task" --priority 3',
      tempDir
    );
    kspec(`task start @${task.task._ulid}`, tempDir);

    try {
      kspec(`task complete @${task.task._ulid} --refs @${task.task._ulid}`, tempDir);
      expect.fail('Should have thrown error for mutual exclusion');
    } catch (error) {
      expect(String(error)).toContain('Cannot use both positional ref and --refs flag');
    }
  });

  // AC: @multi-ref-batch ac-4 - Partial failure handling
  it('should continue processing after errors and report partial failures', () => {
    // Create two valid tasks
    const task1 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Valid Task 1" --priority 3',
      tempDir
    );
    const task2 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Valid Task 2" --priority 3',
      tempDir
    );

    // Start and submit both tasks
    kspec(`task start @${task1.task._ulid}`, tempDir);
    kspec(`task start @${task2.task._ulid}`, tempDir);
    kspec(`task submit @${task1.task._ulid}`, tempDir);
    kspec(`task submit @${task2.task._ulid}`, tempDir);

    // Complete tasks with one invalid ref in the middle
    const result = kspecJson<{
      success: boolean;
      summary: { total: number; succeeded: number; failed: number };
      results: Array<{ ref: string; status: string; error?: string }>;
    }>(`task complete --refs @${task1.task._ulid} @invalid-ref-12345 @${task2.task._ulid} --reason "Test"`, tempDir);

    // Should have partial success
    expect(result.success).toBe(false);
    expect(result.summary.total).toBe(3);
    expect(result.summary.succeeded).toBe(2);
    expect(result.summary.failed).toBe(1);

    // Check individual results
    expect(result.results[0].status).toBe('success');
    expect(result.results[1].status).toBe('error');
    expect(result.results[1].error).toContain('not found');
    expect(result.results[2].status).toBe('success');
  });

  // AC: @multi-ref-batch ac-7 - Empty refs error
  it('should error when --refs is provided without values', () => {
    try {
      kspec('task cancel --refs', tempDir);
      expect.fail('Should have thrown error for empty refs');
    } catch (error) {
      // Commander handles this case with "argument missing" error
      expect(String(error)).toContain('argument missing');
    }
  });

  // AC: @multi-ref-batch ac-8 - Ref resolution uses existing logic
  it('should resolve refs using existing resolution logic (slugs, ULID prefixes)', () => {
    // Create two tasks with slugs
    const task1 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Slug Test 1" --slug test-slug-1 --priority 3',
      tempDir
    );
    const task2 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Slug Test 2" --slug test-slug-2 --priority 3',
      tempDir
    );

    const ulid1 = task1.task._ulid;
    const ulid2 = task2.task._ulid;
    const shortUlid1 = ulid1.slice(0, 8);
    const shortUlid2 = ulid2.slice(0, 8);

    // Start and submit both tasks
    kspec(`task start @${ulid1}`, tempDir);
    kspec(`task start @${ulid2}`, tempDir);
    kspec(`task submit @${ulid1}`, tempDir);
    kspec(`task submit @${ulid2}`, tempDir);

    // Test slug resolution
    const slugResult = kspecJson<{
      success: boolean;
      results: Array<{ ref: string; status: string }>;
    }>('task complete --refs @test-slug-1 @test-slug-2 --reason "Test"', tempDir);
    expect(slugResult.success).toBe(true);
    expect(slugResult.results[0].status).toBe('success');
    expect(slugResult.results[1].status).toBe('success');

    // Create two more tasks for ULID prefix test
    // Use full ULIDs since short prefixes (8 chars) can be ambiguous when
    // tasks are created in quick succession (ULID first 10 chars are timestamp)
    const task3 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Prefix Test 1" --priority 3',
      tempDir
    );
    const task4 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Prefix Test 2" --priority 3',
      tempDir
    );
    const ulid3 = task3.task._ulid;
    const ulid4 = task4.task._ulid;

    // Start and submit both
    kspec(`task start @${ulid3}`, tempDir);
    kspec(`task start @${ulid4}`, tempDir);
    kspec(`task submit @${ulid3}`, tempDir);
    kspec(`task submit @${ulid4}`, tempDir);

    // Test ULID resolution with full ULIDs (ref resolution still uses the same logic)
    const prefixResult = kspecJson<{
      success: boolean;
      summary: { total: number; succeeded: number; failed: number };
      results: Array<{ ref: string; status: string; error?: string }>;
    }>(`task complete --refs @${ulid3} @${ulid4} --reason "Test"`, tempDir);

    // Full ULIDs should always resolve uniquely
    expect(prefixResult.success).toBe(true);
    expect(prefixResult.summary.succeeded).toBe(2);
    expect(prefixResult.results[0].status).toBe('success');
    expect(prefixResult.results[1].status).toBe('success');
  });

  // Test task complete batch
  it('should batch complete multiple tasks', () => {
    // Create and start three tasks
    const task1 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Complete 1" --priority 3',
      tempDir
    );
    const task2 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Complete 2" --priority 3',
      tempDir
    );
    const task3 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Complete 3" --priority 3',
      tempDir
    );

    kspec(`task start @${task1.task._ulid}`, tempDir);
    kspec(`task start @${task2.task._ulid}`, tempDir);
    kspec(`task start @${task3.task._ulid}`, tempDir);
    kspec(`task submit @${task1.task._ulid}`, tempDir);
    kspec(`task submit @${task2.task._ulid}`, tempDir);
    kspec(`task submit @${task3.task._ulid}`, tempDir);

    // Batch complete
    const result = kspecJson<{
      success: boolean;
      summary: { total: number; succeeded: number };
    }>(`task complete --refs @${task1.task._ulid} @${task2.task._ulid} @${task3.task._ulid} --reason "Batch completed"`, tempDir);

    expect(result.success).toBe(true);
    expect(result.summary.total).toBe(3);
    expect(result.summary.succeeded).toBe(3);
  });

  // Test task cancel batch
  it('should batch cancel multiple tasks', () => {
    // Create and start two tasks
    const task1 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Cancel 1" --priority 3',
      tempDir
    );
    const task2 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Cancel 2" --priority 3',
      tempDir
    );

    kspec(`task start @${task1.task._ulid}`, tempDir);
    kspec(`task start @${task2.task._ulid}`, tempDir);

    // Batch cancel
    const result = kspecJson<{
      success: boolean;
      summary: { total: number; succeeded: number };
    }>(`task cancel --refs @${task1.task._ulid} @${task2.task._ulid}`, tempDir);

    expect(result.success).toBe(true);
    expect(result.summary.total).toBe(2);
    expect(result.summary.succeeded).toBe(2);
  });

  // Test task delete batch
  it('should batch delete multiple tasks', () => {
    // Create three tasks
    const task1 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Delete 1" --priority 3',
      tempDir
    );
    const task2 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Delete 2" --priority 3',
      tempDir
    );
    const task3 = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "Delete 3" --priority 3',
      tempDir
    );

    // Batch delete (requires --force)
    const result = kspecJson<{
      success: boolean;
      summary: { total: number; succeeded: number };
    }>(`task delete --refs @${task1.task._ulid} @${task2.task._ulid} @${task3.task._ulid} --force`, tempDir);

    expect(result.success).toBe(true);
    expect(result.summary.total).toBe(3);
    expect(result.summary.succeeded).toBe(3);
  });
});
