<!--
  AC: @ui-plans-view ac-1 — Each plan shows title, status, creation date, linked spec/task counts, and progress.
  AC: @ui-plans-view ac-2 — Expandable plan content rendered as formatted markdown, loaded on demand.
  AC: @ui-data-freshness ac-1 — Renders from cache on revisit without loading state
  AC: @ui-data-freshness ac-3 — WebSocket events invalidate plan queries via centralized wiring
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onDestroy, onMount } from 'svelte';
	import type {
		BatchItemSummary,
		BroadcastEvent,
		PlanDetail,
		PlanResourceChangedEventData,
		PlanSummary
	} from '@kynetic-ai/shared';
	import { createQuery } from '@tanstack/svelte-query';
	import { fetchPlans, fetchPlanContent, fetchBatchItems, isCacheWarmingError } from '$lib/api';
	import CacheWarmingBanner from '$lib/components/CacheWarmingBanner.svelte';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { off, on } from '$lib/stores/connection.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { buildPlanContentBlocks } from '$lib/utils/plan-embedded-content';
	import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import PlanEmbeddedBlocks from '$lib/components/plans/PlanEmbeddedBlocks.svelte';
	import MapIcon from 'lucide-svelte/icons/map';
	import FileTextIcon from 'lucide-svelte/icons/file-text';
	import ListTodoIcon from 'lucide-svelte/icons/list-todo';
	import ChevronDownIcon from 'lucide-svelte/icons/chevron-down';

	// ── Filter state — URL-driven for consistency ──
	type PlanStatusFilter = 'all' | 'draft' | 'approved' | 'active' | 'completed' | 'rejected';
	let filterStatus = $derived<PlanStatusFilter>(
		($page.url.searchParams.get('status') as PlanStatusFilter) || 'all'
	);

	function setFilterStatus(status: PlanStatusFilter) {
		const url = new URL($page.url);
		if (status === 'all') {
			url.searchParams.delete('status');
		} else {
			url.searchParams.set('status', status);
		}
		goto(url, { replaceState: true, keepFocus: true, noScroll: true });
	}

	// ── Plan content expansion state ──
	// AC: @ui-plans-view ac-2 — Track expanded plans and their lazy-loaded content
	let expandedPlanId = $state<string | null>(null);
	let detailCache = $state<Record<string, PlanDetail>>({});
	let contentLoading = $state<Record<string, boolean>>({});
	let contentError = $state<Record<string, string>>({});
	let embeddedItemsCache = $state<Record<string, BatchItemSummary[]>>({});
	let embeddedItemsLoading = $state<Record<string, boolean>>({});
	let embeddedItemsError = $state<Record<string, string>>({});

	// ── Plan status labels and colors ──
	// AC: @ui-plans-view ac-1 — visually distinct statuses with text labels
	const PLAN_STATUS_LABELS: Record<string, string> = {
		draft: 'Draft',
		approved: 'Approved',
		active: 'Active',
		completed: 'Completed',
		rejected: 'Rejected'
	};

	const PLAN_STATUS_COLORS: Record<string, string> = {
		draft: 'bg-status-pending text-status-pending-fg',
		approved: 'bg-status-pending-review text-status-pending-review-fg',
		active: 'bg-status-in-progress text-status-in-progress-fg',
		completed: 'bg-status-completed text-status-completed-fg',
		rejected: 'bg-status-blocked text-status-blocked-fg'
	};

	// --- TanStack Query: plans data ---
	// AC: @ui-data-freshness ac-1 — createQuery caches; revisits render from cache
	// AC: @ui-data-freshness ac-2 — Concurrent uses share the same in-flight request
	const plansQuery = createQuery(() => ({
		queryKey: queryKeys.plans.lists(),
		queryFn: () => fetchPlans(),
		enabled: isProjectInitialized(),
	}));

	let plans = $derived(plansQuery.data?.items ?? []);
	let loading = $derived(plansQuery.isLoading);
	// AC: @ui-data-freshness ac-warming-skeleton — Distinguish warming errors from other errors
	let cacheWarming = $derived(isCacheWarmingError(plansQuery.error));
	let error = $derived(cacheWarming ? '' : (plansQuery.error?.message ?? ''));

	// ── Filtered plans ──
	let filteredPlans = $derived.by(() => {
		if (filterStatus === 'all') return plans;
		return plans.filter((p) => p.status === filterStatus);
	});

	// ── Status summary counts ──
	let statusCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const plan of plans) {
			counts[plan.status] = (counts[plan.status] ?? 0) + 1;
		}
		return counts;
	});

	// AC: @ui-plans-view ac-2 — Toggle plan content expansion, lazy-load content on first expand
	async function togglePlanContent(plan: PlanSummary) {
		const planRef = plan.slugs[0] ?? plan._ulid;

		if (expandedPlanId === plan._ulid) {
			expandedPlanId = null;
			return;
		}

		expandedPlanId = plan._ulid;

		// Skip loading if already cached
		if (detailCache[plan._ulid] !== undefined) {
			if (
				embeddedItemsCache[plan._ulid] === undefined &&
				!embeddedItemsLoading[plan._ulid] &&
				plan.derived_specs.length + plan.derived_tasks.length > 0
			) {
				void loadEmbeddedItems(plan);
			}
			return;
		}

		// Don't re-fetch if already loading
		if (contentLoading[plan._ulid]) return;

		contentLoading = { ...contentLoading, [plan._ulid]: true };
		contentError = { ...contentError, [plan._ulid]: '' };

		try {
			const detail = await fetchPlanContent(planRef);
			detailCache = { ...detailCache, [plan._ulid]: detail };
			if (detail.derived_specs.length + detail.derived_tasks.length > 0) {
				void loadEmbeddedItems(detail);
			}
		} catch (err) {
			contentError = {
				...contentError,
				[plan._ulid]: err instanceof Error ? err.message : 'Failed to load plan content'
			};
		} finally {
			contentLoading = { ...contentLoading, [plan._ulid]: false };
		}
	}

	async function loadEmbeddedItems(plan: Pick<PlanDetail, '_ulid' | 'derived_specs' | 'derived_tasks'>) {
		if (embeddedItemsLoading[plan._ulid]) return;

		const refs = [...plan.derived_specs, ...plan.derived_tasks];
		if (refs.length === 0) {
			embeddedItemsCache = { ...embeddedItemsCache, [plan._ulid]: [] };
			return;
		}

		embeddedItemsLoading = { ...embeddedItemsLoading, [plan._ulid]: true };
		embeddedItemsError = { ...embeddedItemsError, [plan._ulid]: '' };

		try {
			const response = await fetchBatchItems(refs);
			embeddedItemsCache = { ...embeddedItemsCache, [plan._ulid]: response.items };
		} catch (err) {
			embeddedItemsError = {
				...embeddedItemsError,
				[plan._ulid]: err instanceof Error ? err.message : 'Failed to load embedded items'
			};
		} finally {
			embeddedItemsLoading = { ...embeddedItemsLoading, [plan._ulid]: false };
		}
	}

	// ── Formatting ──
	function formatDate(dateString: string): string {
		const date = new Date(dateString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return 'just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;

		return date.toLocaleDateString();
	}

	// AC: @ui-plans-view ac-1 — Progress percentage from task completion status
	function progressPercent(plan: PlanSummary): number {
		if (plan.task_progress.total === 0) return 0;
		return Math.round((plan.task_progress.completed / plan.task_progress.total) * 100);
	}

	function planBlocks(planId: string): ReturnType<typeof buildPlanContentBlocks> {
		const detail = detailCache[planId];
		if (!detail) return [];

		return buildPlanContentBlocks(detail, {
			batchItems: embeddedItemsCache[planId],
			batchLoading: embeddedItemsLoading[planId],
			batchError: embeddedItemsError[planId]
		});
	}

	function planRefForContent(planId: string): string {
		const plan = plans.find((candidate) => candidate._ulid === planId);
		return plan?.slugs[0] ?? detailCache[planId]?.slugs[0] ?? planId;
	}

	// AC: @ui-targeted-event-consumption ac-3 — Refresh visible expanded plan
	// content from the typed plan event path without relying on file fallback.
	async function refreshCachedPlanContent(planId: string): Promise<void> {
		if (detailCache[planId] === undefined && expandedPlanId !== planId) return;
		if (contentLoading[planId]) return;

		contentLoading = { ...contentLoading, [planId]: true };
		contentError = { ...contentError, [planId]: '' };

		try {
			const detail = await fetchPlanContent(planRefForContent(planId));
			detailCache = { ...detailCache, [planId]: detail };
			if (detail.derived_specs.length + detail.derived_tasks.length > 0) {
				void loadEmbeddedItems(detail);
			}
		} catch (err) {
			contentError = {
				...contentError,
				[planId]: err instanceof Error ? err.message : 'Failed to refresh plan content'
			};
			console.error('Error refreshing plan content:', err);
		} finally {
			contentLoading = { ...contentLoading, [planId]: false };
		}
	}

	function handlePlanUpdate(event: BroadcastEvent): void {
		if (event.event === 'plan_resource_changed') {
			const data = event.data as Partial<PlanResourceChangedEventData> | undefined;
			if (data?.plan_ulid) {
				void refreshCachedPlanContent(data.plan_ulid);
			}
			return;
		}

		if (event.event === 'file_changed') {
			const ref = (event.data as { ref?: string } | undefined)?.ref;
			const [, planId] = ref?.match(/^plans\/([^/]+)\//) ?? [];
			if (planId) {
				void refreshCachedPlanContent(planId);
			}
		}
	}

	onMount(() => {
		on('plans:updates', handlePlanUpdate);
		on('files:updates', handlePlanUpdate);
	});

	onDestroy(() => {
		off('plans:updates', handlePlanUpdate);
		off('files:updates', handlePlanUpdate);
	});
</script>

<div class="flex flex-col gap-4 p-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold">Plans</h1>
			{#if !loading}
				<p class="text-sm text-muted-foreground" data-testid="plans-summary">
					{plans.length} plan{plans.length === 1 ? '' : 's'}
					{#if Object.keys(statusCounts).length > 0}
						&middot;
						{#each Object.entries(statusCounts) as [status, count], i}
							{count} {PLAN_STATUS_LABELS[status]?.toLowerCase() ?? status}{i < Object.entries(statusCounts).length - 1 ? ', ' : ''}
						{/each}
					{/if}
					{#if filteredPlans.length !== plans.length}
						&middot; Showing {filteredPlans.length} filtered
					{/if}
				</p>
			{/if}
		</div>
	</div>

	<!-- Filter controls — URL-driven for consistency -->
	<div class="flex flex-wrap gap-2 items-center" data-testid="plans-filters">
		<label for="plans-status-filter" class="text-sm font-medium text-muted-foreground">Status</label>
		<select
			id="plans-status-filter"
			value={filterStatus}
			onchange={(e) => setFilterStatus(e.currentTarget.value as PlanStatusFilter)}
			class="rounded-md border bg-background px-3 py-1.5 text-sm"
			data-testid="plans-status-filter"
		>
			<option value="all">All Status</option>
			<option value="draft">Draft</option>
			<option value="approved">Approved</option>
			<option value="active">Active</option>
			<option value="completed">Completed</option>
			<option value="rejected">Rejected</option>
		</select>
	</div>

	{#if error}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg text-sm" data-testid="error-message" role="alert">
			{error}
		</div>
	{/if}

	<!-- AC: @ui-data-freshness ac-warming-skeleton — Show skeleton during cache warming -->
	<!-- AC: @ui-data-freshness ac-warming-timeout — Show error banner after 30s timeout -->
	{#if cacheWarming}
		<CacheWarmingBanner entityName="plans" queryKey={queryKeys.plans.lists()} />
	{:else if loading}
		<div class="space-y-2" data-testid="plans-loading">
			{#each Array(3) as _}
				<div class="h-28 rounded-lg bg-muted ds-shimmer"></div>
			{/each}
		</div>
	{:else if filteredPlans.length === 0}
		<div class="flex flex-col items-center justify-center py-16" data-testid="plans-empty">
			<MapIcon class="size-12 text-muted-foreground/30 mb-4" />
			{#if plans.length === 0}
				<h2 class="text-lg font-medium text-muted-foreground mb-1">No plans yet</h2>
				<p class="text-sm text-muted-foreground">
					{#if isStaticMode()}
						No plan data available in the snapshot.
					{:else}
						Create plans with <code class="text-xs bg-muted px-1 py-0.5 rounded">kspec plan add</code> to track implementation progress.
					{/if}
				</p>
			{:else}
				<h2 class="text-lg font-medium text-muted-foreground mb-1">No matching plans</h2>
				<p class="text-sm text-muted-foreground">Try adjusting the filter above.</p>
			{/if}
		</div>
	{:else}
		<div class="flex flex-col gap-3" data-testid="plans-list">
			{#each filteredPlans as plan (plan._ulid)}
				<!-- AC: @ui-plans-view ac-1 — Plan card with all required fields -->
				<Card class="transition-all duration-200 hover:shadow-md" data-testid="plan-card">
					<CardHeader class="pb-3">
						<div class="flex items-start justify-between gap-4">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-1">
									<Badge
										class={PLAN_STATUS_COLORS[plan.status] ?? 'bg-muted text-muted-foreground'}
										data-testid="plan-status"
									>
										{PLAN_STATUS_LABELS[plan.status] ?? plan.status}
									</Badge>
									<h3 class="text-sm font-semibold truncate" data-testid="plan-title">{plan.title}</h3>
								</div>
							</div>
						</div>
					</CardHeader>
					<CardContent class="pt-0">
						<div class="flex flex-col gap-3">
							<!-- AC: @ui-plans-view ac-1 — Progress bar based on task completion status -->
							{#if plan.task_progress.total > 0}
								<div class="flex items-center gap-3">
									<div class="flex-1 h-2 rounded-full bg-muted overflow-hidden" data-testid="plan-progress-bar">
										<div
											class="h-full rounded-full bg-status-completed transition-all duration-300"
											style="width: {progressPercent(plan)}%"
										></div>
									</div>
									<span class="text-xs font-medium text-muted-foreground whitespace-nowrap" data-testid="plan-progress-text">
										{progressPercent(plan)}% ({plan.task_progress.completed}/{plan.task_progress.total} tasks)
									</span>
								</div>
								<!-- Task status breakdown -->
								<div class="flex flex-wrap gap-2 text-xs text-muted-foreground" data-testid="plan-task-breakdown">
									{#if plan.task_progress.completed > 0}
										<span class="inline-flex items-center gap-1">
											<span class="inline-block size-2 rounded-full bg-status-completed"></span>
											{plan.task_progress.completed} completed
										</span>
									{/if}
									{#if plan.task_progress.in_progress > 0}
										<span class="inline-flex items-center gap-1">
											<span class="inline-block size-2 rounded-full bg-status-in-progress"></span>
											{plan.task_progress.in_progress} in progress
										</span>
									{/if}
									{#if plan.task_progress.pending > 0}
										<span class="inline-flex items-center gap-1">
											<span class="inline-block size-2 rounded-full bg-status-pending"></span>
											{plan.task_progress.pending} pending
										</span>
									{/if}
									{#if plan.task_progress.blocked > 0}
										<span class="inline-flex items-center gap-1">
											<span class="inline-block size-2 rounded-full bg-status-blocked"></span>
											{plan.task_progress.blocked} blocked
										</span>
									{/if}
								</div>
							{/if}

							<!-- Metadata row -->
							<div class="flex items-center gap-2 text-xs text-muted-foreground">
								<span data-testid="plan-created-at">{formatDate(plan.created_at)}</span>
								<span>&middot;</span>
								<span data-testid="plan-spec-count">{plan.spec_count} spec{plan.spec_count === 1 ? '' : 's'}</span>
								<span>&middot;</span>
								<span data-testid="plan-task-count">{plan.task_count} task{plan.task_count === 1 ? '' : 's'}</span>
								{#if plan.slugs.length > 0}
									<span>&middot;</span>
									<code class="text-xs bg-muted px-1 py-0.5 rounded" data-testid="plan-slug">@{plan.slugs[0]}</code>
								{/if}
							</div>
						</div>

						<!-- Navigation actions and expand toggle -->
						<div class="flex items-center gap-2 pt-1" data-testid="plan-actions">
							{#if plan.spec_count > 0}
								<Button
									variant="outline"
									size="sm"
									href="{base}/items?plan={encodeURIComponent(plan.slugs[0] ?? plan._ulid)}"
									class="h-7 gap-1.5 text-xs"
									data-testid="plan-view-specs"
								>
									<FileTextIcon class="size-3.5" />
									View Specs
								</Button>
							{/if}
							{#if plan.task_count > 0}
								<Button
									variant="outline"
									size="sm"
									href="{base}/tasks?plan={encodeURIComponent(plan.slugs[0] ?? plan._ulid)}"
									class="h-7 gap-1.5 text-xs"
									data-testid="plan-view-tasks"
								>
									<ListTodoIcon class="size-3.5" />
									View Tasks
								</Button>
							{/if}
							<!-- AC: @ui-plans-view ac-2 — Expand/collapse button for plan content -->
							<Button
								variant="ghost"
								size="sm"
								class="h-7 gap-1.5 text-xs ml-auto"
								onclick={() => togglePlanContent(plan)}
								aria-expanded={expandedPlanId === plan._ulid}
								aria-controls="plan-content-{plan._ulid}"
								data-testid="plan-expand-toggle"
							>
								{expandedPlanId === plan._ulid ? 'Hide Content' : 'Show Content'}
								<ChevronDownIcon
									class="size-3.5 transition-transform duration-200 {expandedPlanId === plan._ulid ? 'rotate-180' : ''}"
								/>
							</Button>
						</div>

						<!-- AC: @ui-plans-view ac-2 — Expandable plan content section -->
						{#if expandedPlanId === plan._ulid}
							<div
								id="plan-content-{plan._ulid}"
								class="mt-3 border-t pt-3"
								data-testid="plan-content-section"
							>
								{#if contentLoading[plan._ulid]}
									<div class="space-y-2" data-testid="plan-content-loading">
										<Skeleton class="h-4 w-full" />
										<Skeleton class="h-4 w-5/6" />
										<Skeleton class="h-4 w-4/6" />
										<Skeleton class="h-4 w-full" />
										<Skeleton class="h-4 w-3/6" />
									</div>
								{:else if contentError[plan._ulid]}
									<div
										class="text-sm text-destructive bg-destructive/10 p-3 rounded"
										role="alert"
										data-testid="plan-content-error"
									>
										{contentError[plan._ulid]}
									</div>
								{:else if detailCache[plan._ulid] !== undefined}
									{#if detailCache[plan._ulid].content}
										<div class="prose prose-sm dark:prose-invert max-w-none">
											<PlanEmbeddedBlocks blocks={planBlocks(plan._ulid)} />
										</div>
									{:else}
										<p class="text-sm text-muted-foreground italic" data-testid="plan-content-empty">
											No content available for this plan.
										</p>
									{/if}
								{/if}
							</div>
						{/if}
					</CardContent>
				</Card>
			{/each}
		</div>
	{/if}
</div>
