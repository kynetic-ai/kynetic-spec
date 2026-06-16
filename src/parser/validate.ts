/**
 * Validation module for kspec files.
 *
 * Provides schema validation, reference validation, and orphan detection.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  acIdPattern,
  AgentSchema,
  ConventionSchema,
  HookSchema,
  isSkill,
  ManifestSchema,
  MetaManifestSchema,
  ObservationSchema,
  SkillSchema,
  SpecItemSchema,
  TaskSchema,
  TasksFileSchema,
  UlidSchema,
  WorkflowSchema,
} from "../schema/index.js";
import { validateHookFilter } from "../schema/hooks.js";
import {
  extractActionTemplates,
  validateActionTemplates,
} from "../agent-runtime/action-executor.js";
import {
  findMetaManifest,
  getSkillContentPath,
  loadMetaContext,
  type LoadedHook,
  type LoadedSchedule,
  type LoadedComposition,
  type LoadedSkill,
} from "./meta.js";
import { loadPlans } from "./plans.js";
import { findReviewFiles, validateReviewsFile } from "./review-validation.js";
import {
  ReferenceIndex,
  type RefValidationError,
  type RefValidationWarning,
  shortestUniqueUlid,
  validateRefs,
} from "./refs.js";
import { checkReviewLinkageConsistency } from "./review-task-integration.js";
import { loadReviewRecords } from "./reviews.js";
import { TraitIndex } from "./traits.js";
import type { KspecContext, LoadedSpecItem, LoadedTask } from "./yaml.js";
import {
  expandIncludePattern,
  extractItemsFromRaw,
  findTaskFiles,
  loadSpecFile,
  readYamlFile,
} from "./yaml.js";
import { resolveTaskDataManager, TaskDataManagerError } from "./task-data-manager.js";
import { listTaskDirs, getTaskFilePath } from "./split-backend.js";
import {
  loadVerificationRecords,
  partitionVerificationReads,
} from "./verification-record-store.js";

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
  | "missing_acceptance_criteria"
  | "missing_description"
  | "status_inconsistency"
  | "missing_test_coverage"
  | "automation_eligible_no_spec"
  | "ac_schema_field_mismatch"
  | "invalid_ac_annotation"
  | "inconsistent_review_linkage"
  | "coverage_not_configured"
  | "orphaned_verification_record";

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
export type InvalidAnnotationSubtype =
  | "unresolved_target"
  | "non_spec_target"
  | "missing_ac_id"
  | "blanket_ref"
  | "malformed_ac_token";

export interface CompletenessWarning {
  type: CompletenessWarningType;
  subtype?: "own_ac" | "trait_ac" | InvalidAnnotationSubtype;
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
    skills: number;
    hooks: number;
    schedules: number;
    compositions: number;
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
  /**
   * When true, dangling references are treated as errors instead of warnings.
   * AC: @config-validation ac-2 ac-3 ac-4
   */
  strictRefs?: boolean;
  /**
   * When true, missing acceptance criteria are treated as errors instead of warnings.
   * AC: @config-validation ac-1
   */
  requireAcceptance?: boolean;
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
          path: issue.path.join("."),
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
    } else if (raw && typeof raw === "object" && "tasks" in raw) {
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
        message: "Invalid tasks file format: expected array or { tasks: [...] }",
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
            path: `tasks[${i}].${issue.path.join(".")}`,
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
 * Validate per-task directory files for schema conformance.
 *
 * Iterates ULID directories under specDir/tasks/ and validates each task.yaml
 * against TaskSchema, assembling the full record (task.yaml + notes.yaml) the
 * same way the split backend does.  Reports schema errors for malformed task
 * records instead of silently omitting them.
 *
 * AC: @validation-task-data-source ac-task-load-errors-reported
 */
async function validatePerTaskFiles(
  ctx: KspecContext,
  loadedTaskUlids: Set<string>,
): Promise<{
  errors: SchemaValidationError[];
  filesChecked: number;
  partialTasks: LoadedTask[];
}> {
  const errors: SchemaValidationError[] = [];
  const partialTasks: LoadedTask[] = [];
  let filesChecked = 0;

  let ulids: string[];
  try {
    ulids = await listTaskDirs(ctx);
  } catch {
    return { errors, filesChecked, partialTasks };
  }

  for (const ulid of ulids) {
    const taskFilePath = getTaskFilePath(ctx, ulid);
    filesChecked++;

    try {
      const rawCore = await readYamlFile<unknown>(taskFilePath);

      if (!rawCore || typeof rawCore !== "object") {
        errors.push({
          file: taskFilePath,
          path: ulid,
          message: "Invalid task file: expected a YAML object",
        });
        continue;
      }

      const rawCoreObj = rawCore as Record<string, unknown>;
      // Remove history before schema validation (same as split backend)
      const { history: _h, ...coreWithoutHistory } = rawCoreObj;

      // Read notes file (may not exist)
      let notes: unknown[] = [];
      try {
        const notesFilePath = path.join(path.dirname(taskFilePath), "notes.yaml");
        const rawNotes = await readYamlFile<unknown>(notesFilePath);
        if (rawNotes && typeof rawNotes === "object" && "notes" in rawNotes) {
          const notesWrapper = rawNotes as Record<string, unknown>;
          notes = Array.isArray(notesWrapper.notes) ? notesWrapper.notes : [];
        } else if (Array.isArray(rawNotes)) {
          notes = rawNotes;
        }
      } catch {
        // Notes file doesn't exist — zero notes
      }

      // Assemble and validate (mirrors split backend's loadTaskFromDirWithHistory)
      const assembled = { ...coreWithoutHistory, notes };
      const parsed = TaskSchema.safeParse(assembled);

      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          errors.push({
            file: taskFilePath,
            path: `${ulid}.${issue.path.join(".")}`,
            message: issue.message,
            details: issue,
          });
        }

        // AC: @validation-task-data-source ac-task-references-checked
        // AC: @validation-task-data-source ac-task-load-errors-reported
        // For tasks that failed schema validation but were NOT loaded by the canonical
        // path, extract a partial task so their reference fields still participate in
        // ref validation. Without this, a malformed task with spec_ref: "@missing-spec"
        // would silently disappear from both schema AND ref checks when loadAllTasks()
        // skips it.
        if (!loadedTaskUlids.has(ulid)) {
          const raw = assembled as Record<string, unknown>;
          const partial = {
            ...assembled,
            _ulid: ulid,
            _sourceFile: taskFilePath,
            // Ensure slugs is iterable for ReferenceIndex — malformed tasks
            // may be missing it entirely.
            slugs: Array.isArray(raw.slugs) ? raw.slugs : [],
          } as LoadedTask;
          partialTasks.push(partial);
        }
      }
    } catch (err) {
      errors.push({
        file: taskFilePath,
        message: `Failed to parse task YAML: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { errors, filesChecked, partialTasks };
}

/**
 * Validate a spec module file against schema
 */
async function validateSpecFile(filePath: string): Promise<SchemaValidationError[]> {
  const errors: SchemaValidationError[] = [];

  try {
    const raw = await readYamlFile<unknown>(filePath);

    // Recursively validate spec items
    validateSpecItemRecursive(raw, filePath, "", errors);
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
          path: issue.path.join("."),
          message: issue.message,
          details: issue,
        });
      }
      return errors;
    }

    // Validate each agent with strict ULID validation
    if (
      raw &&
      typeof raw === "object" &&
      "agents" in raw &&
      Array.isArray((raw as Record<string, unknown>).agents)
    ) {
      const agents = (raw as Record<string, unknown>).agents as unknown[];
      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        const agentResult = AgentSchema.safeParse(agent);
        if (!agentResult.success) {
          for (const issue of agentResult.error.issues) {
            errors.push({
              file: filePath,
              path: `agents[${i}].${issue.path.join(".")}`,
              message: issue.message,
              details: issue,
            });
          }
        }

        // Strict ULID validation
        if (agent && typeof agent === "object" && "_ulid" in agent) {
          const ulidResult = UlidSchema.safeParse((agent as Record<string, unknown>)._ulid);
          if (!ulidResult.success) {
            errors.push({
              file: filePath,
              path: `agents[${i}]._ulid`,
              message: "Invalid ULID format (expected 26 characters)",
            });
          }
        }
      }
    }

    // Validate each workflow with strict ULID validation
    if (
      raw &&
      typeof raw === "object" &&
      "workflows" in raw &&
      Array.isArray((raw as Record<string, unknown>).workflows)
    ) {
      const workflows = (raw as Record<string, unknown>).workflows as unknown[];
      for (let i = 0; i < workflows.length; i++) {
        const workflow = workflows[i];
        const workflowResult = WorkflowSchema.safeParse(workflow);
        if (!workflowResult.success) {
          for (const issue of workflowResult.error.issues) {
            errors.push({
              file: filePath,
              path: `workflows[${i}].${issue.path.join(".")}`,
              message: issue.message,
              details: issue,
            });
          }
        }

        // Strict ULID validation
        if (workflow && typeof workflow === "object" && "_ulid" in workflow) {
          const ulidResult = UlidSchema.safeParse((workflow as Record<string, unknown>)._ulid);
          if (!ulidResult.success) {
            errors.push({
              file: filePath,
              path: `workflows[${i}]._ulid`,
              message: "Invalid ULID format (expected 26 characters)",
            });
          }
        }
      }
    }

    // Validate each convention with strict ULID validation
    if (
      raw &&
      typeof raw === "object" &&
      "conventions" in raw &&
      Array.isArray((raw as Record<string, unknown>).conventions)
    ) {
      const conventions = (raw as Record<string, unknown>).conventions as unknown[];
      for (let i = 0; i < conventions.length; i++) {
        const convention = conventions[i];
        const conventionResult = ConventionSchema.safeParse(convention);
        if (!conventionResult.success) {
          for (const issue of conventionResult.error.issues) {
            errors.push({
              file: filePath,
              path: `conventions[${i}].${issue.path.join(".")}`,
              message: issue.message,
              details: issue,
            });
          }
        }

        // Strict ULID validation
        if (convention && typeof convention === "object" && "_ulid" in convention) {
          const ulidResult = UlidSchema.safeParse((convention as Record<string, unknown>)._ulid);
          if (!ulidResult.success) {
            errors.push({
              file: filePath,
              path: `conventions[${i}]._ulid`,
              message: "Invalid ULID format (expected 26 characters)",
            });
          }
        }
      }
    }

    // Validate each observation with strict ULID validation
    if (
      raw &&
      typeof raw === "object" &&
      "observations" in raw &&
      Array.isArray((raw as Record<string, unknown>).observations)
    ) {
      const observations = (raw as Record<string, unknown>).observations as unknown[];
      for (let i = 0; i < observations.length; i++) {
        const observation = observations[i];
        const observationResult = ObservationSchema.safeParse(observation);
        if (!observationResult.success) {
          for (const issue of observationResult.error.issues) {
            errors.push({
              file: filePath,
              path: `observations[${i}].${issue.path.join(".")}`,
              message: issue.message,
              details: issue,
            });
          }
        }

        // Strict ULID validation
        if (observation && typeof observation === "object" && "_ulid" in observation) {
          const ulidResult = UlidSchema.safeParse((observation as Record<string, unknown>)._ulid);
          if (!ulidResult.success) {
            errors.push({
              file: filePath,
              path: `observations[${i}]._ulid`,
              message: "Invalid ULID format (expected 26 characters)",
            });
          }
        }
      }
    }

    // AC: @skill-validation ac-4 - validate each skill with strict ULID validation
    if (
      raw &&
      typeof raw === "object" &&
      "skills" in raw &&
      Array.isArray((raw as Record<string, unknown>).skills)
    ) {
      const skills = (raw as Record<string, unknown>).skills as unknown[];
      for (let i = 0; i < skills.length; i++) {
        const skill = skills[i];
        const skillResult = SkillSchema.safeParse(skill);
        if (!skillResult.success) {
          for (const issue of skillResult.error.issues) {
            errors.push({
              file: filePath,
              path: `skills[${i}].${issue.path.join(".")}`,
              message: issue.message,
              details: issue,
            });
          }
        }

        // Strict ULID validation
        if (skill && typeof skill === "object" && "_ulid" in skill) {
          const ulidResult = UlidSchema.safeParse((skill as Record<string, unknown>)._ulid);
          if (!ulidResult.success) {
            errors.push({
              file: filePath,
              path: `skills[${i}]._ulid`,
              message: "Invalid ULID format (expected 26 characters)",
            });
          }
        }
      }
    }

    // AC: @dispatch-hook-schema ac-1, ac-2 - validate each hook with strict ULID validation
    if (
      raw &&
      typeof raw === "object" &&
      "hooks" in raw &&
      Array.isArray((raw as Record<string, unknown>).hooks)
    ) {
      const hooks = (raw as Record<string, unknown>).hooks as unknown[];
      for (let i = 0; i < hooks.length; i++) {
        const hook = hooks[i];
        const hookResult = HookSchema.safeParse(hook);
        if (!hookResult.success) {
          for (const issue of hookResult.error.issues) {
            errors.push({
              file: filePath,
              path: `hooks[${i}].${issue.path.join(".")}`,
              message: issue.message,
              details: issue,
            });
          }
        }

        // Strict ULID validation
        if (hook && typeof hook === "object" && "_ulid" in hook) {
          const ulidResult = UlidSchema.safeParse((hook as Record<string, unknown>)._ulid);
          if (!ulidResult.success) {
            errors.push({
              file: filePath,
              path: `hooks[${i}]._ulid`,
              message: "Invalid ULID format (expected 26 characters)",
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
  errors: SchemaValidationError[],
): void {
  if (!raw || typeof raw !== "object") return;

  // Fields that may contain nested spec items (objects with _ulid) instead of refs (strings)
  const nestedFields = [
    "modules",
    "features",
    "requirements",
    "constraints",
    "decisions",
    "traits",
    "items",
  ];

  // Check if this is a spec item (has _ulid)
  if ("_ulid" in raw) {
    // Strip nested item arrays before validation since they're processed
    // recursively and SpecItemSchema expects refs (strings), not nested objects
    const cleanedForValidation: Record<string, unknown> = {
      ...(raw as Record<string, unknown>),
    };
    for (const field of nestedFields) {
      if (field in cleanedForValidation && Array.isArray(cleanedForValidation[field])) {
        const arr = cleanedForValidation[field] as unknown[];
        const hasNestedItems = arr.some(
          (item) =>
            item && typeof item === "object" && "_ulid" in (item as Record<string, unknown>),
        );
        if (hasNestedItems) {
          delete cleanedForValidation[field];
        }
      }
    }

    const result = SpecItemSchema.safeParse(cleanedForValidation);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          file,
          path: pathPrefix ? `${pathPrefix}.${issue.path.join(".")}` : issue.path.join("."),
          message: issue.message,
          details: issue,
        });
      }
    }
  }
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
  index: ReferenceIndex,
): OrphanItem[] {
  const orphans: OrphanItem[] = [];

  // Build set of all referenced ULIDs
  const referenced = new Set<string>();

  const allItems = [...tasks, ...items];

  // Fields that contain references
  const refFields = [
    "depends_on",
    "blocked_by",
    "implements",
    "relates_to",
    "tests",
    "supersedes",
    "spec_ref",
    "context",
  ];

  for (const item of allItems) {
    const obj = item as unknown as Record<string, unknown>;

    for (const field of refFields) {
      const value = obj[field];

      if (typeof value === "string" && value.startsWith("@")) {
        const resolved = index.resolve(value);
        if (resolved.ok) {
          referenced.add(resolved.ulid);
        }
      } else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === "string" && v.startsWith("@")) {
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
  const entryPointTypes = ["module", "task", "epic", "bug", "spike", "infra"];

  for (const item of items) {
    // Only check spec items, not tasks
    if (!referenced.has(item._ulid)) {
      // Skip entry point types
      if (entryPointTypes.includes(item.type || "")) continue;

      // Skip nested items - they're implicitly referenced by their parent
      // _path indicates nesting (e.g., "features[0].requirements[2]")
      if (item._path) continue;

      orphans.push({
        ulid: item._ulid,
        title: item.title,
        type: item.type || "unknown",
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
function detectTraitCycles(items: LoadedSpecItem[], index: ReferenceIndex): TraitCycleError[] {
  const errors: TraitCycleError[] = [];
  const traits = items.filter((item) => item.type === "trait");

  // Build adjacency list: trait ULID → trait ULIDs it references
  const graph = new Map<string, string[]>();
  const traitInfo = new Map<string, { ref: string; title: string }>();

  for (const trait of traits) {
    const ref = trait.slugs?.[0] ? `@${trait.slugs[0]}` : `@${index.shortUlid(trait._ulid)}`;
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
          const cycleRefs = cycle.map((ulid) => {
            const cycleInfo = traitInfo.get(ulid);
            return cycleInfo ? cycleInfo.ref : `@${index.shortUlid(ulid)}`;
          });

          errors.push({
            traitRef: info.ref,
            traitTitle: info.title,
            cycle: cycleRefs,
            message: `Circular trait reference: ${cycleRefs.join(" → ")} → ${cycleRefs[0]}`,
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
 * Recursively find all files in a directory.
 *
 * AC: @coverage-scan-config ac-configured-paths — scan all files under configured paths
 */
async function findAllFilesRecursive(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subFiles = await findAllFilesRecursive(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read - return empty
  }

  return files;
}

/**
 * Convert a simple glob pattern to a regex for matching file paths.
 * Supports * (any non-separator chars) and ** (any chars including separators).
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any characters including path separators
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        // * matches any non-separator characters
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if (".+^${}()|[]\\".includes(ch)) {
      regex += "\\" + ch;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  return new RegExp("^" + regex + "$");
}

/**
 * Check if a file path matches any of the exclude patterns.
 * @param relPath - File path relative to rootDir
 * @param excludePatterns - Glob patterns to match against
 */
function isExcluded(relPath: string, excludePatterns: RegExp[]): boolean {
  return excludePatterns.some((re) => re.test(relPath));
}

/**
 * Map of file extensions to the AC annotation prefix regex for that language.
 *
 * AC: @coverage-scan-config ac-language-aware-parsing — comment syntax matches file language
 */
const COMMENT_PREFIX_MAP: Record<string, RegExp> = {
  // // style comments
  ".ts": /\/\/\s*AC:\s*/,
  ".js": /\/\/\s*AC:\s*/,
  ".tsx": /\/\/\s*AC:\s*/,
  ".jsx": /\/\/\s*AC:\s*/,
  ".rs": /\/\/\s*AC:\s*/,
  ".go": /\/\/\s*AC:\s*/,
  ".java": /\/\/\s*AC:\s*/,
  ".c": /\/\/\s*AC:\s*/,
  ".cpp": /\/\/\s*AC:\s*/,
  ".swift": /\/\/\s*AC:\s*/,
  ".kt": /\/\/\s*AC:\s*/,
  // # style comments
  ".py": /#\s*AC:\s*/,
  ".rb": /#\s*AC:\s*/,
  ".sh": /#\s*AC:\s*/,
  ".yaml": /#\s*AC:\s*/,
  ".yml": /#\s*AC:\s*/,
  ".toml": /#\s*AC:\s*/,
  // -- style comments
  ".lua": /--\s*AC:\s*/,
  ".sql": /--\s*AC:\s*/,
  // <!-- --> style comments
  ".html": /<!--\s*AC:\s*/,
  ".svelte": /<!--\s*AC:\s*/,
};

/**
 * Get the AC annotation line prefix regex for a given file extension.
 * Returns null for unrecognized extensions.
 *
 * AC: @coverage-scan-config ac-unrecognized-language — unrecognized extensions return null
 */
export function getACLinePrefix(ext: string): RegExp | null {
  return COMMENT_PREFIX_MAP[ext] ?? null;
}

/** Legacy constant for backward compatibility with parseACAnnotationLine tests. */
const AC_LINE_PREFIX = /\/\/\s*AC:\s*/;

/**
 * Parsed result from a single @ref group in an AC annotation line.
 */
export interface ParsedACGroup {
  specRef: string;
  acIds: string[];
  malformedTokens: string[];
}

/**
 * Parse all @ref groups from an AC annotation line.
 * Handles single and multiple @ref groups separated by commas or spaces.
 *
 * Only tokens matching the `ac-` prefix are recognized as explicit AC ids.
 * Non-prefixed words after a @ref are ignored and do NOT create AC coverage.
 * Malformed ac-prefixed tokens (e.g. ac-good.extra, ac-good/path) are detected
 * and returned in malformedTokens instead of being silently truncated.
 *
 * Examples:
 *   "// AC: @spec-a ac-1"                        → [{specRef:"@spec-a", acIds:["ac-1"], malformedTokens:[]}]
 *   "// AC: @spec-a ac-create, ac-update"        → [{specRef:"@spec-a", acIds:["ac-create","ac-update"], malformedTokens:[]}]
 *   "// AC: @spec-a ac-1, @spec-b ac-2"          → [{specRef:"@spec-a", acIds:["ac-1"], ...}, {specRef:"@spec-b", acIds:["ac-2"], ...}]
 *   "// AC: @spec-a ac-1 — N/A: reason"          → [{specRef:"@spec-a", acIds:["ac-1"], malformedTokens:[]}]
 *   "// AC: @spec-a"                             → [{specRef:"@spec-a", acIds:[], malformedTokens:[]}]  (blanket ref, no AC credit)
 *   "// AC: @spec-a validate"                    → [{specRef:"@spec-a", acIds:[], malformedTokens:[]}]  (non-prefixed token ignored)
 *   "// AC: @spec-a ac-good.extra"               → [{specRef:"@spec-a", acIds:[], malformedTokens:["ac-good.extra"]}]
 */
export function parseACAnnotationLine(
  lineText: string,
  prefix: RegExp = AC_LINE_PREFIX,
): ParsedACGroup[] {
  const prefixMatch = prefix.exec(lineText);
  if (!prefixMatch) return [];

  // Get everything after "// AC: "
  let remainder = lineText.slice(prefixMatch.index + prefixMatch[0].length);

  // Strip N/A suffix: " — N/A: ..." or " -- N/A: ..."
  remainder = remainder.replace(/\s*[—–-]{1,3}\s*N\/A\b.*$/, "");

  // Strip parenthetical comments: " (some comment)"
  remainder = remainder.replace(/\s*\(.*$/, "");

  // Tokenize by whitespace and commas — these are the only valid delimiters.
  // This preserves the full raw token text so we can detect malformed tokens
  // like "ac-good.extra" instead of silently truncating to "ac-good".
  const tokens = remainder.split(/[\s,]+/).filter((t) => t.length > 0);

  const groups: ParsedACGroup[] = [];
  let currentGroup: ParsedACGroup | null = null;

  for (const token of tokens) {
    if (token.startsWith("@")) {
      // New @ref group
      currentGroup = { specRef: token, acIds: [], malformedTokens: [] };
      groups.push(currentGroup);
    } else if (currentGroup && token.startsWith("ac-")) {
      // ac-prefixed token — validate against strict pattern
      if (acIdPattern.test(token)) {
        currentGroup.acIds.push(token);
      } else {
        currentGroup.malformedTokens.push(token);
      }
    }
    // Non-ac-prefixed, non-@ref tokens are silently ignored (e.g. bare words)
  }

  return groups;
}

/**
 * Scan a directory for AC annotations and add to the coverage set.
 * Scans all files and uses language-aware comment prefix detection.
 *
 * AC: @coverage-scan-config ac-language-aware-parsing — comment syntax matches file language
 * AC: @coverage-scan-config ac-unrecognized-language — unrecognized files are skipped
 */
async function scanDirForACAnnotations(
  dir: string,
  coveredACs: Set<string>,
  rootDir: string,
  excludePatterns: RegExp[],
): Promise<void> {
  try {
    await fs.access(dir);
  } catch {
    // Directory doesn't exist - skip
    return;
  }

  const allFiles = await findAllFilesRecursive(dir);

  for (const filePath of allFiles) {
    if (excludePatterns.length > 0) {
      const relPath = path.relative(rootDir, filePath);
      if (isExcluded(relPath, excludePatterns)) continue;
    }

    const ext = path.extname(filePath);
    const prefix = getACLinePrefix(ext);
    if (!prefix) continue; // AC: ac-unrecognized-language — skip unrecognized extensions

    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");

    for (const lineText of lines) {
      if (!prefix.test(lineText)) continue;

      const groups = parseACAnnotationLine(lineText, prefix);
      for (const { specRef, acIds } of groups) {
        for (const ac of acIds) {
          coveredACs.add(`${specRef} ${ac}`);
        }
      }
    }
  }
}

/**
 * Scan test files for AC annotations to build coverage index.
 * When scanPaths is provided (non-empty), scans those directories.
 * When scanPaths is empty or not provided, returns empty set (no scanning).
 *
 * AC: @coverage-scan-config ac-explicit-opt-in — no scanning when unconfigured
 * AC: @coverage-scan-config ac-configured-paths — scans configured directories
 *
 * @param rootDir - Project root directory
 * @param scanPaths - Directories to scan (relative to rootDir). Empty = no scanning.
 * @returns Set of covered ACs in format "@spec-ref ac-id"
 */
export async function scanTestCoverage(
  rootDir: string,
  scanPaths: string[] = [],
  excludePatterns: string[] = [],
): Promise<Set<string>> {
  const coveredACs = new Set<string>();

  // AC: ac-explicit-opt-in — no scanning when unconfigured
  if (scanPaths.length === 0) {
    return coveredACs;
  }

  const compiledExcludes = excludePatterns.map(globToRegex);

  // AC: ac-configured-paths — scan each configured path
  for (const scanPath of scanPaths) {
    await scanDirForACAnnotations(
      path.join(rootDir, scanPath),
      coveredACs,
      rootDir,
      compiledExcludes,
    );
  }
  return coveredACs;
}

/**
 * Structured AC annotation found in a test file.
 */
export interface ACAnnotation {
  /** The @slug or @ULID reference */
  specRef: string;
  /** Specific AC ids like "ac-1", "ac-2", or empty if just the ref */
  acIds: string[];
  /** Malformed ac-prefixed tokens that failed strict validation */
  malformedTokens: string[];
  /** Source file where annotation was found */
  file: string;
  /** Line number in the source file (1-based) */
  line: number;
}

/**
 * Scan a directory for structured AC annotation data.
 * Unlike scanDirForACAnnotations which only returns a Set<string>,
 * this returns full annotation details including file and line number.
 *
 * AC: @coverage-scan-config ac-language-aware-parsing — comment syntax matches file language
 * AC: @coverage-scan-config ac-unrecognized-language — unrecognized files are skipped
 */
async function scanDirForACAnnotationsStructured(
  dir: string,
  annotations: ACAnnotation[],
  rootDir: string,
  excludePatterns: RegExp[],
): Promise<void> {
  try {
    await fs.access(dir);
  } catch {
    return;
  }

  const allFiles = await findAllFilesRecursive(dir);

  for (const filePath of allFiles) {
    if (excludePatterns.length > 0) {
      const relPath = path.relative(rootDir, filePath);
      if (isExcluded(relPath, excludePatterns)) continue;
    }

    const ext = path.extname(filePath);
    const prefix = getACLinePrefix(ext);
    if (!prefix) continue; // AC: ac-unrecognized-language — skip unrecognized extensions

    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (!prefix.test(lineText)) continue;

      const groups = parseACAnnotationLine(lineText, prefix);
      for (const { specRef, acIds, malformedTokens } of groups) {
        annotations.push({
          specRef,
          acIds,
          malformedTokens,
          file: filePath,
          line: i + 1,
        });
      }
    }
  }
}

/**
 * Scan configured test directories for structured AC annotations.
 * When scanPaths is empty, returns empty array (no scanning).
 *
 * AC: @coverage-scan-config ac-explicit-opt-in — no scanning when unconfigured
 * AC: @coverage-scan-config ac-configured-paths — scans configured directories
 *
 * @param rootDir - Project root directory
 * @param scanPaths - Directories to scan (relative to rootDir). Empty = no scanning.
 */
export async function scanACAnnotations(
  rootDir: string,
  scanPaths: string[] = [],
  excludePatterns: string[] = [],
): Promise<ACAnnotation[]> {
  const annotations: ACAnnotation[] = [];

  // AC: ac-explicit-opt-in — no scanning when unconfigured
  if (scanPaths.length === 0) {
    return annotations;
  }

  const compiledExcludes = excludePatterns.map(globToRegex);

  // AC: ac-configured-paths — scan each configured path
  for (const scanPath of scanPaths) {
    await scanDirForACAnnotationsStructured(
      path.join(rootDir, scanPath),
      annotations,
      rootDir,
      compiledExcludes,
    );
  }

  return annotations;
}

/**
 * Validate AC annotations in test files.
 * Checks that:
 * 1. @slug resolves to a real spec item or trait
 * 2. ac-N exists on the resolved item's acceptance_criteria
 * 3. blanket refs without ac-* ids do not count for items that define ACs
 *
 * Returns completeness warnings for invalid annotations.
 */
export function validateACAnnotations(
  annotations: ACAnnotation[],
  items: LoadedSpecItem[],
  index: ReferenceIndex,
): CompletenessWarning[] {
  const warnings: CompletenessWarning[] = [];

  for (const annotation of annotations) {
    const { specRef, acIds, malformedTokens, file, line } = annotation;
    const relFile = path.basename(file);

    // AC: @ac-annotation-integrity-reporting ac-malformed-ac-token-reported
    // Report malformed ac-prefixed tokens before other validation
    if (malformedTokens && malformedTokens.length > 0) {
      for (const token of malformedTokens) {
        warnings.push({
          type: "invalid_ac_annotation",
          subtype: "malformed_ac_token",
          itemRef: specRef,
          itemTitle: `${relFile}:${line}`,
          message: `Malformed AC token: '${token}' in annotation targeting '${specRef}' is not a valid ac-prefixed identifier`,
          details: `${file}:${line}`,
        });
      }
    }

    // AC: @ac-annotation-integrity-reporting ac-unresolved-target-reported
    // Check if the reference resolves
    const result = index.resolve(specRef);
    if (!result.ok) {
      warnings.push({
        type: "invalid_ac_annotation",
        subtype: "unresolved_target",
        itemRef: specRef,
        itemTitle: `${relFile}:${line}`,
        message: `Unresolved target: '${specRef}' cannot be resolved`,
        details: `${file}:${line}`,
      });
      continue;
    }

    // AC: @ac-annotation-integrity-reporting ac-non-spec-target-reported
    // Find the resolved item in our loaded spec items
    const item = items.find((i) => i._ulid === result.ulid);
    if (!item) {
      // Resolved to a non-spec item (task, plan, meta) — AC annotations must target spec items or traits
      warnings.push({
        type: "invalid_ac_annotation",
        subtype: "non_spec_target",
        itemRef: specRef,
        itemTitle: `${relFile}:${line}`,
        message: `Invalid coverage target: '${specRef}' resolves but is not a spec item or trait`,
        details: `${file}:${line}`,
      });
      continue;
    }

    // AC: @ac-annotation-integrity-reporting ac-blanket-ref-does-not-cover
    if (acIds.length === 0) {
      const hasAcceptanceCriteria = (item.acceptance_criteria?.length ?? 0) > 0;
      if (hasAcceptanceCriteria) {
        warnings.push({
          type: "invalid_ac_annotation",
          subtype: "blanket_ref",
          itemRef: specRef,
          itemTitle: `${relFile}:${line}`,
          message: `Blanket ref: '${specRef}' without explicit ac-* ids does not count for coverage`,
          details: `${file}:${line}`,
        });
      }
      continue;
    }

    // AC: @ac-annotation-integrity-reporting ac-missing-ac-id-reported
    const existingACs = new Set((item.acceptance_criteria || []).map((ac) => ac.id));

    for (const acId of acIds) {
      if (!existingACs.has(acId)) {
        const itemRef = item.slugs?.[0] ? `@${item.slugs[0]}` : `@${index.shortUlid(item._ulid)}`;
        warnings.push({
          type: "invalid_ac_annotation",
          subtype: "missing_ac_id",
          itemRef,
          itemTitle: `${relFile}:${line}`,
          message: `Missing AC: '${specRef} ${acId}' — ${itemRef} has no acceptance criterion '${acId}'`,
          details: `${file}:${line}`,
        });
      }
    }
  }

  return warnings;
}

/**
 * Compute coverage status for acceptance criteria of a spec item.
 * Shared utility used by both daemon API and JSON export.
 *
 * @param item - The spec item containing acceptance_criteria
 * @param coveredACs - Set of covered AC references from scanTestCoverage()
 * @returns Array of ACs with covered field populated
 */
export function computeACCoverage<
  T extends { id: string; given: string; when: string; then: string },
>(
  item: { _ulid: string; slugs?: string[]; acceptance_criteria?: T[] },
  coveredACs: Set<string>,
): Array<T & { covered: boolean }> {
  if (!item.acceptance_criteria || item.acceptance_criteria.length === 0) {
    return [];
  }

  return item.acceptance_criteria.map((ac) => {
    const possibleRefs: string[] = [];

    // Try with primary slug
    if (item.slugs && item.slugs.length > 0) {
      possibleRefs.push(`@${item.slugs[0]} ${ac.id}`);
    }

    // Try all ULID prefix lengths (8..full) to support shortest-unique refs
    for (let prefixLength = 8; prefixLength <= item._ulid.length; prefixLength++) {
      const prefix = item._ulid.slice(0, prefixLength);
      possibleRefs.push(`@${prefix} ${ac.id}`);
    }

    const covered = possibleRefs.some((ref) => coveredACs.has(ref));
    return { ...ac, covered };
  });
}

/**
 * Check spec items for completeness
 * AC: @spec-completeness ac-1, ac-2, ac-3
 * AC: @spec-completeness-policy ac-module-exempt, ac-feature-required, ac-description-required, ac-decision-required
 * AC: @trait-validation ac-1, ac-2, ac-3
 */
async function checkCompleteness(
  items: LoadedSpecItem[],
  index: ReferenceIndex,
  rootDir: string,
  traitIndex?: TraitIndex,
  scanPaths: string[] = [],
  excludePatterns: string[] = [],
): Promise<CompletenessWarning[]> {
  const warnings: CompletenessWarning[] = [];

  // AC: @coverage-scan-config ac-unconfigured-guidance — warn when no coverage scanning configured
  // AC: @coverage-scan-config ac-no-silent-regression — guidance warning surfaces
  if (scanPaths.length === 0) {
    warnings.push({
      type: "coverage_not_configured",
      itemRef: "coverage",
      itemTitle: "Coverage Scanning",
      message:
        "AC coverage scanning is inactive — no scan paths configured. " +
        "Add a coverage.scan_paths array to kspec.config.yaml to enable AC coverage scanning. " +
        "Example:\n  coverage:\n    scan_paths:\n      - tests/",
    });
  }

  // Scan test files for AC coverage
  const coveredACs = await scanTestCoverage(rootDir, scanPaths, excludePatterns);

  for (const item of items) {
    const itemRef = item.slugs?.[0] ? `@${item.slugs[0]}` : `@${index.shortUlid(item._ulid)}`;
    const isTrait = item.type === "trait";
    const isModule = item.type === "module";

    // AC: @spec-completeness ac-1
    // AC: @spec-completeness-policy ac-module-exempt
    // AC: @spec-completeness-policy ac-feature-required
    // AC: @spec-completeness-policy ac-decision-required
    // AC: @trait-type ac-2 - Traits should have acceptance criteria for completeness
    // Check for missing acceptance criteria
    if (!isModule && (!item.acceptance_criteria || item.acceptance_criteria.length === 0)) {
      warnings.push({
        type: "missing_acceptance_criteria",
        itemRef,
        itemTitle: item.title,
        message: `${isTrait ? "Trait" : "Item"} ${itemRef} has no acceptance criteria`,
      });
    }

    // AC: @spec-completeness ac-2
    // AC: @spec-completeness-policy ac-description-required
    // AC: @trait-type ac-3 - Traits should have description for completeness
    // Check for missing description
    if (!isModule && (!item.description || item.description.trim() === "")) {
      warnings.push({
        type: "missing_description",
        itemRef,
        itemTitle: item.title,
        message: `${isTrait ? "Trait" : "Item"} ${itemRef} has no description`,
      });
    }

    // AC: @spec-completeness ac-3
    // Check for status inconsistency between parent and children
    if (item.status?.implementation === "implemented") {
      // Check if this item has children with not_started status
      const childFields = [
        "modules",
        "features",
        "requirements",
        "constraints",
        "epics",
        "themes",
        "capabilities",
      ];

      for (const field of childFields) {
        const children = (item as any)[field];
        if (Array.isArray(children)) {
          for (const child of children) {
            if (child.status?.implementation === "not_started") {
              const childRef = child.slugs?.[0]
                ? `@${child.slugs[0]}`
                : child._ulid
                  ? `@${shortestUniqueUlid(
                      child._ulid,
                      items.map((candidate) => candidate._ulid),
                    )}`
                  : "@unknown";
              warnings.push({
                type: "status_inconsistency",
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
    // AC: @coverage-scan-config ac-explicit-opt-in — only check coverage when scanning is configured
    if (scanPaths.length > 0 && item.acceptance_criteria && item.acceptance_criteria.length > 0) {
      const uncoveredACs: string[] = [];

      for (const ac of item.acceptance_criteria) {
        // Build all possible references for this AC
        const possibleRefs: string[] = [];

        // Try with primary slug
        if (item.slugs && item.slugs.length > 0) {
          possibleRefs.push(`@${item.slugs[0]} ${ac.id}`);
        }

        // Try all ULID prefix lengths (8..full) to support shortest-unique refs
        for (let prefixLength = 8; prefixLength <= item._ulid.length; prefixLength++) {
          const prefix = item._ulid.slice(0, prefixLength);
          possibleRefs.push(`@${prefix} ${ac.id}`);
        }

        // Check if any of these references are covered
        const isCovered = possibleRefs.some((ref) => coveredACs.has(ref));

        if (!isCovered) {
          uncoveredACs.push(ac.id);
        }
      }

      // Only warn if there are uncovered ACs
      if (uncoveredACs.length > 0) {
        warnings.push({
          type: "missing_test_coverage",
          subtype: "own_ac",
          itemRef,
          itemTitle: item.title,
          message: `Item ${itemRef} has ${uncoveredACs.length} AC(s) without test coverage`,
          details: `Uncovered: ${uncoveredACs.join(", ")}`,
        });
      }
    }

    // AC: @trait-validation ac-1, ac-2
    // Check for test coverage of trait acceptance criteria
    // AC: @coverage-scan-config ac-explicit-opt-in — only check coverage when scanning is configured
    if (scanPaths.length > 0 && traitIndex && item.traits && item.traits.length > 0) {
      const inheritedACs = traitIndex.getInheritedAC(item._ulid);
      const uncoveredTraitACs: Array<{ traitSlug: string; acId: string }> = [];

      for (const { trait, ac } of inheritedACs) {
        // Build all possible references for this trait AC
        const possibleRefs: string[] = [];

        // Try with trait slug
        possibleRefs.push(`@${trait.slug} ${ac.id}`);

        // Try all trait ULID prefix lengths (8..full) to support shortest-unique refs
        for (let prefixLength = 8; prefixLength <= trait.ulid.length; prefixLength++) {
          const prefix = trait.ulid.slice(0, prefixLength);
          possibleRefs.push(`@${prefix} ${ac.id}`);
        }

        // Check if any of these references are covered
        const isCovered = possibleRefs.some((ref) => coveredACs.has(ref));

        if (!isCovered) {
          uncoveredTraitACs.push({ traitSlug: trait.slug, acId: ac.id });
        }
      }

      // Only warn if there are uncovered trait ACs
      if (uncoveredTraitACs.length > 0) {
        const details = uncoveredTraitACs
          .map(({ traitSlug, acId }) => `@${traitSlug} ${acId}`)
          .join(", ");
        warnings.push({
          type: "missing_test_coverage",
          subtype: "trait_ac",
          itemRef,
          itemTitle: item.title,
          message: `Item ${itemRef} has ${uncoveredTraitACs.length} inherited trait AC(s) without test coverage`,
          details: `Uncovered trait ACs: ${details}`,
        });
      }
    }

    // AC: @trait-retrospective ac-2, ac-3
    // Check retrospective specs have required verification metadata
    const isRetrospective = item.traits?.includes("@trait-retrospective");
    if (isRetrospective) {
      const isImplementedOrVerified =
        item.status?.implementation === "implemented" || item.status?.implementation === "verified";

      // AC: @trait-retrospective ac-2
      // Retrospective specs with implemented/verified status must have verification metadata
      if (isImplementedOrVerified) {
        if (!item.verified_at || !item.verified_by) {
          warnings.push({
            type: "status_inconsistency",
            itemRef,
            itemTitle: item.title,
            message: `Retrospective spec ${itemRef} is ${item.status?.implementation} but missing verified_at/verified_by`,
            details:
              "Specs using @trait-retrospective must have verified_at and verified_by fields when marked as implemented or verified",
          });
        }
      }

      // Inverse validation: If verification metadata exists, status should be implemented/verified
      if ((item.verified_at || item.verified_by) && !isImplementedOrVerified) {
        warnings.push({
          type: "status_inconsistency",
          itemRef,
          itemTitle: item.title,
          message: `Retrospective spec ${itemRef} has verification metadata but status is not implemented/verified`,
          details:
            "Retrospective specs with verified_at/verified_by should have implementation status set to 'implemented' or 'verified'",
        });
      }
    }
  }

  return warnings;
}

// ============================================================
// AC SCHEMA DRIFT DETECTION
// ============================================================

/**
 * Known schema fields for SpecItem — derived at runtime from SpecItemSchema.shape
 * to prevent drift from the actual schema definition.
 */
const SPEC_ITEM_FIELDS = new Set(Object.keys(SpecItemSchema.shape));

/**
 * Known schema fields for Task — derived at runtime from TaskSchema.shape
 * to prevent drift from the actual schema definition.
 */
const TASK_FIELDS = new Set(Object.keys(TaskSchema.shape));

/**
 * Known fields that are referenced but are parse-time or conceptual only
 * These are common pseudo-fields that ACs reference but don't exist in schema
 */
const CONCEPTUAL_FIELDS = new Set([
  "children", // Hierarchy is parse-time only
  "parent", // Parent references are derived, not stored
  "modules", // These are container structures in YAML, not item fields
  "features",
  "requirements",
  "constraints",
  "decisions",
  "epics",
  "themes",
  "capabilities",
]);

/**
 * Extract field reference patterns from AC text
 * Looks for patterns like:
 * - item.field
 * - spec.field
 * - task.field
 * - status.field
 * - spec_ref.field
 * - the field
 * - their field
 * - item's field
 */
/**
 * File extensions to exclude from field matching
 * These are common file extensions that would otherwise match our patterns
 */
const FILE_EXTENSIONS = new Set([
  "yaml",
  "yml",
  "json",
  "js",
  "ts",
  "md",
  "txt",
  "html",
  "css",
  "log",
]);

function extractFieldReferences(text: string): Array<{ context: string; field: string }> {
  const references: Array<{ context: string; field: string }> = [];

  // Pattern: context.field (e.g., item.status, spec_ref.children)
  // This matches entity.property patterns in prose
  const dotPattern = /\b(item|spec|task|status|spec_ref|task_ref|meta_ref|plan_ref)\.(\w+)/gi;
  let match: RegExpExecArray | null;
  while ((match = dotPattern.exec(text)) !== null) {
    const field = match[2].toLowerCase();
    // Skip file extensions (e.g., spec.yaml, task.json)
    if (FILE_EXTENSIONS.has(field)) {
      continue;
    }
    references.push({ context: match[1].toLowerCase(), field });
  }

  // Pattern: "the <field>" when discussing items/tasks (common in ACs)
  // Only match known schema-like words to avoid false positives
  const thePattern =
    /\bthe\s+(status|children|parent|spec_ref|depends_on|traits|tags|notes|todos|acceptance_criteria)\b/gi;
  while ((match = thePattern.exec(text)) !== null) {
    references.push({ context: "item", field: match[1].toLowerCase() });
  }

  return references;
}

/**
 * Check if a field exists in the appropriate schema
 */
function isValidSchemaField(context: string, field: string): { valid: boolean; reason?: string } {
  // If it's a known conceptual field, it's technically invalid but we can give a specific message
  if (CONCEPTUAL_FIELDS.has(field)) {
    return {
      valid: false,
      reason: `'${field}' is a parse-time/conceptual field, not stored in schema`,
    };
  }

  // Check based on context
  switch (context) {
    case "spec":
    case "item":
      if (SPEC_ITEM_FIELDS.has(field)) {
        return { valid: true };
      }
      break;

    case "task":
      if (TASK_FIELDS.has(field)) {
        return { valid: true };
      }
      break;

    case "status":
      // status.maturity, status.implementation are valid for specs
      if (field === "maturity" || field === "implementation") {
        return { valid: true };
      }
      break;

    case "spec_ref":
    case "task_ref":
    case "meta_ref":
    case "plan_ref":
      // These are string references, not objects with fields
      return {
        valid: false,
        reason: `'${context}' is a reference string, not an object with fields`,
      };
  }

  // Check if field exists in either schema (might be ambiguous context)
  if (SPEC_ITEM_FIELDS.has(field) || TASK_FIELDS.has(field)) {
    return { valid: true };
  }

  return { valid: false, reason: `'${field}' is not a known schema field` };
}

/**
 * Check acceptance criteria for field references that don't exist in schema
 * Catches drift between spec prose and implementation reality.
 */
export function checkACSchemaReferences(items: LoadedSpecItem[]): CompletenessWarning[] {
  const warnings: CompletenessWarning[] = [];
  const itemUlids = items.map((item) => item._ulid);

  for (const item of items) {
    if (!item.acceptance_criteria || item.acceptance_criteria.length === 0) {
      continue;
    }

    const itemRef = item.slugs?.[0]
      ? `@${item.slugs[0]}`
      : `@${shortestUniqueUlid(item._ulid, itemUlids)}`;

    for (const ac of item.acceptance_criteria) {
      // Check all three parts of the AC for field references
      const textToCheck = `${ac.given} ${ac.when} ${ac.then}`;
      const fieldRefs = extractFieldReferences(textToCheck);

      for (const { context, field } of fieldRefs) {
        const result = isValidSchemaField(context, field);
        if (!result.valid) {
          warnings.push({
            type: "ac_schema_field_mismatch",
            itemRef,
            itemTitle: item.title,
            message: `AC ${ac.id} references '${context}.${field}' which doesn't exist in schema`,
            details: result.reason,
          });
        }
      }
    }
  }

  return warnings;
}

