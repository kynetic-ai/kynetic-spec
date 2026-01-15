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
  extractItemsFromRaw,
  findItemByRef,
  expandIncludePattern,
  initContext,
  loadAllItems,
  ReferenceIndex,
  validateRefs,
  findDuplicateSlugs,
  type LoadedSpecItem,
  type LoadedTask,
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

// ============================================================
// SPEC ITEM LOADING TESTS
// ============================================================

describe('extractItemsFromRaw', () => {
  // ULIDs must be valid Crockford base32 (no I, L, O, U)
  it('should extract a single spec item', () => {
    const raw = {
      _ulid: '01KEZCKA9VTASQW75Q4MBSMB13',
      title: 'Test Item',
      slugs: ['test-item'],
      type: 'feature',
    };

    const items = extractItemsFromRaw(raw, 'test.yaml');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Test Item');
    expect(items[0]._sourceFile).toBe('test.yaml');
  });

  it('should extract nested items from features array', () => {
    const raw = {
      _ulid: '01KEZCKAA29NNMAZCXMG9VTJ34',
      title: 'Parent Module',
      slugs: ['parent'],
      type: 'module',
      features: [
        {
          _ulid: '01KEZCKAA2HM72WSB0SQ24FERQ',
          title: 'Child Feature',
          slugs: ['child-feature'],
          type: 'feature',
        },
      ],
    };

    const items = extractItemsFromRaw(raw, 'test.yaml');
    expect(items).toHaveLength(2);
    expect(items.map(i => i.title)).toContain('Parent Module');
    expect(items.map(i => i.title)).toContain('Child Feature');
  });

  it('should extract deeply nested items', () => {
    const raw = {
      _ulid: '01KEZCKAA3FPECBS5PWSSMJKQ5',
      title: 'Module',
      slugs: ['module'],
      type: 'module',
      features: [
        {
          _ulid: '01KEZCKAA3YQTVQYK4NC19R1DR',
          title: 'Feature',
          slugs: ['feature'],
          type: 'feature',
          requirements: [
            {
              _ulid: '01KEZCKAA3MPDRS6XPFC1VPMKW',
              title: 'Requirement',
              slugs: ['requirement'],
              type: 'requirement',
            },
          ],
        },
      ],
    };

    const items = extractItemsFromRaw(raw, 'test.yaml');
    expect(items).toHaveLength(3);
    expect(items.map(i => i.type)).toContain('module');
    expect(items.map(i => i.type)).toContain('feature');
    expect(items.map(i => i.type)).toContain('requirement');
  });

  it('should handle arrays of items', () => {
    const raw = [
      {
        _ulid: '01KEZCKAA39C06RGCDNANM7MDW',
        title: 'Item 1',
        slugs: ['item-1'],
      },
      {
        _ulid: '01KEZCKAA4A070ZAVZF8HC0NCB',
        title: 'Item 2',
        slugs: ['item-2'],
      },
    ];

    const items = extractItemsFromRaw(raw, 'test.yaml');
    expect(items).toHaveLength(2);
  });

  it('should return empty array for non-item objects', () => {
    const items = extractItemsFromRaw({ foo: 'bar' }, 'test.yaml');
    expect(items).toHaveLength(0);
  });

  it('should return empty array for null/undefined', () => {
    expect(extractItemsFromRaw(null, 'test.yaml')).toHaveLength(0);
    expect(extractItemsFromRaw(undefined, 'test.yaml')).toHaveLength(0);
  });
});

describe('findItemByRef', () => {
  const items: LoadedSpecItem[] = [
    {
      _ulid: '01JHNK8QW0CORE000000000000',
      slugs: ['core', 'core-primitives'],
      title: 'Core Primitives',
      tags: [],
      depends_on: [],
      implements: [],
      relates_to: [],
      tests: [],
    },
    {
      _ulid: '01JHNK8QW1ITEM000000000000',
      slugs: ['spec-item'],
      title: 'Spec Item',
      tags: [],
      depends_on: [],
      implements: [],
      relates_to: [],
      tests: [],
    },
  ];

  it('should find item by full ULID', () => {
    const item = findItemByRef(items, '01JHNK8QW0CORE000000000000');
    expect(item?.title).toBe('Core Primitives');
  });

  it('should find item by short ULID prefix', () => {
    const item = findItemByRef(items, '01JHNK8QW0');
    expect(item?.title).toBe('Core Primitives');
  });

  it('should find item by slug', () => {
    const item = findItemByRef(items, 'core-primitives');
    expect(item?.title).toBe('Core Primitives');
  });

  it('should find item by @ prefixed reference', () => {
    const item = findItemByRef(items, '@spec-item');
    expect(item?.title).toBe('Spec Item');
  });

  it('should return undefined for non-existent ref', () => {
    const item = findItemByRef(items, 'non-existent');
    expect(item).toBeUndefined();
  });
});

