<!--
  AC: @ui-session-stream ac-1 — Session events render as structured blocks.
  AC: @ui-session-stream ac-3 — Auto-scroll behavior with jump-to-bottom button.
  AC: @ws-session-event-streaming ac-message-start — Writing indicator on streaming blocks.
-->
<script lang="ts">
	import { type DisplayBlock, shouldAutoScroll as computeShouldAutoScroll, shouldShowJumpButton as computeShowJumpButton } from './session-utils';
	import MessageBlock from './MessageBlock.svelte';
	import ToolCallView from './ToolCallView.svelte';
	import ThinkingBlock from './ThinkingBlock.svelte';
	import SystemBlock from './SystemBlock.svelte';
	import ArrowDown from 'lucide-svelte/icons/arrow-down';

	let {
		blocks,
		isLive = false,
		sessionId,
	}: {
		blocks: DisplayBlock[];
		isLive?: boolean;
		sessionId: string;
	} = $props();

	let scrollContainer: HTMLDivElement | undefined = $state();
	let autoScrollActive = $state(true);
	let userScrolling = $state(false);
	let scrollDebounceTimer: ReturnType<typeof setTimeout> | undefined;

	// Track whether any block is streaming (for auto-scroll reactivity)
	let hasStreamingBlock = $derived(blocks.some(
		(b) => (b.type === 'message' || b.type === 'thinking') && b.isStreaming
	));

	// AC: @ui-session-stream ac-3 — Pause auto-scroll when user scrolls up
	function handleScroll() {
		if (!scrollContainer) return;

		const { scrollHeight, scrollTop, clientHeight } = scrollContainer;

		// Clear existing debounce
		if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
		userScrolling = true;

		scrollDebounceTimer = setTimeout(() => {
			userScrolling = false;
		}, 150);

		// AC: @ui-session-stream ac-3 — Uses extracted utility for threshold calculation
		autoScrollActive = computeShouldAutoScroll(scrollHeight, scrollTop, clientHeight);
	}

	// AC: @ui-session-stream ac-3 — Auto-scroll to follow new content
	$effect(() => {
		// Track block count and streaming state to trigger scroll
		const _blockCount = blocks.length;
		const _streaming = hasStreamingBlock;

		if (autoScrollActive && !userScrolling && scrollContainer) {
			requestAnimationFrame(() => {
				if (scrollContainer) {
					scrollContainer.scrollTo({
						top: scrollContainer.scrollHeight,
						behavior: 'auto',
					});
				}
			});
		}
	});

	function jumpToBottom() {
		autoScrollActive = true;
		if (scrollContainer) {
			scrollContainer.scrollTo({
				top: scrollContainer.scrollHeight,
				behavior: 'smooth',
			});
		}
	}

	// AC: @ui-session-stream ac-3 — Uses extracted utility for button visibility
	let showJumpButton = $derived(computeShowJumpButton(autoScrollActive, isLive, blocks.length));

	// Use block index as key since WS-created blocks may have seq=-1
	function blockKey(block: DisplayBlock, index: number): string | number {
		return block.seq >= 0 ? block.seq : `ws-${index}`;
	}
</script>

<div class="relative flex-1 min-h-0">
	<div
		bind:this={scrollContainer}
		class="absolute inset-0 overflow-y-auto px-4 py-2"
		onscroll={handleScroll}
		data-testid="session-stream"
		aria-live={isLive ? 'polite' : undefined}
		aria-label="Session event stream"
		role="log"
	>
		{#each blocks as block, i (blockKey(block, i))}
			{#if block.type === 'message'}
				<MessageBlock {block} />
			{:else if block.type === 'tool_call'}
				<ToolCallView {block} {sessionId} />
			{:else if block.type === 'thinking'}
				<ThinkingBlock {block} />
			{:else if block.type === 'system'}
				<SystemBlock {block} />
			{/if}
		{/each}

		{#if blocks.length === 0}
			<div class="flex items-center justify-center h-full text-muted-foreground/50 text-sm" data-testid="stream-empty">
				{#if isLive}
					Waiting for agent output...
				{:else}
					No events recorded for this session.
				{/if}
			</div>
		{/if}
	</div>

	<!-- AC: @ui-session-stream ac-3 — Jump to bottom button -->
	{#if showJumpButton}
		<button
			class="absolute bottom-4 right-6 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg hover:bg-primary/90 transition-colors"
			onclick={jumpToBottom}
			data-testid="jump-to-bottom"
		>
			<ArrowDown class="size-3.5" />
			Jump to bottom
		</button>
	{/if}
</div>

<style>
	@keyframes cursor-blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0; }
	}
	:global(.ds-streaming-cursor) {
		color: var(--design-primary);
		animation: cursor-blink 1s step-end infinite;
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.ds-streaming-cursor) {
			animation: none;
			opacity: 1;
		}
	}
</style>
