<script lang="ts">
	import { page } from '$app/stores';
	import { base } from '$app/paths';
	import {
		LayoutDashboard,
		ListTodo,
		FileText,
		Inbox,
		MoreHorizontal
	} from 'lucide-svelte';

	// Primary mobile nav items — most-used routes
	const primaryItems = [
		{ path: '/', label: 'Home', icon: LayoutDashboard },
		{ path: '/tasks', label: 'Tasks', icon: ListTodo },
		{ path: '/specs', label: 'Specs', icon: FileText },
		{ path: '/inbox', label: 'Inbox', icon: Inbox }
	];

	function isActive(itemPath: string): boolean {
		const currentPath = $page.url.pathname;
		const fullPath = `${base}${itemPath}`;
		if (itemPath === '/') {
			return currentPath === fullPath || currentPath === '/';
		}
		return currentPath === fullPath || currentPath.startsWith(`${fullPath}/`);
	}
</script>

<nav
	class="fixed bottom-0 left-0 right-0 z-50 border-t bg-background md:hidden"
	aria-label="Mobile navigation"
>
	<div class="flex justify-around">
		{#each primaryItems as item}
			<a
				href="{base}{item.path}"
				class="flex flex-1 flex-col items-center justify-center gap-1 px-2 py-3 text-xs transition-colors hover:bg-accent"
				class:text-primary={isActive(item.path)}
				class:font-semibold={isActive(item.path)}
			>
				<item.icon class="h-5 w-5" />
				<span>{item.label}</span>
			</a>
		{/each}
	</div>
</nav>
