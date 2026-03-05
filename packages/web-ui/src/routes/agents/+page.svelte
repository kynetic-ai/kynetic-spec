<script lang="ts">
	// AC: @ui-agent-dispatch ac-1 — Agent definitions with name, triggers, active/completed counts
	// AC: @ui-agent-dispatch ac-2 — Dispatch running: status, stop button, active invocations
	// AC: @ui-agent-dispatch ac-3 — Dispatch stopped: status shown, no active invocations
	import { onMount, onDestroy } from 'svelte';
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
	import { getProjectVersion } from '$lib/stores/project.svelte';
	import AgentCard from '$lib/components/agents/AgentCard.svelte';
	import DispatchStatusComponent from '$lib/components/agents/DispatchStatus.svelte';
	import ActiveInvocationRow from '$lib/components/agents/ActiveInvocationRow.svelte';
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import Bot from '@lucide/svelte/icons/bot';
	import Zap from '@lucide/svelte/icons/zap';

	let agentDefinitions = $state<AgentDefinition[]>([]);
	let dispatchStatus = $state<AgentDispatchStatus | null>(null);
	let loading = $state(true);
	let error = $state('');
	let isToggling = $state(false);

	// Screen reader announcement for live invocation updates
	let invocationAnnouncement = $state('');

	// Track completed invocations per agent (incremented by WebSocket events)
	let completedCounts = $state<Record<string, number>>({});

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

	// Reload on project change
	$effect(() => {
		const version = getProjectVersion();
		if (version > 0) {
			loadData();
		}
	});

	async function loadData() {
		loading = true;
		error = '';

		try {
			const [statusResult, defsResult] = await Promise.all([
				fetchAgentStatus(),
				fetchAgentDefinitions()
			]);
			dispatchStatus = statusResult;
			agentDefinitions = defsResult.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load agent data';
			console.error('Error loading agent data:', err);
		} finally {
			loading = false;
		}
	}

	async function handleStartDispatch() {
		if (isStaticMode()) return;
		isToggling = true;
		error = '';

		try {
			const result = await controlDispatch('start');
			// Refresh full status after toggle
			dispatchStatus = await fetchAgentStatus();
		} catch (err) {
			if (err instanceof ReadOnlyModeError) {
				error = err.message;
			} else {
				error = err instanceof Error ? err.message : 'Failed to start dispatch';
			}
		} finally {
			isToggling = false;
		}
	}

	async function handleStopDispatch() {
		if (isStaticMode()) return;
		isToggling = true;
		error = '';

		try {
			const result = await controlDispatch('stop');
			// Refresh full status after toggle
			dispatchStatus = await fetchAgentStatus();
		} catch (err) {
			if (err instanceof ReadOnlyModeError) {
				error = err.message;
			} else {
				error = err instanceof Error ? err.message : 'Failed to stop dispatch';
			}
		} finally {
			isToggling = false;
		}
	}

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
			// Refresh status to update active invocations
			fetchAgentStatus()
				.then((status) => {
					dispatchStatus = status;
				})
				.catch((err) => console.error('Error refreshing agent status:', err));
		}
	}

	onMount(() => {
		loadData();
		subscribe(['agents']);
		on('agents', handleAgentEvent);
	});

	onDestroy(() => {
		off('agents', handleAgentEvent);
		unsubscribe(['agents']);
	});
</script>

<div class="flex flex-col gap-6 p-6">
	<div>
		<h1 class="text-3xl font-bold mb-2">Agents</h1>
		<p class="text-muted-foreground">Agent definitions and dispatch engine status.</p>
	</div>

	<!-- Error State -->
	{#if error}
		<div
			class="bg-destructive/10 text-destructive p-4 rounded-lg"
			data-testid="error-message"
			role="alert"
		>
			{error}
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
							<ActiveInvocationRow {invocation} />
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
						/>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
</div>
