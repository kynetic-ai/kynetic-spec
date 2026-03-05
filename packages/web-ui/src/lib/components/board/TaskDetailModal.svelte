<!--
  AC: @ui-task-board ac-3 — Task detail modal with full task info.
  AC: @ui-task-board ac-6 — Action buttons: Start, Submit, Complete, Block, Add Note.
-->
<script lang="ts">
	import type { TaskDetail } from '@kynetic-ai/shared';
	import { base } from '$app/paths';
	import {
		fetchTask,
		startTask,
		submitTask,
		completeTask,
		blockTask,
		addTaskNote
	} from '$lib/api';
	import { isStaticMode, ReadOnlyModeError } from '$lib/stores/mode.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Input } from '$lib/components/ui/input';
	import { Separator } from '$lib/components/ui/separator';
	import { getStatusClasses, formatAge } from './board-utils';

	let {
		open = $bindable(false),
		taskRef = $bindable<string | null>(null),
		onTaskUpdated
	}: {
		open?: boolean;
		taskRef?: string | null;
		onTaskUpdated?: () => void;
	} = $props();

	let task = $state<TaskDetail | null>(null);
	let loading = $state(false);
	let error = $state('');
	let actionError = $state('');
	let isSubmitting = $state(false);

	// Note form
	let noteContent = $state('');

	// Block/Complete reason form
	let reasonInput = $state('');
	let showReasonFor = $state<'block' | 'complete' | null>(null);

	$effect(() => {
		if (open && taskRef) {
			loadTask(taskRef);
		} else if (!open) {
			task = null;
			error = '';
			actionError = '';
			noteContent = '';
			reasonInput = '';
			showReasonFor = null;
		}
	});

	async function loadTask(ref: string) {
		loading = true;
		error = '';
		try {
			task = await fetchTask(ref);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load task';
		} finally {
			loading = false;
		}
	}

	async function reloadAndNotify() {
		if (task) {
			task = await fetchTask(task._ulid);
		}
		onTaskUpdated?.();
	}

	async function handleAction(action: () => Promise<void>) {
		isSubmitting = true;
		actionError = '';
		try {
			await action();
			await reloadAndNotify();
		} catch (err) {
			if (err instanceof ReadOnlyModeError) {
				actionError = err.message;
			} else {
				actionError = err instanceof Error ? err.message : 'Action failed';
			}
		} finally {
			isSubmitting = false;
		}
	}

	function handleStart() {
		if (!task) return;
		handleAction(() => startTask(task!._ulid));
	}

	function handleSubmit() {
		if (!task) return;
		handleAction(() => submitTask(task!._ulid));
	}

	function handleComplete() {
		if (!task || !reasonInput.trim()) return;
		const reason = reasonInput.trim();
		handleAction(async () => {
			await completeTask(task!._ulid, reason);
			reasonInput = '';
			showReasonFor = null;
		});
	}

	function handleBlock() {
		if (!task || !reasonInput.trim()) return;
		const reason = reasonInput.trim();
		handleAction(async () => {
			await blockTask(task!._ulid, reason);
			reasonInput = '';
			showReasonFor = null;
		});
	}

	function handleAddNote() {
		if (!task || !noteContent.trim()) return;
		const content = noteContent.trim();
		handleAction(async () => {
			await addTaskNote(task!._ulid, content);
			noteContent = '';
		});
	}

	function formatDate(dateStr: string): string {
		return new Intl.DateTimeFormat('en-US', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(new Date(dateStr));
	}

	let statusInfo = $derived(task ? getStatusClasses(task.status) : null);
	let slug = $derived(task?.slugs?.[0] ?? task?._ulid?.slice(0, 8) ?? '');
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="task-detail-modal">
		{#if loading}
			<div class="flex items-center justify-center py-12">
				<p class="text-muted-foreground">Loading task...</p>
			</div>
		{:else if error}
			<div class="bg-destructive/10 text-destructive p-4 rounded-lg" role="alert">
				{error}
			</div>
		{:else if task && statusInfo}
			<Dialog.Header>
				<Dialog.Title data-testid="modal-task-title">{task.title}</Dialog.Title>
				<Dialog.Description>
					<span class="font-mono text-xs">@{slug}</span>
				</Dialog.Description>
			</Dialog.Header>

			<div class="flex flex-col gap-4">
				<!-- Status, priority, type -->
				<div class="flex flex-wrap gap-2 items-center">
					<Badge class="{statusInfo.bg} {statusInfo.fg}" data-testid="modal-status-badge">
						{statusInfo.label}
					</Badge>
					<Badge variant="outline" data-testid="modal-priority">Priority {task.priority}</Badge>
					{#if task.type !== 'task'}
						<Badge variant="outline">{task.type}</Badge>
					{/if}
					{#if task.automation}
						<Badge variant="secondary" data-testid="modal-automation">
							{task.automation}
						</Badge>
					{/if}
				</div>

				<!-- Spec ref -->
				{#if task.spec_ref}
					<div data-testid="modal-spec-ref">
						<p class="text-xs font-medium text-muted-foreground mb-0.5">Spec</p>
						<a
							href="{base}/specs?ref={encodeURIComponent(task.spec_ref)}"
							class="text-sm text-primary hover:underline font-mono"
						>
							{task.spec_ref}
						</a>
					</div>
				{/if}

				<!-- Tags -->
				{#if task.tags?.length > 0}
					<div>
						<p class="text-xs font-medium text-muted-foreground mb-1">Tags</p>
						<div class="flex flex-wrap gap-1">
							{#each task.tags as tag}
								<Badge variant="secondary">{tag}</Badge>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Dependencies -->
				{#if task.depends_on?.length > 0}
					<div data-testid="modal-dependencies">
						<p class="text-xs font-medium text-muted-foreground mb-1">Dependencies</p>
						<ul class="text-sm space-y-0.5">
							{#each task.depends_on as dep}
								<li>
									<a
										href="{base}/tasks/board?ref={encodeURIComponent(dep)}"
										class="text-primary hover:underline font-mono text-xs"
									>
										{dep}
									</a>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<!-- Blocked by -->
				{#if task.blocked_by?.length > 0}
					<div data-testid="modal-blocked-by">
						<p class="text-xs font-medium text-destructive mb-1">Blocked By</p>
						<ul class="text-sm space-y-0.5">
							{#each task.blocked_by as blocker}
								<li class="text-muted-foreground font-mono text-xs">{blocker}</li>
							{/each}
						</ul>
					</div>
				{/if}

				<!-- VCS refs -->
				{#if task.vcs_refs?.length > 0}
					<div data-testid="modal-vcs">
						<p class="text-xs font-medium text-muted-foreground mb-1">VCS</p>
						<ul class="text-sm space-y-0.5">
							{#each task.vcs_refs as ref}
								<li class="text-muted-foreground font-mono text-xs">{ref}</li>
							{/each}
						</ul>
					</div>
				{/if}

				<!-- Plan ref (via derivation) -->
				{#if task.derivation}
					<div data-testid="modal-plan-ref">
						<p class="text-xs font-medium text-muted-foreground mb-0.5">Derivation</p>
						<p class="text-sm text-muted-foreground">{task.derivation}</p>
					</div>
				{/if}

				<Separator />

				<!-- AC: @ui-task-board ac-6 — Actions -->
				{#if !isStaticMode()}
					<div class="flex flex-wrap gap-2" data-testid="modal-actions">
						{#if task.status === 'pending'}
							<Button
								size="sm"
								onclick={handleStart}
								disabled={isSubmitting}
								data-testid="action-start"
							>
								{isSubmitting ? 'Starting...' : 'Start'}
							</Button>
						{/if}

						{#if task.status === 'in_progress' || task.status === 'needs_work'}
							<Button
								size="sm"
								onclick={handleSubmit}
								disabled={isSubmitting}
								data-testid="action-submit"
							>
								{isSubmitting ? 'Submitting...' : 'Submit for Review'}
							</Button>
						{/if}

						{#if task.status === 'in_progress' || task.status === 'pending_review'}
							<Button
								size="sm"
								variant="outline"
								onclick={() => {
									showReasonFor = 'complete';
									reasonInput = '';
								}}
								disabled={isSubmitting}
								data-testid="action-complete-toggle"
							>
								Complete
							</Button>
						{/if}

						{#if task.status !== 'blocked' && task.status !== 'completed' && task.status !== 'cancelled'}
							<Button
								size="sm"
								variant="destructive"
								onclick={() => {
									showReasonFor = 'block';
									reasonInput = '';
								}}
								disabled={isSubmitting}
								data-testid="action-block-toggle"
							>
								Block
							</Button>
						{/if}
					</div>

					<!-- Reason input for block/complete -->
					{#if showReasonFor}
						<div class="flex gap-2" data-testid="reason-input">
							<Input
								bind:value={reasonInput}
								placeholder="{showReasonFor === 'block' ? 'Block' : 'Completion'} reason..."
								class="flex-1"
							/>
							<Button
								size="sm"
								onclick={showReasonFor === 'block' ? handleBlock : handleComplete}
								disabled={isSubmitting || !reasonInput.trim()}
							>
								Confirm
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onclick={() => {
									showReasonFor = null;
									reasonInput = '';
								}}
							>
								Cancel
							</Button>
						</div>
					{/if}
				{/if}

				{#if actionError}
					<p class="text-sm text-destructive" data-testid="action-error">{actionError}</p>
				{/if}

				<Separator />

				<!-- Todos -->
				{#if task.todos && task.todos.length > 0}
					<div data-testid="modal-todos">
						<p class="text-xs font-medium text-muted-foreground mb-1">
							Todos ({task.todos.length})
						</p>
						<ul class="space-y-1">
							{#each task.todos as todo}
								<li class="flex items-start gap-2 text-sm">
									<span class="mt-0.5 text-xs">
										{#if todo.status === 'completed'}
											&#x2705;
										{:else if todo.status === 'in_progress'}
											&#x23F3;
										{:else}
											&#x23F8;&#xFE0F;
										{/if}
									</span>
									<span class:line-through={todo.status === 'completed'}>
										{todo.content}
									</span>
								</li>
							{/each}
						</ul>
					</div>
					<Separator />
				{/if}

				<!-- Notes -->
				<div data-testid="modal-notes">
					<p class="text-xs font-medium text-muted-foreground mb-2">
						Notes ({task.notes?.length ?? 0})
					</p>

					<!-- Add Note form -->
					{#if !isStaticMode()}
						<div class="mb-3 space-y-2" data-testid="modal-add-note">
							<Textarea
								placeholder="Add a note..."
								bind:value={noteContent}
								disabled={isSubmitting}
								rows={2}
							/>
							<Button
								size="sm"
								onclick={handleAddNote}
								disabled={isSubmitting || !noteContent.trim()}
								data-testid="action-add-note"
							>
								{isSubmitting ? 'Adding...' : 'Add Note'}
							</Button>
						</div>
					{/if}

					<!-- Notes list -->
					<div class="space-y-3">
						{#each task.notes ?? [] as note}
							<div class="border rounded-md p-2.5" data-testid="note-item">
								<div class="flex justify-between items-start mb-1">
									<span class="text-[10px] text-muted-foreground">{note.author}</span>
									<span class="text-[10px] text-muted-foreground">{formatDate(note.created_at)}</span>
								</div>
								<p class="text-sm whitespace-pre-wrap">{note.content}</p>
							</div>
						{/each}
					</div>
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
