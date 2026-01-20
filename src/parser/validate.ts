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
  MetaManifestSchema,
  AgentSchema,
  WorkflowSchema,
  ConventionSchema,
  ObservationSchema,
  UlidSchema,
} from '../schema/index.js';
import type { KspecContext, LoadedTask, LoadedSpecItem } from './yaml.js';
import {
  readYamlFile,
  findTaskFiles,
  loadSpecFile,
  expandIncludePattern,
  extractItemsFromRaw,
} from './yaml.js';
import { ReferenceIndex, validateRefs, type RefValidationError, type RefValidationWarning } from './refs.js';
import { findMetaManifest, loadMetaContext, type MetaContext } from './meta.js';
import { TraitIndex } from './traits.js';

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
 * Completeness warning types
 */
export type CompletenessWarningType =
  | 'missing_acceptance_criteria'
  | 'missing_description'
  | 'status_inconsistency'
  | 'missing_test_coverage'
  | 'automation_eligible_no_spec';

/**
 * Trait cycle error
 */
export interface TraitCycleError {
  traitRef: string;
  traitTitle: string;
  cycle: string[];
  message: string;
}

/**
 * Completeness warning
 */
export interface CompletenessWarning {
  type: CompletenessWarningType;
  itemRef: string;
  itemTitle: string;
  message: string;
  details?: string;
}

/**
 * Complete validation result
 */
