<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
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
		SidebarMenuBadge,
		SidebarMenuButton,
		SidebarMenuItem,
		SidebarRail,
		SidebarSeparator
	} from '$lib/components/ui/sidebar';
	import { Badge } from '$lib/components/ui/badge';
	import { fetchSessionContext, fetchObservations, fetchInbox, fetchTasks } from '$lib/api';
	import type { SessionContext } from '@kynetic-ai/shared';
	import ConnectionStatus from '$lib/components/ConnectionStatus.svelte';
	import ProjectSelector from '$lib/components/ProjectSelector.svelte';
	import {
		hasMultipleProjects,
		getProjectVersion,
		isInitialized as isProjectInitialized
	} from '$lib/stores/project.svelte';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import {
		LayoutDashboard,
		ListTodo,
		Bot,
		Terminal,
		FileText,
		Map,
		ShieldCheck,
		Inbox,
		Eye,
		Filter,
		Workflow,
		Settings,
		ChevronDown
	} from 'lucide-svelte';

	// AC: @ui-app-shell ac-1 — Grouped navigation sections
	type NavItem = {
		path: string;
		label: string;
		icon: typeof LayoutDashboard;
		badgeKey?: 'inbox' | 'observations' | 'pendingReview';
	};

	type NavGroup = {
		label: string;
		items: NavItem[];
	};

	const navGroups: NavGroup[] = [
		{
			label: 'Work',
			items: [
				{ path: '/', label: 'Dashboard', icon: LayoutDashboard },
				{ path: '/tasks', label: 'Tasks', icon: ListTodo, badgeKey: 'pendingReview' },
				{ path: '/agents', label: 'Agents', icon: Bot },
				{ path: '/sessions', label: 'Sessions', icon: Terminal }
			]
		},
		{
			label: 'Specs',
			items: [
				{ path: '/specs', label: 'Specs', icon: FileText },
				{ path: '/plans', label: 'Plans', icon: Map },
				{ path: '/validate', label: 'Validate', icon: ShieldCheck }
			]
		},
		{
			label: 'Capture',
			items: [
				{ path: '/inbox', label: 'Inbox', icon: Inbox, badgeKey: 'inbox' },
				// AC: @ui-app-shell ac-4 — Observations always visible (not hidden when count is 0)
				{ path: '/observations', label: 'Observations', icon: Eye, badgeKey: 'observations' },
				{ path: '/triage', label: 'Triage', icon: Filter }
			]
		},
		{
			label: 'Config',
			items: [
				{ path: '/workflows', label: 'Workflows', icon: Workflow },
				{ path: '/settings', label: 'Settings', icon: Settings }
			]
		}
	];

	// AC: @ui-app-shell ac-2 — Badge counts for actionable items
	let sessionContext = $state<SessionContext | null>(null);
	let inboxCount = $state(0);
	let unresolvedObservationsCount = $state(0);
	let pendingReviewCount = $state(0);

	let showProjectSelector = $derived(hasMultipleProjects());

	// Collapsed group state (all expanded by default)
	let collapsedGroups = $state<Record<string, boolean>>({});

	function toggleGroup(label: string) {
		collapsedGroups = { ...collapsedGroups, [label]: !collapsedGroups[label] };
	}

	function isActive(itemPath: string): boolean {
		const currentPath = $page.url.pathname;
		const fullPath = `${base}${itemPath}`;
		if (itemPath === '/') {
			return currentPath === fullPath || currentPath === '/';
		}
		return currentPath === fullPath || currentPath.startsWith(`${fullPath}/`);
	}

	function getBadgeCount(key?: 'inbox' | 'observations' | 'pendingReview'): number {
		if (!key) return 0;
		switch (key) {
			case 'inbox':
				return inboxCount;
			case 'observations':
				return unresolvedObservationsCount;
			case 'pendingReview':
				return pendingReviewCount;
			default:
				return 0;
		}
	}

	// Polling interval handle — set up once project store is ready
	let countsInterval: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		return () => {
			if (countsInterval) clearInterval(countsInterval);
		};
	});

	// Load counts when project store is initialized and on every project change.
	// This replaces the old onMount loadCounts() call which could fire before
	// loadProjects() completed, causing stale/wrong-project badge counts.
	$effect(() => {
		const version = getProjectVersion();
		const ready = isProjectInitialized();
		if (!ready) return;

		// Initial load (version === 0) and subsequent project switches (version > 0)
		loadCounts();

		// Set up polling interval on first ready signal
		if (!countsInterval) {
			countsInterval = setInterval(loadCounts, 30000);
		}
	});

	async function loadCounts() {
		try {
			const [sessionData, obsResponse, inboxResponse, tasksResponse] = await Promise.all([
				fetchSessionContext(),
				fetchObservations({ resolved: false }),
				fetchInbox({ limit: 0 }),
				fetchTasks({ status: 'pending_review', limit: 0 })
			]);

			sessionContext = sessionData;
			unresolvedObservationsCount = obsResponse.total;
			inboxCount = inboxResponse.total;
			pendingReviewCount = tasksResponse.total;
		} catch (err) {
			console.error('Failed to load sidebar counts:', err);
		}
	}
