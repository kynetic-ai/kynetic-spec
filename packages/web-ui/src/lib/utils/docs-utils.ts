/**
 * Pure utility functions for docs content — no virtual module dependencies.
 * Can be imported in both browser code and tests.
 */

import type { DocsEntry } from '../docs-types';

/**
 * Get entries in the same section as the given slug.
 * A "section" is the top-level directory segment. Root pages (no slash)
 * belong to the root section and are returned when the slug is also at root.
 */
export function filterSectionEntries(entries: DocsEntry[], slug: string): DocsEntry[] {
	const slashIdx = slug.indexOf('/');
	if (slashIdx === -1) {
		// Root page — return all root-level entries (no slash in slug)
		return entries.filter((e) => !e.slug.includes('/'));
	}
	// Nested page — return all entries in the same top-level directory
	const section = slug.slice(0, slashIdx);
	return entries.filter((e) => e.slug.startsWith(section + '/') || e.slug === section);
}

/**
 * Resolve a relative markdown link against the current doc's path.
 * Handles `../FILE.md`, `./FILE.md`, and `FILE.md` relative to the source
 * doc's directory within the docs tree.
 *
 * Returns the resolved slug if the target is within the docs tree,
 * or null if the link points outside (e.g. `../INSTALL.md` from a root doc).
 */
export function resolveDocsLink(href: string, currentDocPath: string): string | null {
	// Only handle .md links
	if (!href.endsWith('.md')) return null;

	// Get the directory of the current doc (relative to docs/)
	const slashIdx = currentDocPath.lastIndexOf('/');
	const currentDir = slashIdx === -1 ? '' : currentDocPath.slice(0, slashIdx);

	// Split both into segments and resolve
	const baseParts = currentDir ? currentDir.split('/') : [];
	const hrefParts = href.split('/');

	const resolved: string[] = [...baseParts];
	for (const part of hrefParts) {
		if (part === '.' || part === '') continue;
		if (part === '..') {
			if (resolved.length === 0) return null; // walked outside docs/
			resolved.pop();
		} else {
			resolved.push(part);
		}
	}

	// Convert the resolved path to a slug (strip .md)
	const resolvedPath = resolved.join('/');
	return resolvedPath.replace(/\.md$/i, '');
}
