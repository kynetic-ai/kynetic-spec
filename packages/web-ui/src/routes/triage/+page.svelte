<!--
  AC: @ui-data-freshness ac-1 — Renders from cache on revisit without loading state
  AC: @ui-data-freshness ac-3 — WebSocket events invalidate merged inbox query
  AC: @ui-api-aggregation ac-3 — Inbox items include inline triage status, no client join
-->
<script lang="ts">
	// AC: @interactive-triage-ui ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7, ac-8
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import type { InboxItemWithTriage } from '@kynetic-ai/shared';
	import type { TriageRecord, TriageAction } from '$lib/types/triage';
	import {
		fetchMergedInbox,
		fetchTriageExport,
		fetchTriageRecords,
		createTriageRecord,
		overrideTriageRecord,
		actOnTriageRecord,
		isCacheWarmingError
	} from '$lib/api';
	import CacheWarmingBanner from '$lib/components/CacheWarmingBanner.svelte';
	import { isStaticMode, ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { shortcutRegistry } from '$lib/shortcuts';
	import { queryKeys } from '$lib/query/keys.js';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Separator } from '$lib/components/ui/separator';
	import ChevronLeftIcon from 'lucide-svelte/icons/chevron-left';
	import ChevronRightIcon from 'lucide-svelte/icons/chevron-right';

	const queryClient = useQueryClient();

	// Card navigation state
	// AC: @interactive-triage-ui ac-5
	let currentIndex = $state(0);
	let submitting = $state(false);

	// Form state
	// AC: @interactive-triage-ui ac-3
	let selectedAction = $state<TriageAction | ''>('');
	let reasoning = $state('');

	// Write operation error (separate from query error)
	let writeError = $state('');
	let exportLoading = $state(false);
	let exportError = $state('');
	let exportFormat = $state<'context' | 'json'>('context');
	let exportContent = $state('');

	// Action labels
	const ACTION_LABELS: Record<TriageAction, string> = {
		promote: 'Promote to Task',
		delete: 'Delete',
		defer: 'Defer',
		'spec-gap': 'Spec Gap',
		duplicate: 'Duplicate'
	};

	const ACTION_COLORS: Record<TriageAction, string> = {
		promote: 'bg-green-500',
		delete: 'bg-red-500',
		defer: 'bg-yellow-500',
		'spec-gap': 'bg-purple-500',
		duplicate: 'bg-gray-500'
	};

	type TriageFilterStatus = 'all' | 'untriaged' | 'triaged' | 'acted_on';
	const TRIAGE_STATUS_VALUES: readonly TriageFilterStatus[] = ['all', 'untriaged', 'triaged', 'acted_on'];
	const TRIAGE_ACTION_VALUES = Object.keys(ACTION_LABELS) as TriageAction[];

	// ── Queries ──
	// AC: @ui-data-freshness ac-1 — createQuery caches; revisits render from cache
	// AC: @ui-api-aggregation ac-3 — Uses merged endpoint for inline triage status
	const mergedInboxQuery = createQuery(() => ({
		queryKey: queryKeys.inbox.merged(),
		queryFn: () => fetchMergedInbox(),
		enabled: isProjectInitialized(),
	}));

	// Full triage records for detail view (evidence_refs, override_reasoning, override_by)
	const triageRecordsQuery = createQuery(() => ({
		queryKey: queryKeys.inbox.list({ type: 'triage-records' }),
		queryFn: () => fetchTriageRecords(),
		enabled: isProjectInitialized(),
	}));

	// Filter state — derived from URL params (single source of truth)
	// AC: @interactive-triage-ui ac-7
	let filterTag = $derived(page.url.searchParams.get('tag') || '');
	let filterStatus = $derived.by((): TriageFilterStatus => {
		const raw = page.url.searchParams.get('status');
		if (raw && TRIAGE_STATUS_VALUES.includes(raw as TriageFilterStatus)) {
			return raw as TriageFilterStatus;
		}
		return 'all';
	});
	let filterAction = $derived.by((): TriageAction | '' => {
		const raw = page.url.searchParams.get('action');
		if (raw && TRIAGE_ACTION_VALUES.includes(raw as TriageAction)) {
			return raw as TriageAction;
		}
		return '';
	});

	// Build a map of triage records by inbox_ref for fast lookup in the detail card
	let triageRecordsByInboxRef = $derived.by((): Map<string, TriageRecord> => {
		const records = triageRecordsQuery.data?.items ?? [];
		const map = new Map<string, TriageRecord>();
		for (const r of records) {
			map.set(r.inbox_ref, r);
		}
		return map;
	});

	// Merged view: inbox items with their triage records
	interface TriageCardItem {
		inbox: InboxItemWithTriage;
		record: TriageRecord | null;
	}

	// AC: @interactive-triage-ui ac-7 - Filtered items
	let allItems = $derived.by((): TriageCardItem[] => {
		const items = mergedInboxQuery.data?.items ?? [];
		return items.map((item) => {
			const record = triageRecordsByInboxRef.get(item._ulid) ?? null;
			return { inbox: item, record };
		});
	});

	let filteredItems = $derived.by(() => {
		let items = allItems;

		// Tag filter
		if (filterTag) {
			items = items.filter((i) => i.inbox.tags.includes(filterTag));
		}

		// Status filter (use inline triage status from merged endpoint)
		if (filterStatus === 'untriaged') {
			items = items.filter((i) => !i.inbox.triage || i.inbox.triage.status === 'pending');
		} else if (filterStatus === 'triaged') {
			items = items.filter((i) => i.inbox.triage?.status === 'triaged');
		} else if (filterStatus === 'acted_on') {
			items = items.filter((i) => i.inbox.triage?.status === 'acted_on');
		}

		// Action filter
		if (filterAction) {
			items = items.filter((i) => i.inbox.triage?.action === filterAction);
		}

		return items;
	});

	let currentItem = $derived(filteredItems[currentIndex] ?? null);

	// AC: @interactive-triage-ui ac-7 - Progress count
	let triagedCount = $derived(
		allItems.filter((i) => i.inbox.triage && i.inbox.triage.status !== 'pending').length
	);
	let totalCount = $derived(allItems.length);

	// All unique tags for filter
	let allTags = $derived.by(() => {
		const items = mergedInboxQuery.data?.items ?? [];
		const tagSet = new Set<string>();
		items.forEach((item) => item.tags.forEach((t) => tagSet.add(t)));
		return Array.from(tagSet).sort();
	});

	// AC: @ui-data-freshness ac-1 — Only show loading on initial fetch (no cache)
	let loading = $derived(mergedInboxQuery.isLoading || triageRecordsQuery.isLoading);

	// AC: @ui-data-freshness ac-warming-skeleton — Distinguish warming errors from other errors
	let cacheWarming = $derived(isCacheWarmingError(mergedInboxQuery.error) || isCacheWarmingError(triageRecordsQuery.error));

	// AC: @ui-data-freshness ac-7 — Surface error from query or write operations
	let error = $derived(
		writeError ||
		(cacheWarming ? '' : (
			(mergedInboxQuery.error ? mergedInboxQuery.error.message : '') ||
			(triageRecordsQuery.error ? triageRecordsQuery.error.message : '')
		))
	);

	function updateFilterParam(key: 'status' | 'action' | 'tag', value: string) {
		const params = new URLSearchParams(page.url.searchParams);

		if (!value || value === 'all') {
			params.delete(key);
		} else {
			params.set(key, value);
		}

		const query = params.toString();
		const nextUrl = query ? `${base}/triage?${query}` : `${base}/triage`;
		goto(nextUrl, { replaceState: false, keepFocus: true, noScroll: true });
	}

	// AC: @interactive-triage-ui ac-5 - Navigation
	function goNext() {
		if (currentIndex < filteredItems.length - 1) {
			currentIndex++;
			resetForm();
		}
	}

	function goPrevious() {
		if (currentIndex > 0) {
			currentIndex--;
			resetForm();
		}
	}

	function resetForm() {
		selectedAction = '';
		reasoning = '';
		writeError = '';
	}

	// Keyboard navigation through the central shortcut registry, scoped to the
	// triage surface. The registry's central text-entry suppression keeps the
	// arrow keys from hijacking input/textarea/contenteditable focus.
	// AC: @interactive-triage-ui ac-5
	// AC: @ui-shortcut-registry ac-1, ac-6
	onMount(() => {
		const context = 'triage';
		shortcutRegistry.activateContext(context);
		const prev = shortcutRegistry.register({
			id: 'triage.previous',
			label: 'Previous triage item',
			context,
			chord: { key: 'ArrowLeft' },
			preventDefault: false,
			handler: () => goPrevious()
		});
		const next = shortcutRegistry.register({
			id: 'triage.next',
			label: 'Next triage item',
			context,
			chord: { key: 'ArrowRight' },
			preventDefault: false,
			handler: () => goNext()
		});
		return () => {
			prev.unregister();
			next.unregister();
			shortcutRegistry.deactivateContext(context);
		};
	});

	// AC: @interactive-triage-ui ac-3 - Submit triage decision
	// AC: @ui-data-freshness ac-8 — Write operation invalidates related cache
	async function handleSubmit() {
		if (!currentItem || !selectedAction || !reasoning.trim()) return;

		if (isStaticMode()) {
			writeError = 'Cannot submit triage decisions in read-only mode.';
			return;
		}

		try {
			submitting = true;
			writeError = '';

			const existing = currentItem.record;

			if (existing && existing.status !== 'pending') {
				// AC: @interactive-triage-ui ac-4 - Override existing decision
				await overrideTriageRecord(existing._ulid, {
					action: selectedAction,
					reasoning: reasoning.trim()
				});
			} else {
				// Create new triage record
				await createTriageRecord({
					inbox_ref: currentItem.inbox._ulid,
					action: selectedAction,
					reasoning: reasoning.trim()
				});
			}

			// AC: @ui-data-freshness ac-8 — Invalidate inbox cache after write
			queryClient.invalidateQueries({ queryKey: queryKeys.inbox.all });

			// Auto-advance to next item
			// AC: @interactive-triage-ui ac-3 - advances to next item
			if (currentIndex < filteredItems.length - 1) {
				currentIndex++;
			}
			resetForm();
		} catch (err) {
			if (err instanceof ReadOnlyModeError) {
				writeError = err.message;
			} else {
				writeError = err instanceof Error ? err.message : 'Failed to submit triage decision';
			}
		} finally {
			submitting = false;
		}
	}

	// Execute the triage action
	// AC: @ui-data-freshness ac-8 — Write operation invalidates related cache
	async function handleAct() {
		if (!currentItem?.record) return;

		if (isStaticMode()) {
			writeError = 'Cannot execute triage actions in read-only mode.';
			return;
		}

		try {
			submitting = true;
			writeError = '';
			await actOnTriageRecord(currentItem.record._ulid);
			// AC: @ui-data-freshness ac-8 — Invalidate inbox cache after write
			queryClient.invalidateQueries({ queryKey: queryKeys.inbox.all });
		} catch (err) {
			if (err instanceof ReadOnlyModeError) {
				writeError = err.message;
			} else {
				writeError = err instanceof Error ? err.message : 'Failed to execute triage action';
			}
		} finally {
			submitting = false;
		}
	}

	// AC: @triage-daemon-api ac-6 - Export triage records for preview from /triage
	async function handleExport(format: 'context' | 'json') {
		try {
			exportLoading = true;
			exportError = '';
			const result = await fetchTriageExport(format);
			exportFormat = result.format;
			exportContent = result.content;
		} catch (err) {
			exportError = err instanceof Error ? err.message : 'Failed to export triage records';
		} finally {
			exportLoading = false;
		}
	}

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

	// AC: @interactive-triage-ui ac-7 - Reset index when filter changes
	$effect(() => {
		// Reading filter values creates reactive dependencies
		const _tag = filterTag;
		const _status = filterStatus;
		const _action = filterAction;
		currentIndex = 0;
		resetForm();
	});
