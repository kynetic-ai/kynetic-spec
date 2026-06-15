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
  AC: @ui-data-freshness ac-1 — Renders from cache on revisit without loading state (createInfiniteQuery caches pages)
  AC: @ui-data-freshness ac-3 — WS events invalidate session queries via centralized wiring
-->
<script lang="ts">
	import { on, off } from '$lib/stores/connection.svelte';
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { base } from '$app/paths';
	import type {
		SessionSummary,
		FetchSessionsParams,
		SessionSearchResult,
		FetchSessionSearchParams
	} from '$lib/api';
	import { fetchSessions, fetchSessionSearch, isCacheWarmingError } from '$lib/api';
	import CacheWarmingBanner from '$lib/components/CacheWarmingBanner.svelte';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { formatElapsed, formatAge, getTriggerLabel, isDispatchedSession } from '$lib/components/session/session-utils';
	import SessionFilters from '$lib/components/session/SessionFilters.svelte';
	import { StatusBadge } from '$lib/components/ds';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import { createInfiniteQuery, createQuery } from '$lib/query/createQuery.svelte.js';
	import { queryKeys } from '$lib/query/keys.js';
	import Activity from 'lucide-svelte/icons/activity';
	import Zap from 'lucide-svelte/icons/zap';
	import Terminal from 'lucide-svelte/icons/terminal';
	import Loader2 from 'lucide-svelte/icons/loader-2';
	import Search from 'lucide-svelte/icons/search';
	import ArrowUp from 'lucide-svelte/icons/arrow-up';
	import type { BroadcastEvent } from '@kynetic-ai/shared';

	const PAGE_SIZE = 25;
	const SCROLL_THRESHOLD = 200; // px from bottom to trigger load
	const SEARCH_LIMIT = 50;
	const TOP_REFRESH_THRESHOLD = 80;

	// Local UI state
	let searchInput = $state('');
	let isNearTop = $state(true);
	let pendingFreshCount = $state(0);
	let frozenSessions = $state<SessionSummary[] | null>(null);
	let liveRefreshQueued = false;
	let liveRefreshInFlight = false;
	let scrollContainer: HTMLElement | null = null;

	// IntersectionObserver sentinel element
	let sentinel: HTMLDivElement | undefined = $state();
	let observer: IntersectionObserver | undefined;

	// AC: @ui-url-panel-state ac-4 — Derive filter values from URL params
	let filterStatuses = $derived($page.url.searchParams.getAll('status'));
	let filterAgentId = $derived($page.url.searchParams.get('agent_id') || '');
	let filterAgentType = $derived($page.url.searchParams.get('agent_type') || '');
	let filterTrigger = $derived($page.url.searchParams.get('trigger') || '');
	let filterSince = $derived($page.url.searchParams.get('since') || '');
	let filterTaskId = $derived($page.url.searchParams.get('task_id') || '');
	let filterSpecRef = $derived($page.url.searchParams.get('spec_ref') || '');
	let searchQuery = $derived($page.url.searchParams.get('q') || '');
	let searchMode = $derived(searchQuery.trim().length > 0);
	let hasFilters = $derived(
		filterStatuses.length > 0 ||
			filterAgentId ||
			filterAgentType ||
			filterTrigger ||
			filterSince ||
			filterTaskId ||
			filterSpecRef
	);

	/**
	 * Build filter object for query keys and fetch params.
	 * Excludes pagination — used for cache key identity.
	 */
	function buildFilterKey(): Record<string, unknown> {
		const key: Record<string, unknown> = {};
		if (filterStatuses.length > 0) key.status = filterStatuses;
		if (filterAgentId) key.agent_id = filterAgentId;
		if (filterAgentType) key.agent_type = filterAgentType;
		if (filterTrigger) key.trigger = filterTrigger;
		if (filterSince) key.since = filterSince;
		if (filterTaskId) key.task_id = filterTaskId;
		if (filterSpecRef) key.spec_ref = filterSpecRef;
		return key;
	}

	/**
	 * Build FetchSessionsParams from current URL search params + page offset.
	 */
	function buildFetchParams(pageOffset: number): FetchSessionsParams {
		const params: FetchSessionsParams = {
			offset: pageOffset,
			limit: PAGE_SIZE
		};
		if (filterStatuses.length > 0) params.status = filterStatuses;
		if (filterAgentId) params.agent_id = filterAgentId;
		if (filterAgentType) params.agent_type = filterAgentType;
		if (filterTrigger) params.trigger = filterTrigger;
		if (filterSince) params.since = filterSince;
		if (filterTaskId) params.task_id = filterTaskId;
		if (filterSpecRef) params.spec_ref = filterSpecRef;
		return params;
	}

	function buildSearchParams(): FetchSessionSearchParams {
		const params: FetchSessionSearchParams = {
			q: searchQuery.trim(),
			limit: SEARCH_LIMIT
		};
		if (filterStatuses.length > 0) params.status = filterStatuses;
		if (filterAgentId) params.agent_id = filterAgentId;
		if (filterAgentType) params.agent_type = filterAgentType;
		if (filterTrigger) params.trigger = filterTrigger;
		if (filterSince) params.since = filterSince;
		if (filterTaskId) params.task_id = filterTaskId;
		if (filterSpecRef) params.spec_ref = filterSpecRef;
		return params;
	}

	// AC: @ui-data-freshness ac-1 — createInfiniteQuery caches pages; revisits render from cache
	// AC: @ui-data-freshness ac-2 — Concurrent requests deduplicated by TanStack Query
	// AC: @session-list-infinite-scroll ac-initial-load — First page loaded automatically
	const sessionsQuery = createInfiniteQuery(() => ({
		queryKey: queryKeys.sessions.list({ ...buildFilterKey(), mode: 'paginated' }),
		queryFn: ({ pageParam }) =>
			fetchSessions(buildFetchParams(pageParam as number)),
		initialPageParam: 0,
		getNextPageParam: (lastPage) => {
			const nextOffset = lastPage.offset + lastPage.items.length;
			return nextOffset < lastPage.total ? nextOffset : undefined;
		},
		enabled: isProjectInitialized() && !searchMode,
	}));

	// Search query — separate from paginated list
	const searchResultsQuery = createQuery(() => ({
		queryKey: queryKeys.sessions.list({ ...buildFilterKey(), mode: 'search', q: searchQuery }),
		queryFn: () => fetchSessionSearch(buildSearchParams()),
		enabled: isProjectInitialized() && searchMode,
	}));

	// Derived state from queries
	let sessions = $derived<SessionSummary[]>(
		sessionsQuery.data?.pages.flatMap((p) => p.items) ?? []
	);
	let total = $derived(sessionsQuery.data?.pages[0]?.total ?? 0);
	let loading = $derived(sessionsQuery.isLoading);
	let loadingMore = $derived(sessionsQuery.isFetchingNextPage);
	let allLoaded = $derived(searchMode ? true : !sessionsQuery.hasNextPage);
	// AC: @ui-data-freshness ac-warming-skeleton — Distinguish warming errors from other errors
	// Check the active query (search vs paginated) for cache warming state
	let cacheWarming = $derived(
		searchMode
			? isCacheWarmingError(searchResultsQuery.error)
			: isCacheWarmingError(sessionsQuery.error)
	);
	let error = $derived(
		cacheWarming
			? ''
			: (
				(isCacheWarmingError(sessionsQuery.error) ? '' : sessionsQuery.error?.message ?? '') ||
				(isCacheWarmingError(searchResultsQuery.error) ? '' : searchResultsQuery.error?.message ?? '')
			)
	);

	let searchResults = $derived<SessionSearchResult[]>(searchResultsQuery.data?.items ?? []);
	let totalMatches = $derived(searchResultsQuery.data?.total_matches ?? 0);
	let searchTotal = $derived(searchResultsQuery.data?.total_sessions ?? 0);
	let searchLoading = $derived(searchResultsQuery.isLoading);
	let visibleSessions = $derived(frozenSessions ?? sessions);

	// AC: @session-filter-controls ac-filter-counts — Read unfiltered_total from paginated response
	let unfilteredTotal = $derived(sessionsQuery.data?.pages[0]?.unfiltered_total ?? 0);

	// AC: @session-filter-controls ac-agent-filter, ac-agent-type-filter — Distinct values for filter dropdowns
	let distinctAgentIds = $derived.by(() => {
		const agentIdSet = new Set<string>();
		for (const session of sessions) {
			if (session.agent_id) agentIdSet.add(session.agent_id);
		}
		if (filterAgentId) agentIdSet.add(filterAgentId);
		return [...agentIdSet].sort();
	});

	let distinctAgentTypes = $derived.by(() => {
		const agentTypeSet = new Set<string>();
		for (const session of sessions) {
			agentTypeSet.add(session.agent_type);
		}
		if (filterAgentType) agentTypeSet.add(filterAgentType);
		return [...agentTypeSet].sort();
	});

	function applySearch(value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			params.delete('q');
		} else {
			params.set('q', trimmed);
		}
		params.delete('offset');
		const qs = params.toString();
		goto(qs ? `${base}/sessions?${qs}` : `${base}/sessions`, {
			replaceState: true,
			keepFocus: true,
			noScroll: true
		});
	}

	function handleSearchSubmit(event: SubmitEvent) {
		event.preventDefault();
		applySearch(searchInput);
	}

	function resolveScrollContainer(): HTMLElement | null {
		return document.querySelector('main.overflow-auto');
	}

	function updateNearTopState(): void {
		scrollContainer ??= resolveScrollContainer();
		const nextNearTop = (scrollContainer?.scrollTop ?? 0) <= TOP_REFRESH_THRESHOLD;
		isNearTop = nextNearTop;
		if (nextNearTop && (pendingFreshCount > 0 || frozenSessions)) {
			pendingFreshCount = 0;
			frozenSessions = null;
		}
	}

	function buildSessionListFingerprint(items: SessionSummary[]): string {
		return JSON.stringify(
			items.map((session) => [
				session.id,
				session.status,
				session.started_at,
				session.ended_at ?? null,
				session.duration_ms,
				session.event_count,
				session.iteration_count,
				session.tasks_completed
			])
		);
	}

	function buildSearchFingerprint(items: SessionSearchResult[]): string {
		return JSON.stringify(
			items.map((result) => [
				result.session_id,
				result.agent_type,
				result.started_at,
				result.matches.length
			])
		);
	}

	async function refetchForFreshness(): Promise<boolean> {
		if (searchMode) {
			const previousTotal = searchTotal;
			const previousFingerprint = buildSearchFingerprint(searchResults);
			const result = await searchResultsQuery.refetch();
			const nextTotal = result.data?.total_sessions ?? 0;
			const nextFingerprint = buildSearchFingerprint(result.data?.items ?? []);
			return nextTotal !== previousTotal || nextFingerprint !== previousFingerprint;
		}

		const previousTotal = total;
		const previousFingerprint = buildSessionListFingerprint(sessions);
		const result = await sessionsQuery.refetch();
		const nextPages = result.data?.pages ?? [];
		const nextTotal = nextPages[0]?.total ?? 0;
		const nextFingerprint = buildSessionListFingerprint(nextPages.flatMap((page) => page.items));
		return nextTotal !== previousTotal || nextFingerprint !== previousFingerprint;
	}

	function delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function refetchForFreshnessWithRetry(): Promise<boolean> {
		const retryDelaysMs = [150, 300];
		let changed = await refetchForFreshness();
		if (changed || searchMode) {
			return changed;
		}

		for (const delayMs of retryDelaysMs) {
			await delay(delayMs);
			changed = await refetchForFreshness();
			if (changed) {
				return true;
			}
		}

		return false;
	}

	async function processLiveRefresh(): Promise<void> {
		const snapshot = frozenSessions ?? sessions.slice();
		const changed = await refetchForFreshnessWithRetry();
		if (!changed || isNearTop || searchMode) {
			if (isNearTop) {
				pendingFreshCount = 0;
				frozenSessions = null;
			}
			return;
		}

		if (!frozenSessions) {
			frozenSessions = snapshot;
		}
		pendingFreshCount += 1;
	}

	async function drainLiveRefreshQueue(): Promise<void> {
		if (liveRefreshInFlight) return;
		liveRefreshInFlight = true;
		try {
			while (liveRefreshQueued) {
				liveRefreshQueued = false;
				await processLiveRefresh();
			}
		} finally {
			liveRefreshInFlight = false;
		}
	}

	function isLiveSessionUpdate(topic: 'agents' | 'sessions', event: BroadcastEvent): boolean {
		if (topic === 'sessions') {
			return event.event !== 'session_error';
		}

		const streamingEvents = new Set([
			'message_start',
			'message_progress',
			'thinking_start',
			'thinking_progress',
			'tool_call_start'
		]);
		return !streamingEvents.has(event.event);
	}

	function handleLiveSessionUpdate(topic: 'agents' | 'sessions', event: BroadcastEvent): void {
		if (isStaticMode() || !isLiveSessionUpdate(topic, event)) {
			return;
		}
		liveRefreshQueued = true;
		void drainLiveRefreshQueue();
	}

	async function revealFreshSessions(): Promise<void> {
		pendingFreshCount = 0;
		frozenSessions = null;
		scrollContainer ??= resolveScrollContainer();
		scrollContainer?.scrollTo({ top: 0, behavior: 'smooth' });
		await refetchForFreshness();
	}

	$effect(() => {
		searchInput = searchQuery;
	});

	$effect(() => {
		if (!searchMode) return;
		pendingFreshCount = 0;
		frozenSessions = null;
	});

	// AC: @session-list-infinite-scroll ac-scroll-load — IntersectionObserver for sentinel
	$effect(() => {
		if (!sentinel) return;

		observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				if (entry?.isIntersecting && !searchMode && !loadingMore && !allLoaded && !loading) {
					sessionsQuery.fetchNextPage();
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

	onDestroy(() => {
		observer?.disconnect();
		if (!isStaticMode()) {
			off('agents', agentsHandler);
			off('sessions', sessionsHandler);
		}
		scrollContainer?.removeEventListener('scroll', updateNearTopState);
	});

	const agentsHandler = (event: BroadcastEvent) => handleLiveSessionUpdate('agents', event);
	const sessionsHandler = (event: BroadcastEvent) => handleLiveSessionUpdate('sessions', event);

	onMount(() => {
		if (isStaticMode()) {
			return;
		}

		on('agents', agentsHandler);
		on('sessions', sessionsHandler);
	});

	$effect(() => {
		scrollContainer = resolveScrollContainer();
		if (!scrollContainer) return;
		updateNearTopState();
		scrollContainer.addEventListener('scroll', updateNearTopState, { passive: true });
		return () => {
			scrollContainer?.removeEventListener('scroll', updateNearTopState);
		};
	});
</script>

<div class="flex flex-col gap-4 p-6">
	<div>
		<h1 class="text-2xl font-bold">Sessions</h1>
		<!-- AC: @session-list-infinite-scroll ac-initial-load — Show count -->
		{#if searchMode && !searchLoading}
			<p class="text-sm text-muted-foreground" data-testid="session-search-count">
				{totalMatches} match{totalMatches === 1 ? '' : 'es'} across {searchTotal} session{searchTotal === 1 ? '' : 's'}
			</p>
		{:else if !loading && total > 0 && !hasFilters}
			<p class="text-sm text-muted-foreground" data-testid="sessions-count">
				{sessions.length} of {total} session{total === 1 ? '' : 's'}
			</p>
		{/if}
	</div>

	<form class="flex gap-2" onsubmit={handleSearchSubmit} data-testid="session-search-form">
		<div class="relative flex-1">
			<Search class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
			<input
				bind:value={searchInput}
				type="search"
				class="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm"
				placeholder="Search session events"
				data-testid="session-search-input"
			/>
		</div>
		<button
			type="submit"
			class="h-10 rounded-md border px-4 text-sm font-medium hover:bg-accent"
			data-testid="session-search-submit"
		>
			Search
		</button>
	</form>

	<!-- AC: @session-filter-controls — Filter controls with URL state -->
	{#if (!loading && !searchLoading) || sessions.length > 0 || searchResults.length > 0}
		<SessionFilters
			filteredTotal={searchMode ? searchTotal : total}
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

	<!-- AC: @ui-data-freshness ac-warming-skeleton — Show skeleton during cache warming -->
	<!-- AC: @ui-data-freshness ac-warming-timeout — Show error banner after 30s timeout -->
	<!-- AC: @session-list-infinite-scroll ac-initial-load — Loading skeleton -->
	{#if cacheWarming}
		<CacheWarmingBanner
			entityName="sessions"
			queryKey={searchMode
				? queryKeys.sessions.list({ ...buildFilterKey(), mode: 'search', q: searchQuery })
				: queryKeys.sessions.list({ ...buildFilterKey(), mode: 'paginated' })}
		/>
	{:else if loading || (searchMode && searchLoading)}
		<div class="space-y-2" data-testid="sessions-loading">
			{#each Array(5) as _}
				<div class="h-16 rounded-lg bg-muted ds-shimmer"></div>
			{/each}
		</div>
	{:else if (searchMode ? searchResults.length === 0 : sessions.length === 0) && (searchMode ? searchTotal === 0 : total === 0)}
		<div class="flex flex-col items-center justify-center py-16" data-testid="sessions-empty">
			<Activity class="size-12 text-muted-foreground/30 mb-4" />
			<h2 class="text-lg font-medium text-muted-foreground mb-1">
				{#if searchMode || hasFilters}
					No matching sessions
				{:else}
					No sessions yet
				{/if}
			</h2>
			<p class="text-sm text-muted-foreground">
				{#if isStaticMode()}
					Session data is not available in static mode.
				{:else if searchMode}
					Try adjusting your search or filters.
				{:else if hasFilters}
					Try adjusting your filters.
				{:else}
					Sessions are created when agents run tasks.
				{/if}
			</p>
		</div>
	{:else if searchMode}
		<div class="space-y-3" data-testid="session-search-results">
			{#each searchResults as result (result.session_id)}
				<a
					href="{base}/sessions/{result.session_id}"
					class="block rounded-lg border p-4 hover:bg-accent/30 transition-colors"
					data-testid="session-search-session"
					data-session-id={result.session_id}
				>
					<div class="flex items-center justify-between gap-3">
						<div>
							<p class="text-sm font-medium">{result.agent_type}</p>
							<p class="text-xs text-muted-foreground font-mono">{result.session_id}</p>
						</div>
						<p class="text-xs text-muted-foreground">{formatAge(result.started_at)}</p>
					</div>
					<div class="mt-3 space-y-2">
						{#each result.matches as match}
							<div class="rounded-md bg-muted/40 p-3" data-testid="session-search-match">
								<p class="text-[11px] uppercase tracking-wide text-muted-foreground">
									{match.event_type} #{match.event_seq} · {new Date(match.timestamp).toISOString()}
								</p>
								<p class="mt-1 text-sm text-foreground/90 break-words">{match.content_excerpt}</p>
							</div>
						{/each}
					</div>
				</a>
			{/each}
		</div>
	{:else}
		{#if pendingFreshCount > 0}
			<button
				type="button"
				class="sticky top-0 z-10 flex items-center gap-2 self-start rounded-full border bg-background/95 px-3 py-2 text-sm font-medium shadow-sm backdrop-blur"
				data-testid="new-sessions-indicator"
				onclick={() => void revealFreshSessions()}
			>
				<ArrowUp class="size-4" />
				{pendingFreshCount} new session{pendingFreshCount === 1 ? '' : 's'}
			</button>
		{/if}

		<!-- AC: @ui-session-history ac-1 — List showing ID, agent type, task ref, status, duration, age -->
		<div class="space-y-2" data-testid="sessions-list">
			{#each visibleSessions as s (s.id)}
				<!-- AC: @ui-session-history ac-2 — Click navigates to /sessions/:id -->
				<a
					href="{base}/sessions/{s.id}"
					class="flex items-center gap-4 p-3 rounded-lg border hover:bg-accent/30 transition-colors"
					data-testid="session-row"
					data-session-id={s.id}
				>
					<!-- AC: @ui-view-header ac-2 — session state drawn from the shared status-token source -->
					<StatusBadge domain="session" state={s.status} testid="session-status-badge" />

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
									<ReferenceLink ref={s.task_id} type="task" title={s.task_title ?? undefined} inline class="text-xs" />
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
