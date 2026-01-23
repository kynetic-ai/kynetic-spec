<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import * as Command from '$lib/components/ui/command';
	import { search } from '$lib/api';
	import type { SearchResult } from '@kynetic-ai/shared';

	// AC: @web-dashboard ac-23
	let open = $state(false);
	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let loading = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// AC: @web-dashboard ac-23 - Open command palette on Cmd+K / Ctrl+K
	onMount(() => {
		function handleKeydown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
				e.preventDefault();
				open = !open;
			}
		}

		document.addEventListener('keydown', handleKeydown);
		return () => {
			document.removeEventListener('keydown', handleKeydown);
		};
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
		results = [];

		// Map type to route
		const routes: Record<string, (ulid: string) => string> = {
			task: (ulid) => `/tasks?selected=${ulid}`,
			item: (ulid) => `/items?selected=${ulid}`,
			inbox: (ulid) => `/inbox?selected=${ulid}`,
			observation: (ulid) => `/observations?selected=${ulid}`,
			agent: (ulid) => `/meta?selected=${ulid}`,
			workflow: (ulid) => `/meta?selected=${ulid}`,
			convention: (ulid) => `/meta?selected=${ulid}`
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
<Command.Dialog bind:open bind:value={query} title="Search" description="Search across all entities">
	{@render children()}
</Command.Dialog>

{#snippet children()}
	<!-- AC: @web-dashboard ac-23, ac-24 -->
	<Command.Input placeholder="Search tasks, items, inbox..." />
	<Command.List>
		{#if loading}
			<Command.Loading>Searching...</Command.Loading>
		{:else if query.trim() && results.length === 0}
			<Command.Empty>No results found.</Command.Empty>
		{:else}
			<!-- AC: @web-dashboard ac-24 - Group results by type -->
			{#each Object.entries(groupedResults) as [type, items]}
				<Command.Group heading={typeLabels[type] || type}>
					{#each items as result}
						<!-- AC: @web-dashboard ac-25 - Navigate on click -->
						<Command.Item onSelect={() => handleSelect(result)}>
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
