<!--
  AC: @ui-session-stream ac-1 — Thinking blocks collapsed by default, expandable.
  AC: @ws-session-event-streaming ac-thinking-blocks — Thinking blocks stream progressively, collapsed by default.
-->
<script lang="ts">
	import type { ThinkingBlock as ThinkingBlockType } from './session-utils';
	import { formatTime } from './session-utils';
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import Brain from 'lucide-svelte/icons/brain';

	let { block }: { block: ThinkingBlockType } = $props();

	let expanded = $state(false);

	let preview = $derived(
		block.content.length > 80 ? block.content.slice(0, 80) + '\u2026' : block.content
	);
</script>

<div class="border-l-2 border-l-design-ring rounded-r-md bg-card/30" data-testid="thinking-block">
	<button
		class="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-accent/30 transition-colors"
		onclick={() => (expanded = !expanded)}
		aria-expanded={expanded}
	>
		<ChevronRight
			class="size-3.5 text-muted-foreground transition-transform {expanded ? 'rotate-90' : ''}"
		/>

		<span class="text-xs text-muted-foreground font-mono">{formatTime(block.timestamp)}</span>

		<Brain class="size-3.5 text-design-ring" />
		<span class="text-xs text-design-muted-fg">Thinking</span>

		{#if block.isStreaming}
			<span class="ds-session-active-dot size-1.5 rounded-full bg-design-ring inline-block"></span>
		{/if}

		{#if !expanded}
			<span class="text-xs text-muted-foreground/60 truncate flex-1 italic">{preview}</span>
		{/if}
	</button>

	{#if expanded}
		<div class="px-3 pb-3">
			<pre class="text-xs font-mono text-muted-foreground/80 whitespace-pre-wrap break-words max-h-96 overflow-y-auto">{block.content}</pre>
		</div>
	{/if}
</div>
