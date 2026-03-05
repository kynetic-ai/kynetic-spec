<!--
  AC: @ui-session-stream ac-1 — Tool calls rendered as collapsible blocks with icon, input/output, timing.
-->
<script lang="ts">
	import type { ToolCallBlock } from './session-utils';
	import { getToolIcon, getToolInputPreview, formatDuration, formatTime } from './session-utils';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import Loader from '@lucide/svelte/icons/loader';

	let { block }: { block: ToolCallBlock } = $props();

	let expanded = $state(block.status === 'running');

	let borderColor = $derived(
		block.status === 'completed'
			? 'border-l-emerald-500'
			: block.status === 'failed'
				? 'border-l-red-500'
				: 'border-l-blue-500'
	);

	let icon = $derived(getToolIcon(block.toolName));
	let preview = $derived(getToolInputPreview(block.toolName, block.input));

	function formatOutput(output: unknown): string {
		if (typeof output === 'string') return output;
		try {
			return JSON.stringify(output, null, 2);
		} catch {
			return String(output);
		}
	}

	function formatInput(input: unknown): string {
		if (typeof input === 'string') return input;
		try {
			return JSON.stringify(input, null, 2);
		} catch {
			return String(input);
		}
	}

	let outputText = $derived(block.output ? formatOutput(block.output) : '');
	let truncatedOutput = $derived(
		outputText.length > 1000 ? outputText.slice(0, 1000) : outputText
	);
	let isOutputTruncated = $derived(outputText.length > 1000);
	let showFullOutput = $state(false);
</script>

<div
	class="border-l-2 {borderColor} rounded-r-md bg-card/50"
	data-testid="tool-call-block"
	data-tool-call-id={block.toolCallId}
>
	<!-- Header (always visible) -->
	<button
		class="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-accent/30 transition-colors"
		onclick={() => (expanded = !expanded)}
		aria-expanded={expanded}
	>
		<ChevronRight
			class="size-3.5 text-muted-foreground transition-transform {expanded ? 'rotate-90' : ''}"
		/>

		<span class="text-xs text-muted-foreground font-mono">{formatTime(block.startedAt)}</span>

		<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono bg-secondary">
			<span>{icon}</span>
			{block.toolName}
		</span>

		{#if block.status === 'running'}
			<Loader class="size-3.5 text-blue-500 ds-tool-spin" />
		{:else if block.status === 'completed'}
			<Check class="size-3.5 text-emerald-500" />
		{:else if block.status === 'failed'}
			<X class="size-3.5 text-red-500" />
		{/if}

		{#if !expanded && preview}
			<span class="text-xs text-muted-foreground truncate flex-1">{preview}</span>
		{/if}

		{#if block.durationMs !== undefined}
			<span class="text-[10px] text-muted-foreground font-mono ml-auto flex-shrink-0">
				{formatDuration(block.durationMs)}
			</span>
		{/if}
	</button>

	<!-- Expanded content -->
	{#if expanded}
		<div class="px-3 pb-3 space-y-2">
			{#if block.input}
				<div>
					<p class="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Input</p>
					<pre class="text-xs font-mono bg-secondary/50 rounded p-2 overflow-x-auto max-h-60 whitespace-pre-wrap break-words">{formatInput(block.input)}</pre>
				</div>
			{/if}

			{#if block.output !== undefined}
				<div>
					<p class="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
						Output
						{#if block.status === 'failed'}
							<span class="text-red-500">(error)</span>
						{/if}
					</p>
					<pre class="text-xs font-mono bg-secondary/50 rounded p-2 overflow-x-auto max-h-80 whitespace-pre-wrap break-words {block.status === 'failed' ? 'text-red-400' : ''}">{showFullOutput ? outputText : truncatedOutput}</pre>
					{#if isOutputTruncated && !showFullOutput}
						<button
							class="text-xs text-primary hover:underline mt-1"
							onclick={() => (showFullOutput = true)}
						>
							Show full output ({outputText.length.toLocaleString()} chars)
						</button>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	@keyframes tool-spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}
	:global(.ds-tool-spin) {
		animation: tool-spin 1.5s linear infinite;
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.ds-tool-spin) {
			animation: none;
		}
	}
</style>
