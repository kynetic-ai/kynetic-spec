<!--
  AC: @ui-automation-view ac-1 — Shows agent dispatch triggers with enabled/disabled state
  AC: @ui-automation-view ac-5 — Inline editing of trigger event type and filter criteria
-->
<script lang="ts">
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import {
		updateAgentDefinition,
		type AgentDefinition
	} from '$lib/api';
	import { AGENT_DISPATCH_EVENTS, type AgentDispatchRule, type AgentDispatchFilter, type AgentDispatchEvent } from '@kynetic-ai/shared';
	import { isStaticMode, ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card } from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import Bot from '@lucide/svelte/icons/bot';
	import Zap from '@lucide/svelte/icons/zap';
	import Pencil from '@lucide/svelte/icons/pencil';
	import X from '@lucide/svelte/icons/x';

	interface Props {
		agents: AgentDefinition[];
		dispatchEnabled: boolean;
	}

	let { agents, dispatchEnabled }: Props = $props();

	const queryClient = useQueryClient();

	// Editing state
	let editingAgentId = $state<string | null>(null);
	let editingTriggers = $state<AgentDispatchRule[]>([]);
	let editDialogOpen = $state(false);
	let editError = $state('');

	const EVENT_TYPES = AGENT_DISPATCH_EVENTS;

	// AC: @ui-automation-view ac-5 — Mutation for saving trigger edits
	const updateMutation = createMutation(() => ({
		mutationFn: ({ agentId, dispatch }: { agentId: string; dispatch: AgentDispatchRule[] }) =>
			updateAgentDefinition(agentId, { dispatch }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
			editDialogOpen = false;
			editingAgentId = null;
			editError = '';
		},
		onError: (err: Error) => {
			editError = err instanceof ReadOnlyModeError ? err.message : err.message;
		},
	}));

	function openEditDialog(agent: AgentDefinition) {
		editingAgentId = agent.id;
		editingTriggers = agent.dispatch.map((d) => ({
			on: d.on,
			filter: d.filter ? { ...d.filter } : undefined,
		}));
		editError = '';
		editDialogOpen = true;
	}

	function addTrigger() {
		editingTriggers = [...editingTriggers, { on: 'task.ready' as AgentDispatchEvent }];
	}

	function removeTrigger(index: number) {
		editingTriggers = editingTriggers.filter((_, i) => i !== index);
	}

	function updateTriggerEvent(index: number, event: string) {
		editingTriggers = editingTriggers.map((t, i) =>
			i === index ? { ...t, on: event as AgentDispatchEvent } : t
		);
	}

	function updateTriggerFilterAutomation(index: number, value: string) {
		editingTriggers = editingTriggers.map((t, i) => {
			if (i !== index) return t;
			const filter: AgentDispatchFilter = { ...t.filter };
			if (value) {
				filter.automation = value as 'eligible' | 'ineligible';
			} else {
				delete filter.automation;
			}
			return { ...t, filter: Object.keys(filter).length > 0 ? filter : undefined };
		});
	}

	function updateTriggerFilterTags(index: number, tagsStr: string) {
		editingTriggers = editingTriggers.map((t, i) => {
			if (i !== index) return t;
			const filter: AgentDispatchFilter = { ...t.filter };
			const tags = tagsStr.split(',').map((s) => s.trim()).filter(Boolean);
			if (tags.length > 0) {
				filter.tags = tags;
			} else {
				delete filter.tags;
			}
			return { ...t, filter: Object.keys(filter).length > 0 ? filter : undefined };
		});
	}

	function saveTriggers() {
		if (!editingAgentId) return;
		updateMutation.mutate({ agentId: editingAgentId, dispatch: editingTriggers });
	}

	let editingAgent = $derived(agents.find((a) => a.id === editingAgentId));
</script>

