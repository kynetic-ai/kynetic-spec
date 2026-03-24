<!--
  AC: @ui-automation-view ac-2 — Recent events in reverse chronological order
  AC: @ui-automation-view ac-7 — Real-time updates via WebSocket (parent handles invalidation)
-->
<script lang="ts">
	import type { EventEnvelopeSummary } from '$lib/api';
	import { Badge } from '$lib/components/ui/badge';
	import { Card } from '$lib/components/ui/card';
	import ScrollText from '@lucide/svelte/icons/scroll-text';

	interface Props {
		events: EventEnvelopeSummary[];
	}

	let { events }: Props = $props();

	function formatTimestamp(iso: string): string {
		const date = new Date(iso);
		return date.toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	}

	function formatDate(iso: string): string {
		const date = new Date(iso);
		return date.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
		});
	}

	function getEventDomain(eventType: string): string {
		return eventType.split('.')[0] ?? 'unknown';
	}

	function getDomainColor(domain: string): 'default' | 'secondary' | 'outline' {
		switch (domain) {
			case 'task':
				return 'default';
			case 'invocation':
				return 'secondary';
			default:
				return 'outline';
		}
	}

	// Expand state for payload details
	let expandedEventId = $state<string | null>(null);

	function toggleExpand(eventId: string) {
		expandedEventId = expandedEventId === eventId ? null : eventId;
	}
</script>

<section data-testid="event-log-section" aria-live="polite">
	<h2 class="text-lg font-semibold mb-3">
		Event Log
		{#if events.length > 0}
			<span class="text-sm font-normal text-muted-foreground">({events.length} recent)</span>
		{/if}
	</h2>

	{#if events.length === 0}
		<div
			class="flex flex-col items-center justify-center py-8 text-center border rounded-lg"
			data-testid="events-empty-state"
		>
			<ScrollText class="h-10 w-10 text-muted-foreground mb-3" />
			<h3 class="text-sm font-medium mb-1">No recent events</h3>
			<p class="text-xs text-muted-foreground max-w-sm">
				Events appear here when the dispatch engine is running. Start dispatch to begin.
			</p>
		</div>
	{:else}
		<div class="border rounded-lg overflow-hidden">
			<div class="max-h-[400px] overflow-y-auto">
				<table class="w-full text-sm">
					<thead class="bg-muted/50 sticky top-0">
						<tr>
							<th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Time</th>
							<th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Event Type</th>
							<th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Source</th>
							<th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Details</th>
						</tr>
					</thead>
					<tbody>
						{#each events as event (event.event_id)}
							<tr
								class="border-t hover:bg-muted/30 cursor-pointer"
								onclick={() => toggleExpand(event.event_id)}
								data-testid="event-row-{event.event_id}"
							>
								<td class="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
									<span title={event.emitted_at}>
										{formatDate(event.emitted_at)} {formatTimestamp(event.emitted_at)}
									</span>
								</td>
								<td class="px-3 py-2">
									<Badge variant={getDomainColor(getEventDomain(event.event_type))} class="text-xs">
										{event.event_type}
									</Badge>
								</td>
								<td class="px-3 py-2 text-xs text-muted-foreground">
									{event.source_type}
									{#if event.source_id}
										<span class="font-mono">({event.source_id})</span>
									{/if}
								</td>
								<td class="px-3 py-2 text-xs text-muted-foreground">
									{#if event.causation_id}
										<span class="font-mono" title="Causation ID">⤵ {event.causation_id.slice(0, 8)}</span>
									{/if}
								</td>
							</tr>
							{#if expandedEventId === event.event_id}
								<tr class="border-t bg-muted/20">
									<td colspan="4" class="px-3 py-2">
										<div class="text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
											{JSON.stringify(event.payload, null, 2)}
										</div>
										{#if event.correlation_id}
											<div class="mt-1 text-xs text-muted-foreground">
												Correlation: <span class="font-mono">{event.correlation_id}</span>
											</div>
										{/if}
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</section>
