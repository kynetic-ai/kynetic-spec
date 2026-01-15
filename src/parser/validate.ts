/**
 * Validation module for kspec files.
 *
 * Provides schema validation, reference validation, and orphan detection.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  TaskSchema,
  TasksFileSchema,
  ManifestSchema,
  SpecItemSchema,
} from '../schema/index.js';
import type { KspecContext, LoadedTask, LoadedSpecItem } from './yaml.js';
import {
  readYamlFile,
  findTaskFiles,
  loadSpecFile,
  expandIncludePattern,
} from './yaml.js';
import { ReferenceIndex, validateRefs, type RefValidationError } from './refs.js';

// ============================================================
// TYPES
// ============================================================

/**
 * Schema validation error
 */
export interface SchemaValidationError {
  file: string;
  path?: string;
  message: string;
  details?: unknown;
}

/**
 * Orphan item (not referenced by anything)
 */
export interface OrphanItem {
  ulid: string;
  title: string;
  type: string;
  file?: string;
}

/**
 * Complete validation result
 */
export interface ValidationResult {
  valid: boolean;
  schemaErrors: SchemaValidationError[];
  refErrors: RefValidationError[];
  orphans: OrphanItem[];
  stats: {
    filesChecked: number;
    itemsChecked: number;
    tasksChecked: number;
  };
}

/**
 * Validation options
 */
export interface ValidateOptions {
  /** Check schema conformance */
  schema?: boolean;
  /** Check reference resolution */
  refs?: boolean;
  /** Find orphaned items */
  orphans?: boolean;
}

// ============================================================
// SCHEMA VALIDATION
// ============================================================

/**
 * Validate a manifest file against schema
 */
