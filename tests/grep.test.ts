/**
 * Tests for grep-like content search
 *
 * Spec: @fuzzy-item-search
 * Task: @task-grep-content-search
 */

import { describe, it, expect } from 'vitest';
import { grepItem, formatMatchedFields, type GrepMatch } from '../src/utils/grep.js';
import { ItemIndex, type ItemFilter } from '../src/parser/items.js';
import type { LoadedSpecItem, LoadedTask } from '../src/parser/yaml.js';

// Test fixtures
const createSpecItem = (overrides: Partial<LoadedSpecItem> = {}): LoadedSpecItem => ({
  _ulid: '01TEST00000000000000000000',
  _sourceFile: 'test.yaml',
  _sourcePath: [],
  title: 'Test Item',
  type: 'feature',
  slugs: ['test-item'],
  description: '',
  status: { maturity: 'draft', implementation: 'not_started' },
  depends_on: [],
  implements: [],
  relates_to: [],
  tests: [],
  tags: [],
  ...overrides,
});

const createTask = (overrides: Partial<LoadedTask> = {}): LoadedTask => ({
  _ulid: '01TASK00000000000000000000',
  _sourceFile: 'test.tasks.yaml',
  _sourcePath: [],
  title: 'Test Task',
  type: 'task',
  slugs: ['test-task'],
  status: 'pending',
  priority: 3,
  tags: [],
  depends_on: [],
  blocked_by: [],
  notes: [],
  todos: [],
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('grepItem', () => {
  // AC: @fuzzy-item-search ac-1
  // Given: A user runs kspec search "TODO"
  // When: The search runs across all loaded items and tasks
  // Then: Returns items/tasks where any text field matches
  describe('AC-1: Basic text search', () => {
    it('should find matches in title', () => {
      const item = createSpecItem({ title: 'TODO: Implement feature' });
      const match = grepItem(item as Record<string, unknown>, 'TODO');

      expect(match).not.toBeNull();
      expect(match!.matchedFields).toContain('title');
    });

    it('should find matches in description', () => {
      const item = createSpecItem({ description: 'This needs a TODO fix' });
      const match = grepItem(item as Record<string, unknown>, 'TODO');

      expect(match).not.toBeNull();
      expect(match!.matchedFields).toContain('description');
    });

    it('should return null when no match', () => {
      const item = createSpecItem({ title: 'Regular item', description: 'No matches here' });
      const match = grepItem(item as Record<string, unknown>, 'TODO');

      expect(match).toBeNull();
    });

    it('should search task notes', () => {
      const task = createTask({
        notes: [
          { _ulid: '01NOTE0000000000000000000', content: 'Found a TODO in the code', author: '@claude', created_at: '2026-01-01T00:00:00Z', supersedes: null },
        ],
      });
      const match = grepItem(task as unknown as Record<string, unknown>, 'TODO');

      expect(match).not.toBeNull();
      expect(match!.matchedFields).toContain('notes[0].content');
    });
  });

  // AC: @fuzzy-item-search ac-2
  // Given: A user searches with a regex pattern like "shadow.*branch"
  // When: The pattern is applied to content
  // Then: Matches using JavaScript regex semantics, case-insensitive by default
  describe('AC-2: Regex patterns and case sensitivity', () => {
    it('should support regex patterns', () => {
      const item = createSpecItem({ description: 'Works with shadow branch storage' });
      const match = grepItem(item as Record<string, unknown>, 'shadow.*branch');

      expect(match).not.toBeNull();
      expect(match!.matchedFields).toContain('description');
    });

    it('should be case-insensitive by default', () => {
      const item = createSpecItem({ title: 'SHADOW Branch Setup' });
      const match = grepItem(item as Record<string, unknown>, 'shadow');

      expect(match).not.toBeNull();
      expect(match!.matchedFields).toContain('title');
    });

    it('should support case-sensitive search when specified', () => {
      const item = createSpecItem({ title: 'shadow branch' });

      // Case insensitive (default)
      const matchInsensitive = grepItem(item as Record<string, unknown>, 'SHADOW', true);
      expect(matchInsensitive).not.toBeNull();

      // Case sensitive
      const matchSensitive = grepItem(item as Record<string, unknown>, 'SHADOW', false);
      expect(matchSensitive).toBeNull();
    });

    it('should handle invalid regex gracefully (treat as literal)', () => {
      const item = createSpecItem({ description: 'Pattern with [invalid regex' });
      const match = grepItem(item as Record<string, unknown>, '[invalid regex');

      expect(match).not.toBeNull();
      expect(match!.matchedFields).toContain('description');
    });
  });

  // AC: @fuzzy-item-search ac-3
  // Given: An item matches in multiple fields
  // When: Results are displayed
  // Then: Shows which field(s) matched
  describe('AC-3: Multiple field matches', () => {
    it('should report all matching fields', () => {
      const item = createSpecItem({
        title: 'Authentication Feature',
        description: 'Handles authentication flow',
        tags: ['authentication', 'security'],
      });
      const match = grepItem(item as Record<string, unknown>, 'authentication');

      expect(match).not.toBeNull();
      expect(match!.matchedFields).toContain('title');
      expect(match!.matchedFields).toContain('description');
      expect(match!.matchedFields).toContain('tags[0]');
    });

    it('should match multiple array items', () => {
      const task = createTask({
        notes: [
          { _ulid: '01NOTE0000000000000000001', content: 'First TODO note', author: '@claude', created_at: '2026-01-01T00:00:00Z', supersedes: null },
          { _ulid: '01NOTE0000000000000000002', content: 'Regular note', author: '@claude', created_at: '2026-01-01T00:00:00Z', supersedes: null },
          { _ulid: '01NOTE0000000000000000003', content: 'Another TODO note', author: '@claude', created_at: '2026-01-01T00:00:00Z', supersedes: null },
        ],
      });
      const match = grepItem(task as unknown as Record<string, unknown>, 'TODO');

      expect(match).not.toBeNull();
      expect(match!.matchedFields).toContain('notes[0].content');
      expect(match!.matchedFields).not.toContain('notes[1].content');
      expect(match!.matchedFields).toContain('notes[2].content');
    });
  });

  // AC: @fuzzy-item-search ac-4
  // Given: A match is found in nested content like notes or AC
  // When: Results are displayed
  // Then: The full item is returned with match location indicator
  describe('AC-4: Nested content matching', () => {
    it('should match in acceptance criteria', () => {
      const item = createSpecItem({
        acceptance_criteria: [
          { id: 'ac-1', given: 'A user inputs data', when: 'Validation runs', then: 'Errors are shown' },
          { id: 'ac-2', given: 'Authentication is required', when: 'User submits', then: 'Check credentials' },
        ],
      });
      const match = grepItem(item as Record<string, unknown>, 'Authentication');

      expect(match).not.toBeNull();
      expect(match!.matchedFields).toContain('acceptance_criteria[1].given');
    });

    it('should match in deeply nested structures', () => {
      const task = createTask({
        notes: [
          {
            _ulid: '01NOTE0000000000000000001',
            content: 'Check the shadow branch for details',
            author: '@claude',
            created_at: '2026-01-01T00:00:00Z',
            supersedes: null,
          },
        ],
      });
      const match = grepItem(task as unknown as Record<string, unknown>, 'shadow.*branch');

      expect(match).not.toBeNull();
      expect(match!.matchedFields).toContain('notes[0].content');
    });

    it('should not include internal fields (starting with _)', () => {
      const item = createSpecItem({
        _sourceFile: 'path/with/shadow/in/it.yaml',
        description: 'Regular description',
      });
      const match = grepItem(item as Record<string, unknown>, 'shadow');

      // Should NOT match _sourceFile
      expect(match).toBeNull();
    });
  });
});

describe('formatMatchedFields', () => {
  it('should format single field', () => {
    expect(formatMatchedFields(['description'])).toBe('description');
  });

  it('should format multiple fields', () => {
    const result = formatMatchedFields(['title', 'description', 'notes[0].content']);
    expect(result).toContain('title');
    expect(result).toContain('description');
    expect(result).toContain('notes[0]');
  });

  it('should abbreviate acceptance_criteria to ac', () => {
    const result = formatMatchedFields(['acceptance_criteria[0].given']);
    expect(result).toBe('ac[0].given');
  });

  it('should remove .content suffix from notes', () => {
    const result = formatMatchedFields(['notes[1].content']);
    expect(result).toBe('notes[1]');
  });
});

describe('ItemIndex grep integration', () => {
  // AC: @fuzzy-item-search ac-5
  // Given: User combines search with filters like --type task or --status pending
  // When: Search runs
  // Then: Filters are applied first, then content search within the filtered set
  describe('AC-5: Filter combination', () => {
    const items: LoadedSpecItem[] = [
      createSpecItem({ _ulid: '01ITEM0000000000000000001', title: 'Auth Feature', type: 'feature', description: 'Authentication system' }),
      createSpecItem({ _ulid: '01ITEM0000000000000000002', title: 'Auth Requirement', type: 'requirement', description: 'Authentication must be secure' }),
      createSpecItem({ _ulid: '01ITEM0000000000000000003', title: 'Other Feature', type: 'feature', description: 'Different system' }),
    ];

    const tasks: LoadedTask[] = [
      createTask({ _ulid: '01TASK0000000000000000001', title: 'Implement Auth', status: 'pending', description: 'Add authentication' }),
      createTask({ _ulid: '01TASK0000000000000000002', title: 'Test Auth', status: 'completed', description: 'Test authentication flow' }),
    ];

    it('should apply type filter before grep', () => {
      const index = new ItemIndex(tasks, items);
      const filter: ItemFilter = {
        type: 'feature',
        grepSearch: 'auth',
        specItemsOnly: true,
      };

      const results = index.query(filter);

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Auth Feature');
    });

    it('should apply status filter before grep for tasks', () => {
      const index = new ItemIndex(tasks, items);
      const filter: ItemFilter = {
        status: 'pending',
        grepSearch: 'auth',
        tasksOnly: true,
      };

      const results = index.query(filter);

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Implement Auth');
    });

    it('should combine tag and grep filters', () => {
      const taggedItems = [
        createSpecItem({ _ulid: '01ITEM0000000000000000010', title: 'API Auth', tags: ['api', 'security'], description: 'API authentication' }),
        createSpecItem({ _ulid: '01ITEM0000000000000000011', title: 'UI Component', tags: ['ui'], description: 'Authentication UI' }),
        createSpecItem({ _ulid: '01ITEM0000000000000000012', title: 'API Logging', tags: ['api'], description: 'Log API calls' }),
      ];

      const index = new ItemIndex([], taggedItems);
      const filter: ItemFilter = {
        tags: ['api'],
        grepSearch: 'auth',
        specItemsOnly: true,
      };

      const results = index.query(filter);

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('API Auth');
    });
  });

  // AC: @fuzzy-item-search ac-6
  // Given: Search finds no matches
  // When: Results are displayed
  // Then: Shows empty result with helpful message, not an error
  describe('AC-6: Empty results handling', () => {
    it('should return empty array when no matches', () => {
      const items = [
        createSpecItem({ title: 'Item One', description: 'First item' }),
        createSpecItem({ title: 'Item Two', description: 'Second item' }),
      ];

      const index = new ItemIndex([], items);
      const filter: ItemFilter = {
        grepSearch: 'nonexistent',
        specItemsOnly: true,
      };

      const results = index.query(filter);

      expect(results).toEqual([]);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should return empty array when filters exclude all items', () => {
      const items = [
        createSpecItem({ title: 'Feature', type: 'feature', description: 'Has keyword' }),
      ];

      const index = new ItemIndex([], items);
      const filter: ItemFilter = {
        type: 'requirement', // No requirements exist
        grepSearch: 'keyword',
        specItemsOnly: true,
      };

      const results = index.query(filter);

      expect(results).toEqual([]);
    });
  });
});

describe('grep edge cases', () => {
  it('should handle empty strings', () => {
    const item = createSpecItem({ title: 'Test', description: '' });
    const match = grepItem(item as Record<string, unknown>, 'test');

    expect(match).not.toBeNull();
    expect(match!.matchedFields).toContain('title');
    expect(match!.matchedFields).not.toContain('description');
  });

  it('should handle null and undefined fields', () => {
    const item = createSpecItem({ title: 'Regular Item', description: undefined });
    const match = grepItem(item as Record<string, unknown>, 'nonexistent');

    // Should not throw
    expect(match).toBeNull();
  });

  it('should handle special regex characters in search', () => {
    const item = createSpecItem({ description: 'Use [brackets] and (parens)' });

    // Literal brackets should be escaped automatically
    const match = grepItem(item as Record<string, unknown>, '[brackets]');
    expect(match).not.toBeNull();
  });

  it('should handle very long text content', () => {
    const longText = 'word '.repeat(10000) + 'needle ' + 'word '.repeat(10000);
    const item = createSpecItem({ description: longText });
    const match = grepItem(item as Record<string, unknown>, 'needle');

    expect(match).not.toBeNull();
    expect(match!.matchedFields).toContain('description');
  });
});
