/**
 * Alignment tracking between specs and tasks.
 *
 * Provides bidirectional mapping from spec items to implementing tasks,
 * and detects alignment issues like orphaned specs or stale implementation status.
 */

import type { ImplementationStatus } from "../schema/index.js";
import type { ReferenceIndex } from "./refs.js";
import type { KspecContext, LoadedSpecItem, LoadedTask } from "./yaml.js";
import { updateSpecItem } from "./yaml.js";

// ============================================================
// TYPES
// ============================================================

/**
 * Summary of a spec item's implementation status based on linked tasks
 */
export interface SpecImplementationSummary {
  specUlid: string;
  specTitle: string;
  currentStatus: ImplementationStatus;
  expectedStatus: ImplementationStatus;
  linkedTasks: LinkedTaskSummary[];
  isAligned: boolean;
}

/**
 * Summary of a task linked to a spec item
 */
export interface LinkedTaskSummary {
  taskUlid: string;
  taskTitle: string;
  taskStatus: string;
  hasNotes: boolean;
}

/**
 * Alignment warning
 */
export interface AlignmentWarning {
  type: "orphaned_spec" | "status_mismatch" | "stale_implementation";
  specUlid?: string;
  specTitle?: string;
  taskUlid?: string;
  message: string;
}

// ============================================================
// ALIGNMENT INDEX
// ============================================================

/**
 * Index for tracking spec-task alignment.
 * Build once when loading, then query for alignment issues.
 */
export class AlignmentIndex {
  /** spec ULID → task ULIDs that reference it */
  private specToTasks = new Map<string, string[]>();

  /** task ULID → spec ULID it references */
  private taskToSpec = new Map<string, string>();

  /** All spec items by ULID */
  private specItems = new Map<string, LoadedSpecItem>();

  /** All tasks by ULID */
  private tasks = new Map<string, LoadedTask>();

  /**
   * Build index from loaded items
   */
  constructor(tasks: LoadedTask[], items: LoadedSpecItem[]) {
    // Index spec items
    for (const item of items) {
      this.specItems.set(item._ulid, item);
      this.specToTasks.set(item._ulid, []);
    }

    // Index tasks and build reverse mapping
    for (const task of tasks) {
      this.tasks.set(task._ulid, task);

      if (task.spec_ref) {
        // Store the raw ref - we'll resolve it when needed
        this.taskToSpec.set(task._ulid, task.spec_ref);
      }
    }
  }

  /**
   * Resolve task spec_refs and build the bidirectional index.
   * Must be called with a ReferenceIndex to resolve @refs.
   */
  buildLinks(refIndex: ReferenceIndex): void {
    for (const [taskUlid, specRef] of this.taskToSpec) {
      const result = refIndex.resolve(specRef);
      if (result.ok) {
        const specUlid = result.ulid;
        const existing = this.specToTasks.get(specUlid);
        if (existing) {
          existing.push(taskUlid);
        }
      }
    }
  }

  /**
   * Get tasks that implement a spec item
   */
  getTasksForSpec(specUlid: string): LoadedTask[] {
    const taskUlids = this.specToTasks.get(specUlid) || [];
    return taskUlids
      .map((ulid) => this.tasks.get(ulid))
      .filter((t): t is LoadedTask => t !== undefined);
  }

  /**
   * Get the spec item a task implements
   */
  getSpecForTask(
    taskUlid: string,
    refIndex: ReferenceIndex,
  ): LoadedSpecItem | undefined {
    const specRef = this.taskToSpec.get(taskUlid);
    if (!specRef) return undefined;

    const result = refIndex.resolve(specRef);
    if (result.ok) {
      return this.specItems.get(result.ulid);
    }
    return undefined;
  }

  /**
   * Calculate expected implementation status based on linked task statuses
   */
  calculateExpectedStatus(specUlid: string): ImplementationStatus {
    const taskUlids = this.specToTasks.get(specUlid) || [];
    if (taskUlids.length === 0) {
      return "not_started";
    }

    const tasks = taskUlids
      .map((ulid) => this.tasks.get(ulid))
      .filter((t): t is LoadedTask => t !== undefined);

    if (tasks.length === 0) {
      return "not_started";
    }

    // Check task statuses
    const hasInProgress = tasks.some((t) => t.status === "in_progress");
    const allCompleted = tasks.every((t) => t.status === "completed");
    const someCompleted = tasks.some((t) => t.status === "completed");

    if (allCompleted) {
      return "implemented";
    }
    if (hasInProgress || someCompleted) {
      return "in_progress";
    }
    return "not_started";
  }

  /**
   * Get implementation summary for a spec item
   */
  getImplementationSummary(
    specUlid: string,
  ): SpecImplementationSummary | undefined {
    const spec = this.specItems.get(specUlid);
    if (!spec) return undefined;

    const taskUlids = this.specToTasks.get(specUlid) || [];
    const linkedTasks: LinkedTaskSummary[] = taskUlids
      .map((ulid) => this.tasks.get(ulid))
      .filter((t): t is LoadedTask => t !== undefined)
      .map((t) => ({
        taskUlid: t._ulid,
        taskTitle: t.title,
        taskStatus: t.status,
        hasNotes: t.notes.length > 0,
      }));

    const currentStatus = spec.status?.implementation || "not_started";
    const expectedStatus = this.calculateExpectedStatus(specUlid);

    return {
      specUlid,
      specTitle: spec.title,
      currentStatus,
      expectedStatus,
      linkedTasks,
      isAligned: currentStatus === expectedStatus,
    };
  }

