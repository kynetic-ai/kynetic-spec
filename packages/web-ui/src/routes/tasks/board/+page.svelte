<!--
  AC: @ui-task-board ac-1 — Kanban board with columns
  AC: @ui-task-board ac-2 — Task cards with metadata
  AC: @ui-task-board ac-3 — Detail modal on click
  AC: @ui-task-board ac-4 — Active Fleet row
  AC: @ui-task-board ac-5 — Real-time WebSocket updates
  AC: @ui-task-board ac-6 — Task action buttons in modal
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import type { TaskSummary, BroadcastEvent } from '@kynetic-ai/shared';
	import { fetchTasks, fetchAgentStatus, type AgentDispatchStatus } from '$lib/api';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { getProjectVersion, isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
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
	import { replaceState } from '$app/navigation';

	let tasks = $state<TaskSummary[]>([]);
	let columns = $state<BoardColumn[]>([]);
	let loading = $state(true);
	let error = $state('');
	let agentStatus = $state<AgentDispatchStatus | null>(null);

	// AC: @ui-task-board ac-4 — Buffered output state per agent session
	let sessionStates = $state<Record<string, FleetSessionState>>({});

	// Derived: output lines per session (for ActiveFleetRow)
	let agentOutputLines = $derived<Record<string, string[]>>(
		Object.fromEntries(
			Object.entries(sessionStates).map(([id, s]) => [id, s.lines])
		)
	);

	// AC: @ui-task-board ac-4 — Lookup map: task_ref (@ULID or @slug) → title
	let taskTitles = $derived(
		Object.fromEntries(
			tasks.flatMap((t) => {
				const entries: [string, string][] = [
					[`@${t._ulid}`, t.title]
				];
				for (const slug of t.slugs) {
					entries.push([`@${slug}`, t.title]);
				}
				return entries;
			})
		)
	);

	// Detail modal state
	let modalOpen = $state(false);
	let selectedTaskRef = $state<string | null>(null);

	// Track last processed URL ref to avoid infinite loops
	let lastProcessedRef = $state('');

	$effect(() => {
		// Re-derive columns whenever tasks change
		columns = distributeToColumns(tasks);
	});

	// AC: @ui-task-board ac-5 — Load board when project is ready and reload on project change
	// Gates on isProjectInitialized() to prevent loading with wrong/missing project context.
	// Replaces the old onMount+$effect pattern that could race with project resolution.
	$effect(() => {
		const version = getProjectVersion();
		const ready = isProjectInitialized();
		if (!ready) return;
		loadBoard();
	});

	// Open task detail from URL param
	$effect(() => {
		const urlRef = $page.url.searchParams.get('ref');
		if (urlRef && urlRef !== lastProcessedRef) {
			lastProcessedRef = urlRef;
			selectedTaskRef = urlRef;
			modalOpen = true;
		}
	});

	// AC: @ui-task-board ac-7 — Clear component state and URL param when modal closes
	$effect(() => {
		if (!modalOpen) {
			selectedTaskRef = null;
			lastProcessedRef = '';
			const url = new URL($page.url);
			if (url.searchParams.has('ref')) {
				url.searchParams.delete('ref');
				replaceState(url, {});
			}
		}
	});

	async function loadBoard() {
		loading = true;
		error = '';
		try {
			const [taskResponse, statusResponse] = await Promise.all([
				fetchTasks({ limit: 500 }),
				fetchAgentStatus().catch(() => null)
			]);
			tasks = taskResponse.items;
			agentStatus = statusResponse;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load board';
		} finally {
			loading = false;
		}
	}

	function handleCardClick(task: TaskSummary) {
		selectedTaskRef = task._ulid;
		modalOpen = true;
	}

	function handleTaskUpdated() {
		loadBoard();
	}

	// AC: @ui-task-board ac-5 — WebSocket real-time updates
	function handleTaskUpdate(event: BroadcastEvent) {
		loadBoard();
	}

	// AC: @ui-task-board ac-4 — Refresh agent status on agent events
	function handleAgentUpdate(event: BroadcastEvent) {
		// AC: @ui-task-board ac-4 — Buffer text chunks into complete lines
		if (event.event === 'agent_text_chunk' && event.data?.session_id && event.data?.text) {
			const sessionId = event.data.session_id as string;
			const text = event.data.text as string;
			const current = sessionStates[sessionId] ?? createSessionState();
			sessionStates[sessionId] = processTextChunk(current, text);
			return;
		}

		// Invocation lifecycle events — refresh status and clean up stale state
		fetchAgentStatus()
			.then((status) => {
				agentStatus = status;
				// Clean up session states for sessions no longer active
				const activeSessions = new Set(
					status.active_invocations.map((inv) => inv.session_id)
				);
				for (const sessionId of Object.keys(sessionStates)) {
					if (!activeSessions.has(sessionId)) {
						delete sessionStates[sessionId];
					}
				}
			})
			.catch(() => {});
	}

	// Polling for agent elapsed time updates
	let agentPollTimer: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		// AC: @ui-task-board ac-5 — Subscribe to task and agent updates
		subscribe(['tasks', 'agents']);
		on('tasks', handleTaskUpdate);
		on('agents', handleAgentUpdate);

		// Poll agent status every 5s for elapsed time updates
		agentPollTimer = setInterval(() => {
			fetchAgentStatus()
				.then((status) => {
					agentStatus = status;
				})
				.catch(() => {});
		}, 5000);
	});

	onDestroy(() => {
		off('tasks', handleTaskUpdate);
		off('agents', handleAgentUpdate);
		unsubscribe(['tasks', 'agents']);
		if (agentPollTimer) clearInterval(agentPollTimer);
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
			<ActiveFleetRow status={agentStatus} outputLines={agentOutputLines} {taskTitles} />
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
