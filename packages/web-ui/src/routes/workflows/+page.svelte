<!--
  AC: @ui-workflows-view ac-1 — Each workflow shows id, description, ordered steps with names,
  trigger type if configured, and loop variant indicator. A Start button initiates the workflow
  via daemon API.
  AC: @ui-data-freshness ac-1 — Renders from cache on revisit without loading state
  AC: @ui-data-freshness ac-3 — WS events invalidate workflow queries via centralized wiring
-->
<script lang="ts">
	import type { Workflow } from '@kynetic-ai/shared';
	import { createQuery } from '$lib/query/createQuery.svelte.js';
	import { fetchWorkflows } from '$lib/api';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { isInitialized as isProjectInitialized } from '$lib/stores/project.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import WorkflowIcon from 'lucide-svelte/icons/workflow';
	import PlayIcon from 'lucide-svelte/icons/play';
	import ZapIcon from 'lucide-svelte/icons/zap';
	import RepeatIcon from 'lucide-svelte/icons/repeat';
	import CheckCircleIcon from 'lucide-svelte/icons/check-circle';
	import CircleDotIcon from 'lucide-svelte/icons/circle-dot';
	import CircleIcon from 'lucide-svelte/icons/circle';
	import CopyIcon from 'lucide-svelte/icons/copy';
	import { renderMarkdown } from '$lib/utils/markdown';

	// ── Step type classes (using design-system severity tokens) ──
	const STEP_TYPE_CLASS: Record<string, string> = {
		action: 'text-severity-success',
		check: 'text-severity-info',
		decision: 'text-severity-warning'
	};

	// AC: @ui-data-freshness ac-1 — createQuery caches results; revisits render from cache
	// AC: @ui-data-freshness ac-2 — Concurrent uses share the same in-flight request
	const workflowsQuery = createQuery(() => ({
		queryKey: queryKeys.workflows.all,
		queryFn: () => fetchWorkflows(),
		enabled: isProjectInitialized(),
	}));

	let workflows = $derived<Workflow[]>(workflowsQuery.data?.items ?? []);
	let loading = $derived(workflowsQuery.isLoading);
	let error = $derived(workflowsQuery.error?.message ?? '');

	// ── Copy start command ──
	let copiedId = $state<string | null>(null);

	async function copyStartCommand(workflowId: string) {
		const command = `kspec workflow start @${workflowId}`;
		try {
			await navigator.clipboard.writeText(command);
			copiedId = workflowId;
			setTimeout(() => {
				copiedId = null;
			}, 2000);
		} catch {
			// Clipboard API may not be available
		}
	}
</script>

