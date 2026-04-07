<!--
  AC: @ui-session-stream ac-1 — Tool calls rendered as collapsible blocks with icon, input/output, timing.
  AC: @ws-session-event-streaming ac-tool-output-on-demand — Output fetched on expand via HTTP.
  AC: @ws-session-event-streaming ac-tool-call-start — Shows tool name and input in running state.
  AC: @ws-session-event-streaming ac-tool-call-complete — Updates status and duration.
-->
<script lang="ts">
	import type { ToolCallBlock } from './session-utils';
	import { getToolIcon, getToolInputPreview, formatDuration, formatTime } from './session-utils';
	import { ansiToHtml, containsAnsi, safeTruncateAnsi } from '$lib/utils/ansi';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import { fetchSessionEventDetail } from '$lib/api';
	import { queryKeys } from '$lib/query/keys.js';
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import Check from 'lucide-svelte/icons/check';
	import X from 'lucide-svelte/icons/x';
	import Loader from 'lucide-svelte/icons/loader';
	import RefreshCw from 'lucide-svelte/icons/refresh-cw';

	let {
		block,
		sessionId,
	}: {
		block: ToolCallBlock;
		sessionId: string;
	} = $props();

	let expanded = $state(false);

	let borderColor = $derived(
		block.status === 'completed'
			? 'border-l-status-completed'
			: block.status === 'failed'
				? 'border-l-status-blocked'
				: 'border-l-status-pending-review'
	);

	let icon = $derived(getToolIcon(block.toolName));
	let preview = $derived(getToolInputPreview(block.toolName, block.input));

	// AC: @ws-session-event-streaming ac-tool-output-on-demand — Fetch output on demand when expanded
	// Use resultSeq (the tool result event) when available; fall back to seq (tool call start event).
	// resultSeq points to the event that contains the actual output.
	let outputSeq = $derived(block.resultSeq ?? block.seq);
	let shouldFetchOutput = $derived(expanded && outputSeq >= 0 && block.output === undefined);

	const outputQuery = createQuery(() => ({
		queryKey: queryKeys.sessions.eventDetail(sessionId, outputSeq),
		queryFn: () => fetchSessionEventDetail(sessionId, outputSeq),
		enabled: shouldFetchOutput,
		staleTime: Infinity, // Tool output doesn't change
	}));

	// Extract output from the fetched event detail
	let fetchedOutput = $derived.by(() => {
		if (!outputQuery.data) return undefined;
		const data = outputQuery.data.data as Record<string, unknown> | null;
		if (!data) return undefined;
		// ACP format: data.sessionUpdate exists
		const update = (data.sessionUpdate ? data : (data.update as Record<string, unknown> | undefined)) as Record<string, unknown> | undefined;
		if (!update) return undefined;
		return update.rawOutput ?? update.output ?? update.content;
	});

	// Use inline output if present, otherwise fetched output
	let resolvedOutput = $derived(block.output ?? fetchedOutput);

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

	let outputText = $derived(resolvedOutput !== undefined ? formatOutput(resolvedOutput) : '');
	let truncatedOutput = $derived(safeTruncateAnsi(outputText, 1000));
	let isOutputTruncated = $derived(outputText.length > 1000);
	let showFullOutput = $state(false);
	let hasAnsi = $derived(containsAnsi(outputText));
	let renderedOutput = $derived(
		hasAnsi ? ansiToHtml(showFullOutput ? outputText : truncatedOutput) : ''
	);
</script>

<div
	class="border-l-2 {borderColor} rounded-r-md bg-card/50"
	data-testid="tool-call-block"
	data-tool-call-id={block.toolCallId}
>
	<!-- AC: @ui-session-stream ac-5 — Header enforces single-line layout with truncation -->
	<button
		class="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-accent/30 transition-colors overflow-hidden"
		onclick={() => (expanded = !expanded)}
		aria-expanded={expanded}
	>
		<ChevronRight
			class="size-3.5 flex-shrink-0 text-muted-foreground transition-transform {expanded ? 'rotate-90' : ''}"
		/>

		<span class="text-xs text-muted-foreground font-mono flex-shrink-0 whitespace-nowrap">{formatTime(block.startedAt)}</span>

		<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono bg-secondary min-w-0 max-w-[40%]">
			<span class="flex-shrink-0">{icon}</span>
			<span class="truncate">{block.toolName}</span>
		</span>

		{#if block.status === 'running'}
			<Loader class="size-3.5 flex-shrink-0 text-status-pending-review ds-tool-spin" />
		{:else if block.status === 'completed'}
			<Check class="size-3.5 flex-shrink-0 text-status-completed" />
		{:else if block.status === 'failed'}
			<X class="size-3.5 flex-shrink-0 text-status-blocked" />
		{/if}

		{#if !expanded && preview}
			<span class="text-xs text-muted-foreground truncate min-w-0">{preview}</span>
		{/if}

		{#if block.durationMs !== undefined}
			<span class="text-[10px] text-muted-foreground font-mono ml-auto flex-shrink-0 whitespace-nowrap">
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

			<!-- AC: @ws-session-event-streaming ac-tool-output-on-demand — Loading, error, and content states -->
			{#if shouldFetchOutput && outputQuery.isLoading}
				<div class="flex items-center gap-2 text-xs text-muted-foreground py-2" data-testid="tool-output-loading">
					<Loader class="size-3.5 ds-tool-spin" />
					Loading output...
				</div>
			{:else if shouldFetchOutput && outputQuery.isError}
				<div class="flex items-center gap-2 text-xs text-destructive py-2" data-testid="tool-output-error">
					<X class="size-3.5" />
					Failed to load output
					<button
						class="text-primary hover:underline ml-1"
						onclick={() => outputQuery.refetch()}
						data-testid="tool-output-retry"
					>
						<RefreshCw class="size-3 inline" />
						Retry
					</button>
				</div>
			{:else if resolvedOutput !== undefined}
				<div>
					<p class="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
						Output
						{#if block.status === 'failed'}
							<span class="text-destructive">(error)</span>
						{/if}
					</p>
					{#if hasAnsi}
					<pre class="text-xs font-mono bg-secondary/50 rounded p-2 overflow-x-auto max-h-80 whitespace-pre-wrap break-words {block.status === 'failed' ? 'text-destructive' : ''}">{@html renderedOutput}</pre>
				{:else}
					<pre class="text-xs font-mono bg-secondary/50 rounded p-2 overflow-x-auto max-h-80 whitespace-pre-wrap break-words {block.status === 'failed' ? 'text-destructive' : ''}">{showFullOutput ? outputText : truncatedOutput}</pre>
				{/if}
					{#if isOutputTruncated && !showFullOutput}
						<button
							class="text-xs text-primary hover:underline mt-1"
							onclick={() => (showFullOutput = true)}
						>
							Show full output ({outputText.length.toLocaleString()} chars)
						</button>
					{/if}
				</div>
			{:else if block.status === 'running'}
				<div class="text-xs text-muted-foreground py-1" data-testid="tool-output-pending">
					Tool is running...
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
