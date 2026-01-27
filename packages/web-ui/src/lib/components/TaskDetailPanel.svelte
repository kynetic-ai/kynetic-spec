<script lang="ts">
	// AC: @web-dashboard ac-5, ac-6, ac-7, ac-8
	// Custom sheet implementation for task details
	import type { TaskDetail as TaskDetailType } from '@kynetic-ai/shared';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Separator } from '$lib/components/ui/separator';
	import { startTask, addTaskNote } from '$lib/api';
	import XIcon from '@lucide/svelte/icons/x';

	// Props for controlling the panel - use $bindable for reactivity
	let {
		open = $bindable(false),
		task = $bindable<TaskDetailType | null>(null),
		onclose = undefined as (() => void) | undefined,
		onupdate = undefined as (() => void) | undefined
	} = $props();

	// Debug: log when props change
	$effect(() => {
		console.log('[TaskDetailPanel] open changed to:', open, 'task:', task?.title);
	});

	let noteContent = $state('');
	let isSubmitting = $state(false);
	let error = $state('');

	function close() {
		onclose?.();
	}

	// Handle clicking outside the panel
	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			close();
		}
	}

	// Handle escape key
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			close();
		}
	}

	async function handleStartTask() {
		if (!task) return;

		isSubmitting = true;
		error = '';

		try {
			await startTask(task._ulid);
			onupdate?.();
			close();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start task';
		} finally {
			isSubmitting = false;
		}
	}

	async function handleAddNote() {
		if (!task || !noteContent.trim()) return;

		isSubmitting = true;
		error = '';

		try {
			await addTaskNote(task._ulid, noteContent);
			noteContent = '';
			onupdate?.();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to add note';
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
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open && task}
	<!-- Overlay -->
	<div
		class="fixed inset-0 z-50 bg-black/50"
		onclick={handleOverlayClick}
		onkeydown={(e) => e.key === 'Enter' && close()}
		role="button"
		tabindex="-1"
		aria-label="Close panel"
	>
		<!-- Panel -->
		<div
			class="fixed inset-y-0 right-0 z-50 w-3/4 max-w-lg bg-background shadow-lg border-l overflow-y-auto animate-in slide-in-from-right duration-300"
			data-testid="task-detail-panel"
			role="dialog"
			aria-modal="true"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<!-- Header -->
			<div class="flex items-center justify-between p-6 border-b">
				<h2 class="text-lg font-semibold" data-testid="task-description">{task.title}</h2>
				<button
					onclick={close}
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
					<Badge class={getStatusColor(task.status)}>{task.status}</Badge>
					<Badge variant="outline">Priority: {task.priority}</Badge>
					{#if task.type !== 'task'}
						<Badge variant="outline">{task.type}</Badge>
					{/if}
				</div>

				<!-- Spec Reference -->
				<!-- AC: @web-dashboard ac-6 -->
				{#if task.spec_ref}
					<div data-testid="task-spec-ref-link">
						<p class="text-sm font-medium mb-1">Spec Reference:</p>
						<a
							href="/items?ref={encodeURIComponent(task.spec_ref)}"
							class="text-sm text-primary hover:underline"
						>
							{task.spec_ref}
						</a>
					</div>
				{/if}

				<!-- Tags -->
				{#if task.tags.length > 0}
					<div>
						<p class="text-sm font-medium mb-1">Tags:</p>
						<div class="flex flex-wrap gap-1">
							{#each task.tags as tag}
								<Badge variant="secondary">{tag}</Badge>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Dependencies -->
				<div data-testid="task-dependencies">
					{#if task.depends_on.length > 0}
						<p class="text-sm font-medium mb-1">Dependencies:</p>
						<ul class="text-sm space-y-1">
							{#each task.depends_on as dep}
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
				{#if task.blocked_by.length > 0}
					<div>
						<p class="text-sm font-medium mb-1 text-destructive">Blocked By:</p>
						<ul class="text-sm space-y-1">
							{#each task.blocked_by as blocker}
								<li class="text-muted-foreground">{blocker}</li>
							{/each}
						</ul>
					</div>
				{/if}

				<Separator />

				<!-- Actions -->
				<!-- AC: @web-dashboard ac-7 -->
				{#if task.status === 'pending'}
					<div>
						<Button data-testid="start-task-button" onclick={handleStartTask} disabled={isSubmitting} class="w-full">
							{isSubmitting ? 'Starting...' : 'Start Task'}
						</Button>
					</div>
				{/if}

				{#if error}
					<p class="text-sm text-destructive">{error}</p>
				{/if}

				<Separator />

				<!-- Todos -->
				<div data-testid="task-todos">
					{#if task.todos && task.todos.length > 0}
						<p class="text-sm font-medium mb-2">Todos:</p>
						<ul class="space-y-2">
							{#each task.todos as todo}
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
					<p class="text-sm font-medium mb-2">Notes ({task.notes.length}):</p>

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
						{#each task.notes as note}
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
