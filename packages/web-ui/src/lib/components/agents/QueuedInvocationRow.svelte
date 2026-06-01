<script lang="ts">
	// AC: @runner-operator-surfaces ac-web-ui-queued-invocations-include-runner
	// AC: @runner-operator-surfaces ac-web-ui-invocation-rows-show-resolved-adapter
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

	// AC: @runner-operator-surfaces ac-web-ui-invocation-rows-show-resolved-adapter
	// Provide a row-level accessible label that combines agent, runner
	// identity (when present), and resolved adapter identity so screen
	// readers receive the full dispatch harness identity rather than only
	// the visible badge text.
	let accessibleLabel = $derived(buildAccessibleLabel(invocation));

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

	function buildAccessibleLabel(inv: QueuedInvocation): string {
		const parts: string[] = [`Queued invocation for ${inv.agent_id}`];
		if (inv.runner) {
			parts.push(`runner ${inv.runner}`);
		}
		if (inv.resolved_adapter) {
			parts.push(`adapter ${inv.resolved_adapter}`);
		}
		if (inv.task_ref) {
			parts.push(`task ${inv.task_ref}`);
		}
		return parts.join(', ');
	}
</script>

<!-- AC: @runner-operator-surfaces ac-web-ui-queued-invocations-include-runner -->
<!-- AC: @runner-operator-surfaces ac-web-ui-invocation-rows-show-resolved-adapter -->
<div
	class="flex items-center justify-between rounded-md border px-3 py-2"
	data-testid="queued-invocation-row"
	aria-label={accessibleLabel}
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
			>
				runner: {invocation.runner}
			</Badge>
		{/if}

		{#if invocation.resolved_adapter}
			<!-- AC: @runner-operator-surfaces ac-web-ui-invocation-rows-show-resolved-adapter -->
			<!-- Resolved adapter rendered as visible text (not only a title
				 attribute) so assistive technology can read it and legacy
				 adapter-only rows still surface the resolved harness identity. -->
			<Badge
				variant="outline"
				class="text-xs shrink-0 text-muted-foreground"
				data-testid="queued-invocation-resolved-adapter"
			>
				adapter: {invocation.resolved_adapter}
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
