<script lang="ts">
	/**
	 * Read-Only Banner Component
	 *
	 * Displays a banner indicating the app is in read-only mode
	 * when running from a static export.
	 *
	 * AC: @gh-pages-export ac-15 - Data freshness indicator
	 * AC: @gh-pages-export ac-14 - Validation badge
	 */

	import { isStaticMode, getExportedAt, getSnapshotValidation } from '$lib/stores/mode.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { RefreshCw, CheckCircle, XCircle, BookOpen } from 'lucide-svelte';

	// Format the exported timestamp for display
	function formatExportedAt(isoString: string | null): string {
		if (!isoString) return 'Unknown';

		const date = new Date(isoString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);

		// Show relative time for recent exports
		if (diffMins < 1) return 'Just now';
		if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
		if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
		if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;

		// Show absolute date for older exports
		return date.toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	// Refresh the page to check for updates
	function handleRefresh() {
		window.location.reload();
	}

	// Get validation info
	const validation = $derived(getSnapshotValidation());
	const exportedAt = $derived(getExportedAt());
	const formattedTime = $derived(formatExportedAt(exportedAt));
</script>

<!-- AC: @gh-pages-export ac-15 - Only show in static mode -->
{#if isStaticMode()}
	<div
		role="alert"
		class="flex items-center justify-between gap-4 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
	>
		<div class="flex items-center gap-3">
			<BookOpen class="h-4 w-4 flex-shrink-0" />
			<span>
				<strong>Read-only mode</strong>
				<span class="hidden sm:inline"> &mdash; Data as of: {formattedTime}</span>
				<span class="sm:hidden"> &mdash; {formattedTime}</span>
			</span>
		</div>

		<div class="flex items-center gap-2">
			<!-- AC: @gh-pages-export ac-14 - Validation badge -->
			{#if validation}
				{#if validation.valid}
					<Badge variant="outline" class="gap-1 border-green-500 text-green-600 dark:text-green-400">
						<CheckCircle class="h-3 w-3" />
						Valid
					</Badge>
				{:else}
					<Badge
						variant="outline"
						class="gap-1 border-red-500 text-red-600 dark:text-red-400"
						title="{validation.errorCount} errors, {validation.warningCount} warnings"
					>
						<XCircle class="h-3 w-3" />
						{validation.errorCount} errors
					</Badge>
				{/if}
			{/if}

			<Button variant="ghost" size="sm" onclick={handleRefresh} title="Refresh page">
				<RefreshCw class="h-4 w-4" />
				<span class="sr-only">Refresh</span>
			</Button>
		</div>
	</div>
{/if}
