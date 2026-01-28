/**
 * Mode Store
 *
 * Manages the application mode: 'daemon' (live) or 'static' (read-only).
 * Detects whether the daemon is reachable and falls back to static JSON if not.
 *
 * AC Coverage:
 * - ac-11 (@gh-pages-export): Fetch JSON snapshot and render
 * - ac-12, ac-13 (@gh-pages-export): Deep linking support
 * - ac-15 (@gh-pages-export): Data freshness indicator
 * - ac-19 (@gh-pages-export): Build flag bypasses daemon check
 * - ac-20 (@gh-pages-export): Base path prefix for snapshot URL
 */

import type { KspecSnapshot } from '$lib/types/snapshot';
import { DAEMON_API_BASE } from '$lib/constants';
import { base } from '$app/paths';

// Build-time static mode flag (set via VITE_STATIC_MODE=true)
// When true, skip daemon detection entirely and load static snapshot directly
const BUILD_STATIC_MODE = import.meta.env.VITE_STATIC_MODE === 'true';

// Application modes
export type AppMode = 'loading' | 'daemon' | 'static';

// Reactive state
let mode = $state<AppMode>('loading');
let snapshotData = $state<KspecSnapshot | null>(null);
let initError = $state<string | null>(null);

/**
 * Initialize mode detection
 *
 * 1. If BUILD_STATIC_MODE, load static snapshot directly (no daemon check)
 * 2. Otherwise try daemon health check (2s timeout)
 * 3. Fall back to static JSON
 * 4. Show error state if neither available
 *
 * AC: @gh-pages-export ac-11, ac-19
 */
export async function initMode(): Promise<void> {
	// AC: @gh-pages-export ac-19 - Build flag bypasses daemon check
	if (BUILD_STATIC_MODE) {
		await loadStaticSnapshot();
		return;
	}

	// 1. Try daemon health check
	try {
		const response = await fetch(`${DAEMON_API_BASE}/health`, {
			signal: AbortSignal.timeout(2000)
		});
		if (response.ok) {
			mode = 'daemon';
			return;
		}
	} catch {
		// Daemon not available, try static fallback
	}

	// 2. Fall back to static JSON
	// AC: @gh-pages-export ac-11, ac-20 - Fetch kspec-snapshot.json with base path
	try {
		const response = await fetch(`${base}/kspec-snapshot.json`, {
			signal: AbortSignal.timeout(5000)
		});
		if (response.ok) {
			snapshotData = await response.json();
			mode = 'static';
			return;
		}
	} catch {
		// Static JSON not available either
	}

	// 3. Neither available - default to daemon mode and let connection error handling show message
	mode = 'daemon';
	initError = 'Unable to connect to daemon and no static snapshot available';
}

/**
 * Load static snapshot with proper base path handling
 * AC: @gh-pages-export ac-19, ac-20
 */
async function loadStaticSnapshot(): Promise<void> {
	try {
		const response = await fetch(`${base}/kspec-snapshot.json`, {
			signal: AbortSignal.timeout(5000)
		});
		if (response.ok) {
			snapshotData = await response.json();
			mode = 'static';
			return;
		}
		console.error('[Mode] Static snapshot fetch failed:', response.status);
	} catch (err) {
		console.error('[Mode] Static snapshot fetch error:', err);
	}
	// If static mode forced but load fails, stay in static mode with error
	// (Don't fall back to daemon - that would cause WebSocket attempts)
	mode = 'static';
	initError = 'Failed to load static snapshot';
}

/**
 * Check if running in static mode
 * AC: @gh-pages-export ac-11
 */
export function isStaticMode(): boolean {
	return mode === 'static';
}

/**
 * Check if running in daemon mode
 */
export function isDaemonMode(): boolean {
	return mode === 'daemon';
}

/**
 * Check if mode is still loading
 */
export function isLoading(): boolean {
	return mode === 'loading';
}

/**
 * Get the current mode
 */
export function getMode(): AppMode {
	return mode;
}

/**
 * Get the loaded snapshot data
 * AC: @gh-pages-export ac-11
 */
export function getSnapshot(): KspecSnapshot | null {
	return snapshotData;
}

/**
 * Get the export timestamp for freshness display
 * AC: @gh-pages-export ac-15
 */
export function getExportedAt(): string | null {
	return snapshotData?.exported_at ?? null;
}

/**
 * Get project info from snapshot
 */
export function getSnapshotProject(): { name: string; version?: string } | null {
	return snapshotData?.project ?? null;
}

/**
 * Get validation info from snapshot
 * AC: @gh-pages-export ac-14
 */
export function getSnapshotValidation(): KspecSnapshot['validation'] | null {
	return snapshotData?.validation ?? null;
}

/**
 * Get initialization error if any
 */
export function getInitError(): string | null {
	return initError;
}

/**
 * Read-Only Mode Error
 *
 * Error thrown when a write operation is attempted in static mode.
 * AC: @gh-pages-export ac-18
 */
export class ReadOnlyModeError extends Error {
	constructor(operation: string) {
		super(`Cannot ${operation} in read-only mode. Use the kspec CLI to make changes.`);
		this.name = 'ReadOnlyModeError';
	}
}

/**
 * Guard for write operations
 * AC: @gh-pages-export ac-18
 */
export function assertWritable(operation: string): void {
	if (isStaticMode()) {
		throw new ReadOnlyModeError(operation);
	}
}
