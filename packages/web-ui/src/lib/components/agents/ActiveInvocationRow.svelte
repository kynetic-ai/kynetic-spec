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

	// AC: @runner-operator-surfaces ac-web-ui-invocation-rows-show-resolved-adapter
	// Build a row-level accessible label that combines the agent, runner
	// identity (when present), and resolved adapter identity so assistive
	// technology gets the full harness identity instead of only what the
	// visible badge text expresses. The label is also defended against
	// future changes that might collapse the visible adapter badge text.
	let accessibleLabel = $derived(buildAccessibleLabel(invocation));

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

	function buildAccessibleLabel(inv: ActiveInvocation): string {
		const parts: string[] = [`Active invocation for ${inv.agent_id}`];
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

<!-- AC: @ui-agent-dispatch ac-2 -->
<!-- AC: @runner-operator-surfaces ac-web-ui-active-invocations-include-runner -->
<!-- AC: @runner-operator-surfaces ac-web-ui-invocation-rows-show-resolved-adapter -->
<div
	class="flex items-center justify-between rounded-md border px-3 py-2 ds-breathe"
	data-testid="active-invocation-row"
	aria-label={accessibleLabel}
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
			>
				runner: {invocation.runner}
			</Badge>
		{/if}

		{#if invocation.resolved_adapter}
			<!-- AC: @runner-operator-surfaces ac-web-ui-invocation-rows-show-resolved-adapter -->
			<!-- Resolved adapter is rendered as visible text (not only a title
				 attribute) so assistive technology can read it and so legacy
				 adapter-only rows still surface the resolved harness identity
				 when the daemon payload provides it. -->
			<Badge
				variant="outline"
				class="text-xs shrink-0 text-muted-foreground"
				data-testid="invocation-resolved-adapter"
			>
				adapter: {invocation.resolved_adapter}
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
