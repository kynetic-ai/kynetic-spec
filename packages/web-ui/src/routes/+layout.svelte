<script lang="ts">
	import { onMount } from 'svelte';

	import { base } from '$app/paths';
	import '../app.css';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SidebarProvider, SidebarInset } from '$lib/components/ui/sidebar';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MobileNav from '$lib/components/MobileNav.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import ReadOnlyBanner from '$lib/components/ReadOnlyBanner.svelte';
	import { initConnection } from '$lib/stores/connection.svelte';
	import { loadProjects, getSelectedProjectPath, isInitialized, initializeForStaticMode } from '$lib/stores/project.svelte';
	import { initMode, isStaticMode, isLoading as isModeLoading } from '$lib/stores/mode.svelte';
	import { createQueryClientInstance, setQueryClient } from '$lib/query';
	import { setupWsInvalidation } from '$lib/query/ws-invalidation.js';
	import { shortcutRegistry } from '$lib/shortcuts';

	let { children } = $props();

	// AC: @ui-data-freshness ac-1 — QueryClient provides caching and deduplication
	// AC: @ui-data-freshness ac-2 — Request deduplication built into QueryClient
	const queryClient = createQueryClientInstance();
	setQueryClient(queryClient);

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
		// AC: @gh-pages-export ac-25 - Initialize project store so page gates pass
		if (isStaticMode()) {
			initializeForStaticMode();
			appReady = true;
			return;
		}

		// In daemon mode: load projects and connect WebSocket
		await loadProjects();
		appReady = true;

		// Initialize WebSocket with selected project
		const projectPath = getSelectedProjectPath();
		initConnection({ projectPath: projectPath ?? undefined });

		// AC: @ui-data-freshness ac-3 — Wire WebSocket events to query invalidation
		setupWsInvalidation(queryClient);
	});

	// SSR is disabled globally via +layout.ts — ready tracks appReady directly
	let ready = $derived(appReady);
</script>

<!-- Single document-level keyboard shortcut dispatcher (AC: @ui-shortcut-registry ac-1, ac-6) -->
<svelte:window onkeydown={(e) => shortcutRegistry.handleKeydown(e)} />

<svelte:head>
	<link rel="icon" type="image/x-icon" href="{base}/favicon.ico" />
	<link rel="icon" type="image/png" sizes="32x32" href="{base}/favicon-32.png" />
	<link rel="icon" type="image/png" sizes="192x192" href="{base}/favicon-192.png" />
</svelte:head>

<!-- AC: @web-dashboard ac-23 - Global command palette -->
<CommandPalette />

<!-- AC: @ui-data-freshness ac-1, ac-2 — QueryClientProvider enables caching and deduplication -->
<QueryClientProvider client={queryClient}>
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

			<main class="flex-1 overflow-auto p-4 pb-20 md:pb-4 min-w-0">
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
</QueryClientProvider>
