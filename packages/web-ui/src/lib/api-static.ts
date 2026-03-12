/**
 * Static API Provider
 *
 * Provides API responses from a static JSON snapshot.
 * Used when daemon is unavailable (GitHub Pages mode).
 *
 * AC Coverage:
 * - ac-11 (@gh-pages-export): Render from JSON snapshot
 * - ac-12, ac-13 (@gh-pages-export): Deep linking with ref resolution
 */

import type {
	TaskSummary,
	TaskDetail,
	ItemSummary,
	ItemDetail,
	BatchItemsResponse,
	BatchSpecItemSummary,
	BatchTaskSummary,
	InboxItem,
	PlanDetail,
	PlanSummary,
	SessionContext,
	Observation,
	TriageRecord,
	ValidationResponse,
	AlignmentResponse,
	Workflow,
	PaginatedResponse,
	SearchResponse,
	SearchResult
} from '@kynetic-ai/shared';
import type { KspecSnapshot, ExportedTask, ExportedItem } from '$lib/types/snapshot';
import { getSnapshot, ReadOnlyModeError } from '$lib/stores/mode.svelte';

/**
 * Convert ExportedTask to TaskSummary
 */
function toTaskSummary(task: ExportedTask): TaskSummary {
	return {
		_ulid: task._ulid,
		slugs: task.slugs,
		title: task.title,
		type: task.type,
		status: task.status,
		priority: task.priority,
		spec_ref: task.spec_ref ?? undefined,
		tags: task.tags,
		depends_on: task.depends_on,
		created_at: task.created_at,
		started_at: task.started_at ?? undefined,
		automation: task.automation,
		notes_count: task.notes?.length ?? 0,
		todos_count: task.todos?.length ?? 0
	};
}

/**
 * Convert ExportedItem to ItemSummary
 */
function toItemSummary(item: ExportedItem): ItemSummary {
	return {
		_ulid: item._ulid,
		slugs: item.slugs,
		title: item.title,
		type: item.type,
		status: item.status,
		tags: item.tags,
		created_at: item.created_at ?? new Date().toISOString(),
		acceptance_criteria_count: item.acceptance_criteria?.length ?? 0
	};
}

function toBatchSpecItemSummary(item: ExportedItem): BatchSpecItemSummary {
	const rawStatus = (item as ExportedItem & { status?: string | { maturity?: string } }).status;

	return {
		kind: 'item',
		ulid: item._ulid,
		slugs: item.slugs,
		title: item.title,
		type: item.type,
		status: typeof rawStatus === 'string' ? rawStatus : undefined,
		maturity: typeof rawStatus === 'object' && rawStatus ? rawStatus.maturity : undefined,
		traits: item.traits ?? [],
		ac_count: item.acceptance_criteria?.length ?? 0
	};
}

function toBatchTaskSummary(task: ExportedTask): BatchTaskSummary {
	const assignee = (task as ExportedTask & { assignee?: string }).assignee;

	return {
		kind: 'task',
		ulid: task._ulid,
		slugs: task.slugs,
		title: task.title,
		status: task.status,
		priority: task.priority,
		spec_ref: task.spec_ref ?? undefined,
		assignee
	};
}

function normalizeRef(ref: string | null | undefined): string | null {
	if (!ref) return null;
	return ref.startsWith('@') ? ref.slice(1) : ref;
}

function findPlanByRef(snapshot: KspecSnapshot, ref: string): PlanDetail | null {
	const normalizedRef = normalizeRef(ref);
	if (!normalizedRef) return null;

	return (
		snapshot.plans?.find(
			(plan) =>
				plan.slugs.includes(normalizedRef) ||
				plan._ulid.toUpperCase().startsWith(normalizedRef.toUpperCase())
		) ?? null
	);
}

function matchesPlanRef(planRef: string | undefined, ref: string): boolean {
	const normalizedPlanRef = normalizeRef(planRef);
	const normalizedRef = normalizeRef(ref);

	if (!normalizedPlanRef || !normalizedRef) return false;
	return (
		normalizedPlanRef === normalizedRef ||
		normalizedPlanRef.toUpperCase().startsWith(normalizedRef.toUpperCase())
	);
}

/**
 * Filter helper for tasks
 */
