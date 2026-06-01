<!--
  AC: @ui-data-freshness ac-1 — Renders from cache on revisit without loading state
  AC: @ui-data-freshness ac-3 — WS events invalidate agent queries via centralized wiring
  AC: @ui-data-freshness ac-8 — Dispatch control mutations invalidate related cache
-->
<script lang="ts">
	// AC: @ui-agent-dispatch ac-1 — Agent definitions with name, triggers, active/completed counts
	// AC: @ui-agent-dispatch ac-2 — Dispatch running: status, stop button, active invocations
	// AC: @ui-agent-dispatch ac-3 — Dispatch stopped: status shown, no active invocations
	import { onMount, onDestroy } from 'svelte';
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import {
		fetchAgentStatus,
		fetchAgentDefinitions,
		controlDispatch,
		type AgentDefinition,
		type AgentDispatchStatus,
		type ActiveInvocation
	} from '$lib/api';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { isStaticMode, ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import AgentCard from '$lib/components/agents/AgentCard.svelte';
	import AgentEditForm from '$lib/components/agents/AgentEditForm.svelte';
	import DispatchStatusComponent from '$lib/components/agents/DispatchStatus.svelte';
	import ActiveInvocationRow from '$lib/components/agents/ActiveInvocationRow.svelte';
	import QueuedInvocationRow from '$lib/components/agents/QueuedInvocationRow.svelte';
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import Bot from 'lucide-svelte/icons/bot';
	import Zap from 'lucide-svelte/icons/zap';

	const queryClient = useQueryClient();

	// --- Queries ---
	// AC: @ui-data-freshness ac-1 — createQuery caches results; revisits render from cache
	// AC: @ui-data-freshness ac-6 — fetchAgentStatus returns empty data in static mode
	const agentStatusQuery = createQuery(() => ({
		queryKey: queryKeys.agents.status(),
		queryFn: () => fetchAgentStatus(),
		enabled: isProjectInitialized(),
		staleTime: 10 * 1000,
	}));

	const agentDefsQuery = createQuery(() => ({
		queryKey: queryKeys.agents.definitions(),
		queryFn: () => fetchAgentDefinitions(),
		enabled: isProjectInitialized(),
	}));

	// --- Derived state ---
	let dispatchStatus = $derived<AgentDispatchStatus | null>(agentStatusQuery.data ?? null);
	let agentDefinitions = $derived<AgentDefinition[]>(agentDefsQuery.data?.items ?? []);

	// AC: @ui-data-freshness ac-1 — Only show loading skeleton on initial fetch (no cache)
	let loading = $derived(agentStatusQuery.isLoading || agentDefsQuery.isLoading);
	let error = $state('');

	// Agent edit dialog state
	let editDialogOpen = $state(false);
	let editingAgent = $state<AgentDefinition | null>(null);

	// Screen reader announcement for live invocation updates
	let invocationAnnouncement = $state('');

	// Track completed invocations per agent (incremented by WebSocket events)
	let completedCounts = $state<Record<string, number>>({});

	// Pre-populate completed counts from agent definitions
	$effect(() => {
		if (agentStatusQuery.data?.agent_definitions) {
			const initial: Record<string, number> = {};
			for (const def of agentStatusQuery.data.agent_definitions) {
				if (def.completed_sessions != null && def.completed_sessions > 0) {
					initial[def.id] = def.completed_sessions;
				}
			}
			completedCounts = initial;
		}
	});

	// Derive active counts per agent from dispatch status
	let activeCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		if (dispatchStatus?.active_invocations) {
			for (const inv of dispatchStatus.active_invocations) {
				counts[inv.agent_id] = (counts[inv.agent_id] || 0) + 1;
			}
		}
		return counts;
	});

	// --- Mutations ---
	// AC: @ui-data-freshness ac-8 — Dispatch control invalidates related cache
	const dispatchMutation = createMutation(() => ({
		mutationFn: (action: 'start' | 'stop') => controlDispatch(action),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
		},
		onError: (err: Error) => {
			if (err instanceof ReadOnlyModeError) {
				error = err.message;
			} else {
				error = err.message || 'Failed to control dispatch';
			}
		},
	}));

	let isToggling = $derived(dispatchMutation.isPending);

	function handleStartDispatch() {
		if (isStaticMode()) return;
		error = '';
		dispatchMutation.mutate('start');
	}

	function handleStopDispatch() {
		if (isStaticMode()) return;
		error = '';
		dispatchMutation.mutate('stop');
	}

	// --- WebSocket handlers ---
	// Agent lifecycle events still need per-page handling for completed counts
	// and screen reader announcements. Query invalidation handled by centralized wiring.
	function handleAgentEvent(event: any) {
		if (event.event === 'agent_invocation') {
			const data = event.data;
			if (data.status === 'completed' || data.status === 'failed') {
				completedCounts = {
					...completedCounts,
					[data.agent_id]: (completedCounts[data.agent_id] || 0) + 1
				};
			}
			// Announce change to screen readers
			const agentLabel = data.agent_id || 'Agent';
			if (data.status === 'started') {
				invocationAnnouncement = `${agentLabel} invocation started`;
			} else if (data.status === 'completed') {
				invocationAnnouncement = `${agentLabel} invocation completed`;
			} else if (data.status === 'failed') {
				invocationAnnouncement = `${agentLabel} invocation failed`;
			}
		}
	}

	function handleEditAgent(agent: AgentDefinition) {
		editingAgent = agent;
		editDialogOpen = true;
	}

	function handleAgentSaved(updated: AgentDefinition) {
		// Invalidate agent definitions query to refresh the list
		queryClient.invalidateQueries({ queryKey: queryKeys.agents.definitions() });
	}

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