async function validateManifestFile(filePath: string): Promise<SchemaValidationError[]> {
  const errors: SchemaValidationError[] = [];

  try {
    const raw = await readYamlFile<unknown>(filePath);
    const result = ManifestSchema.safeParse(raw);

    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          file: filePath,
          path: issue.path.join('.'),
          message: issue.message,
          details: issue,
        });
      }
    }
  } catch (err) {
    errors.push({
      file: filePath,
      message: `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return errors;
}

/**
 * Validate a tasks file against schema
 */
async function validateTasksFile(filePath: string): Promise<SchemaValidationError[]> {
  const errors: SchemaValidationError[] = [];

  try {
    const raw = await readYamlFile<unknown>(filePath);

    // Handle both formats: { tasks: [...] } and plain array
    let taskList: unknown[];

    if (Array.isArray(raw)) {
      taskList = raw;
    } else if (raw && typeof raw === 'object' && 'tasks' in raw) {
      // Try full TasksFile schema first
      const fileResult = TasksFileSchema.safeParse(raw);
      if (!fileResult.success) {
        // If TasksFile fails, just validate individual tasks
        taskList = (raw as { tasks: unknown[] }).tasks || [];
      } else {
        // File schema passed, validate individual tasks for detailed errors
        taskList = fileResult.data.tasks;
      }
    } else {
      errors.push({
        file: filePath,
        message: 'Invalid tasks file format: expected array or { tasks: [...] }',
      });
      return errors;
    }

    // Validate each task
    for (let i = 0; i < taskList.length; i++) {
      const task = taskList[i];
      const result = TaskSchema.safeParse(task);

      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            file: filePath,
            path: `tasks[${i}].${issue.path.join('.')}`,
            message: issue.message,
            details: issue,
          });
        }
      }
    }
  } catch (err) {
    errors.push({
      file: filePath,
      message: `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return errors;
}

/**
 * Validate a spec module file against schema
 */
async function validateSpecFile(filePath: string): Promise<SchemaValidationError[]> {
  const errors: SchemaValidationError[] = [];

  try {
    const raw = await readYamlFile<unknown>(filePath);

    // Recursively validate spec items
    validateSpecItemRecursive(raw, filePath, '', errors);
  } catch (err) {
    errors.push({
      file: filePath,
      message: `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return errors;
}

/**
 * Recursively validate spec items in a structure
 */
function validateSpecItemRecursive(
  raw: unknown,
  file: string,
  pathPrefix: string,
  errors: SchemaValidationError[]
): void {
  if (!raw || typeof raw !== 'object') return;

  // Check if this is a spec item (has _ulid)
  if ('_ulid' in raw) {
    const result = SpecItemSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          file,
          path: pathPrefix ? `${pathPrefix}.${issue.path.join('.')}` : issue.path.join('.'),
          message: issue.message,
          details: issue,
        });
      }
    }
  }

  // Recurse into nested structures
  const nestedFields = ['modules', 'features', 'requirements', 'constraints', 'decisions', 'items'];
  const obj = raw as Record<string, unknown>;

  for (const field of nestedFields) {
    if (field in obj && Array.isArray(obj[field])) {
      const arr = obj[field] as unknown[];
      for (let i = 0; i < arr.length; i++) {
        const newPath = pathPrefix ? `${pathPrefix}.${field}[${i}]` : `${field}[${i}]`;
        validateSpecItemRecursive(arr[i], file, newPath, errors);
      }
    }
  }
}

// ============================================================
// ORPHAN DETECTION
// ============================================================

/**
 * Find items that are not referenced by any other item
 */
function findOrphans(
  tasks: LoadedTask[],
  items: LoadedSpecItem[],
  index: ReferenceIndex
): OrphanItem[] {
  const orphans: OrphanItem[] = [];

  // Build set of all referenced ULIDs
  const referenced = new Set<string>();

  const allItems = [...tasks, ...items];

  // Fields that contain references
  const refFields = [
    'depends_on',
    'blocked_by',
    'implements',
    'relates_to',
    'tests',
    'supersedes',
    'spec_ref',
    'context',
  ];

  for (const item of allItems) {
    const obj = item as unknown as Record<string, unknown>;

    for (const field of refFields) {
      const value = obj[field];

      if (typeof value === 'string' && value.startsWith('@')) {
        const resolved = index.resolve(value);
        if (resolved.ok) {
          referenced.add(resolved.ulid);
        }
      } else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === 'string' && v.startsWith('@')) {
            const resolved = index.resolve(v);
            if (resolved.ok) {
              referenced.add(resolved.ulid);
            }
          }
        }
      }
    }
  }

  // Find items not in the referenced set
  // Skip entry point types: modules are spec entry points, tasks are work items
  const entryPointTypes = ['module', 'task', 'epic', 'bug', 'spike', 'infra'];

  for (const item of items) {
    // Only check spec items, not tasks
    if (!referenced.has(item._ulid)) {
      // Skip entry point types
      if (entryPointTypes.includes(item.type || '')) continue;

      orphans.push({
        ulid: item._ulid,
        title: item.title,
        type: item.type || 'unknown',
        file: item._sourceFile,
      });
    }
  }

  return orphans;
}

// ============================================================
// MAIN VALIDATION
// ============================================================

/**
 * Run full validation on a kspec project
 */
export async function validate(
  ctx: KspecContext,
  options: ValidateOptions = {}
): Promise<ValidationResult> {
  // Default: run all checks
  const runSchema = options.schema !== false;
  const runRefs = options.refs !== false;
  const runOrphans = options.orphans !== false;

  const result: ValidationResult = {
    valid: true,
    schemaErrors: [],
    refErrors: [],
    orphans: [],
    stats: {
      filesChecked: 0,
      itemsChecked: 0,
      tasksChecked: 0,
    },
  };

  const allTasks: LoadedTask[] = [];
  const allItems: LoadedSpecItem[] = [];

  // Validate manifest
  if (ctx.manifestPath && runSchema) {
    const manifestErrors = await validateManifestFile(ctx.manifestPath);
    result.schemaErrors.push(...manifestErrors);
    result.stats.filesChecked++;
  }

  // Find and validate task files
  const taskFiles = await findTaskFiles(ctx.rootDir);
  const specTaskFiles = await findTaskFiles(path.join(ctx.rootDir, 'spec'));
  const allTaskFiles = [...new Set([...taskFiles, ...specTaskFiles])];

  for (const taskFile of allTaskFiles) {
    if (runSchema) {
      const taskErrors = await validateTasksFile(taskFile);
      result.schemaErrors.push(...taskErrors);
    }
    result.stats.filesChecked++;

    // Load tasks for ref validation
    try {
      const raw = await readYamlFile<unknown>(taskFile);
      let taskList: unknown[] = [];

      if (Array.isArray(raw)) {
        taskList = raw;
      } else if (raw && typeof raw === 'object' && 'tasks' in raw) {
        taskList = (raw as { tasks: unknown[] }).tasks || [];
      }

      for (const t of taskList) {
        const parsed = TaskSchema.safeParse(t);
        if (parsed.success) {
          allTasks.push({ ...parsed.data, _sourceFile: taskFile });
          result.stats.tasksChecked++;
        }
      }
    } catch {
      // Already reported in schema validation
    }
  }

  // Validate spec files (from includes)
  if (ctx.manifest && ctx.manifestPath) {
    const manifestDir = path.dirname(ctx.manifestPath);
    const includes = ctx.manifest.includes || [];

    for (const include of includes) {
      const expandedPaths = await expandIncludePattern(include, manifestDir);

      for (const filePath of expandedPaths) {
        if (runSchema) {
          const specErrors = await validateSpecFile(filePath);
          result.schemaErrors.push(...specErrors);
        }
        result.stats.filesChecked++;

        // Load items for ref validation
        try {
          const items = await loadSpecFile(filePath);
          allItems.push(...items);
          result.stats.itemsChecked += items.length;
        } catch {
          // Already reported in schema validation
        }
      }
    }
  }

  // Reference validation
  if (runRefs && (allTasks.length > 0 || allItems.length > 0)) {
    const index = new ReferenceIndex(allTasks, allItems);
    result.refErrors = validateRefs(index, allTasks, allItems);

    // Orphan detection
    if (runOrphans) {
      result.orphans = findOrphans(allTasks, allItems, index);
    }
  }

  // Set valid flag
  result.valid = result.schemaErrors.length === 0 && result.refErrors.length === 0;

  return result;
}
