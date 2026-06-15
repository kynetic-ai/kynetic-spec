<!--
  AC: @ui-session-stream ac-4 — Session context panel with metadata, spec context with AC checklist,
  files changed during session, and budget info.
-->
<script lang="ts">
	import type { SessionDetail } from '$lib/api';
	import type { DisplayBlock } from './session-utils';
	import { extractFilesChanged, formatElapsed, formatTimeline, getTriggerLabel, isDispatchedSession } from './session-utils';
	import { StatusBadge } from '$lib/components/ds';
	import { Separator } from '$lib/components/ui/separator';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import Clock from 'lucide-svelte/icons/clock';
	import Bot from 'lucide-svelte/icons/bot';
	import FileText from 'lucide-svelte/icons/file-text';
	import Activity from 'lucide-svelte/icons/activity';
	import CheckCircle from 'lucide-svelte/icons/check-circle';
	import Wallet from 'lucide-svelte/icons/wallet';
	import FolderOpen from 'lucide-svelte/icons/folder-open';
	import Zap from 'lucide-svelte/icons/zap';
	import Terminal from 'lucide-svelte/icons/terminal';

	let {
		session,
		blocks = [],
		taskTitle = null,
	}: {
		session: SessionDetail;
		blocks?: DisplayBlock[];
		taskTitle?: string | null;
	} = $props();

	let triggerLabel = $derived(getTriggerLabel(session.trigger));

	// AC: @ui-session-stream ac-4 — Files changed during session
	let filesChanged = $derived(extractFilesChanged(blocks));

	// Shorten file paths for display — show last 2 segments
	function shortenPath(filePath: string): string {
		const parts = filePath.split('/');
		return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : filePath;
	}
</script>

