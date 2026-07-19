<!--
  AC: @web-dashboard ac-5 — Task detail content showing description, notes, todos, dependencies.
  AC: @web-dashboard ac-6 — Spec reference is clickable link to spec item detail.
  AC: @web-dashboard ac-7 — Start Task action button.
  AC: @web-dashboard ac-8 — Add Note textarea and submit.
  AC: @gh-pages-export ac-16 — Buttons disabled with tooltip in static mode.

  Shared task detail content used by both TaskDetailModal (kanban board)
  and the task list Dialog modal. Handles all task display, actions, and notes.
-->
<script lang="ts">
	import type { TaskDetail, ReviewSummary } from '@kynetic-ai/shared';
	import { base } from '$app/paths';
	import {
		startTask,
		submitTask,
		completeTask,
		blockTask,
		addTaskNote,
		fetchTaskSessions,
		fetchReviewsForTask,
		type SessionSummary
	} from '$lib/api';
	import { isStaticMode, ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Input } from '$lib/components/ui/input';
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import { renderMarkdown } from '$lib/utils/markdown';
	import {
		rewriteTaskResourceLinks,
		findUnmatchedTaskResourceReferences
	} from '$lib/utils/task-resource-links';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { getStatusClasses, formatVcsRef } from './board-utils';
	import GitBranch from 'lucide-svelte/icons/git-branch';
	import ExternalLink from 'lucide-svelte/icons/external-link';
	import RelatedSessionsSection from '$lib/components/session/RelatedSessionsSection.svelte';

	interface Props {
		/** The task detail to display, or null if not yet loaded. */
		task: TaskDetail | null;
		/** Whether the task is currently loading. */
		loading: boolean;
		/** Error message to display, if any. */
		error: string;
		/** Called after a task action succeeds (start, submit, complete, block, add note). */
		onTaskUpdated?: (task: TaskDetail) => void;
	}

	let { task, loading, error, onTaskUpdated }: Props = $props();

	let actionError = $state('');
	let isSubmitting = $state(false);
	let relatedSessions = $state<SessionSummary[]>([]);
	let sessionsLoading = $state(false);
	let sessionsError = $state('');

	// AC: @review-records-web-ui ac-7 — Review data for task detail
	let linkedReviews = $state<ReviewSummary[]>([]);
	let reviewsLoading = $state(false);
	let reviewsError = $state('');
	let showClosedReviews = $state(false);

	// Note form
	let noteContent = $state('');

	// Block/Complete reason form
	let reasonInput = $state('');
	let showReasonFor = $state<'block' | 'complete' | null>(null);

	// Reset local state when task changes
	$effect(() => {
		if (task) {
			// Task changed, reset action-specific state
			actionError = '';
			noteContent = '';
			reasonInput = '';
			showReasonFor = null;
		}
	});

	$effect(() => {
		if (!task) {
			relatedSessions = [];
			sessionsLoading = false;
			sessionsError = '';
			return;
		}

		let cancelled = false;
		sessionsLoading = true;
		sessionsError = '';

		fetchTaskSessions(task._ulid)
			.then((response) => {
				if (cancelled) return;
				relatedSessions = response.items;
			})
			.catch((err) => {
				if (cancelled) return;
				sessionsError = err instanceof Error ? err.message : 'Failed to load related sessions';
				relatedSessions = [];
			})
			.finally(() => {
				if (!cancelled) sessionsLoading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	// AC: @review-records-web-ui ac-7 — Fetch linked reviews when task changes
	$effect(() => {
		if (!task) {
			linkedReviews = [];
			reviewsLoading = false;
			reviewsError = '';
			showClosedReviews = false;
			return;
		}

		let cancelled = false;
		reviewsLoading = true;
		reviewsError = '';

		const reviewTaskRef = task.slugs?.[0] ?? task._ulid;
		fetchReviewsForTask(reviewTaskRef)
			.then((response) => {
				if (cancelled) return;
				linkedReviews = response.items;
			})
			.catch((err) => {
				if (cancelled) return;
				reviewsError = err instanceof Error ? err.message : 'Failed to load reviews';
				linkedReviews = [];
			})
			.finally(() => {
				if (!cancelled) reviewsLoading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	async function handleAction(action: () => Promise<void>) {
		if (!task) return;
		isSubmitting = true;
		actionError = '';
		try {
			await action();
			// Re-fetch is handled by the parent via onTaskUpdated
			onTaskUpdated?.(task);
		} catch (err) {
			if (err instanceof ReadOnlyModeError) {
				actionError = err.message;
			} else {
				actionError = err instanceof Error ? err.message : 'Action failed';
			}
		} finally {
			isSubmitting = false;
		}
	}

	function handleStart() {
		if (!task) return;
		handleAction(() => startTask(task!._ulid));
	}

	function handleSubmit() {
		if (!task) return;
		handleAction(() => submitTask(task!._ulid));
	}

	function handleComplete() {
		if (!task || !reasonInput.trim()) return;
		const reason = reasonInput.trim();
		handleAction(async () => {
			await completeTask(task!._ulid, reason);
			reasonInput = '';
			showReasonFor = null;
		});
	}

	function handleBlock() {
		if (!task || !reasonInput.trim()) return;
		const reason = reasonInput.trim();
		handleAction(async () => {
			await blockTask(task!._ulid, reason);
			reasonInput = '';
			showReasonFor = null;
		});
	}

	function handleAddNote() {
		if (!task || !noteContent.trim()) return;
		const content = noteContent.trim();
		handleAction(async () => {
			await addTaskNote(task!._ulid, content);
			noteContent = '';
		});
	}

	function formatDate(dateStr: string): string {
		return new Intl.DateTimeFormat('en-US', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(new Date(dateStr));
	}

	let statusInfo = $derived(task ? getStatusClasses(task.status) : null);
	let slug = $derived(task?.slugs?.[0] ?? task?._ulid?.slice(0, 8) ?? '');
	let readOnly = $derived(isStaticMode());

	// Rewrite `./resources/<path>` markdown targets in the task description to the
	// task-scoped resource bytes URL (carrying selected-project context) before
	// rendering. Only `present` resolved resources are rewritten; drift/missing/
	// unresolved and unmatched references stay raw and are surfaced in the
	// resources status section below.
	// AC: @live-task-resource-markdown-rendering ac-plan-owned-task-image-renders
	// AC: @live-task-resource-markdown-rendering ac-plan-owned-task-doc-link-opens
	// AC: @live-task-resource-markdown-rendering ac-materialized-task-image-renders
	// AC: @live-task-resource-markdown-rendering ac-materialized-task-doc-link-opens
	let renderedDescription = $derived(
		task?.description
			? rewriteTaskResourceLinks(task.description, task.resolved_resources, task.resources_base_url)
			: ''
	);

	// AC: @live-task-resource-markdown-rendering ac-drifted-task-resource-is-visible-not-silent
	// Resolved task resources whose status is not `present` cannot be rewritten to
	// a bytes URL without risking serving different bytes — surface them so drift/
	// missing/unresolved states stay visible even if an image fails to load.
	let unhealthyResources = $derived(
		(task?.resolved_resources ?? []).filter((r) => r.status !== 'present')
	);

	// AC: @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw
	// `./resources/<path>` references in the description that resolve to NO task
	// resource at all. The rewriter leaves these raw, so a broken `<img>`/`<a>`
	// would otherwise hide the authoring reference entirely. Surface each one as a
	// visible reference with actionable guidance so it is never silently dropped.
	let unmatchedReferences = $derived(
		findUnmatchedTaskResourceReferences(task?.description, task?.resolved_resources)
	);

	let hasResourceGuidance = $derived(
		unhealthyResources.length > 0 || unmatchedReferences.length > 0
	);

	function resourceStatusClasses(status: string): string {
		switch (status) {
			case 'present':
				return 'bg-status-completed text-status-completed-fg';
			case 'drift':
				return 'bg-status-blocked text-status-blocked-fg';
			default:
				return 'bg-status-pending text-status-pending-fg';
		}
	}

	// AC: @review-records-web-ui ac-7 — Split reviews into current (open/draft) and closed
	let currentReviews = $derived(
		linkedReviews.filter((r) => r.lifecycle_state === 'open' || r.lifecycle_state === 'draft')
	);
	let closedReviews = $derived(
		linkedReviews.filter((r) => r.lifecycle_state === 'closed' || r.lifecycle_state === 'archived')
	);

	function dispositionClasses(disposition: string): string {
		switch (disposition) {
			case 'approved':
				return 'bg-status-completed text-status-completed-fg';
			case 'changes_requested':
				return 'bg-status-needs-work text-status-needs-work-fg';
			default:
				return 'bg-status-pending text-status-pending-fg';
		}
	}

	function dispositionLabel(disposition: string): string {
		switch (disposition) {
			case 'approved':
				return 'Approved';
			case 'changes_requested':
				return 'Changes Requested';
			default:
				return 'Pending';
		}
	}
</script>

{#if loading}
	<div class="flex flex-col gap-4 py-4" data-testid="task-detail-skeleton">
		<Skeleton class="h-6 w-3/4 ds-shimmer" />
		<Skeleton class="h-3 w-24 ds-shimmer" />
		<div class="flex gap-2">
			<Skeleton class="h-5 w-20 rounded-full ds-shimmer" />
			<Skeleton class="h-5 w-24 rounded-full ds-shimmer" />
		</div>
		<div>
			<Skeleton class="h-3 w-10 mb-1 ds-shimmer" />
			<Skeleton class="h-4 w-32 ds-shimmer" />
		</div>
		<div class="flex gap-1">
			<Skeleton class="h-5 w-12 rounded-full ds-shimmer" />
			<Skeleton class="h-5 w-16 rounded-full ds-shimmer" />
		</div>
		<Skeleton class="h-px w-full ds-shimmer" />
		<div>
			<Skeleton class="h-3 w-16 mb-2 ds-shimmer" />
			<Skeleton class="h-16 w-full rounded-md ds-shimmer" />
		</div>
	</div>
{:else if error}
	<div class="bg-destructive/10 text-destructive p-4 rounded-lg" role="alert">
		{error}
	</div>
{:else if task && statusInfo}
	<div class="flex flex-col gap-4">
		<!-- Description -->
		<!-- AC: @live-task-resource-markdown-rendering ac-plan-owned-task-image-renders -->
		<!-- AC: @live-task-resource-markdown-rendering ac-materialized-task-image-renders -->
		{#if task.description}
			<div
				class="text-sm text-muted-foreground break-words leading-relaxed prose prose-sm dark:prose-invert max-w-none"
				data-testid="task-description"
			>
				{@html renderMarkdown(renderedDescription)}
			</div>
		{/if}

		<!-- Resource status — surfaces drift/missing/unresolved resolved resources
		     AND unmatched authoring references so they stay visible even when an
		     image cannot load or the reference resolves to nothing. -->
		<!-- AC: @live-task-resource-markdown-rendering ac-drifted-task-resource-is-visible-not-silent -->
		<!-- AC: @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw -->
		{#if hasResourceGuidance}
			<div data-testid="task-resource-status" class="flex flex-col gap-2">
				<p class="text-xs font-medium text-muted-foreground">Resources needing attention</p>
				<ul class="flex flex-col gap-1.5">
					{#each unhealthyResources as resource (resource.id)}
						<li
							class="flex flex-wrap items-center gap-2 text-xs"
							data-testid="task-resource-status-item"
						>
							<Badge
								class={resourceStatusClasses(resource.status)}
								data-testid="task-resource-status-badge"
							>
								{resource.status}
							</Badge>
							<code class="break-all font-mono">./resources/{resource.path}</code>
							<span class="text-muted-foreground break-words">{resource.message}</span>
						</li>
					{/each}
					{#each unmatchedReferences as path (path)}
						<li
							class="flex flex-wrap items-center gap-2 text-xs"
							data-testid="task-resource-unmatched-item"
						>
							<Badge
								class={resourceStatusClasses('unmatched')}
								data-testid="task-resource-status-badge"
							>
								unmatched
							</Badge>
							<code class="break-all font-mono">./resources/{path}</code>
							<span class="text-muted-foreground break-words">
								No matching task resource — verify the reference path or re-derive the task with
								this resource present.
							</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<!-- Status, priority, type -->
		<div class="flex flex-wrap gap-2 items-center">
			<Badge class="{statusInfo.bg} {statusInfo.fg}" data-testid="task-status-badge">
				{statusInfo.label}
			</Badge>
			<Badge variant="outline" data-testid="task-priority">Priority {task.priority}</Badge>
			<Badge variant="outline" data-testid="task-type">{task.type}</Badge>
			{#if task.automation}
				<Badge variant="secondary" data-testid="task-automation">
					{task.automation}
				</Badge>
			{/if}
		</div>

		<!-- Spec ref -->
		<!-- AC: @web-dashboard ac-6 -->
		{#if task.spec_ref}
			<div data-testid="task-spec-ref">
				<p class="text-xs font-medium text-muted-foreground mb-0.5">Spec</p>
				<ReferenceLink ref={task.spec_ref} type="spec" />
			</div>
		{/if}

		<!-- Tags -->
		{#if task.tags?.length > 0}
			<div data-testid="task-tags">
				<p class="text-xs font-medium text-muted-foreground mb-1">Tags</p>
				<div class="flex flex-wrap gap-1">
					{#each task.tags as tag}
						<Badge variant="secondary">{tag}</Badge>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Dependencies -->
		<div data-testid="task-dependencies">
			{#if task.depends_on?.length > 0}
				<p class="text-xs font-medium text-muted-foreground mb-1">Dependencies</p>
				<ul class="text-sm space-y-0.5">
					{#each task.depends_on as dep}
						<li>
							<ReferenceLink ref={dep} type="task" class="text-xs" />
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-muted-foreground">No dependencies</p>
			{/if}
		</div>

		<!-- Blocked by -->
		{#if task.blocked_by?.length > 0}
			<div data-testid="task-blocked-by">
				<p class="text-xs font-medium text-destructive mb-1">Blocked By</p>
				<ul class="text-sm space-y-0.5">
					{#each task.blocked_by as blocker}
						<li>
							<ReferenceLink ref={blocker} type="task" class="text-xs" />
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<!-- VCS info (branch, PR link) -->
		{#if task.vcs_refs?.length > 0}
			<div data-testid="task-vcs">
				<p class="text-xs font-medium text-muted-foreground mb-1">VCS</p>
				<ul class="text-sm space-y-1">
					{#each task.vcs_refs as ref}
						{@const vcsInfo = formatVcsRef(ref)}
						<li class="flex items-center gap-1.5">
							<GitBranch class="size-3 text-muted-foreground flex-shrink-0" />
							{#if vcsInfo.url}
								<a
									href={vcsInfo.url}
									target="_blank"
									rel="noopener noreferrer"
									class="text-xs text-primary hover:underline font-mono inline-flex items-center gap-1"
								>
									{vcsInfo.label}
									<ExternalLink class="size-3" />
								</a>
							{:else}
								<span class="text-muted-foreground font-mono text-xs">{vcsInfo.label}</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<!-- Plan ref -->
		{#if task.plan_ref}
			<div data-testid="task-plan-ref">
				<p class="text-xs font-medium text-muted-foreground mb-0.5">Plan</p>
				<ReferenceLink ref={task.plan_ref} type="plan" />
			</div>
		{:else if task.derivation}
			<div data-testid="task-derivation">
				<p class="text-xs font-medium text-muted-foreground mb-0.5">Derivation</p>
				<p class="text-sm text-muted-foreground">{task.derivation}</p>
			</div>
		{/if}

		<!-- Session link -->
		{#if task.session_ref}
			<div data-testid="task-session-ref">
				<p class="text-xs font-medium text-muted-foreground mb-0.5">Session</p>
				<ReferenceLink ref={task.session_ref} type="session" />
			</div>
		{/if}

		<!-- AC: @task-spec-session-context ac-task-detail-sessions, ac-session-list-task-filter -->
		<RelatedSessionsSection
			title="Sessions"
			sessions={relatedSessions}
			loading={sessionsLoading}
			error={sessionsError}
			filterHref={`${base}/sessions?task_id=${encodeURIComponent(`@${slug}`)}`}
			emptyMessage="No sessions have referenced this task yet."
			dataTestId="task-related-sessions"
		/>

		<!-- AC: @review-records-web-ui ac-7 — Reviews linked to this task -->
		<div data-testid="task-reviews">
			<h3 class="text-sm font-semibold mb-2">Reviews</h3>

			{#if reviewsLoading}
				<div class="space-y-2" data-testid="task-reviews-loading">
					{#each Array(2) as _}
						<div class="h-14 rounded-md bg-muted ds-shimmer"></div>
					{/each}
				</div>
			{:else if reviewsError}
				<p class="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="task-reviews-error">
					{reviewsError}
				</p>
			{:else if linkedReviews.length === 0}
				<p class="text-sm text-muted-foreground" data-testid="task-reviews-empty">No reviews linked to this task.</p>
			{:else}
				<!-- Current (open/draft) reviews shown prominently -->
				{#if currentReviews.length > 0}
					<div class="space-y-2" data-testid="task-reviews-current">
						{#each currentReviews as review (review._ulid)}
							<a
								href={`${base}/reviews/${review._ulid}`}
								class="flex items-center gap-3 rounded-md border p-3 transition-colors hover:bg-muted/40"
								data-testid="task-review-row"
							>
								<Badge class={dispositionClasses(review.disposition)}>
									{dispositionLabel(review.disposition)}
								</Badge>
								<div class="min-w-0 flex-1">
									<div class="text-sm font-medium truncate">{review.title}</div>
									<div class="text-xs text-muted-foreground">
										{review.thread_count} {review.thread_count === 1 ? 'thread' : 'threads'}{#if review.unresolved_blocker_count > 0}, <span class="text-destructive">{review.unresolved_blocker_count} blocker{review.unresolved_blocker_count === 1 ? '' : 's'} unresolved</span>{/if}
									</div>
								</div>
								<Badge variant="outline" class="text-xs">{review.lifecycle_state}</Badge>
							</a>
						{/each}
					</div>
				{/if}

				<!-- Closed reviews collapsed as history -->
				{#if closedReviews.length > 0}
					<div class="mt-2" data-testid="task-reviews-closed">
						<button
							class="text-xs text-muted-foreground hover:text-foreground transition-colors"
							onclick={() => (showClosedReviews = !showClosedReviews)}
							data-testid="task-reviews-toggle-closed"
						>
							{showClosedReviews ? 'Hide' : 'Show'} {closedReviews.length} closed review{closedReviews.length === 1 ? '' : 's'}
						</button>
						{#if showClosedReviews}
							<div class="space-y-2 mt-2">
								{#each closedReviews as review (review._ulid)}
									<a
										href={`${base}/reviews/${review._ulid}`}
										class="flex items-center gap-3 rounded-md border border-dashed p-3 opacity-70 transition-colors hover:bg-muted/40 hover:opacity-100"
										data-testid="task-review-row-closed"
									>
										<Badge class={dispositionClasses(review.disposition)}>
											{dispositionLabel(review.disposition)}
										</Badge>
										<div class="min-w-0 flex-1">
											<div class="text-sm font-medium truncate">{review.title}</div>
											<div class="text-xs text-muted-foreground">
												{review.thread_count} {review.thread_count === 1 ? 'thread' : 'threads'}
											</div>
										</div>
										<Badge variant="outline" class="text-xs">{review.lifecycle_state}</Badge>
									</a>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			{/if}
		</div>

		<Separator />

		<!-- Actions -->
		<!-- AC: @web-dashboard ac-7 -->
		<!-- AC: @gh-pages-export ac-16 — Buttons disabled with tooltip in static mode -->
		<div class="flex flex-wrap gap-2" data-testid="task-actions">
			{#if task.status === 'pending'}
				{#if readOnly}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button {...props} size="sm" disabled={true} data-testid="action-start">
									Start
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content><p>Read-only mode — use CLI to start task</p></Tooltip.Content>
					</Tooltip.Root>
				{:else}
					<Button
						size="sm"
						onclick={handleStart}
						disabled={isSubmitting}
						data-testid="action-start"
					>
						{isSubmitting ? 'Starting...' : 'Start'}
					</Button>
				{/if}
			{/if}

			{#if task.status === 'in_progress' || task.status === 'needs_work'}
				{#if readOnly}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button {...props} size="sm" disabled={true} data-testid="action-submit">
									Submit for Review
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content><p>Read-only mode — use CLI to submit task</p></Tooltip.Content>
					</Tooltip.Root>
				{:else}
					<Button
						size="sm"
						onclick={handleSubmit}
						disabled={isSubmitting}
						data-testid="action-submit"
					>
						{isSubmitting ? 'Submitting...' : 'Submit for Review'}
					</Button>
				{/if}
			{/if}

			{#if task.status === 'in_progress' || task.status === 'pending_review'}
				{#if readOnly}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button {...props} size="sm" variant="outline" disabled={true} data-testid="action-complete-toggle">
									Complete
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content><p>Read-only mode — use CLI to complete task</p></Tooltip.Content>
					</Tooltip.Root>
				{:else}
					<Button
						size="sm"
						variant="outline"
						onclick={() => {
							showReasonFor = 'complete';
							reasonInput = '';
						}}
						disabled={isSubmitting}
						data-testid="action-complete-toggle"
					>
						Complete
					</Button>
				{/if}
			{/if}

			{#if task.status !== 'blocked' && task.status !== 'completed' && task.status !== 'cancelled'}
				{#if readOnly}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button {...props} size="sm" variant="destructive" disabled={true} data-testid="action-block-toggle">
									Block
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content><p>Read-only mode — use CLI to block task</p></Tooltip.Content>
					</Tooltip.Root>
				{:else}
					<Button
						size="sm"
						variant="destructive"
						onclick={() => {
							showReasonFor = 'block';
							reasonInput = '';
						}}
						disabled={isSubmitting}
						data-testid="action-block-toggle"
					>
						Block
					</Button>
				{/if}
			{/if}
		</div>

		<!-- Reason input for block/complete (only in daemon mode) -->
		{#if !readOnly && showReasonFor}
			<div class="flex gap-2" data-testid="reason-input">
				<Input
					bind:value={reasonInput}
					placeholder="{showReasonFor === 'block' ? 'Block' : 'Completion'} reason..."
					class="flex-1"
				/>
				<Button
					size="sm"
					onclick={showReasonFor === 'block' ? handleBlock : handleComplete}
					disabled={isSubmitting || !reasonInput.trim()}
				>
					Confirm
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onclick={() => {
						showReasonFor = null;
						reasonInput = '';
					}}
				>
					Cancel
				</Button>
			</div>
		{/if}

		{#if actionError}
			<p class="text-sm text-destructive" data-testid="action-error">{actionError}</p>
		{/if}

		<Separator />

		<!-- Todos -->
		<div data-testid="task-todos">
			{#if task.todos && task.todos.length > 0}
				<p class="text-xs font-medium text-muted-foreground mb-1">
					Todos ({task.todos.length})
				</p>
				<ul class="space-y-1">
					{#each task.todos as todo}
						<li class="flex items-start gap-2 text-sm">
							<span class="mt-0.5 text-xs">
								{#if todo.done}
									&#x2705;
								{:else}
									&#x23F8;&#xFE0F;
								{/if}
							</span>
							<span class:line-through={todo.done}>
								{todo.text}
							</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-muted-foreground">No todos</p>
			{/if}
		</div>
		<Separator />

		<!-- Notes -->
		<!-- AC: @web-dashboard ac-8 -->
		<div data-testid="task-notes">
			<p class="text-xs font-medium text-muted-foreground mb-2">
				Notes ({task.notes?.length ?? 0})
			</p>

			<!-- Add Note form -->
			<!-- AC: @gh-pages-export ac-18 — Note form disabled in static mode -->
			{#if readOnly}
				<div class="mb-3 space-y-2" data-testid="task-add-note">
					<Textarea
						placeholder="Add a note..."
						disabled={true}
						rows={2}
					/>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button {...props} size="sm" disabled={true} data-testid="action-add-note">
									Add Note
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content><p>Read-only mode — use CLI to add notes</p></Tooltip.Content>
					</Tooltip.Root>
				</div>
			{:else}
				<div class="mb-3 space-y-2" data-testid="task-add-note">
					<Textarea
						placeholder="Add a note..."
						bind:value={noteContent}
						disabled={isSubmitting}
						rows={2}
					/>
					<Button
						size="sm"
						onclick={handleAddNote}
						disabled={isSubmitting || !noteContent.trim()}
						data-testid="action-add-note"
					>
						{isSubmitting ? 'Adding...' : 'Add Note'}
					</Button>
				</div>
			{/if}

			<!-- Notes list -->
			<div class="space-y-3">
				{#if (task.notes ?? []).length === 0}
					<div class="text-center py-4 text-muted-foreground text-xs" data-testid="notes-empty">
						{#if readOnly}
							No notes recorded. Use <code class="bg-muted px-1 rounded">kspec task note</code> to add context.
						{:else}
							Add a note above to document decisions, progress, or findings.
						{/if}
					</div>
				{:else}
					{#each task.notes ?? [] as note}
						<div class="border rounded-md p-2.5" data-testid="note-item">
							<div class="flex justify-between items-start mb-1">
								<span class="text-[10px] text-muted-foreground">{note.author}</span>
								<span class="text-[10px] text-muted-foreground" data-testid="note-timestamp">{formatDate(note.created_at)}</span>
							</div>
							<div
								class="text-sm break-words leading-relaxed prose prose-sm dark:prose-invert max-w-none"
								data-testid="note-content"
							>
								{@html renderMarkdown(note.content)}
							</div>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/if}
