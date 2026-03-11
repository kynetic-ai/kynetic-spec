<script lang="ts">
	import { onMount } from 'svelte';
	import * as smd from 'streaming-markdown';
	import { createStreamingMarkdownRenderer, finalizeStreamingMarkdown } from '$lib/utils/streaming-markdown';

	type Parser = ReturnType<typeof smd.parser>;

	let {
		content = '',
		isStreaming = false,
		class: className = ''
	}: {
		content?: string;
		isStreaming?: boolean;
		class?: string;
	} = $props();

	let containerEl: HTMLDivElement | undefined = $state();
	let parser: Parser | null = null;
	let lastContent = '';
	let lastStreamingState: boolean | undefined;
	let hasFinalized = false;
	let pendingChunk = '';
	let frameId: number | null = null;

	function scheduleFrame(callback: FrameRequestCallback): number {
		return globalThis.requestAnimationFrame
			? globalThis.requestAnimationFrame(callback)
			: Number(globalThis.setTimeout(() => callback(performance.now()), 16));
	}

	function cancelFrame(frame: number): void {
		if (globalThis.cancelAnimationFrame) {
			globalThis.cancelAnimationFrame(frame);
			return;
		}
		clearTimeout(frame);
	}

	function ensureParser(): void {
		if (!containerEl || parser) return;
		parser = smd.parser(createStreamingMarkdownRenderer(containerEl));
	}

	function flushPendingChunk(): void {
		if (!parser || !pendingChunk) return;
		smd.parser_write(parser, pendingChunk);
		pendingChunk = '';
	}

	function queueChunk(chunk: string): void {
		if (!chunk) return;
		pendingChunk += chunk;
		if (frameId !== null) return;

		frameId = scheduleFrame(() => {
			frameId = null;
			flushPendingChunk();
		});
	}

	function clearScheduledFrame(): void {
		if (frameId === null) return;
		cancelFrame(frameId);
		frameId = null;
	}

	function resetParser(nextContent = ''): void {
		clearScheduledFrame();
		pendingChunk = '';
		hasFinalized = false;
		lastContent = '';

		if (!containerEl) return;

		containerEl.innerHTML = '';
		parser = smd.parser(createStreamingMarkdownRenderer(containerEl));

		if (nextContent) {
			queueChunk(nextContent);
			lastContent = nextContent;
		}
	}

	function finalizeCurrentOutput(): void {
		if (!parser || !containerEl || hasFinalized) return;
		clearScheduledFrame();
		flushPendingChunk();
		smd.parser_end(parser);
		finalizeStreamingMarkdown(containerEl);
		hasFinalized = true;
	}

	function renderStaticContent(nextContent: string): void {
		if (!containerEl) return;

		clearScheduledFrame();
		pendingChunk = '';
		containerEl.innerHTML = '';
		parser = smd.parser(createStreamingMarkdownRenderer(containerEl));
		lastContent = nextContent;

		if (nextContent) {
			smd.parser_write(parser, nextContent);
			smd.parser_end(parser);
			finalizeStreamingMarkdown(containerEl);
		}

		hasFinalized = true;
	}

	$effect(() => {
		if (!containerEl) return;

		ensureParser();

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
	});

	onMount(() => {
		return () => {
			clearScheduledFrame();
			parser = null;
		};
	});
</script>

<div class={`streaming-markdown prose prose-sm dark:prose-invert max-w-none break-words leading-relaxed ${className}`.trim()}>
	<div bind:this={containerEl} data-testid="streaming-markdown"></div>
	{#if isStreaming}
		<span class="ds-streaming-cursor" aria-hidden="true">{'\u258A'}</span>
	{/if}
</div>

<style>
	.streaming-markdown :global(pre),
	.streaming-markdown :global(pre code) {
		white-space: pre;
	}

	.streaming-markdown :global(ul ul),
	.streaming-markdown :global(ol ol),
	.streaming-markdown :global(ul ol),
	.streaming-markdown :global(ol ul) {
		margin-top: 0.25rem;
		margin-bottom: 0.25rem;
		margin-left: 1rem;
	}

	.streaming-markdown :global(a) {
		word-break: break-word;
	}
 </style>
