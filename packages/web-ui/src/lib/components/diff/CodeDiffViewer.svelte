<!--
  AC: @review-code-diff-viewer ac-1 — File list shows all changed files with diff stats, expandable
  AC: @review-code-diff-viewer ac-2 — Unified diff with syntax highlighting, line numbers, color coding
  AC: @review-code-diff-viewer ac-3 — Collapsed unchanged regions with "Show N more lines" expansion
  AC: @review-code-diff-viewer ac-4 — Click-to-comment creates thread with code anchor
  AC: @review-code-diff-viewer ac-5 — Existing threads shown inline at anchor positions
  AC: @review-code-diff-viewer ac-6 — Lazy loading for 20+ files (headers/stats immediate, content on expand)
-->
<script lang="ts">
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import type { ReviewThread, ReviewDetail, ReviewThreadKind } from '@kynetic-ai/shared';
	import {
		fetchDiff,
		fetchFileDiff,
		fetchDiffContext,
		createReviewThread,
		replyToReviewThread,
		resolveReviewThread,
		reopenReviewThread,
		type ParsedDiff,
		type DiffFile,
		type DiffChangeLine,
	} from '$lib/api';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { isStaticMode, ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { getFilePath } from '$lib/utils/diff';
	import type { ActorClassifier } from '$lib/utils/actor';
	import DiffFileList from './DiffFileList.svelte';
	import DiffFileView from './DiffFileView.svelte';

	interface Props {
		review: ReviewDetail;
		baseCommit: string;
		headCommit: string;
		threads: ReviewThread[];
		isInteractive: boolean;
		/** Shared actor classifier threaded to inline diff thread authors. */
		classifier?: ActorClassifier;
	}

	let { review, baseCommit, headCommit, threads, isInteractive, classifier }: Props = $props();

	const queryClient = useQueryClient();
	const LAZY_LOAD_THRESHOLD = 20;

	// Track expanded files
	let expandedFiles = $state<Set<string>>(new Set());
	let selectedFile = $state<string | null>(null);
	let mutationError = $state('');

	// AC: @review-code-diff-viewer ac-1 — Fetch full diff
	const diffQuery = createQuery(() => ({
		queryKey: queryKeys.diff.full(baseCommit, headCommit),
		queryFn: () => fetchDiff(baseCommit, headCommit),
		enabled: isProjectInitialized() && !!baseCommit && !!headCommit,
	}));

	let diff = $derived<ParsedDiff | null>(diffQuery.data ?? null);
	let diffLoading = $derived(diffQuery.isLoading);
	let diffError = $derived(diffQuery.error?.message ?? '');

	// AC: @review-code-diff-viewer ac-6 — For 20+ files, use lazy loading
	let useLazyLoading = $derived((diff?.files.length ?? 0) > LAZY_LOAD_THRESHOLD);

	// Track which files have their full diff loaded (for lazy mode)
	let lazyLoadedFiles = $state<Map<string, DiffFile>>(new Map());
	let lazyLoadingFiles = $state<Set<string>>(new Set());

	// Get the effective file data: either from full diff or lazy loaded
	function getFileData(filePath: string): DiffFile | null {
		if (!diff) return null;

		// Check lazy loaded first
		if (lazyLoadedFiles.has(filePath)) {
			return lazyLoadedFiles.get(filePath)!;
		}

		// For non-lazy mode or summary data, use the full diff
		const file = diff.files.find((f) => getFilePath(f) === filePath);
		return file ?? null;
	}

	// Lazy load a single file's diff
	async function lazyLoadFile(filePath: string) {
		if (lazyLoadedFiles.has(filePath) || lazyLoadingFiles.has(filePath)) return;

		lazyLoadingFiles = new Set([...lazyLoadingFiles, filePath]);
		try {
			const result = await fetchFileDiff(baseCommit, headCommit, filePath);
			lazyLoadedFiles = new Map([...lazyLoadedFiles, [filePath, result.file]]);
		} catch (err) {
			console.error(`Failed to load diff for ${filePath}:`, err);
		} finally {
			const next = new Set(lazyLoadingFiles);
			next.delete(filePath);
			lazyLoadingFiles = next;
		}
	}

	// Toggle file expansion
	function toggleFile(filePath: string) {
		const next = new Set(expandedFiles);
		if (next.has(filePath)) {
			next.delete(filePath);
		} else {
			next.add(filePath);
			// Lazy load if needed
			if (useLazyLoading && !lazyLoadedFiles.has(filePath)) {
				lazyLoadFile(filePath);
			}
		}
		expandedFiles = next;
		selectedFile = filePath;
	}

	// Select file from file list and expand it
	function selectFile(filePath: string) {
		if (!expandedFiles.has(filePath)) {
			toggleFile(filePath);
		}
		selectedFile = filePath;
		// Scroll to the file
		const el = document.querySelector(`[data-file-path="${CSS.escape(filePath)}"]`);
		el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	// AC: @review-code-diff-viewer ac-4 — Create thread with code anchor
	const addCommentMutation = createMutation(() => ({
			mutationFn: (data: {
				body: string;
				kind: ReviewThreadKind;
				path: string;
				lineNumber: number;
				side: 'base' | 'head';
		}) =>
			createReviewThread(review._ulid, {
				body: data.body,
				kind: data.kind,
				anchor: {
					type: 'code',
					path: data.path,
					side: data.side,
					line_start: data.lineNumber,
					line_end: data.lineNumber,
					commit: data.side === 'base' ? baseCommit : headCommit,
				},
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(review._ulid) });
			mutationError = '';
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to add comment';
		},
	}));

	function handleAddComment(data: {
		body: string;
		kind: ReviewThreadKind;
		path: string;
		lineNumber: number;
		side: 'base' | 'head';
	}) {
		mutationError = '';
		addCommentMutation.mutate(data);
	}

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

	function handleReply(threadId: string, body: string) {
		mutationError = '';
		replyMutation.mutate({ threadId, body });
	}

	// Resolve mutation
	const resolveMutation = createMutation(() => ({
		mutationFn: (threadId: string) => resolveReviewThread(review._ulid, threadId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(review._ulid) });
			mutationError = '';
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to resolve thread';
		},
	}));

	// Reopen mutation
	const reopenMutation = createMutation(() => ({
		mutationFn: (threadId: string) => reopenReviewThread(review._ulid, threadId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.reviews.detail(review._ulid) });
			mutationError = '';
		},
		onError: (err: Error) => {
			mutationError = err instanceof ReadOnlyModeError
				? err.message
				: err.message || 'Failed to reopen thread';
		},
	}));

	// AC: @review-code-diff-viewer ac-3 — Context expansion
	async function handleExpandContext(path: string, direction: 'up' | 'down', hunkIndex: number, lineNumber: number) {
		const contextSize = 20;
		const start = direction === 'up' ? Math.max(1, lineNumber - contextSize) : lineNumber + 1;
		const end = direction === 'up' ? lineNumber - 1 : lineNumber + contextSize;

		if (start > end) return;

		try {
			const result = await fetchDiffContext(baseCommit, headCommit, path, start, end);

			// Insert context lines into the file's hunks
			const fileData = getFileData(path);
			if (!fileData) return;

			// Create new context change lines
			const contextChanges: DiffChangeLine[] = result.lines.map((line) => ({
				type: 'unchanged' as const,
				content: line.content,
				oldLineNumber: line.lineNumber,
				newLineNumber: line.lineNumber,
			}));

			// Update the file hunks by inserting context lines
			const updatedHunks = [...fileData.hunks];
			const hunk = updatedHunks[hunkIndex];
			if (!hunk) return;

			if (direction === 'up') {
				// Prepend context lines before the hunk
				hunk.changes = [...contextChanges, ...hunk.changes];
				hunk.newStart = start;
				hunk.oldStart = start;
				hunk.newCount += contextChanges.length;
				hunk.oldCount += contextChanges.length;
			} else {
				// Append context lines after the hunk
				hunk.changes = [...hunk.changes, ...contextChanges];
				hunk.newCount += contextChanges.length;
				hunk.oldCount += contextChanges.length;
			}

			// Update in lazy loaded map (or create entry)
			const updatedFile: DiffFile = {
				...fileData,
				hunks: updatedHunks,
			};
			lazyLoadedFiles = new Map([...lazyLoadedFiles, [path, updatedFile]]);
		} catch (err) {
			console.error('Failed to expand context:', err);
		}
	}

	// Filter code-anchored threads only
	let codeThreads = $derived(
		threads.filter((t) => t.anchor?.type === 'code')
	);

	// For non-lazy mode, determine if a file has loaded hunks
	function isFileLoaded(filePath: string): boolean {
		if (!useLazyLoading) return true; // All files loaded in full diff
		return lazyLoadedFiles.has(filePath);
	}

	function isFileLoading(filePath: string): boolean {
		return lazyLoadingFiles.has(filePath);
	}
