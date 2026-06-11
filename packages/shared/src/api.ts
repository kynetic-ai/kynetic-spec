/**
 * API Response Types
 *
 * Shared types and Zod runtime schemas for REST API responses between daemon and web-ui.
 * These define the contract for HTTP endpoints — both compile-time types and runtime validation.
 */

import { z } from "zod";

// ─── Unified Response Envelope ──────────────────────────────────────────────
// AC: @api-contract ac-envelope
// AC: @api-contract ac-cache-status-field

/**
 * Zod schema for cache readiness state.
 * "ready" — cache is populated, data is current.
 * "loading" — cache is warming, data is empty/default.
 * AC: @api-contract ac-cache-status-field
 */
export const CacheStatusSchema = z.enum(["ready", "loading"]);

/**
 * Cache readiness state for API response metadata.
 */
export type CacheStatus = z.infer<typeof CacheStatusSchema>;

/**
 * Zod schema for API response metadata.
 * Always includes cache_status. Pagination fields are present only
 * for list/paginated endpoints.
 * AC: @api-contract ac-envelope
 */
export const ApiResponseMetaSchema = z.object({
  cache_status: CacheStatusSchema,
  total: z.number().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

/**
 * Metadata for API response envelope.
 */
export type ApiResponseMeta = z.infer<typeof ApiResponseMetaSchema>;

/**
 * Creates a Zod schema for the unified API response envelope with a typed data payload.
 * Use: `ApiResponseSchema(z.array(TaskSummarySchema))` for list endpoints.
 * AC: @api-contract ac-envelope
 * AC: @api-contract ac-cache-status-field
 */
export function ApiResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    meta: ApiResponseMetaSchema,
  });
}

/**
 * Unified API response envelope.
 * All cache-backed endpoints return this shape.
 * `data` is the typed payload (array for lists, object for detail/aggregation).
 * `meta` carries cache readiness and optional pagination.
 */
export interface ApiResponse<T> {
  data: T;
  meta: ApiResponseMeta;
}

/**
 * Common paginated response wrapper
 * AC: @api-contract ac-4
 * @deprecated Use ApiResponse<T[]> with pagination fields in meta instead.
 * Kept for backward compatibility during route migration.
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Standard error response
 * AC: @api-contract ac-22, ac-23, ac-24
 * AC: @api-contract ac-task-storage-incompatibility-error-code
 * AC: @api-contract ac-task-storage-incompatibility-guidance
 * AC: @api-contract ac-task-storage-incompatibility-field-context
 * AC: @api-contract ac-task-storage-incompatibility-cache-domain-context
 * AC: @api-contract ac-task-storage-incompatibility-cache-state-context
 */
export interface ErrorResponse {
  error: string;
  message?: string;
  suggestion?: string;
  details?: Array<{ field: string; message: string }>;
  current?: string;
  valid_transitions?: string[];
  /**
   * Inner stable error code identifying the specific failure class. Used by
   * task-storage incompatibility responses to preserve the underlying
   * TaskDataManagerError code (e.g. "legacy_task_storage_removed",
   * "split_task_storage_unmigrated") even when the top-level `error`
   * collapses them into a single API discriminator.
   */
  code?: string;
  /**
   * Affected configuration or storage field when the failure identifies one
   * (e.g. "task_storage.format" for task-storage incompatibility errors).
   * Distinct from `details[].field`, which is reserved for per-field
   * validation diagnostics on 400/422 responses.
   */
  field?: string;
  /**
   * Identifies the cache domain associated with the failure when the error
   * is tied to a cache-backed domain (e.g. "tasks").
   */
  cache_domain?: string;
  /**
   * Current state of the affected cache domain when the daemon can report
   * one. Mirrors the daemon's internal DomainState enum
   * ("unloaded" | "loading" | "ready" | "degraded"). Distinct from the
   * envelope `meta.cache_status`, which only exposes "ready" | "loading".
   */
  cache_domain_state?: string;
  /**
   * Logical entity domain for storage-incompatibility responses
   * ("plans" | "reviews" | "resources"). Set on entity-storage 409
   * responses so clients can present domain-specific recovery UI.
   *
   * AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
   */
  domain?: string;
  /**
   * The project manifest's literal declared format version, set on
   * format-version incompatibility responses (project data written by a
   * newer kspec than this daemon supports).
   *
   * AC: @data-format-forward-compatibility ac-daemon-structured-error
   */
  declared_version?: string;
  /**
   * The running daemon's maximum supported format version, paired with
   * `declared_version` on format-version incompatibility responses.
   *
   * AC: @data-format-forward-compatibility ac-daemon-structured-error
   */
  max_supported_version?: string;
}

