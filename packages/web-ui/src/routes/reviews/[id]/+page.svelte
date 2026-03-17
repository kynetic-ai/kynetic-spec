<!--
  AC: @review-records-web-ui ac-2 — Review detail page with threads, checks, verdicts, disposition
  AC: @review-records-web-ui ac-8 — Markdown rendering with syntax highlighting in thread bodies
  AC: @review-records-web-ui ac-9 — Author identity and relative timestamp on thread entries
  AC: @review-records-web-ui ac-10 — Empty state messages for sections with no items
  AC: @review-records-web-ui ac-11 — Revision dropdown for same-subject reviews
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import type { ReviewDetail, ReviewSummary, ReviewThread, BroadcastEvent } from '@kynetic-ai/shared';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { Badge } from '$lib/components/ui/badge';
	import { fetchReview, fetchReviewSiblings } from '$lib/api';
	import { subscribe, unsubscribe, on, off } from '$lib/stores/connection.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { shortRef, normalizeRef, refHref } from '$lib/utils/reference';

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

	const siblingsQuery = createQuery(() => ({
		queryKey: queryKeys.reviews.siblings(subjectRef || headBranch || ''),
		queryFn: () =>
			fetchReviewSiblings({
				subject_type: subjectType,
				subject_ref: subjectRef,
				head_branch: headBranch,
			}),
		enabled: isProjectInitialized() && !!review && (!!subjectRef || !!headBranch),
	}));

	let siblings = $derived<ReviewSummary[]>(siblingsQuery.data ?? []);
	let hasMultipleRevisions = $derived(siblings.length > 1);

	// --- Badge helpers (reused from list page) ---
	function getDispositionColor(disposition: string): string {
		const colors: Record<string, string> = {
			pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
			approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
			changes_requested: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
		};
		return colors[disposition] || 'bg-gray-100 text-gray-800';
	}

	function formatDisposition(disposition: string): string {
		const labels: Record<string, string> = {
			pending: 'Pending',
			approved: 'Approved',
			changes_requested: 'Changes Requested',
		};
		return labels[disposition] || disposition;
	}

	function getLifecycleColor(state: string): string {
		const colors: Record<string, string> = {
			draft: 'bg-status-pending text-status-pending-fg',
			open: 'bg-status-in-progress text-status-in-progress-fg',
			closed: 'bg-status-completed text-status-completed-fg',
			archived: 'bg-status-cancelled text-status-cancelled-fg',
		};
		return colors[state] || 'bg-status-cancelled text-status-cancelled-fg';
	}

	function formatLifecycle(state: string): string {
		const labels: Record<string, string> = {
			draft: 'Draft',
			open: 'Open',
			closed: 'Closed',
			archived: 'Archived',
		};
		return labels[state] || state;
	}

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
</script>

<div class="flex flex-col gap-6 p-6 min-w-0">
	<!-- Back navigation -->
	<div>
		<a
			href="{base}/reviews"
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

	{#if loading}
		<div class="flex justify-center items-center py-12">
			<p class="text-muted-foreground">Loading review...</p>
		</div>
	{:else if review}
		<!-- Header -->
		<div class="flex flex-col gap-4" data-testid="review-header">
			<div class="flex flex-wrap items-center gap-3">
				<h1 class="text-2xl font-bold" data-testid="review-title">{review.title}</h1>
				<!-- AC: @review-records-web-ui ac-2 — Prominent computed disposition -->
				<Badge data-testid="review-disposition-badge" class={getDispositionColor(review.disposition)}>
					{formatDisposition(review.disposition)}
				</Badge>
				<Badge data-testid="review-lifecycle-badge" class={getLifecycleColor(review.lifecycle_state)}>
					{formatLifecycle(review.lifecycle_state)}
				</Badge>
			</div>

			<!-- Subject info and metadata -->
			<div class="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
				<span data-testid="review-subject-info">
					<span class="font-medium">{formatSubjectType(review.subject.type)}</span>
					{#if getSubjectRef()}
						{@const ref = getSubjectRef()}
						{@const refType = getSubjectRefType()}
						{#if ref && refType}
							<a
								href={refHref(refType, ref, base)}
								class="text-primary hover:underline ml-1"
								data-testid="review-subject-link"
							>@{shortRef(ref)}</a>
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

				<span class="font-mono text-xs" data-testid="review-ref">
					@{review.slugs?.[0] || review._ulid.slice(0, 8)}
				</span>
			</div>

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

		<!-- Threads Section -->
		<section data-testid="threads-section">
			<h2 class="text-lg font-semibold mb-3">
				Threads
				{#if review.threads.length > 0}
					<span class="text-sm font-normal text-muted-foreground ml-1">
						({unresolvedThreads.length} open, {resolvedThreads.length} resolved)
					</span>
				{/if}
			</h2>

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
								<!-- AC: @review-records-web-ui ac-2 — Kind badges (blocker=red, question=amber, nit=gray) -->
								<Badge data-testid="thread-kind-badge" class={getKindColor(thread.kind)}>
									{formatKind(thread.kind)}
								</Badge>
								{#if anchorText}
									<span class="text-xs font-mono text-muted-foreground" data-testid="thread-anchor">
										{anchorText}
									</span>
								{/if}
								<!-- AC: @review-records-web-ui ac-2 — Resolution state -->
								<span class="ml-auto text-xs" data-testid="thread-status">
									{#if thread.resolved_at}
										<span class="text-emerald-600 dark:text-emerald-400">Resolved</span>
									{:else}
										<span class="text-amber-600 dark:text-amber-400">Open</span>
									{/if}
								</span>
							</div>

							<!-- AC: @review-records-web-ui ac-2 — Thread entries as conversation view -->
							<!-- AC: @review-records-web-ui ac-8 — Markdown rendering in bodies -->
							<!-- AC: @review-records-web-ui ac-9 — Author and relative timestamp -->
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
						</div>
					{/each}

					<!-- Resolved threads -->
					{#if resolvedThreads.length > 0}
						<details class="group">
							<summary class="cursor-pointer text-sm text-muted-foreground hover:text-foreground py-2" data-testid="resolved-threads-toggle">
								{resolvedThreads.length} resolved thread{resolvedThreads.length === 1 ? '' : 's'}
							</summary>
							<div class="flex flex-col gap-4 mt-2">
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
											<span class="ml-auto text-xs text-emerald-600 dark:text-emerald-400" data-testid="thread-status">
												Resolved
											</span>
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
									</div>
								{/each}
							</div>
						</details>
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
	{/if}
</div>