function filterTasks(
	tasks: ExportedTask[],
	params?: {
		status?: string | string[];
		tag?: string;
		assignee?: string;
		automation?: string;
		plan?: string;
	}
): ExportedTask[] {
	let result = tasks;

	if (params?.status) {
		const statuses = Array.isArray(params.status) ? params.status : [params.status];
		result = result.filter((t) => statuses.includes(t.status));
	}
	if (params?.tag) {
		result = result.filter((t) => t.tags.includes(params.tag!));
	}
	if (params?.assignee) {
		result = result.filter((t) => t.assignee === params.assignee);
	}
	if (params?.automation) {
		result = result.filter((t) => t.automation === params.automation);
	}
	if (params?.plan) {
		result = result.filter((t) => matchesPlanRef(t.plan_ref, params.plan!));
	}

	return result;
}

/**
 * Filter helper for items
 */
function filterItems(
	items: ExportedItem[],
	params?: {
		type?: string | string[];
		tag?: string;
		plan?: string;
	}
): ExportedItem[] {
	let result = items;

	if (params?.type) {
		const types = Array.isArray(params.type) ? params.type : [params.type];
		result = result.filter((i) => types.includes(i.type));
	}
	if (params?.tag) {
		result = result.filter((i) => i.tags.includes(params.tag!));
	}
	if (params?.plan) {
		const snapshot = getSnapshot();
		const plan = snapshot ? findPlanByRef(snapshot, params.plan) : null;
		if (plan) {
			const planSpecRefs = new Set(plan.derived_specs.map((ref) => normalizeRef(ref)));
			result = result.filter(
				(i) =>
					planSpecRefs.has(i._ulid) ||
					i.slugs.some((slug) => planSpecRefs.has(slug))
			);
		} else {
			result = [];
		}
	}

	return result;
}

/**
 * Paginate array
 */
function paginate<T>(
	items: T[],
	params?: { limit?: number; offset?: number }
): PaginatedResponse<T> {
	const limit = params?.limit ?? items.length;
	const offset = params?.offset ?? 0;
	const paged = items.slice(offset, offset + limit);

	return {
		items: paged,
		total: items.length,
		offset,
		limit
	};
}

/**
 * Find task by reference (slug or ULID prefix)
 * AC: @gh-pages-export ac-12
 */
function findTaskByRef(tasks: ExportedTask[], ref: string): ExportedTask | null {
	const normalizedRef = ref.startsWith('@') ? ref.slice(1) : ref;

	// Try exact slug match first
	const bySlug = tasks.find((t) => t.slugs.includes(normalizedRef));
	if (bySlug) return bySlug;

	// Try ULID prefix match
	const byUlid = tasks.find((t) => t._ulid.startsWith(normalizedRef.toUpperCase()));
	if (byUlid) return byUlid;

	return null;
}

/**
 * Find item by reference (slug or ULID prefix)
 * AC: @gh-pages-export ac-13
 */
function findItemByRef(items: ExportedItem[], ref: string): ExportedItem | null {
	const normalizedRef = ref.startsWith('@') ? ref.slice(1) : ref;

	// Try exact slug match first
	const bySlug = items.find((i) => i.slugs.includes(normalizedRef));
	if (bySlug) return bySlug;

	// Try ULID prefix match
	const byUlid = items.find((i) => i._ulid.startsWith(normalizedRef.toUpperCase()));
	if (byUlid) return byUlid;

	return null;
}

// ============================================================
// Static API Functions
// ============================================================

/**
 * Fetch tasks from static snapshot
 * AC: @gh-pages-export ac-11
 */
export function fetchTasksStatic(params?: {
	status?: string | string[];
	tag?: string;
	assignee?: string;
	automation?: string;
	plan?: string;
	limit?: number;
	offset?: number;
}): PaginatedResponse<TaskSummary> {
	const snapshot = getSnapshot();
	if (!snapshot) {
		return { items: [], total: 0, offset: 0, limit: 50 };
	}

	const filtered = filterTasks(snapshot.tasks, params);
	const paginated = paginate(filtered, params);

	return {
		...paginated,
		items: paginated.items.map(toTaskSummary)
	};
}

/**
 * Fetch single task from static snapshot
 * AC: @gh-pages-export ac-12
 */
export function fetchTaskStatic(ref: string): TaskDetail | null {
	const snapshot = getSnapshot();
	if (!snapshot) return null;

	const task = findTaskByRef(snapshot.tasks, ref);
	if (!task) return null;

	// ExportedTask extends TaskDetail, so we can return it directly
	return task;
}

/**
 * Fetch items from static snapshot
 * AC: @gh-pages-export ac-11
 */
export function fetchItemsStatic(params?: {
	type?: string | string[];
	tag?: string;
	plan?: string;
	limit?: number;
	offset?: number;
}): PaginatedResponse<ItemSummary> {
	const snapshot = getSnapshot();
	if (!snapshot) {
		return { items: [], total: 0, offset: 0, limit: 50 };
	}

	const filtered = filterItems(snapshot.items, params);
	const paginated = paginate(filtered, params);

	return {
		...paginated,
		items: paginated.items.map(toItemSummary)
	};
}

