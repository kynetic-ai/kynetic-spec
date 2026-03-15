<!--
  AC: @ui-session-stream ac-1 — Session events render as structured blocks.
  AC: @ui-session-stream ac-2 — Live streaming via WebSocket session events.
  AC: @ui-session-stream ac-3 — Auto-scroll with jump-to-bottom.
  AC: @ui-session-stream ac-4 — Session context panel with metadata.
  AC: @ui-data-freshness ac-1 — Session detail renders from cache on revisit
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import type { SessionDetail, SessionEvent as SessionEventType } from '$lib/api';
	import { fetchSession, fetchSessionEvents } from '$lib/api';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import type { BroadcastEvent } from '@kynetic-ai/shared';
	import { parseEventsToBlocks, accumulateStreamingText, getLastSeq, type DisplayBlock } from '$lib/components/session/session-utils';
	import SessionStream from '$lib/components/session/SessionStream.svelte';
	import SessionContextPanel from '$lib/components/session/SessionContextPanel.svelte';
	import SessionStreamSkeleton from '$lib/components/session/SessionStreamSkeleton.svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { base } from '$app/paths';

	let sessionId = $derived($page.params.id);

	// --- Queries ---
	// AC: @ui-data-freshness ac-1 — createQuery caches session detail
	const sessionQuery = createQuery(() => ({
		queryKey: queryKeys.sessions.detail(sessionId),
		queryFn: () => fetchSession(sessionId),
		enabled: isProjectInitialized() && !isStaticMode(),
	}));

	// Events are fetched once and then incrementally updated via polling for live sessions.
	// We use manual state for events since they accumulate incrementally.
	let events = $state<SessionEventType[]>([]);
	let blocks = $state<DisplayBlock[]>([]);
	let eventsLoading = $state(true);
	let error = $state('');

	// AC: @ui-session-stream ac-2 — Live streaming state
	let streamingText = $state('');
	let isLive = $derived(sessionQuery.data?.status === 'active');
	let lastSeq = $state(-1);

	// Server-resolved task_title eliminates need for separate task title lookup
	let taskTitle = $derived<string | null>(sessionQuery.data?.task_title ?? null);
	let session = $derived<SessionDetail | null>(sessionQuery.data ?? null);

	let loading = $derived(sessionQuery.isLoading || eventsLoading);

	// Track whether initial events load has been triggered
	let eventsLoadTriggered = $state(false);

	// Reset events state when sessionId changes (SvelteKit may reuse component)
	let prevSessionId = $state(sessionId);
	$effect(() => {
		if (sessionId !== prevSessionId) {
			prevSessionId = sessionId;
			eventsLoadTriggered = false;
			events = [];
			blocks = [];
			eventsLoading = true;
			error = '';
			streamingText = '';
			lastSeq = -1;
		}
	});

	async function loadEvents() {
		if (isStaticMode()) {
			eventsLoading = false;
			error = '';
			return;
		}

		eventsLoading = true;
		error = '';
		try {
			const eventsData = await fetchSessionEvents(sessionId);
			events = eventsData.events;
			blocks = parseEventsToBlocks(events);
			lastSeq = getLastSeq(events);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load session events';
		} finally {
			eventsLoading = false;
		}
	}

	// AC: @ui-session-stream ac-2 — Periodic structured refresh for live sessions
	async function refreshEvents() {
		if (!isLive) return;
		try {
			const eventsData = await fetchSessionEvents(sessionId, lastSeq);
			if (eventsData.events.length > 0) {
				events = [...events, ...eventsData.events];
				blocks = parseEventsToBlocks(events);
				lastSeq = getLastSeq(events);
				// Clear streaming text when we get structured data
				streamingText = '';
			}
		} catch {
			// Ignore refresh errors — will retry on next interval
		}
	}

	// AC: @ui-session-stream ac-2 — WebSocket handler for live text chunks
	// AC: @ui-data-freshness ac-4 — Event-driven refresh replaces timer-based polling
	let refreshDebounceTimer: ReturnType<typeof setTimeout> | undefined;

	function handleAgentEvent(event: BroadcastEvent) {
		// Uses extracted utility for session-filtered text accumulation
		// AC: @session-event-broadcast ac-replaces-text-chunks
		streamingText = accumulateStreamingText(streamingText, event, sessionId);

		if (event.event === 'agent_invocation') {
			const data = event.data as { session_id?: string; status?: string };
			if (data.session_id === sessionId) {
				// Refresh immediately on invocation state changes
				refreshEvents();
			}
		} else if ((event.event === 'message_complete' || event.event === 'thinking_complete' || event.event === 'tool_call_complete') && isLive) {
			// Completion events trigger debounced structured event refresh.
			const data = event.data as { session_id?: string };
			if (data?.session_id === sessionId && !refreshDebounceTimer) {
				refreshDebounceTimer = setTimeout(() => {
					refreshDebounceTimer = undefined;
					refreshEvents();
				}, 3000);
			}
		} else if ((event.event === 'message_progress' || event.event === 'thinking_progress') && isLive) {
			// Progress events indicate the session is active — debounced refresh
			if (!refreshDebounceTimer) {
				refreshDebounceTimer = setTimeout(() => {
					refreshDebounceTimer = undefined;
					refreshEvents();
				}, 3000);
			}
		}
	}

	// Load events when session query resolves (only once per session)
	$effect(() => {
		if (sessionQuery.data && !isStaticMode() && !eventsLoadTriggered) {
			eventsLoadTriggered = true;
			loadEvents();
		}
	});

	onMount(() => {
		// Subscribe to agent events for live streaming
		if (!isStaticMode()) {
			subscribe(['agents']);
			on('agents', handleAgentEvent);
		}
	});

	onDestroy(() => {
		if (!isStaticMode()) {
			off('agents', handleAgentEvent);
			unsubscribe(['agents']);
		}
		if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
	});
