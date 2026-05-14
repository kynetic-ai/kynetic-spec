<!--
	AC: @docs-search ac-1 — Search input returns matching docs pages with links
	AC: @docs-search ac-2 — Runs entirely in the browser, no non-local network requests
	AC: @docs-search ac-3 — Same index used on public and local deployments
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Search, X, Loader2 } from 'lucide-svelte';

	interface SearchResultData {
		url: string;
		excerpt: string;
		meta?: { title?: string };
	}

	interface PagefindResult {
		id: string;
		data: () => Promise<SearchResultData>;
	}

	interface Pagefind {
		options: (opts: Record<string, unknown>) => Promise<void>;
		init: () => Promise<void>;
		search: (query: string) => Promise<{ results: PagefindResult[] }>;
		debouncedSearch: (query: string, opts?: { debounceTimeoutMs?: number }) => Promise<{ results: PagefindResult[] } | null>;
		destroy: () => Promise<void>;
	}

	let query = $state('');
	let results = $state<SearchResultData[]>([]);
	let loading = $state(false);
	let pagefind = $state<Pagefind | null>(null);
	let initError = $state(false);
	let inputEl: HTMLInputElement | undefined = $state();
	let open = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	async function initPagefind(): Promise<Pagefind | null> {
		if (pagefind) return pagefind;
		try {
			// Pagefind JS is served from the static build output alongside the index.
			// The bundlePath tells the client where to find the WASM and index chunks.
			const pf = await import(/* @vite-ignore */ `${base}/pagefind/pagefind.js`) as Pagefind;
			await pf.options({ bundlePath: `${base}/pagefind/` });
			await pf.init();
			pagefind = pf;
			return pf;
		} catch {
			initError = true;
			return null;
		}
	}

	function handleFocus() {
		open = true;
		// Lazy-load Pagefind on first focus
		if (!pagefind && !initError) {
			initPagefind();
		}
	}

	function handleBlur() {
		// Delay closing to allow click on results
		setTimeout(() => {
			open = false;
		}, 200);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			query = '';
			results = [];
			open = false;
			inputEl?.blur();
		}
	}

	function navigateTo(url: string) {
		// URLs from Pagefind already include the base path
		goto(url);
		query = '';
		results = [];
		open = false;
	}

	$effect(() => {
		const q = query.trim();
		if (q === '') {
			results = [];
			loading = false;
			return;
		}

		if (!pagefind) {
			// Still loading — will re-run when pagefind is set
			return;
		}

		loading = true;
		if (debounceTimer) clearTimeout(debounceTimer);

		const pf = pagefind;
		debounceTimer = setTimeout(async () => {
			try {
				const searchResult = await pf.search(q);
				// Load the first 10 results' data
				const loaded = await Promise.all(
					searchResult.results.slice(0, 10).map((r) => r.data())
				);
				results = loaded;
			} catch {
				results = [];
			} finally {
				loading = false;
			}
		}, 200);
	});
</script>

<div class="relative">
	<div class="relative">
		<Search class="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
		<input
			bind:this={inputEl}
			bind:value={query}
			onfocus={handleFocus}
			onblur={handleBlur}
			onkeydown={handleKeydown}
			type="text"
			placeholder="Search docs..."
			class="w-full pl-8 pr-8 py-1.5 text-sm rounded-md border border-input bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
			data-testid="docs-search-input"
		/>
		{#if query}
			<button
				type="button"
				class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
				onmousedown={(e) => {
					e.preventDefault();
					query = '';
					results = [];
				}}
			>
				<X class="h-3.5 w-3.5" />
			</button>
		{/if}
	</div>

	{#if open && (query.trim() !== '' || initError)}
		<div
			class="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-md z-50 max-h-80 overflow-y-auto"
			data-testid="docs-search-results"
		>
			{#if initError}
				<div class="px-3 py-2 text-sm text-muted-foreground">
					Search is not available. Build the search index first.
				</div>
			{:else if loading}
				<div class="px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 class="h-3.5 w-3.5 animate-spin" />
					Searching...
				</div>
			{:else if results.length === 0 && query.trim() !== ''}
				<div class="px-3 py-2 text-sm text-muted-foreground">
					No results for "{query}"
				</div>
			{:else}
				<ul class="py-1">
					{#each results as result}
						<li>
							<button
								type="button"
								class="w-full text-left px-3 py-2 hover:bg-accent transition-colors cursor-pointer"
								onmousedown={(e) => {
									e.preventDefault();
									navigateTo(result.url);
								}}
							>
								<div class="text-sm font-medium">{result.meta?.title ?? 'Untitled'}</div>
								{#if result.excerpt}
									<div class="text-xs text-muted-foreground mt-0.5 line-clamp-2">
										{@html result.excerpt}
									</div>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
