<script lang="ts">
	// AC: @web-dashboard ac-11, ac-12, ac-13, ac-14, ac-15
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import type { ItemSummary } from '@kynetic-ai/shared';
	import { fetchItems } from '$lib/api';
	import ItemTree from '$lib/components/ItemTree.svelte';
	import ItemDetail from '$lib/components/ItemDetail.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';

	let items: ItemSummary[] = [];
	let loading = true;
	let error: string | null = null;
	let selectedRef: string | null = null;
	let detailOpen = false;

	async function loadItems() {
		loading = true;
		error = null;
		try {
			const response = await fetchItems();
			items = response.items;

			// Check if there's a ref in URL query params
			const urlRef = $page.url.searchParams.get('ref');
			if (urlRef) {
				selectedRef = urlRef;
				detailOpen = true;
			}
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

		// Update URL
		const url = new URL(window.location.href);
		url.searchParams.set('ref', event.detail);
		window.history.pushState({}, '', url);
	}

	function handleDetailClose() {
		detailOpen = false;

		// Clear URL param
		const url = new URL(window.location.href);
		url.searchParams.delete('ref');
		window.history.pushState({}, '', url);
	}

	onMount(() => {
		loadItems();
	});
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between">
		<h1 class="text-3xl font-bold">Spec Items</h1>
		<p class="text-sm text-muted-foreground">{items.length} items total</p>
	</div>

	{#if loading}
		<div class="space-y-4">
			<Skeleton class="h-12 w-full" />
			<Skeleton class="h-12 w-full" />
			<Skeleton class="h-12 w-full" />
			<Skeleton class="h-12 w-full" />
		</div>
	{:else if error}
		<div class="rounded-md border border-destructive bg-destructive/10 p-4">
			<p class="text-destructive font-medium">Error loading spec items</p>
			<p class="text-sm text-destructive/80">{error}</p>
		</div>
	{:else}
		<ItemTree {items} on:select={handleSelect} />
	{/if}
</div>

<ItemDetail ref={selectedRef} bind:open={detailOpen} on:close={handleDetailClose} />
