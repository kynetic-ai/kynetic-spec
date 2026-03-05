<!--
  AC: @ui-task-board ac-4 — Active Fleet row showing running agent work.
  Shows task title, agent name, elapsed time with pulse indicator,
  and last few lines of output.
-->
<script lang="ts">
	import type { AgentStatus } from '$lib/api';
	import { Badge } from '$lib/components/ui/badge';
	import { formatElapsed } from './board-utils';
	import Bot from '@lucide/svelte/icons/bot';
	import Activity from '@lucide/svelte/icons/activity';

	let { status }: { status: AgentStatus | null } = $props();

	let activeInvocations = $derived(status?.active_invocations ?? []);
	let isVisible = $derived(status?.dispatch_enabled && activeInvocations.length > 0);
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
				<div
					class="flex-shrink-0 w-64 rounded-lg border bg-card p-3 ds-breathe"
					data-testid="fleet-card"
				>
					<div class="flex items-center gap-2 mb-1.5">
						<Bot class="size-4 text-muted-foreground" />
						<span class="text-xs font-medium truncate">{invocation.agent_id}</span>
					</div>

					{#if invocation.task_ref}
						<p class="text-xs text-muted-foreground font-mono truncate mb-1">
							{invocation.task_ref}
						</p>
					{/if}

					<div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
						<!-- Pulse indicator -->
						<span class="relative flex size-2">
							<span
								class="absolute inline-flex h-full w-full rounded-full bg-status-in-progress opacity-75 ds-breathe"
							></span>
							<span class="relative inline-flex size-2 rounded-full bg-status-in-progress"></span>
						</span>
						<span>{formatElapsed(invocation.elapsed_ms)}</span>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}
