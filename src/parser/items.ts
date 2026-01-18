/**
 * Item index for efficient queries across spec items and tasks.
 *
 * Provides filtering by type, tags, status, and field presence.
 * Complements ReferenceIndex which handles @reference resolution.
 */

import type { LoadedSpecItem, LoadedTask, AnyLoadedItem } from './yaml.js';
import type { ItemType, TaskStatus, Maturity, ImplementationStatus } from '../schema/index.js';
import { grepItem } from '../utils/grep.js';

// ============================================================
// TYPES
// ============================================================

/**
 * Filter criteria for item queries
 */
export interface ItemFilter {
  /** Filter by item type (module, feature, requirement, etc.) */
  type?: ItemType | ItemType[];
  /** Filter by tags (matches if item has ANY of these tags) */
  tags?: string[];
  /** Filter by tags (matches if item has ALL of these tags) */
  allTags?: string[];
  /** Filter by task status (for tasks only) */
  status?: TaskStatus | TaskStatus[];
  /** Filter by maturity status (for spec items) */
  maturity?: Maturity | Maturity[];
  /** Filter by implementation status (for spec items) */
  implementation?: ImplementationStatus | ImplementationStatus[];
  /** Filter items that have these fields present (non-null/undefined) */
  hasFields?: string[];
  /** Filter items that have a specific field value */
  fieldEquals?: { field: string; value: unknown }[];
  /** Text search in title */
  titleContains?: string;
  /** Include only tasks */
  tasksOnly?: boolean;
  /** Include only spec items (non-tasks) */
  specItemsOnly?: boolean;
  /** Grep-like regex search across all text content */
  grepSearch?: string;
}

/**
 * Query result with pagination info
 */
export interface QueryResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

// ============================================================
// ITEM INDEX
// ============================================================

/**
 * Index for efficient item queries.
 * Build once when loading the spec, then query many times.
 */
export class ItemIndex {
  /** All items (tasks + spec items) */
  private allItems: AnyLoadedItem[] = [];

  /** Tasks only */
  private tasks: LoadedTask[] = [];

  /** Spec items only (non-tasks) */
  private specItems: LoadedSpecItem[] = [];

  /** Index by type */
  private typeIndex = new Map<string, AnyLoadedItem[]>();

  /** Index by tag */
  private tagIndex = new Map<string, AnyLoadedItem[]>();

  /** Index by task status */
  private statusIndex = new Map<TaskStatus, LoadedTask[]>();

  /** Index by maturity */
  private maturityIndex = new Map<Maturity, LoadedSpecItem[]>();

  /** Index by implementation status */
  private implementationIndex = new Map<ImplementationStatus, LoadedSpecItem[]>();

  /**
   * Build index from loaded items
   */
  constructor(tasks: LoadedTask[], items: LoadedSpecItem[]) {
    this.tasks = tasks;
    this.specItems = items;
    this.allItems = [...tasks, ...items];

    // Build indexes
    for (const item of this.allItems) {
      this.indexItem(item);
    }
  }

  private indexItem(item: AnyLoadedItem): void {
    // Index by type
    const type = item.type || 'unknown';
    const typeList = this.typeIndex.get(type) || [];
    typeList.push(item);
    this.typeIndex.set(type, typeList);

    // Index by tags
    const tags = 'tags' in item ? (item.tags as string[]) : [];
    for (const tag of tags) {
      const tagList = this.tagIndex.get(tag) || [];
      tagList.push(item);
      this.tagIndex.set(tag, tagList);
    }

    // Index tasks by status
    if ('status' in item && typeof item.status === 'string') {
      const task = item as LoadedTask;
      const statusList = this.statusIndex.get(task.status) || [];
      statusList.push(task);
      this.statusIndex.set(task.status, statusList);
    }

    // Index spec items by maturity/implementation
    if ('status' in item && typeof item.status === 'object' && item.status !== null) {
      const specItem = item as LoadedSpecItem;
      const status = specItem.status as { maturity?: Maturity; implementation?: ImplementationStatus };

      if (status.maturity) {
        const maturityList = this.maturityIndex.get(status.maturity) || [];
        maturityList.push(specItem);
        this.maturityIndex.set(status.maturity, maturityList);
      }

      if (status.implementation) {
        const implList = this.implementationIndex.get(status.implementation) || [];
        implList.push(specItem);
        this.implementationIndex.set(status.implementation, implList);
      }
    }
  }

  /**
   * Query items with filters
   */
  query(filter: ItemFilter = {}): AnyLoadedItem[] {
    let results: AnyLoadedItem[];

    // Start with appropriate base set
    if (filter.tasksOnly) {
      results = [...this.tasks];
    } else if (filter.specItemsOnly) {
      results = [...this.specItems];
    } else {
      results = [...this.allItems];
    }

    // Apply type filter
    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      results = results.filter(item => types.includes(item.type as ItemType));
    }

    // Apply tag filter (ANY)
    if (filter.tags && filter.tags.length > 0) {
      results = results.filter(item => {
        const itemTags = 'tags' in item ? (item.tags as string[]) : [];
        return filter.tags!.some(tag => itemTags.includes(tag));
      });
    }

    // Apply tag filter (ALL)
    if (filter.allTags && filter.allTags.length > 0) {
      results = results.filter(item => {
        const itemTags = 'tags' in item ? (item.tags as string[]) : [];
        return filter.allTags!.every(tag => itemTags.includes(tag));
      });
    }

