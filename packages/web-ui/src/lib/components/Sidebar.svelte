<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		Sidebar,
		SidebarContent,
		SidebarFooter,
		SidebarGroup,
		SidebarGroupContent,
		SidebarGroupLabel,
		SidebarHeader,
		SidebarMenu,
		SidebarMenuButton,
		SidebarMenuItem
	} from '$lib/components/ui/sidebar';
	import { Badge } from '$lib/components/ui/badge';
	import { fetchSessionContext, fetchObservations } from '$lib/api';
	import type { SessionContext } from '@kynetic-ai/shared';
	import ConnectionStatus from '$lib/components/ConnectionStatus.svelte';
	import ProjectSelector from '$lib/components/ProjectSelector.svelte';
	import { hasMultipleProjects, getProjectVersion } from '$lib/stores/project.svelte';

	// Navigation items
	const navItems = [
		{ href: '/', label: 'Dashboard' },
		{ href: '/tasks', label: 'Tasks' },
		{ href: '/items', label: 'Items' },
		{ href: '/inbox', label: 'Inbox' }
	];

	// AC: @web-dashboard ac-20, ac-21
	let sessionContext = $state<SessionContext | null>(null);
	let unresolvedObservationsCount = $state(0);

	// AC: @multi-directory-daemon ac-25 - Track if multiple projects exist
	let showProjectSelector = $derived(hasMultipleProjects());

	onMount(async () => {
		await loadSessionData();
		// Refresh every 30s (will be replaced with WebSocket updates later)
		const interval = setInterval(loadSessionData, 30000);
		return () => clearInterval(interval);
	});

	// AC: @multi-directory-daemon ac-27 - Reload session data when project changes
	$effect(() => {
		const version = getProjectVersion();
		if (version > 0) {
			// Only reload if version has been incremented (not on initial load)
			loadSessionData();
		}
	});

	async function loadSessionData() {
		try {
			// Load session context
			sessionContext = await fetchSessionContext();

			// Load unresolved observations count
			const obsResponse = await fetchObservations({ resolved: false });
			unresolvedObservationsCount = obsResponse.total;
		} catch (err) {
			console.error('Failed to load session data:', err);
		}
	}

	// Open observations panel
	function openObservations() {
		// Navigate to observations view (will implement panel in next step)
		goto('/observations');
	}
</script>

<Sidebar>
	<SidebarHeader>
		<div class="flex items-center gap-2 px-4 py-2">
			<span class="text-lg font-bold">kspec</span>
		</div>
	</SidebarHeader>

	<SidebarContent>
		<!-- AC: @multi-directory-daemon ac-25 - Project selector when multiple projects -->
		{#if showProjectSelector}
			<SidebarGroup>
				<SidebarGroupLabel>Project</SidebarGroupLabel>
				<SidebarGroupContent>
					<div class="px-2">
						<ProjectSelector />
					</div>
				</SidebarGroupContent>
			</SidebarGroup>
		{/if}

		<!-- AC: @web-dashboard ac-20 - Display session focus -->
		{#if sessionContext?.focus}
			<SidebarGroup>
				<SidebarGroupLabel>Current Focus</SidebarGroupLabel>
				<SidebarGroupContent>
					<div class="px-4 py-2 text-sm italic text-muted-foreground" data-testid="session-focus">
						{sessionContext.focus}
					</div>
				</SidebarGroupContent>
			</SidebarGroup>
		{/if}

		<SidebarGroup>
			<SidebarGroupLabel>Navigation</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu data-testid="sidebar-nav">
					{#each navItems as item}
						<SidebarMenuItem>
							<SidebarMenuButton
								href={item.href}
								isActive={$page.url.pathname === item.href}
								data-testid="nav-link-{item.label.toLowerCase()}"
							>
								<span>{item.label}</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					{/each}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>

		<!-- AC: @web-dashboard ac-21 - Observations count badge -->
		{#if unresolvedObservationsCount > 0}
			<SidebarGroup>
				<SidebarGroupContent>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton onclick={openObservations} data-testid="observations-badge">
								<span>Observations</span>
								<Badge variant="secondary" class="ml-auto" data-testid="observations-count">
									{unresolvedObservationsCount}
								</Badge>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>
		{/if}
	</SidebarContent>

	<SidebarFooter>
		<div class="flex items-center gap-2 px-4 py-2">
			<!-- AC: @web-dashboard ac-29 -->
			<ConnectionStatus />
		</div>
	</SidebarFooter>
</Sidebar>
