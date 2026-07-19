<script lang="ts">
	import type { AgentDispatchStatus } from '$lib/api';
	import {
		HARD_STOP_CONFIRMATION,
		getGlobalActionLabel,
		getGlobalLifecycleActions,
		getLifecycleBadge,
		type GlobalLifecycleAction
	} from '$lib/dispatch-lifecycle';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { isStaticMode } from '$lib/stores/mode.svelte';
	import { tick } from 'svelte';
	import Loader2 from 'lucide-svelte/icons/loader-2';

	interface Props {
		status: AgentDispatchStatus;
		onAction: (action: GlobalLifecycleAction) => Promise<void>;
		isToggling: boolean;
	}

	let { status, onAction, isToggling }: Props = $props();
	let confirmationOpen = $state(false);
	let pendingStop = $state(false);
	let invokingControl = $state<HTMLButtonElement | null>(null);
	let preferInvokingOnDialogClose = $state(true);
	let closeConfirmationWhenReady = $state(false);
	let controlsElement = $state<HTMLDivElement | null>(null);
	let liveStatus = $state('');
	let actions = $derived(getGlobalLifecycleActions(status));
	let badge = $derived(getLifecycleBadge(status));

	$effect(() => {
		if (closeConfirmationWhenReady && !isToggling) {
			closeConfirmationWhenReady = false;
			confirmationOpen = false;
		}
	});

	async function invoke(action: GlobalLifecycleAction, button: HTMLButtonElement) {
		if (isStaticMode()) return;
		invokingControl = button;
		if (action === 'stop') {
			pendingStop = true;
			preferInvokingOnDialogClose = true;
			confirmationOpen = true;
			return;
		}
		await runAction(action);
	}

	function focusLifecycleControl(preferInvoking: boolean) {
		const replacement = controlsElement?.isConnected
			? controlsElement.querySelector<HTMLButtonElement>('button:not([disabled])')
			: null;
		const connectedInvoker = invokingControl?.isConnected ? invokingControl : null;
		(preferInvoking ? connectedInvoker ?? replacement : replacement ?? connectedInvoker)?.focus();
		invokingControl = null;
	}

	function handleCloseAutoFocus(event: Event) {
		event.preventDefault();
		focusLifecycleControl(preferInvokingOnDialogClose);
	}

	async function restoreFocusAfterDomRefresh(preferInvoking: boolean) {
		await tick();
		requestAnimationFrame(() => {
			requestAnimationFrame(() => focusLifecycleControl(preferInvoking));
		});
	}

	function cancelConfirmation() {
		closeConfirmationWhenReady = false;
		preferInvokingOnDialogClose = true;
		confirmationOpen = false;
		pendingStop = false;
	}

	async function runAction(action: GlobalLifecycleAction) {
		let succeeded = false;
		try {
			await onAction(action);
			succeeded = true;
			await tick();
			liveStatus = `Dispatch status changed: ${getLifecycleBadge(status)}`;
		} catch {
			await tick();
			liveStatus = `Dispatch status unchanged: ${getLifecycleBadge(status)}`;
		} finally {
			preferInvokingOnDialogClose = !succeeded;
			pendingStop = false;
			if (action === 'stop') closeConfirmationWhenReady = true;
			else await restoreFocusAfterDomRefresh(!succeeded);
		}
	}
</script>

<!-- AC: @ui-agent-dispatch ac-2, ac-3, ac-status-projection -->
<div class="flex flex-col gap-4 rounded-lg border p-4 min-w-0" data-testid="dispatch-status">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="flex min-w-0 flex-col gap-2">
			<div class="flex flex-wrap items-center gap-2">
				<span
					class="inline-flex h-3 w-3 rounded-full {status.globalAuthority === 'running' ? 'bg-status-completed' : status.globalAuthority === 'paused' ? 'bg-status-pending' : 'bg-status-cancelled'}"
					aria-hidden="true"
				></span>
				<Badge data-testid="dispatch-status-badge">{badge}</Badge>
				<span class="text-sm text-muted-foreground">
					Authority: <strong data-testid="dispatch-authority">{status.globalAuthority}</strong>
				</span>
				<span class="text-sm text-muted-foreground">
					Projection: <strong data-testid="dispatch-projection">{status.projection === 'legacy_unknown_stopping' ? 'Legacy unknown/stopping' : status.projection}</strong>
				</span>
			</div>
			<div class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground" data-testid="dispatch-counts">
				<span><strong data-testid="dispatch-active-count">{status.activeCount}</strong> active</span>
				<span><strong data-testid="dispatch-queued-count">{status.queueDepth}</strong> queued</span>
				<span><strong data-testid="dispatch-held-count">{status.heldCount}</strong> held</span>
			</div>
		</div>

		<div bind:this={controlsElement} class="flex flex-wrap gap-2" aria-label="Dispatch lifecycle controls">
			{#each actions as action}
				<Button
					size="sm"
					variant={action === 'stop' ? 'destructive' : 'outline'}
					disabled={isToggling || isStaticMode()}
					onclick={(event) => invoke(action, event.currentTarget as HTMLButtonElement)}
					aria-label={getGlobalActionLabel(status, action)}
					data-lifecycle-control
					data-testid={`dispatch-action-${action}`}
				>
					{#if isToggling}
						<Loader2 class="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" />
					{/if}
					{getGlobalActionLabel(status, action)}
				</Button>
			{/each}
		</div>
	</div>

	{#if status.cleanupState.entries.length > 0}
		<div class="rounded-md bg-muted/50 p-3 text-xs" data-testid="dispatch-cleanup-evidence">
			<p class="font-medium">Cleanup evidence</p>
			{#each status.cleanupState.entries as entry (entry.cleanupId)}
				<p class="mt-1 break-words font-mono">
					{entry.scope}{entry.taskId ? `/${entry.taskId}` : ''}: {entry.status}/{entry.phase}{entry.errorCode ? ` (${entry.errorCode})` : ''}
				</p>
			{/each}
		</div>
	{/if}

	{#if status.degraded.active || status.degradedTargets.length > 0}
		<div class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="dispatch-degraded-state">
			<strong>Degraded state</strong>
			<p>{status.degraded.reason || status.degradedTargets[0]?.reason || 'Dispatch target is degraded'}</p>
		</div>
	{/if}

	<div class="sr-only" aria-live="polite" aria-atomic="true" data-testid="dispatch-live-status">
		{liveStatus}
	</div>
</div>

<Dialog.Root bind:open={confirmationOpen}>
	<Dialog.Content
		data-testid="dispatch-confirm-dialog"
		aria-label={HARD_STOP_CONFIRMATION.title}
		onCloseAutoFocus={handleCloseAutoFocus}
	>
		<Dialog.Header>
			<Dialog.Title>{HARD_STOP_CONFIRMATION.title}</Dialog.Title>
			<Dialog.Description>{HARD_STOP_CONFIRMATION.description}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button
				variant="outline"
				disabled={isToggling}
				onclick={cancelConfirmation}
				data-testid="dispatch-confirm-cancel"
			>Cancel</Button>
			<Button
				variant="destructive"
				disabled={isToggling || !pendingStop}
				onclick={() => runAction('stop')}
			>Confirm</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
