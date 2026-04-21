/**
 * Docs-specific markdown rendering with anchored headings.
 *
 * Extends the base marked pipeline with:
 * - Heading IDs for direct linking (AC: @docs-navigation-shape ac-2)
 * - TOC extraction from heading structure
 */
import { Marked } from "marked";
import { highlightCode, INLINE_CODE_CLASS_NAMES, normalizeLanguage } from "./highlight";
import { isExternalHref, sanitizeHtml } from "./sanitize";
import { resolveDocsLink, resolveOutOfTreeHref } from "./docs-utils";

export interface TocEntry {
	id: string;
	text: string;
	level: number;
}

/**
 * Slugify a heading text into a URL-safe anchor ID.
 * Matches common conventions (GitHub, etc.): lowercase, spaces to hyphens,
 * strip non-alphanumeric except hyphens.
 */
export function slugifyHeading(text: string): string {
	return text
		.toLowerCase()
		.replace(/<[^>]*>/g, "") // strip HTML tags
		.replace(/&[^;]+;/g, "") // strip HTML entities
		.replace(/\./g, "-") // dots to hyphens (version anchors: v0.13.0 → v0-13-0)
		.replace(/[^\w\s-]/g, "") // remove non-word chars (except spaces and hyphens)
		.replace(/\s+/g, "-") // spaces to hyphens
		.replace(/-+/g, "-") // collapse multiple hyphens
		.replace(/^-|-$/g, ""); // trim leading/trailing hyphens
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeInlineCode(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export interface DocsLinkContext {
	/** Relative path of the current doc from the docs root (e.g. "getting-started.md") */
	currentDocPath: string;
	/** Set of known slugs in the docs manifest */
	knownSlugs: ReadonlySet<string>;
	/** Base path for SPA routes (e.g. "" or "/kynetic-spec") */
	basePath: string;
	/** GitHub repository blob URL for out-of-tree links (e.g. "https://github.com/org/repo/blob/main") */
	repoUrl?: string;
}

/**
 * Render docs markdown with anchored headings.
 * Returns both the rendered HTML and a table-of-contents structure.
 *
 * When `linkContext` is provided, relative `.md` links that resolve to bundled
 * docs entries are rewritten to their SPA routes at render time, so they work
 * correctly without relying on the click interceptor.
 */
export function renderDocsMarkdown(content: string, linkContext?: DocsLinkContext): { html: string; toc: TocEntry[] } {
	if (!content) return { html: "", toc: [] };

	const toc: TocEntry[] = [];
	const usedIds = new Map<string, number>();

	// Create a dedicated Marked instance for docs rendering
	// so we don't interfere with the global marked config used elsewhere
	const docsMarked = new Marked({
		gfm: true,
		breaks: false, // docs prose should not treat single newlines as <br>
	});

	docsMarked.use({
		renderer: {
			// AC: @docs-navigation-shape ac-2 — anchored headings with stable links
			heading({ tokens, depth }) {
				const text = this.parser.parseInline(tokens);
				// Strip HTML for the slug and plain-text TOC entry
				const plainText = text.replace(/<[^>]*>/g, "");
				let id = slugifyHeading(plainText);

				// Handle duplicate IDs by appending a counter
				const count = usedIds.get(id) ?? 0;
				usedIds.set(id, count + 1);
				if (count > 0) {
					id = `${id}-${count}`;
				}

				toc.push({ id, text: plainText, level: depth });

				return `<h${depth} id="${escapeHtmlAttribute(id)}"><a class="anchor" href="#${escapeHtmlAttribute(id)}" aria-hidden="true">#</a>${text}</h${depth}>`;
			},
			code({ text, lang }) {
				const language = normalizeLanguage(lang);
				const classNames = ["hljs"];

				if (language) {
					classNames.push(`language-${language}`);
				}

				return `<pre><code class="${classNames.join(" ")}"${language ? ` data-language="${escapeHtmlAttribute(language)}"` : ""}>${highlightCode(text, language)}</code></pre>`;
			},
			codespan({ text }) {
				return `<code class="${INLINE_CODE_CLASS_NAMES.join(" ")}">${escapeInlineCode(text)}</code>`;
			},
			link({ href, title, tokens }) {
				const linkText = this.parser.parseInline(tokens);
				let resolvedHref = href;

				// Rewrite relative .md links that point to bundled docs entries
				if (linkContext && !href.startsWith("http") && !href.startsWith("//") && href.endsWith(".md")) {
					const slug = resolveDocsLink(href, linkContext.currentDocPath);
					if (slug !== null && linkContext.knownSlugs.has(slug)) {
						resolvedHref = `${linkContext.basePath}/docs/${slug}`;
					} else if (linkContext.repoUrl) {
						// Out-of-tree or unbundled .md links: rewrite to GitHub blob URL
						// so readers land on the actual file instead of a 404
						const repoPath = resolveOutOfTreeHref(href, linkContext.currentDocPath);
						if (repoPath !== null) {
							resolvedHref = `${linkContext.repoUrl}/${repoPath}`;
						}
					}
				}

				const attributes = [`href="${escapeHtmlAttribute(resolvedHref)}"`];

				if (title) {
					attributes.push(`title="${escapeHtmlAttribute(title)}"`);
				}

				if (isExternalHref(resolvedHref)) {
					attributes.push('target="_blank"', 'rel="noopener noreferrer"');
				}

				return `<a ${attributes.join(" ")}>${linkText}</a>`;
			},
		},
	});

	const rawHtml = docsMarked.parse(content, { async: false }) as string;
	const html = sanitizeHtml(rawHtml);

	return { html, toc };
}
