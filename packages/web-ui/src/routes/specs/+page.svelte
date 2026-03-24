<!--
  AC: @web-dashboard ac-11, ac-12, ac-13, ac-14, ac-15
  AC: @multi-directory-daemon ac-27 - Reload on project change
  AC: @ui-data-freshness ac-1 — Renders from cache on revisit without loading state
  AC: @ui-data-freshness ac-3 — WebSocket events invalidate item queries via centralized wiring
-->
<script lang="ts">
	// AC: @web-dashboard ac-11, ac-12, ac-13, ac-14, ac-15
	// AC: @multi-directory-daemon ac-27 - Reload on project change
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { createQuery } from '@tanstack/svelte-query';
	import { fetchItems } from '$lib/api';
	import ItemTree from '$lib/components/ItemTree.svelte';
	import ItemDetail from '$lib/components/ItemDetail.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';

	let selectedRef = $state<string | null>(null);
	let detailOpen = $state(false);

	// Plan filter from URL query param (set by "View Specs" on plans page)
	let planFilter = $derived($page.url.searchParams.get('plan') ?? undefined);

	// AC: @ui-data-freshness ac-1 — createQuery caches; revisits render from cache
	// AC: @ui-data-freshness ac-2 — Concurrent uses share the same in-flight request
	// AC: @multi-directory-daemon ac-27 — Re-fetches when project changes
	const itemsQuery = createQuery(() => ({
		queryKey: queryKeys.items.list(planFilter ? { plan: planFilter } : {}),
		queryFn: () => fetchItems(planFilter ? { plan: planFilter } : undefined),
		enabled: isProjectInitialized(),
	}));

	let items = $derived(itemsQuery.data?.items ?? []);
	let loading = $derived(itemsQuery.isLoading);
	let error = $derived(itemsQuery.error?.message ?? null);

	function handleSelect(event: CustomEvent<string>) {
		selectedRef = event.detail;
		detailOpen = true;

		// AC: @ui-url-panel-state ac-1 — Use goto() so $page.url updates reactively
		const url = new URL($page.url);
		url.searchParams.set('ref', event.detail);
		goto(url, { replaceState: true, keepFocus: true, noScroll: true });
	}


	// AC: @ui-url-panel-state ac-2 — Clear URL param when detail panel closes
	$effect(() => {
		if (!detailOpen && selectedRef) {
			selectedRef = null;
			const url = new URL($page.url);
			url.searchParams.delete('ref');
			goto(url, { replaceState: true, keepFocus: true, noScroll: true });
		}
	});

	// React to URL ref param changes (handles both initial load and navigation)
	$effect(() => {
		const urlRef = $page.url.searchParams.get('ref');
		if (urlRef && urlRef !== selectedRef) {
			selectedRef = urlRef;
			detailOpen = true;
		}
	});
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between">
		<h1 class="text-3xl font-bold">Spec Items</h1>
		<p class="text-sm text-muted-foreground">{items.length} items total</p>
	</div>

	{#if planFilter}
		<div class="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-md px-3 py-2" data-testid="plan-filter-banner">
			Filtered by plan: <code class="bg-muted px-1 py-0.5 rounded text-xs">@{planFilter}</code>
			<a href="{base}/specs" class="ml-auto text-primary hover:underline text-xs">Clear filter</a>
		</div>
	{/if}

	{#if loading}
		<div class="space-y-4">
			<Skeleton class="h-12 w-full" />
			<Skeleton class="h-12 w-full" />
			<Skeleton class="h-12 w-full" />
			<Skeleton class="h-12 w-full" />
		</div>
	{:else if error}
		<div
			class="rounded-md border border-destructive bg-destructive/10 p-4"
			data-testid="error-message"
			role="alert"
		>
			<p class="text-destructive font-medium">Error loading spec items</p>
			<p class="text-sm text-destructive/80">{error}</p>
		</div>
	{:else}
		<ItemTree {items} on:select={handleSelect} />
	{/if}
</div>

<ItemDetail ref={selectedRef} bind:open={detailOpen} />
