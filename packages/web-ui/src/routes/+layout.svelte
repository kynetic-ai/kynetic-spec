<script lang="ts">
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';
	import { SidebarProvider, SidebarInset } from '$lib/components/ui/sidebar';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MobileNav from '$lib/components/MobileNav.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import { initConnection } from '$lib/stores/connection.svelte';
	import { loadProjects, getSelectedProjectPath, isInitialized } from '$lib/stores/project.svelte';
	import { browser } from '$app/environment';

	let { children } = $props();

	// Track if projects are loaded
	let projectsReady = $state(false);

	// AC: @web-dashboard ac-28 - Initialize WebSocket connection
	// AC: @multi-directory-daemon ac-25 - Load projects list on mount
	onMount(async () => {
		// Load projects first so we know which project to connect to
		await loadProjects();
		projectsReady = true;

		// Initialize WebSocket with selected project
		const projectPath = getSelectedProjectPath();
		initConnection({ projectPath: projectPath ?? undefined });
	});

	// For SSR, treat as ready since we can't have a selected project anyway
	let ready = $derived(browser ? projectsReady : true);
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
			{#if ready}
				{@render children()}
			{:else}
				<!-- AC: @multi-directory-daemon ac-25 - Wait for projects to load -->
				<div class="flex items-center justify-center h-32">
					<span class="text-muted-foreground">Loading...</span>
				</div>
			{/if}
		</main>
	</SidebarInset>

	<!-- Mobile bottom navigation (hidden on desktop) -->
	<MobileNav />
</SidebarProvider>
