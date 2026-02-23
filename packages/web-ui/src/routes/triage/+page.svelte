<script lang="ts">
	// AC: @interactive-triage-ui ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7, ac-8
	// AC: @trait-websocket-protocol ac-1, ac-2, ac-3
	import { onMount, onDestroy } from 'svelte';
	import type { InboxItem, BroadcastEvent } from '@kynetic-ai/shared';
	import type { TriageRecord, TriageAction } from '$lib/types/triage';
	import {
		fetchInbox,
		fetchTriageRecords,
		createTriageRecord,
		overrideTriageRecord,
		actOnTriageRecord
	} from '$lib/api';
	import { isStaticMode, ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { getProjectVersion } from '$lib/stores/project.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Separator } from '$lib/components/ui/separator';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	// Data state
	let inboxItems = $state<InboxItem[]>([]);
	let triageRecords = $state<TriageRecord[]>([]);
	let loading = $state(true);
	let error = $state('');

	// Card navigation state
	// AC: @interactive-triage-ui ac-5
	let currentIndex = $state(0);
	let submitting = $state(false);

	// Form state
	// AC: @interactive-triage-ui ac-3
	let selectedAction = $state<TriageAction | ''>('');
	let reasoning = $state('');

	// Filter state
	// AC: @interactive-triage-ui ac-7
	let filterTag = $state<string | ''>('');
	let filterStatus = $state<'all' | 'untriaged' | 'triaged' | 'acted_on'>('all');

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

	// Merged view: inbox items with their triage records
	interface TriageCardItem {
		inbox: InboxItem;
		record: TriageRecord | null;
	}

	// AC: @interactive-triage-ui ac-7 - Filtered items
	let allItems = $derived.by(() => {
		const items: TriageCardItem[] = inboxItems.map((inbox) => {
			const record = triageRecords.find((r) => r.inbox_ref === inbox._ulid) ?? null;
			return { inbox, record };
		});
		return items;
	});

	let filteredItems = $derived.by(() => {
		let items = allItems;

		// Tag filter
		if (filterTag) {
			items = items.filter((i) => i.inbox.tags.includes(filterTag));
		}

		// Status filter
		if (filterStatus === 'untriaged') {
			items = items.filter((i) => !i.record || i.record.status === 'pending');
		} else if (filterStatus === 'triaged') {
			items = items.filter((i) => i.record?.status === 'triaged');
		} else if (filterStatus === 'acted_on') {
			items = items.filter((i) => i.record?.status === 'acted_on');
		}

		return items;
	});

	let currentItem = $derived(filteredItems[currentIndex] ?? null);

	// AC: @interactive-triage-ui ac-7 - Progress count
	let triagedCount = $derived(allItems.filter((i) => i.record && i.record.status !== 'pending').length);
	let totalCount = $derived(allItems.length);

	// All unique tags for filter
	let allTags = $derived.by(() => {
		const tagSet = new Set<string>();
		inboxItems.forEach((item) => item.tags.forEach((t) => tagSet.add(t)));
		return Array.from(tagSet).sort();
	});

	onMount(async () => {
		await loadData();

		// AC: @interactive-triage-ui ac-6 - Subscribe to triage:updates
		// AC: @trait-websocket-protocol ac-2 - Subscribe to topic
		if (!isStaticMode()) {
			subscribe(['triage:updates']);
			on('triage:updates', handleTriageUpdate);
		}
	});

	onDestroy(() => {
		if (!isStaticMode()) {
			off('triage:updates', handleTriageUpdate);
			unsubscribe(['triage:updates']);
		}
	});

	// AC: @multi-directory-daemon ac-27 - Reload on project change
	$effect(() => {
		const version = getProjectVersion();
		if (version > 0) {
			loadData();
		}
	});

	// AC: @interactive-triage-ui ac-6 - Real-time update handler
	// AC: @trait-websocket-protocol ac-3 - Handle broadcast event
	function handleTriageUpdate(_event: BroadcastEvent) {
		// Reload triage records on any triage update
		loadTriageData();
	}

	async function loadData() {
		try {
			loading = true;
			error = '';
			const [inboxResponse, triageResponse] = await Promise.all([
				fetchInbox({ limit: 1000 }),
				fetchTriageRecords({ limit: 1000 })
			]);
			inboxItems = inboxResponse.items;
			triageRecords = triageResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load triage data';
		} finally {
			loading = false;
		}
	}

	async function loadTriageData() {
		try {
			const triageResponse = await fetchTriageRecords({ limit: 1000 });
			triageRecords = triageResponse.items;
		} catch (err) {
			console.error('Failed to reload triage records:', err);
		}
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
		error = '';
	}

	// Keyboard navigation
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowLeft') {
			goPrevious();
		} else if (e.key === 'ArrowRight') {
			goNext();
		}
	}

	// AC: @interactive-triage-ui ac-3 - Submit triage decision
	async function handleSubmit() {
		if (!currentItem || !selectedAction || !reasoning.trim()) return;

		if (isStaticMode()) {
			error = 'Cannot submit triage decisions in read-only mode.';
			return;
		}

		try {
			submitting = true;
			error = '';

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

			// Reload triage data
			await loadTriageData();

			// Auto-advance to next item
			// AC: @interactive-triage-ui ac-3 - advances to next item
			if (currentIndex < filteredItems.length - 1) {
				currentIndex++;
			}
			resetForm();
		} catch (err) {
			if (err instanceof ReadOnlyModeError) {
				error = err.message;
			} else {
				error = err instanceof Error ? err.message : 'Failed to submit triage decision';
			}
		} finally {
			submitting = false;
		}
	}

	// Execute the triage action
	async function handleAct() {
		if (!currentItem?.record) return;

		if (isStaticMode()) {
			error = 'Cannot execute triage actions in read-only mode.';
			return;
		}

		try {
			submitting = true;
			error = '';
			await actOnTriageRecord(currentItem.record._ulid);
			await loadTriageData();
		} catch (err) {
			if (err instanceof ReadOnlyModeError) {
				error = err.message;
			} else {
				error = err instanceof Error ? err.message : 'Failed to execute triage action';
			}
		} finally {
			submitting = false;
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
		// Track filter dependencies
		filterTag;
		filterStatus;
		currentIndex = 0;
		resetForm();
	});
</script>

<svelte:window onkeydown={handleKeydown} />

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
				bind:value={filterStatus}
				class="rounded-md border bg-background px-3 py-1.5 text-sm"
				data-testid="triage-status-filter"
			>
				<option value="all">All</option>
				<option value="untriaged">Untriaged</option>
				<option value="triaged">Triaged</option>
				<option value="acted_on">Acted On</option>
			</select>
			{#if allTags.length > 0}
				<select
					bind:value={filterTag}
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

	{#if loading}
		<div class="text-center text-muted-foreground py-12">Loading triage data...</div>
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
					<CardTitle class="text-lg leading-relaxed" data-testid="triage-card-text">
						{currentItem.inbox.text}
					</CardTitle>
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
