import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseYaml,
  toYaml,
  createTask,
  createNote,
  findTaskByRef,
  isTaskReady,
  getReadyTasks,
} from '../src/parser/index.js';
import type { Task, TaskInput } from '../src/schema/index.js';

describe('YAML parsing', () => {
  it('should parse YAML to object', () => {
    const yaml = `
title: Test Task
status: pending
priority: 2
`;
    const result = parseYaml<{ title: string; status: string; priority: number }>(yaml);
    expect(result.title).toBe('Test Task');
    expect(result.status).toBe('pending');
    expect(result.priority).toBe(2);
  });

  it('should serialize object to YAML', () => {
    const obj = {
      title: 'Test Task',
      status: 'pending',
      priority: 2,
    };
    const yaml = toYaml(obj);
    expect(yaml).toContain('title: Test Task');
    expect(yaml).toContain('status: pending');
    expect(yaml).toContain('priority: 2');
  });
});

describe('createTask', () => {
  it('should create task with defaults', () => {
    const input: TaskInput = {
      title: 'My task',
    };
    const task = createTask(input);

    expect(task.title).toBe('My task');
    expect(task._ulid).toBeDefined();
    expect(task._ulid.length).toBe(26);
    expect(task.status).toBe('pending');
    expect(task.type).toBe('task');
    expect(task.priority).toBe(3);
    expect(task.notes).toEqual([]);
    expect(task.todos).toEqual([]);
    expect(task.created_at).toBeDefined();
  });

  it('should preserve provided values', () => {
    const input: TaskInput = {
      title: 'Bug fix',
      type: 'bug',
      priority: 1,
      tags: ['urgent'],
    };
    const task = createTask(input);

    expect(task.title).toBe('Bug fix');
    expect(task.type).toBe('bug');
    expect(task.priority).toBe(1);
    expect(task.tags).toEqual(['urgent']);
  });
});

describe('createNote', () => {
  it('should create note with generated fields', () => {
    const note = createNote('Found an issue', '@agent-1');

    expect(note._ulid).toBeDefined();
    expect(note._ulid.length).toBe(26);
    expect(note.content).toBe('Found an issue');
    expect(note.author).toBe('@agent-1');
    expect(note.created_at).toBeDefined();
    expect(note.supersedes).toBeNull();
  });

  it('should set supersedes when provided', () => {
    const previousUlid = '01HQ3K5XJ8MPVB2XCJZ0KE9YWN';
    const note = createNote('Correction', '@agent-2', previousUlid);

    expect(note.supersedes).toBe(previousUlid);
  });
});

describe('findTaskByRef', () => {
  const tasks: Task[] = [
    {
      _ulid: '01HQ3K5XJ8MPVB2XCJZ0KE9YWN',
      slugs: ['impl-login', 'auth-login'],
      title: 'Implement login',
      type: 'task',
      status: 'pending',
      blocked_by: [],
      depends_on: [],
      context: [],
      priority: 2,
      tags: [],
      vcs_refs: [],
      created_at: '2025-01-14T10:00:00Z',
      notes: [],
      todos: [],
    },
    {
      _ulid: '01HQ3K6ABC123456789012345',
      slugs: ['impl-session'],
      title: 'Implement session',
      type: 'task',
      status: 'completed',
      blocked_by: [],
      depends_on: [],
      context: [],
      priority: 3,
      tags: [],
      vcs_refs: [],
      created_at: '2025-01-14T09:00:00Z',
      notes: [],
      todos: [],
    },
  ];

  it('should find task by full ULID', () => {
    const task = findTaskByRef(tasks, '01HQ3K5XJ8MPVB2XCJZ0KE9YWN');
    expect(task?.title).toBe('Implement login');
  });

  it('should find task by short ULID', () => {
    const task = findTaskByRef(tasks, '01HQ3K5');
    expect(task?.title).toBe('Implement login');
  });

  it('should find task by slug', () => {
    const task = findTaskByRef(tasks, 'impl-login');
    expect(task?.title).toBe('Implement login');
  });

  it('should find task by @ prefixed reference', () => {
    const task = findTaskByRef(tasks, '@impl-session');
    expect(task?.title).toBe('Implement session');
  });

  it('should return undefined for non-existent ref', () => {
    const task = findTaskByRef(tasks, 'non-existent');
    expect(task).toBeUndefined();
  });
});

