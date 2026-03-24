<script lang="ts">
	import { onMount } from 'svelte';
	import { createStreamingMarkdownController, type StreamingMarkdownController } from '$lib/utils/streaming-markdown';

	const {
		content = '',
		isStreaming = false,
		class: className = ''
	}: {
		content?: string;
		isStreaming?: boolean;
		class?: string;
	} = $props();

	const containerEl: HTMLDivElement | undefined = $state();
	let controller: StreamingMarkdownController | null = null;

	$effect(() => {
		if (!containerEl) return;
		controller ??= createStreamingMarkdownController(containerEl);
		controller.update(content ?? '', isStreaming);
	});

	onMount(() => {
		return () => {
			controller?.destroy();
			controller = null;
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
