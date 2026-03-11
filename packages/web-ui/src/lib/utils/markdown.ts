import { marked } from 'marked';
import { highlightCode, normalizeLanguage } from './highlight';
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
