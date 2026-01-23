<script lang="ts">
	// AC: @web-dashboard ac-5, ac-6, ac-7, ac-8
	import type { TaskDetail as TaskDetailType } from '@kynetic-ai/shared';
	import { Sheet, SheetContent, SheetHeader, SheetTitle } from '$lib/components/ui/sheet';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Separator } from '$lib/components/ui/separator';
	import { startTask, addTaskNote } from '$lib/api';
	import { createEventDispatcher } from 'svelte';

	export let task: TaskDetailType | null = null;
	export let open = false;

	let noteContent = '';
	let isSubmitting = false;
	let error = '';

	const dispatch = createEventDispatcher<{
		close: void;
		update: void;
	}>();

	function close() {
		dispatch('close');
	}

	async function handleStartTask() {
		if (!task) return;

		isSubmitting = true;
		error = '';

		try {
			await startTask(task._ulid);
			dispatch('update');
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
			dispatch('update');
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

<Sheet bind:open onOpenChange={(o) => !o && close()}>
	<SheetContent class="overflow-y-auto sm:max-w-lg">
		{#if task}
			<SheetHeader>
				<SheetTitle>{task.title}</SheetTitle>
			</SheetHeader>

			<div class="flex flex-col gap-4 mt-4">
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
					<div>
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
				{#if task.depends_on.length > 0}
					<div>
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
					</div>
				{/if}

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
						<Button on:click={handleStartTask} disabled={isSubmitting} class="w-full">
							{isSubmitting ? 'Starting...' : 'Start Task'}
						</Button>
					</div>
				{/if}

				{#if error}
					<p class="text-sm text-destructive">{error}</p>
				{/if}

				<Separator />

				<!-- Todos -->
				{#if task.todos && task.todos.length > 0}
					<div>
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
					</div>
					<Separator />
				{/if}

				<!-- Notes -->
				<!-- AC: @web-dashboard ac-5 -->
				<div>
					<p class="text-sm font-medium mb-2">Notes ({task.notes.length}):</p>

					<!-- Add Note Form -->
					<!-- AC: @web-dashboard ac-8 -->
					<div class="mb-4 space-y-2">
						<Textarea
							placeholder="Add a note..."
							bind:value={noteContent}
							disabled={isSubmitting}
							rows={3}
						/>
						<Button
							on:click={handleAddNote}
							disabled={isSubmitting || !noteContent.trim()}
							size="sm"
						>
							{isSubmitting ? 'Adding...' : 'Add Note'}
						</Button>
					</div>

					<!-- Notes List -->
					<div class="space-y-4">
						{#each task.notes as note}
							<div class="border rounded-lg p-3">
								<div class="flex justify-between items-start mb-2">
									<span class="text-xs text-muted-foreground">{note.author}</span>
									<span class="text-xs text-muted-foreground">{formatDate(note.created_at)}</span>
								</div>
								<p class="text-sm whitespace-pre-wrap">{note.content}</p>
							</div>
						{/each}
					</div>
				</div>
			</div>
		{/if}
	</SheetContent>
</Sheet>