/**
 * Resolved reference entry with title and status
 * AC: @ui-api-ref-resolution ac-2
 */
export interface ResolvedRefEntry {
  ref: string;
  title: string | null;
  status: string | null;
}

/**
 * Task summary for list endpoints
 * AC: @api-contract ac-2
 * AC: @ui-api-ref-resolution ac-1 — spec_title resolved server-side
 */
export interface TaskSummary {
  _ulid: string;
  slugs: string[];
  title: string;
  type: string;
  status: string;
  priority: number;
  spec_ref?: string;
  /** Resolved title for spec_ref. Null if ref cannot be resolved. */
  spec_title?: string | null;
  tags: string[];
  depends_on: string[];
  automation?: string;
  created_at: string;
  started_at?: string;
  notes_count: number;
  todos_count?: number;
}

/**
 * Resolved task resource projection for task detail responses.
 *
 * One entry per derived `resource_refs` entry, re-resolved against the owning
 * entity's current manifest so drift is visible on every consumer surface
 * (CLI `--json`, agent context, daemon task detail). Mirrors the structured
 * output of `projectResolvedTaskResources` in
 * `src/parser/task-resource-resolver.ts` — never embeds resource bytes.
 * `content_type`/`byte_size`/`current_sha256`/`current_git_commit` come from
 * the owner's current manifest entry and are null when the reference is
 * `missing` (path no longer declared) or `unresolved` (owner not found).
 * Browser-fetchable bytes are addressed via `TaskDetail.resources_base_url`
 * (`${base}/${encodeURIComponent(id)}/bytes`), not a per-entry URL.
 *
 * AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
 * AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
 */
export interface ResolvedTaskResourceSummary {
  owner_type: "plan" | "task";
  owner_ref: string;
  id: string;
  path: string;
  content_type: string | null;
  byte_size: number | null;
  status: "present" | "drift" | "missing" | "unresolved";
  recorded_sha256: string;
  current_sha256: string | null;
  recorded_git_commit: string | null;
  current_git_commit: string | null;
  message: string;
}

/**
 * Full task with notes and todos
 * AC: @api-contract ac-5
 * AC: @ui-task-board ac-3 — description, plan_ref, session_ref for detail modal
 * AC: @ui-api-ref-resolution ac-1, ac-2 — resolved titles for refs
 */
export interface TaskDetail extends TaskSummary {
  description?: string;
  derivation?: string;
  blocked_by: string[];
  depends_on: string[];
  /** Resolved depends_on entries with titles and status */
  resolved_depends_on?: ResolvedRefEntry[];
  /** Resolved blocked_by entries with titles and status */
  resolved_blocked_by?: ResolvedRefEntry[];
  context: string[];
  vcs_refs: string[];
  plan_ref?: string;
  /** Resolved title for plan_ref. Null if ref cannot be resolved. */
  plan_title?: string | null;
  /** Current review record linked to this task. AC: @review-records-web-ui ac-7 */
  review_ref?: string | null;
  session_ref?: string;
  notes: Note[];
  todos?: Todo[];
  notes_count: number;
  todos_count?: number;
  /**
   * Resolved task resource references with drift status. Present only on
   * detail responses when the task has one or more derived `resource_refs`;
   * omitted entirely otherwise. Index-tier surfaces (task list, dashboard)
   * never carry this field so resource bytes/manifests stay off the index.
   *
   * AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
   */
  resolved_resources?: ResolvedTaskResourceSummary[];
  /**
   * Task-scoped base URL clients use to fetch resolved-resource bytes via
   * `${resources_base_url}/${encodeURIComponent(id)}/bytes` without guessing
   * whether the resource is plan-owned or task-owned. Present alongside
   * `resolved_resources` (i.e. only when the task has derived resources).
   *
   * AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resource-base-url
   */
  resources_base_url?: string;
}