describe('expandIncludePattern', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-test-'));
    // Create test directory structure
    await fs.mkdir(path.join(testDir, 'modules'));
    await fs.writeFile(path.join(testDir, 'modules', 'a.yaml'), '');
    await fs.writeFile(path.join(testDir, 'modules', 'b.yaml'), '');
    await fs.writeFile(path.join(testDir, 'modules', 'c.txt'), '');
    await fs.writeFile(path.join(testDir, 'root.yaml'), '');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  it('should expand exact file path', async () => {
    const result = await expandIncludePattern('root.yaml', testDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(path.join(testDir, 'root.yaml'));
  });

  it('should expand *.yaml pattern', async () => {
    const result = await expandIncludePattern('modules/*.yaml', testDir);
    expect(result).toHaveLength(2);
    expect(result.some(p => p.endsWith('a.yaml'))).toBe(true);
    expect(result.some(p => p.endsWith('b.yaml'))).toBe(true);
    expect(result.some(p => p.endsWith('c.txt'))).toBe(false);
  });

  it('should return empty array for non-existent file', async () => {
    const result = await expandIncludePattern('nonexistent.yaml', testDir);
    expect(result).toHaveLength(0);
  });

  it('should return empty array for pattern with no matches', async () => {
    const result = await expandIncludePattern('modules/*.json', testDir);
    expect(result).toHaveLength(0);
  });
});

describe('loadAllItems integration', () => {
  it('should load items from real spec files', async () => {
    // This tests against the actual kynetic-spec spec files
    const ctx = await initContext(process.cwd());

    // Skip if no manifest found (e.g., running in CI without spec files)
    if (!ctx.manifestPath) {
      return;
    }

    const items = await loadAllItems(ctx);

    // Should have items from all modules
    expect(items.length).toBeGreaterThan(0);

    // Should have different types
    const types = new Set(items.map(i => i.type));
    expect(types.has('module')).toBe(true);
    expect(types.has('feature')).toBe(true);
    expect(types.has('requirement')).toBe(true);

    // Should include known slugs
    const slugs = items.flatMap(i => i.slugs);
    expect(slugs.includes('core')).toBe(true);
  });
});

// ============================================================
// REFERENCE RESOLUTION TESTS
// ============================================================

