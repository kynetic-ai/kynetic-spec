<!--
  StatusBadge — renders an entity state as a pill drawn from the shared
  status-token vocabulary (color + glyph). The single visual representation of a
  state used across every surface, so the same state reads identically wherever
  it appears.

  Spec: @ui-view-header (state indicator from a shared status-token vocabulary)
-->
<script lang="ts">
	import { cn } from '$lib/utils.js';
	import {
		resolveStatusToken,
		statusBadgeClass,
		type StatusDomain
	} from '$lib/ds/status-tokens';

	interface Props {
		/** State vocabulary domain (task, session, review-disposition, …). */
		domain: StatusDomain;
		/** The state value within the domain (e.g. `in_progress`). */
		state: string;
		/** Optional extra classes merged onto the pill. */
		class?: string;
		/** Optional test id forwarded to the pill element. */
		testid?: string;
		/** Show the glyph (default true). */
		showGlyph?: boolean;
		/** Show the label text (default true). */
		showLabel?: boolean;
	}

	let {
		domain,
		state,
		class: className,
		testid,
		showGlyph = true,
		showLabel = true
	}: Props = $props();

	let token = $derived(resolveStatusToken(domain, state));
</script>

<span
	data-slot="status-badge"
	data-testid={testid}
	data-status-domain={domain}
	data-status-state={state}
	class={cn(
		'inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
		statusBadgeClass(token.family),
		className
	)}
>
	{#if showGlyph}
		<span aria-hidden="true" class="font-mono leading-none">{token.glyph}</span>
	{/if}
	{#if showLabel}<span>{token.label}</span>{/if}
</span>