<div class="w-72 border-r bg-card/50 overflow-y-auto flex-shrink-0" data-testid="session-context-panel">
	<div class="p-4 space-y-4">
		<!-- Session metadata -->
		<div>
			<h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Session</h3>

			<div class="space-y-2">
				<div class="flex items-center justify-between">
					<!-- AC: @ui-view-header ac-2 — session state drawn from the shared status-token source -->
					<StatusBadge domain="session" state={session.status} testid="session-context-status-badge" />
					<span class="text-[10px] font-mono text-muted-foreground">
						{session.id.slice(0, 8)}
					</span>
				</div>

				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<Bot class="size-3.5" />
					<span>{session.agent_type}</span>
					{#if session.agent_id && session.agent_id !== session.agent_type}
						<span class="text-muted-foreground/50">({session.agent_id})</span>
					{/if}
				</div>

				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<Clock class="size-3.5" />
					<span>{formatElapsed(session.duration_ms)}</span>
					{#if session.status === 'active'}
						<span class="ds-session-active-dot size-1.5 rounded-full bg-status-completed inline-block"></span>
					{/if}
				</div>

				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					{#if isDispatchedSession(session.trigger)}
						<Zap class="size-3.5 text-status-in-progress" />
					{:else}
						<Terminal class="size-3.5" />
					{/if}
					<span>{triggerLabel}</span>
				</div>

				{#if session.task_id}
					<div class="flex items-center gap-2 text-xs">
						<FileText class="size-3.5 text-muted-foreground" />
						<ReferenceLink ref={session.task_id} type="task" title={taskTitle} class="text-xs" />
					</div>
				{/if}
			</div>
		</div>

		<Separator />

		<!-- AC: @ui-session-stream ac-4 — Spec context with AC checklist -->
		{#if session.spec_context}
			<div data-testid="spec-context-section">
				<h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Spec Context</h3>

				<div class="space-y-2">
					<div class="text-xs">
						<ReferenceLink ref={session.spec_context.spec_ref} type="spec" title={session.spec_context.title} class="text-xs" />
					</div>

					{#if session.spec_context.acceptance_criteria.length > 0}
						<div class="space-y-1" data-testid="ac-checklist">
							{#each session.spec_context.acceptance_criteria as ac (ac.id)}
								<div class="flex items-start gap-1.5 text-[10px]">
									<CheckCircle class="size-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
									<span class="text-muted-foreground">
										<span class="font-mono font-medium">{ac.id}</span>
										{#if ac.description}
											— {ac.description.length > 60 ? ac.description.slice(0, 60) + '\u2026' : ac.description}
										{/if}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</div>

			<Separator />
		{/if}

		<!-- Stats -->
		<div>
			<h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Stats</h3>

			<div class="grid grid-cols-2 gap-2">
				<div class="bg-secondary/50 rounded-md px-2.5 py-1.5">
					<p class="text-[10px] text-muted-foreground">Events</p>
					<p class="text-sm font-medium">{session.event_count}</p>
				</div>
				<div class="bg-secondary/50 rounded-md px-2.5 py-1.5">
					<p class="text-[10px] text-muted-foreground">Iterations</p>
					<p class="text-sm font-medium">{session.iteration_count}</p>
				</div>
				<div class="bg-secondary/50 rounded-md px-2.5 py-1.5">
					<p class="text-[10px] text-muted-foreground">Tasks Done</p>
					<p class="text-sm font-medium">{session.tasks_completed}</p>
				</div>
				<div class="bg-secondary/50 rounded-md px-2.5 py-1.5">
					<p class="text-[10px] text-muted-foreground">Origin</p>
					<p class="text-sm font-medium">{isDispatchedSession(session.trigger) ? 'Dispatched' : 'Manual'}</p>
				</div>
			</div>
		</div>

		<Separator />

		<!-- AC: @ui-session-stream ac-4 — Budget info -->
		{#if session.budget}
			<div data-testid="budget-section">
				<h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
					<span class="inline-flex items-center gap-1.5">
						<Wallet class="size-3" />
						Budget
					</span>
				</h3>

				<div class="space-y-1 text-xs text-muted-foreground">
					<div class="flex justify-between">
						<span>Tasks started</span>
						<span class="font-mono">{session.budget.started_this_cycle} / {session.budget.max_per_cycle}</span>
					</div>
					<div class="w-full bg-secondary rounded-full h-1.5">
						<div
							class="bg-primary rounded-full h-1.5 transition-all"
							style="width: {Math.min(100, (session.budget.started_this_cycle / session.budget.max_per_cycle) * 100)}%"
						></div>
					</div>
				</div>
			</div>

			<Separator />
		{/if}

		<!-- AC: @ui-session-stream ac-4 — Files changed during session -->
		{#if filesChanged.length > 0}
			<div data-testid="files-changed-section">
				<h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
					<span class="inline-flex items-center gap-1.5">
						<FolderOpen class="size-3" />
						Files Changed ({filesChanged.length})
					</span>
				</h3>

				<div class="space-y-0.5 max-h-40 overflow-y-auto">
					{#each filesChanged as filePath}
						<div class="text-[10px] font-mono text-muted-foreground truncate" title={filePath}>
							{shortenPath(filePath)}
						</div>
					{/each}
				</div>
			</div>

			<Separator />
		{/if}

		<!-- Timeline -->
		<div>
			<h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Timeline</h3>

			<div class="space-y-1 text-xs text-muted-foreground">
				<div class="flex justify-between">
					<span>Started</span>
					<span class="font-mono" title={session.started_at}>{formatTimeline(session.started_at)}</span>
				</div>
				{#if session.ended_at}
					<div class="flex justify-between">
						<span>Ended</span>
						<span class="font-mono" title={session.ended_at}>{formatTimeline(session.ended_at)}</span>
					</div>
				{/if}
				<div class="flex justify-between">
					<span>Duration</span>
					<span class="font-mono">{formatElapsed(session.duration_ms)}</span>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	@keyframes session-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}
	:global(.ds-session-active-dot) {
		animation: session-pulse 2s ease-in-out infinite;
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.ds-session-active-dot) {
			animation: none;
		}
	}
</style>
