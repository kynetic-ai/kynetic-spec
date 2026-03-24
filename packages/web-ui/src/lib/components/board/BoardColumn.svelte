<!--
  AC: @ui-task-board ac-1 — Board column container.
  Renders a column header with count and contained task cards.
-->
<script lang="ts">
	import type { TaskSummary } from '@kynetic-ai/shared';
	import type { BoardColumn } from './board-utils';
	import TaskCard from './TaskCard.svelte';

	const {
		column,
		onCardClick
	}: {
		column: BoardColumn;
		onCardClick: (task: TaskSummary) => void;
	} = $props();
</script>

<div
	class="flex flex-col min-w-0"
	data-testid="board-column"
	data-column-id={column.id}
>
	<!-- Column header -->
	<div class="flex items-center gap-2 mb-3 px-1">
		<h2 class="text-sm font-semibold">{column.label}</h2>
		<span
			class="inline-flex items-center justify-center min-w-[20px] h-5 rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground"
		>
			{column.tasks.length}
		</span>
	</div>

	<!-- Cards -->
	<div class="flex flex-col gap-2 overflow-y-auto flex-1 pb-4 pr-1">
		{#if column.tasks.length === 0}
			<div class="flex flex-col items-center justify-center py-8 text-muted-foreground text-xs text-center px-2" data-testid="column-empty">
				{#if column.id === 'backlog'}
					<p>No backlog tasks.</p>
					<p class="mt-1">Create tasks with <code class="bg-muted px-1 rounded">kspec task add</code></p>
				{:else if column.id === 'ready'}
					<p>No tasks ready for work.</p>
					<p class="mt-1">Mark tasks eligible with <code class="bg-muted px-1 rounded">kspec task set --automation eligible</code></p>
				{:else if column.id === 'in_progress'}
					<p>No active work.</p>
					<p class="mt-1">Start a task with <code class="bg-muted px-1 rounded">kspec task start</code></p>
				{:else if column.id === 'review'}
					<p>Nothing awaiting review.</p>
					<p class="mt-1">Submit work with <code class="bg-muted px-1 rounded">kspec task submit</code></p>
				{:else if column.id === 'done'}
					<p>No completed tasks yet.</p>
					<p class="mt-1">Tasks appear here after completion.</p>
				{:else}
					<p>No tasks in this column.</p>
				{/if}
			</div>
		{:else}
			{#each column.tasks as task (task._ulid)}
				<TaskCard {task} onclick={onCardClick} />
			{/each}
		{/if}
	</div>
</div>
