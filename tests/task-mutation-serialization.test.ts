import { afterEach, describe, expect, it } from 'vitest';
import {
  createNote,
  initContext,
  loadAllTasks,
  mutateTaskAtomically,
} from '../src/parser/index.js';
import { cleanupTempDir, setupTempFixtures } from './helpers/cli.js';

describe('Task Mutation Serialization', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  it('preserves status transition when concurrent note mutation runs on the same task', async () => {
    // AC: @agent-invocation-lifecycle ac-5 - runtime failure notes must not clobber concurrent task state transitions.
    tempDir = await setupTempFixtures();
    const ctx = await initContext(tempDir);
    const tasks = await loadAllTasks(ctx);
    const target = tasks.find((task) => task.slugs.includes('test-task-pending'));

    expect(target).toBeDefined();

    const failNote = createNote('[AGENT-FAIL] simulated failure', '@test');

    await Promise.all([
      mutateTaskAtomically(ctx, target!, async (latestTask) => {
        // Delay increases overlap pressure so both mutators race for the same file lock.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          ...latestTask,
          status: 'in_progress',
          started_at: '2026-03-03T00:00:00.000Z',
        };
      }),
      mutateTaskAtomically(ctx, target!, (latestTask) => ({
        ...latestTask,
        notes: [...latestTask.notes, failNote],
      })),
    ]);

    const refreshed = (await loadAllTasks(ctx)).find((task) => task._ulid === target!._ulid);
    expect(refreshed?.status).toBe('in_progress');
    expect(refreshed?.notes.some((note) => note.content === failNote.content)).toBe(true);
  });

  it('keeps both notes when concurrent note appends target the same task', async () => {
    tempDir = await setupTempFixtures();
    const ctx = await initContext(tempDir);
    const tasks = await loadAllTasks(ctx);
    const target = tasks.find((task) => task.slugs.includes('test-task-pending'));

    expect(target).toBeDefined();

    const noteA = createNote('first concurrent note', '@test');
    const noteB = createNote('second concurrent note', '@test');

    await Promise.all([
      mutateTaskAtomically(ctx, target!, async (latestTask) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          ...latestTask,
          notes: [...latestTask.notes, noteA],
        };
      }),
      mutateTaskAtomically(ctx, target!, (latestTask) => ({
        ...latestTask,
        notes: [...latestTask.notes, noteB],
      })),
    ]);

    const refreshed = (await loadAllTasks(ctx)).find((task) => task._ulid === target!._ulid);
    const contents = refreshed?.notes.map((note) => note.content) ?? [];

    expect(contents).toContain(noteA.content);
    expect(contents).toContain(noteB.content);
  });
});
