<script lang="ts">
	// AC: @web-dashboard ac-4, ac-5, ac-9, ac-10
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import type { TaskSummary, TaskDetail as TaskDetailType } from '@kynetic-ai/shared';
	import TaskFilters from '$lib/components/TaskFilters.svelte';
	import TaskList from '$lib/components/TaskList.svelte';
	import TaskDetail from '$lib/components/TaskDetail.svelte';
	import { fetchTasks, fetchTask } from '$lib/api';

	let tasks: TaskSummary[] = [];
	let total = 0;
	let loading = true;
	let error = '';

	let selectedTaskId: string | null = null;
	let selectedTask: TaskDetailType | null = null;
	let detailOpen = false;

	// Reactive: re-fetch when URL params change
	$: filterParams = {
		status: $page.url.searchParams.get('status') || undefined,
		type: $page.url.searchParams.get('type') || undefined,
		tag: $page.url.searchParams.get('tag') || undefined,
		assignee: $page.url.searchParams.get('assignee') || undefined,
		automation: $page.url.searchParams.get('automation') || undefined,
		limit: 50,
		offset: 0
	};

	$: if (filterParams) {
		loadTasks();
	}

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

	async function handleSelectTask(event: CustomEvent<string>) {
		selectedTaskId = event.detail;
		try {
			selectedTask = await fetchTask(selectedTaskId);
			detailOpen = true;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load task details';
			console.error('Error loading task:', err);
		}
	}

	function handleCloseDetail() {
		detailOpen = false;
		selectedTask = null;
		selectedTaskId = null;
	}

	function handleUpdateTask() {
		// Reload tasks to reflect changes
		loadTasks();
		// Reload selected task detail
		if (selectedTaskId) {
			fetchTask(selectedTaskId)
				.then((task) => {
					selectedTask = task;
				})
				.catch((err) => {
					console.error('Error reloading task:', err);
				});
		}
	}

	onMount(() => {
		loadTasks();
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
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg">
			{error}
		</div>
	{/if}

	{#if loading}
		<div class="flex justify-center items-center py-12">
			<p class="text-muted-foreground">Loading tasks...</p>
		</div>
	{:else}
		<TaskList {tasks} on:select={handleSelectTask} />
	{/if}
</div>

<TaskDetail
	task={selectedTask}
	bind:open={detailOpen}
	on:close={handleCloseDetail}
	on:update={handleUpdateTask}
/>