/**
 * Task note
 */
export interface Note {
  _ulid: string;
  created_at: string;
  author: string;
  content: string;
  supersedes?: string;
}

/**
 * Task todo
 * Matches TodoSchema: id, text, done, done_at, added_at, added_by, promoted_to
 */
export interface Todo {
  id: number;
  text: string;
  done: boolean;
  done_at?: string;
  added_at: string;
  added_by?: string;
  promoted_to?: string;
}

/**
 * Spec item summary for list endpoints
 * AC: @api-contract ac-8
 */
export interface ItemSummary {
  _ulid: string;
  slugs: string[];
  title: string;
  type: string;
  status?: string;
  tags: string[];
  parent?: string;
  created_at: string;
  /** Optional summary count used by validation views. */
  acceptance_criteria_count?: number;
}

/**
 * Full spec item with ACs and traits
 * AC: @api-contract ac-10
 */
export interface ItemDetail extends ItemSummary {
  description?: string;
  acceptance_criteria: AcceptanceCriterion[];
  traits: string[];
  depends_on: string[];
  priority?: number;
}

/**
 * Acceptance criterion
 */
export interface AcceptanceCriterion {
  _ulid: string;
  given: string;
  when: string;
  then: string;
  /** Test coverage status: true=covered, false=not covered, undefined=unknown */
  covered?: boolean;
}

/**
 * Inbox item
 * AC: @api-contract ac-12
 */
export interface InboxItem {
  _ulid: string;
  text: string;
  tags: string[];
  added_by: string;
  created_at: string;
}

/**
 * Session context
 * AC: @api-contract ac-15
 */
export interface SessionContext {
  focus?: string;
  threads: string[];
  open_questions: string[];
  updated_at: string;
}

/**
 * Agent definition
 * AC: @api-contract ac-16
 */
export interface Agent {
  _ulid: string;
  slugs: string[];
  role: string;
  status: string;
  capabilities: string[];
  constraints: string[];
}

/**
 * Workflow definition
 * AC: @api-contract ac-17
 */
export interface Workflow {
  _ulid: string;
  id: string;
  trigger: string;
  description?: string;
  steps: WorkflowStep[];
  enforcement?: "advisory" | "strict";
  mode?: "interactive" | "loop";
  based_on?: string;
  tags?: string[];
}

/**
 * Workflow step
 */
export interface WorkflowStep {
  type: "action" | "check" | "decision";
  content: string;
  on_fail?: string;
  options?: string[];
}

/**
 * Observation
 * AC: @api-contract ac-18
 */
export interface Observation {
  _ulid: string;
  type: "friction" | "success" | "question" | "idea";
  content: string;
  context?: string;
  created_at: string;
  resolved?: boolean;
  resolution?: string;
}

/**
 * Plan-owned resource metadata returned by the daemon API.
 *
 * Exact mirror of `ResourceMetadata` from `src/schema/resources.ts` — strict
 * 9-field shape with no embedded URLs. Safe fetch URLs are exposed outside
 * the metadata object via `PlanDetail.resources_base_url` (consumers
 * construct `${base}/${encodeURIComponent(id)}/bytes`), keeping the
 * resource metadata shape identical across CLI, API, and static export
 * surfaces.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export interface PlanResourceMetadata {
  id: string;
  label: string | null;
  path: string;
  content_type: string;
  bytes: number;
  sha256: string;
  git_commit: string | null;
  git_path: string | null;
  description: string | null;
}

/**
 * Bounded resource summary projected through the plan index — counts only,
 * never resource bytes. Surfaced on list responses (including the cache-ready
 * fast path) so resource-bearing plans are visible without loading the full
 * per-plan resource manifest.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export interface PlanResourceSummary {
  count: number;
  total_bytes: number;
}

/**
 * Plan summary for list endpoints
 * AC: @ui-plans-view ac-1
 */
export interface PlanSummary {
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
  /**
   * Bounded resource summary from the plan index. Always populated on list
   * responses — `{ count: 0, total_bytes: 0 }` when the plan has no
   * declared resources — so list/dashboard views can show resource presence
   * without loading the per-plan manifest.
   *
   * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
   * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
   */
  resource_summary?: PlanResourceSummary;
}

/**
 * Plan detail with content for expand/detail views
 * AC: @ui-plans-view ac-2
 */
