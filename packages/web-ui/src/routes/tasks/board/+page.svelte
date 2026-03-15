<!--
  AC: @ui-task-board ac-1 — Kanban board with columns
  AC: @ui-task-board ac-2 — Task cards with metadata
  AC: @ui-task-board ac-3 — Detail modal on click
  AC: @ui-task-board ac-4 — Active Fleet row
  AC: @ui-task-board ac-5 — Real-time WebSocket updates
  AC: @ui-task-board ac-6 — Task action buttons in modal
  AC: @ui-data-freshness ac-1 — Renders from cache on revisit without loading state
  AC: @ui-data-freshness ac-3 — WebSocket events invalidate queries via centralized wiring
  AC: @ui-data-freshness ac-4 — Agent status served from cache, not 5s polling
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import type { BroadcastEvent } from '@kynetic-ai/shared';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { fetchTasks, fetchAgentStatus, type AgentDispatchStatus } from '$lib/api';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { distributeToColumns, type BoardColumn } from '$lib/components/board/board-utils';
	import BoardColumnComponent from '$lib/components/board/BoardColumn.svelte';
	import ActiveFleetRow from '$lib/components/board/ActiveFleetRow.svelte';
	import TaskDetailModal from '$lib/components/board/TaskDetailModal.svelte';
	import BoardSkeleton from '$lib/components/board/BoardSkeleton.svelte';
	import {
		createSessionState,
		processTextChunk,
		type FleetSessionState,
	} from '$lib/components/board/fleet-buffer';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import List from '@lucide/svelte/icons/list';
	import { Button } from '$lib/components/ui/button';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';

	const queryClient = useQueryClient();

	// AC: @ui-task-board ac-4 — Buffered output state per agent session
	let sessionStates = $state<Record<string, FleetSessionState>>({});

	// --- TanStack Query: board data ---
	// AC: @ui-data-freshness ac-1 — createQuery caches; revisits render from cache
	// AC: @ui-data-freshness ac-2 — Concurrent uses share the same in-flight request
	const tasksQuery = createQuery(() => ({
		queryKey: queryKeys.tasks.list({}),
		queryFn: () => fetchTasks(),
		enabled: isProjectInitialized(),
	}));

	// AC: @ui-data-freshness ac-4 — Agent status served from cache, event-driven invalidation
	// Replaces 5s polling interval with cache + WS invalidation
	const agentStatusQuery = createQuery(() => ({
		queryKey: queryKeys.agents.status(),
		queryFn: () => fetchAgentStatus(),
		enabled: isProjectInitialized() && !isStaticMode(),
		staleTime: 10 * 1000,
	}));

	let tasks = $derived(tasksQuery.data?.items ?? []);
	let columns = $derived(distributeToColumns(tasks));
	let loading = $derived(tasksQuery.isLoading);
	let error = $derived(tasksQuery.error?.message ?? '');
	let agentStatus = $derived<AgentDispatchStatus | null>(agentStatusQuery.data ?? null);

	// Derived: output lines per session (for ActiveFleetRow)
	let agentOutputLines = $derived<Record<string, string[]>>(
		Object.fromEntries(
			Object.entries(sessionStates).map(([id, s]) => [id, s.lines])
		)
	);

	// Detail modal state
	let modalOpen = $state(false);
	let selectedTaskRef = $state<string | null>(null);

	// Track last processed URL ref to avoid infinite loops
	let lastProcessedRef = $state('');

	// Open task detail from URL param
	$effect(() => {
		const urlRef = $page.url.searchParams.get('ref');
		if (urlRef && urlRef !== lastProcessedRef) {
			lastProcessedRef = urlRef;
			selectedTaskRef = urlRef;
			modalOpen = true;
		}
	});

	// AC: @ui-task-board ac-7, @ui-url-panel-state ac-2 — Clear component state and URL param when modal closes
	$effect(() => {
		if (!modalOpen) {
			selectedTaskRef = null;
			lastProcessedRef = '';
			const url = new URL($page.url);
			if (url.searchParams.has('ref')) {
				url.searchParams.delete('ref');
				goto(url, { replaceState: true, keepFocus: true, noScroll: true });
			}
		}
	});

	function handleCardClick(task: { _ulid: string }) {
		selectedTaskRef = task._ulid;
		modalOpen = true;
	}

	// AC: @ui-data-freshness ac-8 — Write operations invalidate related cache
	function handleTaskUpdated() {
		queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
	}

	// AC: @ui-task-board ac-4 — Buffer agent session events (streaming stays outside TanStack Query)
	function handleAgentUpdate(event: BroadcastEvent) {
		const textEvents = new Set(['message_progress', 'message_complete', 'thinking_progress', 'thinking_complete']);
		if (textEvents.has(event.event) && event.data?.session_id && event.data?.text) {
			const sessionId = event.data.session_id as string;
			const text = event.data.text as string;
			const current = sessionStates[sessionId] ?? createSessionState();
			sessionStates[sessionId] = processTextChunk(current, text);
			return;
		}

		// Invocation lifecycle events — invalidate agent status query
		// AC: @ui-data-freshness ac-3 — WS event drives cache invalidation
		queryClient.invalidateQueries({ queryKey: queryKeys.agents.status() });
	}

	// Clean up session states for sessions no longer active.
	// Runs as a $effect so it reacts to fresh agentStatusQuery.data after invalidation completes,
	// rather than reading stale pre-invalidation cache in the WS handler.
	$effect(() => {
		const status = agentStatusQuery.data;
		if (!status) return;
		const activeSessions = new Set(
			status.active_invocations.map((inv) => inv.session_id)
		);
		for (const sessionId of Object.keys(sessionStates)) {
			if (!activeSessions.has(sessionId)) {
				delete sessionStates[sessionId];
			}
		}
	});

	onMount(() => {
		// AC: @ui-task-board ac-5 — Subscribe to agent events for text chunk streaming
		// Task data reloading handled by centralized ws-invalidation wiring
		if (!isStaticMode()) {
			subscribe(['agents']);
			on('agents', handleAgentUpdate);
		}
	});

	onDestroy(() => {
		if (!isStaticMode()) {
			off('agents', handleAgentUpdate);
			unsubscribe(['agents']);
		}
	});
