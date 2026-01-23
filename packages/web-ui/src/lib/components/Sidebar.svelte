<script lang="ts">
	import { page } from '$app/stores';
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

	// Navigation items
	const navItems = [
		{ href: '/', label: 'Dashboard', icon: 'LayoutDashboard' },
		{ href: '/tasks', label: 'Tasks', icon: 'CheckSquare' },
		{ href: '/items', label: 'Items', icon: 'FileText' },
		{ href: '/inbox', label: 'Inbox', icon: 'Inbox' }
	];

	// Connection status (will be wired to WebSocket later)
	let connected = $state(false);
</script>

<Sidebar>
	<SidebarHeader>
		<div class="flex items-center gap-2 px-4 py-2">
			<span class="text-lg font-bold">kspec</span>
		</div>
	</SidebarHeader>

	<SidebarContent>
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
	</SidebarContent>

	<SidebarFooter>
		<div class="flex items-center gap-2 px-4 py-2">
			<Badge variant={connected ? 'default' : 'destructive'}>
				{connected ? 'Connected' : 'Disconnected'}
			</Badge>
		</div>
	</SidebarFooter>
</Sidebar>
