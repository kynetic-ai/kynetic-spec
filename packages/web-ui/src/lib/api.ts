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
	InboxItem,
	SessionContext,
	Observation,
	PaginatedResponse,
	ErrorResponse,
	SearchResponse
} from '@kynetic-ai/shared';
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
	fetchInboxStatic,
	fetchSessionContextStatic,
	fetchObservationsStatic,
	searchStatic
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
	status?: string;
	type?: string;
	tag?: string;
	assignee?: string;
	automation?: string;
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
 * Fetch spec items with optional filters
 * AC: @web-dashboard ac-11
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchItems(params?: {
	type?: string | string[];
	tag?: string;
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
