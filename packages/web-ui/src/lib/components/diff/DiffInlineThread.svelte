<!--
  AC: @review-code-diff-viewer ac-5 — Comment threads shown inline at their anchored position in the diff
-->
<script lang="ts">
	import type { ReviewThread } from '@kynetic-ai/shared';
	import { Badge } from '$lib/components/ui/badge';
	import { ActorDisplay } from '$lib/components/ds';
	import type { ActorClassifier } from '$lib/utils/actor';
	import { renderMarkdown } from '$lib/utils/markdown';

	interface Props {
		thread: ReviewThread;
		isInteractive: boolean;
		onReply: (threadId: string, body: string) => void;
		onResolve: (threadId: string) => void;
		onReopen: (threadId: string) => void;
		/**
		 * Shared actor classifier (identity payload) so thread authors render
		 * through the same actor primitive — and therefore identically — as every
		 * other actor on the review surface. Omitted in static mode, where
		 * ActorDisplay degrades to the unknown treatment.
		 */
		classifier?: ActorClassifier;
	}

	let { thread, isInteractive, onReply, onResolve, onReopen, classifier }: Props = $props();

	let showReplyForm = $state(false);
	let replyBody = $state('');
	let userCollapsed = $state<boolean | null>(null);
	let collapsed = $derived(userCollapsed ?? !!thread.resolved_at);

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

	function handleReply() {
		if (!replyBody.trim()) return;
		onReply(thread._ulid, replyBody.trim());
		replyBody = '';
		showReplyForm = false;
	}
</script>

<div
	class="mx-8 my-1 border rounded-lg overflow-hidden bg-background shadow-sm {thread.resolved_at ? 'opacity-70' : ''}"
	data-testid="diff-inline-thread"
	data-thread-id={thread._ulid}
	data-thread-kind={thread.kind}
>
	<!-- Thread header -->
	<button
		type="button"
		class="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/30 border-b text-left"
		onclick={() => { userCollapsed = !collapsed; }}
	>
		<svg
			class="h-3 w-3 transition-transform {collapsed ? '' : 'rotate-90'}"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
		>
			<path d="M9 18l6-6-6-6"/>
		</svg>
		<Badge class={getKindColor(thread.kind)}>
			{formatKind(thread.kind)}
		</Badge>
		<span class="text-xs text-muted-foreground flex-1 inline-flex items-center gap-1">
			{#if thread.entries[0]}
				<ActorDisplay actor={thread.entries[0].author} {classifier} class="text-xs" />
			{:else}
				anonymous
			{/if}
			&middot; {thread.entries.length} {thread.entries.length === 1 ? 'comment' : 'comments'}
		</span>
		{#if thread.resolved_at}
			<span class="text-xs text-emerald-600 dark:text-emerald-400">Resolved</span>
		{:else}
			<span class="text-xs text-amber-600 dark:text-amber-400">Open</span>
		{/if}
	</button>

	{#if !collapsed}
		<!-- Thread entries -->
		<div class="divide-y">
			{#each thread.entries as entry (entry._ulid)}
				<div class="px-3 py-2" data-testid="diff-thread-entry">
					<div class="flex items-center gap-2 mb-1">
						<ActorDisplay
							actor={entry.author}
							{classifier}
							class="text-xs"
							testid="diff-thread-entry-author"
						/>
						<span class="text-xs text-muted-foreground" title={entry.created_at}>
							{formatRelativeTime(entry.created_at)}
						</span>
					</div>
					<div class="prose prose-sm dark:prose-invert max-w-none text-sm">
						{@html renderMarkdown(entry.body)}
					</div>
				</div>
			{/each}
		</div>

		<!-- Actions -->
		{#if isInteractive}
			<div class="border-t px-3 py-1.5 flex items-center gap-2">
				{#if showReplyForm}
					<div class="flex-1 flex flex-col gap-2" data-testid="diff-thread-reply-form">
						<textarea
							class="w-full rounded-md border bg-background px-2 py-1.5 text-sm min-h-[50px] resize-y"
							placeholder="Write your reply..."
							bind:value={replyBody}
						></textarea>
						<div class="flex items-center gap-2">
							<button
								type="button"
								class="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
								disabled={!replyBody.trim()}
								onclick={handleReply}
							>
								Reply
							</button>
							<button
								type="button"
								class="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors"
								onclick={() => { showReplyForm = false; replyBody = ''; }}
							>
								Cancel
							</button>
						</div>
					</div>
				{:else}
					<button
						type="button"
						class="text-xs text-muted-foreground hover:text-foreground transition-colors"
						onclick={() => { showReplyForm = true; }}
					>
						Reply
					</button>
					{#if thread.kind === 'blocker' || thread.kind === 'question'}
						{#if thread.resolved_at}
							<button
								type="button"
								class="text-xs text-muted-foreground hover:text-foreground transition-colors"
								onclick={() => onReopen(thread._ulid)}
							>
								Reopen
							</button>
						{:else}
							<button
								type="button"
								class="text-xs text-muted-foreground hover:text-foreground transition-colors"
								onclick={() => onResolve(thread._ulid)}
							>
								Resolve
							</button>
						{/if}
					{/if}
				{/if}
			</div>
		{/if}
	{/if}
</div>
