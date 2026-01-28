<script lang="ts">
	import { page } from '$app/stores';
	import { base } from '$app/paths';

	// Navigation items matching Sidebar - paths are relative, prefixed with base in template
	const navItems = [
		{ path: '/', label: 'Dashboard', icon: '🏠' },
		{ path: '/tasks', label: 'Tasks', icon: '✓' },
		{ path: '/items', label: 'Items', icon: '📄' },
		{ path: '/inbox', label: 'Inbox', icon: '📥' }
	];
</script>

<!-- AC: @web-dashboard ac-26 -->
<nav
	class="fixed bottom-0 left-0 right-0 z-50 border-t bg-background md:hidden"
	aria-label="Mobile navigation"
>
	<div class="flex justify-around">
		{#each navItems as item}
			<a
				href="{base}{item.path}"
				class="flex flex-1 flex-col items-center justify-center gap-1 px-2 py-3 text-xs transition-colors hover:bg-accent"
				class:text-primary={$page.url.pathname === `${base}${item.path}` || $page.url.pathname === item.path}
				class:font-semibold={$page.url.pathname === `${base}${item.path}` || $page.url.pathname === item.path}
			>
				<span class="text-lg">{item.icon}</span>
				<span>{item.label}</span>
			</a>
		{/each}
	</div>
</nav>
