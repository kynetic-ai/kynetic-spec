<!--
  AC: @ui-task-board ac-2 — Task card with priority badge, tag chips, title,
  slug (mono), spec ref link, and metadata footer (notes count, dependency count, age)
-->
<script lang="ts">
	import type { TaskSummary } from '@kynetic-ai/shared';
	import { Badge } from '$lib/components/ui/badge';
	import { StatusBadge } from '$lib/components/ds';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import { formatAge } from './board-utils';
	import MessageSquare from 'lucide-svelte/icons/message-square';
	import GitBranch from 'lucide-svelte/icons/git-branch';
	import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
	import Ban from 'lucide-svelte/icons/ban';

	let { task, onclick }: { task: TaskSummary; onclick: (task: TaskSummary) => void } = $props();

	let isBlocked = $derived(task.status === 'blocked');
	let isCancelled = $derived(task.status === 'cancelled');
	let slug = $derived(task.slugs?.[0] ?? task._ulid.slice(0, 8));
</script>

<button
	class="group w-full text-left rounded-lg border bg-card p-3 shadow-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {isBlocked
		? 'border-status-blocked/50'
		: isCancelled
			? 'border-status-cancelled/50 opacity-60'
			: 'border-border'}"
	data-testid="task-card"
	data-task-id={task._ulid}
	onclick={() => onclick(task)}
>
	<!-- Top row: priority + status indicator + blocked/cancelled badge -->
	<div class="flex items-center gap-1.5 mb-1.5">
		<!-- Priority badge -->
		<span
			class="inline-flex items-center justify-center size-5 rounded-full text-[10px] font-bold leading-none {task.priority === 1
				? 'bg-destructive text-primary-foreground'
				: task.priority === 2
					? 'bg-status-in-progress text-status-in-progress-fg'
					: 'bg-muted text-muted-foreground'}"
			title="Priority {task.priority}"
			data-testid="priority-badge"
		>
			P{task.priority}
		</span>

		<!-- Status indicator drawn from the shared status-token source -->
		<!-- AC: @ui-view-header ac-2 — same task state = same color + glyph across views -->
		<StatusBadge domain="task" state={task.status} class="px-1.5 py-0 text-[10px]" testid="task-card-status-badge" />

		<!-- Blocked indicator -->
		{#if isBlocked}
			<span class="ml-auto flex items-center gap-0.5 text-[10px] text-status-blocked">
				<AlertTriangle class="size-3" />
				Blocked
			</span>
		{/if}

		<!-- Cancelled indicator -->
		{#if isCancelled}
			<span class="ml-auto flex items-center gap-0.5 text-[10px] text-status-cancelled">
				<Ban class="size-3" />
				Cancelled
			</span>
		{/if}
	</div>

	<!-- Title -->
	<p class="text-sm font-medium leading-snug line-clamp-2 mb-1" data-testid="task-title">
		{task.title}
	</p>

	<!-- Slug (mono) -->
	<p class="text-[11px] font-mono text-muted-foreground mb-1.5" data-testid="task-slug">
		@{slug}
	</p>

	<!-- Tag chips -->
	{#if task.tags?.length > 0}
		<div class="flex flex-wrap gap-1 mb-2" data-testid="task-tags">
			{#each task.tags.slice(0, 3) as tag}
				<Badge variant="secondary" class="text-[10px] px-1.5 py-0">{tag}</Badge>
			{/each}
			{#if task.tags.length > 3}
				<span class="text-[10px] text-muted-foreground">+{task.tags.length - 3}</span>
			{/if}
		</div>
	{/if}

	<!-- Spec ref link -->
	{#if task.spec_ref}
		<div class="mb-2" data-testid="spec-ref-link">
			<ReferenceLink ref={task.spec_ref} type="spec" inline class="text-[11px]" />
		</div>
	{/if}

	<!-- Metadata footer -->
	<div
		class="flex items-center gap-3 text-[10px] text-muted-foreground pt-1.5 border-t border-border/50"
		data-testid="task-metadata"
	>
		<!-- Notes count -->
		<span class="flex items-center gap-0.5" title="{task.notes_count} notes">
			<MessageSquare class="size-3" />
			{task.notes_count}
		</span>

		<!-- Dependency count -->
		<span class="flex items-center gap-0.5" title="{task.depends_on?.length ?? 0} dependencies">
			<GitBranch class="size-3" />
			{task.depends_on?.length ?? 0}
		</span>

		<!-- Age -->
		<span class="ml-auto" title={task.created_at}>
			{formatAge(task.created_at)}
		</span>
	</div>
</button>
