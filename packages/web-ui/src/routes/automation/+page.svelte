<!--
  AC: @ui-automation-view ac-1 — Organized sections for triggers, hooks, schedules
  AC: @ui-automation-view ac-2 — Event log section with recent events
  AC: @ui-automation-view ac-3 — Inline editing for hooks and schedules
  AC: @ui-automation-view ac-4 — Schedule runtime state display
  AC: @ui-automation-view ac-5 — Dispatch trigger inline editing
  AC: @ui-automation-view ac-6 — Composition group activation display
  AC: @ui-automation-view ac-7 — Real-time event log via WebSocket
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import {
		fetchAgentStatus,
		fetchAgentDefinitions,
		fetchHooks,
		fetchSchedules,
		fetchRecentEvents,
		type AgentDefinition,
		type AgentDispatchStatus,
		type HookSummary,
		type ScheduleSummary,
		type EventEnvelopeSummary
	} from '$lib/api';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import DispatchTriggersSection from '$lib/components/automation/DispatchTriggersSection.svelte';
	import HooksSection from '$lib/components/automation/HooksSection.svelte';
	import SchedulesSection from '$lib/components/automation/SchedulesSection.svelte';
	import EventLogSection from '$lib/components/automation/EventLogSection.svelte';
	import CompositionsSection from '$lib/components/automation/CompositionsSection.svelte';
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';

	const queryClient = useQueryClient();

	// --- Queries ---
	// AC: @ui-automation-view ac-1 — Fetch agent definitions for dispatch triggers
	const agentStatusQuery = createQuery(() => ({
		queryKey: queryKeys.agents.status(),
		queryFn: () => fetchAgentStatus(),
		enabled: isProjectInitialized() && !isStaticMode(),
		staleTime: 10 * 1000,
	}));

	const agentDefsQuery = createQuery(() => ({
		queryKey: queryKeys.agents.definitions(),
		queryFn: () => fetchAgentDefinitions(),
		enabled: isProjectInitialized(),
	}));

	// AC: @ui-automation-view ac-1 — Fetch hooks
	const hooksQuery = createQuery(() => ({
		queryKey: queryKeys.automation.hooks(),
		queryFn: () => fetchHooks(),
		enabled: isProjectInitialized() && !isStaticMode(),
	}));

	// AC: @ui-automation-view ac-1, ac-4 — Fetch schedules with runtime state
	const schedulesQuery = createQuery(() => ({
		queryKey: queryKeys.automation.schedules(),
		queryFn: () => fetchSchedules(),
		enabled: isProjectInitialized() && !isStaticMode(),
	}));

	// AC: @ui-automation-view ac-2 — Fetch recent events
	const eventsQuery = createQuery(() => ({
		queryKey: queryKeys.automation.events(),
		queryFn: () => fetchRecentEvents({ limit: 50 }),
		enabled: isProjectInitialized() && !isStaticMode(),
		staleTime: 5 * 1000,
	}));

	// --- Derived state ---
	let dispatchStatus = $derived<AgentDispatchStatus | null>(agentStatusQuery.data ?? null);
	let agentDefinitions = $derived<AgentDefinition[]>(agentDefsQuery.data?.items ?? []);
	let hooks = $derived<HookSummary[]>(hooksQuery.data?.items ?? []);
	let schedules = $derived<ScheduleSummary[]>(schedulesQuery.data?.items ?? []);
	let events = $derived<EventEnvelopeSummary[]>(eventsQuery.data?.items ?? []);

	let loading = $derived(
		agentStatusQuery.isLoading ||
		agentDefsQuery.isLoading ||
		hooksQuery.isLoading ||
		schedulesQuery.isLoading
	);

	// --- WebSocket handlers ---
	// AC: @ui-automation-view ac-7 — Real-time event log updates
	function handleAgentEvent() {
		// Invalidate events query to pick up new events
		queryClient.invalidateQueries({ queryKey: queryKeys.automation.events() });
	}

	function handleTaskEvent() {
		// Task state changes generate automation events
		queryClient.invalidateQueries({ queryKey: queryKeys.automation.events() });
	}

	onMount(() => {
		if (!isStaticMode()) {
			subscribe(['agents', 'tasks:updates']);
			on('agents', handleAgentEvent);
			on('tasks:updates', handleTaskEvent);
		}
	});

	onDestroy(() => {
		if (!isStaticMode()) {
			off('agents', handleAgentEvent);
			off('tasks:updates', handleTaskEvent);
			unsubscribe(['agents', 'tasks:updates']);
		}
	});
</script>

<div class="flex flex-col gap-6 p-6">
	<div>
		<h1 class="text-3xl font-bold mb-2">Automation</h1>
		<p class="text-muted-foreground">
			Dispatch triggers, hooks, schedules, event log, and composition groups.
		</p>
	</div>

	<!-- Error State -->
	{#if agentStatusQuery.error || hooksQuery.error || schedulesQuery.error}
		<div
			class="bg-destructive/10 text-destructive p-4 rounded-lg"
			data-testid="error-message"
			role="alert"
		>
			{agentStatusQuery.error?.message || hooksQuery.error?.message || schedulesQuery.error?.message}
		</div>
	{/if}

	<!-- Loading Skeleton -->
	{#if loading}
		<div class="flex flex-col gap-4" data-testid="automation-loading">
			<Skeleton class="h-24 w-full rounded-lg" />
			<Separator />
			<Skeleton class="h-24 w-full rounded-lg" />
			<Separator />
			<Skeleton class="h-24 w-full rounded-lg" />
			<Separator />
			<Skeleton class="h-40 w-full rounded-lg" />
		</div>
	{:else}
		<!-- AC: @ui-automation-view ac-1, ac-5 — Agent Dispatch Triggers -->
		<DispatchTriggersSection
			agents={agentDefinitions}
			dispatchEnabled={dispatchStatus?.dispatch_enabled ?? false}
		/>

		<Separator />

		<!-- AC: @ui-automation-view ac-1, ac-3 — Hooks -->
		<HooksSection {hooks} />

		<Separator />

		<!-- AC: @ui-automation-view ac-1, ac-3, ac-4 — Schedules -->
		<SchedulesSection {schedules} />

		<Separator />

		<!-- AC: @ui-automation-view ac-2, ac-7 — Event Log -->
		<EventLogSection {events} />

		<Separator />

		<!-- AC: @ui-automation-view ac-6 — Compositions -->
		<CompositionsSection />
	{/if}
</div>
