/**
 * API Client
 *
 * Helper functions for making requests to the kspec daemon API.
 * All functions use fetch with localhost:3456 as the base URL.
 */

import type {
	TaskSummary,
	TaskDetail,
	ItemSummary,
	ItemDetail,
	PaginatedResponse,
	ErrorResponse
} from '@kynetic-ai/shared';

const API_BASE = 'http://localhost:3456';

/**
 * Fetch tasks with optional filters
 * AC: @web-dashboard ac-9, ac-10
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

	const response = await fetch(url.toString());
	if (!response.ok) {
		const error: ErrorResponse = await response.json();
		throw new Error(error.message || error.error);
	}

	return response.json();
}

/**
 * Fetch single task by reference
 * AC: @web-dashboard ac-5
 */
export async function fetchTask(ref: string): Promise<TaskDetail> {
	const response = await fetch(`${API_BASE}/api/tasks/${ref}`);
	if (!response.ok) {
		const error: ErrorResponse = await response.json();
		throw new Error(error.message || error.error);
	}

	return response.json();
}

/**
 * Start a task (change status to in_progress)
 * AC: @web-dashboard ac-7
 */
export async function startTask(ref: string): Promise<void> {
	const response = await fetch(`${API_BASE}/api/tasks/${ref}/start`, {
		method: 'POST'
	});
	if (!response.ok) {
		const error: ErrorResponse = await response.json();
		throw new Error(error.message || error.error);
	}
}

/**
 * Add a note to a task
 * AC: @web-dashboard ac-8
 */
export async function addTaskNote(ref: string, content: string): Promise<void> {
	const response = await fetch(`${API_BASE}/api/tasks/${ref}/note`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ content })
	});
	if (!response.ok) {
		const error: ErrorResponse = await response.json();
		throw new Error(error.message || error.error);
	}
}

/**
 * Fetch spec items with optional filters
 * AC: @web-dashboard ac-11
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

	const response = await fetch(url.toString());
	if (!response.ok) {
		const error: ErrorResponse = await response.json();
		throw new Error(error.message || error.error);
	}

	return response.json();
}

/**
 * Fetch single spec item by reference
 * AC: @web-dashboard ac-12
 */
export async function fetchItem(ref: string): Promise<ItemDetail> {
	const response = await fetch(`${API_BASE}/api/items/${ref}`);
	if (!response.ok) {
		const error: ErrorResponse = await response.json();
		throw new Error(error.message || error.error);
	}

	return response.json();
}

/**
 * Fetch tasks linked to a spec item
 * AC: @web-dashboard ac-13
 */
export async function fetchItemTasks(ref: string): Promise<PaginatedResponse<TaskSummary>> {
	const response = await fetch(`${API_BASE}/api/items/${ref}/tasks`);
	if (!response.ok) {
		const error: ErrorResponse = await response.json();
		throw new Error(error.message || error.error);
	}

	return response.json();
}
