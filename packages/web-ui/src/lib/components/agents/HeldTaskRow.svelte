<script lang="ts">
	import type { AgentDispatchStatus, DispatchHeldTask, DispatchTaskControl } from '$lib/api';
	import {
		HARD_STOP_CONFIRMATION,
		getTaskActionLabel,
		getTaskLifecycleActions,
		type TaskLifecycleAction
	} from '$lib/dispatch-lifecycle';
	import ReferenceLink from '$lib/components/ReferenceLink.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { tick } from 'svelte';

	interface Props {
		status: AgentDispatchStatus;
		task: DispatchHeldTask | DispatchTaskControl;
		onAction: (action: TaskLifecycleAction, task: DispatchHeldTask | DispatchTaskControl) => Promise<void>;
		isToggling: boolean;
	}

	let { status, task, onAction, isToggling }: Props = $props();
	let confirmationOpen = $state(false);
	let invokingControl = $state<HTMLButtonElement | null>(null);
	let rowElement = $state<HTMLDivElement | null>(null);
	let actions = $derived(getTaskLifecycleActions(status, task.taskId));
	let isHeld = $derived('scope' in task);

	async function invoke(action: TaskLifecycleAction, button: HTMLButtonElement) {
		if (isStaticMode()) return;
		invokingControl = button;
		if (action === 'stop') {
			confirmationOpen = true;
			return;
		}
		await runAction(action);
	}

	async function restoreLifecycleFocus(preferInvoking = false) {
		await tick();
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const replacement = rowElement?.isConnected
					? rowElement.querySelector<HTMLButtonElement>('button[data-lifecycle-control]:not([disabled])')
					: null;
				const fallback = document.querySelector<HTMLButtonElement>(
					'[data-testid="dispatch-status"] button[data-lifecycle-control]:not([disabled])'
				);
				const connectedInvoker = invokingControl?.isConnected ? invokingControl : null;
				(preferInvoking
					? connectedInvoker ?? replacement ?? fallback
					: replacement ?? connectedInvoker ?? fallback
				)?.focus();
				invokingControl = null;
			});
		});
	}

	async function cancelConfirmation() {
		confirmationOpen = false;
		await restoreLifecycleFocus(true);
	}

	async function runAction(action: TaskLifecycleAction) {
		let succeeded = false;
		try {
			await onAction(action, task);
			succeeded = true;
		} finally {
			confirmationOpen = false;
			await restoreLifecycleFocus(!succeeded);
		}
	}
</script>

<div bind:this={rowElement} class="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2" data-testid={`${isHeld ? 'held-task' : 'task-control'}-${task.taskId}`}>
	<div class="min-w-0">
		<div class="flex flex-wrap items-center gap-2">
			<Badge variant="secondary">{task.mode}</Badge>
			{#if task.taskRef}
				<ReferenceLink ref={task.taskRef} type="task" title={task.title ?? undefined} class="text-sm" />
			{:else}
				<span class="break-all font-mono text-sm">{task.taskId}</span>
			{/if}
		</div>
		<p class="mt-1 text-xs text-muted-foreground">
			{isHeld ? `Held by ${'scope' in task ? task.scope : 'task'} authority` : 'Task control'}: {task.reason}
		</p>
	</div>
	<div class="flex flex-wrap gap-2" aria-label={`Lifecycle controls for ${task.title ?? task.taskId}`}>
		{#each actions as action}
			<Button
				size="sm"
				variant={action === 'stop' ? 'destructive' : 'outline'}
				disabled={isToggling || isStaticMode()}
				onclick={(event) => invoke(action, event.currentTarget as HTMLButtonElement)}
				aria-label={getTaskActionLabel(status, task.taskId, action)}
				data-lifecycle-control
				data-testid={`task-lifecycle-${task.taskId}-${action}`}
			>
				{getTaskActionLabel(status, task.taskId, action)}
			</Button>
		{/each}
	</div>
</div>

<Dialog.Root bind:open={confirmationOpen}>
	<Dialog.Content aria-label={HARD_STOP_CONFIRMATION.title}>
		<Dialog.Header>
			<Dialog.Title>{HARD_STOP_CONFIRMATION.title}</Dialog.Title>
			<Dialog.Description>{HARD_STOP_CONFIRMATION.description}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={cancelConfirmation}>Cancel</Button>
			<Button variant="destructive" disabled={isToggling} onclick={() => runAction('stop')}>Confirm</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
