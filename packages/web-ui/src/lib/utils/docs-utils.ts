/**
 * Pure utility functions for docs content — no virtual module dependencies.
 * Can be imported in both browser code and tests.
 */

import type { DocsEntry } from '../docs-types';

/**
 * Canonical order of docs sections as defined by @docs-section-taxonomy.
 * Sections not in this list are appended alphabetically after the known sections.
 */
export const DOCS_SECTION_ORDER = [
	'getting-started',
	'guides',
	'concepts',
	'troubleshooting',
	'release-notes',
] as const;

/**
 * Determine the section key for an entry. Uses path to detect section
 * landing pages whose slug has been normalized (e.g. slug "getting-started"
 * with path "getting-started/index.md" belongs to the "getting-started" section).
 */
function sectionKeyOf(entry: DocsEntry): string | null {
	const slashIdx = entry.path.indexOf('/');
	if (slashIdx === -1) return null; // root-level entry
	return entry.path.slice(0, slashIdx);
}

/**
 * Get entries in the same section as the given slug.
 * A "section" is the top-level directory segment. Section landing pages
 * (normalized from dir/index.md to bare dir slug) are included in their section.
 */
export function filterSectionEntries(entries: DocsEntry[], slug: string): DocsEntry[] {
	const slashIdx = slug.indexOf('/');
	let section: string;
	if (slashIdx === -1) {
		// Could be a section landing page (normalized index) or a root page.
		// Check if any entries have paths under this slug as a directory.
		const hasChildren = entries.some((e) => e.path.startsWith(slug + '/'));
		if (!hasChildren) {
			// True root page — return all root-level entries
			return entries.filter((e) => sectionKeyOf(e) === null);
		}
		section = slug;
	} else {
		section = slug.slice(0, slashIdx);
	}
	return entries.filter((e) => sectionKeyOf(e) === section);
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

	// Convert the resolved path to a slug (strip .md, normalize index)
	const resolvedPath = resolved.join('/');
	const slug = resolvedPath.replace(/\.md$/i, '');
	// Normalize index pages: "getting-started/index" → "getting-started"
	if (slug.endsWith('/index')) {
		return slug.slice(0, -'/index'.length);
	}
	return slug;
}

/**
 * Resolve a relative `.md` link from a doc page to its repo-root-relative path.
 * This handles links that escape the docs tree (e.g. `../INSTALL.md` from a
 * root-level doc) by computing where they point relative to the repository root.
 *
 * The docs directory is assumed to be at `docs/` in the repo root, so the
 * current doc's full repo path is `docs/<currentDocPath>`.
 *
 * Returns the repo-root-relative path (e.g. "INSTALL.md"), or null if the link
 * is not a `.md` link or resolves to an invalid path (too many `..` traversals).
 */
export function resolveOutOfTreeHref(href: string, currentDocPath: string): string | null {
	if (!href.endsWith('.md')) return null;

	// The current doc's directory relative to the repo root is docs/<dir>
	const slashIdx = currentDocPath.lastIndexOf('/');
	const currentDir = slashIdx === -1 ? '' : currentDocPath.slice(0, slashIdx);

	// Build the full path from repo root: ["docs", ...currentDir segments]
	const baseParts = ['docs', ...(currentDir ? currentDir.split('/') : [])];
	const hrefParts = href.split('/');

	const resolved: string[] = [...baseParts];
	for (const part of hrefParts) {
		if (part === '.' || part === '') continue;
		if (part === '..') {
			if (resolved.length === 0) return null; // walked above repo root
			resolved.pop();
		} else {
			resolved.push(part);
		}
	}

	return resolved.join('/');
}

export interface DocsSection {
	/** Directory name (e.g. "getting-started") used as the section key */
	key: string;
	/** Human-readable label (e.g. "Getting Started") */
	label: string;
	/** Entries in this section, preserving their original sort order */
	entries: DocsEntry[];
}

/**
 * Group docs entries into ordered sections following DOCS_SECTION_ORDER.
 * Root-level entries (no directory) are returned as a "root" section.
 * Unknown sections are appended alphabetically after the known sections.
 */
export function groupDocsSections(entries: DocsEntry[]): DocsSection[] {
	const rootEntries: DocsEntry[] = [];
	const dirGroups = new Map<string, DocsEntry[]>();

	for (const entry of entries) {
		const section = sectionKeyOf(entry);
		if (section === null) {
			rootEntries.push(entry);
		} else {
			if (!dirGroups.has(section)) dirGroups.set(section, []);
			dirGroups.get(section)!.push(entry);
		}
	}

	const sections: DocsSection[] = [];

	// Add known sections in canonical order
	for (const key of DOCS_SECTION_ORDER) {
		const sectionEntries = dirGroups.get(key);
		if (sectionEntries && sectionEntries.length > 0) {
			sections.push({
				key,
				label: humanizeDir(key),
				entries: sectionEntries,
			});
			dirGroups.delete(key);
		}
	}

	// Add any remaining unknown sections alphabetically
	const remaining = [...dirGroups.entries()].sort(([a], [b]) => a.localeCompare(b));
	for (const [key, sectionEntries] of remaining) {
		sections.push({
			key,
			label: humanizeDir(key),
			entries: sectionEntries,
		});
	}

	// Root-level entries go last (these are standalone pages not in any section)
	if (rootEntries.length > 0) {
		sections.push({
			key: '',
			label: 'Docs',
			entries: rootEntries,
		});
	}

	return sections;
}

function humanizeDir(dir: string): string {
	return dir
		.split('-')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}
