<!--
  AC: @review-code-diff-viewer ac-2 — Unified diff with syntax highlighting, line numbers, color coding
  AC: @review-code-diff-viewer ac-3 — Collapsed unchanged regions with "Show N more lines" expansion
  AC: @review-code-diff-viewer ac-4 — Click-to-comment on diff lines via + button on hover
  AC: @review-code-diff-viewer ac-5 — Existing threads rendered inline at anchored positions
-->
<script lang="ts">
	import type { DiffHunk, DiffChangeLine } from '$lib/api';
	import type { ReviewThread, ReviewThreadKind } from '@kynetic-ai/shared';
	import { highlightCode } from '$lib/utils/highlight';
	import type { ActorClassifier } from '$lib/utils/actor';
	import DiffInlineThread from './DiffInlineThread.svelte';
	import DiffCommentForm from './DiffCommentForm.svelte';

	interface Props {
		hunk: DiffHunk;
		filePath: string;
		language: string | undefined;
		threads: ReviewThread[];
		headCommit: string;
		isInteractive: boolean;
		/** Shared actor classifier threaded to inline diff thread authors. */
		classifier?: ActorClassifier;
			onAddComment: (data: {
				body: string;
				kind: ReviewThreadKind;
				lineNumber: number;
				side: 'base' | 'head';
		}) => void;
		onReply: (threadId: string, body: string) => void;
		onResolve: (threadId: string) => void;
		onReopen: (threadId: string) => void;
		onExpandContext?: (direction: 'up' | 'down', hunkIndex: number, lineNumber: number) => void;
		hunkIndex: number;
		isFirstHunk: boolean;
	}

	let {
		hunk,
		filePath,
		language,
		threads,
		headCommit,
		isInteractive,
		classifier,
		onAddComment,
		onReply,
		onResolve,
		onReopen,
		onExpandContext,
		hunkIndex,
		isFirstHunk,
	}: Props = $props();

	// Comment form state
	let commentingOnLine = $state<{ lineNumber: number; side: 'base' | 'head' } | null>(null);

	function getLineClass(type: DiffChangeLine['type']): string {
		switch (type) {
			case 'added': return 'bg-emerald-50 dark:bg-emerald-950/30';
			case 'deleted': return 'bg-red-50 dark:bg-red-950/30';
			default: return '';
		}
	}

	function getLineNumberClass(type: DiffChangeLine['type']): string {
		switch (type) {
			case 'added': return 'bg-emerald-100/60 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-500';
			case 'deleted': return 'bg-red-100/60 dark:bg-red-900/20 text-red-700 dark:text-red-500';
			default: return 'text-muted-foreground';
		}
	}

	function getGutterSymbol(type: DiffChangeLine['type']): string {
		switch (type) {
			case 'added': return '+';
			case 'deleted': return '-';
			default: return ' ';
		}
	}

	function getGutterClass(type: DiffChangeLine['type']): string {
		switch (type) {
			case 'added': return 'text-emerald-600 dark:text-emerald-400 bg-emerald-100/80 dark:bg-emerald-900/30';
			case 'deleted': return 'text-red-600 dark:text-red-400 bg-red-100/80 dark:bg-red-900/30';
			default: return 'text-muted-foreground';
		}
	}

	function highlightLine(content: string, lang: string | undefined): string {
		if (!lang || !content.trim()) return escapeHtml(content);
		return highlightCode(content, lang);
	}

	function escapeHtml(text: string): string {
		return text
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;');
	}

	// Find threads anchored to a specific line
	function getThreadsForLine(lineNumber: number, side: 'base' | 'head'): ReviewThread[] {
		return threads.filter((t) => {
			if (!t.anchor || t.anchor.type !== 'code') return false;
			return (
				t.anchor.path === filePath &&
				t.anchor.side === side &&
				t.anchor.line_start <= lineNumber &&
				t.anchor.line_end >= lineNumber
			);
		});
	}

	function openCommentForm(lineNumber: number, side: 'base' | 'head') {
		commentingOnLine = { lineNumber, side };
	}

	function closeCommentForm() {
		commentingOnLine = null;
	}

	function handleSubmitComment(body: string, kind: ReviewThreadKind) {
		if (!commentingOnLine) return;
		onAddComment({
			body,
			kind,
			lineNumber: commentingOnLine.lineNumber,
			side: commentingOnLine.side,
		});
		commentingOnLine = null;
	}

	// Check if there are hidden lines before/after this hunk
	let hiddenLinesBefore = $derived(
		isFirstHunk && hunk.newStart > 1
			? hunk.newStart - 1
			: 0
	);

