/**
 * API Client
 *
 * Helper functions for making requests to the kspec daemon API.
 * Supports both daemon mode (live) and static mode (read-only JSON).
 *
 * AC Coverage:
 * - ac-26 (@multi-directory-daemon): X-Kspec-Dir header injection
 * - ac-36 (@multi-directory-daemon): Invalid project error detection
 * - ac-11 (@gh-pages-export): Mode-aware API dispatch
 * - ac-18 (@gh-pages-export): Graceful no-op for write operations
 */

import type {
	TaskSummary,
	TaskDetail,
	ItemSummary,
	ItemDetail,
	BatchItemsResponse,
	InboxItem,
	InboxItemWithTriage,
	SessionContext,
	Observation,
	Workflow,
	Convention,
	PaginatedResponse,
	PlanSummary,
	PlanDetail,
	ReviewSummary,
	ReviewDetail,
	ErrorResponse,
	SearchResponse,
	AgentDefinition,
	AgentUpdatePayload,
	ValidationAggregation,
} from '@kynetic-ai/shared';
import type { TriageRecord } from './types/triage';
import {
	getSelectedProjectPath,
	clearInvalidSelection,
	isInvalidProjectError,
	type Project
} from './stores/project.svelte';
import { isStaticMode, assertWritable } from './stores/mode.svelte';
import {
	fetchTasksStatic,
	fetchTaskStatic,
	fetchItemsStatic,
	fetchItemStatic,
	fetchItemTasksStatic,
	fetchBatchItemsStatic,
	fetchInboxStatic,
	fetchSessionContextStatic,
	fetchObservationsStatic,
	searchStatic,
	fetchTriageRecordsStatic,
	fetchPlansStatic,
	fetchPlanContentStatic,
	fetchValidationStatic,
	fetchAlignmentStatic,
	fetchWorkflowsStatic
} from './api-static';
import { DAEMON_API_BASE } from './constants';

const API_BASE = DAEMON_API_BASE;

/**
 * Get headers for API requests, including X-Kspec-Dir if project is selected
 * AC: @multi-directory-daemon ac-26
 */
function getProjectHeaders(): HeadersInit {
	const path = getSelectedProjectPath();
	return path ? { 'X-Kspec-Dir': path } : {};
}

/**
 * Handle response errors, detecting invalid project errors
 * AC: @multi-directory-daemon ac-36
 */
async function handleResponseError(response: Response): Promise<never> {
	const error: ErrorResponse = await response.json();
	const message = error.message || error.error;

	// Check if this is an invalid project error
	if (isInvalidProjectError(response, message)) {
		clearInvalidSelection();
	}

	throw new Error(message);
}

/**
 * Fetch registered projects
 * AC: @multi-directory-daemon ac-25, ac-28
 */
export async function fetchProjects(): Promise<{ projects: Project[] }> {
	const response = await fetch(`${API_BASE}/api/projects`);
	if (!response.ok) {
		await handleResponseError(response);
	}
	return response.json();
}

/**
 * Fetch tasks with optional filters
 * AC: @web-dashboard ac-9, ac-10
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchTasks(params?: {
	status?: string | string[];
	tag?: string;
	assignee?: string;
	automation?: string;
	plan?: string;
	limit?: number;
	offset?: number;
}): Promise<PaginatedResponse<TaskSummary>> {
	// AC: @gh-pages-export ac-11 - Use static data in static mode
	if (isStaticMode()) {
		return fetchTasksStatic(params);
	}

	const url = new URL(`${API_BASE}/api/tasks`);

	if (params) {
		Object.entries(params).forEach(([key, value]) => {
			if (value !== undefined && value !== '') {
				if (Array.isArray(value)) {
					value.forEach((v) => url.searchParams.append(key, v));
				} else {
					url.searchParams.set(key, String(value));
				}
			}
		});
	}

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch single task by reference
 * AC: @web-dashboard ac-5
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-12 - Static mode deep linking
 */
