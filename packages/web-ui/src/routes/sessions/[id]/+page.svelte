<!--
  AC: @ui-session-stream ac-1 — Session events render as structured blocks.
  AC: @ui-session-stream ac-2 — Live streaming via WebSocket agent_text_chunk events.
  AC: @ui-session-stream ac-3 — Auto-scroll with jump-to-bottom.
  AC: @ui-session-stream ac-4 — Session context panel with metadata.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import type { SessionDetail, SessionEvent as SessionEventType } from '$lib/api';
	import { fetchSession, fetchSessionEvents, fetchTasks } from '$lib/api';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import type { BroadcastEvent } from '@kynetic-ai/shared';
	import { parseEventsToBlocks, accumulateStreamingText, getLastSeq, type DisplayBlock } from '$lib/components/session/session-utils';
	import SessionStream from '$lib/components/session/SessionStream.svelte';
	import SessionContextPanel from '$lib/components/session/SessionContextPanel.svelte';
	import SessionStreamSkeleton from '$lib/components/session/SessionStreamSkeleton.svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { base } from '$app/paths';

	let sessionId = $derived($page.params.id);

	let session = $state<SessionDetail | null>(null);
	let taskTitle = $state<string | null>(null);
	let events = $state<SessionEventType[]>([]);
	let blocks = $state<DisplayBlock[]>([]);
	let loading = $state(true);
	let error = $state('');

	// AC: @ui-session-stream ac-2 — Live streaming state
	let streamingText = $state('');
	let isLive = $derived(session?.status === 'active');
	let lastSeq = $state(-1);
	let refreshTimer: ReturnType<typeof setInterval> | undefined;

	async function loadSession() {
		if (isStaticMode()) {
			loading = false;
			error = '';
			return;
		}

		loading = true;
		error = '';
		try {
			const [sessionData, eventsData] = await Promise.all([
				fetchSession(sessionId),
				fetchSessionEvents(sessionId)
			]);
			session = sessionData;
			events = eventsData.events;
			blocks = parseEventsToBlocks(events);
			lastSeq = getLastSeq(events);

			// Resolve task title if the session has a task_id
			if (sessionData.task_id) {
				resolveTaskTitle(sessionData.task_id);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load session';
		} finally {
			loading = false;
		}
	}

	async function resolveTaskTitle(taskId: string) {
		try {
			const tasksData = await fetchTasks({ limit: 1000 });
			const ref = taskId.startsWith('@') ? taskId : `@${taskId}`;
			for (const task of tasksData.items) {
				if (`@${task._ulid}` === ref) {
					taskTitle = task.title;
					return;
				}
				for (const slug of task.slugs || []) {
					if (`@${slug}` === ref) {
						taskTitle = task.title;
						return;
					}
				}
			}
		} catch {
			// Non-critical — ReferenceLink falls back to raw ID display
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

			// Also refresh session metadata to detect status changes
			const sessionData = await fetchSession(sessionId);
			session = sessionData;
		} catch {
			// Ignore refresh errors — will retry on next interval
		}
	}

	// AC: @ui-session-stream ac-2 — WebSocket handler for live text chunks
	function handleAgentEvent(event: BroadcastEvent) {
		// Uses extracted utility for session-filtered text accumulation
		streamingText = accumulateStreamingText(streamingText, event, sessionId);

		if (event.event === 'agent_invocation') {
			const data = event.data as { session_id?: string; status?: string };
			if (data.session_id === sessionId) {
				// Refresh on invocation state changes
				refreshEvents();
			}
		}
	}

	onMount(() => {
		loadSession();

		// Subscribe to agent events for live streaming
		if (!isStaticMode()) {
			subscribe(['agents']);
			on('agents', handleAgentEvent);
		}

		// AC: @ui-session-stream ac-2 — Periodic refresh (every 3s for live sessions)
		if (!isStaticMode()) {
			refreshTimer = setInterval(() => {
				if (isLive) {
					refreshEvents();
				}
			}, 3000);
		}
	});

	onDestroy(() => {
		if (!isStaticMode()) {
			off('agents', handleAgentEvent);
			unsubscribe(['agents']);
		}
		if (refreshTimer) clearInterval(refreshTimer);
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
	{#if error}
		<div class="mx-4 mt-4 bg-destructive/10 text-destructive p-4 rounded-lg" role="alert" data-testid="session-error">
			{error}
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