</script>

<div class="flex flex-col h-full min-w-0">
	<!-- Header -->
	<div class="flex items-center justify-between p-6 pb-0">
		<div>
			<h1 class="text-2xl font-bold">Task Board</h1>
			{#if !loading && columns.length > 0}
				{@const visibleCount = columns.reduce((sum, col) => sum + col.tasks.length, 0)}
				<p class="text-sm text-muted-foreground">{visibleCount} tasks</p>
			{/if}
		</div>

		<!-- View toggle: Board / List -->
		<div class="flex items-center gap-1 border rounded-lg p-0.5">
			<Button
				variant="ghost"
				size="icon-sm"
				class="bg-accent"
				title="Board view"
				aria-pressed="true"
			>
				<LayoutGrid class="size-4" />
			</Button>
			<a href="{base}/tasks" title="List view">
				<Button variant="ghost" size="icon-sm" aria-pressed="false">
					<List class="size-4" />
				</Button>
			</a>
		</div>
	</div>

	<!-- Error -->
	{#if error}
		<div class="mx-6 mt-4 bg-destructive/10 text-destructive p-4 rounded-lg" role="alert" data-testid="board-error">
			{error}
		</div>
	{/if}

	<!-- Loading skeleton -->
	{#if loading}
		<BoardSkeleton />
	{:else if tasks.length === 0}
		<!-- Empty state -->
		<div class="flex flex-col items-center justify-center flex-1 py-16" data-testid="board-empty">
			<LayoutGrid class="size-12 text-muted-foreground/30 mb-4" />
			<h2 class="text-lg font-medium text-muted-foreground mb-1">No tasks yet</h2>
			<p class="text-sm text-muted-foreground">
				Create tasks using <code class="bg-muted px-1 rounded text-xs">kspec task add</code>
			</p>
		</div>
	{:else}
		<!-- AC: @ui-task-board ac-4 — Active Fleet Row -->
		<div class="px-6 pt-4">
			<ActiveFleetRow status={agentStatus} outputLines={agentOutputLines} />
		</div>

		<!-- AC: @ui-task-board ac-1 — Kanban Columns -->
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 p-6 pt-2 flex-1 min-h-0" data-testid="board-columns">
			{#each columns as column (column.id)}
				<BoardColumnComponent {column} onCardClick={handleCardClick} />
			{/each}
		</div>
	{/if}
</div>

<!-- AC: @ui-task-board ac-3, ac-6 — Detail Modal -->
<TaskDetailModal
	bind:open={modalOpen}
	bind:taskRef={selectedTaskRef}
	onTaskUpdated={handleTaskUpdated}
/>
