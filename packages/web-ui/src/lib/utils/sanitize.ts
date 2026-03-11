import DOMPurify from 'isomorphic-dompurify';

const ALLOWED_TAGS = [
	'p',
	'br',
	'b',
	'i',
	'em',
	'strong',
	'u',
	's',
	'del',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'code',
	'pre',
	'ul',
	'ol',
	'li',
	'a',
	'blockquote',
	'table',
	'thead',
	'tbody',
	'tfoot',
	'tr',
	'th',
	'td',
	'caption',
	'colgroup',
	'col',
	'hr',
	'span',
	'div',
	'img',
	'input'
] as const;

const ALLOWED_ATTR = [
	'href',
	'title',
	'class',
	'target',
	'rel',
	'src',
	'alt',
	'checked',
	'disabled',
	'type',
	'start',
	'aria-label',
	'aria-hidden',
	'role',
	'data-language'
] as const;

const SANITIZE_CONFIG = {
	ALLOWED_TAGS: [...ALLOWED_TAGS],
	ALLOWED_ATTR: [...ALLOWED_ATTR],
	ADD_ATTR: ['target', 'rel'],
	ALLOW_DATA_ATTR: true,
	ALLOW_UNKNOWN_PROTOCOLS: false
};

export function sanitizeHtml(dirtyHtml: string): string {
	if (!dirtyHtml) return '';
	const cleanHtml = DOMPurify.sanitize(dirtyHtml, SANITIZE_CONFIG) as string;
	return addExternalLinkSecurity(cleanHtml);
}

export function addExternalLinkSecurity(html: string): string {
	if (!html) return '';

	return html.replace(/<a\s+([^>]*href="([^"]+)"[^>]*)>/gi, (match: string, attrs: string, href: string) => {
		if (!isExternalHref(href)) return match;

		let nextAttrs = attrs;
		if (!/\btarget=/i.test(nextAttrs)) {
			nextAttrs += ' target="_blank"';
		}
		if (!/\brel=/i.test(nextAttrs)) {
			nextAttrs += ' rel="noopener noreferrer"';
		}
		return `<a ${nextAttrs}>`;
	});
}

export function isExternalHref(href?: string | null): boolean {
	return typeof href === 'string' && /^(https?:)?\/\//i.test(href);
}
