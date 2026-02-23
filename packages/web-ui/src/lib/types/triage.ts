/**
 * Triage Types
 *
 * Types for triage records used in the web UI.
 * Mirrors the schema types from src/schema/triage.ts.
 */

export type TriageStatus = 'pending' | 'triaged' | 'acted_on';
export type TriageAction = 'promote' | 'delete' | 'defer' | 'spec-gap' | 'duplicate';

export interface TriageRecord {
	_ulid: string;
	inbox_ref: string;
	item_snapshot: string;
	status: TriageStatus;
	action?: TriageAction;
	reasoning?: string;
	decided_by?: string;
	evidence_refs: string[];
	override_reasoning?: string;
	override_by?: string;
	override_at?: string;
	acted_at?: string;
	result_ref?: string;
	created_at: string;
	updated_at?: string;
}
