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
 * Task summary for list endpoints
 * AC: @api-contract ac-2
 */
export interface TaskSummary {
  _ulid: string;
  slugs: string[];
  title: string;
  type: string;
  status: string;
  priority: number;
  spec_ref?: string;
  tags: string[];
  created_at: string;
  started_at?: string;
  notes_count: number;
  todos_count?: number;
}

/**
 * Full task with notes and todos
 * AC: @api-contract ac-5
 */
export interface TaskDetail extends TaskSummary {
  derivation?: string;
  blocked_by: string[];
  depends_on: string[];
  context: string[];
  vcs_refs: string[];
  notes: Note[];
  todos?: Todo[];
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
 */
export interface Todo {
  _ulid: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  created_at: string;
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
  slugs: string[];
  name: string;
  steps: WorkflowStep[];
}

/**
 * Workflow step
 */
export interface WorkflowStep {
  _ulid: string;
  type: 'action' | 'check' | 'decision';
  content: string;
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
 * Validation result
 * AC: @api-contract ac-20
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
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

/**
 * Alignment index stats
 * AC: @api-contract ac-21
 */
export interface AlignmentStats {
  total_specs: number;
  total_tasks: number;
  specs_without_tasks: number;
  tasks_without_specs: number;
  warnings: string[];
}
