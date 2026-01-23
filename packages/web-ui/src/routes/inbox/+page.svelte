<script lang="ts">
	import { onMount } from 'svelte';
	import type { InboxItem } from '@kynetic-ai/shared';
	import { fetchInbox, addInboxItem, deleteInboxItem } from '$lib/api';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogFooter,
		DialogHeader,
		DialogTitle
	} from '$lib/components/ui/dialog';

	// AC: @web-dashboard ac-16
	let items: InboxItem[] = [];
	let loading = true;
	let error = '';

	// AC: @web-dashboard ac-17
	let showAddInput = false;
	let newItemText = '';
	let addingItem = false;

	// AC: @web-dashboard ac-19
	let deleteConfirmOpen = false;
	let itemToDelete: InboxItem | null = null;
	let deletingItem = false;

	onMount(async () => {
		await loadInbox();
	});

	async function loadInbox() {
		try {
			loading = true;
			error = '';
			const response = await fetchInbox();
			items = response.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load inbox';
		} finally {
			loading = false;
		}
	}

	// AC: @web-dashboard ac-17, ac-18
	async function handleAddItem() {
		if (!newItemText.trim()) return;

		try {
			addingItem = true;
			error = '';
			const newItem = await addInboxItem(newItemText.trim());

			// Add new item to list without reloading
			items = [newItem, ...items];

			// Reset form
			newItemText = '';
			showAddInput = false;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to add item';
		} finally {
			addingItem = false;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			handleAddItem();
		}
	}

	// AC: @web-dashboard ac-19
	function confirmDelete(item: InboxItem) {
		itemToDelete = item;
		deleteConfirmOpen = true;
	}

	async function handleDelete() {
		if (!itemToDelete) return;

		try {
			deletingItem = true;
			error = '';
			await deleteInboxItem(itemToDelete._ulid);

			// Remove item from list with animation
			items = items.filter((i) => i._ulid !== itemToDelete!._ulid);

			// Close dialog
			deleteConfirmOpen = false;
			itemToDelete = null;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete item';
		} finally {
			deletingItem = false;
		}
	}

	function formatDate(dateString: string): string {
		const date = new Date(dateString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return 'just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;

		return date.toLocaleDateString();
	}
</script>

<!-- AC: @web-dashboard ac-16, ac-17, ac-18, ac-19 -->
<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between">
		<h1 class="text-3xl font-bold">Inbox</h1>
		<Button
			on:click={() => (showAddInput = !showAddInput)}
			variant={showAddInput ? 'secondary' : 'default'}
		>
			{showAddInput ? 'Cancel' : 'Add Item'}
		</Button>
	</div>

	{#if error}
		<div class="rounded-md bg-red-50 p-4 text-sm text-red-800">
			{error}
		</div>
	{/if}

	<!-- AC: @web-dashboard ac-17 - Add input field -->
	{#if showAddInput}
		<Card>
			<CardContent class="pt-6">
				<div class="flex gap-2">
					<Input
						bind:value={newItemText}
						placeholder="Enter inbox item text (press Enter to submit)"
						on:keydown={handleKeydown}
						disabled={addingItem}
						class="flex-1"
					/>
					<Button on:click={handleAddItem} disabled={addingItem || !newItemText.trim()}>
						{addingItem ? 'Adding...' : 'Add'}
					</Button>
				</div>
			</CardContent>
		</Card>
	{/if}

	<!-- AC: @web-dashboard ac-16 - Inbox list -->
	{#if loading}
		<div class="text-center text-muted-foreground">Loading inbox...</div>
	{:else if items.length === 0}
		<div class="text-center text-muted-foreground">
			<p>No inbox items.</p>
			<p class="text-sm">Click "Add Item" to capture ideas and thoughts.</p>
		</div>
	{:else}
		<div class="flex flex-col gap-3">
			{#each items as item (item._ulid)}
				<!-- AC: @web-dashboard ac-18 - Item appears with animation -->
				<Card class="transition-all duration-200 hover:shadow-md">
					<CardHeader class="pb-3">
						<div class="flex items-start justify-between gap-4">
							<div class="flex-1">
								<p class="text-sm leading-relaxed">{item.text}</p>
							</div>
							<Button
								variant="ghost"
								size="sm"
								on:click={() => confirmDelete(item)}
								class="text-red-600 hover:text-red-700 hover:bg-red-50"
							>
								Delete
							</Button>
						</div>
					</CardHeader>
					<CardContent class="pt-0">
						<div class="flex items-center gap-2 text-xs text-muted-foreground">
							<span>{formatDate(item.created_at)}</span>
							<span>•</span>
							<span>{item.added_by}</span>
							{#if item.tags.length > 0}
								<span>•</span>
								<div class="flex gap-1">
									{#each item.tags as tag}
										<Badge variant="secondary" class="text-xs">{tag}</Badge>
									{/each}
								</div>
							{/if}
						</div>
					</CardContent>
				</Card>
			{/each}
		</div>
	{/if}
</div>

<!-- AC: @web-dashboard ac-19 - Delete confirmation dialog -->
<Dialog bind:open={deleteConfirmOpen}>
	<DialogContent>
		<DialogHeader>
			<DialogTitle>Delete Inbox Item?</DialogTitle>
			<DialogDescription>
				Are you sure you want to delete this inbox item? This action cannot be undone.
			</DialogDescription>
		</DialogHeader>
		{#if itemToDelete}
			<div class="rounded-md bg-muted p-3 text-sm">
				{itemToDelete.text}
			</div>
		{/if}
		<DialogFooter>
			<Button variant="outline" on:click={() => (deleteConfirmOpen = false)} disabled={deletingItem}>
				Cancel
			</Button>
			<Button variant="destructive" on:click={handleDelete} disabled={deletingItem}>
				{deletingItem ? 'Deleting...' : 'Delete'}
			</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>