/**
 * Check the verification record store for orphaned stamps — stored stamps
 * whose owning item ULID or acceptance-criterion id no longer resolves to a
 * live criterion. Loading the store never fails on these; instead each
 * orphan surfaces as a completeness finding so it is neither silently
 * dropped nor able to fail an otherwise-valid project.
 *
 * The set of live criteria for an item is its own acceptance criteria plus
 * the acceptance criteria inherited from any traits it implements, since a
 * stamp may be keyed by an inherited trait AC id under the implementing
 * item's ULID.
 *
 * AC: @ac-verification-record-store ac-unresolvable-keys-tolerated
 */
async function checkOrphanedVerifications(
  ctx: KspecContext,
  items: LoadedSpecItem[],
  index: ReferenceIndex,
  traitIndex: TraitIndex,
): Promise<CompletenessWarning[]> {
  const records = await loadVerificationRecords(ctx);
  if (records.length === 0) {
    return [];
  }

  const itemUlids = items.map((item) => item._ulid);
  const itemsByUlid = new Map(items.map((item) => [item._ulid, item]));

  // Live criteria per item: own AC ids ∪ inherited trait AC ids.
  const validCriteria = new Map<string, Set<string>>();
  for (const item of items) {
    const acIds = new Set<string>();
    for (const ac of item.acceptance_criteria ?? []) {
      acIds.add(ac.id);
    }
    for (const { ac } of traitIndex.getInheritedAC(item._ulid)) {
      acIds.add(ac.id);
    }
    validCriteria.set(item._ulid, acIds);
  }

  const { orphans } = partitionVerificationReads(records, validCriteria);

  return orphans.map((orphan) => {
    const owningItem = itemsByUlid.get(orphan.itemUlid);
    const itemRef = owningItem?.slugs?.[0]
      ? `@${owningItem.slugs[0]}`
      : `@${shortestUniqueUlid(orphan.itemUlid, itemUlids)}`;
    const message =
      orphan.reason === "unknown_item"
        ? `Verification stamp for ${orphan.acId} references item ${orphan.itemUlid}, which no longer exists`
        : `Verification stamp references ${orphan.acId}, which no longer exists on ${itemRef}`;
    return {
      type: "orphaned_verification_record" as const,
      itemRef,
      itemTitle: owningItem?.title ?? orphan.itemUlid,
      message,
      details: `Orphaned verification record (${orphan.reason}).`,
    };
  });
}

