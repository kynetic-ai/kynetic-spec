<script lang="ts">
	/**
	 * ConnectionStatus Component
	 *
	 * Displays WebSocket connection status with visual indicator.
	 *
	 * AC Coverage:
	 * - ac-29 (@web-dashboard): Show "Connection lost" after 10s disconnected
	 */
	import { Badge } from '$lib/components/ui/badge';
	import { getConnectionState, isConnectionLost } from '$lib/stores/connection.svelte';

	// AC: @web-dashboard ac-29
	let state = $derived(getConnectionState());
	let lost = $derived(isConnectionLost());

	// Compute badge variant and label
	let variant = $derived.by(() => {
		if (lost) return 'destructive';
		if (state === 'connected') return 'default';
		if (state === 'connecting' || state === 'reconnecting') return 'secondary';
		return 'outline';
	});

	let label = $derived.by(() => {
		if (lost) return 'Connection Lost';
		if (state === 'connected') return 'Connected';
		if (state === 'reconnecting') return 'Reconnecting...';
		if (state === 'connecting') return 'Connecting...';
		return 'Disconnected';
	});
</script>

<!-- AC: @web-dashboard ac-29 -->
<Badge {variant}>
	{label}
</Badge>
