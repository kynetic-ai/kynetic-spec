<!--
  AC: @review-code-diff-viewer ac-1 — File list with diff stats (+/- lines), expandable to show diff content
  AC: @review-code-diff-viewer ac-6 — File headers and stats shown immediately for lazy loading
-->
<script lang="ts">
	import type { DiffFile } from '$lib/api';
	import { getFilePath } from '$lib/utils/diff';
	import { resolveStatusToken, statusTextClass } from '$lib/ds/status-tokens';

	interface Props {
		files: Array<{ oldPath: string; newPath: string; status: DiffFile['status']; stats: DiffFile['stats'] }>;
		selectedFile: string | null;
		onSelectFile: (path: string) => void;
	}

	let { files, selectedFile, onSelectFile }: Props = $props();

	function getStatusIcon(status: DiffFile['status']): string {
		return resolveStatusToken('diff', status).glyph;
	}

	function getStatusColor(status: DiffFile['status']): string {
		return statusTextClass(resolveStatusToken('diff', status).family);
	}

	function getDisplayPath(file: { oldPath: string; newPath: string; status: DiffFile['status'] }): string {
		if (file.status === 'renamed' && file.oldPath !== file.newPath) {
			return `${file.oldPath} → ${file.newPath}`;
		}
		return getFilePath(file);
	}

	let totalAdditions = $derived(files.reduce((sum, f) => sum + f.stats.additions, 0));
	let totalDeletions = $derived(files.reduce((sum, f) => sum + f.stats.deletions, 0));
</script>

<div class="border rounded-lg overflow-hidden" data-testid="diff-file-list">
	<!-- Summary header -->
	<div class="px-4 py-2 bg-muted/30 border-b flex items-center gap-3 text-sm">
		<span class="font-medium" data-testid="diff-file-count">
			{files.length} file{files.length === 1 ? '' : 's'} changed
		</span>
		<span class="text-emerald-600 dark:text-emerald-400" data-testid="diff-total-additions">
			+{totalAdditions}
		</span>
		<span class="text-red-600 dark:text-red-400" data-testid="diff-total-deletions">
			-{totalDeletions}
		</span>
	</div>

	<!-- File entries -->
	<div class="divide-y max-h-[400px] overflow-y-auto">
		{#each files as file (getFilePath(file))}
			{@const filePath = getFilePath(file)}
			<button
				type="button"
				class="w-full text-left px-4 py-2 hover:bg-muted/50 transition-colors flex items-center gap-2 text-sm {selectedFile === filePath ? 'bg-muted/70' : ''}"
				data-testid="diff-file-entry"
				data-file-path={filePath}
				onclick={() => onSelectFile(filePath)}
			>
				<span class="font-mono font-bold text-xs w-4 text-center {getStatusColor(file.status)}" data-testid="diff-file-status">
					{getStatusIcon(file.status)}
				</span>
				<span class="font-mono text-xs truncate flex-1" title={getDisplayPath(file)}>
					{getDisplayPath(file)}
				</span>
				<span class="flex items-center gap-1 text-xs flex-shrink-0">
					{#if file.stats.additions > 0}
						<span class="text-emerald-600 dark:text-emerald-400">+{file.stats.additions}</span>
					{/if}
					{#if file.stats.deletions > 0}
						<span class="text-red-600 dark:text-red-400">-{file.stats.deletions}</span>
					{/if}
				</span>
			</button>
		{/each}
	</div>
</div>
