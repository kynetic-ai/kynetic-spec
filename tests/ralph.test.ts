/**
 * Tests for ralph command and event translator.
 *
 * Uses a mock ACP agent to test loop behavior, retry logic,
 * and failure handling without invoking the real Claude Code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTranslator } from '../src/ralph/events.js';
import type { SessionUpdate } from '../src/acp/types.js';
import { CLI_PATH, setupTempFixtures, cleanupTempDir } from './helpers/cli';

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
    'node',
    [CLI_PATH, 'ralph', ...args.split(/\s+/), '--adapter-cmd', `node ${MOCK_ACP}`],
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

describe('ralph command', () => {
  let tempDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    stateFile = path.join(tempDir, 'mock-state');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cli-ralph ac-1 - Basic loop execution
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

  // AC: @cli-ralph ac-2 - No ready tasks exit
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

    expect(result.output).toContain('No automation-eligible tasks (ready or in_progress)');
    // Should not attempt multiple iterations
    expect(result.output).not.toContain('Iteration 2/5');
  });

  // AC: @cli-ralph ac-16
  it('only considers automation-eligible tasks, ignoring manual_only and unassessed', async () => {
    // Modify fixtures: mark one task as manual_only (should be ignored)
    // The pending task has no automation field (unassessed) - should also be ignored
    const tasksPath = path.join(tempDir, 'project.tasks.yaml');
    const content = await fs.readFile(tasksPath, 'utf-8');

    // Add automation: manual_only to the pending task
    const modified = content.replace(
      /title: Test pending task\n    type: task\n    status: pending/,
      'title: Test pending task\n    type: task\n    status: pending\n    automation: manual_only'
    );
    await fs.writeFile(tasksPath, modified);

    const result = runRalph('--max-loops 5', tempDir, {
      MOCK_ACP_EXIT_CODE: '0',
    });

    // Should exit with no eligible tasks message (after starting iteration 1)
    expect(result.output).toContain('No automation-eligible tasks (ready or in_progress)');
    // Should not continue to iteration 2 (exits early)
    expect(result.output).not.toContain('Iteration 2/5');
    // Should not show "Completed iteration" since no work was done
    expect(result.output).not.toContain('Completed iteration');
  });

  it('processes automation-eligible tasks when available', async () => {
    // Fixture already has automation: eligible on test-task-pending
    const result = runRalph('--max-loops 1', tempDir, {
      MOCK_ACP_EXIT_CODE: '0',
    });

    // Should process the eligible task
    expect(result.output).toContain('Iteration 1/1');
    expect(result.output).toContain('Completed iteration 1');
  });

  // AC: @cli-ralph ac-20 - Context refresh after pending_review processing
  // NOTE: Full integration test for ac-20 requires a working kspec environment with
  // shadow branch support, which is complex to set up in test fixtures. The fix
  // (re-gathering context after processPendingReviewTasks) is verified through:
  // 1. Code review - the implementation refreshes context when pending_review_tasks.length > 0
  // 2. Manual testing - run ralph with pending_review tasks that block other tasks
  // The behavior can be observed by examining the prompt JSON which uses currentCtx (refreshed)
  // instead of sessionCtx (stale) after pending_review processing.

  // AC: @cli-ralph ac-16, ac-19
  it('exits when in_progress tasks are automation:needs_review', async () => {
    // Create an in_progress task with automation:needs_review
    // This simulates the scenario where all active tasks are marked as needing human review
    const tasksPath = path.join(tempDir, 'project.tasks.yaml');
    const content = await fs.readFile(tasksPath, 'utf-8');

    // Modify the pending task to be in_progress with needs_review
    // Note: fixture has priority between status and automation
    const modified = content
      .replace(/status: pending/, 'status: in_progress')
      .replace(/automation: eligible/, 'automation: needs_review');
    await fs.writeFile(tasksPath, modified);

    const result = runRalph('--max-loops 5', tempDir, {
      MOCK_ACP_EXIT_CODE: '0',
    });

    // Should exit immediately since in_progress task is needs_review (not eligible)
    expect(result.output).toContain('No automation-eligible tasks (ready or in_progress)');
    // Should not continue to iteration 2
    expect(result.output).not.toContain('Iteration 2/5');
  });

  // AC: @cli-ralph ac-6 - Dry run mode
  it('shows prompt without executing in dry-run mode', async () => {
    const result = runRalph('--dry-run', tempDir);

    expect(result.stdout).toContain('DRY RUN');
    expect(result.stdout).toContain('Kspec Automation Session');
    expect(result.stdout).toContain('Task Work Prompt');
    expect(result.stdout).toContain('Reflect Prompt');
    // Should not show completion
    expect(result.stdout).not.toContain('Completed iteration');
  });

  // AC: @ralph-skill-delegation ac-1
  it('includes iteration N/M, session ID, and no-human flag in prompt', async () => {
    const result = runRalph('--dry-run --max-loops 5', tempDir);

    expect(result.stdout).toContain('Iteration:** 1 of 5');
    expect(result.stdout).toMatch(/Session ID:\*\* `[A-Z0-9]{26}`/);
    expect(result.stdout).toContain('Mode:** Automated (no human in the loop)');
  });

  // AC: @ralph-skill-delegation ac-2
  it('does NOT contain step-by-step task work instructions', async () => {
    const result = runRalph('--dry-run', tempDir);

    // Old-style instructions should be gone
    expect(result.stdout).not.toContain('### 1. Check for Open PRs First');
    expect(result.stdout).not.toContain('### 3. Pick or Continue a Task');
    expect(result.stdout).not.toContain('### 4. Do the Work');
    expect(result.stdout).not.toContain('kspec task start @task-ref');
    expect(result.stdout).not.toContain('kspec task note @task-ref');
  });

  // AC: @ralph-skill-delegation ac-3
  it('contains kspec: namespace skill invocations by default', async () => {
    const result = runRalph('--dry-run', tempDir);

    expect(result.stdout).toContain('/kspec:task-work loop');
    expect(result.stdout).toContain('/kspec:reflect loop');
  });

  // AC: @ralph-skill-delegation ac-4
  it('does NOT parse or detect skill invocations from agent output', async () => {
    const result = runRalph('--max-loops 1', tempDir, {
      MOCK_ACP_EXIT_CODE: '0',
      MOCK_ACP_RESPONSE_TEXT: 'I will now run /task-work to complete the task, then use /reflect to document learnings.',
    });

    // Should complete normally without attempting to parse/invoke skills
    expect(result.stdout).toContain('Completed iteration 1');

    // Should NOT show any skill invocation behavior
    expect(result.output).not.toContain('Invoking skill');
    expect(result.output).not.toContain('Detected skill command');
    expect(result.output).not.toContain('Running /task-work');
    expect(result.output).not.toContain('Running /reflect');

    // The text should appear in the output (proving Ralph doesn't filter it)
    expect(result.stdout).toContain('I will now run /task-work to complete the task');
  });

  // AC: @cli-ralph ac-7 - Retry on error
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

  // AC: @cli-ralph ac-8 - Consecutive failure guard
  // Timeout increased because wrap-up agent runs on max_failures exit
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
  }, 30000);

  it('resets failure count on success', async () => {
    // For simplicity, just verify a success resets the pattern
    const result = runRalph('--max-loops 2 --max-retries 0', tempDir, {
      MOCK_ACP_EXIT_CODE: '0',
    });

    expect(result.output).toContain('Completed iteration 1');
    expect(result.output).toContain('Completed iteration 2');
    expect(result.output).not.toContain('consecutive failures');
  });

  // AC: @cli-ralph ac-9 - Adapter selection
  it('uses specified adapter', async () => {
    const result = runRalph('--dry-run --adapter custom --adapter-cmd "echo test"', tempDir);

    // Dry run should show the adapter being used
    expect(result.stdout).toContain('adapter=custom');
  });

  // AC: @cli-ralph ac-9 - Default adapter
  it('uses claude-agent-acp as default adapter', async () => {
    // Use kspec directly (not runRalph) because runRalph always adds --adapter-cmd
    // which internally sets adapter to "custom", masking the default
    const result = spawnSync(
      'node',
      [CLI_PATH, 'ralph', '--dry-run'],
      {
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, KSPEC_AUTHOR: '@test' },
      }
    );

    // Dry run without --adapter should show the default adapter
    expect(result.stdout).toContain('adapter=claude-agent-acp');
  });

  // AC: @cli-ralph ac-9 - Deprecated adapter alias backwards compatibility
  it('supports deprecated claude-code-acp adapter alias', async () => {
    // Use kspec directly to test explicit deprecated adapter name
    const result = spawnSync(
      'node',
      [CLI_PATH, 'ralph', '--dry-run', '--adapter', 'claude-code-acp'],
      {
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, KSPEC_AUTHOR: '@test' },
      }
    );

    // Deprecated name should still work and show in output
    expect(result.stdout).toContain('adapter=claude-code-acp');
    // Should not fail validation (it's a registered adapter, not ad-hoc)
    expect(result.status).toBe(0);
  });

  // AC: @cli-ralph ac-10 - Session creation
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

  // AC: @cli-ralph ac-11 - Streaming output
  it('displays streaming output from agent', async () => {
    const result = runRalph('--max-loops 1', tempDir, {
      MOCK_ACP_EXIT_CODE: '0',
      MOCK_ACP_RESPONSE_TEXT: 'Streaming test output',
    });

    // The streaming text should appear in output
    expect(result.stdout).toContain('Streaming test output');
  });

  // AC: @cli-ralph ac-12 - Event logging
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

  // AC: @cli-ralph ac-13 - Context snapshot saving
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
      'node',
      [CLI_PATH, 'ralph', '--adapter', '@nonexistent/adapter-package', '--dry-run'],
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
      'node',
      [CLI_PATH, 'ralph', '--adapter', '@invalid/package'],
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
    it('suppresses standalone onPostToolUseHook messages', () => {
      const translator = createTranslator();
      const event = translator.translate(
        makeChunk('agent_message_chunk', 'No onPostToolUseHook found for tool use ID: toolu_01LCkxN6GwoWUfvy7wqwp3sW')
      );

      expect(event).toBeNull();
    });

    it('suppresses standalone onPreToolUseHook messages', () => {
      const translator = createTranslator();
      const event = translator.translate(
        makeChunk('agent_message_chunk', 'No onPreToolUseHook found for tool use')
      );

      expect(event).toBeNull();
    });

    it('strips embedded hook noise while preserving surrounding content', () => {
      const translator = createTranslator();
      // Simulates the observed bug: noise concatenated with agent message
      const event = translator.translate(
        makeChunk('agent_message_chunk', 'Excellent creative brief. Now launching Phase 2...No onPostToolUseHook found for tool use ID: toolu_01LCkxN6GwoWUfvy7wqwp3sW')
      );

      expect(event).not.toBeNull();
      expect(event!.type).toBe('agent_message');
      expect((event!.data as { content: string }).content).toBe('Excellent creative brief. Now launching Phase 2...');
    });

    it('strips multiple noise patterns from same chunk', () => {
      const translator = createTranslator();
      // Realistic pattern: two hook warnings with proper toolu_ format (24 chars after toolu_)
      const event = translator.translate(
        makeChunk('agent_message_chunk', 'Start No onPreToolUseHook found for tool use ID: toolu_01ABC2345678901234567890 middle No onPostToolUseHook found for tool use ID: toolu_01XYZ2345678901234567890 end')
      );

      expect(event).not.toBeNull();
      // Content between/around noise is preserved (with empty space where noise was)
      expect((event!.data as { content: string }).content).toBe('Start  middle  end');
    });

    it('preserves content that directly follows noise without whitespace', () => {
      const translator = createTranslator();
      // Edge case: noise followed immediately by real content with no separator
      // The tool ID pattern matches exactly 26 chars, so 'Hello' won't be consumed
      const event = translator.translate(
        makeChunk('agent_message_chunk', 'No onPostToolUseHook found for tool use ID: toolu_01LCkxN6GwoWUfvy7wqwp3sWHello world')
      );

      expect(event).not.toBeNull();
      // 'Hello world' should be preserved, not eaten by greedy matching
      expect((event!.data as { content: string }).content).toBe('Hello world');
    });

    it('accumulates cleaned content across chunks', () => {
      const translator = createTranslator();

      // Chunk with noise concatenated directly at the end (no space before noise)
      // Tool ID must be exactly 24 chars after toolu_
      translator.translate(
        makeChunk('agent_message_chunk', 'First part.No onPostToolUseHook found for tool use ID: toolu_01XYZ2345678901234567890')
      );

      // Clean chunk with leading space
      translator.translate(
        makeChunk('agent_message_chunk', ' Second part.')
      );

      // Finalize
      const final = translator.translate(makeChunk('agent_message_chunk', ''));

      expect(final).not.toBeNull();
      expect((final!.data as { content: string }).content).toBe('First part. Second part.');
    });

    it('strips noise from accumulated content at finalization', () => {
      const translator = createTranslator();

      // Accumulate content that will contain noise when combined
      translator.translate(
        makeChunk('agent_message_chunk', 'Hello ')
      );

      // Noise arrives in its own chunk
      translator.translate(
        makeChunk('agent_message_chunk', 'No onPostToolUseHook found for tool use ID: toolu_01LCkxN6GwoWUfvy7wqwp3sW')
      );

      // More content
      translator.translate(
        makeChunk('agent_message_chunk', ' World')
      );

      // Finalize - accumulated content should be cleaned
      const final = translator.translate(makeChunk('agent_message_chunk', ''));

      expect(final).not.toBeNull();
      // Noise stripped from accumulated content at finalization
      expect((final!.data as { content: string }).content).toBe('Hello  World');
    });

    it('handles noise in thought chunks the same way', () => {
      const translator = createTranslator();
      const event = translator.translate(
        makeChunk('agent_thought_chunk', 'Thinking about this...No onPostToolUseHook found for tool use ID: toolu_01LCkxN6GwoWUfvy7wqwp3sW')
      );

      expect(event).not.toBeNull();
      expect(event!.type).toBe('agent_thought');
      expect((event!.data as { content: string }).content).toBe('Thinking about this...');
    });

    it('preserves whitespace-only chunks that are not noise', () => {
      const translator = createTranslator();

      // Whitespace-only chunks can be legitimate streaming tokens (formatting, newlines)
      const spaceEvent = translator.translate(makeChunk('agent_message_chunk', ' '));
      expect(spaceEvent).not.toBeNull();
      expect((spaceEvent!.data as { content: string }).content).toBe(' ');

      // Reset translator for thought chunk test
      const thoughtTranslator = createTranslator();
      const newlineEvent = thoughtTranslator.translate(makeChunk('agent_thought_chunk', '\n'));
      expect(newlineEvent).not.toBeNull();
      expect((newlineEvent!.data as { content: string }).content).toBe('\n');
    });

    it('preserves whitespace in accumulated content with noise stripped', () => {
      const translator = createTranslator();

      // First chunk with noise embedded
      translator.translate(
        makeChunk('agent_message_chunk', 'Hello')
      );

      // Whitespace chunk
      translator.translate(
        makeChunk('agent_message_chunk', ' ')
      );

      // More content
      translator.translate(
        makeChunk('agent_message_chunk', 'World')
      );

      // Finalize
      const final = translator.translate(makeChunk('agent_message_chunk', ''));

      expect(final).not.toBeNull();
      expect((final!.data as { content: string }).content).toBe('Hello World');
    });

    // ─── Split-Chunk Boundary Tests ─────────────────────────────────────────────
    // AC: @01KHASR8 - noise patterns split across chunk boundaries

    it('buffers and suppresses noise split at "No onPostToolUse" / "Hook found..."', () => {
      const translator = createTranslator();

      // First chunk: real content followed by partial noise
      const event1 = translator.translate(
        makeChunk('agent_message_chunk', 'Real content. No onPostToolUse')
      );

      // Should emit real content, buffer the partial noise
      expect(event1).not.toBeNull();
      expect((event1!.data as { content: string }).content).toBe('Real content. ');

      // Second chunk: rest of noise pattern
      const event2 = translator.translate(
        makeChunk('agent_message_chunk', 'Hook found for tool use ID: toolu_01ABC2345678901234567890')
      );

      // Should suppress - the combined content matches full noise pattern
      expect(event2).toBeNull();

      // Finalize - should return accumulated content without noise
      const final = translator.translate(makeChunk('agent_message_chunk', ''));
      expect(final).not.toBeNull();
      expect((final!.data as { content: string }).content).toBe('Real content. ');
    });

    it('buffers and suppresses noise split at "No on" / "PostToolUseHook found..."', () => {
      const translator = createTranslator();

      // First chunk: partial noise start
      const event1 = translator.translate(
        makeChunk('agent_message_chunk', 'No on')
      );

      // Should buffer, not emit (could be noise)
      expect(event1).toBeNull();

      // Second chunk: rest of noise
      const event2 = translator.translate(
        makeChunk('agent_message_chunk', 'PostToolUseHook found')
      );

      // Should suppress
      expect(event2).toBeNull();

      // Finalize - nothing should remain
      const final = translator.translate(makeChunk('agent_message_chunk', ''));
      expect(final).toBeNull();
    });

    it('buffers and suppresses noise split at tool ID boundary', () => {
      const translator = createTranslator();

      // Full noise up to partial tool ID
      const event1 = translator.translate(
        makeChunk('agent_message_chunk', 'No onPostToolUseHook found for tool use ID: toolu_01ABC234567890')
      );

      // Should buffer - tool ID is incomplete (only 14 chars, need 24)
      expect(event1).toBeNull();

      // Rest of tool ID
      const event2 = translator.translate(
        makeChunk('agent_message_chunk', '1234567890')
      );

      // Should suppress
      expect(event2).toBeNull();

      // Finalize
      const final = translator.translate(makeChunk('agent_message_chunk', ''));
      expect(final).toBeNull();
    });

    it('emits buffered content when next chunk proves it is not noise', () => {
      const translator = createTranslator();

      // Chunk that could be noise start but isn't
      const event1 = translator.translate(
        makeChunk('agent_message_chunk', 'No on')
      );

      // Should buffer
      expect(event1).toBeNull();

      // Next chunk proves it's not noise (doesn't continue pattern)
      const event2 = translator.translate(
        makeChunk('agent_message_chunk', 'e can deny this.')
      );

      // Should emit combined content
      expect(event2).not.toBeNull();
      expect((event2!.data as { content: string }).content).toBe('No one can deny this.');
    });

    it('handles split noise in thought chunks', () => {
      const translator = createTranslator();

      // First chunk: partial noise
      const event1 = translator.translate(
        makeChunk('agent_thought_chunk', 'Thinking... No onPreToolUseHook')
      );

      expect(event1).not.toBeNull();
      expect((event1!.data as { content: string }).content).toBe('Thinking... ');

      // Second chunk: rest of noise
      const event2 = translator.translate(
        makeChunk('agent_thought_chunk', ' found')
      );

      expect(event2).toBeNull();

      // Finalize
      const final = translator.translate(makeChunk('agent_thought_chunk', ''));
      expect(final).not.toBeNull();
      expect((final!.data as { content: string }).content).toBe('Thinking... ');
    });

    it('handles multiple split noise patterns in sequence', () => {
      const translator = createTranslator();

      // Real content
      translator.translate(makeChunk('agent_message_chunk', 'Start. '));

      // First noise split
      translator.translate(makeChunk('agent_message_chunk', 'No onPostToolUseHook'));
      translator.translate(makeChunk('agent_message_chunk', ' found'));

      // More content
      translator.translate(makeChunk('agent_message_chunk', ' Middle. '));

      // Second noise split
      translator.translate(makeChunk('agent_message_chunk', 'No onPreToolUseHook found for tool use ID: toolu_'));
      translator.translate(makeChunk('agent_message_chunk', '01ABC2345678901234567890'));

      // End content
      translator.translate(makeChunk('agent_message_chunk', ' End.'));

      // Finalize
      const final = translator.translate(makeChunk('agent_message_chunk', ''));

      expect(final).not.toBeNull();
      expect((final!.data as { content: string }).content).toBe('Start.  Middle.  End.');
    });

    it('returns null for finalization when only whitespace remains after stripping split noise', () => {
      const translator = createTranslator();

      // Only noise content, split across chunks
      translator.translate(makeChunk('agent_message_chunk', '  No onPostToolUseHook'));
      translator.translate(makeChunk('agent_message_chunk', ' found  '));

      // Finalize - should return null since only whitespace remains
      const final = translator.translate(makeChunk('agent_message_chunk', ''));
      expect(final).toBeNull();
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

    it('handles rawOutput as array of content blocks instead of [object Object]', () => {
      const translator = createTranslator();

      translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_arr1',
        rawInput: { command: 'some-cmd' },
        _meta: { claudeCode: { toolName: 'Bash' } },
      } as SessionUpdate);

      const event = translator.translate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_arr1',
        status: 'completed',
        rawOutput: [
          { type: 'text', text: 'Line one' },
          { type: 'text', text: 'Line two' },
        ],
      } as SessionUpdate);

      expect(event).not.toBeNull();
      const data = event!.data as { output: string };
      expect(data.output).toContain('Line one');
      expect(data.output).toContain('Line two');
      expect(data.output).not.toContain('[object Object]');
    });

    it('handles output field as array of content blocks', () => {
      const translator = createTranslator();

      translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_arr2',
        rawInput: {},
        _meta: { claudeCode: { toolName: 'Read' } },
      } as SessionUpdate);

      const event = translator.translate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_arr2',
        status: 'completed',
        output: [
          { type: 'text', text: 'File content here' },
        ],
      } as SessionUpdate);

      expect(event).not.toBeNull();
      const data = event!.data as { output: string };
      expect(data.output).toBe('File content here');
      expect(data.output).not.toContain('[object Object]');
    });

    it('handles output as plain object via JSON.stringify', () => {
      const translator = createTranslator();

      translator.translate({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_obj1',
        rawInput: {},
        _meta: { claudeCode: { toolName: 'Task' } },
      } as SessionUpdate);

      const event = translator.translate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_obj1',
        status: 'completed',
        rawOutput: { result: 'success', count: 42 },
      } as SessionUpdate);

      expect(event).not.toBeNull();
      const data = event!.data as { output: string };
      expect(data.output).toContain('"result"');
      expect(data.output).toContain('success');
      expect(data.output).not.toContain('[object Object]');
    });
  });
});

// ─── Subagent Module Tests ────────────────────────────────────────────────────

import {
  buildSubagentPrompt,
  DEFAULT_SUBAGENT_PREFIX,
  DEFAULT_SUBAGENT_TIMEOUT,
  SKILL_PR_REVIEW,
  SKILL_REFLECT,
  SKILL_TASK_WORK,
  type SubagentContext,
} from '../src/ralph/subagent.js';
import { createPrefixedRenderer } from '../src/ralph/cli-renderer.js';

describe('subagent module', () => {
  // AC: @ralph-subagent-spawning ac-2, ac-10
  describe('buildSubagentPrompt', () => {
    it('includes task reference in prompt', () => {
      const context: SubagentContext = {
        taskRef: '@task-example',
        taskDetails: { title: 'Example Task', status: 'pending_review' },
        specWithACs: null,
        gitBranch: 'feat/example',
      };

      const prompt = buildSubagentPrompt(context);

      expect(prompt).toContain('@task-example');
      expect(prompt).toContain(`${SKILL_PR_REVIEW} @task-example`);
    });

    it('includes git branch in prompt', () => {
      const context: SubagentContext = {
        taskRef: '@task-example',
        taskDetails: { title: 'Example Task' },
        specWithACs: null,
        gitBranch: 'feat/my-branch',
      };

      const prompt = buildSubagentPrompt(context);

      expect(prompt).toContain('feat/my-branch');
    });

    it('includes task details as JSON', () => {
      const context: SubagentContext = {
        taskRef: '@task-example',
        taskDetails: { title: 'Test Task', priority: 1 },
        specWithACs: null,
        gitBranch: 'main',
      };

      const prompt = buildSubagentPrompt(context);

      expect(prompt).toContain('"title": "Test Task"');
      expect(prompt).toContain('"priority": 1');
    });

    it('includes spec with ACs when provided', () => {
      const context: SubagentContext = {
        taskRef: '@task-example',
        taskDetails: { title: 'Test Task' },
        specWithACs: {
          title: 'Example Spec',
          acceptance_criteria: [
            { id: 'ac-1', given: 'condition', when: 'action', then: 'result' },
          ],
        },
        gitBranch: 'main',
      };

      const prompt = buildSubagentPrompt(context);

      expect(prompt).toContain('Example Spec');
      expect(prompt).toContain('acceptance_criteria');
      expect(prompt).toContain('Verify all ACs have test coverage');
    });

    it('omits spec section when specWithACs is null', () => {
      const context: SubagentContext = {
        taskRef: '@task-example',
        taskDetails: { title: 'Test Task' },
        specWithACs: null,
        gitBranch: 'main',
      };

      const prompt = buildSubagentPrompt(context);

      expect(prompt).not.toContain('Linked Spec with Acceptance Criteria');
    });

    it('instructs subagent to run PR review skill using default constant', () => {
      const context: SubagentContext = {
        taskRef: '@task-my-feature',
        taskDetails: {},
        specWithACs: null,
        gitBranch: 'main',
      };

      const prompt = buildSubagentPrompt(context);

      expect(prompt).toContain(`${SKILL_PR_REVIEW} @task-my-feature`);
    });

    it('accepts custom skill name for PR review', () => {
      const context: SubagentContext = {
        taskRef: '@task-my-feature',
        taskDetails: {},
        specWithACs: null,
        gitBranch: 'main',
      };

      const prompt = buildSubagentPrompt(context, '/my-custom-review');

      expect(prompt).toContain('/my-custom-review @task-my-feature');
      expect(prompt).not.toContain(SKILL_PR_REVIEW);
    });
  });

  describe('constants', () => {
    // AC: @ralph-subagent-spawning ac-9
    it('DEFAULT_SUBAGENT_TIMEOUT is 20 minutes', () => {
      expect(DEFAULT_SUBAGENT_TIMEOUT).toBe(20 * 60 * 1000);
    });

    // AC: @ralph-subagent-spawning ac-11
    it('DEFAULT_SUBAGENT_PREFIX is [REVIEW SUBAGENT]', () => {
      expect(DEFAULT_SUBAGENT_PREFIX).toBe('[REVIEW SUBAGENT]');
    });

    it('skill invocation constants use kspec: namespace by default', () => {
      expect(SKILL_TASK_WORK).toBe('/kspec:task-work');
      expect(SKILL_REFLECT).toBe('/kspec:reflect');
      expect(SKILL_PR_REVIEW).toBe('/kspec:review');
    });
  });

  // AC: @ralph-subagent-spawning ac-11
  describe('createPrefixedRenderer', () => {
    it('does not double prefix for console.log output', () => {
      const renderer = createPrefixedRenderer('[TEST]');

      // Spy on console.log to capture what the wrapper passes to the original
      const logCalls: unknown[][] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logCalls.push(args);
      });

      try {
        renderer.newSection?.('My Section');
      } finally {
        spy.mockRestore();
      }

      // The wrapper should NOT pass the prefix as an extra argument to console.log.
      // The stdout.write wrapper handles prefixing, so console.log should receive
      // only the original arguments (no doubled prefix).
      const allArgs = logCalls.map(args => args.map(String).join(' ')).join('\n');
      expect(allArgs).toContain('My Section');

      // Count prefix occurrences per line - should never appear doubled
      for (const call of logCalls) {
        const line = call.map(String).join(' ');
        const prefixCount = (line.match(/\[TEST\]/g) || []).length;
        expect(prefixCount, `Line has doubled prefix: ${line}`).toBeLessThanOrEqual(1);
      }
    });

    it('does not double prefix for streaming content via stdout.write', () => {
      const renderer = createPrefixedRenderer('[TEST]');

      // Capture process.stdout.write output - this IS used by streaming render events
      const chunks: string[] = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = ((chunk: unknown) => {
        if (typeof chunk === 'string') chunks.push(chunk);
        return true;
      }) as typeof process.stdout.write;

      // Also suppress console.log (vitest intercepts it differently)
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        // Render a streaming agent_message event which goes through stdout.write
        renderer.render({
          timestamp: 0,
          data: {
            kind: 'agent_message',
            content: 'Hello World\n',
            isStreaming: true,
          },
        });
      } finally {
        process.stdout.write = originalWrite;
        logSpy.mockRestore();
      }

      const output = chunks.join('');
      expect(output).toContain('Hello World');
      // Prefix should appear at most once per line
      for (const line of output.split('\n')) {
        const prefixCount = (line.match(/\[TEST\]/g) || []).length;
        expect(prefixCount, `Line has doubled prefix: ${line}`).toBeLessThanOrEqual(1);
      }
    });

    it('creates renderer with render function', () => {
      const renderer = createPrefixedRenderer('[TEST]');

      expect(renderer.render).toBeDefined();
      expect(typeof renderer.render).toBe('function');
    });
  });

  // ─── Explicit Task Scope Tests ──────────────────────────────────────────────
  // AC: @cli-ralph ac-21

  describe('--tasks flag (explicit task scope)', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await setupTempFixtures();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    // AC: @cli-ralph ac-21 - Basic explicit task scope
    it('accepts --tasks flag with task references', async () => {
      const result = runRalph('--dry-run --tasks @test-task-pending', tempDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('explicit-tasks: @test-task-pending');
      expect(result.stdout).toContain('Explicit Task Scope');
    });

    // AC: @cli-ralph ac-21 - Multiple tasks
    it('accepts comma-separated task refs', async () => {
      const result = runRalph('--dry-run --tasks @test-task-pending,@test-task-secondary', tempDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('explicit-tasks: @test-task-pending, @test-task-secondary');
    });

    // AC: @cli-ralph ac-21 - ULID format
    it('accepts ULID format task refs', async () => {
      const result = runRalph('--dry-run --tasks @01KF1645CA45ZT43W2T6HJMVA1', tempDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Explicit Task Scope');
    });

    // AC: @cli-ralph ac-21 - Short ULID format
    it('accepts short ULID format task refs', async () => {
      // Use 01KF1645CA which uniquely identifies test-task-pending
      const result = runRalph('--dry-run --tasks @01KF1645CA', tempDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Explicit Task Scope');
    });

    // AC: @cli-ralph ac-21 - Invalid task ref
    it('errors on invalid task reference', async () => {
      const result = runRalph('--dry-run --tasks @nonexistent-task', tempDir);

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('Cannot resolve task reference');
    });

    // AC: @cli-ralph ac-21 - Prompt includes scope indicator
    it('includes explicit task scope in prompt', async () => {
      const result = runRalph('--dry-run --tasks @test-task-pending', tempDir);

      expect(result.stdout).toContain('Explicit Task Scope');
      expect(result.stdout).toContain('This session is scoped to specific tasks');
      expect(result.stdout).toContain('@test-task-pending');
    });

    // AC: @cli-ralph ac-21 - Mode description updated
    it('updates mode description for explicit scope', async () => {
      const result = runRalph('--dry-run --tasks @test-task-pending', tempDir);

      // Should mention explicit task scope, not automation-eligible
      expect(result.stdout).toContain('explicit task scope');
    });

    // AC: @cli-ralph ac-21 - Session start event includes explicit tasks
    it('logs explicit tasks in session start event', async () => {
      const result = runRalph('--max-loops 1 --tasks @test-task-pending', tempDir, {
        MOCK_ACP_EXIT_CODE: '0',
      });

      // Check events file
      const sessionsDir = path.join(tempDir, 'sessions');
      const sessions = await fs.readdir(sessionsDir).catch(() => []);

      if (sessions.length > 0) {
        const eventsPath = path.join(sessionsDir, sessions[0], 'events.jsonl');
        const events = await fs.readFile(eventsPath, 'utf-8');

        expect(events).toContain('explicitTasks');
        expect(events).toContain('@test-task-pending');
      }
    });

    // AC: @cli-ralph ac-21 - Ignores automation eligibility with explicit scope
    it('includes manual_only tasks when explicitly specified', async () => {
      // test-task-secondary is automation: manual_only
      const result = runRalph('--dry-run --tasks @test-task-secondary', tempDir);

      expect(result.exitCode).toBe(0);
      // Should not fail even though task is manual_only
      expect(result.stdout).toContain('Explicit Task Scope');
      expect(result.stdout).toContain('@test-task-secondary');
    });

    // AC: @cli-ralph ac-21 - Only shows explicitly listed tasks in context
    it('filters context to only include explicit tasks', async () => {
      const result = runRalph('--dry-run --tasks @test-task-pending', tempDir);

      // Context should only show the explicitly listed task
      // The ready_tasks should not include test-task-secondary (even though it's pending)
      expect(result.stdout).toContain('test-task-pending');

      // Parse the JSON context from output to verify filtering
      const contextMatch = result.stdout.match(/## Current State\s+```json\s+([\s\S]*?)\s+```/);
      if (contextMatch) {
        const context = JSON.parse(contextMatch[1]);
        // Ready tasks should only include the explicit task
        const readyRefs = context.ready_tasks.map((t: { ref: string }) => t.ref);
        expect(readyRefs.length).toBeLessThanOrEqual(1);
        // Should not include test-task-secondary
        expect(readyRefs).not.toContain('01KF1645C'); // Short ULID prefix for secondary
      }
    });

    // AC: @cli-ralph ac-21 - Exit when all explicit tasks completed
    it('exits when all explicit tasks are completed', async () => {
      // test-task-completed is already completed
      const result = runRalph('--max-loops 5 --tasks @test-task-completed', tempDir, {
        MOCK_ACP_EXIT_CODE: '0',
      });

      expect(result.output).toContain('All explicit tasks completed or blocked');
      // Should not run multiple iterations
      expect(result.output).not.toContain('Iteration 2/5');
    });

    // AC: @cli-ralph ac-21 - Exit when all explicit tasks blocked
    it('exits when all explicit tasks are blocked', async () => {
      // Modify test-task-pending to be blocked
      const tasksPath = path.join(tempDir, 'project.tasks.yaml');
      const content = await fs.readFile(tasksPath, 'utf-8');
      const modified = content.replace(
        /title: Test pending task\n    type: task\n    status: pending/,
        'title: Test pending task\n    type: task\n    status: blocked'
      );
      await fs.writeFile(tasksPath, modified);

      const result = runRalph('--max-loops 5 --tasks @test-task-pending', tempDir, {
        MOCK_ACP_EXIT_CODE: '0',
      });

      expect(result.output).toContain('All explicit tasks completed or blocked');
    });

    // AC: @cli-ralph ac-21 - Empty --tasks value
    it('errors on empty --tasks value', async () => {
      const result = runRalph('--dry-run --tasks ""', tempDir);

      // Should error or show warning
      expect(result.exitCode).not.toBe(0);
    });

    // AC: @cli-ralph ac-21 - Reference to spec item (not task) should error
    it('errors when --tasks references a spec item instead of task', async () => {
      // Try to use a spec item ref (if any exist in fixtures)
      const result = runRalph('--dry-run --tasks @some-spec-item', tempDir);

      expect(result.exitCode).not.toBe(0);
      // Should mention it's not a task or cannot be resolved
      expect(result.output).toMatch(/cannot resolve|not a task/i);
    });
  });
});
