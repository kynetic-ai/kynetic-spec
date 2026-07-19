/**
 * Export Types
 *
 * Types for the kspec export functionality.
 * These define the structure of exported JSON snapshots and related types.
 * AC: @gh-pages-export ac-2, ac-3, ac-4
 */

import type {
  AcceptanceCriterion,
  Agent,
  Convention,
  InboxItem,
  Observation,
  ReviewRecord,
  SessionContext,
  TriageRecord,
  Workflow,
} from "../schema/index.js";
import type { ResourceMetadata } from "../schema/resources.js";
import type { ProjectedTaskResource } from "../parser/task-resource-resolver.js";
import type { LoadedSpecItem, LoadedTask } from "../parser/yaml.js";
import type { AlignmentWarning } from "../parser/alignment.js";
import type {
  CompletenessWarning,
  OrphanItem,
  SchemaValidationError,
  TraitCycleError,
} from "../parser/validate.js";
import type { RefValidationError, RefValidationWarning } from "../parser/refs.js";

export interface AlignmentResponse {
  stats: {
    totalSpecs: number;
    specsWithTasks: number;
    alignedSpecs: number;
    orphanedSpecs: number;
  };
  warnings: AlignmentWarning[];
}

/**
 * A single task resource reference projected into the static export. The base
 * shape is exactly the daemon's `resolved_resources` projection
 * (`projectResolvedTaskResources` in `src/parser/task-resource-resolver.ts`),
 * so static-mode and live-mode consumers render task resources identically;
 * the static export adds an `exported_path` pointer that is set only when the
 * reference resolves to a `present` resource whose bytes were copied (or are
 * advertised) under the static asset tree at
 * `assets/resources/task/<task-ulid>/<relative-path>`.
 *
 * Drifted, missing, and unresolved references carry their status and message
 * but never an `exported_path`: the export must not advertise an asset path
 * for bytes that do not match the task's recorded resource hash.
 *
 * AC: @static-export-resource-assets-complete ac-static-task-plan-owned-asset-uses-recorded-hash
 * AC: @static-export-resource-assets-complete ac-static-task-materialized-asset-exists
 * AC: @static-export-resource-assets-complete ac-static-task-drift-is-visible-not-rewritten
 */
export type ExportedTaskResource = ProjectedTaskResource & {
  /**
   * Snapshot-relative POSIX path under the export root:
   * `assets/resources/task/<task-ulid>/<relative-path>`. Present only for
   * `present` references whose bytes match the task's recorded hash.
   */
  exported_path?: string;
};

/**
 * Exported task with resolved spec reference title.
 * AC: @gh-pages-export ac-3
 */
export interface ExportedTask extends LoadedTask {
  /** Resolved title of the linked spec item (for display) */
  spec_ref_title?: string;
  /**
   * Task resource references resolved against the owning entity's current
   * state, with exported asset pointers for present references. Absent when
   * the task declares no resource references.
   *
   * AC: @static-export-resource-assets-complete ac-static-task-plan-owned-asset-uses-recorded-hash
   * AC: @static-export-resource-assets-complete ac-static-task-materialized-asset-exists
   * AC: @static-export-resource-assets-complete ac-static-task-drift-is-visible-not-rewritten
   */
  resolved_resources?: ExportedTaskResource[];
}

/**
 * Acceptance criterion with inheritance tracking.
 * AC: @gh-pages-export ac-4
 */
export interface InheritedAC extends AcceptanceCriterion {
  /** Reference to the trait this AC was inherited from */
  _inherited_from: string;
}

/**
 * Exported spec item with nested hierarchy and inherited ACs.
 * AC: @gh-pages-export ac-4
 */
export interface ExportedItem extends Omit<LoadedSpecItem, "acceptance_criteria"> {
  /** Own acceptance criteria */
  acceptance_criteria?: AcceptanceCriterion[];
  /** Nested child items */
  children?: ExportedItem[];
  /** Acceptance criteria inherited from traits */
  inherited_acs?: InheritedAC[];
}

/**
 * Project metadata in the snapshot.
 * AC: @gh-pages-export ac-2
 */
export interface ExportedProject {
  name: string;
  version?: string;
  description?: string;
}

/**
 * Plan-owned resource as it appears in a static export. Mirrors
 * `ResourceMetadata` plus an `exported_path` pointer to the copied file
 * location under the export root, using the standard layout
 * `assets/resources/plan/<plan-ulid>/<relative-path>`.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 */
export interface ExportedPlanResource {
  id: string;
  label: string | null;
  path: string;
  content_type: string;
  bytes: number;
  sha256: string;
  git_commit: string | null;
  git_path: string | null;
  description: string | null;
  exported_path: string;
}