</script>

<!-- AC: @ui-app-shell ac-1 — Collapsible sidebar with grouped navigation -->
<Sidebar>
	<SidebarHeader>
		<div class="flex items-center gap-2 px-4 py-2">
			<span class="text-lg font-bold">kspec</span>
		</div>
	</SidebarHeader>

	<SidebarContent>
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

		{#if sessionContext?.focus}
			<SidebarGroup>
				<SidebarGroupLabel>Current Focus</SidebarGroupLabel>
				<SidebarGroupContent>
					<div
						class="px-4 py-2 text-sm italic text-muted-foreground"
						data-testid="session-focus"
					>
						{sessionContext.focus}
					</div>
				</SidebarGroupContent>
			</SidebarGroup>
		{/if}

		{#each navGroups as group}
			<SidebarGroup>
				<SidebarGroupLabel>
					<button
						class="flex w-full items-center justify-between text-xs font-medium uppercase tracking-wider"
						onclick={() => toggleGroup(group.label)}
						data-testid="nav-group-{group.label.toLowerCase()}"
					>
						{group.label}
						<ChevronDown
							class="h-3 w-3 transition-transform {collapsedGroups[group.label]
								? '-rotate-90'
								: ''}"
						/>
					</button>
				</SidebarGroupLabel>
				{#if !collapsedGroups[group.label]}
					<SidebarGroupContent>
						<SidebarMenu data-testid="sidebar-nav-{group.label.toLowerCase()}">
							{#each group.items as item}
								<SidebarMenuItem>
									<SidebarMenuButton
										isActive={isActive(item.path)}
										data-testid="nav-link-{item.label.toLowerCase()}"
									>
										{#snippet child({ props })}
											<a href="{base}{item.path}" {...props}>
												<item.icon class="h-4 w-4" />
												<span>{item.label}</span>
											</a>
										{/snippet}
									</SidebarMenuButton>
									<!-- AC: @ui-app-shell ac-2 — Badge counts for actionable items -->
									{#if item.badgeKey && getBadgeCount(item.badgeKey) > 0}
										<SidebarMenuBadge data-testid="badge-{item.badgeKey}">
											{getBadgeCount(item.badgeKey)}
										</SidebarMenuBadge>
									{/if}
								</SidebarMenuItem>
							{/each}
						</SidebarMenu>
					</SidebarGroupContent>
				{/if}
			</SidebarGroup>
		{/each}
	</SidebarContent>

	<SidebarFooter>
		<div class="flex items-center gap-2 px-4 py-2">
			<ConnectionStatus />
		</div>
	</SidebarFooter>

	<SidebarRail />
</Sidebar>