</script>

<div class="flex flex-col h-full">
	<!-- Header -->
	<div class="flex items-center gap-3 px-4 py-3 border-b flex-shrink-0">
		<a
			href="{base}/sessions"
			class="text-muted-foreground hover:text-foreground transition-colors"
			title="Back to sessions"
		>
			<ArrowLeft class="size-4" />
		</a>
		<div>
			<h1 class="text-lg font-semibold">
				Session
				{#if session}
					<span class="font-mono text-sm text-muted-foreground ml-1">{session.id.slice(0, 8)}</span>
				{/if}
			</h1>
			{#if session}
				<p class="text-xs text-muted-foreground">
					{session.agent_type}
					{#if isLive}
						<span class="ds-session-active-dot size-1.5 rounded-full bg-status-completed inline-block ml-1"></span>
						<span class="text-status-completed">Live</span>
					{/if}
				</p>
			{/if}
		</div>
	</div>

	<!-- Error -->
	{#if error || sessionQuery.error}
		<div class="mx-4 mt-4 bg-destructive/10 text-destructive p-4 rounded-lg" role="alert" data-testid="session-error">
			{error || sessionQuery.error?.message}
		</div>
	{/if}

	<!-- Loading skeleton -->
	{#if loading}
		<SessionStreamSkeleton />
	{:else if isStaticMode()}
		<div class="mx-4 mt-4 rounded-lg border border-dashed p-6 text-sm text-muted-foreground" data-testid="session-static-message">
			Session history is not included in the static export. Open the live daemon-backed UI to inspect session streams.
		</div>
	{:else if session}
		<!-- Main content: context panel + stream -->
		<div class="flex flex-1 min-h-0">
			<!-- AC: @ui-session-stream ac-4 — Context panel with spec context, files, budget -->
			<SessionContextPanel {session} {blocks} {taskTitle} />

			<!-- AC: @ui-session-stream ac-1, ac-2, ac-3 — Event stream -->
			<SessionStream {blocks} {isLive} {streamingText} />
		</div>
	{/if}
</div>

<style>
	@keyframes session-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}
	:global(.ds-session-active-dot) {
		animation: session-pulse 2s ease-in-out infinite;
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.ds-session-active-dot) {
			animation: none;
		}
	}
</style>