export interface PlanDetail extends PlanSummary {
  content: string;
  /** Declared plan-owned resources. Always populated for detail responses. */
  resources: PlanResourceMetadata[];
  /**
   * Base URL prefix for per-resource fetches. Clients construct
   * `${resources_base_url}/${encodeURIComponent(id)}/bytes` to retrieve a
   * specific resource. Always populated for detail responses; static
   * exports populate it with the asset-prefix equivalent so consumers can
   * keep building URLs uniformly.
   *
   * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
   */
  resources_base_url: string;
}

/**
 * Byte-free plan resource context attached to markdown sections of
 * `GET /api/reviews/:id/content` for plan review subjects.
 *
 * Carries exactly what a client needs to rewrite author-style
 * `./resources/<relative-path>` markdown targets in the embedded plan content:
 * the owning plan ref, the plan-scoped bytes base URL (clients construct
 * `${resources_base_url}/${encodeURIComponent(id)}/bytes`, appending
 * selected-project routing context browser-side), and the declared resource
 * metadata (same strict byte-free shape as `PlanDetail.resources`). Only
 * declared resources appear, so undeclared/unsafe paths cannot be rewritten.
 *
 * AC: @review-content-diff-api ac-5
 */
export interface ReviewContentPlanResourceContext {
  owner_type: "plan";
  /** The owning plan ref (the review subject ref). */
  owner_ref: string;
  /** Plan-scoped bytes base URL, e.g. `/api/plans/<ulid>/resources`. */
  resources_base_url: string;
  /** Bounded declared-resource metadata from the plan manifest — never bytes. */
  resources: PlanResourceMetadata[];
}

/**
 * Byte-free task resource context attached to the task-description markdown
 * section of `GET /api/reviews/:id/content` for task review subjects.
 *
 * Mirrors the task detail contract (`TaskDetail.resolved_resources` +
 * `TaskDetail.resources_base_url`): the resolved projection reports drift
 * status per reference (plan-owned refs and materialized task-owned copies
 * alike), so clients rewrite only `present` resources and surface actionable
 * status for drifted/missing/unresolved/unmatched references instead of
 * silently serving replacement bytes.
 *
 * AC: @review-content-diff-api ac-6
 */
export interface ReviewContentTaskResourceContext {
  owner_type: "task";
  /** The owning task ref (the review subject ref). */
  owner_ref: string;
  /** Task-scoped bytes base URL, e.g. `/api/tasks/<ulid>/resources`. */
  resources_base_url: string;
  /** Bounded resolved-resource status projection — never bytes. */
  resources: ResolvedTaskResourceSummary[];
}

/**
 * Resource context a review-content markdown section may carry so embedded
 * plan content / task descriptions can resolve `./resources/<relative-path>`
 * markdown targets exactly like the plan/task detail views.
 *
 * AC: @review-content-diff-api ac-5
 * AC: @review-content-diff-api ac-6
 */
export type ReviewContentResourceContext =
  | ReviewContentPlanResourceContext
  | ReviewContentTaskResourceContext;

/**
 * Review summary for list endpoints and task detail integration
 * AC: @review-records-daemon-api ac-1
 * AC: @review-records-web-ui ac-1
 * AC: @review-records-web-ui ac-7
 */
export interface ReviewSummary {
  _ulid: string;
  slugs: string[];
  title: string;
  lifecycle_state: string;
  disposition: string;
  subject_type: string;
  subject_ref?: string;
  /** Code-review grouping key for revision navigation. */
  head_branch?: string;
  author: string;
  related_refs: string[];
  /** Linked task ref (from subject_ref for task reviews, or first related_ref) */
  task_ref?: string;
  /** Resolved task title */
  task_title?: string | null;
  thread_count: number;
  unresolved_blocker_count: number;
  check_count: number;
  verdict_count: number;
  created_at: string;
  updated_at?: string;
}

/**
 * Review thread entry (individual comment within a thread)
 * AC: @review-records-web-ui ac-2
 * AC: @review-records-web-ui ac-9
 */
export interface ReviewThreadEntry {
  _ulid: string;
  author: string;
  body: string;
  created_at: string;
}

/**
 * Review anchor — locates a thread within a specific file or structured content
 * AC: @review-records-web-ui ac-2
 */
