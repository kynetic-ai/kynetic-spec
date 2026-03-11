<script lang="ts">
	import { base } from '$app/paths';
	import type { PlanContentBlock } from '$lib/utils/plan-embedded-content';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { Badge } from '$lib/components/ui/badge';
	import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';

	interface Props {
		blocks: PlanContentBlock[];
	}

	let { blocks }: Props = $props();

	function itemHref(ref: string): string {
		return `${base}/items?ref=${encodeURIComponent(ref)}`;
	}

	function taskHref(ref: string): string {
		return `${base}/tasks?ref=${encodeURIComponent(ref)}`;
	}

	function formatStatus(value: string | undefined): string {
		if (!value) return 'Unknown';
		return value.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
	}

	function formatMaturity(value: string | undefined): string {
		return value ? value.replace(/\b\w/g, (char) => char.toUpperCase()) : 'Unspecified';
	}
 </script>

<div class="flex flex-col gap-4" data-testid="plan-embedded-blocks">
	{#each blocks as block, index}
		{#if block.type === 'markdown'}
			<div class="prose prose-sm dark:prose-invert max-w-none" data-testid="plan-content-rendered">
				{@html renderMarkdown(block.markdown)}
			</div>
		{:else if block.state === 'loading'}
			<div class="not-prose space-y-3" data-testid={`plan-embedded-${block.embedType}-loading`}>
				{#each Array(Math.max(block.refs.length, 1)) as _}
					<Card class="border-dashed">
						<CardHeader class="pb-2">
							<Skeleton class="h-5 w-40 ds-shimmer" />
							<Skeleton class="h-4 w-24 ds-shimmer" />
						</CardHeader>
						<CardContent class="space-y-2">
							<Skeleton class="h-4 w-full ds-shimmer" />
							<Skeleton class="h-4 w-5/6 ds-shimmer" />
						</CardContent>
					</Card>
				{/each}
			</div>
		{:else if block.state === 'error'}
			<div class="not-prose space-y-3" data-testid={`plan-embedded-${block.embedType}-error`}>
				<div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					Failed to load embedded {block.embedType} details: {block.errorMessage}
				</div>
				<div class="prose prose-sm dark:prose-invert max-w-none">
					{@html renderMarkdown(block.rawMarkdown)}
				</div>
			</div>
		{:else if block.embedType === 'spec'}
			<div class="not-prose space-y-3" data-testid="plan-embedded-specs">
				{#each block.items as item}
					<a
						href={itemHref(item.slugs[0] ?? item.ulid)}
						class="block rounded-lg border transition-colors hover:bg-muted/30"
						data-testid="plan-embedded-spec-card"
					>
						<Card class="border-0 shadow-none">
							<CardHeader class="gap-3 pb-3">
								<div class="flex flex-wrap items-center gap-2">
									<Badge variant="outline">{item.type}</Badge>
									<Badge variant="secondary">{formatStatus(item.status)}</Badge>
									<Badge variant="secondary">{formatMaturity(item.maturity)}</Badge>
								</div>
								<div class="space-y-1">
									<h4 class="text-sm font-semibold">{item.title}</h4>
									<p class="text-xs text-muted-foreground font-mono">
										@{item.slugs[0] ?? item.ulid}
									</p>
								</div>
							</CardHeader>
							<CardContent class="space-y-3">
								<div class="flex flex-wrap gap-2">
									<Badge variant="outline">{item.ac_count} AC{item.ac_count === 1 ? '' : 's'}</Badge>
									{#each item.traits as trait}
										<Badge variant="outline">{trait}</Badge>
									{/each}
								</div>
								<p class="text-xs text-muted-foreground">
									Open spec detail to review full acceptance criteria.
								</p>
							</CardContent>
						</Card>
					</a>
				{/each}
			</div>
		{:else}
			<div class="not-prose space-y-3" data-testid="plan-embedded-tasks">
				{#each block.items as item}
					<a
						href={taskHref(item.slugs[0] ?? item.ulid)}
						class="block rounded-lg border transition-colors hover:bg-muted/30"
						data-testid="plan-embedded-task-card"
					>
						<Card class="border-0 shadow-none">
							<CardHeader class="gap-3 pb-3">
								<div class="flex flex-wrap items-center gap-2">
									<Badge variant="secondary">{formatStatus(item.status)}</Badge>
									<Badge variant="outline">P{item.priority}</Badge>
									{#if item.assignee}
										<Badge variant="outline">{item.assignee}</Badge>
									{/if}
								</div>
								<div class="space-y-1">
									<h4 class="text-sm font-semibold">{item.title}</h4>
									<p class="text-xs text-muted-foreground font-mono">
										@{item.slugs[0] ?? item.ulid}
									</p>
								</div>
							</CardHeader>
							{#if item.spec_ref}
								<CardContent class="pt-0">
									<p class="text-xs text-muted-foreground">Spec: {item.spec_ref}</p>
								</CardContent>
							{/if}
						</Card>
					</a>
				{/each}
			</div>
		{/if}
	{/each}
</div>
