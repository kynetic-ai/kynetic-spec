<!--
  AC: @ui-validation-view ac-1
  AC: @ui-data-freshness ac-1 — Renders from cache on revisit without loading state
  AC: @ui-data-freshness ac-3 — WebSocket events invalidate validation queries via centralized wiring
-->
<script lang="ts">
	// AC: @ui-validation-view ac-1
	import {
		fetchValidation,
		fetchValidationAggregation,
		type ValidationResponse,
		type CompletenessWarning
	} from '$lib/api';
	import type { ValidationAggregation } from '@kynetic-ai/shared';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import {
		ShieldCheck,
		ShieldAlert,
		AlertTriangle,
		AlertCircle,
		CheckCircle2,
		Info,
		Link2Off,
		FileWarning,
		RefreshCw
	} from 'lucide-svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';

	const queryClient = useQueryClient();

	// --- TanStack Query: validation data ---
	// AC: @ui-data-freshness ac-1 — createQuery caches; revisits render from cache
	// AC: @ui-data-freshness ac-2 — Concurrent uses share the same in-flight request
	const validationQuery = createQuery(() => ({
		queryKey: queryKeys.validation.results(),
		queryFn: () => fetchValidation(),
		enabled: isProjectInitialized(),
	}));

	// AC: @ui-api-aggregation ac-2 — Server-computed stats replace client-side fetchItems/fetchTasks
	const aggregationQuery = createQuery(() => ({
		queryKey: queryKeys.validation.aggregation(),
		queryFn: () => fetchValidationAggregation(),
		enabled: isProjectInitialized(),
	}));

	let validation = $derived<ValidationResponse | null>(validationQuery.data ?? null);
	let aggregation = $derived<ValidationAggregation | null>(aggregationQuery.data ?? null);
	let loading = $derived(validationQuery.isLoading || aggregationQuery.isLoading);
	let error = $derived(validationQuery.error?.message ?? aggregationQuery.error?.message ?? '');

	// --- Derived counts ---
	// AC: @ui-validation-view ac-1 — error count, warning count, valid item count

	let errorCount = $derived.by(() => {
		if (!validation) return 0;
		return (
			validation.schemaErrors.length +
			validation.refErrors.length +
			validation.traitCycles.length
		);
	});

	let warningCount = $derived.by(() => {
		if (!validation) return 0;
		return (
			validation.refWarnings.length +
			validation.completenessWarnings.length +
			validation.orphans.length
		);
	});

	// Stats from server-side aggregation — replaces manual fetchItems/fetchTasks
	let totalItemCount = $derived(aggregation?.entity_counts.items ?? 0);
	let totalAcCount = $derived(aggregation?.ac_counts.total ?? 0);
	let uncoveredAcCount = $derived(aggregation?.ac_counts.uncovered ?? 0);
	let orphanedTaskCount = $derived(aggregation?.orphan_count ?? 0);

	// AC: @ui-validation-view ac-1 — valid item count
	let validItemCount = $derived.by(() => {
		if (!validation) return 0;
		const itemsWithErrors = new Set<string>();
		for (const e of validation.schemaErrors) {
			if (e.file) itemsWithErrors.add(e.file);
		}
		for (const e of validation.refErrors) {
			const source = e.sourceUlid ?? e.sourceFile;
			if (source) itemsWithErrors.add(source);
		}
		for (const e of validation.traitCycles) {
			if (e.traitRef) itemsWithErrors.add(e.traitRef);
		}
		return Math.max(0, totalItemCount - itemsWithErrors.size);
	});

	// AC: @ui-validation-view ac-1 — spec coverage %, AC coverage %
	let specCoverage = $derived.by(() => {
		if (!aggregation || aggregation.stats.totalSpecs === 0) return 0;
		return Math.round(
			(aggregation.stats.specsWithTasks / aggregation.stats.totalSpecs) * 100
		);
	});

	// AC: @ui-validation-view ac-1 — AC coverage %
	let acCoverage = $derived.by(() => {
		if (totalAcCount === 0) return 100;
		const covered = totalAcCount - uncoveredAcCount;
		return Math.round((covered / totalAcCount) * 100);
	});

	// --- Group issues by severity ---

	type GroupedIssue = {
		severity: 'error' | 'warning' | 'info';
		category: string;
		message: string;
		detail?: string;
	};

	let groupedIssues = $derived.by((): GroupedIssue[] => {
		if (!validation && !aggregation) return [];
		const issues: GroupedIssue[] = [];

		if (validation) {
			for (const e of validation.schemaErrors) {
				issues.push({
					severity: 'error',
					category: 'Schema',
					message: e.message,
					detail: e.file + (e.path ? ` (${e.path})` : '')
				});
			}
			for (const e of validation.refErrors) {
				issues.push({
					severity: 'error',
					category: 'Reference',
					message: e.message,
					detail: `${e.ref} in ${e.field}`
				});
			}
			for (const e of validation.traitCycles) {
				issues.push({
					severity: 'error',
					category: 'Trait Cycle',
					message: e.message,
					detail: e.cycle.join(' → ')
				});
			}
			for (const w of validation.refWarnings) {
				issues.push({
					severity: 'warning',
					category: 'Reference',
					message: w.message,
					detail: `${w.ref} in ${w.field}`
				});
			}
			for (const w of validation.completenessWarnings) {
				issues.push({
					severity: 'warning',
					category: completenessLabel(w.type),
					message: w.message,
					detail: w.details ?? `${w.itemRef} — ${w.itemTitle}`
				});
			}
			for (const o of validation.orphans) {
				issues.push({
					severity: 'info',
					category: 'Orphan',
					message: `${o.title} (${o.type})`,
					detail: o.file ?? o.ulid
				});
			}
		}

		if (aggregation) {
			for (const w of aggregation.warnings) {
				issues.push({
					severity: w.type === 'status_mismatch' ? 'warning' : 'info',
					category: alignmentLabel(w.type),
					message: w.message,
					detail: w.specTitle ?? w.specUlid
				});
			}
		}

		return issues;
	});

	let errorIssues = $derived(groupedIssues.filter((i) => i.severity === 'error'));
	let warningIssues = $derived(groupedIssues.filter((i) => i.severity === 'warning'));
	let infoIssues = $derived(groupedIssues.filter((i) => i.severity === 'info'));

	function refreshAll() {
		queryClient.invalidateQueries({ queryKey: queryKeys.validation.all });
	}

	// --- Helpers ---

	function completenessLabel(type: string): string {
		const labels: Record<string, string> = {
			missing_acceptance_criteria: 'Missing AC',
			missing_description: 'Missing Description',
			status_inconsistency: 'Status Inconsistency',
			missing_test_coverage: 'Test Coverage',
			automation_eligible_no_spec: 'No Spec',
			ac_schema_field_mismatch: 'AC Schema Mismatch'
		};
		return labels[type] ?? type;
	}

	function alignmentLabel(type: string): string {
		const labels: Record<string, string> = {
			orphaned_spec: 'Orphaned Spec',
			status_mismatch: 'Status Mismatch',
			stale_implementation: 'Stale Implementation'
		};
		return labels[type] ?? type;
	}
