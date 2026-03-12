<!--
  AC: @ui-inbox-enhanced ac-1 — Each item shows triage status inline with quick triage action links.
  AC: @ui-inbox-enhanced ac-2 — Filters by status, tags, age.
-->
<script lang="ts">
	// AC: @multi-directory-daemon ac-27 - Reload on project change
	// AC: @gh-pages-export ac-17 - Hide Add button in static mode
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import type { InboxItem, BroadcastEvent } from '@kynetic-ai/shared';
	import type { TriageRecord } from '$lib/types/triage';
	import {
		fetchInbox,
		addInboxItem,
		deleteInboxItem,
		fetchTriageRecords
	} from '$lib/api';
	import { isStaticMode, ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogFooter,
		DialogHeader,
		DialogTitle
	} from '$lib/components/ui/dialog';
	import { getProjectVersion, isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { renderMarkdown } from '$lib/utils/markdown';
	import Inbox from '@lucide/svelte/icons/inbox';

	// ── Data state ──
	let inboxItems = $state<InboxItem[]>([]);
	let triageRecords = $state<TriageRecord[]>([]);
	let loading = $state(true);
	let error = $state('');

	// ── Add item state ──
	let showAddInput = $state(false);
	let newItemText = $state('');
	let addingItem = $state(false);

	// ── Delete state ──
	let deleteConfirmOpen = $state(false);
	let itemToDelete = $state<InboxItem | null>(null);
	let deletingItem = $state(false);

	// ── Triage status labels and colors ──
	const TRIAGE_STATUS_LABELS: Record<string, string> = {
		untriaged: 'Untriaged',
		triaged: 'Triaged',
		acted_on: 'Acted On'
	};

	const TRIAGE_STATUS_COLORS: Record<string, string> = {
		untriaged: 'bg-status-pending text-status-pending-fg',
		triaged: 'bg-status-pending-review text-status-pending-review-fg',
		acted_on: 'bg-status-completed text-status-completed-fg'
	};

	// ── Filter state ──
	// AC: @ui-inbox-enhanced ac-2
	type TriageFilterStatus = 'all' | 'untriaged' | 'triaged' | 'acted_on';
	const TRIAGE_STATUS_VALUES: readonly TriageFilterStatus[] = ['all', 'untriaged', 'triaged', 'acted_on'];

	let filterStatus = $derived.by((): TriageFilterStatus => {
		const raw = page.url.searchParams.get('status');
		if (raw && TRIAGE_STATUS_VALUES.includes(raw as TriageFilterStatus)) {
			return raw as TriageFilterStatus;
		}
		return 'all';
	});
	let filterTag = $derived(page.url.searchParams.get('tag') || '');
	let filterAge = $derived(page.url.searchParams.get('age') || '');

	// ── Merged inbox + triage view ──
	interface InboxCardItem {
		inbox: InboxItem;
		record: TriageRecord | null;
		triageStatus: string;
	}

	// AC: @ui-inbox-enhanced ac-1 — Merge inbox items with triage records
	let allItems = $derived.by(() => {
		return inboxItems.map((inbox) => {
			const record = triageRecords.find((r) => r.inbox_ref === inbox._ulid) ?? null;
			const triageStatus = record
				? record.status === 'pending'
					? 'untriaged'
					: record.status
				: 'untriaged';
			return { inbox, record, triageStatus };
		});
	});

	// AC: @ui-inbox-enhanced ac-2 — Filtered items
	let filteredItems = $derived.by(() => {
		let items = allItems;

		// Status filter
		if (filterStatus === 'untriaged') {
			items = items.filter((i) => i.triageStatus === 'untriaged');
		} else if (filterStatus === 'triaged') {
			items = items.filter((i) => i.triageStatus === 'triaged');
		} else if (filterStatus === 'acted_on') {
			items = items.filter((i) => i.triageStatus === 'acted_on');
		}

		// Tag filter
		if (filterTag) {
			items = items.filter((i) => i.inbox.tags.includes(filterTag));
		}

		// Age filter
		if (filterAge) {
			const now = Date.now();
			const cutoffs: Record<string, number> = {
				'1d': 86400000,
				'7d': 604800000,
				'30d': 2592000000
			};
			const cutoff = cutoffs[filterAge];
			if (cutoff) {
				items = items.filter((i) => now - new Date(i.inbox.created_at).getTime() <= cutoff);
			}
		}

		return items;
	});

	// All unique tags across inbox items
	let allTags = $derived.by(() => {
		const tagSet = new Set<string>();
		inboxItems.forEach((item) => item.tags.forEach((t) => tagSet.add(t)));
		return Array.from(tagSet).sort();
	});

	// Counts for status summary
	let untriagedCount = $derived(allItems.filter((i) => i.triageStatus === 'untriaged').length);
	let triagedCount = $derived(allItems.filter((i) => i.triageStatus === 'triaged').length);
	let actedCount = $derived(allItems.filter((i) => i.triageStatus === 'acted_on').length);

	// ── Lifecycle ──
	onMount(() => {
		// Subscribe to real-time updates
		if (!isStaticMode()) {
			subscribe(['inbox:updates', 'triage:updates']);
			on('inbox:updates', handleInboxUpdate);
			on('triage:updates', handleTriageUpdate);
		}
	});

	onDestroy(() => {
		if (!isStaticMode()) {
			off('inbox:updates', handleInboxUpdate);
			off('triage:updates', handleTriageUpdate);
			unsubscribe(['inbox:updates', 'triage:updates']);
		}
	});

	// Load data when project is ready and reload on project change.
	// Gates on isProjectInitialized() to prevent loading with wrong/missing project context.
	// AC: @multi-directory-daemon ac-27 - Reload data when project changes
	$effect(() => {
		const version = getProjectVersion();
		const ready = isProjectInitialized();
		if (!ready) return;
		loadData();
	});

	// ── Data loading ──
	async function loadData() {
		try {
			loading = true;
			error = '';
			const inboxResponse = await fetchInbox({ limit: 1000 });
			inboxItems = inboxResponse.items;

			// Load triage records separately — if triage fails, inbox still shows
			try {
				const triageResponse = await fetchTriageRecords({ limit: 1000 });
				triageRecords = triageResponse.items;
			} catch {
				triageRecords = [];
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load inbox';
		} finally {
			loading = false;
		}
	}

	// ── WebSocket handlers ──
	function handleInboxUpdate(_event: BroadcastEvent) {
		loadData();
	}

	function handleTriageUpdate(_event: BroadcastEvent) {
		loadTriageData();
	}

	async function loadTriageData() {
		try {
			const triageResponse = await fetchTriageRecords({ limit: 1000 });
			triageRecords = triageResponse.items;
		} catch (err) {
			console.error('Failed to reload triage records:', err);
		}
	}

	// ── Filter URL management ──
	function updateFilterParam(key: 'status' | 'tag' | 'age', value: string) {
		const params = new URLSearchParams(page.url.searchParams);

		if (!value || value === 'all') {
			params.delete(key);
		} else {
			params.set(key, value);
		}

		const query = params.toString();
		const nextUrl = query ? `${base}/inbox?${query}` : `${base}/inbox`;
		goto(nextUrl, { replaceState: false, keepFocus: true, noScroll: true });
	}

	// ── Add item ──
	async function handleAddItem() {
		if (!newItemText.trim()) return;

		if (isStaticMode()) {
			error = 'Cannot add items in read-only mode. Use the kspec CLI.';
			return;
		}

		try {
			addingItem = true;
			error = '';
			const newItem = await addInboxItem(newItemText.trim());
			inboxItems = [newItem, ...inboxItems];
			newItemText = '';
			showAddInput = false;
		} catch (err) {
			if (err instanceof ReadOnlyModeError) {
				error = err.message;
			} else {
				error = err instanceof Error ? err.message : 'Failed to add item';
			}
		} finally {
			addingItem = false;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			handleAddItem();
		}
	}

	// ── Delete item ──
	function confirmDelete(item: InboxItem) {
		itemToDelete = item;
		deleteConfirmOpen = true;
	}

	async function handleDelete() {
		if (!itemToDelete) return;

		if (isStaticMode()) {
			error = 'Cannot delete items in read-only mode. Use the kspec CLI.';
			deleteConfirmOpen = false;
			itemToDelete = null;
			return;
		}

		try {
			deletingItem = true;
			error = '';
			await deleteInboxItem(itemToDelete._ulid);
			inboxItems = inboxItems.filter((i) => i._ulid !== itemToDelete!._ulid);
			deleteConfirmOpen = false;
			itemToDelete = null;
		} catch (err) {
			if (err instanceof ReadOnlyModeError) {
				error = err.message;
			} else {
				error = err instanceof Error ? err.message : 'Failed to delete item';
			}
		} finally {
			deletingItem = false;
		}
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

	function getTriageStatusLabel(item: InboxCardItem): string {
		return TRIAGE_STATUS_LABELS[item.triageStatus] || 'Untriaged';
	}

	function getTriageStatusColor(item: InboxCardItem): string {
		return TRIAGE_STATUS_COLORS[item.triageStatus] || TRIAGE_STATUS_COLORS.untriaged;
	}
</script>

<div class="flex flex-col gap-4 p-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold">Inbox</h1>
			{#if !loading}
				<p class="text-sm text-muted-foreground" data-testid="inbox-summary">
					{allItems.length} item{allItems.length === 1 ? '' : 's'}
					&middot; {untriagedCount} untriaged, {triagedCount} triaged, {actedCount} acted on
					{#if filteredItems.length !== allItems.length}
						&middot; Showing {filteredItems.length} filtered
					{/if}
				</p>
			{/if}
		</div>
		{#if !isStaticMode()}
			<Button
				data-testid="add-inbox-button"
				onclick={() => (showAddInput = !showAddInput)}
				variant={showAddInput ? 'secondary' : 'default'}
			>
				{showAddInput ? 'Cancel' : 'Add Item'}
			</Button>
		{/if}
	</div>

	<!-- AC: @ui-inbox-enhanced ac-2 — Filter controls -->
	<div class="flex flex-wrap gap-2 items-center" data-testid="inbox-filters">
		<select
			value={filterStatus}
			onchange={(event) => updateFilterParam('status', (event.currentTarget as HTMLSelectElement).value)}
			class="rounded-md border bg-background px-3 py-1.5 text-sm"
			data-testid="inbox-status-filter"
		>
			<option value="all">All Status</option>
			<option value="untriaged">Untriaged</option>
			<option value="triaged">Triaged</option>
			<option value="acted_on">Acted On</option>
		</select>

		{#if allTags.length > 0}
			<select
				value={filterTag}
				onchange={(event) => updateFilterParam('tag', (event.currentTarget as HTMLSelectElement).value)}
				class="rounded-md border bg-background px-3 py-1.5 text-sm"
				data-testid="inbox-tag-filter"
			>
				<option value="">All Tags</option>
				{#each allTags as tag}
					<option value={tag}>{tag}</option>
				{/each}
			</select>
		{/if}

		<select
			value={filterAge}
			onchange={(event) => updateFilterParam('age', (event.currentTarget as HTMLSelectElement).value)}
			class="rounded-md border bg-background px-3 py-1.5 text-sm"
			data-testid="inbox-age-filter"
		>
			<option value="">Any Age</option>
			<option value="1d">Last 24 hours</option>
			<option value="7d">Last 7 days</option>
			<option value="30d">Last 30 days</option>
		</select>
	</div>

	{#if error}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg text-sm" data-testid="error-message" role="alert">
			{error}
		</div>
	{/if}

	<!-- Add input field -->
	{#if showAddInput}
		<Card data-testid="inbox-add-form">
			<CardContent class="pt-6">
				<div class="flex gap-2">
					<Input
						data-testid="inbox-input"
						bind:value={newItemText}
						placeholder="Enter inbox item text (press Enter to submit)"
						onkeydown={handleKeydown}
						disabled={addingItem}
						class="flex-1"
					/>
					<Button data-testid="inbox-submit" onclick={handleAddItem} disabled={addingItem || !newItemText.trim()}>
						{addingItem ? 'Adding...' : 'Add'}
					</Button>
				</div>
			</CardContent>
		</Card>
	{/if}

	<!-- Inbox list -->
	{#if loading}
		<div class="space-y-2" data-testid="inbox-loading">
			{#each Array(5) as _}
				<div class="h-20 rounded-lg bg-muted ds-shimmer"></div>
			{/each}
		</div>
	{:else if filteredItems.length === 0}
		<div class="flex flex-col items-center justify-center py-16" data-testid="inbox-empty">
			<Inbox class="size-12 text-muted-foreground/30 mb-4" />
			{#if allItems.length === 0}
				<h2 class="text-lg font-medium text-muted-foreground mb-1">No inbox items</h2>
				<p class="text-sm text-muted-foreground">
					{#if isStaticMode()}
						No inbox items in the snapshot.
					{:else}
						Click "Add Item" to capture ideas and thoughts.
					{/if}
				</p>
			{:else}
				<h2 class="text-lg font-medium text-muted-foreground mb-1">No matching items</h2>
				<p class="text-sm text-muted-foreground">Try adjusting the filters above.</p>
			{/if}
		</div>
	{:else}
		<div class="flex flex-col gap-3" data-testid="inbox-list">
			{#each filteredItems as item (item.inbox._ulid)}
				<!-- AC: @ui-inbox-enhanced ac-1 — Item with triage status inline -->
				<Card class="transition-all duration-200 hover:shadow-md" data-testid="inbox-item">
					<CardHeader class="pb-3">
						<div class="flex items-start justify-between gap-4">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-1">
									<!-- AC: @ui-inbox-enhanced ac-1 — Triage status badge -->
									<Badge
										class={getTriageStatusColor(item)}
										data-testid="inbox-triage-status"
									>
										{getTriageStatusLabel(item)}
									</Badge>
									{#if item.record?.action}
										<span class="text-xs text-muted-foreground" data-testid="inbox-triage-action">
											{item.record.action}
										</span>
									{/if}
								</div>
								<div
									class="text-sm break-words leading-relaxed prose prose-sm dark:prose-invert max-w-none"
									data-testid="inbox-text"
								>
									{@html renderMarkdown(item.inbox.text)}
								</div>
							</div>
							<div class="flex items-center gap-1 flex-shrink-0">
								<!-- AC: @ui-inbox-enhanced ac-1 — Quick triage action link -->
								{#if !isStaticMode() && item.triageStatus === 'untriaged'}
									<Button
										variant="ghost"
										size="sm"
										href="{base}/triage?status=untriaged"
										data-testid="inbox-triage-link"
										class="text-xs"
									>
										Triage
									</Button>
								{/if}
								{#if !isStaticMode()}
									<Button
										data-testid="delete-inbox-button"
										variant="ghost"
										size="sm"
										onclick={() => confirmDelete(item.inbox)}
										class="text-destructive hover:text-destructive hover:bg-destructive/10"
									>
										Delete
									</Button>
								{/if}
							</div>
						</div>
					</CardHeader>
					<CardContent class="pt-0">
						<div class="flex items-center gap-2 text-xs text-muted-foreground">
							<span data-testid="inbox-created-at">{formatDate(item.inbox.created_at)}</span>
							<span>&middot;</span>
							<span data-testid="inbox-added-by">{item.inbox.added_by}</span>
							{#if item.inbox.tags.length > 0}
								<span>&middot;</span>
								<div class="flex gap-1" data-testid="inbox-tags">
									{#each item.inbox.tags as tag}
										<Badge variant="secondary" class="text-xs">{tag}</Badge>
									{/each}
								</div>
							{/if}
						</div>
					</CardContent>
				</Card>
			{/each}
		</div>
	{/if}
</div>

<!-- Delete confirmation dialog -->
<Dialog bind:open={deleteConfirmOpen}>
	<DialogContent data-testid="confirm-delete-dialog">
		<DialogHeader>
			<DialogTitle>Delete Inbox Item?</DialogTitle>
			<DialogDescription>
				Are you sure you want to delete this inbox item? This action cannot be undone.
			</DialogDescription>
		</DialogHeader>
		{#if itemToDelete}
			<div class="rounded-md bg-muted p-3 text-sm">
				{itemToDelete.text}
			</div>
		{/if}
		<DialogFooter>
			<Button data-testid="confirm-delete-no" variant="outline" onclick={() => (deleteConfirmOpen = false)} disabled={deletingItem}>
				Cancel
			</Button>
			<Button data-testid="confirm-delete-yes" variant="destructive" onclick={handleDelete} disabled={deletingItem}>
				{deletingItem ? 'Deleting...' : 'Delete'}
			</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>
