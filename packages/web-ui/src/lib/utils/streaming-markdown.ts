import * as smd from 'streaming-markdown';
import { highlightCodeBlocks, normalizeLanguage } from './highlight';
import { isExternalHref, sanitizeHtml } from './sanitize';

export function createStreamingMarkdownRenderer(root: HTMLElement): smd.Default_Renderer {
	const renderer = smd.default_renderer(root);
	const setAttr = renderer.set_attr;

	renderer.set_attr = (data, attr, value) => {
		if (attr === smd.Attr.Lang) {
			const normalized = normalizeLanguage(value) ?? value.toLowerCase();
			setAttr(data, attr, `language-${normalized}`);
			const node = data.nodes[data.index];
			if (node instanceof HTMLElement) {
				node.dataset.language = normalized;
			}
			return;
		}

		setAttr(data, attr, value);

		if (attr === smd.Attr.Href) {
			const node = data.nodes[data.index];
			if (node instanceof HTMLAnchorElement && isExternalHref(value)) {
				node.target = '_blank';
				node.rel = 'noopener noreferrer';
			}
		}
	};

	return renderer;
}

export function finalizeStreamingMarkdown(root: HTMLElement): void {
	root.innerHTML = sanitizeHtml(root.innerHTML);
	highlightCodeBlocks(root);
}
