<!--
  Loading skeleton for the Kanban board.
  Shows column placeholders with shimmer-animated card placeholders.
-->
<script lang="ts">
	import { Skeleton } from '$lib/components/ui/skeleton';
</script>

<div class="flex gap-4 overflow-x-auto p-6" data-testid="board-skeleton">
	{#each Array(5) as _, colIdx}
		<div class="flex flex-col min-w-[260px] max-w-[320px] flex-1">
			<!-- Column header skeleton -->
			<div class="flex items-center gap-2 mb-3 px-1">
				<Skeleton class="h-4 w-20 ds-shimmer" />
				<Skeleton class="size-5 rounded-full ds-shimmer" />
			</div>

			<!-- Card skeletons -->
			{#each Array(colIdx === 0 ? 3 : colIdx === 4 ? 2 : 1) as _}
				<div class="rounded-lg border bg-card p-3 mb-2">
					<div class="flex items-center gap-1.5 mb-1.5">
						<Skeleton class="size-5 rounded-full ds-shimmer" />
						<Skeleton class="h-3 w-16 ds-shimmer" />
					</div>
					<Skeleton class="h-4 w-full mb-1 ds-shimmer" />
					<Skeleton class="h-3 w-24 mb-1.5 ds-shimmer" />
					<div class="flex gap-1 mb-2">
						<Skeleton class="h-4 w-10 rounded-full ds-shimmer" />
						<Skeleton class="h-4 w-12 rounded-full ds-shimmer" />
					</div>
					<div class="flex items-center gap-3 pt-1.5 border-t border-border/50">
						<Skeleton class="h-3 w-8 ds-shimmer" />
						<Skeleton class="h-3 w-8 ds-shimmer" />
						<Skeleton class="h-3 w-6 ml-auto ds-shimmer" />
					</div>
				</div>
			{/each}
		</div>
	{/each}
</div>
