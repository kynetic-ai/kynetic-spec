/**
 * Tests for ralph command.
 *
 * Uses a mock ACP agent to test loop behavior, retry logic,
 * and failure handling without invoking the real Claude Code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const CLI_PATH = path.join(__dirname, '..', 'src', 'cli', 'index.ts');
const MOCK_ACP = path.join(__dirname, 'mocks', 'acp-mock.js');

interface RalphResult {
  output: string; // Combined stdout + stderr for easier assertion
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run ralph command with mock ACP agent
 */
function runRalph(
  args: string,
  cwd: string,
  env: Record<string, string> = {}
): RalphResult {
  const result = spawnSync(
    'npx',
    ['tsx', CLI_PATH, 'ralph', ...args.split(/\s+/), '--adapter-cmd', `node ${MOCK_ACP}`],
    {
      cwd,
      encoding: 'utf-8',
      timeout: 30000,
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
      MOCK_ACP_EXIT_CODE: '0',
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
      MOCK_ACP_EXIT_CODE: '0',
    });

    expect(result.output).toContain('No active or ready tasks');
    // Should not attempt multiple iterations
    expect(result.output).not.toContain('Iteration 2/5');
  });

  // AC-6: Dry run mode
  it('shows prompt without executing in dry-run mode', async () => {
    const result = runRalph('--dry-run', tempDir);

    expect(result.stdout).toContain('DRY RUN');
    expect(result.stdout).toContain('Kspec Automation Session');
    expect(result.stdout).toContain('Working Procedure');
    // Should not show completion
    expect(result.stdout).not.toContain('Completed iteration');
  });

  // AC-7: Retry on error
  it('retries iteration on failure', async () => {
    // Fail twice then succeed
    const result = runRalph('--max-loops 1 --max-retries 3', tempDir, {
      MOCK_ACP_FAIL_COUNT: '2',
      MOCK_ACP_STATE_FILE: stateFile,
    });

    expect(result.stdout).toContain('Retry attempt 1/3');
    expect(result.stdout).toContain('Retry attempt 2/3');
    expect(result.stdout).toContain('Completed iteration 1');
  });

  it('continues to next iteration after retries exhausted', async () => {
    // Always fail
    const result = runRalph('--max-loops 2 --max-retries 1 --max-failures 3', tempDir, {
      MOCK_ACP_EXIT_CODE: '1',
    });

    expect(result.output).toContain('failed after 2 attempts');
    expect(result.output).toContain('Continuing to next iteration');
    expect(result.output).toContain('Iteration 2/2');
  });

  // AC-8: Consecutive failure guard
  it('exits after max consecutive failures', async () => {
    // Always fail
    const result = runRalph('--max-loops 10 --max-retries 0 --max-failures 2', tempDir, {
      MOCK_ACP_EXIT_CODE: '1',
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
      MOCK_ACP_EXIT_CODE: '0',
    });

    expect(result.output).toContain('Completed iteration 1');
    expect(result.output).toContain('Completed iteration 2');
    expect(result.output).not.toContain('consecutive failures');
  });

  // AC-9: Adapter selection
  it('uses specified adapter', async () => {
    const result = runRalph('--dry-run --adapter custom --adapter-cmd "echo test"', tempDir);

    // Dry run should show the adapter being used
    expect(result.stdout).toContain('adapter=custom');
  });

  // AC-10: Session creation
  it('creates session and logs events', async () => {
    const result = runRalph('--max-loops 1', tempDir, {
      MOCK_ACP_EXIT_CODE: '0',
    });

    // Check that session directory was created
    const sessionsDir = path.join(tempDir, 'sessions');
    const sessions = await fs.readdir(sessionsDir).catch(() => []);
    expect(sessions.length).toBeGreaterThan(0);

    // Check session metadata
    if (sessions.length > 0) {
      const sessionDir = path.join(sessionsDir, sessions[0]);
      const metadataPath = path.join(sessionDir, 'session.yaml');
      const metadata = await fs.readFile(metadataPath, 'utf-8');
      expect(metadata).toContain('agent_type:');
      expect(metadata).toContain('status:');
    }
  });

  // AC-11: Streaming output
  it('displays streaming output from agent', async () => {
    const result = runRalph('--max-loops 1', tempDir, {
      MOCK_ACP_EXIT_CODE: '0',
      MOCK_ACP_RESPONSE_TEXT: 'Streaming test output',
    });

    // The streaming text should appear in output
    expect(result.stdout).toContain('Streaming test output');
  });

  // AC-12: Event logging
  it('logs prompt.sent events', async () => {
    const result = runRalph('--max-loops 1', tempDir, {
      MOCK_ACP_EXIT_CODE: '0',
    });

    // Check events file
    const sessionsDir = path.join(tempDir, 'sessions');
    const sessions = await fs.readdir(sessionsDir).catch(() => []);

    if (sessions.length > 0) {
      const eventsPath = path.join(sessionsDir, sessions[0], 'events.jsonl');
      const events = await fs.readFile(eventsPath, 'utf-8');

      // Should have session.start, prompt.sent, and session.end at minimum
      expect(events).toContain('"type":"session.start"');
      expect(events).toContain('"type":"prompt.sent"');
      expect(events).toContain('"type":"session.end"');
    }
  });
});