export type ReviewAnchor =
  | {
      type: "code";
      path: string;
      side: "base" | "head";
      line_start: number;
      line_end: number;
      commit: string;
    }
  | {
      type: "structured";
      section?: string;
      field?: string;
      path?: string;
      ref?: string;
    };

/**
 * Review thread with entries and resolution state
 * AC: @review-records-web-ui ac-2
 */
export interface ReviewThread {
  _ulid: string;
  kind: "blocker" | "question" | "nit";
  anchor?: ReviewAnchor;
  entries: ReviewThreadEntry[];
  resolved_at?: string | null;
  resolved_by?: string | null;
}

/**
 * Subject version for checks and verdicts
 */
export type ReviewSubjectVersion =
  | { type: "code_compare"; base_commit: string; head_commit: string }
  | { type: "entity_version"; content_hash: string };

/**
 * Review check result
 * AC: @review-records-web-ui ac-2
 */
export interface ReviewCheck {
  name: string;
  status: "pass" | "fail" | "running" | "skipped";
  required: boolean;
  runner?: string;
  evidence?: string;
  applies_to_version: ReviewSubjectVersion;
  created_at: string;
  completed_at?: string | null;
}

/**
 * Review verdict
 * AC: @review-records-web-ui ac-2
 */
export interface ReviewVerdict {
  reviewer: string;
  role: string;
  decision: "approve" | "request_changes" | "comment";
  applies_to_version: ReviewSubjectVersion;
  created_at: string;
}

/**
 * Review subject binding
 * AC: @review-records-web-ui ac-2
 */
export type ReviewSubject =
  | {
      type: "code";
      base_commit: string;
      head_commit: string;
      merge_base_commit?: string;
      base_branch?: string;
      head_branch?: string;
    }
  | { type: "plan"; ref: string; shadow_commit: string; content_hash: string }
  | { type: "task"; ref: string; shadow_commit: string; content_hash: string }
  | { type: "spec"; ref: string; shadow_commit: string; content_hash: string }
  | { type: "external"; url: string; external_id?: string; provider?: string };

/**
 * Metadata for one declared review resource. Mirrors the on-disk
 * `ResourceMetadata` shape so the same envelope can be returned by every
 * surface (CLI JSON, daemon JSON, static export).
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export interface ReviewResource {
  id: string;
  label: string | null;
  path: string;
  content_type: string;
  bytes: number;
  sha256: string;
  git_commit: string | null;
  git_path: string | null;
  description: string | null;
  /**
   * Snapshot-relative path used by static exports
   * (`assets/resources/review/<ulid>/<relative-path>`). Present only on
   * responses that come from the static export; absent on live daemon
   * responses since the daemon serves resource bytes via the
   * `/api/reviews/:ref/resources/:id/bytes` endpoint.
   *
   * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
   */
  exported_path?: string;
}

/**
 * Full review detail for the detail endpoint
 * AC: @review-records-daemon-api ac-2
 * AC: @review-records-web-ui ac-2
 */
export interface ReviewDetail {
  _ulid: string;
  slugs: string[];
  title: string;
  lifecycle_state: string;
  disposition: string;
  subject: ReviewSubject;
  author: string;
  related_refs: string[];
  threads: ReviewThread[];
  checks: ReviewCheck[];
  verdicts: ReviewVerdict[];
  events: Array<{
    _ulid: string;
    event_type: string;
    actor: string;
    timestamp: string;
    payload: Record<string, unknown>;
  }>;
  notes: Array<{
    author: string;
    body: string;
    created_at: string;
  }>;
  external_links: Array<{
    url: string;
    provider?: string;
    external_id?: string;
    label?: string;
  }>;
  examined_commit: string | null;
  created_at: string;
  updated_at?: string | null;
  /**
   * Declared local resources for this review. Always present on responses
   * returned by the daemon and static export. The order matches the
   * on-disk `resources.yaml` manifest order so consumers can render a
   * stable list without re-sorting.
   *
   * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
   * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
   */
  resources?: ReviewResource[];
}

export interface BatchSpecItemSummary {
  kind: "item";
  ulid: string;
  slugs: string[];
  title: string;
  type: string;
  status?: string;
  maturity?: string;
  traits: string[];
  ac_count: number;
}

