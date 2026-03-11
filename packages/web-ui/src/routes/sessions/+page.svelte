<!--
  AC: @ui-session-history ac-1 — Session list with ID, agent type, task ref, status, duration, age.
  AC: @ui-session-history ac-2 — Click navigates to /sessions/:id.
  AC: @session-list-infinite-scroll ac-initial-load — First page loads with skeleton, shows count.
  AC: @session-list-infinite-scroll ac-scroll-load — IntersectionObserver triggers next page.
  AC: @session-list-infinite-scroll ac-scroll-end — End of list indicator when all loaded.
  AC: @session-list-infinite-scroll ac-filter-reset — Filter change resets to page 1.
  AC: @session-list-infinite-scroll ac-live-update — WebSocket updates total and shows indicator.
  AC: @ui-url-panel-state ac-4 — goto() for filter URL mutations.
  AC: @session-filter-controls ac-status-filter — Status filter via URL params.
  AC: @session-filter-controls ac-agent-filter — Agent ID filter via URL params.
  AC: @session-filter-controls ac-agent-type-filter — Agent type filter via URL params.
  AC: @session-filter-controls ac-trigger-filter — Trigger filter via URL params.
  AC: @session-filter-controls ac-date-filter — Date range filter via URL params.
  AC: @session-filter-controls ac-clear-filters — Clear all filters button.
  AC: @session-filter-controls ac-filter-counts — Filtered vs total count display.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { base } from '$app/paths';
	import type { SessionSummary, FetchSessionsParams } from '$lib/api';
	import { fetchSessions, fetchTasks } from '$lib/api';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { getProjectVersion, isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { formatElapsed, formatAge, getTriggerLabel, isDispatchedSession } from '$lib/components/session/session-utils';
	import SessionFilters from '$lib/components/session/SessionFilters.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import Activity from '@lucide/svelte/icons/activity';
	import Zap from '@lucide/svelte/icons/zap';
	import Terminal from '@lucide/svelte/icons/terminal';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';

	const PAGE_SIZE = 25;
	const SCROLL_THRESHOLD = 200; // px from bottom to trigger load

	// Pagination state
	let sessions = $state<SessionSummary[]>([]);
	let total = $state(0);
	let offset = $state(0);
	let loading = $state(true); // Initial load
	let loadingMore = $state(false); // Subsequent page loads
	let error = $state('');
	let allLoaded = $derived(sessions.length >= total);

	// Task title lookup
	let taskTitles = $state<Record<string, string>>({});
	let taskTitlesLoaded = $state(false);

	// AC: @session-filter-controls ac-filter-counts — Track unfiltered total for count display
	let unfilteredTotal = $state(0);

	// AC: @session-filter-controls ac-agent-filter, ac-agent-type-filter — Distinct values for filter dropdowns
	let distinctAgentIds = $state<string[]>([]);
	let distinctAgentTypes = $state<string[]>([]);

	// AC: @session-list-infinite-scroll ac-live-update — Track new sessions
	let newSessionsAvailable = $state(0);
	let isAtTop = $state(true);
	let pageRoot: HTMLDivElement | undefined = $state();
	let scrollContainer: HTMLElement | undefined = $state();

	// IntersectionObserver sentinel element
	let sentinel: HTMLDivElement | undefined = $state();
	let observer: IntersectionObserver | undefined;

	// AC: @ui-url-panel-state ac-4 — Derive filter values from URL params
	let filterStatuses = $derived($page.url.searchParams.getAll('status'));
	let filterAgentId = $derived($page.url.searchParams.get('agent_id') || '');
	let filterAgentType = $derived($page.url.searchParams.get('agent_type') || '');
	let filterTrigger = $derived($page.url.searchParams.get('trigger') || '');
	let filterSince = $derived($page.url.searchParams.get('since') || '');
	let hasFilters = $derived(
		filterStatuses.length > 0 || filterAgentId || filterAgentType || filterTrigger || filterSince
	);

	function updateDistinctFilters(items: SessionSummary[], options?: { reset?: boolean }) {
		const reset = options?.reset ?? false;
		const agentIdSet = new Set(reset ? [] : distinctAgentIds);
		const agentTypeSet = new Set(reset ? [] : distinctAgentTypes);

		for (const session of items) {
			if (session.agent_id) agentIdSet.add(session.agent_id);
			agentTypeSet.add(session.agent_type);
		}

		if (filterAgentId) agentIdSet.add(filterAgentId);
		if (filterAgentType) agentTypeSet.add(filterAgentType);

		distinctAgentIds = [...agentIdSet].sort();
		distinctAgentTypes = [...agentTypeSet].sort();
	}

	/**
	 * Build FetchSessionsParams from current URL search params.
	 */
	function buildFetchParams(extraOffset?: number): FetchSessionsParams {
		const params: FetchSessionsParams = {
			offset: extraOffset ?? 0,
			limit: PAGE_SIZE
		};
		if (filterStatuses.length > 0) params.status = filterStatuses;
		if (filterAgentId) params.agent_id = filterAgentId;
		if (filterAgentType) params.agent_type = filterAgentType;
		if (filterTrigger) params.trigger = filterTrigger;
		if (filterSince) params.since = filterSince;
		return params;
	}

	/**
	 * Seed filter metadata from the first unfiltered page so controls scale with pagination.
	 */
	async function loadFilterOptions() {
		try {
			const data = await fetchSessions({ offset: 0, limit: PAGE_SIZE });
			unfilteredTotal = data.total;
			updateDistinctFilters(data.items, { reset: true });
		} catch {
			// Non-critical — filter options just won't be populated
		}
	}

	// AC: @session-list-infinite-scroll ac-initial-load — Load first page
	async function loadInitialPage() {
		loading = true;
		error = '';
		sessions = [];
		offset = 0;
		total = 0;
		newSessionsAvailable = 0;
		try {
			const [data, tasksData] = await Promise.all([
				fetchSessions(buildFetchParams(0)),
				// Only load task titles once
				taskTitlesLoaded ? Promise.resolve(null) : fetchTasks({ limit: 1000 })
			]);
			// AC: @ui-session-history ac-1 — sorted by most recent first (daemon returns pre-sorted)
			sessions = data.items;
			total = data.total;
			offset = data.items.length;
			updateDistinctFilters(data.items, { reset: !hasFilters });

			// AC: @session-filter-controls ac-filter-counts — Update unfiltered total if no filters active
			if (!hasFilters) {
				unfilteredTotal = data.total;
			}

			// Build task title lookup for ReferenceLink display
			if (tasksData) {
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
				taskTitlesLoaded = true;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load sessions';
		} finally {
			loading = false;
		}
	}

	// AC: @session-list-infinite-scroll ac-scroll-load — Load next page
	async function loadNextPage() {
		if (loadingMore || allLoaded) return;
		loadingMore = true;
		try {
			const data = await fetchSessions(buildFetchParams(offset));
			sessions = [...sessions, ...data.items];
			total = data.total;
			offset += data.items.length;
			updateDistinctFilters(data.items);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load more sessions';
		} finally {
			loadingMore = false;
		}
	}

	// AC: @session-list-infinite-scroll ac-live-update — WebSocket handler
	function handleAgentEvent(event: { event: string; data?: { session_id?: string; status?: string } }) {
		if (event.event === 'agent_invocation') {
			const data = event.data;
			if (data?.status === 'started') {
				// Always update total count immediately
				total++;
				unfilteredTotal++;

				if (isAtTop) {
					// User is at top — re-fetch page 1 to show the new session
					loadInitialPage();
				} else {
					// User is scrolled down — show "new sessions available" indicator
					newSessionsAvailable++;
				}
			}
		}
	}

	// AC: @session-list-infinite-scroll ac-live-update — Refresh to show new sessions
	function refreshNewSessions() {
		newSessionsAvailable = 0;
		loadInitialPage();
		// Scroll to top to see the new sessions
		scrollContainer?.scrollTo({ top: 0, behavior: 'smooth' });
	}

	// AC: @session-list-infinite-scroll ac-live-update — Track scroll position
	function handleScroll() {
		if (scrollContainer) {
			isAtTop = scrollContainer.scrollTop <= 10;
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
		loadFilterOptions();
		loadInitialPage();
	});

	// AC: @session-list-infinite-scroll ac-filter-reset — Reload when URL filter params change
	let previousFilterKey: string | undefined;
	$effect(() => {
		// Build a stable key from all filter params to detect changes
		const key = `${filterStatuses.join(',')}|${filterAgentId}|${filterAgentType}|${filterTrigger}|${filterSince}`;
		if (previousFilterKey !== undefined && previousFilterKey !== key) {
			loadInitialPage();
		}
		previousFilterKey = key;
	});

	// AC: @session-list-infinite-scroll ac-scroll-load — IntersectionObserver for sentinel
	$effect(() => {
		if (!sentinel) return;

		observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				if (entry?.isIntersecting && !loadingMore && !allLoaded && !loading) {
					loadNextPage();
				}
			},
			{ rootMargin: `${SCROLL_THRESHOLD}px` }
		);
		observer.observe(sentinel);

		return () => {
			observer?.disconnect();
			observer = undefined;
		};
	});

	// AC: @session-list-infinite-scroll ac-live-update — Subscribe to agent events
	// AC: @session-list-infinite-scroll ac-live-update — Find the layout's <main> scroll container
	onMount(() => {
		// The actual scroll container is the layout's <main class="overflow-auto">,
		// not the page's root div. Attach scroll listener there.
		scrollContainer = pageRoot?.closest('main') ?? undefined;
		scrollContainer?.addEventListener('scroll', handleScroll);

		if (!isStaticMode()) {
			subscribe(['agents']);
			on('agents', handleAgentEvent);
		}
	});

	onDestroy(() => {
		scrollContainer?.removeEventListener('scroll', handleScroll);
		if (!isStaticMode()) {
			off('agents', handleAgentEvent);
			unsubscribe(['agents']);
		}
		observer?.disconnect();
	});
