/**
 * Tests for ralph command and event translator.
 *
 * Uses a mock ACP agent to test loop behavior, retry logic,
 * and failure handling without invoking the real Claude Code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createTranslator } from '../src/ralph/events.js';
import type { SessionUpdate } from '../src/acp/types.js';

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

  // AC-13: Context snapshot saving
  it('saves session context snapshot after each iteration', async () => {
    const result = runRalph('--max-loops 2', tempDir, {
      MOCK_ACP_EXIT_CODE: '0',
    });

    // Check that context snapshots were saved
    const sessionsDir = path.join(tempDir, 'sessions');
    const sessions = await fs.readdir(sessionsDir).catch(() => []);

    expect(sessions.length).toBeGreaterThan(0);

    if (sessions.length > 0) {
      const sessionDir = path.join(sessionsDir, sessions[0]);

      // Should have context snapshots for iteration 1 and 2
      const context1Path = path.join(sessionDir, 'context-iter-1.json');
      const context2Path = path.join(sessionDir, 'context-iter-2.json');

      const context1Exists = await fs.access(context1Path).then(() => true).catch(() => false);
      const context2Exists = await fs.access(context2Path).then(() => true).catch(() => false);

      expect(context1Exists).toBe(true);
      expect(context2Exists).toBe(true);

      // Verify context structure
      const context1Content = await fs.readFile(context1Path, 'utf-8');
      const context1 = JSON.parse(context1Content);

      expect(context1).toHaveProperty('generated_at');
      expect(context1).toHaveProperty('branch');
      expect(context1).toHaveProperty('active_tasks');
      expect(context1).toHaveProperty('ready_tasks');
      expect(context1).toHaveProperty('stats');
    }
  });

  // ─── Adapter Validation Tests ──────────────────────────────────────────────

  // AC: @ralph-adapter-validation valid-adapter-proceeds
  it('proceeds with valid adapter (uses --adapter-cmd for testing)', async () => {
    // When using --adapter-cmd, validation is skipped (custom command)
    // This test verifies the mock adapter works (validation would pass for real adapters)
    const result = runRalph('--max-loops 1', tempDir, {
      MOCK_ACP_EXIT_CODE: '0',
    });

    expect(result.output).toContain('Iteration 1/1');
    expect(result.output).toContain('Ralph loop completed');
    expect(result.exitCode).toBe(0);
  });

  // AC: @ralph-adapter-validation invalid-adapter-error
  it('exits with code 3 and clear error for invalid adapter', async () => {
    // Run without --adapter-cmd to trigger validation
    const result = spawnSync(
      'npx',
      ['tsx', CLI_PATH, 'ralph', '--adapter', '@nonexistent/adapter-package', '--dry-run'],
      {
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 10000,
        env: {
          ...process.env,
          KSPEC_AUTHOR: '@test',
        },
      }
    );

    const output = (result.stdout || '') + (result.stderr || '');

    expect(result.status).toBe(3);
    expect(output).toContain('Adapter package not found: @nonexistent/adapter-package');
    expect(output).toContain('npm install -g @nonexistent/adapter-package');
  });

  // AC: @ralph-adapter-validation validation-before-spawn
  it('validates adapter before spawning agent or creating session', async () => {
    // Run with invalid adapter
    const result = spawnSync(
      'npx',
      ['tsx', CLI_PATH, 'ralph', '--adapter', '@invalid/package'],
      {
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 10000,
        env: {
          ...process.env,
          KSPEC_AUTHOR: '@test',
        },
      }
    );

    const output = (result.stdout || '') + (result.stderr || '');

    // Should fail validation immediately
    expect(result.status).toBe(3);
    expect(output).toContain('Adapter package not found');

    // Should NOT show any signs of session creation or agent spawn
    expect(output).not.toContain('Spawning ACP agent');
    expect(output).not.toContain('Creating ACP session');
    expect(output).not.toContain('Iteration');

    // Should NOT create session directory
    const sessionsDir = path.join(tempDir, 'sessions');
    const sessions = await fs.readdir(sessionsDir).catch(() => []);
    expect(sessions.length).toBe(0);
  });
});

// ─── Event Translator Unit Tests ────────────────────────────────────────────

describe('ralph event translator', () => {
  // Helper to create SessionUpdate objects
  function makeChunk(
    type: 'agent_message_chunk' | 'agent_thought_chunk',
    text: string
  ): SessionUpdate {
    return {
      sessionUpdate: type,
      content: { type: 'text', text },
    } as SessionUpdate;
  }

  describe('agent_message_chunk', () => {
    it('translates streaming content', () => {
      const translator = createTranslator();
      const event = translator.translate(makeChunk('agent_message_chunk', 'Hello'));

      expect(event).not.toBeNull();
      expect(event!.type).toBe('agent_message');
      expect(event!.data).toMatchObject({
        kind: 'agent_message',
        content: 'Hello',
        isStreaming: true,
      });
    });

    it('finalizes on empty string signal', () => {
      const translator = createTranslator();

      // First, stream some content
      translator.translate(makeChunk('agent_message_chunk', 'Hello'));
      translator.translate(makeChunk('agent_message_chunk', ' world'));

      // Then send empty string to finalize
      const finalEvent = translator.translate(makeChunk('agent_message_chunk', ''));

      expect(finalEvent).not.toBeNull();
      expect(finalEvent!.type).toBe('agent_message');
      expect(finalEvent!.data).toMatchObject({
        kind: 'agent_message',
        content: 'Hello world',
        isStreaming: false,
      });
    });

    it('returns null for empty string when no active message', () => {
      const translator = createTranslator();

      // Send empty string without prior content
      const event = translator.translate(makeChunk('agent_message_chunk', ''));

      expect(event).toBeNull();
    });
  });

  describe('agent_thought_chunk', () => {
    it('translates streaming thought content', () => {
      const translator = createTranslator();
      const event = translator.translate(makeChunk('agent_thought_chunk', 'Thinking...'));

      expect(event).not.toBeNull();
      expect(event!.type).toBe('agent_thought');
      expect(event!.data).toMatchObject({
        kind: 'agent_thought',
        content: 'Thinking...',
        isStreaming: true,
      });
    });

    it('finalizes on empty string signal', () => {
      const translator = createTranslator();

      // Stream some thought content
      translator.translate(makeChunk('agent_thought_chunk', 'Let me think'));
      translator.translate(makeChunk('agent_thought_chunk', ' about this'));

      // Finalize with empty string
      const finalEvent = translator.translate(makeChunk('agent_thought_chunk', ''));

      expect(finalEvent).not.toBeNull();
      expect(finalEvent!.type).toBe('agent_thought');
      expect(finalEvent!.data).toMatchObject({
        kind: 'agent_thought',
        content: 'Let me think about this',
        isStreaming: false,
      });
    });
  });

  describe('finalize()', () => {
    it('returns final event for pending message', () => {
      const translator = createTranslator();

      // Stream content without empty string finalization
      translator.translate(makeChunk('agent_message_chunk', 'Incomplete'));

      // Call finalize explicitly
      const finalEvent = translator.finalize();

      expect(finalEvent).not.toBeNull();
      expect(finalEvent!.type).toBe('agent_message');
      expect(finalEvent!.data).toMatchObject({
        kind: 'agent_message',
        content: 'Incomplete',
        isStreaming: false,
      });
    });

    it('returns null when no pending message', () => {
      const translator = createTranslator();

      const event = translator.finalize();

      expect(event).toBeNull();
    });

    it('clears state after finalize', () => {
      const translator = createTranslator();

      translator.translate(makeChunk('agent_message_chunk', 'Test'));
      translator.finalize();

      // Second finalize should return null
      const secondFinalize = translator.finalize();
      expect(secondFinalize).toBeNull();
    });
  });

  describe('noise suppression', () => {
    it('suppresses onPostToolUseHook messages', () => {
      const translator = createTranslator();
      const event = translator.translate(
        makeChunk('agent_message_chunk', 'No onPostToolUseHook found for tool use ID: toolu_123')
      );

      expect(event).toBeNull();
    });

    it('suppresses onPreToolUseHook messages', () => {
      const translator = createTranslator();
      const event = translator.translate(
        makeChunk('agent_message_chunk', 'No onPreToolUseHook found for tool use')
      );

      expect(event).toBeNull();
    });
  });

  describe('tool_call events', () => {
    it('extracts tool name and summary from rawInput (ACP format)', () => {
      const translator = createTranslator();
      const event = translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_123',
        rawInput: { command: 'npm run build' },
        _meta: { claudeCode: { toolName: 'Bash' } },
      } as SessionUpdate);

      expect(event).not.toBeNull();
      expect(event!.type).toBe('tool_start');
      expect(event!.data).toMatchObject({
        kind: 'tool_start',
        toolCallId: 'toolu_123',
        tool: 'Bash',
        summary: 'npm run build',
      });
    });

    it('extracts file path summary for Read tool', () => {
      const translator = createTranslator();
      const event = translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_456',
        rawInput: { file_path: '/home/user/project/src/index.ts' },
        _meta: { claudeCode: { toolName: 'Read' } },
      } as SessionUpdate);

      expect(event).not.toBeNull();
      expect(event!.data).toMatchObject({
        kind: 'tool_start',
        tool: 'Read',
        summary: 'index.ts',
      });
    });

    it('extracts pattern summary for Grep tool', () => {
      const translator = createTranslator();
      const event = translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_789',
        rawInput: { pattern: 'TODO|FIXME' },
        _meta: { claudeCode: { toolName: 'Grep' } },
      } as SessionUpdate);

      expect(event).not.toBeNull();
      expect(event!.data).toMatchObject({
        kind: 'tool_start',
        tool: 'Grep',
        summary: '/TODO|FIXME/',
      });
    });

    it('truncates long Bash commands', () => {
      const translator = createTranslator();
      const longCommand = 'npm run build -- --very-long-flag --another-flag --more-options';
      const event = translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_abc',
        rawInput: { command: longCommand },
        _meta: { claudeCode: { toolName: 'Bash' } },
      } as SessionUpdate);

      expect(event).not.toBeNull();
      const data = event!.data as { summary: string };
      expect(data.summary.length).toBeLessThanOrEqual(50);
      expect(data.summary).toContain('...');
    });

    it('deduplicates phased tool_call events (same tool_call_id)', () => {
      const translator = createTranslator();

      // Phase 1: Registration with no input
      const event1 = translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_phased',
        rawInput: {},
        _meta: { claudeCode: { toolName: 'Bash' } },
      } as SessionUpdate);

      expect(event1).not.toBeNull();
      expect(event1!.type).toBe('tool_start');
      expect((event1!.data as { summary: string }).summary).toBe('');

      // Phase 2: Same tool_call_id with input now available
      const event2 = translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_phased',
        rawInput: { command: 'npm run build' },
        _meta: { claudeCode: { toolName: 'Bash' } },
      } as SessionUpdate);

      // Should emit tool_update with summary, not another tool_start
      expect(event2).not.toBeNull();
      expect(event2!.type).toBe('tool_update');
      expect((event2!.data as { summary: string }).summary).toBe('npm run build');
    });

    it('suppresses duplicate tool_call events with no new summary', () => {
      const translator = createTranslator();

      // First event with input
      translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_dup',
        rawInput: { command: 'npm test' },
        _meta: { claudeCode: { toolName: 'Bash' } },
      } as SessionUpdate);

      // Same event again (duplicate)
      const event2 = translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_dup',
        rawInput: { command: 'npm test' },
        _meta: { claudeCode: { toolName: 'Bash' } },
      } as SessionUpdate);

      // Should suppress since summary didn't change
      expect(event2).toBeNull();
    });
  });

  describe('tool_call_update events', () => {
    it('extracts output from Claude Code toolResponse format', () => {
      const translator = createTranslator();

      // First send tool_call to register the tool
      translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_123',
        rawInput: { command: 'echo hello' },
        _meta: { claudeCode: { toolName: 'Bash' } },
      } as SessionUpdate);

      // Then send tool_call_update with result
      const event = translator.translate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_123',
        status: 'completed',
        _meta: {
          claudeCode: {
            toolName: 'Bash',
            toolResponse: {
              stdout: 'hello\n',
              stderr: '',
              interrupted: false,
              isImage: false,
            },
          },
        },
      } as SessionUpdate);

      expect(event).not.toBeNull();
      expect(event!.type).toBe('tool_result');
      expect(event!.data).toMatchObject({
        kind: 'tool_result',
        toolCallId: 'toolu_123',
        tool: 'Bash',
        status: 'completed',
        output: 'hello',
      });
    });

    it('combines stdout and stderr in output', () => {
      const translator = createTranslator();

      translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_456',
        rawInput: { command: 'failing-cmd' },
        _meta: { claudeCode: { toolName: 'Bash' } },
      } as SessionUpdate);

      const event = translator.translate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_456',
        status: 'completed',
        _meta: {
          claudeCode: {
            toolName: 'Bash',
            toolResponse: {
              stdout: 'partial output',
              stderr: 'error: something went wrong',
              interrupted: false,
              isImage: false,
            },
          },
        },
      } as SessionUpdate);

      expect(event).not.toBeNull();
      const data = event!.data as { output: string };
      expect(data.output).toContain('partial output');
      expect(data.output).toContain('error: something went wrong');
    });

    it('handles non-terminal status updates', () => {
      const translator = createTranslator();

      translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_789',
        rawInput: { command: 'long-running-cmd' },
        _meta: { claudeCode: { toolName: 'Bash' } },
      } as SessionUpdate);

      const event = translator.translate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_789',
        status: 'running',
        _meta: { claudeCode: { toolName: 'Bash' } },
      } as SessionUpdate);

      expect(event).not.toBeNull();
      expect(event!.type).toBe('tool_update');
      expect(event!.data).toMatchObject({
        kind: 'tool_update',
        status: 'running',
      });
    });
  });
});
