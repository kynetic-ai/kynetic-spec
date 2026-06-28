<!--
	AC: @unified-spec-workspace-navigation ac-stable-node-urls
	AC: @unified-spec-workspace-navigation ac-existing-ref-links-compatible
	AC: @unified-spec-workspace-navigation ac-dual-gesture-row
	AC: @unified-spec-workspace-navigation ac-touch-and-keyboard-open
	AC: @unified-spec-workspace-navigation ac-expansion-state-preserved
	AC: @unified-spec-workspace-navigation ac-multi-branch-expansion
	AC: @unified-spec-workspace-navigation ac-page-children-use-same-rows
	AC: @unified-spec-workspace-navigation ac-no-horizontal-scroll
	AC: @spec-workspace-delivery-quality ac-url-state-via-goto
	AC: @spec-node-criterion-workspace-pages ac-root-page
	AC: @spec-node-criterion-workspace-pages ac-module-feature-requirement-pages
	AC: @spec-node-criterion-workspace-pages ac-requirement-ac-list
	AC: @spec-node-criterion-workspace-pages ac-criterion-page
	AC: @spec-node-criterion-workspace-pages ac-linked-work-strip
	AC: @spec-node-criterion-workspace-pages ac-empty-and-missing-sections
	AC: @spec-node-criterion-workspace-pages ac-read-navigation-scope
	AC: @spec-workspace-coverage-resolution-panels ac-resolution-visibility
	AC: @spec-workspace-coverage-resolution-panels ac-dry-run-before-apply
	AC: @spec-workspace-coverage-resolution-panels ac-explicit-reverify-action
	AC: @spec-workspace-coverage-resolution-panels ac-spec-text-revert-action
	AC: @spec-workspace-coverage-resolution-panels ac-dispatch-fix-action
	AC: @spec-workspace-coverage-resolution-panels ac-readonly-resolution-refusal
	AC: @spec-workspace-coverage-resolution-panels ac-resolution-event-refresh
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import type { RefType } from '$lib/utils/reference';
	import type {
		CoverageBucketCounts,
		SpecWorkspaceCriterionSummary,
		SpecWorkspaceLinkedWorkGroup,
		SpecWorkspaceLinkedWorkItem,
		SpecWorkspaceNodeDetailProjection,
		SpecWorkspaceNodeSummary
	} from '@kynetic-ai/shared';
	import type {
		CoverageResolutionAction,
		CoverageResolutionResponse
	} from '$lib/spec-workspace/coverage-resolution';
	import { Badge } from '$lib/components/ui/badge';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import CacheWarmingBanner from '$lib/components/CacheWarmingBanner.svelte';
	import BreadcrumbNav from '$lib/components/BreadcrumbNav.svelte';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import SpecWorkspaceRows from '$lib/components/SpecWorkspaceRows.svelte';
	import { StatusBadge, ViewHeader, type ViewHeaderCount } from '$lib/components/ds';
	import { statusBadgeClass } from '$lib/ds/status-tokens';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import { queryKeys } from '$lib/query/keys.js';
	import {
		buildCoverageReadiness,
		buildCoverageRollup,
		buildCoverageStateFilters,
		buildReverifySummary,
		filterCriteriaByCoverageState,
		isCoverageFilterState,
		presentationForCriterion,
		type CoverageFilterState
	} from '$lib/spec-workspace/coverage-presentation';
	import {
		buildCoverageResolutionPanelModel,
		coverageResolutionTarget,
		resolutionEffectSummary,
		storedResultMessage,
		taskEffectsFromResolution
	} from '$lib/spec-workspace/coverage-resolution';
	import {
		CoverageResolutionApiError,
		fetchSpecWorkspaceCriterion,
		fetchSpecWorkspaceNode,
		fetchSpecWorkspaceRoot,
		isCacheWarmingError,
		resolveCoverageResolution
	} from '$lib/api';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { cn } from '$lib/utils';
	import { renderInlineMarkdown, renderMarkdown } from '$lib/utils/markdown';
	import { normalizeRef } from '$lib/utils/reference';
	import CheckCircle2 from 'lucide-svelte/icons/check-circle-2';
	import ChevronLeft from 'lucide-svelte/icons/chevron-left';
	import ExternalLink from 'lucide-svelte/icons/external-link';
	import Eye from 'lucide-svelte/icons/eye';
	import RotateCw from 'lucide-svelte/icons/rotate-cw';
	import Undo2 from 'lucide-svelte/icons/undo-2';
	import Wrench from 'lucide-svelte/icons/wrench';

	const MAX_EXPANDED_REFS = 80;
	const WORKSPACE_PAGE_SIZE = 100;
	const EXPANSION_EVICTED_PARAM = 'expandedEvicted';

	let expandedDetails = $state(new Map<string, SpecWorkspaceNodeDetailProjection>());
	let expandedLoading = $state(new Set<string>());
	let expandedErrors = $state(new Map<string, string>());
	let expandedCriteria = $state(new Set<string>());
	let resolutionActiveKey = $state<string | null>(null);
	let resolutionSelectedAction = $state<CoverageResolutionAction | null>(null);
	let resolutionPreview = $state<CoverageResolutionResponse | null>(null);
	let resolutionResult = $state<CoverageResolutionResponse | null>(null);
	let resolutionError = $state<string | null>(null);
	let resolutionSuggestion = $state<string | null>(null);
	let resolutionConflictFingerprint = $state<string | null>(null);
	let resolutionBusy = $state(false);
	let resolutionApplying = $state(false);
	let lastResolutionTargetKey = $state<string | null>(null);

	let focusedNodeRef = $derived.by(() => {
		const node = $page.url.searchParams.get('node');
		const legacyRef = $page.url.searchParams.get('ref');
		return node ?? legacyRef;
	});
	let focusedCriterionId = $derived($page.url.searchParams.get('ac'));
	let planFilter = $derived($page.url.searchParams.get('plan') ?? undefined);
	let coverageFilter = $derived(parseCoverageFilter($page.url.searchParams.get('coverage')));
	let expandedRefParts = $derived(parseExpandedRefParts($page.url.searchParams.get('expanded')));
	let expansionEvictedByUrl = $derived(Math.max(0, expandedRefParts.length - MAX_EXPANDED_REFS));
	let expansionEvictedByMutation = $derived(parseEvictedCount($page.url.searchParams.get(EXPANSION_EVICTED_PARAM)));
	let expansionEvictedCount = $derived(Math.max(expansionEvictedByUrl, expansionEvictedByMutation));
	let expandedRefs = $derived(parseExpandedRefs($page.url.searchParams.get('expanded')));

	const rootQuery = createQuery(() => ({
		queryKey: queryKeys.specWorkspace.root({ limit: WORKSPACE_PAGE_SIZE, plan: planFilter }),
		queryFn: () => fetchSpecWorkspaceRoot({ limit: WORKSPACE_PAGE_SIZE, plan: planFilter }),
		enabled: isProjectInitialized()
	}));

	const nodeQuery = createQuery(() => ({
		queryKey: focusedNodeRef
			? queryKeys.specWorkspace.node(focusedNodeRef, { limit: WORKSPACE_PAGE_SIZE })
			: queryKeys.specWorkspace.node('__none__', { limit: WORKSPACE_PAGE_SIZE }),
		queryFn: () => fetchSpecWorkspaceNode(focusedNodeRef ?? '', { limit: WORKSPACE_PAGE_SIZE }),
		enabled: isProjectInitialized() && Boolean(focusedNodeRef) && !focusedCriterionId
	}));

	const criterionQuery = createQuery(() => ({
		queryKey:
			focusedNodeRef && focusedCriterionId
				? queryKeys.specWorkspace.criterion(focusedNodeRef, focusedCriterionId)
				: queryKeys.specWorkspace.criterion('__none__', '__none__'),
		queryFn: () => fetchSpecWorkspaceCriterion(focusedNodeRef ?? '', focusedCriterionId ?? ''),
		enabled: isProjectInitialized() && Boolean(focusedNodeRef) && Boolean(focusedCriterionId)
	}));

	let root = $derived(rootQuery.data ?? null);
	let focusedNode = $derived(nodeQuery.data ?? null);
	let focusedCriterion = $derived(criterionQuery.data ?? null);
	let rootLoading = $derived(rootQuery.isLoading || rootQuery.isFetching);
	let nodeLoading = $derived(nodeQuery.isLoading || nodeQuery.isFetching);
	let criterionLoading = $derived(criterionQuery.isLoading || criterionQuery.isFetching);
	let rootCacheWarming = $derived(isCacheWarmingError(rootQuery.error));
	let rootError = $derived(rootCacheWarming ? null : (rootQuery.error?.message ?? null));
	let focusedError = $derived(
		focusedCriterionId
			? criterionQuery.error?.message
			: focusedNodeRef
				? nodeQuery.error?.message
				: null
	);
	let readOnlyMode = $derived(isStaticMode());
	let focusedResolutionTargetKey = $derived(
		focusedCriterion
			? `${focusedCriterion.parent.ref}::${focusedCriterion.criterion.id}::${focusedCriterion.coverage?.state ?? 'none'}`
			: null
	);

	function parseExpandedRefParts(value: string | null): string[] {
		if (!value) return [];
		return value
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean);
	}

	function parseExpandedRefs(value: string | null): Set<string> {
		return new Set(parseExpandedRefParts(value).slice(-MAX_EXPANDED_REFS));
	}

	function parseEvictedCount(value: string | null): number {
		const count = Number(value);
		return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
	}

	function parseCoverageFilter(value: string | null): CoverageFilterState {
		return isCoverageFilterState(value) ? value : 'all';
	}

	function withWorkspaceState(updater: (url: URL) => void, options?: { replaceState?: boolean }) {
		const url = new URL($page.url);
		updater(url);
		goto(url, { replaceState: options?.replaceState ?? false, keepFocus: true, noScroll: true });
	}

	function setExpandedRefs(url: URL, refs: Set<string>) {
		const allRefs = [...refs];
		const evicted = Math.max(0, allRefs.length - MAX_EXPANDED_REFS);
		const bounded = allRefs.slice(-MAX_EXPANDED_REFS);
		if (bounded.length > 0) {
			url.searchParams.set('expanded', bounded.join(','));
		} else {
			url.searchParams.delete('expanded');
		}
		if (evicted > 0) {
			url.searchParams.set(EXPANSION_EVICTED_PARAM, String(evicted));
		} else {
			url.searchParams.delete(EXPANSION_EVICTED_PARAM);
		}
	}

	function nodeHref(node: SpecWorkspaceNodeSummary): string {
		const url = new URL($page.url);
		url.pathname = `${base}/specs`;
		url.searchParams.set('node', node.ref);
		url.searchParams.delete('ref');
		url.searchParams.delete('ac');
		return `${url.pathname}${url.search}${url.hash}`;
	}

	function criterionHref(parentRef: string, criterionId: string): string {
		const url = new URL($page.url);
		url.pathname = `${base}/specs`;
		url.searchParams.set('node', parentRef);
		url.searchParams.set('ac', criterionId);
		url.searchParams.delete('ref');
		return `${url.pathname}${url.search}${url.hash}`;
	}

	function clearFocusedPage() {
		withWorkspaceState((url) => {
			url.searchParams.delete('node');
			url.searchParams.delete('ref');
			url.searchParams.delete('ac');
			url.searchParams.delete('coverage');
		});
	}

	function setCoverageFilter(filter: CoverageFilterState) {
		withWorkspaceState((url) => {
			if (filter === 'all') {
				url.searchParams.delete('coverage');
			} else {
				url.searchParams.set('coverage', filter);
			}
		}, { replaceState: true });
	}

	async function toggleNode(node: SpecWorkspaceNodeSummary) {
		if (node.child_count === 0) return;
		const nextExpanded = new Set(expandedRefs);
		if (nextExpanded.has(node.ref)) {
			nextExpanded.delete(node.ref);
		} else {
			nextExpanded.add(node.ref);
			await ensureNodeDetail(node.ref);
		}
		withWorkspaceState((url) => setExpandedRefs(url, nextExpanded), { replaceState: true });
	}

	async function ensureNodeDetail(ref: string) {
		if (expandedDetails.has(ref) || expandedLoading.has(ref)) return;
		expandedLoading = new Set(expandedLoading).add(ref);
		const nextErrors = new Map(expandedErrors);
		nextErrors.delete(ref);
		expandedErrors = nextErrors;
		try {
			const detail = await fetchSpecWorkspaceNode(ref, { limit: WORKSPACE_PAGE_SIZE });
			const nextDetails = new Map(expandedDetails);
			nextDetails.set(ref, detail);
			expandedDetails = nextDetails;
		} catch (err) {
			const errors = new Map(expandedErrors);
			errors.set(ref, err instanceof Error ? err.message : 'Failed to load child nodes');
			expandedErrors = errors;
		} finally {
			const loading = new Set(expandedLoading);
			loading.delete(ref);
			expandedLoading = loading;
		}
	}

	$effect(() => {
		for (const ref of expandedRefs) {
			ensureNodeDetail(ref).catch(() => {
				// ensureNodeDetail records per-node load failures for display.
			});
		}
	});

	$effect(() => {
		if (focusedResolutionTargetKey !== lastResolutionTargetKey) {
			clearResolutionState(true);
			lastResolutionTargetKey = focusedResolutionTargetKey;
		}
	});

	function toggleCriterion(id: string) {
		const next = new Set(expandedCriteria);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		expandedCriteria = next;
	}

	function criterionLabel(criterion: SpecWorkspaceCriterionSummary): string {
		const text = criterion.given.replace(/\s+/g, ' ').trim();
		return text.length > 90 ? `${text.slice(0, 87)}...` : text;
	}

	function nodeCounts(node: SpecWorkspaceNodeSummary): ViewHeaderCount[] {
		return [
			{ label: 'children', value: node.child_count, testid: 'spec-child-count' },
			{ label: 'criteria', value: node.acceptance_criteria_count, testid: 'spec-ac-count' },
			{
				label: 'linked work',
				value: Object.values(node.linked_work_counts).reduce((sum, count) => sum + count, 0),
				testid: 'spec-linked-work-count'
			}
		];
	}

	function rootCounts(): ViewHeaderCount[] {
		if (!root) return [];
		return [
			{ label: 'items', value: root.corpus.items, testid: 'spec-corpus-items' },
			{ label: 'criteria', value: root.corpus.acceptance_criteria, testid: 'spec-corpus-ac' },
			{
				label: 'coverage denominator',
				value: root.coverage_summary.denominator,
				testid: 'spec-coverage-denominator'
			}
		];
	}

	function statusState(node: SpecWorkspaceNodeSummary): string | undefined {
		return typeof node.status === 'string' ? node.status : node.status?.implementation;
	}

	function linkedWorkHref(item: { kind: string; ref: string }): string {
		const encoded = encodeURIComponent(item.ref);
		if (item.kind === 'task') return `${base}/tasks/board?ref=${encoded}`;
		if (item.kind === 'session') return `${base}/sessions/${normalizeRef(item.ref)}`;
		if (item.kind === 'plan') return `${base}/plans?ref=${encoded}`;
		if (item.kind === 'review') return `${base}/reviews/${normalizeRef(item.ref)}`;
		return `${base}/observations`;
	}

	function linkedWorkLabel(kind: SpecWorkspaceLinkedWorkItem['kind']): string {
		if (kind === 'task') return 'Tasks';
		if (kind === 'session') return 'Sessions';
		if (kind === 'plan') return 'Plans';
		if (kind === 'review') return 'Reviews';
		return 'Observations';
	}

	function linkedWorkRefType(kind: SpecWorkspaceLinkedWorkItem['kind']): RefType | null {
		if (kind === 'task') return 'task';
		if (kind === 'session') return 'session';
		if (kind === 'plan') return 'plan';
		if (kind === 'review') return 'review';
		return null;
	}

	function criterionEvidenceCount(criterion: SpecWorkspaceCriterionSummary): number {
		const coverage = criterion.coverage;
		return (
			(coverage?.latest_run_evidence.length ?? 0) +
			(coverage?.unmapped_result_references.length ?? 0) +
			(coverage?.freshness.secondary_causes.length ?? 0)
		);
	}

	function criterionEvidenceLabel(criterion: SpecWorkspaceCriterionSummary): string {
		const count = criterionEvidenceCount(criterion);
		if (count === 0) return 'No evidence yet';
		return `${count} evidence ${count === 1 ? 'entry' : 'entries'}`;
	}

	function linkedWorkGroup(
		groups: SpecWorkspaceLinkedWorkGroup[],
		kind: SpecWorkspaceLinkedWorkItem['kind']
	): SpecWorkspaceLinkedWorkGroup | undefined {
		return groups.find((group) => group.kind === kind);
	}

	function resolutionPanelKey(parentRef: string, criterion: SpecWorkspaceCriterionSummary): string {
		return `${parentRef}::${criterion.id}`;
	}

	function clearResolutionState(clearSelection: boolean) {
		if (clearSelection) {
			resolutionActiveKey = null;
			resolutionSelectedAction = null;
		}
		resolutionPreview = null;
		resolutionResult = null;
		resolutionError = null;
		resolutionSuggestion = null;
		resolutionConflictFingerprint = null;
		resolutionBusy = false;
		resolutionApplying = false;
	}

	function recordResolutionError(err: unknown) {
		if (err instanceof CoverageResolutionApiError) {
			resolutionError = err.message;
			resolutionSuggestion = err.suggestion;
			resolutionConflictFingerprint = err.currentFingerprint;
			if (err.response) {
				resolutionPreview = err.response;
			}
			return;
		}
		resolutionError = err instanceof Error ? err.message : 'Coverage resolution failed.';
		resolutionSuggestion = 'Refresh coverage state and retry the requested resolution action.';
		resolutionConflictFingerprint = null;
	}

	async function previewResolution(
		action: CoverageResolutionAction,
		parentRef: string,
		criterion: SpecWorkspaceCriterionSummary
	) {
		const key = resolutionPanelKey(parentRef, criterion);
		resolutionActiveKey = key;
		resolutionSelectedAction = action;
		clearResolutionState(false);
		resolutionBusy = true;
		try {
			resolutionPreview = await resolveCoverageResolution(action, {
				target: coverageResolutionTarget({ parentRef, criterion }),
				dry_run: true
			});
		} catch (err) {
			recordResolutionError(err);
		} finally {
			resolutionBusy = false;
		}
	}

	async function applyResolution(parentRef: string, criterion: SpecWorkspaceCriterionSummary) {
		if (!resolutionSelectedAction || !resolutionPreview) return;
		resolutionApplying = true;
		resolutionError = null;
		resolutionSuggestion = null;
		resolutionConflictFingerprint = null;
		try {
			const action = resolutionSelectedAction;
			resolutionResult = await resolveCoverageResolution(action, {
				target: coverageResolutionTarget({ parentRef, criterion }),
				expected_current_fingerprint:
					action === 'spec-text-revert'
						? resolutionPreview.target.current_fingerprint
						: undefined
			});
			resolutionPreview = null;
			await Promise.all([
				rootQuery.refetch(),
				nodeQuery.refetch(),
				...(focusedCriterionId ? [criterionQuery.refetch()] : [])
			]);
		} catch (err) {
			recordResolutionError(err);
		} finally {
			resolutionApplying = false;
		}
	}