    // Apply task status filter
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      results = results.filter(item => {
        if (!('status' in item) || typeof item.status !== 'string') return false;
        return statuses.includes(item.status as TaskStatus);
      });
    }

    // Apply maturity filter
    if (filter.maturity) {
      const maturities = Array.isArray(filter.maturity) ? filter.maturity : [filter.maturity];
      results = results.filter(item => {
        if (!('status' in item) || typeof item.status !== 'object' || !item.status) return false;
        const status = item.status as { maturity?: Maturity };
        return status.maturity && maturities.includes(status.maturity);
      });
    }

    // Apply implementation filter
    if (filter.implementation) {
      const impls = Array.isArray(filter.implementation) ? filter.implementation : [filter.implementation];
      results = results.filter(item => {
        if (!('status' in item) || typeof item.status !== 'object' || !item.status) return false;
        const status = item.status as { implementation?: ImplementationStatus };
        return status.implementation && impls.includes(status.implementation);
      });
    }

    // Apply has-fields filter
    if (filter.hasFields && filter.hasFields.length > 0) {
      results = results.filter(item => {
        const obj = item as unknown as Record<string, unknown>;
        return filter.hasFields!.every(field => {
          const value = getNestedField(obj, field);
          return value !== undefined && value !== null;
        });
      });
    }

    // Apply field-equals filter
    if (filter.fieldEquals && filter.fieldEquals.length > 0) {
      results = results.filter(item => {
        const obj = item as unknown as Record<string, unknown>;
        return filter.fieldEquals!.every(({ field, value }) => {
          const itemValue = getNestedField(obj, field);
          return itemValue === value;
        });
      });
    }

    // Apply title search
    if (filter.titleContains) {
      const search = filter.titleContains.toLowerCase();
      results = results.filter(item => item.title.toLowerCase().includes(search));
    }

    // Apply grep search (regex across all text content)
    if (filter.grepSearch) {
      results = results.filter(item => {
        const match = grepItem(item as unknown as Record<string, unknown>, filter.grepSearch!);
        return match !== null;
      });
    }

    return results;
  }

  /**
   * Query with pagination
   */
  queryPaginated(filter: ItemFilter = {}, offset = 0, limit = 50): QueryResult<AnyLoadedItem> {
    const allResults = this.query(filter);
    const items = allResults.slice(offset, offset + limit);

    return {
      items,
      total: allResults.length,
      offset,
      limit,
    };
  }

  /**
   * Get items by type
   */
  getByType(type: ItemType): AnyLoadedItem[] {
    return this.typeIndex.get(type) || [];
  }

  /**
   * Get items by tag
   */
  getByTag(tag: string): AnyLoadedItem[] {
    return this.tagIndex.get(tag) || [];
  }

  /**
   * Get tasks by status
   */
  getTasksByStatus(status: TaskStatus): LoadedTask[] {
    return this.statusIndex.get(status) || [];
  }

  /**
   * Get spec items by maturity
   */
  getByMaturity(maturity: Maturity): LoadedSpecItem[] {
    return this.maturityIndex.get(maturity) || [];
  }

  /**
   * Get spec items by implementation status
   */
  getByImplementation(impl: ImplementationStatus): LoadedSpecItem[] {
    return this.implementationIndex.get(impl) || [];
  }

  /**
   * Get all unique types in the index
   */
  getTypes(): string[] {
    return [...this.typeIndex.keys()].sort();
  }

  /**
   * Get all unique tags in the index
   */
  getTags(): string[] {
    return [...this.tagIndex.keys()].sort();
  }

  /**
   * Get count by type
   */
  getTypeCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [type, items] of this.typeIndex) {
      counts.set(type, items.length);
    }
    return counts;
  }

  /**
   * Get count by tag
   */
  getTagCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [tag, items] of this.tagIndex) {
      counts.set(tag, items.length);
    }
    return counts;
  }

  /**
   * Get total item count
   */
  get size(): number {
    return this.allItems.length;
  }

  /**
   * Get task count
   */
  get taskCount(): number {
    return this.tasks.length;
  }

  /**
   * Get spec item count
   */
  get specItemCount(): number {
    return this.specItems.length;
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Get a nested field value using dot notation
 * e.g., "status.maturity" -> item.status.maturity
 */
function getNestedField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Find direct child items of a parent item based on _path
 * Children have paths like "parent_path.field[N]"
 */
export function findChildItems(parent: LoadedSpecItem, allItems: LoadedSpecItem[]): LoadedSpecItem[] {
  // Handle both cases: parent at root and nested parent
  const parentPath = parent._path || '';

  // Look for items whose path starts with parent's path
  return allItems.filter(item => {
    if (!item._path) return false;
    if (item._ulid === parent._ulid) return false; // Skip self

    // Child path should be: parentPath.field[N]
    // Examples:
    // - Parent: "features[0]", Child: "features[0].requirements[0]"
    // - Parent: "", Child: "features[0]"
    if (parentPath === '') {
      // Root level parent - children are top-level items like "features[0]"
      return !item._path.includes('.');
    }

    // Nested parent - children start with parent path + dot
    if (!item._path.startsWith(parentPath + '.')) {
      return false;
    }

    // Must be direct child (no additional nesting)
    // Remove parent prefix and check for no more dots
    const remainder = item._path.slice(parentPath.length + 1);
    return !remainder.includes('.');
  });
}
