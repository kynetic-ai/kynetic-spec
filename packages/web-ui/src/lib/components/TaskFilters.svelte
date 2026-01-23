<script lang="ts">
	// AC: @web-dashboard ac-9, ac-10
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import {
		Select,
		SelectContent,
		SelectItem,
		SelectTrigger
	} from '$lib/components/ui/select';

	// Current filter values from URL
	$: status = $page.url.searchParams.get('status') || '';
	$: type = $page.url.searchParams.get('type') || '';
	$: tag = $page.url.searchParams.get('tag') || '';
	$: assignee = $page.url.searchParams.get('assignee') || '';
	$: automation = $page.url.searchParams.get('automation') || '';

	function updateFilter(key: string, value: string) {
		const params = new URLSearchParams($page.url.searchParams);

		if (value === '' || value === 'all') {
			params.delete(key);
		} else {
			params.set(key, value);
		}

		// Reset offset when filter changes
		params.delete('offset');

		goto(`?${params.toString()}`, { replaceState: false, keepFocus: true });
	}

	function clearFilters() {
		goto('/tasks', { replaceState: false });
	}

	$: hasFilters = status || type || tag || assignee || automation;
</script>

<div class="flex flex-wrap gap-4 p-4 bg-muted/50 rounded-lg">
	<div class="flex-1 min-w-[200px]">
		<label for="status-filter" class="text-sm font-medium mb-2 block">Status</label>
		<Select value={status || 'all'} onValueChange={(v) => updateFilter('status', v || 'all')}>
			<SelectTrigger id="status-filter">
				{status || 'All Statuses'}
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
		<Select value={type || 'all'} onValueChange={(v) => updateFilter('type', v || 'all')}>
			<SelectTrigger id="type-filter">
				{type || 'All Types'}
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
			value={automation || 'all'}
			onValueChange={(v) => updateFilter('automation', v || 'all')}
		>
			<SelectTrigger id="automation-filter">
				{automation || 'All'}
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
			type="text"
			placeholder="Filter by tag..."
			value={tag}
			on:input={(e) => updateFilter('tag', e.currentTarget.value)}
		/>
	</div>

	<div class="flex-1 min-w-[200px]">
		<label for="assignee-filter" class="text-sm font-medium mb-2 block">Assignee</label>
		<Input
			id="assignee-filter"
			type="text"
			placeholder="Filter by assignee..."
			value={assignee}
			on:input={(e) => updateFilter('assignee', e.currentTarget.value)}
		/>
	</div>

	{#if hasFilters}
		<div class="flex items-end">
			<Button variant="outline" on:click={clearFilters}>Clear Filters</Button>
		</div>
	{/if}
</div>