</script>

<!-- AC: @interactive-triage-ui ac-1, ac-5, ac-7 -->
<div class="flex flex-col gap-4 p-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold">Triage</h1>
			{#if !loading}
				<!-- AC: @interactive-triage-ui ac-7 - Progress count -->
				<p class="text-muted-foreground" data-testid="triage-progress">
					{triagedCount} of {totalCount} triaged
					{#if filteredItems.length !== allItems.length}
						&middot; Showing {filteredItems.length} filtered
					{/if}
				</p>
			{/if}
		</div>

		<!-- AC: @interactive-triage-ui ac-7 - Filters -->
		<div class="flex gap-2 items-center" data-testid="triage-filters">
			<select
				value={filterStatus}
				onchange={(event) => updateFilterParam('status', (event.currentTarget as HTMLSelectElement).value)}
				class="rounded-md border bg-background px-3 py-1.5 text-sm"
				data-testid="triage-status-filter"
			>
				<option value="all">All</option>
				<option value="untriaged">Untriaged</option>
				<option value="triaged">Triaged</option>
				<option value="acted_on">Acted On</option>
			</select>
			<select
				value={filterAction}
				onchange={(event) => updateFilterParam('action', (event.currentTarget as HTMLSelectElement).value)}
				class="rounded-md border bg-background px-3 py-1.5 text-sm"
				data-testid="triage-action-filter"
			>
				<option value="">All Actions</option>
				{#each Object.entries(ACTION_LABELS) as [action, label]}
					<option value={action}>{label}</option>
				{/each}
			</select>
			{#if allTags.length > 0}
				<select
					value={filterTag}
					onchange={(event) => updateFilterParam('tag', (event.currentTarget as HTMLSelectElement).value)}
					class="rounded-md border bg-background px-3 py-1.5 text-sm"
					data-testid="triage-tag-filter"
				>
					<option value="">All Tags</option>
					{#each allTags as tag}
						<option value={tag}>{tag}</option>
					{/each}
				</select>
			{/if}
		</div>
	</div>

	{#if !isStaticMode()}
		<Card data-testid="triage-export-panel">
			<CardHeader class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div class="space-y-1">
					<h2 class="text-lg font-semibold">Export Decisions</h2>
					<p class="text-sm text-muted-foreground">
						Load the current triage export in Markdown context or JSON format.
					</p>
				</div>
				<div class="flex gap-2" data-testid="triage-export-controls">
					<Button
						variant={exportFormat === 'context' && exportContent ? 'default' : 'outline'}
						size="sm"
						onclick={() => handleExport('context')}
						disabled={exportLoading}
						data-testid="triage-export-context"
					>
						{exportLoading && exportFormat === 'context' ? 'Loading…' : 'Export Markdown'}
					</Button>
					<Button
						variant={exportFormat === 'json' && exportContent ? 'default' : 'outline'}
						size="sm"
						onclick={() => handleExport('json')}
						disabled={exportLoading}
						data-testid="triage-export-json"
					>
						{exportLoading && exportFormat === 'json' ? 'Loading…' : 'Export JSON'}
					</Button>
				</div>
			</CardHeader>
			<CardContent class="space-y-3">
				{#if exportError}
					<div
						class="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-200"
						role="alert"
						data-testid="triage-export-error"
					>
						{exportError}
					</div>
				{:else if exportContent}
					<div class="space-y-2">
						<p class="text-sm font-medium" data-testid="triage-export-format">
							Showing {exportFormat === 'context' ? 'Markdown context' : 'JSON'} export
						</p>
						<pre
							class="max-h-80 overflow-auto rounded-md border bg-muted/40 p-4 text-xs leading-5 whitespace-pre-wrap"
							data-testid="triage-export-preview"
						>{exportContent}</pre>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground" data-testid="triage-export-empty">
						Choose a format to preview the triage export.
					</p>
				{/if}
			</CardContent>
		</Card>
	{/if}

	<!-- Progress bar -->
	{#if totalCount > 0}
		<div class="w-full bg-muted rounded-full h-2" data-testid="triage-progress-bar">
			<div
				class="bg-primary rounded-full h-2 transition-all duration-300"
				style="width: {(triagedCount / totalCount) * 100}%"
			></div>
		</div>
	{/if}

	{#if error}
		<div class="rounded-md bg-red-50 p-4 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-200" data-testid="triage-error" role="alert">
			{error}
		</div>
	{/if}

	<!-- AC: @interactive-triage-ui ac-8 - Static mode notice -->
	{#if isStaticMode() && !loading}
		<div class="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200" data-testid="triage-static-notice">
			Triage decisions are not included in static snapshots. Browse inbox items below; use the daemon for full triage functionality.
		</div>
	{/if}

	<!-- AC: @ui-data-freshness ac-warming-skeleton — Show skeleton during cache warming -->
	<!-- AC: @ui-data-freshness ac-warming-timeout — Show error banner after 30s timeout -->
	{#if cacheWarming}
		<CacheWarmingBanner entityName="triage data" queryKey={queryKeys.inbox.merged()} extraQueryKeys={[queryKeys.inbox.list({ type: 'triage-records' })]} />
	{:else if loading}
		<div class="space-y-2" data-testid="triage-loading">
			{#each Array(3) as _}
				<div class="h-20 rounded-lg bg-muted ds-shimmer"></div>
			{/each}
		</div>
	{:else if filteredItems.length === 0}
		<div class="text-center text-muted-foreground py-12">
			{#if allItems.length === 0}
				<p>No inbox items to triage.</p>
				<p class="text-sm mt-1">Add items to your inbox first.</p>
			{:else}
				<p>No items match the current filters.</p>
			{/if}
		</div>
	{:else if currentItem}
		<!-- Card navigation -->
		<div class="flex items-center justify-between mb-2">
			<!-- AC: @interactive-triage-ui ac-5 - Navigation controls -->
			<Button
				variant="outline"
				size="sm"
				onclick={goPrevious}
				disabled={currentIndex === 0}
				data-testid="triage-prev"
			>
				<ChevronLeftIcon class="size-4 mr-1" />
				Previous
			</Button>
			<span class="text-sm text-muted-foreground" data-testid="triage-position">
				{currentIndex + 1} / {filteredItems.length}
			</span>
			<Button
				variant="outline"
				size="sm"
				onclick={goNext}
				disabled={currentIndex === filteredItems.length - 1}
				data-testid="triage-next"
			>
				Next
				<ChevronRightIcon class="size-4 ml-1" />
			</Button>
		</div>

		<!-- AC: @interactive-triage-ui ac-1 - Card view showing item text, tags, age, added_by -->
		<Card class="transition-all duration-200" data-testid="triage-card">
			<CardHeader>
				<div class="flex items-start justify-between gap-4">
					<div
						class="text-lg leading-relaxed prose prose-sm dark:prose-invert max-w-none"
						data-testid="triage-card-text"
					>
						{@html renderMarkdown(currentItem.inbox.text)}
					</div>
					<!-- AC: @interactive-triage-ui ac-5 - Show decision state on already-triaged items -->
					{#if currentItem.record && currentItem.record.status !== 'pending'}
						<Badge
							class={currentItem.record.action ? ACTION_COLORS[currentItem.record.action] : 'bg-gray-500'}
							data-testid="triage-card-status"
						>
							{currentItem.record.status === 'acted_on' ? 'Acted' : 'Triaged'}
						</Badge>
					{/if}
				</div>
				<!-- AC: @interactive-triage-ui ac-1 - tags, age, added_by -->
				<div class="flex items-center gap-2 text-xs text-muted-foreground mt-2" data-testid="triage-card-meta">
					<span data-testid="triage-card-age">{formatDate(currentItem.inbox.created_at)}</span>
					<span>&middot;</span>
					<span data-testid="triage-card-added-by">{currentItem.inbox.added_by}</span>
					{#if currentItem.inbox.tags.length > 0}
						<span>&middot;</span>
						<div class="flex gap-1" data-testid="triage-card-tags">
							{#each currentItem.inbox.tags as tag}
								<Badge variant="secondary" class="text-xs">{tag}</Badge>
							{/each}
						</div>
					{/if}
				</div>
			</CardHeader>
			<CardContent>
				<!-- AC: @interactive-triage-ui ac-2 - Show agent recommendation if exists -->
				{#if currentItem.record && currentItem.record.status !== 'pending'}
					<div class="rounded-md bg-muted p-4 mb-4" data-testid="triage-agent-recommendation">
						<p class="text-sm font-medium mb-2">
							{#if currentItem.record.override_by}
								Override Decision
							{:else}
								Agent Recommendation
							{/if}
						</p>
						<div class="space-y-1 text-sm">
							<p data-testid="triage-rec-action">
								<span class="font-medium">Action:</span>
								{currentItem.record.action ? ACTION_LABELS[currentItem.record.action] : 'None'}
							</p>
							<p data-testid="triage-rec-reasoning">
								<span class="font-medium">Reasoning:</span>
								{currentItem.record.override_reasoning || currentItem.record.reasoning}
							</p>
							{#if currentItem.record.evidence_refs.length > 0}
								<p data-testid="triage-rec-evidence">
									<span class="font-medium">Evidence:</span>
									{currentItem.record.evidence_refs.join(', ')}
								</p>
							{/if}
							<p class="text-xs text-muted-foreground">
								Decided by: {currentItem.record.override_by || currentItem.record.decided_by}
							</p>
						</div>
					</div>
				{/if}

				<!-- AC: @interactive-triage-ui ac-8 - Hide action UI in static mode -->
				{#if !isStaticMode()}
					<Separator class="my-4" />

					<!-- AC: @interactive-triage-ui ac-3, ac-4 - Action selection and reasoning -->
					<div class="space-y-4" data-testid="triage-action-form">
						<div>
							<p class="text-sm font-medium mb-2">
								{currentItem.record && currentItem.record.status !== 'pending' ? 'Override Action' : 'Select Action'}
							</p>
							<div class="flex flex-wrap gap-2" data-testid="triage-action-buttons">
								{#each Object.entries(ACTION_LABELS) as [action, label]}
									<Button
										variant={selectedAction === action ? 'default' : 'outline'}
										size="sm"
										onclick={() => (selectedAction = action as TriageAction)}
										data-testid="triage-action-{action}"
									>
										{label}
									</Button>
								{/each}
							</div>
						</div>

						<div>
							<p class="text-sm font-medium mb-2">Reasoning</p>
							<Textarea
								placeholder="Why are you choosing this action?"
								bind:value={reasoning}
								rows={3}
								disabled={submitting}
								data-testid="triage-reasoning"
							/>
						</div>

						<div class="flex gap-2">
							<Button
								onclick={handleSubmit}
								disabled={submitting || !selectedAction || !reasoning.trim()}
								data-testid="triage-submit"
							>
								{#if submitting}
									Submitting...
								{:else if currentItem.record && currentItem.record.status !== 'pending'}
									Override Decision
								{:else}
									Submit Decision
								{/if}
							</Button>

							{#if currentItem.record?.status === 'triaged'}
								<Button
									variant="secondary"
									onclick={handleAct}
									disabled={submitting}
									data-testid="triage-act"
								>
									{submitting ? 'Executing...' : `Execute: ${currentItem.record.action ? ACTION_LABELS[currentItem.record.action] : ''}`}
								</Button>
							{/if}
						</div>
					</div>
				{:else}
					<!-- AC: @interactive-triage-ui ac-8 - Static mode: browsing only -->
					{#if !currentItem.record}
						<p class="text-sm text-muted-foreground mt-4">
							No triage decision recorded. Use the CLI or daemon to triage items.
						</p>
					{/if}
				{/if}
			</CardContent>
		</Card>
	{/if}
</div>
