<script lang="ts">
	import { page } from '$app/stores';
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

	// Navigation items
	const navItems = [
		{ href: '/', label: 'Dashboard' },
		{ href: '/tasks', label: 'Tasks' },
		{ href: '/items', label: 'Items' },
		{ href: '/inbox', label: 'Inbox' }
	];

	// Connection status (will be wired to WebSocket later)
	let connected = $state(false);

	// AC: @web-dashboard ac-20, ac-21
	let sessionContext = $state<SessionContext | null>(null);
	let unresolvedObservationsCount = $state(0);

	onMount(async () => {
		await loadSessionData();
		// Refresh every 30s (will be replaced with WebSocket updates later)
		const interval = setInterval(loadSessionData, 30000);
		return () => clearInterval(interval);
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
		window.location.href = '/observations';
	}
</script>

<Sidebar>
	<SidebarHeader>
		<div class="flex items-center gap-2 px-4 py-2">
			<span class="text-lg font-bold">kspec</span>
		</div>
	</SidebarHeader>

	<SidebarContent>
		<!-- AC: @web-dashboard ac-20 - Display session focus -->
		{#if sessionContext?.focus}
			<SidebarGroup>
				<SidebarGroupLabel>Current Focus</SidebarGroupLabel>
				<SidebarGroupContent>
					<div class="px-4 py-2 text-sm italic text-muted-foreground">
						{sessionContext.focus}
					</div>
				</SidebarGroupContent>
			</SidebarGroup>
		{/if}

		<SidebarGroup>
			<SidebarGroupLabel>Navigation</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu>
					{#each navItems as item}
						<SidebarMenuItem>
							<SidebarMenuButton
								href={item.href}
								isActive={$page.url.pathname === item.href}
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
							<SidebarMenuButton onclick={openObservations}>
								<span>Observations</span>
								<Badge variant="secondary" class="ml-auto">
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
			<Badge variant={connected ? 'default' : 'destructive'}>
				{connected ? 'Connected' : 'Disconnected'}
			</Badge>
		</div>
	</SidebarFooter>
</Sidebar>
