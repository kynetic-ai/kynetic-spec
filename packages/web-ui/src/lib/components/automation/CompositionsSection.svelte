<!--
  AC: @ui-automation-view ac-6 — Composition group activations with join progress,
  member action runs, and timeout status
-->
<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import {
		fetchCompositionConfigs,
		fetchCompositionActivations,
		type CompositionConfigSummary,
		type CompositionActivation
	} from '$lib/api';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { Badge } from '$lib/components/ui/badge';
	import { Card } from '$lib/components/ui/card';
	import Layers from '@lucide/svelte/icons/layers';

	// AC: @ui-automation-view ac-6 — Fetch composition configs to discover available IDs
	const compositionConfigsQuery = createQuery(() => ({
		queryKey: queryKeys.automation.compositionConfigs(),
		queryFn: () => fetchCompositionConfigs(),
		enabled: isProjectInitialized() && !isStaticMode(),
	}));

	let compositionConfigs = $derived<CompositionConfigSummary[]>(
		compositionConfigsQuery.data?.items ?? []
	);

	// Track activations per config ID
	let activationsByConfig = $state<Record<string, CompositionActivation[]>>({});
	let loadError = $state('');

	// AC: @ui-automation-view ac-6 — Fetch activations for each known config ID
	$effect(() => {
		if (isStaticMode() || !isProjectInitialized()) return;

		for (const config of compositionConfigs) {
			fetchCompositionActivations(config.id)
				.then((result) => {
					activationsByConfig = {
						...activationsByConfig,
						[config.id]: result.activations,
					};
				})
				.catch((err) => {
					loadError = err.message;
				});
		}
	});

	function formatTimeout(ms: number | null): string {
		if (ms === null) return 'No timeout';
		if (ms <= 0) return 'Expired';
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s remaining`;
		const minutes = Math.floor(seconds / 60);
		return `${minutes}m ${seconds % 60}s remaining`;
	}

	function progressPercent(completed: number, total: number): number {
		if (total === 0) return 0;
		return (completed / total) * 100;
	}
</script>

<section data-testid="compositions-section">
	<h2 class="text-lg font-semibold mb-3">
		Composition Groups
		{#if compositionConfigs.length > 0}
			<span class="text-sm font-normal text-muted-foreground">({compositionConfigs.length})</span>
		{/if}
	</h2>

	{#if loadError}
		<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-lg mb-3" role="alert">
			{loadError}
		</div>
	{/if}

	{#if compositionConfigsQuery.isLoading}
		<div class="text-sm text-muted-foreground">Loading compositions...</div>
	{:else if compositionConfigs.length === 0}
		<div
			class="flex flex-col items-center justify-center py-8 text-center border rounded-lg"
			data-testid="compositions-empty-state"
		>
			<Layers class="h-10 w-10 text-muted-foreground mb-3" />
			<h3 class="text-sm font-medium mb-1">No composition groups configured</h3>
			<p class="text-xs text-muted-foreground max-w-sm">
				Composition groups define fan-in join rules for coordinating multiple action runs.
				Configure them in kynetic.meta.yaml under <code class="bg-muted px-1 py-0.5 rounded">compositions</code>.
			</p>
		</div>
	{:else}
		<div class="flex flex-col gap-3">
			{#each compositionConfigs as config (config.id)}
				{@const activations = activationsByConfig[config.id] ?? []}
				<Card class="p-4" data-testid="composition-card-{config.id}">
					<div class="flex items-center justify-between mb-2">
						<div class="flex items-center gap-2">
							<Layers class="h-4 w-4 text-muted-foreground" />
							<h3 class="font-medium text-sm">{config.name}</h3>
							<span class="text-xs text-muted-foreground font-mono">({config.id})</span>
						</div>
						<div class="flex items-center gap-2">
							<Badge variant="secondary" class="text-xs">
								join: {config.join_count}
							</Badge>
							<Badge
								variant={config.enabled ? 'default' : 'outline'}
								class="text-xs"
							>
								{config.enabled ? 'Enabled' : 'Disabled'}
							</Badge>
							<Badge variant="outline" class="text-xs">
								{activations.length} activation{activations.length !== 1 ? 's' : ''}
							</Badge>
						</div>
					</div>

					{#if activations.length === 0}
						<p class="text-xs text-muted-foreground">No active activations</p>
					{:else}
						<div class="flex flex-col gap-2 mt-2">
							{#each activations as activation (activation.activation_id)}
								<div
									class="p-2 border rounded text-xs"
									data-testid="activation-{activation.activation_id}"
								>
									<div class="flex items-center justify-between mb-1">
										<span class="font-mono text-muted-foreground">
											{activation.group_id}
										</span>
										<Badge variant="outline" class="text-xs">
											{formatTimeout(activation.timeout_remaining_ms)}
										</Badge>
									</div>

									<!-- Join progress -->
									<div class="flex items-center gap-2 mb-1">
										<span class="text-muted-foreground">Progress:</span>
										<div class="flex-1 h-2 bg-muted rounded-full overflow-hidden">
											<div
												class="h-full bg-primary rounded-full transition-all"
												style="width: {progressPercent(activation.completed_count, activation.total_members)}%"
											></div>
										</div>
										<span class="font-medium">
											{activation.completed_count}/{activation.total_members}
										</span>
									</div>

									{#if activation.failed_count > 0}
										<div class="text-destructive">
											{activation.failed_count} failed
										</div>
									{/if}

									{#if activation.member_action_run_ids.length > 0}
										<div class="mt-1 text-muted-foreground">
											<span class="font-medium">Runs:</span>
											<span class="font-mono ml-1">
												{activation.member_action_run_ids.join(', ')}
											</span>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</Card>
			{/each}
		</div>
	{/if}
</section>
