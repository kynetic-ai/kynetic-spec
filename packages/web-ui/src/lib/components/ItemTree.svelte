<script lang="ts">
	// AC: @web-dashboard ac-11
	import type { ItemSummary } from '@kynetic-ai/shared';
	import { Badge } from '$lib/components/ui/badge';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { createEventDispatcher } from 'svelte';

	export let items: ItemSummary[];

	const dispatch = createEventDispatcher<{
		select: string;
	}>();

	// Track expanded nodes
	let expandedNodes = new Set<string>();

	// Build hierarchical tree structure
	interface TreeNode {
		item: ItemSummary;
		children: TreeNode[];
	}

	function buildTree(flatItems: ItemSummary[]): TreeNode[] {
		const nodeMap = new Map<string, TreeNode>();
		const roots: TreeNode[] = [];

		// Create nodes for all items
		flatItems.forEach((item) => {
			nodeMap.set(item._ulid, { item, children: [] });
		});

		// Build parent-child relationships
		flatItems.forEach((item) => {
			const node = nodeMap.get(item._ulid);
			if (!node) return;

			if (item.parent) {
				const parentNode = nodeMap.get(item.parent);
				if (parentNode) {
					parentNode.children.push(node);
				} else {
					roots.push(node);
				}
			} else {
				roots.push(node);
			}
		});

		return roots;
	}

	function toggleExpand(ulid: string) {
		if (expandedNodes.has(ulid)) {
			expandedNodes.delete(ulid);
		} else {
			expandedNodes.add(ulid);
		}
		// Trigger reactivity
		expandedNodes = expandedNodes;
	}

	function selectItem(item: ItemSummary) {
		dispatch('select', item._ulid);
	}

	function getTypeColor(type: string): string {
		const colors: Record<string, string> = {
			module: 'bg-purple-500',
			feature: 'bg-blue-500',
			requirement: 'bg-green-500',
			trait: 'bg-yellow-500'
		};
		return colors[type] || 'bg-gray-500';
	}

	$: tree = buildTree(items);
</script>

<!-- Recursive tree node snippet -->
{#snippet renderNode(node: TreeNode, level: number)}
	{@const isExpanded = expandedNodes.has(node.item._ulid)}
	{@const hasChildren = node.children.length > 0}
	<div data-testid="tree-node tree-node-{node.item.type}">
		<div class="flex items-center gap-1 py-2 px-2 rounded-md hover:bg-muted/50">
			<!-- Expand/collapse button (only if has children) -->
			{#if hasChildren}
				<button
					type="button"
					class="p-1 rounded hover:bg-muted transition-transform"
					class:rotate-90={isExpanded}
					onclick={() => toggleExpand(node.item._ulid)}
					data-testid="expand-toggle"
					aria-expanded={isExpanded}
					aria-label={isExpanded ? 'Collapse' : 'Expand'}
				>
					<ChevronRight class="h-4 w-4" />
				</button>
			{:else}
				<!-- Placeholder for alignment -->
				<div class="w-6"></div>
			{/if}

			<!-- Item content (clickable for selection) -->
			<button
				type="button"
				class="flex items-center gap-2 flex-1 text-left"
				onclick={() => selectItem(node.item)}
				data-testid="node-title"
			>
				<Badge class={getTypeColor(node.item.type)}>{node.item.type}</Badge>
				<span class="font-medium">{node.item.title}</span>
				{#if node.item.tags && node.item.tags.length > 0}
					<div class="flex gap-1 ml-auto">
						{#each node.item.tags.slice(0, 2) as tag}
							<Badge variant="outline" class="text-xs">{tag}</Badge>
						{/each}
					</div>
				{/if}
			</button>
		</div>

		<!-- Children (conditionally rendered) -->
		{#if hasChildren && isExpanded}
			<div class="pl-4 border-l-2 border-border ml-4" data-testid="tree-node-child">
				{#each node.children as child (child.item._ulid)}
					{@render renderNode(child, level + 1)}
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<div class="space-y-1" data-testid="spec-tree-container">
	{#if items.length === 0}
		<p class="text-center text-muted-foreground py-8">No spec items found</p>
	{:else}
		<div class="space-y-1" data-testid="spec-tree">
			{#each tree as node (node.item._ulid)}
				{@render renderNode(node, 0)}
			{/each}
		</div>
	{/if}
</div>
