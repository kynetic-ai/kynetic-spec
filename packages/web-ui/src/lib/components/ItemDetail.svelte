<script lang="ts">
	// AC: @web-dashboard ac-12, ac-13, ac-14, ac-15
	import type { ItemDetail, TaskSummary } from '@kynetic-ai/shared';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Sheet,
		SheetContent,
		SheetDescription,
		SheetHeader,
		SheetTitle
	} from '$lib/components/ui/sheet';
	import {
		Accordion,
		AccordionContent,
		AccordionItem,
		AccordionTrigger
	} from '$lib/components/ui/accordion';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { fetchItem, fetchItemTasks } from '$lib/api';

	export let ref: string | null = null;
	export let open = false;

	let item: ItemDetail | null = null;
	let linkedTasks: TaskSummary[] = [];
	let loading = false;
	let error: string | null = null;

	async function loadItem(itemRef: string) {
		loading = true;
		error = null;
		try {
			// Fetch item details
			item = await fetchItem(itemRef);

			// Fetch linked tasks
			// AC: @web-dashboard ac-13
			const tasksResponse = await fetchItemTasks(itemRef);
			linkedTasks = tasksResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load item';
			item = null;
			linkedTasks = [];
		} finally {
			loading = false;
		}
	}

	$: if (ref && open) {
		loadItem(ref);
	}

	function getStatusColor(status: string): string {
		const colors: Record<string, string> = {
			pending: 'bg-gray-500',
			in_progress: 'bg-blue-500',
			pending_review: 'bg-yellow-500',
			blocked: 'bg-red-500',
			completed: 'bg-green-500',
			cancelled: 'bg-gray-400'
		};
		return colors[status] || 'bg-gray-500';
	}
</script>

<Sheet bind:open>
	<SheetContent class="sm:max-w-2xl overflow-y-auto" data-testid="spec-detail-panel">
		{#if loading}
			<div class="space-y-4">
				<Skeleton class="h-8 w-3/4" />
				<Skeleton class="h-4 w-full" />
				<Skeleton class="h-4 w-full" />
				<Skeleton class="h-4 w-2/3" />
			</div>
		{:else if error}
			<div class="flex flex-col gap-4">
				<SheetHeader>
					<SheetTitle>Error</SheetTitle>
				</SheetHeader>
				<p class="text-destructive">{error}</p>
			</div>
		{:else if item}
			<div class="flex flex-col gap-6">
				<SheetHeader>
					<div class="flex items-center gap-2">
						<!-- AC: @web-dashboard ac-12 - Title and type -->
						<Badge data-testid="implementation-status">{item.type}</Badge>
						<SheetTitle data-testid="spec-title">{item.title}</SheetTitle>
					</div>
					{#if item.description}
						<SheetDescription data-testid="spec-description">{item.description}</SheetDescription>
					{/if}
				</SheetHeader>

				<!-- Tags -->
				{#if item.tags.length > 0}
					<div>
						<h3 class="text-sm font-semibold mb-2">Tags</h3>
						<div class="flex flex-wrap gap-1">
							{#each item.tags as tag}
								<Badge variant="outline">{tag}</Badge>
							{/each}
						</div>
					</div>
				{/if}

				<!-- AC: @web-dashboard ac-12, ac-15 - Acceptance Criteria (GWT format) -->
				{#if item.acceptance_criteria && item.acceptance_criteria.length > 0}
					<div data-testid="acceptance-criteria">
						<h3 class="text-sm font-semibold mb-2">Acceptance Criteria</h3>
						<Accordion type="multiple" class="w-full">
							{#each item.acceptance_criteria as ac, i}
								<AccordionItem value={ac._ulid} data-testid="ac-item">
									<AccordionTrigger data-testid="ac-expand-toggle">
										<span class="text-sm" data-testid="ac-given">AC-{i + 1}: {ac.given}</span>
									</AccordionTrigger>
									<AccordionContent>
										<div class="space-y-2 text-sm pl-4">
											<div data-testid="ac-given-full">
												<span class="font-medium text-muted-foreground">Given:</span>
												{ac.given}
											</div>
											<div data-testid="ac-when ac-when-full">
												<span class="font-medium text-muted-foreground">When:</span>
												{ac.when}
											</div>
											<div data-testid="ac-then ac-then-full">
												<span class="font-medium text-muted-foreground">Then:</span>
												{ac.then}
											</div>
											<!-- Test coverage indicator placeholder -->
											<div data-testid="test-coverage-indicator" class="text-xs text-muted-foreground mt-2 uncovered">
												<!-- TODO: Integrate test coverage data -->
												Coverage: Unknown
											</div>
										</div>
									</AccordionContent>
								</AccordionItem>
							{/each}
						</Accordion>
					</div>
				{/if}

				<!-- AC: @web-dashboard ac-14 - Traits as chips -->
				{#if item.traits && item.traits.length > 0}
					<div data-testid="traits-section">
						<h3 class="text-sm font-semibold mb-2">Traits</h3>
						<div class="flex flex-wrap gap-2">
							{#each item.traits as trait}
								<Button
									variant="outline"
									size="sm"
									data-testid="trait-chip"
									on:click={() => {
										// TODO: Navigate to trait detail or show trait info
										console.log('Trait clicked:', trait);
									}}
								>
									<span data-testid="trait-title">{trait}</span>
								</Button>
							{/each}
						</div>
					</div>
				{/if}

				<!-- AC: @web-dashboard ac-13 - Linked tasks with status -->
				{#if linkedTasks.length > 0}
					<div data-testid="implementation-section">
						<h3 class="text-sm font-semibold mb-2">Implementation</h3>
						<div class="space-y-2">
							{#each linkedTasks as task}
								<a
									href="/tasks?ref={encodeURIComponent(task._ulid)}"
									class="flex items-center gap-2 p-2 rounded border hover:bg-muted/50 transition-colors"
									data-testid="linked-task"
								>
									<Badge class={getStatusColor(task.status)} data-testid="task-status-badge"
										>{task.status}</Badge
									>
									<span class="text-sm flex-1" data-testid="task-title">{task.title}</span>
									{#if task.notes_count > 0}
										<Badge variant="secondary" class="text-xs">{task.notes_count} notes</Badge>
									{/if}
								</a>
							{/each}
						</div>
					</div>
				{:else}
					<div data-testid="implementation-section">
						<h3 class="text-sm font-semibold mb-2">Implementation</h3>
						<p class="text-sm text-muted-foreground">No tasks linked to this spec item yet.</p>
					</div>
				{/if}
			</div>
		{/if}
	</SheetContent>
</Sheet>
