<script lang="ts">
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';
	import { SidebarProvider, SidebarInset } from '$lib/components/ui/sidebar';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MobileNav from '$lib/components/MobileNav.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import ReadOnlyBanner from '$lib/components/ReadOnlyBanner.svelte';
	import { initConnection } from '$lib/stores/connection.svelte';
	import { loadProjects, getSelectedProjectPath, isInitialized } from '$lib/stores/project.svelte';
	import { initMode, isStaticMode, isLoading as isModeLoading } from '$lib/stores/mode.svelte';
	import { browser } from '$app/environment';

	let { children } = $props();

	// Track if app is ready (mode detected and projects loaded if in daemon mode)
	let appReady = $state(false);

	// AC: @web-dashboard ac-28 - Initialize WebSocket connection
	// AC: @multi-directory-daemon ac-25 - Load projects list on mount
	// AC: @gh-pages-export ac-11 - Mode detection before initialization
	onMount(async () => {
		// First: detect mode (daemon or static)
		await initMode();

		// In static mode, skip project loading and WebSocket
		// AC: @gh-pages-export ac-11 - Static mode uses embedded JSON
		if (isStaticMode()) {
			appReady = true;
			return;
		}

		// In daemon mode: load projects and connect WebSocket
		await loadProjects();
		appReady = true;

		// Initialize WebSocket with selected project
		const projectPath = getSelectedProjectPath();
		initConnection({ projectPath: projectPath ?? undefined });
	});

	// For SSR, treat as ready since we can't have a selected project anyway
	let ready = $derived(browser ? appReady : true);
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
		<!-- AC: @gh-pages-export ac-15 - Show read-only banner in static mode -->
		<ReadOnlyBanner />

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