/**
 * Fetch single item from static snapshot
 * AC: @gh-pages-export ac-13
 */
export function fetchItemStatic(ref: string): ItemDetail | null {
	const snapshot = getSnapshot();
	if (!snapshot) return null;

	const item = findItemByRef(snapshot.items, ref);
	if (!item) return null;

	return item;
}

/**
 * Fetch tasks linked to an item from static snapshot
 */
export function fetchItemTasksStatic(ref: string): PaginatedResponse<TaskSummary> {
	const snapshot = getSnapshot();
	if (!snapshot) {
		return { items: [], total: 0, offset: 0, limit: 50 };
	}

	const item = findItemByRef(snapshot.items, ref);
	if (!item) {
		return { items: [], total: 0, offset: 0, limit: 50 };
	}

	// Find tasks that reference this item
	const linkedTasks = snapshot.tasks.filter((t) => {
		if (!t.spec_ref) return false;
		const specRef = t.spec_ref.startsWith('@') ? t.spec_ref.slice(1) : t.spec_ref;
		return item.slugs.includes(specRef) || item._ulid.startsWith(specRef.toUpperCase());
	});

	return {
		items: linkedTasks.map(toTaskSummary),
		total: linkedTasks.length,
		offset: 0,
		limit: linkedTasks.length
	};
}

export function fetchBatchItemsStatic(refs: string[]): BatchItemsResponse {
	const snapshot = getSnapshot();
	if (!snapshot || refs.length === 0) {
		return { items: [], unresolved: [] };
	}

	const items = [];
	const unresolved: string[] = [];

	for (const ref of refs) {
		const task = findTaskByRef(snapshot.tasks, ref);
		if (task) {
			items.push(toBatchTaskSummary(task));
			continue;
		}

		const item = findItemByRef(snapshot.items, ref);
		if (item) {
			items.push(toBatchSpecItemSummary(item));
			continue;
		}

		unresolved.push(ref);
	}

	return { items, unresolved };
}

/**
 * Fetch inbox from static snapshot
 * AC: @gh-pages-export ac-11
 */
export function fetchInboxStatic(params?: {
	limit?: number;
	offset?: number;
}): PaginatedResponse<InboxItem> {
	const snapshot = getSnapshot();
	if (!snapshot) {
		return { items: [], total: 0, offset: 0, limit: 50 };
	}

	return paginate(snapshot.inbox, params);
}

/**
 * Fetch session context from static snapshot
 */
export function fetchSessionContextStatic(): SessionContext | null {
	const snapshot = getSnapshot();
	return snapshot?.session ?? null;
}

/**
 * Fetch observations from static snapshot
 */
export function fetchObservationsStatic(params?: {
	type?: 'friction' | 'success' | 'question' | 'idea';
	resolved?: boolean;
}): PaginatedResponse<Observation> {
	const snapshot = getSnapshot();
	if (!snapshot) {
		return { items: [], total: 0, offset: 0, limit: 50 };
	}

	let filtered = snapshot.observations;

	if (params?.type) {
		filtered = filtered.filter((o) => o.type === params.type);
	}
	if (params?.resolved !== undefined) {
		filtered = filtered.filter((o) => o.resolved === params.resolved);
	}

	return {
		items: filtered,
		total: filtered.length,
		offset: 0,
		limit: filtered.length
	};
}

/**
 * Search across static snapshot
 * AC: @gh-pages-export ac-11
 */
export function searchStatic(query: string): SearchResponse {
	const snapshot = getSnapshot();
	if (!snapshot) {
		return { results: [], total: 0, showing: 0 };
	}

	const lowerQuery = query.toLowerCase();
	const results: SearchResult[] = [];

	// Search tasks
	for (const task of snapshot.tasks) {
		if (
			task.title.toLowerCase().includes(lowerQuery) ||
			task.slugs.some((s) => s.includes(lowerQuery))
		) {
			results.push({
				type: 'task',
				ulid: task._ulid,
				title: task.title,
				matchedFields: ['title']
			});
		}
	}

	// Search items
	for (const item of snapshot.items) {
		if (
			item.title.toLowerCase().includes(lowerQuery) ||
			item.slugs.some((s) => s.includes(lowerQuery))
		) {
			results.push({
				type: 'item',
				ulid: item._ulid,
				title: item.title,
				matchedFields: ['title']
			});
		}
	}

	// Search inbox
	for (const inbox of snapshot.inbox) {
		if (inbox.text.toLowerCase().includes(lowerQuery)) {
			results.push({
				type: 'inbox',
				ulid: inbox._ulid,
				title: inbox.text.slice(0, 50),
				matchedFields: ['text']
			});
		}
	}

	return {
		results: results.slice(0, 20),
		total: results.length,
		showing: Math.min(results.length, 20)
	};
}

