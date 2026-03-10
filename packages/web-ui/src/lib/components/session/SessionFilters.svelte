<!--
  AC: @session-filter-controls ac-status-filter — Status multi-select filter via URL params.
  AC: @session-filter-controls ac-agent-filter — Agent ID filter via URL params.
  AC: @session-filter-controls ac-agent-type-filter — Agent type filter via URL params.
  AC: @session-filter-controls ac-trigger-filter — Trigger filter (manual/dispatched) via URL params.
  AC: @session-filter-controls ac-date-filter — Date range filter via URL params.
  AC: @session-filter-controls ac-clear-filters — Clear all filters button.
  AC: @session-filter-controls ac-filter-counts — Filtered vs total count display.
  AC: @ui-url-panel-state ac-4 — goto() for all URL mutations.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { base } from '$app/paths';
	import {
		Select,
		SelectContent,
		SelectItem,
		SelectTrigger
	} from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import X from '@lucide/svelte/icons/x';

	interface Props {
		/** Total sessions matching current filters */
		filteredTotal: number;
		/** Total sessions unfiltered */
		unfilteredTotal: number;
		/** Distinct agent IDs found in data */
		agentIds: string[];
		/** Distinct agent types found in data */
		agentTypes: string[];
	}

	let { filteredTotal, unfilteredTotal, agentIds, agentTypes }: Props = $props();

	const SESSION_STATUSES = ['active', 'completed', 'failed', 'abandoned', 'timed_out'] as const;

	const statusLabels: Record<string, string> = {
		'': 'All Statuses',
		all: 'All Statuses',
		active: 'Active',
		completed: 'Completed',
		failed: 'Failed',
		abandoned: 'Abandoned',
		timed_out: 'Timed Out'
	};

	const dateRangeLabels: Record<string, string> = {
		'': 'All Time',
		all: 'All Time',
		today: 'Today',
		'7d': 'Last 7 days',
		'30d': 'Last 30 days'
	};

	const triggerLabels: Record<string, string> = {
		'': 'All Triggers',
		all: 'All Triggers',
		manual: 'Manual',
		dispatched: 'Dispatched'
	};

	// AC: @ui-url-panel-state ac-4 — Derive filter values from $page.url.searchParams
	let status = $derived($page.url.searchParams.get('status') || '');
	let agentId = $derived($page.url.searchParams.get('agent_id') || '');
	let agentType = $derived($page.url.searchParams.get('agent_type') || '');
	let trigger = $derived($page.url.searchParams.get('trigger') || '');
	let dateRange = $derived($page.url.searchParams.get('date_range') || '');

	let hasFilters = $derived(status || agentId || agentType || trigger || dateRange);

	let statusDisplay = $derived(status || 'all');
	let triggerDisplay = $derived(trigger || 'all');
	let dateRangeDisplay = $derived(dateRange || 'all');

	// AC: @ui-url-panel-state ac-4 — All URL mutations use goto()
	function updateFilter(key: string, value: string | string[] | undefined) {
		let actualValue: string | undefined;
		if (Array.isArray(value)) {
			actualValue = value.length > 0 ? value[value.length - 1] : undefined;
		} else {
			actualValue = value;
		}

		const params = new URLSearchParams($page.url.searchParams);

		if (!actualValue || actualValue === 'all') {
			params.delete(key);
		} else {
			params.set(key, actualValue);
		}

		// Reset offset when filter changes
		params.delete('offset');

		const qs = params.toString();
		const newUrl = qs ? `${base}/sessions?${qs}` : `${base}/sessions`;
		goto(newUrl, { replaceState: true, keepFocus: true, noScroll: true });
	}

	// AC: @session-filter-controls ac-clear-filters
	function clearFilters() {
		goto(`${base}/sessions`, { replaceState: true, keepFocus: true, noScroll: true });
	}
</script>