/**
 * Exported plan with computed progress for static display.
 * AC: @gh-pages-export ac-23
 */
export interface ExportedPlan {
  _ulid: string;
  slugs: string[];
  title: string;
  status: string;
  created_at: string;
  approved_at?: string;
  completed_at?: string;
  derived_specs: string[];
  derived_tasks: string[];
  spec_count: number;
  task_count: number;
  task_progress: {
    total: number;
    completed: number;
    in_progress: number;
    pending: number;
    blocked: number;
  };
  content: string;
  /**
   * Declared plan-owned resources with exported file paths. Empty when the
   * plan has no resources or when its manifest is absent.
   *
   * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
   * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
   */
  resources: ExportedPlanResource[];
}

/**
 * A single review resource in the exported snapshot. Mirrors the runtime
 * `ResourceMetadata` shape and adds the snapshot-relative `exported_path`
 * pointer that consumers (web UI in static mode, agents reading the
 * snapshot offline) follow to fetch resource bytes.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 */
export interface ExportedReviewResource extends ResourceMetadata {
  /**
   * Snapshot-relative path under the export root using POSIX separators:
   * `assets/resources/review/<review-ulid>/<relative-path>`.
   */
  exported_path: string;
}

/**
 * Bounded review projection included in the static export. The shape
 * mirrors the lean index entry the daemon stores (no full thread or
 * verdict bodies, no resource file bytes) plus the per-review resources
 * array so the static UI can render evidence without depending on a live
 * daemon.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 * AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 */
export interface ExportedReview {
  _ulid: string;
  slugs: string[];
  title: string;
  lifecycle_state: ReviewRecord["lifecycle_state"];
  author: string;
  subject: ReviewRecord["subject"];
  related_refs: string[];
  external_links: ReviewRecord["external_links"];
  created_at: string;
  updated_at: string | null;
  examined_commit: string | null;
  disposition: string;
  resources: ExportedReviewResource[];
}

/**
 * Validation result included in the snapshot.
 * AC: @gh-pages-export ac-5
 */
export interface ExportedValidation {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  schemaErrors: SchemaValidationError[];
  refErrors: RefValidationError[];
  refWarnings: RefValidationWarning[];
  orphans: OrphanItem[];
  completenessWarnings: CompletenessWarning[];
  traitCycles: TraitCycleError[];
  errors: Array<{
    file: string;
    message: string;
    path?: string;
  }>;
  warnings: Array<{
    file: string;
    message: string;
  }>;
}

/**
 * Full kspec snapshot structure.
 * AC: @gh-pages-export ac-2
 */
export interface KspecSnapshot {
  /** kspec version that generated this snapshot */
  version: string;
  /** ISO timestamp when the snapshot was exported */
  exported_at: string;
  /** Project metadata */
  project: ExportedProject;
  /** All tasks with resolved spec references */
  tasks: ExportedTask[];
  /** All spec items with hierarchy and inherited ACs */
  items: ExportedItem[];
  /** Inbox items */
  inbox: InboxItem[];
  /** Plans for static plans/specs/tasks filtering */
  plans?: ExportedPlan[];
  /**
   * Reviews exported as a bounded projection with linked resource metadata
   * pointing at copied asset paths.
   *
   * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
   * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
   */
  reviews?: ExportedReview[];
  /** Triage records for static triage browsing */
  triage?: TriageRecord[];
  /** Session context */
  session: SessionContext | null;
  /** Observations */
  observations: Observation[];
  /** Agents */
  agents: Agent[];
  /** Workflows */
  workflows: Workflow[];
  /** Conventions */
  conventions: Convention[];
  /** Validation results (optional) */
  validation?: ExportedValidation;
  /** Alignment stats and warnings for static validate view */
  alignment?: AlignmentResponse;
}

/**
 * Options for the export command.
 */
export interface ExportOptions {
  /** Output format */
  format: "json" | "html";
  /** Output path (optional, defaults to stdout for json) */
  output?: string;
  /** Include validation results */
  includeValidation?: boolean;
  /** Dry run - show stats without writing */
  dryRun?: boolean;
}

/**
 * Statistics shown during dry-run.
 * AC: @gh-pages-export ac-7
 */
export interface ExportStats {
  taskCount: number;
  itemCount: number;
  inboxCount: number;
  planCount: number;
  reviewCount: number;
  reviewResourceCount: number;
  triageCount: number;
  observationCount: number;
  agentCount: number;
  workflowCount: number;
  conventionCount: number;
  estimatedSizeBytes: number;
}
