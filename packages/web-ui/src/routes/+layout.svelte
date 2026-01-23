<script lang="ts">
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';
	import { SidebarProvider, SidebarInset } from '$lib/components/ui/sidebar';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MobileNav from '$lib/components/MobileNav.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import { initConnection } from '$lib/stores/connection.svelte';

	let { children } = $props();

	// AC: @web-dashboard ac-28 - Initialize WebSocket connection
	onMount(() => {
		initConnection();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<!-- AC: @web-dashboard ac-23 - Global command palette -->
<CommandPalette />

<!-- AC: @web-dashboard ac-26, ac-27 -->
<SidebarProvider>
	<!-- Desktop sidebar (hidden on mobile) -->
	<div class="hidden md:block">
		<Sidebar />
	</div>

	<!-- Main content area with responsive inset -->
	<SidebarInset>
		<main class="flex-1 overflow-auto p-4 pb-20 md:pb-4">
			{@render children()}
		</main>
	</SidebarInset>

	<!-- Mobile bottom navigation (hidden on desktop) -->
	<MobileNav />
</SidebarProvider>