<div class="flex flex-col gap-4 p-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold">Workflows</h1>
			{#if !loading}
				<p class="text-sm text-muted-foreground" data-testid="workflows-summary">
					{workflows.length} workflow{workflows.length === 1 ? '' : 's'} defined
				</p>
			{/if}
		</div>
	</div>

	{#if error}
		<div class="bg-destructive/10 text-destructive p-4 rounded-lg text-sm" data-testid="workflows-error" role="alert">
			{error}
		</div>
	{/if}

	<!-- Workflows list -->
	{#if loading}
		<div class="flex flex-col gap-3" data-testid="workflows-loading">
			{#each Array(3) as _}
				<div class="h-36 rounded-lg bg-muted ds-shimmer"></div>
			{/each}
		</div>
	{:else if workflows.length === 0}
		<!-- AC: @ui-workflows-view ac-1 — Empty state -->
		<div class="flex flex-col items-center justify-center py-16" data-testid="workflows-empty">
			<WorkflowIcon class="size-12 text-muted-foreground/30 mb-4" />
			<h2 class="text-lg font-medium text-muted-foreground mb-1">No workflows defined</h2>
			<p class="text-sm text-muted-foreground">
				{#if isStaticMode()}
					No workflow data available in the snapshot.
				{:else}
					Define workflows in <code class="text-xs bg-muted px-1 py-0.5 rounded">kynetic.meta.yaml</code> to see them here.
				{/if}
			</p>
		</div>
	{:else}
		<!-- AC: @ui-workflows-view ac-1 — Workflow cards with all required fields -->
		<div class="flex flex-col gap-3" data-testid="workflows-list">
			{#each workflows as workflow (workflow._ulid)}
				<Card class="transition-all duration-200 hover:shadow-md" data-testid="workflow-card">
					<CardHeader class="pb-3">
						<div class="flex items-start justify-between gap-4">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-1 flex-wrap">
									<h3 class="text-sm font-semibold" data-testid="workflow-id">
										{workflow.id}
									</h3>
									<!-- AC: @ui-workflows-view ac-1 — Trigger type badge -->
									<Badge variant="secondary" class="text-xs gap-1" data-testid="workflow-trigger">
										<ZapIcon class="h-3 w-3" />
										{workflow.trigger}
									</Badge>
									<!-- AC: @ui-workflows-view ac-1 — Loop variant indicator -->
									{#if workflow.mode === 'loop'}
										<Badge variant="outline" class="text-xs gap-1" data-testid="workflow-loop">
											<RepeatIcon class="h-3 w-3" />
											Loop
										</Badge>
									{/if}
									{#if workflow.based_on}
										<Badge variant="outline" class="text-xs gap-1" data-testid="workflow-variant">
											variant of @{workflow.based_on}
										</Badge>
									{/if}
									{#if workflow.enforcement === 'strict'}
										<Badge class="text-xs bg-status-blocked text-status-blocked-fg">
											Strict
										</Badge>
									{/if}
								</div>
								{#if workflow.description}
									<div
										class="text-sm text-muted-foreground break-words leading-relaxed prose prose-sm dark:prose-invert max-w-none"
										data-testid="workflow-description"
									>
										{@html renderMarkdown(workflow.description.trim())}
									</div>
								{/if}
							</div>
							<!-- AC: @ui-workflows-view ac-1 — Start button -->
							{#if !isStaticMode()}
								<Button
									variant="outline"
									size="sm"
									class="h-8 gap-1.5 text-xs shrink-0"
									data-testid="workflow-start-btn"
									onclick={() => copyStartCommand(workflow.id)}
								>
									{#if copiedId === workflow.id}
										<CopyIcon class="size-3.5" />
										Copied!
									{:else}
										<PlayIcon class="size-3.5" />
										Start
									{/if}
								</Button>
							{/if}
						</div>
					</CardHeader>
					<CardContent class="pt-0">
						<!-- AC: @ui-workflows-view ac-1 — Ordered steps with names -->
						{#if workflow.steps.length > 0}
							<div class="flex flex-col gap-1.5" data-testid="workflow-steps">
								<h4 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
									Steps ({workflow.steps.length})
								</h4>
								<ol class="flex flex-col gap-1">
									{#each workflow.steps as step, i}
										<li class="flex items-start gap-2 text-sm" data-testid="workflow-step">
											<span class="flex items-center gap-1.5 shrink-0 mt-0.5">
												<span class="text-xs text-muted-foreground font-mono w-4 text-right">{i + 1}.</span>
												{#if step.type === 'check'}
													<CheckCircleIcon class="size-3.5 {STEP_TYPE_CLASS.check}" />
												{:else if step.type === 'decision'}
													<CircleDotIcon class="size-3.5 {STEP_TYPE_CLASS.decision}" />
												{:else}
													<CircleIcon class="size-3.5 {STEP_TYPE_CLASS.action}" />
												{/if}
											</span>
											<span class="min-w-0">
												<span class="text-muted-foreground">{step.content}</span>
												{#if step.on_fail}
													<span class="text-xs text-destructive/80 ml-1">(on fail: {step.on_fail})</span>
												{/if}
												{#if step.options && step.options.length > 0}
													<ul class="mt-1 ml-4 space-y-0.5">
														{#each step.options as option}
															<li class="text-xs text-muted-foreground list-disc">{option}</li>
														{/each}
													</ul>
												{/if}
											</span>
										</li>
									{/each}
								</ol>
							</div>
						{:else}
							<p class="text-xs text-muted-foreground italic">No steps defined</p>
						{/if}

						<!-- Metadata row -->
						<div class="flex items-center gap-2 text-xs text-muted-foreground mt-3 pt-3 border-t">
							<code class="bg-muted px-1 py-0.5 rounded" data-testid="workflow-ulid">
								{workflow._ulid.slice(0, 8)}
							</code>
							{#if workflow.tags && workflow.tags.length > 0}
								<span>&middot;</span>
								{#each workflow.tags as tag}
									<Badge variant="secondary" class="text-xs">{tag}</Badge>
								{/each}
							{/if}
						</div>
					</CardContent>
				</Card>
			{/each}
		</div>
	{/if}
</div>
