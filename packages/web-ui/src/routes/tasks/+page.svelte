<script lang="ts">
	// AC: @web-dashboard ac-4, ac-5, ac-9, ac-10, ac-33
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import type { TaskSummary, BroadcastEvent } from '@kynetic-ai/shared';
	import TaskFilters from '$lib/components/TaskFilters.svelte';
	import TaskList from '$lib/components/TaskList.svelte';
	import TaskDetailPanel from '$lib/components/TaskDetailPanel.svelte';
	import { fetchTasks, fetchTask } from '$lib/api';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { taskDetailStore } from '$lib/stores/taskDetail.svelte';

	let tasks = $state<TaskSummary[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let error = $state('');
	let updatedTaskIds = $state<Set<string>>(new Set());

	// Reactive: re-fetch when URL params change
	let filterParams = $derived({
		status: $page.url.searchParams.get('status') || undefined,
		type: $page.url.searchParams.get('type') || undefined,
		tag: $page.url.searchParams.get('tag') || undefined,
		assignee: $page.url.searchParams.get('assignee') || undefined,
		automation: $page.url.searchParams.get('automation') || undefined,
		limit: 50,
		offset: 0
	});

	$effect(() => {
		// Re-fetch when filterParams changes
		filterParams;
		loadTasks();
	});

	async function loadTasks() {
		loading = true;
		error = '';

		try {
			const response = await fetchTasks(filterParams);
			tasks = response.items;
			total = response.total;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load tasks';
			console.error('Error loading tasks:', err);
		} finally {
			loading = false;
		}
	}

	async function handleSelectTask(taskId: string) {
		console.log('[TasksPage] handleSelectTask called for:', taskId);
		try {
			console.log('[TasksPage] Fetching task details...');
			const task = await fetchTask(taskId);
			console.log('[TasksPage] Task fetched:', task?.title, 'Opening store...');
			// Use store to bypass Portal reactivity issues
			taskDetailStore.openWith(task);
			console.log('[TasksPage] Store open is now:', taskDetailStore.open);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load task details';
			console.error('[TasksPage] Error loading task:', err);
		}
	}

	// Legacy event handler for backwards compatibility
	function handleSelectTaskEvent(event: CustomEvent<string>) {
		handleSelectTask(event.detail);
	}

	function handleCloseDetail() {
		taskDetailStore.close();
	}

	function handleUpdateTask() {
		// Reload tasks to reflect changes
		loadTasks();
		// Reload selected task detail
		const currentTask = taskDetailStore.task;
		if (currentTask) {
			fetchTask(currentTask._ulid)
				.then((task) => {
					taskDetailStore.task = task;
				})
				.catch((err) => {
					console.error('Error reloading task:', err);
				});
		}
	}

	// AC: @web-dashboard ac-33 - Handle WebSocket task updates
	function handleTaskUpdate(event: BroadcastEvent) {
		console.log('[TasksPage] Task update received:', event);

		// Mark task as updated for highlight animation
		if (event.data?.ulid) {
			updatedTaskIds.add(event.data.ulid);
			updatedTaskIds = new Set(updatedTaskIds);

			// Remove highlight after 3s
			setTimeout(() => {
				updatedTaskIds.delete(event.data.ulid);
				updatedTaskIds = new Set(updatedTaskIds);
			}, 3000);
		}

		// Reload tasks list
		loadTasks();

		// Reload selected task if it's the one that updated
		const currentTask = taskDetailStore.task;
		if (currentTask && event.data?.ulid === currentTask._ulid) {
			fetchTask(currentTask._ulid)
				.then((task) => {
					taskDetailStore.task = task;
				})
				.catch((err) => {
					console.error('Error reloading task:', err);
				});
		}
	}

	onMount(() => {
		loadTasks();

		// AC: @web-dashboard ac-32, ac-33 - Subscribe to task updates
		subscribe(['tasks']);
		on('tasks', handleTaskUpdate);
	});

	onDestroy(() => {
		// Clean up subscription
		off('tasks', handleTaskUpdate);
		unsubscribe(['tasks']);
	});
</script>

<div class="flex flex-col gap-6 p-6">
	<div>
		<h1 class="text-3xl font-bold mb-2">Tasks</h1>
		{#if !loading}
			<p class="text-muted-foreground">
				Showing {tasks.length} of {total} tasks
			</p>
		{/if}
	</div>

	<TaskFilters />

	{#if error}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg" data-testid="error-message" role="alert">
			{error}
		</div>
	{/if}

	{#if loading}
		<div class="flex justify-center items-center py-12">
			<p class="text-muted-foreground">Loading tasks...</p>
		</div>
	{:else}
		<!-- AC: @web-dashboard ac-33 -->
		<TaskList {tasks} {updatedTaskIds} onSelectTask={handleSelectTask} on:select={handleSelectTaskEvent} />
	{/if}
</div>

<TaskDetailPanel
	onclose={handleCloseDetail}
	onupdate={handleUpdateTask}
/>
