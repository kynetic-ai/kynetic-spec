<!--
  AC: @ui-task-board ac-3 — Task detail modal with full task info.
  AC: @ui-task-board ac-6 — Action buttons: Start, Submit, Complete, Block, Add Note.

  Kanban board task detail dialog. Wraps TaskDetailContent in a Dialog overlay.
-->
<script lang="ts">
	import type { TaskDetail } from '@kynetic-ai/shared';
	import { fetchTask } from '$lib/api';
	import * as Dialog from '$lib/components/ui/dialog';
	import TaskDetailContent from './TaskDetailContent.svelte';

	const {
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

	$effect(() => {
		if (open && taskRef) {
			loadTask(taskRef);
		} else if (!open) {
			task = null;
			error = '';
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

	async function handleTaskUpdated() {
		if (task) {
			task = await fetchTask(task._ulid);
		}
		onTaskUpdated?.();
	}

	const slug = $derived(task?.slugs?.[0] ?? task?._ulid?.slice(0, 8) ?? '');
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="task-detail-modal">
		{#if task && !loading && !error}
			<Dialog.Header>
				<Dialog.Title data-testid="task-detail-title">{task.title}</Dialog.Title>
				<Dialog.Description>
					<span class="font-mono text-xs">@{slug}</span>
				</Dialog.Description>
			</Dialog.Header>
		{/if}

		<TaskDetailContent
			{task}
			{loading}
			{error}
			onTaskUpdated={handleTaskUpdated}
		/>
	</Dialog.Content>
</Dialog.Root>
