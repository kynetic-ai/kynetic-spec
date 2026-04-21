<!--
	AC: @docs-reachability ac-2 — Content bundled at build time, renders without network requests
	AC: @docs-reachability ac-3 — No daemon or SSR required
	AC: @docs-section-taxonomy ac-1 — Five top-level sections in canonical order
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { getDocsEntries, groupDocsSections } from '$lib/docs';
	import DocsSearch from '$lib/components/DocsSearch.svelte';

	const entries = getDocsEntries();
	const sections = groupDocsSections(entries);
</script>

<div class="max-w-3xl mx-auto">
	<h1 class="text-2xl font-bold mb-4">Documentation</h1>
	<p class="text-muted-foreground mb-6">
		Browse the kspec documentation. All content is available offline — no network requests required.
	</p>

	<!-- AC: @docs-search ac-1 — Search input on docs landing page -->
	<div class="mb-6 max-w-md">
		<DocsSearch />
	</div>

	{#each sections as section}
		<div class="mb-6">
			<h2 class="text-lg font-semibold mb-2">{section.label}</h2>
			<ul class="space-y-1">
				{#each section.entries as entry}
					<li>
						<a
							href="{base}/docs/{entry.slug}"
							class="text-primary hover:underline"
						>
							{entry.title}
						</a>
					</li>
				{/each}
			</ul>
		</div>
	{/each}
</div>