</script>

<div class="flex flex-col gap-4 p-6" bind:this={pageRoot}>
	<div>
		<h1 class="text-2xl font-bold">Sessions</h1>
		<!-- AC: @session-list-infinite-scroll ac-initial-load — Show count -->
		{#if !loading && total > 0 && !hasFilters}
			<p class="text-sm text-muted-foreground" data-testid="sessions-count">
				{sessions.length} of {total} session{total === 1 ? '' : 's'}
			</p>
		{/if}
	</div>

	<!-- AC: @session-filter-controls — Filter controls with URL state -->
	{#if !loading || sessions.length > 0}
		<SessionFilters
			filteredTotal={total}
			{unfilteredTotal}
			agentIds={distinctAgentIds}
			agentTypes={distinctAgentTypes}
		/>
	{/if}

	{#if error}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg" role="alert" data-testid="sessions-error">
			{error}
		</div>
	{/if}

	<!-- AC: @session-list-infinite-scroll ac-live-update — New sessions indicator -->
	{#if newSessionsAvailable > 0}
		<button
			class="flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-primary/10 text-primary text-sm font-medium hover:bg-primary/20 transition-colors"
			onclick={refreshNewSessions}
			data-testid="new-sessions-indicator"
		>
			<ArrowUp class="size-3.5" />
			{newSessionsAvailable} new session{newSessionsAvailable === 1 ? '' : 's'} available
		</button>
	{/if}

	<!-- AC: @session-list-infinite-scroll ac-initial-load — Loading skeleton -->
	{#if loading}
		<div class="space-y-2" data-testid="sessions-loading">
			{#each Array(5) as _}
				<div class="h-16 rounded-lg bg-muted ds-shimmer"></div>
			{/each}
		</div>
	{:else if sessions.length === 0 && total === 0}
		<div class="flex flex-col items-center justify-center py-16" data-testid="sessions-empty">
			<Activity class="size-12 text-muted-foreground/30 mb-4" />
			<h2 class="text-lg font-medium text-muted-foreground mb-1">
				{#if hasFilters}
					No matching sessions
				{:else}
					No sessions yet
				{/if}
			</h2>
			<p class="text-sm text-muted-foreground">
				{#if isStaticMode()}
					Session data is not available in static mode.
				{:else if hasFilters}
					Try adjusting your filters.
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

		<!-- AC: @session-list-infinite-scroll ac-scroll-load — Loading indicator for next page -->
		{#if loadingMore}
			<div class="flex items-center justify-center py-4 gap-2 text-muted-foreground" data-testid="sessions-loading-more">
				<Loader2 class="size-4 animate-spin" />
				<span class="text-sm">Loading more sessions...</span>
			</div>
		{/if}

		<!-- AC: @session-list-infinite-scroll ac-scroll-end — End of list indicator -->
		{#if allLoaded && sessions.length > 0}
			<div class="flex items-center justify-center py-4" data-testid="sessions-end-of-list">
				<span class="text-xs text-muted-foreground/60">All {total} sessions loaded</span>
			</div>
		{/if}

		<!-- AC: @session-list-infinite-scroll ac-scroll-load — Sentinel for IntersectionObserver -->
		{#if !allLoaded}
			<div bind:this={sentinel} class="h-1" data-testid="scroll-sentinel" aria-hidden="true"></div>
		{/if}
	{/if}
</div>