</script>

<div class="flex flex-col gap-4" data-testid="code-diff-viewer">
	{#if mutationError}
		<div class="bg-destructive/10 text-destructive p-3 rounded-lg text-sm" data-testid="diff-mutation-error" role="alert">
			{mutationError}
		</div>
	{/if}

	{#if diffError}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg" data-testid="diff-error" role="alert">
			Failed to load diff: {diffError}
		</div>
	{:else if diffLoading}
		<div class="flex justify-center items-center py-8">
			<p class="text-muted-foreground text-sm">Loading diff...</p>
		</div>
	{:else if diff}
		{#if diff.files.length === 0}
			<div class="border rounded-lg p-8 text-center text-muted-foreground">
				<p>No file changes between these commits</p>
			</div>
		{:else}
			<!-- AC: @review-code-diff-viewer ac-1 — File list sidebar with stats -->
			<DiffFileList
				files={diff.files.map(f => ({
					oldPath: f.oldPath,
					newPath: f.newPath,
					status: f.status,
					stats: f.stats,
				}))}
				{selectedFile}
				onSelectFile={selectFile}
			/>

			<!-- Per-file diff views -->
			<div class="flex flex-col gap-3" data-testid="diff-files-container">
				{#each diff.files as file (getFilePath(file))}
					{@const filePath = getFilePath(file)}
					{@const effectiveFile = getFileData(filePath) ?? file}
					{@const expanded = expandedFiles.has(filePath)}
					{@const fileHasHunks = useLazyLoading ? isFileLoaded(filePath) : true}

					<DiffFileView
						file={fileHasHunks ? effectiveFile : { ...file, hunks: [] }}
						threads={codeThreads}
						{headCommit}
						{isInteractive}
						{classifier}
						{expanded}
						onToggleExpand={() => toggleFile(filePath)}
						onAddComment={handleAddComment}
						onReply={handleReply}
						onResolve={(id) => resolveMutation.mutate(id)}
						onReopen={(id) => reopenMutation.mutate(id)}
						onExpandContext={handleExpandContext}
						loading={isFileLoading(filePath)}
					/>
				{/each}
			</div>
		{/if}
	{/if}
</div>
