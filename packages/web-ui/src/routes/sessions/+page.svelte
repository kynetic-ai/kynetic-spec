<!--
  AC: @ui-session-history ac-1 — Session list with ID, agent type, task ref, status, duration, age.
  AC: @ui-session-history ac-2 — Click navigates to /sessions/:id.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import type { SessionSummary } from '$lib/api';
	import { fetchSessions } from '$lib/api';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { formatElapsed, formatAge } from '$lib/components/session/session-utils';
	import { Badge } from '$lib/components/ui/badge';
	import Activity from '@lucide/svelte/icons/activity';

	let sessions = $state<SessionSummary[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function loadSessions() {
		loading = true;
		error = '';
		try {
			const data = await fetchSessions();
			// AC: @ui-session-history ac-1 — sorted by most recent first (daemon returns pre-sorted)
			sessions = data.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load sessions';
		} finally {
			loading = false;
		}
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'active':
				return 'bg-status-in-progress text-status-in-progress-fg';
			case 'completed':
				return 'bg-status-completed text-status-completed-fg';
			case 'failed':
				return 'bg-status-blocked text-status-blocked-fg';
			case 'abandoned':
				return 'bg-status-needs-work text-status-needs-work-fg';
			case 'timed_out':
				return 'bg-status-pending text-status-pending-fg';
			default:
				return 'bg-status-cancelled text-status-cancelled-fg';
		}
	}

	/** Format task_id to a short ref display (first 8 chars), stripping leading @. */
	function shortTaskRef(taskId: string): string {
		return taskId.replace(/^@/, '').slice(0, 8);
	}

	onMount(() => {
		loadSessions();
	});
</script>

<div class="flex flex-col gap-4 p-6">
	<div>
		<h1 class="text-2xl font-bold">Sessions</h1>
		{#if !loading && sessions.length > 0}
			<p class="text-sm text-muted-foreground">{sessions.length} session{sessions.length === 1 ? '' : 's'}</p>
		{/if}
	</div>

	{#if error}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg" role="alert" data-testid="sessions-error">
			{error}
		</div>
	{/if}

	{#if loading}
		<div class="space-y-2" data-testid="sessions-loading">
			{#each Array(5) as _}
				<div class="h-16 rounded-lg bg-muted ds-shimmer"></div>
			{/each}
		</div>
	{:else if sessions.length === 0}
		<div class="flex flex-col items-center justify-center py-16" data-testid="sessions-empty">
			<Activity class="size-12 text-muted-foreground/30 mb-4" />
			<h2 class="text-lg font-medium text-muted-foreground mb-1">No sessions yet</h2>
			<p class="text-sm text-muted-foreground">
				{#if isStaticMode()}
					Session data is not available in static mode.
				{:else}
					Sessions are created when agents run tasks.
				{/if}
			</p>
		</div>
	{:else}
		<!-- AC: @ui-session-history ac-1 — List showing ID, agent type, task ref, status, duration, age -->
		<div class="space-y-2" data-testid="sessions-list">
			{#each sessions as s (s.id)}
				<!-- AC: @ui-session-history ac-2 — Click navigates to /sessions/:id -->
				<a
					href="{base}/sessions/{s.id}"
					class="flex items-center gap-4 p-3 rounded-lg border hover:bg-accent/30 transition-colors"
					data-testid="session-row"
					data-session-id={s.id}
				>
					<Badge class={statusColor(s.status)}>{s.status}</Badge>

					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium">{s.agent_type}</span>
							<span class="text-xs text-muted-foreground font-mono" data-testid="session-id">{s.id.slice(0, 8)}</span>
							{#if s.task_id}
								<span class="text-xs text-muted-foreground">·</span>
								<span class="text-xs font-mono text-primary/70" data-testid="session-task-ref" title={s.task_id}>@{shortTaskRef(s.task_id)}</span>
							{/if}
						</div>
						<div class="text-xs text-muted-foreground">
							{s.event_count} events
							{#if s.iteration_count > 0}
								&middot; {s.iteration_count} iterations
							{/if}
							{#if s.tasks_completed > 0}
								&middot; {s.tasks_completed} tasks
							{/if}
						</div>
					</div>

					<div class="text-right flex-shrink-0">
						<p class="text-xs font-mono text-muted-foreground" data-testid="session-duration">{formatElapsed(s.duration_ms)}</p>
						<p class="text-[10px] text-muted-foreground/60" data-testid="session-age">{formatAge(s.started_at)}</p>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>