/**
 * Fetch triage records from static snapshot
 * AC: @interactive-triage-ui ac-8
 */
export function fetchTriageRecordsStatic(params?: {
	status?: string;
	action?: string;
	limit?: number;
	offset?: number;
}): PaginatedResponse<TriageRecord> {
	const snapshot = getSnapshot();
	if (!snapshot) {
		return { items: [], total: 0, offset: params?.offset ?? 0, limit: params?.limit ?? 50 };
	}

	let items = snapshot.triage ?? [];

	if (params?.status) {
		items = items.filter((item) => item.status === params.status);
	}
	if (params?.action) {
		items = items.filter((item) => item.action === params.action);
	}

	return paginate(items, params);
}

// ============================================================
// Workflows Static Functions
// ============================================================

/**
 * Fetch workflows from static snapshot
 * AC: @ui-workflows-view ac-1
 */
export function fetchWorkflowsStatic(): { items: Workflow[]; total: number } {
	const snapshot = getSnapshot();
	if (!snapshot) {
		return { items: [], total: 0 };
	}

	return {
		items: snapshot.workflows ?? [],
		total: (snapshot.workflows ?? []).length
	};
}

// ============================================================
// Plans Static Functions
// ============================================================

/**
 * Fetch plans from static snapshot
 * Plans are not included in static snapshots, so return empty.
 */
export function fetchPlansStatic(_params?: {
	status?: string;
}): { items: PlanSummary[]; total: number } {
	const snapshot = getSnapshot();
	if (!snapshot) {
		return { items: [], total: 0 };
	}

	let items = snapshot.plans ?? [];
	if (_params?.status) {
		items = items.filter((plan) => plan.status === _params.status);
	}

	return {
		items: items.map(({ content: _content, ...plan }) => plan),
		total: items.length
	};
}

export function fetchPlanContentStatic(ref: string): PlanDetail {
	const snapshot = getSnapshot();
	if (!snapshot) {
		throw new Error('Plan content not available in static mode');
	}

	const plan = findPlanByRef(snapshot, ref);
	if (!plan) {
		throw new Error(`Plan not found: ${ref}`);
	}

	return plan;
}

export function fetchValidationStatic(): ValidationResponse {
	const snapshot = getSnapshot();
	if (!snapshot?.validation) {
		return {
			valid: true,
			schemaErrors: [],
			refErrors: [],
			refWarnings: [],
			orphans: [],
			completenessWarnings: [],
			traitCycles: []
		};
	}

	return {
		valid: snapshot.validation.valid,
		schemaErrors: snapshot.validation.schemaErrors ?? [],
		refErrors: snapshot.validation.refErrors ?? [],
		refWarnings: snapshot.validation.refWarnings ?? [],
		orphans: snapshot.validation.orphans ?? [],
		completenessWarnings: snapshot.validation.completenessWarnings ?? [],
		traitCycles: snapshot.validation.traitCycles ?? []
	};
}

export function fetchAlignmentStatic(): AlignmentResponse {
	return (
		getSnapshot()?.alignment ?? {
			stats: { totalSpecs: 0, specsWithTasks: 0, alignedSpecs: 0, orphanedSpecs: 0 },
			warnings: []
		}
	);
}

// ============================================================
// Write Operations (throw ReadOnlyModeError)
// ============================================================

/**
 * Start task - not available in static mode
 * AC: @gh-pages-export ac-16, ac-18
 */
export function startTaskStatic(_ref: string): never {
	throw new ReadOnlyModeError('start task');
}

/**
 * Add task note - not available in static mode
 * AC: @gh-pages-export ac-18
 */
export function addTaskNoteStatic(_ref: string, _content: string): never {
	throw new ReadOnlyModeError('add note');
}

/**
 * Add inbox item - not available in static mode
 * AC: @gh-pages-export ac-17, ac-18
 */
export function addInboxItemStatic(_text: string, _tags?: string[]): never {
	throw new ReadOnlyModeError('add inbox item');
}

/**
 * Delete inbox item - not available in static mode
 * AC: @gh-pages-export ac-18
 */
export function deleteInboxItemStatic(_ref: string): never {
	throw new ReadOnlyModeError('delete inbox item');
}
