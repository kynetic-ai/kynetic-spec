<!--
  AC: @ui-session-history ac-1 — Session list with ID, agent type, task ref, status, duration, age.
  AC: @ui-session-history ac-2 — Click navigates to /sessions/:id.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import type { SessionSummary } from '$lib/api';
	import { fetchSessions, fetchTasks } from '$lib/api';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { getProjectVersion, isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { formatElapsed, formatAge, getTriggerLabel, isDispatchedSession } from '$lib/components/session/session-utils';
	import { Badge } from '$lib/components/ui/badge';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import Activity from '@lucide/svelte/icons/activity';
	import Zap from '@lucide/svelte/icons/zap';
	import Terminal from '@lucide/svelte/icons/terminal';

	let sessions = $state<SessionSummary[]>([]);
	let taskTitles = $state<Record<string, string>>({});
	let loading = $state(true);
	let error = $state('');

	type TriggerFilter = 'all' | 'manual' | 'dispatched';
	let triggerFilter = $state<TriggerFilter>('all');

	let filteredSessions = $derived(
		triggerFilter === 'all'
			? sessions
			: triggerFilter === 'manual'
				? sessions.filter(s => !isDispatchedSession(s.trigger))
				: sessions.filter(s => isDispatchedSession(s.trigger))
	);

	async function loadSessions() {
		loading = true;
		error = '';
		try {
			const [data, tasksData] = await Promise.all([
				fetchSessions(),
				fetchTasks({ limit: 1000 })
			]);
			// AC: @ui-session-history ac-1 — sorted by most recent first (daemon returns pre-sorted)
			sessions = data.items;

			// Build task title lookup for ReferenceLink display
			const titles: Record<string, string> = {};
			for (const task of tasksData.items) {
				if (task.slugs?.length) {
					for (const slug of task.slugs) {
						titles[`@${slug}`] = task.title;
					}
				}
				titles[`@${task._ulid}`] = task.title;
			}
			taskTitles = titles;
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

	// Load sessions when project is ready and reload on project change.
	// Gates on isProjectInitialized() to prevent loading with wrong/missing project context.
	$effect(() => {
		const version = getProjectVersion();
		const ready = isProjectInitialized();
		if (!ready) return;
		loadSessions();
	});
</script>

<div class="flex flex-col gap-4 p-6">
	<div class="flex items-end justify-between gap-4">
		<div>
			<h1 class="text-2xl font-bold">Sessions</h1>
			{#if !loading && sessions.length > 0}
				<p class="text-sm text-muted-foreground">{filteredSessions.length} of {sessions.length} session{sessions.length === 1 ? '' : 's'}</p>
			{/if}
		</div>

		{#if !loading && sessions.length > 0}
			<div class="flex gap-1" data-testid="trigger-filter">
				<button
					class="px-2.5 py-1 text-xs rounded-md transition-colors {triggerFilter === 'all' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:bg-accent'}"
					onclick={() => triggerFilter = 'all'}
				>
					All
				</button>
				<button
					class="px-2.5 py-1 text-xs rounded-md transition-colors inline-flex items-center gap-1 {triggerFilter === 'manual' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:bg-accent'}"
					onclick={() => triggerFilter = 'manual'}
				>
					<Terminal class="size-3" />
					Manual
				</button>
				<button
					class="px-2.5 py-1 text-xs rounded-md transition-colors inline-flex items-center gap-1 {triggerFilter === 'dispatched' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:bg-accent'}"
					onclick={() => triggerFilter = 'dispatched'}
				>
					<Zap class="size-3" />
					Dispatched
				</button>
			</div>
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
	{:else if filteredSessions.length === 0}
		<div class="flex flex-col items-center justify-center py-16" data-testid="sessions-filter-empty">
			<Activity class="size-12 text-muted-foreground/30 mb-4" />
			<h2 class="text-lg font-medium text-muted-foreground mb-1">No matching sessions</h2>
			<p class="text-sm text-muted-foreground">
				No sessions match the "{triggerFilter}" filter.
			</p>
		</div>
	{:else}
		<!-- AC: @ui-session-history ac-1 — List showing ID, agent type, task ref, status, duration, age -->
		<div class="space-y-2" data-testid="sessions-list">
			{#each filteredSessions as s (s.id)}
				<!-- AC: @ui-session-history ac-2 — Click navigates to /sessions/:id -->
				<a
					href="{base}/sessions/{s.id}"
					class="flex items-center gap-4 p-3 rounded-lg border hover:bg-accent/30 transition-colors"
					data-testid="session-row"
					data-session-id={s.id}
				>
					<Badge class={statusColor(s.status)}>{s.status}</Badge>

					<!-- Session origin indicator -->
					<span
						class="flex-shrink-0"
						title={getTriggerLabel(s.trigger)}
						data-testid="session-trigger-icon"
					>
						{#if isDispatchedSession(s.trigger)}
							<Zap class="size-3.5 text-status-in-progress" />
						{:else}
							<Terminal class="size-3.5 text-muted-foreground" />
						{/if}
					</span>

					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium">{s.agent_type}</span>
							<span class="text-xs text-muted-foreground font-mono" data-testid="session-id">{s.id.slice(0, 8)}</span>
							{#if s.task_id}
								<span class="text-xs text-muted-foreground">&middot;</span>
								<span data-testid="session-task-ref">
									<ReferenceLink ref={s.task_id} type="task" title={taskTitles[s.task_id] || taskTitles[`@${s.task_id}`]} inline class="text-xs" />
								</span>
							{/if}
						</div>
						<div class="text-xs text-muted-foreground">
							<span data-testid="session-trigger-label">{getTriggerLabel(s.trigger)}</span>
							&middot; {s.event_count} events
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
