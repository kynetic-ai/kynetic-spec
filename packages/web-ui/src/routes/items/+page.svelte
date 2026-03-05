<script lang="ts">
	// AC: @ui-app-shell ac-3 — Redirect /items to /specs preserving query parameters
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';

	onMount(() => {
		const queryString = $page.url.search;
		goto(`${base}/specs${queryString}`, { replaceState: true });
	});
</script>

<div class="flex items-center justify-center h-32">
	<span class="text-muted-foreground">Redirecting to Specs...</span>
</div>
