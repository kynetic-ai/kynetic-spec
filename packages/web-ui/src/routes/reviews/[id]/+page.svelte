<!--
  AC: @review-records-web-ui ac-2 — Review detail page with threads, checks, verdicts, disposition
  AC: @review-records-web-ui ac-3 — Add Comment: create new thread with body and kind selection
  AC: @review-records-web-ui ac-4 — Reply: add reply to existing thread
  AC: @review-records-web-ui ac-5 — Resolve/Reopen: toggle thread resolution state
  AC: @review-records-web-ui ac-6 — Verdict submission with disposition update
  AC: @review-records-web-ui ac-8 — Markdown rendering with syntax highlighting in thread bodies
  AC: @review-records-web-ui ac-9 — Author identity and relative timestamp on thread entries
  AC: @review-records-web-ui ac-10 — Empty state messages for sections with no items
  AC: @review-records-web-ui ac-11 — Revision dropdown for same-subject reviews
  AC: @review-structured-content-viewer ac-1 — Plan content rendered with identifiable sections
  AC: @review-structured-content-viewer ac-2 — Spec content rendered with targetable sections
  AC: @review-structured-content-viewer ac-3 — Comment creates thread with structured anchor
  AC: @review-structured-content-viewer ac-4 — Threads shown inline at anchored section positions
  AC: @review-code-diff-viewer ac-1 — File list with diff stats, expandable to show diff content
  AC: @review-code-diff-viewer ac-2 — Unified diff with syntax highlighting, line numbers, color coding
  AC: @review-code-diff-viewer ac-3 — Collapsed unchanged regions with "Show N more lines"
  AC: @review-code-diff-viewer ac-4 — Click-to-comment on diff lines creates thread with code anchor
  AC: @review-code-diff-viewer ac-5 — Existing threads shown inline at anchor positions in diff
  AC: @review-code-diff-viewer ac-6 — Lazy loading for 20+ changed files
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import type { ReviewDetail, ReviewResource, ReviewSummary, ReviewThread, BroadcastEvent } from '@kynetic-ai/shared';
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import { Badge } from '$lib/components/ui/badge';
	import { ViewHeader, StatusBadge, type ViewHeaderCount } from '$lib/components/ds';
	import {
		fetchReview,
		fetchReviewSiblings,
		createReviewThread,
		replyToReviewThread,
		resolveReviewThread,
		reopenReviewThread,
		reviewResourceBytesUrl,
		encodeStaticAssetPath,
		submitReviewVerdict,
	} from '$lib/api';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { isStaticMode, ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { shortRef, normalizeRef, refHref } from '$lib/utils/reference';
	import { StructuredContentViewer } from '$lib/components/content';
	import { CodeDiffViewer } from '$lib/components/diff';

	let reviewId = $derived($page.params.id);

	const queryClient = useQueryClient();

	// AC: @review-records-web-ui ac-2 — Fetch full review detail
	const reviewQuery = createQuery(() => ({
		queryKey: queryKeys.reviews.detail(reviewId),
		queryFn: () => fetchReview(reviewId),
		enabled: isProjectInitialized() && !!reviewId,
	}));

	let review = $derived<ReviewDetail | null>(reviewQuery.data ?? null);
	let loading = $derived(reviewQuery.isLoading);
	let error = $derived(reviewQuery.error?.message ?? '');

	// AC: @review-records-web-ui ac-11 — Fetch sibling reviews for revision selector
	let subjectRef = $derived(review?.subject && 'ref' in review.subject ? review.subject.ref : undefined);
	let subjectType = $derived(review?.subject.type ?? '');
	let headBranch = $derived(
		review?.subject.type === 'code' ? review.subject.head_branch : undefined
	);
	let siblingFilters = $derived({
		subject_type: subjectType,
		subject_ref: subjectRef,
		head_branch: headBranch
	});

	const siblingsQuery = createQuery(() => ({
		queryKey: queryKeys.reviews.siblings(siblingFilters),
		queryFn: () => fetchReviewSiblings(siblingFilters),
		enabled: isProjectInitialized() && !!review && (!!subjectRef || !!headBranch),
	}));

	let siblings = $derived<ReviewSummary[]>(siblingsQuery.data ?? []);
	let hasMultipleRevisions = $derived(siblings.length > 1);

	// AC: @ui-view-header ac-1 — Standard header reference + server-resolved child counts.
	// Counts come from the review detail payload's embedded child collections — the
	// header receives them as values and never enumerates a separate entity list.
	let reviewRef = $derived(review?.slugs?.[0] ?? review?._ulid ?? reviewId ?? '');
	let reviewCounts = $derived<ViewHeaderCount[]>(
		review
			? [
					{ label: 'threads', value: review.threads.length, testid: 'view-header-count-threads' },
					{ label: 'checks', value: review.checks.length, testid: 'view-header-count-checks' },
					{ label: 'verdicts', value: review.verdicts.length, testid: 'view-header-count-verdicts' }
				]
			: []
	);

	// AC: @review-records-web-ui ac-2 — Thread kind badges with appropriate colors
	function getKindColor(kind: string): string {
		const colors: Record<string, string> = {
			blocker: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
			question: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
			nit: 'bg-gray-100 text-gray-800 dark:bg-gray-800/50 dark:text-gray-400',
		};
		return colors[kind] || 'bg-gray-100 text-gray-800';
	}

	function formatKind(kind: string): string {
		const labels: Record<string, string> = {
			blocker: 'Blocker',
			question: 'Question',
			nit: 'Nit',
		};
		return labels[kind] || kind;
	}

	// --- Check status helpers ---
	function getCheckStatusColor(status: string): string {
		const colors: Record<string, string> = {
			pass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
			fail: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
			running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
			skipped: 'bg-gray-100 text-gray-800 dark:bg-gray-800/50 dark:text-gray-400',
		};
		return colors[status] || 'bg-gray-100 text-gray-800';
	}

	function formatCheckStatus(status: string): string {
		const labels: Record<string, string> = {
			pass: 'Pass',
			fail: 'Fail',
			running: 'Running',
			skipped: 'Skipped',
		};
		return labels[status] || status;
	}

	// --- Verdict decision helpers ---
	function getVerdictColor(decision: string): string {
		const colors: Record<string, string> = {
			approve: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
			request_changes: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
			comment: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
		};
		return colors[decision] || 'bg-gray-100 text-gray-800';
	}

	function formatVerdict(decision: string): string {
		const labels: Record<string, string> = {
			approve: 'Approved',
			request_changes: 'Changes Requested',
			comment: 'Commented',
		};
		return labels[decision] || decision;
	}

	// --- Subject display ---
	function formatSubjectType(type: string): string {
		const labels: Record<string, string> = {
			task: 'Task',
			code: 'Code',
			plan: 'Plan',
			spec: 'Spec',
			external: 'External',
		};
		return labels[type] || type;
	}

	function getSubjectRef(): string | undefined {
		if (!review) return undefined;
		if ('ref' in review.subject) return review.subject.ref;
		return undefined;
	}

	function getSubjectRefType(): 'task' | 'spec' | 'plan' | undefined {
		if (!review) return undefined;
		const t = review.subject.type;
		if (t === 'task' || t === 'spec' || t === 'plan') return t;
		return undefined;
	}

	function getSubjectVersionDisplay(): string {
		if (!review) return '';
		const s = review.subject;
		if (s.type === 'code') {
			return `${s.base_commit.slice(0, 8)}..${s.head_commit.slice(0, 8)}`;
		}
		if ('content_hash' in s) {
			return s.content_hash.slice(0, 8);
		}
		return '';
	}

	// AC: @review-records-web-ui ac-9 — Relative timestamp formatting
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

	// --- Check staleness ---
	function isCheckStale(check: { applies_to_version: { type: string; base_commit?: string; head_commit?: string; content_hash?: string } }): boolean {
		if (!review) return false;
		const subjectVersion = check.applies_to_version;
		const subject = review.subject;

		if (subjectVersion.type === 'code_compare' && subject.type === 'code') {
			return (
				subjectVersion.base_commit !== subject.base_commit ||
				subjectVersion.head_commit !== subject.head_commit
			);
		}

		if (subjectVersion.type === 'entity_version' && 'content_hash' in subject) {
			return subjectVersion.content_hash !== subject.content_hash;
		}

		return false;
	}

	// --- Thread grouping ---
	let unresolvedThreads = $derived(
		review?.threads.filter((t) => !t.resolved_at) ?? []
	);
	let resolvedThreads = $derived(
		review?.threads.filter((t) => t.resolved_at) ?? []
	);
	let showResolvedThreads = $state(false);

	$effect(() => {
		reviewId;
		showResolvedThreads = false;
	});

	// --- Anchor display ---
	function formatAnchor(thread: ReviewThread): string {
		if (!thread.anchor) return '';
		if (thread.anchor.type === 'code') {
			const a = thread.anchor;
			const lines =
				a.line_start === a.line_end
					? `L${a.line_start}`
					: `L${a.line_start}-${a.line_end}`;
			return `${a.path}:${lines}`;
		}
		if (thread.anchor.type === 'structured') {
			const parts: string[] = [];
			if (thread.anchor.ref) parts.push(`@${normalizeRef(thread.anchor.ref)}`);
			if (thread.anchor.section) parts.push(thread.anchor.section);
			if (thread.anchor.field) parts.push(thread.anchor.field);
			return parts.join(' / ');
		}
		return '';
	}

	// --- WebSocket real-time updates ---
	function handleReviewUpdate(event: BroadcastEvent) {
		if (event.data?.review_ulid === reviewId) {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(reviewId) });
		}
	}

	onMount(() => {
		subscribe(['reviews']);
		on('reviews', handleReviewUpdate);
	});

	onDestroy(() => {
		off('reviews', handleReviewUpdate);
		unsubscribe(['reviews']);
	});

	// AC: @review-records-web-ui ac-11 — Navigate to sibling review
	function navigateToRevision(ulid: string) {
		goto(`${base}/reviews/${ulid}`);
	}

	// --- Interaction state ---
	let mutationError = $state('');

	// AC: @review-records-web-ui ac-3 — Add Comment form state
	let showAddComment = $state(false);
	let commentBody = $state('');
	let commentKind = $state<'blocker' | 'question' | 'nit'>('nit');

	const addCommentMutation = createMutation(() => ({
		mutationFn: (data: { body: string; kind: 'blocker' | 'question' | 'nit' }) =>
			createReviewThread(reviewId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(reviewId) });
			showAddComment = false;
			commentBody = '';
			commentKind = 'nit';
			mutationError = '';
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to add comment';
		},
	}));

	function handleAddComment() {
		if (!commentBody.trim()) return;
		mutationError = '';
		addCommentMutation.mutate({ body: commentBody.trim(), kind: commentKind });
	}

	// AC: @review-records-web-ui ac-4 — Reply form state (per-thread)
	let replyingToThread = $state<string | null>(null);
	let replyBody = $state('');

	const replyMutation = createMutation(() => ({
		mutationFn: (data: { threadId: string; body: string }) =>
			replyToReviewThread(reviewId, data.threadId, { body: data.body }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(reviewId) });
			replyingToThread = null;
			replyBody = '';
			mutationError = '';
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to reply';
		},
	}));

	function handleReply(threadId: string) {
		if (!replyBody.trim()) return;
		mutationError = '';
		replyMutation.mutate({ threadId, body: replyBody.trim() });
	}

	function openReplyForm(threadId: string) {
		replyingToThread = threadId;
		replyBody = '';
	}

	// AC: @review-records-web-ui ac-5 — Resolve/Reopen thread
	const resolveMutation = createMutation(() => ({
		mutationFn: (threadId: string) => resolveReviewThread(reviewId, threadId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(reviewId) });
			mutationError = '';
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to resolve thread';
		},
	}));

	const reopenMutation = createMutation(() => ({
		mutationFn: (threadId: string) => reopenReviewThread(reviewId, threadId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(reviewId) });
			mutationError = '';
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to reopen thread';
		},
	}));

	// AC: @review-records-web-ui ac-6 — Verdict submission state
	let verdictDecision = $state<'approve' | 'request_changes' | 'comment'>('approve');
	let verdictReviewer = $state('');

	const verdictMutation = createMutation(() => ({
		mutationFn: (data: { decision: 'approve' | 'request_changes' | 'comment'; reviewer: string }) =>
			submitReviewVerdict(reviewId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(reviewId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.all });
			verdictReviewer = '';
			mutationError = '';
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to submit verdict';
		},
	}));

	function handleSubmitVerdict() {
		if (!verdictReviewer.trim()) return;
		mutationError = '';
		verdictMutation.mutate({ decision: verdictDecision, reviewer: verdictReviewer.trim() });
	}

	// Check if review is in a state that accepts interactions
	let isInteractive = $derived(
		review != null &&
		review.lifecycle_state !== 'archived' &&
		!isStaticMode()
	);

	// AC: @review-structured-content-viewer ac-1, ac-2 — Detect entity reviews for structured content
	let hasStructuredContent = $derived(
		review != null &&
		(review.subject.type === 'plan' || review.subject.type === 'spec' || review.subject.type === 'task')
	);

	// AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
	// AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
	let reviewResources = $derived<ReviewResource[]>(review?.resources ?? []);

	/**
	 * Pick the right URL for a resource depending on mode:
	 *   - static export: use the snapshot's pre-baked `exported_path`,
	 *     URL-encoded per segment so resource paths containing `#`, `?`,
	 *     spaces, or other URL-reserved characters are not interpreted
	 *     by the browser as fragments / query strings.
	 *   - live daemon : use the bytes endpoint
	 */
	function resolveResourceUrl(resource: ReviewResource): string {
		if (isStaticMode() && resource.exported_path) {
			return `${base}/${encodeStaticAssetPath(resource.exported_path)}`;
		}
		return reviewResourceBytesUrl(reviewId, resource.id);
	}

	function isImageResource(resource: ReviewResource): boolean {
		return resource.content_type.startsWith('image/');
	}

	function formatResourceBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	// AC: @review-code-diff-viewer ac-1 — Detect code review subject for diff viewer
	let isCodeReview = $derived(review?.subject.type === 'code');
	let baseCommit = $derived(
		review?.subject.type === 'code' ? review.subject.base_commit : ''
	);
	let headCommitValue = $derived(
		review?.subject.type === 'code' ? review.subject.head_commit : ''
	);