describe('ReferenceIndex', () => {
  // Sample tasks with distinct ULIDs
  const tasks: LoadedTask[] = [
    {
      _ulid: '01HQ3K5XJ8MPVB2XCJZ0KE9YWN',
      slugs: ['impl-login', 'auth-login'],
      title: 'Implement login',
      type: 'task',
      status: 'pending',
      blocked_by: [],
      depends_on: ['@impl-session'],
      context: [],
      priority: 2,
      tags: [],
      vcs_refs: [],
      created_at: '2025-01-14T10:00:00Z',
      notes: [],
      todos: [],
      _sourceFile: 'tasks.yaml',
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
      _sourceFile: 'tasks.yaml',
    },
  ];

  // Sample spec items
  const items: LoadedSpecItem[] = [
    {
      _ulid: '01JHNK8QW0CORE000000000000',
      slugs: ['core', 'core-primitives'],
      title: 'Core Primitives',
      tags: [],
      depends_on: [],
      implements: [],
      relates_to: [],
      tests: [],
      _sourceFile: 'spec/modules/core.yaml',
    },
    {
      _ulid: '01JHNK8QW1ITEM000000000000',
      slugs: ['spec-item'],
      title: 'Spec Item',
      tags: [],
      depends_on: [],
      implements: ['@core'],
      relates_to: [],
      tests: [],
      _sourceFile: 'spec/modules/core.yaml',
    },
  ];

  describe('resolve', () => {
    it('should resolve by exact slug', () => {
      const index = new ReferenceIndex(tasks, items);
      const result = index.resolve('@impl-login');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.item.title).toBe('Implement login');
        expect(result.matchType).toBe('slug');
      }
    });

    it('should resolve by alternate slug', () => {
      const index = new ReferenceIndex(tasks, items);
      const result = index.resolve('@auth-login');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.item.title).toBe('Implement login');
      }
    });

    it('should resolve by full ULID', () => {
      const index = new ReferenceIndex(tasks, items);
      const result = index.resolve('@01HQ3K5XJ8MPVB2XCJZ0KE9YWN');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.item.title).toBe('Implement login');
        expect(result.matchType).toBe('ulid-full');
      }
    });

    it('should resolve by unique ULID prefix', () => {
      const index = new ReferenceIndex(tasks, items);
      // 01HQ3K5 should uniquely identify the first task
      const result = index.resolve('@01HQ3K5X');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.item.title).toBe('Implement login');
        expect(result.matchType).toBe('ulid-prefix');
      }
    });

    it('should resolve spec items', () => {
      const index = new ReferenceIndex(tasks, items);
      const result = index.resolve('@core-primitives');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.item.title).toBe('Core Primitives');
      }
    });

    it('should return not_found for unknown reference', () => {
      const index = new ReferenceIndex(tasks, items);
      const result = index.resolve('@nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('not_found');
        expect(result.ref).toBe('@nonexistent');
      }
    });

    it('should return ambiguous for matching ULID prefix', () => {
      // Create items with similar ULIDs (same timestamp prefix)
      const similarTasks: LoadedTask[] = [
        {
          _ulid: '01SAME00001111111111111111',
          slugs: ['task-a'],
          title: 'Task A',
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
          _ulid: '01SAME00002222222222222222',
          slugs: ['task-b'],
          title: 'Task B',
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
      ];

      const index = new ReferenceIndex(similarTasks, []);
      // '01SAME0000' matches both
      const result = index.resolve('@01SAME0000');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('ambiguous');
        expect(result.candidates).toHaveLength(2);
      }
    });

    it('should handle reference without @ prefix', () => {
      const index = new ReferenceIndex(tasks, items);
      const result = index.resolve('impl-login');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.item.title).toBe('Implement login');
      }
    });

    it('should be case-insensitive for ULID matching', () => {
      const index = new ReferenceIndex(tasks, items);
      const result = index.resolve('@01hq3k5xj8mpvb2xcjz0ke9ywn');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.item.title).toBe('Implement login');
      }
    });
  });

  describe('shortUlid', () => {
    it('should return minimum unique prefix', () => {
      const index = new ReferenceIndex(tasks, items);

      // With distinct ULIDs, 8 chars should be enough
      const short = index.shortUlid('01HQ3K5XJ8MPVB2XCJZ0KE9YWN');
      expect(short.length).toBeLessThanOrEqual(26);
      expect('01HQ3K5XJ8MPVB2XCJZ0KE9YWN'.startsWith(short)).toBe(true);
    });

    it('should expand prefix for similar ULIDs', () => {
      const similarTasks: LoadedTask[] = [
        {
          _ulid: '01SAME00001111111111111111',
          slugs: ['task-a'],
          title: 'Task A',
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
          _ulid: '01SAME00002222222222222222',
          slugs: ['task-b'],
          title: 'Task B',
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
      ];

      const index = new ReferenceIndex(similarTasks, []);

      const shortA = index.shortUlid('01SAME00001111111111111111');
      const shortB = index.shortUlid('01SAME00002222222222222222');

      // Should be longer than default 8 to differentiate
      expect(shortA.length).toBeGreaterThan(8);
      expect(shortB.length).toBeGreaterThan(8);

      // Should still be unique
      expect(shortA).not.toBe(shortB);
    });

    it('should respect minimum length', () => {
      const index = new ReferenceIndex(tasks, items);
      const short = index.shortUlid('01HQ3K5XJ8MPVB2XCJZ0KE9YWN', 12);
      expect(short.length).toBeGreaterThanOrEqual(12);
    });
  });

  describe('duplicate slug detection', () => {
    it('should detect duplicate slugs', () => {
      const duplicateItems: LoadedSpecItem[] = [
        {
          _ulid: '01ITEM1000000000000000000',
          slugs: ['shared-slug', 'unique-a'],
          title: 'Item 1',
          tags: [],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
        },
        {
          _ulid: '01ITEM2000000000000000000',
          slugs: ['shared-slug', 'unique-b'],
          title: 'Item 2',
          tags: [],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
        },
      ];

      const index = new ReferenceIndex([], duplicateItems);
      const duplicates = findDuplicateSlugs(index);

      expect(duplicates.has('shared-slug')).toBe(true);
      expect(duplicates.get('shared-slug')).toHaveLength(2);
    });

    it('should return duplicate_slug error on resolution', () => {
      const duplicateItems: LoadedSpecItem[] = [
        {
          _ulid: '01ITEM1000000000000000000',
          slugs: ['dupe'],
          title: 'Item 1',
          tags: [],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
        },
        {
          _ulid: '01ITEM2000000000000000000',
          slugs: ['dupe'],
          title: 'Item 2',
          tags: [],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
        },
      ];

      const index = new ReferenceIndex([], duplicateItems);
      const result = index.resolve('@dupe');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('duplicate_slug');
        expect(result.candidates).toHaveLength(2);
      }
    });
  });
});