export async function fetchTask(ref: string): Promise<TaskDetail> {
	// AC: @gh-pages-export ac-12 - Use static data in static mode
	if (isStaticMode()) {
		const task = fetchTaskStatic(ref);
		if (!task) {
			throw new Error(`Task not found: ${ref}`);
		}
		return task;
	}

	const response = await fetch(`${API_BASE}/api/tasks/${ref}`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Start a task (change status to in_progress)
 * AC: @web-dashboard ac-7
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-16, ac-18 - Disabled in static mode
 */
export async function startTask(ref: string): Promise<void> {
	// AC: @gh-pages-export ac-16, ac-18 - Write operations throw in static mode
	assertWritable('start task');

	const response = await fetch(`${API_BASE}/api/tasks/${ref}/start`, {
		method: 'POST',
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
}

/**
 * Add a note to a task
 * AC: @web-dashboard ac-8
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-18 - Disabled in static mode
 */
export async function addTaskNote(ref: string, content: string): Promise<void> {
	// AC: @gh-pages-export ac-18 - Write operations throw in static mode
	assertWritable('add note');

	const response = await fetch(`${API_BASE}/api/tasks/${ref}/note`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...getProjectHeaders()
		},
		body: JSON.stringify({ content })
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
}

/**
 * Submit a task for review (transition to pending_review)
 * AC: @ui-task-board ac-6
 */
export async function submitTask(ref: string): Promise<void> {
	assertWritable('submit task');

	const response = await fetch(`${API_BASE}/api/tasks/${ref}/submit`, {
		method: 'POST',
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
}

/**
 * Complete a task
 * AC: @ui-task-board ac-6
 */
export async function completeTask(ref: string, reason: string): Promise<void> {
	assertWritable('complete task');

	const response = await fetch(`${API_BASE}/api/tasks/${ref}/complete`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...getProjectHeaders()
		},
		body: JSON.stringify({ reason })
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
}

/**
 * Block a task
 * AC: @ui-task-board ac-6
 */
export async function blockTask(ref: string, reason: string): Promise<void> {
	assertWritable('block task');

	const response = await fetch(`${API_BASE}/api/tasks/${ref}/block`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...getProjectHeaders()
		},
		body: JSON.stringify({ reason })
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
}

/**
 * Fetch agent/dispatch status
 * AC: @ui-task-board ac-4
 */

/**
 * Fetch spec items with optional filters
 * AC: @web-dashboard ac-11
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchItems(params?: {
	type?: string | string[];
	tag?: string;
	plan?: string;
	limit?: number;
	offset?: number;
}): Promise<PaginatedResponse<ItemSummary>> {
	// AC: @gh-pages-export ac-11 - Use static data in static mode
	if (isStaticMode()) {
		return fetchItemsStatic(params);
	}

	const url = new URL(`${API_BASE}/api/items`);

	if (params) {
		Object.entries(params).forEach(([key, value]) => {
			if (value !== undefined && value !== '') {
				if (Array.isArray(value)) {
					value.forEach((v) => url.searchParams.append(key, String(v)));
				} else {
					url.searchParams.set(key, String(value));
				}
			}
		});
	}

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch single spec item by reference
 * AC: @web-dashboard ac-12
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-13 - Static mode deep linking
 */
export async function fetchItem(ref: string): Promise<ItemDetail> {
	// AC: @gh-pages-export ac-13 - Use static data in static mode
	if (isStaticMode()) {
		const item = fetchItemStatic(ref);
		if (!item) {
			throw new Error(`Item not found: ${ref}`);
		}
		return item;
	}

	const response = await fetch(`${API_BASE}/api/items/${ref}`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

export async function fetchBatchItems(refs: string[]): Promise<BatchItemsResponse> {
	if (isStaticMode()) {
		return fetchBatchItemsStatic(refs);
	}

	const response = await fetch(`${API_BASE}/api/items/batch`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...getProjectHeaders()
		},
		body: JSON.stringify({ refs })
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch tasks linked to a spec item
 * AC: @web-dashboard ac-13
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchItemTasks(ref: string): Promise<PaginatedResponse<TaskSummary>> {
	// AC: @gh-pages-export ac-11 - Use static data in static mode
	if (isStaticMode()) {
		return fetchItemTasksStatic(ref);
	}

	const response = await fetch(`${API_BASE}/api/items/${ref}/tasks`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch inbox items
 * AC: @web-dashboard ac-16
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchInbox(params?: {
	limit?: number;
	offset?: number;
}): Promise<PaginatedResponse<InboxItem>> {
	// AC: @gh-pages-export ac-11 - Use static data in static mode
	if (isStaticMode()) {
		return fetchInboxStatic(params);
	}

	const url = new URL(`${API_BASE}/api/inbox`);

	if (params) {
		Object.entries(params).forEach(([key, value]) => {
			if (value !== undefined && value !== '') {
				url.searchParams.set(key, String(value));
			}
		});
	}

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch inbox items with inline triage status from the merged aggregation endpoint.
 * Eliminates the need for separate fetchInbox + fetchTriageRecords + client-side join.
 * AC: @ui-api-aggregation ac-3 — Inbox items with inline triage status
 */
export async function fetchMergedInbox(): Promise<{
	items: InboxItemWithTriage[];
	total: number;
}> {
	// In static mode, fall back to separate fetches and merge client-side
	if (isStaticMode()) {
		const inboxResponse = await fetchInboxStatic();
		const triageResponse = await fetchTriageRecordsStatic();
		const items: InboxItemWithTriage[] = inboxResponse.items.map((item) => {
			const record = triageResponse.items.find((r) => r.inbox_ref === item._ulid);
			const result: InboxItemWithTriage = { ...item };
			if (record) {
				result.triage = {
					_ulid: record._ulid,
					status: record.status,
					action: record.action,
					reasoning: record.reasoning,
					decided_by: record.decided_by,
					acted_at: record.acted_at,
					result_ref: record.result_ref,
				};
			}
			return result;
		});
		return { items, total: items.length };
	}

	const response = await fetch(`${API_BASE}/api/aggregation/inbox`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Add a new inbox item
 * AC: @web-dashboard ac-18
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-17, ac-18 - Disabled in static mode
 */
export async function addInboxItem(text: string, tags?: string[]): Promise<InboxItem> {
	// AC: @gh-pages-export ac-17, ac-18 - Write operations throw in static mode
	assertWritable('add inbox item');

	const response = await fetch(`${API_BASE}/api/inbox`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...getProjectHeaders()
		},
		body: JSON.stringify({ text, tags })
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	const result = await response.json();
	return result.item;
}

/**
 * Delete an inbox item
 * AC: @web-dashboard ac-19
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-18 - Disabled in static mode
 */
export async function deleteInboxItem(ref: string): Promise<void> {
	// AC: @gh-pages-export ac-18 - Write operations throw in static mode
	assertWritable('delete inbox item');

	const response = await fetch(`${API_BASE}/api/inbox/${ref}`, {
		method: 'DELETE',
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
}

/**
 * Fetch session context
 * AC: @web-dashboard ac-20
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchSessionContext(): Promise<SessionContext> {
	// AC: @gh-pages-export ac-11 - Use static data in static mode
	if (isStaticMode()) {
		const session = fetchSessionContextStatic();
		if (!session) {
			return { focus: null, threads: [], open_questions: [], updated_at: new Date().toISOString() };
		}
		return session;
	}

	const response = await fetch(`${API_BASE}/api/meta/session`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch observations
 * AC: @web-dashboard ac-21, ac-22
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchObservations(params?: {
	type?: 'friction' | 'success' | 'question' | 'idea';
	resolved?: boolean;
}): Promise<PaginatedResponse<Observation>> {
	// AC: @gh-pages-export ac-11 - Use static data in static mode
	if (isStaticMode()) {
		return fetchObservationsStatic(params);
	}

	const url = new URL(`${API_BASE}/api/meta/observations`);

	if (params) {
		Object.entries(params).forEach(([key, value]) => {
			if (value !== undefined && value !== '') {
				url.searchParams.set(key, String(value));
			}
		});
	}

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Search across all entities
 * AC: @web-dashboard ac-24
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function search(query: string): Promise<SearchResponse> {
	// AC: @gh-pages-export ac-11 - Use static data in static mode
	if (isStaticMode()) {
		return searchStatic(query);
	}

	const url = new URL(`${API_BASE}/api/search`);
	url.searchParams.set('q', query);

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

// ============================================================
// Triage API Functions
// AC: @interactive-triage-ui ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7
// ============================================================

/**
 * Fetch triage records with optional filters
 * AC: @interactive-triage-ui ac-1, ac-2, ac-7
 */
export async function fetchTriageRecords(params?: {
	status?: string;
	action?: string;
	limit?: number;
	offset?: number;
}): Promise<PaginatedResponse<TriageRecord>> {
	// AC: @interactive-triage-ui ac-8 - Static mode: read-only triage data
	if (isStaticMode()) {
		return fetchTriageRecordsStatic(params);
	}

	const url = new URL(`${API_BASE}/api/triage`);

	if (params) {
		Object.entries(params).forEach(([key, value]) => {
			if (value !== undefined && value !== '') {
				url.searchParams.set(key, String(value));
			}
		});
	}

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Create or update a triage record
 * AC: @interactive-triage-ui ac-3
 */
export async function createTriageRecord(data: {
	inbox_ref: string;
	action: string;
	reasoning: string;
	decided_by?: string;
	evidence_refs?: string[];
}): Promise<{ success: boolean; record: TriageRecord }> {
	assertWritable('create triage record');

	const response = await fetch(`${API_BASE}/api/triage`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...getProjectHeaders()
		},
		body: JSON.stringify(data)
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Override a triage decision
 * AC: @interactive-triage-ui ac-4
 */
export async function overrideTriageRecord(
	ref: string,
	data: {
		action: string;
		reasoning: string;
		override_by?: string;
	}
): Promise<{ success: boolean; record: TriageRecord }> {
	assertWritable('override triage record');

	const response = await fetch(`${API_BASE}/api/triage/${ref}/override`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...getProjectHeaders()
		},
		body: JSON.stringify(data)
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

// ============================================================
// Agent & Dispatch API Functions
// AC: @ui-agent-dispatch ac-1, ac-2, ac-3
// ============================================================

// AgentDefinition and AgentUpdatePayload are imported from @kynetic-ai/shared
// (schema-driven types mirroring AgentSchema from src/schema/meta.ts)
// Re-exported so existing imports from '$lib/api' continue to work.
// AC: @ui-agent-dispatch ac-4
export type { AgentDefinition, AgentUpdatePayload };

/**
 * Active invocation from GET /api/agent/status
 */
export interface ActiveInvocation {
	session_id: string;
	agent_id: string;
	task_ref: string | null;
	task_title: string | null;
	elapsed_ms: number;
}

/**
 * Agent dispatch status from GET /api/agent/status
 */
export interface AgentDispatchStatus {
	dispatch_enabled: boolean;
	active_invocations: ActiveInvocation[];
	queue_depth: number;
	agent_definitions: Array<{
		id: string;
		name: string;
		adapter: string;
		completed_sessions?: number;
	}>;
}

/**
 * Fetch agent dispatch status (dispatch state + active invocations)
 * AC: @ui-agent-dispatch ac-1, ac-2, ac-3
 */
export async function fetchAgentStatus(): Promise<AgentDispatchStatus> {
	const response = await fetch(`${API_BASE}/api/agent/status`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
	return response.json();
}

/**
 * Fetch full agent definitions from meta
 * AC: @ui-agent-dispatch ac-1
 */
export async function fetchAgentDefinitions(): Promise<{ items: AgentDefinition[]; total: number }> {
	const response = await fetch(`${API_BASE}/api/meta/agents`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
	return response.json();
}

/**
 * Start or stop the dispatch engine
 * AC: @ui-agent-dispatch ac-2
 */
export async function controlDispatch(action: 'start' | 'stop'): Promise<{ dispatch_enabled: boolean }> {
	assertWritable('control dispatch');

	const response = await fetch(`${API_BASE}/api/agent/dispatch`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...getProjectHeaders()
		},
		body: JSON.stringify({ action })
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
	return response.json();
}

/**
 * Update an agent definition via PATCH
 * AC: @ui-agent-dispatch ac-4
 */
export async function updateAgentDefinition(
	agentId: string,
	payload: AgentUpdatePayload
): Promise<AgentDefinition> {
	assertWritable('update agent definition');

	const response = await fetch(`${API_BASE}/api/meta/agents/${agentId}`, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
			...getProjectHeaders()
		},
		body: JSON.stringify(payload)
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Execute a triage action
 * AC: @interactive-triage-ui ac-3
 */
export async function actOnTriageRecord(
	ref: string
): Promise<{ success: boolean; record: TriageRecord }> {
	assertWritable('execute triage action');

	const response = await fetch(`${API_BASE}/api/triage/${ref}/act`, {
		method: 'POST',
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

// ============================================================
// Plans API Functions
// AC: @ui-plans-view ac-1
// ============================================================

/**
 * Fetch plans with optional status filter
 * AC: @ui-plans-view ac-1
 */
export async function fetchPlans(params?: {
	status?: string;
}): Promise<{ items: PlanSummary[]; total: number }> {
	if (isStaticMode()) {
		return fetchPlansStatic(params);
	}

	const url = new URL(`${API_BASE}/api/plans`);

	if (params) {
		Object.entries(params).forEach(([key, value]) => {
			if (value !== undefined && value !== '') {
				url.searchParams.set(key, String(value));
			}
		});
	}

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch a single plan's detail including content (lazy-loaded on expand)
 * AC: @ui-plans-view ac-2
 */
export async function fetchPlanContent(ref: string): Promise<PlanDetail> {
	if (isStaticMode()) {
		return fetchPlanContentStatic(ref);
	}

	const response = await fetch(`${API_BASE}/api/plans/${ref}`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

// ============================================================
// Reviews API Functions
// AC: @review-records-web-ui ac-1
// ============================================================

/**
 * Fetch reviews with optional filters
 * AC: @review-records-web-ui ac-1
 */
export async function fetchReviews(params?: {
	status?: string | string[];
	disposition?: string;
	subject_type?: string;
	subject_ref?: string;
	head_branch?: string;
	task?: string;
	sort?: string;
	sort_dir?: string;
	limit?: number;
	offset?: number;
}): Promise<PaginatedResponse<ReviewSummary>> {
	if (isStaticMode()) {
		return { items: [], total: 0, offset: 0, limit: 0 };
	}

	const url = new URL(`${API_BASE}/api/reviews`);

	if (params) {
		Object.entries(params).forEach(([key, value]) => {
			if (value !== undefined && value !== '') {
				if (Array.isArray(value)) {
					value.forEach((v) => url.searchParams.append(key, v));
				} else {
					url.searchParams.set(key, String(value));
				}
			}
		});
	}

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch a single review by ID (ULID or slug).
 * AC: @review-records-web-ui ac-2
 */
export async function fetchReview(id: string): Promise<ReviewDetail> {
	if (isStaticMode()) {
		throw new Error('Review detail not available in static mode');
	}

	const response = await fetch(`${API_BASE}/api/reviews/${encodeURIComponent(id)}`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch sibling reviews for the same subject (for revision selector).
 * Returns all reviews matching the subject type, filtered client-side
 * by subject_ref or head_branch depending on subject type.
 * AC: @review-records-web-ui ac-11
 */
export async function fetchReviewSiblings(params: {
	subject_type: string;
	subject_ref?: string;
	head_branch?: string;
}): Promise<ReviewSummary[]> {
	if (isStaticMode()) {
		return [];
	}

	const data = await fetchReviews({
		status: 'all',
		sort: 'created_at',
		sort_dir: 'asc',
		subject_type: params.subject_type,
		subject_ref: params.subject_ref,
		head_branch: params.head_branch
	});

	return data.items;
}

// ============================================================
// Workflows API Functions
// AC: @ui-workflows-view ac-1
// ============================================================

/**
 * Fetch workflow definitions
 * AC: @ui-workflows-view ac-1
 */
export async function fetchWorkflows(): Promise<{ items: Workflow[]; total: number }> {
	if (isStaticMode()) {
		return fetchWorkflowsStatic();
	}

	const response = await fetch(`${API_BASE}/api/meta/workflows`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

// ============================================================
// Session API Functions
// AC: @ui-session-stream ac-1, ac-2, ac-4
// ============================================================

/**
 * Session summary from the daemon API.
 */
export interface SessionSummary {
	id: string;
	status: 'active' | 'completed' | 'abandoned' | 'timed_out' | 'failed' | 'stalled';
	agent_type: string;
	/** Agent definition ID (e.g. worker, pr-reviewer). */
	agent_id?: string;
	session_type: 'loop' | 'invocation';
	/** Dispatch trigger for distinguishing dispatched agent vs manual CLI run. */
	trigger?: string;
	/** Task ID being worked on (if any). AC: @ui-session-history ac-1 */
	task_id?: string;
	/** Server-resolved task title. AC: @ui-api-ref-resolution ac-1 */
	task_title?: string | null;
	started_at: string;
	ended_at?: string;
	duration_ms: number;
	event_count: number;
	iteration_count: number;
	tasks_completed: number;
}

/**
 * Spec context with acceptance criteria checklist.
 * AC: @ui-session-stream ac-4
 */
export interface SessionSpecContext {
	spec_ref: string;
	title: string;
	acceptance_criteria: Array<{ id: string; description: string }>;
}

/**
 * Session budget info.
 * AC: @ui-session-stream ac-4
 */
export interface SessionBudget {
	max_per_cycle: number;
	started_this_cycle: number;
}

/**
 * Session detail with additional metadata.
 * AC: @ui-session-stream ac-4
 */
export interface SessionDetail extends SessionSummary {
	task_id?: string;
	agent_id?: string;
	trigger?: string;
	spec_context?: SessionSpecContext | null;
	budget?: SessionBudget | null;
}

/**
 * A single event from events.jsonl.
 */
export interface SessionEvent {
	ts: number;
	seq: number;
	type: string;
	session_id: string;
	trace_id?: string;
	data: unknown;
}

/**
 * Pagination and filter parameters for session list.
 * AC: @session-list-infinite-scroll ac-initial-load
 * AC: @session-filter-controls ac-status-filter, ac-agent-filter, ac-agent-type-filter, ac-trigger-filter, ac-date-filter
 */
export interface FetchSessionsParams {
	offset?: number;
	limit?: number;
	status?: string[];
	agent_id?: string;
	agent_type?: string;
	trigger?: string;
	since?: string;
	task_id?: string;
	spec_ref?: string;
}

export interface SessionSearchMatch {
	session_id: string;
	event_seq: number;
	timestamp: number;
	event_type: string;
	content_excerpt: string;
}

export interface SessionSearchResult {
	session_id: string;
	agent_type: string;
	started_at: string;
	matches: SessionSearchMatch[];
}

export interface FetchSessionSearchParams {
	q: string;
	status?: string[];
	agent_id?: string;
	agent_type?: string;
	trigger?: string;
	since?: string;
	task_id?: string;
	spec_ref?: string;
	limit?: number;
}

export interface SessionSearchResponse {
	items: SessionSearchResult[];
	total_sessions: number;
	total_matches: number;
	query: string;
}

/**
 * Paginated session list response.
 * AC: @session-list-infinite-scroll ac-initial-load
 */
export interface SessionListResponse {
	items: SessionSummary[];
	total: number;
	unfiltered_total: number;
	offset: number;
	limit: number;
}

/**
 * Fetch sessions with pagination and filtering.
 * AC: @ui-session-stream ac-1
 * AC: @session-list-infinite-scroll ac-initial-load
 */
export async function fetchSessions(params?: FetchSessionsParams): Promise<SessionListResponse> {
	if (isStaticMode()) {
		return { items: [], total: 0, unfiltered_total: 0, offset: 0, limit: 25 };
	}

	const url = new URL(`${API_BASE}/api/sessions`);
	if (params?.offset !== undefined) {
		url.searchParams.set('offset', String(params.offset));
	}
	if (params?.limit !== undefined) {
		url.searchParams.set('limit', String(params.limit));
	}
	// AC: @session-filter-controls ac-status-filter — Multi-value status filter
	if (params?.status?.length) {
		for (const s of params.status) {
			url.searchParams.append('status', s);
		}
	}
	// AC: @session-filter-controls ac-agent-filter
	if (params?.agent_id) {
		url.searchParams.set('agent_id', params.agent_id);
	}
	// AC: @session-filter-controls ac-agent-type-filter
	if (params?.agent_type) {
		url.searchParams.set('agent_type', params.agent_type);
	}
	// AC: @session-filter-controls ac-trigger-filter
	if (params?.trigger) {
		url.searchParams.set('trigger', params.trigger);
	}
	// AC: @session-filter-controls ac-date-filter
	if (params?.since) {
		url.searchParams.set('since', params.since);
	}
	if (params?.task_id) {
		url.searchParams.set('task_id', params.task_id);
	}
	if (params?.spec_ref) {
		url.searchParams.set('spec_ref', params.spec_ref);
	}

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

export async function fetchSessionSearch(
	params: FetchSessionSearchParams
): Promise<SessionSearchResponse> {
	if (isStaticMode()) {
		return { items: [], total_sessions: 0, total_matches: 0, query: params.q };
	}

	const url = new URL(`${API_BASE}/api/sessions/search`);
	url.searchParams.set('q', params.q);
	if (params.limit !== undefined) {
		url.searchParams.set('limit', String(params.limit));
	}
	if (params.status?.length) {
		for (const s of params.status) {
			url.searchParams.append('status', s);
		}
	}
	if (params.agent_id) {
		url.searchParams.set('agent_id', params.agent_id);
	}
	if (params.agent_type) {
		url.searchParams.set('agent_type', params.agent_type);
	}
	if (params.trigger) {
		url.searchParams.set('trigger', params.trigger);
	}
	if (params.since) {
		url.searchParams.set('since', params.since);
	}
	if (params.task_id) {
		url.searchParams.set('task_id', params.task_id);
	}
	if (params.spec_ref) {
		url.searchParams.set('spec_ref', params.spec_ref);
	}

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

export async function fetchTaskSessions(ref: string): Promise<SessionListResponse> {
	if (isStaticMode()) {
		return { items: [], total: 0, offset: 0, limit: 0 };
	}

	const response = await fetch(`${API_BASE}/api/tasks/${ref}/sessions`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

export async function fetchItemSessions(ref: string): Promise<SessionListResponse> {
	if (isStaticMode()) {
		return { items: [], total: 0, offset: 0, limit: 0 };
	}

	const response = await fetch(`${API_BASE}/api/items/${ref}/sessions`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch a single session by ID.
 * AC: @ui-session-stream ac-4
 */
export async function fetchSession(id: string): Promise<SessionDetail> {
	if (isStaticMode()) {
		throw new Error('Session data not available in static mode');
	}

	const response = await fetch(`${API_BASE}/api/sessions/${id}`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch session events (optionally incremental via since_seq).
 * AC: @ui-session-stream ac-1, ac-2
 */
export async function fetchSessionEvents(
	id: string,
	sinceSeq?: number
): Promise<{ events: SessionEvent[]; total: number }> {
	if (isStaticMode()) {
		return { events: [], total: 0 };
	}

	const url = new URL(`${API_BASE}/api/sessions/${id}/events`);
	if (sinceSeq !== undefined) {
		url.searchParams.set('since_seq', String(sinceSeq));
	}

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

/**
 * Fetch a single session event by sequence number (on-demand tool output).
 * AC: @ws-session-event-streaming ac-tool-output-on-demand
 */
export async function fetchSessionEventDetail(
	id: string,
	seq: number
): Promise<SessionEvent> {
	if (isStaticMode()) {
		throw new Error('Session event detail not available in static mode');
	}

	const response = await fetch(`${API_BASE}/api/sessions/${id}/events/${seq}`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

// ============================================================
// Reviews API Functions
// AC: @review-records-web-ui ac-7
// ============================================================

/**
 * Fetch reviews linked to a task (via subject or related_refs).
 * Used by the task detail page to show linked review history.
 * AC: @review-records-web-ui ac-7
 */
export async function fetchReviewsForTask(taskRef: string): Promise<PaginatedResponse<ReviewSummary>> {
	if (isStaticMode()) {
		return { items: [], total: 0, offset: 0, limit: 0 };
	}

	const url = new URL(`${API_BASE}/api/reviews`);
	url.searchParams.set('task', taskRef);
	url.searchParams.set('status', 'all');

	const response = await fetch(url.toString(), {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

// ============================================================
// Validation & Alignment API Functions
// AC: @ui-validation-view ac-1
// ============================================================

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

export interface ValidationResponse {
	valid: boolean;
	schemaErrors: SchemaValidationError[];
	refErrors: RefValidationError[];
	refWarnings: RefValidationWarning[];
	orphans: OrphanItem[];
	completenessWarnings: CompletenessWarning[];
	traitCycles: TraitCycleError[];
}

/** Alias for backward compatibility with dashboard overview */
export type ValidationResult = ValidationResponse;

export interface AlignmentWarning {
	type: 'orphaned_spec' | 'status_mismatch' | 'stale_implementation';
	specUlid?: string;
	specTitle?: string;
	taskUlid?: string;
	message: string;
}

export interface AlignmentStats {
	totalSpecs: number;
	specsWithTasks: number;
	alignedSpecs: number;
	orphanedSpecs: number;
}

export interface AlignmentResponse {
	stats: AlignmentStats;
	warnings: AlignmentWarning[];
}

/**
 * Fetch validation results
 * AC: @ui-validation-view ac-1
 */
export async function fetchValidation(): Promise<ValidationResponse> {
	if (isStaticMode()) {
		return fetchValidationStatic();
	}

	const response = await fetch(`${API_BASE}/api/validate`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	const data = await response.json();
	// Normalize: ensure all array fields exist even if the API omits them
	return {
		valid: data.valid ?? true,
		schemaErrors: data.schemaErrors ?? [],
		refErrors: data.refErrors ?? [],
		refWarnings: data.refWarnings ?? [],
		orphans: data.orphans ?? [],
		completenessWarnings: data.completenessWarnings ?? [],
		traitCycles: data.traitCycles ?? []
	};
}

/**
 * Fetch alignment stats and warnings
 * AC: @ui-validation-view ac-1
 */
export async function fetchAlignment(): Promise<AlignmentResponse> {
	if (isStaticMode()) {
		return fetchAlignmentStatic();
	}

	const response = await fetch(`${API_BASE}/api/alignment`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}

	return response.json();
}

// ============================================================
// Settings API Functions
// AC: @ui-settings-view ac-1
// ============================================================

/**
 * Daemon health check response
 * AC: @ui-settings-view ac-1 — daemon connection info (port, uptime, version)
 */
export interface HealthResponse {
	status: string;
	uptime: number;
	connections: number;
	version: string;
}

/**
 * Project config from manifest + kspec.config.yaml
 * AC: @ui-settings-view ac-1 — project config (name, version, remote tracking)
 */
export interface ProjectConfig {
	project: { name: string; version: string; status: string } | null;
	spec_version: string | null;
	root_dir: string;
	remote_tracking: { value: string; type: string } | null;
	daemon: { port: number; host: string; auto_start: boolean };
}

/**
 * Shadow branch status
 * AC: @ui-settings-view ac-1 — shadow branch status
 */
export interface ShadowStatusResponse {
	enabled: boolean;
	branch_name: string | null;
	worktree_dir: string | null;
	healthy: boolean;
	remote_tracking: boolean;
}

/**
 * Fetch daemon health
 * AC: @ui-settings-view ac-1
 */
export async function fetchHealth(): Promise<HealthResponse> {
	const response = await fetch(`${API_BASE}/api/health`);
	if (!response.ok) {
		await handleResponseError(response);
	}
	return response.json();
}

/**
 * Fetch project config (manifest + kspec.config.yaml)
 * AC: @ui-settings-view ac-1
 */
export async function fetchProjectConfig(): Promise<ProjectConfig> {
	const response = await fetch(`${API_BASE}/api/meta/config`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
	return response.json();
}

/**
 * Fetch shadow branch status
 * AC: @ui-settings-view ac-1
 */
export async function fetchShadowStatus(): Promise<ShadowStatusResponse> {
	const response = await fetch(`${API_BASE}/api/meta/shadow`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
	return response.json();
}

/**
 * Fetch convention definitions
 * AC: @ui-settings-view ac-1
 */
export async function fetchConventions(): Promise<{ items: Convention[]; total: number }> {
	const response = await fetch(`${API_BASE}/api/meta/conventions`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
	return response.json();
}

/**
 * Fetch extended validation/alignment stats with entity and AC counts
 * AC: @ui-api-aggregation ac-2
 */
export async function fetchValidationAggregation(): Promise<ValidationAggregation> {
	const response = await fetch(`${API_BASE}/api/aggregation/validation`, {
		headers: getProjectHeaders()
	});
	if (!response.ok) {
		await handleResponseError(response);
	}
	return response.json();
}
