<!--
  AC: @ui-session-stream ac-1 — Agent messages rendered as markdown blocks.
  AC: @ws-session-event-streaming ac-message-start — Writing indicator for in-progress messages.
  AC: @ws-session-event-streaming ac-message-progress — Text streams line-by-line.
-->
<script lang="ts">
	import type { MessageBlock as MessageBlockType } from './session-utils';
	import { formatTime } from './session-utils';
	import { renderMarkdown } from '$lib/utils/markdown';
	import StreamingMarkdown from '$lib/components/markdown/StreamingMarkdown.svelte';

	const { block }: { block: MessageBlockType } = $props();

	const html = $derived(block.isStreaming ? '' : renderMarkdown(block.content));
</script>

<div class="py-2" data-testid="message-block">
	<div class="flex items-start gap-3">
		<div class="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
			<span class="text-xs font-bold text-primary">A</span>
		</div>
		<div class="flex-1 min-w-0">
			<div class="flex items-center gap-2 mb-1">
				<span class="text-xs font-medium text-muted-foreground">Agent</span>
				<span class="text-[10px] text-muted-foreground/60 font-mono">{formatTime(block.timestamp)}</span>
				{#if block.isStreaming}
					<span class="ds-session-active-dot size-1.5 rounded-full bg-primary inline-block"></span>
				{/if}
			</div>
			{#if block.isStreaming}
				<StreamingMarkdown content={block.content} isStreaming={true} />
			{:else}
				<div
					class="text-sm break-words leading-relaxed prose prose-sm dark:prose-invert max-w-none"
					data-testid="message-content"
				>
					{@html html}
				</div>
			{/if}
		</div>
	</div>
</div>
