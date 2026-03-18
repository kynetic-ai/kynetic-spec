<!--
  AC: @ui-automation-view ac-6 — Composition group activations with join progress,
  member action runs, and timeout status
-->
<script lang="ts">
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import {
		fetchAgentDefinitions,
		fetchCompositionActivations,
		type CompositionActivation
	} from '$lib/api';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { Badge } from '$lib/components/ui/badge';
	import { Card } from '$lib/components/ui/card';
	import Layers from '@lucide/svelte/icons/layers';

	// We need to detect composition configs from meta. The daemon API requires
	// a config_id to query activations. We'll fetch agent definitions which
	// come from meta loading that also includes compositions.
	// For now, we need to discover composition config IDs from the manifest.
	// Since there's no dedicated "list compositions" endpoint, we'll try to
	// fetch from a known set of composition IDs discovered at runtime.

	// Track known composition config IDs (populated by parent or user interaction)
	let compositionConfigIds = $state<string[]>([]);
	let activationsByConfig = $state<Record<string, CompositionActivation[]>>({});
	let loadError = $state('');

	// Attempt to load composition configs from the meta endpoint
	// The schedules/hooks meta includes compositions in the same manifest.
	// We need a list endpoint — for now, show empty state with guidance.

	// AC: @ui-automation-view ac-6 — If composition IDs are known, fetch their activations
	$effect(() => {
		if (isStaticMode() || !isProjectInitialized()) return;

		// Fetch activations for each known config ID
		for (const configId of compositionConfigIds) {
			fetchCompositionActivations(configId)
				.then((result) => {
					activationsByConfig = {
						...activationsByConfig,
						[configId]: result.activations,
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

	let hasActivations = $derived(
		Object.values(activationsByConfig).some((a) => a.length > 0)
	);
</script>

<section data-testid="compositions-section">
	<h2 class="text-lg font-semibold mb-3">Composition Groups</h2>

	{#if loadError}
		<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-lg mb-3" role="alert">
			{loadError}
		</div>
	{/if}

	{#if compositionConfigIds.length === 0}
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
			{#each compositionConfigIds as configId (configId)}
				{@const activations = activationsByConfig[configId] ?? []}
				<Card class="p-4" data-testid="composition-card-{configId}">
					<div class="flex items-center justify-between mb-2">
						<div class="flex items-center gap-2">
							<Layers class="h-4 w-4 text-muted-foreground" />
							<h3 class="font-medium text-sm">{configId}</h3>
						</div>
						<Badge variant="secondary" class="text-xs">
							{activations.length} activation{activations.length !== 1 ? 's' : ''}
						</Badge>
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
												style="width: {(activation.completed_count / activation.total_members) * 100}%"
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
