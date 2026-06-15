<script lang="ts">
	import { base } from '$app/paths';
	import type { SessionSummary } from '$lib/api';
	import { Button } from '$lib/components/ui/button';
	import { StatusBadge } from '$lib/components/ds';
	import { formatAge, formatElapsed } from './session-utils';

	interface Props {
		title: string;
		sessions: SessionSummary[];
		loading: boolean;
		error: string;
		filterHref: string;
		emptyMessage: string;
		dataTestId: string;
	}

	let { title, sessions, loading, error, filterHref, emptyMessage, dataTestId }: Props = $props();
</script>

<div data-testid={dataTestId}>
	<div class="mb-2 flex items-center justify-between gap-3">
		<h3 class="text-sm font-semibold">{title}</h3>
		<Button
			href={filterHref}
			variant="ghost"
			size="sm"
			class="h-7 px-2 text-xs"
			data-testid={`${dataTestId}-view-all`}
		>
			View all sessions
		</Button>
	</div>

	{#if loading}
		<div class="space-y-2" data-testid={`${dataTestId}-loading`}>
			{#each Array(2) as _}
				<div class="h-14 rounded-md bg-muted ds-shimmer"></div>
			{/each}
		</div>
	{:else if error}
		<p class="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid={`${dataTestId}-error`}>
			{error}
		</p>
	{:else if sessions.length === 0}
		<p class="text-sm text-muted-foreground" data-testid={`${dataTestId}-empty`}>{emptyMessage}</p>
	{:else}
		<div class="space-y-2">
			{#each sessions as session (session.id)}
				<a
					href={`${base}/sessions/${session.id}`}
					class="flex items-center gap-3 rounded-md border p-3 transition-colors hover:bg-muted/40"
					data-testid={`${dataTestId}-row`}
				>
					<!-- AC: @ui-view-header ac-2 — session state drawn from the shared status-token source -->
					<StatusBadge domain="session" state={session.status} testid={`${dataTestId}-status-badge`} />
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium">{session.id.slice(0, 8)}</span>
							<span class="text-xs text-muted-foreground">{formatElapsed(session.duration_ms)}</span>
						</div>
						<div class="text-xs text-muted-foreground">
							Started {formatAge(session.started_at)}
						</div>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>
