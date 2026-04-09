<!--
  AC: @web-dashboard ac-4, ac-5, ac-9, ac-10, ac-33, ac-default-active-filter
  AC: @multi-directory-daemon ac-27 - Reload on project change
  AC: @ui-data-freshness ac-1 — Renders from cache on revisit without loading state
  AC: @ui-data-freshness ac-3 — WebSocket events invalidate task queries via centralized wiring
-->
<script lang="ts">
	// AC: @web-dashboard ac-4, ac-5, ac-9, ac-10, ac-33, ac-default-active-filter
	// AC: @multi-directory-daemon ac-27 - Reload on project change
	import { page } from '$app/stores';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import type { TaskDetail, BroadcastEvent } from '@kynetic-ai/shared';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import TaskFilters, { ACTIVE_STATUSES } from '$lib/components/TaskFilters.svelte';
	import TaskList from '$lib/components/TaskList.svelte';
	import TaskDetailContent from '$lib/components/board/TaskDetailContent.svelte';
	import { fetchTasks, fetchTask, isCacheWarmingError } from '$lib/api';
	import CacheWarmingBanner from '$lib/components/CacheWarmingBanner.svelte';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import LayoutGrid from 'lucide-svelte/icons/layout-grid';
	import ListIcon from 'lucide-svelte/icons/list';

	const queryClient = useQueryClient();

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

	// AC: @ui-data-freshness ac-1 — createQuery caches results; revisits render from cache
	// AC: @ui-data-freshness ac-2 — Concurrent uses share the same in-flight request
	// AC: @multi-directory-daemon ac-27 — Re-fetches when project changes (isProjectInitialized toggles)
	const tasksQuery = createQuery(() => ({
		queryKey: queryKeys.tasks.list(filterParams),
		queryFn: () => fetchTasks(filterParams),
		enabled: isProjectInitialized(),
	}));

	let tasks = $derived(tasksQuery.data?.items ?? []);
	let total = $derived(tasksQuery.data?.total ?? 0);
	// AC: @ui-data-freshness ac-1 — Only show loading on initial fetch (no cache)
	let loading = $derived(tasksQuery.isLoading);
	// AC: @ui-data-freshness ac-warming-skeleton — Distinguish warming errors from other errors
	let cacheWarming = $derived(isCacheWarmingError(tasksQuery.error));
	let error = $derived(cacheWarming ? '' : (tasksQuery.error?.message ?? ''));

	// AC: Open task detail when URL has ref param
	$effect(() => {
		const urlRef = $page.url.searchParams.get('ref');
		if (urlRef && urlRef !== lastProcessedRef) {
			lastProcessedRef = urlRef;
			handleSelectTask(urlRef);
		}
		// When URL no longer has ?ref= (after goto in close effect), reset tracking
		if (!urlRef && lastProcessedRef) {
			lastProcessedRef = '';
		}
	});

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

	// AC: @ui-data-freshness ac-8 — Write operations invalidate related cache
	async function handleTaskUpdated() {
		// Invalidate task queries so list and detail refresh
		queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
		// Reload the task detail to reflect changes
		if (panelTask) {
			try {
				panelTask = await fetchTask(panelTask._ulid);
			} catch (err) {
				console.error('Error reloading task:', err);
			}
		}
	}

	// AC: @ui-task-board ac-7, @ui-url-panel-state ac-2 — Reset panel state and clear URL param when dialog closes
	$effect(() => {
		if (!dialogOpen) {
			panelTask = null;
			panelError = '';
			// Do NOT clear lastProcessedRef here — keep it set so the open effect
			// doesn't see the stale ?ref= as "new" while goto() is in flight.
			// lastProcessedRef gets cleared by the open effect when urlRef becomes null.
			const url = new URL($page.url);
			if (url.searchParams.has('ref')) {
				url.searchParams.delete('ref');
				goto(url, { replaceState: true, keepFocus: true, noScroll: true });
			}
		}
	});

	// AC: @web-dashboard ac-33 - Handle WebSocket task updates for highlight animation
	// Data reloading is handled by centralized ws-invalidation wiring (AC: @ui-data-freshness ac-3)
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
		// AC: @web-dashboard ac-32, ac-33 - Subscribe to task updates for highlight animation
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

	<!-- AC: @ui-data-freshness ac-warming-skeleton — Show skeleton during cache warming -->
	<!-- AC: @ui-data-freshness ac-warming-timeout — Show error banner after 30s timeout -->
	{#if cacheWarming}
		<CacheWarmingBanner entityName="tasks" queryKey={queryKeys.tasks.list(filterParams)} />
	{:else if loading}
		<div class="space-y-2" data-testid="tasks-loading">
			{#each Array(5) as _}
				<div class="h-16 rounded-lg bg-muted ds-shimmer"></div>
			{/each}
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
