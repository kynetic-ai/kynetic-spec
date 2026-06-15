<!--
  AC: @review-code-diff-viewer ac-1 — Each file is expandable to show its diff content
  AC: @review-code-diff-viewer ac-2 — Unified diff view with syntax highlighting and line numbers
  AC: @review-code-diff-viewer ac-3 — Collapsed unchanged regions with "Show N more lines"
  AC: @review-code-diff-viewer ac-6 — Diff content loaded on expand (lazy loading)
-->
<script lang="ts">
	import type { DiffFile, DiffHunk } from '$lib/api';
	import type { ReviewThread } from '@kynetic-ai/shared';
	import { getFilePath as getFilePathUtil } from '$lib/utils/diff';
	import { resolveStatusToken, statusTextClass } from '$lib/ds/status-tokens';
	import type { ActorClassifier } from '$lib/utils/actor';
	import DiffHunkView from './DiffHunkView.svelte';

	interface Props {
		file: DiffFile;
		threads: ReviewThread[];
		headCommit: string;
		isInteractive: boolean;
		/** Shared actor classifier threaded to inline diff thread authors. */
		classifier?: ActorClassifier;
		expanded: boolean;
		onToggleExpand: () => void;
		onAddComment: (data: {
			body: string;
			kind: 'blocker' | 'question' | 'nit';
			path: string;
			lineNumber: number;
			side: 'base' | 'head';
		}) => void;
		onReply: (threadId: string, body: string) => void;
		onResolve: (threadId: string) => void;
		onReopen: (threadId: string) => void;
		onExpandContext?: (path: string, direction: 'up' | 'down', hunkIndex: number, lineNumber: number) => void;
		loading?: boolean;
	}

	let {
		file,
		threads,
		headCommit,
		isInteractive,
		classifier,
		expanded,
		onToggleExpand,
		onAddComment,
		onReply,
		onResolve,
		onReopen,
		onExpandContext,
		loading = false,
	}: Props = $props();

	function getStatusIcon(status: DiffFile['status']): string {
		return resolveStatusToken('diff', status).glyph;
	}

	function getStatusColor(status: DiffFile['status']): string {
		return statusTextClass(resolveStatusToken('diff', status).family);
	}

	function getFilePath(): string {
		return getFilePathUtil(file);
	}

	function getDisplayPath(): string {
		if (file.status === 'renamed' && file.oldPath !== file.newPath) {
			return `${file.oldPath} → ${file.newPath}`;
		}
		return getFilePath();
	}

	// Detect language from file extension for syntax highlighting
	function detectLanguage(filePath: string): string | undefined {
		const ext = filePath.split('.').pop()?.toLowerCase();
		if (!ext) return undefined;
		const extMap: Record<string, string> = {
			ts: 'typescript', tsx: 'typescript',
			js: 'javascript', jsx: 'javascript',
			py: 'python',
			rs: 'rust',
			go: 'go',
			json: 'json',
			yaml: 'yaml', yml: 'yaml',
			sql: 'sql',
			css: 'css',
			html: 'html', htm: 'html',
			java: 'java',
			c: 'c',
			cpp: 'cpp', cxx: 'cpp', cc: 'cpp',
			sh: 'bash', bash: 'bash', zsh: 'bash',
			diff: 'diff', patch: 'diff',
		};
		return extMap[ext];
	}

	let language = $derived(detectLanguage(getFilePath()));

	// Filter threads for this file
	let fileThreads = $derived(
		threads.filter((t) =>
			t.anchor?.type === 'code' &&
			t.anchor.path === getFilePath()
		)
	);

	// Get the last new-side line number in a hunk
	function getHunkLastNewLine(h: DiffHunk): number {
		for (let j = h.changes.length - 1; j >= 0; j--) {
			if (h.changes[j].newLineNumber != null) return h.changes[j].newLineNumber!;
		}
		return h.newStart + h.newCount - 1;
	}

	// Count of collapsed context lines between hunks
	function getCollapsedLinesBetweenHunks(hunks: DiffHunk[], idx: number): number {
		if (idx === 0) return 0;
		const prevHunk = hunks[idx - 1];
		const currHunk = hunks[idx];
		const prevEnd = getHunkLastNewLine(prevHunk);
		return Math.max(0, currHunk.newStart - prevEnd - 1);
	}

	function handleAddComment(data: { body: string; kind: 'blocker' | 'question' | 'nit'; lineNumber: number; side: 'base' | 'head' }) {
		onAddComment({
			...data,
			path: getFilePath(),
		});
	}

	function handleExpandContext(direction: 'up' | 'down', hunkIndex: number, lineNumber: number) {
		onExpandContext?.(getFilePath(), direction, hunkIndex, lineNumber);
	}

	let threadCount = $derived(fileThreads.length);
	let unresolvedCount = $derived(fileThreads.filter(t => !t.resolved_at).length);
