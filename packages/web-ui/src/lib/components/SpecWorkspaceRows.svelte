<script lang="ts">
	import type {
		SpecWorkspaceNodeDetailProjection,
		SpecWorkspaceNodeSummary
	} from '@kynetic-ai/shared';
	import { Badge } from '$lib/components/ui/badge';
	import StatusBadge from '$lib/components/ds/StatusBadge.svelte';
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import ExternalLink from 'lucide-svelte/icons/external-link';
	import { cn } from '$lib/utils.js';

	interface Props {
		nodes: SpecWorkspaceNodeSummary[];
		expandedRefs: Set<string>;
		expandedDetails: Map<string, SpecWorkspaceNodeDetailProjection>;
		expandedLoading: Set<string>;
		expandedErrors: Map<string, string>;
		focusedRef?: string | null;
		level?: number;
		nodeHref: (node: SpecWorkspaceNodeSummary) => string;
		onToggle: (node: SpecWorkspaceNodeSummary) => void;
	}

	let {
		nodes,
		expandedRefs,
		expandedDetails,
		expandedLoading,
		expandedErrors,
		focusedRef = null,
		level = 0,
		nodeHref,
		onToggle
	}: Props = $props();

	function coverageBucket(node: SpecWorkspaceNodeSummary): string | null {
		if (!node.coverage || node.coverage.denominator === 0) return null;
		if (node.coverage.counts.failing > 0) return 'failing';
		if (node.coverage.counts.re_verify > 0) return 're_verify';
		if (node.coverage.counts.not_yet > 0) return 'not_yet';
		return 'covered';
	}

	function nodeStatus(node: SpecWorkspaceNodeSummary): string | null {
		return typeof node.status === 'string' ? node.status : (node.status?.implementation ?? null);
	}

	function childNodes(node: SpecWorkspaceNodeSummary): SpecWorkspaceNodeSummary[] {
		const detail = expandedDetails.get(node.ref);
		if (!detail) return [];
		return detail.child_sections.flatMap((section) => section.nodes);
	}
</script>

{#snippet renderNode(node: SpecWorkspaceNodeSummary, depth: number)}
	{@const isExpanded = expandedRefs.has(node.ref)}
	{@const hasChildren = node.child_count > 0}
	{@const children = childNodes(node)}
	{@const loading = expandedLoading.has(node.ref)}
	{@const error = expandedErrors.get(node.ref)}
	{@const status = nodeStatus(node)}
	{@const coverage = coverageBucket(node)}
	<div
		class="min-w-0"
		data-testid="tree-node tree-node-{node.type}"
		data-node-ref={node.ref}
		data-expanded={isExpanded}
	>
		<div
			class={cn(
				'group grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-stretch gap-1 rounded-md border border-transparent transition-colors',
				focusedRef === node.ref ? 'border-primary/30 bg-primary/5' : 'hover:border-border hover:bg-muted/40'
			)}
			style={`margin-inline-start: ${Math.min(depth, 8) * 0.875}rem;`}
		>
			<button
				type="button"
				class="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-2 rounded-l-md px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onclick={() => onToggle(node)}
				data-testid="workspace-row-body"
				aria-expanded={hasChildren ? isExpanded : undefined}
				aria-label={hasChildren ? `${isExpanded ? 'Collapse' : 'Expand'} ${node.title}` : `${node.title} has no child nodes`}
			>
				<span
					class="flex size-6 items-center justify-center rounded text-muted-foreground"
					class:rotate-90={isExpanded}
					data-testid="expand-toggle"
					aria-hidden="true"
				>
					{#if hasChildren}
						<ChevronRight class="size-4 transition-transform" />
					{:else}
						<span class="size-1.5 rounded-full bg-muted-foreground/40"></span>
					{/if}
				</span>
				<span class="flex min-w-0 items-center gap-2">
					<Badge variant="outline" class="shrink-0 text-[10px]">{node.type}</Badge>
					<span class="min-w-0 truncate font-medium">{node.title}</span>
					{#if node.acceptance_criteria_count > 0}
						<span class="shrink-0 text-xs text-muted-foreground">{node.acceptance_criteria_count} AC</span>
					{/if}
					{#if node.child_count > 0}
						<span class="shrink-0 text-xs text-muted-foreground">{node.child_count} children</span>
					{/if}
					{#if coverage}
						<StatusBadge domain="coverage" state={coverage} class="shrink-0 px-1.5 py-0 text-[10px]" />
					{/if}
					{#if status}
						<StatusBadge domain="spec-implementation" state={status} class="hidden shrink-0 px-1.5 py-0 text-[10px] sm:inline-flex" />
					{/if}
				</span>
			</button>

			<a
				href={nodeHref(node)}
				class="inline-flex min-w-0 items-center gap-1 rounded-r-md px-2 py-2 text-sm font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				data-testid="node-title"
				aria-label={`Open ${node.title} as workspace page`}
			>
				<span class="max-w-[9rem] truncate">{node.title}</span>
				<ExternalLink class="size-3.5 shrink-0" aria-hidden="true" />
			</a>
		</div>

		{#if hasChildren && isExpanded}
			<div class="ml-4 min-w-0 border-l border-border pl-2" data-testid="tree-node-child">
				{#if loading}
					<p class="px-2 py-3 text-sm text-muted-foreground">Loading child nodes...</p>
				{:else if error}
					<p class="px-2 py-3 text-sm text-destructive" role="alert">{error}</p>
				{:else if children.length > 0}
					<div class="space-y-1 py-1">
						{#each children as child (child.ref)}
							{@render renderNode(child, depth + 1)}
						{/each}
					</div>
				{:else}
					<p class="px-2 py-3 text-sm text-muted-foreground">No visible child nodes.</p>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

<div class="min-w-0 space-y-1" data-testid="spec-tree">
	{#if nodes.length === 0}
		<p class="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
			No spec items found.
		</p>
	{:else}
		{#each nodes as node (node.ref)}
			{@render renderNode(node, level)}
		{/each}
	{/if}
</div>
