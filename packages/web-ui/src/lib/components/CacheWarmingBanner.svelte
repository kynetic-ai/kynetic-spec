<!--
  Error banner shown when cache warming retries are exhausted (30s timeout).
  Displays entity-specific message and a Retry button that resets queries.
  AC: @ui-data-freshness ac-warming-timeout — Error state with manual retry
-->
<script lang="ts">
	import { useQueryClient } from '@tanstack/svelte-query';
	import { Button } from '$lib/components/ui/button';
	import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
	import RefreshCw from 'lucide-svelte/icons/refresh-cw';

	interface Props {
		/** Human-readable entity name, e.g. "tasks", "inbox items" */
		entityName: string;
		/** Query key(s) to reset when Retry is clicked. Pass a single key or array of keys. */
		queryKey: readonly unknown[];
		/** Additional query keys to reset alongside the primary key. */
		extraQueryKeys?: (readonly unknown[])[];
	}

	let { entityName, queryKey, extraQueryKeys }: Props = $props();

	const queryClient = useQueryClient();
	let retrying = $state(false);

	async function handleRetry() {
		retrying = true;
		await queryClient.resetQueries({ queryKey: [...queryKey] });
		if (extraQueryKeys) {
			for (const key of extraQueryKeys) {
				await queryClient.resetQueries({ queryKey: [...key] });
			}
		}
		retrying = false;
	}
</script>

<div
	class="flex flex-col items-center justify-center gap-4 py-12 px-6 text-center"
	role="alert"
	data-testid="cache-warming-timeout"
>
	<AlertTriangle class="size-10 text-amber-500" />
	<div>
		<h2 class="text-lg font-medium mb-1">Unable to load {entityName}</h2>
		<p class="text-sm text-muted-foreground">
			The server cache did not become ready. This usually resolves on its own.
		</p>
	</div>
	<Button
		variant="outline"
		size="sm"
		onclick={handleRetry}
		disabled={retrying}
		data-testid="cache-warming-retry"
	>
		<RefreshCw class="size-4 mr-2 {retrying ? 'animate-spin' : ''}" />
		{retrying ? 'Retrying…' : 'Retry'}
	</Button>
</div>
