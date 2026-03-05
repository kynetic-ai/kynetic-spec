<!--
  AC: @ui-plans-view ac-1 — Each plan shows title, status, creation date, linked spec/task counts, and progress.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { PlanSummary } from '@kynetic-ai/shared';
	import { fetchPlans } from '$lib/api';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { getProjectVersion } from '$lib/stores/project.svelte';
	import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import MapIcon from '@lucide/svelte/icons/map';

	// ── Data state ──
	let plans = $state<PlanSummary[]>([]);
	let loading = $state(true);
	let error = $state('');

	// ── Filter state ──
	type PlanStatusFilter = 'all' | 'draft' | 'approved' | 'active' | 'completed' | 'rejected';
	let filterStatus = $state<PlanStatusFilter>('all');

	// ── Plan status labels and colors ──
	// AC: @ui-plans-view ac-1 — visually distinct statuses with text labels
	const PLAN_STATUS_LABELS: Record<string, string> = {
		draft: 'Draft',
		approved: 'Approved',
		active: 'Active',
		completed: 'Completed',
		rejected: 'Rejected'
	};

	const PLAN_STATUS_COLORS: Record<string, string> = {
		draft: 'bg-status-pending text-status-pending-fg',
		approved: 'bg-status-pending-review text-status-pending-review-fg',
		active: 'bg-status-in-progress text-status-in-progress-fg',
		completed: 'bg-status-completed text-status-completed-fg',
		rejected: 'bg-status-blocked text-status-blocked-fg'
	};

	// ── Filtered plans ──
	let filteredPlans = $derived.by(() => {
		if (filterStatus === 'all') return plans;
		return plans.filter((p) => p.status === filterStatus);
	});

	// ── Status summary counts ──
	let statusCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const plan of plans) {
			counts[plan.status] = (counts[plan.status] ?? 0) + 1;
		}
		return counts;
	});

	// ── Lifecycle ──
	onMount(async () => {
		await loadData();

		if (!isStaticMode()) {
			subscribe(['plans:updates']);
			on('plans:updates', handleUpdate);
		}
	});

	onDestroy(() => {
		if (!isStaticMode()) {
			off('plans:updates', handleUpdate);
			unsubscribe(['plans:updates']);
		}
	});

	// Reload on project change
	$effect(() => {
		const version = getProjectVersion();
		if (version > 0) {
			loadData();
		}
	});

	// ── Data loading ──
	async function loadData() {
		try {
			loading = true;
			error = '';
			const response = await fetchPlans();
			plans = response.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load plans';
		} finally {
			loading = false;
		}
	}

	// ── WebSocket handler ──
	function handleUpdate() {
		loadData();
	}

	// ── Formatting ──
	function formatDate(dateString: string): string {
		const date = new Date(dateString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return 'just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;

		return date.toLocaleDateString();
	}

	// AC: @ui-plans-view ac-1 — Progress percentage from task completion status
	function progressPercent(plan: PlanSummary): number {
		if (plan.task_progress.total === 0) return 0;
		return Math.round((plan.task_progress.completed / plan.task_progress.total) * 100);
	}
</script>

<div class="flex flex-col gap-4 p-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold">Plans</h1>
			{#if !loading}
				<p class="text-sm text-muted-foreground" data-testid="plans-summary">
					{plans.length} plan{plans.length === 1 ? '' : 's'}
					{#if Object.keys(statusCounts).length > 0}
						&middot;
						{#each Object.entries(statusCounts) as [status, count], i}
							{count} {PLAN_STATUS_LABELS[status]?.toLowerCase() ?? status}{i < Object.entries(statusCounts).length - 1 ? ', ' : ''}
						{/each}
					{/if}
					{#if filteredPlans.length !== plans.length}
						&middot; Showing {filteredPlans.length} filtered
					{/if}
				</p>
			{/if}
		</div>
	</div>

	<!-- Filter controls -->
	<div class="flex flex-wrap gap-2 items-center" data-testid="plans-filters">
		<select
			bind:value={filterStatus}
			class="rounded-md border bg-background px-3 py-1.5 text-sm"
			data-testid="plans-status-filter"
		>
			<option value="all">All Status</option>
			<option value="draft">Draft</option>
			<option value="approved">Approved</option>
			<option value="active">Active</option>
			<option value="completed">Completed</option>
			<option value="rejected">Rejected</option>
		</select>
	</div>

	{#if error}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg text-sm" data-testid="error-message" role="alert">
			{error}
		</div>
	{/if}

	<!-- Plans list -->
	{#if loading}
		<div class="space-y-2" data-testid="plans-loading">
			{#each Array(3) as _}
				<div class="h-28 rounded-lg bg-muted ds-shimmer"></div>
			{/each}
		</div>
	{:else if filteredPlans.length === 0}
		<div class="flex flex-col items-center justify-center py-16" data-testid="plans-empty">
			<MapIcon class="size-12 text-muted-foreground/30 mb-4" />
			{#if plans.length === 0}
				<h2 class="text-lg font-medium text-muted-foreground mb-1">No plans yet</h2>
				<p class="text-sm text-muted-foreground">
					{#if isStaticMode()}
						No plan data available in the snapshot.
					{:else}
						Create plans with <code class="text-xs bg-muted px-1 py-0.5 rounded">kspec plan add</code> to track implementation progress.
					{/if}
				</p>
			{:else}
				<h2 class="text-lg font-medium text-muted-foreground mb-1">No matching plans</h2>
				<p class="text-sm text-muted-foreground">Try adjusting the filter above.</p>
			{/if}
		</div>
	{:else}
		<div class="flex flex-col gap-3" data-testid="plans-list">
			{#each filteredPlans as plan (plan._ulid)}
				<!-- AC: @ui-plans-view ac-1 — Plan card with all required fields -->
				<Card class="transition-all duration-200 hover:shadow-md" data-testid="plan-card">
					<CardHeader class="pb-3">
						<div class="flex items-start justify-between gap-4">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-1">
									<Badge
										class={PLAN_STATUS_COLORS[plan.status] ?? 'bg-muted text-muted-foreground'}
										data-testid="plan-status"
									>
										{PLAN_STATUS_LABELS[plan.status] ?? plan.status}
									</Badge>
									<h3 class="text-sm font-semibold truncate" data-testid="plan-title">{plan.title}</h3>
								</div>
							</div>
						</div>
					</CardHeader>
					<CardContent class="pt-0">
						<div class="flex flex-col gap-3">
							<!-- AC: @ui-plans-view ac-1 — Progress bar based on task completion status -->
							{#if plan.task_progress.total > 0}
								<div class="flex items-center gap-3">
									<div class="flex-1 h-2 rounded-full bg-muted overflow-hidden" data-testid="plan-progress-bar">
										<div
											class="h-full rounded-full transition-all duration-300 bg-[var(--design-status-completed)]"
											style="width: {progressPercent(plan)}%"
										></div>
									</div>
									<span class="text-xs font-medium text-muted-foreground whitespace-nowrap" data-testid="plan-progress-text">
										{progressPercent(plan)}% ({plan.task_progress.completed}/{plan.task_progress.total} tasks)
									</span>
								</div>
								<!-- Task status breakdown -->
								<div class="flex flex-wrap gap-2 text-xs text-muted-foreground" data-testid="plan-task-breakdown">
									{#if plan.task_progress.completed > 0}
										<span class="inline-flex items-center gap-1">
											<span class="inline-block size-2 rounded-full bg-[var(--design-status-completed)]"></span>
											{plan.task_progress.completed} completed
										</span>
									{/if}
									{#if plan.task_progress.in_progress > 0}
										<span class="inline-flex items-center gap-1">
											<span class="inline-block size-2 rounded-full bg-[var(--design-status-in-progress)]"></span>
											{plan.task_progress.in_progress} in progress
										</span>
									{/if}
									{#if plan.task_progress.pending > 0}
										<span class="inline-flex items-center gap-1">
											<span class="inline-block size-2 rounded-full bg-[var(--design-status-pending)]"></span>
											{plan.task_progress.pending} pending
										</span>
									{/if}
									{#if plan.task_progress.blocked > 0}
										<span class="inline-flex items-center gap-1">
											<span class="inline-block size-2 rounded-full bg-[var(--design-status-blocked)]"></span>
											{plan.task_progress.blocked} blocked
										</span>
									{/if}
								</div>
							{/if}

							<!-- Metadata row -->
							<div class="flex items-center gap-2 text-xs text-muted-foreground">
								<span data-testid="plan-created-at">{formatDate(plan.created_at)}</span>
								<span>&middot;</span>
								<span data-testid="plan-spec-count">{plan.spec_count} spec{plan.spec_count === 1 ? '' : 's'}</span>
								<span>&middot;</span>
								<span data-testid="plan-task-count">{plan.task_count} task{plan.task_count === 1 ? '' : 's'}</span>
								{#if plan.slugs.length > 0}
									<span>&middot;</span>
									<code class="text-xs bg-muted px-1 py-0.5 rounded" data-testid="plan-slug">@{plan.slugs[0]}</code>
								{/if}
							</div>
						</div>
					</CardContent>
				</Card>
			{/each}
		</div>
	{/if}
</div>
