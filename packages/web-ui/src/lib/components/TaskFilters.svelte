<script lang="ts">
	// AC: @web-dashboard ac-9, ac-10
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
		'': 'All Statuses',
		all: 'All Statuses',
		pending: 'Pending',
		in_progress: 'In Progress',
		pending_review: 'Pending Review',
		blocked: 'Blocked',
		completed: 'Completed',
		cancelled: 'Cancelled'
	};

	// Display labels for type values
	const typeLabels: Record<string, string> = {
		'': 'All Types',
		all: 'All Types',
		task: 'Task',
		subtask: 'Subtask'
	};

	// Display labels for automation values
	const automationLabels: Record<string, string> = {
		'': 'All',
		all: 'All',
		eligible: 'Eligible',
		blocked: 'Blocked'
	};

	// Derive filter values from URL - use $derived with $page store
	let status = $derived($page.url.searchParams.get('status') || '');
	let type = $derived($page.url.searchParams.get('type') || '');
	let tag = $derived($page.url.searchParams.get('tag') || '');
	let assignee = $derived($page.url.searchParams.get('assignee') || '');
	let automation = $derived($page.url.searchParams.get('automation') || '');

	let hasFilters = $derived(status || type || tag || assignee || automation);

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

		if (!actualValue || actualValue === 'all') {
			params.delete(key);
		} else {
			params.set(key, actualValue);
		}

		// Reset offset when filter changes
		params.delete('offset');

		const newUrl = `${base}/tasks?${params.toString()}`;
		goto(newUrl, { replaceState: false, keepFocus: true });
	}

	function clearFilters() {
		goto(`${base}/tasks`, { replaceState: false });
	}

	// Compute the display value for Select triggers
	let statusDisplay = $derived(status || 'all');
	let typeDisplay = $derived(type || 'all');
	let automationDisplay = $derived(automation || 'all');
</script>

<div class="flex flex-wrap gap-4 p-4 bg-muted/50 rounded-lg" data-testid="filter-controls">
	<div class="flex-1 min-w-[200px]">
		<label for="status-filter" class="text-sm font-medium mb-2 block">Status</label>
		<Select
			value={statusDisplay}
			onValueChange={(v) => updateFilter('status', v)}
		>
			<SelectTrigger id="status-filter" data-testid="filter-status">
				{statusLabels[statusDisplay] || 'All Statuses'}
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="all">All Statuses</SelectItem>
				<SelectItem value="pending">Pending</SelectItem>
				<SelectItem value="in_progress">In Progress</SelectItem>
				<SelectItem value="pending_review">Pending Review</SelectItem>
				<SelectItem value="blocked">Blocked</SelectItem>
				<SelectItem value="completed">Completed</SelectItem>
				<SelectItem value="cancelled">Cancelled</SelectItem>
			</SelectContent>
		</Select>
	</div>

	<div class="flex-1 min-w-[200px]">
		<label for="type-filter" class="text-sm font-medium mb-2 block">Type</label>
		<Select
			value={typeDisplay}
			onValueChange={(v) => updateFilter('type', v)}
		>
			<SelectTrigger id="type-filter" data-testid="filter-type">
				{typeLabels[typeDisplay] || 'All Types'}
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="all">All Types</SelectItem>
				<SelectItem value="task">Task</SelectItem>
				<SelectItem value="subtask">Subtask</SelectItem>
			</SelectContent>
		</Select>
	</div>

	<div class="flex-1 min-w-[200px]">
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
				<SelectItem value="blocked">Blocked</SelectItem>
			</SelectContent>
		</Select>
	</div>

	<div class="flex-1 min-w-[200px]">
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

	<div class="flex-1 min-w-[200px]">
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
