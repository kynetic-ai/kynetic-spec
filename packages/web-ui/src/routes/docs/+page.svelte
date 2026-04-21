<!--
	AC: @docs-reachability ac-2 — Content bundled at build time, renders without network requests
	AC: @docs-reachability ac-3 — No daemon or SSR required
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { getDocsEntries } from '$lib/docs';

	const entries = getDocsEntries();

	// Group entries by top-level directory (or root)
	type Group = { label: string; entries: { slug: string; title: string }[] };

	function buildGroups(): Group[] {
		const rootEntries: Group['entries'] = [];
		const dirGroups = new Map<string, Group['entries']>();

		for (const entry of entries) {
			const slashIdx = entry.slug.indexOf('/');
			if (slashIdx === -1) {
				rootEntries.push({ slug: entry.slug, title: entry.title });
			} else {
				const dir = entry.slug.slice(0, slashIdx);
				if (!dirGroups.has(dir)) dirGroups.set(dir, []);
				dirGroups.get(dir)!.push({ slug: entry.slug, title: entry.title });
			}
		}

		const groups: Group[] = [];
		if (rootEntries.length > 0) {
			groups.push({ label: 'Docs', entries: rootEntries });
		}
		for (const [dir, dirEntries] of dirGroups) {
			const label = dir.charAt(0).toUpperCase() + dir.slice(1).replace(/[-_]/g, ' ');
			groups.push({ label, entries: dirEntries });
		}
		return groups;
	}

	const groups = buildGroups();
</script>

<div class="max-w-3xl mx-auto">
	<h1 class="text-2xl font-bold mb-4">Documentation</h1>
	<p class="text-muted-foreground mb-6">
		Browse the kspec documentation. All content is available offline — no network requests required.
	</p>

	{#each groups as group}
		<div class="mb-6">
			<h2 class="text-lg font-semibold mb-2">{group.label}</h2>
			<ul class="space-y-1">
				{#each group.entries as entry}
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
