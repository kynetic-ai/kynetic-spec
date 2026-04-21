<!--
	AC: @docs-reachability ac-2 — Content bundled at build time, renders without network requests
	AC: @docs-reachability ac-3 — No daemon or SSR required, client-side rendering only
	AC: @docs-navigation-shape ac-2 — Anchored headings with stable direct links
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { getDocsEntry, getDocsEntries, type DocsEntry } from '$lib/docs';
	import { renderDocsMarkdown, type TocEntry } from '$lib/utils/docs-markdown';

	let entry = $derived.by(() => {
		const slug = $page.params.slug;
		return slug ? getDocsEntry(slug) : undefined;
	});

	let rendered = $derived.by(() => {
		if (!entry) return { html: '', toc: [] as TocEntry[] };
		return renderDocsMarkdown(entry.content);
	});

	// Sidebar entries for navigation within docs
	const allEntries = getDocsEntries();

	function handleDocLinkClick(event: MouseEvent) {
		const target = event.target as HTMLElement;
		const anchor = target.closest('a');
		if (!anchor) return;

		const href = anchor.getAttribute('href');
		if (!href) return;

		// Handle anchor links (scroll to heading)
		if (href.startsWith('#')) {
			event.preventDefault();
			const el = document.getElementById(href.slice(1));
			if (el) el.scrollIntoView({ behavior: 'smooth' });
			return;
		}

		// Handle relative doc links (client-side navigation)
		if (!href.startsWith('http') && !href.startsWith('//') && href.endsWith('.md')) {
			event.preventDefault();
			const docSlug = href.replace(/\.md$/, '').replace(/^\.?\/?/, '');
			goto(`${base}/docs/${docSlug}`);
		}
	}
</script>

<div class="flex gap-8 max-w-6xl mx-auto">
	<!-- Docs sidebar navigation -->
	<nav class="hidden lg:block w-56 shrink-0 sticky top-4 self-start max-h-[calc(100vh-6rem)] overflow-y-auto">
		<h3 class="text-sm font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Pages</h3>
		<ul class="space-y-1">
			{#each allEntries as navEntry}
				<li>
					<a
						href="{base}/docs/{navEntry.slug}"
						class="block text-sm py-1 px-2 rounded transition-colors {navEntry.slug === $page.params.slug
							? 'bg-accent text-accent-foreground font-medium'
							: 'text-muted-foreground hover:text-foreground hover:bg-accent/50'}"
					>
						{navEntry.title}
					</a>
				</li>
			{/each}
		</ul>

		<!-- Table of contents for current page -->
		{#if rendered.toc.length > 0}
			<h3 class="text-sm font-semibold text-muted-foreground mt-6 mb-2 uppercase tracking-wider">On this page</h3>
			<ul class="space-y-0.5">
				{#each rendered.toc as tocItem}
					<li style="padding-left: {(tocItem.level - 1) * 0.75}rem">
						<a
							href="#{tocItem.id}"
							class="block text-xs py-0.5 text-muted-foreground hover:text-foreground transition-colors"
						>
							{tocItem.text}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</nav>

	<!-- Main content -->
	<div class="flex-1 min-w-0">
		{#if entry}
			<article
				class="prose prose-sm dark:prose-invert max-w-none"
				role="button"
				tabindex="-1"
				onclick={handleDocLinkClick}
				onkeydown={() => {}}
			>
				{@html rendered.html}
			</article>
		{:else}
			<div class="text-center py-12">
				<h1 class="text-xl font-semibold mb-2">Page not found</h1>
				<p class="text-muted-foreground mb-4">
					The docs page "{$page.params.slug}" does not exist.
				</p>
				<a href="{base}/docs" class="text-primary hover:underline">
					Back to docs
				</a>
			</div>
		{/if}
	</div>
</div>
