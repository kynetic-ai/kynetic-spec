<script lang="ts">
	// AC: @web-dashboard ac-4, ac-5, ac-9, ac-10, ac-33, ac-default-active-filter
	// AC: @multi-directory-daemon ac-27 - Reload on project change
	import { page } from '$app/stores';
	import { base } from '$app/paths';
	import { replaceState } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import type { TaskSummary, TaskDetail, BroadcastEvent } from '@kynetic-ai/shared';
	import TaskFilters, { ACTIVE_STATUSES } from '$lib/components/TaskFilters.svelte';
	import TaskList from '$lib/components/TaskList.svelte';
	import TaskDetailContent from '$lib/components/board/TaskDetailContent.svelte';
	import { fetchTasks, fetchTask } from '$lib/api';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { getProjectVersion, isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import ListIcon from '@lucide/svelte/icons/list';

	let tasks = $state<TaskSummary[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let error = $state('');
	let updatedTaskIds = $state<Set<string>>(new Set());

	// Dialog panel state
	let dialogOpen = $state(false);
	let panelTask = $state<TaskDetail | null>(null);
	let panelLoading = $state(false);
	let panelError = $state('');

	// AC: @web-dashboard ac-default-active-filter - Default to active statuses when no status param
	// "all" means show everything (no status filter), empty/absent means show active only
	function getStatusFilter(urlStatus: string | null): string | string[] | undefined {
		if (urlStatus === 'all') return undefined;
		if (urlStatus) return urlStatus;
		return [...ACTIVE_STATUSES];
	}

	let filterParams = $derived({
		status: getStatusFilter($page.url.searchParams.get('status')),
		tag: $page.url.searchParams.get('tag') || undefined,
		assignee: $page.url.searchParams.get('assignee') || undefined,
		automation: $page.url.searchParams.get('automation') || undefined,
		plan: $page.url.searchParams.get('plan') || undefined,
		limit: 50,
		offset: 0
	});

	// Track the last processed ref to avoid infinite loops
	let lastProcessedRef = $state('');

	// Re-fetch when filterParams change or project changes.
	// Gates on isProjectInitialized() to prevent loading with wrong/missing project context.
	// AC: @multi-directory-daemon ac-27 - Reload data when project changes
	$effect(() => {
		// Explicitly access all filter properties for dependency tracking
		const { status, tag, assignee, automation, plan, limit, offset } = filterParams;
		const version = getProjectVersion();
		const ready = isProjectInitialized();
		if (!ready) return;
		loadTasks();
	});

	// AC: Open task detail when URL has ref param
	$effect(() => {
		const urlRef = $page.url.searchParams.get('ref');
		if (urlRef && urlRef !== lastProcessedRef) {
			lastProcessedRef = urlRef;
			handleSelectTask(urlRef);
		}
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
		panelLoading = true;
		panelError = '';
		dialogOpen = true;
		try {
			panelTask = await fetchTask(taskId);
		} catch (err) {
			panelError = err instanceof Error ? err.message : 'Failed to load task details';
			console.error('Error loading task:', err);
		} finally {
			panelLoading = false;
		}
	}

	// Legacy event handler for backwards compatibility
	function handleSelectTaskEvent(event: CustomEvent<string>) {
		handleSelectTask(event.detail);
	}

	async function handleTaskUpdated() {
		// Reload the task detail to reflect changes
		if (panelTask) {
			try {
				panelTask = await fetchTask(panelTask._ulid);
			} catch (err) {
				console.error('Error reloading task:', err);
			}
		}
		// Reload the task list to reflect status changes
		loadTasks();
	}

	// AC: @ui-task-board ac-7 — Reset panel state and clear URL param when dialog closes
	$effect(() => {
		if (!dialogOpen) {
			panelTask = null;
			panelError = '';
			lastProcessedRef = '';
			const url = new URL($page.url);
			if (url.searchParams.has('ref')) {
				url.searchParams.delete('ref');
				replaceState(url, {});
			}
		}
	});

	// AC: @web-dashboard ac-33 - Handle WebSocket task updates
	function handleTaskUpdate(event: BroadcastEvent) {
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
		if (panelTask && event.data?.ulid === panelTask._ulid) {
			fetchTask(panelTask._ulid)
				.then((updated) => {
					panelTask = updated;
				})
				.catch((err) => {
					console.error('Error reloading task:', err);
				});
		}
	}

	onMount(() => {
		// AC: @web-dashboard ac-32, ac-33 - Subscribe to task updates
		subscribe(['tasks']);
		on('tasks', handleTaskUpdate);
	});

	onDestroy(() => {
		// Clean up subscription
		off('tasks', handleTaskUpdate);
		unsubscribe(['tasks']);
	});

	let slug = $derived(panelTask?.slugs?.[0] ?? panelTask?._ulid?.slice(0, 8) ?? '');
</script>

<div class="flex flex-col gap-6 p-6 min-w-0">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold mb-2">Tasks</h1>
			{#if !loading}
				<p class="text-muted-foreground">
					Showing {tasks.length} of {total} tasks
				</p>
			{/if}
		</div>
		<!-- View toggle -->
		<div class="flex items-center gap-1 border rounded-lg p-0.5">
			<a href="{base}/tasks/board" title="Board view">
				<Button variant="ghost" size="icon-sm" aria-pressed="false">
					<LayoutGrid class="size-4" />
				</Button>
			</a>
			<Button
				variant="ghost"
				size="icon-sm"
				class="bg-accent"
				title="List view"
				aria-pressed="true"
			>
				<ListIcon class="size-4" />
			</Button>
		</div>
	</div>

	<TaskFilters />

	{#if filterParams.plan}
		<div class="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-md px-3 py-2" data-testid="plan-filter-banner">
			Filtered by plan: <code class="bg-muted px-1 py-0.5 rounded text-xs">@{filterParams.plan}</code>
			<a href="{base}/tasks" class="ml-auto text-primary hover:underline text-xs">Clear filter</a>
		</div>
	{/if}

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

<!-- Task Detail Dialog Modal - AC: @web-dashboard ac-5, ac-6, ac-7, ac-8 -->
<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="task-detail-panel">
		{#if panelTask && !panelLoading && !panelError}
			<Dialog.Header>
				<Dialog.Title data-testid="task-detail-title">{panelTask.title}</Dialog.Title>
				<Dialog.Description>
					<span class="font-mono text-xs">@{slug}</span>
				</Dialog.Description>
			</Dialog.Header>
		{/if}

		<TaskDetailContent
			task={panelTask}
			loading={panelLoading}
			error={panelError}
			onTaskUpdated={handleTaskUpdated}
		/>
	</Dialog.Content>
</Dialog.Root>
