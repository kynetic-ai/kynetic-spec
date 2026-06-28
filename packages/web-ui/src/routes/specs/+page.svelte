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
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import type {
		SpecWorkspaceCriterionSummary,
		SpecWorkspaceLinkedWorkGroup,
		SpecWorkspaceNodeDetailProjection,
		SpecWorkspaceNodeSummary
	} from '@kynetic-ai/shared';
	import { Badge } from '$lib/components/ui/badge';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import CacheWarmingBanner from '$lib/components/CacheWarmingBanner.svelte';
	import BreadcrumbNav from '$lib/components/BreadcrumbNav.svelte';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import SpecWorkspaceRows from '$lib/components/SpecWorkspaceRows.svelte';
	import { StatusBadge, ViewHeader, type ViewHeaderCount } from '$lib/components/ds';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import { queryKeys } from '$lib/query/keys.js';
	import {
		fetchSpecWorkspaceCriterion,
		fetchSpecWorkspaceNode,
		fetchSpecWorkspaceRoot,
		isCacheWarmingError
	} from '$lib/api';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { renderInlineMarkdown, renderMarkdown } from '$lib/utils/markdown';
	import { normalizeRef } from '$lib/utils/reference';
	import ChevronLeft from 'lucide-svelte/icons/chevron-left';
	import ExternalLink from 'lucide-svelte/icons/external-link';

	const MAX_EXPANDED_REFS = 80;
	const WORKSPACE_PAGE_SIZE = 100;
	const EXPANSION_EVICTED_PARAM = 'expandedEvicted';

	let expandedDetails = $state(new Map<string, SpecWorkspaceNodeDetailProjection>());
	let expandedLoading = $state(new Set<string>());
	let expandedErrors = $state(new Map<string, string>());
	let expandedCriteria = $state(new Set<string>());

	let focusedNodeRef = $derived.by(() => {
		const node = $page.url.searchParams.get('node');
		const legacyRef = $page.url.searchParams.get('ref');
		return node ?? legacyRef;
	});
	let focusedCriterionId = $derived($page.url.searchParams.get('ac'));
	let planFilter = $derived($page.url.searchParams.get('plan') ?? undefined);
	let expandedRefParts = $derived(parseExpandedRefParts($page.url.searchParams.get('expanded')));
	let expansionEvictedByUrl = $derived(Math.max(0, expandedRefParts.length - MAX_EXPANDED_REFS));
	let expansionEvictedByMutation = $derived(parseEvictedCount($page.url.searchParams.get(EXPANSION_EVICTED_PARAM)));
	let expansionEvictedCount = $derived(Math.max(expansionEvictedByUrl, expansionEvictedByMutation));
	let expandedRefs = $derived(parseExpandedRefs($page.url.searchParams.get('expanded')));

	const rootQuery = createQuery(() => ({
		queryKey: queryKeys.specWorkspace.root({ limit: WORKSPACE_PAGE_SIZE }),
		queryFn: () => fetchSpecWorkspaceRoot({ limit: WORKSPACE_PAGE_SIZE }),
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
		});
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
			{ label: 'criteria', value: root.corpus.acceptance_criteria, testid: 'spec-corpus-ac' }
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
	{#if criterion.coverage?.presentation}
		<StatusBadge
			domain="coverage"
			state={criterion.coverage.presentation}
			testid="test-coverage-indicator"
		/>
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
			<section class="min-w-0" data-testid="acceptance-criteria">
				<h2 class="mb-2 text-sm font-semibold">Acceptance Criteria</h2>
				<div class="min-w-0 space-y-2">
					{#each detail.acceptance_criteria as criterion (criterion.id)}
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
											{#if criterion.coverage?.presentation}
												<StatusBadge
													domain="coverage"
													state={criterion.coverage.presentation}
													class="shrink-0 px-1.5 py-0 text-[10px]"
												/>
											{/if}
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
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</section>
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
		{/if}

		{@render linkedWorkSection(detail.linked_work)}
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
					statusDomain={focusedCriterion.criterion.coverage?.presentation ? 'coverage' : undefined}
					statusState={focusedCriterion.criterion.coverage?.presentation}
					statusTestid="test-coverage-indicator"
				counts={[
					{ label: 'siblings', value: focusedCriterion.siblings.length, testid: 'spec-ac-sibling-count' }
				]}
				actions={focusedActions}
			/>

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

			<section class="min-w-0">
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

			{@render linkedWorkSection(focusedCriterion.linked_work)}
		</div>
	{/if}
{/snippet}

{#snippet linkedWorkSection(groups: SpecWorkspaceLinkedWorkGroup[])}
	<section class="min-w-0" data-testid="implementation-section">
		<h2 class="mb-2 text-sm font-semibold">Implementation</h2>
		{#if groups.some((group) => group.items.length > 0)}
			<div class="min-w-0 space-y-3">
				{#each groups as group (group.kind)}
					{#if group.items.length > 0}
						<div class="min-w-0">
							<h3 class="mb-1 text-xs font-medium uppercase tracking-normal text-muted-foreground">
								{group.kind}
							</h3>
							<div class="min-w-0 space-y-1">
								{#each group.items as item (item.kind + item.ref)}
									<a
										href={linkedWorkHref(item)}
										class="flex min-w-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										data-testid={item.kind === 'task' ? 'linked-task' : 'linked-work'}
									>
										{#if item.kind === 'task' && item.status}
											<StatusBadge domain="task" state={item.status} testid="task-status-badge" />
										{/if}
										<span class="min-w-0 flex-1 truncate" data-testid={item.kind === 'task' ? 'task-title' : undefined}>
											{item.title ?? item.ref}
										</span>
										<span class="shrink-0 font-mono text-xs text-muted-foreground">@{normalizeRef(item.ref)}</span>
									</a>
								{/each}
							</div>
						</div>
					{/if}
				{/each}
			</div>
		{:else}
			<p class="text-sm text-muted-foreground">No tasks linked to this spec item yet.</p>
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
				<div class="min-w-0 space-y-5" data-testid="spec-detail-panel">
					<ViewHeader
						reference="specs"
						title="Spec Items"
						titleTestid="spec-title"
						counts={rootCounts()}
					/>
					<p class="text-sm text-muted-foreground">
						Expand branches in the tree, or open any row title as a focused workspace page.
					</p>
					{#if root}
						<div class="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-4">
							{#each Object.entries(root.corpus.by_type) as [type, count] (type)}
								<div class="rounded-md border border-border px-3 py-2">
									<p class="truncate text-sm font-medium">{type}</p>
									<p class="text-2xl font-semibold">{count}</p>
								</div>
							{/each}
						</div>
					{/if}
				</div>
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
