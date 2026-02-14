/**
 * Tests for ralph wrap-up agent module.
 *
 * AC: @ralph-wrap-up-agent-on-loop-exit
 */
import { describe, it, expect } from 'vitest';
import {
  buildWrapUpContext,
  buildWrapUpPrompt,
  DEFAULT_WRAPUP_TIMEOUT,
  isWrapUpNeeded,
  WRAPUP_AGENT_PREFIX,
  type ExitReason,
  type WrapUpContext,
} from '../src/ralph/wrap-up.js';
import type { GitWorkingTree } from '../src/utils/git.js';

// ─── Helper Functions ─────────────────────────────────────────────────────────

function createCleanWorkingTree(): GitWorkingTree {
  return {
    clean: true,
    staged: [],
    unstaged: [],
    untracked: [],
  };
}

function createDirtyWorkingTree(): GitWorkingTree {
  return {
    clean: false,
    staged: [{ path: 'src/feature.ts', status: 'modified', staged: true }],
    unstaged: [{ path: 'tests/feature.test.ts', status: 'modified', staged: false }],
    untracked: ['temp.log', 'debug.txt'],
  };
}

function createWrapUpContext(overrides: Partial<WrapUpContext> = {}): WrapUpContext {
  return {
    exitReason: 'no_tasks',
    sessionId: '01TEST00000000000000000000',
    iteration: 5,
    maxIterations: 10,
    workingTree: createCleanWorkingTree(),
    inProgressTasks: [],
    pendingReviewTasks: [],
    recentTaskRefs: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('wrap-up agent module', () => {
  describe('constants', () => {
    // AC: @ralph-wrap-up-agent-on-loop-exit ac-5
    it('DEFAULT_WRAPUP_TIMEOUT is 2 minutes', () => {
      expect(DEFAULT_WRAPUP_TIMEOUT).toBe(2 * 60 * 1000);
    });

    it('WRAPUP_AGENT_PREFIX is [WRAP-UP]', () => {
      expect(WRAPUP_AGENT_PREFIX).toBe('[WRAP-UP]');
    });
  });

  describe('isWrapUpNeeded', () => {
    // AC: @ralph-wrap-up-agent-on-loop-exit ac-1
    it('returns needed=true when working tree has uncommitted changes', () => {
      const context = createWrapUpContext({
        workingTree: createDirtyWorkingTree(),
      });

      const result = isWrapUpNeeded(context);

      expect(result.needed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('returns needed=true when there are in-progress tasks', () => {
      const context = createWrapUpContext({
        inProgressTasks: [{ ref: '@task-1', title: 'Task 1' }],
      });

      const result = isWrapUpNeeded(context);

      expect(result.needed).toBe(true);
    });

    it('returns needed=true when exit reason is error AND working tree dirty', () => {
      const context = createWrapUpContext({
        exitReason: 'error',
        errorMessage: 'Something went wrong',
        workingTree: createDirtyWorkingTree(),
      });

      const result = isWrapUpNeeded(context);

      expect(result.needed).toBe(true);
    });

    it('returns needed=false when exit reason is error BUT tree is clean', () => {
      const context = createWrapUpContext({
        exitReason: 'error',
        errorMessage: 'Something went wrong',
        workingTree: createCleanWorkingTree(),
        inProgressTasks: [],
      });

      const result = isWrapUpNeeded(context);

      expect(result.needed).toBe(false);
    });

    it('returns needed=true when exit reason is max_failures AND in-progress tasks', () => {
      const context = createWrapUpContext({
        exitReason: 'max_failures',
        inProgressTasks: [{ ref: '@task-1', title: 'Unfinished work' }],
      });

      const result = isWrapUpNeeded(context);

      expect(result.needed).toBe(true);
    });

    it('returns needed=false when exit reason is max_failures BUT tree clean and no tasks', () => {
      const context = createWrapUpContext({
        exitReason: 'max_failures',
        workingTree: createCleanWorkingTree(),
        inProgressTasks: [],
      });

      const result = isWrapUpNeeded(context);

      expect(result.needed).toBe(false);
    });

    it('returns needed=false with reason when clean exit and clean tree', () => {
      const context = createWrapUpContext({
        exitReason: 'no_tasks',
        workingTree: createCleanWorkingTree(),
        inProgressTasks: [],
      });

      const result = isWrapUpNeeded(context);

      expect(result.needed).toBe(false);
      expect(result.reason).toContain('clean');
    });

    it('returns needed=false for explicit_tasks_done with clean tree', () => {
      const context = createWrapUpContext({
        exitReason: 'explicit_tasks_done',
        workingTree: createCleanWorkingTree(),
        inProgressTasks: [],
      });

      const result = isWrapUpNeeded(context);

      expect(result.needed).toBe(false);
    });
  });

  describe('buildWrapUpPrompt', () => {
    // AC: @ralph-wrap-up-agent-on-loop-exit ac-2
    it('includes session ID in prompt', () => {
      const context = createWrapUpContext({
        sessionId: '01TESTSESSIONID0000000000',
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('01TESTSESSIONID0000000000');
    });

    it('includes iteration info in prompt', () => {
      const context = createWrapUpContext({
        iteration: 7,
        maxIterations: 10,
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('7 of 10');
    });

    it('includes exit reason description for no_tasks', () => {
      const context = createWrapUpContext({
        exitReason: 'no_tasks',
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('No automation-eligible tasks available');
    });

    it('includes exit reason description for end_loop_signal', () => {
      const context = createWrapUpContext({
        exitReason: 'end_loop_signal',
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Agent explicitly requested end of loop');
    });

    it('includes exit reason description for max_iterations', () => {
      const context = createWrapUpContext({
        exitReason: 'max_iterations',
        maxIterations: 20,
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Reached maximum iterations (20)');
    });

    it('includes error message in exit reason description for error', () => {
      const context = createWrapUpContext({
        exitReason: 'error',
        errorMessage: 'Connection timeout',
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Error occurred');
      expect(prompt).toContain('Connection timeout');
    });

    it('includes exit reason description for max_failures', () => {
      const context = createWrapUpContext({
        exitReason: 'max_failures',
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Reached maximum consecutive failures');
    });

    it('includes exit reason description for explicit_tasks_done', () => {
      const context = createWrapUpContext({
        exitReason: 'explicit_tasks_done',
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('All explicitly scoped tasks completed or blocked');
    });

    // AC: @ralph-wrap-up-agent-on-loop-exit ac-2
    it('shows clean working tree message when no changes', () => {
      const context = createWrapUpContext({
        workingTree: createCleanWorkingTree(),
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Working tree is clean');
      expect(prompt).toContain('No uncommitted changes');
    });

    it('lists staged changes when present', () => {
      const context = createWrapUpContext({
        workingTree: {
          clean: false,
          staged: [
            { path: 'src/feature.ts', status: 'modified', staged: true },
            { path: 'src/new.ts', status: 'added', staged: true },
          ],
          unstaged: [],
          untracked: [],
        },
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Staged (2)');
      expect(prompt).toContain('src/feature.ts (modified)');
      expect(prompt).toContain('src/new.ts (added)');
    });

    it('lists unstaged changes when present', () => {
      const context = createWrapUpContext({
        workingTree: {
          clean: false,
          staged: [],
          unstaged: [{ path: 'tests/spec.test.ts', status: 'modified', staged: false }],
          untracked: [],
        },
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Unstaged (1)');
      expect(prompt).toContain('tests/spec.test.ts (modified)');
    });

    it('lists untracked files when present', () => {
      const context = createWrapUpContext({
        workingTree: {
          clean: false,
          staged: [],
          unstaged: [],
          untracked: ['temp.log', 'debug.txt', '.DS_Store'],
        },
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Untracked (3)');
      expect(prompt).toContain('temp.log');
      expect(prompt).toContain('debug.txt');
      expect(prompt).toContain('.DS_Store');
    });

    // AC: @ralph-wrap-up-agent-on-loop-exit ac-4
    it('lists in-progress tasks', () => {
      const context = createWrapUpContext({
        inProgressTasks: [
          { ref: '@task-feature', title: 'Add new feature' },
          { ref: '@task-bugfix', title: 'Fix critical bug' },
        ],
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('In-progress tasks (2)');
      expect(prompt).toContain('@task-feature: Add new feature');
      expect(prompt).toContain('@task-bugfix: Fix critical bug');
    });

    it('lists pending review tasks', () => {
      const context = createWrapUpContext({
        pendingReviewTasks: [{ ref: '@task-review', title: 'Pending PR merge' }],
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Pending review tasks (1)');
      expect(prompt).toContain('@task-review: Pending PR merge');
    });

    it('lists recent task refs', () => {
      const context = createWrapUpContext({
        recentTaskRefs: ['@task-1', '@task-2', '@task-3'],
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Recent task refs worked this session');
      expect(prompt).toContain('@task-1');
      expect(prompt).toContain('@task-2');
      expect(prompt).toContain('@task-3');
    });

    // AC: @ralph-wrap-up-agent-on-loop-exit ac-3
    it('includes instructions for handling uncommitted changes', () => {
      const context = createWrapUpContext({
        workingTree: createDirtyWorkingTree(),
      });

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Handle Uncommitted Changes');
      expect(prompt).toContain('commit');
      expect(prompt).toContain('stash');
      expect(prompt).toContain('CRITICAL');
      expect(prompt).toContain('Do NOT discard any work');
    });

    // AC: @ralph-wrap-up-agent-on-loop-exit ac-4
    it('includes instructions for exit summary', () => {
      const context = createWrapUpContext();

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Exit Summary');
      expect(prompt).toContain('RALPH SESSION EXIT SUMMARY');
      expect(prompt).toContain('Changes handled');
      expect(prompt).toContain('Human attention needed');
    });

    // AC: @ralph-wrap-up-agent-on-loop-exit ac-5
    it('includes timeout warning in prompt', () => {
      const context = createWrapUpContext();

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('2 minutes');
      expect(prompt).toContain('Timeout Warning');
      expect(prompt).toContain('prioritize');
    });

    it('instructs to exit after cleanup', () => {
      const context = createWrapUpContext();

      const prompt = buildWrapUpPrompt(context);

      expect(prompt).toContain('Exit');
      expect(prompt).toContain('Do not start new work');
    });
  });

  describe('buildWrapUpContext', () => {
    it('builds context with all required fields', () => {
      // Note: buildWrapUpContext calls getWorkingTreeStatus internally,
      // so we test the structure of the returned context
      const context = buildWrapUpContext(
        'no_tasks',
        '01TESTSESSION',
        5,
        10,
        [{ ref: '@task-1', title: 'Task 1' }],
        [{ ref: '@task-2', title: 'Task 2' }],
        ['@task-1', '@task-2'],
        process.cwd(),
        undefined
      );

      expect(context.exitReason).toBe('no_tasks');
      expect(context.sessionId).toBe('01TESTSESSION');
      expect(context.iteration).toBe(5);
      expect(context.maxIterations).toBe(10);
      expect(context.inProgressTasks).toHaveLength(1);
      expect(context.pendingReviewTasks).toHaveLength(1);
      expect(context.recentTaskRefs).toHaveLength(2);
      expect(context.workingTree).toBeDefined();
      expect(context.errorMessage).toBeUndefined();
    });

    it('includes error message when provided', () => {
      const context = buildWrapUpContext(
        'error',
        '01TESTSESSION',
        3,
        10,
        [],
        [],
        [],
        process.cwd(),
        'Connection failed'
      );

      expect(context.exitReason).toBe('error');
      expect(context.errorMessage).toBe('Connection failed');
    });
  });

  describe('ExitReason type coverage', () => {
    // Verify all exit reasons are handled in prompt
    const exitReasons: ExitReason[] = [
      'no_tasks',
      'end_loop_signal',
      'max_iterations',
      'error',
      'max_failures',
      'explicit_tasks_done',
    ];

    for (const reason of exitReasons) {
      it(`handles exit reason: ${reason}`, () => {
        const context = createWrapUpContext({
          exitReason: reason,
          errorMessage: reason === 'error' ? 'Test error' : undefined,
        });

        const prompt = buildWrapUpPrompt(context);

        // Each exit reason should have a description in the prompt
        expect(prompt).toContain('Exit Reason');
        expect(prompt.length).toBeGreaterThan(500); // Ensure substantial prompt
      });
    }
  });
});