<div class="flex flex-wrap items-end gap-3" data-testid="session-filter-controls">
	<!-- AC: @session-filter-controls ac-status-filter -->
	<div class="min-w-[130px]">
		<label for="session-status-filter" class="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
		<Select
			value={statusDisplay}
			onValueChange={(v) => updateFilter('status', v)}
		>
			<SelectTrigger id="session-status-filter" data-testid="session-filter-status" class="h-8 text-xs">
				{statusLabels[statusDisplay] || 'All Statuses'}
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="all">All Statuses</SelectItem>
				{#each SESSION_STATUSES as s}
					<SelectItem value={s}>{statusLabels[s]}</SelectItem>
				{/each}
			</SelectContent>
		</Select>
	</div>

	<!-- AC: @session-filter-controls ac-trigger-filter -->
	<div class="min-w-[130px]">
		<label for="session-trigger-filter" class="text-xs font-medium text-muted-foreground mb-1 block">Trigger</label>
		<Select
			value={triggerDisplay}
			onValueChange={(v) => updateFilter('trigger', v)}
		>
			<SelectTrigger id="session-trigger-filter" data-testid="session-filter-trigger" class="h-8 text-xs">
				{triggerLabels[triggerDisplay] || 'All Triggers'}
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="all">All Triggers</SelectItem>
				<SelectItem value="manual">Manual</SelectItem>
				<SelectItem value="dispatched">Dispatched</SelectItem>
			</SelectContent>
		</Select>
	</div>

	<!-- AC: @session-filter-controls ac-agent-type-filter -->
	{#if agentTypes.length > 1}
		<div class="min-w-[150px]">
			<label for="session-agent-type-filter" class="text-xs font-medium text-muted-foreground mb-1 block">Agent Type</label>
			<Select
				value={agentType || 'all'}
				onValueChange={(v) => updateFilter('agent_type', v)}
			>
				<SelectTrigger id="session-agent-type-filter" data-testid="session-filter-agent-type" class="h-8 text-xs">
					{agentType || 'All Types'}
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="all">All Types</SelectItem>
					{#each agentTypes as t}
						<SelectItem value={t}>{t}</SelectItem>
					{/each}
				</SelectContent>
			</Select>
		</div>
	{/if}

	<!-- AC: @session-filter-controls ac-agent-filter -->
	{#if agentIds.length > 1}
		<div class="min-w-[130px]">
			<label for="session-agent-filter" class="text-xs font-medium text-muted-foreground mb-1 block">Agent</label>
			<Select
				value={agentId || 'all'}
				onValueChange={(v) => updateFilter('agent_id', v)}
			>
				<SelectTrigger id="session-agent-filter" data-testid="session-filter-agent" class="h-8 text-xs">
					{agentId || 'All Agents'}
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="all">All Agents</SelectItem>
					{#each agentIds as a}
						<SelectItem value={a}>{a}</SelectItem>
					{/each}
				</SelectContent>
			</Select>
		</div>
	{/if}

	<!-- AC: @session-filter-controls ac-date-filter -->
	<div class="min-w-[130px]">
		<label for="session-date-filter" class="text-xs font-medium text-muted-foreground mb-1 block">Time Range</label>
		<Select
			value={dateRangeDisplay}
			onValueChange={(v) => updateFilter('date_range', v)}
		>
			<SelectTrigger id="session-date-filter" data-testid="session-filter-date" class="h-8 text-xs">
				{dateRangeLabels[dateRangeDisplay] || 'All Time'}
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="all">All Time</SelectItem>
				<SelectItem value="today">Today</SelectItem>
				<SelectItem value="7d">Last 7 days</SelectItem>
				<SelectItem value="30d">Last 30 days</SelectItem>
			</SelectContent>
		</Select>
	</div>

	<!-- AC: @session-filter-controls ac-clear-filters -->
	{#if hasFilters}
		<Button
			variant="ghost"
			size="sm"
			onclick={clearFilters}
			class="h-8 text-xs gap-1"
			data-testid="session-clear-filters"
		>
			<X class="size-3" />
			Clear filters
		</Button>
	{/if}

	<!-- AC: @session-filter-controls ac-filter-counts -->
	{#if hasFilters && unfilteredTotal > 0}
		<span class="text-xs text-muted-foreground ml-auto" data-testid="session-filter-count">
			{filteredTotal} of {unfilteredTotal} session{unfilteredTotal === 1 ? '' : 's'}
		</span>
	{/if}
</div>