describe('isTaskReady', () => {
  const completedTask: Task = {
    _ulid: '01COMPLETE00000000000000',
    slugs: ['completed-task'],
    title: 'Completed task',
    type: 'task',
    status: 'completed',
    blocked_by: [],
    depends_on: [],
    context: [],
    priority: 3,
    tags: [],
    vcs_refs: [],
    created_at: '2025-01-14T08:00:00Z',
    notes: [],
    todos: [],
  };

  it('should return true for pending task with no deps', () => {
    const task: Task = {
      _ulid: '01PENDING0000000000000000',
      slugs: ['pending-task'],
      title: 'Pending task',
      type: 'task',
      status: 'pending',
      blocked_by: [],
      depends_on: [],
      context: [],
      priority: 3,
      tags: [],
      vcs_refs: [],
      created_at: '2025-01-14T10:00:00Z',
      notes: [],
      todos: [],
    };
    expect(isTaskReady(task, [])).toBe(true);
  });

  it('should return true for pending task with completed deps', () => {
    const task: Task = {
      _ulid: '01PENDING0000000000000000',
      slugs: ['pending-task'],
      title: 'Pending task',
      type: 'task',
      status: 'pending',
      blocked_by: [],
      depends_on: ['@completed-task'],
      context: [],
      priority: 3,
      tags: [],
      vcs_refs: [],
      created_at: '2025-01-14T10:00:00Z',
      notes: [],
      todos: [],
    };
    expect(isTaskReady(task, [completedTask])).toBe(true);
  });

  it('should return false for pending task with incomplete deps', () => {
    const pendingDep: Task = {
      _ulid: '01PENDINGDEP000000000000',
      slugs: ['pending-dep'],
      title: 'Pending dep',
      type: 'task',
      status: 'pending',
      blocked_by: [],
      depends_on: [],
      context: [],
      priority: 3,
      tags: [],
      vcs_refs: [],
      created_at: '2025-01-14T09:00:00Z',
      notes: [],
      todos: [],
    };

    const task: Task = {
      _ulid: '01PENDING0000000000000000',
      slugs: ['pending-task'],
      title: 'Pending task',
      type: 'task',
      status: 'pending',
      blocked_by: [],
      depends_on: ['@pending-dep'],
      context: [],
      priority: 3,
      tags: [],
      vcs_refs: [],
      created_at: '2025-01-14T10:00:00Z',
      notes: [],
      todos: [],
    };

    expect(isTaskReady(task, [pendingDep])).toBe(false);
  });

  it('should return false for blocked task', () => {
    const task: Task = {
      _ulid: '01BLOCKED0000000000000000',
      slugs: ['blocked-task'],
      title: 'Blocked task',
      type: 'task',
      status: 'pending',
      blocked_by: ['Waiting on design'],
      depends_on: [],
      context: [],
      priority: 3,
      tags: [],
      vcs_refs: [],
      created_at: '2025-01-14T10:00:00Z',
      notes: [],
      todos: [],
    };
    expect(isTaskReady(task, [])).toBe(false);
  });

  it('should return false for in_progress task', () => {
    const task: Task = {
      _ulid: '01INPROGRESS0000000000000',
      slugs: ['in-progress-task'],
      title: 'In progress task',
      type: 'task',
      status: 'in_progress',
      blocked_by: [],
      depends_on: [],
      context: [],
      priority: 3,
      tags: [],
      vcs_refs: [],
      created_at: '2025-01-14T10:00:00Z',
      notes: [],
      todos: [],
    };
    expect(isTaskReady(task, [])).toBe(false);
  });
});

describe('getReadyTasks', () => {
  it('should return ready tasks sorted by priority', () => {
    const tasks: Task[] = [
      {
        _ulid: '01TASK100000000000000000',
        slugs: ['low-priority'],
        title: 'Low priority',
        type: 'task',
        status: 'pending',
        blocked_by: [],
        depends_on: [],
        context: [],
        priority: 5,
        tags: [],
        vcs_refs: [],
        created_at: '2025-01-14T10:00:00Z',
        notes: [],
        todos: [],
      },
      {
        _ulid: '01TASK200000000000000000',
        slugs: ['high-priority'],
        title: 'High priority',
        type: 'task',
        status: 'pending',
        blocked_by: [],
        depends_on: [],
        context: [],
        priority: 1,
        tags: [],
        vcs_refs: [],
        created_at: '2025-01-14T10:00:00Z',
        notes: [],
        todos: [],
      },
      {
        _ulid: '01TASK300000000000000000',
        slugs: ['medium-priority'],
        title: 'Medium priority',
        type: 'task',
        status: 'pending',
        blocked_by: [],
        depends_on: [],
        context: [],
        priority: 3,
        tags: [],
        vcs_refs: [],
        created_at: '2025-01-14T10:00:00Z',
        notes: [],
        todos: [],
      },
    ];

    const ready = getReadyTasks(tasks);
    expect(ready).toHaveLength(3);
    expect(ready[0].title).toBe('High priority');
    expect(ready[1].title).toBe('Medium priority');
    expect(ready[2].title).toBe('Low priority');
  });
});
