/**
 * API Client
 *
 * Helper functions for making requests to the kspec daemon API.
 * All functions use fetch with localhost:3456 as the base URL.
 *
 * AC Coverage:
 * - ac-26 (@multi-directory-daemon): X-Kspec-Dir header injection
 * - ac-36 (@multi-directory-daemon): Invalid project error detection
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
 */
export async function fetchTask(ref: string): Promise<TaskDetail> {
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
 */
export async function startTask(ref: string): Promise<void> {
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
 */
export async function addTaskNote(ref: string, content: string): Promise<void> {
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
 */
export async function fetchItems(params?: {
	type?: string | string[];
	tag?: string;
	limit?: number;
	offset?: number;
}): Promise<PaginatedResponse<ItemSummary>> {
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
 */
export async function fetchItem(ref: string): Promise<ItemDetail> {
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
 */
export async function fetchItemTasks(ref: string): Promise<PaginatedResponse<TaskSummary>> {
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
 */
export async function fetchInbox(params?: {
	limit?: number;
	offset?: number;
}): Promise<PaginatedResponse<InboxItem>> {
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
 */
export async function addInboxItem(text: string, tags?: string[]): Promise<InboxItem> {
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
 */
export async function deleteInboxItem(ref: string): Promise<void> {
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
 */
export async function fetchSessionContext(): Promise<SessionContext> {
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
 */
export async function fetchObservations(params?: {
	type?: 'friction' | 'success' | 'question' | 'idea';
	resolved?: boolean;
}): Promise<PaginatedResponse<Observation>> {
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
 */
export async function search(query: string): Promise<SearchResponse> {
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