<div class="flex flex-col gap-6 p-6">
	<div>
		<h1 class="text-3xl font-bold mb-2">Agents</h1>
		<p class="text-muted-foreground">Agent definitions and dispatch engine status.</p>
	</div>

	<!-- Error State -->
	{#if error || agentStatusQuery.error || agentDefsQuery.error}
		<div
			class="bg-destructive/10 text-destructive p-4 rounded-lg"
			data-testid="error-message"
			role="alert"
		>
			{error || agentStatusQuery.error?.message || agentDefsQuery.error?.message}
		</div>
	{/if}

	<!-- Loading Skeleton -->
	{#if loading}
		<div class="flex flex-col gap-4" data-testid="agents-loading">
			<Skeleton class="h-16 w-full rounded-lg" />
			<Separator />
			<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				<Skeleton class="h-40 rounded-lg" />
				<Skeleton class="h-40 rounded-lg" />
			</div>
		</div>
	{:else}
		<!-- Dispatch Status Section -->
		<!-- AC: @ui-agent-dispatch ac-2, ac-3 -->
		<section data-testid="dispatch-section">
			<h2 class="text-lg font-semibold mb-3">Dispatch Engine</h2>
			{#if dispatchStatus}
				<DispatchStatusComponent
					enabled={dispatchStatus.dispatch_enabled}
					activeCount={dispatchStatus.active_invocations.length}
					queueDepth={dispatchStatus.queue_depth}
					onStart={handleStartDispatch}
					onStop={handleStopDispatch}
					{isToggling}
				/>
			{/if}
		</section>

		<!-- Active Invocations Section -->
		<!-- AC: @ui-agent-dispatch ac-2 -->
		{#if dispatchStatus?.dispatch_enabled}
			<section data-testid="active-invocations-section" aria-live="polite" aria-relevant="additions removals">
				<h2 class="text-lg font-semibold mb-3">Active Invocations</h2>
				{#if dispatchStatus.active_invocations.length > 0}
					<div class="flex flex-col gap-2">
						{#each dispatchStatus.active_invocations as invocation (invocation.session_id)}
							<ActiveInvocationRow {invocation} taskTitle={invocation.task_title ?? null} />
						{/each}
					</div>
				{:else}
					<div
						class="flex flex-col items-center justify-center py-8 text-center border rounded-lg"
						data-testid="active-invocations-empty"
					>
						<Zap class="h-10 w-10 text-muted-foreground mb-3" />
						<h3 class="text-sm font-medium mb-1">No active invocations</h3>
						<p class="text-xs text-muted-foreground max-w-sm">
							Dispatch is running and waiting for eligible tasks. Use
							<code class="bg-muted px-1 py-0.5 rounded">kspec tasks ready --eligible</code>
							to check for work.
						</p>
					</div>
				{/if}
			</section>

			<!-- Queued Invocations Section -->
			<!-- AC: @runner-operator-surfaces ac-web-ui-queued-invocations-include-runner -->
			{#if dispatchStatus.queued_invocations && dispatchStatus.queued_invocations.length > 0}
				<section data-testid="queued-invocations-section">
					<h2 class="text-lg font-semibold mb-3">Queued Invocations</h2>
					<div class="flex flex-col gap-2">
						{#each dispatchStatus.queued_invocations as invocation, index (`${invocation.agent_id}-${invocation.task_ref ?? 'no-task'}-${index}`)}
							<QueuedInvocationRow {invocation} taskTitle={invocation.task_title ?? null} />
						{/each}
					</div>
				</section>
			{/if}
		{/if}

		<!-- Screen reader live announcement for invocation changes -->
		<div class="sr-only" aria-live="assertive" aria-atomic="true" data-testid="invocation-live-region">
			{invocationAnnouncement}
		</div>

		<Separator />

		<!-- Agent Definitions Section -->
		<!-- AC: @ui-agent-dispatch ac-1 -->
		<section data-testid="agent-definitions-section">
			<h2 class="text-lg font-semibold mb-3">
				Agent Definitions
				{#if agentDefinitions.length > 0}
					<span class="text-sm font-normal text-muted-foreground">({agentDefinitions.length})</span>
				{/if}
			</h2>

			{#if agentDefinitions.length === 0}
				<!-- Empty State -->
				<div
					class="flex flex-col items-center justify-center py-12 text-center border rounded-lg"
					data-testid="agents-empty-state"
				>
					<Bot class="h-12 w-12 text-muted-foreground mb-4" />
					<h3 class="text-lg font-medium mb-1">No agents defined</h3>
					<p class="text-sm text-muted-foreground max-w-sm">
						Agent definitions are configured in kynetic.meta.yaml. Use
						<code class="text-xs bg-muted px-1 py-0.5 rounded">kspec setup</code>
						to create default agent definitions.
					</p>
				</div>
			{:else}
				<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
					{#each agentDefinitions as agent (agent.id)}
						<AgentCard
							{agent}
							activeCount={activeCounts[agent.id] || 0}
							completedCount={completedCounts[agent.id] || 0}
							onEdit={() => handleEditAgent(agent)}
						/>
					{/each}
				</div>
			{/if}
		</section>
	{/if}

	{#if editingAgent}
		<AgentEditForm
			bind:open={editDialogOpen}
			agent={editingAgent}
			onSaved={handleAgentSaved}
		/>
	{/if}
</div>
