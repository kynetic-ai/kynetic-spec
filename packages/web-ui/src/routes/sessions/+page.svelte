<!--
  Session history list view. Links to /sessions/:id for detail.
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
			default:
				return 'bg-status-cancelled text-status-cancelled-fg';
		}
	}

	onMount(() => {
		loadSessions();
	});
</script>

<div class="flex flex-col gap-4 p-6">
	<div>
		<h1 class="text-2xl font-bold">Sessions</h1>
		{#if !loading && sessions.length > 0}
			<p class="text-sm text-muted-foreground">{sessions.length} sessions</p>
		{/if}
	</div>

	{#if error}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg" role="alert">
			{error}
		</div>
	{/if}

	{#if loading}
		<div class="space-y-2">
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
		<div class="space-y-2">
			{#each sessions as s (s.id)}
				<a
					href="{base}/sessions/{s.id}"
					class="flex items-center gap-4 p-3 rounded-lg border hover:bg-accent/30 transition-colors"
					data-testid="session-row"
				>
					<Badge class={statusColor(s.status)}>{s.status}</Badge>

					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium">{s.agent_type}</span>
							<span class="text-xs text-muted-foreground font-mono">{s.id.slice(0, 8)}</span>
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
						<p class="text-xs font-mono text-muted-foreground">{formatElapsed(s.duration_ms)}</p>
						<p class="text-[10px] text-muted-foreground/60">{formatAge(s.started_at)}</p>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>
