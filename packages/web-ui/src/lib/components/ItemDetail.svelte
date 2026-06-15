<script lang="ts">
	// AC: @web-dashboard ac-12, ac-13, ac-14, ac-15
	import type { ItemDetail, TaskSummary } from '@kynetic-ai/shared';
	import { base } from '$app/paths';
	import type { SessionSummary } from '$lib/api';
	import { Badge } from '$lib/components/ui/badge';
	import { StatusBadge } from '$lib/components/ds';
	import {
		Sheet,
		SheetContent,
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
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import { fetchItem, fetchItemTasks, fetchItemSessions } from '$lib/api';
	import { renderInlineMarkdown, renderMarkdown } from '$lib/utils/markdown';
	import { CheckCircle, XCircle, HelpCircle } from 'lucide-svelte';
	import RelatedSessionsSection from '$lib/components/session/RelatedSessionsSection.svelte';

	interface Props {
		ref: string | null;
		open: boolean;
	}

	let { ref, open = $bindable(false) }: Props = $props();

	let item = $state<ItemDetail | null>(null);
	let linkedTasks = $state<TaskSummary[]>([]);
	let relatedSessions = $state<SessionSummary[]>([]);
	let sessionsError = $state('');
	let loading = $state(false);
	let error = $state<string | null>(null);

	async function loadItem(itemRef: string) {
		loading = true;
		error = null;
		sessionsError = '';
		try {
			const [itemResponse, tasksResponse] = await Promise.all([
				fetchItem(itemRef),
				fetchItemTasks(itemRef)
			]);
			item = itemResponse;
			linkedTasks = tasksResponse.items;
			try {
				const sessionsResponse = await fetchItemSessions(itemRef);
				relatedSessions = sessionsResponse.items;
			} catch (sessionErr) {
				sessionsError =
					sessionErr instanceof Error ? sessionErr.message : 'Failed to load related sessions';
				relatedSessions = [];
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load item';
			item = null;
			linkedTasks = [];
			relatedSessions = [];
			sessionsError = '';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (ref && open) {
			loadItem(ref);
		}
	});

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
						<div
							class="text-muted-foreground text-sm prose prose-sm dark:prose-invert max-w-none"
							data-testid="spec-description"
						>
							{@html renderMarkdown(item.description)}
						</div>
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
										<span class="text-sm" data-testid="ac-given">
											{@html renderInlineMarkdown(`AC-${i + 1}: ${ac.given}`)}
										</span>
									</AccordionTrigger>
									<AccordionContent>
										<div class="space-y-2 text-sm pl-4">
											<div
												data-testid="ac-given-full"
												class="prose prose-sm dark:prose-invert max-w-none"
											>
												<span class="font-medium text-muted-foreground">Given:</span>
												{@html renderInlineMarkdown(` ${ac.given}`)}
											</div>
											<div
												data-testid="ac-when-full"
												class="prose prose-sm dark:prose-invert max-w-none"
											>
												<span class="font-medium text-muted-foreground">When:</span>
												{@html renderInlineMarkdown(` ${ac.when}`)}
											</div>
											<div
												data-testid="ac-then-full"
												class="prose prose-sm dark:prose-invert max-w-none"
											>
												<span class="font-medium text-muted-foreground">Then:</span>
												{@html renderInlineMarkdown(` ${ac.then}`)}
											</div>
											<!-- AC: @web-dashboard ac-15 - Test coverage indicator -->
											<div
												data-testid="test-coverage-indicator"
												class="text-xs mt-2 inline-flex items-center gap-1 {ac.covered === true
													? 'text-green-600 covered'
													: ac.covered === false
														? 'text-amber-600 uncovered'
														: 'text-muted-foreground unknown'}"
											>
												{#if ac.covered === true}
													<CheckCircle class="w-3 h-3" />
													<span>Covered</span>
												{:else if ac.covered === false}
													<XCircle class="w-3 h-3" />
													<span>Not covered</span>
												{:else}
													<HelpCircle class="w-3 h-3" />
													<span>Coverage: Unknown</span>
												{/if}
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
								<span data-testid="trait-chip">
									<!-- AC: @web-dashboard ac-14 - Navigate to trait detail -->
									<ReferenceLink ref={trait} type="spec" class="text-sm" />
								</span>
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
									href="{base}/tasks?ref={encodeURIComponent(task._ulid)}"
									class="flex items-center gap-2 p-2 rounded border hover:bg-muted/50 transition-colors"
									data-testid="linked-task"
								>
									<StatusBadge domain="task" state={task.status} testid="task-status-badge" />
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

				<!-- AC: @task-spec-session-context ac-spec-detail-sessions, ac-session-list-spec-filter -->
				<RelatedSessionsSection
					title="Sessions"
					sessions={relatedSessions}
					loading={false}
					error={sessionsError}
					filterHref={`${base}/sessions?spec_ref=${encodeURIComponent(`@${item.slugs[0] || item._ulid}`)}`}
					emptyMessage="No sessions are linked to tasks for this spec item yet."
					dataTestId="item-related-sessions"
				/>
			</div>
		{/if}
	</SheetContent>
</Sheet>
