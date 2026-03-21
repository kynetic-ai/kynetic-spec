/**
 * Daemon Task Routes — Task Data Manager Migration Verification
 *
 * Verifies that daemon task routes use the task data manager for all task I/O
 * instead of direct yaml.ts calls. This ensures the storage abstraction layer
 * is the exclusive interface for task operations.
 *
 * Spec: @task-data-manager
 * Task: @task-migrate-daemon
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES_PATH = path.resolve(
  import.meta.dirname,
  '../packages/daemon/src/routes/tasks.ts',
);
const source = readFileSync(ROUTES_PATH, 'utf8');

describe('Daemon task routes use task data manager', () => {
  // AC: @task-data-manager ac-1
  it('imports taskDataManager from parser index', () => {
    expect(source).toContain('taskDataManager');
    expect(source).toMatch(/import\s*\{[^}]*taskDataManager[^}]*\}\s*from/);
  });

  // AC: @task-data-manager ac-1
  it('does not call saveTask directly', () => {
    // saveTask should not appear as a function call in the source
    // (it may appear in comments, but not as an invocation)
    const lines = source.split('\n');
    const saveTaskCalls = lines.filter(
      (line) =>
        !line.trim().startsWith('*') &&
        !line.trim().startsWith('//') &&
        /\bsaveTask\s*\(/.test(line),
    );
    expect(saveTaskCalls).toEqual([]);
  });

  // AC: @task-data-manager ac-2
  it('uses taskDataManager.listTasks for the list endpoint', () => {
    expect(source).toContain('taskDataManager.listTasks');
  });

  // AC: @task-data-manager ac-3
  it('uses taskDataManager.getTask for task detail and mutations', () => {
    expect(source).toContain('taskDataManager.getTask');
  });

  // AC: @task-data-manager ac-4
  it('uses taskDataManager.mutateTask for state transitions', () => {
    expect(source).toContain('taskDataManager.mutateTask');
  });

  // AC: @task-data-manager ac-4
  it('uses taskDataManager.addNote for the note endpoint', () => {
    expect(source).toContain('taskDataManager.addNote');
  });

  // AC: @task-data-manager ac-1
  it('imports TaskDataManagerError for error handling', () => {
    expect(source).toMatch(/import\s*\{[^}]*TaskDataManagerError[^}]*\}\s*from/);
    expect(source).toContain('instanceof TaskDataManagerError');
  });

  // AC: @task-data-manager ac-1
  it('does not import saveTask from parser', () => {
    // saveTask should not be in the import statement
    const importBlock = source.match(
      /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/\.\.\/parser\/index\.js['"]/,
    );
    expect(importBlock).toBeTruthy();
    const importedNames = importBlock![1];
    expect(importedNames).not.toMatch(/\bsaveTask\b/);
  });

  // Verify mutation routes all go through mutateTask, not direct save
  // AC: @task-data-manager ac-4, ac-6
  it('routes start/submit/complete/block through mutateTask', () => {
    // Count mutateTask calls — should have one for each mutation endpoint
    // (start, submit, complete, block = 4)
    const mutateTaskCalls = source.match(/taskDataManager\.mutateTask\(/g);
    expect(mutateTaskCalls).toBeTruthy();
    expect(mutateTaskCalls!.length).toBe(4);
  });

  // AC: @task-data-manager ac-4
  it('routes note addition through addNote', () => {
    const addNoteCalls = source.match(/taskDataManager\.addNote\(/g);
    expect(addNoteCalls).toBeTruthy();
    expect(addNoteCalls!.length).toBe(1);
  });

  // Verify sessions endpoint still uses loadAllTasks (it needs full task
  // data for ReferenceIndex, which is acceptable since it's a read-only
  // cross-entity query, not a task I/O operation)
  it('sessions endpoint uses loadAllTasks for cross-entity query', () => {
    // loadAllTasks should still be imported (for sessions and syncSpec)
    expect(source).toMatch(/import\s*\{[^}]*loadAllTasks[^}]*\}\s*from/);
  });
});
