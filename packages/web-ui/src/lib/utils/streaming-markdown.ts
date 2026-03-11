import * as smd from 'streaming-markdown';
import { highlightCodeBlocks, normalizeLanguage } from './highlight';
import { isExternalHref, sanitizeHtml } from './sanitize';

type Parser = ReturnType<typeof smd.parser>;

export interface FrameScheduler {
	request(callback: FrameRequestCallback): number;
	cancel(frame: number): void;
}

export interface StreamingMarkdownControllerOptions {
	scheduler?: FrameScheduler;
	onChunkFlush?: (chunk: string) => void;
}

export interface StreamingMarkdownController {
	update(content: string, isStreaming: boolean): void;
	destroy(): void;
}

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

function createDefaultScheduler(): FrameScheduler {
	return {
		request(callback) {
			return globalThis.requestAnimationFrame
				? globalThis.requestAnimationFrame(callback)
				: Number(globalThis.setTimeout(() => callback(Date.now()), 16));
		},
		cancel(frame) {
			if (globalThis.cancelAnimationFrame) {
				globalThis.cancelAnimationFrame(frame);
				return;
			}
			clearTimeout(frame);
		}
	};
}

export function createStreamingMarkdownController(
	root: HTMLElement,
	options: StreamingMarkdownControllerOptions = {}
): StreamingMarkdownController {
	const scheduler = options.scheduler ?? createDefaultScheduler();

	let parser: Parser | null = smd.parser(createStreamingMarkdownRenderer(root));
	let lastContent = '';
	let lastStreamingState: boolean | undefined;
	let hasFinalized = false;
	let pendingChunk = '';
	let frameId: number | null = null;

	function flushPendingChunk(): void {
		if (!parser || !pendingChunk) return;
		const chunk = pendingChunk;
		pendingChunk = '';
		smd.parser_write(parser, chunk);
		options.onChunkFlush?.(chunk);
	}

	function queueChunk(chunk: string): void {
		if (!chunk) return;
		pendingChunk += chunk;
		if (frameId !== null) return;

		frameId = scheduler.request(() => {
			frameId = null;
			flushPendingChunk();
		});
	}

	function clearScheduledFrame(): void {
		if (frameId === null) return;
		scheduler.cancel(frameId);
		frameId = null;
	}

	function resetParser(nextContent = ''): void {
		clearScheduledFrame();
		pendingChunk = '';
		hasFinalized = false;
		lastContent = '';
		root.innerHTML = '';
		parser = smd.parser(createStreamingMarkdownRenderer(root));

		if (nextContent) {
			queueChunk(nextContent);
			lastContent = nextContent;
		}
	}

	function finalizeCurrentOutput(): void {
		if (!parser || hasFinalized) return;
		clearScheduledFrame();
		flushPendingChunk();
		smd.parser_end(parser);
		finalizeStreamingMarkdown(root);
		hasFinalized = true;
	}

	function renderStaticContent(nextContent: string): void {
		clearScheduledFrame();
		pendingChunk = '';
		root.innerHTML = '';
		parser = smd.parser(createStreamingMarkdownRenderer(root));
		lastContent = nextContent;

		if (nextContent) {
			smd.parser_write(parser, nextContent);
			smd.parser_end(parser);
			finalizeStreamingMarkdown(root);
		}

		hasFinalized = true;
	}

	return {
		update(content: string, isStreaming: boolean) {
			const nextContent = content ?? '';

			if (isStreaming) {
				hasFinalized = false;

				if (nextContent !== lastContent) {
					if (nextContent.startsWith(lastContent)) {
						queueChunk(nextContent.slice(lastContent.length));
					} else {
						resetParser(nextContent);
					}
					lastContent = nextContent;
				}

				lastStreamingState = true;
				return;
			}

			if (lastStreamingState) {
				if (nextContent !== lastContent) {
					if (nextContent.startsWith(lastContent)) {
						queueChunk(nextContent.slice(lastContent.length));
					} else {
						renderStaticContent(nextContent);
						lastStreamingState = false;
						return;
					}
					lastContent = nextContent;
				}

				finalizeCurrentOutput();
				lastStreamingState = false;
				return;
			}

			if (!hasFinalized || nextContent !== lastContent) {
				renderStaticContent(nextContent);
			}

			lastStreamingState = false;
		},

		destroy() {
			clearScheduledFrame();
			parser = null;
			pendingChunk = '';
		}
	};
}