</script>

<!-- AC: @ui-validation-view ac-1 -->
<div class="flex flex-col gap-6" data-testid="validate-page">
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<h1 class="text-3xl font-bold">Validate</h1>
			{#if !loading && validation}
				{#if validation.valid && errorCount === 0}
					<Badge class="bg-severity-success text-severity-success-fg" data-testid="status-valid">
						<CheckCircle2 class="mr-1 h-3 w-3" />
						Valid
					</Badge>
				{:else}
					<Badge class="bg-severity-error text-severity-error-fg" data-testid="status-invalid">
						<ShieldAlert class="mr-1 h-3 w-3" />
						Issues Found
					</Badge>
				{/if}
			{/if}
		</div>
		{#if !loading}
			<button
				class="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm
					text-muted-foreground transition-colors hover:bg-muted/50"
				onclick={refreshAll}
				data-testid="refresh-btn"
			>
				<RefreshCw class="h-3.5 w-3.5" />
				Refresh
			</button>
		{/if}
	</div>

	<!-- Error banner -->
	{#if error}
		<div
			class="rounded-md bg-severity-error-muted p-4 text-sm text-severity-error-muted-fg"
			role="alert"
			data-testid="error"
		>
			{error}
		</div>
	{/if}

	<!-- Loading state -->
	{#if loading}
		<div class="space-y-4" data-testid="loading">
			<div class="grid gap-4 md:grid-cols-3">
				{#each Array(3) as _}
					<Card>
						<CardHeader class="pb-2">
							<div class="h-4 w-24 rounded bg-muted ds-shimmer"></div>
						</CardHeader>
						<CardContent>
							<div class="h-8 w-16 rounded bg-muted ds-shimmer"></div>
						</CardContent>
					</Card>
				{/each}
			</div>
			<Card>
				<CardHeader class="pb-2">
					<div class="h-4 w-32 rounded bg-muted ds-shimmer"></div>
				</CardHeader>
				<CardContent class="space-y-3">
					{#each Array(3) as _}
						<div class="h-4 w-full rounded bg-muted ds-shimmer"></div>
					{/each}
				</CardContent>
			</Card>
		</div>

	<!-- Empty state (no data returned) -->
	{:else if !validation && !aggregation && !error}
		<div class="text-center text-muted-foreground py-12" data-testid="empty">
			<ShieldCheck class="mx-auto h-12 w-12 mb-4 opacity-50" />
			<p>No validation data available.</p>
			<p class="text-sm">Connect to a running daemon to run validation.</p>
		</div>

	<!-- Data loaded -->
	{:else}
		<!-- Summary Cards -->
		<!-- AC: @ui-validation-view ac-1 — error count, warning count, valid item count -->
		<div class="grid gap-4 md:grid-cols-3" data-testid="summary-cards">
			<Card data-testid="error-count-card">
				<CardHeader class="flex flex-row items-center justify-between pb-2 space-y-0">
					<CardTitle class="text-sm font-medium">Errors</CardTitle>
					<AlertCircle class="h-4 w-4 text-severity-error" />
				</CardHeader>
				<CardContent>
					<div class="text-2xl font-bold" class:text-severity-error={errorCount > 0}>
						{errorCount}
					</div>
					<p class="text-xs text-muted-foreground">
						Schema, reference, and trait cycle errors
					</p>
				</CardContent>
			</Card>

			<Card data-testid="warning-count-card">
				<CardHeader class="flex flex-row items-center justify-between pb-2 space-y-0">
					<CardTitle class="text-sm font-medium">Warnings</CardTitle>
					<AlertTriangle class="h-4 w-4 text-severity-warning" />
				</CardHeader>
				<CardContent>
					<div class="text-2xl font-bold" class:text-severity-warning={warningCount > 0}>
						{warningCount}
					</div>
					<p class="text-xs text-muted-foreground">
						Completeness, orphans, and reference warnings
					</p>
				</CardContent>
			</Card>

			<Card data-testid="valid-count-card">
				<CardHeader class="flex flex-row items-center justify-between pb-2 space-y-0">
					<CardTitle class="text-sm font-medium">Valid Items</CardTitle>
					<CheckCircle2 class="h-4 w-4 text-severity-success" />
				</CardHeader>
				<CardContent>
					<div class="text-2xl font-bold" data-testid="valid-item-count">
						{validItemCount}
					</div>
					<p class="text-xs text-muted-foreground">
						{validItemCount} of {totalItemCount} items passing validation
					</p>
				</CardContent>
			</Card>
		</div>

		<!-- Alignment Section -->
		<!-- AC: @ui-validation-view ac-1 — spec coverage %, AC coverage %, orphaned tasks/specs counts -->
		{#if aggregation}
			<Card data-testid="alignment-section">
				<CardHeader>
					<CardTitle class="flex items-center gap-2">
						<Link2Off class="h-5 w-5" />
						Alignment
					</CardTitle>
				</CardHeader>
				<CardContent>
					<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
						<div class="space-y-1" data-testid="spec-coverage">
							<p class="text-sm text-muted-foreground">Spec Coverage</p>
							<div class="flex items-baseline gap-2">
								<span class="text-2xl font-bold">{specCoverage}%</span>
								<span class="text-xs text-muted-foreground">
									{aggregation.stats.specsWithTasks}/{aggregation.stats.totalSpecs} specs with tasks
								</span>
							</div>
							<div class="h-2 w-full rounded-full bg-muted overflow-hidden">
								<div
									class="h-full rounded-full transition-all bg-severity-success"
									style="width: {specCoverage}%"
								></div>
							</div>
						</div>

						<div class="space-y-1" data-testid="ac-coverage">
							<p class="text-sm text-muted-foreground">AC Coverage</p>
							<div class="flex items-baseline gap-2">
								<span class="text-2xl font-bold">{acCoverage}%</span>
								<span class="text-xs text-muted-foreground">
									{totalAcCount - uncoveredAcCount}/{totalAcCount} ACs with tests
								</span>
							</div>
							<div class="h-2 w-full rounded-full bg-muted overflow-hidden">
								<div
									class="h-full rounded-full transition-all bg-severity-info"
									style="width: {acCoverage}%"
								></div>
							</div>
						</div>

						<div class="space-y-1" data-testid="orphaned-tasks">
							<p class="text-sm text-muted-foreground">Orphaned Tasks</p>
							<div class="flex items-baseline gap-2">
								<span class="text-2xl font-bold"
									class:text-severity-warning={orphanedTaskCount > 0}
								>
									{orphanedTaskCount}
								</span>
								<span class="text-xs text-muted-foreground">
									tasks without linked specs
								</span>
							</div>
						</div>

						<div class="space-y-1" data-testid="orphaned-specs">
							<p class="text-sm text-muted-foreground">Orphaned Specs</p>
							<div class="flex items-baseline gap-2">
								<span class="text-2xl font-bold"
									class:text-severity-warning={aggregation.stats.orphanedSpecs > 0}
								>
									{aggregation.stats.orphanedSpecs}
								</span>
								<span class="text-xs text-muted-foreground">
									specs without linked tasks
								</span>
							</div>
						</div>
					</div>
				</CardContent>
			</Card>
		{/if}

		<!-- Issues List -->
		<!-- AC: @ui-validation-view ac-1 — Issues list grouped by severity -->
		{#if groupedIssues.length > 0}
			<div class="space-y-4" data-testid="issues-list">
				<h2 class="text-xl font-semibold flex items-center gap-2">
					<FileWarning class="h-5 w-5" />
					Issues ({groupedIssues.length})
				</h2>

				<!-- Errors group -->
				{#if errorIssues.length > 0}
					<div data-testid="error-issues">
						<h3 class="text-sm font-medium text-severity-error mb-2 flex items-center gap-1.5">
							<AlertCircle class="h-4 w-4" />
							Errors ({errorIssues.length})
						</h3>
						<div class="space-y-2">
							{#each errorIssues as issue}
								<div class="rounded-md border p-3 bg-severity-error-muted border-severity-error-border" data-testid="issue-error">
									<div class="flex items-start gap-2">
										<AlertCircle class="h-4 w-4 mt-0.5 text-severity-error shrink-0" />
										<div class="min-w-0">
											<div class="flex items-center gap-2 flex-wrap">
												<Badge variant="outline" class="text-xs">{issue.category}</Badge>
												<span class="text-sm font-medium">{issue.message}</span>
											</div>
											{#if issue.detail}
												<p class="text-xs text-muted-foreground mt-1 font-mono truncate">
													{issue.detail}
												</p>
											{/if}
										</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Warnings group -->
				{#if warningIssues.length > 0}
					<div data-testid="warning-issues">
						<h3 class="text-sm font-medium text-severity-warning-muted-fg mb-2 flex items-center gap-1.5">
							<AlertTriangle class="h-4 w-4" />
							Warnings ({warningIssues.length})
						</h3>
						<div class="space-y-2">
							{#each warningIssues as issue}
								<div class="rounded-md border p-3 bg-severity-warning-muted border-severity-warning-border" data-testid="issue-warning">
									<div class="flex items-start gap-2">
										<AlertTriangle class="h-4 w-4 mt-0.5 text-severity-warning-muted-fg shrink-0" />
										<div class="min-w-0">
											<div class="flex items-center gap-2 flex-wrap">
												<Badge variant="outline" class="text-xs">{issue.category}</Badge>
												<span class="text-sm font-medium">{issue.message}</span>
											</div>
											{#if issue.detail}
												<p class="text-xs text-muted-foreground mt-1 font-mono truncate">
													{issue.detail}
												</p>
											{/if}
										</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Info group -->
				{#if infoIssues.length > 0}
					<div data-testid="info-issues">
						<h3 class="text-sm font-medium text-severity-info mb-2 flex items-center gap-1.5">
							<Info class="h-4 w-4" />
							Info ({infoIssues.length})
						</h3>
						<div class="space-y-2">
							{#each infoIssues as issue}
								<div class="rounded-md border p-3 bg-severity-info-muted border-severity-info-border" data-testid="issue-info">
									<div class="flex items-start gap-2">
										<Info class="h-4 w-4 mt-0.5 text-severity-info shrink-0" />
										<div class="min-w-0">
											<div class="flex items-center gap-2 flex-wrap">
												<Badge variant="outline" class="text-xs">{issue.category}</Badge>
												<span class="text-sm font-medium">{issue.message}</span>
											</div>
											{#if issue.detail}
												<p class="text-xs text-muted-foreground mt-1 font-mono truncate">
													{issue.detail}
												</p>
											{/if}
										</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		{:else if !error}
			<Card data-testid="no-issues">
				<CardContent class="py-8">
					<div class="text-center text-muted-foreground">
						<CheckCircle2 class="mx-auto h-12 w-12 mb-4 text-severity-success opacity-75" />
						<p class="font-medium">No issues found</p>
						<p class="text-sm">All validation checks passed.</p>
					</div>
				</CardContent>
			</Card>
		{/if}
	{/if}
</div>
