<script lang="ts">
	// AC: @ui-agent-dispatch ac-2, ac-3 — Dispatch status with start/stop control
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import Play from 'lucide-svelte/icons/play';
	import Square from 'lucide-svelte/icons/square';
	import Loader2 from 'lucide-svelte/icons/loader-2';

	interface Props {
		enabled: boolean;
		activeCount: number;
		queueDepth: number;
		onStart: () => void;
		onStop: () => void;
		isToggling: boolean;
	}

	let { enabled, activeCount, queueDepth, onStart, onStop, isToggling }: Props = $props();
</script>

<!-- AC: @ui-agent-dispatch ac-2, ac-3 -->
<div
	class="flex items-center justify-between rounded-lg border p-4"
	data-testid="dispatch-status"
>
	<div class="flex items-center gap-3">
		<div class="flex items-center gap-2">
			{#if enabled}
				<!-- AC: @ui-agent-dispatch ac-2 — Running state -->
				<span class="relative flex h-3 w-3" data-testid="dispatch-indicator-running">
					<span class="absolute inline-flex h-full w-full animate-ping motion-reduce:animate-none rounded-full bg-status-completed opacity-75"></span>
					<span class="relative inline-flex h-3 w-3 rounded-full bg-status-completed"></span>
				</span>
				<Badge class="bg-status-completed text-status-completed-fg" data-testid="dispatch-status-badge">
					Running
				</Badge>
			{:else}
				<!-- AC: @ui-agent-dispatch ac-3 — Stopped state -->
				<span class="inline-flex h-3 w-3 rounded-full bg-status-cancelled" data-testid="dispatch-indicator-stopped"></span>
				<Badge variant="secondary" data-testid="dispatch-status-badge">
					Stopped
				</Badge>
			{/if}
		</div>

		{#if enabled}
			<span class="text-sm text-muted-foreground" data-testid="dispatch-counts">
				{activeCount} active{#if queueDepth > 0}, {queueDepth} queued{/if}
			</span>
		{/if}
	</div>

	<div>
		{#if isStaticMode()}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							size="sm"
							variant="outline"
							disabled
							data-testid="dispatch-toggle-button"
						>
							{enabled ? 'Stop' : 'Start'}
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>
					<p>Read-only mode - use CLI to control dispatch</p>
				</Tooltip.Content>
			</Tooltip.Root>
		{:else if enabled}
			<!-- AC: @ui-agent-dispatch ac-2 — Stop button when running -->
			<Button
				size="sm"
				variant="destructive"
				onclick={onStop}
				disabled={isToggling}
				data-testid="dispatch-toggle-button"
			>
				{#if isToggling}
					<Loader2 class="h-4 w-4 animate-spin motion-reduce:animate-none mr-1" />
					Stopping...
				{:else}
					<Square class="h-4 w-4 mr-1" />
					Stop
				{/if}
			</Button>
		{:else}
			<Button
				size="sm"
				onclick={onStart}
				disabled={isToggling}
				data-testid="dispatch-toggle-button"
			>
				{#if isToggling}
					<Loader2 class="h-4 w-4 animate-spin motion-reduce:animate-none mr-1" />
					Starting...
				{:else}
					<Play class="h-4 w-4 mr-1" />
					Start
				{/if}
			</Button>
		{/if}
	</div>
</div>
