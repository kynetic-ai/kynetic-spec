<!--
  Agent edit form for definition fields (name, description, adapter, capabilities,
  tools, skills, budget, concurrency, auto_approve, prompt_template).

  Dispatch trigger editing has been moved to the automation view
  (DispatchTriggersSection) — see @ui-automation-view ac-5.
-->
<script lang="ts">
	import { updateAgentDefinition } from '$lib/api';
	import {
		type AgentDefinition,
		type AgentUpdatePayload
	} from '@kynetic-ai/shared';
	import { ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import X from 'lucide-svelte/icons/x';

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
	let name = $state('');
	let description = $state('');
	let adapter = $state('');
	// AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
	// Tracks the runner value entered in the form. `initialRunner` lets the
	// save handler detect whether the field needs to be sent as a string (set),
	// `null` (clear), or omitted (unchanged) — the daemon PATCH treats omission
	// and `null` differently.
	let runner = $state('');
	let initialRunner = $state<string | undefined>(undefined);
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

	// Reset form state when dialog opens
	$effect(() => {
		if (open && agent) {
			name = agent.name;
			description = agent.description ?? '';
			adapter = agent.adapter ?? '';
			// AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
			runner = agent.runner ?? '';
			initialRunner = agent.runner;
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
		}
	});

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

		// AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
		// PATCH semantics: a string value sets the runner, `null` clears it,
		// omission leaves it unchanged. We send a value only when the user
		// changed the field so unrelated fields stay untouched.
		const trimmedRunner = runner.trim();
		const currentRunner = trimmedRunner.length > 0 ? trimmedRunner : null;
		const baseline = initialRunner ?? null;
		if (currentRunner !== baseline) {
			payload.runner = currentRunner;
		}

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
				Dispatch triggers are configured in the <a href="/automation" class="underline text-primary">Automation</a> view.
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
				<p class="mt-1 text-xs text-muted-foreground">
					Legacy adapter identity. Leave unchanged when assigning a runner.
				</p>
			</div>

			<!-- Runner -->
			<!-- AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner -->
			<div>
				<label for="agent-runner" class="text-sm font-medium">Runner</label>
				<div class="flex gap-2">
					<Input
						id="agent-runner"
						bind:value={runner}
						placeholder="Named runner from runner config (optional)"
						class="flex-1"
						data-testid="agent-edit-runner"
					/>
					{#if runner.length > 0}
						<Button
							type="button"
							size="sm"
							variant="outline"
							onclick={() => (runner = '')}
							data-testid="agent-edit-runner-clear"
						>
							Clear
						</Button>
					{/if}
				</div>
				<p class="mt-1 text-xs text-muted-foreground">
					Reference a named runner from the layered runner config. Clearing
					the field reverts the agent to the legacy adapter shortcut.
				</p>
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
