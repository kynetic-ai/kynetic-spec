/**
 * Integration tests for kspec CLI commands.
 *
 * Uses fixture files to test end-to-end workflows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const CLI_PATH = path.join(__dirname, '..', 'src', 'cli', 'index.ts');

/**
 * Run a kspec CLI command and return stdout
 */
function kspec(args: string, cwd: string): string {
  const cmd = `npx tsx ${CLI_PATH} ${args}`;
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, KSPEC_AUTHOR: '@test' },
    }).trim();
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    // Return stdout even on error (some commands exit non-zero with valid output)
    if (execError.stdout) return execError.stdout.trim();
    throw new Error(`Command failed: ${cmd}\n${execError.stderr || execError.message}`);
  }
}

/**
 * Run kspec and return JSON output
 */
function kspecJson<T>(args: string, cwd: string): T {
  const output = kspec(`${args} --json`, cwd);
  return JSON.parse(output);
}

/**
 * Copy fixtures to a temp directory for isolated testing
 */
async function setupTempFixtures(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-test-'));

  // Copy all fixture files
  await fs.cp(FIXTURES_DIR, tempDir, { recursive: true });

  return tempDir;
}

/**
 * Clean up temp directory
 */
async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

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
    kspec('task complete @test-task-pending --reason "Done"', tempDir);

    // Now blocked task should be ready
    readyOutput = kspec('tasks ready', tempDir);
    expect(readyOutput).toContain('test-task-blocked');
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
    expect(() => {
      execSync(`npx tsx ${path.join(__dirname, '..', 'src', 'cli', 'index.ts')} task set @test-task-pending --spec-ref @nonexistent`, {
        cwd: tempDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    }).toThrow();
  });

  it('should reject task as spec ref', () => {
    expect(() => {
      execSync(`npx tsx ${path.join(__dirname, '..', 'src', 'cli', 'index.ts')} task set @test-task-pending --spec-ref @test-task-blocked`, {
        cwd: tempDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    }).toThrow();
  });

  it('should update priority', () => {
    kspec('task set @test-task-pending --priority 1', tempDir);

    const task = kspecJson<{ priority: number }>('task get @test-task-pending', tempDir);
    expect(task.priority).toBe(1);
  });

  it('should reject invalid priority', () => {
    expect(() => {
      execSync(`npx tsx ${path.join(__dirname, '..', 'src', 'cli', 'index.ts')} task set @test-task-pending --priority 6`, {
        cwd: tempDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    }).toThrow();
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
    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} task patch @test-task-pending --data 'bad'`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
  });

  // AC: @task-patch ac-3
  it('should error on unknown field by default', () => {
    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} task patch @test-task-pending --data '{"unknown":true}'`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
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
    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} item set @only-slug --remove-slug only-slug`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
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

    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} item patch @json-test --data 'not json'`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
  });

  // AC: @item-patch ac-3
  it('should accept JSON from stdin', () => {
    kspec('item add --under @test-core --title "Stdin Test" --slug stdin-test --type feature', tempDir);

    execSync(
      `echo '{"description":"From stdin"}' | npx tsx ${CLI_PATH} item patch @stdin-test`,
      { cwd: tempDir, encoding: 'utf-8' }
    );

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

    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} item patch @unknown-test --data '{"foobar":"value"}'`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
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

    const jsonl = '{"ref":"@bulk-test-1","data":{"priority":"high"}}\\n{"ref":"@bulk-test-2","data":{"priority":"low"}}';
    const result = execSync(
      `printf '${jsonl}' | npx tsx ${CLI_PATH} item patch --bulk --json`,
      { cwd: tempDir, encoding: 'utf-8' }
    );

    const parsed = JSON.parse(result);
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
    const result = execSync(
      `echo '${json}' | npx tsx ${CLI_PATH} item patch --bulk --json`,
      { cwd: tempDir, encoding: 'utf-8' }
    );

    const parsed = JSON.parse(result);
    expect(parsed.summary.updated).toBe(2);
  });

  // AC: @item-patch ac-9
  it('should continue on error by default in bulk mode', () => {
    kspec('item add --under @test-core --title "Continue Test" --slug continue-test --type feature', tempDir);

    const jsonl = '{"ref":"@nonexistent","data":{"title":"X"}}\\n{"ref":"@continue-test","data":{"priority":"high"}}';
    try {
      const result = execSync(
        `printf '${jsonl}' | npx tsx ${CLI_PATH} item patch --bulk --json`,
        { cwd: tempDir, encoding: 'utf-8' }
      );
      const parsed = JSON.parse(result);
      expect(parsed.summary.failed).toBe(1);
      expect(parsed.summary.updated).toBe(1);
    } catch (error: unknown) {
      // Command exits with 1 when there are failures, but stdout has the result
      const execError = error as { stdout?: string };
      if (execError.stdout) {
        const parsed = JSON.parse(execError.stdout);
        expect(parsed.summary.failed).toBe(1);
        expect(parsed.summary.updated).toBe(1);
      } else {
        throw error;
      }
    }
  });

  // AC: @item-patch ac-10
  it('should stop on first error with --fail-fast', () => {
    kspec('item add --under @test-core --title "Failfast Test" --slug failfast-test --type feature', tempDir);

    const jsonl = '{"ref":"@nonexistent","data":{"title":"X"}}\\n{"ref":"@failfast-test","data":{"priority":"high"}}';
    try {
      execSync(
        `printf '${jsonl}' | npx tsx ${CLI_PATH} item patch --bulk --fail-fast --json`,
        { cwd: tempDir, encoding: 'utf-8' }
      );
    } catch (error: unknown) {
      const execError = error as { stdout?: string };
      if (execError.stdout) {
        const parsed = JSON.parse(execError.stdout);
        expect(parsed.summary.failed).toBe(1);
        expect(parsed.summary.skipped).toBe(1);
        expect(parsed.summary.updated).toBe(0);
      }
    }
  });

  // AC: @item-patch ac-11
  it('should reject task refs', () => {
    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} item patch @test-task-pending --data '{"title":"X"}'`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow(/is a task, not a spec item/);
  });

  // AC: @item-patch ac-12
  it('should error on nonexistent ref', () => {
    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} item patch @nonexistent --data '{"title":"X"}'`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow(/Item not found/);
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
    expect(() => {
      execSync(`npx tsx ${CLI_PATH} derive @nonexistent`, {
        cwd: tempDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }).toThrow();
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

    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} item ac add @test-feature --id unique-ac --given "g2" --when "w2" --then "t2"`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
  });

  it('should reject adding AC to a task', () => {
    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} item ac add @test-task-pending --given "g" --when "w" --then "t"`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
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
    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} item ac set @test-feature nonexistent-ac --then "new value"`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
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
    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} item ac remove @test-feature nonexistent-ac --force`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
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
    expect(output).toContain('Would delete task');
    expect(output).toContain('Task to Delete');
    expect(output).toContain('Source file:');

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
    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} task delete @nonexistent-task --force`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
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

    const output = kspec('task complete @orphan-task --reason "Done"', tempDir);
    expect(output).toContain('Suggested Commit');
    expect(output).toContain('Task: @orphan-task');
    expect(output).toContain('no spec_ref');
  });

  // AC: @commit-guidance ac-4
  it('should not show guidance in JSON mode', () => {
    kspec('task add --title "JSON Test Task" --slug json-test-task', tempDir);
    kspec('task start @json-test-task', tempDir);

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
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cmd-log ac-5
  it('should error on invalid reference', () => {
    expect(() => {
      execSync(`npx tsx ${CLI_PATH} log @nonexistent-ref`, {
        cwd: tempDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }).toThrow();
  });

  // AC: @cmd-log ac-3
  it('should show no commits found message', () => {
    const output = kspec('log @test-task-pending', tempDir);
    expect(output).toContain('No commits found');
  });

  it('should show log command help', () => {
    const output = kspec('log --help', tempDir);
    expect(output).toContain('Search git history');
    expect(output).toContain('--spec');
    expect(output).toContain('--task');
    expect(output).toContain('--oneline');
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
    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} link create @test-feature @test-requirement --type invalid_type`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
  });

  it('should error when referencing non-existent item', () => {
    expect(() => {
      execSync(
        `npx tsx ${CLI_PATH} link create @test-feature @nonexistent --type depends_on`,
        { cwd: tempDir, encoding: 'utf-8', stdio: 'pipe' }
      );
    }).toThrow();
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
    const output = execSync(
      `echo "n" | npx tsx ${CLI_PATH} item set @test-feature --status implemented`,
      { cwd: tempDir, encoding: 'utf-8' }
    );

    expect(output).toContain('Update');
    expect(output).toContain('child item(s) to implemented? [y/n]');
    expect(output).toContain('Updated item');
  });

  it('should update children when cascade accepted', () => {
    // Get initial status of child
    const beforeChild = kspecJson<{ status?: { implementation?: string } }>(
      'item get @test-requirement',
      tempDir
    );
    const beforeImpl = beforeChild.status?.implementation || 'not_started';

    // Cascade update by piping "y"
    execSync(
      `echo "y" | npx tsx ${CLI_PATH} item set @test-feature --status verified`,
      { cwd: tempDir, encoding: 'utf-8' }
    );

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
    execSync(
      `echo "n" | npx tsx ${CLI_PATH} item set @test-feature --status implemented`,
      { cwd: tempDir, encoding: 'utf-8' }
    );

    // Check child status was NOT updated
    const afterChild = kspecJson<{ status?: { implementation?: string } }>(
      'item get @test-requirement',
      tempDir
    );
    expect(afterChild.status?.implementation).toBe(beforeImpl);
  });

  it('should skip prompt in JSON mode', () => {
    const output = execSync(
      `npx tsx ${CLI_PATH} item set @test-feature --status in_progress --json`,
      { cwd: tempDir, encoding: 'utf-8' }
    );

    // Should not prompt in JSON mode
    expect(output).not.toContain('child item(s) to');
    expect(output).not.toContain('[y/n]');

    // Should return valid JSON
    const parsed = JSON.parse(output);
    expect(parsed.item).toBeDefined();
  });

  it('should handle items with no children', () => {
    // test-requirement has no children
    const output = execSync(
      `echo "n" | npx tsx ${CLI_PATH} item set @test-requirement --status implemented`,
      { cwd: tempDir, encoding: 'utf-8' }
    );

    // Should not show cascade prompt when no children
    expect(output).not.toContain('child item(s) to');
    expect(output).not.toContain('[y/n]');
    expect(output).toContain('Updated item');
  });
});
