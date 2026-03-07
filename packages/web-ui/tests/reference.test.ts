/**
 * Unit tests for reference normalization and routing utilities.
 *
 * AC: @ui-reference-display ac-1 — Shared ReferenceLink displays resolved title,
 * slug/ULID as secondary, links to detail view, normalizes @ prefix.
 */

import { describe, it, expect } from 'vitest';
import { normalizeRef, shortRef, refHref } from '../src/lib/utils/reference';

describe('normalizeRef', () => {
	// AC: @ui-reference-display ac-1 — normalizes @ prefix (no double @@)
	it('strips leading @ from a reference', () => {
		expect(normalizeRef('@task-slug')).toBe('task-slug');
	});

	it('returns the same string if no leading @', () => {
		expect(normalizeRef('task-slug')).toBe('task-slug');
	});

	it('strips only the first @', () => {
		expect(normalizeRef('@@double')).toBe('@double');
	});

	it('handles empty string', () => {
		expect(normalizeRef('')).toBe('');
	});

	it('handles ULID format', () => {
		expect(normalizeRef('@01KK2NNQ0MJY54DX9PYHP4N1EA')).toBe('01KK2NNQ0MJY54DX9PYHP4N1EA');
	});
});

describe('shortRef', () => {
	// AC: @ui-reference-display ac-1 — shows slug or short ULID as secondary text
	it('returns first 8 chars of normalized ref', () => {
		expect(shortRef('@01KK2NNQ0MJY54DX9PYHP4N1EA')).toBe('01KK2NNQ');
	});

	it('returns full ref if shorter than 8 chars', () => {
		expect(shortRef('@short')).toBe('short');
	});

	it('normalizes before shortening', () => {
		expect(shortRef('@task-slug-long-name')).toBe('task-slu');
	});
});

describe('refHref', () => {
	// AC: @ui-reference-display ac-1 — links to the appropriate detail view
	it('generates task board URL', () => {
		const href = refHref('task', '@task-slug');
		expect(href).toBe('/tasks/board?ref=%40task-slug');
	});

	it('generates spec URL', () => {
		const href = refHref('spec', 'ui-reference-display');
		expect(href).toBe('/specs?ref=ui-reference-display');
	});

	it('generates plan URL', () => {
		const href = refHref('plan', '@plan-id');
		expect(href).toBe('/plans?ref=%40plan-id');
	});

	it('generates session URL with normalized ref', () => {
		const href = refHref('session', '@session-id');
		expect(href).toBe('/sessions/session-id');
	});

	it('prepends base path when provided', () => {
		const href = refHref('task', '@task-slug', '/kynetic-spec');
		expect(href).toBe('/kynetic-spec/tasks/board?ref=%40task-slug');
	});

	it('uses empty string as default base path', () => {
		const href = refHref('spec', 'my-spec');
		expect(href).toBe('/specs?ref=my-spec');
	});
});
