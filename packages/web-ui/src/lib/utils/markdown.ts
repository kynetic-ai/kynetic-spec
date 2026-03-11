import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

marked.setOptions({
	gfm: true,
	breaks: true
});

/**
 * Render markdown string to sanitized HTML.
 * Uses marked for parsing and DOMPurify for XSS protection.
 */
export function renderMarkdown(content: string): string {
	if (!content) return '';
	const rawHtml = marked.parse(content, { async: false }) as string;
	return DOMPurify.sanitize(rawHtml, {
		ADD_ATTR: ['target'],
		ALLOWED_TAGS: [
			'p',
			'br',
			'strong',
			'em',
			'del',
			'code',
			'pre',
			'blockquote',
			'ul',
			'ol',
			'li',
			'a',
			'h1',
			'h2',
			'h3',
			'h4',
			'h5',
			'h6',
			'hr',
			'table',
			'thead',
			'tbody',
			'tr',
			'th',
			'td',
			'img',
			'span',
			'div',
			'input'
		],
		ALLOWED_ATTR: [
			'href',
			'target',
			'rel',
			'src',
			'alt',
			'title',
			'class',
			'type',
			'checked',
			'disabled'
		]
	});
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
