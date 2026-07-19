<!--
  AC: @review-structured-content-viewer ac-1 — Plan content rendered with identifiable sections targetable for comments
  AC: @review-structured-content-viewer ac-2 — Spec content rendered with description, ACs, traits, metadata, each targetable
  AC: @review-structured-content-viewer ac-3 — Comment button creates thread with structured anchor (section, field, anchor-ref)
  AC: @review-structured-content-viewer ac-4 — Existing threads shown inline at anchored section positions
  AC: @review-structured-content-viewer ac-5 — Plan content markdown rewrites declared `./resources/` targets to plan-scoped bytes URLs
  AC: @review-structured-content-viewer ac-6 — Task description markdown rewrites present `./resources/` targets to task-scoped bytes URLs; drifted/missing/unresolved references stay visible with status messages
  AC: @review-structured-content-viewer ac-7 — Unmatched `./resources/` references (including when the task has no derived resource refs) stay unreplaced and render an `unmatched` status message with guidance
-->
<script lang="ts">
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import type { ReviewThread, ReviewDetail } from '@kynetic-ai/shared';
	import {
		fetchReviewContent,
		createReviewThread,
		replyToReviewThread,
		resolveReviewThread,
		reopenReviewThread,
		type ContentSection,
		type ReviewContentResponse,
	} from '$lib/api';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { shortRef, normalizeRef } from '$lib/utils/reference';
	import {
		rewriteReviewSectionResourceLinks,
		reviewSectionResourceGuidance,
	} from '$lib/utils/review-content-resources';
	import { Badge } from '$lib/components/ui/badge';
	import ContentCommentForm from './ContentCommentForm.svelte';
	import ContentInlineThread from './ContentInlineThread.svelte';

	interface Props {
		review: ReviewDetail;
		threads: ReviewThread[];
		isInteractive: boolean;
	}

	let { review, threads, isInteractive }: Props = $props();

	const queryClient = useQueryClient();

	// AC: @review-structured-content-viewer ac-1, ac-2 — Fetch structured content
	const contentQuery = createQuery(() => ({
		queryKey: queryKeys.reviews.content(review._ulid),
		queryFn: () => fetchReviewContent(review._ulid),
		enabled: isProjectInitialized() && !!review._ulid,
	}));

	let content = $derived<ReviewContentResponse | null>(contentQuery.data ?? null);
	let contentLoading = $derived(contentQuery.isLoading);
	let contentError = $derived(contentQuery.error?.message ?? '');

	// Track which section has an open comment form
	let commentingOnSection = $state<string | null>(null);
	let commentingOnField = $state<string | null>(null);
	let mutationError = $state('');

	// AC: @review-structured-content-viewer ac-3 — Create thread with structured anchor
	const addCommentMutation = createMutation(() => ({
		mutationFn: (data: {
			body: string;
			kind: 'blocker' | 'question' | 'nit';
			section: string;
			field?: string;
		}) =>
			createReviewThread(review._ulid, {
				body: data.body,
				kind: data.kind,
				anchor: {
					type: 'structured',
					section: data.section,
					field: data.field,
					ref: content?.subject_ref ?? undefined,
				},
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(review._ulid) });
			commentingOnSection = null;
			commentingOnField = null;
			mutationError = '';
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to add comment';
		},
	}));

	// Reply mutation
	const replyMutation = createMutation(() => ({
		mutationFn: (data: { threadId: string; body: string }) =>
			replyToReviewThread(review._ulid, data.threadId, { body: data.body }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(review._ulid) });
			mutationError = '';
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to reply';
		},
	}));

	// Resolve/reopen mutations
	const resolveMutation = createMutation(() => ({
		mutationFn: (threadId: string) => resolveReviewThread(review._ulid, threadId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(review._ulid) });
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to resolve thread';
		},
	}));

	const reopenMutation = createMutation(() => ({
		mutationFn: (threadId: string) => reopenReviewThread(review._ulid, threadId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(review._ulid) });
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to reopen thread';
		},
	}));

	function handleReply(threadId: string, body: string) {
		replyMutation.mutate({ threadId, body });
	}

	function handleResolve(threadId: string) {
		resolveMutation.mutate(threadId);
	}

	function handleReopen(threadId: string) {
		reopenMutation.mutate(threadId);
	}

	// AC: @review-structured-content-viewer ac-3 — Open comment form for a section
	function openCommentForm(sectionId: string, fieldId?: string) {
		commentingOnSection = sectionId;
		commentingOnField = fieldId ?? null;
	}

	function handleCommentSubmit(body: string, kind: 'blocker' | 'question' | 'nit') {
		if (!commentingOnSection) return;
		addCommentMutation.mutate({
			body,
			kind,
			section: commentingOnSection,
			field: commentingOnField ?? undefined,
		});
	}

	function handleCommentCancel() {
		commentingOnSection = null;
		commentingOnField = null;
	}

	// AC: @review-structured-content-viewer ac-4 — Find threads anchored to a specific section/field
	function getThreadsForSection(sectionId: string, fieldId?: string): ReviewThread[] {
		return threads.filter((t) => {
			if (!t.anchor || t.anchor.type !== 'structured') return false;
			if (t.anchor.section !== sectionId) return false;
			if (fieldId) return t.anchor.field === fieldId;
			// If no fieldId requested, match threads without a field or with the section only
			return !fieldId && !t.anchor.field;
		});
	}

	// Get threads for an AC field specifically
	function getThreadsForAcField(acId: string): ReviewThread[] {
		return threads.filter((t) => {
			if (!t.anchor || t.anchor.type !== 'structured') return false;
			return t.anchor.section === 'acceptance_criteria' && t.anchor.field === acId;
		});
	}

	// AC: @review-structured-content-viewer ac-6 — badge styling for resource
	// status messages (mirrors the task detail resource status section).
	// AC: @review-structured-content-viewer ac-7 — `unmatched` falls through to
	// the default pending-style badge.
	function resourceStatusClasses(status: string): string {
		switch (status) {
			case 'drift':
				return 'bg-status-blocked text-status-blocked-fg';
			default:
				return 'bg-status-pending text-status-pending-fg';
		}
	}

	function formatRelativeTime(dateStr: string): string {
		const date = new Date(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return 'just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 30) return `${diffDays}d ago`;
		return date.toLocaleDateString();
	}
</script>

<div class="flex flex-col gap-4" data-testid="structured-content-viewer">
	{#if contentError}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg" data-testid="content-error">
			{contentError}
		</div>
	{/if}

	{#if mutationError}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg" data-testid="content-mutation-error">
			{mutationError}
		</div>
	{/if}

	{#if contentLoading}
		<div class="flex justify-center items-center py-8">
			<p class="text-muted-foreground">Loading content...</p>
		</div>
	{:else if content?.content}
		<!-- Content title -->
		<h3 class="text-lg font-semibold" data-testid="content-title">
			{content.content.title}
		</h3>

		<!-- Render each section -->
		{#each content.content.sections as section (section.id)}
			{@const sectionThreads = getThreadsForSection(section.id)}
			<div
				class="border rounded-lg overflow-hidden group/section"
				data-testid="content-section"
				data-section-id={section.id}
				data-section-type={section.type}
			>
				<!-- Section header with comment button -->
				<div class="flex items-center justify-between px-4 py-2 bg-muted/30 border-b">
					<h4 class="text-sm font-semibold" data-testid="section-title">{section.title}</h4>
					{#if isInteractive}
						<button
							type="button"
							class="opacity-0 group-hover/section:opacity-100 transition-opacity text-xs text-muted-foreground hover:text-foreground"
							data-testid="section-comment-button"
							onclick={() => openCommentForm(section.id)}
						>
							<svg class="h-4 w-4 inline-block mr-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
							</svg>
							Comment
						</button>
					{/if}
				</div>

				<!-- Section content -->
				<div class="px-4 py-3">
					{#if section.type === 'markdown'}
						<!-- AC: @review-structured-content-viewer ac-5 — plan content `./resources/` targets rewrite to plan-scoped bytes URLs (undeclared/unsafe paths stay raw) -->
						<!-- AC: @review-structured-content-viewer ac-6 — task description `./resources/` targets rewrite to task-scoped bytes URLs for present resources only -->
						<!-- AC: @review-structured-content-viewer ac-7 — unmatched `./resources/` targets stay unreplaced; the browser is never pointed at replacement bytes for them -->
						{@const resourceGuidance = reviewSectionResourceGuidance(
							section.content,
							section.resource_context
						)}
						<div class="prose prose-sm dark:prose-invert max-w-none" data-testid="section-markdown-content">
							{@html renderMarkdown(
								rewriteReviewSectionResourceLinks(section.content, section.resource_context)
							)}
						</div>

						<!-- Resource status — drifted/missing/unresolved resolved resources AND
						     unmatched authoring references stay visible with actionable status
						     instead of silently serving replacement bytes. -->
						<!-- AC: @review-structured-content-viewer ac-6 — drift/missing/unresolved status messages -->
						<!-- AC: @review-structured-content-viewer ac-7 — `unmatched` status messages with guidance for each authored path -->
						{#if resourceGuidance.length > 0}
							<div data-testid="review-resource-status" class="mt-3 flex flex-col gap-2">
								<p class="text-xs font-medium text-muted-foreground">Resources needing attention</p>
								<ul class="flex flex-col gap-1.5">
									{#each resourceGuidance as item (`${item.status}:${item.path}`)}
										<li
											class="flex flex-wrap items-center gap-2 text-xs"
											data-testid="review-resource-status-item"
										>
											<Badge
												class={resourceStatusClasses(item.status)}
												data-testid="review-resource-status-badge"
											>
												{item.status}
											</Badge>
											<code class="break-all font-mono">./resources/{item.path}</code>
											<span class="text-muted-foreground break-words">{item.message}</span>
										</li>
									{/each}
								</ul>
							</div>
						{/if}

					{:else if section.type === 'acceptance_criteria'}
						<!-- AC: @review-structured-content-viewer ac-2 — Each AC individually targetable -->
						<div class="flex flex-col gap-3" data-testid="section-ac-list">
							{#each section.criteria as ac (ac.id)}
								{@const acThreads = getThreadsForAcField(ac.id)}
								<div
									class="border rounded-md p-3 group/ac relative"
									data-testid="ac-item"
									data-ac-id={ac.id}
								>
									<div class="flex items-start justify-between gap-2">
										<div class="flex-1">
											<span class="text-xs font-mono text-muted-foreground">[{ac.id}]</span>
											{#if ac.given}
												<p class="text-sm mt-1">
													<span class="font-medium text-muted-foreground">Given:</span> {ac.given}
												</p>
											{/if}
											{#if ac.when}
												<p class="text-sm mt-0.5">
													<span class="font-medium text-muted-foreground">When:</span> {ac.when}
												</p>
											{/if}
											{#if ac.then}
												<p class="text-sm mt-0.5">
													<span class="font-medium text-muted-foreground">Then:</span> {ac.then}
												</p>
											{/if}
										</div>
										{#if isInteractive}
											<button
												type="button"
												class="opacity-0 group-hover/ac:opacity-100 transition-opacity text-xs text-muted-foreground hover:text-foreground shrink-0"
												data-testid="ac-comment-button"
												onclick={() => openCommentForm('acceptance_criteria', ac.id)}
											>
												<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
												</svg>
											</button>
										{/if}
									</div>

									<!-- Inline threads for this AC -->
									{#each acThreads as thread (thread._ulid)}
										<div class="mt-2">
											<ContentInlineThread
												{thread}
												{isInteractive}
												onReply={handleReply}
												onResolve={handleResolve}
												onReopen={handleReopen}
											/>
										</div>
									{/each}

									<!-- Comment form for this AC -->
									{#if commentingOnSection === 'acceptance_criteria' && commentingOnField === ac.id}
										<ContentCommentForm
											onSubmit={handleCommentSubmit}
											onCancel={handleCommentCancel}
										/>
									{/if}
								</div>
							{/each}
						</div>

					{:else if section.type === 'ref_list'}
						<div class="flex flex-wrap gap-2" data-testid="section-ref-list">
							{#each section.refs as ref}
								<span class="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-mono">
									@{shortRef(normalizeRef(ref))}
								</span>
							{/each}
							{#if section.refs.length === 0}
								<span class="text-sm text-muted-foreground">None</span>
							{/if}
						</div>

					{:else if section.type === 'notes'}
						<div class="flex flex-col gap-2" data-testid="section-notes-list">
							{#each section.notes as note}
								<div class="border-l-2 border-muted pl-3 py-1">
									<div class="flex items-center gap-2 mb-1">
										<span class="text-xs font-medium">{note.author}</span>
										<span class="text-xs text-muted-foreground" title={note.created_at}>
											{formatRelativeTime(note.created_at)}
										</span>
									</div>
									<div class="prose prose-sm dark:prose-invert max-w-none text-sm">
										{@html renderMarkdown(note.body)}
									</div>
								</div>
							{/each}
						</div>

					{:else if section.type === 'metadata'}
						<div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="section-metadata">
							{#each Object.entries(section.metadata) as [key, value]}
								<span class="font-mono text-muted-foreground text-xs">{key}</span>
								<span class="font-mono text-xs truncate" title={String(value)}>
									{#if Array.isArray(value)}
										{value.join(', ')}
									{:else if value === null || value === undefined}
										<span class="text-muted-foreground italic">null</span>
									{:else}
										{String(value)}
									{/if}
								</span>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Section-level inline threads (not AC-specific) -->
				{#if sectionThreads.length > 0 && section.type !== 'acceptance_criteria'}
					<div class="px-4 pb-3 flex flex-col gap-2">
						{#each sectionThreads as thread (thread._ulid)}
							<ContentInlineThread
								{thread}
								{isInteractive}
								onReply={handleReply}
								onResolve={handleResolve}
								onReopen={handleReopen}
							/>
						{/each}
					</div>
				{/if}

				<!-- Section-level comment form (not for AC sections, which have per-field forms) -->
				{#if commentingOnSection === section.id && !commentingOnField && section.type !== 'acceptance_criteria'}
					<div class="px-4 pb-3">
						<ContentCommentForm
							onSubmit={handleCommentSubmit}
							onCancel={handleCommentCancel}
						/>
					</div>
				{/if}

				<!-- For acceptance_criteria, also show section-level threads that don't target a specific field -->
				{#if section.type === 'acceptance_criteria' && sectionThreads.length > 0}
					<div class="px-4 pb-3 flex flex-col gap-2">
						{#each sectionThreads as thread (thread._ulid)}
							<ContentInlineThread
								{thread}
								{isInteractive}
								onReply={handleReply}
								onResolve={handleResolve}
								onReopen={handleReopen}
							/>
						{/each}
					</div>
				{/if}

				<!-- Section-level comment form for acceptance_criteria section header -->
				{#if commentingOnSection === section.id && !commentingOnField && section.type === 'acceptance_criteria'}
					<div class="px-4 pb-3">
						<ContentCommentForm
							onSubmit={handleCommentSubmit}
							onCancel={handleCommentCancel}
						/>
					</div>
				{/if}
			</div>
		{/each}
	{:else if content && !content.content}
		<div class="border rounded-lg p-8 text-center text-muted-foreground" data-testid="content-not-available">
			<p>Content not available for this review type.</p>
		</div>
	{/if}
</div>
