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
  SessionContext,
  Workflow,
} from "../schema/index.js";
import type { LoadedSpecItem, LoadedTask } from "../parser/yaml.js";

/**
 * Exported task with resolved spec reference title.
 * AC: @gh-pages-export ac-3
 */
export interface ExportedTask extends LoadedTask {
  /** Resolved title of the linked spec item (for display) */
  spec_ref_title?: string;
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
export interface ExportedItem extends Omit<LoadedSpecItem, 'acceptance_criteria'> {
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
 * Validation result included in the snapshot.
 * AC: @gh-pages-export ac-5
 */
export interface ExportedValidation {
  valid: boolean;
  errorCount: number;
  warningCount: number;
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
}

/**
 * Options for the export command.
 */
export interface ExportOptions {
  /** Output format */
  format: 'json' | 'html';
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
  observationCount: number;
  agentCount: number;
  workflowCount: number;
  conventionCount: number;
  estimatedSizeBytes: number;
}
