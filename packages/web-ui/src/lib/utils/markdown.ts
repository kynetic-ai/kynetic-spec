import { marked } from 'marked';
import { highlightCode, INLINE_CODE_CLASS_NAMES, normalizeLanguage } from './highlight';
import { isExternalHref, sanitizeHtml } from './sanitize';

marked.setOptions({
	gfm: true,
	breaks: true
});

marked.use({
	renderer: {
		code({ text, lang }) {
			const language = normalizeLanguage(lang);
			const classNames = ['hljs'];

			if (language) {
				classNames.push(`language-${language}`);
			}

			return `<pre><code class="${classNames.join(' ')}"${language ? ` data-language="${escapeHtmlAttribute(language)}"` : ''}>${highlightCode(text, language)}</code></pre>`;
		},
		codespan({ text }) {
			return `<code class="${INLINE_CODE_CLASS_NAMES.join(' ')}">${escapeInlineCode(text)}</code>`;
		},
		link({ href, title, tokens }) {
			const text = this.parser.parseInline(tokens);
			const attributes = [`href="${escapeHtmlAttribute(href)}"`];

			if (title) {
				attributes.push(`title="${escapeHtmlAttribute(title)}"`);
			}

			if (isExternalHref(href)) {
				attributes.push('target="_blank"', 'rel="noopener noreferrer"');
			}

			return `<a ${attributes.join(' ')}>${text}</a>`;
		}
	}
});

/**
 * Render markdown string to sanitized HTML.
 * Uses marked for parsing, highlight.js for code fences, and DOMPurify for XSS protection.
 */
export function renderMarkdown(content: string): string {
	if (!content) return '';
	const rawHtml = marked.parse(content, { async: false }) as string;
	return sanitizeHtml(rawHtml);
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

function escapeInlineCode(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

/**
 * Render inline markdown string to sanitized HTML without wrapping block elements.
 * Useful for short fields like acceptance criteria labels that still need code/link formatting.
 */
export function renderInlineMarkdown(content: string): string {
	if (!content) return '';
	const rawHtml = marked.parseInline(content) as string;
	return DOMPurify.sanitize(rawHtml, {
		ADD_ATTR: ['target'],
		ALLOWED_TAGS: [
			'strong',
			'em',
			'del',
			'code',
			'a',
			'span',
			'br'
		],
		ALLOWED_ATTR: ['href', 'target', 'rel', 'title', 'class']
	});
}
