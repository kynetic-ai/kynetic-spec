<script lang="ts">
	// AC: @web-dashboard ac-4, ac-5, ac-33
	import type { TaskSummary } from '@kynetic-ai/shared';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Table,
		TableBody,
		TableCell,
		TableHead,
		TableHeader,
		TableRow
	} from '$lib/components/ui/table';
	import { createEventDispatcher } from 'svelte';

	export let tasks: TaskSummary[];
	export let updatedTaskIds: Set<string> = new Set();
	export let onSelectTask: ((taskId: string) => void) | undefined = undefined;

	const dispatch = createEventDispatcher<{
		select: string;
	}>();

	function selectTask(task: TaskSummary) {
		// Try callback first (Svelte 5 pattern), then dispatch (Svelte 4 pattern)
		if (onSelectTask) {
			onSelectTask(task._ulid);
		}
		dispatch('select', task._ulid);
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

	function getPriorityColor(priority: number): string {
		if (priority === 1) return 'text-red-600 font-bold';
		if (priority === 2) return 'text-orange-600 font-semibold';
		if (priority === 3) return 'text-yellow-600';
		return 'text-gray-600';
	}
</script>

<div class="rounded-md border" data-testid="task-list">
	<Table>
		<TableHeader>
			<TableRow>
				<TableHead>Title</TableHead>
				<TableHead>Status</TableHead>
				<TableHead>Priority</TableHead>
				<TableHead>Spec</TableHead>
				<TableHead>Notes</TableHead>
				<TableHead>Tags</TableHead>
			</TableRow>
		</TableHeader>
		<TableBody>
			{#if tasks.length === 0}
				<TableRow>
					<TableCell colspan={6} class="text-center text-muted-foreground">
						No tasks found
					</TableCell>
				</TableRow>
			{:else}
				{#each tasks as task}
					<!-- AC: @web-dashboard ac-33 - Highlight animation on update -->
					{@const isUpdated = updatedTaskIds.has(task._ulid)}
					<TableRow
						class="cursor-pointer hover:bg-muted/50 transition-colors duration-300 {isUpdated ? 'bg-primary/10' : ''}"
						data-testid="task-list-item"
						data-task-ref={task.slugs?.[0] || task._ulid}
						onclick={() => selectTask(task)}
					>
						<TableCell class="font-medium">
							<span data-testid="task-title">{task.title}</span>
							{#if task.type !== 'task'}
								<Badge variant="outline" class="ml-2">{task.type}</Badge>
							{/if}
						</TableCell>
						<TableCell>
							<Badge data-testid="task-status-badge" class={getStatusColor(task.status)}>{task.status}</Badge>
						</TableCell>
						<TableCell class={getPriorityColor(task.priority)}>
							<span data-testid="task-priority">P{task.priority}</span>
						</TableCell>
						<TableCell data-testid="task-spec-ref">
							{#if task.spec_ref}
								<a
									href="/items?ref={encodeURIComponent(task.spec_ref)}"
									class="text-primary hover:underline text-sm"
									on:click|stopPropagation
								>
									{task.spec_ref}
								</a>
							{:else}
								<span class="text-muted-foreground text-sm">—</span>
							{/if}
						</TableCell>
						<TableCell>
							<Badge data-testid="task-notes-count" variant="secondary">{task.notes_count}</Badge>
						</TableCell>
						<TableCell data-testid="task-tags">
							<div class="flex flex-wrap gap-1">
								{#each task.tags.slice(0, 3) as tag}
									<Badge variant="outline" class="text-xs">{tag}</Badge>
								{/each}
								{#if task.tags.length > 3}
									<Badge variant="outline" class="text-xs">+{task.tags.length - 3}</Badge>
								{/if}
							</div>
						</TableCell>
					</TableRow>
				{/each}
			{/if}
		</TableBody>
	</Table>
</div>