</script>

{#snippet loadingRows()}
	<div class="space-y-3">
		<Skeleton class="h-14 w-full" />
		<Skeleton class="h-14 w-full" />
		<Skeleton class="h-14 w-full" />
		<Skeleton class="h-14 w-4/5" />
	</div>
{/snippet}

{#snippet criterionCoverageBadge(criterion: SpecWorkspaceCriterionSummary)}
	<StatusBadge
		domain="coverage"
		state={presentationForCriterion(criterion)}
		testid="test-coverage-indicator"
	/>
{/snippet}

{#snippet emptyState(message: string, testid = 'section-empty')}
	<p
		class="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground"
		data-testid={testid}
	>
		{message}
	</p>
{/snippet}

{#snippet coverageRollup(counts: CoverageBucketCounts, denominator: number, testid = 'coverage-rollup')}
	{@const rollup = buildCoverageRollup(counts, denominator)}
	<div class="min-w-0 space-y-2" data-testid={testid}>
		<div
			class="flex h-2.5 overflow-hidden rounded-full bg-muted"
			aria-label={`Coverage rollup: ${rollup.denominator} criteria`}
		>
			{#each rollup.segments as segment (segment.state)}
				<span
					class={statusBadgeClass(segment.family)}
					style={`width: ${segment.percent}%;`}
					title={`${segment.label}: ${segment.count}`}
				></span>
			{/each}
		</div>
		<div class="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
			{#each rollup.segments as segment (segment.state)}
				<div class="min-w-0 rounded-md bg-muted/45 px-3 py-2" data-testid={`coverage-count-${segment.state}`}>
					<div class="mb-1 flex min-w-0 items-center justify-between gap-2">
						<StatusBadge
							domain="coverage"
							state={segment.state}
							class="px-1.5 py-0 text-[10px]"
						/>
						<span class="shrink-0 text-xs text-muted-foreground">{segment.percent}%</span>
					</div>
					<p class="text-lg font-semibold">{segment.count}</p>
				</div>
			{/each}
		</div>
	</div>
{/snippet}

{#snippet coverageReadinessNotice(readiness: ReturnType<typeof buildCoverageReadiness>)}
	{#if readiness.state !== 'ready'}
		<div
			class="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
			data-testid={`coverage-readiness-${readiness.state}`}
			role="status"
		>
			<div class="flex min-w-0 flex-wrap items-center gap-2">
				<Badge variant="outline" class="shrink-0">Coverage {readiness.state}</Badge>
				<p class="min-w-0 text-muted-foreground">{readiness.message}</p>
			</div>
			{#if readiness.suggestion}
				<p class="mt-1 text-xs text-muted-foreground">{readiness.suggestion}</p>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet reverifyBanner(criteria: SpecWorkspaceCriterionSummary[], scopeRef: string, acId?: string)}
	{@const summary = buildReverifySummary(criteria, scopeRef, `${base}/validate`, acId)}
	{#if summary.count > 0}
		<div
			class="rounded-md border border-severity-warning/40 bg-severity-warning/10 px-3 py-2 text-sm"
			data-testid="reverify-banner"
			role="status"
		>
			<div class="flex min-w-0 flex-wrap items-center gap-2">
				<StatusBadge domain="coverage" state="re_verify" />
				<p class="min-w-0 font-medium">
					{summary.count} {summary.count === 1 ? 'criterion needs' : 'criteria need'} re-verification.
				</p>
				<a
					href={summary.href}
					class="ml-auto shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					data-testid="reverify-validate-link"
				>
					Open Validate
				</a>
			</div>
			<p class="mt-1 text-xs text-muted-foreground" data-testid="reverify-cause-summary">
				{summary.causeLabels.length > 0 ? summary.causeLabels.join(', ') : 'No secondary cause details reported.'}
			</p>
		</div>
	{/if}
{/snippet}

{#snippet coverageSummary()}
	{#if root}
		{@const readiness = buildCoverageReadiness({
			cacheWarming: rootCacheWarming,
			unavailableSections: root.unavailable_sections
		})}
		<section class="min-w-0 rounded-md border border-border p-3" data-testid="root-coverage-summary">
			<div class="mb-2 flex min-w-0 items-center justify-between gap-3">
				<h2 class="text-sm font-semibold">Coverage Summary</h2>
				<span class="shrink-0 text-xs text-muted-foreground">
					{root.coverage_summary.denominator} criteria
				</span>
			</div>
			<div class="space-y-3">
				{@render coverageReadinessNotice(readiness)}
				{@render coverageRollup(root.coverage_summary.counts, root.coverage_summary.denominator, 'root-coverage-rollup')}
			</div>
		</section>
	{/if}
{/snippet}

{#snippet focusedActions()}
	{#if focusedNodeRef}
		<button
			type="button"
			class="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			onclick={clearFocusedPage}
			aria-label="Close focused workspace page"
		>
			<ChevronLeft class="size-4" aria-hidden="true" />
			Close
		</button>
	{/if}
{/snippet}

{#snippet rootWorkspacePage()}
	<div class="min-w-0 space-y-5" data-testid="spec-detail-panel">
		<ViewHeader reference="specs" title="Specs" titleTestid="spec-title" counts={rootCounts()} />
		<p class="text-sm text-muted-foreground">
			Explore the spec corpus from the tree or open a top-level row as a focused workspace page.
		</p>

		{#if rootCacheWarming}
			{@render coverageReadinessNotice(buildCoverageReadiness({
				cacheWarming: true,
				unavailableSections: []
			}))}
		{/if}

		{#if root}
			{@render coverageSummary()}

			<section class="min-w-0" data-testid="root-type-summary">
				<h2 class="mb-2 text-sm font-semibold">Corpus by Type</h2>
				<div class="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-4">
					{#each Object.entries(root.corpus.by_type) as [type, count] (type)}
						<div class="rounded-md border border-border px-3 py-2">
							<p class="truncate text-sm font-medium">{type}</p>
							<p class="text-2xl font-semibold">{count}</p>
						</div>
					{/each}
				</div>
			</section>

			<section class="min-w-0" data-testid="root-top-level-rows">
				<div class="mb-2 flex min-w-0 items-center justify-between gap-3">
					<h2 class="text-sm font-semibold">Top-level Specs</h2>
					<span class="shrink-0 text-xs text-muted-foreground">{root.pagination.total}</span>
				</div>
				<SpecWorkspaceRows
					nodes={root.top_level_nodes}
					{expandedRefs}
					{expandedDetails}
					{expandedLoading}
					{expandedErrors}
					focusedRef={focusedNodeRef}
					nodeHref={nodeHref}
					onToggle={toggleNode}
				/>
			</section>
		{:else}
			{@render emptyState('Spec corpus summary is unavailable while the workspace loads.')}
		{/if}
	</div>
{/snippet}

{#snippet nodeWorkspacePage(detail: SpecWorkspaceNodeDetailProjection)}
	<div class="min-w-0 space-y-5" data-testid="spec-detail-panel">
		<BreadcrumbNav ancestors={detail.ancestors} />
		<ViewHeader
			reference={detail.node.ref}
			title={detail.node.title}
			titleTestid="spec-title"
			statusDomain={statusState(detail.node) ? 'spec-implementation' : undefined}
			statusState={statusState(detail.node)}
			statusTestid="implementation-status"
			counts={nodeCounts(detail.node)}
			actions={focusedActions}
		/>

		{@render coverageReadinessNotice(buildCoverageReadiness({
			cacheWarming: false,
			unavailableSections: detail.unavailable_sections
		}))}

		{#if detail.node.coverage && detail.node.coverage.denominator > 0}
			<section class="min-w-0 rounded-md border border-border p-3" data-testid="node-coverage-summary">
				<div class="mb-2 flex min-w-0 items-center justify-between gap-3">
					<h2 class="text-sm font-semibold">Coverage Rollup</h2>
					<span class="shrink-0 text-xs text-muted-foreground">
						{detail.node.coverage.denominator} criteria
					</span>
				</div>
				<div class="space-y-3">
					{@render coverageRollup(detail.node.coverage.counts, detail.node.coverage.denominator, 'node-coverage-rollup')}
				</div>
			</section>
		{/if}

		{@render reverifyBanner(detail.acceptance_criteria, detail.node.ref)}

		{#if detail.description}
			<section
				class="prose prose-sm max-w-none overflow-hidden text-muted-foreground dark:prose-invert"
				data-testid="spec-description"
			>
				{@html renderMarkdown(detail.description)}
			</section>
		{/if}

		{#if detail.node.tags.length > 0}
			<section class="min-w-0">
				<h2 class="mb-2 text-sm font-semibold">Tags</h2>
				<div class="flex min-w-0 flex-wrap gap-1">
					{#each detail.node.tags as tag}
						<Badge variant="outline">{tag}</Badge>
					{/each}
				</div>
			</section>
		{/if}

		{#if detail.traits.length > 0}
			<section class="min-w-0" data-testid="traits-section">
				<h2 class="mb-2 text-sm font-semibold">Traits</h2>
				<div class="flex min-w-0 flex-wrap gap-2">
					{#each detail.traits as trait}
						<span data-testid="trait-chip">
							<ReferenceLink ref={trait} type="spec" class="text-sm" />
						</span>
					{/each}
				</div>
			</section>
		{/if}

		{#if detail.acceptance_criteria.length > 0}
			{@const filters = buildCoverageStateFilters(detail.acceptance_criteria)}
			{@const visibleCriteria = filterCriteriaByCoverageState(detail.acceptance_criteria, coverageFilter)}
			<section class="min-w-0" data-testid="acceptance-criteria">
				<div class="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-3">
					<h2 class="text-sm font-semibold">Acceptance Criteria</h2>
					<div class="flex min-w-0 flex-wrap gap-1" data-testid="coverage-filter-strip">
						{#each filters as filter (filter.state)}
							<button
								type="button"
								class={cn(
									'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
									coverageFilter === filter.state
										? 'border-primary bg-primary text-primary-foreground'
										: 'border-border bg-background hover:bg-muted'
								)}
								aria-pressed={coverageFilter === filter.state}
								data-testid={`coverage-filter-${filter.state}`}
								onclick={() => setCoverageFilter(filter.state)}
							>
								<span>{filter.label}</span>
								<span class="font-mono">{filter.count}</span>
							</button>
						{/each}
					</div>
				</div>
				<div class="min-w-0 space-y-2">
					{#each visibleCriteria as criterion (criterion.id)}
						{@const isExpanded = expandedCriteria.has(criterion.id)}
						<div class="min-w-0 rounded-md border border-border" data-testid="ac-item">
							<div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-1">
								<button
									type="button"
									class="min-w-0 rounded-l-md px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									onclick={() => toggleCriterion(criterion.id)}
									data-testid="ac-expand-toggle"
									aria-expanded={isExpanded}
									aria-label={`${isExpanded ? 'Collapse' : 'Expand'} acceptance criterion ${criterion.id}`}
								>
									<span class="flex min-w-0 flex-wrap items-center gap-2">
										<Badge variant="outline" class="shrink-0">{criterion.id}</Badge>
										<span class="min-w-0 text-sm" data-testid="ac-given">
											{@html renderInlineMarkdown(criterionLabel(criterion))}
										</span>
										<StatusBadge
											domain="coverage"
											state={presentationForCriterion(criterion)}
											class="shrink-0 px-1.5 py-0 text-[10px]"
										/>
										<span class="shrink-0 text-xs text-muted-foreground" data-testid="ac-evidence-summary">
											{criterionEvidenceLabel(criterion)}
										</span>
									</span>
								</button>
								<a
									href={criterionHref(detail.node.ref, criterion.id)}
									class="inline-flex items-center gap-1 rounded-r-md px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									aria-label={`Open acceptance criterion ${criterion.id} as workspace page`}
									data-testid="ac-open-page"
								>
									Open
									<ExternalLink class="size-3.5" aria-hidden="true" />
								</a>
							</div>
							{#if isExpanded}
								<div class="space-y-2 border-t border-border px-3 py-3 text-sm">
									<p data-testid="ac-given-full">
										<span class="font-medium text-muted-foreground">Given:</span>
										{@html renderInlineMarkdown(` ${criterion.given}`)}
									</p>
									<p data-testid="ac-when-full">
										<span class="font-medium text-muted-foreground">When:</span>
										{@html renderInlineMarkdown(` ${criterion.when}`)}
									</p>
									<p data-testid="ac-then-full">
										<span class="font-medium text-muted-foreground">Then:</span>
										{@html renderInlineMarkdown(` ${criterion.then}`)}
									</p>
									{@render criterionCoverageBadge(criterion)}
									<p class="text-xs text-muted-foreground" data-testid="ac-evidence-summary-expanded">
										{criterionEvidenceLabel(criterion)}
									</p>
									{#if presentationForCriterion(criterion) === 're_verify'}
										{@render resolutionPanel(detail.node.ref, criterion, true)}
									{/if}
								</div>
							{/if}
						</div>
					{/each}
					{#if visibleCriteria.length === 0}
						{@render emptyState('No acceptance criteria match this coverage filter.', 'acceptance-criteria-filter-empty')}
					{/if}
				</div>
			</section>
		{:else if detail.child_sections.length === 0}
			{@render emptyState('No acceptance criteria are defined for this spec item.', 'acceptance-criteria-empty')}
		{/if}

		{#if detail.child_sections.length > 0}
			<section class="min-w-0" data-testid="workspace-page-children">
				<h2 class="mb-2 text-sm font-semibold">Child Sections</h2>
				<div class="min-w-0 space-y-4">
					{#each detail.child_sections as section (section.type)}
						<div class="min-w-0">
							<div class="mb-2 flex min-w-0 items-center gap-2">
								<h3 class="truncate text-sm font-medium">{section.title}</h3>
								<span class="shrink-0 text-xs text-muted-foreground">{section.pagination.total}</span>
							</div>
							<SpecWorkspaceRows
								nodes={section.nodes}
								{expandedRefs}
								{expandedDetails}
								{expandedLoading}
								{expandedErrors}
								focusedRef={focusedNodeRef}
								nodeHref={nodeHref}
								onToggle={toggleNode}
							/>
						</div>
					{/each}
				</div>
			</section>
		{:else}
			{@render emptyState('No child sections are available for this spec item.', 'workspace-page-children-empty')}
		{/if}

		{@render linkedWorkSection(detail.linked_work, detail.node)}
	</div>
{/snippet}

{#snippet criterionWorkspacePage()}
	{#if focusedCriterion}
		<div class="min-w-0 space-y-5" data-testid="spec-detail-panel">
			<BreadcrumbNav ancestors={focusedCriterion.ancestors} />
			<ViewHeader
				reference={`${focusedCriterion.parent.ref} ${focusedCriterion.criterion.id}`}
				title={`${focusedCriterion.parent.title} · ${focusedCriterion.criterion.id}`}
				titleTestid="spec-title"
				statusDomain="coverage"
				statusState={presentationForCriterion(focusedCriterion.criterion)}
				statusTestid="test-coverage-indicator"
				counts={[
					{ label: 'siblings', value: focusedCriterion.siblings.length, testid: 'spec-ac-sibling-count' }
				]}
				actions={focusedActions}
			/>

			{@render coverageReadinessNotice(buildCoverageReadiness({
				cacheWarming: false,
				unavailableSections: focusedCriterion.unavailable_sections
			}))}

			{@render reverifyBanner([focusedCriterion.criterion], focusedCriterion.parent.ref, focusedCriterion.criterion.id)}

			<section
				class="min-w-0 rounded-md border border-border bg-muted/30 p-3"
				data-testid="criterion-parent-context"
			>
				<h2 class="mb-2 text-sm font-semibold">Parent Requirement</h2>
				<div class="flex min-w-0 flex-wrap items-center gap-2">
					<Badge variant="outline">{focusedCriterion.parent.type}</Badge>
					<ReferenceLink
						ref={focusedCriterion.parent.ref}
						type="spec"
						title={focusedCriterion.parent.title}
					/>
				</div>
			</section>

			<section class="space-y-3 rounded-md border border-border p-4" data-testid="acceptance-criteria">
				<h2 class="text-sm font-semibold">Scenario</h2>
				<div class="space-y-2 text-sm" data-testid="ac-item">
					<p data-testid="ac-given-full">
						<span class="font-medium text-muted-foreground">Given:</span>
						{@html renderInlineMarkdown(` ${focusedCriterion.criterion.given}`)}
					</p>
					<p data-testid="ac-when-full">
						<span class="font-medium text-muted-foreground">When:</span>
						{@html renderInlineMarkdown(` ${focusedCriterion.criterion.when}`)}
					</p>
					<p data-testid="ac-then-full">
						<span class="font-medium text-muted-foreground">Then:</span>
						{@html renderInlineMarkdown(` ${focusedCriterion.criterion.then}`)}
					</p>
				</div>
			</section>

			<section class="min-w-0 rounded-md border border-border p-3" data-testid="criterion-evidence-summary">
				<div class="mb-2 flex min-w-0 flex-wrap items-center gap-2">
					<h2 class="text-sm font-semibold">Coverage Evidence</h2>
					<span data-testid="criterion-coverage-state">
						<StatusBadge
							domain="coverage"
							state={presentationForCriterion(focusedCriterion.criterion)}
							testid="test-coverage-indicator"
						/>
					</span>
				</div>

				<div class="grid min-w-0 gap-2 sm:grid-cols-3">
					<div class="rounded-md bg-muted/45 px-3 py-2">
						<p class="text-xs text-muted-foreground">Latest run</p>
						<p class="text-lg font-semibold">{focusedCriterion.evidence.latest_run.length}</p>
					</div>
					<div class="rounded-md bg-muted/45 px-3 py-2">
						<p class="text-xs text-muted-foreground">Unmapped</p>
						<p class="text-lg font-semibold">{focusedCriterion.evidence.unmapped_results.length}</p>
					</div>
					<div class="rounded-md bg-muted/45 px-3 py-2">
						<p class="text-xs text-muted-foreground">Re-verify causes</p>
						<p class="text-lg font-semibold">{focusedCriterion.evidence.reverify_causes.length}</p>
					</div>
				</div>

				{#if focusedCriterion.coverage?.explanation.rule}
					<p class="mt-2 text-xs text-muted-foreground">
						State explanation: {focusedCriterion.coverage.explanation.rule}
					</p>
				{/if}

				{#if focusedCriterion.evidence.latest_run.length > 0}
					<div class="mt-3 space-y-2" data-testid="criterion-evidence-latest-run">
						{#each focusedCriterion.evidence.latest_run as evidence (evidence.run_id + evidence.case_id)}
							<div class="min-w-0 rounded-md border border-border px-3 py-2 text-sm">
								<div class="flex min-w-0 flex-wrap items-center gap-2">
									<Badge variant="outline">{evidence.status}</Badge>
									<span class="min-w-0 truncate font-medium">{evidence.display_name}</span>
								</div>
								<p class="mt-1 text-xs text-muted-foreground">
									{evidence.producer.label} · {evidence.run_id}
								</p>
							</div>
						{/each}
					</div>
				{:else if focusedCriterion.evidence.unmapped_results.length === 0 && focusedCriterion.evidence.reverify_causes.length === 0}
					{@render emptyState('No coverage evidence is linked to this criterion yet.', 'criterion-evidence-empty')}
				{/if}

				{#if focusedCriterion.evidence.reverify_causes.length > 0}
					<div class="mt-3 space-y-2" data-testid="criterion-reverify-causes">
						{#each focusedCriterion.evidence.reverify_causes as cause (cause.cause)}
							<p class="rounded-md bg-muted/45 px-3 py-2 text-sm">
								<span class="font-medium">{cause.cause}</span>
								{#if cause.detail}
									<span class="text-muted-foreground"> — {cause.detail}</span>
								{/if}
							</p>
						{/each}
					</div>
				{/if}
			</section>

			{@render resolutionPanel(focusedCriterion.parent.ref, focusedCriterion.criterion, false)}

			<section class="min-w-0" data-testid="criterion-siblings">
				<h2 class="mb-2 text-sm font-semibold">Sibling Criteria</h2>
				<div class="flex min-w-0 flex-wrap gap-2">
					{#each focusedCriterion.siblings as sibling (sibling.id)}
						<a
							href={criterionHref(focusedCriterion.parent.ref, sibling.id)}
							class="rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-current={sibling.id === focusedCriterion.criterion.id ? 'page' : undefined}
						>
							{sibling.id}
						</a>
					{/each}
				</div>
			</section>

			{@render linkedWorkSection(focusedCriterion.linked_work, focusedCriterion.parent)}
		</div>
	{/if}
{/snippet}

{#snippet resolutionActionIcon(action: CoverageResolutionAction)}
	{#if action === 'explicit-reverify'}
		<RotateCw class="size-4" aria-hidden="true" />
	{:else if action === 'spec-text-revert'}
		<Undo2 class="size-4" aria-hidden="true" />
	{:else}
		<Wrench class="size-4" aria-hidden="true" />
	{/if}
{/snippet}

{#snippet resolutionPanel(parentRef: string, criterion: SpecWorkspaceCriterionSummary, compact: boolean)}
	{@const model = buildCoverageResolutionPanelModel({ criterion, readOnly: readOnlyMode })}
	{@const key = resolutionPanelKey(parentRef, criterion)}
	<section
		class={cn(
			'min-w-0 rounded-md border border-border bg-card p-3',
			compact ? 'mt-3 bg-muted/20' : ''
		)}
		data-testid={compact ? 'inline-resolution-panel' : 'criterion-resolution-panel'}
	>
		<div class="mb-3 flex min-w-0 flex-wrap items-center gap-2">
			<h2 class="min-w-0 text-sm font-semibold">Resolution</h2>
			<StatusBadge domain="coverage" state={model.stateLabel} class="shrink-0 px-1.5 py-0 text-[10px]" />
			{#if model.readOnly}
				<Badge variant="outline" class="shrink-0">Read-only</Badge>
			{/if}
		</div>

		{#if model.guidance}
			<p class="mb-3 rounded-md bg-muted/45 px-3 py-2 text-sm text-muted-foreground" data-testid="resolution-guidance">
				{model.guidance}
			</p>
		{/if}

		<div class={cn('grid min-w-0 gap-2', compact ? 'sm:grid-cols-1' : 'lg:grid-cols-3')}>
			{#each model.actions as action (action.action)}
				<article
					class={cn(
						'min-w-0 rounded-md border p-3',
						action.available ? 'border-border' : 'border-dashed border-border bg-muted/25'
					)}
					data-testid={`resolution-action-${action.action}`}
				>
					<div class="mb-2 flex min-w-0 items-center gap-2">
						{@render resolutionActionIcon(action.action)}
						<h3 class="truncate text-sm font-medium">{action.label}</h3>
					</div>
					<p class="text-xs text-muted-foreground">{action.summary}</p>
					{#if action.disabledReason}
						<p class="mt-2 text-xs text-muted-foreground" data-testid="resolution-action-disabled">
							{action.disabledReason}
						</p>
					{:else}
						<button
							type="button"
							class="mt-3 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							disabled={resolutionBusy || resolutionApplying}
							onclick={() => previewResolution(action.action, parentRef, criterion)}
							data-testid={`resolution-preview-${action.action}`}
						>
							<Eye class="size-3.5" aria-hidden="true" />
							Preview
						</button>
					{/if}
				</article>
			{/each}
		</div>

		{#if resolutionActiveKey === key}
			{#if resolutionBusy}
				<p class="mt-3 rounded-md bg-muted/45 px-3 py-2 text-sm text-muted-foreground" role="status">
					Loading dry-run preview...
				</p>
			{/if}

			{#if resolutionError}
				<div
					class="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
					data-testid="resolution-error"
					role="alert"
				>
					<p class="font-medium text-destructive">{resolutionError}</p>
					{#if resolutionSuggestion}
						<p class="mt-1 text-xs text-muted-foreground">{resolutionSuggestion}</p>
					{/if}
					{#if resolutionConflictFingerprint}
						<p class="mt-1 break-all font-mono text-[11px] text-muted-foreground">
							Current fingerprint: {resolutionConflictFingerprint}
						</p>
					{/if}
				</div>
			{/if}

			{#if resolutionPreview}
				<div
					class="mt-3 rounded-md border border-border bg-muted/20 p-3"
					data-testid="resolution-preview"
				>
					<div class="mb-2 flex min-w-0 flex-wrap items-center gap-2">
						<Badge variant="outline">Dry run</Badge>
						<p class="min-w-0 text-sm font-medium">
							{resolutionPreview.effects.length}
							{resolutionPreview.effects.length === 1 ? 'stored effect' : 'stored effects'} previewed
						</p>
					</div>
					<p class="break-all text-xs text-muted-foreground">
						Fingerprint: {resolutionPreview.target.current_fingerprint}
					</p>
					{#if resolutionPreview.diagnostics.length > 0}
						<div class="mt-2 space-y-1" data-testid="resolution-diagnostics">
							{#each resolutionPreview.diagnostics as diagnostic (diagnostic.code + diagnostic.missing_requirement)}
								<p class="text-xs text-muted-foreground">
									<span class="font-medium">{diagnostic.satisfied ? 'Ready' : 'Blocked'}:</span>
									{diagnostic.suggestion}
								</p>
							{/each}
						</div>
					{/if}
					{#if resolutionPreview.effects.length > 0}
						<ul class="mt-2 space-y-1" data-testid="resolution-effects">
							{#each resolutionPreview.effects as effect, index (`${effect.kind}-${index}`)}
								<li class="text-xs text-muted-foreground">{resolutionEffectSummary(effect)}</li>
							{/each}
						</ul>
					{:else}
						<p class="mt-2 text-xs text-muted-foreground">No stored effects are available for this action.</p>
					{/if}
					{#if resolutionPreview.affected_scopes.length > 0}
						<p class="mt-2 text-xs text-muted-foreground" data-testid="resolution-affected-scopes">
							Affected scopes: {resolutionPreview.affected_scopes.length}
						</p>
					{/if}
					{#if !readOnlyMode && !resolutionPreview.diagnostics.some((diagnostic) => !diagnostic.satisfied)}
						<button
							type="button"
							class="mt-3 inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							disabled={resolutionApplying}
							onclick={() => applyResolution(parentRef, criterion)}
							data-testid="resolution-confirm-apply"
						>
							<CheckCircle2 class="size-4" aria-hidden="true" />
							{resolutionApplying ? 'Applying...' : 'Apply'}
						</button>
					{/if}
				</div>
			{/if}

			{#if resolutionResult}
				<div
					class="mt-3 rounded-md border border-severity-success/40 bg-severity-success/10 px-3 py-2 text-sm"
					data-testid="resolution-result"
					role="status"
				>
					<p class="font-medium">{storedResultMessage(resolutionResult)}</p>
					{#if taskEffectsFromResolution(resolutionResult).length > 0}
						<div class="mt-2 space-y-1" data-testid="resolution-task-results">
							{#each taskEffectsFromResolution(resolutionResult) as taskEffect (taskEffect.task_ref ?? taskEffect.idempotency_key ?? taskEffect.operation)}
								<p class="text-xs text-muted-foreground">
									{resolutionEffectSummary(taskEffect)}
									{#if taskEffect.task_ref}
										<span class="ml-1">
											<ReferenceLink ref={taskEffect.task_ref} type="task" title={taskEffect.task_ref} />
										</span>
									{/if}
								</p>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</section>
{/snippet}

{#snippet linkedWorkSection(groups: SpecWorkspaceLinkedWorkGroup[], node: SpecWorkspaceNodeSummary)}
	<section class="min-w-0" data-testid="linked-work-section">
		<div class="mb-2 flex min-w-0 items-center justify-between gap-3">
			<h2 class="text-sm font-semibold">Linked Work</h2>
			{#if linkedWorkGroup(groups, 'session')}
				<a
					href="{base}/sessions?spec_ref={encodeURIComponent(node.ref)}"
					class="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					data-testid="item-related-sessions-view-all"
				>
					View all sessions
				</a>
			{/if}
		</div>

		{#if groups.length === 0}
			{@render emptyState('Linked work is not available for this workspace projection.', 'linked-work-empty')}
		{:else}
			<div class="grid min-w-0 gap-3 lg:grid-cols-2">
				{#each groups as group (group.kind)}
					<div
						class="min-w-0 rounded-md border border-border p-3"
						data-testid={`linked-work-group-${group.kind}`}
						id={group.kind === 'session' ? 'item-related-sessions' : undefined}
					>
						<div class="mb-2 flex min-w-0 items-center justify-between gap-2">
							<h3 class="text-sm font-medium">{linkedWorkLabel(group.kind)}</h3>
							<Badge variant="outline" class="shrink-0">{group.total}</Badge>
						</div>
						<p class="mb-2 text-xs text-muted-foreground">{group.inclusion_rule}</p>

						{#if group.unavailable}
							<p
								class="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground"
								data-testid={group.kind === 'session' ? 'item-related-sessions-error' : 'linked-work-unavailable'}
							>
								<span class="font-medium">unavailable:</span>
								{group.unavailable.reason}
								<span class="block text-xs">{group.unavailable.suggestion}</span>
							</p>
						{:else if group.items.length > 0}
							<div class="min-w-0 space-y-2">
								{#each group.items as item (item.kind + item.ref)}
									<div
										class="flex min-w-0 items-center gap-3 rounded-md border border-border p-3 text-sm"
										data-testid={item.kind === 'task' ? 'linked-task' : item.kind === 'session' ? 'item-related-sessions-row' : 'linked-work'}
									>
										{#if item.status}
											<StatusBadge
												domain={item.kind === 'task' ? 'task' : item.kind === 'session' ? 'session' : 'spec-implementation'}
												state={item.status}
												testid={item.kind === 'task' ? 'task-status-badge' : item.kind === 'session' ? 'item-related-sessions-status-badge' : undefined}
											/>
										{/if}
										<div class="min-w-0 flex-1">
											{#if linkedWorkRefType(item.kind)}
												<ReferenceLink
													ref={item.ref}
													type={linkedWorkRefType(item.kind) ?? 'task'}
													title={item.title}
													class="min-w-0"
												/>
											{:else}
												<a
													href={linkedWorkHref(item)}
													class="inline-flex min-w-0 items-baseline gap-1 text-primary hover:underline"
												>
													<span class="truncate text-sm" data-testid={item.kind === 'task' ? 'task-title' : undefined}>
														{item.title ?? item.ref}
													</span>
													<span class="font-mono text-[10px] text-muted-foreground">@{normalizeRef(item.ref)}</span>
												</a>
											{/if}
											{#if item.kind === 'task'}
												<span class="sr-only" data-testid="task-title">{item.title ?? item.ref}</span>
											{/if}
											{#if item.created_at}
												<p class="mt-1 text-xs text-muted-foreground">Created {item.created_at}</p>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						{:else}
							<p
								class="text-sm text-muted-foreground"
								data-testid={group.kind === 'session' ? 'item-related-sessions-empty' : 'linked-work-empty'}
							>
								No linked work entries are available for {linkedWorkLabel(group.kind).toLowerCase()}.
							</p>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>
{/snippet}

<div class="min-w-0 overflow-x-hidden" data-testid="spec-workspace">
	{#if planFilter}
		<div
			class="mb-4 flex min-w-0 items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
			data-testid="plan-filter-banner"
		>
			<span class="min-w-0 truncate">Opened from plan <code class="rounded bg-muted px-1 py-0.5 text-xs">@{planFilter}</code></span>
			<a href="{base}/specs" class="ml-auto shrink-0 text-xs text-primary hover:underline">Clear</a>
		</div>
	{/if}

	{#if expansionEvictedCount > 0}
		<div
			class="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
			data-testid="expansion-eviction-notice"
			role="status"
		>
			{expansionEvictedCount}
			{expansionEvictedCount === 1 ? 'older expanded branch was' : 'older expanded branches were'}
			dropped to keep the workspace responsive.
		</div>
	{/if}

	<div class="grid min-w-0 gap-4 xl:grid-cols-[minmax(20rem,28rem)_minmax(0,1fr)]">
		<aside class="min-w-0 rounded-lg border border-border bg-card p-3" data-testid="spec-tree-container">
			<div class="mb-3 flex min-w-0 items-center justify-between gap-3">
				<div class="min-w-0">
					<h1 class="truncate text-xl font-semibold">Spec Items</h1>
					<p class="text-sm text-muted-foreground">Unified workspace tree</p>
				</div>
				{#if root}
					<Badge variant="outline" class="shrink-0">{root.corpus.items} items</Badge>
				{/if}
			</div>

			{#if rootCacheWarming}
				<CacheWarmingBanner entityName="spec workspace" queryKey={queryKeys.specWorkspace.root()} />
			{:else if rootLoading && !root}
				{@render loadingRows()}
			{:else if rootError}
				<div class="rounded-md border border-destructive bg-destructive/10 p-4" data-testid="error-message" role="alert">
					<p class="font-medium text-destructive">Error loading spec workspace</p>
					<p class="text-sm text-destructive/80">{rootError}</p>
				</div>
			{:else if root}
				<SpecWorkspaceRows
					nodes={root.top_level_nodes}
					{expandedRefs}
					{expandedDetails}
					{expandedLoading}
					{expandedErrors}
					focusedRef={focusedNodeRef}
					nodeHref={nodeHref}
					onToggle={toggleNode}
				/>
			{/if}
		</aside>

		<main class="min-w-0 rounded-lg border border-border bg-card p-4">
			{#if !focusedNodeRef}
				{@render rootWorkspacePage()}
			{:else if focusedCriterionId}
				{#if criterionLoading && !focusedCriterion}
					{@render loadingRows()}
				{:else if focusedError}
					<div class="rounded-md border border-destructive bg-destructive/10 p-4" data-testid="error-message" role="alert">
						<p class="font-medium text-destructive">Error loading criterion page</p>
						<p class="text-sm text-destructive/80">{focusedError}</p>
					</div>
				{:else}
					{@render criterionWorkspacePage()}
				{/if}
			{:else if nodeLoading && !focusedNode}
				{@render loadingRows()}
			{:else if focusedError}
				<div class="rounded-md border border-destructive bg-destructive/10 p-4" data-testid="error-message" role="alert">
					<p class="font-medium text-destructive">Error loading spec page</p>
					<p class="text-sm text-destructive/80">{focusedError}</p>
				</div>
			{:else if focusedNode}
				{@render nodeWorkspacePage(focusedNode)}
			{/if}
		</main>
	</div>
</div>
