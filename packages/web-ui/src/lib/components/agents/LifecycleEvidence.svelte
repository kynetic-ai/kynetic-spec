<script lang="ts">
	import type { AgentDispatchStatus } from '$lib/api';
	import { getLifecycleBadge } from '$lib/dispatch-lifecycle';
	import { Badge } from '$lib/components/ui/badge';

	let { status }: { status: AgentDispatchStatus } = $props();
</script>

<div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/20 px-3 py-2 text-xs" data-testid="dispatch-lifecycle-evidence">
	<Badge variant="outline">{getLifecycleBadge(status)}</Badge>
	<span>Authority: {status.globalAuthority}</span>
	<span>Projection: {status.projection === 'legacy_unknown_stopping' ? 'Legacy unknown/stopping' : status.projection}</span>
	<span>{status.activeCount} active</span>
	<span>{status.queueDepth} queued</span>
	<span>{status.heldCount} held</span>
	{#if status.cleanupState.status !== 'idle'}
		<span>Cleanup: {status.cleanupState.status}</span>
	{/if}
	{#if status.degraded.active || status.degradedTargets.length > 0}
		<span class="text-destructive">Degraded: {status.degraded.reason || status.degradedTargets[0]?.reason}</span>
	{/if}
</div>
