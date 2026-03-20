<!--
  AC: @ui-automation-view ac-1 — Shows schedules with enabled/disabled state
  AC: @ui-automation-view ac-3 — Manual trigger supported via POST /api/schedules/:id/trigger;
    config editing (cron, overlap, etc.) requires PATCH endpoint not yet available in daemon API.
  AC: @ui-automation-view ac-4 — Schedule runtime state (next tick, last tick, run count, overlap state)
-->
<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import {
		fetchScheduleStatus,
		triggerSchedule,
		type ScheduleSummary,
		type ScheduleRuntimeStatus
	} from '$lib/api';
	import { isStaticMode, ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card } from '$lib/components/ui/card';
	import Clock from '@lucide/svelte/icons/clock';
	import Play from '@lucide/svelte/icons/play';

	interface Props {
		schedules: ScheduleSummary[];
	}

	let { schedules }: Props = $props();

	const queryClient = useQueryClient();

	// Track expanded schedule for runtime detail
	let expandedScheduleId = $state<string | null>(null);
	let triggerError = $state('');

	// AC: @ui-automation-view ac-4 — Fetch detailed runtime status when expanded
	const scheduleStatusQuery = createQuery(() => ({
		queryKey: queryKeys.automation.scheduleStatus(expandedScheduleId ?? ''),
		queryFn: () => fetchScheduleStatus(expandedScheduleId!),
		enabled: isProjectInitialized() && !isStaticMode() && !!expandedScheduleId,
		staleTime: 5 * 1000,
	}));

	let scheduleStatus = $derived<ScheduleRuntimeStatus | null>(scheduleStatusQuery.data ?? null);

	// AC: @ui-automation-view ac-3 — Trigger schedule manually
	const triggerMutation = createMutation(() => ({
		mutationFn: (id: string) => triggerSchedule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.automation.schedules() });
			if (expandedScheduleId) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.automation.scheduleStatus(expandedScheduleId)
				});
			}
			triggerError = '';
		},
		onError: (err: Error) => {
			triggerError = err instanceof ReadOnlyModeError ? err.message : err.message;
		},
	}));

	function toggleExpand(id: string) {
		expandedScheduleId = expandedScheduleId === id ? null : id;
	}

	function handleTrigger(id: string) {
		triggerError = '';
		triggerMutation.mutate(id);
	}

	function formatTime(ms: number | null): string {
		if (ms === null) return 'N/A';
		return new Date(ms).toLocaleString();
	}

	function getOverlapStateLabel(schedule: ScheduleSummary): string {
		if (schedule.active_run_count === 0) return 'idle';
		return 'running';
	}

	function getOverlapBadgeVariant(state: string): 'default' | 'secondary' | 'outline' {
		switch (state) {
			case 'running':
			case 'running_buffered':
				return 'default';
			default:
				return 'secondary';
		}
	}
</script>

<section data-testid="schedules-section">
	<h2 class="text-lg font-semibold mb-3">
		Schedules
		{#if schedules.length > 0}
			<span class="text-sm font-normal text-muted-foreground">({schedules.length})</span>
		{/if}
	</h2>

	{#if triggerError}
		<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-lg mb-3" role="alert">
			{triggerError}
		</div>
	{/if}

	{#if schedules.length === 0}
		<div
			class="flex flex-col items-center justify-center py-8 text-center border rounded-lg"
			data-testid="schedules-empty-state"
		>
			<Clock class="h-10 w-10 text-muted-foreground mb-3" />
			<h3 class="text-sm font-medium mb-1">No schedules configured</h3>
			<p class="text-xs text-muted-foreground max-w-sm">
				Schedules run actions on a cron basis. Configure them in kynetic.meta.yaml.
			</p>
		</div>
	{:else}
		<div class="flex flex-col gap-3">
			{#each schedules as schedule (schedule.id)}
				<Card class="p-4" data-testid="schedule-card-{schedule.id}">
					<div class="flex items-center justify-between gap-2 mb-2">
						<div class="flex items-center gap-2 min-w-0">
							<Clock class="h-4 w-4 shrink-0 text-muted-foreground" />
							<button
								class="font-medium text-sm truncate hover:underline text-left"
								onclick={() => toggleExpand(schedule.id)}
							>
								{schedule.name}
							</button>
						</div>
						<div class="flex items-center gap-2 shrink-0">
							<Badge
								variant={schedule.enabled ? 'default' : 'outline'}
								class="text-xs"
							>
								{schedule.enabled ? 'Enabled' : 'Disabled'}
							</Badge>
							{#if !isStaticMode() && schedule.enabled}
								<Button
									size="sm"
									variant="outline"
									class="h-7 gap-1"
									onclick={() => handleTrigger(schedule.id)}
									disabled={triggerMutation.isPending}
									data-testid="trigger-schedule-{schedule.id}"
								>
									<Play class="h-3 w-3" />
									Trigger
								</Button>
							{/if}
						</div>
					</div>

					<!-- AC: @ui-automation-view ac-4 — Runtime state summary -->
					<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
						<span>
							<code class="bg-muted px-1 py-0.5 rounded">{schedule.cron}</code>
							<span class="ml-1">({schedule.timezone})</span>
						</span>
						<span>Overlap: <strong>{schedule.overlap_policy}</strong></span>
						<span>Runs: <strong>{schedule.run_count}</strong></span>
						{#if schedule.active_run_count > 0}
							<Badge variant={getOverlapBadgeVariant(getOverlapStateLabel(schedule))} class="text-xs">
								{schedule.active_run_count} active
							</Badge>
						{:else}
							<Badge variant="secondary" class="text-xs">idle</Badge>
						{/if}
					</div>

					<div class="flex gap-x-4 mt-1 text-xs text-muted-foreground">
						<span>Next: <strong>{formatTime(schedule.next_tick)}</strong></span>
						<span>Last: <strong>{formatTime(schedule.last_tick)}</strong></span>
					</div>

					<!-- Expanded detail -->
					{#if expandedScheduleId === schedule.id && scheduleStatus}
						<div class="mt-3 pt-3 border-t" data-testid="schedule-detail-{schedule.id}">
							<div class="grid grid-cols-2 gap-2 text-xs">
								<div>
									<span class="text-muted-foreground">Overlap State:</span>
									<Badge variant={getOverlapBadgeVariant(scheduleStatus.overlap_state)} class="ml-1 text-xs">
										{scheduleStatus.overlap_state}
									</Badge>
								</div>
								<div>
									<span class="text-muted-foreground">Active Run IDs:</span>
									{#if scheduleStatus.active_run_ids.length > 0}
										<span class="font-mono ml-1">{scheduleStatus.active_run_ids.join(', ')}</span>
									{:else}
										<span class="ml-1">None</span>
									{/if}
								</div>
							</div>
						</div>
					{/if}
				</Card>
			{/each}
		</div>
	{/if}
</section>
