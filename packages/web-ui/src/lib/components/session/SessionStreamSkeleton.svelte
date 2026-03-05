<!--
  Loading skeleton for the session stream view.
-->
<div class="flex h-full" data-testid="session-skeleton">
	<!-- Context panel skeleton -->
	<div class="w-72 border-r bg-card/50 p-4 space-y-4 flex-shrink-0">
		<div class="space-y-2">
			<div class="h-3 w-16 rounded bg-muted ds-shimmer"></div>
			<div class="h-6 w-20 rounded bg-muted ds-shimmer"></div>
			<div class="h-4 w-32 rounded bg-muted ds-shimmer"></div>
			<div class="h-4 w-28 rounded bg-muted ds-shimmer"></div>
			<div class="h-4 w-36 rounded bg-muted ds-shimmer"></div>
		</div>
		<div class="h-px bg-border"></div>
		<div class="space-y-2">
			<div class="h-3 w-12 rounded bg-muted ds-shimmer"></div>
			<div class="grid grid-cols-2 gap-2">
				<div class="h-12 rounded bg-muted ds-shimmer"></div>
				<div class="h-12 rounded bg-muted ds-shimmer"></div>
				<div class="h-12 rounded bg-muted ds-shimmer"></div>
				<div class="h-12 rounded bg-muted ds-shimmer"></div>
			</div>
		</div>
	</div>

	<!-- Stream skeleton -->
	<div class="flex-1 p-4 space-y-4">
		{#each Array(6) as _, i}
			{#if i % 3 === 0}
				<!-- Message skeleton -->
				<div class="flex gap-3">
					<div class="size-7 rounded-full bg-muted ds-shimmer flex-shrink-0"></div>
					<div class="flex-1 space-y-2">
						<div class="h-3 w-24 rounded bg-muted ds-shimmer"></div>
						<div class="h-4 w-full rounded bg-muted ds-shimmer"></div>
						<div class="h-4 w-3/4 rounded bg-muted ds-shimmer"></div>
					</div>
				</div>
			{:else if i % 3 === 1}
				<!-- Tool call skeleton -->
				<div class="border-l-2 border-muted rounded-r-md p-3 space-y-1">
					<div class="h-4 w-48 rounded bg-muted ds-shimmer"></div>
				</div>
			{:else}
				<!-- System block skeleton -->
				<div class="flex items-center gap-2">
					<div class="flex-1 h-px bg-border"></div>
					<div class="h-3 w-32 rounded bg-muted ds-shimmer"></div>
					<div class="flex-1 h-px bg-border"></div>
				</div>
			{/if}
		{/each}
	</div>
</div>