export interface ValidationResult {
  valid: boolean;
  schemaErrors: SchemaValidationError[];
  refErrors: RefValidationError[];
  refWarnings: RefValidationWarning[];
  orphans: OrphanItem[];
  completenessWarnings: CompletenessWarning[];
  traitCycleErrors: TraitCycleError[];
  stats: {
    filesChecked: number;
    itemsChecked: number;
    tasksChecked: number;
  };
  metaStats?: {
    agents: number;
    workflows: number;
    conventions: number;
    observations: number;
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
  /** Check spec completeness (missing AC, descriptions, status inconsistencies) */
  completeness?: boolean;
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
 * Validate meta manifest file with strict ULID validation
 * AC-meta-manifest-3: Invalid schema exits with code 1 and shows field path + expected type
 */
async function validateMetaManifestFile(filePath: string): Promise<SchemaValidationError[]> {
  const errors: SchemaValidationError[] = [];

  try {
    const raw = await readYamlFile<unknown>(filePath);

    // Validate overall manifest structure
    const manifestResult = MetaManifestSchema.safeParse(raw);
    if (!manifestResult.success) {
      for (const issue of manifestResult.error.issues) {
        errors.push({
          file: filePath,
          path: issue.path.join('.'),
          message: issue.message,
          details: issue,
        });
      }
      return errors;
    }

    // Validate each agent with strict ULID validation
    if (raw && typeof raw === 'object' && 'agents' in raw && Array.isArray((raw as Record<string, unknown>).agents)) {
      const agents = (raw as Record<string, unknown>).agents as unknown[];
      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        const agentResult = AgentSchema.safeParse(agent);
        if (!agentResult.success) {
          for (const issue of agentResult.error.issues) {
            errors.push({
              file: filePath,
              path: `agents[${i}].${issue.path.join('.')}`,
              message: issue.message,
              details: issue,
            });
          }
        }

        // Strict ULID validation
        if (agent && typeof agent === 'object' && '_ulid' in agent) {
          const ulidResult = UlidSchema.safeParse((agent as Record<string, unknown>)._ulid);
          if (!ulidResult.success) {
            errors.push({
              file: filePath,
              path: `agents[${i}]._ulid`,
              message: 'Invalid ULID format (expected 26 characters)',
            });
          }
        }
      }
    }

    // Validate each workflow with strict ULID validation
    if (raw && typeof raw === 'object' && 'workflows' in raw && Array.isArray((raw as Record<string, unknown>).workflows)) {
      const workflows = (raw as Record<string, unknown>).workflows as unknown[];
      for (let i = 0; i < workflows.length; i++) {
        const workflow = workflows[i];
        const workflowResult = WorkflowSchema.safeParse(workflow);
        if (!workflowResult.success) {
          for (const issue of workflowResult.error.issues) {
            errors.push({
              file: filePath,
              path: `workflows[${i}].${issue.path.join('.')}`,
              message: issue.message,
              details: issue,
            });
          }
        }

        // Strict ULID validation
        if (workflow && typeof workflow === 'object' && '_ulid' in workflow) {
          const ulidResult = UlidSchema.safeParse((workflow as Record<string, unknown>)._ulid);
          if (!ulidResult.success) {
            errors.push({
              file: filePath,
              path: `workflows[${i}]._ulid`,
              message: 'Invalid ULID format (expected 26 characters)',
            });
          }
        }
      }
    }

    // Validate each convention with strict ULID validation
    if (raw && typeof raw === 'object' && 'conventions' in raw && Array.isArray((raw as Record<string, unknown>).conventions)) {
      const conventions = (raw as Record<string, unknown>).conventions as unknown[];
      for (let i = 0; i < conventions.length; i++) {
        const convention = conventions[i];
        const conventionResult = ConventionSchema.safeParse(convention);
        if (!conventionResult.success) {
          for (const issue of conventionResult.error.issues) {
            errors.push({
              file: filePath,
              path: `conventions[${i}].${issue.path.join('.')}`,
              message: issue.message,
              details: issue,
            });
          }
        }

        // Strict ULID validation
        if (convention && typeof convention === 'object' && '_ulid' in convention) {
          const ulidResult = UlidSchema.safeParse((convention as Record<string, unknown>)._ulid);
          if (!ulidResult.success) {
            errors.push({
              file: filePath,
              path: `conventions[${i}]._ulid`,
              message: 'Invalid ULID format (expected 26 characters)',
            });
          }
        }
      }
    }

    // Validate each observation with strict ULID validation
    if (raw && typeof raw === 'object' && 'observations' in raw && Array.isArray((raw as Record<string, unknown>).observations)) {
      const observations = (raw as Record<string, unknown>).observations as unknown[];
      for (let i = 0; i < observations.length; i++) {
        const observation = observations[i];
        const observationResult = ObservationSchema.safeParse(observation);
        if (!observationResult.success) {
          for (const issue of observationResult.error.issues) {
            errors.push({
              file: filePath,
              path: `observations[${i}].${issue.path.join('.')}`,
              message: issue.message,
              details: issue,
            });
          }
        }

        // Strict ULID validation
        if (observation && typeof observation === 'object' && '_ulid' in observation) {
          const ulidResult = UlidSchema.safeParse((observation as Record<string, unknown>)._ulid);
          if (!ulidResult.success) {
            errors.push({
              file: filePath,
              path: `observations[${i}]._ulid`,
              message: 'Invalid ULID format (expected 26 characters)',
            });
          }
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

      // Skip nested items - they're implicitly referenced by their parent
      // _path indicates nesting (e.g., "features[0].requirements[2]")
      if (item._path) continue;

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
// TRAIT CYCLE DETECTION
// ============================================================

/**
 * Detect circular trait references
 * AC: @trait-edge-cases ac-2
 */
function detectTraitCycles(
  items: LoadedSpecItem[],
  index: ReferenceIndex
): TraitCycleError[] {
  const errors: TraitCycleError[] = [];
  const traits = items.filter(item => item.type === 'trait');

  // Build adjacency list: trait ULID → trait ULIDs it references
  const graph = new Map<string, string[]>();
  const traitInfo = new Map<string, { ref: string; title: string }>();

  for (const trait of traits) {
    const ref = trait.slugs?.[0] ? `@${trait.slugs[0]}` : `@${trait._ulid.slice(0, 8)}`;
    traitInfo.set(trait._ulid, { ref, title: trait.title });

    const dependencies: string[] = [];
    if (trait.traits && trait.traits.length > 0) {
      for (const traitRef of trait.traits) {
        const result = index.resolve(traitRef);
        if (result.ok) {
          dependencies.push(result.ulid);
        }
      }
    }
    graph.set(trait._ulid, dependencies);
  }

  // DFS-based cycle detection
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(ulid: string, path: string[]): string[] | null {
    if (visiting.has(ulid)) {
      // Found a cycle - return the cycle path
      const cycleStart = path.indexOf(ulid);
      return path.slice(cycleStart);
    }

    if (visited.has(ulid)) {
      return null; // Already checked this path
    }

    visiting.add(ulid);
    path.push(ulid);

    const dependencies = graph.get(ulid) || [];
    for (const depUlid of dependencies) {
      const cycle = dfs(depUlid, path);
      if (cycle) {
        return cycle;
      }
    }

    visiting.delete(ulid);
    visited.add(ulid);
    path.pop();

    return null;
  }

  // Check each trait for cycles
  for (const trait of traits) {
    if (!visited.has(trait._ulid)) {
      const cycle = dfs(trait._ulid, []);
      if (cycle) {
        const info = traitInfo.get(cycle[0]);
        if (info) {
          const cycleRefs = cycle.map(ulid => {
            const cycleInfo = traitInfo.get(ulid);
            return cycleInfo ? cycleInfo.ref : `@${ulid.slice(0, 8)}`;
          });

          errors.push({
            traitRef: info.ref,
            traitTitle: info.title,
            cycle: cycleRefs,
            message: `Circular trait reference: ${cycleRefs.join(' → ')} → ${cycleRefs[0]}`,
          });
        }

        // Mark all traits in cycle as visited to avoid duplicate errors
        for (const ulid of cycle) {
          visited.add(ulid);
        }
      }
    }
  }

  return errors;
}

// ============================================================
// COMPLETENESS VALIDATION
// ============================================================

/**
 * Scan test files for AC annotations to build coverage index
 * Returns a Set of covered ACs in format "@spec-ref ac-N"
 */
async function scanTestCoverage(rootDir: string): Promise<Set<string>> {
  const coveredACs = new Set<string>();
  const testsDir = path.join(rootDir, 'tests');

  try {
    // Check if tests directory exists
    await fs.access(testsDir);

    // Read all test files
    const files = await fs.readdir(testsDir);
    const testFiles = files.filter(f => f.endsWith('.test.ts') || f.endsWith('.test.js'));

    for (const file of testFiles) {
      const filePath = path.join(testsDir, file);
      const content = await fs.readFile(filePath, 'utf-8');

      // Match AC annotations: // AC: @spec-ref ac-N
      // Also handle multiple ACs on one line: // AC: @spec-ref ac-1, ac-2
      const acPattern = /\/\/\s*AC:\s*(@[\w-]+)(?:\s+(ac-\d+(?:\s*,\s*ac-\d+)*))?/g;
      let match;

      while ((match = acPattern.exec(content)) !== null) {
        const specRef = match[1]; // @spec-ref
        const acList = match[2]; // "ac-1, ac-2" or just "ac-1" or undefined

        if (acList) {
          // Split by comma and trim
          const acs = acList.split(',').map(ac => ac.trim());
          for (const ac of acs) {
            coveredACs.add(`${specRef} ${ac}`);
          }
        } else {
          // No specific AC mentioned, just the spec ref
          // We'll consider this as generic coverage
          coveredACs.add(specRef);
        }
      }
    }
  } catch (err) {
    // Tests directory doesn't exist or can't be read - that's ok
  }

  return coveredACs;
}

/**
 * Check spec items for completeness
 * AC: @spec-completeness ac-1, ac-2, ac-3
 * AC: @trait-validation ac-1, ac-2, ac-3
 */
async function checkCompleteness(
  items: LoadedSpecItem[],
  index: ReferenceIndex,
  rootDir: string,
  traitIndex?: TraitIndex
): Promise<CompletenessWarning[]> {
  const warnings: CompletenessWarning[] = [];

  // Scan test files for AC coverage
  const coveredACs = await scanTestCoverage(rootDir);

  for (const item of items) {
    const itemRef = item.slugs?.[0] ? `@${item.slugs[0]}` : `@${item._ulid.slice(0, 8)}`;
    const isTrait = item.type === 'trait';

    // AC: @spec-completeness ac-1
    // AC: @trait-type ac-2 - Traits should have acceptance criteria for completeness
    // Check for missing acceptance criteria
    if (!item.acceptance_criteria || item.acceptance_criteria.length === 0) {
      warnings.push({
        type: 'missing_acceptance_criteria',
        itemRef,
        itemTitle: item.title,
        message: `${isTrait ? 'Trait' : 'Item'} ${itemRef} has no acceptance criteria`,
      });
    }

    // AC: @spec-completeness ac-2
    // AC: @trait-type ac-3 - Traits should have description for completeness
    // Check for missing description
    if (!item.description || item.description.trim() === '') {
      warnings.push({
        type: 'missing_description',
        itemRef,
        itemTitle: item.title,
        message: `${isTrait ? 'Trait' : 'Item'} ${itemRef} has no description`,
      });
    }

    // AC: @spec-completeness ac-3
    // Check for status inconsistency between parent and children
    if (item.status?.implementation === 'implemented') {
      // Check if this item has children with not_started status
      const childFields = [
        'modules',
        'features',
        'requirements',
        'constraints',
        'epics',
        'themes',
        'capabilities',
      ];

      for (const field of childFields) {
        const children = (item as any)[field];
        if (Array.isArray(children)) {
          for (const child of children) {
            if (child.status?.implementation === 'not_started') {
              const childRef = child.slugs?.[0]
                ? `@${child.slugs[0]}`
                : `@${child._ulid?.slice(0, 8) || 'unknown'}`;
              warnings.push({
                type: 'status_inconsistency',
                itemRef,
                itemTitle: item.title,
                message: `Parent ${itemRef} is implemented but child ${childRef} is not_started`,
                details: `Child: ${child.title}`,
              });
            }
          }
        }
      }
    }

    // Check for test coverage of acceptance criteria
    if (item.acceptance_criteria && item.acceptance_criteria.length > 0) {
      const uncoveredACs: string[] = [];

      for (const ac of item.acceptance_criteria) {
        // Build all possible references for this AC
        const possibleRefs: string[] = [];

        // Try with primary slug
        if (item.slugs && item.slugs.length > 0) {
          possibleRefs.push(`@${item.slugs[0]} ${ac.id}`);
          // Also check for just the slug without specific AC
          possibleRefs.push(`@${item.slugs[0]}`);
        }

        // Try with ULID (short form)
        possibleRefs.push(`@${item._ulid.slice(0, 8)} ${ac.id}`);
        possibleRefs.push(`@${item._ulid.slice(0, 8)}`);

        // Check if any of these references are covered
        const isCovered = possibleRefs.some(ref => coveredACs.has(ref));

        if (!isCovered) {
          uncoveredACs.push(ac.id);
        }
      }

      // Only warn if there are uncovered ACs
      if (uncoveredACs.length > 0) {
        warnings.push({
          type: 'missing_test_coverage',
          itemRef,
          itemTitle: item.title,
          message: `Item ${itemRef} has ${uncoveredACs.length} AC(s) without test coverage`,
          details: `Uncovered: ${uncoveredACs.join(', ')}`,
        });
      }
    }

    // AC: @trait-validation ac-1, ac-2
    // Check for test coverage of trait acceptance criteria
    if (traitIndex && item.traits && item.traits.length > 0) {
      const inheritedACs = traitIndex.getInheritedAC(item._ulid);
      const uncoveredTraitACs: Array<{ traitSlug: string; acId: string }> = [];

      for (const { trait, ac } of inheritedACs) {
        // Build all possible references for this trait AC
        const possibleRefs: string[] = [];

        // Try with trait slug
        possibleRefs.push(`@${trait.slug} ${ac.id}`);
        possibleRefs.push(`@${trait.slug}`);

        // Try with trait ULID (short form)
        possibleRefs.push(`@${trait.ulid.slice(0, 8)} ${ac.id}`);
        possibleRefs.push(`@${trait.ulid.slice(0, 8)}`);

        // Check if any of these references are covered
        const isCovered = possibleRefs.some(ref => coveredACs.has(ref));

        if (!isCovered) {
          uncoveredTraitACs.push({ traitSlug: trait.slug, acId: ac.id });
        }
      }

      // Only warn if there are uncovered trait ACs
      if (uncoveredTraitACs.length > 0) {
        const details = uncoveredTraitACs
          .map(({ traitSlug, acId }) => `@${traitSlug} ${acId}`)
          .join(', ');
        warnings.push({
          type: 'missing_test_coverage',
          itemRef,
          itemTitle: item.title,
          message: `Item ${itemRef} has ${uncoveredTraitACs.length} inherited trait AC(s) without test coverage`,
          details: `Uncovered trait ACs: ${details}`,
        });
      }
    }
  }

  return warnings;
}

// ============================================================
// AUTOMATION VALIDATION
// ============================================================

/**
 * Check task automation status for warnings
 * AC: @task-automation-eligibility ac-21, ac-23
 */
function checkAutomationEligibility(
  tasks: LoadedTask[],
  index: ReferenceIndex
): CompletenessWarning[] {
  const warnings: CompletenessWarning[] = [];

  for (const task of tasks) {
    const taskRef = task.slugs?.[0] ? `@${task.slugs[0]}` : `@${task._ulid.slice(0, 8)}`;

    // AC: @task-automation-eligibility ac-21
    // Warn if eligible but no spec_ref
    if (task.automation === 'eligible' && !task.spec_ref) {
      warnings.push({
        type: 'automation_eligible_no_spec',
        itemRef: taskRef,
        itemTitle: task.title,
        message: `Task ${taskRef} is automation: eligible but has no spec_ref - eligible tasks should have linked specs`,
      });
    }

    // AC: @task-automation-eligibility ac-23
    // Warn if eligible but spec_ref doesn't resolve
    if (task.automation === 'eligible' && task.spec_ref) {
      const specResult = index.resolve(task.spec_ref);
      if (!specResult.ok) {
        warnings.push({
          type: 'automation_eligible_no_spec',
          itemRef: taskRef,
          itemTitle: task.title,
          message: `Task ${taskRef} is automation: eligible but spec_ref ${task.spec_ref} cannot be resolved`,
        });
      }
    }
  }

  return warnings;
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
  const runCompleteness = options.completeness !== false;

  const result: ValidationResult = {
    valid: true,
    schemaErrors: [],
    refErrors: [],
    refWarnings: [],
    orphans: [],
    completenessWarnings: [],
    traitCycleErrors: [],
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

  // Load items from manifest (traits, inline modules, etc.)
  if (ctx.manifest && ctx.manifestPath) {
    const manifestItems = extractItemsFromRaw(ctx.manifest, ctx.manifestPath);
    allItems.push(...manifestItems);
    result.stats.itemsChecked += manifestItems.length;
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

  // Load meta items for reference validation
  // AC: @agent-definitions ac-agent-3
  const metaCtx = await loadMetaContext(ctx);
  const allMetaItems = [
    ...metaCtx.agents,
    ...metaCtx.workflows,
    ...metaCtx.conventions,
    ...metaCtx.observations,
  ];

  // Reference validation
  if (runRefs && (allTasks.length > 0 || allItems.length > 0 || allMetaItems.length > 0)) {
    const index = new ReferenceIndex(allTasks, allItems, allMetaItems);
    const refResult = validateRefs(index, allTasks, allItems);
    result.refErrors = refResult.errors;
    result.refWarnings = refResult.warnings;

    // AC: @trait-edge-cases ac-2
    // Detect circular trait references
    result.traitCycleErrors = detectTraitCycles(allItems, index);

    // Orphan detection
    if (runOrphans) {
      result.orphans = findOrphans(allTasks, allItems, index);
    }

    // Completeness validation
    // AC: @spec-completeness ac-1, ac-2, ac-3
    // AC: @trait-validation ac-3
    if (runCompleteness) {
      // Build trait index for trait AC coverage validation
      const traitIndex = new TraitIndex(allItems, index);
      result.completenessWarnings = await checkCompleteness(allItems, index, ctx.rootDir, traitIndex);

      // AC: @task-automation-eligibility ac-21, ac-23
      // Check automation eligibility warnings for tasks
      const automationWarnings = checkAutomationEligibility(allTasks, index);
      result.completenessWarnings.push(...automationWarnings);
    }
  }

  // Meta manifest validation (AC-meta-manifest-2, AC-meta-manifest-3)
  const metaManifestPath = await findMetaManifest(ctx.specDir);
  if (metaManifestPath) {
    // Use metaCtx already loaded above
    result.metaStats = {
      agents: metaCtx.agents.length,
      workflows: metaCtx.workflows.length,
      conventions: metaCtx.conventions.length,
      observations: metaCtx.observations.length,
    };

    // Validate meta manifest schema with strict ULID validation
    if (runSchema) {
      const metaErrors = await validateMetaManifestFile(metaManifestPath);
      // Prefix all meta errors with "meta:"
      for (const err of metaErrors) {
        err.path = err.path ? `meta:${err.path}` : 'meta:';
      }
      result.schemaErrors.push(...metaErrors);
      result.stats.filesChecked++;
    }
  }

  // Set valid flag
  result.valid = result.schemaErrors.length === 0 && result.refErrors.length === 0 && result.traitCycleErrors.length === 0;

  return result;
}
