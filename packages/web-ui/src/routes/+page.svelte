<!--
  AC: @ui-dashboard-overview ac-1 — Dashboard home view
  Active work section, status summary, needs-attention aggregation.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import {
		fetchTasks,
		fetchInbox,
		fetchObservations,
		fetchValidation,
		fetchAgentStatus,
		type AgentDispatchStatus,
		type ActiveInvocation
	} from '$lib/api';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { getProjectVersion } from '$lib/stores/project.svelte';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import Eye from '@lucide/svelte/icons/eye';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Ban from '@lucide/svelte/icons/ban';
	import Activity from '@lucide/svelte/icons/activity';
	import Bot from '@lucide/svelte/icons/bot';
	import ExternalLink from '@lucide/svelte/icons/external-link';

	// --- State ---
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Task counts
	interface TaskCounts {
		ready: number;
		in_progress: number;
		needs_work: number;
		pending_review: number;
		blocked: number;
		completed: number;
		cancelled: number;
	}

	let counts = $state<TaskCounts>({
		ready: 0,
		in_progress: 0,
		needs_work: 0,
		pending_review: 0,
		blocked: 0,
		completed: 0,
		cancelled: 0
	});

	// Active work
	let agentStatus = $state<AgentDispatchStatus | null>(null);
	let taskTitles = $state<Record<string, string>>({});

	let hasActiveWork = $derived(
		agentStatus?.dispatch_enabled && (agentStatus?.active_invocations?.length ?? 0) > 0
	);

	// Needs attention
	let inboxUntriaged = $state(0);
	let observationsUnresolved = $state(0);
	let validationWarnings = $state(0);
	let blockedTasks = $state(0);

	let totalAttention = $derived(
		inboxUntriaged + observationsUnresolved + validationWarnings + blockedTasks
	);

	// --- Status config with design system tokens ---
	// AC: @ui-dashboard-overview ac-1 — clickable count cards per status
	const statusConfig = [
		{
			key: 'ready' as const,
			label: 'Ready',
			dotClass: 'bg-status-pending',
			filterStatus: 'pending'
		},
		{
			key: 'in_progress' as const,
			label: 'In Progress',
			dotClass: 'bg-status-in-progress',
			filterStatus: 'in_progress'
		},
		{
			key: 'needs_work' as const,
			label: 'Needs Work',
			dotClass: 'bg-status-needs-work',
			filterStatus: 'needs_work'
		},
		{
			key: 'pending_review' as const,
			label: 'Review',
			dotClass: 'bg-status-pending-review',
			filterStatus: 'pending_review'
		},
		{
			key: 'blocked' as const,
			label: 'Blocked',
			dotClass: 'bg-status-blocked',
			filterStatus: 'blocked'
		},
		{
			key: 'completed' as const,
			label: 'Completed',
			dotClass: 'bg-status-completed',
			filterStatus: 'completed'
		},
		{
			key: 'cancelled' as const,
			label: 'Cancelled',
			dotClass: 'bg-status-cancelled',
			filterStatus: 'cancelled'
		}
	];

	// --- Needs attention items config ---
	const attentionItems = $derived([
		{
			key: 'inbox',
			label: 'Untriaged inbox',
			count: inboxUntriaged,
			icon: InboxIcon,
			href: `${base}/inbox`,
			colorClass: 'text-status-pending-review'
		},
		{
			key: 'observations',
			label: 'Unresolved observations',
			count: observationsUnresolved,
			icon: Eye,
			href: `${base}/observations`,
			colorClass: 'text-status-in-progress'
		},
		{
			key: 'validation',
			label: 'Validation warnings',
			count: validationWarnings,
			icon: ShieldAlert,
			href: `${base}/validate`,
			colorClass: 'text-status-needs-work'
		},
		{
			key: 'blocked',
			label: 'Blocked tasks',
			count: blockedTasks,
			icon: Ban,
			href: `${base}/tasks?status=blocked`,
			colorClass: 'text-status-blocked'
		}
	]);

	// --- Elapsed time formatting ---
	function formatElapsed(ms: number): string {
		const secs = Math.floor(ms / 1000);
		const mins = Math.floor(secs / 60);
		const hours = Math.floor(mins / 60);
		if (hours > 0) return `${hours}h ${mins % 60}m`;
		if (mins > 0) return `${mins}m ${secs % 60}s`;
		return `${secs}s`;
	}

	// --- Data loading ---
	async function loadDashboard() {
		loading = true;
		error = null;

		try {
			const [tasksResponse, inboxResponse, obsResponse, validationResult, agentStatusResult] =
				await Promise.all([
					fetchTasks({ limit: 1000 }),
					fetchInbox({ limit: 0 }),
					fetchObservations({ resolved: false }),
					fetchValidation().catch(() => null),
					isStaticMode()
						? Promise.resolve(null)
						: fetchAgentStatus().catch(() => null)
				]);

			// Compute task counts
			const tasks = tasksResponse.items;
			const newCounts: TaskCounts = {
				ready: 0,
				in_progress: 0,
				needs_work: 0,
				pending_review: 0,
				blocked: 0,
				completed: 0,
				cancelled: 0
			};

			const completedRefs = new Set(
				tasks
					.filter((t) => t.status === 'completed')
					.flatMap((t) => [t._ulid, ...(t.slugs || [])])
			);

			const titles: Record<string, string> = {};

			for (const task of tasks) {
				// Build task titles for active fleet
				if (task.slugs?.length) {
					for (const slug of task.slugs) {
						titles[`@${slug}`] = task.title;
					}
				}
				titles[`@${task._ulid}`] = task.title;

				switch (task.status) {
					case 'completed':
						newCounts.completed++;
						break;
					case 'in_progress':
						newCounts.in_progress++;
						break;
					case 'pending_review':
						newCounts.pending_review++;
						break;
					case 'blocked':
						newCounts.blocked++;
						break;
					case 'needs_work':
						newCounts.needs_work++;
						break;
					case 'cancelled':
						newCounts.cancelled++;
						break;
					case 'pending': {
						const deps = task.depends_on || [];
						const hasUnmetDeps = deps.some((dep: string) => {
							const ref = dep.startsWith('@') ? dep.slice(1) : dep;
							return !completedRefs.has(ref);
						});
						if (hasUnmetDeps) {
							newCounts.blocked++;
						} else {
							newCounts.ready++;
						}
						break;
					}
				}
			}

			counts = newCounts;
			taskTitles = titles;
			blockedTasks = newCounts.blocked;

			// Inbox count
			inboxUntriaged = inboxResponse.total;

			// Observations: unresolved count
			observationsUnresolved = obsResponse.total;

			// Validation warnings
			if (validationResult) {
				validationWarnings =
					validationResult.refWarnings.length +
					validationResult.completenessWarnings.length +
					validationResult.schemaErrors.length +
					validationResult.refErrors.length;
			}

			// Agent status
			if (agentStatusResult) {
				agentStatus = agentStatusResult;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load dashboard data';
			console.error('Dashboard load error:', err);
		} finally {
			loading = false;
		}
	}

	function navigateToTasks(status: string) {
		goto(`${base}/tasks?status=${status}`);
	}

	// --- WebSocket real-time updates ---
	function handleTaskUpdate() {
		loadDashboard();
	}

	function handleAgentEvent() {
		fetchAgentStatus()
			.then((s) => {
				agentStatus = s;
			})
			.catch(() => {});
	}

	// --- Lifecycle ---
	onMount(() => {
		loadDashboard();

		if (!isStaticMode()) {
			subscribe(['tasks', 'agents']);
			on('tasks', handleTaskUpdate);
			on('agents', handleAgentEvent);
		}
	});

	onDestroy(() => {
		if (!isStaticMode()) {
			off('tasks', handleTaskUpdate);
			off('agents', handleAgentEvent);
			unsubscribe(['tasks', 'agents']);
		}
	});

	// Reload on project change
	$effect(() => {
		const version = getProjectVersion();
		if (version > 0) {
			loadDashboard();
		}
	});
</script>

<div class="flex flex-col gap-6 p-6" data-testid="dashboard">
	<h1 class="text-2xl font-bold">Dashboard</h1>

	{#if error}
		<!-- Error state -->
		<div
			class="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-4"
			role="alert"
			data-testid="dashboard-error"
		>
			<AlertTriangle class="size-5 text-destructive" />
			<div>
				<p class="text-sm font-medium text-destructive">Failed to load dashboard</p>
				<p class="text-xs text-muted-foreground">{error}</p>
			</div>
			<button
				class="ml-auto text-xs text-muted-foreground underline hover:text-foreground"
				onclick={loadDashboard}
			>
				Retry
			</button>
		</div>
	{/if}

	{#if loading}
		<!-- Loading skeleton -->
		<div data-testid="dashboard-skeleton">
			<!-- Active work skeleton -->
			<div class="mb-6">
				<Skeleton class="mb-2 h-5 w-32 ds-shimmer" />
				<div class="flex gap-3">
					<Skeleton class="h-20 w-72 ds-shimmer" />
				</div>
			</div>

			<!-- Status summary skeleton -->
			<div class="mb-6">
				<Skeleton class="mb-3 h-5 w-40 ds-shimmer" />
				<div class="grid gap-4 md:grid-cols-4 lg:grid-cols-7">
					{#each Array(7) as _}
						<Skeleton class="h-24 ds-shimmer" />
					{/each}
				</div>
			</div>

			<!-- Needs attention skeleton -->
			<div>
				<Skeleton class="mb-3 h-5 w-40 ds-shimmer" />
				<div class="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
					{#each Array(4) as _}
						<Skeleton class="h-20 ds-shimmer" />
					{/each}
				</div>
			</div>
		</div>
	{:else}
		<!-- AC: @ui-dashboard-overview ac-1 — Active work section -->
		<section data-testid="active-work-section">
			{#if hasActiveWork}
				<div class="mb-4">
					<div class="flex items-center gap-2 mb-2">
						<Activity class="size-4 text-status-in-progress" />
						<h2 class="text-sm font-medium">Active Fleet</h2>
						<Badge variant="secondary" class="text-[10px]">
							{agentStatus?.active_invocations.length} running
						</Badge>
					</div>
					<div class="flex gap-3 overflow-x-auto pb-2" data-testid="active-fleet-row">
						{#each agentStatus?.active_invocations ?? [] as invocation (invocation.session_id)}
							{@const title = invocation.task_ref ? taskTitles[invocation.task_ref] : undefined}
							<div
								class="flex-shrink-0 w-72 rounded-lg border bg-card p-3 ds-breathe"
								data-testid="fleet-card"
							>
								<div class="flex items-center gap-2 mb-1.5">
									<Bot class="size-4 text-muted-foreground" />
									<span class="text-xs font-medium truncate">{invocation.agent_id}</span>
								</div>

								{#if invocation.task_ref}
									{#if title}
										<p class="text-xs text-foreground truncate mb-0.5">{title}</p>
									{/if}
									<p class="text-[10px] text-muted-foreground font-mono truncate mb-1">
										{invocation.task_ref}
									</p>
								{/if}

								<div class="flex items-center justify-between text-[10px] text-muted-foreground">
									<div class="flex items-center gap-1.5">
										<!-- Pulse indicator -->
										<span class="relative flex size-2">
											<span
												class="absolute inline-flex h-full w-full rounded-full bg-status-in-progress opacity-75 ds-breathe"
											></span>
											<span
												class="relative inline-flex size-2 rounded-full bg-status-in-progress"
											></span>
										</span>
										<span>{formatElapsed(invocation.elapsed_ms)}</span>
									</div>

									<a
										href="{base}/sessions/{invocation.session_id}"
										class="inline-flex items-center gap-1 text-primary hover:underline"
									>
										Stream
										<ExternalLink class="size-3" />
									</a>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{:else}
				<div
					class="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
					data-testid="no-active-work"
				>
					<Activity class="size-4" />
					<span>No agents currently running</span>
				</div>
			{/if}
		</section>

		<!-- AC: @ui-dashboard-overview ac-1 — Status summary with clickable count cards -->
		<section data-testid="status-summary-section">
			<h2 class="mb-3 text-sm font-medium text-muted-foreground">Status Summary</h2>
			<div class="grid gap-3 md:grid-cols-4 lg:grid-cols-7" data-testid="dashboard-counts">
				{#each statusConfig as status}
					<button
						class="text-left"
						onclick={() => navigateToTasks(status.filterStatus)}
						data-testid="task-count-{status.key}"
					>
						<Card class="transition-colors hover:bg-muted/50 cursor-pointer h-full">
							<CardHeader
								class="flex flex-row items-center justify-between pb-1 pt-3 px-3 space-y-0"
							>
								<CardTitle class="text-xs font-medium text-muted-foreground">
									{status.label}
								</CardTitle>
								<span class="inline-block size-2.5 rounded-full {status.dotClass}"></span>
							</CardHeader>
							<CardContent class="px-3 pb-3">
								<div class="text-2xl font-bold tabular-nums">
									{counts[status.key]}
								</div>
							</CardContent>
						</Card>
					</button>
				{/each}
			</div>
		</section>

		<!-- AC: @ui-dashboard-overview ac-1 — Needs attention aggregation -->
		<section data-testid="needs-attention-section">
			<div class="mb-3 flex items-center gap-2">
				<h2 class="text-sm font-medium text-muted-foreground">Needs Attention</h2>
				{#if totalAttention > 0}
					<Badge variant="secondary" class="text-[10px]">{totalAttention}</Badge>
				{/if}
			</div>

			{#if totalAttention === 0}
				<div
					class="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
					data-testid="no-attention-needed"
				>
					<span>Nothing needs attention right now</span>
				</div>
			{:else}
				<div class="grid gap-3 md:grid-cols-2 lg:grid-cols-4" data-testid="attention-cards">
					{#each attentionItems as item}
						{#if item.count > 0}
							<a href={item.href} class="block" data-testid="attention-{item.key}">
								<Card class="transition-colors hover:bg-muted/50 cursor-pointer h-full">
									<CardContent class="flex items-center gap-3 p-4">
										<div class="rounded-md bg-muted p-2">
											<item.icon class="size-4 {item.colorClass}" />
										</div>
										<div>
											<p class="text-2xl font-bold tabular-nums">{item.count}</p>
											<p class="text-xs text-muted-foreground">{item.label}</p>
										</div>
									</CardContent>
								</Card>
							</a>
						{/if}
					{/each}
				</div>
			{/if}
		</section>
	{/if}
</div>
