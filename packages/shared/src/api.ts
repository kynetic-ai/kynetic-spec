/**
 * API Response Types
 *
 * Shared types for REST API responses between daemon and web-ui.
 * These types define the contract for HTTP endpoints.
 */

/**
 * Common paginated response wrapper
 * AC: @api-contract ac-4
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
 */
export interface ErrorResponse {
  error: string;
  message?: string;
  suggestion?: string;
  details?: Array<{ field: string; message: string }>;
  current?: string;
  valid_transitions?: string[];
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
  enforcement?: 'advisory' | 'strict';
  mode?: 'interactive' | 'loop';
  based_on?: string;
  tags?: string[];
}

/**
 * Workflow step
 */
export interface WorkflowStep {
  type: 'action' | 'check' | 'decision';
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
  type: 'friction' | 'success' | 'question' | 'idea';
  content: string;
  context?: string;
  created_at: string;
  resolved?: boolean;
  resolution?: string;
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
}

/**
 * Plan detail with content for expand/detail views
 * AC: @ui-plans-view ac-2
 */
export interface PlanDetail extends PlanSummary {
  content: string;
}

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
      type: 'code';
      path: string;
      side: 'base' | 'head';
      line_start: number;
      line_end: number;
      commit: string;
    }
  | {
      type: 'structured';
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
  kind: 'blocker' | 'question' | 'nit';
  anchor?: ReviewAnchor;
  entries: ReviewThreadEntry[];
  resolved_at?: string | null;
  resolved_by?: string | null;
}

/**
 * Subject version for checks and verdicts
 */
export type ReviewSubjectVersion =
  | { type: 'code_compare'; base_commit: string; head_commit: string }
  | { type: 'entity_version'; content_hash: string };

/**
 * Review check result
 * AC: @review-records-web-ui ac-2
 */
export interface ReviewCheck {
  name: string;
  status: 'pass' | 'fail' | 'running' | 'skipped';
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
  decision: 'approve' | 'request_changes' | 'comment';
  applies_to_version: ReviewSubjectVersion;
  created_at: string;
}

/**
 * Review subject binding
 * AC: @review-records-web-ui ac-2
 */
export type ReviewSubject =
  | { type: 'code'; base_commit: string; head_commit: string; merge_base_commit?: string; base_branch?: string; head_branch?: string }
  | { type: 'plan'; ref: string; shadow_commit: string; content_hash: string }
  | { type: 'task'; ref: string; shadow_commit: string; content_hash: string }
  | { type: 'spec'; ref: string; shadow_commit: string; content_hash: string }
  | { type: 'external'; url: string; external_id?: string; provider?: string };

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
}

export interface BatchSpecItemSummary {
  kind: 'item';
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
  kind: 'task';
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
  type: 'item' | 'task' | 'inbox' | 'observation' | 'agent' | 'workflow' | 'convention';
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
  error: 'not_found' | 'ambiguous' | 'duplicate_slug';
  message: string;
}

export interface RefValidationWarning {
  ref: string;
  sourceFile?: string;
  sourceUlid?: string;
  field: string;
  warning: 'deprecated_target';
  message: string;
}

export interface OrphanItem {
  ulid: string;
  title: string;
  type: string;
  file?: string;
}

export type CompletenessWarningType =
  | 'missing_acceptance_criteria'
  | 'missing_description'
  | 'status_inconsistency'
  | 'missing_test_coverage'
  | 'automation_eligible_no_spec'
  | 'ac_schema_field_mismatch';

export interface CompletenessWarning {
  type: CompletenessWarningType;
  subtype?: 'own_ac' | 'trait_ac';
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
  type: 'orphaned_spec' | 'status_mismatch' | 'stale_implementation';
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
    type: 'regex' | 'enum' | 'range' | 'prose';
    pattern?: string;
    message?: string;
    allowed?: string[];
    min?: number;
    max?: number;
    unit?: 'words' | 'chars' | 'lines';
  };
}

/**
 * Triage status lifecycle
 */
export type TriageStatus = 'pending' | 'triaged' | 'acted_on';

/**
 * Triage action types
 */
export type TriageAction = 'promote' | 'delete' | 'defer' | 'spec-gap' | 'duplicate';

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
