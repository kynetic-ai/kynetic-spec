<!--
  AC: @ui-session-stream ac-4 — Session context panel with metadata, spec context, files changed, budget.
-->
<script lang="ts">
	import type { SessionDetail } from '$lib/api';
	import { formatElapsed, formatAge } from '$lib/components/board/board-utils';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import Clock from '@lucide/svelte/icons/clock';
	import Bot from '@lucide/svelte/icons/bot';
	import FileText from '@lucide/svelte/icons/file-text';
	import Activity from '@lucide/svelte/icons/activity';

	let {
		session,
	}: {
		session: SessionDetail;
	} = $props();

	let statusColor = $derived(
		session.status === 'active'
			? 'bg-status-in-progress text-status-in-progress-fg'
			: session.status === 'completed'
				? 'bg-status-completed text-status-completed-fg'
				: session.status === 'failed'
					? 'bg-status-blocked text-status-blocked-fg'
					: 'bg-status-cancelled text-status-cancelled-fg'
	);

	let statusLabel = $derived(
		session.status === 'active'
			? 'Active'
			: session.status === 'completed'
				? 'Completed'
				: session.status === 'abandoned'
					? 'Abandoned'
					: session.status === 'timed_out'
						? 'Timed Out'
						: session.status === 'failed'
							? 'Failed'
							: session.status
	);

	let triggerLabel = $derived(
		session.trigger === 'manual'
			? 'Manual'
			: session.trigger === 'task.ready'
				? 'Task Ready'
				: session.trigger === 'task.in_progress'
					? 'Task In Progress'
					: session.trigger === 'task.needs_work'
						? 'Needs Work'
						: session.trigger === 'task.pending_review'
							? 'Pending Review'
							: session.trigger ?? 'Legacy'
	);
</script>

<div class="w-72 border-r bg-card/50 overflow-y-auto flex-shrink-0" data-testid="session-context-panel">
	<div class="p-4 space-y-4">
		<!-- Session metadata -->
		<div>
			<h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Session</h3>

			<div class="space-y-2">
				<div class="flex items-center justify-between">
					<Badge class={statusColor}>{statusLabel}</Badge>
					<span class="text-[10px] font-mono text-muted-foreground">
						{session.id.slice(0, 8)}
					</span>
				</div>

				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<Bot class="size-3.5" />
					<span>{session.agent_type}</span>
					{#if session.agent_id && session.agent_id !== session.agent_type}
						<span class="text-muted-foreground/50">({session.agent_id})</span>
					{/if}
				</div>

				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<Clock class="size-3.5" />
					<span>{formatElapsed(session.duration_ms)}</span>
					{#if session.status === 'active'}
						<span class="ds-session-active-dot size-1.5 rounded-full bg-emerald-500 inline-block"></span>
					{/if}
				</div>

				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<Activity class="size-3.5" />
					<span>Trigger: {triggerLabel}</span>
				</div>

				{#if session.task_id}
					<div class="flex items-center gap-2 text-xs">
						<FileText class="size-3.5 text-muted-foreground" />
						<span class="font-mono text-primary">@{session.task_id.slice(0, 8)}</span>
					</div>
				{/if}
			</div>
		</div>

		<Separator />

		<!-- Stats -->
		<div>
			<h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Stats</h3>

			<div class="grid grid-cols-2 gap-2">
				<div class="bg-secondary/50 rounded-md px-2.5 py-1.5">
					<p class="text-[10px] text-muted-foreground">Events</p>
					<p class="text-sm font-medium">{session.event_count}</p>
				</div>
				<div class="bg-secondary/50 rounded-md px-2.5 py-1.5">
					<p class="text-[10px] text-muted-foreground">Iterations</p>
					<p class="text-sm font-medium">{session.iteration_count}</p>
				</div>
				<div class="bg-secondary/50 rounded-md px-2.5 py-1.5">
					<p class="text-[10px] text-muted-foreground">Tasks Done</p>
					<p class="text-sm font-medium">{session.tasks_completed}</p>
				</div>
				<div class="bg-secondary/50 rounded-md px-2.5 py-1.5">
					<p class="text-[10px] text-muted-foreground">Type</p>
					<p class="text-sm font-medium capitalize">{session.session_type}</p>
				</div>
			</div>
		</div>

		<Separator />

		<!-- Timeline -->
		<div>
			<h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Timeline</h3>

			<div class="space-y-1 text-xs text-muted-foreground">
				<div class="flex justify-between">
					<span>Started</span>
					<span class="font-mono">{formatAge(session.started_at)}</span>
				</div>
				{#if session.ended_at}
					<div class="flex justify-between">
						<span>Ended</span>
						<span class="font-mono">{formatAge(session.ended_at)}</span>
					</div>
				{/if}
				<div class="flex justify-between">
					<span>Duration</span>
					<span class="font-mono">{formatElapsed(session.duration_ms)}</span>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	@keyframes session-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}
	:global(.ds-session-active-dot) {
		animation: session-pulse 2s ease-in-out infinite;
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.ds-session-active-dot) {
			animation: none;
		}
	}
</style>
