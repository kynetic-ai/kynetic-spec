<script lang="ts">
	// AC: @web-dashboard ac-4, ac-5, ac-9, ac-10, ac-33
	import { page } from '$app/stores';
	import { onMount, onDestroy, flushSync } from 'svelte';
	import type { TaskSummary, TaskDetail, BroadcastEvent } from '@kynetic-ai/shared';
	import TaskFilters from '$lib/components/TaskFilters.svelte';
	import TaskList from '$lib/components/TaskList.svelte';
	import { fetchTasks, fetchTask, startTask, addTaskNote } from '$lib/api';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Separator } from '$lib/components/ui/separator';
	import XIcon from '@lucide/svelte/icons/x';

	let tasks = $state<TaskSummary[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let error = $state('');
	let updatedTaskIds = $state<Set<string>>(new Set());

	// Use $state with an object for panel state to ensure deep reactivity
	let panel = $state<{ open: boolean; task: TaskDetail | null }>({
		open: false,
		task: null
	});

	let noteContent = $state('');
	let isSubmitting = $state(false);
	let panelError = $state('');

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
			console.log('[TasksPage] Task fetched:', task?.title);
			// Update panel state using flushSync to ensure synchronous DOM update
			flushSync(() => {
				panel.task = task;
				panel.open = true;
			});
			console.log('[TasksPage] panel.open set to true, panel.task:', panel.task?.title);
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
		panel.open = false;
		panel.task = null;
		noteContent = '';
		panelError = '';
	}

	// Handle clicking outside the panel
	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			handleCloseDetail();
		}
	}

	// Handle escape key
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && panel.open) {
			handleCloseDetail();
		}
	}

	async function handleStartTask() {
		if (!panel.task) return;

		isSubmitting = true;
		panelError = '';

		try {
			await startTask(panel.task._ulid);
			// Reload task to get updated status
			const updated = await fetchTask(panel.task._ulid);
			panel.task = updated;
			loadTasks();
		} catch (err) {
			panelError = err instanceof Error ? err.message : 'Failed to start task';
		} finally {
			isSubmitting = false;
		}
	}

	async function handleAddNote() {
		if (!panel.task || !noteContent.trim()) return;

		isSubmitting = true;
		panelError = '';

		try {
			await addTaskNote(panel.task._ulid, noteContent);
			noteContent = '';
			// Reload task to get updated notes
			const updated = await fetchTask(panel.task._ulid);
			panel.task = updated;
			loadTasks();
		} catch (err) {
			panelError = err instanceof Error ? err.message : 'Failed to add note';
		} finally {
			isSubmitting = false;
		}
	}

	function formatDate(dateStr: string): string {
		const date = new Date(dateStr);
		return new Intl.DateTimeFormat('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(date);
	}

	function getStatusColor(status: string): string {
		const colors: Record<string, string> = {
			pending: 'bg-gray-500',
			in_progress: 'bg-blue-500',
			pending_review: 'bg-yellow-500',
			blocked: 'bg-red-500',
			completed: 'bg-green-500',
			cancelled: 'bg-gray-400'
		};
		return colors[status] || 'bg-gray-500';
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
		if (panel.task && event.data?.ulid === panel.task._ulid) {
			fetchTask(panel.task._ulid)
				.then((updated) => {
					panel.task = updated;
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

<svelte:window onkeydown={handleKeydown} />

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

<!-- Inline Task Detail Panel - AC: @web-dashboard ac-5, ac-6, ac-7, ac-8 -->
{#if panel.open && panel.task}
	<div
		class="fixed inset-0 z-50 bg-black/50"
		onclick={handleOverlayClick}
		onkeydown={(e) => e.key === 'Enter' && handleCloseDetail()}
		role="button"
		tabindex="-1"
		aria-label="Close panel"
	>
		<!-- Panel -->
		<div
			class="fixed inset-y-0 right-0 z-50 w-3/4 max-w-lg bg-background shadow-lg border-l overflow-y-auto"
			data-testid="task-detail-panel"
			role="dialog"
			aria-modal="true"
			tabindex="0"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<!-- Header -->
			<div class="flex items-center justify-between p-6 border-b">
				<h2 class="text-lg font-semibold" data-testid="task-description">{panel.task.title}</h2>
				<button
					onclick={handleCloseDetail}
					class="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
				>
					<XIcon class="size-4" />
					<span class="sr-only">Close</span>
				</button>
			</div>

			<!-- Content -->
			<div class="flex flex-col gap-4 p-6">
				<!-- Status and Priority -->
				<div class="flex gap-2 items-center">
					<Badge data-testid="task-status-badge" class={getStatusColor(panel.task.status)}>{panel.task.status}</Badge>
					<Badge variant="outline">Priority: {panel.task.priority}</Badge>
					{#if panel.task.type !== 'task'}
						<Badge variant="outline">{panel.task.type}</Badge>
					{/if}
				</div>

				<!-- Spec Reference -->
				<!-- AC: @web-dashboard ac-6 -->
				{#if panel.task.spec_ref}
					<div data-testid="task-spec-ref-link">
						<p class="text-sm font-medium mb-1">Spec Reference:</p>
						<a
							href="/items?ref={encodeURIComponent(panel.task.spec_ref)}"
							class="text-sm text-primary hover:underline"
						>
							{panel.task.spec_ref}
						</a>
					</div>
				{/if}

				<!-- Tags -->
				{#if panel.task.tags?.length > 0}
					<div>
						<p class="text-sm font-medium mb-1">Tags:</p>
						<div class="flex flex-wrap gap-1">
							{#each panel.task.tags as tag}
								<Badge variant="secondary">{tag}</Badge>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Dependencies -->
				<div data-testid="task-dependencies">
					{#if panel.task.depends_on?.length > 0}
						<p class="text-sm font-medium mb-1">Dependencies:</p>
						<ul class="text-sm space-y-1">
							{#each panel.task.depends_on as dep}
								<li>
									<a href="/tasks?ref={encodeURIComponent(dep)}" class="text-primary hover:underline">
										{dep}
									</a>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-sm text-muted-foreground">No dependencies</p>
					{/if}
				</div>

				<!-- Blocked By -->
				{#if panel.task.blocked_by?.length > 0}
					<div>
						<p class="text-sm font-medium mb-1 text-destructive">Blocked By:</p>
						<ul class="text-sm space-y-1">
							{#each panel.task.blocked_by as blocker}
								<li class="text-muted-foreground">{blocker}</li>
							{/each}
						</ul>
					</div>
				{/if}

				<Separator />

				<!-- Actions -->
				<!-- AC: @web-dashboard ac-7 -->
				{#if panel.task.status === 'pending'}
					<div>
						<Button data-testid="start-task-button" onclick={handleStartTask} disabled={isSubmitting} class="w-full">
							{isSubmitting ? 'Starting...' : 'Start Task'}
						</Button>
					</div>
				{/if}

				{#if panelError}
					<p class="text-sm text-destructive">{panelError}</p>
				{/if}

				<Separator />

				<!-- Todos -->
				<div data-testid="task-todos">
					{#if panel.task.todos && panel.task.todos.length > 0}
						<p class="text-sm font-medium mb-2">Todos:</p>
						<ul class="space-y-2">
							{#each panel.task.todos as todo}
								<li class="flex items-start gap-2 text-sm">
									<span class="mt-0.5">
										{#if todo.status === 'completed'}
											✅
										{:else if todo.status === 'in_progress'}
											⏳
										{:else}
											⏸️
										{/if}
									</span>
									<span class:line-through={todo.status === 'completed'}>
										{todo.content}
									</span>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-sm text-muted-foreground">No todos</p>
					{/if}
				</div>

				<Separator />

				<!-- Notes -->
				<!-- AC: @web-dashboard ac-5 -->
				<div data-testid="task-notes">
					<p class="text-sm font-medium mb-2">Notes ({panel.task.notes?.length ?? 0}):</p>

					<!-- Add Note Form -->
					<!-- AC: @web-dashboard ac-8 -->
					<div class="mb-4 space-y-2" data-testid="add-note-form">
						<Textarea
							placeholder="Add a note..."
							bind:value={noteContent}
							disabled={isSubmitting}
							rows={3}
							data-testid="note-textarea"
						/>
						<Button
							onclick={handleAddNote}
							disabled={isSubmitting || !noteContent.trim()}
							size="sm"
							data-testid="add-note-button"
						>
							{isSubmitting ? 'Adding...' : 'Add Note'}
						</Button>
					</div>

					<!-- Notes List -->
					<div class="space-y-4" data-testid="task-notes-list">
						{#each panel.task.notes ?? [] as note}
							<div class="border rounded-lg p-3" data-testid="note-item">
								<div class="flex justify-between items-start mb-2">
									<span class="text-xs text-muted-foreground">{note.author}</span>
									<span class="text-xs text-muted-foreground" data-testid="note-timestamp">{formatDate(note.created_at)}</span>
								</div>
								<p class="text-sm whitespace-pre-wrap">{note.content}</p>
							</div>
						{/each}
					</div>
				</div>
			</div>
		</div>
	</div>
{/if}
