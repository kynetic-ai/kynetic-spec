<script lang="ts">
	import { page } from '$app/stores';

	// Navigation items matching Sidebar
	const navItems = [
		{ href: '/', label: 'Dashboard', icon: '🏠' },
		{ href: '/tasks', label: 'Tasks', icon: '✓' },
		{ href: '/items', label: 'Items', icon: '📄' },
		{ href: '/inbox', label: 'Inbox', icon: '📥' }
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
				href={item.href}
				class="flex flex-1 flex-col items-center justify-center gap-1 px-2 py-3 text-xs transition-colors hover:bg-accent"
				class:text-primary={$page.url.pathname === item.href}
				class:font-semibold={$page.url.pathname === item.href}
			>
				<span class="text-lg">{item.icon}</span>
				<span>{item.label}</span>
			</a>
		{/each}
	</div>
</nav>
