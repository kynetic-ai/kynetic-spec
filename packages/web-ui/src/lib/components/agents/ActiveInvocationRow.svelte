<script lang="ts">
	// AC: @ui-agent-dispatch ac-2 — Active invocation showing task ref, elapsed time, session stream link
	import { base } from '$app/paths';
	import type { ActiveInvocation } from '$lib/api';
	import { Badge } from '$lib/components/ui/badge';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import ExternalLink from 'lucide-svelte/icons/external-link';
	import Clock from 'lucide-svelte/icons/clock';

	interface Props {
		invocation: ActiveInvocation;
		taskTitle?: string | null;
	}

	let { invocation, taskTitle = null }: Props = $props();

	let elapsedFormatted = $derived(formatElapsed(invocation.elapsed_ms));

	function formatElapsed(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		return `${hours}h ${remainingMinutes}m`;
	}
</script>

<!-- AC: @ui-agent-dispatch ac-2 -->
<!-- AC: @runner-operator-surfaces ac-web-ui-active-invocations-include-runner -->
<div
	class="flex items-center justify-between rounded-md border px-3 py-2 ds-breathe"
	data-testid="active-invocation-row"
>
	<div class="flex items-center gap-3 min-w-0">
		<Badge class="bg-status-in-progress text-status-in-progress-fg shrink-0">
			{invocation.agent_id}
		</Badge>

		{#if invocation.runner}
			<!-- AC: @runner-operator-surfaces ac-web-ui-active-invocations-include-runner -->
			<Badge
				variant="outline"
				class="text-xs shrink-0"
				data-testid="invocation-runner"
				title={invocation.resolved_adapter
					? `Adapter: ${invocation.resolved_adapter}`
					: undefined}
			>
				runner: {invocation.runner}
			</Badge>
		{/if}

		{#if invocation.task_ref}
			<span data-testid="invocation-task-ref">
				<ReferenceLink ref={invocation.task_ref} type="task" title={taskTitle} class="text-sm" />
			</span>
		{:else}
			<span class="text-sm text-muted-foreground italic">No task</span>
		{/if}
	</div>

	<div class="flex items-center gap-3 shrink-0">
		<span class="flex items-center gap-1 text-xs text-muted-foreground" data-testid="invocation-elapsed">
			<Clock class="h-3 w-3" />
			{elapsedFormatted}
		</span>

		<a
			href="{base}/sessions/{invocation.session_id}"
			class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
			data-testid="invocation-session-link"
		>
			Stream
			<ExternalLink class="h-3 w-3" />
		</a>
	</div>
</div>
