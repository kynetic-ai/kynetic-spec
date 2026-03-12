<script lang="ts">
	// AC: @multi-directory-daemon ac-27 - Reload on project change
	import type { Observation } from '@kynetic-ai/shared';
	import { fetchObservations } from '$lib/api';
	import { Card, CardHeader } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { renderMarkdown } from '$lib/utils/markdown';
	import {
		Lightbulb,
		Zap,
		AlertTriangle,
		HelpCircle
	} from 'lucide-svelte';
	import { getProjectVersion, isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';

	// AC: @web-dashboard ac-22
	let observations = $state<Observation[]>([]);
	let loading = $state(true);
	let error = $state('');

	// Type icons mapping
	const typeIcons = {
		friction: AlertTriangle,
		success: Zap,
		question: HelpCircle,
		idea: Lightbulb
	};

	const typeColors = {
		friction: 'text-red-600',
		success: 'text-green-600',
		question: 'text-blue-600',
		idea: 'text-yellow-600'
	};

	const typeLabels = {
		friction: 'Friction',
		success: 'Success',
		question: 'Question',
		idea: 'Idea'
	};

	// Load observations when project is ready and reload on project change.
	// Gates on isProjectInitialized() to prevent loading with wrong/missing project context.
	// AC: @multi-directory-daemon ac-27 - Reload data when project changes
	$effect(() => {
		const version = getProjectVersion();
		const ready = isProjectInitialized();
		if (!ready) return;
		loadObservations();
	});

	async function loadObservations() {
		try {
			loading = true;
			error = '';
			// AC: @web-dashboard ac-22 - Show unresolved observations
			const response = await fetchObservations({ resolved: false });
			observations = response.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load observations';
		} finally {
			loading = false;
		}
	}

	function formatDate(dateString: string): string {
		const date = new Date(dateString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return 'just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;

		return date.toLocaleDateString();
	}
</script>

<!-- AC: @web-dashboard ac-22 - Observations panel with type icons -->
<div class="flex flex-col gap-4" data-testid="observations-panel">
	<div class="flex items-center justify-between">
		<h1 class="text-3xl font-bold">Observations</h1>
		<Badge variant="secondary" data-testid="observations-count">
			{observations.length} unresolved
		</Badge>
	</div>

	{#if error}
		<div class="rounded-md bg-red-50 p-4 text-sm text-red-800" data-testid="error">
			{error}
		</div>
	{/if}

	{#if loading}
		<div class="text-center text-muted-foreground" data-testid="loading">Loading observations...</div>
	{:else if observations.length === 0}
		<div class="text-center text-muted-foreground" data-testid="observations-empty">
			<p>No unresolved observations.</p>
			<p class="text-sm">Observations are captured during work sessions.</p>
		</div>
	{:else}
		<div class="flex flex-col gap-3">
			{#each observations as obs (obs._ulid)}
				<!-- AC: @web-dashboard ac-22 - Show type icons -->
				<Card data-testid="observation-item">
					<CardHeader class="pb-3">
						<div class="flex items-start gap-3">
							<div class={`mt-0.5 ${typeColors[obs.type]}`} data-testid="observation-type-icon">
								<svelte:component this={typeIcons[obs.type]} class="h-5 w-5" />
							</div>
							<div class="flex-1">
								<div class="flex items-center gap-2 mb-2">
									<Badge variant="outline" data-testid="observation-type">{typeLabels[obs.type]}</Badge>
									<span class="text-xs text-muted-foreground">{formatDate(obs.created_at)}</span>
								</div>
								<div
									class="text-sm break-words leading-relaxed prose prose-sm dark:prose-invert max-w-none"
									data-testid="observation-content"
								>
									{@html renderMarkdown(obs.content)}
								</div>
								{#if obs.context}
									<div
										class="mt-2 text-xs text-muted-foreground border-l-2 border-muted pl-3 prose prose-sm dark:prose-invert max-w-none"
										data-testid="observation-context"
									>
										{@html renderMarkdown(obs.context)}
									</div>
								{/if}
							</div>
						</div>
					</CardHeader>
				</Card>
			{/each}
		</div>
	{/if}
</div>