</script>

<div class="diff-hunk" data-testid="diff-hunk" data-hunk-index={hunkIndex}>
	<!-- AC: @review-code-diff-viewer ac-3 — Show N more lines button (before hunk) -->
	{#if hiddenLinesBefore > 0 && onExpandContext}
		<button
			type="button"
			class="w-full text-center py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors border-b bg-muted/20"
			data-testid="expand-context-up"
			onclick={() => onExpandContext?.('up', hunkIndex, hunk.newStart)}
		>
			Show {hiddenLinesBefore} more line{hiddenLinesBefore === 1 ? '' : 's'} above
		</button>
	{/if}

	<!-- Hunk header -->
	<div
		class="px-4 py-1 text-xs text-muted-foreground bg-blue-50/50 dark:bg-blue-950/20 border-b font-mono select-none"
		data-testid="diff-hunk-header"
	>
		{hunk.header}
	</div>

	<!-- Change lines -->
	{#each hunk.changes as change, i}
		{@const lineNum = change.type === 'deleted' ? change.oldLineNumber : change.newLineNumber}
		{@const side = change.type === 'deleted' ? 'base' as const : 'head' as const}
		{@const lineThreads = lineNum ? getThreadsForLine(lineNum, side) : []}
		{@const isCommentTarget = commentingOnLine && lineNum === commentingOnLine.lineNumber && side === commentingOnLine.side}

		<div
			class="group flex {getLineClass(change.type)} hover:brightness-95 dark:hover:brightness-110"
			data-testid="diff-line"
			data-line-type={change.type}
			data-old-line={change.oldLineNumber}
			data-new-line={change.newLineNumber}
		>
			<!-- AC: @review-code-diff-viewer ac-4 — Comment button on hover -->
			<div class="w-8 flex-shrink-0 flex items-center justify-center">
				{#if isInteractive && lineNum}
					<button
						type="button"
						class="invisible group-hover:visible text-primary hover:text-primary/80 transition-colors"
						data-testid="diff-line-comment-button"
						title="Add comment on line {lineNum}"
						onclick={() => openCommentForm(lineNum!, side)}
					>
						<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M12 5v14M5 12h14"/>
						</svg>
					</button>
				{/if}
			</div>

			<!-- Old line number -->
			<div
				class="w-12 flex-shrink-0 text-right pr-2 text-xs font-mono select-none {getLineNumberClass(change.type)}"
				data-testid="diff-old-line-number"
			>
				{change.oldLineNumber ?? ''}
			</div>

			<!-- New line number -->
			<div
				class="w-12 flex-shrink-0 text-right pr-2 text-xs font-mono select-none {getLineNumberClass(change.type)}"
				data-testid="diff-new-line-number"
			>
				{change.newLineNumber ?? ''}
			</div>

			<!-- Gutter (+/-/space) -->
			<div
				class="w-5 flex-shrink-0 text-center text-xs font-mono select-none {getGutterClass(change.type)}"
			>
				{getGutterSymbol(change.type)}
			</div>

			<!-- Code content with syntax highlighting -->
			<div class="flex-1 min-w-0 px-2 text-sm font-mono whitespace-pre overflow-x-auto">
				{@html highlightLine(change.content, language)}
			</div>
		</div>

		<!-- AC: @review-code-diff-viewer ac-5 — Inline threads at anchor positions -->
		{#each lineThreads as thread (thread._ulid)}
			<DiffInlineThread
				{thread}
				{isInteractive}
				{classifier}
				{onReply}
				{onResolve}
				{onReopen}
			/>
		{/each}

		<!-- AC: @review-code-diff-viewer ac-4 — Inline comment form -->
		{#if isCommentTarget}
			<DiffCommentForm
				onSubmit={handleSubmitComment}
				onCancel={closeCommentForm}
			/>
		{/if}
	{/each}

</div>