export interface BatchTaskSummary {
  kind: "task";
  ulid: string;
  slugs: string[];
  title: string;
  status: string;
  priority: number;
  spec_ref?: string;
  assignee?: string;
}

export type BatchItemSummary = BatchSpecItemSummary | BatchTaskSummary;

export interface BatchItemsResponse {
  items: BatchItemSummary[];
  unresolved: string[];
}

/**
 * Search result
 * AC: @api-contract ac-19
 * AC: @web-dashboard ac-24
 */
export interface SearchResult {
  type: "item" | "task" | "inbox" | "observation" | "agent" | "workflow" | "convention";
  ulid: string;
  title: string;
  matchedFields: string[];
}

/**
 * Search response
 * AC: @api-contract ac-19
 * AC: @web-dashboard ac-24
 */
export interface SearchResponse {
  results: SearchResult[];
  total: number;
  showing: number;
}

/**
 * Validation error
 */
export interface ValidationError {
  file: string;
  field: string;
  message: string;
  ref?: string;
}

/**
 * Validation warning
 */
export interface ValidationWarning {
  file: string;
  message: string;
  ref?: string;
}

export interface SchemaValidationError {
  file: string;
  path?: string;
  message: string;
  details?: unknown;
}

export interface RefValidationError {
  ref: string;
  sourceFile?: string;
  sourceUlid?: string;
  field: string;
  error: "not_found" | "ambiguous" | "duplicate_slug";
  message: string;
}

export interface RefValidationWarning {
  ref: string;
  sourceFile?: string;
  sourceUlid?: string;
  field: string;
  warning: "deprecated_target";
  message: string;
}

export interface OrphanItem {
  ulid: string;
  title: string;
  type: string;
  file?: string;
}

export type CompletenessWarningType =
  | "missing_acceptance_criteria"
  | "missing_description"
  | "status_inconsistency"
  | "missing_test_coverage"
  | "automation_eligible_no_spec"
  | "ac_schema_field_mismatch";

export interface CompletenessWarning {
  type: CompletenessWarningType;
  subtype?: "own_ac" | "trait_ac";
  itemRef: string;
  itemTitle: string;
  message: string;
  details?: string;
}

export interface TraitCycleError {
  traitRef: string;
  traitTitle: string;
  cycle: string[];
  message: string;
}

/**
 * Validation result
 * AC: @api-contract ac-20
 */
export interface ValidationResult {
  valid: boolean;
  schemaErrors: SchemaValidationError[];
  refErrors: RefValidationError[];
  refWarnings: RefValidationWarning[];
  orphans: OrphanItem[];
  completenessWarnings: CompletenessWarning[];
  traitCycles: TraitCycleError[];
}

/**
 * Alignment index stats
 * AC: @api-contract ac-21
 */
export interface AlignmentStats {
  totalSpecs: number;
  specsWithTasks: number;
  alignedSpecs: number;
  orphanedSpecs: number;
}

export interface AlignmentWarning {
  type: "orphaned_spec" | "status_mismatch" | "stale_implementation";
  specUlid?: string;
  specTitle?: string;
  taskUlid?: string;
  message: string;
}

export interface AlignmentResponse {
  stats: AlignmentStats;
  warnings: AlignmentWarning[];
}

/**
 * Convention definition from meta manifest
 */
export interface Convention {
  _ulid: string;
  domain: string;
  rules: string[];
  examples?: Array<{ good: string; bad: string }>;
  validation?: {
    type: "regex" | "enum" | "range" | "prose";
    pattern?: string;
    message?: string;
    allowed?: string[];
    min?: number;
    max?: number;
    unit?: "words" | "chars" | "lines";
  };
}

/**
 * Triage status lifecycle
 */
export type TriageStatus = "pending" | "triaged" | "acted_on";

/**
 * Triage action types
 */
export type TriageAction = "promote" | "delete" | "defer" | "spec-gap" | "duplicate";

/**
 * Triage record
 * AC: @ui-api-ref-resolution ac-2 — resolved_evidence_refs with titles
 */
