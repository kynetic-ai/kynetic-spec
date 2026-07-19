<script lang="ts">
	// AC: @web-dashboard ac-4, ac-5, ac-33
	import type { TaskSummary } from '@kynetic-ai/shared';
	import { Badge } from '$lib/components/ui/badge';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
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
			pending: 'bg-status-pending text-status-pending-fg',
			in_progress: 'bg-status-in-progress text-status-in-progress-fg',
			pending_review: 'bg-status-pending-review text-status-pending-review-fg',
			needs_work: 'bg-status-needs-work text-status-needs-work-fg',
			blocked: 'bg-status-blocked text-status-blocked-fg',
			completed: 'bg-status-completed text-status-completed-fg',
			cancelled: 'bg-status-cancelled text-status-cancelled-fg'
		};
		return colors[status] || 'bg-status-cancelled text-status-cancelled-fg';
	}

	function formatStatus(status: string): string {
		const labels: Record<string, string> = {
			pending: 'Pending',
			in_progress: 'In Progress',
			pending_review: 'Pending Review',
			needs_work: 'Needs Work',
			blocked: 'Blocked',
			completed: 'Completed',
			cancelled: 'Cancelled'
		};
		return labels[status] || status;
	}

	function getPriorityColor(priority: number): string {
		if (priority === 1) return 'text-red-600 font-bold';
		if (priority === 2) return 'text-orange-600 font-semibold';
		if (priority === 3) return 'text-yellow-600';
		return 'text-gray-600';
	}
</script>

<div class="rounded-md border overflow-hidden" data-testid="task-list">
	<Table class="table-fixed">
		<TableHeader>
			<TableRow>
				<TableHead class="w-[40%]">Title</TableHead>
				<TableHead class="w-[12%]">Status</TableHead>
				<TableHead class="w-[8%]">Priority</TableHead>
				<TableHead class="w-[15%]">Spec</TableHead>
				<TableHead class="w-[7%]">Notes</TableHead>
				<TableHead class="w-[18%]">Tags</TableHead>
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
					<!-- Use native tr for reliable click handling -->
					<tr
						class="cursor-pointer hover:bg-muted/50 transition-colors duration-300 border-b {isUpdated ? 'bg-primary/10 animate-pulse' : ''}"
						data-testid="task-list-item"
						data-task-ref={task.slugs?.[0] || task._ulid}
						onclick={() => selectTask(task)}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === 'Enter' && selectTask(task)}
					>
						<TableCell class="font-medium truncate">
							<span data-testid="task-title" class="truncate">{task.title}</span>
						</TableCell>
						<TableCell>
							<Badge data-testid="task-status-badge" class={getStatusColor(task.status)}>{formatStatus(task.status)}</Badge>
						</TableCell>
						<TableCell class={getPriorityColor(task.priority)}>
							<span data-testid="task-priority">P{task.priority}</span>
						</TableCell>
						<TableCell data-testid="task-spec-ref" class="truncate">
							{#if task.spec_ref}
								<ReferenceLink ref={task.spec_ref} type="spec" stopPropagation class="text-sm truncate" />
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
					</tr>
				{/each}
			{/if}
		</TableBody>
	</Table>
</div>
