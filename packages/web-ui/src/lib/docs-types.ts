export interface DocsEntry {
	/** URL-safe slug derived from the file path (without .md extension) */
	slug: string;
	/** Human-readable title extracted from the first H1, or derived from filename */
	title: string;
	/** Raw markdown source */
	content: string;
	/** Original relative path from docs/ (e.g. "getting-started.md") */
	path: string;
}

export interface DocsManifest {
	entries: DocsEntry[];
	/** GitHub blob URL prefix for out-of-tree markdown links, or null if not configured */
	repoUrl: string | null;
}