<section data-testid="dispatch-triggers-section">
	<h2 class="text-lg font-semibold mb-3">
		Agent Dispatch Triggers
		{#if agents.length > 0}
			<span class="text-sm font-normal text-muted-foreground">({agents.length} agents)</span>
		{/if}
	</h2>

	{#if !dispatchEnabled}
		<div class="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg mb-3">
			Dispatch engine is not running. Triggers are shown but will not fire until dispatch is started.
		</div>
	{/if}

	{#if agents.length === 0}
		<div
			class="flex flex-col items-center justify-center py-8 text-center border rounded-lg"
			data-testid="triggers-empty-state"
		>
			<Bot class="h-10 w-10 text-muted-foreground mb-3" />
			<h3 class="text-sm font-medium mb-1">No agents defined</h3>
			<p class="text-xs text-muted-foreground max-w-sm">
				Agent definitions are configured in kynetic.meta.yaml.
			</p>
		</div>
	{:else}
		<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
			{#each agents as agent (agent.id)}
				<Card class="p-4 flex flex-col gap-3" data-testid="trigger-card-{agent.id}">
					<div class="flex items-start justify-between gap-2">
						<div class="flex items-center gap-2 min-w-0">
							<Bot class="h-4 w-4 shrink-0 text-muted-foreground" />
							<div class="min-w-0">
								<h3 class="font-medium text-sm truncate">{agent.name}</h3>
								<p class="text-xs text-muted-foreground font-mono">{agent.id}</p>
							</div>
						</div>
						{#if !isStaticMode()}
							<Button
								size="sm"
								variant="ghost"
								class="h-7 w-7 p-0 shrink-0"
								onclick={() => openEditDialog(agent)}
								aria-label="Edit triggers for {agent.name}"
								data-testid="edit-triggers-{agent.id}"
							>
								<Pencil class="h-3.5 w-3.5" />
							</Button>
						{/if}
					</div>

					<div class="flex flex-wrap gap-1.5">
						{#if agent.dispatch.length > 0}
							{#each agent.dispatch as trigger}
								<Badge variant="secondary" class="text-xs gap-1">
									<Zap class="h-3 w-3" />
									{trigger.on}
								</Badge>
								{#if trigger.filter?.automation}
									<Badge variant="outline" class="text-xs">{trigger.filter.automation}</Badge>
								{/if}
								{#if trigger.filter?.tags?.length}
									{#each trigger.filter.tags as tag}
										<Badge variant="outline" class="text-xs">{tag}</Badge>
									{/each}
								{/if}
								{#if trigger.filter?.priority !== undefined}
									<Badge variant="outline" class="text-xs">p≤{trigger.filter.priority}</Badge>
								{/if}
							{/each}
						{:else}
							<span class="text-xs text-muted-foreground">No triggers configured</span>
						{/if}
					</div>
				</Card>
			{/each}
		</div>
	{/if}
</section>

<!-- AC: @ui-automation-view ac-5 — Trigger edit dialog -->
<Dialog.Root bind:open={editDialogOpen}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Edit Dispatch Triggers</Dialog.Title>
			<Dialog.Description>
				{#if editingAgent}
					Configure triggers for <strong>{editingAgent.name}</strong> ({editingAgentId})
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if editError}
			<div class="bg-destructive/10 text-destructive text-sm p-3 rounded" role="alert">
				{editError}
			</div>
		{/if}

		<div class="flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
			{#each editingTriggers as trigger, index}
				<div class="flex flex-col gap-2 p-3 border rounded-lg" data-testid="trigger-edit-{index}">
					<div class="flex items-center justify-between">
						<span class="text-xs font-medium text-muted-foreground">Trigger {index + 1}</span>
						<Button
							size="sm"
							variant="ghost"
							class="h-6 w-6 p-0"
							onclick={() => removeTrigger(index)}
							aria-label="Remove trigger {index + 1}"
						>
							<X class="h-3.5 w-3.5" />
						</Button>
					</div>

					<div>
						<label class="text-xs font-medium" for="trigger-event-{index}">Event Type</label>
						<select
							id="trigger-event-{index}"
							class="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
							value={trigger.on}
							onchange={(e) => updateTriggerEvent(index, e.currentTarget.value)}
						>
							{#each EVENT_TYPES as eventType}
								<option value={eventType}>{eventType}</option>
							{/each}
						</select>
					</div>

					<div>
						<label class="text-xs font-medium" for="trigger-automation-{index}">Automation Filter</label>
						<select
							id="trigger-automation-{index}"
							class="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
							value={trigger.filter?.automation ?? ''}
							onchange={(e) => updateTriggerFilterAutomation(index, e.currentTarget.value)}
						>
							<option value="">Any</option>
							<option value="eligible">Eligible</option>
							<option value="ineligible">Ineligible</option>
						</select>
					</div>

					<div>
						<label class="text-xs font-medium" for="trigger-tags-{index}">Tags (comma-separated)</label>
						<Input
							id="trigger-tags-{index}"
							class="mt-1"
							placeholder="e.g. cli, web-ui"
							value={trigger.filter?.tags?.join(', ') ?? ''}
							oninput={(e) => updateTriggerFilterTags(index, e.currentTarget.value)}
						/>
					</div>
				</div>
			{/each}

			<Button variant="outline" size="sm" onclick={addTrigger}>
				Add Trigger
			</Button>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => { editDialogOpen = false; }}>Cancel</Button>
			<Button onclick={saveTriggers} disabled={updateMutation.isPending}>
				{updateMutation.isPending ? 'Saving...' : 'Save'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
