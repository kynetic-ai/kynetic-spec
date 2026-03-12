<script lang="ts" module>
	// AC: @web-dashboard ac-default-active-filter
	export const ACTIVE_STATUSES = ['pending', 'in_progress', 'pending_review', 'needs_work', 'blocked'] as const;
</script>

<script lang="ts">
	// AC: @web-dashboard ac-9, ac-10, ac-default-active-filter
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { base } from '$app/paths';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import {
		Select,
		SelectContent,
		SelectItem,
		SelectTrigger
	} from '$lib/components/ui/select';

	// Display labels for status values
	const statusLabels: Record<string, string> = {
		'': 'Active',
		active: 'Active',
		all: 'All Statuses',
		pending: 'Pending',
		in_progress: 'In Progress',
		pending_review: 'Pending Review',
		needs_work: 'Needs Work',
		blocked: 'Blocked',
		completed: 'Completed',
		cancelled: 'Cancelled'
	};

	// Display labels for automation values
	// Values match AutomationStatusSchema: eligible, needs_review, manual_only
	const automationLabels: Record<string, string> = {
		'': 'All',
		all: 'All',
		eligible: 'Eligible',
		needs_review: 'Needs Review',
		manual_only: 'Manual Only'
	};

	// Derive filter values from URL - use $derived with $page store
	let status = $derived($page.url.searchParams.get('status') || '');
	let tag = $derived($page.url.searchParams.get('tag') || '');
	let assignee = $derived($page.url.searchParams.get('assignee') || '');
	let automation = $derived($page.url.searchParams.get('automation') || '');

	// AC: @web-dashboard ac-default-active-filter — non-default filters are: explicit status, tag, assignee, automation
	// Empty status means "active" (the default), so only count as filtered if it's a specific single status or "all"
	let hasFilters = $derived(status || tag || assignee || automation);

	function updateFilter(key: string, value: string | string[] | undefined) {
		// Handle the case where value might be an array (bits-ui Svelte 5 quirk)
		// The quirk produces arrays like ['a', 'l', 'l', 'in_progress'] - we want the last element
		let actualValue: string | undefined;
		if (Array.isArray(value)) {
			actualValue = value.length > 0 ? value[value.length - 1] : undefined;
		} else {
			actualValue = value;
		}

		const params = new URLSearchParams($page.url.searchParams);

		// AC: @web-dashboard ac-default-active-filter
		// "active" maps to no status param (default behavior shows active statuses)
		// "all" explicitly requests all statuses including completed/cancelled
		if (key === 'status') {
			if (!actualValue || actualValue === 'active') {
				params.delete(key);
			} else {
				params.set(key, actualValue);
			}
		} else {
			if (!actualValue || actualValue === 'all') {
				params.delete(key);
			} else {
				params.set(key, actualValue);
			}
		}

		// Reset offset when filter changes
		params.delete('offset');

		const newUrl = `${base}/tasks?${params.toString()}`;
		goto(newUrl, { replaceState: false, keepFocus: true });
	}

	function clearFilters() {
		goto(`${base}/tasks`, { replaceState: false });
	}

	// AC: @web-dashboard ac-default-active-filter — empty status means "active" (default)
	let statusDisplay = $derived(status || 'active');
	let automationDisplay = $derived(automation || 'all');
</script>

<div class="flex flex-wrap gap-4 p-4 bg-muted/50 rounded-lg" data-testid="filter-controls">
	<div class="flex-1 min-w-[140px]">
		<label for="status-filter" class="text-sm font-medium mb-2 block">Status</label>
		<Select
			value={statusDisplay}
			onValueChange={(v) => updateFilter('status', v)}
		>
			<SelectTrigger id="status-filter" data-testid="filter-status">
				{statusLabels[statusDisplay] || 'Active'}
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="active">Active</SelectItem>
				<SelectItem value="all">All Statuses</SelectItem>
				<SelectItem value="pending">Pending</SelectItem>
				<SelectItem value="in_progress">In Progress</SelectItem>
				<SelectItem value="pending_review">Pending Review</SelectItem>
				<SelectItem value="needs_work">Needs Work</SelectItem>
				<SelectItem value="blocked">Blocked</SelectItem>
				<SelectItem value="completed">Completed</SelectItem>
				<SelectItem value="cancelled">Cancelled</SelectItem>
			</SelectContent>
		</Select>
	</div>

	<div class="flex-1 min-w-[140px]">
		<label for="automation-filter" class="text-sm font-medium mb-2 block">Automation</label>
		<Select
			value={automationDisplay}
			onValueChange={(v) => updateFilter('automation', v)}
		>
			<SelectTrigger id="automation-filter" data-testid="filter-automation">
				{automationLabels[automationDisplay] || 'All'}
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="all">All</SelectItem>
				<SelectItem value="eligible">Eligible</SelectItem>
				<SelectItem value="needs_review">Needs Review</SelectItem>
				<SelectItem value="manual_only">Manual Only</SelectItem>
			</SelectContent>
		</Select>
	</div>

	<div class="flex-1 min-w-[140px]">
		<label for="tag-filter" class="text-sm font-medium mb-2 block">Tag</label>
		<Input
			id="tag-filter"
			data-testid="filter-tag"
			type="text"
			placeholder="Filter by tag..."
			value={tag}
			oninput={(e) => updateFilter('tag', (e.target as HTMLInputElement).value)}
		/>
	</div>

	<div class="flex-1 min-w-[140px]">
		<label for="assignee-filter" class="text-sm font-medium mb-2 block">Assignee</label>
		<Input
			id="assignee-filter"
			data-testid="filter-assignee"
			type="text"
			placeholder="Filter by assignee..."
			value={assignee}
			oninput={(e) => updateFilter('assignee', (e.target as HTMLInputElement).value)}
		/>
	</div>

	{#if hasFilters}
		<div class="flex items-end">
			<Button variant="outline" onclick={clearFilters}>Clear Filters</Button>
		</div>
	{/if}
</div>
