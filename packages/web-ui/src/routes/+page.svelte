<!--
  AC: @ui-dashboard-overview ac-1 — Dashboard home view
  Active work section, status summary, needs-attention aggregation.

  AC: @ui-dashboard-overview ac-counts-from-summary — Status counts come from
  the pre-computed server-side summary endpoint, not the full task list.

  AC: @ui-data-freshness ac-1 — Renders from cache on revisit without loading state
  AC: @ui-data-freshness ac-3 — WebSocket events invalidate dashboard queries
  AC: @ui-data-freshness ac-6 — Static mode compatibility via queryFn dispatch
  AC: @ui-data-freshness ac-7 — Error state with retry for daemon-unreachable
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import type { BroadcastEvent } from '@kynetic-ai/shared';
	import {
		fetchTaskStatusSummary,
		fetchInbox,
		fetchObservations,
		fetchValidation,
		fetchAgentStatus,
		type AgentDispatchStatus
	} from '$lib/api';
	import {
		createSessionState,
		processTextChunk,
		type FleetSessionState,
	} from '$lib/components/board/fleet-buffer';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
	import InboxIcon from 'lucide-svelte/icons/inbox';
	import Eye from 'lucide-svelte/icons/eye';
	import ShieldAlert from 'lucide-svelte/icons/shield-alert';
	import Ban from 'lucide-svelte/icons/ban';
	import Activity from 'lucide-svelte/icons/activity';
	import Bot from 'lucide-svelte/icons/bot';
	import ExternalLink from 'lucide-svelte/icons/external-link';
	import TerminalIcon from 'lucide-svelte/icons/terminal';

	const queryClient = useQueryClient();

	// --- Task counts type ---
	interface TaskCounts {
		ready: number;
		in_progress: number;
		needs_work: number;
		pending_review: number;
		blocked: number;
		completed: number;
		cancelled: number;
	}

	// --- Queries ---
	// AC: @ui-data-freshness ac-1 — createQuery caches results; revisits render from cache
	// AC: @ui-data-freshness ac-2 — Concurrent uses share the same in-flight request
	// AC: @ui-data-freshness ac-6 — fetchTaskStatusSummary/fetchInbox/etc. already dispatch to static mode
	// AC: @ui-dashboard-overview ac-counts-from-summary — pre-computed server-side
	// summary instead of fetching the full task list. WS task events invalidate
	// queryKeys.tasks.all, which covers this key (see ws-invalidation.ts).
	const taskSummaryQuery = createQuery(() => ({
		queryKey: queryKeys.tasks.summary(),
		queryFn: () => fetchTaskStatusSummary(),
		enabled: isProjectInitialized(),
	}));

	const inboxQuery = createQuery(() => ({
		queryKey: queryKeys.inbox.count(),
		queryFn: () => fetchInbox({ limit: 0 }),
		enabled: isProjectInitialized(),
	}));

	const observationsQuery = createQuery(() => ({
		queryKey: queryKeys.observations.list({ resolved: false }),
		queryFn: () => fetchObservations({ resolved: false }),
		enabled: isProjectInitialized(),
	}));

	const validationQuery = createQuery(() => ({
		queryKey: queryKeys.validation.results(),
		queryFn: () => fetchValidation(),
		enabled: isProjectInitialized(),
	}));

	// AC: @ui-data-freshness ac-6 — fetchAgentStatus returns empty data in static mode
	const agentStatusQuery = createQuery(() => ({
		queryKey: queryKeys.agents.status(),
		queryFn: () => fetchAgentStatus(),
		enabled: isProjectInitialized(),
		staleTime: 10 * 1000,
	}));

	// --- Derived state from queries ---
	// AC: @ui-dashboard-overview ac-counts-from-summary
	// Every card except ready maps 1:1 from summary.counts — blocked stays
	// status 'blocked' only (blocked_by_dependencies is NOT folded in). The
	// ready card adopts summary.ready, the server's canonical dependency-aware
	// definition: pending OR needs_work tasks with no blockers and all
	// dependencies met.
	let counts = $derived.by(() => {
		const summary = taskSummaryQuery.data;
		const statusCounts = summary?.counts ?? {};
		const newCounts: TaskCounts = {
			ready: summary?.ready ?? 0,
			in_progress: statusCounts.in_progress ?? 0,
			needs_work: statusCounts.needs_work ?? 0,
			pending_review: statusCounts.pending_review ?? 0,
			blocked: statusCounts.blocked ?? 0,
			completed: statusCounts.completed ?? 0,
			cancelled: statusCounts.cancelled ?? 0,
		};
		return newCounts;
	});

	let agentStatus = $derived<AgentDispatchStatus | null>(agentStatusQuery.data ?? null);

	let hasActiveWork = $derived(
		agentStatus?.dispatch_enabled && (agentStatus?.active_invocations?.length ?? 0) > 0
	);

	// Buffered output state per agent session (same pattern as board)
	let sessionStates = $state<Record<string, FleetSessionState>>({});

	let inboxUntriaged = $derived(inboxQuery.data?.total ?? 0);
	let observationsUnresolved = $derived(observationsQuery.data?.total ?? 0);

	let validationWarnings = $derived.by(() => {
		const v = validationQuery.data;
		if (!v) return 0;
		return (
			v.refWarnings.length +
			v.completenessWarnings.length +
			v.schemaErrors.length +
			v.refErrors.length
		);
	});

	let blockedTasks = $derived(counts.blocked);

	let totalAttention = $derived(
		inboxUntriaged + observationsUnresolved + validationWarnings + blockedTasks
	);

	// AC: @ui-data-freshness ac-7 — Surface error with retry capability
	let error = $derived.by(() => {
		if (taskSummaryQuery.error) return taskSummaryQuery.error.message;
		if (inboxQuery.error) return inboxQuery.error.message;
		if (observationsQuery.error) return observationsQuery.error.message;
		return null;
	});

	// AC: @ui-data-freshness ac-1 — Only show loading skeleton on initial fetch (no cache)
	let loading = $derived(
		taskSummaryQuery.isLoading ||
		inboxQuery.isLoading ||
		observationsQuery.isLoading
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

	function navigateToTasks(status: string) {
		goto(`${base}/tasks?status=${status}`);
	}

	function retryAll() {
		queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
		queryClient.invalidateQueries({ queryKey: queryKeys.inbox.all });
		queryClient.invalidateQueries({ queryKey: queryKeys.observations.all });
		queryClient.invalidateQueries({ queryKey: queryKeys.validation.all });
		queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
	}

	// --- WebSocket handlers for agent text streaming ---
	// Session events stay outside TanStack Query (streaming buffer, not request-response).
	// Agent lifecycle events trigger an agent status query invalidation.
	// AC: @session-event-broadcast ac-replaces-text-chunks
	function handleAgentEvent(event: BroadcastEvent) {
		const textEvents = new Set(['message_progress', 'message_complete', 'thinking_progress', 'thinking_complete']);
		if (textEvents.has(event.event) && event.data?.session_id && event.data?.text) {
			const sessionId = event.data.session_id as string;
			const text = event.data.text as string;
			const current = sessionStates[sessionId] ?? createSessionState();
			sessionStates[sessionId] = processTextChunk(current, text);
			return;
		}

		// Invocation lifecycle events — invalidate agent status query, clean up stale state
		// AC: @ui-data-freshness ac-3 — WS event drives cache invalidation instead of full re-fetch
		queryClient.invalidateQueries({ queryKey: queryKeys.agents.status() });

		// Clean up stale session states based on refreshed agent status
		if (agentStatusQuery.data) {
			const activeSessions = new Set(
				agentStatusQuery.data.active_invocations.map((inv) => inv.session_id)
			);
			for (const sessionId of Object.keys(sessionStates)) {
				if (!activeSessions.has(sessionId)) {
					delete sessionStates[sessionId];
				}
			}
		}
	}

	// --- Lifecycle ---
	// Subscribe to agent events for text chunk streaming (tasks handled by centralized wiring).
	onMount(() => {
		if (!isStaticMode()) {
			subscribe(['agents']);
			on('agents', handleAgentEvent);
		}
	});

	onDestroy(() => {
		if (!isStaticMode()) {
			off('agents', handleAgentEvent);
			unsubscribe(['agents']);
		}
	});
</script>

<div class="flex flex-col gap-6 p-6" data-testid="dashboard">
	<h1 class="text-2xl font-bold">Dashboard</h1>

	{#if error}
		<!-- AC: @ui-data-freshness ac-7 — Error state with retry -->
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
				onclick={retryAll}
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
							{@const title = invocation.task_title ?? undefined}
							{@const sessionState = sessionStates[invocation.session_id]}
							{@const lines = sessionState?.lines ?? []}
							<div
								class="flex-shrink-0 w-72 rounded-lg border bg-card p-3 ds-breathe"
								data-testid="fleet-card"
							>
								<div class="flex items-center gap-2 mb-1.5">
									<Bot class="size-4 text-muted-foreground" />
									<span class="text-xs font-medium truncate">{invocation.agent_id}</span>
								</div>

								{#if invocation.task_ref}
									<div class="truncate mb-1">
										<ReferenceLink ref={invocation.task_ref} type="task" title={title} class="text-xs" />
									</div>
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

								<!-- Buffered output -->
								{#if lines.length > 0}
									<div
										class="mt-1.5 rounded bg-muted/50 p-1.5 font-mono text-[10px] leading-tight text-muted-foreground overflow-hidden max-h-10"
										aria-live="polite"
										aria-label="Agent output for {title ?? invocation.agent_id}"
										data-testid="fleet-output"
									>
										{#each lines.slice(-2) as line}
											<div class="truncate">{line}</div>
										{/each}
									</div>
								{:else}
									<div
										class="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground/50"
										aria-live="polite"
										aria-label="Agent output for {title ?? invocation.agent_id}"
										data-testid="fleet-output-empty"
									>
										<TerminalIcon class="size-3" />
										<span>Awaiting output...</span>
									</div>
								{/if}
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
