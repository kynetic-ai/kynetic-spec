<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import * as Command from '$lib/components/ui/command';
	import { search } from '$lib/api';
	import { shortcutRegistry } from '$lib/shortcuts';
	import type { SearchResult } from '@kynetic-ai/shared';

	// AC: @web-dashboard ac-23
	let open = $state(false);
	let query = $state('');
	let selectedValue = $state('');
	let results = $state<SearchResult[]>([]);
	let loading = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Track the Command component's internal search text via onStateChange.
	// bits-ui Command's `value` prop represents the selected item, not the search text.
	// The search text lives in the internal `search` state field.
	function handleStateChange(state: { search: string; value: string }) {
		if (state.search !== query) {
			query = state.search;
		}
	}

	// AC: @web-dashboard ac-23 - Open command palette on Cmd+K / Ctrl+K
	// Registered through the central shortcut registry; the root layout owns the
	// single document-level dispatcher.
	// AC: @ui-shortcut-registry ac-1, ac-3
	onMount(() => {
		const registration = shortcutRegistry.register({
			id: 'command-palette.toggle',
			label: 'Open command palette',
			chord: { mod: true, key: 'k' },
			handler: () => {
				open = !open;
			}
		});
		return registration.unregister;
	});

	// AC: @web-dashboard ac-24 - Debounced search (300ms)
	$effect(() => {
		if (query.trim() === '') {
			results = [];
			loading = false;
			return;
		}

		loading = true;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}

		debounceTimer = setTimeout(async () => {
			try {
				const response = await search(query);
				results = response.results;
			} catch (error) {
				console.error('Search failed:', error);
				results = [];
			} finally {
				loading = false;
			}
		}, 300);

		return () => {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
		};
	});

	// AC: @web-dashboard ac-24 - Group results by type
	const groupedResults = $derived(
		results.reduce(
			(acc, result) => {
				if (!acc[result.type]) {
					acc[result.type] = [];
				}
				acc[result.type].push(result);
				return acc;
			},
			{} as Record<string, SearchResult[]>
		)
	);

	// AC: @web-dashboard ac-25 - Navigate to detail view on click
	function handleSelect(result: SearchResult) {
		open = false;
		query = '';
		selectedValue = '';
		results = [];

		// Map type to route
		const routes: Record<string, (ulid: string) => string> = {
			task: (ulid) => `${base}/tasks?selected=${ulid}`,
			item: (ulid) => `${base}/items?selected=${ulid}`,
			inbox: (ulid) => `${base}/inbox?selected=${ulid}`,
			observation: (ulid) => `${base}/observations?selected=${ulid}`,
			agent: (ulid) => `${base}/meta?selected=${ulid}`,
			workflow: (ulid) => `${base}/meta?selected=${ulid}`,
			convention: (ulid) => `${base}/meta?selected=${ulid}`
		};

		const route = routes[result.type]?.(result.ulid);
		if (route) {
			goto(route);
		}
	}

	// Type labels for display
	const typeLabels: Record<string, string> = {
		task: 'Tasks',
		item: 'Spec Items',
		inbox: 'Inbox',
		observation: 'Observations',
		agent: 'Agents',
		workflow: 'Workflows',
		convention: 'Conventions'
	};
</script>

<!-- AC: @web-dashboard ac-23 -->
<Command.Dialog data-testid="command-palette" bind:open bind:value={selectedValue} shouldFilter={false} onStateChange={handleStateChange} title="Search" description="Search across all entities">
	{@render children()}
</Command.Dialog>

{#snippet children()}
	<!-- AC: @web-dashboard ac-23, ac-24 -->
	<Command.Input data-testid="command-palette-input" placeholder="Search tasks, items, inbox..." />
	<Command.List data-testid="command-palette-results">
		{#if loading}
			<Command.Loading>Searching...</Command.Loading>
		{:else if query.trim() && results.length === 0}
			<Command.Empty>No results found.</Command.Empty>
		{:else}
			<!-- AC: @web-dashboard ac-24 - Group results by type -->
			{#each Object.entries(groupedResults) as [type, items]}
				<Command.Group data-testid="search-group-{type}" heading={typeLabels[type] || type}>
					{#each items as result}
						<!-- AC: @web-dashboard ac-25 - Navigate on click -->
						<Command.Item data-testid="search-result-item" onSelect={() => handleSelect(result)}>
							<div class="flex flex-col">
								<span class="font-medium">{result.title}</span>
								{#if result.matchedFields.length > 0}
									<span class="text-xs text-muted-foreground">
										Matched: {result.matchedFields.join(', ')}
									</span>
								{/if}
							</div>
						</Command.Item>
					{/each}
				</Command.Group>
			{/each}
		{/if}
	</Command.List>
{/snippet}
