<!--
  AC: @ui-automation-view ac-1 — Shows hooks with enabled/disabled state
  AC: @ui-automation-view ac-3 — N/A for hooks: no PATCH /api/hooks endpoint exists yet;
    hooks are read-only config from kynetic.meta.yaml. Inline editing requires backend support.
-->
<script lang="ts">
	import type { HookSummary } from '$lib/api';
	import { Badge } from '$lib/components/ui/badge';
	import { Card } from '$lib/components/ui/card';
	import Webhook from '@lucide/svelte/icons/webhook';

	interface Props {
		hooks: HookSummary[];
	}

	let { hooks }: Props = $props();
</script>

<section data-testid="hooks-section">
	<h2 class="text-lg font-semibold mb-3">
		Hooks
		{#if hooks.length > 0}
			<span class="text-sm font-normal text-muted-foreground">({hooks.length})</span>
		{/if}
	</h2>

	{#if hooks.length === 0}
		<div
			class="flex flex-col items-center justify-center py-8 text-center border rounded-lg"
			data-testid="hooks-empty-state"
		>
			<Webhook class="h-10 w-10 text-muted-foreground mb-3" />
			<h3 class="text-sm font-medium mb-1">No hooks configured</h3>
			<p class="text-xs text-muted-foreground max-w-sm">
				Hooks react to events and execute actions. Configure them in kynetic.meta.yaml.
			</p>
		</div>
	{:else}
		<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
			{#each hooks as hook (hook.id)}
				<Card class="p-4 flex flex-col gap-2" data-testid="hook-card-{hook.id}">
					<div class="flex items-start justify-between gap-2">
						<div class="flex items-center gap-2 min-w-0">
							<Webhook class="h-4 w-4 shrink-0 text-muted-foreground" />
							<h3 class="font-medium text-sm truncate">{hook.name}</h3>
						</div>
						<Badge
							variant={hook.enabled ? 'default' : 'outline'}
							class="text-xs shrink-0"
							data-testid="hook-enabled-badge"
						>
							{hook.enabled ? 'Enabled' : 'Disabled'}
						</Badge>
					</div>

					<div class="flex flex-wrap gap-1.5">
						<Badge variant="secondary" class="text-xs">on: {hook.on}</Badge>
						<Badge variant="outline" class="text-xs">action: {hook.action_type}</Badge>
					</div>

					{#if hook.filter}
						<div class="text-xs text-muted-foreground mt-1">
							<span class="font-medium">Filter:</span>
							<code class="ml-1 bg-muted px-1 py-0.5 rounded">{JSON.stringify(hook.filter)}</code>
						</div>
					{/if}
				</Card>
			{/each}
		</div>
	{/if}
</section>
