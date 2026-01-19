import { describe, it, expect } from 'vitest';
import {
  TaskSchema,
  TaskInputSchema,
  NoteSchema,
  UlidSchema,
  SlugSchema,
  RefSchema,
  MaturitySchema,
} from '../src/schema/index.js';

describe('UlidSchema', () => {
  it('should accept valid ULIDs', () => {
    const validUlid = '01HQ3K5XJ8MPVB2XCJZ0KE9YWN';
    expect(UlidSchema.safeParse(validUlid).success).toBe(true);
  });

  it('should reject invalid ULIDs', () => {
    expect(UlidSchema.safeParse('invalid').success).toBe(false);
    expect(UlidSchema.safeParse('01HQ3K5XJ8-invalid').success).toBe(false);
    expect(UlidSchema.safeParse('').success).toBe(false);
  });
});

describe('SlugSchema', () => {
  it('should accept valid slugs', () => {
    expect(SlugSchema.safeParse('auth-login').success).toBe(true);
    expect(SlugSchema.safeParse('impl-user-session').success).toBe(true);
    expect(SlugSchema.safeParse('a').success).toBe(true);
    expect(SlugSchema.safeParse('task123').success).toBe(true);
  });

  it('should reject invalid slugs', () => {
    expect(SlugSchema.safeParse('Auth-Login').success).toBe(false); // uppercase
    expect(SlugSchema.safeParse('123-task').success).toBe(false);   // starts with number
    expect(SlugSchema.safeParse('-task').success).toBe(false);      // starts with hyphen
    expect(SlugSchema.safeParse('').success).toBe(false);
  });
});

describe('RefSchema', () => {
  it('should accept valid references', () => {
    expect(RefSchema.safeParse('@auth-login').success).toBe(true);
    expect(RefSchema.safeParse('@01HQ3K').success).toBe(true);
    expect(RefSchema.safeParse('@impl-session-123').success).toBe(true);
  });

  it('should reject invalid references', () => {
    expect(RefSchema.safeParse('auth-login').success).toBe(false);  // missing @
    expect(RefSchema.safeParse('@').success).toBe(false);            // empty after @
    expect(RefSchema.safeParse('').success).toBe(false);
  });
});

describe('TaskSchema', () => {
  it('should accept a valid full task', () => {
    const task = {
      _ulid: '01HQ3K5XJ8MPVB2XCJZ0KE9YWN',
      slugs: ['impl-login'],
      title: 'Implement login',
      type: 'task',
      spec_ref: '@user-login',
      status: 'pending',
      blocked_by: [],
      depends_on: ['@impl-session'],
      context: [],
      priority: 2,
      tags: ['auth', 'mvp'],
      vcs_refs: [],
      created_at: '2025-01-14T10:00:00Z',
      notes: [],
      todos: [],
    };

    const result = TaskSchema.safeParse(task);
    expect(result.success).toBe(true);
  });

  it('should reject task without required fields', () => {
    const result = TaskSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should reject task without title', () => {
    const task = {
      _ulid: '01HQ3K5XJ8MPVB2XCJZ0KE9YWN',
      type: 'task',
    };
    const result = TaskSchema.safeParse(task);
    expect(result.success).toBe(false);
  });
});

describe('TaskInputSchema', () => {
  it('should accept minimal input (title only)', () => {
    const input = {
      title: 'My new task',
    };
    const result = TaskInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should accept input with optional fields', () => {
    const input = {
      title: 'My new task',
      type: 'bug',
      priority: 1,
      tags: ['urgent'],
      spec_ref: '@some-feature',
    };
    const result = TaskInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe('NoteSchema', () => {
  it('should accept valid note', () => {
    const note = {
      _ulid: '01HQ3K5XJ8MPVB2XCJZ0KE9YWN',
      created_at: '2025-01-14T10:00:00Z',
      author: '@agent-1',
      content: 'Found an issue with the middleware.',
      supersedes: null,
    };
    const result = NoteSchema.safeParse(note);
    expect(result.success).toBe(true);
  });
});

describe('MaturitySchema', () => {
  it('should accept all valid maturity statuses', () => {
    expect(MaturitySchema.safeParse('draft').success).toBe(true);
    expect(MaturitySchema.safeParse('proposed').success).toBe(true);
    expect(MaturitySchema.safeParse('stable').success).toBe(true);
    expect(MaturitySchema.safeParse('deferred').success).toBe(true);
    expect(MaturitySchema.safeParse('deprecated').success).toBe(true);
  });

  it('should reject invalid maturity statuses', () => {
    expect(MaturitySchema.safeParse('invalid').success).toBe(false);
    expect(MaturitySchema.safeParse('pending').success).toBe(false);
    expect(MaturitySchema.safeParse('').success).toBe(false);
  });
});