export interface TriageRecord {
  _ulid: string;
  inbox_ref: string;
  item_snapshot: string;
  status: TriageStatus;
  action?: TriageAction;
  reasoning?: string;
  decided_by?: string;
  evidence_refs: string[];
  /** Resolved evidence_refs with titles and status */
  resolved_evidence_refs?: ResolvedRefEntry[];
  override_reasoning?: string;
  override_by?: string;
  override_at?: string;
  acted_at?: string;
  result_ref?: string;
  created_at: string;
  updated_at?: string;
}

/**
 * Acceptance criterion with inheritance tracking
 */
export interface InheritedAC extends AcceptanceCriterion {
  _inherited_from: string;
}

/**
 * Exported task with resolved spec reference title
 */
export interface ExportedTask extends TaskDetail {
  spec_ref_title?: string;
}

/**
 * Exported spec item with nested hierarchy and inherited ACs.
 * Note: extends ItemDetail (acceptance_criteria required) because the JSON
 * snapshot always includes the field. The core export module uses Omit to
 * build from parser types where AC may not yet exist, but by the time data
 * reaches the web-ui via snapshot, AC is always present (at least as []).
 */
export interface ExportedItem extends ItemDetail {
  children?: ExportedItem[];
  inherited_acs?: InheritedAC[];
}

/**
 * Project metadata in a snapshot
 */
export interface ExportedProject {
  name: string;
  version?: string;
  description?: string;
}

/**
 * Validation result included in a snapshot
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
 * Lightweight ref index entry for display metadata
 * AC: @ui-api-ref-resolution ac-4, ac-5
 */
export interface RefIndexEntry {
  title: string;
  type: string;
  status?: string;
}

/**
 * Ref index response — map of ref keys to display metadata
 * AC: @ui-api-ref-resolution ac-4, ac-5
 */
export interface RefIndexResponse {
  refs: Record<string, RefIndexEntry>;
}

/**
 * Bounded review projection included in the static export. Mirrors the
 * lean index entry the daemon stores (subject summary, related refs,
 * disposition, timestamps) plus the per-review resources array with
 * `exported_path` pointers so the static UI can render evidence without
 * a live daemon.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 * AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 */
export interface ExportedReview {
  _ulid: string;
  slugs: string[];
  title: string;
  lifecycle_state: ReviewSummary["lifecycle_state"];
  author: string;
  subject: ReviewSubject;
  related_refs: string[];
  external_links: ReviewDetail["external_links"];
  created_at: string;
  updated_at: string | null;
  examined_commit: string | null;
  disposition: string;
  resources: ReviewResource[];
}

/**
 * Full kspec snapshot structure
 */
export interface KspecSnapshot {
  version: string;
  exported_at: string;
  project: ExportedProject;
  tasks: ExportedTask[];
  items: ExportedItem[];
  inbox: InboxItem[];
  plans?: PlanDetail[];
  /**
   * Reviews exported as a bounded projection with linked resource metadata
   * pointing at copied asset paths.
   *
   * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
   * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
   */
  reviews?: ExportedReview[];
  triage?: TriageRecord[];
  session: SessionContext | null;
  observations: Observation[];
  agents: Agent[];
  workflows: Workflow[];
  conventions: Convention[];
  validation?: ExportedValidation;
  alignment?: AlignmentResponse;
}

/**
 * Task status counts with dependency-aware distinctions
 * AC: @ui-api-aggregation ac-1
 */
export interface TaskStatusSummary {
  counts: Record<string, number>;
  ready: number;
  blocked_by_dependencies: number;
  total: number;
}

/**
 * Extended validation/alignment stats with entity and AC counts
 * AC: @ui-api-aggregation ac-2
 */
export interface ValidationAggregation {
  stats: AlignmentStats;
  warnings: AlignmentWarning[];
  entity_counts: {
    items: number;
    tasks: number;
    traits: number;
  };
  ac_counts: {
    total: number;
    covered: number;
    uncovered: number;
  };
  orphan_count: number;
  valid: boolean;
  error_count: number;
  warning_count: number;
}

/**
 * Inbox item with inline triage status
 * AC: @ui-api-aggregation ac-3
 */
export interface InboxItemWithTriage extends InboxItem {
  triage?: {
    _ulid: string;
    status: TriageStatus;
    action?: TriageAction;
    reasoning?: string;
    decided_by?: string;
    acted_at?: string;
    result_ref?: string;
  };
}
