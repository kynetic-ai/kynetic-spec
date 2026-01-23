<script lang="ts">
	// AC: @web-dashboard ac-11
	import type { ItemSummary } from '@kynetic-ai/shared';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Accordion,
		AccordionContent,
		AccordionItem,
		AccordionTrigger
	} from '$lib/components/ui/accordion';
	import { createEventDispatcher } from 'svelte';

	export let items: ItemSummary[];

	const dispatch = createEventDispatcher<{
		select: string;
	}>();

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

<div class="space-y-2">
	{#if items.length === 0}
		<p class="text-center text-muted-foreground py-8">No spec items found</p>
	{:else}
		<Accordion type="multiple" class="w-full">
			{#each tree as node (node.item._ulid)}
				<AccordionItem value={node.item._ulid}>
					<AccordionTrigger class="hover:no-underline">
						<div
							class="flex items-center gap-2 flex-1 cursor-pointer"
							on:click|stopPropagation={() => selectItem(node.item)}
							role="button"
							tabindex="0"
							on:keydown={(e) => e.key === 'Enter' && selectItem(node.item)}
						>
							<Badge class={getTypeColor(node.item.type)}>{node.item.type}</Badge>
							<span class="font-medium">{node.item.title}</span>
							{#if node.item.tags.length > 0}
								<div class="flex gap-1 ml-auto">
									{#each node.item.tags.slice(0, 2) as tag}
										<Badge variant="outline" class="text-xs">{tag}</Badge>
									{/each}
								</div>
							{/if}
						</div>
					</AccordionTrigger>
					{#if node.children.length > 0}
						<AccordionContent>
							<div class="pl-4 border-l-2 border-border ml-2">
								<svelte:self items={node.children.map((n) => n.item)} on:select />
							</div>
						</AccordionContent>
					{/if}
				</AccordionItem>
			{/each}
		</Accordion>
	{/if}
</div>