</script>

<div class="border rounded-lg overflow-hidden" data-testid="diff-file-view" data-file-path={getFilePath()}>
	<!-- File header (always visible) -->
	<button
		type="button"
		class="w-full text-left px-4 py-2 bg-muted/30 flex items-center gap-2 text-sm hover:bg-muted/50 transition-colors"
		data-testid="diff-file-header"
		onclick={onToggleExpand}
	>
		<svg
			class="h-3.5 w-3.5 flex-shrink-0 transition-transform {expanded ? 'rotate-90' : ''}"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
		>
			<path d="M9 18l6-6-6-6"/>
		</svg>

		<span class="font-mono font-bold text-xs {getStatusColor(file.status)}" data-testid="diff-file-status-icon">
			{getStatusIcon(file.status)}
		</span>

		<span class="font-mono text-xs truncate flex-1" title={getDisplayPath()}>
			{getDisplayPath()}
		</span>

		<!-- Thread count indicator -->
		{#if threadCount > 0}
			<span class="text-xs text-muted-foreground" data-testid="diff-file-thread-count">
				{unresolvedCount > 0 ? `${unresolvedCount} open` : ''}{unresolvedCount > 0 && (threadCount - unresolvedCount) > 0 ? ', ' : ''}{(threadCount - unresolvedCount) > 0 ? `${threadCount - unresolvedCount} resolved` : ''}
			</span>
		{/if}

		<span class="flex items-center gap-1 text-xs flex-shrink-0">
			{#if file.stats.additions > 0}
				<span class="text-emerald-600 dark:text-emerald-400">+{file.stats.additions}</span>
			{/if}
			{#if file.stats.deletions > 0}
				<span class="text-red-600 dark:text-red-400">-{file.stats.deletions}</span>
			{/if}
		</span>
	</button>

	<!-- File diff content (expandable) -->
	{#if expanded}
		<div class="border-t" data-testid="diff-file-content">
			{#if loading}
				<div class="py-4 text-center text-sm text-muted-foreground">
					Loading diff...
				</div>
			{:else if file.hunks.length === 0}
				<div class="py-4 text-center text-sm text-muted-foreground">
					No changes (binary file or empty diff)
				</div>
			{:else}
				{#each file.hunks as hunk, i}
					<!-- Collapsed lines between hunks -->
					{#if i > 0}
						{@const collapsed = getCollapsedLinesBetweenHunks(file.hunks, i)}
						{#if collapsed > 0 && onExpandContext}
							<button
								type="button"
								class="w-full text-center py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors border-y bg-muted/20"
								data-testid="expand-context-between"
								onclick={() => handleExpandContext('down', i - 1, getHunkLastNewLine(file.hunks[i - 1]))}
							>
								Show {collapsed} more line{collapsed === 1 ? '' : 's'}
							</button>
						{/if}
					{/if}

					<DiffHunkView
						{hunk}
						filePath={getFilePath()}
						{language}
						threads={fileThreads}
						{headCommit}
						{isInteractive}
						{classifier}
						onAddComment={handleAddComment}
						{onReply}
						{onResolve}
						{onReopen}
						hunkIndex={i}
						isFirstHunk={i === 0}
						onExpandContext={onExpandContext ? handleExpandContext : undefined}
					/>
				{/each}
			{/if}
		</div>
	{/if}
</div>
