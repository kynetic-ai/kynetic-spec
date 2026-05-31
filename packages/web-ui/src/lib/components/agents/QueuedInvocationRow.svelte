<script lang="ts">
	// AC: @runner-operator-surfaces ac-web-ui-queued-invocations-include-runner
	import type { QueuedInvocation } from '$lib/api';
	import { Badge } from '$lib/components/ui/badge';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import Hourglass from 'lucide-svelte/icons/hourglass';

	interface Props {
		invocation: QueuedInvocation;
		taskTitle?: string | null;
	}

	let { invocation, taskTitle = null }: Props = $props();

	let waitFormatted = $derived(formatWait(invocation.wait_ms));

	function formatWait(ms: number): string {
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

<!-- AC: @runner-operator-surfaces ac-web-ui-queued-invocations-include-runner -->
<div
	class="flex items-center justify-between rounded-md border px-3 py-2"
	data-testid="queued-invocation-row"
>
	<div class="flex items-center gap-3 min-w-0">
		<Badge variant="secondary" class="shrink-0">
			{invocation.agent_id}
		</Badge>

		{#if invocation.runner}
			<Badge
				variant="outline"
				class="text-xs shrink-0"
				data-testid="queued-invocation-runner"
				title={invocation.resolved_adapter
					? `Adapter: ${invocation.resolved_adapter}`
					: undefined}
			>
				runner: {invocation.runner}
			</Badge>
		{/if}

		{#if invocation.task_ref}
			<span data-testid="queued-invocation-task-ref">
				<ReferenceLink ref={invocation.task_ref} type="task" title={taskTitle} class="text-sm" />
			</span>
		{:else}
			<span class="text-sm text-muted-foreground italic">No task</span>
		{/if}
	</div>

	<div class="flex items-center gap-3 shrink-0">
		<span
			class="flex items-center gap-1 text-xs text-muted-foreground"
			data-testid="queued-invocation-wait"
		>
			<Hourglass class="h-3 w-3" />
			{waitFormatted}
		</span>
	</div>
</div>
