/**
 * Core Type Definitions
 *
 * Basic types used throughout kspec that align with Zod schemas in src/schema.
 * These are plain TypeScript types without Zod dependencies for lightweight usage.
 */

/**
 * Task status values
 */
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'pending_review'
  | 'blocked'
  | 'completed'
  | 'cancelled';

/**
 * Task type values
 */
export type TaskType =
  | 'epic'
  | 'task'
  | 'bug'
  | 'spike'
  | 'infra';

/**
 * Spec item type values
 */
export type ItemType =
  | 'module'
  | 'feature'
  | 'requirement'
  | 'constraint'
  | 'decision'
  | 'task'
  | 'trait';

/**
 * Implementation status values
 */
export type ImplementationStatus =
  | 'not_started'
  | 'in_progress'
  | 'implemented'
  | 'verified';

/**
 * Maturity status values
 */
export type Maturity =
  | 'draft'
  | 'proposed'
  | 'stable'
  | 'deferred'
  | 'deprecated';

/**
 * Observation type values
 */
export type ObservationType =
  | 'friction'
  | 'success'
  | 'question'
  | 'idea';
