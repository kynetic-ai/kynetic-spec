<!--
  AC: @ui-task-board ac-4 — Active Fleet row showing running agent work.
  Shows task title, agent name, elapsed time with pulse indicator,
  and last few lines of buffered output.
-->
<script lang="ts">
	import type { AgentDispatchStatus } from '$lib/api';
	import { Badge } from '$lib/components/ui/badge';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import { formatElapsed } from './board-utils';
	import Bot from 'lucide-svelte/icons/bot';
	import Activity from 'lucide-svelte/icons/activity';
	import Terminal from 'lucide-svelte/icons/terminal';

	let {
		status,
		outputLines = {}
	}: {
		status: AgentDispatchStatus | null;
		outputLines?: Record<string, string[]>;
	} = $props();

	let activeInvocations = $derived(status?.active_invocations ?? []);
	let isVisible = $derived(status?.dispatch_enabled && activeInvocations.length > 0);

	// AC: @ui-task-board ac-4 — Resolve agent name from agent_definitions
	let agentNameMap = $derived(
		Object.fromEntries(
			(status?.agent_definitions ?? []).map((a) => [a.id, a.name])
		)
	);
</script>

{#if isVisible}
	<div class="mb-4" data-testid="active-fleet-row">
		<div class="flex items-center gap-2 mb-2">
			<Activity class="size-4 text-status-in-progress" />
			<h3 class="text-sm font-medium">Active Fleet</h3>
			<Badge variant="secondary" class="text-[10px]">{activeInvocations.length} running</Badge>
		</div>
		<div class="flex gap-3 overflow-x-auto pb-2">
			{#each activeInvocations as invocation (invocation.session_id)}
				{@const lines = outputLines[invocation.session_id] ?? []}
				{@const title = invocation.task_title ?? undefined}
				{@const agentName = agentNameMap[invocation.agent_id] ?? invocation.agent_id}
				<div
					class="flex-shrink-0 w-72 rounded-lg border bg-card p-3 ds-breathe"
					data-testid="fleet-card"
				>
					<div class="flex items-center gap-2 mb-1.5">
						<Bot class="size-4 text-muted-foreground" />
						<span class="text-xs font-medium truncate" data-testid="fleet-agent-name">{agentName}</span>
					</div>

					{#if invocation.task_ref}
						<div class="truncate mb-1" data-testid="fleet-task-title">
							<ReferenceLink ref={invocation.task_ref} type="task" title={title} class="text-xs" />
						</div>
					{/if}

					<div class="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1.5">
						<!-- Pulse indicator -->
						<span class="relative flex size-2">
							<span
								class="absolute inline-flex h-full w-full rounded-full bg-status-in-progress opacity-75 ds-breathe"
							></span>
							<span class="relative inline-flex size-2 rounded-full bg-status-in-progress"></span>
						</span>
						<span>{formatElapsed(invocation.elapsed_ms)}</span>
					</div>

					<!-- AC: @ui-task-board ac-4 — Last few lines of buffered output -->
					{#if lines.length > 0}
						<div
							class="mt-1.5 rounded bg-muted/50 p-1.5 font-mono text-[10px] leading-tight text-muted-foreground overflow-hidden max-h-14"
							aria-live="polite"
							aria-label="Agent output for {title ?? agentName}"
							data-testid="fleet-output"
						>
							{#each lines as line}
								<div class="truncate">{line}</div>
							{/each}
						</div>
					{:else}
						<div
							class="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground/50"
							aria-live="polite"
							aria-label="Agent output for {title ?? agentName}"
							data-testid="fleet-output-empty"
						>
							<Terminal class="size-3" />
							<span>Awaiting output...</span>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
{/if}
