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

/**
 * Render docs markdown with anchored headings.
 * Returns both the rendered HTML and a table-of-contents structure.
 */
export function renderDocsMarkdown(content: string): { html: string; toc: TocEntry[] } {
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
				const attributes = [`href="${escapeHtmlAttribute(href)}"`];

				if (title) {
					attributes.push(`title="${escapeHtmlAttribute(title)}"`);
				}

				if (isExternalHref(href)) {
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
