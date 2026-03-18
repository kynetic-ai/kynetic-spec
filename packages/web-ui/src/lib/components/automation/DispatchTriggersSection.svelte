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
	import {
		AGENT_DISPATCH_EVENTS,
		type AgentDispatchRule,
		type AgentDispatchFilter,
		type AgentDispatchEvent
	} from '@kynetic-ai/shared';
	import { isStaticMode, ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import { queryKeys } from '$lib/query/keys.js';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card } from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Separator } from '$lib/components/ui/separator';
	import {
		Select,
		SelectContent,
		SelectItem,
		SelectTrigger
	} from '$lib/components/ui/select';
	import * as Dialog from '$lib/components/ui/dialog';
	import Bot from '@lucide/svelte/icons/bot';
	import Zap from '@lucide/svelte/icons/zap';
	import Pencil from '@lucide/svelte/icons/pencil';
	import X from '@lucide/svelte/icons/x';
	import Plus from '@lucide/svelte/icons/plus';
	import Filter from '@lucide/svelte/icons/filter';

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

	// Tag input buffers per trigger
	let triggerTagInputs = $state<Record<number, string>>({});

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
		triggerTagInputs = {};
		editDialogOpen = true;
	}

	// Available dispatch events not yet selected
	let availableEvents = $derived(
		AGENT_DISPATCH_EVENTS.filter((e) => !editingTriggers.some((t) => t.on === e))
	);

	// Default automation:eligible for task.ready/task.needs_work
	function addTrigger(event: AgentDispatchEvent) {
		const defaultsToEligible = event === 'task.ready' || event === 'task.needs_work';
		const filter: AgentDispatchFilter | undefined = defaultsToEligible
			? { automation: 'eligible' }
			: undefined;
		editingTriggers = [...editingTriggers, { on: event, filter }];
	}

	function removeTrigger(index: number) {
		editingTriggers = editingTriggers.filter((_, i) => i !== index);
	}

	// Update filter on a trigger with cleanup
	function updateTriggerFilter(index: number, updates: Partial<AgentDispatchFilter>) {
		editingTriggers = editingTriggers.map((t, i) => {
			if (i !== index) return t;
			const currentFilter = t.filter ?? {};
			const newFilter = { ...currentFilter, ...updates };
			// Clean up undefined/empty values
			if (newFilter.automation === undefined) delete newFilter.automation;
			if (!newFilter.tags || newFilter.tags.length === 0) delete newFilter.tags;
			if (newFilter.priority === undefined) delete newFilter.priority;
			// If filter is empty, set to undefined
			const hasFilter = Object.keys(newFilter).length > 0;
			return { ...t, filter: hasFilter ? newFilter : undefined };
		});
	}

	// Add tag to a trigger's filter
	function addFilterTag(index: number, tag: string) {
		const trimmed = tag.trim();
		if (!trimmed) return;
		const currentTags = editingTriggers[index]?.filter?.tags ?? [];
		if (currentTags.includes(trimmed)) return;
		updateTriggerFilter(index, { tags: [...currentTags, trimmed] });
	}

	// Remove tag from a trigger's filter
	function removeFilterTag(index: number, tagIndex: number) {
		const currentTags = editingTriggers[index]?.filter?.tags ?? [];
		const newTags = currentTags.filter((_, i) => i !== tagIndex);
		updateTriggerFilter(index, { tags: newTags.length > 0 ? newTags : undefined });
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

<!-- AC: @ui-automation-view ac-5 — Trigger edit dialog with full filter editing -->
<Dialog.Root bind:open={editDialogOpen}>
	<Dialog.Content class="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="trigger-edit-dialog">
		<Dialog.Header>
			<Dialog.Title data-testid="trigger-edit-title">Edit Dispatch Triggers</Dialog.Title>
			<Dialog.Description>
				{#if editingAgent}
					Configure triggers for <strong>{editingAgent.name}</strong> ({editingAgentId})
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if editError}
			<div class="bg-destructive/10 text-destructive text-sm p-3 rounded" role="alert" data-testid="trigger-edit-error">
				{editError}
			</div>
		{/if}

		<div class="flex flex-col gap-3 max-h-[60vh] overflow-y-auto" data-testid="trigger-edit-triggers">
			{#each editingTriggers as trigger, i}
				<div class="border rounded-lg p-3 bg-muted/30" data-testid="trigger-row-{trigger.on}">
					<!-- Trigger header: event name + remove button -->
					<div class="flex items-center justify-between mb-2">
						<Badge variant="secondary" class="gap-1">
							{trigger.on}
						</Badge>
						<button
							type="button"
							class="rounded-full p-1 hover:bg-muted-foreground/20"
							onclick={() => removeTrigger(i)}
							aria-label="Remove trigger {trigger.on}"
							data-testid="remove-trigger-{trigger.on}"
						>
							<X class="h-3.5 w-3.5" />
						</button>
					</div>

					<!-- Filter controls -->
					<div class="flex flex-col gap-2">
						<!-- Automation filter dropdown -->
						<div class="flex items-center gap-2">
							<label class="text-xs text-muted-foreground w-20 shrink-0">
								<Filter class="h-3 w-3 inline-block mr-1" />Automation
							</label>
							<Select
								value={trigger.filter?.automation ?? 'any'}
								onValueChange={(v) => {
									const val = Array.isArray(v) ? v[v.length - 1] : v;
									updateTriggerFilter(i, {
										automation: val === 'any' ? undefined : val as 'eligible' | 'ineligible'
									});
								}}
							>
								<SelectTrigger
									class="h-7 text-xs flex-1"
									data-testid="trigger-automation-{trigger.on}"
								>
									{#if trigger.filter?.automation}
										<Badge variant="outline" class="text-xs">{trigger.filter.automation}</Badge>
									{:else}
										<span class="text-muted-foreground">any</span>
									{/if}
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="any">Any</SelectItem>
									<SelectItem value="eligible">Eligible</SelectItem>
									<SelectItem value="ineligible">Ineligible</SelectItem>
								</SelectContent>
							</Select>
						</div>

						<!-- Tag filter with removable chips -->
						<div class="flex items-start gap-2">
							<label class="text-xs text-muted-foreground w-20 shrink-0 mt-1.5">Tags</label>
							<div class="flex-1">
								<div class="flex flex-wrap gap-1 mb-1" data-testid="trigger-tags-{trigger.on}">
									{#each trigger.filter?.tags ?? [] as tag, tagIdx}
										<Badge variant="outline" class="text-xs gap-0.5 pr-0.5">
											{tag}
											<button
												type="button"
												class="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
												onclick={() => removeFilterTag(i, tagIdx)}
												aria-label="Remove tag {tag}"
												data-testid="remove-filter-tag-{tag}"
											>
												<X class="h-2.5 w-2.5" />
											</button>
										</Badge>
									{/each}
								</div>
								<div class="flex gap-1">
									<Input
										class="h-7 text-xs flex-1"
										placeholder="Add tag..."
										value={triggerTagInputs[i] ?? ''}
										oninput={(e: Event) => {
											triggerTagInputs[i] = (e.target as HTMLInputElement).value;
										}}
										onkeydown={(e: KeyboardEvent) => {
											if (e.key === 'Enter') {
												e.preventDefault();
												addFilterTag(i, triggerTagInputs[i] ?? '');
												triggerTagInputs[i] = '';
											}
										}}
										data-testid="trigger-tag-input-{trigger.on}"
									/>
									<Button
										size="sm"
										variant="outline"
										class="h-7 text-xs px-2"
										onclick={() => {
											addFilterTag(i, triggerTagInputs[i] ?? '');
											triggerTagInputs[i] = '';
										}}
									>
										<Plus class="h-3 w-3" />
									</Button>
								</div>
							</div>
						</div>

						<!-- Priority filter threshold -->
						<div class="flex items-center gap-2">
							<label class="text-xs text-muted-foreground w-20 shrink-0">Priority &#x2264;</label>
							<Input
								class="h-7 text-xs flex-1"
								type="number"
								min={0}
								placeholder="any"
								value={trigger.filter?.priority ?? ''}
								oninput={(e: Event) => {
									const v = (e.target as HTMLInputElement).valueAsNumber;
									updateTriggerFilter(i, {
										priority: Number.isNaN(v) ? undefined : v
									});
								}}
								data-testid="trigger-priority-{trigger.on}"
							/>
						</div>
					</div>
				</div>
			{/each}

			{#if availableEvents.length > 0}
				<Separator />
				<div>
					<p class="text-xs text-muted-foreground mb-2">Add trigger:</p>
					<div class="flex flex-wrap gap-1.5" data-testid="trigger-edit-available-triggers">
						{#each availableEvents as event}
							<Button
								size="sm"
								variant="outline"
								class="text-xs gap-1"
								onclick={() => addTrigger(event)}
								data-testid="add-trigger-{event}"
							>
								<Plus class="h-3 w-3" />
								{event}
							</Button>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => { editDialogOpen = false; }} data-testid="trigger-edit-cancel">Cancel</Button>
			<Button onclick={saveTriggers} disabled={updateMutation.isPending} data-testid="trigger-edit-save">
				{updateMutation.isPending ? 'Saving...' : 'Save'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
