<!--
  AC: @review-records-web-ui ac-1 — Review list page with filtering, sorting, disposition badges
  AC: @review-records-web-ui ac-10 — Empty state when no reviews exist
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import type { ReviewSummary, BroadcastEvent } from '@kynetic-ai/shared';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import { StatusBadge } from '$lib/components/ds';
	import {
		Table,
		TableBody,
		TableCell,
		TableHead,
		TableHeader,
		TableRow
	} from '$lib/components/ui/table';
	import { fetchReviews, isCacheWarmingError } from '$lib/api';
	import CacheWarmingBanner from '$lib/components/CacheWarmingBanner.svelte';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';

	let updatedReviewIds = $state<Set<string>>(new Set());

	// --- URL-driven filter state ---
	// No URL status param → default to 'open' (landing view shows open reviews)
	// URL status=all → send all valid statuses (backend defaults to 'open' when no status param)
	// URL status=<value> → send that value to API
	const ALL_STATUSES: string[] = ['draft', 'open', 'closed', 'archived'];
	function getStatusFilter(urlStatus: string | null): string | string[] | undefined {
		if (urlStatus === 'all') return ALL_STATUSES;
		if (urlStatus) return urlStatus;
		return 'open'; // default landing view
	}

	let filterParams = $derived({
		status: getStatusFilter($page.url.searchParams.get('status')),
		disposition: $page.url.searchParams.get('disposition') || undefined,
		subject_type: $page.url.searchParams.get('subject_type') || undefined,
		sort: $page.url.searchParams.get('sort') || undefined,
		sort_dir: $page.url.searchParams.get('sort_dir') || undefined,
		limit: 50,
		offset: 0
	});

	const reviewsQuery = createQuery(() => ({
		queryKey: queryKeys.reviews.list(filterParams),
		queryFn: () => fetchReviews(filterParams),
		enabled: isProjectInitialized(),
	}));

	let reviews = $derived(reviewsQuery.data?.items ?? []);
	let total = $derived(reviewsQuery.data?.total ?? 0);
	let loading = $derived(reviewsQuery.isLoading);
	// AC: @ui-data-freshness ac-warming-skeleton — Distinguish warming errors from other errors
	let cacheWarming = $derived(isCacheWarmingError(reviewsQuery.error));
	let error = $derived(cacheWarming ? '' : (reviewsQuery.error?.message ?? ''));

	// --- Filter helpers ---
	function updateFilter(key: string, value: string | undefined) {
		const url = new URL($page.url);
		if (!value) {
			url.searchParams.delete(key);
		} else {
			url.searchParams.set(key, value);
		}
		goto(url, { replaceState: true, keepFocus: true, noScroll: true });
	}

	// --- Sort helpers ---
	let currentSort = $derived($page.url.searchParams.get('sort') || 'created_at');
	let currentSortDir = $derived($page.url.searchParams.get('sort_dir') || 'desc');

	function toggleSort(field: string) {
		const url = new URL($page.url);
		if (currentSort === field) {
			// Toggle direction
			url.searchParams.set('sort_dir', currentSortDir === 'desc' ? 'asc' : 'desc');
		} else {
			url.searchParams.set('sort', field);
			url.searchParams.set('sort_dir', 'desc');
		}
		goto(url, { replaceState: true, keepFocus: true, noScroll: true });
	}

	function getSortIndicator(field: string): string {
		if (currentSort !== field) return '';
		return currentSortDir === 'asc' ? ' \u2191' : ' \u2193';
	}

	// --- Subject type formatting ---
	function formatSubjectType(type: string): string {
		const labels: Record<string, string> = {
			task: 'Task',
			code: 'Code',
			plan: 'Plan',
			spec: 'Spec',
			external: 'External'
		};
		return labels[type] || type;
	}

	// --- Relative time ---
	function formatRelativeTime(dateStr: string): string {
		const date = new Date(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return 'just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 30) return `${diffDays}d ago`;
		return date.toLocaleDateString();
	}

	// --- Active filter state ---
	let activeStatus = $derived($page.url.searchParams.get('status') || '');
	let activeDisposition = $derived($page.url.searchParams.get('disposition') || '');
	let activeSubjectType = $derived($page.url.searchParams.get('subject_type') || '');

	// --- WebSocket updates for highlight animation ---
	function handleReviewUpdate(event: BroadcastEvent) {
		if (event.data?.review_ulid) {
			updatedReviewIds.add(event.data.review_ulid);
			updatedReviewIds = new Set(updatedReviewIds);

			setTimeout(() => {
				updatedReviewIds.delete(event.data.review_ulid);
				updatedReviewIds = new Set(updatedReviewIds);
			}, 3000);
		}
	}

	onMount(() => {
		subscribe(['reviews']);
		on('reviews', handleReviewUpdate);
	});

	onDestroy(() => {
		off('reviews', handleReviewUpdate);
		unsubscribe(['reviews']);
	});
</script>

<div class="flex flex-col gap-6 p-6 min-w-0">
	<div>
		<h1 class="text-3xl font-bold mb-2">Reviews</h1>
		{#if !loading}
			<p class="text-muted-foreground">
				Showing {reviews.length} of {total} reviews
			</p>
		{/if}
	</div>

	<!-- AC: @review-records-web-ui ac-1 — Filters for status, disposition, and subject type -->
	<div class="flex flex-wrap gap-2" data-testid="review-filters">
		<!-- Status filter -->
		<select
			class="rounded-md border bg-background px-3 py-1.5 text-sm"
			data-testid="filter-status"
			value={activeStatus || ''}
			onchange={(e) => updateFilter('status', e.currentTarget.value || undefined)}
		>
			<option value="">Open (default)</option>
			<option value="all">All statuses</option>
			<option value="draft">Draft</option>
			<option value="open">Open</option>
			<option value="closed">Closed</option>
			<option value="archived">Archived</option>
		</select>

		<!-- Disposition filter -->
		<select
			class="rounded-md border bg-background px-3 py-1.5 text-sm"
			data-testid="filter-disposition"
			value={activeDisposition}
			onchange={(e) => updateFilter('disposition', e.currentTarget.value || undefined)}
		>
			<option value="">All dispositions</option>
			<option value="pending">Pending</option>
			<option value="approved">Approved</option>
			<option value="changes_requested">Changes Requested</option>
		</select>

		<!-- Subject type filter -->
		<select
			class="rounded-md border bg-background px-3 py-1.5 text-sm"
			data-testid="filter-subject-type"
			value={activeSubjectType}
			onchange={(e) => updateFilter('subject_type', e.currentTarget.value || undefined)}
		>
			<option value="">All types</option>
			<option value="task">Task</option>
			<option value="code">Code</option>
			<option value="plan">Plan</option>
			<option value="spec">Spec</option>
			<option value="external">External</option>
		</select>
	</div>

	{#if error}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg" data-testid="error-message" role="alert">
			{error}
		</div>
	{/if}

	<!-- AC: @ui-data-freshness ac-warming-skeleton — Show skeleton during cache warming -->
	<!-- AC: @ui-data-freshness ac-warming-timeout — Show error banner after 30s timeout -->
	{#if cacheWarming}
		<CacheWarmingBanner entityName="reviews" queryKey={queryKeys.reviews.list(filterParams)} />
	{:else if loading}
		<div class="space-y-2" data-testid="reviews-loading">
			{#each Array(5) as _}
				<div class="h-12 rounded-lg bg-muted ds-shimmer"></div>
			{/each}
		</div>
	{:else}
		<!-- AC: @review-records-web-ui ac-1 — Sortable columns -->
		<div class="rounded-md border overflow-hidden" data-testid="review-list">
			<Table class="table-fixed">
				<TableHeader>
					<TableRow>
						<TableHead class="w-[30%]">
							<button class="flex items-center gap-1 hover:text-foreground" onclick={() => toggleSort('title')}>
								Title{getSortIndicator('title')}
							</button>
						</TableHead>
						<TableHead class="w-[10%]">
							<button class="flex items-center gap-1 hover:text-foreground" onclick={() => toggleSort('lifecycle_state')}>
								Status{getSortIndicator('lifecycle_state')}
							</button>
						</TableHead>
						<TableHead class="w-[14%]">Disposition</TableHead>
						<TableHead class="w-[8%]">Type</TableHead>
						<TableHead class="w-[12%]">Reviewer</TableHead>
						<TableHead class="w-[14%]">Linked Task</TableHead>
						<TableHead class="w-[12%]">
							<button class="flex items-center gap-1 hover:text-foreground" onclick={() => toggleSort('created_at')}>
								Created{getSortIndicator('created_at')}
							</button>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					<!-- AC: @review-records-web-ui ac-10 — Empty state -->
					{#if reviews.length === 0}
						<TableRow>
							<TableCell colspan={7} class="text-center text-muted-foreground py-12">
								<div class="flex flex-col items-center gap-2">
									<p class="text-lg">No reviews found</p>
									<p class="text-sm">
										{#if activeStatus || activeDisposition || activeSubjectType}
											Try adjusting your filters
										{:else}
											Reviews will appear here when created via <code class="bg-muted px-1 py-0.5 rounded text-xs">kspec review add</code>
										{/if}
									</p>
								</div>
							</TableCell>
						</TableRow>
					{:else}
						{#each reviews as review}
							{@const isUpdated = updatedReviewIds.has(review._ulid)}
							<tr
								class="cursor-pointer hover:bg-muted/50 transition-colors duration-300 border-b {isUpdated ? 'bg-primary/10 animate-pulse' : ''}"
								data-testid="review-list-item"
								data-review-ref={review.slugs?.[0] || review._ulid}
								onclick={() => goto(`${base}/reviews/${review._ulid}`)}
								role="button"
								tabindex="0"
								onkeydown={(e) => e.key === 'Enter' && goto(`${base}/reviews/${review._ulid}`)}
							>
								<TableCell class="font-medium truncate">
									<div class="flex flex-col gap-0.5">
										<span data-testid="review-title" class="truncate">{review.title}</span>
										<span class="text-xs text-muted-foreground font-mono">@{review.slugs?.[0] || review._ulid.slice(0, 8)}</span>
									</div>
								</TableCell>
								<TableCell>
									<!-- AC: @ui-view-header ac-2 — lifecycle state drawn from the shared status-token source -->
									<StatusBadge
										domain="review-lifecycle"
										state={review.lifecycle_state}
										testid="review-lifecycle-badge"
									/>
								</TableCell>
								<TableCell>
									<!-- AC: @ui-view-header ac-2 / @review-records-web-ui ac-1 — disposition badge from the shared status-token source -->
									<StatusBadge
										domain="review-disposition"
										state={review.disposition}
										testid="review-disposition-badge"
									/>
								</TableCell>
								<TableCell>
									<span class="text-sm" data-testid="review-subject-type">{formatSubjectType(review.subject_type)}</span>
								</TableCell>
								<TableCell class="truncate">
									<span class="text-sm" data-testid="review-author">{review.author}</span>
								</TableCell>
								<TableCell class="truncate">
									{#if review.task_ref}
										<a
											href="{base}/tasks?ref={review.task_ref.startsWith('@') ? review.task_ref.slice(1) : review.task_ref}"
											class="text-sm text-primary hover:underline truncate"
											data-testid="review-task-link"
											onclick={(e) => e.stopPropagation()}
										>
											{review.task_title || review.task_ref}
										</a>
									{:else}
										<span class="text-muted-foreground text-sm">--</span>
									{/if}
								</TableCell>
								<TableCell>
									<span class="text-sm text-muted-foreground" data-testid="review-created-at" title={review.created_at}>
										{formatRelativeTime(review.created_at)}
									</span>
								</TableCell>
							</tr>
						{/each}
					{/if}
				</TableBody>
			</Table>
		</div>
	{/if}
</div>