describe('validateRefs', () => {
  it('should find broken references', () => {
    const tasks: LoadedTask[] = [
      {
        _ulid: '01TASK1000000000000000000',
        slugs: ['my-task'],
        title: 'My Task',
        type: 'task',
        status: 'pending',
        blocked_by: [],
        depends_on: ['@nonexistent-dep'],
        context: [],
        priority: 1,
        tags: [],
        vcs_refs: [],
        created_at: '2025-01-14T10:00:00Z',
        notes: [],
        todos: [],
        _sourceFile: 'tasks.yaml',
      },
    ];

    const index = new ReferenceIndex(tasks, []);
    const errors = validateRefs(index, tasks, []);

    expect(errors).toHaveLength(1);
    expect(errors[0].ref).toBe('@nonexistent-dep');
    expect(errors[0].field).toBe('depends_on');
    expect(errors[0].error).toBe('not_found');
  });

  it('should report source info in errors', () => {
    const tasks: LoadedTask[] = [
      {
        _ulid: '01TASK1000000000000000000',
        slugs: ['my-task'],
        title: 'My Task',
        type: 'task',
        status: 'pending',
        blocked_by: [],
        depends_on: ['@broken'],
        context: [],
        priority: 1,
        tags: [],
        vcs_refs: [],
        created_at: '2025-01-14T10:00:00Z',
        notes: [],
        todos: [],
        _sourceFile: 'spec/tasks.yaml',
      },
    ];

    const index = new ReferenceIndex(tasks, []);
    const errors = validateRefs(index, tasks, []);

    expect(errors[0].sourceFile).toBe('spec/tasks.yaml');
    expect(errors[0].sourceUlid).toBe('01TASK1000000000000000000');
  });

  it('should return empty array for valid refs', () => {
    const tasks: LoadedTask[] = [
      {
        _ulid: '01TASK1000000000000000000',
        slugs: ['task-a'],
        title: 'Task A',
        type: 'task',
        status: 'pending',
        blocked_by: [],
        depends_on: ['@task-b'],
        context: [],
        priority: 1,
        tags: [],
        vcs_refs: [],
        created_at: '2025-01-14T10:00:00Z',
        notes: [],
        todos: [],
      },
      {
        _ulid: '01TASK2000000000000000000',
        slugs: ['task-b'],
        title: 'Task B',
        type: 'task',
        status: 'completed',
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
    ];

    const index = new ReferenceIndex(tasks, []);
    const errors = validateRefs(index, tasks, []);

    expect(errors).toHaveLength(0);
  });

  it('should validate spec_ref field', () => {
    const tasks: LoadedTask[] = [
      {
        _ulid: '01TASK1000000000000000000',
        slugs: ['my-task'],
        title: 'My Task',
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
        spec_ref: '@missing-spec',
      },
    ];

    const index = new ReferenceIndex(tasks, []);
    const errors = validateRefs(index, tasks, []);

    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('spec_ref');
  });
});