  /**
   * Find all alignment issues
   */
  findAlignmentWarnings(): AlignmentWarning[] {
    const warnings: AlignmentWarning[] = [];

    // Check each spec item
    for (const [specUlid, spec] of this.specItems) {
      const taskUlids = this.specToTasks.get(specUlid) || [];
      const currentStatus = spec.status?.implementation || "not_started";
      const expectedStatus = this.calculateExpectedStatus(specUlid);

      // Orphaned spec (no tasks)
      // AC: @trait-retrospective ac-1
      // Skip retrospective specs from orphaned warnings
      const isRetrospective = spec.traits?.includes("@trait-retrospective");
      if (
        taskUlids.length === 0 &&
        currentStatus === "not_started" &&
        !isRetrospective
      ) {
        warnings.push({
          type: "orphaned_spec",
          specUlid,
          specTitle: spec.title,
          message: `Spec item "${spec.title}" has no implementing tasks`,
        });
      }

      // Status mismatch
      if (currentStatus !== expectedStatus) {
        warnings.push({
          type: "status_mismatch",
          specUlid,
          specTitle: spec.title,
          message: `Spec "${spec.title}" status is "${currentStatus}" but should be "${expectedStatus}" based on task progress`,
        });
      }
    }

    // Check completed tasks with stale spec status
    for (const [taskUlid, task] of this.tasks) {
      if (task.status === "completed" && task.spec_ref) {
        const specRef = this.taskToSpec.get(taskUlid);
        if (specRef) {
          // Note: We already checked this via spec iteration above
          // But this provides task-centric context
        }
      }
    }

    return warnings;
  }

  /**
   * Get all spec items with their implementation summary
   */
  getAllImplementationSummaries(): SpecImplementationSummary[] {
    const summaries: SpecImplementationSummary[] = [];
    for (const specUlid of this.specItems.keys()) {
      const summary = this.getImplementationSummary(specUlid);
      if (summary) {
        summaries.push(summary);
      }
    }
    return summaries;
  }

  /**
   * Get stats about alignment
   */
  getStats(): {
    totalSpecs: number;
    specsWithTasks: number;
    alignedSpecs: number;
    orphanedSpecs: number;
  } {
    let specsWithTasks = 0;
    let alignedSpecs = 0;
    let orphanedSpecs = 0;

    for (const specUlid of this.specItems.keys()) {
      const taskUlids = this.specToTasks.get(specUlid) || [];
      if (taskUlids.length > 0) {
        specsWithTasks++;
        const summary = this.getImplementationSummary(specUlid);
        if (summary?.isAligned) {
          alignedSpecs++;
        }
      } else {
        orphanedSpecs++;
      }
    }

    return {
      totalSpecs: this.specItems.size,
      specsWithTasks,
      alignedSpecs,
      orphanedSpecs,
    };
  }
}

// ============================================================
// SYNC FUNCTIONS
// ============================================================

/**
 * Result of syncing spec implementation status
 */
export interface SyncResult {
  synced: boolean;
  specUlid: string;
  specTitle: string;
  previousStatus: ImplementationStatus;
  newStatus: ImplementationStatus;
}

/**
 * Sync a spec item's implementation status based on its linked tasks.
 * Called after task state changes (start, complete, etc.).
 *
 * @returns SyncResult if status changed, null if no change needed or no spec_ref
 */
export async function syncSpecImplementationStatus(
  ctx: KspecContext,
  task: LoadedTask,
  allTasks: LoadedTask[],
  allItems: LoadedSpecItem[],
  refIndex: ReferenceIndex,
): Promise<SyncResult | null> {
  // Skip if task has no spec_ref
  if (!task.spec_ref) {
    return null;
  }

  // Resolve the spec reference
  const result = refIndex.resolve(task.spec_ref);
  if (!result.ok) {
    return null;
  }

  // Find the spec item
  const specItem = allItems.find((item) => item._ulid === result.ulid);
  if (!specItem) {
    return null;
  }

  // Build alignment index to calculate expected status
  const alignmentIndex = new AlignmentIndex(allTasks, allItems);
  alignmentIndex.buildLinks(refIndex);

  const expectedStatus = alignmentIndex.calculateExpectedStatus(specItem._ulid);
  const currentStatus = specItem.status?.implementation || "not_started";

  // No change needed
  if (currentStatus === expectedStatus) {
    return null;
  }

  // Update the spec item
  await updateSpecItem(ctx, specItem, {
    status: {
      maturity: specItem.status?.maturity || "draft",
      implementation: expectedStatus,
    },
  });

  return {
    synced: true,
    specUlid: specItem._ulid,
    specTitle: specItem.title,
    previousStatus: currentStatus,
    newStatus: expectedStatus,
  };
}
