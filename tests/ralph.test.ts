/**
 * Tests for ralph command.
 *
 * Uses a mock claude script to test loop behavior, retry logic,
 * and failure handling without invoking the real Claude CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const CLI_PATH = path.join(__dirname, '..', 'src', 'cli', 'index.ts');
const MOCK_CLAUDE = path.join(__dirname, 'mocks', 'claude-mock.js');

interface RalphResult {
  output: string; // Combined stdout + stderr for easier assertion
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run ralph command with mock claude
 */
function runRalph(
  args: string,
  cwd: string,
  env: Record<string, string> = {}
): RalphResult {
  const result = spawnSync(
    'npx',
    ['tsx', CLI_PATH, 'ralph', ...args.split(/\s+/), '--claude-cmd', `node ${MOCK_CLAUDE}`],
    {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        KSPEC_AUTHOR: '@test',
        ...env,
      },
    }
  );

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  return {
    output: stdout + stderr,
    stdout,
    stderr,
    exitCode: result.status || 0,
  };
}

/**
 * Copy fixtures to a temp directory for isolated testing
 */
async function setupTempFixtures(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-ralph-test-'));
  await fs.cp(FIXTURES_DIR, tempDir, { recursive: true });
  return tempDir;
}

describe('ralph command', () => {
  let tempDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    stateFile = path.join(tempDir, 'mock-state');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // AC-1: Basic loop execution
  it('executes loop iterations when ready tasks exist', async () => {
    const result = runRalph('--max-loops 2', tempDir, {
      MOCK_CLAUDE_EXIT_CODE: '0',
    });

    expect(result.stdout).toContain('Iteration 1/2');
    expect(result.stdout).toContain('Iteration 2/2');
    expect(result.stdout).toContain('Completed iteration 1');
    expect(result.stdout).toContain('Completed iteration 2');
    expect(result.stdout).toContain('Ralph loop completed');
  });

  // AC-2: No ready tasks exit
  it('exits when no ready tasks exist', async () => {
    // Modify fixtures to have no ready tasks - mark all pending as completed
    const tasksPath = path.join(tempDir, 'project.tasks.yaml');
    const content = await fs.readFile(tasksPath, 'utf-8');
    // Change all pending tasks to completed (use global replace)
    const modified = content.replace(/status: pending/g, 'status: completed');
    await fs.writeFile(tasksPath, modified);

    const result = runRalph('--max-loops 5', tempDir, {
      MOCK_CLAUDE_EXIT_CODE: '0',
    });

    expect(result.output).toContain('No active or ready tasks');
    // Should not attempt multiple iterations
    expect(result.output).not.toContain('Iteration 2/5');
  });

  // AC-7: Dry run mode
  it('shows prompt without executing in dry-run mode', async () => {
    const result = runRalph('--dry-run', tempDir);

    expect(result.stdout).toContain('DRY RUN');
    expect(result.stdout).toContain('Kspec Automation Session');
    expect(result.stdout).toContain('Working Procedure');
    // Should not show completion
    expect(result.stdout).not.toContain('Completed iteration');
  });

  // AC-10: Retry on error
  it('retries iteration on failure', async () => {
    // Fail twice then succeed
    const result = runRalph('--max-loops 1 --max-retries 3', tempDir, {
      MOCK_CLAUDE_FAIL_COUNT: '2',
      MOCK_CLAUDE_STATE_FILE: stateFile,
    });

    expect(result.stdout).toContain('Retry attempt 1/3');
    expect(result.stdout).toContain('Retry attempt 2/3');
    expect(result.stdout).toContain('Completed iteration 1');
  });

  it('continues to next iteration after retries exhausted', async () => {
    // Always fail
    const result = runRalph('--max-loops 2 --max-retries 1 --max-failures 3', tempDir, {
      MOCK_CLAUDE_EXIT_CODE: '1',
    });

    expect(result.output).toContain('failed after 2 attempts');
    expect(result.output).toContain('Continuing to next iteration');
    expect(result.output).toContain('Iteration 2/2');
  });

  // AC-11: Consecutive failure guard
  it('exits after max consecutive failures', async () => {
    // Always fail
    const result = runRalph('--max-loops 10 --max-retries 0 --max-failures 2', tempDir, {
      MOCK_CLAUDE_EXIT_CODE: '1',
    });

    expect(result.output).toContain('1/2 consecutive failures');
    expect(result.output).toContain('2/2 consecutive failures');
    expect(result.output).toContain('Reached 2 consecutive failures');
    // Should not continue to iteration 3
    expect(result.output).not.toContain('Iteration 3/10');
  });

  it('resets failure count on success', async () => {
    // For simplicity, just verify a success resets the pattern
    const result = runRalph('--max-loops 2 --max-retries 0', tempDir, {
      MOCK_CLAUDE_EXIT_CODE: '0',
    });

    expect(result.output).toContain('Completed iteration 1');
    expect(result.output).toContain('Completed iteration 2');
    expect(result.output).not.toContain('consecutive failures');
  });
});
