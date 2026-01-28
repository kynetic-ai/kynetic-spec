/**
 * Snapshot Types
 *
 * Types for the static JSON snapshot used in read-only mode.
 * These mirror the export types from the CLI.
 */

import type {
	TaskDetail,
	ItemDetail,
	InboxItem,
	SessionContext,
	Observation,
	Agent,
	Workflow
} from '@kynetic-ai/shared';

/**
 * Convention from meta manifest
 */
export interface Convention {
	_ulid: string;
	domain: string;
	rules: string[];
}

/**
 * Acceptance criterion with inheritance tracking
 */
export interface InheritedAC {
	id: string;
	given: string;
	when: string;
	then: string;
	_inherited_from: string;
}

/**
 * Exported task with resolved spec reference title
 */
export interface ExportedTask extends TaskDetail {
	spec_ref_title?: string;
}

/**
 * Exported spec item with inherited ACs
 */
export interface ExportedItem extends ItemDetail {
	children?: ExportedItem[];
	inherited_acs?: InheritedAC[];
}

/**
 * Validation result in snapshot
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
 * Full kspec snapshot structure
 */
export interface KspecSnapshot {
	version: string;
	exported_at: string;
	project: {
		name: string;
		version?: string;
		description?: string;
	};
	tasks: ExportedTask[];
	items: ExportedItem[];
	inbox: InboxItem[];
	session: SessionContext | null;
	observations: Observation[];
	agents: Agent[];
	workflows: Workflow[];
	conventions: Convention[];
	validation?: ExportedValidation;
}