</script>

<div class="flex flex-col gap-6 p-6 min-w-0">
	<!-- Back navigation -->
	<div>
		<a
			href={`${base}/reviews`}
			class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
			data-testid="back-to-reviews"
		>
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M19 12H5M12 19l-7-7 7-7"/>
			</svg>
			Back to Reviews
		</a>
	</div>

	{#if error}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg" data-testid="error-message" role="alert">
			{error}
		</div>
	{/if}

	{#if mutationError}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg" data-testid="mutation-error" role="alert">
			{mutationError}
		</div>
	{/if}

	{#if loading}
		<div class="flex justify-center items-center py-12">
			<p class="text-muted-foreground">Loading review...</p>
		</div>
	{:else if review}
		<!--
			Standard view header. AC: @ui-view-header ac-1, ac-2, ac-4, ac-5, ac-6
			Disposition is the primary state indicator; lifecycle is a compound-state
			chip in the badges zone. Both draw from the shared status-token vocabulary.
		-->
		<div class="flex flex-col gap-4" data-testid="review-header">
			<ViewHeader
				title={review.title}
				titleTestid="review-title"
				reference={reviewRef}
				statusDomain="review-disposition"
				statusState={review.disposition}
				statusTestid="review-disposition-badge"
				counts={reviewCounts}
			>
				{#snippet badges()}
					<!-- AC: @review-records-web-ui ac-2 — lifecycle chip alongside disposition -->
					<StatusBadge
						domain="review-lifecycle"
						state={review.lifecycle_state}
						testid="review-lifecycle-badge"
					/>
				{/snippet}

				{#snippet meta()}
					<span data-testid="review-subject-info">
						<span class="font-medium">{formatSubjectType(review.subject.type)}</span>
						{#if getSubjectRef()}
							{@const ref = getSubjectRef()}
							{@const refType = getSubjectRefType()}
							{#if ref && refType}
								<a
									href={refHref(refType, ref, base)}
									class="text-primary hover:underline ml-1"
									data-testid="review-subject-link">@{shortRef(ref)}</a
								>
							{/if}
						{/if}
						{#if getSubjectVersionDisplay()}
							<span class="ml-1 font-mono text-xs" data-testid="review-subject-version">
								({getSubjectVersionDisplay()})
							</span>
						{/if}
					</span>

					<span data-testid="review-author">
						by <span class="font-medium">{review.author}</span>
					</span>

					<span data-testid="review-created-at" title={review.created_at}>
						{formatRelativeTime(review.created_at)}
					</span>
				{/snippet}
			</ViewHeader>

			<!-- AC: @review-records-web-ui ac-11 — Revision selector dropdown -->
			{#if hasMultipleRevisions}
				<div class="flex items-center gap-2" data-testid="revision-selector">
					<label for="revision-select" class="text-sm text-muted-foreground">Revision:</label>
					<select
						id="revision-select"
						class="rounded-md border bg-background px-3 py-1.5 text-sm"
						value={review._ulid}
						onchange={(e) => navigateToRevision(e.currentTarget.value)}
					>
						{#each siblings as sibling, i}
							<option value={sibling._ulid}>
								#{i + 1} - {sibling.title} ({formatRelativeTime(sibling.created_at)})
							</option>
						{/each}
					</select>
				</div>
			{/if}
		</div>

		<!-- AC: @review-structured-content-viewer ac-1, ac-2, ac-3, ac-4 — Structured Content Viewer -->
		{#if hasStructuredContent && review}
			<section data-testid="structured-content-section">
				<h2 class="text-lg font-semibold mb-3">Content</h2>
				<StructuredContentViewer
					{review}
					threads={review.threads}
					{isInteractive}
				/>
			</section>
		{/if}

		<!-- AC: @review-code-diff-viewer ac-1, ac-2, ac-3, ac-4, ac-5, ac-6 — Code Diff Viewer -->
		{#if isCodeReview && review}
			<section data-testid="diff-viewer-section">
				<h2 class="text-lg font-semibold mb-3">Changed Files</h2>
				<CodeDiffViewer
					{review}
					{baseCommit}
					headCommit={headCommitValue}
					threads={review.threads}
					{isInteractive}
				/>
			</section>
		{/if}

		<!-- Threads Section -->
		<section data-testid="threads-section">
			<div class="flex items-center justify-between mb-3">
				<h2 class="text-lg font-semibold">
					Threads
					{#if review.threads.length > 0}
						<span class="text-sm font-normal text-muted-foreground ml-1">
							({unresolvedThreads.length} open, {resolvedThreads.length} resolved)
						</span>
					{/if}
				</h2>
				<!-- AC: @review-records-web-ui ac-3 — Add Comment button -->
				{#if isInteractive}
					<button
						type="button"
						class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
						data-testid="add-comment-button"
						onclick={() => { showAddComment = !showAddComment; }}
					>
						<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M12 5v14M5 12h14"/>
						</svg>
						Add Comment
					</button>
				{/if}
			</div>

			<!-- AC: @review-records-web-ui ac-3 — Add Comment form -->
			{#if showAddComment}
				<div class="border rounded-lg p-4 mb-4" data-testid="add-comment-form">
					<div class="flex flex-col gap-3">
						<div>
							<label for="comment-kind" class="block text-sm font-medium mb-1">Kind</label>
							<select
								id="comment-kind"
								class="rounded-md border bg-background px-3 py-1.5 text-sm w-full max-w-xs"
								data-testid="comment-kind-select"
								bind:value={commentKind}
							>
								<option value="nit">Nit</option>
								<option value="question">Question</option>
								<option value="blocker">Blocker</option>
							</select>
						</div>
						<div>
							<label for="comment-body" class="block text-sm font-medium mb-1">Comment</label>
							<textarea
								id="comment-body"
								class="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[80px] resize-y"
								data-testid="comment-body-input"
								placeholder="Write your comment..."
								bind:value={commentBody}
							></textarea>
						</div>
						<div class="flex items-center gap-2">
							<button
								type="button"
								class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
								data-testid="comment-submit-button"
								disabled={!commentBody.trim() || addCommentMutation.isPending}
								onclick={handleAddComment}
							>
								{addCommentMutation.isPending ? 'Submitting...' : 'Submit'}
							</button>
							<button
								type="button"
								class="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
								data-testid="comment-cancel-button"
								onclick={() => { showAddComment = false; commentBody = ''; }}
							>
								Cancel
							</button>
						</div>
					</div>
				</div>
			{/if}

			<!-- AC: @review-records-web-ui ac-10 — Empty state for threads -->
			{#if review.threads.length === 0}
				<div class="border rounded-lg p-8 text-center text-muted-foreground" data-testid="threads-empty">
					<p>No threads yet</p>
					<p class="text-sm mt-1">Threads will appear here when comments are added to this review.</p>
				</div>
			{:else}
				<div class="flex flex-col gap-4">
					<!-- Unresolved threads first -->
					{#each unresolvedThreads as thread (thread._ulid)}
						{@const anchorText = formatAnchor(thread)}
						<div
							class="border rounded-lg overflow-hidden"
							data-testid="thread-item"
							data-thread-id={thread._ulid}
							data-thread-kind={thread.kind}
						>
							<!-- Thread header -->
							<div class="flex items-center gap-2 px-4 py-2 bg-muted/30 border-b">
								<!-- AC: @review-records-web-ui ac-2 — Kind badges -->
								<Badge data-testid="thread-kind-badge" class={getKindColor(thread.kind)}>
									{formatKind(thread.kind)}
								</Badge>
								{#if anchorText}
									<span class="text-xs font-mono text-muted-foreground" data-testid="thread-anchor">
										{anchorText}
									</span>
								{/if}
								<div class="ml-auto flex items-center gap-2">
									<!-- AC: @review-records-web-ui ac-5 — Resolve button for blocker/question threads -->
									{#if isInteractive && (thread.kind === 'blocker' || thread.kind === 'question')}
										<button
											type="button"
											class="text-xs rounded px-2 py-0.5 border hover:bg-muted transition-colors disabled:opacity-50"
											data-testid="thread-resolve-button"
											disabled={resolveMutation.isPending}
											onclick={() => resolveMutation.mutate(thread._ulid)}
										>
											Resolve
										</button>
									{/if}
									<span class="text-xs" data-testid="thread-status">
										<span class="text-amber-600 dark:text-amber-400">Open</span>
									</span>
								</div>
							</div>

							<!-- Thread entries -->
							<div class="divide-y">
								{#each thread.entries as entry (entry._ulid)}
									<div class="px-4 py-3" data-testid="thread-entry">
										<div class="flex items-center gap-2 mb-2">
											<span class="text-sm font-medium" data-testid="entry-author">
												{entry.author}
											</span>
											<span
												class="text-xs text-muted-foreground"
												data-testid="entry-timestamp"
												title={entry.created_at}
											>
												{formatRelativeTime(entry.created_at)}
											</span>
										</div>
										<div
											class="prose prose-sm dark:prose-invert max-w-none"
											data-testid="entry-body"
										>
											{@html renderMarkdown(entry.body)}
										</div>
									</div>
								{/each}
							</div>

							<!-- AC: @review-records-web-ui ac-4 — Reply form -->
							{#if isInteractive}
								<div class="border-t px-4 py-2">
									{#if replyingToThread === thread._ulid}
										<div class="flex flex-col gap-2" data-testid="reply-form">
											<textarea
												class="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[60px] resize-y"
												data-testid="reply-body-input"
												placeholder="Write your reply..."
												bind:value={replyBody}
											></textarea>
											<div class="flex items-center gap-2">
												<button
													type="button"
													class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
													data-testid="reply-submit-button"
													disabled={!replyBody.trim() || replyMutation.isPending}
													onclick={() => handleReply(thread._ulid)}
												>
													{replyMutation.isPending ? 'Submitting...' : 'Reply'}
												</button>
												<button
													type="button"
													class="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
													data-testid="reply-cancel-button"
													onclick={() => { replyingToThread = null; replyBody = ''; }}
												>
													Cancel
												</button>
											</div>
										</div>
									{:else}
										<button
											type="button"
											class="text-sm text-muted-foreground hover:text-foreground transition-colors"
											data-testid="thread-reply-button"
											onclick={() => openReplyForm(thread._ulid)}
										>
											Reply
										</button>
									{/if}
								</div>
							{/if}
						</div>
					{/each}

					<!-- Resolved threads -->
					{#if resolvedThreads.length > 0}
						<div class="flex flex-col gap-2">
							<button
								type="button"
								class="inline-flex items-center gap-2 self-start py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
								data-testid="resolved-threads-toggle"
								aria-expanded={showResolvedThreads}
								onclick={() => {
									showResolvedThreads = !showResolvedThreads;
								}}
							>
								<svg
									class={`h-4 w-4 transition-transform ${showResolvedThreads ? 'rotate-90' : ''}`}
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="m9 18 6-6-6-6" />
								</svg>
								<span>{resolvedThreads.length} resolved thread{resolvedThreads.length === 1 ? '' : 's'}</span>
							</button>
							{#if showResolvedThreads}
								<div class="flex flex-col gap-4 mt-2" data-testid="resolved-threads-section">
								{#each resolvedThreads as thread (thread._ulid)}
									{@const anchorText = formatAnchor(thread)}
									<div
										class="border rounded-lg overflow-hidden opacity-75"
										data-testid="thread-item"
										data-thread-id={thread._ulid}
										data-thread-kind={thread.kind}
									>
										<div class="flex items-center gap-2 px-4 py-2 bg-muted/30 border-b">
											<Badge data-testid="thread-kind-badge" class={getKindColor(thread.kind)}>
												{formatKind(thread.kind)}
											</Badge>
											{#if anchorText}
												<span class="text-xs font-mono text-muted-foreground" data-testid="thread-anchor">
													{anchorText}
												</span>
											{/if}
											<div class="ml-auto flex items-center gap-2">
												<!-- AC: @review-records-web-ui ac-5 — Reopen button for resolved blocker/question threads -->
												{#if isInteractive && (thread.kind === 'blocker' || thread.kind === 'question')}
													<button
														type="button"
														class="text-xs rounded px-2 py-0.5 border hover:bg-muted transition-colors disabled:opacity-50"
														data-testid="thread-reopen-button"
														disabled={reopenMutation.isPending}
														onclick={() => reopenMutation.mutate(thread._ulid)}
													>
														Reopen
													</button>
												{/if}
												<span class="text-xs text-emerald-600 dark:text-emerald-400" data-testid="thread-status">
													Resolved
												</span>
											</div>
										</div>
										<div class="divide-y">
											{#each thread.entries as entry (entry._ulid)}
												<div class="px-4 py-3" data-testid="thread-entry">
													<div class="flex items-center gap-2 mb-2">
														<span class="text-sm font-medium" data-testid="entry-author">
															{entry.author}
														</span>
														<span
															class="text-xs text-muted-foreground"
															data-testid="entry-timestamp"
															title={entry.created_at}
														>
															{formatRelativeTime(entry.created_at)}
														</span>
													</div>
													<div
														class="prose prose-sm dark:prose-invert max-w-none"
														data-testid="entry-body"
													>
														{@html renderMarkdown(entry.body)}
													</div>
												</div>
											{/each}
										</div>

										<!-- AC: @review-records-web-ui ac-4 — Reply form on resolved threads -->
										{#if isInteractive}
											<div class="border-t px-4 py-2">
												{#if replyingToThread === thread._ulid}
													<div class="flex flex-col gap-2" data-testid="reply-form">
														<textarea
															class="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[60px] resize-y"
															data-testid="reply-body-input"
															placeholder="Write your reply..."
															bind:value={replyBody}
														></textarea>
														<div class="flex items-center gap-2">
															<button
																type="button"
																class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
																data-testid="reply-submit-button"
																disabled={!replyBody.trim() || replyMutation.isPending}
																onclick={() => handleReply(thread._ulid)}
															>
																{replyMutation.isPending ? 'Submitting...' : 'Reply'}
															</button>
															<button
																type="button"
																class="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
																data-testid="reply-cancel-button"
																onclick={() => { replyingToThread = null; replyBody = ''; }}
															>
																Cancel
															</button>
														</div>
													</div>
												{:else}
													<button
														type="button"
														class="text-sm text-muted-foreground hover:text-foreground transition-colors"
														data-testid="thread-reply-button"
														onclick={() => openReplyForm(thread._ulid)}
													>
														Reply
													</button>
												{/if}
											</div>
										{/if}
									</div>
								{/each}
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</section>

		<!-- Checks Section -->
		<section data-testid="checks-section">
			<h2 class="text-lg font-semibold mb-3">
				Checks
				{#if review.checks.length > 0}
					<span class="text-sm font-normal text-muted-foreground ml-1">
						({review.checks.length})
					</span>
				{/if}
			</h2>

			<!-- AC: @review-records-web-ui ac-10 — Empty state for checks -->
			{#if review.checks.length === 0}
				<div class="border rounded-lg p-8 text-center text-muted-foreground" data-testid="checks-empty">
					<p>No checks recorded</p>
					<p class="text-sm mt-1">Checks will appear here when test/lint results are recorded.</p>
				</div>
			{:else}
				<!-- AC: @review-records-web-ui ac-2 — Checks show pass/fail with staleness -->
				<div class="border rounded-lg overflow-hidden">
					<div class="divide-y">
						{#each review.checks as check}
							{@const stale = isCheckStale(check)}
							<div
								class="flex items-center gap-3 px-4 py-3 {stale ? 'opacity-60' : ''}"
								data-testid="check-item"
								data-check-name={check.name}
							>
								<Badge data-testid="check-status-badge" class={getCheckStatusColor(check.status)}>
									{formatCheckStatus(check.status)}
								</Badge>
								<span class="font-medium text-sm" data-testid="check-name">{check.name}</span>
								{#if check.runner}
									<span class="text-xs text-muted-foreground">({check.runner})</span>
								{/if}
								{#if !check.required}
									<span class="text-xs text-muted-foreground italic">optional</span>
								{/if}
								{#if stale}
									<Badge class="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400" data-testid="check-stale-badge">
										Stale
									</Badge>
								{/if}
								{#if check.evidence}
									<span class="text-xs text-muted-foreground ml-auto truncate max-w-[300px]" data-testid="check-evidence" title={check.evidence}>
										{check.evidence}
									</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</section>

		<!-- Verdicts Section -->
		<section data-testid="verdicts-section">
			<h2 class="text-lg font-semibold mb-3">
				Verdicts
				{#if review.verdicts.length > 0}
					<span class="text-sm font-normal text-muted-foreground ml-1">
						({review.verdicts.length})
					</span>
				{/if}
			</h2>

			<!-- AC: @review-records-web-ui ac-10 — Empty state for verdicts -->
			{#if review.verdicts.length === 0}
				<div class="border rounded-lg p-8 text-center text-muted-foreground" data-testid="verdicts-empty">
					<p>No verdicts yet</p>
					<p class="text-sm mt-1">Verdicts will appear here when reviewers submit their decisions.</p>
				</div>
			{:else}
				<!-- AC: @review-records-web-ui ac-2 — Verdicts show reviewer decisions -->
				<div class="border rounded-lg overflow-hidden">
					<div class="divide-y">
						{#each review.verdicts as verdict}
							<div class="flex items-center gap-3 px-4 py-3" data-testid="verdict-item">
								<Badge data-testid="verdict-decision-badge" class={getVerdictColor(verdict.decision)}>
									{formatVerdict(verdict.decision)}
								</Badge>
								<span class="text-sm font-medium" data-testid="verdict-reviewer">
									{verdict.reviewer}
								</span>
								{#if verdict.role && verdict.role !== 'reviewer'}
									<span class="text-xs text-muted-foreground">({verdict.role})</span>
								{/if}
								<span
									class="text-xs text-muted-foreground ml-auto"
									data-testid="verdict-timestamp"
									title={verdict.created_at}
								>
									{formatRelativeTime(verdict.created_at)}
								</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</section>

		<!--
			Resources Section
			AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
			AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
			AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
		-->
		<section data-testid="resources-section">
			<h2 class="text-lg font-semibold mb-3">
				Resources
				{#if reviewResources.length > 0}
					<span class="text-sm font-normal text-muted-foreground ml-1">
						({reviewResources.length})
					</span>
				{/if}
			</h2>

			{#if reviewResources.length === 0}
				<div class="border rounded-lg p-8 text-center text-muted-foreground" data-testid="resources-empty">
					<p>No attached resources</p>
					<p class="text-sm mt-1">Screenshots and other evidence attached to this review will appear here.</p>
				</div>
			{:else}
				<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="resources-grid">
					{#each reviewResources as resource (resource.id)}
						{@const url = resolveResourceUrl(resource)}
						<a
							href={url}
							target="_blank"
							rel="noopener noreferrer"
							class="border rounded-lg overflow-hidden hover:border-primary transition-colors flex flex-col"
							data-testid="resource-item"
							data-resource-id={resource.id}
							data-resource-content-type={resource.content_type}
							data-resource-path={resource.path}
						>
							{#if isImageResource(resource)}
								<img
									src={url}
									alt={resource.label ?? resource.id}
									class="w-full aspect-video object-cover bg-muted"
									data-testid="resource-image-preview"
									loading="lazy"
								/>
							{:else}
								<div class="w-full aspect-video flex items-center justify-center bg-muted text-muted-foreground text-xs font-mono p-4 text-center" data-testid="resource-binary-placeholder">
									{resource.content_type}
								</div>
							{/if}
							<div class="px-3 py-2 border-t flex flex-col gap-0.5">
								<span class="text-sm font-medium truncate" data-testid="resource-label">
									{resource.label ?? resource.id}
								</span>
								<span class="text-xs text-muted-foreground truncate font-mono" data-testid="resource-path">
									{resource.path}
								</span>
								<span class="text-xs text-muted-foreground" data-testid="resource-bytes">
									{formatResourceBytes(resource.bytes)} · {resource.content_type}
								</span>
							</div>
						</a>
					{/each}
				</div>
			{/if}
		</section>

		<!-- AC: @review-records-web-ui ac-6 — Verdict submission panel -->
		{#if isInteractive}
			<section data-testid="verdict-submission-section">
				<h2 class="text-lg font-semibold mb-3">Submit Verdict</h2>
				<div class="border rounded-lg p-4" data-testid="verdict-form">
					<div class="flex flex-col gap-3">
						<div>
							<label for="verdict-decision" class="block text-sm font-medium mb-1">Decision</label>
							<select
								id="verdict-decision"
								class="rounded-md border bg-background px-3 py-1.5 text-sm w-full max-w-xs"
								data-testid="verdict-decision-select"
								bind:value={verdictDecision}
							>
								<option value="approve">Approve</option>
								<option value="request_changes">Request Changes</option>
								<option value="comment">Comment</option>
							</select>
						</div>
						<div>
							<label for="verdict-reviewer" class="block text-sm font-medium mb-1">Reviewer</label>
							<input
								id="verdict-reviewer"
								type="text"
								class="w-full max-w-sm rounded-md border bg-background px-3 py-1.5 text-sm"
								data-testid="verdict-reviewer-input"
								placeholder="your@email.com"
								bind:value={verdictReviewer}
							/>
						</div>
						<div>
							<button
								type="button"
								class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
								data-testid="verdict-submit-button"
								disabled={!verdictReviewer.trim() || verdictMutation.isPending}
								onclick={handleSubmitVerdict}
							>
								{verdictMutation.isPending ? 'Submitting...' : 'Submit Verdict'}
							</button>
						</div>
					</div>
				</div>
			</section>
		{/if}
	{/if}
</div>
