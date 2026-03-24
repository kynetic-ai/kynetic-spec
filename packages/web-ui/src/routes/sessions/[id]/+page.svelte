<!--
  AC: @ui-session-stream ac-1 — Session events render as structured blocks.
  AC: @ws-session-event-streaming ac-message-start — Writing indicator appears for in-progress messages.
  AC: @ws-session-event-streaming ac-message-progress — Text streams at newline boundaries.
  AC: @ws-session-event-streaming ac-message-complete — Remaining text flushed, indicator removed.
  AC: @ws-session-event-streaming ac-tool-call-start — Tool call block appears in running state.
  AC: @ws-session-event-streaming ac-tool-call-complete — Status and duration updated.
  AC: @ws-session-event-streaming ac-tool-output-on-demand — Output fetched on expand via ToolCallView.
  AC: @ws-session-event-streaming ac-thinking-blocks — Thinking blocks stream progressively.
  AC: @ws-session-event-streaming ac-historical-playback — Historical events fetched via HTTP.
  AC: @ws-session-event-streaming ac-live-session-catchup — HTTP catch-up then WS for live sessions.
  AC: @ws-session-event-streaming ac-no-http-polling — No periodic HTTP polling for live sessions.
  AC: @ws-session-event-streaming ac-reconnect-recovery — Gap fill on reconnection.
  AC: @ui-session-stream ac-3 — Auto-scroll with jump-to-bottom.
  AC: @ui-session-stream ac-4 — Session context panel with metadata.
  AC: @ui-data-freshness ac-1 — Session detail renders from cache on revisit.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import type { SessionDetail, SessionEvent as SessionEventType } from '$lib/api';
	import { fetchSession, fetchSessionEvents } from '$lib/api';
	import { subscribe, unsubscribe, on, off, onStateChange, offStateChange } from '$lib/stores/connection.svelte';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import type { BroadcastEvent } from '@kynetic-ai/shared';
	import type { ConnectionState } from '$lib/websocket/types';
	import {
		parseEventsToBlocks,
		incrementalBlockUpdate,
		stripToolOutput,
		getLastSeq,
		type DisplayBlock,
	} from '$lib/components/session/session-utils';
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
		enabled: isProjectInitialized(),
	}));

	// Events are fetched once on load (for catch-up/historical), then updated incrementally via WS.
	// Manual state since they accumulate incrementally.
	let events = $state<SessionEventType[]>([]);
	let blocks = $state<DisplayBlock[]>([]);
	let eventsLoading = $state(true);
	let error = $state('');

	let isLive = $derived(sessionQuery.data?.status === 'active');
	let lastSeq = $state(-1);

	// Server-resolved task_title eliminates need for separate task title lookup
	let taskTitle = $derived<string | null>(sessionQuery.data?.task_title ?? null);
	let session = $derived<SessionDetail | null>(sessionQuery.data ?? null);

	let loading = $derived(sessionQuery.isLoading || eventsLoading);

	// Track whether initial events load has been triggered
	let eventsLoadTriggered = $state(false);

	// Track whether WS was connected before (to detect reconnection)
	let wasConnected = $state(false);

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
			lastSeq = -1;
		}
	});

	// AC: @ws-session-event-streaming ac-historical-playback, ac-live-session-catchup
	// Load events via HTTP (initial load, catch-up, and gap fill after reconnect).
	// Tool output is stripped for on-demand loading (consistent UX).
	async function loadEvents(sinceSeq?: number) {
		if (isStaticMode()) {
			eventsLoading = false;
			error = '';
			return;
		}

		if (sinceSeq === undefined) {
			eventsLoading = true;
		}
		error = '';
		try {
			const eventsData = await fetchSessionEvents(sessionId, sinceSeq);
			if (sinceSeq !== undefined) {
				// Gap fill: append new events to existing
				if (eventsData.events.length > 0) {
					events = [...events, ...eventsData.events];
					// Re-parse all events to rebuild blocks (handles merging, tool call correlation)
					blocks = stripToolOutput(parseEventsToBlocks(events));
					lastSeq = getLastSeq(events);
				}
			} else {
				// Initial load
				events = eventsData.events;
				blocks = stripToolOutput(parseEventsToBlocks(events));
				lastSeq = getLastSeq(events);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load session events';
		} finally {
			eventsLoading = false;
		}
	}

	// AC: @ws-session-event-streaming ac-no-http-polling — No periodic polling.
	// All live activity arrives via WebSocket event handlers below.

	// AC: @ws-session-event-streaming — WebSocket handler for typed session lifecycle events
	function handleAgentEvent(event: BroadcastEvent) {
		const data = event.data as Record<string, unknown> | null;
		if (!data) return;

		// Filter events to this session
		if (data.session_id !== sessionId) return;

		// Session lifecycle events handled via incrementalBlockUpdate
		const sessionEventTypes = new Set([
			'message_start', 'message_progress', 'message_complete',
			'thinking_start', 'thinking_progress', 'thinking_complete',
			'tool_call_start', 'tool_call_input', 'tool_call_complete',
		]);

		if (sessionEventTypes.has(event.event)) {
			blocks = incrementalBlockUpdate(blocks, event.event, data);
		}

		// Agent invocation events: refresh session detail for status changes
		if (event.event === 'agent_invocation') {
			sessionQuery.refetch();
		}
	}

	// AC: @ws-session-event-streaming ac-reconnect-recovery — Fill gap on reconnection
	function handleStateChange(state: ConnectionState) {
		if (state === 'connected') {
			if (wasConnected && isLive) {
				// Reconnected after disconnect during live session — fill the gap
				loadEvents(lastSeq);
			}
			wasConnected = true;
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
			onStateChange(handleStateChange);
		}
	});

	onDestroy(() => {
		if (!isStaticMode()) {
			off('agents', handleAgentEvent);
			unsubscribe(['agents']);
			offStateChange(handleStateChange);
		}
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

			<!-- AC: @ui-session-stream ac-1, ac-3 — Event stream -->
			<SessionStream {blocks} {isLive} {sessionId} />
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
