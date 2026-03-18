/**
 * Reference normalization and routing utilities.
 *
 * Provides consistent handling of @-prefixed references (tasks, specs, plans, sessions)
 * across the web UI. Normalizes @ prefixes, detects reference types, and generates
 * navigation URLs.
 *
 * AC: @ui-reference-display ac-1
 */

/** Types of entities that can be referenced in the UI. */
export type RefType = 'task' | 'spec' | 'plan' | 'session' | 'review';

/**
 * Strip the leading @ from a reference string if present.
 * Prevents double @@ when displaying with @ prefix.
 */
export function normalizeRef(ref: string): string {
	return ref.startsWith('@') ? ref.slice(1) : ref;
}

/** ULID pattern: 26 Crockford base32 characters (digits 0-9 + A-Z excluding I, L, O, U). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Check whether a normalized ref looks like a ULID.
 */
export function isUlid(ref: string): boolean {
	return ULID_RE.test(normalizeRef(ref));
}

/**
 * Get a short display version of a reference.
 * ULIDs are truncated to 8 chars; slugs are returned in full.
 */
export function shortRef(ref: string): string {
	const norm = normalizeRef(ref);
	return isUlid(norm) ? norm.slice(0, 8) : norm;
}

/**
 * Build the navigation URL for a given reference type and ID.
 * @param basePath - The SvelteKit base path (from $app/paths). Defaults to ''.
 */
export function refHref(type: RefType, ref: string, basePath = ''): string {
	const encoded = encodeURIComponent(ref);
	switch (type) {
		case 'task':
			return `${basePath}/tasks/board?ref=${encoded}`;
		case 'spec':
			return `${basePath}/specs?ref=${encoded}`;
		case 'plan':
			return `${basePath}/plans?ref=${encoded}`;
		case 'session':
			return `${basePath}/sessions/${normalizeRef(ref)}`;
		case 'review':
			return `${basePath}/reviews/${normalizeRef(ref)}`;
	}
}
