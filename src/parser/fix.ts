/**
 * Auto-fix module for kspec validation issues.
 *
 * Provides automatic fixes for common validation problems:
 * - Invalid ULIDs (regenerate)
 * - Missing timestamps (add current time)
 * - Missing status objects (add defaults)
 */

import { ulid } from 'ulid';
import { ulidPattern } from '../schema/common.js';
import { readYamlFile, writeYamlFilePreserveFormat } from './yaml.js';

// ============================================================
// TYPES
// ============================================================

/**
 * A single fix that was applied
 */
export interface AppliedFix {
  file: string;
  path: string;
  type: 'ulid_regenerated' | 'timestamp_added' | 'status_added';
  oldValue?: unknown;
  newValue: unknown;
}

/**
 * Result of running fixes on a project
 */
export interface FixResult {
  filesModified: number;
  fixesApplied: AppliedFix[];
  errors: Array<{ file: string; message: string }>;
}

// ============================================================
// ULID VALIDATION
// ============================================================

/**
 * Check if a string is a valid ULID
 */
function isValidUlid(value: unknown): boolean {
  return typeof value === 'string' && ulidPattern.test(value);
}

// ============================================================
// FIX FUNCTIONS
// ============================================================

/**
 * Recursively fix issues in a data structure
 * Returns the number of fixes applied
 */
function fixObject(
  obj: unknown,
  file: string,
  pathPrefix: string,
  fixes: AppliedFix[]
): boolean {
  if (!obj || typeof obj !== 'object') return false;

  let modified = false;
  const record = obj as Record<string, unknown>;

  // Fix invalid _ulid
  if ('_ulid' in record) {
    if (!isValidUlid(record._ulid)) {
      const oldValue = record._ulid;
      const newValue = ulid();
      record._ulid = newValue;
      fixes.push({
        file,
        path: pathPrefix ? `${pathPrefix}._ulid` : '_ulid',
        type: 'ulid_regenerated',
        oldValue,
        newValue,
      });
      modified = true;
    }
  }

  // Fix missing created timestamp on items that have _ulid (spec items, tasks)
  // Tasks use created_at, spec items use created - check for both
  if ('_ulid' in record && !('created' in record) && !('created_at' in record)) {
    const newValue = new Date().toISOString();
    record.created = newValue;
    fixes.push({
      file,
      path: pathPrefix ? `${pathPrefix}.created` : 'created',
      type: 'timestamp_added',
      newValue,
    });
    modified = true;
  }

  // Fix notes with invalid _ulid
  if ('notes' in record && Array.isArray(record.notes)) {
    for (let i = 0; i < record.notes.length; i++) {
      const note = record.notes[i] as Record<string, unknown>;
      if (note && typeof note === 'object' && '_ulid' in note) {
        if (!isValidUlid(note._ulid)) {
          const oldValue = note._ulid;
          const newValue = ulid();
          note._ulid = newValue;
          fixes.push({
            file,
            path: `${pathPrefix}.notes[${i}]._ulid`,
            type: 'ulid_regenerated',
            oldValue,
            newValue,
          });
          modified = true;
        }
      }
    }
  }

  // Recurse into nested structures
  const nestedFields = [
    'modules',
    'features',
    'requirements',
    'constraints',
    'decisions',
    'items',
    'tasks',
  ];

  for (const field of nestedFields) {
    if (field in record && Array.isArray(record[field])) {
      const arr = record[field] as unknown[];
      for (let i = 0; i < arr.length; i++) {
        const newPath = pathPrefix ? `${pathPrefix}.${field}[${i}]` : `${field}[${i}]`;
        if (fixObject(arr[i], file, newPath, fixes)) {
          modified = true;
        }
      }
    }
  }

  return modified;
}

/**
 * Fix issues in a single file
 */
export async function fixFile(filePath: string): Promise<AppliedFix[]> {
  const fixes: AppliedFix[] = [];

  const data = await readYamlFile<unknown>(filePath);

  // Handle task files (array or { tasks: [...] })
  if (Array.isArray(data)) {
    let modified = false;
    for (let i = 0; i < data.length; i++) {
      if (fixObject(data[i], filePath, `[${i}]`, fixes)) {
        modified = true;
      }
    }
    if (modified) {
      await writeYamlFilePreserveFormat(filePath, data);
    }
  } else if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;

    // Check for tasks file format
    if ('tasks' in record && Array.isArray(record.tasks)) {
      let modified = false;
      for (let i = 0; i < record.tasks.length; i++) {
        if (fixObject(record.tasks[i], filePath, `tasks[${i}]`, fixes)) {
          modified = true;
        }
      }
      if (modified) {
        await writeYamlFilePreserveFormat(filePath, data);
      }
    }
    // Check for inbox file format
    else if ('inbox' in record && Array.isArray(record.inbox)) {
      let modified = false;
      for (let i = 0; i < record.inbox.length; i++) {
        if (fixObject(record.inbox[i], filePath, `inbox[${i}]`, fixes)) {
          modified = true;
        }
      }
      if (modified) {
        await writeYamlFilePreserveFormat(filePath, data);
      }
    }
    // Spec file (root is a spec item)
    else if ('_ulid' in record) {
      if (fixObject(data, filePath, '', fixes)) {
        await writeYamlFilePreserveFormat(filePath, data);
      }
    }
  }

  return fixes;
}

/**
 * Fix issues across multiple files
 */
export async function fixFiles(filePaths: string[]): Promise<FixResult> {
  const result: FixResult = {
    filesModified: 0,
    fixesApplied: [],
    errors: [],
  };

  for (const filePath of filePaths) {
    try {
      const fixes = await fixFile(filePath);
      if (fixes.length > 0) {
        result.filesModified++;
        result.fixesApplied.push(...fixes);
      }
    } catch (err) {
      result.errors.push({
        file: filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
