<!--
  AC: @ui-agent-dispatch ac-4 — Inline edit form for agent definitions.
  AC: @ui-agent-dispatch ac-5, ac-6, ac-7, ac-8, ac-9 — Dispatch filter editing per trigger row.
  Schema-driven: types (AgentDefinition, AgentUpdatePayload, AgentDispatchRule) and
  dispatch event values (AGENT_DISPATCH_EVENTS) from @kynetic-ai/shared, which mirrors
  AgentSchema / AgentDispatchEventSchema from src/schema/meta.ts.
-->
<script lang="ts">
	import { updateAgentDefinition } from '$lib/api';
	import {
		AGENT_DISPATCH_EVENTS,
		type AgentDefinition,
		type AgentUpdatePayload,
		type AgentDispatchEvent,
		type AgentDispatchRule,
		type AgentDispatchFilter
	} from '@kynetic-ai/shared';
	import { ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import {
		Select,
		SelectContent,
		SelectItem,
		SelectTrigger
	} from '$lib/components/ui/select';
	import X from '@lucide/svelte/icons/x';
	import Plus from '@lucide/svelte/icons/plus';
	import Filter from '@lucide/svelte/icons/filter';

	let {
		open = $bindable(false),
		agent,
		onSaved
	}: {
		open?: boolean;
		agent: AgentDefinition;
		onSaved?: (updated: AgentDefinition) => void;
	} = $props();

	// Form state derived from agent prop — reset when dialog opens
	// Field structure mirrors AgentDefinition from @kynetic-ai/shared (schema-driven)
	let name = $state('');
	let description = $state('');
	let adapter = $state('');
	let dispatchTriggers = $state<AgentDispatchRule[]>([]);
	let capabilities = $state<string[]>([]);
	let tools = $state<string[]>([]);
	let skills = $state<string[]>([]);
	let maxTasks = $state<number | undefined>(undefined);
	let maxRetries = $state<number | undefined>(undefined);
	let timeoutMinutes = $state<number | undefined>(undefined);
	let maxConcurrent = $state(1);
	let autoApprove = $state(false);
	let promptTemplate = $state('');

	// UI state
	let saving = $state(false);
	let error = $state('');

	// Chip input buffers
	let newCapability = $state('');
	let newTool = $state('');
	let newSkill = $state('');

	// Tag input buffers per trigger
	let triggerTagInputs = $state<Record<number, string>>({});

	// Reset form state when dialog opens
	$effect(() => {
		if (open && agent) {
			name = agent.name;
			description = agent.description ?? '';
			adapter = agent.adapter ?? '';
			dispatchTriggers = agent.dispatch.map((d) => ({ ...d, filter: d.filter ? { ...d.filter } : undefined }));
			capabilities = [...agent.capabilities];
			tools = [...agent.tools];
			skills = [...agent.skills];
			maxTasks = agent.budget?.max_tasks;
			maxRetries = agent.budget?.max_retries;
			timeoutMinutes = agent.budget?.timeout_minutes;
			maxConcurrent = agent.concurrency?.max_concurrent ?? 1;
			autoApprove = agent.auto_approve;
			promptTemplate = agent.prompt_template ?? '';
			error = '';
			newCapability = '';
			newTool = '';
			newSkill = '';
			triggerTagInputs = {};
		}
	});

	// Available dispatch events not yet selected
	let availableEvents = $derived(
		AGENT_DISPATCH_EVENTS.filter((e) => !dispatchTriggers.some((t) => t.on === e))
	);

	// AC: @ui-agent-dispatch ac-6 — default automation:eligible for task.ready/task.needs_work
	function addTrigger(event: AgentDispatchEvent) {
		const defaultsToEligible = event === 'task.ready' || event === 'task.needs_work';
		const filter: AgentDispatchFilter | undefined = defaultsToEligible
			? { automation: 'eligible' }
			: undefined;
		dispatchTriggers = [...dispatchTriggers, { on: event, filter }];
	}

	function removeTrigger(index: number) {
		dispatchTriggers = dispatchTriggers.filter((_, i) => i !== index);
	}

	// AC: @ui-agent-dispatch ac-5 — update filter on a trigger
	function updateTriggerFilter(index: number, updates: Partial<AgentDispatchFilter>) {
		dispatchTriggers = dispatchTriggers.map((t, i) => {
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

	// AC: @ui-agent-dispatch ac-7 — add tag to a trigger's filter
	function addFilterTag(index: number, tag: string) {
		const trimmed = tag.trim();
		if (!trimmed) return;
		const currentTags = dispatchTriggers[index]?.filter?.tags ?? [];
		if (currentTags.includes(trimmed)) return;
		updateTriggerFilter(index, { tags: [...currentTags, trimmed] });
	}

	// AC: @ui-agent-dispatch ac-7 — remove tag from a trigger's filter
	function removeFilterTag(index: number, tagIndex: number) {
		const currentTags = dispatchTriggers[index]?.filter?.tags ?? [];
		const newTags = currentTags.filter((_, i) => i !== tagIndex);
		updateTriggerFilter(index, { tags: newTags.length > 0 ? newTags : undefined });
	}

	function addChip(list: string[], value: string, setter: (v: string[]) => void, clearInput: () => void) {
		const trimmed = value.trim();
		if (trimmed && !list.includes(trimmed)) {
			setter([...list, trimmed]);
			clearInput();
		}
	}

	function removeChip(list: string[], index: number, setter: (v: string[]) => void) {
		setter(list.filter((_, i) => i !== index));
	}

	async function handleSave() {
		saving = true;
		error = '';

		const payload: AgentUpdatePayload = {
			name,
			description: description || undefined,
			adapter: adapter || undefined,
			dispatch: dispatchTriggers,
			capabilities,
			tools,
			skills,
			budget: (maxTasks !== undefined || maxRetries !== undefined || timeoutMinutes !== undefined)
				? { max_tasks: maxTasks, max_retries: maxRetries, timeout_minutes: timeoutMinutes }
				: undefined,
			concurrency: { max_concurrent: maxConcurrent },
			auto_approve: autoApprove,
			prompt_template: promptTemplate || undefined
		};

		try {
			const updated = await updateAgentDefinition(agent.id, payload);
			onSaved?.(updated);
			open = false;
		} catch (err) {
			if (err instanceof ReadOnlyModeError) {
				error = err.message;
			} else {
				error = err instanceof Error ? err.message : 'Failed to save agent';
			}
		} finally {
			saving = false;
		}
	}

	function handleCancel() {
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="agent-edit-dialog">
		<Dialog.Header>
			<Dialog.Title data-testid="agent-edit-title">Edit Agent: {agent.id}</Dialog.Title>
			<Dialog.Description>
				Modify agent definition fields. Changes are persisted to kynetic.meta.yaml.
			</Dialog.Description>
		</Dialog.Header>

		{#if error}
			<div
				class="bg-destructive/10 text-destructive p-3 rounded-lg text-sm"
				data-testid="agent-edit-error"
				role="alert"
			>
				{error}
			</div>
		{/if}

		<div class="flex flex-col gap-4">
			<!-- Name -->
			<div>
				<label for="agent-name" class="text-sm font-medium">Name</label>
				<Input
					id="agent-name"
					bind:value={name}
					placeholder="Agent name"
					data-testid="agent-edit-name"
				/>
			</div>

			<!-- Description -->
			<div>
				<label for="agent-description" class="text-sm font-medium">Description</label>
				<Textarea
					id="agent-description"
					bind:value={description}
					placeholder="Agent description"
					rows={2}
					data-testid="agent-edit-description"
				/>
			</div>

			<!-- Adapter -->
			<div>
				<label for="agent-adapter" class="text-sm font-medium">Adapter</label>
				<Input
					id="agent-adapter"
					bind:value={adapter}
					placeholder="e.g. claude-code"
					data-testid="agent-edit-adapter"
				/>
			</div>

			<Separator />

			<!-- Dispatch Triggers (schema-driven from AGENT_DISPATCH_EVENTS) -->
			<!-- AC: @ui-agent-dispatch ac-5 — each trigger row shows filter criteria with inline editing -->
			<div>
				<p class="text-sm font-medium mb-2">Dispatch Triggers</p>
				<div class="flex flex-col gap-3 mb-2" data-testid="agent-edit-triggers">
					{#each dispatchTriggers as trigger, i}
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
								<!-- AC: @ui-agent-dispatch ac-5, ac-6 — automation filter dropdown -->
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

								<!-- AC: @ui-agent-dispatch ac-7 — tag filter with removable chips -->
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

								<!-- AC: @ui-agent-dispatch ac-8 — priority filter threshold -->
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
				</div>
				{#if availableEvents.length > 0}
					<div class="flex flex-wrap gap-1.5" data-testid="agent-edit-available-triggers">
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
				{/if}
			</div>

			<Separator />

			<!-- Capabilities (chip input) -->
			<div>
				<p class="text-sm font-medium mb-1">Capabilities</p>
				<div class="flex flex-wrap gap-1 mb-2" data-testid="agent-edit-capabilities">
					{#each capabilities as cap, i}
						<Badge variant="outline" class="gap-1 pr-1">
							{cap}
							<button
								type="button"
								class="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
								onclick={() => removeChip(capabilities, i, (v) => (capabilities = v))}
								aria-label="Remove capability {cap}"
							>
								<X class="h-3 w-3" />
							</button>
						</Badge>
					{/each}
				</div>
				<div class="flex gap-2">
					<Input
						bind:value={newCapability}
						placeholder="Add capability..."
						class="flex-1"
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								addChip(capabilities, newCapability, (v) => (capabilities = v), () => (newCapability = ''));
							}
						}}
						data-testid="agent-edit-capability-input"
					/>
					<Button
						size="sm"
						variant="outline"
						onclick={() => addChip(capabilities, newCapability, (v) => (capabilities = v), () => (newCapability = ''))}
					>
						Add
					</Button>
				</div>
			</div>

			<!-- Tools (chip input) -->
			<div>
				<p class="text-sm font-medium mb-1">Tools</p>
				<div class="flex flex-wrap gap-1 mb-2" data-testid="agent-edit-tools">
					{#each tools as tool, i}
						<Badge variant="outline" class="gap-1 pr-1">
							{tool}
							<button
								type="button"
								class="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
								onclick={() => removeChip(tools, i, (v) => (tools = v))}
								aria-label="Remove tool {tool}"
							>
								<X class="h-3 w-3" />
							</button>
						</Badge>
					{/each}
				</div>
				<div class="flex gap-2">
					<Input
						bind:value={newTool}
						placeholder="Add tool..."
						class="flex-1"
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								addChip(tools, newTool, (v) => (tools = v), () => (newTool = ''));
							}
						}}
						data-testid="agent-edit-tool-input"
					/>
					<Button
						size="sm"
						variant="outline"
						onclick={() => addChip(tools, newTool, (v) => (tools = v), () => (newTool = ''))}
					>
						Add
					</Button>
				</div>
			</div>

			<!-- Skills (chip input) -->
			<div>
				<p class="text-sm font-medium mb-1">Skills</p>
				<div class="flex flex-wrap gap-1 mb-2" data-testid="agent-edit-skills">
					{#each skills as skill, i}
						<Badge variant="outline" class="gap-1 pr-1">
							{skill}
							<button
								type="button"
								class="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
								onclick={() => removeChip(skills, i, (v) => (skills = v))}
								aria-label="Remove skill {skill}"
							>
								<X class="h-3 w-3" />
							</button>
						</Badge>
					{/each}
				</div>
				<div class="flex gap-2">
					<Input
						bind:value={newSkill}
						placeholder="Add skill..."
						class="flex-1"
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								addChip(skills, newSkill, (v) => (skills = v), () => (newSkill = ''));
							}
						}}
						data-testid="agent-edit-skill-input"
					/>
					<Button
						size="sm"
						variant="outline"
						onclick={() => addChip(skills, newSkill, (v) => (skills = v), () => (newSkill = ''))}
					>
						Add
					</Button>
				</div>
			</div>

			<Separator />

			<!-- Budget -->
			<div>
				<p class="text-sm font-medium mb-2">Budget</p>
				<div class="grid grid-cols-3 gap-3">
					<div>
						<label for="agent-max-tasks" class="text-xs text-muted-foreground">Max Tasks</label>
						<Input
							id="agent-max-tasks"
							type="number"
							min={1}
							value={maxTasks ?? ''}
							oninput={(e: Event) => {
								const v = (e.target as HTMLInputElement).valueAsNumber;
								maxTasks = Number.isNaN(v) ? undefined : v;
							}}
							placeholder="—"
							data-testid="agent-edit-max-tasks"
						/>
					</div>
					<div>
						<label for="agent-max-retries" class="text-xs text-muted-foreground">Max Retries</label>
						<Input
							id="agent-max-retries"
							type="number"
							min={0}
							value={maxRetries ?? ''}
							oninput={(e: Event) => {
								const v = (e.target as HTMLInputElement).valueAsNumber;
								maxRetries = Number.isNaN(v) ? undefined : v;
							}}
							placeholder="—"
							data-testid="agent-edit-max-retries"
						/>
					</div>
					<div>
						<label for="agent-timeout" class="text-xs text-muted-foreground">Timeout (min)</label>
						<Input
							id="agent-timeout"
							type="number"
							min={1}
							value={timeoutMinutes ?? ''}
							oninput={(e: Event) => {
								const v = (e.target as HTMLInputElement).valueAsNumber;
								timeoutMinutes = Number.isNaN(v) ? undefined : v;
							}}
							placeholder="—"
							data-testid="agent-edit-timeout"
						/>
					</div>
				</div>
			</div>

			<!-- Concurrency -->
			<div>
				<label for="agent-concurrency" class="text-sm font-medium">Max Concurrent</label>
				<Input
					id="agent-concurrency"
					type="number"
					min={1}
					bind:value={maxConcurrent}
					data-testid="agent-edit-concurrency"
				/>
			</div>

			<!-- Auto Approve -->
			<div class="flex items-center gap-3">
				<input
					id="agent-auto-approve"
					type="checkbox"
					bind:checked={autoApprove}
					class="h-4 w-4 rounded border-input"
					data-testid="agent-edit-auto-approve"
				/>
				<label for="agent-auto-approve" class="text-sm font-medium">Auto Approve</label>
			</div>

			<Separator />

			<!-- Prompt Template -->
			<div>
				<label for="agent-prompt-template" class="text-sm font-medium">Prompt Template</label>
				<Textarea
					id="agent-prompt-template"
					bind:value={promptTemplate}
					placeholder="Agent prompt template..."
					rows={4}
					class="font-mono text-xs"
					data-testid="agent-edit-prompt-template"
				/>
			</div>
		</div>

		<Dialog.Footer class="mt-4">
			<Button
				variant="ghost"
				onclick={handleCancel}
				disabled={saving}
				data-testid="agent-edit-cancel"
			>
				Cancel
			</Button>
			<Button
				onclick={handleSave}
				disabled={saving || !name.trim()}
				data-testid="agent-edit-save"
			>
				{saving ? 'Saving...' : 'Save'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
