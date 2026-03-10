<script lang="ts">
	// AC: @web-dashboard ac-11, ac-12, ac-13, ac-14, ac-15
	// AC: @multi-directory-daemon ac-27 - Reload on project change
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import type { ItemSummary } from '@kynetic-ai/shared';
	import { fetchItems } from '$lib/api';
	import ItemTree from '$lib/components/ItemTree.svelte';
	import ItemDetail from '$lib/components/ItemDetail.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { getProjectVersion, isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';

	let items = $state<ItemSummary[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let selectedRef = $state<string | null>(null);
	let detailOpen = $state(false);

	// Plan filter from URL query param (set by "View Specs" on plans page)
	let planFilter = $derived($page.url.searchParams.get('plan') ?? undefined);

	async function loadItems() {
		loading = true;
		error = null;
		try {
			const response = await fetchItems(planFilter ? { plan: planFilter } : undefined);
			items = response.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load spec items';
			items = [];
		} finally {
			loading = false;
		}
	}

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

	// Load items when project is ready, on project change, and on plan filter change.
	// Gates on isProjectInitialized() to prevent loading with wrong/missing project context.
	// AC: @multi-directory-daemon ac-27 - Reload data when project changes
	$effect(() => {
		const _plan = planFilter;
		const version = getProjectVersion();
		const ready = isProjectInitialized();
		if (!ready) return;
		loadItems();
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
