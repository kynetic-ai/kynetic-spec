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
});
