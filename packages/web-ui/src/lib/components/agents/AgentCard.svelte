<script lang="ts">
	// AC: @ui-agent-dispatch ac-1 — Agent card showing name, triggers, active/completed counts
	// AC: @runner-operator-surfaces ac-web-ui-agent-cards-include-runner — runner identity and resolved adapter
	// AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets — render daemon-redacted diagnostics only
	import type { AgentDefinition } from '$lib/api';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card } from '$lib/components/ui/card';
	import Bot from 'lucide-svelte/icons/bot';
	import Zap from 'lucide-svelte/icons/zap';
	import Pencil from 'lucide-svelte/icons/pencil';
	import Settings from 'lucide-svelte/icons/settings';

	interface Props {
		agent: AgentDefinition;
		activeCount: number;
		completedCount: number;
		onEdit?: () => void;
	}

	let { agent, activeCount, completedCount, onEdit }: Props = $props();

	// AC: @runner-operator-surfaces ac-web-ui-agent-cards-include-runner
	// Daemon resolves adapter identity via the runner registry (or legacy
	// adapter fallback). Falls back to the raw `adapter` field for clients
	// that pre-date the runner-aware response shape.
	let resolvedAdapter = $derived(agent.resolved_adapter ?? agent.adapter ?? '');
	let runnerValidation = $derived(agent.runner_validation);
</script>

<!-- AC: @ui-agent-dispatch ac-1 -->
<Card
	class="p-4 flex flex-col gap-3"
	data-testid="agent-card-{agent.id}"
>
	<div class="flex items-start justify-between gap-2">
		<div class="flex items-center gap-2 min-w-0">
			<Bot class="h-5 w-5 shrink-0 text-muted-foreground" />
			<div class="min-w-0">
				<h3 class="font-semibold truncate" data-testid="agent-name">{agent.name}</h3>
				<p class="text-xs text-muted-foreground font-mono" data-testid="agent-id">{agent.id}</p>
			</div>
		</div>
		<div class="flex items-center gap-1.5 shrink-0">
			{#if activeCount > 0}
				<span class="ds-breathe inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-status-in-progress text-status-in-progress-fg" data-testid="agent-active-badge">
					{activeCount} active
				</span>
			{/if}
			{#if !isStaticMode() && onEdit}
				<!-- AC: @ui-agent-dispatch ac-4 — Edit button -->
				<Button
					size="sm"
					variant="ghost"
					class="h-7 w-7 p-0"
					onclick={onEdit}
					aria-label="Edit agent {agent.name}"
					data-testid="agent-edit-button-{agent.id}"
				>
					<Pencil class="h-4 w-4" />
				</Button>
			{/if}
		</div>
	</div>

	{#if agent.description}
		<p class="text-sm text-muted-foreground">{agent.description}</p>
	{/if}

	<!-- AC: @runner-operator-surfaces ac-web-ui-agent-cards-include-runner -->
	<!-- AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets -->
	<div class="flex flex-col gap-1.5 rounded-md border bg-muted/30 px-3 py-2 text-xs" data-testid="agent-execution-identity">
		{#if agent.runner}
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-muted-foreground">Runner:</span>
				<Badge variant="outline" class="text-xs" data-testid="agent-runner-name">{agent.runner}</Badge>
				{#if runnerValidation}
					{#if runnerValidation.status === 'valid'}
						<Badge
							class="text-xs bg-status-completed text-status-completed-fg"
							data-testid="agent-runner-validation"
						>
							Valid
						</Badge>
					{:else}
						<Badge
							variant="destructive"
							class="text-xs"
							data-testid="agent-runner-validation"
						>
							Invalid
						</Badge>
					{/if}
				{/if}
			</div>
		{/if}
		{#if resolvedAdapter}
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-muted-foreground">Adapter:</span>
				<span class="font-mono" data-testid="agent-resolved-adapter">{resolvedAdapter}</span>
			</div>
		{/if}
		{#if runnerValidation && runnerValidation.diagnostics.length > 0}
			<ul class="mt-1 flex flex-col gap-1" data-testid="agent-runner-diagnostics">
				{#each runnerValidation.diagnostics as diag}
					<li
						class="rounded border-l-2 border-destructive/60 bg-destructive/5 px-2 py-1"
						data-testid="agent-runner-diagnostic"
					>
						<span class="font-mono text-[10px] uppercase tracking-wide text-muted-foreground" data-testid="agent-runner-diagnostic-reason">
							{diag.reason}
						</span>
						<p class="text-xs" data-testid="agent-runner-diagnostic-message">{diag.message}</p>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<div class="flex flex-wrap gap-1.5">
		{#if agent.dispatch.length > 0}
			{#each agent.dispatch as trigger}
				<Badge variant="secondary" class="text-xs gap-1" data-testid="agent-trigger">
					<Zap class="h-3 w-3" />
					{trigger.on.replace('task.', '')}
				</Badge>
				{#if trigger.filter}
					{#if trigger.filter.automation}
						<Badge variant="outline" class="text-xs" data-testid="filter-badge-automation">{trigger.filter.automation}</Badge>
					{/if}
					{#if trigger.filter.tags?.length}
						{#each trigger.filter.tags as tag}
							<Badge variant="outline" class="text-xs" data-testid="filter-badge-tag">{tag}</Badge>
						{/each}
					{/if}
					{#if trigger.filter.priority !== undefined}
						<Badge variant="outline" class="text-xs" data-testid="filter-badge-priority">p≤{trigger.filter.priority}</Badge>
					{/if}
				{/if}
			{/each}
		{:else}
			<span class="text-xs text-muted-foreground">No triggers configured</span>
		{/if}
	</div>

	<a
		href="/automation"
		class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
		data-testid="configure-triggers-link"
	>
		<Settings class="h-3 w-3" />
		Configure in Automation
	</a>

	<div class="flex items-center gap-4 text-sm border-t pt-3 mt-auto">
		<div class="flex items-center gap-1.5" data-testid="agent-active-count">
			<span class="inline-block h-2 w-2 rounded-full bg-status-in-progress"></span>
			<span class="text-muted-foreground">Active:</span>
			<span class="font-medium">{activeCount}</span>
		</div>
		<div class="flex items-center gap-1.5" data-testid="agent-completed-count">
			<span class="inline-block h-2 w-2 rounded-full bg-status-completed"></span>
			<span class="text-muted-foreground">Completed:</span>
			<span class="font-medium">{completedCount}</span>
		</div>
	</div>
</Card>