// ============================================================
// SKILL CONTENT VALIDATION
// ============================================================

/**
 * Validate that skill meta entries have corresponding SKILL.md files.
 * AC: @skill-content-model ac-3 - missing content file reports validation error
 */
async function validateSkillContentFiles(
  ctx: KspecContext,
  skills: LoadedSkill[],
): Promise<SchemaValidationError[]> {
  const errors: SchemaValidationError[] = [];

  for (const skill of skills) {
    const contentPath = getSkillContentPath(ctx, skill.id);

    try {
      await fs.access(contentPath);
    } catch {
      // File doesn't exist - report validation error
      errors.push({
        file: skill._sourceFile || "kynetic.meta.yaml",
        path: `skills.${skill.id}`,
        message: `Skill '${skill.id}' is missing content file at ${contentPath}`,
      });
    }
  }

  return errors;
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
  index: ReferenceIndex,
): CompletenessWarning[] {
  const warnings: CompletenessWarning[] = [];
  const terminalStatuses = new Set(["completed", "cancelled"]);

  for (const task of tasks) {
    // AC: @task-automation-eligibility ac-21 — skip terminal statuses
    if (terminalStatuses.has(task.status)) continue;

    const taskRef = task.slugs?.[0] ? `@${task.slugs[0]}` : `@${index.shortUlid(task._ulid)}`;

    // AC: @task-automation-eligibility ac-21
    // Warn if eligible but no spec_ref
    if (task.automation === "eligible" && !task.spec_ref) {
      warnings.push({
        type: "automation_eligible_no_spec",
        itemRef: taskRef,
        itemTitle: task.title,
        message: `Task ${taskRef} is automation: eligible but has no spec_ref - eligible tasks should have linked specs`,
      });
    }

    // AC: @task-automation-eligibility ac-23
    // Warn if eligible but spec_ref doesn't resolve
    if (task.automation === "eligible" && task.spec_ref) {
      const specResult = index.resolve(task.spec_ref);
      if (!specResult.ok) {
        warnings.push({
          type: "automation_eligible_no_spec",
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
// SKILL VALIDATION
// ============================================================

/**
 * Validate skill depends_on references
 * AC: @skill-validation ac-2 - broken depends_on ref reports warning
 */
function validateSkillDependsOn(
  skills: LoadedSkill[],
  index: ReferenceIndex,
): RefValidationWarning[] {
  const warnings: RefValidationWarning[] = [];

  for (const skill of skills) {
    if (!skill.depends_on || skill.depends_on.length === 0) {
      continue;
    }

    for (const depRef of skill.depends_on) {
      const result = index.resolve(depRef);
      if (!result.ok) {
        warnings.push({
          ref: depRef,
          sourceFile: skill._sourceFile,
          sourceUlid: skill._ulid,
          field: "depends_on",
          warning: "deprecated_target", // Reuse warning type for broken refs
          message: `Skill '${skill.id}' depends_on reference '${depRef}' cannot be resolved`,
        });
      } else {
        // Check that the resolved item is actually a skill (uses _type discriminant)
        if (!isSkill(result.item)) {
          warnings.push({
            ref: depRef,
            sourceFile: skill._sourceFile,
            sourceUlid: skill._ulid,
            field: "depends_on",
            warning: "deprecated_target",
            message: `Skill '${skill.id}' depends_on reference '${depRef}' points to non-skill item`,
          });
        }
      }
    }
  }

  return warnings;
}

/**
 * Find orphaned skill directories (directories with no corresponding meta entry)
 * AC: @skill-validation ac-3 - orphaned directory reports warning
 */
async function findOrphanedSkillDirectories(
  ctx: KspecContext,
  skills: LoadedSkill[],
): Promise<RefValidationWarning[]> {
  const warnings: RefValidationWarning[] = [];
  const skillsDir = path.join(ctx.specDir, "skills");

  try {
    // Check if skills directory exists
    await fs.access(skillsDir);

    // Read all directories in skills/
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());

    // Build set of skill IDs from meta
    const skillIds = new Set(skills.map((s) => s.id));

    // Find orphaned directories
    for (const dir of directories) {
      if (!skillIds.has(dir.name)) {
        warnings.push({
          ref: `@${dir.name}`,
          sourceFile: path.join(skillsDir, dir.name),
          field: "directory",
          warning: "deprecated_target", // Reuse warning type
          message: `Orphaned skill directory '${dir.name}' has no corresponding meta entry`,
        });
      }
    }
  } catch {
    // Skills directory doesn't exist - that's fine
  }

  return warnings;
}

// ============================================================
// HOOK VALIDATION
// ============================================================

/**
 * Validate hook agent action references against known agents.
 * Agent refs in hooks are errors (not warnings) because they will fail at runtime.
 *
 * AC: @dispatch-hook-schema ac-3
 */
function validateHookAgentRefs(
  hooks: LoadedHook[],
  agents: { id: string }[],
): { file: string; path: string; message: string }[] {
  const errors: { file: string; path: string; message: string }[] = [];
  const knownAgentIds = new Set(agents.map((a) => a.id));

  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i];
    if (hook.action.type === "agent") {
      const agentId = hook.action.agent_id;
      if (!knownAgentIds.has(agentId)) {
        errors.push({
          file: hook._sourceFile || "kynetic.meta.yaml",
          path: `hooks[${i}].action.agent_id`,
          message: `Hook '${hook.name}' references non-existent agent '${agentId}'. Known agents: ${[...knownAgentIds].join(", ") || "(none)"}`,
        });
      }
    }
  }

  return errors;
}

/**
 * Validate hook filter fields against known fields for their event types.
 * Unknown filter fields produce warnings.
 *
 * AC: @dispatch-hook-filter ac-3
 */
function validateHookFilters(hooks: LoadedHook[]): {
  ref: string;
  sourceFile?: string;
  field: string;
  warning: "deprecated_target";
  message: string;
}[] {
  const warnings: {
    ref: string;
    sourceFile?: string;
    field: string;
    warning: "deprecated_target";
    message: string;
  }[] = [];

  for (const hook of hooks) {
    if (!hook.filter) continue;

    const filterWarnings = validateHookFilter(hook.name, hook.on, hook.filter);
    for (const w of filterWarnings) {
      warnings.push({
        ref: `@${hook.name}`,
        sourceFile: hook._sourceFile,
        field: w.field,
        warning: "deprecated_target",
        message: w.message,
      });
    }
  }

  return warnings;
}

// ============================================================
// SESSION PROMPT ACTION VALIDATION
// ============================================================

/**
 * Validate session_prompt actions in hooks for session_id availability.
 *
 * When a session_prompt action is on a session.* event, session_id is
 * available from the event context (AC: @session-prompt-action-schema ac-3).
 * When on a non-session event, an explicit session_id is required for the
 * action to succeed at runtime (AC: @session-prompt-action-schema ac-4).
 */
function validateSessionPromptActions(hooks: LoadedHook[]): {
  ref: string;
  sourceFile?: string;
  field: string;
  warning: "deprecated_target";
  message: string;
}[] {
  const warnings: {
    ref: string;
    sourceFile?: string;
    field: string;
    warning: "deprecated_target";
    message: string;
  }[] = [];

  for (const hook of hooks) {
    if (hook.action.type !== "session_prompt") continue;

    const isSessionEvent = hook.on.startsWith("session.");
    const hasExplicitSessionId = hook.action.session_id !== undefined;

    if (!isSessionEvent && !hasExplicitSessionId) {
      // AC: @session-prompt-action-schema ac-4 — warn that session_id is required
      warnings.push({
        ref: `@${hook.name}`,
        sourceFile: hook._sourceFile,
        field: "action.session_id",
        warning: "deprecated_target",
        message: `Hook '${hook.name}' uses a session_prompt action on event '${hook.on}' without an explicit session_id. Session prompt actions on non-session events require a session_id — the action will fail at runtime without one.`,
      });
    }
  }

  return warnings;
}

/**
 * Validate session_prompt actions on schedules — schedules never have session
 * event context, so session_id is always required.
 *
 * AC: @session-prompt-action ac-7
 * AC: @session-prompt-action-schema ac-4
 */
function validateScheduleSessionPromptActions(schedules: LoadedSchedule[]): {
  ref: string;
  sourceFile?: string;
  field: string;
  warning: "deprecated_target";
  message: string;
}[] {
  const warnings: {
    ref: string;
    sourceFile?: string;
    field: string;
    warning: "deprecated_target";
    message: string;
  }[] = [];

  for (const schedule of schedules) {
    if (schedule.action.type !== "session_prompt") continue;

    const hasExplicitSessionId = schedule.action.session_id !== undefined;
    if (!hasExplicitSessionId) {
      warnings.push({
        ref: `@${schedule.id}`,
        sourceFile: schedule._sourceFile,
        field: "action.session_id",
        warning: "deprecated_target",
        message: `Schedule '${schedule.name}' uses a session_prompt action without an explicit session_id. Schedules have no session event context — the action will fail at runtime without a session_id.`,
      });
    }
  }

  return warnings;
}

/**
 * Validate session_prompt actions on compositions — compositions never have
 * session event context, so session_id is always required.
 *
 * AC: @session-prompt-action ac-7
 * AC: @session-prompt-action-schema ac-4
 */
function validateCompositionSessionPromptActions(compositions: LoadedComposition[]): {
  ref: string;
  sourceFile?: string;
  field: string;
  warning: "deprecated_target";
  message: string;
}[] {
  const warnings: {
    ref: string;
    sourceFile?: string;
    field: string;
    warning: "deprecated_target";
    message: string;
  }[] = [];

  for (const composition of compositions) {
    if (composition.on_complete.type !== "session_prompt") continue;

    const hasExplicitSessionId = composition.on_complete.session_id !== undefined;
    if (!hasExplicitSessionId) {
      warnings.push({
        ref: `@${composition.id}`,
        sourceFile: composition._sourceFile,
        field: "on_complete.session_id",
        warning: "deprecated_target",
        message: `Composition '${composition.name}' uses a session_prompt on_complete action without an explicit session_id. Compositions have no session event context — the action will fail at runtime without a session_id.`,
      });
    }
  }

  return warnings;
}

// ============================================================
// SCHEDULE VALIDATION
// ============================================================

/**
 * Validate schedule agent action references against known agents.
 * Agent refs in schedules are errors (not warnings) because they will fail at runtime.
 *
 * AC: @dispatch-schedule-schema ac-3
 */
function validateScheduleAgentRefs(
  schedules: LoadedSchedule[],
  agents: { id: string }[],
): { file: string; path: string; message: string }[] {
  const errors: { file: string; path: string; message: string }[] = [];
  const knownAgentIds = new Set(agents.map((a) => a.id));

  for (let i = 0; i < schedules.length; i++) {
    const schedule = schedules[i];
    if (schedule.action.type === "agent") {
      const agentId = schedule.action.agent_id;
      if (!knownAgentIds.has(agentId)) {
        errors.push({
          file: schedule._sourceFile || "kynetic.meta.yaml",
          path: `schedules[${i}].action.agent_id`,
          message: `Schedule '${schedule.name}' references non-existent agent '${agentId}'. Known agents: ${[...knownAgentIds].join(", ") || "(none)"}`,
        });
      }
    }
  }

  return errors;
}

// ============================================================
// COMPOSITION VALIDATION
// ============================================================

/**
 * Validate composition on_complete action agent references against known agents.
 * Agent refs in compositions are errors (not warnings) because they will fail at runtime.
 *
 * AC: @dispatch-hook-schema ac-3 — reuses same pattern for composition actions
 */
function validateCompositionAgentRefs(
  compositions: LoadedComposition[],
  agents: { id: string }[],
): { file: string; path: string; message: string }[] {
  const errors: { file: string; path: string; message: string }[] = [];
  const knownAgentIds = new Set(agents.map((a) => a.id));

  for (let i = 0; i < compositions.length; i++) {
    const comp = compositions[i];
    if (comp.on_complete.type === "agent") {
      const agentId = comp.on_complete.agent_id;
      if (!knownAgentIds.has(agentId)) {
        errors.push({
          file: comp._sourceFile || "kynetic.meta.yaml",
          path: `compositions[${i}].on_complete.agent_id`,
          message: `Composition '${comp.name}' on_complete references non-existent agent '${agentId}'. Known agents: ${[...knownAgentIds].join(", ") || "(none)"}`,
        });
      }
    }
  }

  return errors;
}

// ============================================================
// TEMPLATE VARIABLE VALIDATION
// ============================================================

/**
 * Validate template variables in hook, schedule, and composition actions.
 * Unknown template variables produce warnings (not errors) because
 * they pass through unchanged at runtime (AC: @dispatch-action-model ac-8).
 *
 * AC: @dispatch-action-model ac-7 — warn on unknown template variables
 */
function validateTemplateVars(
  hooks: LoadedHook[],
  schedules: LoadedSchedule[],
  compositions: LoadedComposition[],
): {
  ref: string;
  sourceFile?: string;
  field: string;
  warning: "deprecated_target";
  message: string;
}[] {
  const warnings: {
    ref: string;
    sourceFile?: string;
    field: string;
    warning: "deprecated_target";
    message: string;
  }[] = [];

  // Validate hook action templates
  for (const hook of hooks) {
    const templates = extractActionTemplates(hook.action);
    const templateWarnings = validateActionTemplates(templates, hook.on);
    for (const w of templateWarnings) {
      warnings.push({
        ref: `@${hook.name}`,
        sourceFile: hook._sourceFile,
        field: `action.${w.variable}`,
        warning: "deprecated_target",
        message: `Hook '${hook.name}' action template references unknown variable '{{${w.variable}}}' for event type '${hook.on}'. Available fields: ${w.available_fields.join(", ")}`,
      });
    }
  }

  // Validate schedule action templates (schedules don't have an event type context
  // since they fire schedule.tick — use that as the event type)
  for (const schedule of schedules) {
    const templates = extractActionTemplates(schedule.action);
    const templateWarnings = validateActionTemplates(templates, "schedule.tick");
    for (const w of templateWarnings) {
      warnings.push({
        ref: `@${schedule.name}`,
        sourceFile: schedule._sourceFile,
        field: `action.${w.variable}`,
        warning: "deprecated_target",
        message: `Schedule '${schedule.name}' action template references unknown variable '{{${w.variable}}}' for event type 'schedule.tick'. Available fields: ${w.available_fields.join(", ")}`,
      });
    }
  }

  // Validate composition on_complete action templates (no specific event type context)
  for (const comp of compositions) {
    const templates = extractActionTemplates(comp.on_complete);
    // Compositions don't have a specific event type; validate against all known fields
    const templateWarnings = validateActionTemplates(templates);
    for (const w of templateWarnings) {
      warnings.push({
        ref: `@${comp.name}`,
        sourceFile: comp._sourceFile,
        field: `on_complete.${w.variable}`,
        warning: "deprecated_target",
        message: `Composition '${comp.name}' on_complete action template references unknown variable '{{${w.variable}}}'. Available fields: ${w.available_fields.join(", ")}`,
      });
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
  options: ValidateOptions = {},
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

  // Load tasks via canonical TaskDataManager read path when split storage is available.
  // AC: @validation-task-data-source ac-all-persisted-tasks-included
  // This ensures validation sees the same tasks that CLI, API, and dispatch consumers see.
  //
  // Legacy detection: check the manifest condition directly rather than catching
  // resolveTaskDataManager() errors. Only kynetic <1.1 projects without split storage
  // should use the legacy findTaskFiles() fallback. All other errors — including
  // TaskDataManager resolver or backend failures — must be surfaced as validation
  // findings so validation never silently diverges from the canonical task data source.
  const kyneticVersion = ctx.manifest?.kynetic;
  const storageFormat = ctx.manifest?.task_storage?.format;
  const isLegacyProject =
    kyneticVersion !== undefined && storageFormat !== "split" && parseFloat(kyneticVersion) < 1.1;

  let usedCanonicalPath = false;

  if (!isLegacyProject) {
    try {
      const tdm = resolveTaskDataManager(ctx);
      const loadedTasks = await tdm.loadAllTasks(ctx);
      for (const task of loadedTasks) {
        allTasks.push(task);
        result.stats.tasksChecked++;
      }
      usedCanonicalPath = true;
    } catch (err) {
      // AC: @validation-task-data-source ac-task-load-errors-reported
      // Surface resolver AND load errors as validation findings — do NOT
      // fall back to legacy path, which would silently diverge from the
      // canonical task data source.
      usedCanonicalPath = true;
      const message =
        err instanceof TaskDataManagerError
          ? err.message
          : `Task data manager failed to load tasks: ${err instanceof Error ? err.message : String(err)}`;
      result.schemaErrors.push({
        file: path.join(ctx.specDir, "project.tasks.yaml"),
        message,
      });
    }
  }

  if (usedCanonicalPath) {
    // Validate per-task directory files and report malformed records unconditionally.
    // AC: @validation-task-data-source ac-task-load-errors-reported
    // AC: @validation-task-data-source ac-task-references-checked
    // This must run regardless of runSchema because:
    // 1. loadAllTasks() silently skips malformed per-task records
    // 2. Without this, malformed tasks are invisible to ALL validation checks
    //    (schema, refs, orphans) — not just schema validation
    const loadedTaskUlids = new Set(allTasks.map((t) => t._ulid));
    const perTaskResult = await validatePerTaskFiles(ctx, loadedTaskUlids);
    result.schemaErrors.push(...perTaskResult.errors);
    result.stats.filesChecked += perTaskResult.filesChecked;
    // Add partial tasks (malformed records skipped by loadAllTasks) so their
    // reference fields still participate in ref validation.
    for (const partial of perTaskResult.partialTasks) {
      allTasks.push(partial);
      result.stats.tasksChecked++;
    }
  } else {
    // Legacy fallback: find *.tasks.yaml files the traditional way.
    // Used for kynetic <1.1 projects that don't have split task storage.
    const taskFiles = await findTaskFiles(ctx.rootDir);
    const specTaskFiles = await findTaskFiles(path.join(ctx.rootDir, "spec"));
    const allTaskFiles = [...new Set([...taskFiles, ...specTaskFiles])].filter(
      (f) => !f.includes("/fixtures/"),
    );

    for (const taskFile of allTaskFiles) {
      if (runSchema) {
        const taskErrors = await validateTasksFile(taskFile);
        result.schemaErrors.push(...taskErrors);
      }
      result.stats.filesChecked++;

      try {
        const raw = await readYamlFile<unknown>(taskFile);
        let taskList: unknown[] = [];

        if (Array.isArray(raw)) {
          taskList = raw;
        } else if (raw && typeof raw === "object" && "tasks" in raw) {
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
  }

  // Validate review files
  // AC: @review-record-validation ac-1, ac-2
  if (runSchema) {
    const reviewFiles = await findReviewFiles(ctx.specDir);
    for (const reviewFile of reviewFiles) {
      const reviewErrors = await validateReviewsFile(reviewFile);
      result.schemaErrors.push(...reviewErrors);
      result.stats.filesChecked++;
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
    ...metaCtx.skills, // Include skills for reference indexing
  ];

  // Load plans for reference validation
  // AC: @plan-validation ac-10
  const allPlans = await loadPlans(ctx);

  // Build reference index when any downstream check needs it.
  const needsRefIndex = runRefs || runOrphans || runCompleteness;
  if (
    needsRefIndex &&
    (allTasks.length > 0 || allItems.length > 0 || allMetaItems.length > 0 || allPlans.length > 0)
  ) {
    const index = new ReferenceIndex(allTasks, allItems, allMetaItems, allPlans);

    if (runRefs) {
      const refResult = validateRefs(index, allTasks, allItems);

      // AC: @config-validation ac-2 ac-3 — strict_refs controls error vs warning
      // When strictRefs is false, demote "not_found" ref errors to warnings
      if (options.strictRefs === false) {
        // Move not_found errors to warnings
        const notFoundErrors = refResult.errors.filter((e) => e.error === "not_found");
        const otherErrors = refResult.errors.filter((e) => e.error !== "not_found");

        result.refErrors = otherErrors;
        result.refWarnings = [
          ...refResult.warnings,
          ...notFoundErrors.map((e) => ({
            ref: e.ref,
            sourceFile: e.sourceFile,
            sourceUlid: e.sourceUlid,
            field: e.field,
            warning: "deprecated_target" as const, // Reuse existing warning type
            message: e.message,
          })),
        ];
      } else {
        // Default/strict behavior: not_found refs are errors
        result.refErrors = refResult.errors;
        result.refWarnings = refResult.warnings;
      }

      // AC: @skill-validation ac-2 - validate skill depends_on references
      const skillDependsOnWarnings = validateSkillDependsOn(metaCtx.skills, index);
      result.refWarnings.push(...skillDependsOnWarnings);

      // AC: @trait-edge-cases ac-2
      // Detect circular trait references
      result.traitCycleErrors = detectTraitCycles(allItems, index);
    }

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
      const completenessWarnings = await checkCompleteness(
        allItems,
        index,
        ctx.rootDir,
        traitIndex,
        ctx.config.coverage.scan_paths,
        ctx.config.coverage.exclude_patterns,
      );

      // AC: @task-automation-eligibility ac-21, ac-23
      // Check automation eligibility warnings for tasks
      const automationWarnings = checkAutomationEligibility(allTasks, index);
      completenessWarnings.push(...automationWarnings);

      // AC: @review-task-lifecycle-integration ac-5
      // Check review linkage consistency for pending_review tasks
      const reviews = await loadReviewRecords(ctx);
      const linkageWarnings = checkReviewLinkageConsistency(allTasks, reviews);
      for (const lw of linkageWarnings) {
        completenessWarnings.push({
          type: "inconsistent_review_linkage",
          itemRef: lw.taskRef,
          itemTitle: lw.taskTitle,
          message: lw.message,
        });
      }

      // Validate AC annotations in test files
      const annotations = await scanACAnnotations(
        ctx.rootDir,
        ctx.config.coverage.scan_paths,
        ctx.config.coverage.exclude_patterns,
      );
      const annotationWarnings = validateACAnnotations(annotations, allItems, index);
      completenessWarnings.push(...annotationWarnings);

      // AC: @ac-verification-record-store ac-unresolvable-keys-tolerated
      // Surface stored verification stamps whose item ULID or AC id no longer
      // resolves as orphaned-verification findings rather than dropping them.
      const orphanedVerifications = await checkOrphanedVerifications(
        ctx,
        allItems,
        index,
        traitIndex,
      );
      completenessWarnings.push(...orphanedVerifications);

      // AC: @config-validation ac-1 — require_acceptance promotes missing AC to errors
      if (options.requireAcceptance) {
        const missingAC = completenessWarnings.filter(
          (w) => w.type === "missing_acceptance_criteria",
        );
        const otherWarnings = completenessWarnings.filter(
          (w) => w.type !== "missing_acceptance_criteria",
        );

        // Promote missing AC warnings to schema errors
        for (const w of missingAC) {
          result.schemaErrors.push({
            file: "completeness",
            path: w.itemRef,
            message: w.message,
          });
        }

        result.completenessWarnings = otherWarnings;
      } else {
        result.completenessWarnings = completenessWarnings;
      }
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
      skills: metaCtx.skills.length,
      hooks: metaCtx.hooks.length,
      schedules: metaCtx.schedules.length,
      compositions: metaCtx.compositions.length,
    };

    // Validate meta manifest schema with strict ULID validation
    if (runSchema) {
      const metaErrors = await validateMetaManifestFile(metaManifestPath);
      // Prefix all meta errors with "meta:"
      for (const err of metaErrors) {
        err.path = err.path ? `meta:${err.path}` : "meta:";
      }
      result.schemaErrors.push(...metaErrors);
      result.stats.filesChecked++;

      // AC: @skill-content-model ac-3 - validate skill content files exist
      if (metaCtx.skills.length > 0) {
        const skillContentErrors = await validateSkillContentFiles(ctx, metaCtx.skills);
        result.schemaErrors.push(...skillContentErrors);
      }

      // AC: @skill-validation ac-3 - detect orphaned skill directories
      const orphanedSkillWarnings = await findOrphanedSkillDirectories(ctx, metaCtx.skills);
      result.refWarnings.push(...orphanedSkillWarnings);
    }

    // AC: @dispatch-hook-schema ac-3 - validate hook agent action references
    // AC: @dispatch-hook-filter ac-3 - validate hook filter fields
    if (metaCtx.hooks.length > 0) {
      const hookErrors = validateHookAgentRefs(metaCtx.hooks, metaCtx.agents);
      result.schemaErrors.push(
        ...hookErrors.map((e) => ({
          file: e.file,
          path: e.path,
          message: e.message,
        })),
      );

      const hookFilterWarnings = validateHookFilters(metaCtx.hooks);
      result.refWarnings.push(...hookFilterWarnings);

      // AC: @session-prompt-action-schema ac-4 — warn on session_prompt without session_id on non-session events
      const sessionPromptWarnings = validateSessionPromptActions(metaCtx.hooks);
      result.refWarnings.push(...sessionPromptWarnings);
    }

    // AC: @dispatch-schedule-schema ac-3 - validate schedule agent action references
    if (metaCtx.schedules.length > 0) {
      const scheduleErrors = validateScheduleAgentRefs(metaCtx.schedules, metaCtx.agents);
      result.schemaErrors.push(
        ...scheduleErrors.map((e) => ({
          file: e.file,
          path: e.path,
          message: e.message,
        })),
      );

      // AC: @session-prompt-action-schema ac-4 — warn on session_prompt without session_id on schedules
      const scheduleSessionPromptWarnings = validateScheduleSessionPromptActions(metaCtx.schedules);
      result.refWarnings.push(...scheduleSessionPromptWarnings);
    }

    // Validate composition on_complete agent action references
    if (metaCtx.compositions.length > 0) {
      const compositionErrors = validateCompositionAgentRefs(metaCtx.compositions, metaCtx.agents);
      result.schemaErrors.push(
        ...compositionErrors.map((e) => ({
          file: e.file,
          path: e.path,
          message: e.message,
        })),
      );

      // AC: @session-prompt-action-schema ac-4 — warn on session_prompt without session_id on compositions
      const compositionSessionPromptWarnings = validateCompositionSessionPromptActions(
        metaCtx.compositions,
      );
      result.refWarnings.push(...compositionSessionPromptWarnings);
    }

    // AC: @dispatch-action-model ac-7 - validate template variables in actions
    const templateWarnings = validateTemplateVars(
      metaCtx.hooks,
      metaCtx.schedules,
      metaCtx.compositions,
    );
    result.refWarnings.push(...templateWarnings);
  }

  // Set valid flag
  result.valid =
    result.schemaErrors.length === 0 &&
    result.refErrors.length === 0 &&
    result.traitCycleErrors.length === 0;

  return result;
}
