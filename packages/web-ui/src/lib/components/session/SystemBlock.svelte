<!--
  AC: @ui-session-stream ac-1 — System events (session start/end, iterations, agent lifecycle).
-->
<script lang="ts">
	import type { SystemBlock as SystemBlockType } from './session-utils';
	import { formatTime } from './session-utils';

	const { block }: { block: SystemBlockType } = $props();
</script>

<div class="flex items-center gap-2 py-1.5" data-testid="system-block">
	<div class="flex-1 h-px bg-border"></div>
	<div class="flex items-center gap-2 px-2 py-0.5 text-[10px] text-muted-foreground/70 font-mono">
		<span>{formatTime(block.timestamp)}</span>
		<span class="font-medium">{block.label}</span>
		{#if block.detail}
			<span class="text-muted-foreground/50">{block.detail}</span>
		{/if}
	</div>
	<div class="flex-1 h-px bg-border"></div>
</div>
